/**
 * Action log — every action and error that moves through the app, remembered,
 * deduplicated, and reported somewhere the fixer can act on it.
 *
 * The chain, deliberately boring:
 *
 *   1. record. The UI reports its own errors and the last thing the person
 *      clicked; the server reports every failed HTTP response.
 *   2. dedupe. The same error from the same place is one item with a growing
 *      count, not fifty rows — so a genuinely recurring problem (a Linux error
 *      popping up on every run click, for example) stands out instead of
 *      drowning in noise.
 *   3. recognize. A small table of known patterns attaches advice and, where a
 *      safe fix exists, the fix. The platform-mismatch case is one: an error
 *      about Linux arriving on a machine the person says is Windows is recorded
 *      with the explanation and the run is allowed to proceed in simulated mode.
 *   4. report. Once an item repeats past the threshold, a single living file is
 *      written into must-check/ — the folder auto-sync carries to GitHub — so a
 *      connected AI reading the repository sees the error, its count and its
 *      context without anyone copying logs around.
 *   5. triage. The pipeline drafts an AI suggestion for the item (handler
 *      'error-triage'), shown in-app; the operator can dismiss or mark applied.
 *      Nothing here edits source files on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, logActivity, now, persist, ROOT, uid } from './store.js';
import { enqueue } from './pipeline.js';

const MUST_CHECK = 'must-check';
const ITEM_LIMIT = 200;
const OUTPUT_LIMIT = 2500;

/** Errors so benign that recording them would be the noise, not the signal. */
const BENIGN = [
  { match: /ENOENT.*db\.json\.tmp/i, note: 'the database save raced another writer; the next save wins' },
];

/**
 * Known patterns: advice for the person, and the safe fix the app itself can
 * apply. Extend this table (or db().settings.actionLogPatterns) as new recurring
 * errors are understood — no code change needed for pure advice.
 */
export const KNOWN_PATTERNS = [
  {
    id: 'platform-mismatch',
    match: /live control is not implemented for (linux|darwin)|linux.*(preview|cannot access)|xdotool|wayland/i,
    advice:
      'This machine is not actually Linux — the console is being reached through a hosted preview that runs on Linux, so the live backend refuses. On Windows, run `npm start` on the desktop machine and open http://127.0.0.1:4317 there. Live runs now fall back to simulated instead of bouncing, so work can continue.',
    fix: 'platform-fallback',
  },
  {
    id: 'model-offline',
    match: /model is offline|AI unavailable|fetch failed|ECONNREFUSED/i,
    advice: 'The local planner keeps builds and runs working without the model; check the endpoint in Agent settings, or wait for it to come back.',
    fix: '',
  },
];

function log() {
  const d = db();
  if (!Array.isArray(d.actionLog)) d.actionLog = [];
  return d.actionLog;
}

function settings() {
  const s = db().settings;
  if (!s.actionLog || typeof s.actionLog !== 'object') s.actionLog = {};
  if (s.actionLog.enabled === undefined) s.actionLog.enabled = true;
  if (!Number(s.actionLog.reportAt)) s.actionLog.reportAt = 2;
  return s.actionLog;
}

export function actionLogStatus() {
  const items = log();
  return {
    items: items.slice(0, 40),
    open: items.filter((item) => !['dismissed', 'fix-applied', 'suppressed'].includes(item.status)).length,
    triaged: items.filter((item) => item.status === 'fix-suggested').length,
  };
}

export function listActionLog({ status = '', limit = 40 } = {}) {
  const items = log();
  const wanted = status ? items.filter((item) => item.status === status) : items;
  return wanted.slice(-Math.max(1, Math.min(ITEM_LIMIT, Number(limit) || 40))).reverse();
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/["'`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function matchPattern(item) {
  const extra = Array.isArray(db().settings.actionLogPatterns) ? db().settings.actionLogPatterns : [];
  const table = [...KNOWN_PATTERNS, ...extra];
  const text = `${item.action} ${item.error} ${item.detail || ''}`;
  return table.find((pattern) => pattern.match && new RegExp(pattern.match, 'i').test(text)) || null;
}

/** The single living report per recurring error, updated in place. */
export function writeActionReport(item) {
  try {
    const dir = path.join(ROOT, MUST_CHECK);
    fs.mkdirSync(dir, { recursive: true });
    const slug = normalize(`${item.action} ${item.error}`).replace(/[^a-z0-9#]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'action';
    const file = path.join(dir, `action-${slug}.md`);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // Keep an operator/AI notes section appended by humans across updates.
    const notes = existing.includes('## Notes for the fixer') ? existing.split('## Notes for the fixer')[1] || '' : '';
    const body = [
      `# Recurring app action/error — ${item.action || item.kind}`,
      '',
      `- signature: \`${item.signature}\``,
      `- seen: **${item.count}×**, first ${item.firstAt}, last ${item.lastAt}`,
      `- status: ${item.status}${item.suggestion ? ' (AI suggestion drafted, see below)' : ''}`,
      '',
      '## Error',
      '',
      '```',
      String(item.error || '(no error text)').slice(0, OUTPUT_LIMIT),
      '```',
      '',
      '## Context',
      '',
      '```json',
      JSON.stringify(safeDetail(item), null, 2).slice(0, 1500),
      '```',
      '',
      item.pattern?.advice ? `## Known advice\n\n${item.pattern.advice}\n` : '',
      item.suggestion ? `## AI suggestion\n\n${item.suggestion}\n` : '',
      '## Notes for the fixer',
      notes.trimEnd() || '(append findings here; auto-sync carries this file to GitHub and back)',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(file, `${body}\n`);
    return path.join(MUST_CHECK, path.basename(file)).split(path.sep).join('/');
  } catch {
    return '';
  }
}

function safeDetail(item) {
  if (!item.detail || typeof item.detail !== 'object') return { detail: item.detail || null };
  const clean = {};
  for (const [key, value] of Object.entries(item.detail)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

/**
 * Record one action or error. Returns the (possibly merged) item.
 * `report` set to false records silently (used for suppressed classes).
 */
export function recordAction({ kind = 'ui', action = '', error = '', detail = null, report = true, forceReport = false } = {}) {
  const conf = settings();
  if (conf.enabled === false) return null;
  const text = String(error || action || '').trim();
  if (!text && !action) return null;

  for (const benign of BENIGN) {
    if (benign.match.test(text)) {
      return { status: 'suppressed', note: benign.note };
    }
  }

  const items = log();
  const signature = `${kind}:${normalize(action)}:${normalize(error)}`;
  let item = items.find((entry) => entry.signature === signature && !['dismissed', 'fix-applied'].includes(entry.status));
  if (item) {
    item.count += 1;
    item.lastAt = now();
  } else {
    item = {
      id: uid('act'),
      at: now(),
      firstAt: now(),
      lastAt: now(),
      kind: String(kind || 'ui').slice(0, 20),
      action: String(action || '').slice(0, 160),
      error: String(error || '').slice(0, OUTPUT_LIMIT),
      detail: detail && typeof detail === 'object' ? JSON.parse(JSON.stringify(detail)) : detail,
      signature,
      count: 1,
      status: 'new',
      pattern: null,
      suggestion: null,
    };
    items.push(item);
    if (items.length > ITEM_LIMIT) {
      const dropped = items.findIndex((entry) => ['dismissed', 'fix-applied', 'suppressed'].includes(entry.status));
      items.splice(dropped === -1 ? 0 : dropped, 1);
    }
  }

  const pattern = matchPattern(item);
  if (pattern) {
    item.pattern = { id: pattern.id, advice: pattern.advice, fix: pattern.fix || '' };
    if (item.status === 'new') item.status = 'recognized';
  }

  const threshold = Math.max(1, Number(conf.reportAt) || 2);
  if (report && (forceReport || (item.count >= threshold && !item.reportedAt))) {
    item.reportedAt = item.reportedAt || now();
    item.reportFile = writeActionReport(item) || item.reportFile;
    try {
      enqueue({ kind: 'error-triage', payload: { id: item.id }, key: `error-triage:${item.signature}`, priority: 2 });
    } catch { /* the pipeline handler is registered at boot; before that, skip */ }
    logActivity('action-log', `Recurring ${item.kind} issue (${item.count}×): ${item.error.slice(0, 80)}`, { itemId: item.id });
  }
  persist();
  return item;
}

/** The pipeline handler: ask the model for a concrete fix suggestion. */
export async function triageItem({ id } = {}, deps = {}) {
  const item = log().find((entry) => entry.id === id);
  if (!item) throw new Error('Item not found');
  let ask = deps.chat || null;
  if (!ask) {
    const mod = await import('./llm.js');
    ask = async (messages) => mod.chat(messages, { timeoutMs: 90000 });
  }
  try {
    const reply = await ask([
      {
        role: 'system',
        content:
          'You are triaging a recurring error from a Node.js screen-automation console. Reply with at most 8 lines: what is most likely happening, whether it is safe to ignore, and the smallest concrete fix (file and change) if it is not. Plain text. You are advising; do not claim to have changed anything.',
      },
      {
        role: 'user',
        content: `Action: ${item.action || item.kind}\nSeen ${item.count}× (${item.firstAt} → ${item.lastAt})\nError: ${String(item.error).slice(0, 2000)}\n${item.pattern?.advice ? `Known advice: ${item.pattern.advice}\n` : ''}`,
      },
    ]);
    item.suggestion = reply?.ok
      ? String(reply.content || '').trim().slice(0, 3000)
      : null;
    if (reply?.ok) item.suggestionError = null;
    else item.suggestionError = reply?.error || 'the model is offline';
  } catch (err) {
    item.suggestionError = err.message;
  }
  item.status = item.suggestion ? 'fix-suggested' : item.status;
  item.suggestedAt = now();
  // The report file is rewritten so the suggestion reaches the synced folder too.
  if (item.reportedAt) writeActionReport(item);
  persist();
  return item;
}

/** Apply a recognized, safe fix (or record that the operator did it). */
export function applyFix(id, { note = '' } = {}) {
  const item = log().find((entry) => entry.id === id);
  if (!item) throw new Error('Item not found');
  item.status = 'fix-applied';
  item.appliedAt = now();
  item.appliedNote = String(note || (item.pattern?.fix ? `applied known fix: ${item.pattern.fix}` : 'applied by operator')).slice(0, 400);
  if (item.reportedAt) writeActionReport(item);
  persist();
  logActivity('action-log', `Marked a recurring issue as handled: ${item.error.slice(0, 60)}`, { itemId: item.id });
  return item;
}

/**
 * Turn an AI suggestion into something implementable: the model converts the
 * suggestion into concrete workflow steps for the affected workflow, saved as
 * a reviewable suggestion on that workflow. Nothing is applied to the workflow
 * itself — a human or an approving agent accepts it in the builder, and the
 * suite (or a shadow run) checks the correction afterwards.
 */
export async function implementSuggestion(id, deps = {}) {
  const item = log().find((entry) => entry.id === id);
  if (!item) throw new Error('Item not found');
  if (!item.suggestion) throw new Error('This item has no AI suggestion to implement yet — run AI suggestion first.');
  const detail = item.detail || {};
  const workflowId = detail.workflowId || null;
  let ask = deps.chat || null;
  if (!ask) {
    const mod = await import('./llm.js');
    ask = async (messages) => mod.chat(messages, { timeoutMs: 120000 });
  }
  let parsed = null;
  let parseError = '';
  try {
    const reply = await ask([
      {
        role: 'system',
        content:
          'Convert the fix suggestion into workflow steps for the screen-automation console. Reply with JSON only: {"summary":"one line","steps":[{"type":"launchApp|focusWindow|type|key|wait|waitFor|expect|screenshot|click","name":"...","params":{}}]}. Allowed params per type: launchApp {target}, focusWindow {title}, type {text, foreground}, key {keys}, wait {ms}, waitFor {kind, value, mode}, expect {kind, value, mode}, screenshot {caption}, click {x, y}. Keep it minimal and safe; never include steps that delete or overwrite files.',
      },
      { role: 'user', content: `Issue: ${item.error}\nSuggestion: ${item.suggestion}\n${detail.workflowId ? `Workflow: ${detail.workflowId}` : ''}` },
    ]);
    if (reply?.ok) {
      const text = String(reply.content || '').trim();
      const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
      parsed = JSON.parse(json);
    } else {
      parseError = reply?.error || 'the model is offline';
    }
  } catch (err) {
    parseError = err.message;
  }
  if (!parsed?.steps?.length) {
    item.implementError = parseError || 'the model returned no usable steps';
    persist();
    return { ok: false, status: 'no-steps', message: item.implementError, item };
  }
  const { addSuggestion } = await import('./planner.js');
  const suggestion = addSuggestion(
    `Fix for “${item.action}”: ${parsed.summary || item.suggestion.slice(0, 120)} — steps: ${parsed.steps.map((s) => s.type).join(' → ')}`,
    'fix',
    workflowId,
    detail.runId || null
  );
  item.implementation = { at: now(), summary: parsed.summary || '', steps: parsed.steps, suggestionId: suggestion?.id || null };
  item.status = 'implementing';
  if (item.reportedAt) writeActionReport(item);
  persist();
  logActivity('action-log', `A fix for a recurring issue became ${parsed.steps.length} reviewable step(s)`, { itemId: item.id });
  return { ok: true, status: 'proposed', steps: parsed.steps, suggestionId: suggestion?.id || null, message: `${parsed.steps.length} step(s) drafted for review — accept them in the builder, then test.` };
}

export function dismissItem(id) {
  const item = log().find((entry) => entry.id === id);
  if (!item) throw new Error('Item not found');
  item.status = 'dismissed';
  item.settledAt = now();
  persist();
  return item;
}
