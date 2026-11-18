import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-retry-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows can keep a handle on a file that was just renamed into place.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        break;
      } catch (err) {
        if (err.code !== 'EPERM' || attempt === 9) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
      }
    }
  }
});

test('retryRun accepts a valid plan that has no type step', async () => {
  const d = store.db();
  d.settings.dryRun = true;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  const workflow = {
    id: 'wf_retry_probe',
    name: 'Retry probe',
    description: 'Open Notepad, record a note and capture the screen.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_old_focus', type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
      { id: 'stp_old_note', type: 'note', name: 'Old note', params: { text: 'old' } },
    ],
  };
  const original = {
    id: 'run_retry_probe',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'failed',
    trigger: 'manual',
    dryRun: true,
    steps: [
      { ...workflow.steps[0], status: 'failed', attempts: 1, error: 'Window not found.' },
      { ...workflow.steps[1], status: 'skipped', attempts: 0 },
    ],
    evidence: [],
    log: [],
  };
  d.workflows = [workflow];
  d.runs = [original];
  d.recoveryPacks = [];

  let plannedGoal = '';
  const retry = await engine.retryRun(original.id, {
    planner: async (goal, base) => {
      plannedGoal = goal;
      assert.equal(base.steps.length, 0, 'the repair planner starts from a blank plan');
      return {
        source: 'test-planner',
        note: 'Fresh note-and-capture plan.',
        steps: [
          { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
          { type: 'note', name: 'Record the repair', params: { text: 'repaired' } },
          { type: 'screenshot', name: 'Capture the result', params: { caption: 'Repaired' } },
        ],
      };
    },
  });

  assert.match(plannedGoal, /Open Notepad/);
  assert.equal(retry.replanned, true);
  assert.equal(retry.trigger, 'retry-replanned');
  assert.equal(retry.recoveryOf, undefined);
  assert.deepEqual(
    workflow.steps.map((step) => step.type).slice(0, 2),
    ['launchApp', 'wait'],
    'the repaired plan opens the app before its first focus'
  );
  assert.deepEqual(
    workflow.steps.map((step) => step.type).slice(2),
    ['focusWindow', 'note', 'screenshot'],
    'a valid repair plan without a type step must replace the failed plan'
  );
  assert.deepEqual(
    retry.steps.map((step) => step.type).slice(2),
    ['focusWindow', 'note', 'screenshot']
  );
  for (let attempt = 0; attempt < 80 && ['queued', 'running'].includes(retry.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  store.flush();
});

function retryWorkflow(id, pauseBeforeRetryMs = 500) {
  const d = store.db();
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  const workflow = {
    id,
    name: 'Retry coordination',
    description: 'Record a note.',
    status: 'ready',
    failurePolicy: { onFailure: 'retry', maxRetries: 1, pauseBeforeRetryMs },
    steps: [{ id: `${id}_step`, type: 'note', name: 'Record note', params: { text: 'test' } }],
  };
  d.workflows = [workflow];
  d.runs = [];
  return workflow;
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The engine runs one run at a time, so a test that wipes the run list while the
 * previous run is still retrying leaves its own run queued behind it. Wait for
 * the queue to drain before starting (or clearing runs for) the next test.
 */
async function settleQueue(timeoutMs = 15000) {
  await until(
    () => !(store.db().runs || []).some((run) => ['queued', 'running'].includes(run.status)),
    timeoutMs
  );
}

test('cancellation during retry backoff prevents another attempt', async () => {
  await settleQueue();
  const workflow = retryWorkflow('wf_cancel_backoff', 2000);
  let attempts = 0;
  const run = engine.createRun(workflow, {
    dryRun: true,
    probe: { executeStep: async () => { attempts += 1; throw new Error('first attempt failed'); } },
  });
  await until(() => run.log.some((entry) => entry.message.includes('Attempt 1/2 failed')));
  engine.cancelRun(run.id);
  await until(() => run.status === 'cancelled', 1500);
  assert.equal(attempts, 1);
  assert.equal(run.steps[0].attempts, 1);
  assert.equal(run.steps[0].status, 'skipped');
});

test('pause during retry backoff holds the retry until resumed', async () => {
  await settleQueue();
  const workflow = retryWorkflow('wf_pause_backoff', 300);
  let attempts = 0;
  const run = engine.createRun(workflow, {
    dryRun: true,
    probe: { executeStep: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt failed');
      return { output: 'done', evidence: [] };
    } },
  });
  await until(() => run.log.some((entry) => entry.message.includes('Attempt 1/2 failed')));
  engine.controlRun(run.id, 'pause');
  await until(() => run.paused);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(attempts, 1);
  assert.equal(run.status, 'running');
  engine.controlRun(run.id, 'resume');
  await until(() => !['queued', 'running'].includes(run.status));
  assert.equal(attempts, 2);
  assert.equal(run.steps[0].status, 'passed');
  assert.equal(run.retryCount, 1);
});

test('cancellation during a failed attempt does not start a retry', async () => {
  const workflow = retryWorkflow('wf_cancel_attempt');
  let attempts = 0;
  const run = engine.createRun(workflow, {
    dryRun: true,
    probe: { executeStep: async (step, ctx) => {
      attempts += 1;
      engine.cancelRun(ctx.runId);
      throw new Error('failed while cancelling');
    } },
  });
  await until(() => run.status === 'cancelled');
  assert.equal(attempts, 1);
  assert.equal(run.steps[0].status, 'skipped');
});
