import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-recovery-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const recovery = await load('server/run-recovery.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function fixture() {
  const workflow = {
    id: 'wf_closed_app',
    name: 'Closed app recovery probe',
    description: 'Open Kiro and ask "What is a diamond?" then save the answer to Notepad.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_focus_kiro', type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' }, timeoutMs: 10000 },
      { id: 'stp_type', type: 'type', name: 'Ask Kiro', params: { text: 'What is a diamond?', foreground: 'Kiro' }, timeoutMs: 10000 },
    ],
  };
  const run = {
    id: 'run_closed_app',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'failed',
    trigger: 'manual',
    dryRun: false,
    steps: [
      { id: 'stp_focus_kiro', type: 'focusWindow', name: 'Focus Kiro', status: 'failed', error: 'No window matching title "Kiro" or process "".' },
      { id: 'stp_type', type: 'type', name: 'Ask Kiro', status: 'skipped' },
    ],
    evidence: [],
    log: [],
  };
  return { workflow, run };
}

test('a closed app gets an open prerequisite and a five-stage recovery pack', async () => {
  const { workflow, run } = fixture();
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.recoveryPacks = [];
  const plannerSteps = [
    { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
    { type: 'type', name: 'Ask Kiro', params: { text: 'What is a diamond?', foreground: 'Kiro' } },
  ];
  const outcome = await recovery.prepareRecovery(run, {
    plan: async () => ({ steps: plannerSteps, confidence: 0.9, note: 'test planner' }),
  });
  assert.ok(outcome?.pack);
  assert.equal(outcome.pack.stages.length, 5);
  assert.equal(outcome.pack.selectedCandidateId, 'candidate_targeted');
  assert.ok(outcome.selected.steps.some((step) => step.type === 'launchApp' && step.params.target === 'Kiro'));
  assert.ok(outcome.retryWorkflow.steps.some((step) => step.type === 'launchApp'));
  assert.equal(workflow.steps.some((step) => step.type === 'launchApp'), false, 'saved workflow stays untouched until the retry passes');
  assert.ok(outcome.pack.logs.some((entry) => entry.level === 'info'));
  assert.ok(outcome.pack.candidates.every((candidate) => candidate.test && typeof candidate.test.ok === 'boolean'));

  const retry = {
    id: 'run_recovery_retry',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'passed',
    recoveryPackId: outcome.pack.id,
    steps: outcome.selected.steps.map((step) => ({ ...step, status: 'passed' })),
    evidence: [],
  };
  d.runs.push(retry);
  const finalized = recovery.finalizeRecoveryPack(retry);
  assert.equal(finalized.status, 'passed');
  assert.equal(finalized.incorporated, true);
  assert.equal(run.recovered, true);
  assert.ok(workflow.steps.some((step) => step.type === 'launchApp'));
  store.flush();
});

test('ensureOpenPrerequisites fixes a fresh plan that starts with focusWindow', () => {
  const steps = recovery.ensureOpenPrerequisites([
    { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
    { type: 'type', name: 'Ask Kiro', params: { text: 'hello', foreground: 'Kiro' } },
  ]);
  assert.deepEqual(
    steps.slice(0, 3).map((step) => step.type),
    ['launchApp', 'waitFor', 'focusWindow']
  );
  assert.equal(steps.filter((step) => step.type === 'launchApp').length, 1);
});

test('a missing tool is not mistaken for a closed app', async () => {
  const d = store.db();
  const workflow = {
    id: 'wf_tool_failure',
    name: 'Tool failure probe',
    description: 'Run the missing tool.',
    status: 'ready',
    steps: [{ id: 'stp_tool', type: 'runTool', name: 'Run missing tool', params: { toolId: 'tool_missing' } }],
  };
  const run = {
    id: 'run_tool_failure',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'failed',
    trigger: 'manual',
    steps: [{ id: 'stp_tool', type: 'runTool', name: 'Run missing tool', status: 'failed', error: 'Tool not found: tool_missing' }],
    evidence: [],
  };
  d.workflows = [workflow];
  d.runs = [run];
  d.recoveryPacks = [];
  const outcome = await recovery.prepareRecovery(run, {
    plan: async () => ({
      steps: [{ type: 'runTool', name: 'Run missing tool', params: { toolId: 'tool_missing' } }],
      confidence: 0.8,
    }),
  });
  assert.ok(outcome?.pack);
  assert.equal(outcome.pack.candidates.some((candidate) => candidate.id === 'candidate_targeted'), false);
  assert.equal(outcome.pack.selectedCandidateId, 'candidate_fresh');
  store.flush();
});

test('a stuck planning pack is downgraded without approving a retry', () => {
  const d = store.db();
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  d.runs = [{ id: 'run_stuck_planning', status: 'failed', recovery: { packId: 'rcp_stuck', status: 'planning' } }];
  d.recoveryPacks = [
    {
      id: 'rcp_stuck',
      status: 'planning',
      originalRunId: 'run_stuck_planning',
      candidates: [],
      logs: [],
      createdAt: old,
      updatedAt: old,
      retryRunId: null,
    },
  ];
  assert.equal(recovery.reconcileStuckRecoveryPacks({ staleMs: 1000 }), true);
  assert.equal(d.recoveryPacks[0].status, 'needs_review');
  assert.equal(d.runs[0].recovery.status, 'needs_review');
  assert.equal(d.recoveryPacks[0].retryRunId, null);
  assert.match(d.recoveryPacks[0].logs[0].message, /No retry was approved/);
  assert.equal(recovery.reconcileStuckRecoveryPacks({ staleMs: 1000 }), false);
  store.flush();
});