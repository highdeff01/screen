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
import { executeStep, findUiElement, findUiElementByOcr, readPresence, readCursor as readCursorPoint, readWindowRect, elementLabels } from './automation.js';
import { adjustPoint, describeMotion, motionBetween, workableZone } from './motion.js';
import { fromWindowOffset, isWindowRelative } from './window-relative.js';

/** The person at the desk must be still: this is not a race for the pointer. */
export const AIM_MIN_IDLE_MS = 1200;
/** Re-aiming the same control every step is pointless. */
export const AIM_SAME_TARGET_MS = 5000;
const MAX_AIMS = 12;
/** Close enough that moving the pointer would change nothing worth waiting for. */
export const AIM_NEAR_PX = 6;
/** A window may drift this far (DPI rounding) before its points stop counting. */
export const POINT_WINDOW_TOLERANCE_PX = 2;

const state = new Map();

function runState(runId) {
  const key = String(runId || '');
  if (!state.has(key)) state.set(key, { inflight: false, last: null });
  return state.get(key);
}

const targetTypes = new Set(['click', 'doubleClick', 'rightClick', 'clickElement', 'type', 'scroll', 'drag']);

/** How to name the window a relative point is measured inside. */
function targetWindowLabel(window) {
  const title = String(window || '').trim();
  return title ? `“${title}”` : 'the window in front';
}

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
    // A window-relative point is an offset until the window is read; the move is
    // resolved against the window's current rectangle just before it happens.
    const relative = isWindowRelative(params);
    return {
      kind: 'point',
      x: Math.round(x),
      y: Math.round(y),
      relative,
      name: '',
      window,
      label: relative ? `${Math.round(x)}, ${Math.round(y)} inside ${targetWindowLabel(window)}` : `${Math.round(x)}, ${Math.round(y)}`,
    };
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
/** Why this run may not aim at all, or '' when it may. */
export function aimDisabledReason(run, target) {
  if (!target) return 'this step names no control to aim at';
  if (!run) return 'the run is not running';
  if (run.dryRun) return 'the run is simulated';
  if (run.shadow) return 'the run is a shadow run';
  if (run.pointerAim === false) return 'aiming is off for this run';
  return '';
}

/**
 * A point this target has without asking the desktop: an explicit coordinate, or
 * where the control was clicked last time. Aiming at either is a hover, so if
 * the pointer is already there nothing has to be resolved or moved.
 */
export function knownAimPoint(target) {
  if (!target) return null;
  // A relative point is an offset, not a place the pointer could already be on.
  if (target.kind === 'point') return target.relative ? null : { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) };
  const x = Number(target.fallback?.x);
  const y = Number(target.fallback?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Whether the pointer is close enough that moving it would change nothing. */
export function pointerIsOnTarget(point, cursor, tolerance = AIM_NEAR_PX) {
  if (!point || !cursor) return false;
  const dx = Number(point.x) - Number(cursor.x);
  const dy = Number(point.y) - Number(cursor.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const limit = Math.max(0, Number(tolerance) || 0);
  return Math.sqrt(dx * dx + dy * dy) <= limit;
}

export function shouldAim({ run = null, presence = null, target = null, last = null, at = Date.now() } = {}) {
  const disabled = aimDisabledReason(run, target);
  if (disabled) return { ok: false, reason: disabled };
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
 * Turn a target into a screen point, asking the same questions the click will:
 * UI Automation's label variants first, then — when the control is not exposed
 * (Tk and other non-UIA toolkits, which is why aiming existed at all here) — a
 * read of the window's text, which locates the label in 19–46 ms instead of the
 * vision model's 0.7–52 s and lands inside the control. The point this control
 * was clicked at last time is the last resort: a fact, but a stale one.
 */
export async function resolveAimPoint(target, { find = findUiElement, readText = findUiElementByOcr } = {}) {
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
    // The inspection script is DPI-aware, so this is already a physical screen
    // pixel — the same unit the pointer is moved in.
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (readText) {
    try {
      const read = await readText({ window: target.window, names: elementLabels(target.name) });
      const x = Number(read?.x);
      const y = Number(read?.y);
      if (read?.found && Number.isFinite(x) && Number.isFinite(y)) return { x: Math.round(x), y: Math.round(y) };
    } catch {
      // A window that could not be read leaves the aim to the remembered point.
    }
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

/** Record what an aim did on the run: the point, whether it moved, and its cost. */
function recordAim(run, target, point, { moved, ms, log, tracker }) {
  run.aimNote = '';
  tracker.last = { label: target.label, at: Date.now(), x: point.x, y: point.y };
  run.aims = [
    ...(run.aims || []),
    {
      at: now(),
      target: target.label,
      x: point.x,
      y: point.y,
      window: target.window || '',
      stepId: target.stepId || run.currentStepId || null,
      moved,
      ms,
    },
  ].slice(-MAX_AIMS);
  persist();
  if (typeof log === 'function') {
    log(
      moved
        ? `Aimed the pointer at “${target.label}” (${point.x}, ${point.y}) while the step is being prepared.`
        : `The pointer was already on “${target.label}” (${point.x}, ${point.y}); the step starts without waiting for a move.`
    );
  }
  return { ok: true, point, moved, ms, reason: '' };
}

/**
 * Aim at a target. Returns what happened; never throws at the caller, because a
 * pointer that could not be placed is a note, not a failed step.
 */
export async function aimAt(
  run,
  target,
  { log = null, find = findUiElement, readText = findUiElementByOcr, presence = readPresence, move = movePointer, cursor = readCursorPoint, readRect = readWindowRect, tolerance = AIM_NEAR_PX } = {}
) {
  if (!run?.id || !target) return { ok: false, reason: 'nothing to aim at' };
  const tracker = runState(run.id);
  if (tracker.inflight) return { ok: false, reason: 'an aim is already in flight' };
  tracker.inflight = true;
  const startedAt = Date.now();
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
    const safeCursor = async () => {
      try {
        return await cursor();
      } catch {
        return null;
      }
    };
    const disabled = aimDisabledReason(run, target);
    if (disabled) return pause(disabled);
    // A target that already has its point needs no presence read and no UI
    // Automation query: if the pointer is there, the step starts now. This is
    // the case that repeats most — a control clicked a moment ago.
    const known = knownAimPoint(target);
    const cursorAtStart = known ? await safeCursor() : null;
    if (known && pointerIsOnTarget(known, cursorAtStart, tolerance)) {
      return recordAim(run, target, known, { moved: false, ms: Date.now() - startedAt, log, tracker });
    }
    const activity = await presence();
    const check = shouldAim({ run, presence: activity, target, last: tracker.last });
    if (!check.ok) return pause(check.reason);
    // A point recorded inside the window has to be placed on the screen first:
    // the offset is what survives the window being dragged.
    let resolveTarget = target;
    if (target.relative) {
      let rect = null;
      try {
        rect = await readRect(target.window || '');
      } catch {
        rect = null;
      }
      const placed = fromWindowOffset({ x: target.x, y: target.y }, rect);
      if (!placed) {
        return pause(`${targetWindowLabel(target.window)} could not be located, so “${target.label}” has no screen point`);
      }
      resolveTarget = { ...target, kind: 'point', relative: false, x: placed.x, y: placed.y };
    }
    const point = await resolveAimPoint(resolveTarget, { find, readText });
    if (!point) return pause(`“${target.label}” could not be located on screen`);
    // Where the pointer is comes free with the presence read; a target resolved
    // by UI Automation can land on the pointer without any further work.
    const here = activity?.cursor || cursorAtStart || (await safeCursor());
    if (pointerIsOnTarget(point, here, tolerance)) {
      return recordAim(run, target, point, { moved: false, ms: Date.now() - startedAt, log, tracker });
    }
    await move(run, point, target.label);
    return recordAim(run, target, point, { moved: true, ms: Date.now() - startedAt, log, tracker });
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

/**
 * Whether a remembered point was recorded in the window as it stands now.
 *
 * A point is a pair of screen coordinates, not a place in the app: once the
 * window has moved, the same pair points at whatever happens to be there. A
 * point with no recorded rect has no provenance at all, so it is not trusted
 * either — the fresh read is the only thing that knows where the control is.
 */
export function pointMatchesWindow(point, rect) {
  const saved = point?.window;
  if (!saved || !rect) return false;
  for (const key of ['left', 'top', 'width', 'height']) {
    const was = Number(saved[key]);
    const now = Number(rect[key]);
    if (!Number.isFinite(was) || !Number.isFinite(now)) return false;
    if (Math.abs(was - now) > POINT_WINDOW_TOLERANCE_PX) return false;
  }
  return true;
}

/** Aim for the step that is about to run, from the step's own parameters. */
export async function aimBeforeStep(run, step, options = {}) {
  const target = aimTargetFor(step);
  if (!target) return { ok: false, reason: 'this step names no control to aim at' };
  // The run keeps the aim under the step it was for, so its cost is attributable.
  target.stepId = String(step?.id || options.stepId || '') || null;
  // Where this control was clicked last time is the best point a toolkit with no
  // UI Automation tree can offer. It is only a hover target, never a click, and
  // only while the window is still where the point was recorded: a window that
  // moved turns the same coordinates into empty desktop.
  const remembered = options.workflow?.clickPoints?.[step?.id];
  if (remembered && target.kind === 'element' && Number.isFinite(Number(remembered.x))) {
    const readRect = typeof options.windowRect === 'function' ? options.windowRect : readWindowRect;
    let rect = null;
    try {
      // Without a guard the remembered point does not say which window it was
      // learned in, and the window in front would be a guess at its origin.
      rect = target.window ? await readRect(target.window) : null;
    } catch {
      rect = null;
    }
    if (pointMatchesWindow(remembered, rect)) {
      target.fallback = { x: Number(remembered.x), y: Number(remembered.y) };
    } else if (remembered.window) {
      // The window is not where the point was recorded, so the coordinates no
      // longer name the same place. Carry the point across the move instead of
      // either trusting it blind or dropping what the click taught us: the
      // control keeps its place in the window, so translate by the movement and
      // scale by any resize, then keep the result inside the window itself.
      const saved = remembered.window;
      // `motionBetween` is the validity check too: an unreadable or minimized
      // window has no usable rect, so it yields null and nothing is carried.
      const motion = motionBetween(saved, rect);
      const carried = motion ? adjustPoint(remembered, saved, rect) : null;
      const zone = carried ? workableZone(carried, rect) : null;
      if (zone) {
        target.fallback = { x: zone.x, y: zone.y };
        target.remapped = {
          from: { x: Number(remembered.x), y: Number(remembered.y) },
          to: { x: zone.x, y: zone.y },
          motion,
        };
        if (typeof options.log === 'function') {
          options.log(
            `The point remembered for “${target.label}” was recorded at ${remembered.x},${remembered.y} in a window at ${saved.left},${saved.top}; ${describeMotion(
              motion
            )}, so it was carried to ${zone.x},${zone.y}. The control is still located afresh first; the carried point is used only if that fails.`
          );
        }
      } else if (typeof options.log === 'function') {
        options.log(
          `The point remembered for “${target.label}” was recorded in a window at ${saved.left},${saved.top} and the window could not be found now; it is not used, so the control is located afresh.`
        );
      }
    }
  }
  return aimAt(run, target, options);
}

export function resetAimState(runId = null) {
  if (runId == null) state.clear();
  else state.delete(String(runId));
}

export const aimSettings = () => ({ minIdleMs: AIM_MIN_IDLE_MS, sameTargetMs: AIM_SAME_TARGET_MS, enabled: db().settings?.pointerAim !== false });
