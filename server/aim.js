/**
 * Aiming the pointer while the console thinks.
 *
 * The runner used to think with the pointer parked wherever the last action
 * left it: between steps nothing visibly happened, and the next click jumped in
 * from an unrelated place. Aiming moves the pointer to the control the next
 * step names — a hover, never a click — during the thinking and planning gap,
 * so the move is already done when the action starts.
 *
 * It is passive by design and bound to the operator's own input: it only runs
 * while the mouse and keyboard have been quiet for a moment and while the
 * window the run owns is the window in front. A pointer that wanders into
 * someone else's app is worse than a pointer that waits. Nothing here clicks,
 * types or takes focus, and every move is recorded on the run (`run.aims`) and
 * in the log.
 */

import { db, now, persist, uid } from './store.js';
import { executeStep, findUiElement, readPresence, elementLabels } from './automation.js';

/** The person at the desk must be still: this is not a race for the pointer. */
export const AIM_MIN_IDLE_MS = 1200;
/** Re-aiming the same control every step is pointless. */
export const AIM_SAME_TARGET_MS = 5000;
const MAX_AIMS = 12;

const state = new Map();

function runState(runId) {
  const key = String(runId || '');
  if (!state.has(key)) state.set(key, { inflight: false, last: null });
  return state.get(key);
}

const targetTypes = new Set(['click', 'doubleClick', 'rightClick', 'clickElement', 'type', 'scroll', 'drag']);

/**
 * Where this step wants the pointer, in the terms the step itself uses: an
 * explicit coordinate, or the control it names.
 */
export function aimTargetFor(step) {
  const type = String(step?.type || '');
  if (!targetTypes.has(type)) return null;
  const params = step?.params || {};
  const x = Number(params.x);
  const y = Number(params.y);
  const window = String(params.window || params.title || (params.foreground === true ? '' : params.foreground) || '').trim();
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { kind: 'point', x: Math.round(x), y: Math.round(y), name: '', window, label: `${Math.round(x)}, ${Math.round(y)}` };
  }
  const name = String(params.name || params.label || params.control || params.target || '').trim();
  if (!name) return null;
  return {
    kind: 'element',
    name,
    window,
    controlType: String(params.controlType || '').trim(),
    label: name,
  };
}

/** The same aim, taken from a prepared thinking choice rather than a step. */
export function aimTargetForChoice(choice) {
  if (String(choice?.type || '') !== 'clickElement') return null;
  const params = choice?.params || {};
  const name = String(params.name || params.label || '').trim();
  if (!name) return null;
  return {
    kind: 'element',
    name,
    window: String(params.window || '').trim(),
    controlType: String(params.controlType || '').trim(),
    label: name,
  };
}

/**
 * Whether the pointer may be moved now. Pure, so the policy is testable without
 * a desktop: a simulated run, an operator who is typing, a window this run does
 * not own in front, or a pointer already on the control all say no.
 */
export function shouldAim({ run = null, presence = null, target = null, last = null, at = Date.now() } = {}) {
  if (!target) return { ok: false, reason: 'this step names no control to aim at' };
  if (!run || run.dryRun) return { ok: false, reason: 'the run is simulated' };
  if (run.shadow) return { ok: false, reason: 'the run is a shadow run' };
  if (run.pointerAim === false) return { ok: false, reason: 'aiming is off for this run' };
  if (!presence || presence.idleMs == null) return { ok: false, reason: 'the operator activity could not be read' };
  // The run's own clicks and keystrokes are input too, and they reset the idle
  // timer the presence guard reads. Input that happened at or after this run's
  // last action is the run's own: it must not be mistaken for the operator.
  const idle = Number(presence.idleMs) || 0;
  const inputAt = Number(at) - idle;
  const ours = Boolean(run.lastActionAt) && inputAt >= Number(run.lastActionAt) - 3000;
  if (idle < AIM_MIN_IDLE_MS && !ours) {
    return { ok: false, reason: 'the operator is using the mouse or keyboard' };
  }
  const front = String(presence.foreground?.title || '').toLowerCase();
  if (target.window && !front.includes(target.window.toLowerCase())) {
    return { ok: false, reason: `“${target.window}” is not the window in front` };
  }
  if (last && last.label === target.label && Number(at) - Number(last.at) < AIM_SAME_TARGET_MS) {
    return { ok: false, reason: 'the pointer is already on that control' };
  }
  return { ok: true, reason: '' };
}

/**
 * Turn a target into a screen point, asking UI Automation the same question a
 * click asks: the label variants first, then — when the control is not exposed
 * (Tk and other non-UIA toolkits) — the point this control was clicked at last
 * time, which is a fact about where it lives on screen.
 */
export async function resolveAimPoint(target, { find = findUiElement } = {}) {
  if (!target) return null;
  if (target.kind === 'point') return { x: target.x, y: target.y };
  for (const name of elementLabels(target.name)) {
    const found = await find({
      window: target.window,
      name,
      controlType: target.controlType || '',
    });
    if (!found?.found) continue;
    const x = Number(found.x);
    const y = Number(found.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // UI Automation reports device pixels; the runner acts in screen pixels.
    const scale = Number(found.scale) > 0 ? Number(found.scale) : 1;
    return { x: Math.round(x / scale), y: Math.round(y / scale) };
  }
  if (target.fallback) return { x: Math.round(target.fallback.x), y: Math.round(target.fallback.y) };
  return null;
}

async function movePointer(run, point, label) {
  await executeStep(
    {
      id: uid('aim'),
      type: 'move',
      name: `Aim at ${label}`,
      params: { x: point.x, y: point.y },
      timeoutMs: 6000,
    },
    { live: true, runId: run?.id || null, run, workflow: null, getTool: () => null }
  );
}

/**
 * Aim at a target. Returns what happened; never throws at the caller, because a
 * pointer that could not be placed is a note, not a failed step.
 */
export async function aimAt(run, target, { log = null, find = findUiElement, presence = readPresence, move = movePointer } = {}) {
  if (!run?.id || !target) return { ok: false, reason: 'nothing to aim at' };
  const tracker = runState(run.id);
  if (tracker.inflight) return { ok: false, reason: 'an aim is already in flight' };
  tracker.inflight = true;
  try {
    // Say why once per reason, so a pointer that stays still is explained on
    // the run instead of looking like aiming is switched off.
    const pause = (reason) => {
      if (typeof log === 'function' && run.aimNote !== reason) {
        run.aimNote = reason;
        log(`Aiming paused: ${reason}.`);
      }
      return { ok: false, reason };
    };
    const activity = await presence();
    const check = shouldAim({ run, presence: activity, target, last: tracker.last });
    if (!check.ok) return pause(check.reason);
    const point = await resolveAimPoint(target, { find });
    if (!point) return pause(`“${target.label}” could not be located on screen`);
    run.aimNote = '';
    await move(run, point, target.label);
    tracker.last = { label: target.label, at: Date.now(), x: point.x, y: point.y };
    run.aims = [
      ...(run.aims || []),
      { at: now(), target: target.label, x: point.x, y: point.y, window: target.window || '', stepId: run.currentStepId || null },
    ].slice(-MAX_AIMS);
    persist();
    if (typeof log === 'function') {
      log(`Aimed the pointer at “${target.label}” (${point.x}, ${point.y}) while the step is being prepared.`);
    }
    return { ok: true, point, reason: '' };
  } catch (err) {
    if (typeof log === 'function') log(`Could not aim the pointer at “${target.label}”: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    tracker.inflight = false;
  }
}

/**
 * Wait for an aim to finish, but never hold a step for longer than the budget.
 * The pointer must be on the control when the click starts; an aim still in
 * flight is reported, not silently raced by the click.
 */
export async function aimWithin(promise, { timeoutMs = 2500, log = null } = {}) {
  let timer = null;
  let timedOut = false;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, Math.max(0, Number(timeoutMs) || 0));
  });
  try {
    return await Promise.race([Promise.resolve(promise), limit]);
  } finally {
    clearTimeout(timer);
    if (timedOut && typeof log === 'function') {
      log('The pointer was still on its way to the control when the step started; the move finishes in the background.');
    }
  }
}

/** Aim for the step that is about to run, from the step's own parameters. */
export function aimBeforeStep(run, step, options = {}) {
  const target = aimTargetFor(step);
  if (!target) return Promise.resolve({ ok: false, reason: 'this step names no control to aim at' });
  // Where this control was clicked last time is the best point a toolkit with no
  // UI Automation tree can offer. It is only a hover target, never a click.
  const remembered = options.workflow?.clickPoints?.[step?.id];
  if (remembered && target.kind === 'element' && Number.isFinite(Number(remembered.x))) {
    target.fallback = { x: Number(remembered.x), y: Number(remembered.y) };
  }
  return aimAt(run, target, options);
}

export function resetAimState(runId = null) {
  if (runId == null) state.clear();
  else state.delete(String(runId));
}

export const aimSettings = () => ({ minIdleMs: AIM_MIN_IDLE_MS, sameTargetMs: AIM_SAME_TARGET_MS, enabled: db().settings?.pointerAim !== false });
