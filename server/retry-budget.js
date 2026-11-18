import { db, persist, now, logActivity } from './store.js';

const DEFAULT_MAX = 3;
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;

function ensure(workflow) {
  if (!workflow) return null;
  if (!workflow.retryBudget || typeof workflow.retryBudget !== 'object') {
    workflow.retryBudget = {
      failures: [],
      maxFailures: DEFAULT_MAX,
      windowMs: DEFAULT_WINDOW_MS,
      paused: false,
      manual: false,
      reason: null,
      updatedAt: null,
    };
  }
  const budget = workflow.retryBudget;
  budget.failures = Array.isArray(budget.failures) ? budget.failures : [];
  budget.maxFailures = Math.max(1, Math.min(20, Number(budget.maxFailures) || DEFAULT_MAX));
  budget.windowMs = Math.max(60000, Number(budget.windowMs) || DEFAULT_WINDOW_MS);
  return budget;
}

function prune(budget, nowMs = Date.now()) {
  budget.failures = (budget.failures || []).filter((failure) => {
    const at = Date.parse(failure.at || '');
    return Number.isFinite(at) && nowMs - at <= budget.windowMs;
  });
}

export function normalizeBudget(budget) {
  if (!budget || typeof budget !== 'object') return null;
  budget.failures = Array.isArray(budget.failures) ? budget.failures : [];
  budget.maxFailures = Math.max(1, Math.min(20, Number(budget.maxFailures) || DEFAULT_MAX));
  budget.windowMs = Math.max(60000, Number(budget.windowMs) || DEFAULT_WINDOW_MS);
  budget.paused = Boolean(budget.paused);
  budget.manual = Boolean(budget.manual);
  return budget;
}

export function budgetView(budget, nowMs = Date.now()) {
  const value = normalizeBudget(budget);
  if (!value) return { ok: false, remaining: 0, reason: 'Retry budget not found', failures: [], maxFailures: DEFAULT_MAX };
  prune(value, nowMs);
  return {
    ok: !value.paused && value.failures.length < value.maxFailures,
    paused: Boolean(value.paused),
    manual: Boolean(value.manual),
    reason: value.reason || null,
    failures: value.failures.length,
    remaining: Math.max(0, value.maxFailures - value.failures.length),
    maxFailures: value.maxFailures,
    windowMs: value.windowMs,
    updatedAt: value.updatedAt || null,
    recent: value.failures.slice(-5),
  };
}

export function recordBudgetFailure(budget, { at = now(), source = 'run', reason = '', nowMs = Date.now() } = {}) {
  const value = normalizeBudget(budget);
  if (!value) return { budget: null, view: null, pausedNow: false };
  prune(value, nowMs);
  value.failures.push({ at, source, reason: String(reason || '').slice(0, 300) });
  value.failures = value.failures.slice(-30);
  let pausedNow = false;
  if (value.failures.length >= value.maxFailures && !value.paused) {
    value.paused = true;
    value.manual = false;
    value.reason = `Shared retry budget paused after ${value.failures.length} failure(s) in the window.`;
    pausedNow = true;
  }
  value.updatedAt = at;
  return { budget: value, view: budgetView(value, nowMs), pausedNow };
}

export function resetBudget(budget, { at = now() } = {}) {
  const value = normalizeBudget(budget);
  if (!value) return null;
  value.failures = [];
  value.paused = false;
  value.manual = false;
  value.reason = null;
  value.updatedAt = at;
  return value;
}

export function recordBudgetSuccess(budget, { at = now() } = {}) {
  const value = normalizeBudget(budget);
  if (!value) return null;
  if (value.manual) return value;
  return resetBudget(value, { at });
}

export function reEnableBudgetAgents(agents, workflowId, at = now()) {
  let reenabled = 0;
  for (const agent of agents || []) {
    if (agent.budgetPaused && agent.workflowId === workflowId) {
      agent.enabled = true;
      agent.budgetPaused = false;
      agent.status = 'idle';
      agent.log = [{ at, message: 'Re-enabled after the shared retry budget was reset.' }, ...(agent.log || [])].slice(0, 40);
      reenabled += 1;
    }
  }
  return reenabled;
}

export function getRetryBudget(workflowId) {
  const workflow = db().workflows.find((entry) => entry.id === workflowId);
  const budget = ensure(workflow);
  if (!budget) return { ok: false, remaining: 0, reason: 'Workflow not found', failures: [], maxFailures: DEFAULT_MAX };
  return budgetView(budget);
}

export function canRetry(workflowId, source = 'manual') {
  const view = getRetryBudget(workflowId);
  if (view.ok) return { ...view, source };
  return {
    ...view,
    source,
    reason:
      view.reason ||
      `Shared retry budget exhausted: ${view.failures}/${view.maxFailures} failures in the retry window.`,
  };
}

export function recordRetryOutcome(workflowId, { ok = false, source = 'run', reason = '' } = {}) {
  const workflow = db().workflows.find((entry) => entry.id === workflowId);
  const budget = ensure(workflow);
  if (!budget) return null;
  if (ok) {
    if (!budget.manual) {
      recordBudgetSuccess(budget);
      reEnableBudgetAgents(db().agents, workflowId);
    }
  } else {
    const result = recordBudgetFailure(budget, { source, reason });
    if (result.pausedNow) {
      logActivity('retry-budget', `Paused retries for "${workflow.name}"`, { workflowId, reason: budget.reason });
    }
  }
  persist();
  return getRetryBudget(workflowId);
}

export function setRetryBudget(workflowId, { action = 'reset', maxFailures = null } = {}) {
  const workflow = db().workflows.find((entry) => entry.id === workflowId);
  const budget = ensure(workflow);
  if (!budget) throw new Error('Workflow not found');
  if (maxFailures != null) budget.maxFailures = Math.max(1, Math.min(20, Number(maxFailures) || DEFAULT_MAX));
  const next = String(action || '').toLowerCase();
  if (next === 'pause') {
    budget.paused = true;
    budget.manual = true;
    budget.reason = 'Retries paused by the operator.';
  } else if (next === 'resume' || next === 'reset') {
    resetBudget(budget);
    reEnableBudgetAgents(db().agents, workflowId);
  } else {
    throw new Error('Unknown retry budget action. Use pause, resume or reset.');
  }
  if (next === 'pause') budget.updatedAt = now();
  persist();
  logActivity('retry-budget', `Retry budget ${next} for "${workflow.name}"`, { workflowId, action: next });
  return getRetryBudget(workflowId);
}
