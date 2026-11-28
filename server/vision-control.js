/**
 * Live control: the model watching the stream and acting without a plan.
 *
 * Every other path in the console starts a run: a plan is written, a step is
 * taken, the screen is read, the step is proven. That is right for a workflow
 * and wrong for "make this happen on screen now", because the plan is stale the
 * moment the screen moves. This is the loop the runs cannot be: look at the
 * newest frame, decide one action, do it, look again — and keep going by itself.
 *
 * What makes it a loop rather than a step:
 *
 *   look      the newest frame, its sections, its labels. The engine is the
 *             only source of truth; there is no prompt built from a plan.
 *   decide    one action from an allowlist, with a named target preferred over
 *             guessed coordinates, so a button the labeller already found is
 *             clicked by identity even after it moved.
 *   act       the same desktop automation a run uses, one action at a time.
 *   verify    a frame captured after the action, never one the stream was
 *             already holding: a frame taken before the action says nothing
 *             about it. A screen that did not change is a fact, not a pass, and
 *             it is handed straight back to the model.
 *
 * Two automatic recoveries, because a live loop that stops at the first miss is
 * a very slow screenshot tool:
 *
 *   retry     an action that threw is tried again (`maxRetries`), because a
 *             window that was still coming up or a click that raced a repaint
 *             fails once and works the second time.
 *   replan    an action that failed twice, or whose screen did not change, is
 *             not repeated. The model is asked again with the exact failure and
 *             the same goal, so it picks a different route instead of hammering
 *             the same control (`maxReplans`).
 *
 * Everything is bounded — steps, wall clock, retries, replans, model errors —
 * because an unattended loop with a pointer is the one thing that must never
 * spin. Nothing is typed or clicked unless `start()` was called with a goal and
 * the platform reports live control, and `stop()` ends the loop at the next
 * check between actions.
 */
import { chat, parseJsonLoose } from './llm.js';
import { executeStep, runPowerShell } from './automation.js';
import { vision } from './vision-engine.js';
import { visionReview } from './vision-review.js';
import { visionBus } from './vision-bus.js';
import { logActivity } from './store.js';

export const MAX_STEPS = 40;
export const MAX_MS = 5 * 60 * 1000;
export const MAX_RETRIES = 2;
export const MAX_REPLANS = 3;
export const DECISION_TIMEOUT_MS = 60000;
export const SETTLE_MS = 350;
export const PULSE_MS = 2000;
/** How long the after-action check keeps asking for a fresh capture. */
export const VERIFY_TIMEOUT_MS = 2500;
export const VERIFY_POLL_MS = 120;
/** A frame that moved less than this is a screen that did not change. */
export const NO_CHANGE_PCT = 1;

export const ACTION_TYPES = ['move', 'click', 'doubleClick', 'rightClick', 'type', 'key', 'scroll', 'wait'];
const POINT_TYPES = new Set(['move', 'click', 'doubleClick', 'rightClick']);
const WAITING = new Set(['wait']);
const clamp01 = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
};
const textOf = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/**
 * Whatever the model called an action, in the shape the actor understands.
 * Unknown types are refused here rather than thrown at the desktop; a target
 * without coordinates is kept, because the controller resolves it against the
 * labels the engine already tracks.
 */
export function cleanAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? raw.action ?? raw.kind ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (type === 'done' || type === 'finish' || type === 'complete') return { type: 'done', why: textOf(raw.why ?? raw.reason, 240) };
  if (!ACTION_TYPES.includes(type)) return null;
  const action = { type, why: textOf(raw.why ?? raw.reason ?? raw.note, 240) };
  const target = textOf(raw.target ?? raw.element ?? raw.label, 80);
  if (target) action.target = target;
  if (POINT_TYPES.has(type)) {
    const x = clamp01(raw.x);
    const y = clamp01(raw.y);
    if (x !== null && y !== null) {
      action.x = x;
      action.y = y;
    }
  }
  if (type === 'type') {
    const text = String(raw.text ?? raw.value ?? '');
    if (!text) return null;
    action.text = text.slice(0, 4000);
  }
  if (type === 'key') {
    const keys = textOf(raw.keys ?? raw.key ?? raw.shortcut, 60);
    if (!keys) return null;
    action.keys = keys;
  }
  if (type === 'scroll') {
    const amount = Number(raw.amount ?? raw.clicks ?? -3);
    action.amount = Math.max(-10, Math.min(10, Number.isFinite(amount) ? Math.round(amount) : -3));
  }
  if (type === 'wait') {
    const ms = Number(raw.ms ?? 800);
    action.ms = Math.max(0, Math.min(30000, Number.isFinite(ms) ? Math.round(ms) : 800));
  }
  return action;
}

/** The one action, as a line the log and the repair prompt can both quote. */
export function describeAction(action) {
  if (!action) return 'nothing';
  if (action.type === 'done') return 'done';
  if (POINT_TYPES.has(action.type)) {
    const at = action.x === undefined ? `“${action.target}”` : `${action.x.toFixed(2)},${action.y.toFixed(2)}`;
    return `${action.type} at ${at}`;
  }
  if (action.type === 'type') return `type “${String(action.text || '').slice(0, 40)}”`;
  if (action.type === 'key') return `press ${action.keys}`;
  if (action.type === 'scroll') return `scroll ${action.amount}`;
  if (action.type === 'wait') return `wait ${action.ms} ms`;
  return action.type;
}

/** The decision prompt: the goal, this screen, and what has already failed. */
export function controlPrompt({
  goal = '',
  frame = {},
  digest = '',
  elements = [],
  review = null,
  history = [],
  failure = '',
} = {}) {
  const system = [
    'You are the live-control agent inside Sightline, a Windows desktop-automation console.',
    'You are shown the current desktop as a frame record with tracked labels, not a picture. Choose ONE action that moves the goal forward.',
    'Reply with JSON only, exactly this shape:',
    '{"done":false,"why":"one short sentence","action":{"type":"click","target":"Save"}}',
    'Action types: move, click, doubleClick, rightClick, type, key, scroll, wait.',
    'Coordinates are normalized: x and y between 0 and 1 from the top-left of the screen. Prefer "target" naming a tracked label; use x and y only for something with no label.',
    'After your action the screen is read again and you will be asked for the next one, so do not chain actions in one answer and do not repeat an action the log says failed — choose a different route.',
    `Set "done":true only when the goal is visibly reached. At most ${MAX_STEPS} actions are allowed.`,
  ].join(' ');
  const lines = [goal ? `Goal: ${goal}` : 'Goal: none set — describe what should happen next.'];
  if (frame?.seq) {
    lines.push(
      `Frame #${frame.seq}${frame.changedPct === null || frame.changedPct === undefined ? '' : `, ${frame.changedPct}% changed`}${
        Array.isArray(frame.dirtySections) && frame.dirtySections.length ? `, ${frame.dirtySections.length} section(s) moved` : ''
      }.`
    );
  }
  const labelled = (elements || []).slice(0, 24).map((element) => {
    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    const w = Number(element.w) || 0;
    const h = Number(element.h) || 0;
    return `“${element.label}” (${(x + w / 2).toFixed(2)},${(y + h / 2).toFixed(2)}) seen ${element.seen || 1}×`;
  });
  if (labelled.length) lines.push('', 'Tracked labels:', labelled.join('; '));
  else lines.push('', 'Tracked labels: none yet — use coordinates from the frame, or wait for a label.');
  if (review?.summary) lines.push('', `Reader: ${review.summary}${review.next ? ` Next it suggested: ${review.next}` : ''}`);
  if (digest) lines.push('', 'Recent timeline:', String(digest).slice(0, 3000));
  if (history.length) {
    lines.push('', 'What has been tried:');
    for (const entry of history.slice(0, 8)) {
      const result = entry.changed === true ? 'the screen changed' : entry.changed === false ? 'the screen did not change' : 'no check';
      lines.push(`- ${entry.action} — ${result}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }
  if (failure) lines.push('', `Last attempt failed: ${String(failure).slice(0, 600)}`, 'Do not repeat it. Choose a different action that still serves the goal.');
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * A normalized point and the desktop's own origin. The capture is a scaled
 * picture of the virtual screen, so the same fraction of the width is the same
 * place on the desktop; the origin is what a second monitor to the left moves.
 */
export function screenPoint(action, bounds) {
  if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return null;
  const x = clamp01(action?.x);
  const y = clamp01(action?.y);
  if (x === null || y === null) return null;
  return {
    x: Math.round((Number(bounds.x) || 0) + x * bounds.width),
    y: Math.round((Number(bounds.y) || 0) + y * bounds.height),
  };
}

let boundsCache = { at: 0, value: null };
/** The virtual screen, read once and reused: a resolution does not change often. */
export async function readScreenBounds({ force = false, maxAgeMs = 30000, now = () => Date.now() } = {}) {
  if (!force && boundsCache.value && now() - boundsCache.at < maxAgeMs) return boundsCache.value;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    'Write-Output ("$($b.X),$($b.Y),$($b.Width),$($b.Height)")',
  ].join('\n');
  const result = await runPowerShell(script, 8000);
  if (!result?.ok) return null;
  const [x, y, width, height] = String(result.stdout || '').split(/[,\s]+/).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  boundsCache = { at: now(), value: { x, y, width, height } };
  return boundsCache.value;
}

/** The automation step one action becomes. Coordinates are already in pixels. */
export function stepForAction(action, point = null) {
  if (action.type === 'type') return { type: 'type', name: `Type ${String(action.text || '').slice(0, 30)}`, params: { text: action.text } };
  if (action.type === 'key') return { type: 'key', name: `Press ${action.keys}`, params: { keys: action.keys } };
  if (action.type === 'scroll') return { type: 'scroll', name: `Scroll ${action.amount}`, params: { amount: action.amount } };
  if (!POINT_TYPES.has(action.type)) return null;
  if (!point) return null;
  return { type: action.type, name: `${action.type} ${point.x},${point.y}`, params: { x: point.x, y: point.y } };
}

/**
 * The default actor: one action through the same automation a run uses, with
 * the screen's own origin applied. Injected in tests, so no test moves a pointer.
 */
export function createLiveActor({
  execute = executeStep,
  screen = readScreenBounds,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  return async function act(action) {
    if (!action) throw new Error('There is no action to perform.');
    if (action.type === 'wait') {
      await wait(action.ms || 800);
      return { output: `Waited ${action.ms || 800} ms.` };
    }
    if (action.type === 'done') return { output: 'done' };
    let point = null;
    if (POINT_TYPES.has(action.type)) {
      const bounds = await screen();
      if (!bounds) throw new Error('The screen size could not be read, so the point cannot be mapped to the desktop.');
      point = screenPoint(action, bounds);
      if (!point) throw new Error('That action has no point on the screen to act on.');
    }
    const step = stepForAction(action, point);
    if (!step) throw new Error(`Unsupported action: ${action.type}`);
    const result = await execute(step, { live: true, run: { variables: {} }, workflow: { name: 'Live control' } });
    return result || { output: '' };
  };
}

/**
 * One controller. `engine` is the session's vision engine, `ask` is the model,
 * `act` performs one action, and `wait` is the clock's sleep — all injectable,
 * so a test runs the whole loop over a fake screen with no desktop and no model.
 */
export function createVisionController({
  engine,
  sessionId = 'main',
  ask = chat,
  act = null,
  publish = () => {},
  readReview = null,
  log = logActivity,
  clock = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  schedule = setInterval,
  cancel = clearInterval,
  maxSteps = MAX_STEPS,
  maxMs = MAX_MS,
  maxRetries = MAX_RETRIES,
  maxReplans = MAX_REPLANS,
  decisionTimeoutMs = DECISION_TIMEOUT_MS,
  settleMs = SETTLE_MS,
  retryDelayMs = 400,
  pulseMs = PULSE_MS,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  verifyPollMs = VERIFY_POLL_MS,
  maxErrors = 3,
} = {}) {
  if (!engine || typeof engine.step !== 'function') throw new Error('A live controller needs a vision engine.');
  const perform = typeof act === 'function' ? act : createLiveActor();

  let running = false;
  let busy = false;
  let goal = '';
  let startedAt = null;
  let finishedAt = null;
  let stopReason = null;
  let steps = 0;
  let retries = 0;
  let replans = 0;
  let errors = 0;
  let pulses = 0;
  let lastError = '';
  let lastAction = null;
  let limitSteps = maxSteps;
  let limitMs = maxMs;
  const history = [];
  let pulseTimer = null;
  let loop = null;

  const emit = (type, data = {}) => {
    try {
      publish(type, { session: sessionId, ...data });
    } catch {
      // A viewer that cannot be written is not a reason to stop acting.
    }
  };

  function state() {
    return {
      session: sessionId,
      running,
      busy,
      goal,
      steps,
      retries,
      replans,
      errors,
      pulses,
      lastError,
      lastAction,
      stopReason,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      limits: { maxSteps: limitSteps, maxMs: limitMs, maxRetries, maxReplans },
      history: history.slice(0, 12),
      goalReached: Boolean(engine.state?.().goal?.reachedAt),
    };
  }

  /** One capture attempt, in the outcome shape the engine reports. */
  async function read() {
    let outcome = null;
    try {
      outcome = await engine.step();
    } catch (err) {
      throw Object.assign(new Error(`The screen could not be read: ${String(err?.message || err).slice(0, 200)}`), {
        unreadable: Boolean(err?.unreadable),
      });
    }
    if (outcome?.error) throw Object.assign(new Error(outcome.error), { unreadable: true });
    return outcome;
  }

  /** The newest frame the stream has. A busy engine's current frame is just as good. */
  async function look() {
    const outcome = await read();
    if (outcome?.busy || outcome?.skipped) return engine.state?.().current || null;
    return outcome;
  }

  /**
   * The frame after an action, from a capture this check started itself.
   *
   * The stream is already capturing, so the frame sitting in the engine may have
   * been taken before the action being judged — `busy` hands back exactly that
   * one. Judging it calls a click that worked a screen that “did not change” and
   * re-plans work already done. So every poll asks for its own capture, and only
   * an answer produced by one counts: a capture that was already in flight is
   * `busy` and is asked again rather than trusted. A capture that reports the
   * desktop identical to the last frame it kept is a real “nothing changed”.
   *
   * `changed: null` means no fresh frame arrived in time. That is not a failed
   * action, and it must never become a replan.
   */
  async function verify({ sinceSeq = 0, timeoutMs = verifyTimeoutMs } = {}) {
    const deadline = clock() + Math.max(0, timeoutMs);
    for (;;) {
      const outcome = await read();
      if (outcome?.identical === true || outcome?.quiet === true) {
        return { frame: engine.state?.().current || null, changed: false, fresh: true };
      }
      const seq = Number(outcome?.seq);
      if (Number.isFinite(seq) && seq > 0) {
        return {
          frame: outcome,
          changed: seq > sinceSeq && (outcome.changedPct === null || outcome.changedPct === undefined || outcome.changedPct >= NO_CHANGE_PCT),
          fresh: true,
        };
      }
      if (clock() >= deadline) return { frame: engine.state?.().current || null, changed: null, fresh: false };
      await wait(verifyPollMs);
    }
  }

  function startPulse() {
    if (pulseTimer !== null) return;
    // While the model thinks, the viewer is told the loop is alive; a stream
    // that says nothing for a minute looks dead, and the operator stops it.
    pulseTimer = schedule(() => {
      pulses += 1;
      emit('pulse', { pulses, steps });
    }, pulseMs);
    pulseTimer?.unref?.();
  }

  function stopPulse() {
    if (pulseTimer === null) return;
    cancel(pulseTimer);
    pulseTimer = null;
  }

  function finish(reason) {
    running = false;
    stopReason = String(reason || 'stopped').slice(0, 400);
    if (finishedAt === null) finishedAt = clock();
    stopPulse();
    emit('stop', { reason: stopReason, steps, retries, replans });
    try {
      log('vision', `Live control stopped: ${stopReason}`);
    } catch {
      // The log is a convenience, never a condition.
    }
    return state();
  }

  function markGoal(reason) {
    try {
      engine.markGoalReached?.(reason);
    } catch {
      // A goal marker that cannot be written does not undo the reached goal.
    }
    return finish(`goal reached — ${reason}`);
  }

  /**
   * The session reviewer's last reading. It belongs to the reviewer, not to the
   * engine: the engine only records pixels, so a summary read off it is always
   * empty and the decision would be made blind to what the screen says.
   */
  function lastReading() {
    if (typeof readReview !== 'function') return null;
    try {
      return readReview() || null;
    } catch {
      // A reviewer that cannot be asked is a decision made without it.
      return null;
    }
  }

  /** Ask for one action, with the failure that made the last one wrong. */
  async function decide({ frame, elements, failure }) {
    const messages = controlPrompt({
      goal,
      frame,
      digest: typeof engine.digest === 'function' ? engine.digest({ count: 20 }) : '',
      elements,
      review: lastReading(),
      history,
      failure,
    });
    const reply = await ask(messages, {
      kind: 'vision-control',
      format: 'json',
      temperature: 0.1,
      timeoutMs: decisionTimeoutMs,
    });
    if (!reply?.ok) throw new Error(reply?.error || 'the model did not answer');
    const parsed = parseJsonLoose(reply.content) || {};
    const raw = parsed.action && typeof parsed.action === 'object' ? parsed.action : parsed;
    const action = cleanAction(raw);
    const done = parsed.done === true || action?.type === 'done';
    return { done, why: textOf(parsed.why ?? parsed.reason ?? action?.why, 240), action };
  }

  /** A named target is the tracked element's current centre. */
  function place(action, elements) {
    if (action.target) {
      const wanted = action.target.toLowerCase();
      const found =
        elements.find((element) => String(element.label || '').toLowerCase() === wanted) ||
        elements.find((element) => String(element.label || '').toLowerCase().includes(wanted));
      if (!found) return null;
      return {
        ...action,
        target: String(found.label || action.target),
        x: (Number(found.x) || 0) + (Number(found.w) || 0) / 2,
        y: (Number(found.y) || 0) + (Number(found.h) || 0) / 2,
      };
    }
    if (POINT_TYPES.has(action.type) && (action.x === undefined || action.y === undefined)) return null;
    return action;
  }

  /**
   * One observe → decide → act → verify turn. Returns the controller state when
   * the loop should stop, and `{ ok: true }` when another turn should follow.
   */
  async function turn() {
    let frame = await look();
    if (!frame) throw new Error('There is no frame to read yet.');
    let failure = '';
    const decisions = maxReplans + 1;
    for (let index = 0; index < decisions; index++) {
      if (!running) return state();
      const elements = engine.state?.().elements || [];
      const verdict = await decide({ frame, elements, failure });
      if (verdict.done) return markGoal(verdict.why || 'the model marked the goal reached');
      if (!verdict.action) {
        replans += 1;
        failure = 'Your last answer had no usable action. Answer with exactly one action from the list.';
        emit('replan', { reason: failure, step: steps });
        continue;
      }
      const action = place(verdict.action, elements);
      if (!action) {
        replans += 1;
        failure = `The screen does not show anything called “${verdict.action.target}”. Name one of the tracked labels, or give x and y.`;
        emit('replan', { reason: failure, step: steps });
        continue;
      }
      let acted = false;
      let reason = '';
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (!running) return state();
        if (attempt) {
          retries += 1;
          emit('retry', { attempt, action: describeAction(action), reason, step: steps });
          await wait(retryDelayMs);
        }
        const before = clock();
        try {
          await perform(action);
          acted = true;
          reason = '';
          emit('action', { action: describeAction(action), why: action.why || '', ms: clock() - before, step: steps });
          break;
        } catch (err) {
          reason = String(err?.message || err).slice(0, 240);
          lastError = reason;
          errors += 1;
        }
      }
      lastAction = describeAction(action);
      if (!acted) {
        replans += 1;
        failure = `${describeAction(action)} failed: ${reason}. Pick a different way to make progress.`;
        emit('replan', { reason: failure, step: steps });
        continue;
      }
      if (WAITING.has(action.type)) {
        history.unshift({ at: new Date(clock()).toISOString(), action: describeAction(action), changed: null, why: action.why || '' });
        history.length = Math.min(history.length, 40);
        return { ok: true };
      }
      await wait(settleMs);
      // What the stream had when the action finished: only a frame stored after
      // this one can be evidence about the action, so the check below asks for a
      // capture of its own instead of reading this one back.
      const sinceSeq = Number(engine.state?.().current?.seq) || Number(frame?.seq) || 0;
      let check = { frame: null, changed: null, fresh: false };
      try {
        check = await verify({ sinceSeq });
      } catch (err) {
        lastError = String(err?.message || err).slice(0, 240);
        errors += 1;
      }
      const changed = check.changed;
      history.unshift({
        at: new Date(clock()).toISOString(),
        action: describeAction(action),
        changed,
        why: action.why || '',
        ...(changed === false && reason ? { reason } : {}),
      });
      history.length = Math.min(history.length, 40);
      if (check.frame?.seq) frame = check.frame;
      if (changed === true) return { ok: true };
      if (changed === null) {
        // No capture of its own arrived, so there is no verdict on the action.
        // Neither a panic nor a repeat: carry on from the newest frame.
        return { ok: true };
      }
      // The action ran and nothing moved: that is the one result a live loop
      // must never accept as success. Ask again with the fact.
      replans += 1;
      failure = `The screen did not change after ${describeAction(action)}. It probably missed its target; choose a different route.`;
      emit('replan', { reason: failure, step: steps });
    }
    return finish(`no progress after ${decisions} decision(s); the last attempt was ${lastAction || 'none'}`);
  }

  async function runLoop() {
    while (running) {
      if (steps >= limitSteps) return finish(`the step limit (${limitSteps}) was reached`);
      if (clock() - startedAt >= limitMs) return finish(`the time limit (${Math.round(limitMs / 1000)} s) was reached`);
      busy = true;
      startPulse();
      try {
        const outcome = await turn();
        if (outcome?.running === false || !running) return outcome;
      } catch (err) {
        lastError = String(err?.message || err).slice(0, 300);
        errors += 1;
        emit('error', { error: lastError, step: steps });
        if (errors >= maxErrors || err?.unreadable) return finish(lastError);
        await wait(retryDelayMs * 2);
      } finally {
        busy = false;
        stopPulse();
      }
      steps += 1;
    }
    return state();
  }

  function start(options = {}) {
    if (running) return state();
    const wanted = textOf(options.goal ?? goal, 500);
    if (!wanted) throw new Error('Live control needs a goal to work towards.');
    goal = wanted;
    limitSteps = Math.max(1, Math.min(200, Number(options.maxSteps) || maxSteps));
    limitMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(options.maxMs) || maxMs));
    startedAt = clock();
    finishedAt = null;
    stopReason = null;
    steps = 0;
    retries = 0;
    replans = 0;
    errors = 0;
    pulses = 0;
    lastError = '';
    lastAction = null;
    history.length = 0;
    running = true;
    try {
      engine.setGoal?.(goal);
    } catch {
      // The goal lives on the controller too; the engine's copy is for the stream.
    }
    emit('start', { goal, limits: { maxSteps: limitSteps, maxMs: limitMs } });
    try {
      log('vision', `Live control started for “${goal}” (session ${sessionId})`);
    } catch {
      // See finish().
    }
    loop = runLoop().catch((err) => finish(String(err?.message || err)));
    return state();
  }

  function stop(reason = 'stopped by the operator') {
    if (!running) return state();
    return finish(reason);
  }

  function reset() {
    if (running) throw new Error('Stop live control before resetting it.');
    goal = '';
    startedAt = null;
    finishedAt = null;
    stopReason = null;
    steps = 0;
    retries = 0;
    replans = 0;
    errors = 0;
    lastError = '';
    lastAction = null;
    history.length = 0;
    return state();
  }

  return { start, stop, reset, state, turn, look };
}

export const visionControl = createVisionController({
  engine: vision,
  sessionId: 'main',
  readReview: () => visionReview.state()?.lastReview,
  publish: (type, data) => {
    try {
      visionBus.publish(type, data);
    } catch {
      // No viewers is the normal case.
    }
  },
});
