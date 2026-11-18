/**
 * The verification review loop.
 *
 * A step whose silent checks are still open is not finished, and re-checking it
 * once is not enough: the window may open late, an app may be slow to write, or
 * the screen may drift from what the step acted on. This loop runs on a timer,
 * re-checks what a run still owes, and escalates only as far as the evidence
 * justifies:
 *
 *   1. re-run the read-only checks (cheap, every pass)
 *   2. compare a fresh screen signature with the one taken when the step passed
 *      (drift) — the screenshot path the run already uses, no new capture stack
 *   3. look up learned habits for the same app/goal and offer them as workarounds
 *   4. declare a stall and record a strategy suggestion for review
 *
 * It never types, clicks or replans on its own. Everything it decides is written
 * to the run (`verificationReview`) so the console and the operator can see the
 * attempt count, the drift, and the suggestions, and the run's own repair and
 * retry paths stay the only things that touch the desktop.
 */
import { db, persist, now } from './store.js';
import { verifyRunSilently } from './engine.js';
import { readPresence } from './automation.js';
import { recallWorkflowMemory } from './workflow-memory.js';

export const REVIEW_DEFAULTS = {
  intervalMs: 5000,
  // Silent passes before the screen is consulted at all.
  silentAttempts: 2,
  // The first review records a screen baseline; comparisons start here.
  driftAfterAttempts: 2,
  // From here a learned habit may be offered as a workaround.
  habitAfterAttempts: 4,
  // From here the check counts as stalled and needs a human or a replan.
  stallAfterAttempts: 6,
  // A live step running this long is blocked even if it never errored.
  stallStepMs: 5 * 60 * 1000,
  // Reads that need the screen wait until the desk is quiet this long.
  quietMs: 2500,
  // Only runs that ended recently are worth re-reading. Older queued checks are
  // history: they are marked stale instead of being polled forever.
  reviewWithinMs: 30 * 60 * 1000,
  // Hard cap per pass, so a long history can never turn one tick into a storm
  // of PowerShell and screenshot calls.
  maxRunsPerPass: 4,
  // Each further review of the same run waits longer: a check that has been
  // open for minutes does not become likelier by being read every 5 seconds.
  backoffMs: [5000, 15000, 30000, 60000, 120000, 300000],
  // Only these outcomes still owe an answer; failed and cancelled runs keep
  // their queued checks as history rather than being polled forever.
  reviewStatuses: ['passed', 'needs_review'],
  maxReviews: 20,
};

const state = {
  timer: null,
  intervalMs: REVIEW_DEFAULTS.intervalMs,
  busy: false,
  lastRunAt: null,
  lastSummary: null,
  passes: 0,
  errors: [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ladder(overrides = {}) {
  return { ...REVIEW_DEFAULTS, ...overrides };
}

function pushReview(run, entry, max = REVIEW_DEFAULTS.maxReviews) {
  if (!Array.isArray(run.verificationReview)) run.verificationReview = [];
  run.verificationReview.push({ at: now(), ...entry });
  if (run.verificationReview.length > max) {
    run.verificationReview = run.verificationReview.slice(-max);
  }
}

function targetFor(run) {
  for (const entry of run.pendingVerification || []) {
    const step = (run.steps || []).find((candidate) => candidate.id === entry.stepId);
    const value = String(entry.target || step?.params?.title || step?.params?.target || '').trim();
    if (value) return value;
  }
  return '';
}

function checkNames(run) {
  const names = new Set();
  for (const entry of run.pendingVerification || []) {
    for (const check of entry.checks || []) names.add(check);
  }
  return [...names];
}

/**
 * One review pass for one run. Returns the entry that was recorded, so a manual
 * pass and a timed pass describe themselves the same way.
 */
export async function reviewRun(run, deps = {}, options = {}) {
  const policy = ladder(deps.policy);
  const verify = deps.verify || verifyRunSilently;
  const presence = deps.presence || readPresence;
  const habits = deps.habits || recallWorkflowMemory;
  const screen = deps.screenSignature || null;
  const clock = deps.clock || Date.now;

  const attempt = (Number(run.verificationAttempts) || 0) + 1;
  run.verificationAttempts = attempt;
  run.verificationLastAttemptAt = now();

  const verified = await verify(run.id);
  const remaining = Number(verified?.remaining) || 0;
  if (!remaining) {
    run.verificationState = 'complete';
    run.verificationStalled = false;
    const entry = { kind: 'settled', attempt, remaining: 0, detail: 'Every queued check answered.' };
    pushReview(run, entry, policy.maxReviews);
    persist();
    return entry;
  }

  // Reading the screen waits until the person at the desk stops typing: their
  // keystrokes change what the check is looking at.
  let presenceState = null;
  try {
    presenceState = await presence();
  } catch {
    presenceState = null;
  }
  const userActive = Number(presenceState?.idleMs || 0) < policy.quietMs;
  // A baseline is recorded on the first review, while the screen still shows
  // what the step just did; comparisons wait for driftAfterAttempts.
  const wantsCompare = attempt >= policy.driftAfterAttempts;

  let drift = null;
  let signature = null;
  if (screen && !userActive) {
    try {
      signature = await screen({ width: 32, height: 18 });
    } catch {
      signature = null;
    }
  }
  if (signature) {
    if (run.verificationSignature && wantsCompare) drift = signature !== run.verificationSignature;
    else if (!run.verificationSignature) drift = null; // this pass is the baseline
    run.verificationSignature = signature;
    run.verificationSignatureAt = now();
  }

  const suggestions = [];
  if (attempt >= policy.habitAfterAttempts) {
    try {
      const memories = habits({
        goal: String(run.workflowGoal || run.workflowName || ''),
        app: targetFor(run),
        limit: 2,
      });
      for (const memory of memories || []) {
        const apps = (memory.apps || []).filter(Boolean).join('/');
        const outcome = String(memory.summary || memory.goal || memory.workflowName || '').slice(0, 160);
        if (!outcome) continue;
        suggestions.push(`Learned ${memory.status || 'run'}${apps ? ` for ${apps}` : ''}: ${outcome}`);
      }
    } catch {
      // A memory lookup failure is not a verification failure.
    }
  }

  const stalled = attempt >= policy.stallAfterAttempts;
  if (stalled) {
    run.verificationStalled = true;
    suggestions.push(
      `Replan or repair “${run.workflowName || run.id}”: ${remaining} check(s) still open after ${attempt} reviews (${checkNames(run).join(', ') || 'unknown checks'}).`
    );
  }

  const backoff = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)];
  run.verificationNextAt = new Date(clock() + backoff).toISOString();

  const entry = {
    kind: stalled ? 'stalled' : 'review',
    attempt,
    nextReviewInMs: backoff,
    remaining,
    checks: checkNames(run),
    drift,
    deferred: userActive ? 'waiting for the desk to be quiet' : null,
    suggestions,
    detail: `Review ${attempt}: ${remaining} check(s) still open${drift === true ? ', and the screen changed since the step passed' : drift === false ? ', screen unchanged' : ''}.`,
  };
  pushReview(run, entry, policy.maxReviews);
  run.verificationState = 'checking';
  persist();
  return entry;
}

/**
 * A run that is running but has not moved a step in `stallStepMs` is blocked:
 * record it once per step so the console can show it without spamming the log.
 */
export function detectBlockedRuns(deps = {}) {
  const policy = ladder(deps.policy);
  const clock = deps.clock || Date.now;
  const found = [];
  for (const run of db().runs || []) {
    if (run.status !== 'running' || run.dryRun) continue;
    const active = (run.steps || []).find((step) => step.status === 'running');
    const startedAt = Date.parse(active?.startedAt || '');
    if (!active || !Number.isFinite(startedAt)) continue;
    const elapsed = clock() - startedAt;
    if (elapsed < policy.stallStepMs) continue;
    const key = `${run.id}:${active.id}`;
    if (run.stepStalled?.key === key) continue;
    run.stepStalled = {
      key,
      stepId: active.id,
      stepName: active.name,
      elapsedMs: elapsed,
      at: now(),
      suggestion: `“${active.name}” has been running for ${Math.round(elapsed / 60000)}m. Consider pausing the run, capturing the screen, or letting the repair pass retry it.`,
    };
    pushReview(
      run,
      { kind: 'blocked', stepId: active.id, detail: run.stepStalled.suggestion, suggestions: [run.stepStalled.suggestion] },
      policy.maxReviews
    );
    found.push({ runId: run.id, step: active.name, elapsedMs: elapsed });
  }
  return found;
}

/**
 * One pass across every run that owes a check. `deps` is injectable so the loop
 * can be tested without a desktop, a model or a real clock.
 */
export async function reviewPendingVerifications(deps = {}, { onlyRunIds = null } = {}) {
  const clock = deps.clock || Date.now;
  const policy = ladder(deps.policy);
  const scope = Array.isArray(onlyRunIds) && onlyRunIds.length ? onlyRunIds : deps.onlyRunIds;
  const wanted = Array.isArray(scope) && scope.length ? new Set(scope.map(String)) : null;
  const pool = (db().runs || []).filter(
    (run) =>
      (run.pendingVerification || []).length &&
      policy.reviewStatuses.includes(run.status) &&
      (!wanted || wanted.has(run.id))
  );

  let staled = 0;
  const fresh = [];
  for (const run of pool) {
    const endedAt = Date.parse(run.endedAt || run.createdAt || '');
    if (Number.isFinite(endedAt) && clock() - endedAt > policy.reviewWithinMs) {
      if (run.verificationState !== 'stale') {
        run.verificationState = 'stale';
        run.staleVerification = {
          at: now(),
          reason: `Queued check left open for over ${Math.round(policy.reviewWithinMs / 60000)}m; not re-read.`,
        };
        staled += 1;
      }
      continue;
    }
    fresh.push(run);
  }
  if (staled) persist();

  // An operator asking for a pass now gets one; the timer respects the backoff.
  const due = deps.ignoreBackoff === true
    ? fresh
    : fresh.filter((run) => {
        const nextAt = Date.parse(run.verificationNextAt || '');
        return !Number.isFinite(nextAt) || clock() >= nextAt;
      });

  // Newest first, and only a handful per pass; the rest wait their turn.
  const runs = due
    .sort((a, b) => String(b.endedAt || b.createdAt || '').localeCompare(String(a.endedAt || a.createdAt || '')))
    .slice(0, policy.maxRunsPerPass);

  // One presence read per pass, not one per run: each read is a PowerShell call.
  let presenceState = null;
  if (runs.length && (deps.presence || true)) {
    try {
      presenceState = await (deps.presence || readPresence)();
    } catch {
      presenceState = null;
    }
  }
  const passDeps = { ...deps, presence: async () => presenceState };

  const summary = { at: now(), reviewed: 0, settled: 0, stalled: 0, blocked: 0, deferred: 0, stale: staled, entries: [] };
  for (const run of runs) {
    try {
      const entry = await reviewRun(run, passDeps);
      summary.reviewed += 1;
      if (entry.kind === 'settled') summary.settled += 1;
      if (entry.kind === 'stalled') summary.stalled += 1;
      if (entry.deferred) summary.deferred += 1;
      summary.entries.push({ runId: run.id, ...entry });
    } catch (err) {
      state.errors = [...state.errors.slice(-4), { at: now(), message: err.message }];
    }
  }
  if (deps.detectBlocked !== false) {
    try {
      const blocked = detectBlockedRuns(deps);
      summary.blocked = blocked.length;
      if (blocked.length) persist();
    } catch (err) {
      state.errors = [...state.errors.slice(-4), { at: now(), message: err.message }];
    }
  }
  state.lastRunAt = now();
  state.lastSummary = summary;
  state.passes += 1;
  return summary;
}

/** Start the timer. Safe to call twice; the second call only updates the period. */
export function startVerificationLoop({ intervalMs = REVIEW_DEFAULTS.intervalMs, deps = {} } = {}) {
  state.intervalMs = Math.max(1000, Number(intervalMs) || REVIEW_DEFAULTS.intervalMs);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.busy) return; // a slow pass must not stack up behind itself
    state.busy = true;
    // A pass that never returns must not stop every later pass: the cap below
    // releases the flag and records the overrun.
    const capMs = Math.max(5000, (Number(deps.passTimeoutMs) || 45000));
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.busy = false;
    };
    const cap = setTimeout(() => {
      state.errors = [...state.errors.slice(-4), { at: now(), message: `Review pass exceeded ${capMs}ms; released for the next tick.` }];
      release();
    }, capMs);
    cap.unref?.();
    reviewPendingVerifications(deps)
      .catch((err) => {
        state.errors = [...state.errors.slice(-4), { at: now(), message: err.message }];
      })
      .finally(() => {
        clearTimeout(cap);
        release();
      });
  }, state.intervalMs);
  state.timer.unref?.();
  return loopStatus();
}

export function stopVerificationLoop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return loopStatus();
}

export function loopStatus() {
  return {
    running: Boolean(state.timer),
    intervalMs: state.intervalMs,
    busy: state.busy,
    passes: state.passes,
    lastRunAt: state.lastRunAt,
    errors: state.errors.slice(-4),
    lastSummary: state.lastSummary
      ? {
          reviewed: state.lastSummary.reviewed,
          settled: state.lastSummary.settled,
          stalled: state.lastSummary.stalled,
          blocked: state.lastSummary.blocked,
          deferred: state.lastSummary.deferred,
          stale: state.lastSummary.stale,
        }
      : null,
    restingFor: state.lastRunAt
      ? Math.max(0, state.intervalMs - (Date.now() - Date.parse(state.lastRunAt)))
      : 0,
  };
}

/** Wait used by tests and by the manual review route's callers. */
export { sleep };
