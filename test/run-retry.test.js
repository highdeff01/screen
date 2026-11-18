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
