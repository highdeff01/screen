/**
 * Operator nudges — noticing when the person at the desk tries to tell the
 * console to keep going, by mouse action or typing.
 *
 * The console already reads real input signals for its presence guard
 * (GetLastInputInfo: milliseconds since the last key or mouse event). The
 * nudge watcher polls the same signal between steps and interprets fresh,
 * deliberate input while the console is waiting:
 *
 *   operator-paused run    the input is a continue signal — the run resumes
 *   presence-held run      the input is noticed and counted; two nudges in a
 *                          row surface the "Run now anyway" escape hatch,
 *                          but a hold is never broken automatically (the
 *                          hold exists to protect the operator's own work)
 *   awaiting-review run    the nudge is counted on the run card; two nudges
 *                          draft a suggestion to re-plan & retry instead of
 *                          silently retrying anything
 *
 * Pure pointer drift without any action is still input to GetLastInputInfo;
 * the watcher requires input fresher than the last poll to count, and
 * debounces each run so continuous typing cannot spam the log.
 */
import { db, persist, now, logActivity } from './store.js';
import { readPresence } from './automation.js';
import { IS_WINDOWS } from './platform.js';
import { addSuggestion } from './planner.js';

const POLL_MS = 2500;
const FRESH_MS = 2500; // input happened within the last poll window
const DEBOUNCE_MS = 12000;
const REVIEW_WINDOW_MS = 15 * 60 * 1000;
const WATCH_LIMIT = 5;

let timer = null;
let lastIdleMs = null;
let lastNudgeAt = 0;
let readInput = readPresence; // tests inject a fake input signal
let debounceMs = DEBOUNCE_MS;
// The step a running run is thinking through right now, with its live re-read.
const activeSteps = new Map();

export function nudgeStatus() {
  return { watching: Boolean(timer), platform: IS_WINDOWS ? 'windows' : 'other' };
}

export function setNudgeSource(fn) {
  readInput = fn;
}

/** Tests fire nudges faster than real typing bursts ever would. */
export function setNudgeOptions({ debounce = null } = {}) {
  if (debounce !== null) debounceMs = Math.max(0, Number(debounce) || 0);
}

/**
 * Register the step a run is working on, so input during the work can ask for a
 * fresh read. The re-read is the thinking loop's own tick: read-only, bounded,
 * and never a command to act.
 */
export function registerActiveStep(runOrId, step, reread) {
  const id = String((runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId) || '');
  if (!id) return false;
  activeSteps.set(id, { step: step || null, reread: typeof reread === 'function' ? reread : null, at: Date.now() });
  return true;
}

export function clearActiveStep(runOrId) {
  const id = String((runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId) || '');
  return activeSteps.delete(id);
}

export function activeStep(runOrId) {
  const id = String((runOrId && typeof runOrId === 'object' ? runOrId.id : runOrId) || '');
  return activeSteps.get(id) || null;
}

export function startNudgeWatch() {
  if (timer || !IS_WINDOWS) return Boolean(timer);
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  if (timer.unref) timer.unref();
  return true;
}

export function stopNudgeWatch() {
  if (timer) clearInterval(timer);
  timer = null;
  return true;
}

/** Runs the console is waiting on, most relevant first. */
function candidateRuns() {
  const d = db();
  const cutoff = Date.now() - REVIEW_WINDOW_MS;
  const recent = (run) => {
    const ended = Date.parse(run.endedAt || run.lastInteractionAt || run.createdAt || '') || 0;
    return ended >= cutoff;
  };
  return (d.runs || [])
    .filter(
      (run) =>
        (run.status === 'running' && (run.paused || run.presence?.holding || activeSteps.has(run.id))) ||
        (['needs_review', 'failed'].includes(run.status) && recent(run))
    )
    .slice(0, WATCH_LIMIT);
}

function freshInput(idleMs) {
  const idle = Math.max(0, Number(idleMs) || 0);
  if (idle > FRESH_MS) return false;
  // First observation after quietness with input already this fresh counts;
  // afterwards the idle time must drop between polls (new input since then).
  if (lastIdleMs === null) return true;
  return idle < lastIdleMs;
}

async function tick() {
  const candidates = candidateRuns();
  if (!candidates.length) {
    lastIdleMs = null;
    return;
  }
  const presence = await readInput().catch(() => null);
  if (!presence || presence.idleMs == null) return;
  const fresh = freshInput(presence.idleMs);
  lastIdleMs = presence.idleMs;
  if (!fresh) return;
  if (Date.now() - lastNudgeAt < debounceMs) return; // one reaction per burst
  lastNudgeAt = Date.now();
  for (const run of candidates) {
    applyNudge(run, presence);
  }
}

export const __tick = tick;

function applyNudge(run, presence) {
  const at = now();
  // An operator-paused run: fresh deliberate input means "go on".
  if (run.status === 'running' && run.paused && run.pauseRequested) {
    run.pauseRequested = false;
    run.paused = false;
    pushNudgeLog(run, `Operator input noticed while paused (typing or mouse) — read as a continue signal; the run resumes.`);
    return;
  }
  // A presence hold protects the operator's own work: never broken by a nudge,
  // but repeated nudges surface the explicit escape hatch.
  if (run.status === 'running' && run.presence?.holding) {
    run.nudges = (run.nudges || 0) + 1;
    run.lastNudgeAt = at;
    pushNudgeLog(run, `Operator input noticed while the run is holding (input ${Math.round((presence.idleMs || 0) / 100) / 10}s ago). The hold stays until the desktop settles or you press “Run now anyway”.`);
    if (run.nudges >= 2 && !run.nudgeHinted) {
      run.nudgeHinted = true;
      pushNudgeLog(run, 'Two nudges while holding — if the run should take focus regardless, press “Run now anyway”.');
    }
    return;
  }
  // A run that is working, not waiting: fresh input asks it to read the screen
  // again now instead of at the next tick. Input is a request to look, never
  // permission to take focus and never an interruption of the action.
  if (run.status === 'running' && !run.paused && !run.presence?.holding) {
    const entry = activeSteps.get(run.id);
    if (!entry?.reread) return;
    // The run's own clicks and keystrokes are input too. Input that landed at or
    // just after this run's last action is its own, not the operator asking.
    const inputAt = Date.now() - Number(presence.idleMs || 0);
    const ourInput =
      run.lastActionAt && inputAt >= Number(run.lastActionAt) - 3000 && inputAt <= Number(run.lastActionAt) + 5000;
    if (ourInput) return;
    run.inputReviews = (Number(run.inputReviews) || 0) + 1;
    pushNudgeLog(
      run,
      `Operator input noticed while “${entry.step?.name || 'a step'}” runs — re-reading the screen now (re-read ${run.inputReviews}).`
    );
    try {
      void entry.reread({ reason: 'operator input', idleMs: presence.idleMs });
    } catch { /* a re-read never breaks the run */ }
    return;
  }
  // Failed or needs-review: count interest, never auto-retry.
  run.nudges = (run.nudges || 0) + 1;
  run.lastNudgeAt = at;
  pushNudgeLog(run, `Operator input noticed while this run waits for review (nudge ${run.nudges}).`);
  if (run.nudges >= 2 && !run.nudgeSuggested) {
    run.nudgeSuggested = true;
    try {
      addSuggestion(
        `The operator nudged this run ${run.nudges} times while it waited for review. Consider “Re-plan & retry” — or dismiss the run if the outcome is acceptable.`,
        'nudge',
        run.workflowId,
        run.id
      );
    } catch { /* suggestions are additive */ }
  }
}

function pushNudgeLog(run, message) {
  run.log = run.log || [];
  run.log.push({ at: now(), level: 'info', message, stepId: null });
  if (run.log.length > 400) run.log.splice(0, run.log.length - 400);
  persist();
  logActivity('nudge', `${run.workflowName}: ${message}`, { runId: run.id });
}
