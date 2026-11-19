/**
 * Deep focus — after a run ends, the app looks again, live, and thinks.
 *
 * One focus round reads the real desktop state (which window is in front, what
 * element holds the caret, whether work is unsaved, whether the target is
 * minimized, how many windows the app has) and decides what to do next:
 * keep watching, retry the failed step, ask the model to reshape the remaining
 * steps, or conclude. Several rounds in a row are the "higher plan": the run is
 * re-thought from a wider vantage point instead of a single screenshot, and the
 * result is a reshaped step plan with a visible diff against what ran.
 *
 * Safeguards are part of the loop, not an afterthought:
 *   - before reshaped steps are applied, a project snapshot is taken
 *     automatically (the gate) so any apply can be rolled back
 *   - nothing is typed or clicked during a focus round; rounds are read-only.
 *     Acting happens later, through the normal run path with all its guards
 *   - unsaved user work is detected and reported, never overwritten
 *
 * Conclusions and lessons are remembered (agent lessons), so the next similar
 * run starts smarter. Everything that touches the desktop or the model is
 * injectable, so the decisions are testable without either.
 */
import { db, logActivity, now, persist, uid } from './store.js';
import { sendContinuation } from './agent-awareness.js';
import { addNote } from './handoff.js';

const MAX_ROUNDS = 12;

export function deepFocusSettings() {
  const s = db().settings.deepFocus || (db().settings.deepFocus = {});
  if (s.enabled === undefined) s.enabled = true;
  if (!Number(s.rounds)) s.rounds = 5;
  if (!Number(s.roundDelayMs)) s.roundDelayMs = 4000;
  if (s.autoApply === undefined) s.autoApply = false;
  return s;
}

/** The live readers; the composition root injects real desktop readers. */
const readers = {
  readForeground: null,
  readFocused: null,
  listWindows: null,
  chat: null,
  snapshot: null,
  applyAndRetry: null,
};

export function configureDeepFocus(overrides = {}) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) readers[key] = value;
  }
}

function findRun(id) {
  const run = db().runs.find((entry) => entry.id === id);
  if (!run) throw new Error('Run not found');
  return run;
}

export function deepFocusStatus(runId) {
  const run = findRun(runId);
  return run.deepFocus || null;
}

function ensure(run, rounds) {
  if (!run.deepFocus || run.deepFocus.finishedAt) {
    run.deepFocus = {
      id: uid('focus'),
      startedAt: now(),
      reason: '',
      requested: Math.max(1, Math.min(MAX_ROUNDS, Math.floor(Number(rounds) || deepFocusSettings().rounds))),
      baseline: (run.steps || []).map((step) => ({ type: step.type, name: step.name, ...{ ...(step.params || {}) } })),
      rounds: [],
      reflexes: {},
      reshaped: null,
      conclusion: '',
      lessons: [],
      stopped: false,
    };
  }
  return run.deepFocus;
}

/* ---------------- reflex checks (read-only) ---------------- */

const UNSAVED = /^[*•]\s|— \*|\*[^*]* - /;

/**
 * The reflex battery: cheap, read-only checks that catch the ways a run can be
 * wrong even when every step "passed".
 */
export function reflexChecks({ foreground = null, focused = null, windows = null, guard = '' } = {}) {
  const reflexes = {};
  const fgTitle = String(foreground?.title || '');
  const fgProcess = String(foreground?.process || '');
  reflexes.windowFocus = {
    ok: !foreground || (!fgTitle && !fgProcess) || !guard ? null : norm(fgTitle).includes(norm(guard)) || norm(fgProcess).includes(norm(guard)),
    foreground: fgTitle,
    guard,
  };
  reflexes.typingFlow = {
    // Only a genuinely editable caret counts; a control that merely looks like
    // a text field is exactly how text ended up in the wrong place.
    ok: typeof focused?.editable === 'boolean' ? focused.editable : null,
    focusedName: focused?.name || null,
    controlType: focused?.controlType || null,
  };
  reflexes.saveCheck = {
    ok: fgTitle ? !UNSAVED.test(fgTitle) : null,
    note: UNSAVED.test(fgTitle) ? 'the front window shows unsaved changes; save the operator’s work before any step that could close it' : '',
  };
  reflexes.minimizeCheck = {
    ok: typeof foreground?.minimized === 'boolean' ? !foreground.minimized : foreground?.state && foreground.state !== 'unknown' ? foreground.state !== 'minimized' : null,
    note: foreground?.minimized || foreground?.state === 'minimized' ? 'the target window is minimized; restore it before pointer steps' : '',
  };
  reflexes.tabCheck = { count: Array.isArray(windows) ? windows.length : null };
  return reflexes;
}

const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Gather real desktop state for a round. Injected readers keep it testable. */
async function observe(guard, deps = {}) {
  const out = { foreground: null, focused: null, windows: null, availability: {} };
  for (const [field, reader] of [['foreground', 'readForeground'], ['focused', 'readFocused'], ['windows', 'listWindows']]) {
    const read = deps[reader] || readers[reader];
    if (!read) {
      out.availability[field] = 'unavailable';
      continue;
    }
    try {
      const value = await read();
      if (value?.error) {
        out.availability[field] = `failed: ${String(value.error).slice(0, 200)}`;
      } else if (value == null || (field === 'windows' ? !Array.isArray(value) : typeof value !== 'object' || Array.isArray(value)) ||
        (field === 'foreground' && !value.title && !value.process)) {
        out.availability[field] = 'empty or invalid';
      } else {
        out[field] = value;
        out.availability[field] = 'observed';
      }
    } catch (err) {
      out.availability[field] = `failed: ${String(err?.message || err).slice(0, 200)}`;
    }
  }
  out.reflexes = reflexChecks({ ...out, guard });
  return out;
}

/* ---------------- the cycle ---------------- */

const running = new Set();

export function startDeepFocus(runId, { rounds = null, reason = '' } = {}, deps = {}) {
  const run = findRun(runId);
  if (!['failed', 'needs_review', 'cancelled'].includes(run.status)) {
    throw new Error(`Deep focus is for finished runs that need thought — this run is ${run.status}.`);
  }
  if (running.has(runId)) return deepFocusStatus(runId);
  const focus = ensure(run, rounds || deepFocusSettings().rounds);
  focus.reason = reason || focus.reason || run.errorSummary || `${run.status} run`;
  focus.stopped = false;
  focus.finishedAt = null;
  persist();
  running.add(runId);
  cycle(runId, deps).catch((err) => {
    const entry = findRun(runId);
    if (entry?.deepFocus) {
      entry.deepFocus.error = String(err.message || err).slice(0, 300);
      entry.deepFocus.finishedAt = now();
      persist();
    }
  }).finally(() => running.delete(runId));
  logActivity('deep-focus', `Deep focus started on ${run.workflowName} (${focus.requested} rounds)`, { runId });
  return deepFocusStatus(runId);
}

export function stopDeepFocus(runId) {
  const run = findRun(runId);
  if (run.deepFocus) {
    run.deepFocus.stopped = true;
    run.deepFocus.finishedAt = run.deepFocus.finishedAt || now();
    persist();
  }
  return deepFocusStatus(runId);
}

async function cycle(runId, deps = {}) {
  const settings = deepFocusSettings();
  for (let index = 1; index <= MAX_ROUNDS; index += 1) {
    const run = findRun(runId);
    const focus = run.deepFocus;
    if (!focus || focus.stopped) break;
    const failedStep = (run.steps || []).find((step) => step.status === 'failed');
    const guard = String(failedStep?.params?.foreground || run.lastWindow?.title || failedStep?.name || '').trim();
    const state = await observe(guard, deps);
    const round = {
      at: now(),
      index,
      foreground: state.foreground?.title || null,
      process: state.foreground?.process || null,
      caret: state.focused ? `${state.focused.controlType || 'unknown'}${state.focused.name ? ` “${String(state.focused.name).slice(0, 40)}”` : ''}` : null,
      reflexes: state.reflexes,
      observation: state,
      decision: 'observe',
      note: '',
    };
    focus.rounds.push(round);
    Object.assign(focus.reflexes, state.reflexes);

    // Wait for all requested observations before drafting a plan for review.
    if (index === focus.requested && settings.enabled && !focus.stopped) {
      const plan = await rethink(run, focus, deps);
      if (plan && !focus.stopped) {
        focus.reshaped = plan;
        round.decision = 'reshape';
        round.note = `${(plan.steps || []).length} reshaped step(s) drafted from live focus`;
      }
    } else if (index === focus.requested && !settings.enabled) {
      focus.rethinkStatus = 'disabled';
    }

    if (index >= focus.requested) break;
    await sleep(settings.roundDelayMs);
    if (findRun(runId).deepFocus?.stopped) break;
  }
  conclude(runId, deps);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(250, ms)));
}

// Bound each section independently so a large output cannot hide later rounds.
function promptValue(value, limit) {
  const text = JSON.stringify(value ?? null) || 'null';
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

/** The deliberate pass: goal, run history and all observations → a draft. */
async function rethink(run, focus, deps = {}) {
  const ask = deps.chat || readers.chat;
  if (!ask) {
    focus.rethinkStatus = 'model unavailable';
    return null;
  }
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  const mission = (db().missions || []).find((entry) => entry.id === run.missionId);
  const goal = run.workflowGoal || run.goal || mission?.goal || workflow?.description || run.workflowName;
  const steps = run.steps || [];
  const failedIndex = steps.findIndex((step) => step.status === 'failed');
  const start = failedIndex >= 0 ? failedIndex : steps.findIndex((step) => !['passed', 'skipped'].includes(step.status));
  // A goal can be unverified even when every command passed. In that case the
  // whole workflow needs review rather than an empty remainder.
  const remainingStart = start < 0 ? 0 : start;
  const formatStep = (step, index) => `Step ${index + 1}: ${promptValue({ id: step.id, type: step.type, name: step.name, status: step.status, params: step.params, output: step.output, error: step.error }, 1200)}`;
  const history = steps.slice(Math.max(0, remainingStart - 10), remainingStart).map((step, i) => formatStep(step, Math.max(0, remainingStart - 10) + i)).join('\n');
  const remaining = steps.slice(remainingStart, remainingStart + 40).map((step, i) => formatStep(step, remainingStart + i)).join('\n');
  const omitted = Math.max(0, steps.length - remainingStart - 40);
  const observations = focus.rounds.map((round) => {
    const state = round.observation || {};
    return `Round ${round.index}:\nAvailability: ${promptValue(state.availability, 600)}\nForeground: ${promptValue(state.foreground, 800)}\nFocused/caret: ${promptValue(state.focused, 800)}\nWindows: ${promptValue(state.windows, 800)}\nReflexes: ${promptValue(state.reflexes, 1000)}`;
  }).join('\n');
  try {
    const reply = await ask([
      {
        role: 'system',
        content:
          'You are re-planning a screen-automation run from live desktop observations. Reply with JSON only: {"conclusion":"one line","reshaped":[{"type":"focusWindow|type|key|wait|waitFor|expect|screenshot|launchApp|click","name":"...","params":{}}],"retry":true|false}. If a step failed, reshape ONLY that step and the steps after it. If no step failed but the goal is unverified, review the entire workflow and propose a replacement that verifies the goal. Treat missing or failed observations as unknown, not proof. Respect the live focus: if the caret is already in the right place, do not re-launch. Never include steps that delete or overwrite files. The proposal will require review.',
      },
      {
        role: 'user',
        content: `Goal: ${promptValue(goal, 2000)}\nRun error: ${promptValue(run.errorSummary, 1000)}\nPrior steps (most recent 10):\n${history || 'none'}\nRemaining steps (including failed):\n${remaining || 'none'}${omitted ? `\n[${omitted} remaining steps omitted]` : ''}\nObservations:\n${observations || 'none'}`,
      },
    ]);
    if (!reply?.ok) {
      focus.rethinkStatus = 'model request failed';
      return null;
    }
    const text = String(reply.content || '').trim();
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json);
    const proposedSteps = (Array.isArray(parsed.reshaped) ? parsed.reshaped : []).filter((step) => step?.type).slice(0, 12);
    focus.rethinkStatus = 'completed';
    return {
      at: now(),
      conclusion: String(parsed.conclusion || '').slice(0, 300),
      retry: parsed.retry !== false,
      steps: proposedSteps,
    };
  } catch {
    focus.rethinkStatus = 'model request or response failed';
    return null;
  }
}

/** The diff the operator sees: what the higher plan changed and why. */
export function diffPlans(baseline = [], reshaped = []) {
  const key = (step) => `${step.type}:${norm(step.name || '')}`;
  const baseKeys = baseline.map(key);
  const newKeys = reshaped.map(key);
  return {
    kept: reshaped.filter((step, i) => baseKeys[i] === newKeys[i]).length,
    added: reshaped.filter((step) => !baseKeys.includes(key(step))),
    removed: baseline.filter((step) => !newKeys.includes(key(step))),
    changedOrder: baseKeys.join('|') !== newKeys.join('|'),
  };
}

function conclude(runId, deps = {}) {
  const run = findRun(runId);
  const focus = run.deepFocus;
  if (!focus || focus.conclusion) return;
  focus.finishedAt = now();
  const failedStep = (run.steps || []).find((step) => step.status === 'failed');
  const reflexProblems = [...new Set(focus.rounds.flatMap((round) => Object.entries(round.reflexes || {})
    .filter(([, check]) => check.ok === false)
    .map(([name]) => name)))];
  const missing = [...new Set(focus.rounds.flatMap((round) => Object.entries(round.observation?.availability || {})
    .filter(([, status]) => status !== 'observed')
    .map(([name]) => name)))];
  const unknownReflexes = focus.rounds.some((round) => Object.values(round.reflexes || {}).some((check) => 'ok' in check && check.ok == null));
  focus.diff = focus.reshaped ? diffPlans(focus.baseline, focus.reshaped.steps) : null;
  focus.conclusion = [
    focus.reshaped?.conclusion || '',
    focus.reshaped?.steps?.length
      ? `reshaped into ${focus.reshaped.steps.length} step(s) (${focus.diff.added.length} added, ${focus.diff.removed.length} removed); review required`
      : focus.rethinkStatus === 'completed' ? 'model proposed no reshaped steps' : `no model proposal (${focus.rethinkStatus || (focus.stopped ? 'stopped early' : 'not run')})`,
    reflexProblems.length ? `reflex alerts: ${reflexProblems.join(', ')}` : '',
    missing.length ? `observations unavailable or failed: ${missing.join(', ')}` : '',
    unknownReflexes || !focus.rounds.length ? 'some reflexes unknown; not verified' : !reflexProblems.length && !missing.length ? 'observed reflexes clear' : '',
  ].filter(Boolean).join(' — ');
  focus.lessons = [];
  if (failedStep && focus.reshaped?.conclusion) {
    focus.lessons.push({
      goal: run.workflowName,
      step: failedStep.name,
      lesson: focus.reshaped.conclusion.slice(0, 300),
      method: 'deep focus rethink',
    });
  }
  persist();
  // What the loop learned travels: continuation to the working agents, a note
  // for the next run, and the lesson itself for workflow memory.
  try {
    sendContinuation({
      from: 'deep-focus',
      reason: `deep focus finished on ${run.workflowName}`,
      detail: `${focus.conclusion}${focus.reshaped ? '; reshaped steps are waiting for review/apply' : ''}`,
      tags: ['deep-focus'],
    });
    addNote({
      by: 'deep-focus',
      tags: ['deep-focus', 'must-check'],
      text: `${run.workflowName}: ${focus.conclusion}`,
    });
  } catch { /* reporting must not break the loop */ }
  logActivity('deep-focus', `Deep focus concluded on ${run.workflowName}`, { runId });
}

/**
 * The gate: a snapshot of everything as it is right now, then the reshaped
 * steps replace the failed remainder and the run retries. The snapshot is the
 * rollback path; without it nothing is applied.
 */
export async function applyReshaped(runId, deps = {}) {
  const run = findRun(runId);
  const focus = run.deepFocus;
  if (!focus?.reshaped?.steps?.length) throw new Error('No reshaped steps to apply.');
  const snapshot = deps.snapshot || readers.snapshot;
  if (!snapshot) throw new Error('No snapshot path configured; nothing was applied.');
  const made = await snapshot(`before deep-focus apply on ${run.workflowName}`);
  focus.applyGate = { at: now(), snapshot: made?.snapshot?.commit || made?.commit || null, ok: made?.ok === true };
  if (made?.ok !== true) {
    focus.applyGate.blocked = true;
    persist();
    return { ok: false, status: 'gate-blocked', message: `The snapshot gate refused to open (${made?.message || 'snapshot unavailable'}); nothing was applied.` };
  }
  const apply = deps.applyAndRetry || readers.applyAndRetry;
  if (!apply) throw new Error('No apply path configured.');
  const result = await apply(runId, focus.reshaped.steps, focus);
  if (!result?.ok) return result;
  focus.appliedAt = now();
  persist();
  logActivity('deep-focus', `Reshaped steps applied to ${run.workflowName}; run re-queued`, { runId });
  return result;
}

/** Used by the tests to inspect the loop without a run. */
export function isRunning(runId) {
  return running.has(runId);
}
