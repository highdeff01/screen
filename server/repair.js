/**
 * Live repair policy.
 *
 * When a step fails during a live run the engine asks this module for bounded,
 * evidence-preserving alternatives: retry with a different UI Automation or
 * vision strategy, paste instead of typing, try another search engine, reopen
 * the prerequisite, or reuse a method that worked in an earlier session.
 * Pure helpers so the policy can be tested without a desktop.
 */

import { catalogEntry } from './app-install.js';

const INPUT_TYPES = new Set([
  'type',
  'key',
  'clipboard',
  'click',
  'doubleClick',
  'rightClick',
  'drag',
  'dragCopy',
  'scroll',
  'playMedia',
]);

const MAX_MEMORY = 120;

const clip = (value, max = 220) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const FALLBACK_APPS = [
  { match: /\b(?:calculator|calc)\b/i, name: 'Calculator', target: 'calc.exe', process: 'calc', title: 'Calculator' },
  { match: /\bnotepad\b/i, name: 'Notepad', target: 'notepad.exe', process: 'Notepad', title: 'Notepad' },
  { match: /\b(?:google\s+)?chrome\b/i, name: 'Chrome', target: 'chrome.exe', process: 'chrome', title: 'Chrome' },
  { match: /\b(?:microsoft\s+)?edge\b/i, name: 'Edge', target: 'msedge.exe', process: 'msedge', title: 'Edge' },
  { match: /\bfirefox\b/i, name: 'Firefox', target: 'firefox.exe', process: 'firefox', title: 'Firefox' },
  { match: /\b(?:paint|mspaint)\b/i, name: 'Paint', target: 'mspaint.exe', process: 'mspaint', title: 'Paint' },
  { match: /\b(?:file\s+)?explorer\b/i, name: 'File Explorer', target: 'explorer.exe', process: 'explorer', title: 'File Explorer' },
  { match: /\b(?:visual\s+studio\s+code|vscode|vs\s+code)\b/i, name: 'Visual Studio Code', target: 'code', process: 'Code', title: 'Visual Studio Code' },
  { match: /\bword\b/i, name: 'Word', target: 'winword.exe', process: 'WINWORD', title: 'Word' },
  { match: /\bexcel\b/i, name: 'Excel', target: 'excel.exe', process: 'EXCEL', title: 'Excel' },
];

/** A real app the goal explicitly asks to open, used when a window is missing. */
export function appFromGoal(goal = '') {
  const text = String(goal || '');
  if (!/\b(?:open|launch|start|use|switch\s+to)\b/i.test(text)) return null;
  return FALLBACK_APPS.find((entry) => entry.match.test(text)) || null;
}

const KIND_ADVICE = {
  supervisor: 'Keep the operator goal in view and prefer a replanned step over repeating the same action.',
  watchdog: 'Capture the failure evidence first; never retry the same signature unchanged without new information.',
  observer: 'Check the prerequisite before the failed step, especially launch, open, focus and wait.',
  scheduler: 'Keep repairs inside the shared retry budget and the bounded repair chain.',
  continuity: 'Re-check the visible state and the final goal after repairing; do not assume the step worked.',
  companion: 'Reuse a saved method or a note from an earlier run when it matches this step.',
};

const CATEGORY_ADVICE = {
  window_not_found: 'Reopen or focus the target window before retrying the action.',
  input_failed: 'Capture the field state, then use the alternate input path: select-all and retype, or clipboard paste.',
  navigation_failed: 'Try the canonical URL, then an alternate search engine or the direct page.',
  assertion_failed: 'Re-establish the previous step first; the expected state may never have been produced.',
  timeout: 'Extend the wait or add the missing prerequisite instead of repeating the same wait.',
  visual_assertion_failed: 'Refocus the target and retry with a fresh capture; do not lower the confidence threshold.',
  file_issue: 'Check the output path and retry with the saved path from the run variables.',
  unknown: 'Review the previous step and the last screen before repeating the same action.',
};

function cloneStep(step, { type, name, params = {}, timeoutMs } = {}) {
  return {
    ...step,
    id: `${step.id || step.type || 'step'}_alt`,
    type: type || step.type,
    name: name || `${step.name || step.type} (alternative)`,
    params: { ...(step.params || {}), ...params },
    timeoutMs: timeoutMs ?? step.timeoutMs,
    attempts: 0,
    repairs: [],
  };
}

function searchQuery(url) {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (!/google\./i.test(parsed.hostname)) return '';
    return parsed.searchParams.get('q') || parsed.searchParams.get('query') || '';
  } catch {
    return '';
  }
}

function processLeaf(target) {
  return String(target || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.exe$/i, '')
    .trim();
}

/** The last passed step that established the app/window a check depends on. */
function resumeAnchor(run, step) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const index = steps.indexOf(step);
  const before = index >= 0 ? steps.slice(0, index) : steps;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const entry = before[i];
    if (!entry || entry.status !== 'passed') continue;
    if (['launchApp', 'focusWindow', 'playMedia', 'openUrl'].includes(entry.type)) return entry;
  }
  return null;
}

/**
 * Alternative methods for one failed step, most specific first. A candidate
 * either replaces the step or runs as a prerequisite and then retries it.
 */
export function repairCandidates({ step, run = null, workflow = null, goal = '', error = '' } = {}) {
  const out = [];
  const add = (method, steps, { replaces = false, reason = '' } = {}) => {
    const clean = (steps || []).filter(Boolean);
    if (clean.length) out.push({ method, steps: clean, replaces, reason });
  };
  if (!step) return out;
  const p = step.params || {};
  const target = String(p.target || '').trim();

  switch (step.type) {
    case 'clickElement': {
      add(
        'UIA with vision fallback and a longer control wait',
        [cloneStep(step, { name: `${step.name} (UIA + vision)`, params: { controlType: '', waitMs: Math.max(4000, num(p.waitMs)) , visionFallback: true } })],
        { replaces: true, reason: 'The named control may be exposed under a different type or need more time.' }
      );
      for (const controlType of ['Button', 'Link', 'Text', 'ListItem', 'Edit']) {
        if (String(p.controlType || '') === controlType) continue;
        add(
          `control type ${controlType}`,
          [cloneStep(step, { name: `${step.name} (${controlType})`, params: { controlType } })],
          { replaces: true }
        );
      }
      if (Number.isFinite(Number(p.fallbackX)) && Number.isFinite(Number(p.fallbackY))) {
        add(
          'saved coordinate fallback',
          [
            cloneStep(step, {
              type: 'click',
              name: `Click ${step.name} at the saved position`,
              params: {
                x: Number(p.fallbackX),
                y: Number(p.fallbackY),
                button: p.button || 'left',
                ...(p.window || p.foreground ? { foreground: p.window || p.foreground } : {}),
              },
            }),
          ],
          { replaces: true }
        );
      }
      add('press Enter on the focused control', [
        cloneStep(step, {
          type: 'key',
          name: `Activate ${step.name} with Enter`,
          params: { keys: 'enter', ...(p.window || p.foreground ? { foreground: p.window || p.foreground } : {}) },
        }),
      ], { replaces: true });
      break;
    }
    case 'type': {
      const guard = p.foreground || p.window ? { foreground: p.foreground || p.window } : {};
      add('select-all and retype', [
        cloneStep(step, { type: 'key', name: 'Select the existing text', params: { keys: 'ctrl+a', ...guard } }),
        cloneStep(step, { name: `${step.name} (retype)` }),
      ], { replaces: true, reason: 'The field may have received only part of the text or retained old content.' });
      if (p.text != null || p.textVar) {
        add('paste through the clipboard', [
          cloneStep(step, {
            type: 'clipboard',
            name: `Paste ${step.name} from the clipboard`,
            params: {
              action: 'paste',
              ...(p.text != null ? { text: p.text } : {}),
              ...(p.textVar ? { textVar: p.textVar } : {}),
              ...guard,
            },
          }),
        ], { replaces: true });
      }
      break;
    }
    case 'openUrl': {
      const url = String(p.url || '').trim();
      if (url) {
        if (p.app) {
          add('open with the default browser instead of the app override', [
            cloneStep(step, { name: `${step.name} (default browser)`, params: { app: '' } }),
          ], { replaces: true });
        } else {
          add('open explicitly in Chrome', [
            cloneStep(step, { name: `${step.name} (Chrome)`, params: { app: 'chrome.exe' } }),
          ], { replaces: true });
        }
        const query = searchQuery(url);
        if (query) {
          add('alternate search engine', [
            cloneStep(step, {
              name: `${step.name} (DuckDuckGo)`,
              params: { url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, app: p.app || 'chrome.exe' },
            }),
          ], { replaces: true, reason: 'A different engine may render a usable result without the blocked page.' });
        }
        if (/^http:\/\//i.test(url)) {
          add('retry over https', [cloneStep(step, { params: { url: url.replace(/^http:/i, 'https:') } })], { replaces: true });
        }
      }
      break;
    }
    case 'launchApp': {
      const leaf = processLeaf(target);
      const fallback = appFromGoal(goal || run?.workflowGoal || workflow?.description || workflow?.name || '');
      if (fallback && !target.toLowerCase().includes(fallback.name.toLowerCase())) {
        add(`launch the app named by the goal (${fallback.name})`, [
          cloneStep(step, { name: `Open ${fallback.name}`, params: { target: fallback.target } }),
        ], { replaces: true, reason: 'The original target is missing; the goal names an app that can be started.' });
      }
      if (leaf) {
        add('focus an existing window instead of launching again', [
          cloneStep(step, {
            type: 'focusWindow',
            name: `Focus ${leaf}`,
            params: { ...(/\s/.test(leaf) ? { title: leaf } : { process: leaf }) },
          }),
        ], { replaces: true, reason: 'The app may already be open under a window this launch did not match.' });
      }
      if (/\.exe$/i.test(target)) {
        add('launch the app by its bare process name', [
          cloneStep(step, { params: { target: target.replace(/\.exe$/i, '') } }),
        ], { replaces: true });
      } else if (target && !/[\\/]/.test(target)) {
        add('launch the executable name', [
          cloneStep(step, { params: { target: `${target}.exe` } }),
        ], { replaces: true });
      }
      break;
    }
    case 'focusWindow': {
      const title = String(p.title || p.windowName || p.windowTitle || '').trim();
      const process = String(p.process || '').trim() || processLeaf(title);
      const fallback = appFromGoal(goal || run?.workflowGoal || workflow?.description || workflow?.name || '');
      if (process && !p.process) {
        add('focus by process name', [
          cloneStep(step, { params: { process, title: '' } }),
        ], { replaces: true });
      }
      if (fallback) {
        add(`launch the app named by the goal (${fallback.name})`, [
          cloneStep(step, { type: 'launchApp', name: `Open ${fallback.name}`, params: { target: fallback.target } }),
          cloneStep(step, { type: 'wait', name: `Wait for ${fallback.name}`, params: { ms: 900 } }),
          cloneStep(step, { type: 'focusWindow', name: `Focus ${fallback.name}`, params: { title: fallback.title, process: fallback.process } }),
        ], { replaces: true, reason: 'The named window is missing; the goal names an app that can be started.' });
      }
      if (title && !fallback) {
        add('launch the app before focusing', [
          cloneStep(step, { type: 'launchApp', name: `Open ${title}`, params: { target: title } }),
        ]);
      }
      break;
    }
    case 'waitFor':
    case 'expect': {
      add('extended timeout and faster polling', [
        cloneStep(step, {
          params: {
            timeoutMs: Math.min(90000, Math.max(15000, num(p.timeoutMs || step.timeoutMs, 30000) * 2)),
            intervalMs: Math.min(2000, Math.max(250, num(p.intervalMs, 1000))),
          },
        }),
      ], { replaces: true });
      if (p.kind === 'window' && p.value) {
        add('refocus the expected window, then wait again', [
          cloneStep(step, { type: 'focusWindow', name: `Focus ${p.value}`, params: { title: p.value } }),
          cloneStep(step, { name: `${step.name} (after refocus)` }),
        ], { replaces: true });
      }
      break;
    }
    case 'playMedia': {
      add('settle the player and retry the play check', [
        cloneStep(step, { type: 'wait', name: 'Let the player settle', params: { ms: 1500 } }),
        cloneStep(step, { name: `${step.name} (after settle)` }),
      ], { replaces: true });
      break;
    }
    case 'mediaHold': {
      add('longer stall tolerance', [
        cloneStep(step, {
          params: {
            stallMs: Math.min(120000, Math.max(15000, num(p.stallMs, 30000) + 10000)),
            maxMs: Math.min(1800000, Math.max(60000, num(p.maxMs, 900000) + 60000)),
            checkMs: Math.min(10000, Math.max(1000, num(p.checkMs, 5000))),
          },
        }),
      ], { replaces: true, reason: 'Buffering or a slow first frame can look like a stall.' });
      break;
    }
    case 'verifyScreen':
    case 'verifyPlayback': {
      add('wait for the UI to settle, then re-check', [
        cloneStep(step, { type: 'wait', name: 'Settle before re-checking', params: { ms: 2000 } }),
        cloneStep(step, { name: `${step.name} (after settle)` }),
      ], { replaces: true });
      // A failed check is often just a lost window: continue from the furthest
      // passed step that opened or focused the player, rather than restarting.
      const anchor = resumeAnchor(run, step);
      if (anchor) {
        const anchorParams = anchor.params || {};
        const known = catalogEntry([anchorParams.target, anchorParams.app, anchorParams.title, anchorParams.window]);
        const title = String(
          anchorParams.title || anchorParams.window || anchorParams.matchTitle || known?.displayNames?.[0] || known?.name || ''
        ).trim();
        const processName =
          String(anchorParams.process || '').trim() ||
          known?.process ||
          (/^[^\\/]+\.exe$/i.test(String(anchorParams.target || '')) ? processLeaf(anchorParams.target) : '');
        if (title || processName) {
          add(`resume from “${anchor.name}” and re-check`, [
            cloneStep(anchor, {
              type: 'focusWindow',
              name: `Focus ${anchor.name}`,
              params: { ...(title ? { title } : {}), ...(processName ? { process: processName } : {}) },
              timeoutMs: 15000,
            }),
            cloneStep(step, { name: `${step.name} (after resuming ${anchor.name})` }),
          ], { reason: `“${anchor.name}” already passed; continue from its window instead of rebuilding the flow.` });
        }
      }
      // A player can be open and in front at 0:00: the media never started.
      // Press the player's own play/pause control instead of reporting failure.
      const checkText = String(error || step.error || '');
      if (step.type === 'verifyPlayback' && /never started|not started|paused|0:00/i.test(checkText)) {
        const anchorParams = (resumeAnchor(run, step) || {}).params || {};
        const known = catalogEntry([
          step.params?.title,
          step.params?.expected,
          anchorParams.target,
          anchorParams.app,
        ]);
        const playerTitle = String(
          step.params?.title || step.params?.expected || anchorParams.title || known?.displayNames?.[0] || known?.name || ''
        ).trim();
        const playerProcess = String(anchorParams.process || '').trim() || known?.process || '';
        if (playerTitle || playerProcess) {
          add('start playback in the player, then re-check', [
            cloneStep(step, {
              type: 'focusWindow',
              name: `Focus the player before starting playback`,
              params: { ...(playerTitle ? { title: playerTitle } : {}), ...(playerProcess ? { process: playerProcess } : {}) },
              timeoutMs: 15000,
            }),
            cloneStep(step, {
              type: 'key',
              name: 'Press play in the player',
              params: { keys: 'space', foreground: playerTitle || playerProcess },
              timeoutMs: 10000,
            }),
            cloneStep(step, { type: 'wait', name: 'Let playback start', params: { ms: 2500 } }),
            cloneStep(step, { name: `${step.name} (after starting playback)` }),
          ], { reason: 'The player was visible but the media had not started; its own play/pause key starts it without guessing coordinates.' });
        }
      }
      // A stopped player keeps a play button and drops the picture, so pressing
      // play is not always enough. Reopening the media through the launch step
      // that already worked restarts real playback instead of failing the run.
      if (
        step.type === 'verifyPlayback' &&
        anchor?.type === 'launchApp' &&
        /never started|not started|paused|stopped|no video|no evidence|unknown|not advancing|reported failure/i.test(checkText)
      ) {
        add(`reopen the media through “${anchor.name}”, then re-check`, [
          cloneStep(anchor, { name: `Reopen ${anchor.name}` }),
          cloneStep(step, { type: 'wait', name: 'Let the reopened media start', params: { ms: 3000 } }),
          cloneStep(step, { name: `${step.name} (after reopening the media)` }),
        ], { reason: 'The player was in front without a picture; starting the media that already launched is a real repair, not a blind retry.' });
      }
      break;
    }
    case 'downloadMedia':
    case 'writeTextFile': {
      add('retry with overwrite enabled', [
        cloneStep(step, { params: { overwrite: true } }),
      ], { replaces: true });
      break;
    }
    case 'installApp': {
      const entry = catalogEntry([p.app, p.name, p.id, p.packageId, p.target, goal, run?.workflowGoal, workflow?.description, workflow?.name]);
      const appName = String(p.app || p.name || entry?.name || '').trim();
      const usedWinget = Boolean(String(p.id || p.packageId || '').trim());
      const appTarget = String(entry?.exe?.[0] || p.target || '').trim();
      const verifySteps = appTarget
        ? [
            cloneStep(step, {
              type: 'testApp',
              name: `Verify ${appName || 'the app'} works after install`,
              params: {
                target: appTarget,
                process: String(entry?.process || p.process || '').trim(),
                title: String(p.title || entry?.name || appName || '').trim(),
                settleMs: 2500,
                waitMs: 20000,
                close: false,
              },
            }),
          ]
        : [];
      if (entry || appName) {
        add(
          usedWinget ? `install ${appName || entry?.name} from the official installer instead of winget` : `install ${appName || entry?.name} with winget`,
          [
            cloneStep(step, {
              name: `${step.name} (${usedWinget ? 'official installer' : 'winget'})`,
              params: usedWinget
                ? { app: appName || entry?.name, id: '', packageId: '', url: '', urls: [], discover: true, installerArgs: '', maxAttempts: 3, version: '', source: '' }
                : { ...(entry?.wingetId ? { id: entry.wingetId } : {}), app: appName || entry?.name },
            }),
            ...verifySteps,
          ],
          {
            replaces: true,
            reason: usedWinget
              ? 'The package source may be blocked or the id stale; the vendor installer plus a launch check proves the app works.'
              : 'A broken download or installer can be replaced by the package manager, and the app is launched to prove it works.',
          }
        );
      }
      if (p.url || (Array.isArray(p.urls) && p.urls.length)) {
        add('retry the same installer source with a longer timeout', [
          cloneStep(step, { params: { timeoutMs: Math.min(1800000, Math.max(600000, num(step.timeoutMs, 900000) * 2)) } }),
          ...verifySteps,
        ], { replaces: true });
      }
      break;
    }
    default: {
      if (['wait', 'screenshot', 'note', 'writeNote'].includes(step.type)) break;
      add('retry with a longer timeout', [
        cloneStep(step, { timeoutMs: Math.min(300000, Math.max(15000, num(step.timeoutMs, 15000) * 1.5)) }),
      ], { replaces: true });
    }
  }
  return out.slice(0, 8);
}

/** True for steps that send keyboard, pointer or media input into the desktop. */
export function requiresInput(step) {
  return INPUT_TYPES.has(String(step?.type || ''));
}

/** A guarded input step may continue after an earlier failure; an unguarded one may not. */
export function hasInputGuard(step) {
  const p = step?.params || {};
  return Boolean(p.foreground || p.window || p.title || p.process);
}

export function canContinueSafely(step) {
  return !requiresInput(step) || hasInputGuard(step);
}

/** Distinguishes repairs that only work for one action or window target. */
export function repairMemoryKey(step) {
  const p = step?.params || {};
  const action = String(p.action || '').trim().toLowerCase();
  const target = String(p.target || p.title || p.process || '').trim().toLowerCase();
  return [step?.type || 'step', action, target].filter(Boolean).join(':');
}

export function repairSignature(step, error) {
  const message = String(error || step?.error || 'failed')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${step?.type || 'step'}:${message}`;
}

/** Advice from the agents that are already enabled, tailored to the failure. */
export function repairAdvice(db, { step, failure } = {}) {
  const category = failure?.category || 'unknown';
  const detail = CATEGORY_ADVICE[category] || CATEGORY_ADVICE.unknown;
  return (db?.agents || [])
    .filter((agent) => agent.enabled && KIND_ADVICE[agent.kind])
    .map((agent) => ({
      name: agent.name || agent.kind,
      kind: agent.kind,
      advice: `${KIND_ADVICE[agent.kind]} ${detail}`,
    }));
}

/** Successful methods persist in the store and are reused in later sessions. */
export function recallRepairMemory(db, { step, failure, workflowId = '', limit = 2 } = {}) {
  const entries = db?.repairMemory;
  if (!Array.isArray(entries) || !step) return [];
  const key = repairMemoryKey(step);
  const sameAction = (entry) => !entry.key || entry.key === key;
  const exact = entries.filter(
    (entry) =>
      entry.stepType === step.type &&
      entry.signature === failure?.signature &&
      sameAction(entry) &&
      (!workflowId || !entry.workflowId || entry.workflowId === workflowId)
  );
  // Never reuse a method just because another workflow had a step with the same
  // name; the failure signature has to match too.
  const pool = exact.length
    ? exact
    : entries.filter(
        (entry) => entry.stepType === step.type && entry.signature === failure?.signature && sameAction(entry)
      );
  return pool
    .slice()
    .sort((a, b) => (num(b.uses) - num(a.uses)) || String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')))
    .slice(0, limit)
    .map((entry) => ({
      method: `remembered: ${entry.method}`,
      steps: (entry.steps || []).map((saved, index) => ({
        ...saved,
        id: `${saved.id || saved.type || 'step'}_mem${index}`,
        attempts: 0,
        repairs: [],
      })),
      replaces: entry.replaces !== false,
      reason: 'Saved from an earlier successful repair.',
    }));
}

export function rememberRepairMemory(
  db,
  { workflowId = '', step, failure, method = '', steps = [], replaces = false } = {}
) {
  if (!db || !step || !method || !Array.isArray(steps) || !steps.length) return null;
  if (!Array.isArray(db.repairMemory)) db.repairMemory = [];
  const key = repairMemoryKey(step);
  const existing = db.repairMemory.find(
    (entry) =>
      entry.workflowId === workflowId &&
      entry.stepType === step.type &&
      entry.key === key &&
      entry.signature === (failure?.signature || '') &&
      entry.method === method
  );
  const at = new Date().toISOString();
  if (existing) {
    existing.stepName = step.name;
    existing.steps = steps;
    existing.replaces = Boolean(replaces);
    existing.uses = num(existing.uses) + 1;
    existing.lastUsedAt = at;
    return existing;
  }
  const entry = {
    id: `rm_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    workflowId,
    stepType: step.type,
    stepName: step.name,
    key,
    signature: failure?.signature || '',
    method,
    steps,
    replaces: Boolean(replaces),
    uses: 1,
    createdAt: at,
    lastUsedAt: at,
  };
  db.repairMemory.unshift(entry);
  db.repairMemory = db.repairMemory.slice(0, MAX_MEMORY);
  return entry;
}

export function failedStepEntries(run) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  return steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === 'failed')
    .map(({ step, index }) => ({
      index,
      stepNumber: index + 1,
      total: steps.length,
      id: step.id,
      name: step.name,
      type: step.type,
      error: step.error || 'Step failed',
      attempts: Number(step.attempts || 0),
      repairs: (step.repairs || []).length,
      repaired: Boolean(step.repairedBy),
      repairedBy: step.repairedBy || null,
      optional: Boolean(step.optional),
    }));
}

export function failureSummary(entries = []) {
  return entries
    .map(
      (entry) =>
        `Step ${entry.stepNumber}/${entry.total} “${entry.name}” (${entry.type}) failed${
          entry.attempts > 1 ? ` after ${entry.attempts} attempts` : ''
        }: ${clip(entry.error, 200)}`
    )
    .join(' | ');
}
