import path from 'node:path';
import fs from 'node:fs';
import { db, persist, uid, now, logActivity, DATA, CAPTURES } from './store.js';
import { eligibleShortcuts } from './shortcuts.js';
import { runPowerShell, IS_WINDOWS } from './automation.js';

const MAX_HABITS = 80;
const MAX_PATTERNS = 60;
const MAX_PROPOSALS = 40;
const MAX_QUICK_HELP = 24;
const MAX_NOTIFICATIONS = 40;
const MAX_CONTINUATIONS = 40;
const SYSTEM_TTL_MS = 5 * 60 * 1000;

function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clean(value, max = 120) {
  return clip(value, max);
}

function stableId(kind, key) {
  let hash = 2166136261;
  for (const ch of `${kind}:${key}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}_${(hash >>> 0).toString(36)}`;
}

function blankCompanion() {
  return {
    version: 1,
    enabled: true,
    createdAt: now(),
    lastScanAt: null,
    scans: 0,
    system: null,
    habits: { apps: [], files: [], urls: [], inputs: [], timings: [], transitions: [], routines: [] },
    patterns: [],
    proposals: [],
    quickHelp: [],
    notifications: [],
    continuations: [],
    learnedRunIds: [],
    dismissed: [],
    notes: [],
  };
}

export function ensureCompanion() {
  const d = db();
  if (!d.companion || typeof d.companion !== 'object') d.companion = blankCompanion();
  const c = d.companion;
  for (const [key, value] of Object.entries(blankCompanion())) {
    if (c[key] === undefined) c[key] = Array.isArray(value) ? [] : value;
  }
  c.habits = c.habits && typeof c.habits === 'object' ? c.habits : {};
  for (const key of ['apps', 'files', 'urls', 'inputs', 'timings', 'transitions', 'routines']) {
    if (!Array.isArray(c.habits[key])) c.habits[key] = [];
  }
  for (const key of ['patterns', 'proposals', 'quickHelp', 'notifications', 'continuations', 'dismissed', 'notes']) {
    if (!Array.isArray(c[key])) c[key] = [];
  }
  return c;
}

function setting(name, fallback) {
  const value = db().settings?.[name];
  return value === undefined ? fallback : value;
}

function isSensitive(label, value) {
  return /password|passwd|secret|token|api[-_ ]?key|credential|credit card|card number|\bssn\b|social security|\bcvv\b|\bpin\b|authorization|bearer|session id|private key|seed phrase|recovery phrase/i.test(
    `${label || ''} ${value || ''}`
  );
}

function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|api[-_]?key|secret|auth|session|signature|\bsig\b|password|passwd|email|credential|\bcode\b/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return clip(parsed.toString(), 220);
  } catch {
    return clip(
      raw
        .replace(/([?&](?:token|api[-_]?key|secret|auth|session|signature|sig|password|passwd|email|credential|code)=)[^&#]*/gi, '$1[redacted]')
        .replace(/\/\/[^/@\s]+@/, '//')
        .replace(/#.*$/, ''),
      220
    );
  }
}

function recordHabit(list, key, seed = {}, delta = 1, max = MAX_HABITS) {
  if (!key) return null;
  let item = list.find((entry) => entry.key === key);
  if (!item) {
    item = { key, count: 0, firstAt: now(), ...seed };
    list.push(item);
  }
  item.count = Number(item.count || 0) + delta;
  item.lastAt = now();
  for (const [field, value] of Object.entries(seed)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      item[field] = [...new Set([...(item[field] || []), ...value])].slice(0, 8);
    } else if (item[field] === undefined || item[field] === null || item[field] === '') {
      item[field] = value;
    }
  }
  list.sort((a, b) => Number(b.lastAt > a.lastAt) - Number(a.lastAt > b.lastAt) || Number(b.count) - Number(a.count));
  return item;
}

function appNameFromStep(step) {
  const p = step?.params || {};
  return clean(p.target || p.title || p.windowName || p.windowTitle || p.window || p.app || p.process || '', 90);
}

function fileHintsForStep(step) {
  const p = step?.params || {};
  const hints = [];
  for (const key of ['path', 'file', 'fileName', 'filename', 'target']) {
    const value = String(p[key] || '').trim();
    if (
      value &&
      (/(?:[\\/]|\.(?:txt|md|json|csv|log|pdf|docx?|xlsx?|png|jpe?g))$/i.test(value) || step?.type === 'writeTextFile')
    ) {
      hints.push(value);
    }
  }
  const text = String(p.text || '');
  for (const match of text.matchAll(/[\w .-]+\.(?:txt|md|json|csv|log|pdf|docx?|xlsx?|png|jpg)\b/gi)) {
    hints.push(match[0].trim());
  }
  return [...new Set(hints)].slice(0, 4);
}

function fileName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return clean(text.split(/[\\/]/).pop() || text, 100);
}

function looksLikeFilePath(value) {
  return /(?:[\\/]|\.[a-z0-9]{2,6}$)/i.test(String(value || ''));
}

function questionFromStep(step) {
  if (step?.type !== 'type' && step?.type !== 'clipboard') return '';
  const text = String(step.params?.text || step.params?.value || '').trim();
  if (!text || text.length > 500) return '';
  return /\?\s*$/.test(text) || /^(?:what|why|how|when|where|who|can|could|would|should|is|are|do|does)\b/i.test(text)
    ? text
    : '';
}

function addTransition(c, from, to) {
  if (!from || !to || from === to) return;
  recordHabit(c.habits.transitions, `${from}>${to}`, { from, to }, 1, 60);
}

function appKey(value) {
  return clean(value || '', 90).replace(/\.exe$/i, '').toLowerCase();
}

export function learnRun(run) {
  if (
    !run ||
    run.shadow ||
    setting('companionEnabled', true) === false ||
    setting('companionLearning', true) === false
  ) {
    return null;
  }
  const c = ensureCompanion();
  if (c.learnedRunIds.includes(run.id)) return c;
  const workflow = run.workflowSnapshot || db().workflows.find((entry) => entry.id === run.workflowId) || {};
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const app = run.presenter?.app || {};
  let previousApp = '';
  const touchedApps = [];

  const rememberApp = (value, extra = {}) => {
    const key = appKey(value);
    if (!key) return '';
    if (looksLikeFilePath(value) && !/\.exe$/i.test(String(value))) return '';
    const label = clean(value, 90);
    recordHabit(c.habits.apps, key, { name: label, paths: extra.path ? [extra.path] : [], methods: extra.method ? [extra.method] : [] });
    if (!touchedApps.includes(label)) touchedApps.push(label);
    addTransition(c, previousApp, label);
    previousApp = label;
    return label;
  };

  if (app.name || app.target) rememberApp(app.name || app.target, { path: app.path, method: app.method });
  for (const step of steps) {
    const target = appNameFromStep(step);
    if (['launchApp', 'focusWindow'].includes(step.type)) rememberApp(target, { method: step.type });
    if (step.type === 'openUrl' && step.params?.url) {
      const url = safeUrl(step.params.url);
      recordHabit(c.habits.urls, url, { url, title: clean(step.params.title || step.name, 120) });
    }
    for (const file of fileHintsForStep(step)) {
      recordHabit(c.habits.files, clean(file, 220), { path: clean(file, 220), name: fileName(file), ext: path.extname(file).slice(1) || 'file' });
    }
    const question = questionFromStep(step);
    if (question) {
      if (!isSensitive('typed question', question)) {
        recordHabit(c.habits.inputs, `question:${clean(question, 120)}`, {
          kind: 'question',
          label: clean(step.name || 'Typed question', 100),
          value: clean(question, 180),
          app: target || app.name || app.target || '',
        });
      }
    } else if (step.type === 'type' && String(step.params?.text || '').trim()) {
      const label = clean(`${step.name || 'Typed input'} in ${workflow.name || 'workflow'}`, 120);
      const value = String(step.params.text).trim();
      if (!isSensitive(label, value)) {
        recordHabit(c.habits.inputs, `text:${clean(value, 120)}`, {
          kind: 'text',
          label,
          value: clean(value, 180),
          app: target || app.name || app.target || '',
        });
      }
    }
    if (Number(step.ms) > 0) {
      const key = step.type || 'step';
      let timing = c.habits.timings.find((entry) => entry.key === key);
      if (!timing) {
        timing = { key, action: key, count: 0, samples: 0, avgMs: 0, firstAt: now() };
        c.habits.timings.push(timing);
      }
      const samples = Number(timing.samples || 0) + 1;
      timing.avgMs = Math.round((Number(timing.avgMs || 0) * Number(timing.samples || 0) + Number(step.ms)) / samples);
      timing.samples = samples;
      timing.count = Number(timing.count || 0) + 1;
      timing.lastAt = now();
    }
  }
  if (touchedApps.length) {
    const routineKey = clean(`${workflow.name || run.workflowName || 'workflow'}>${touchedApps.join('>')}`, 200);
    recordHabit(c.habits.routines, routineKey, {
      label: workflow.name || run.workflowName || 'Workflow routine',
      apps: touchedApps.slice(0, 8),
      workflowId: run.workflowId,
      goal: clip(workflow.description || run.presenter?.goal || '', 220),
    }, 1, 50);
  }
  const existingContinuation = c.continuations.find((entry) => entry.runId === run.id);
  if (run.status === 'failed') {
    if (existingContinuation) {
      existingContinuation.status = run.recovery?.status === 'retrying'
        ? 'retrying'
        : 'needs_attention';
      existingContinuation.retryRunId = run.recovery?.retryRunId || existingContinuation.retryRunId || null;
      existingContinuation.at = existingContinuation.at || now();
    } else {
      c.continuations.unshift({
        id: uid('cont'),
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName || workflow.name || '',
        status: run.recovery?.status === 'retrying'
          ? 'retrying'
          : 'needs_attention',
        reason: run.lastError || run.failureSignature || 'Run did not complete.',
        retryRunId: run.recovery?.retryRunId || null,
        at: now(),
      });
    }
  } else if (run.status === 'passed' && existingContinuation) {
    existingContinuation.status = 'completed';
    existingContinuation.checkedAt = now();
  }
  c.continuations = c.continuations.slice(0, MAX_CONTINUATIONS);
  c.learnedRunIds = [run.id, ...c.learnedRunIds.filter((id) => id !== run.id)].slice(0, 200);
  c.habits.apps = c.habits.apps.slice(0, MAX_HABITS);
  c.habits.files = c.habits.files.slice(0, MAX_HABITS);
  c.habits.urls = c.habits.urls.slice(0, MAX_HABITS);
  c.habits.inputs = c.habits.inputs.slice(0, MAX_HABITS);
  c.habits.timings = c.habits.timings.slice(0, MAX_HABITS);
  c.habits.transitions = c.habits.transitions.slice(0, MAX_HABITS);
  c.habits.routines = c.habits.routines.slice(0, 50);
  persist();
  return c;
}

async function readSystem() {
  const c = ensureCompanion();
  if (
    c.system &&
    !c.system.error &&
    c.system.duplicates !== undefined &&
    Date.now() - Date.parse(c.system.at || 0) < SYSTEM_TTL_MS
  ) {
    return c.system;
  }
  const duplicateCount = (() => {
    const seen = new Map();
    let duplicates = 0;
    for (const dir of [path.join(DATA, 'files'), CAPTURES]) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(full);
          const key = `${entry.name}:${stat.size}`;
          if (seen.has(key)) duplicates += 1;
          else seen.set(key, full);
        } catch {}
      }
    }
    return duplicates;
  })();
  if (!IS_WINDOWS) {
    c.system = { at: now(), supported: false, diskFreeGb: null, ramUsedPct: null, browserMb: null, recycleItems: null, duplicates: duplicateCount };
    return c.system;
  }
  const script = [
    '$disk=""; $ram=""; $browser=""; $rb=""',
    'try { $drive=Get-PSDrive C -ErrorAction Stop; if ($drive) { $disk=[math]::Round($drive.Free/1GB,1) } } catch {}',
    'try { $os=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; if ($os) { $ram=[math]::Round((1-($os.FreePhysicalMemory/$os.TotalVisibleMemorySize))*100,0) } } catch {}',
    'try { $procs=Get-Process chrome,msedge -ErrorAction SilentlyContinue; if ($procs) { $browser=[math]::Round(((($procs | Measure-Object WorkingSet64 -Sum).Sum)/1MB),0) } } catch {}',
    'try { $rb=(New-Object -ComObject Shell.Application).NameSpace(10).Items().Count } catch {}',
    '"$disk|$ram|$browser|$rb"',
  ].join('; ');
  const result = await runPowerShell(script, 12000);
  const [diskFreeGb, ramUsedPct, browserMb, recycleItems] = String(result.stdout || '')
    .split('|')
    .map((value) => (String(value).trim() === '' ? null : Number(value)));
  c.system = {
    at: now(),
    supported: true,
    diskFreeGb: Number.isFinite(diskFreeGb) ? diskFreeGb : null,
    ramUsedPct: Number.isFinite(ramUsedPct) ? ramUsedPct : null,
    browserMb: Number.isFinite(browserMb) ? browserMb : null,
    recycleItems: Number.isFinite(recycleItems) ? recycleItems : null,
    duplicates: duplicateCount,
    error: result.ok ? null : clip(result.stderr, 180),
  };
  return c.system;
}

function upsertProposal(c, proposal) {
  if (!proposal?.key || c.dismissed.includes(proposal.key)) return null;
  const existing = c.proposals.find((entry) => entry.key === proposal.key);
  if (existing) {
    Object.assign(existing, proposal, { updatedAt: now(), createdAt: existing.createdAt });
    return existing;
  }
  const created = { id: stableId('cmp', proposal.key), createdAt: now(), status: 'pending', ...proposal };
  c.proposals.unshift(created);
  return created;
}

function upsertNotification(c, notification) {
  if (!notification?.key || c.dismissed.includes(notification.key)) return null;
  const existing = c.notifications.find((entry) => entry.key === notification.key);
  if (existing) return existing;
  const created = { id: stableId('cnotif', notification.key), at: now(), read: false, ...notification };
  c.notifications.unshift(created);
  return created;
}

function quickHelpFromHabits(c) {
  const out = [];
  const topApps = [...c.habits.apps].sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 6);
  for (const app of topApps) {
    if (!app.name) continue;
    if (looksLikeFilePath(app.name) && !/\.exe$/i.test(app.name)) continue;
    out.push({
      id: stableId('qh', `app:${app.key}`),
      key: `app:${app.key}`,
      kind: 'app',
      label: `Open ${app.name}`,
      detail: `Used ${app.count} time${app.count === 1 ? '' : 's'}${app.methods?.length ? ` · ${app.methods[0]}` : ''}`,
      confidence: Math.min(96, 45 + Number(app.count) * 8),
      action: { type: 'launchApp', params: { target: app.name } },
    });
  }
  const topFiles = [...c.habits.files].sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 4);
  for (const file of topFiles) {
    if (looksLikeFilePath(file.path)) {
      out.push({
        id: stableId('qh', `file:${file.key}`),
        key: `file:${file.key}`,
        kind: 'file',
        label: `Open ${file.name || fileName(file.path)}`,
        detail: `Remembered file · ${file.count} use${file.count === 1 ? '' : 's'}`,
        confidence: Math.min(92, 40 + Number(file.count) * 10),
        action: { type: 'launchApp', params: { target: file.path } },
      });
    }
  }
  const topUrls = [...c.habits.urls].sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 3);
  for (const page of topUrls) {
    out.push({
      id: stableId('qh', `url:${page.key}`),
      key: `url:${page.key}`,
      kind: 'url',
      label: `Open ${page.title || page.url}`,
      detail: `Remembered page · ${page.count} visit${page.count === 1 ? '' : 's'}; opens in the default browser`,
      confidence: Math.min(90, 42 + Number(page.count) * 9),
      action: { type: 'openUrl', params: { url: page.url } },
    });
  }
  const questions = c.habits.inputs.filter((entry) => entry.kind === 'question').slice(0, 3);
  for (const question of questions) {
    out.push({
      id: stableId('qh', `research:${question.key}`),
      key: `research:${question.key}`,
      kind: 'research',
      label: 'Research the last question',
      detail: clip(question.value || '', 140),
      confidence: 78,
      action: { type: 'openUrl', params: { url: `https://www.google.com/search?q=${encodeURIComponent(question.value || '')}` } },
    });
  }
  for (const habit of eligibleShortcuts(4)) {
    out.push({
      id: stableId('qh', `key:${habit.app}:${habit.keys}`),
      key: `key:${habit.app}:${habit.keys}`,
      kind: 'shortcut',
      label: `${habit.app}: ${habit.action}`,
      detail: `Learned shortcut · ${habit.confidence}% confidence`,
      confidence: habit.confidence,
      action: { type: 'key', params: { keys: habit.keys, foreground: habit.app, app: habit.app } },
    });
  }
  return out
    .filter((item) => !c.dismissed.includes(item.key))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence))
    .slice(0, MAX_QUICK_HELP);
}

function refreshDerived(c) {
  const prior = new Map(c.proposals.map((entry) => [entry.key, entry]));
  const patterns = [];
  for (const app of c.habits.apps.filter((entry) => entry.count >= 2).slice(0, 8)) {
    patterns.push({
      id: stableId('pat', `app:${app.key}`),
      key: `app:${app.key}`,
      kind: 'app-affinity',
      label: `You return to ${app.name}`,
      detail: `${app.count} recorded uses${app.methods?.length ? ` via ${app.methods.slice(0, 2).join(', ')}` : ''}.`,
      confidence: Math.min(94, 50 + app.count * 7),
      evidence: `app habit ${app.key}`,
      lastAt: app.lastAt,
    });
  }
  for (const file of c.habits.files.filter((entry) => entry.count >= 2).slice(0, 6)) {
    patterns.push({
      id: stableId('pat', `file:${file.key}`),
      key: `file:${file.key}`,
      kind: 'file-affinity',
      label: `You keep working in ${file.name || fileName(file.path)}`,
      detail: `${file.count} recorded file references; new output should not overwrite it silently.`,
      confidence: Math.min(92, 52 + file.count * 8),
      evidence: `file habit ${file.key}`,
      lastAt: file.lastAt,
    });
  }
  for (const question of c.habits.inputs.filter((entry) => entry.kind === 'question').slice(0, 4)) {
    patterns.push({
      id: stableId('pat', `question:${question.key}`),
      key: `question:${question.key}`,
      kind: 'question-input',
      label: 'Question typed in a document',
      detail: clip(question.value || '', 180),
      confidence: 74,
      evidence: 'typed question habit',
      lastAt: question.lastAt,
    });
  }
  c.patterns = patterns.slice(0, MAX_PATTERNS);

  const proposals = [];
  const latestFile = [...c.habits.files].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))[0];
  if (latestFile && latestFile.count >= 1) {
    const ext = path.extname(latestFile.path || latestFile.name || '') || '.txt';
    const base = (latestFile.name || fileName(latestFile.path) || 'notes').replace(/\.[^.]+$/, '');
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
    proposals.push({
      key: `new-file:${latestFile.key}`,
      kind: 'new-file',
      title: 'Create a fresh file instead of overwriting',
      detail: `“${latestFile.name || latestFile.path}” has been touched repeatedly. Use a new version when the topic already exists.`,
      expected: `A new ${ext} file named ${base}-${stamp}${ext} exists and the original stays intact.`,
      suggestedName: `${base}-${stamp}${ext}`,
      evidence: [`file habit ${latestFile.key}`, `${latestFile.count} reference(s)`],
      tone: 'important',
      action: { kind: 'proposal', label: 'Use a new filename' },
    });
  }
  const question = c.habits.inputs.find((entry) => entry.kind === 'question');
  if (question) {
    proposals.push({
      key: `research:${question.key}`,
      kind: 'research',
      title: 'Research the question you typed',
      detail: 'A question was typed into a document. I can open a research search in the browser, or use it as the next workflow goal.',
      expected: 'A cited answer is available without changing the original document.',
      evidence: [clip(question.value || '', 160)],
      tone: 'normal',
      action: { kind: 'quick-help', key: `research:${question.key}` },
    });
  }
  if (c.system?.diskFreeGb != null && c.system.diskFreeGb < 15) {
    proposals.push({
      key: 'disk-space',
      kind: 'cleanup',
      title: 'Disk space is getting low',
      detail: `About ${c.system.diskFreeGb} GB is free. Empty the Recycle Bin or review duplicate files before installing or saving more captures.`,
      expected: 'More free space with no important files removed; approval is required before any cleanup.',
      evidence: [`disk free ${c.system.diskFreeGb} GB`, c.system.recycleItems != null ? `${c.system.recycleItems} recycle item(s)` : ''].filter(Boolean),
      tone: 'important',
      action: { kind: 'proposal', label: 'Review cleanup' },
    });
  }
  if (c.system?.browserMb != null && c.system.browserMb > 1500) {
    proposals.push({
      key: 'browser-memory',
      kind: 'performance',
      title: 'Browser memory is high',
      detail: `Chrome/Edge are using about ${c.system.browserMb} MB. A lighter browser or fewer tabs may keep the next run responsive.`,
      expected: 'The same pages remain available with lower memory pressure; switch only after approval.',
      evidence: [`browser working set ${c.system.browserMb} MB`],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Review browser switch' },
    });
  }
  if (c.system?.duplicates > 0) {
    proposals.push({
      key: 'duplicate-files',
      kind: 'cleanup',
      title: 'Duplicate outputs found',
      detail: `${c.system.duplicates} duplicate output file(s) have the same name and size in the workspace. Review them before deleting anything.`,
      expected: 'Only redundant copies are removed; original evidence and notes stay intact.',
      evidence: [`${c.system.duplicates} duplicate file(s)`],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Review duplicates' },
    });
  }
  if (c.system?.ramUsedPct != null && c.system.ramUsedPct > 85) {
    proposals.push({
      key: 'ram-pressure',
      kind: 'performance',
      title: 'Memory pressure is high',
      detail: `RAM is about ${c.system.ramUsedPct}% used. Close unused apps or switch to a lighter browser before a long run.`,
      expected: 'The next run has enough headroom; nothing is closed without your approval.',
      evidence: [`RAM used ${c.system.ramUsedPct}%`],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Review memory cleanup' },
    });
  }
  if (c.habits.files.length >= 2) {
    proposals.push({
      key: 'backup-habit',
      kind: 'backup',
      title: 'Protect the files you keep using',
      detail: 'You regularly work with saved files. I can prepare a backup workflow after you choose a source and destination.',
      expected: 'A dated copy exists in the chosen backup folder; the original is untouched.',
      evidence: [`${c.habits.files.length} learned file habit(s)`],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Prepare backup' },
    });
  }
  const latestPass = db().runs.find((run) => run.status === 'passed' && !run.shadow);
  if (latestPass && latestPass.presenter?.summary?.goalMet) {
    proposals.push({
      key: `followup:${latestPass.id}`,
      kind: 'followup',
      title: 'Check whether this is still what you need',
      detail: `“${latestPass.workflowName}” just finished successfully. I can stop here, repeat it, or prepare the next step.`,
      expected: 'You confirm the result is still needed; no extra work is started without an answer.',
      evidence: [latestPass.id, clip(latestPass.presenter.summary.whatsDone || '', 160)],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Continue or stop' },
    });
  }
  for (const note of c.notes.slice(0, 3)) {
    proposals.push({
      key: `note:${note.id}`,
      kind: 'user-note',
      title: 'Remembered preference',
      detail: note.text,
      expected: 'The next plan and quick help reflect this note before extra work starts.',
      evidence: [`companion note ${note.id}`],
      tone: 'normal',
      action: { kind: 'proposal', label: 'Keep this preference' },
    });
  }
  c.proposals = [];
  for (const proposal of proposals) {
    const created = upsertProposal(c, proposal);
    const old = prior.get(proposal.key);
    if (created && old?.status === 'accepted') {
      created.status = 'accepted';
      created.acceptedAt = old.acceptedAt;
    }
  }
  c.proposals = c.proposals.filter((entry) => entry.status !== 'dismissed').slice(0, MAX_PROPOSALS);
  c.patterns = c.patterns.slice(0, MAX_PATTERNS);
  c.quickHelp = quickHelpFromHabits(c);
}

export async function scanCompanion({ system = true } = {}) {
  const c = ensureCompanion();
  if (!c.enabled || setting('companionEnabled', true) === false) return companionState();
  for (const run of db().runs.slice(0, 60)) {
    if (!c.learnedRunIds.includes(run.id)) learnRun(run);
  }
  c.habits.apps = c.habits.apps.filter(
    (app) => !looksLikeFilePath(app.name) || /\.exe$/i.test(String(app.name || ''))
  );
  c.scans = Number(c.scans || 0) + 1;
  c.lastScanAt = now();
  const systemScan = setting('companionSystemScan', true) !== false;
  if (!systemScan) c.system = null;
  else if (system) await readSystem();
  refreshDerived(c);
  if (setting('companionNotifications', true) !== false && setting('companionPopupPolicy', 'important') !== 'off') {
    for (const proposal of c.proposals.filter((entry) => entry.status === 'pending').slice(0, 6)) {
      const important = proposal.tone === 'important' || proposal.kind === 'cleanup' || proposal.kind === 'new-file';
      if (setting('companionPopupPolicy', 'important') === 'important' && !important) continue;
      upsertNotification(c, {
        key: `proposal:${proposal.key}`,
        kind: proposal.kind,
        title: proposal.title,
        body: clip(proposal.detail, 220),
        important,
        action: { kind: 'proposal', id: proposal.id },
      });
    }
  }
  c.notifications = c.notifications.slice(0, MAX_NOTIFICATIONS);
  for (const continuation of c.continuations) {
    const run = db().runs.find((entry) => entry.id === continuation.runId);
    if (!run) continue;
    const retryId =
      continuation.retryRunId ||
      (run.recovery?.status === 'retrying' && run.recovery.retryRunId !== run.id ? run.recovery.retryRunId : null);
    const retry = retryId ? db().runs.find((entry) => entry.id === retryId) : null;
    if (retryId) continuation.retryRunId = retryId;
    if (run.status === 'passed') continuation.status = 'completed';
    else if (retry?.status === 'passed') continuation.status = 'completed';
    else if (retry?.status === 'failed') continuation.status = 'needs_attention';
    else if (retryId) continuation.status = 'retrying';
    else if (['retrying', 'auto_pending'].includes(continuation.status)) {
      continuation.status = 'needs_attention';
    }
  }
  persist();
  return companionState();
}

export function companionState() {
  const c = ensureCompanion();
  const pending = c.proposals.filter((entry) => entry.status === 'pending');
  const unread = c.notifications.filter((entry) => !entry.read);
  const active = c.continuations.filter((entry) => ['needs_attention', 'retrying'].includes(entry.status));
  const latestRun = db().runs.find((run) => !run.shadow) || null;
  const checks = [
    {
      key: 'presenter-consistency',
      ok: !latestRun?.presenter || Boolean(latestRun.presenter.summary?.goalMet) === (latestRun.status === 'passed'),
      detail: latestRun
        ? `Latest run ${latestRun.status}; presenter says ${latestRun.presenter?.summary?.goalMet === true ? 'goal met' : latestRun.presenter?.summary?.goalMet === false ? 'not met' : 'pending'}.`
        : 'No presenter-backed run yet.',
    },
    {
      key: 'recovery-consistency',
      ok: !active.some((entry) => entry.status === 'retrying' && !entry.retryRunId),
      detail: active.some((entry) => entry.status === 'retrying' && !entry.retryRunId)
        ? 'A continuation says retrying but has no retry run.'
        : `${active.length} continuation(s) waiting.`,
    },
    {
      key: 'learning-enabled',
      ok: setting('companionLearning', true) !== false,
      detail: setting('companionLearning', true) !== false ? 'Learning is enabled.' : 'Learning is paused in settings.',
    },
  ];
  return {
    ok: true,
    enabled: c.enabled !== false && setting('companionEnabled', true) !== false,
    lastScanAt: c.lastScanAt,
    scans: c.scans,
    system: c.system,
    settings: {
      learning: setting('companionLearning', true) !== false,
      notifications: setting('companionNotifications', true) !== false,
      popupPolicy: setting('companionPopupPolicy', 'important'),
      systemScan: setting('companionSystemScan', true) !== false,
    },
    habits: c.habits,
    patterns: c.patterns.slice(0, 24),
    proposals: pending.slice(0, 12),
    quickHelp: c.quickHelp.slice(0, 12),
    notifications: c.notifications.slice(0, 20),
    continuations: c.continuations.slice(0, 12),
    notes: c.notes.slice(0, 10),
    checks,
    summary: {
      apps: c.habits.apps.length,
      files: c.habits.files.length,
      questions: c.habits.inputs.filter((entry) => entry.kind === 'question').length,
      patterns: c.patterns.length,
      proposals: pending.length,
      unread: unread.length,
      continuations: active.length,
      lastRun: latestRun?.status || null,
      checksOk: checks.filter((check) => check.ok).length,
      checksTotal: checks.length,
    },
  };
}

export function companionProposalAction(id, action = 'accept') {
  const c = ensureCompanion();
  const proposal = c.proposals.find((entry) => entry.id === id);
  if (!proposal) return null;
  if (action === 'dismiss') {
    proposal.status = 'dismissed';
    if (!c.dismissed.includes(proposal.key)) c.dismissed.push(proposal.key);
    c.dismissed = c.dismissed.slice(-400);
  } else {
    proposal.status = 'accepted';
    proposal.acceptedAt = now();
  }
  for (const notification of c.notifications) {
    if (notification.action?.id === id) notification.read = true;
  }
  persist();
  logActivity('companion', `Companion proposal ${action}: ${proposal.title}`, { proposalId: id });
  return proposal;
}

export function companionQuickHelp(id) {
  const c = ensureCompanion();
  const item = c.quickHelp.find((entry) => entry.id === id || entry.key === id);
  if (!item) return null;
  item.lastUsedAt = now();
  item.uses = Number(item.uses || 0) + 1;
  persist();
  logActivity('companion', `Quick help used: ${item.label}`, { quickHelpId: item.id });
  return item;
}

export function companionDismissQuickHelp(id) {
  const c = ensureCompanion();
  const item = c.quickHelp.find((entry) => entry.id === id || entry.key === id);
  if (!item) return null;
  if (!c.dismissed.includes(item.key)) c.dismissed.push(item.key);
  c.dismissed = c.dismissed.slice(-400);
  c.quickHelp = c.quickHelp.filter((entry) => entry.id !== id && entry.key !== id);
  persist();
  return { ok: true };
}

export function companionNotes() {
  const c = ensureCompanion();
  return c.notes.slice(0, 15);
}

export function markCompanionContinuation(runId, patch = {}) {
  const c = ensureCompanion();
  const continuation = c.continuations.find((entry) => entry.runId === runId);
  if (!continuation) return null;
  for (const key of ['status', 'retryRunId', 'reason', 'checkedAt']) {
    if (patch[key] !== undefined) continuation[key] = patch[key];
  }
  persist();
  return continuation;
}

export function addCompanionNote(text) {
  const c = ensureCompanion();
  const note = { id: uid('cnote'), at: now(), text: clip(text, 500) };
  c.notes.unshift(note);
  c.notes = c.notes.slice(0, 40);
  refreshDerived(c);
  persist();
  return note;
}

export function markCompanionNotification(id, read = true) {
  const c = ensureCompanion();
  const notification = c.notifications.find((entry) => entry.id === id);
  if (!notification) return null;
  notification.read = Boolean(read);
  persist();
  return notification;
}

export function clearCompanionNotifications() {
  const c = ensureCompanion();
  for (const notification of c.notifications) notification.read = true;
  persist();
  return { ok: true };
}
