/**
 * Step factoring — track how steps form, spot and pin their intents, and
 * re-conjoin similar steps across every workflow and run.
 *
 * Every settled step is fingerprinted (type + normalized params) and counted
 * into a pattern ledger. When the same fingerprint keeps passing — in any
 * workflow — the ledger's strength grows (auto-upscale learning); when it
 * keeps failing, strength falls. The strongest proven form of a step becomes
 * the extracted solution offered to any later run whose step shares the
 * fingerprint, fed into the repair/replan advice so agents adopt what already
 * worked instead of rediscovering it.
 *
 * Intents are spotted from a step's type, params and name (open, window,
 * input-into-window, evidence, timing, persist, pointer, tool, note, ai) and
 * pinned onto the step, so similar steps across workflows carry the same
 * intent tag and duplication is visible.
 *
 * Refactor consideration: duplication clusters (the same fingerprint across
 * several workflows, or repeated inside one workflow) are gathered into
 * refactor plans. Applying a plan never edits anything silently — it pushes a
 * concrete, reviewable suggestion into the builder for each affected
 * workflow, exactly like every other advice channel in this console.
 */
import { db, persist, now, uid, logActivity } from './store.js';
import { addSuggestion } from './planner.js';

const PATTERN_LIMIT = 400;
const PLAN_LIMIT = 40;
const VOLATILE_PARAMS = new Set(['timeoutMs', 'intervalMs', 'waitMs', 'attempts', 'evidence', 'var', 'textVar', 'saveTo']);

/** A stable, comparable shape of what a step actually does. */
export function fingerprintStep(step) {
  const params = step?.params || {};
  const parts = Object.keys(params)
    .filter((key) => !VOLATILE_PARAMS.has(key))
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${normalizeValue(params[key])}`);
  return `${step?.type || 'unknown'}|${parts.join(';')}`;
}

function normalizeValue(value) {
  if (Array.isArray(value)) return `[${value.map(normalizeValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${normalizeValue(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') return Math.round(value);
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

const INTENT_RULES = [
  { intent: 'open', test: (step) => ['launchApp', 'openUrl', 'installApp', 'testApp'].includes(step.type), basis: 'opens or installs an app or page' },
  { intent: 'window', test: (step) => ['focusWindow', 'closeWindow', 'windowAction'].includes(step.type), basis: 'window management' },
  {
    intent: 'input-into-window',
    test: (step) => ['type', 'key', 'clipboard'].includes(step.type) && String(step.params?.foreground || step.params?.window || '').trim() !== '',
    basis: 'typing with a named destination window',
  },
  { intent: 'input', test: (step) => ['type', 'key', 'clipboard'].includes(step.type), basis: 'keyboard or clipboard without a named destination' },
  { intent: 'act-on-control', test: (step) => ['click', 'doubleClick', 'rightClick', 'clickElement', 'drag', 'dragCopy', 'scroll', 'move'].includes(step.type), basis: 'pointer action on a control or coordinate' },
  { intent: 'evidence', test: (step) => ['expect', 'verifyScreen', 'verifyPlayback', 'screenshot'].includes(step.type), basis: 'asserts or captures proof' },
  { intent: 'timing', test: (step) => ['wait', 'waitFor', 'mediaHold'].includes(step.type), basis: 'waits for time or state' },
  { intent: 'persist', test: (step) => ['downloadMedia', 'saveImage', 'writeTextFile', 'writeNote', 'recordVideo'].includes(step.type), basis: 'saves something somewhere' },
  { intent: 'note', test: (step) => ['note', 'readNote'].includes(step.type), basis: 'run notes' },
  { intent: 'tool', test: (step) => step.type === 'runTool', basis: 'runs a saved tool' },
  { intent: 'ai', test: (step) => ['aiExtract', 'watchVideo'].includes(step.type), basis: 'model work' },
];

/** What is this step actually for? Deterministic, explainable. */
export function spotIntent(step) {
  for (const rule of INTENT_RULES) {
    if (rule.test(step)) return { intent: rule.intent, basis: rule.basis, confidence: rule.intent.includes('-') ? 0.9 : 0.75 };
  }
  return { intent: 'other', basis: 'no rule matched this step type', confidence: 0.3 };
}

function patterns() {
  const d = db();
  if (!Array.isArray(d.stepPatterns)) d.stepPatterns = [];
  return d.stepPatterns;
}

function plans() {
  const d = db();
  if (!Array.isArray(d.refactorPlans)) d.refactorPlans = [];
  return d.refactorPlans;
}

/** Pin the spotted intent onto every step of a workflow (never overwrites a set intent). */
export function pinStepIntents(workflow) {
  if (!workflow) throw new Error('Workflow not found');
  let pinned = 0;
  let kept = 0;
  for (const step of workflow.steps || []) {
    if (step.intent) {
      kept += 1;
      continue;
    }
    const spotted = spotIntent(step);
    step.intent = spotted.intent;
    step.intentBasis = spotted.basis;
    pinned += 1;
  }
  if (pinned) {
    workflow.updatedAt = now();
    persist();
    logActivity('factoring', `Pinned ${pinned} step intent(s) in “${workflow.name}”`, { workflowId: workflow.id });
  }
  return { workflowId: workflow.id, pinned, kept };
}

/** The ledger entry for a fingerprint, created on first sight. */
function patternFor(step) {
  const fingerprint = fingerprintStep(step);
  const list = patterns();
  let entry = list.find((pattern) => pattern.fingerprint === fingerprint);
  if (!entry) {
    entry = {
      id: uid('pat'),
      fingerprint,
      type: step.type,
      intent: step.intent || spotIntent(step).intent,
      successes: 0,
      failures: 0,
      strength: 0,
      lastOutcome: null,
      sample: null,
      firstAt: now(),
      updatedAt: now(),
    };
    list.push(entry);
    if (list.length > PATTERN_LIMIT) list.splice(0, list.length - PATTERN_LIMIT);
  }
  return entry;
}

/**
 * Record a settled step into the ledger. Deduped per run+step so retries and
 * multiple bookkeeping calls cannot inflate the counts.
 */
export function noteStepOutcome(run, step) {
  if (!run || !step) return null;
  const status = step.status;
  if (!['passed', 'failed', 'needs_review'].includes(status)) return null;
  if (!Array.isArray(run.factoringCounted)) run.factoringCounted = [];
  const key = `${step.id}:${status}`;
  if (run.factoringCounted.includes(key)) return null;
  run.factoringCounted.push(key);

  const pattern = patternFor(step);
  if (status === 'passed') {
    pattern.successes += 1;
    pattern.sample = {
      workflowId: run.workflowId || null,
      workflowName: run.workflowName || '',
      stepName: step.name || '',
      params: JSON.parse(JSON.stringify(step.params || {})),
      at: now(),
    };
  } else {
    pattern.failures += 1;
  }
  pattern.lastOutcome = status;
  // Upscale: corroboration across runs makes a pattern strong; repeated
  // failure bleeds strength away, but a proven form never goes negative.
  pattern.strength = Math.max(0, pattern.successes - pattern.failures);
  pattern.updatedAt = now();
  persist();
  return pattern;
}

/** Proven forms of this exact step, strongest first, across all workflows. */
export function similarSolutions({ step, excludeWorkflowId = '' } = {}) {
  if (!step) return [];
  const fingerprint = fingerprintStep(step);
  return patterns()
    .filter((pattern) => pattern.fingerprint === fingerprint && pattern.successes > 0)
    .filter((pattern) => !excludeWorkflowId || !pattern.sample || pattern.sample.workflowId !== excludeWorkflowId)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3)
    .map((pattern) => ({
      fingerprint,
      intent: pattern.intent,
      strength: pattern.strength,
      successes: pattern.successes,
      failures: pattern.failures,
      workflowName: pattern.sample?.workflowName || '',
      stepName: pattern.sample?.stepName || '',
      params: pattern.sample?.params || {},
      lastOutcome: pattern.lastOutcome,
    }));
}

/** The ledger's strongest forms — the upscaled learning. */
export function upscaleSummary({ limit = 8 } = {}) {
  return patterns()
    .filter((pattern) => pattern.strength > 0)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

function workflowStepsFingerprinted(workflow) {
  return (workflow.steps || []).map((step, index) => ({
    index,
    stepId: step.id,
    name: step.name || step.type,
    type: step.type,
    intent: step.intent || spotIntent(step).intent,
    fingerprint: fingerprintStep(step),
  }));
}

/** Consider duplication across every workflow and form refactor plans. */
export function planRefactoring({ minWorkflows = 2, minShared = 2 } = {}) {
  const d = db();
  const workflows = (d.workflows || []).filter((workflow) => Array.isArray(workflow.steps) && workflow.steps.length);
  const byFingerprint = new Map();

  for (const workflow of workflows) {
    for (const entry of workflowStepsFingerprinted(workflow)) {
      const list = byFingerprint.get(entry.fingerprint) || [];
      list.push({ workflowId: workflow.id, workflowName: workflow.name, ...entry });
      byFingerprint.set(entry.fingerprint, list);
    }
  }

  const clusters = [];
  for (const [fingerprint, occurrences] of byFingerprint) {
    const byWorkflow = new Map();
    for (const occurrence of occurrences) {
      const list = byWorkflow.get(occurrence.workflowId) || [];
      list.push(occurrence);
      byWorkflow.set(occurrence.workflowId, list);
    }
    if (byWorkflow.size >= minWorkflows) {
      const pattern = patterns().find((entry) => entry.fingerprint === fingerprint);
      clusters.push({
        kind: 'cross-workflow',
        fingerprint,
        intent: occurrences[0].intent,
        workflows: [...byWorkflow.entries()].map(([workflowId, list]) => ({
          workflowId,
          workflowName: list[0].workflowName,
          steps: list.map((item) => ({ index: item.index, stepId: item.stepId, name: item.name })),
        })),
        provenForm: pattern?.sample || null,
        strength: pattern?.strength || 0,
      });
    }
    for (const [workflowId, list] of byWorkflow) {
      if (list.length >= minShared && byWorkflow.size === 1) {
        clusters.push({
          kind: 'in-workflow',
          fingerprint,
          intent: list[0].intent,
          workflows: [{ workflowId, workflowName: list[0].workflowName, steps: list.map((item) => ({ index: item.index, stepId: item.stepId, name: item.name })) }],
          provenForm: patterns().find((entry) => entry.fingerprint === fingerprint)?.sample || null,
          strength: 0,
        });
      }
    }
  }

  const considered = clusters;

  const plan = {
    id: uid('rfp'),
    at: now(),
    status: 'proposed',
    scannedWorkflows: workflows.length,
    clusters: considered,
    summary: considered.length
      ? `${considered.length} duplication cluster(s): ${[...new Set(considered.map((cluster) => cluster.intent))].join(', ')}`
      : 'No duplication worth factoring right now.',
  };
  const list = plans();
  list.unshift(plan);
  if (list.length > PLAN_LIMIT) list.length = PLAN_LIMIT;
  persist();
  logActivity('factoring', `Refactor consideration: ${plan.summary}`, { planId: plan.id });
  return plan;
}

/** Application: concrete, reviewable suggestions in the builder — never silent edits. */
export function pushRefactorToBuilder(planId) {
  const plan = plans().find((entry) => entry.id === planId);
  if (!plan) throw new Error('Refactor plan not found');
  if (plan.status === 'applied') throw new Error('This plan was already pushed to the builder');
  const created = [];
  for (const cluster of plan.clusters) {
    for (const workflow of cluster.workflows) {
      const stepList = workflow.steps.map((step) => `#${step.index + 1} “${step.name}”`).join(', ');
      const proven = cluster.provenForm
        ? ` The strongest proven form (used ${cluster.strength}×, last passing in “${cluster.provenForm.workflowName}”) carries params ${JSON.stringify(cluster.provenForm.params).slice(0, 240)}; adopt it where the copies differ.`
        : '';
      const text = `Refactor (${cluster.kind}, intent: ${cluster.intent}): ${stepList} in “${workflow.workflowName}” share one fingerprint with the same steps elsewhere${cluster.kind === 'cross-workflow' ? ' in other workflows' : ''}. Consider factoring them into a single shared sequence and keeping one canonical copy; update the copies together from now on.${proven}`;
      const suggestion = addSuggestion(text, 'refactor', workflow.workflowId, null);
      if (suggestion) created.push({ workflowId: workflow.workflowId, suggestionId: suggestion.id, text });
    }
  }
  plan.status = 'applied';
  plan.appliedAt = now();
  plan.suggestions = created.map((entry) => entry.suggestionId);
  persist();
  logActivity('factoring', `Refactor plan pushed to the builder: ${created.length} suggestion(s)`, { planId: plan.id });
  return { planId: plan.id, suggestions: created };
}

export function factoringStatus({ limit = 8 } = {}) {
  const d = db();
  const pinnedWorkflows = (d.workflows || []).filter((workflow) => (workflow.steps || []).some((step) => step.intent)).length;
  return {
    patterns: upscaleSummary({ limit }),
    patternCount: (d.stepPatterns || []).length,
    pinnedWorkflows,
    plans: plans().slice(0, 10),
  };
}
