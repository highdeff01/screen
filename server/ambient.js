import path from 'node:path';
import {
  db,
  persist,
  uid,
  now,
  slug,
  logActivity,
  NOTES,
  ROOT,
  writeFileDurable,
} from './store.js';
import { IS_WINDOWS, runPowerShell, readForegroundWindow, executeStep } from './automation.js';

/**
 * Ambient agent: a frame clock that runs at the monitor refresh rate and a
 * preference model that reacts to the foreground app.
 *
 * The frame clock is cheap on purpose: every frame updates counters and checks
 * deadlines, while the desktop is sampled on `settings.sampleMs` (a PowerShell
 * process is far too expensive to spawn 60 times a second). Layout actions are
 * only applied when the foreground app changes, so the loop stays quiet.
 */

const MAX_RULES = 40;
const MAX_SCHEDULES = 40;
const MAX_ACTIONS = 60;
const MAX_NOTIFICATIONS = 40;
const MAX_PROPOSALS = 20;
const MAX_APPS = 40;
const MAX_TRANSITIONS = 40;
const OBSERVE_PERSIST_MS = 20000;
const MAX_ACTIONS_PER_MINUTE = 8;

const MEDIA = /vlc|mpv|mpc[- ]?hc|potplayer|wmplayer|media player|movies|films|netflix|youtube|prime video|disney|plex|kodi|quicktime|iina|player/i;
const MEETING = /teams|zoom|webex|meet|skype/i;

const LAYOUTS = ['cinema', 'maximize', 'center', 'snapLeft', 'snapRight', 'restore', 'none'];
const RULE_KINDS = ['comfort', 'shortcut', 'focus', 'notify'];

const runtime = {
  frameTimer: null,
  startedAt: null,
  hz: 60,
  hzSource: 'default',
  frames: 0,
  samples: 0,
  droppedFrames: 0,
  workMs: 0,
  lastFrameAt: null,
  busy: false,
  scheduleBusy: false,
  lastSampleAt: null,
  lastScheduleCheckAt: null,
  lastPersistAt: 0,
  lastWindow: null,
  lastError: null,
  recentFires: [],
};

const clip = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const psSingle = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

function parseDays(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
  return parts
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function blankAmbient() {
  return {
    version: 1,
    enabled: true,
    createdAt: now(),
    lastTickAt: null,
    settings: {
      sampleMs: 750,
      frameClock: true,
      popups: 'important',
      comfort: true,
      shortcuts: true,
      learning: true,
      notifyOnControl: true,
      maxActionsPerMinute: MAX_ACTIONS_PER_MINUTE,
    },
    rules: [
      {
        id: 'rule_movie_cinema',
        name: 'Movie night comfort',
        kind: 'comfort',
        enabled: false,
        match: { process: 'vlc|mpv|potplayer|wmplayer|netflix|youtube', title: '' },
        layout: 'cinema',
        keys: '',
        mode: 'enter',
        cooldownMs: 600000,
        notify: true,
        note: 'Maximizes a media player when it becomes the foreground app. Enable after a quick test.',
        source: 'seed',
        createdAt: now(),
        updatedAt: now(),
        lastFiredAt: null,
        lastKey: null,
        fireCount: 0,
      },
    ],
    schedules: [],
    habits: { apps: [], transitions: [], lastProcess: '', totalSamples: 0 },
    actions: [],
    notifications: [],
    proposals: [],
    dismissedKeys: [],
    notes: [],
  };
}

export function ensureAmbient() {
  const d = db();
  let created = false;
  if (!d.ambient || typeof d.ambient !== 'object') {
    d.ambient = blankAmbient();
    created = true;
  }
  const a = d.ambient;
  const base = blankAmbient();
  for (const key of Object.keys(base)) {
    if (a[key] === undefined) a[key] = Array.isArray(base[key]) ? [] : base[key];
  }
  a.settings = { ...base.settings, ...(a.settings || {}) };
  a.habits = a.habits && typeof a.habits === 'object' ? a.habits : { apps: [], transitions: [], lastProcess: '', totalSamples: 0 };
  for (const key of ['apps', 'transitions']) {
    if (!Array.isArray(a.habits[key])) a.habits[key] = [];
  }
  for (const key of ['rules', 'schedules', 'actions', 'notifications', 'proposals', 'dismissedKeys']) {
    if (!Array.isArray(a[key])) a[key] = [];
  }
  if (created) persist();
  return a;
}

function notify(title, body, { kind = 'control', important = false } = {}) {
  const a = ensureAmbient();
  const entry = {
    id: uid('ambn'),
    at: now(),
    title: clip(title, 120),
    body: clip(body, 300),
    kind,
    important: Boolean(important),
    read: false,
  };
  a.notifications.unshift(entry);
  a.notifications = a.notifications.slice(0, MAX_NOTIFICATIONS);
  persist();
  return entry;
}

function recordAction(action) {
  const a = ensureAmbient();
  a.actions.unshift(action);
  a.actions = a.actions.slice(0, MAX_ACTIONS);
  persist();
}

/* ------------------------------------------------------------------ settings */

export function ambientSettings(patch = {}) {
  const a = ensureAmbient();
  const s = a.settings;
  if (patch.enabled !== undefined) a.enabled = Boolean(patch.enabled);
  if (patch.sampleMs !== undefined) s.sampleMs = Math.max(250, Math.min(10000, Number(patch.sampleMs) || 750));
  if (patch.frameClock !== undefined) s.frameClock = Boolean(patch.frameClock);
  if (patch.popups !== undefined) s.popups = ['all', 'important', 'off'].includes(patch.popups) ? patch.popups : 'important';
  if (patch.comfort !== undefined) s.comfort = Boolean(patch.comfort);
  if (patch.shortcuts !== undefined) s.shortcuts = Boolean(patch.shortcuts);
  if (patch.learning !== undefined) s.learning = Boolean(patch.learning);
  if (patch.notifyOnControl !== undefined) s.notifyOnControl = Boolean(patch.notifyOnControl);
  persist();
  logActivity('ambient', `Ambient settings updated (${a.enabled ? 'on' : 'off'})`);
  // Only a deliberate enable/disable changes the loop; editing a value must not
  // start a clock that the operator never asked for.
  if (patch.enabled !== undefined) {
    if (a.enabled) startAmbient();
    else stopAmbient();
  }
  return ambientState();
}

/* ------------------------------------------------------------------- rules */

function normalizePattern(value) {
  // Accept plain text or a regular expression; keep it a string for storage.
  return String(value || '').trim().slice(0, 200);
}

function ruleInput(body = {}) {
  const kind = RULE_KINDS.includes(body.kind) ? body.kind : 'comfort';
  const match = {
    process: normalizePattern(body.process ?? body.match?.process),
    title: normalizePattern(body.title ?? body.match?.title),
  };
  if (!match.process && !match.title) throw new Error('Give the rule a process or window-title pattern, so it cannot match every app.');
  const layout = LAYOUTS.includes(body.layout) ? body.layout : 'cinema';
  const keys = Array.isArray(body.keys) ? body.keys.join(' ') : String(body.keys || '').trim().slice(0, 120);
  if (kind === 'shortcut' && !keys) throw new Error('A shortcut rule needs keys, e.g. ctrl+shift+m or {F11}.');
  if (kind === 'comfort' && layout === 'none' && !keys) throw new Error('Pick a layout or add follow-up keys for a comfort rule.');
  const schedule = body.schedule && !body.days && !body.from && !body.to
    ? body.schedule
    : body.days || body.from || body.to
    ? {
        days: parseDays(body.days),
        from: /^\d{1,2}:\d{2}$/.test(String(body.from || '')) ? String(body.from) : '',
        to: /^\d{1,2}:\d{2}$/.test(String(body.to || '')) ? String(body.to) : '',
      }
    : null;
  return {
    name: clip(body.name || 'Ambient rule', 80),
    kind,
    enabled: body.enabled !== false,
    match,
    layout,
    keys,
    mode: body.mode === 'always' ? 'always' : 'enter',
    cooldownMs: Math.max(5000, Math.min(86400000, Number(body.cooldownSeconds || 0) * 1000 || Number(body.cooldownMs) || 120000)),
    notify: body.notify !== false,
    schedule,
    note: clip(body.note || '', 200),
  };
}

export function createRule(body = {}) {
  const a = ensureAmbient();
  const input = ruleInput(body);
  if (a.rules.length >= MAX_RULES) throw new Error(`At most ${MAX_RULES} ambient rules are allowed.`);
  const rule = { id: uid('rule'), ...input, source: 'operator', createdAt: now(), updatedAt: now(), lastFiredAt: null, lastKey: null, fireCount: 0 };
  a.rules.unshift(rule);
  persist();
  logActivity('ambient', `Rule “${rule.name}” added (${rule.kind}${rule.layout !== 'none' ? ` · ${rule.layout}` : ''})`);
  return rule;
}

export function updateRule(id, body = {}) {
  const rule = ensureAmbient().rules.find((entry) => entry.id === id);
  if (!rule) throw new Error('Ambient rule not found');
  if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled);
  if (body.name !== undefined) rule.name = clip(body.name, 80);
  if (body.cooldownSeconds !== undefined) rule.cooldownMs = Math.max(5000, Number(body.cooldownSeconds) * 1000 || 120000);
  if (body.notify !== undefined) rule.notify = Boolean(body.notify);
  if (Object.keys(body).some((key) => ['process', 'title', 'kind', 'layout', 'keys', 'mode', 'days', 'from', 'to', 'match'].includes(key))) {
    Object.assign(rule, ruleInput({ ...rule, ...body, match: { ...rule.match, ...(body.match || {}) } }));
  }
  rule.updatedAt = now();
  persist();
  return rule;
}

export function deleteRule(id) {
  const a = ensureAmbient();
  const index = a.rules.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error('Ambient rule not found');
  const [rule] = a.rules.splice(index, 1);
  a.dismissedKeys = [...new Set([...(a.dismissedKeys || []), `rule:${rule.name.toLowerCase()}`])].slice(-80);
  persist();
  logActivity('ambient', `Rule “${rule.name}” removed`);
  return rule;
}

/* --------------------------------------------------------------- schedules */

export function createSchedule(body = {}) {
  const a = ensureAmbient();
  if (a.schedules.length >= MAX_SCHEDULES) throw new Error(`At most ${MAX_SCHEDULES} ambient schedules are allowed.`);
  const at = /^\d{1,2}:\d{2}$/.test(String(body.at || '')) ? String(body.at).padStart(5, '0') : '';
  if (!at) throw new Error('A schedule needs a time of day in HH:MM form.');
  const kind = ['launch', 'notify', 'note', 'workflow'].includes(body.actionKind) ? body.actionKind : 'launch';
  const target = String(body.target || '').trim().slice(0, 300);
  if (['launch', 'workflow'].includes(kind) && !target) throw new Error('This schedule needs a target (an app, file or workflow).');
  if (kind === 'workflow' && !db().workflows.some((workflow) => workflow.id === target)) {
    throw new Error('Pick an existing workflow for this schedule.');
  }
  const schedule = {
    id: uid('sch'),
    name: clip(body.name || `${kind} at ${at}`, 80),
    at,
    days: parseDays(body.days),
    enabled: body.enabled !== false,
    action: { kind, target, text: clip(body.text || '', 500) },
    lastFiredKey: null,
    lastFiredAt: null,
    fireCount: 0,
    createdAt: now(),
  };
  a.schedules.push(schedule);
  persist();
  logActivity('ambient', `Schedule “${schedule.name}” added for ${schedule.at}`);
  return schedule;
}

export function updateSchedule(id, body = {}) {
  const schedule = ensureAmbient().schedules.find((entry) => entry.id === id);
  if (!schedule) throw new Error('Ambient schedule not found');
  if (body.enabled !== undefined) schedule.enabled = Boolean(body.enabled);
  if (body.name !== undefined) schedule.name = clip(body.name, 80);
  if (body.at !== undefined && /^\d{1,2}:\d{2}$/.test(String(body.at))) schedule.at = String(body.at).padStart(5, '0');
  persist();
  return schedule;
}

export function deleteSchedule(id) {
  const a = ensureAmbient();
  const index = a.schedules.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error('Ambient schedule not found');
  const [schedule] = a.schedules.splice(index, 1);
  persist();
  return schedule;
}

/* --------------------------------------------------------------- matching */

function patternMatch(text, pattern) {
  const value = String(text || '');
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  try {
    return new RegExp(raw, 'i').test(value);
  } catch {
    return value.toLowerCase().includes(raw.toLowerCase());
  }
}

export function ruleMatches(rule, win = {}, date = new Date()) {
  if (!rule || rule.enabled === false) return false;
  const process = win.process || '';
  const title = win.title || '';
  if (!process && !title) return false;
  const processOk = rule.match?.process ? patternMatch(process, rule.match.process) : false;
  const titleOk = rule.match?.title ? patternMatch(title, rule.match.title) : false;
  if (!processOk && !titleOk) return false;
  return withinSchedule(rule.schedule, date);
}

function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Math.min(23, Number(match[1]));
  const minutes = Math.min(59, Number(match[2]));
  return hours * 60 + minutes;
}

function withinSchedule(schedule, date = new Date()) {
  if (!schedule) return true;
  const days = Array.isArray(schedule.days) ? schedule.days.map(Number) : [];
  if (days.length && !days.includes(date.getDay())) return false;
  const from = minutesOfDay(schedule.from);
  const to = minutesOfDay(schedule.to);
  if (from == null || to == null) return true;
  const current = date.getHours() * 60 + date.getMinutes();
  return from <= to ? current >= from && current <= to : current >= from || current <= to;
}

/* ---------------------------------------------------------------- layouts */

function layoutScript({ layout, process: processName = '', title = '' }) {
  return `Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SightlineAmbient {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr z, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}
"@
$wanted = ${psSingle(processName)}
$titleWanted = ${psSingle(title)}
$proc = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    ($wanted -and $_.ProcessName -like ('*' + $wanted + '*')) -or
    ($titleWanted -and $_.MainWindowTitle -like ('*' + $titleWanted + '*'))
  )
} | Select-Object -First 1
if (-not $proc) { [pscustomobject]@{ ok = $false; error = 'window not found' } | ConvertTo-Json -Compress; exit }
$h = $proc.MainWindowHandle
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$layoutName = ${psSingle(layout)}
if ($layoutName -eq 'restore') {
  [void][SightlineAmbient]::ShowWindow($h, 9)
} elseif ($layoutName -eq 'center') {
  $w = [int]($area.Width * 0.92)
  $ht = [int]($area.Height * 0.88)
  $x = $area.X + [int](($area.Width - $w) / 2)
  $y = $area.Y + [int](($area.Height - $ht) / 2)
  [void][SightlineAmbient]::ShowWindow($h, 9)
  [void][SightlineAmbient]::SetWindowPos($h, [IntPtr]::Zero, $x, $y, $w, $ht, 0x0040)
} elseif ($layoutName -eq 'snapLeft' -or $layoutName -eq 'snapRight') {
  $w = [int]($area.Width / 2) - 8
  $ht = $area.Height - 12
  $x = if ($layoutName -eq 'snapLeft') { $area.X + 4 } else { $area.X + [int]($area.Width / 2) + 4 }
  [void][SightlineAmbient]::ShowWindow($h, 9)
  [void][SightlineAmbient]::SetWindowPos($h, [IntPtr]::Zero, $x, $area.Y + 6, $w, $ht, 0x0040)
} else {
  # cinema and maximize both use the shell maximize, which preserves the
  # player's own borderless fullscreen shortcut for a follow-up key press.
  [void][SightlineAmbient]::ShowWindow($h, 3)
}
[void][SightlineAmbient]::SetForegroundWindow($h)
[pscustomobject]@{
  ok = $true
  layout = $layoutName
  maximized = [bool][SightlineAmbient]::IsZoomed($h)
  title = [string]$proc.MainWindowTitle
  process = [string]$proc.ProcessName
} | ConvertTo-Json -Compress`;
}

async function applyLayout(layout, win) {
  if (!IS_WINDOWS) return { ok: false, error: 'Window layouts need Windows.' };
  try {
    const res = await runPowerShell(
      layoutScript({ layout, process: win.process, title: win.title }),
      12000
    );
    if (!res.ok) return { ok: false, error: clip(res.stderr || res.stdout || 'PowerShell failed', 200) };
    const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
    return JSON.parse(line);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendKeys(keys, win) {
  const list = String(keys || '')
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!list.length) return { ok: false, error: 'No keys configured.' };
  try {
    const result = await executeStep(
      {
        id: uid('stp'),
        type: 'key',
        name: 'Ambient shortcut',
        params: { keys: list, foreground: win.title || win.process },
        timeoutMs: 12000,
      },
      { live: true, runId: null, run: { id: 'ambient' }, workflow: null, getTool: () => null }
    );
    return { ok: true, output: clip(result?.output || '', 160) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------------------------------------------------------------- actions */

function defaultKeysFor(kind, win, rule) {
  if (rule.keys) return rule.keys;
  if (kind !== 'comfort') return '';
  // Deliberately conservative: a blind fullscreen toggle would exit fullscreen
  // when the player is already there, so only explicit keys are sent.
  return '';
}

function rateLimited(a) {
  const cutoff = Date.now() - 60000;
  runtime.recentFires = runtime.recentFires.filter((at) => at > cutoff);
  return runtime.recentFires.length >= Math.max(2, Number(a.settings.maxActionsPerMinute) || MAX_ACTIONS_PER_MINUTE);
}

function describeTarget(rule, win) {
  return `${win.process || 'unknown app'}${win.title ? ` · ${clip(win.title, 60)}` : ''}`;
}

async function fireRule(rule, win, { dryRun, reason = 'foreground match' } = {}) {
  const a = ensureAmbient();
  if (rateLimited(a)) {
    runtime.lastError = 'Ambient action rate limit reached; holding this change.';
    return null;
  }
  const simulated = dryRun || !IS_WINDOWS || rule.kind === 'notify';
  const action = {
    id: uid('amba'),
    at: now(),
    ruleId: rule.id,
    ruleName: rule.name,
    kind: rule.kind,
    layout: rule.layout,
    keys: rule.keys,
    window: { process: win.process || '', title: win.title || '' },
    reason,
    simulated: Boolean(dryRun || !IS_WINDOWS),
    ok: true,
    detail: '',
  };
  if (rule.kind === 'notify') {
    action.detail = 'Notification only.';
  } else if (dryRun) {
    action.detail = `Would ${rule.kind === 'comfort' ? `set ${rule.layout}` : rule.kind === 'shortcut' ? `press ${rule.keys}` : 'focus the window'} (simulated mode).`;
  } else if (!IS_WINDOWS) {
    action.detail = 'Skipped: window control needs Windows.';
    action.ok = false;
  } else if (rule.kind === 'comfort') {
    if (rule.layout && rule.layout !== 'none') {
      const result = await applyLayout(rule.layout, win);
      action.ok = result?.ok !== false;
      action.detail = action.ok ? `Layout set to ${rule.layout}${result?.maximized ? ' (maximized)' : ''}.` : `Layout failed: ${result?.error || 'unknown error'}`;
    }
    const keys = defaultKeysFor(rule.kind, win, rule);
    if (keys) {
      const keyResult = await sendKeys(keys, win);
      action.ok = action.ok && keyResult.ok;
      action.detail = `${action.detail} ${keyResult.ok ? `Keys ${keys} sent.` : `Keys failed: ${keyResult.error}`}`.trim();
    }
  } else if (rule.kind === 'shortcut') {
    const keyResult = await sendKeys(rule.keys, win);
    action.ok = keyResult.ok;
    action.detail = keyResult.ok ? `Keys ${rule.keys} sent.` : `Keys failed: ${keyResult.error}`;
  } else if (rule.kind === 'focus') {
    try {
      await executeStep(
        { id: uid('stp'), type: 'focusWindow', name: 'Ambient focus', params: { title: win.title, process: win.process }, timeoutMs: 10000 },
        { live: true, runId: null, run: { id: 'ambient' }, workflow: null, getTool: () => null }
      );
      action.detail = 'Window brought to the foreground.';
    } catch (err) {
      action.ok = false;
      action.detail = `Focus failed: ${err.message}`;
    }
  }
  rule.lastFiredAt = now();
  rule.lastKey = `${win.process}|${win.title}`;
  rule.fireCount = Number(rule.fireCount || 0) + 1;
  runtime.recentFires.push(Date.now());
  recordAction(action);
  logActivity('ambient', `Rule “${rule.name}” ${action.ok ? 'applied' : 'failed'} on ${describeTarget(rule, win)}`, { ruleId: rule.id, actionId: action.id });
  if ((a.settings.notifyOnControl || action.simulated) && rule.notify !== false) {
    notify(
      `${rule.name} · ${action.ok ? (action.simulated ? 'planned' : 'applied') : 'failed'}`,
      `${describeTarget(rule, win)} — ${action.detail}`,
      { kind: 'control', important: rule.kind === 'comfort' && !action.simulated }
    );
  }
  return action;
}

export async function runRuleNow(id) {
  const rule = ensureAmbient().rules.find((entry) => entry.id === id);
  if (!rule) throw new Error('Ambient rule not found');
  const win = runtime.lastWindow || (await currentWindow());
  if (!win?.process && !win?.title) throw new Error('No foreground window is available to test against.');
  rule.enabled = true;
  const action = await fireRule(rule, win, { dryRun: Boolean(db().settings.dryRun), reason: 'manual test' });
  persist();
  return { rule, action, ambient: ambientState() };
}

/* ------------------------------------------------------------- schedules */

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function scheduleDue(schedule, date) {
  if (!schedule.enabled) return false;
  if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(date.getDay())) return false;
  const target = minutesOfDay(schedule.at);
  if (target == null) return false;
  if (date.getHours() * 60 + date.getMinutes() !== target) return false;
  return schedule.lastFiredKey !== `${dayKey(date)}@${schedule.at}`;
}

async function runSchedule(schedule, date = new Date()) {
  const a = ensureAmbient();
  const dryRun = Boolean(db().settings.dryRun);
  const action = {
    id: uid('ambsch'),
    at: now(),
    scheduleId: schedule.id,
    kind: 'schedule',
    name: schedule.name,
    actionKind: schedule.action?.kind,
    target: schedule.action?.target || '',
    simulated: dryRun || !IS_WINDOWS,
    ok: true,
    detail: '',
  };
  schedule.lastFiredKey = `${dayKey(date)}@${schedule.at}`;
  schedule.lastFiredAt = now();
  schedule.fireCount = Number(schedule.fireCount || 0) + 1;
  if (dryRun) {
    action.detail = `Would run ${schedule.action?.kind} ${schedule.action?.target || ''} (simulated mode).`;
  } else if (schedule.action?.kind === 'notify') {
    action.detail = schedule.action.text || 'Scheduled reminder.';
    notify(schedule.name, action.detail, { kind: 'schedule', important: true });
  } else if (schedule.action?.kind === 'note') {
    const title = clip(schedule.name, 100);
    const body = `# ${title}\n\n${schedule.action.text || ''}\n`;
    const file = path.join(NOTES, `${slug(title)}-${Date.now().toString(36)}.md`);
    try {
      writeFileDurable(file, body);
      a.notes.unshift({ id: uid('note'), title, at: now(), file: path.relative(ROOT, file).split(path.sep).join('/') });
      a.notes = a.notes.slice(0, 30);
      action.detail = `Wrote ${path.basename(file)}.`;
    } catch (err) {
      action.ok = false;
      action.detail = `Note failed: ${err.message}`;
    }
  } else if (schedule.action?.kind === 'launch') {
    try {
      await executeStep(
        { id: uid('stp'), type: 'launchApp', name: schedule.name, params: { target: schedule.action.target }, timeoutMs: 30000 },
        { live: true, runId: null, run: { id: 'ambient' }, workflow: null, getTool: () => null }
      );
      action.detail = `Launched ${schedule.action.target}.`;
    } catch (err) {
      action.ok = false;
      action.detail = `Launch failed: ${err.message}`;
    }
  } else {
    const workflow = db().workflows.find((entry) => entry.id === schedule.action?.target);
    if (!workflow) {
      action.ok = false;
      action.detail = 'The scheduled workflow no longer exists.';
    } else {
      try {
        const engine = await import('./engine.js');
        const run = engine.createRun(workflow, { trigger: 'ambient', dryRun: false });
        action.detail = `Queued workflow run ${run.id}.`;
      } catch (err) {
        action.ok = false;
        action.detail = `Workflow failed to queue: ${err.message}`;
      }
    }
  }
  recordAction(action);
  notify(`${schedule.name} · ${action.ok ? 'done' : 'failed'}`, action.detail, { kind: 'schedule', important: true });
  logActivity('ambient', `Schedule “${schedule.name}” ${action.ok ? 'ran' : 'failed'}: ${action.detail}`, { scheduleId: schedule.id });
  runtime.lastScheduleCheckAt = now();
  return action;
}

export async function checkSchedules(date = new Date()) {
  const a = ensureAmbient();
  if (!a.enabled) return [];
  const fired = [];
  for (const schedule of a.schedules.slice(0, MAX_SCHEDULES)) {
    if (!scheduleDue(schedule, date)) continue;
    try {
      fired.push(await runSchedule(schedule, date));
    } catch (err) {
      runtime.lastError = `Schedule ${schedule.name}: ${err.message}`;
    }
  }
  persist();
  return fired;
}

/* ---------------------------------------------------------------- habits */

function recordHabit(win) {
  const a = ensureAmbient();
  if (!a.settings.learning || !win?.process) return;
  const h = a.habits;
  const key = String(win.process).toLowerCase();
  let app = h.apps.find((entry) => entry.key === key);
  if (!app) {
    app = { key, name: win.process, title: win.title || '', count: 0, dwellMs: 0, hours: {}, firstAt: now(), lastAt: null };
    h.apps.push(app);
  }
  app.count = Number(app.count || 0) + 1;
  app.title = win.title || app.title;
  app.lastAt = now();
  const gap = runtime.lastSampleAt ? Date.now() - runtime.lastSampleAt : 0;
  app.dwellMs = Number(app.dwellMs || 0) + Math.min(5000, Math.max(0, gap));
  const hour = new Date().getHours();
  app.hours = app.hours && typeof app.hours === 'object' ? app.hours : {};
  app.hours[hour] = Number(app.hours[hour] || 0) + 1;
  if (h.lastProcess && h.lastProcess !== key) {
    let transition = h.transitions.find((entry) => entry.from === h.lastProcess && entry.to === key);
    if (!transition) {
      transition = { from: h.lastProcess, to: key, count: 0, lastAt: null };
      h.transitions.push(transition);
    }
    transition.count = Number(transition.count || 0) + 1;
    transition.lastAt = now();
  }
  h.lastProcess = key;
  h.totalSamples = Number(h.totalSamples || 0) + 1;
  h.apps = h.apps.sort((left, right) => Number(right.count || 0) - Number(left.count || 0)).slice(0, MAX_APPS);
  h.transitions = h.transitions.sort((left, right) => Number(right.count || 0) - Number(left.count || 0)).slice(0, MAX_TRANSITIONS);
}

function propose(proposal) {
  const a = ensureAmbient();
  const key = proposal.key;
  if (!key || a.dismissedKeys.includes(key)) return null;
  if (a.proposals.some((entry) => entry.key === key)) return null;
  a.proposals.unshift({ id: uid('ambp'), at: now(), status: 'pending', ...proposal, key });
  a.proposals = a.proposals.slice(0, MAX_PROPOSALS);
  return a.proposals[0];
}

export function learnAmbient() {
  const a = ensureAmbient();
  const created = [];
  const mediaRule = a.rules.find(
    (rule) => rule.enabled && MEDIA.test(`${rule.name} ${rule.match?.process} ${rule.match?.title}`)
  );
  for (const app of a.habits.apps.slice(0, 12)) {
    if (Number(app.count || 0) < 4) continue;
    const isMedia = MEDIA.test(`${app.name} ${app.title}`);
    if (isMedia && !mediaRule) {
      const proposal = propose({
        key: `media:${app.key}`,
        kind: 'comfort',
        title: `Cinema comfort for ${app.name}`,
        detail: `You keep ${app.name} in front for ${Math.round((app.dwellMs || 0) / 1000)}s at a time. A comfort rule can maximise it when it comes forward.`,
        expected: 'The player window fills the screen when it becomes the foreground app.',
        rule: { name: `Cinema comfort · ${app.name}`, kind: 'comfort', match: { process: app.key, title: '' }, layout: 'cinema', mode: 'enter', cooldownSeconds: 600 },
      });
      if (proposal) created.push(proposal);
    }
    const hours = Object.entries(app.hours || {}).sort((left, right) => right[1] - left[1]);
    if (hours.length && hours[0][1] >= 3) {
      const hour = String(hours[0][0]).padStart(2, '0');
      const proposal = propose({
        key: `hour:${app.key}:${hour}`,
        kind: 'schedule',
        title: `Open ${app.name} around ${hour}:00`,
        detail: `${app.name} came to the front ${hours[0][1]} times in the ${hour}:00 hour. A schedule can keep that routine.`,
        expected: `The console opens ${app.name} once a day at ${hour}:00.`,
        schedule: { name: `Open ${app.name}`, at: `${hour}:00`, actionKind: 'launch', target: app.name },
      });
      if (proposal) created.push(proposal);
    }
  }
  for (const transition of a.habits.transitions.slice(0, 6)) {
    if (Number(transition.count || 0) < 3) continue;
    const left = a.habits.apps.find((entry) => entry.key === transition.from);
    const right = a.habits.apps.find((entry) => entry.key === transition.to);
    if (!left || !right) continue;
    if (MEDIA.test(left.name) || MEDIA.test(right.name) || MEETING.test(left.name) || MEETING.test(right.name)) continue;
    const proposal = propose({
      key: `split:${transition.from}:${transition.to}`,
      kind: 'comfort',
      title: `Side-by-side ${left.name} and ${right.name}`,
      detail: `You switch ${left.name} → ${right.name} ${transition.count} times. Two comfort rules can place them side by side instead.`,
      expected: `${left.name} opens on the left half and ${right.name} on the right half.`,
      rules: [
        { name: `${left.name} · left half`, kind: 'comfort', match: { process: transition.from, title: '' }, layout: 'snapLeft', mode: 'enter', cooldownSeconds: 300 },
        { name: `${right.name} · right half`, kind: 'comfort', match: { process: transition.to, title: '' }, layout: 'snapRight', mode: 'enter', cooldownSeconds: 300 },
      ],
    });
    if (proposal) created.push(proposal);
  }
  if (created.length) {
    persist();
    notify(`Learned ${created.length} routine(s)`, created.map((entry) => entry.title).join(' · '), { kind: 'learning', important: false });
  }
  return { proposals: created, ambient: ambientState() };
}

export function proposalAction(id, action = 'accept') {
  const a = ensureAmbient();
  const proposal = a.proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error('Ambient proposal not found');
  if (action === 'dismiss') {
    a.proposals = a.proposals.filter((entry) => entry.id !== id);
    a.dismissedKeys = [...new Set([...(a.dismissedKeys || []), proposal.key])].slice(-80);
    persist();
    return ambientState();
  }
  const made = [];
  for (const input of proposal.rules || []) made.push(createRule({ ...input, enabled: true }));
  if (proposal.rule) made.push(createRule({ ...proposal.rule, enabled: true }));
  if (proposal.schedule) {
    const schedule = createSchedule({ ...proposal.schedule, actionKind: proposal.schedule.actionKind || 'launch', target: proposal.schedule.target });
    made.push(schedule);
  }
  a.proposals = a.proposals.filter((entry) => entry.id !== id);
  a.dismissedKeys = [...new Set([...(a.dismissedKeys || []), proposal.key])].slice(-80);
  persist();
  notify('Ambient routine added', proposal.title, { kind: 'learning', important: false });
  logActivity('ambient', `Accepted ambient proposal “${proposal.title}”`);
  return { ambient: ambientState(), made: made.map((entry) => entry.name) };
}

/* ------------------------------------------------------------- observation */

async function currentWindow() {
  if (!IS_WINDOWS) return { title: '', process: '', supported: false };
  try {
    const win = await readForegroundWindow();
    return { ...win, supported: true };
  } catch (err) {
    runtime.lastError = err.message;
    return { title: '', process: '', supported: false };
  }
}

export async function observeOnce({ window: win = null, date = new Date() } = {}) {
  const a = ensureAmbient();
  runtime.samples++;
  const windowInfo = win || (await currentWindow());
  const observed = {
    process: String(windowInfo.process || ''),
    title: String(windowInfo.title || ''),
    supported: windowInfo.supported !== false,
    at: now(),
  };
  runtime.lastWindow = observed;
  a.lastTickAt = now();
  recordHabit(observed);
  const fired = [];
  if (a.enabled && (observed.process || observed.title)) {
    const dryRun = Boolean(db().settings.dryRun);
    for (const rule of a.rules) {
      if (!ruleMatches(rule, observed)) continue;
      if (rule.kind === 'shortcut' && a.settings.shortcuts === false) continue;
      if (rule.kind !== 'shortcut' && a.settings.comfort === false) continue;
      const key = `${observed.process}|${observed.title}`;
      const lastFired = rule.lastFiredAt ? Date.parse(rule.lastFiredAt) : 0;
      const cooling = Date.now() - lastFired < Math.max(5000, Number(rule.cooldownMs) || 120000);
      if (rule.mode !== 'always' && rule.lastKey === key && cooling) continue;
      if (rule.mode === 'always' && cooling) continue;
      try {
        const action = await fireRule(rule, observed, { dryRun });
        if (action) fired.push(action);
      } catch (err) {
        runtime.lastError = `Rule ${rule.name}: ${err.message}`;
      }
      if (fired.length >= 3) break;
    }
  }
  const schedules = await checkSchedules(date);
  if (Date.now() - runtime.lastPersistAt > OBSERVE_PERSIST_MS) {
    runtime.lastPersistAt = Date.now();
    persist();
  }
  return { window: observed, fired, schedules };
}

export async function tickAmbient({ force = false } = {}) {
  const a = ensureAmbient();
  if (!a.enabled && !force) return { skipped: 'ambient disabled' };
  const result = await observeOnce();
  persist();
  return { ...result, ambient: ambientState() };
}

/* ---------------------------------------------------------- refresh clock */

export async function detectRefreshRate() {
  if (!IS_WINDOWS) {
    runtime.hz = 60;
    runtime.hzSource = 'default';
    return { hz: runtime.hz, source: runtime.hzSource };
  }
  try {
    const res = await runPowerShell(
      "Get-CimInstance Win32_VideoController | ForEach-Object { $_.CurrentRefreshRate } | Where-Object { $_ -gt 20 } | Sort-Object -Descending | Select-Object -First 1",
      8000
    );
    if (res.ok) {
      const hz = Number(String(res.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
      if (Number.isFinite(hz) && hz >= 24 && hz <= 500) {
        runtime.hz = hz;
        runtime.hzSource = 'win32-video-controller';
        return { hz, source: runtime.hzSource };
      }
    }
  } catch (err) {
    runtime.lastError = err.message;
  }
  runtime.hz = 60;
  runtime.hzSource = 'default';
  return { hz: runtime.hz, source: runtime.hzSource };
}

export function startAmbient() {
  const a = ensureAmbient();
  if (!a.enabled || runtime.frameTimer) return false;
  runtime.startedAt = Date.now();
  detectRefreshRate().catch(() => {});
  const frame = () => {
    const period = 1000 / Math.max(24, runtime.hz || 60);
    const started = Date.now();
    // Fixed-step clock: Windows timers round a 16.7 ms wait up to ~31 ms, so
    // count every display frame that elapsed rather than counting wakeups.
    // Wakeups coalesce frames; real work still happens on each wakeup.
    const delta = runtime.lastFrameAt ? started - runtime.lastFrameAt : period;
    runtime.lastFrameAt = started;
    runtime.frames += Math.max(1, Math.round(delta / period));
    const sampleMs = Math.max(250, Number(ensureAmbient().settings.sampleMs) || 750);
    if (!runtime.busy && started - (runtime.lastSampleAt || 0) >= sampleMs) {
      runtime.busy = true;
      runtime.lastSampleAt = started;
      observeOnce()
        .catch((err) => {
          runtime.lastError = err.message;
        })
        .finally(() => {
          runtime.busy = false;
        });
    }
    const elapsed = Date.now() - started;
    runtime.workMs = Math.round(elapsed * 100) / 100;
    if (elapsed > period * 4) runtime.droppedFrames++;
    const settings = ensureAmbient().settings;
    const wait = settings.frameClock ? Math.max(4, period - elapsed) : Math.max(50, sampleMs - elapsed);
    runtime.frameTimer = setTimeout(frame, wait);
    runtime.frameTimer.unref?.();
  };
  runtime.lastFrameAt = Date.now();
  runtime.frameTimer = setTimeout(frame, 0);
  runtime.frameTimer.unref?.();
  logActivity('ambient', `Ambient frame clock started at ${runtime.hz} Hz`);
  return true;
}

export function stopAmbient() {
  if (runtime.frameTimer) clearTimeout(runtime.frameTimer);
  runtime.frameTimer = null;
  return true;
}

/* ------------------------------------------------------------------- view */

export function ambientState() {
  const a = ensureAmbient();
  const nowMs = Date.now();
  const uptimeMs = runtime.startedAt ? nowMs - runtime.startedAt : 0;
  const effectiveHz = uptimeMs > 1500 ? Math.round((runtime.frames / (uptimeMs / 1000)) * 10) / 10 : runtime.hz;
  const apps = a.habits.apps.map((app) => ({
    key: app.key,
    name: app.name,
    count: app.count,
    dwellSeconds: Math.round(Number(app.dwellMs || 0) / 1000),
    topHour: Object.entries(app.hours || {}).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
    lastAt: app.lastAt,
  }));
  const unread = a.notifications.filter((entry) => !entry.read).length;
  return {
    ok: true,
    enabled: a.enabled,
    settings: a.settings,
    clock: {
      hz: runtime.hz,
      hzSource: runtime.hzSource,
      effectiveHz,
      frames: runtime.frames,
      samples: runtime.samples,
      droppedFrames: runtime.droppedFrames,
      workMs: runtime.workMs,
      running: Boolean(runtime.frameTimer),
      sampleMs: a.settings.sampleMs,
      lastSampleAt: a.lastTickAt,
      startedAt: runtime.startedAt ? new Date(runtime.startedAt).toISOString() : null,
      uptimeMs,
      busy: runtime.busy,
      lastError: runtime.lastError,
    },
    window: runtime.lastWindow,
    rules: a.rules.map((rule) => ({
      ...rule,
      matchLabel: [rule.match?.process ? `process ${rule.match.process}` : '', rule.match?.title ? `title ${rule.match.title}` : ''].filter(Boolean).join(' · '),
    })),
    schedules: a.schedules,
    actions: a.actions.slice(0, 20),
    notifications: a.notifications,
    proposals: a.proposals,
    habits: {
      apps,
      transitions: a.habits.transitions.slice(0, 12),
      totalSamples: a.habits.totalSamples,
    },
    notes: a.notes,
    summary: {
      rules: a.rules.length,
      rulesEnabled: a.rules.filter((rule) => rule.enabled).length,
      schedules: a.schedules.length,
      schedulesEnabled: a.schedules.filter((entry) => entry.enabled).length,
      apps: apps.length,
      transitions: a.habits.transitions.length,
      proposals: a.proposals.length,
      unread,
      actions: a.actions.length,
    },
  };
}

export function markAmbientNotification(id, read = true) {
  const entry = ensureAmbient().notifications.find((item) => item.id === id);
  if (!entry) return null;
  entry.read = Boolean(read);
  persist();
  return entry;
}

export function clearAmbientNotifications() {
  const a = ensureAmbient();
  a.notifications = a.notifications.map((entry) => ({ ...entry, read: true }));
  persist();
  return ambientState();
}

export function addAmbientNote(text) {
  const a = ensureAmbient();
  const value = clip(text, 500);
  if (!value) throw new Error('Write a note first.');
  a.notes.unshift({ id: uid('note'), text: value, at: now() });
  a.notes = a.notes.slice(0, 30);
  persist();
  logActivity('ambient', `Preference note saved: ${clip(value, 80)}`);
  return a.notes[0];
}

/* --------------------------------------------------------------- presets */

export function ambientPreset(name) {
  const presets = {
    movie: [
      {
        name: 'Movie night comfort',
        kind: 'comfort',
        match: { process: 'vlc|mpv|potplayer|wmplayer|netflix|youtube|plex', title: '' },
        layout: 'cinema',
        mode: 'enter',
        cooldownSeconds: 600,
      },
    ],
    reader: [
      {
        name: 'Comfortable reading width',
        kind: 'comfort',
        match: { process: '', title: 'PDF|Reader|Document|Book' },
        layout: 'center',
        mode: 'enter',
        cooldownSeconds: 300,
      },
    ],
    meeting: [
      {
        name: 'Meeting on the left half',
        kind: 'comfort',
        match: { process: 'teams|zoom|webex', title: '' },
        layout: 'snapLeft',
        mode: 'enter',
        cooldownSeconds: 300,
      },
      {
        name: 'Notes on the right half',
        kind: 'comfort',
        match: { process: '', title: 'Notepad|Notes|Obsidian' },
        layout: 'snapRight',
        mode: 'enter',
        cooldownSeconds: 300,
      },
    ],
  };
  const chosen = presets[name];
  if (!chosen) throw new Error('Unknown ambient preset');
  const made = chosen.map((rule) => createRule({ ...rule, enabled: true, source: 'preset' }));
  notify(`Preset “${name}” enabled`, made.map((rule) => rule.name).join(' · '), { kind: 'control', important: false });
  logActivity('ambient', `Applied ambient preset “${name}”`);
  return { rules: made, ambient: ambientState() };
}

/* --------------------------------------------------------------- cleanup */

export function compactAmbient() {
  const a = ensureAmbient();
  a.actions = a.actions.slice(0, 20);
  a.notifications = a.notifications.filter((entry, index) => !entry.read || index < 10);
  a.dismissedKeys = a.dismissedKeys.slice(-40);
  a.notes = a.notes.slice(0, 10);
  for (const app of a.habits.apps) {
    if (app.hours && Object.keys(app.hours).length > 24) app.hours = {};
  }
  persist();
  return ambientState();
}
