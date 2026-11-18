/**
 * Observer engine.
 *
 * A run only looks at the desktop at its own step boundaries, and the live watch
 * only sees the foreground window. This is a third engine, independent of both:
 * while a run is executing it samples the console's own state — the step in
 * flight, how long it has been running, the file it wrote, the last line of its
 * log, the window the monitor sees — and says one specific thing about what
 * changed. It never reads what the user types or clicks and never drives input,
 * so its lines stay true whether or not anyone is at the machine. A line may
 * still mention the user when that is the fact (a presence hold, for example).
 */

import { db, now, persist } from './store.js';
import { sizeLabel } from './automation.js';
import { monitorState } from './live-monitor.js';

const FILE_STEPS = new Set(['writeTextFile', 'downloadMedia', 'recordVideo', 'saveImage']);
const WAIT_BUCKETS = [5, 15, 30, 60, 120];
const MAX_KEPT = 60;
const MAX_STATE = 10;

const runtime = {
  timer: null,
  runId: null,
  intervalMs: 3000,
  last: { stepId: '', signature: '' },
  observations: [],
};

const clip = (value, max = 90) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

function runningStep(run) {
  const steps = run?.steps || [];
  return (
    steps.find((step) => step.id === run?.currentStepId && step.status === 'running') ||
    steps.find((step) => step.status === 'running') ||
    null
  );
}

/** The window a step is waiting on, when it names one. */
function stepTarget(step) {
  return String(step?.params?.foreground || step?.params?.title || step?.params?.windowName || '').trim();
}

/** The last line this step itself wrote, so narration quotes the app, not the user. */
function lastLogLine(run, stepId) {
  const logs = run?.log || [];
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = logs[index];
    if (!line || line.stepId !== stepId) continue;
    const message = String(line.message || '');
    if (message.startsWith('Observer:')) continue;
    if (message) return clip(message, 70);
  }
  return '';
}

/** The file this step recorded in the run, if it writes one. */
function stepFile(run, step) {
  const files = Array.isArray(run?.files) ? run.files : [];
  const wanted = String(step?.params?.filename || '').trim();
  const match = (wanted && files.filter((file) => file.filename === wanted).pop()) || files[files.length - 1];
  return match?.path ? match : null;
}

/**
 * What changed in the app since the last sample: one sentence, or null when the
 * situation is unchanged. Pure, so the tests drive it with plain run objects.
 */
export function observeStep(run, { at = Date.now(), monitor = null, previous = null } = {}) {
  const step = runningStep(run);
  if (!step) return null;
  const steps = run.steps || [];
  const index = steps.indexOf(step) + 1;
  const startedAt = new Date(step.startedAt || at).getTime();
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, at - startedAt) : 0;
  const target = stepTarget(step);
  const seen = previous?.stepId === step.id ? String(previous.signature || '') : '';
  const done = (signature, text) => ({ stepId: step.id, signature: `${step.id}:${signature}`, text });
  const unseen = (signature) => !seen.startsWith(`${step.id}:${signature}`);

  if (unseen('start')) {
    return done(
      'start',
      `“${step.name}” started (step ${index}/${steps.length}, ${step.type}).${target ? ` Waiting on “${target}”.` : ''}`
    );
  }

  if (FILE_STEPS.has(step.type)) {
    const file = stepFile(run, step);
    const bytes = Number(file?.bytes);
    if (file?.path && unseen(`file:${file.path}`)) {
      return done(`file:${file.path}`, `“${step.name}” wrote ${file.path}${Number.isFinite(bytes) ? ` (${sizeLabel(bytes)})` : ''}.`);
    }
  }

  const foreground = monitor?.current || null;
  const foregroundTitle = String(foreground?.title || '').trim();
  if (target && foregroundTitle) {
    const process = String(foreground.process || '').trim();
    const matches =
      foregroundTitle.toLowerCase().includes(target.toLowerCase()) ||
      (process && process.toLowerCase() === target.replace(/\.exe$/i, '').toLowerCase());
    if (!matches && unseen(`fg:${foregroundTitle}`)) {
      return done(
        `fg:${foregroundTitle}`,
        `“${step.name}” is waiting on “${target}”, but the foreground is “${clip(foregroundTitle, 50)}”${
          process ? ` (${process})` : ''
        }.`
      );
    }
    if (matches && unseen('fg:ok')) {
      return done('fg:ok', `“${clip(foregroundTitle, 50)}” is in front, as “${step.name}” expects.`);
    }
  }

  const seconds = Math.floor(elapsedMs / 1000);
  const bucket = [...WAIT_BUCKETS].reverse().find((threshold) => seconds >= threshold);
  if (bucket && unseen(`wait:${bucket}`)) {
    const last = lastLogLine(run, step.id);
    return done(
      `wait:${bucket}`,
      `“${step.name}” has been running ${bucket}s; ${last ? `last log: “${last}”` : 'no log line from it yet'}.`
    );
  }

  const pending = (run.pendingVerification || []).find((entry) => entry.stepId === step.id);
  if (pending?.checks?.length && unseen('pending')) {
    return done('pending', `“${step.name}” is waiting on ${pending.checks.join(' + ')} before it counts as done.`);
  }

  return null;
}

/** How a step ended: duration, the file it left, and its error if it failed. */
export function endStepObservation(run, step, { at = Date.now() } = {}) {
  if (!step?.startedAt) return null;
  const status = String(step.status || '');
  if (!['passed', 'failed', 'skipped'].includes(status)) return null;
  const startedAt = new Date(step.startedAt).getTime();
  const endedAt = new Date(step.endedAt || at).getTime();
  const seconds = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0;
  const file = FILE_STEPS.has(step.type) ? stepFile(run, step) : null;
  return {
    stepId: step.id,
    signature: `${step.id}:end:${status}`,
    text: `“${step.name}” ${status} after ${seconds}s${file?.path ? `, wrote ${file.path}` : ''}${
      step.error ? `: ${clip(step.error, 80)}` : ''
    }.`,
  };
}

function record(run, observation) {
  if (!observation) return;
  const entry = { at: now(), stepId: observation.stepId, text: observation.text };
  run.observations = [...(run.observations || []), entry].slice(-MAX_KEPT);
  run.log.push({ at: entry.at, level: 'info', message: `Observer: ${entry.text}`, stepId: observation.stepId });
  if (run.log.length > 400) run.log = run.log.slice(-400);
  runtime.observations = [...runtime.observations, { ...entry, runId: run.id, workflowName: run.workflowName }].slice(-40);
  persist();
}

function tick() {
  const run = (db().runs || []).find((entry) => entry.id === runtime.runId);
  if (!run || run.status !== 'running') return stopObservation();
  let monitor = null;
  try {
    monitor = monitorState();
  } catch {
    monitor = null;
  }
  const observation = observeStep(run, { monitor, previous: runtime.last });
  if (!observation) return observerState();
  runtime.last = { stepId: observation.stepId, signature: observation.signature };
  record(run, observation);
  return observerState();
}

function stopObservation() {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.timer = null;
  runtime.runId = null;
  return observerState();
}

/** Start sampling this run; safe to call once per run. */
export function beginRunObservation(run, { intervalMs } = {}) {
  if (!run || db().settings?.observerEnabled === false) return observerState();
  runtime.runId = run.id;
  runtime.intervalMs = Math.max(
    1000,
    Math.min(15000, Number(intervalMs) || Number(db().settings?.observerIntervalMs) || 3000)
  );
  runtime.last = { stepId: '', signature: '' };
  if (runtime.timer) return observerState();
  runtime.timer = setInterval(tick, runtime.intervalMs);
  runtime.timer.unref?.();
  tick();
  return observerState();
}

/** Say how the last step ended, then stop sampling. */
export function endRunObservation(run) {
  try {
    const last = [...(run?.steps || [])].reverse().find((step) => step.status && step.status !== 'pending');
    if (last && last.id === runtime.last.stepId) record(run, endStepObservation(run, last));
  } catch {
    // Narration is never worth failing a run over.
  }
  return stopObservation();
}

/** Serializable view for /api/state and /api/live/monitor. */
export function observerState() {
  const run = runtime.runId ? (db().runs || []).find((entry) => entry.id === runtime.runId) || null : null;
  const step = run ? runningStep(run) : null;
  return {
    running: Boolean(runtime.timer),
    runId: runtime.runId,
    intervalMs: runtime.intervalMs,
    step: step ? { name: step.name, type: step.type, startedAt: step.startedAt || null } : null,
    observations: runtime.observations.slice(-MAX_STATE),
  };
}
