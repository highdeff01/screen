/**
 * Automatic repair — the checkboxes that turn "waiting for the operator" into
 * "the backend finished it".
 *
 * Four independent behaviours, each opt-in, each recorded on the run:
 *
 *   appendFixes        the closeout's predicted follow-up steps (save, close a
 *                      window the run opened) are written into the workflow as
 *                      soon as the run ends, instead of waiting for the
 *                      "Append to workflow" click.
 *   analyzeIncomplete  when a step failed because nothing was detected — no
 *                      control, no required element, nothing to do — the run is
 *                      analysed and the concrete missing steps are appended to
 *                      the workflow automatically.
 *   applyReshaped      a deep-focus reshaped plan is applied through the
 *                      snapshot gate and the run re-runs without a click.
 *   reorderBeforeStep  the screen is read once, in the run loop, just before a
 *                      pending click runs; when that click's control is not on
 *                      screen and a later click's control is, the later one takes
 *                      its slot. This is a decision inside the step loop, not a
 *                      background timer: a focus→click pair finishes faster than
 *                      one OCR read, so a timer could never win that race.
 *
 * Everything here is best-effort: a failed automatic step is written into the
 * run log and never changes the run's verdict, and nothing types or clicks.
 *
 * Focus level: each retry gets a level from 1 to 5. The level starts at one and
 * climbs with the retry depth, then rises further for the steps that matter more
 * (input steps, a goal that was never proved), so a second attempt at a click is
 * not given the same attention as a first attempt at a note.
 */
import { db, logActivity, now, persist, uid } from './store.js';
import { appendCloseout } from './closeout.js';

const INPUT_STEPS = new Set(['type', 'key', 'clipboard', 'click', 'clickElement', 'dragCopy', 'windowAction']);
const CHECK_STEPS = new Set(['expect', 'waitFor', 'verifyScreen', 'verifyPlayback', 'mediaHold']);

export const AUTO_REPAIR_DEFAULTS = Object.freeze({
  appendFixes: false,
  analyzeIncomplete: false,
  applyReshaped: false,
  monitorMaxReads: 60,
  maxFocusLevel: 5,
});

const clampInt = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};

/** Every key is normalized, so a hand-written request cannot lift a bound. */
export function normalizeAutoRepair(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    appendFixes: source.appendFixes === true,
    analyzeIncomplete: source.analyzeIncomplete === true,
    applyReshaped: source.applyReshaped === true,
    monitorMaxReads: clampInt(source.monitorMaxReads, 1, 200, AUTO_REPAIR_DEFAULTS.monitorMaxReads),
    maxFocusLevel: clampInt(source.maxFocusLevel, 1, 5, AUTO_REPAIR_DEFAULTS.maxFocusLevel),
  };
}

export function autoRepairSettings() {
  const settings = db().settings;
  settings.autoRepair = normalizeAutoRepair({ ...AUTO_REPAIR_DEFAULTS, ...(settings.autoRepair || {}) });
  return settings.autoRepair;
}

/* ----------------------------- focus level ------------------------------ */

/**
 * How much attention this retry deserves. Depth is the retry number; importance
 * is how much the step can break when it is wrong.
 */
export function focusLevelFor({ run = null, importance = 0, max = null } = {}) {
  const ceiling = clampInt(max ?? autoRepairSettings().maxFocusLevel, 1, 5, 5);
  const depth = Math.max(0, Number(run?.retryDepth || 0));
  const weight = Math.max(0, Math.min(2, Number(importance) || 0));
  return Math.min(ceiling, 1 + depth + weight);
}

/**
 * 2 = a step that sends input or carries an unproved goal, 1 = a check that
 * decides whether the goal is met, 0 = everything else.
 */
export function importanceOf(step = null, run = null) {
  if (!step) return run?.goalUnverified || run?.presenter?.summary?.goalMet === false ? 2 : 0;
  if (INPUT_STEPS.has(step.type)) return 2;
  if (run?.goalUnverified || run?.presenter?.summary?.goalMet === false) return 2;
  if (CHECK_STEPS.has(step.type)) return 1;
  if (run?.screenReviewUnresolved) return 1;
  return 0;
}

/* -------------------------- incomplete steps ---------------------------- */

const DETECTION_FAILURE =
  /(not (found|visible|detected|present|reachable)|could ?n[o']?t (find|detect|read|locate|see|resolve)|did not (find|detect|appear|show)|no (matching|such|visible|usable) (element|control|field|label|window|button|target)|unable to (find|locate|read|resolve)|unknown (element|control|target|screen)|missing (element|control|field|label|target)|nothing to (do|act on))/i;

/**
 * Steps the run could not act on: nothing was detected, the required element was
 * never there, or the step was left open. These are the steps an AI pass can
 * supply concrete commands for.
 */
export function incompleteStepEntries(run = {}) {
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    const key = entry.id || `${entry.type}:${entry.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  for (const step of run.steps || []) {
    const text = `${step.error || ''} ${step.output || ''} ${step.unverified ? String(step.unverified) : ''}`;
    const open = !['passed', 'skipped'].includes(step.status || '');
    const failed = step.status === 'failed' || step.status === 'stalled';
    if (failed && DETECTION_FAILURE.test(text)) {
      add({ id: step.id, name: step.name, type: step.type, reason: String(step.error || step.output || 'nothing was detected').slice(0, 240) });
    } else if (open && (step.needsElement || step.undetected)) {
      add({ id: step.id, name: step.name, type: step.type, reason: 'left open: the required element was never found' });
    }
  }
  for (const entry of run.unverifiedSteps || []) {
    add({ id: entry.stepId || entry.id, name: entry.name || entry.stepName || 'unverified step', type: entry.type || '', reason: String(entry.reason || 'could not be verified').slice(0, 240) });
  }
  if (run.goalUnverified) {
    add({
      id: null,
      name: 'Goal proof',
      type: 'verify',
      reason: String(run.goalVerdict?.reason || 'the goal was never proved on screen').slice(0, 240),
    });
  }
  return entries;
}

/* --------------------------- append analysis ---------------------------- */

/**
 * The one place suggested steps become workflow steps. The button and the
 * automatic pass share it, so both apply the same filter and the same record.
 */
export function applyAnalysisSteps(run) {
  if (!run) throw new Error('Run not found');
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const failureText = (run.steps || [])
    .filter((step) => step.status === 'failed')
    .map((step) => `${step.name || ''} ${step.type || ''} ${step.error || ''}`)
    .join(' ');
  const timingRelated = /wait|timeout|timed out|loading|dialog|not ready|slow/i.test(failureText);
  const steps = (run.analysis?.suggestedSteps || []).filter((step) => {
    if (step.type === 'wait' && !timingRelated) return false;
    if (step.type === 'writeTextFile' && !step.params?.text && !step.params?.textVar) return false;
    return true;
  });
  if (!steps.length) throw new Error('Suggested steps do not address this failure; rebuild the plan from the goal instead');
  if (!Array.isArray(workflow.steps)) workflow.steps = [];
  workflow.steps.push(...steps.map((step) => ({ ...step, id: step.id || uid('stp') })));
  workflow.updatedAt = now();
  run.analysis = { ...(run.analysis || {}), applied: steps.length, appliedAt: now() };
  persist();
  logActivity('workflow', `Applied ${steps.length} AI step(s) to "${workflow.name}"`, { runId: run.id, workflowId: workflow.id });
  return { workflowId: workflow.id, appended: steps.length, steps };
}

/* ------------------------- append closeout fixes ------------------------ */

function pushAutoLog(run, level, message) {
  if (!Array.isArray(run.log)) run.log = [];
  run.log.push({ at: now(), level, message, stepId: null, source: 'auto-repair' });
}

/* --------------------------- post-run auto work ------------------------- */

/**
 * Runs after the verdict is written and the closeout recorded. `analyze` is the
 * planner hook; it is only called when a run really has incomplete steps.
 */
export async function afterRunAutoRepair(run, { analyze = null, append = appendCloseout } = {}) {
  const settings = autoRepairSettings();
  if (!run || run.dryRun || run.shadow) return { skipped: 'not a live run' };
  if (!settings.appendFixes && !settings.analyzeIncomplete) return { skipped: 'auto repair is off' };
  const record = run.autoRepair || (run.autoRepair = { at: now(), focusLevel: Number(run.focusLevel) || 1, appended: 0, analyzed: false, notes: [] });
  if (record.doneAt) return record;
  try {
    if (settings.appendFixes && run.closeout && run.closeout.action !== 'leave' && (run.closeout.followUpSteps || []).length && !run.closeout.appended) {
      try {
        const applied = append(run.id);
        record.appended += Number(applied?.appended || 0);
        record.notes.push(`Appended ${applied?.appended || 0} follow-up step(s) from the closeout.`);
        pushAutoLog(run, 'info', `Auto-repair: appended ${applied?.appended || 0} follow-up step(s) to the workflow (${run.closeout.action}).`);
      } catch (err) {
        record.notes.push(`Follow-up append skipped: ${String(err.message || err).slice(0, 200)}`);
      }
    }
    if (settings.analyzeIncomplete) {
      const gaps = incompleteStepEntries(run);
      if (gaps.length) {
        const analysis = run.analysis || (typeof analyze === 'function' ? await analyze(run) : null);
        if (analysis) {
          run.analysis = analysis;
          record.analyzed = true;
          record.gaps = gaps.slice(0, 6);
          try {
            const applied = applyAnalysisSteps(run);
            record.appended += applied.appended;
            record.notes.push(`Applied ${applied.appended} AI step(s) for ${gaps.length} incomplete step(s).`);
            pushAutoLog(run, 'info', `Auto-repair: ${gaps.length} incomplete step(s) analysed; ${applied.appended} step(s) appended at focus level ${record.focusLevel}.`);
          } catch (err) {
            record.notes.push(`AI analysis produced nothing usable: ${String(err.message || err).slice(0, 200)}`);
            pushAutoLog(run, 'warn', `Auto-repair: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    record.error = String(err.message || err).slice(0, 300);
    pushAutoLog(run, 'warn', `Auto-repair failed: ${record.error}`);
  } finally {
    record.doneAt = now();
    persist();
  }
  return record;
}

/* --------------------------- screen monitoring -------------------------- */

const readers = { read: null };

export function configureAutoRepair({ read } = {}) {
  if (typeof read === 'function') readers.read = read;
}

const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The control label a step names. Only click steps carry one. */
export function stepLabels(step = {}) {
  const label = norm(step.params?.name);
  return label.length >= 3 && label.length <= 60 ? [label] : [];
}

function visible(step, labelSet) {
  return stepLabels(step).some((label) => [...labelSet].some((seen) => seen.includes(label) || label.includes(seen)));
}

/**
 * Only the *unvisited tail* is permuted: non-pending steps keep their index and
 * the engine's own iterator still visits every tail slot exactly once.
 */
export function reorderPending(run, desiredIds = [], { fromId = null } = {}) {
  const steps = run?.steps;
  if (!Array.isArray(steps) || !desiredIds.length) return null;
  // `fromId` anchors the permutation at the step that is about to run, so the
  // move lands in the slot the loop is standing on instead of one it has already
  // passed (which would drop the moved step entirely).
  const anchorIndex = fromId ? steps.findIndex((step) => step.id === fromId) : -1;
  const currentIndex = run.currentStepId ? steps.findIndex((step) => step.id === run.currentStepId) : -1;
  const tailStart =
    anchorIndex >= 0 ? anchorIndex : currentIndex >= 0 ? currentIndex + 1 : steps.findIndex((step) => step.status === 'pending');
  if (tailStart < 0) return null;
  const tail = steps.slice(tailStart);
  const pending = tail.filter((step) => step.status === 'pending');
  if (pending.length < 2) return null;
  const wanted = desiredIds.filter((id) => pending.some((step) => step.id === id));
  if (!wanted.length) return null;
  const queue = [
    ...wanted.map((id) => pending.find((step) => step.id === id)),
    ...pending.filter((step) => !wanted.includes(step.id)),
  ];
  if (queue.every((step, index) => step === pending[index])) return null;
  let next = 0;
  const nextTail = tail.map((step) => (step.status === 'pending' ? queue[next++] : step));
  steps.splice(tailStart, tail.length, ...nextTail);
  const record = {
    at: now(),
    moved: wanted,
    order: queue.map((step) => step.id),
    previous: pending.map((step) => step.id),
  };
  run.reorders = [...(run.reorders || []), record].slice(-12);
  run.log = run.log || [];
  run.log.push({
    at: now(),
    level: 'info',
    message: `Screen check moved “${queue[0].name || queue[0].type}” ahead of the queue: its control is on screen now and the step before it was not.`,
    stepId: null,
    source: 'auto-repair',
  });
  return record;
}

/**
 * The decision only: given what is on screen, which pending step should go
 * first? The next pending step wins unless its own control is missing and a
 * later step's control is visible.
 *
 * Guard rails, learned the hard way: a reorder only happens while a step is
 * already running (the leading focus/launch of a plan is never rewritten), a
 * lifecycle step or a step with its own skip rule is never moved or crossed,
 * and a run accepts at most two moves.
 */
const LIFECYCLE_STEPS = new Set(['launchApp', 'focusWindow', 'windowAction', 'closeWindow']);
const MAX_REORDERS_PER_RUN = 2;

/** Only a click that names a control can move, and never one with its own skip rule. */
function movable(step) {
  return Boolean(step) && step.type === 'clickElement' && Boolean(step.params?.name) && !step.skipIfVisible;
}

/**
 * The pending steps after the running one, in order, up to the first
 * focus/launch guard: nothing beyond a guard may jump ahead of it.
 */
function pendingTail(run) {
  const steps = run?.steps || [];
  const index = run?.currentStepId ? steps.findIndex((step) => step.id === run.currentStepId && step.status === 'running') : -1;
  if (index < 0) return [];
  const tail = [];
  for (const step of steps.slice(index + 1)) {
    if (LIFECYCLE_STEPS.has(step.type)) break;
    if (step.status === 'pending') tail.push(step);
  }
  return tail;
}

/**
 * Whether a reorder is possible at all, checked before reading the screen: the
 * next pending step must be a click that names a control, and at least one more
 * such click must follow it with no other kind of step in between.
 */
export function monitorCandidates(run) {
  if ((run?.reorders || []).length >= MAX_REORDERS_PER_RUN) return [];
  const clicks = [];
  for (const step of pendingTail(run)) {
    if (!movable(step)) break;
    clicks.push(step);
  }
  return clicks;
}

export function chooseReorder(run, labels = [], clicks = monitorCandidates(run)) {
  const labelSet = new Set((labels || []).map(norm).filter(Boolean));
  if (!labelSet.size) return null;
  if (clicks.length < 2) return null;
  const [next, ...later] = clicks;
  if (visible(next, labelSet)) return null; // the next click's own control is already on screen
  const pick = later.find((step) => visible(step, labelSet));
  return pick ? { ids: [pick.id], moved: pick, aheadOf: next } : null;
}

/**
 * The pending steps a check taken *before* `step` runs may permute: `step`
 * itself, then each following pending click, stopping at the first step that
 * cannot move (or at a lifecycle guard). Empty when this step cannot move, so a
 * screen read is never spent on a step that has nothing to reorder.
 */
export function reorderCandidates(run, step) {
  const steps = run?.steps;
  if (!Array.isArray(steps) || !step || step.status !== 'pending' || !movable(step)) return [];
  const index = steps.findIndex((entry) => entry.id === step.id);
  if (index < 0) return [];
  const candidates = [];
  for (const entry of steps.slice(index)) {
    if (entry.id !== step.id) {
      if (LIFECYCLE_STEPS.has(entry.type)) break;
      if (entry.status !== 'pending') continue;
      if (!movable(entry)) break;
    }
    candidates.push(entry);
  }
  return candidates;
}

/**
 * The check itself: one read of the window, taken just before `step` runs.
 *
 * It is the same decision the old background monitor made — a later click whose
 * control is already on screen takes the slot of one whose control is not — but
 * taken inside the run loop, where a fast focus→click pair cannot outrun it, and
 * anchored at the step about to run so the moved click lands in this slot.
 *
 * Guards are unchanged: only a live run, only click steps that name a control
 * and carry no skip rule of their own, never across a lifecycle step, at most
 * two moves per run, and a read budget per run. Nothing here types or clicks.
 */
export async function reorderBeforeStep(run, step, { read = null, log = null } = {}) {
  if (!run || !step || run.dryRun || run.shadow) return null;
  const candidates = reorderCandidates(run, step);
  if (candidates.length < 2) return null;
  if ((run.reorders || []).length >= MAX_REORDERS_PER_RUN) return null;
  const settings = autoRepairSettings();
  const monitor = run.monitor || (run.monitor = { reads: 0, reorders: 0 });
  if (Number(monitor.reads || 0) >= settings.monitorMaxReads) return null;
  const reader = read || readers.read;
  if (typeof reader !== 'function') return null;
  let labels = [];
  try {
    const value = await reader({ run });
    labels = Array.isArray(value) ? value : Array.isArray(value?.labels) ? value.labels : [];
  } catch (err) {
    monitor.lastError = String(err?.message || err).slice(0, 200);
    persist();
    return null;
  }
  monitor.reads = Number(monitor.reads || 0) + 1;
  monitor.lastReadAt = now();
  monitor.lastLabels = labels.slice(0, 12);
  const decision = chooseReorder(run, labels, candidates);
  if (!decision) {
    persist();
    return null;
  }
  const record = reorderPending(run, decision.ids, { fromId: step.id });
  if (!record) {
    persist();
    return null;
  }
  // The evidence travels with the move: which control was visible, which one was
  // not, and how the queue changed.
  record.movedName = String(decision.moved.name || decision.moved.type || '');
  record.aheadOfName = String(decision.aheadOf.name || decision.aheadOf.type || '');
  record.labels = labels.slice(0, 12);
  monitor.reorders = Number(monitor.reorders || 0) + 1;
  monitor.lastNote = `moved “${record.movedName}” ahead of “${record.aheadOfName}”`;
  logActivity('auto-repair', `Screen check reordered “${run.workflowName}”: ${monitor.lastNote}`, { runId: run.id });
  if (typeof log === 'function') {
    log(`“${record.movedName}” is on screen and “${record.aheadOfName}” is not, so it takes this slot.`);
  }
  persist();
  return { step: decision.moved, record };
}
