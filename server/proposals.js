import { db, persist, uid, now, logActivity } from './store.js';
import { planSteps, lintWorkflow, workflowGoal } from './planner.js';
import { buildWorkflowResearch, compactResearch } from './research.js';
import { shadowTestPlan } from './shadow-test.js';
import { createRun, waitForRun } from './engine.js';

const MAX_PROPOSALS = 40;

function ensureStore() {
  const d = db();
  if (!Array.isArray(d.proposals)) d.proposals = [];
  return d;
}

function stepKey(step) {
  return `${step?.type || ''}|${step?.name || ''}|${JSON.stringify(step?.params || {})}`;
}

export function diffSteps(before = [], after = []) {
  const beforeCounts = new Map();
  const afterCounts = new Map();
  for (const step of before) beforeCounts.set(stepKey(step), (beforeCounts.get(stepKey(step)) || 0) + 1);
  for (const step of after) afterCounts.set(stepKey(step), (afterCounts.get(stepKey(step)) || 0) + 1);
  const added = [];
  const removed = [];
  for (const [key, count] of afterCounts) {
    const previous = beforeCounts.get(key) || 0;
    for (let i = previous; i < count; i++) {
      const step = after.find((entry) => stepKey(entry) === key);
      if (step) added.push({ type: step.type, name: step.name, index: after.indexOf(step) });
    }
  }
  for (const [key, count] of beforeCounts) {
    const next = afterCounts.get(key) || 0;
    for (let i = next; i < count; i++) {
      const step = before.find((entry) => stepKey(entry) === key);
      if (step) removed.push({ type: step.type, name: step.name, index: before.indexOf(step) });
    }
  }
  const unchanged = [...afterCounts.entries()].reduce(
    (total, [key, count]) => total + Math.min(count, beforeCounts.get(key) || 0),
    0
  );
  return {
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    unchanged,
    before: before.length,
    after: after.length,
    changed: added.length + removed.length,
  };
}

export function proposalView(proposal) {
  return {
    id: proposal.id,
    workflowId: proposal.workflowId,
    workflowName: proposal.workflowName,
    goal: proposal.goal,
    status: proposal.status,
    source: proposal.source,
    createdAt: proposal.createdAt,
    approvedAt: proposal.approvedAt || null,
    rejectedAt: proposal.rejectedAt || null,
    appliedMode: proposal.appliedMode || null,
    note: proposal.note,
    planSource: proposal.plan?.source || null,
    planModel: proposal.plan?.model || null,
    steps: proposal.steps || [],
    confidence: proposal.confidence,
    decisions: proposal.decisions || [],
    rejectedSteps: proposal.rejectedSteps || [],
    backups: proposal.backups || [],
    preflight: proposal.preflight || [],
    changes: proposal.changes,
    lint: proposal.lint,
    research: proposal.research,
    tests: proposal.tests || [],
    shadowTest: proposal.shadowTest || null,
    shadowTests: proposal.shadowTests || [],
    visualTests: proposal.visualTests || [],
  };
}

export function listProposals({ workflowId = '', status = '', limit = 20 } = {}) {
  const d = ensureStore();
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
  return {
    count: d.proposals.length,
    pending: d.proposals.filter((proposal) => proposal.status === 'pending').length,
    proposals: d.proposals
      .filter((proposal) => (!workflowId || proposal.workflowId === workflowId) && (!status || proposal.status === status))
      .slice(0, cap)
      .map(proposalView),
  };
}

export function findProposal(id) {
  return ensureStore().proposals.find((proposal) => proposal.id === id) || null;
}

export async function createProposal({ workflowId, goal = '', source = 'research-agent' } = {}) {
  const d = ensureStore();
  const workflow = d.workflows.find((entry) => entry.id === workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const fullGoal = String(goal || workflowGoal(workflow) || workflow.description || workflow.name || '').trim();
  if (!fullGoal) throw new Error('Describe the goal first');

  const research = buildWorkflowResearch({ workflow, goal: fullGoal });
  const plan = await planSteps(fullGoal, workflow, { research });
  if (!plan?.steps?.length) throw new Error('The planner did not produce steps');

  const steps = plan.steps.map((step) => ({ ...step, id: uid('stp') }));
  const lint = lintWorkflow({ ...workflow, description: fullGoal, steps });
  const blocking = (lint.issues || []).filter(
    (issue) => issue.severity === 'error' && issue.code !== 'unrequested new-chat condition'
  );
  const changes = diffSteps(workflow.steps || [], steps);
  const failureCount = research.failedAttempts.length;
  const screenshotCount = research.screenshots.length;
  const noteParts = [
    plan.note,
    `Cross-referenced ${research.conversation.length} conversation message(s), ${failureCount} failed attempt(s), ${screenshotCount} screenshot(s) and ${research.workflowHistory.length} workflow(s).`,
  ].filter(Boolean);

  const proposal = {
    id: uid('prop'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    goal: fullGoal,
    status: blocking.length ? 'blocked' : 'pending',
    source,
    createdAt: now(),
    plan: {
      source: plan.source,
      model: plan.model,
      ms: plan.ms || 0,
      note: plan.note || '',
      memoryMatches: plan.memoryMatches || [],
    },
    steps,
    confidence: plan.confidence,
    decisions: plan.decisions || [],
    rejectedSteps: plan.rejectedSteps || [],
    backups: plan.backups || [],
    preflight: plan.preflight || [],
    changes,
    lint,
    research: compactResearch(research),
    tests: [
      {
        kind: 'static',
        status: blocking.length ? 'failed' : 'passed',
        label: 'Plan lint and failed-attempt review',
        detail: blocking.length
          ? `${blocking.length} blocking lint error(s): ${blocking.map((issue) => issue.code).join(', ')}.`
          : `No blocking lint errors${lint.issues.length ? ` (${lint.issues.length} review warning(s))` : ''}. ${failureCount} prior failure(s) excluded from the proposed order.`,
      },
    ],
    note: noteParts.join(' '),
  };
  d.proposals.unshift(proposal);
  d.proposals = d.proposals.slice(0, MAX_PROPOSALS);
  persist();
  logActivity(
    'proposal',
    `Proposal ${proposal.status}: ${workflow.name} (${steps.length} steps, ${failureCount} prior failure${failureCount === 1 ? '' : 's'} reviewed)`,
    { workflowId: workflow.id, proposalId: proposal.id }
  );
  return proposalView(proposal);
}

export function approveProposal(id, { mode = 'replace' } = {}) {
  const d = ensureStore();
  const proposal = d.proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'approved') throw new Error('Proposal was already approved');
  if (proposal.status === 'rejected') throw new Error('Proposal was rejected');
  if (proposal.status === 'blocked') throw new Error('This proposal has blocking lint errors; request a new proposal instead');
  const workflow = d.workflows.find((entry) => entry.id === proposal.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  const existingByKey = new Map((workflow.steps || []).map((step) => [stepKey(step), step.id]));
  const usedIds = new Set();
  const steps = (proposal.steps || []).map((step) => {
    const previous = existingByKey.get(stepKey(step));
    if (previous && !usedIds.has(previous)) {
      usedIds.add(previous);
      return { ...step, id: previous };
    }
    return { ...step, id: step.id || uid('stp') };
  });
  if (!steps.length) throw new Error('Proposal has no steps');
  workflow.steps = mode === 'append' ? [...workflow.steps, ...steps] : steps;
  workflow.description = proposal.goal;
  workflow.backupSteps = proposal.backups || [];
  workflow.preflight = proposal.preflight || [];
  workflow.planConfidence = proposal.confidence ?? null;
  workflow.updatedAt = now();
  proposal.status = 'approved';
  proposal.approvedAt = now();
  proposal.appliedMode = mode === 'append' ? 'append' : 'replace';
  persist();
  logActivity(
    'proposal',
    `Approved proposal for ${workflow.name}: ${steps.length} step(s) ${proposal.appliedMode === 'append' ? 'appended' : 'replaced'}`,
    { workflowId: workflow.id, proposalId: proposal.id }
  );
  return { proposal: proposalView(proposal), workflow };
}

export function rejectProposal(id, reason = '') {
  const d = ensureStore();
  const proposal = d.proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error('Proposal not found');
  if (proposal.status === 'approved') throw new Error('Proposal was already approved');
  proposal.status = 'rejected';
  proposal.rejectedAt = now();
  proposal.rejectReason = String(reason || '').slice(0, 500);
  persist();
  logActivity('proposal', `Rejected proposal for ${proposal.workflowName}`, {
    workflowId: proposal.workflowId,
    proposalId: proposal.id,
  });
  return proposalView(proposal);
}

export async function createProposalForRun(runId) {
  const d = ensureStore();
  const run = d.runs.find((entry) => entry.id === runId);
  if (!run) throw new Error('Run not found');
  const workflow = d.workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  return createProposal({
    workflowId: workflow.id,
    goal: workflowGoal(workflow, run),
    source: `failure-research:${run.id}`,
  });
}

export async function shadowTestProposal(id) {
  const d = ensureStore();
  const proposal = d.proposals.find((entry) => entry.id === id);
  if (!proposal) throw new Error('Proposal not found');
  const workflow = d.workflows.find((entry) => entry.id === proposal.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  if (!proposal.steps?.length) throw new Error('Proposal has no steps to exercise');
  const staticResult = shadowTestPlan({
    steps: proposal.steps || [],
    preflight: proposal.preflight || [],
    confidence: proposal.confidence,
    screenshots: proposal.research?.screenshots || [],
    backups: proposal.backups || [],
    lint: proposal.lint,
  });
  const shadowWorkflow = {
    ...workflow,
    name: `Shadow test — ${workflow.name}`,
    description: proposal.goal || workflow.description || workflow.name,
    status: 'draft',
    failurePolicy: {
      ...(workflow.failurePolicy || {}),
      onFailure: 'stop',
      maxRetries: 0,
      captureScreenshot: false,
      notifyAgent: false,
    },
    steps: (proposal.steps || []).map((step) => ({ ...step, params: { ...(step.params || {}) } })),
  };
  const run = createRun(shadowWorkflow, {
    trigger: 'shadow',
    dryRun: true,
    workflowSnapshot: shadowWorkflow,
    shadowProposalId: proposal.id,
  });
  const finished = await waitForRun(run.id, { timeoutMs: 30000, intervalMs: 100 });
  const steps = finished?.steps || [];
  const passedSteps = steps.filter((step) => step.status === 'passed').length;
  const skippedSteps = steps.filter((step) => step.status === 'skipped').length;
  const failedSteps = steps.filter((step) => step.status === 'failed');
  const timedOut = ['queued', 'running'].includes(finished?.status);
  const simulationOk = finished?.status === 'passed';
  const checks = [
    ...staticResult.checks,
    {
      key: 'simulation',
      ok: simulationOk,
      label: 'Proposal executed in simulated mode',
      detail: `${passedSteps}/${steps.length} steps passed${timedOut ? ' (timed out)' : ''}.`,
    },
  ];
  const failures = [
    ...staticResult.failures,
    ...failedSteps.map((step, index) => ({
      index,
      name: step.name,
      reason: step.error || 'Simulated step failed.',
    })),
  ];
  const result = {
    ok: staticResult.ok && simulationOk,
    status: simulationOk ? 'passed' : timedOut ? 'running' : 'failed',
    noDesktopInput: true,
    runId: run.id,
    runStatus: finished?.status || 'unknown',
    passed: passedSteps,
    total: steps.length,
    skipped: skippedSteps,
    checksPassed: checks.filter((check) => check.ok).length,
    checksTotal: checks.length,
    score: Math.round(((checks.filter((check) => check.ok).length) / checks.length) * 100),
    checks,
    failures,
    warnings: staticResult.warnings,
    testedAt: new Date().toISOString(),
  };
  proposal.shadowTest = result;
  proposal.shadowTests = [...(proposal.shadowTests || []), result].slice(-8);
  persist();
  logActivity(
    'proposal',
    `Shadow test ${result.status} for ${proposal.workflowName}: ${result.passed}/${result.total} steps (no desktop input)`,
    { proposalId: proposal.id, workflowId: proposal.workflowId }
  );
  return { proposal: proposalView(proposal), shadowTest: result };
}
