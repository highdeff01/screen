/**
 * Read-only evidence review. No files are read, desktop actions performed, plans
 * created, or external models called. All input text is untrusted and may contain
 * sensitive window titles or paths; callers must apply their own access controls.
 *
 * buildObservationProfile({ monitor, simulation }) accepts the monitorState()
 * view and an analyzeRun() result or completed screenshot simulation record.
 * Either is optional. It returns { provenance, observations, missingEvidence,
 * uncertainty, proposedNextSteps, truncation }. Observations are separate
 * monitor and simulation arrays, never correlated by timestamp. Frame paths are
 * references only; availability or contents are not verified. Lists and text
 * are capped, and malformed entries are ignored. This is not a success verdict.
 *
 * prepareObservationReview({ monitor, simulation, proposal }) returns
 * { profile, proposalReview }. When a proposal-like object with a steps array
 * is supplied, proposalReview.staticTest is the existing shadowTestPlan result
 * over a bounded copy of proposal fields. It is a static precondition check,
 * not shadowTestProposal (which creates a run and persists results), approval,
 * execution, or a recommendation to apply changes. Otherwise it is null.
 */
import { shadowTestPlan } from './shadow-test.js';

const MAX_EVENTS = 20;
const MAX_STEPS = 50;
const MAX_TEXT = 200;
const MAX_AUX = 50;
const VERDICTS = new Set(['simulated', 'unreadable', 'missing', 'unclear', 'missing_baseline', 'confirmed', 'mismatch', 'failed_with_change', 'no_change', 'observed']);
const SOURCES = new Set(['evidence', 'live monitor', 'nearest', 'none']);
const text = (value, max = MAX_TEXT) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const array = (value) => Array.isArray(value) ? value : [];

/** Construct a bounded, passive profile from already collected data. */
export function buildObservationProfile({ monitor = null, simulation = null } = {}) {
  monitor = object(monitor);
  simulation = object(simulation);
  const events = array(monitor?.events);
  // A queued or failed simulation is not evidence, even if it has stale fields.
  const ready = Boolean(simulation && (!simulation.status || simulation.status === 'completed'));
  const breakdown = ready ? array(simulation.breakdown) : [];
  const monitorObservations = events.slice(0, MAX_EVENTS).flatMap((item, index) => {
    const event = object(item);
    if (!event) return [];
    return [{
      source: 'live-monitor', index, at: text(event.at) || null,
      title: text(event.title) || null, process: text(event.process) || null,
      capture: text(event.capture) || null,
    }];
  });
  const stepObservations = breakdown.slice(0, MAX_STEPS).flatMap((item, index) => {
    const step = object(item);
    if (!step) return [];
    return [{
      source: 'screenshot-sim', index, seq: number(step.seq, 1, Number.MAX_SAFE_INTEGER),
      stepId: text(step.stepId) || null, name: text(step.name) || null,
      type: text(step.type) || null, status: text(step.status, 40) || null,
      expectedChange: typeof step.expectedChange === 'boolean' ? step.expectedChange : null,
      verdict: VERDICTS.has(step.verdict) ? step.verdict : 'unknown',
      frameSource: SOURCES.has(step.source) ? step.source : null,
      proxy: typeof step.proxy === 'boolean' ? step.proxy : step.source === 'nearest' ? true : null,
      frames: number(step.frames, 0, Number.MAX_SAFE_INTEGER),
      changedPct: number(step.changedPct, 0, 100),
      before: text(step.before) || null, after: text(step.after || step.frame) || null,
    }];
  });
  const missingEvidence = [];
  const uncertainty = [];
  const proposedNextSteps = [];
  const add = (list, code, detail) => list.push({ code, detail });
  if (!monitor || !monitorObservations.length) add(missingEvidence, 'monitor_events', 'No live-monitor events were provided.');
  if (!simulation) add(missingEvidence, 'simulation', 'No screenshot simulation was provided.');
  else if (!ready) add(missingEvidence, 'simulation_incomplete', 'The screenshot simulation is not completed.');
  else if (!stepObservations.length) add(missingEvidence, 'simulation_steps', 'No per-step screenshot results were provided.');
  if (monitorObservations.some((event) => !event.capture)) add(missingEvidence, 'monitor_captures', 'Some monitor events have no capture reference.');
  const verdicts = new Set(stepObservations.map((step) => step.verdict));
  for (const [verdict, detail] of [
    ['missing', 'Some steps have no covering frame.'],
    ['missing_baseline', 'Some steps lack a comparison baseline.'],
    ['unreadable', 'Some frames could not be decoded.'],
    ['simulated', 'Dry-run placeholders are not pixel evidence.'],
  ]) if (verdicts.has(verdict)) add(missingEvidence, verdict, detail);
  add(uncertainty, 'semantic_content', 'Window metadata and pixel differences do not establish visible content, intent, or goal success.');
  if (monitorObservations.length) add(uncertainty, 'monitor_sampling', 'The monitor reports foreground-handle changes, not continuous screen content; captures can be absent or throttled.');
  if (monitorObservations.length && stepObservations.length) add(uncertainty, 'not_correlated', 'Monitor events and simulation steps are not linked or causally correlated by this profile.');
  if (stepObservations.some((step) => step.proxy || step.verdict === 'unclear')) add(uncertainty, 'proxy_frame', 'A nearest or proxy frame may not show the step itself.');
  if (verdicts.has('unknown')) add(uncertainty, 'unknown_verdict', 'Some simulation verdicts are unrecognized or missing.');
  if (events.length > MAX_EVENTS || breakdown.length > MAX_STEPS) add(uncertainty, 'truncated', 'Only a bounded subset of the supplied events and steps is represented.');
  if (stepObservations.length) add(uncertainty, 'simulation_limits', 'Simulation verdicts describe coarse pixel comparison, not semantic verification; references and source results were not independently checked.');
  if (!simulation || !ready || !stepObservations.length) add(proposedNextSteps, 'collect_step_evidence', 'Review or collect per-step evidence before drawing conclusions.');
  if (['missing', 'missing_baseline', 'unreadable', 'simulated'].some((v) => verdicts.has(v)) || stepObservations.some((step) => step.proxy)) {
    add(proposedNextSteps, 'improve_coverage', 'Consider direct, readable before/after captures for uncovered or proxy steps.');
  }
  if (verdicts.has('mismatch') || verdicts.has('failed_with_change') || verdicts.has('no_change')) add(proposedNextSteps, 'inspect_disagreement', 'Inspect the run status, errors and original frames before proposing a change.');
  add(proposedNextSteps, 'verify_semantics', 'Have a reviewer inspect relevant evidence and define explicit content or outcome assertions.');
  return {
    provenance: {
      monitor: monitor ? { running: typeof monitor.running === 'boolean' ? monitor.running : null, lastEventAt: text(monitor.lastEventAt) || null } : null,
      simulation: simulation ? { id: text(simulation.id) || null, runId: text(simulation.runId) || null, workflowId: text(simulation.workflowId) || null, status: text(simulation.status, 40) || null, mode: text(simulation.mode, 40) || null, method: text(simulation.method, 40) || null, completedAt: text(simulation.completedAt) || null } : null,
    },
    observations: { monitor: monitorObservations, steps: stepObservations },
    missingEvidence, uncertainty, proposedNextSteps,
    truncation: { monitorEventsOmitted: Math.max(0, events.length - MAX_EVENTS), simulationStepsOmitted: Math.max(0, breakdown.length - MAX_STEPS) },
  };
}

// Copy only fields used by shadowTestPlan, with strict bounds and primitive values.
function staticPlan(proposal) {
  const steps = array(proposal.steps).slice(0, MAX_STEPS).map((item) => {
    const step = object(item) || {};
    const params = object(step.params) || {};
    const copy = {};
    for (const key of ['text', 'textVar', 'target', 'url', 'title', 'windowName', 'windowTitle', 'window', 'name', 'keys', 'value', 'toolId', 'x', 'y', 'outputVar', 'action']) {
      const value = params[key];
      if (typeof value === 'string') copy[key] = text(value, 2000);
      else if (typeof value === 'number' && Number.isFinite(value)) copy[key] = value;
      else if (typeof value === 'boolean') copy[key] = value;
    }
    return { type: text(step.type, 80), name: text(step.name), params: copy };
  });
  return {
    steps,
    preflight: array(proposal.preflight).slice(0, MAX_AUX).map((item) => ({ ok: object(item)?.ok === true })),
    confidence: number(proposal.confidence, 0, 1),
    screenshots: array(proposal.research?.screenshots).slice(0, MAX_AUX).map(() => true),
    backups: array(proposal.backups).slice(0, MAX_AUX).map(() => true),
    lint: { issues: array(proposal.lint?.issues).slice(0, MAX_AUX).map((item) => ({ severity: text(item?.severity, 40), code: text(item?.code, 100) })) },
  };
}

/** Prepare a profile and optional bounded static check; never persist or execute. */
export function prepareObservationReview({ monitor = null, simulation = null, proposal = null } = {}) {
  const profile = buildObservationProfile({ monitor, simulation });
  if (!object(proposal) || !Array.isArray(proposal.steps)) return { profile, proposalReview: null };
  const truncation = {
    stepsOmitted: Math.max(0, proposal.steps.length - MAX_STEPS),
    preflightOmitted: Math.max(0, array(proposal.preflight).length - MAX_AUX),
    lintIssuesOmitted: Math.max(0, array(proposal.lint?.issues).length - MAX_AUX),
  };
  return {
    profile,
    proposalReview: {
      proposalId: text(proposal.id) || null,
      kind: 'bounded-static-shadow-test',
      staticTest: shadowTestPlan(staticPlan(proposal)),
      truncation,
      limitations: 'Static checks only; input fields and list lengths are bounded. Passing does not prove execution or goal success, especially when input was truncated.',
    },
  };
}
