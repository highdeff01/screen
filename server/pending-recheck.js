/**
 * Pending recheck: keep what already worked.
 *
 * A restart, a retry or a replan used to throw away the steps that had already
 * passed, so the next attempt opened a second Notepad and typed the same text
 * again. Two things live here:
 *
 *  - `carryCompletedSteps` feeds a new attempt with the passed steps already
 *    settled. Matching is exact (type + params), so a step whose action changed
 *    still runs; only a step whose effect already happened is passed through.
 *  - `recheckCandidates` / `runPendingRecheck` re-read the steps that failed or
 *    sat pending too long. Each attempt takes a fresh screenshot and asks a
 *    read-only check whether the state is now there (retry timing and a prep
 *    allowance before the first read are configurable). A step that can only be
 *    settled by running it is left for the retry instead of being marked passed
 *    from a screenshot alone.
 *
 * The functions are pure or dependency-injected so the policy can be tested
 * without a desktop.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  continueAfter: false,
  retryFailed: true,
  maxAttempts: 3,
  intervalMs: 3000,
  prepMs: 4000,
  maxPendingMs: 45000,
  maxTasks: 3,
});

// Steps whose finish line can be observed without acting: a wait, an
// expectation, a playback/end check. A failed type/click is never passed from a
// screenshot; it has to run again.
const OBSERVABLE_TYPES = new Set(['waitFor', 'expect', 'silentCheck', 'verifyScreen', 'verifyPlayback', 'mediaHold', 'check']);

// Failures that are worth re-reading; a refused input or a wrong destination is
// an intent problem, not a timing one.
const TRANSIENT_ERROR =
  /timed out|timeout|not found|no window|not present|not in the foreground|would not bring|window.*closed|no process|interrupted|restart|temporar|busy|still (?:starting|loading)|nothing on screen changed/i;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clip(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** Settings are clamped here too, so a hand-written request cannot lift them. */
export function normalizeRecheckSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled !== false,
    continueAfter: source.continueAfter === true,
    retryFailed: source.retryFailed !== false,
    maxAttempts: clampInt(source.maxAttempts, 1, 10, DEFAULTS.maxAttempts),
    intervalMs: clampInt(source.intervalMs, 250, 60000, DEFAULTS.intervalMs),
    prepMs: clampInt(source.prepMs, 0, 60000, DEFAULTS.prepMs),
    maxPendingMs: clampInt(source.maxPendingMs, 1000, 600000, DEFAULTS.maxPendingMs),
    maxTasks: clampInt(source.maxTasks, 1, 20, DEFAULTS.maxTasks),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The effect a step has: same type and params means the same thing happened. */
export function stepSignature(step) {
  return stableValue([step?.type ?? null, step?.params ?? null]);
}

/**
 * Mark the next attempt's steps that already passed in the previous attempt.
 * Returns the same steps with `status: 'passed'` and a `carriedFrom` note, plus
 * a small list for the run header. A failed, skipped or changed step is kept.
 */
export function carryCompletedSteps(previousSteps, nextSteps, { runId = '', at = new Date().toISOString() } = {}) {
  const done = (Array.isArray(previousSteps) ? previousSteps : []).filter((step) => step?.status === 'passed');
  const used = new Set();
  const steps = (Array.isArray(nextSteps) ? nextSteps : []).map((step) => {
    if (!step) return step;
    const signature = stepSignature(step);
    const index = done.findIndex((previous, position) => !used.has(position) && stepSignature(previous) === signature);
    if (index < 0) return step;
    used.add(index);
    const previous = done[index];
    return {
      ...step,
      status: 'passed',
      attempts: Math.max(1, Number(previous.attempts || 1)),
      startedAt: previous.startedAt || null,
      endedAt: previous.endedAt || at,
      ms: previous.ms ?? null,
      output: String(previous.output || 'Already completed in the previous attempt.'),
      evidenceIds: [],
      error: null,
      completion: previous.completion || { status: 'verified', pending: [], reason: '' },
      carriedFrom: {
        runId: runId || previous.runId || null,
        stepId: previous.id || null,
        name: previous.name || step.name || step.type,
        at,
      },
    };
  });
  const carried = steps
    .filter((step) => step?.carriedFrom)
    .map((step) => ({
      id: step.id,
      name: step.name,
      type: step.type,
      fromStepId: step.carriedFrom.stepId,
      fromRunId: step.carriedFrom.runId,
    }));
  return { steps, carried };
}

/**
 * Steps worth re-reading: still-open silent checks, steps stuck pending past
 * the allowance, and failures with a timing-shaped error. `passable` says the
 * step's finish line can be observed read-only; the rest need the retry.
 */
export function recheckCandidates(run, settings = {}, { nowMs = Date.now() } = {}) {
  const cfg = normalizeRecheckSettings(settings);
  const candidates = [];
  const seen = new Set();
  const add = (entry) => {
    if (!entry?.stepId || seen.has(entry.stepId)) return;
    seen.add(entry.stepId);
    candidates.push(entry);
  };

  for (const entry of run?.pendingVerification || []) {
    const checks = Array.isArray(entry.checks) && entry.checks.length ? entry.checks : ['window'];
    add({
      stepId: entry.stepId,
      name: entry.stepName || 'Pending check',
      type: entry.type || '',
      reason: `still waiting on ${checks.join(', ')}`,
      passable: true,
      checks,
      target: String(entry.target || ''),
    });
  }

  for (const step of run?.steps || []) {
    if (!step?.id) continue;
    if (step.status === 'pending' || step.status === 'running') {
      const reference = step.startedAt
        ? Date.parse(step.startedAt)
        : Date.parse(run?.endedAt || run?.startedAt || run?.createdAt || 0);
      const waited = Number.isFinite(reference) ? Math.max(0, nowMs - reference) : cfg.maxPendingMs;
      if (waited >= cfg.maxPendingMs) {
        add({
          stepId: step.id,
          name: step.name,
          type: step.type,
          reason: `pending ${Math.round(waited / 1000)}s (allowance ${Math.round(cfg.maxPendingMs / 1000)}s)`,
          passable: false,
          checks: [],
          target: String(step.params?.value || step.params?.title || step.params?.foreground || ''),
        });
      }
      continue;
    }
    if (step.status !== 'failed' || !cfg.retryFailed) continue;
    if (!TRANSIENT_ERROR.test(String(step.error || ''))) continue;
    add({
      stepId: step.id,
      name: step.name,
      type: step.type,
      reason: `failed: ${clip(step.error)}`,
      passable: OBSERVABLE_TYPES.has(String(step.type || '')),
      checks: OBSERVABLE_TYPES.has(String(step.type || '')) ? ['window'] : [],
      target: String(
        step.params?.value || step.params?.title || step.params?.foreground || step.params?.windowName || step.params?.process || ''
      ),
    });
  }
  return candidates.slice(0, 20);
}

/**
 * Recheck the candidates with a bounded loop: optional prep wait, then up to
 * `maxAttempts` reads spaced by `intervalMs` (linear backoff). A fresh screenshot
 * is kept as evidence for every attempt. Unresolved steps become task
 * assignments instead of silently disappearing.
 *
 * deps: { capture(candidate, attempt) -> {path,width,height} | null,
 *         verify(candidate, attempt, shot) -> {ok, detail},
 *         sleep(ms), now() -> ISO, uid(prefix) }
 */
export async function runPendingRecheck(run, settings = {}, deps = {}) {
  const cfg = normalizeRecheckSettings(settings);
  const nowFn = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const uid =
    typeof deps.uid === 'function'
      ? deps.uid
      : (prefix = 'rchk') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const candidates = recheckCandidates(run, cfg, { nowMs: deps.nowMs || Date.now() });
  const summary = {
    status: candidates.length ? 'checking' : 'nothing_to_recheck',
    startedAt: nowFn(),
    endedAt: null,
    prepMs: cfg.prepMs,
    attempts: 0,
    checked: candidates.length,
    resolved: [],
    unresolved: [],
    needsRun: [],
    evidence: [],
    tasks: [],
    notes: [],
  };
  if (!candidates.length) {
    summary.endedAt = nowFn();
    return summary;
  }

  if (cfg.prepMs > 0) {
    summary.notes.push(`Prep allowance: waited ${cfg.prepMs}ms before the first read.`);
    await sleep(cfg.prepMs);
  }

  for (const candidate of candidates) {
    if (!candidate.passable) {
      summary.needsRun.push({
        stepId: candidate.stepId,
        name: candidate.name,
        type: candidate.type,
        reason: candidate.reason,
      });
      continue;
    }
    let verdict = null;
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        const wait = cfg.intervalMs * (attempt - 1);
        summary.notes.push(`Retry timing: waited ${wait}ms before attempt ${attempt} of ${candidate.name}.`);
        await sleep(wait);
      }
      summary.attempts += 1;
      let shot = null;
      if (typeof deps.capture === 'function') {
        try {
          shot = await deps.capture(candidate, attempt);
        } catch (err) {
          summary.notes.push(`Screenshot ${attempt} failed: ${err.message}`);
        }
      }
      if (shot?.path) {
        const evidence = {
          id: uid('evd'),
          kind: 'screenshot',
          caption: `Recheck ${attempt} · ${candidate.name}`,
          path: shot.path,
          simulated: Boolean(shot.simulated),
          width: shot.width || null,
          height: shot.height || null,
          stepId: candidate.stepId,
          createdAt: nowFn(),
        };
        run.evidence = [...(run.evidence || []), evidence];
        summary.evidence.push(evidence);
      }
      try {
        verdict = typeof deps.verify === 'function'
          ? await deps.verify(candidate, attempt, shot)
          : { ok: false, detail: 'No read-only check is installed.' };
      } catch (err) {
        verdict = { ok: false, detail: err.message };
      }
      if (verdict?.ok) break;
    }

    const step = (run.steps || []).find((entry) => entry.id === candidate.stepId) || null;
    if (verdict?.ok) {
      if (step) {
        step.status = 'passed';
        step.error = null;
        step.endedAt = nowFn();
        step.output = `Recheck passed on attempt ${summary.attempts}: ${verdict.detail || 'state confirmed'}`;
        step.rechecked = {
          at: nowFn(),
          attempt: summary.attempts,
          detail: String(verdict.detail || ''),
          evidenceId: summary.evidence[summary.evidence.length - 1]?.id || null,
        };
      }
      run.pendingVerification = (run.pendingVerification || []).filter((entry) => entry.stepId !== candidate.stepId);
      summary.resolved.push({
        stepId: candidate.stepId,
        name: candidate.name,
        type: candidate.type,
        detail: String(verdict.detail || ''),
      });
    } else {
      const task = {
        id: uid('task'),
        kind: 'recheck',
        stepId: candidate.stepId,
        name: candidate.name,
        type: candidate.type,
        reason: String(verdict?.detail || candidate.reason),
        status: 'open',
        assignedTo: 'operator',
        createdAt: nowFn(),
      };
      if (summary.tasks.length < cfg.maxTasks) summary.tasks.push(task);
      summary.unresolved.push({
        stepId: candidate.stepId,
        name: candidate.name,
        type: candidate.type,
        reason: task.reason,
      });
    }
  }

  if (summary.tasks.length) {
    const open = (run.recheckTasks || []).filter((task) => task?.status === 'open' && !summary.tasks.some((next) => next.id === task.id));
    run.recheckTasks = [...open, ...summary.tasks].slice(-20);
  }
  summary.status = summary.unresolved.length
    ? 'needs_attention'
    : summary.needsRun.length
      ? 'needs_rerun'
      : 'resolved';
  summary.endedAt = nowFn();
  return summary;
}

/**
 * A run left `running`/`queued` by a restart is not still running: nothing in
 * this process owns it. Keep its completed steps, reopen the step that was in
 * flight, and hand it to review instead of erasing the attempt.
 */
export function markRunInterrupted(run, { at = new Date().toISOString(), reason = 'the console restarted while this run was open' } = {}) {
  if (!run || !['running', 'queued'].includes(run.status)) return false;
  run.interruptedFrom = run.status;
  run.interruptedAt = at;
  run.status = 'needs_review';
  run.endedAt = at;
  const startedAt = Date.parse(run.startedAt || run.createdAt || 0);
  if (Number.isFinite(startedAt)) run.durationMs = Math.max(0, Date.parse(at) - startedAt);
  for (const step of run.steps || []) {
    if (step.status !== 'running') continue;
    step.status = 'failed';
    step.endedAt = at;
    step.error = `Interrupted: ${reason}.`;
  }
  return true;
}
