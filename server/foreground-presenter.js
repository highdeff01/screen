import { db, persist, uid, now, logActivity } from './store.js';
import { readForegroundWindow, runPowerShell } from './automation.js';
import { eligibleShortcuts } from './shortcuts.js';
import { addSuggestion } from './planner.js';
import { matchAppHint } from './app-launch-hints.js';
import { goalApp } from './strategy.js';
import { goalAppEvidence } from './goal-evidence.js';

const OBSERVATION_LIMIT = 80;
const TIMELINE_LIMIT = 80;
const REVIEW_LIMIT = 24;
const POSITION_LIMIT = 600;

let screenCache = null;

const APP_STATUSES = [
  'unopened',
  'loading',
  'open',
  'in_progress',
  'updating',
  'failed',
  'fixable',
  'needs_input',
  'finished',
];

const AI_STATUSES = ['thinking', 'acting', 'waiting', 'verifying', 'paused', 'failed', 'finished'];

function clip(value, max = 260) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stepTarget(step) {
  const p = step?.params || {};
  return [p.title, p.windowName, p.windowTitle, p.window, p.foreground, p.process, p.target, p.value, p.app]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function normalize(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

/** A readable app name for a launch target, URL, process or window title. */
function appLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (looksLikeUrl(raw)) {
    try {
      return new URL(raw).hostname.replace(/^www\./i, '');
    } catch {
      return raw;
    }
  }
  const leaf = raw.split(/[\\/]/).pop().replace(/\.exe$/i, '').trim();
  return leaf ? leaf.charAt(0).toUpperCase() + leaf.slice(1) : raw;
}

function sameAppName(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

const APP_OPENING_TYPES = new Set(['launchApp', 'openUrl', 'focusWindow']);

/**
 * The app a sequence of steps really drives: the last window-opening step, with
 * a friendly name from the shared launch hints (calc.exe -> Calculator).
 */
export function effectiveAppFromSteps(steps = []) {
  const entries = (steps || []).filter((entry) => APP_OPENING_TYPES.has(entry?.type));
  const last = entries[entries.length - 1];
  if (!last) return null;
  const p = last.params || {};
  const hint = matchAppHint([p.target, p.title, p.windowName, p.windowTitle, p.process, p.app, p.url]);
  if (last.type === 'launchApp') {
    const target = String(p.target || hint?.target || '').trim();
    if (!target) return null;
    return {
      target,
      title: String(p.title || hint?.title || '').trim(),
      process: String(p.process || hint?.process || '').trim(),
      name: hint?.label || appLabel(target),
      method: `launchApp · ${target}`,
    };
  }
  if (last.type === 'openUrl') {
    const url = String(p.url || '').trim();
    if (!url) return null;
    return {
      target: String(p.app || url).trim(),
      title: '',
      process: String(hint?.process || p.app || '').trim(),
      name: hint?.label || appLabel(url),
      method: `openUrl · ${url}`,
    };
  }
  const title = String(p.title || p.windowName || p.windowTitle || '').trim();
  const process = String(p.process || hint?.process || '').trim();
  if (!title && !process) return null;
  return {
    target: title || process,
    title,
    process,
    name: hint?.label || appLabel(process || title),
    method: `focusWindow · ${process || title}`,
  };
}

function coordinate(step) {
  const p = step?.params || {};
  const x = Number(p.x ?? p.x1);
  const y = Number(p.y ?? p.y1);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, action: step.type };
}

function pointForStep(step) {
  if (!['move', 'click', 'doubleClick', 'rightClick', 'drag'].includes(step?.type)) return null;
  return coordinate(step);
}

function appMatches(actual, target) {
  if (!target) return false;
  const wanted = normalize(target);
  if (!wanted) return false;
  const haystack = normalize(`${actual.title} ${actual.process} ${actual.path}`);
  if (haystack.includes(wanted)) return true;
  const leaf = normalize(target.split(/[\\/]/).pop());
  return Boolean(leaf) && haystack.includes(leaf);
}

async function screenSize() {
  if (screenCache && Date.now() - screenCache.at < 30000) return screenCache.value;
  if (process.platform !== 'win32') {
    screenCache = { at: Date.now(), value: { width: 1920, height: 1080, source: 'default' } };
    return screenCache.value;
  }
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
[pscustomobject]@{ width = [int]$b.Width; height = [int]$b.Height; x = [int]$b.X; y = [int]$b.Y } | ConvertTo-Json -Compress`;
    const res = await runPowerShell(script, 8000);
    if (res.ok) {
      const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
      const parsed = JSON.parse(line);
      const value = {
        width: Math.max(1, Number(parsed.width) || 1920),
        height: Math.max(1, Number(parsed.height) || 1080),
        x: Number(parsed.x) || 0,
        y: Number(parsed.y) || 0,
        source: 'virtual-screen',
      };
      screenCache = { at: Date.now(), value };
      return value;
    }
  } catch {}
  return { width: 1920, height: 1080, x: 0, y: 0, source: 'default' };
}

function ensurePresenter(run, workflow) {
  if (!run.presenter) {
    run.presenter = {
      runId: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName || workflow?.name || 'Workflow',
      goal: workflow?.description || workflow?.name || run.workflowName || '',
      active: true,
      startedAt: now(),
      updatedAt: now(),
      dryRun: Boolean(run.dryRun),
      ai: { status: 'thinking', action: null, detail: 'Preparing the run.', reason: '', at: now() },
      app: {
        status: 'unopened',
        target: '',
        name: '',
        title: '',
        process: '',
        path: '',
        version: '',
        method: '',
        detail: 'Waiting for the first step.',
        adoptedAt: null,
        repairedFrom: '',
        at: now(),
      },
      current: null,
      next: null,
      done: { steps: 0, total: (run.steps || []).length, last: null },
      progress: 0,
      screen: null,
      observations: [],
      timeline: [],
      agentReviews: [],
      fallbacks: [],
      needsInput: null,
      verifier: null,
      userNotes: [],
      pointer: null,
      position: { memoryCount: 0, nearest: [], last: null },
      summary: { whatsDone: 'Nothing yet.', whatDoing: 'Preparing the run.', whatsNext: 'Waiting for the first step.', goalMet: null },
    };
  }
  if (workflow && !run.presenter.goal) run.presenter.goal = workflow.description || workflow.name;
  return run.presenter;
}

function observe(run, level, message, meta = {}) {
  const presenter = ensurePresenter(run);
  presenter.observations.unshift({ id: uid('obs'), at: now(), level, message: clip(message, 700), ...meta });
  presenter.observations = presenter.observations.slice(0, OBSERVATION_LIMIT);
  presenter.updatedAt = now();
}

function timeline(run, source, kind, text, meta = {}) {
  const presenter = ensurePresenter(run);
  presenter.timeline.unshift({ id: uid('ptl'), at: now(), source, kind, text: clip(text, 700), ...meta });
  presenter.timeline = presenter.timeline.slice(0, TIMELINE_LIMIT);
  presenter.updatedAt = now();
}

function updateSummary(run, workflow) {
  const presenter = ensurePresenter(run, workflow);
  const steps = run.steps || [];
  const currentIndex = presenter.current?.index ?? -1;
  const nextStep = steps[currentIndex + 1] || null;
  const passed = steps.filter((step) => step.status === 'passed').length;
  const failed = steps.find((step) => step.status === 'failed') || null;
  presenter.progress = steps.length ? Math.round((passed / steps.length) * 100) : 0;
  presenter.done = {
    steps: passed,
    total: steps.length,
    last: steps.filter((step) => step.status === 'passed').slice(-1)[0]?.name || null,
  };
  presenter.next = nextStep
    ? { index: currentIndex + 1, id: nextStep.id, name: nextStep.name, type: nextStep.type, status: nextStep.status }
    : null;
  presenter.summary = {
    whatsDone: presenter.done.last ? `${presenter.done.steps}/${presenter.done.total} steps passed; last ${presenter.done.last}.` : 'No steps passed yet.',
    whatDoing: presenter.current ? `${presenter.current.name} (${presenter.current.type}) — ${presenter.current.status}.` : 'Waiting.',
    whatsNext: nextStep ? `${nextStep.name} (${nextStep.type}).` : failed ? `Recovery required after ${failed.name}.` : 'No next step.',
    goalMet: run.status === 'passed' ? true : run.status === 'failed' ? false : null,
  };
}

function stepReason(step, workflow) {
  const p = step?.params || {};
  if (step?.type === 'launchApp') return `Open ${p.target || 'the target app'} before interacting with it.`;
  if (step?.type === 'openUrl') return `Navigate to ${p.url || 'the target URL'} and wait for the page.`;
  if (step?.type === 'focusWindow') return `Make sure ${stepTarget(step) || 'the expected window'} is in front before the next action.`;
  if (step?.type === 'waitFor') return `Wait until ${p.value || p.title || 'the expected state'} is ${p.mode || 'present'}.`;
  if (step?.type === 'clickElement') return `Find and click “${p.name || 'the visible control'}” in ${p.window || 'the target window'}.`;
  if (['click', 'doubleClick', 'rightClick', 'move', 'drag'].includes(step?.type)) return `Move the pointer to the recorded screen position and ${step.type}.`;
  if (step?.type === 'type') return `Type the current request only after the target field is focused.`;
  if (step?.type === 'key') return `Use ${p.keys || 'the configured shortcut'} in the focused window.`;
  if (step?.type === 'clipboard') return `Use the clipboard to ${p.action || 'move text'} without guessing coordinates.`;
  if (step?.type === 'aiExtract') return 'Extract only the requested response from the captured text.';
  if (step?.type === 'screenshot') return 'Capture evidence of the current state.';
  if (step?.type === 'expect') return `Verify that ${p.value || 'the expected state'} is actually true.`;
  return step?.name || 'Complete the next planned action.';
}

function prepForNext(step, current = null) {
  if (!step) return [];
  const p = step.params || {};
  const out = [];
  if (['type', 'writeTextFile', 'key'].includes(current?.type) && ['openUrl', 'launchApp', 'focusWindow'].includes(step.type)) {
    out.push('Finish and save the current document before switching away.');
  }
  if (step.type === 'openUrl') out.push('Confirm the current document is saved; close extra tabs so the destination tab is unambiguous.');
  if (step.type === 'launchApp') out.push(`Pre-open ${p.target || 'the app'} if startup is slow; close extra windows that could steal focus.`);
  if (step.type === 'writeTextFile') out.push('Use the user-specified name and folder when given; otherwise save to the desktop and check for an overwrite.');
  if (step.type === 'closeWindow') out.push('Save the document first, then close only the intended window.');
  if (step.type === 'focusWindow') out.push('Switch to the requested tab/window and close duplicates that could confuse the next action.');
  if (['type', 'clickElement', 'key'].includes(step.type)) out.push('Keep the expected window in the foreground and watch for layout or focus changes.');
  if (step.type === 'screenshot' || step.type === 'expect') out.push('Prepare the verification point and capture before/after evidence.');
  return out;
}

function appMethod(step) {
  if (!step) return 'foreground';
  if (step.type === 'launchApp') return 'launchApp · Start Menu shortcut or executable path';
  if (step.type === 'openUrl') return 'openUrl · default browser navigation';
  if (step.type === 'focusWindow') return 'focusWindow · use an already-open window';
  if (step.type === 'key') return 'keyboard shortcut · focused window only';
  return 'foreground interaction';
}

async function refreshApp(run, step, { status = null } = {}) {
  const presenter = ensurePresenter(run);
  // Once a repair switches the app the run really drives, later steps still
  // carry the old window title. Keep describing the app that actually ran
  // instead of swinging back to the missing window or a stale fallback.
  const effective = run?.effectiveApp?.target ? run.effectiveApp : null;
  const opening = APP_OPENING_TYPES.has(step?.type) && !step?.adoptedApp;
  const stepValue = stepTarget(step);
  const target = opening || !effective ? stepValue || presenter.app.target : effective.target;
  const method = appMethod(step);
  const previous = presenter.app;
  presenter.app = {
    ...previous,
    target: target || previous.target,
    ...(effective
      ? { name: previous.name || effective.name || '', repairedFrom: previous.repairedFrom || effective.replacedTarget || '' }
      : {}),
    method: ['launchApp', 'openUrl'].includes(step?.type) ? method : previous.method || method,
    at: now(),
  };
  if (!presenter.screen) presenter.screen = await screenSize();
  if (run.dryRun) {
    presenter.app.status = status || (step ? 'in_progress' : 'unopened');
    presenter.app.name = effective?.name || presenter.app.target || previous.name || '';
    presenter.app.detail = effective
      ? `Simulated run; the run now targets ${presenter.app.name} after a repair.`
      : 'Simulated run; no desktop window is read.';
    return presenter.app;
  }
  const actual = await readForegroundWindow();
  if (actual?.error) {
    presenter.app.status = 'failed';
    presenter.app.detail = `Could not read the foreground window: ${actual.error}`;
    observe(run, 'warn', presenter.app.detail);
    return presenter.app;
  }
  const match = appMatches(actual, presenter.app.target);
  if (opening && match && stepValue && !sameAppName(effective?.target || '', stepValue)) {
    // A real app switch supersedes the repaired app for later steps and checks.
    const next = effectiveAppFromSteps([step]);
    if (next) run.effectiveApp = { ...next, replacedTarget: '', at: now() };
  }
  presenter.app = {
    ...presenter.app,
    matched: Boolean(match),
    // Only a foreground window that matches the target names the app; otherwise
    // keep the app the run actually drove rather than whatever ended up in front.
    name: match
      ? (run?.effectiveApp?.name || effective?.name || actual.process || previous.name || '')
      : previous.name || '',
    title: actual.title || '',
    process: actual.process || '',
    path:
      actual.path ||
      (/(?:[\\/]|\.exe$)/i.test(presenter.app.target) ? presenter.app.target : '') ||
      previous.path ||
      '',
    version: actual.version || previous.version || '',
    status: status || (match ? 'open' : step?.type === 'launchApp' ? 'loading' : 'unopened'),
    detail: match
      ? `Foreground: ${actual.process || 'unknown'} — ${actual.title || 'untitled'}.`
      : `Expected ${presenter.app.target || 'the target'}; foreground is ${actual.process || 'unknown'} — ${actual.title || 'untitled'}.`,
    at: now(),
  };
  if (!match && presenter.app.status === 'unopened') {
    presenter.app.method = looksLikeUrl(presenter.app.target)
      ? 'openUrl · fallback because the page is not open'
      : 'launchApp · fallback because the app is not open';
  } else if (match && /fallback because/i.test(String(presenter.app.method || ''))) {
    // The suggested fallback already ran successfully; stop describing it as pending.
    presenter.app.method = String(presenter.app.method).replace(/\s*·\s*fallback because.*$/i, ' · confirmed in the foreground');
  }
  return presenter.app;
}

function fallbackPlan(run, step) {
  const presenter = ensurePresenter(run);
  const target = presenter.app.target || stepTarget(step);
  const habits = target ? eligibleShortcuts(4, { app: target }) : [];
  const fallbacks = habits.map((habit) => ({
    kind: 'shortcut',
    label: `${habit.app}: ${habit.action}`,
    keys: habit.keys,
    confidence: habit.confidence,
  }));
  if (target) {
    fallbacks.push({
      kind: looksLikeUrl(target) ? 'openUrl' : 'launchApp',
      label: looksLikeUrl(target) ? `Open ${target}` : `Launch ${target}`,
      target,
      confidence: 0,
    });
  }
  presenter.fallbacks = fallbacks.slice(0, 6);
  return presenter.fallbacks;
}

function reviewAgents(run, workflow, step, { error = '' } = {}) {
  const d = db();
  const presenter = ensurePresenter(run, workflow);
  const index = (run.steps || []).findIndex((entry) => entry.id === step?.id);
  const previous = (run.steps || []).slice(Math.max(0, index - 2), Math.max(0, index)).map((entry) => `${entry.name} (${entry.status})`);
  const next = (run.steps || []).slice(index + 1, index + 3).map((entry) => `${entry.name} (${entry.type})`);
  const agents = (d.agents || []).filter((agent) => agent.enabled || agent.kind === 'watchdog').slice(0, 8).map((agent) => ({
    name: agent.name,
    kind: agent.kind,
    status: agent.status || (agent.enabled ? 'idle' : 'paused'),
    advice: agent.kind === 'watchdog'
      ? 'Capture the evidence and do not retry the same signature unchanged.'
      : agent.kind === 'observer'
        ? 'Check the previous and next step for a missing launch, focus or wait.'
        : 'Compare this action with the recorded failure history before continuing.',
    lastLog: clip((agent.log || []).slice(-1)[0]?.message || '', 180),
  }));
  const suggestions = (d.suggestions || []).filter((entry) => !entry.dismissed && (!entry.workflowId || entry.workflowId === run.workflowId)).slice(0, 5).map((entry) => clip(entry.text, 220));
  const tests = (d.runs || []).filter((entry) => entry.workflowId === run.workflowId && entry.id !== run.id).slice(0, 8);
  const override = !run.dryRun && presenter.app.target && presenter.app.status !== 'open' && step?.type !== 'launchApp'
    ? { action: 'focus-or-open', target: presenter.app.target, reason: `${presenter.app.target} is not confirmed as the foreground app.` }
    : null;
  const review = {
    id: uid('rev'),
    at: now(),
    stepId: step?.id || null,
    stepName: step?.name || null,
    previous,
    current: step ? `${step.name} (${step.type})` : null,
    next,
    agents,
    suggestions,
    backgroundTests: {
      passed: tests.filter((entry) => entry.status === 'passed').length,
      failed: tests.filter((entry) => entry.status === 'failed').length,
    },
    override,
    verdict: override ? 'override' : error ? 'review' : 'aligned',
  };
  presenter.agentReviews.unshift(review);
  presenter.agentReviews = presenter.agentReviews.slice(0, REVIEW_LIMIT);
  if (override) observe(run, 'warn', `Agent review override: ${override.reason}`, { stepId: step?.id });
  else if (error) observe(run, 'warn', `Agents reviewed “${step?.name}”: ${error}`, { stepId: step?.id });
  return review;
}

/**
 * Adopt the app a repair really opened. The original target stays on record as
 * `repairedFrom`, while the presenter, its fallbacks and the final verifier
 * describe the app that actually ran.
 */
export async function presenterAdoptApp(run, workflow, { steps = [], method = '', step = null } = {}) {
  const presenter = ensurePresenter(run, workflow);
  const next = effectiveAppFromSteps(steps);
  if (!next) return null;
  const previous = presenter.app || {};
  if (previous.target && sameAppName(previous.target, next.target)) return null;
  let actual = null;
  if (!run.dryRun) {
    try {
      actual = await readForegroundWindow();
    } catch {
      actual = null;
    }
  }
  const confirmed = Boolean(actual && !actual.error && appMatches(actual, next.target));
  const from = String(previous.target || previous.repairedFrom || '').trim();
  presenter.app = {
    ...previous,
    target: next.target,
    name: next.name || previous.name || next.target,
    title: (confirmed && actual.title) || next.title || previous.title || '',
    process: (confirmed && actual.process) || next.process || previous.process || '',
    path: (confirmed && actual.path) || previous.path || '',
    status: confirmed ? 'open' : 'in_progress',
    method: method ? `${next.method} · ${method}` : next.method,
    detail: confirmed
      ? `Repair switched the target from ${from || 'the missing window'} to ${next.name}; foreground is ${actual.title || actual.process || next.name}.`
      : `Repair switched the target to ${next.name} (${next.target})${from ? ` instead of ${from}` : ''}.`,
    adoptedAt: now(),
    repairedFrom: from || previous.repairedFrom || '',
    at: now(),
  };
  if (step) step.adoptedApp = next.target;
  run.effectiveApp = {
    target: next.target,
    name: presenter.app.name,
    title: presenter.app.title,
    process: presenter.app.process,
    method: presenter.app.method,
    replacedTarget: presenter.app.repairedFrom,
    at: now(),
  };
  fallbackPlan(run, step || null);
  timeline(
    run,
    'system',
    'app',
    `Target app changed to ${presenter.app.name} (${next.target})${
      presenter.app.repairedFrom ? ` — the original ${presenter.app.repairedFrom} was not there` : ''
    }. Later steps, fallbacks and the final check now describe ${presenter.app.name}.`,
    { stepId: step?.id }
  );
  observe(run, 'info', `Presenter now describes ${presenter.app.name}, the app that actually ran.`, { stepId: step?.id });
  presenter.updatedAt = now();
  persist();
  return presenter.app;
}

export async function presenterStart(run, workflow) {
  const presenter = ensurePresenter(run, workflow);
  presenter.active = true;
  presenter.startedAt = presenter.startedAt || now();
  presenter.screen = run.dryRun ? { width: 1920, height: 1080, x: 0, y: 0, source: 'simulated' } : await screenSize();
  presenter.ai = { status: 'thinking', action: null, detail: 'Reading the workflow and preparing the first step.', reason: workflow?.description || '', at: now() };
  timeline(run, 'system', 'intent', `Presenter started for “${presenter.workflowName}”. Goal: ${presenter.goal}`);
  timeline(run, 'ai', 'decision', 'Plan loaded. The presenter will announce the app, method, action and verification for each step.');
  await refreshApp(run, workflow?.steps?.[0] || null);
  if (presenter.app.status !== 'open') observe(run, 'info', `App is not confirmed yet: ${presenter.app.detail}`);
  else observe(run, 'info', `App available: ${presenter.app.title || presenter.app.process}.`);
  persist();
  return presenter;
}

export async function presenterBeginStep(run, workflow, step) {
  const presenter = ensurePresenter(run, workflow);
  const index = (run.steps || []).findIndex((entry) => entry.id === step.id);
  presenter.current = { index, id: step.id, name: step.name, type: step.type, status: 'running', reason: stepReason(step, workflow) };
  presenter.ai = { status: 'acting', action: step.type, detail: step.name, reason: stepReason(step, workflow), at: now() };
  timeline(run, 'ai', 'action', `Acting: ${step.name} (${step.type}). Why: ${stepReason(step, workflow)}`, { stepId: step.id });
  await refreshApp(run, step);
  const mismatch = !run.dryRun && presenter.app.target && presenter.app.status !== 'open';
  if (mismatch) observe(run, 'warn', `This is not there yet: expected ${presenter.app.target}, foreground is ${presenter.app.title || presenter.app.process || 'unknown'}.`, { stepId: step.id });
  else observe(run, 'info', `App is available: ${presenter.app.title || presenter.app.process || 'foreground window'}.`, { stepId: step.id });
  if (pointForStep(step) && mismatch) observe(run, 'warn', 'Mouse is in the wrong window; a coordinate action here could hit the wrong control.', { stepId: step.id });
  fallbackPlan(run, step);
  reviewAgents(run, workflow, step);
  updateSummary(run, workflow);
  persist();
  return presenter;
}

export async function presenterAfterStep(run, workflow, step, { ok = true } = {}) {
  const presenter = ensurePresenter(run, workflow);
  const waitMs = run.dryRun ? 0 : Math.max(0, Math.min(10000, Number(db().settings.presenterSettleMs ?? 2000)));
  presenter.ai = { status: 'verifying', action: step.type, detail: `Waiting ${waitMs}ms, then checking the app/window state.`, reason: 'Do not declare the step done before the UI has time to respond.', at: now() };
  timeline(run, 'ai', 'verification', `Verifying “${step.name}” after a ${waitMs}ms settle window.`, { stepId: step.id });
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  await refreshApp(run, step, { status: ok ? 'in_progress' : 'failed' });
  recordPosition(run, workflow, step, { ok });
  const pointer = pointForStep(step);
  if (pointer) presenter.pointer = { x: pointer.x, y: pointer.y, at: now(), stepId: step.id };
  const next = presenter.next;
  presenter.ai = { status: 'waiting', action: null, detail: next ? `Ready for ${next.name}.` : 'Checking the final result.', reason: '', at: now() };
  if (next) {
    const prep = prepForNext((workflow.steps || []).find((entry) => entry.id === next.id) || null, step);
    presenter.prep = prep;
    if (prep.length) timeline(run, 'system', 'prep', `Prep for next step: ${prep.join(' ')}`);
  }
  observe(run, ok ? 'info' : 'warn', ok ? `Step complete: ${step.name}. Next: ${next?.name || 'verification'}.` : `Step did not complete: ${step.name}.`, { stepId: step.id });
  updateSummary(run, workflow);
  persist();
  return presenter;
}

export async function presenterFailStep(run, workflow, step, error) {
  const presenter = ensurePresenter(run, workflow);
  const text = String(error || 'Step failed');
  presenter.ai = { status: 'failed', action: step?.type || null, detail: text, reason: stepReason(step, workflow), at: now() };
  const needsInput = /login|password|permission|consent|2fa|captcha|user/i.test(text);
  const updating = /install|update|upgrad|download/i.test(text);
  const fixable = /no window matching|not found|foreground|focus|mouse|coordinate|click|closed/i.test(text);
  const inputPolicy = db().settings.presenterInputPolicy || 'auto';
  presenter.app.status = needsInput ? 'needs_input' : updating ? 'updating' : fixable ? 'fixable' : 'failed';
  presenter.app.detail = text;
  presenter.needsInput = needsInput
    ? {
        at: now(),
        stepId: step?.id || null,
        message: text,
        policy: inputPolicy,
        autoContinueAt: inputPolicy === 'auto' ? new Date(Date.now() + Math.max(1000, Number(db().settings.presenterAutoContinueMs || 15000))).toISOString() : null,
      }
    : null;
  if (needsInput && inputPolicy === 'wait') run.pauseRequested = true;
  if (needsInput && inputPolicy === 'stop') run.cancelRequested = true;
  observe(run, 'error', `Failed: ${step?.name || 'step'} — ${text}`, { stepId: step?.id });
  if (/no window matching|not found|closed/i.test(text)) observe(run, 'warn', 'App is not there. Recovery should open or focus it before retrying.', { stepId: step?.id });
  else if (/foreground|focus/i.test(text)) observe(run, 'warn', 'The foreground window is wrong. Mouse or keyboard input may land in the wrong app.', { stepId: step?.id });
  else if (/mouse|coordinate|click/i.test(text)) observe(run, 'warn', 'The pointer may be in the wrong position. Check the current window and target control.', { stepId: step?.id });
  fallbackPlan(run, step);
  reviewAgents(run, workflow, step, { error: text });
  updateSummary(run, workflow);
  persist();
  return presenter;
}

export function presenterFinish(run, workflow, { passed = false, error = '' } = {}) {
  const presenter = ensurePresenter(run, workflow);
  // Describe the app the run really drove, which a repair may have switched.
  const app = run?.effectiveApp?.target ? { ...presenter.app, ...run.effectiveApp } : presenter.app || {};
  const appName = app.name || app.target || '';
  // Only describe a window this run really verified. When the target window is
  // gone (for example the run closed it on purpose), the foreground belongs to
  // some other app, so report no title or process rather than a mismatched pair.
  const windowVerified = app.matched !== false || Boolean(run?.effectiveApp?.target);
  const replacedFrom = run?.effectiveApp?.replacedTarget || presenter.app?.repairedFrom || '';
  const replaced = Boolean(replacedFrom && appName && !sameAppName(replacedFrom, app.target || appName));
  // A passing run is not the same as a satisfied goal: the plan can pass while
  // it never touches the app the user named (a VLC request finished in Chrome).
  // The presenter may have been created before the workflow reached it, in
  // which case its goal is only the workflow name; the description is the goal.
  const goalText = String(workflow?.description || presenter.goal || workflow?.name || '');
  const requestedApp = goalApp(goalText);
  const appEvidence = requestedApp
    ? goalAppEvidence({ run, workflow, goal: goalText, app: requestedApp, foreground: { process: app.process, title: app.title } })
    : null;
  const appSatisfied = !appEvidence || appEvidence.evidenced;
  const goalMet = Boolean(passed) && appSatisfied;
  const withheld = Boolean(passed) && !appSatisfied;
  presenter.active = false;
  presenter.ai = {
    status: 'finished',
    action: null,
    detail: goalMet
      ? 'Goal verified.'
      : withheld
        ? `Steps finished, but ${appEvidence.reason}; not approved as a ${requestedApp?.name} result.`
        : error || 'Run ended without success.',
    reason: '',
    at: now(),
  };
  presenter.app.status = passed ? 'finished' : presenter.app.status === 'open' ? 'failed' : presenter.app.status;
  presenter.summary = {
    ...presenter.summary,
    goalMet,
    whatsDone: goalMet
      ? `Request accomplished: ${presenter.done.steps}/${presenter.done.total} steps passed.`
      : withheld
        ? `Steps completed (${presenter.done.steps}/${presenter.done.total}), but the app the goal names was not verified.`
        : `Request not accomplished. ${presenter.done.steps}/${presenter.done.total} steps passed.`,
    whatDoing: 'Run finished.',
    whatsNext: goalMet
      ? 'Review the presentation and keep the workflow.'
      : withheld
        ? `Open ${requestedApp?.name} and verify it there, or repair the workflow before keeping it.`
        : 'Review the recovery pack or guide the next attempt.',
  };
  const checks = (run.steps || []).filter((step) => ['expect', 'verifyScreen', 'verifyPlayback', 'screenshot'].includes(step.type));
  presenter.verifier = {
    at: now(),
    status: goalMet ? 'verified' : 'needs_review',
    goal: presenter.goal,
    userRequest: presenter.goal,
    app: {
      name: appName,
      target: app.target || '',
      title: windowVerified ? app.title || '' : '',
      process: windowVerified ? app.process || '' : '',
      ...(replaced ? { replacedFrom } : {}),
    },
    checks: checks.map((step) => ({ name: step.name, type: step.type, status: step.status, output: clip(step.output || '', 220) })),
    evidenceCount: (run.evidence || []).length,
    ...(appEvidence ? { requestedApp: appEvidence.app, appEvidence: { evidenced: appEvidence.evidenced, reason: appEvidence.reason, opens: appEvidence.opens.slice(0, 3), installs: appEvidence.installs.slice(0, 3) } } : {}),
    summary: goalMet
      ? `The run passed and the recorded verification steps agree with the requested goal${requestedApp ? ` in ${requestedApp.name}` : appName ? ` in ${appName}` : ''}${replaced ? ` (the target changed from ${replacedFrom} during the run)` : ''}.`
      : withheld
        ? `The ${presenter.done.total} steps completed, but ${appEvidence.reason}. Not approved as a ${requestedApp?.name} result.`
        : `The run did not pass${appName ? ` in ${appName}` : ''}; ${
            checks.filter((step) => step.status === 'failed').length || 'some'
          } verification step(s) are unresolved.`,
  };
  timeline(
    run,
    'system',
    'verification',
    goalMet
      ? `Final verification passed${requestedApp ? ` for ${requestedApp.name}` : appName ? ` for ${appName}` : ''}; the user request is presented as accomplished.`
      : withheld
        ? `Final verification withheld: ${appEvidence.reason}.`
        : `Final verification did not pass${appName ? ` for ${appName}` : ''}${error ? `: ${error}` : '.'}`
  );
  if (withheld) observe(run, 'warn', `Not approving this run: ${appEvidence.reason}.`, {});
  observe(run, goalMet ? 'info' : 'warn', presenter.summary.whatsDone);
  persist();
  return presenter;
}

export function presenterUserInput(run, workflow, { message = '', action = 'guide' } = {}) {
  const presenter = ensurePresenter(run, workflow);
  const text = clip(message, 1000);
  if (text) {
    presenter.userNotes.unshift({ id: uid('pin'), at: now(), text, action });
    presenter.userNotes = presenter.userNotes.slice(0, 30);
    addSuggestion(`Presenter guidance on “${run.workflowName}”: ${text}`, 'presenter', run.workflowId, run.id);
    observe(run, 'info', `User guidance: ${text}`);
    timeline(run, 'user', 'decision', text);
  }
  if (action === 'pause') run.pauseRequested = true;
  if (action === 'resume') {
    run.pauseRequested = false;
    run.paused = false;
  }
  if (action === 'continue') {
    run.pauseRequested = false;
    run.paused = false;
    run.skipRequested = false;
  }
  if (action === 'stop') run.cancelRequested = true;
  presenter.lastGuidance = text || presenter.lastGuidance || '';
  presenter.updatedAt = now();
  persist();
  return presenter;
}

export function recordPosition(run, workflow, step, { ok = true } = {}) {
  const presenter = ensurePresenter(run, workflow);
  const point = pointForStep(step);
  if (!point) return null;
  const screen = presenter.screen || { width: 1920, height: 1080, x: 0, y: 0 };
  const width = Math.max(1, Number(screen.width) || 1920);
  const height = Math.max(1, Number(screen.height) || 1080);
  const nx = Math.round((point.x / width) * 10000) / 10000;
  const ny = Math.round((point.y / height) * 10000) / 10000;
  const before = presenter.pointer;
  const dx = before ? Math.round(point.x - before.x) : null;
  const dy = before ? Math.round(point.y - before.y) : null;
  const distance = before ? Math.round(Math.sqrt((dx || 0) ** 2 + (dy || 0) ** 2)) : null;
  const angle = before && distance ? Math.round((Math.atan2(dy, dx) * 180) / Math.PI) : null;
  const row = {
    id: uid('pos'),
    at: now(),
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    stepId: step.id,
    stepName: step.name,
    action: step.type,
    app: presenter.app.target || presenter.app.process || '',
    window: presenter.app.title || '',
    x: point.x,
    y: point.y,
    normalized: { x: nx, y: ny },
    bucket: `${Math.round(nx / 0.05) / 20}:${Math.round(ny / 0.05) / 20}`,
    vector: [nx, ny],
    from: before ? { x: before.x, y: before.y } : null,
    delta: distance != null ? { dx, dy, distance, angle } : null,
    screen: { width, height, x: screen.x || 0, y: screen.y || 0 },
    ok: Boolean(ok),
  };
  const d = db();
  d.positionMemory = [row, ...(d.positionMemory || [])].slice(0, POSITION_LIMIT);
  const nearest = nearestPositions(row, 4);
  presenter.position = { memoryCount: d.positionMemory.length, last: row, nearest };
  presenter.updatedAt = now();
  timeline(run, 'system', 'position', `Position learned: ${step.type} at ${point.x},${point.y} (${row.bucket}); ${nearest.length} similar position(s).`, { stepId: step.id });
  return row;
}

export function nearestPositions(reference, limit = 4) {
  const d = db();
  if (!reference) return [];
  return (d.positionMemory || [])
    .filter(
      (entry) =>
        entry.id !== reference.id &&
        (entry.workflowId === reference.workflowId ||
          (entry.app && reference.app && entry.app === reference.app && entry.action === reference.action))
    )
    .map((entry) => ({
      ...entry,
      similarity: Math.round((1 - Math.min(1, Math.hypot((entry.normalized?.x || 0) - (reference.normalized?.x || 0), (entry.normalized?.y || 0) - (reference.normalized?.y || 0)))) * 100),
    }))
    .filter((entry) => entry.similarity >= 82)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export function listPositionMemory(limit = 12) {
  return (db().positionMemory || []).slice(0, Math.max(1, Math.min(100, Number(limit) || 12)));
}

export function activePresenter() {
  const runs = db().runs || [];
  return (
    runs.find((run) => ['running', 'queued'].includes(run.status) && run.presenter) ||
    runs.find((run) => run.presenter) ||
    null
  )?.presenter || null;
}

export function presenterForRun(run) {
  return run?.presenter || null;
}

export { APP_STATUSES, AI_STATUSES };