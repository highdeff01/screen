import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-engine-parallel-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function resetDb(overrides = {}) {
  const d = store.db();
  d.settings.dryRun = true;
  d.settings.parallelRuns = 2;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.agentReplans = false;
  d.settings.aiSuggestions = false;
  d.settings.visualChecks = false;
  d.settings.presenterSettleMs = 0;
  d.settings.presenceEnabled = false;
  d.settings.recheck = { enabled: false, continueAfter: false };
  d.settings.stepThink = { enabled: false };
  d.workflows = [];
  d.runs = [];
  Object.assign(d.settings, overrides);
  return d;
}

function workflow(id) {
  return {
    id,
    name: `Parallel ${id}`,
    description: 'Record a note.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: `stp_${id}`, type: 'note', name: 'Record the note', params: { text: id }, timeoutMs: 5000 }],
  };
}

test('the scheduler fills free slots but never lets two live runs share the desk', () => {
  const queued = [
    { id: 'live-a', live: true },
    { id: 'sim-b', live: false },
    { id: 'live-c', live: true },
    { id: 'sim-d', live: false },
  ];
  const isLive = (entry) => entry.live;
  assert.deepEqual(
    engine.startableRuns({ queued, limit: 3, isLive }).map((entry) => entry.id),
    ['live-a', 'sim-b', 'sim-d'],
    'the first live run takes the desk; the later live run waits'
  );
  assert.deepEqual(
    engine.startableRuns({ queued, limit: 3, deskHeld: true, isLive }).map((entry) => entry.id),
    ['sim-b', 'sim-d'],
    'a held desk only blocks live runs'
  );
  assert.deepEqual(
    engine.startableRuns({ queued, runningIds: ['x'], limit: 2, isLive }).map((entry) => entry.id),
    ['live-a'],
    'an occupied slot is not handed out twice'
  );
  assert.deepEqual(engine.startableRuns({ queued, runningIds: ['x', 'y'], limit: 2, isLive }), []);
});

test('the run limit is clamped and defaults to three', () => {
  const d = resetDb({ parallelRuns: 99 });
  assert.equal(engine.parallelRunLimit(), 6);
  d.settings.parallelRuns = 2;
  assert.equal(engine.parallelRunLimit(), 2);
  d.settings.parallelRuns = 0;
  assert.equal(engine.parallelRunLimit(), 1, 'below the range is held at one');
  d.settings.parallelRuns = undefined;
  assert.equal(engine.parallelRunLimit(), 3, 'an unset value keeps the default');
  d.settings.parallelRuns = 1;
  assert.equal(engine.parallelRunLimit(), 1, 'one restores the old one-at-a-time behaviour');
});

test('raising the limit starts the runs that were waiting for a slot', { timeout: 30000 }, async () => {
  const d = resetDb({ parallelRuns: 1 });
  const wfA = workflow('wf_slot_a');
  const wfB = workflow('wf_slot_b');
  d.workflows = [wfA, wfB];

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const probe = (tag) => ({
    async executeStep() {
      await gate;
      return { output: `${tag} done`, evidence: [] };
    },
    async captureScreenSignature() {
      return { at: new Date().toISOString(), cells: [] };
    },
  });

  const runA = engine.createRun(wfA, { dryRun: true, probe: probe('A'), repair: false, aiReplan: false });
  const runB = engine.createRun(wfB, { dryRun: true, probe: probe('B'), repair: false, aiReplan: false });
  await sleep(80);
  assert.equal(engine.findRun(runA.id)?.status, 'running', 'the only slot went to the first run');
  assert.equal(engine.findRun(runB.id)?.status, 'queued', 'the second run waits for a slot');

  d.settings.parallelRuns = 2;
  engine.resumeQueue();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && engine.findRun(runB.id)?.status !== 'running') await sleep(20);
  release();

  const [doneA, doneB] = await Promise.all([
    engine.waitForRun(runA.id, { timeoutMs: 20000, intervalMs: 20 }),
    engine.waitForRun(runB.id, { timeoutMs: 20000, intervalMs: 20 }),
  ]);
  assert.equal(doneA.status, 'passed');
  assert.equal(doneB.status, 'passed', 'the waiting run started once the limit was raised');
});

test('two simulated workflows are in flight at the same time', { timeout: 30000 }, async () => {
  const d = resetDb();
  const wfA = workflow('wf_parallel_a');
  const wfB = workflow('wf_parallel_b');
  d.workflows = [wfA, wfB];

  // Both runs block inside their first step until this gate opens, so the only
  // way both can be running at once is a scheduler that started them together.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = [];
  const probe = (tag) => ({
    async executeStep(step) {
      entered.push({ tag, step: step.id });
      await gate;
      return { output: `${tag} done`, evidence: [] };
    },
    async captureScreenSignature() {
      return { at: new Date().toISOString(), cells: [] };
    },
  });

  const runA = engine.createRun(wfA, { dryRun: true, probe: probe('A'), repair: false, aiReplan: false });
  const runB = engine.createRun(wfB, { dryRun: true, probe: probe('B'), repair: false, aiReplan: false });

  let overlap = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const a = engine.findRun(runA.id);
    const b = engine.findRun(runB.id);
    if (a?.status === 'running' && b?.status === 'running') {
      overlap = true;
      break;
    }
    await sleep(20);
  }
  release();

  const [doneA, doneB] = await Promise.all([
    engine.waitForRun(runA.id, { timeoutMs: 20000, intervalMs: 20 }),
    engine.waitForRun(runB.id, { timeoutMs: 20000, intervalMs: 20 }),
  ]);

  assert.equal(overlap, true, 'both workflows were running at the same time');
  assert.equal(doneA.status, 'passed');
  assert.equal(doneB.status, 'passed');
  assert.deepEqual(entered.map((entry) => entry.tag).sort(), ['A', 'B']);
});
