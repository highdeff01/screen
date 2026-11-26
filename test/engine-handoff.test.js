import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-engine-handoff-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function resetDb() {
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.agentReplans = false;
  d.settings.aiSuggestions = false;
  d.settings.visualChecks = false;
  d.settings.presenterSettleMs = 0;
  d.settings.presenceEnabled = false;
  d.settings.stepThink = { enabled: false };
  d.settings.recheck = { enabled: false, continueAfter: false };
  d.workflows = [];
  d.runs = [];
  return d;
}

// The proof itself only records a note, so a live run here exercises the engine
// without driving the desktop; the hand-off steps are ordinary steps too.
function workflow(id, handoff) {
  return {
    id,
    name: 'Hand-off after a live proof',
    description: 'Record the result, then hand the desktop back.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_note', type: 'note', name: 'Record the result', params: { text: 'done' }, timeoutMs: 5000 }],
    handoff,
  };
}

const RESTORE_STEPS = [
  { type: 'note', name: 'Return to the hand-off screen', params: { text: 'back on Settings' } },
  { type: 'note', name: 'Park the cursor on Notifications', params: { text: 'on Notifications' } },
];

function stubProbe() {
  return {
    executed: [],
    async executeStep(step) {
      this.executed.push(step.type);
      return { output: `${step.type} ok`, evidence: [] };
    },
    async captureScreenSignature() {
      return { at: new Date().toISOString(), cells: [] };
    },
    async inspectWindowState() {
      return { state: 'foreground', foreground: { title: '' }, matches: [], requested: '' };
    },
    async readFocusedElement() {
      return { found: true, name: 'the control', window: '' };
    },
    async findUiElement() {
      return { found: false };
    },
  };
}

function handoffLog(run) {
  return (run.log || []).filter((line) => /^Hand-off/.test(String(line.message || '')));
}

test('a live run runs the declared hand-off steps after its verdict', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_live', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];

  const run = engine.createRun(wf, { dryRun: false, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });

  assert.equal(finished.dryRun, false, 'the live run was not downgraded to a simulation');
  assert.equal(finished.status, 'passed');
  assert.ok(finished.handoff, 'the declared hand-off ran');
  assert.equal(finished.handoff.ok, true);
  assert.deepEqual(
    finished.handoff.steps.map((step) => step.name),
    ['Return to the hand-off screen', 'Park the cursor on Notifications']
  );
  assert.ok(finished.handoff.steps.every((step) => step.ok), 'both declared steps completed');
  assert.match(finished.handoff.steps[0].output, /back on Settings/);
  assert.ok(finished.handoff.finishedAt, 'the hand-off records when it finished');
  assert.equal(finished.handoffPending, false, 'nothing is left pending');
  assert.equal(finished.steps.length, 1, 'hand-off steps are not part of the run’s proof steps');

  const messages = (finished.log || []).map((line) => String(line.message || ''));
  const verdictAt = messages.findIndex((message) => /Run finished: passed/.test(message));
  const handoffAt = messages.findIndex((message) => /Hand-off: returning to the hand-off screen/i.test(message));
  assert.ok(verdictAt >= 0, 'the verdict is logged');
  assert.ok(handoffAt > verdictAt, 'the hand-off runs after the verdict is recorded');
});

test('a simulated run never runs the hand-off', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_simulated', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];

  const run = engine.createRun(wf, { dryRun: true, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });

  assert.equal(finished.dryRun, true, 'the run stayed simulated');
  assert.equal(finished.status, 'passed');
  assert.equal(finished.handoff ?? null, null, 'no hand-off was recorded');
  assert.equal(finished.handoffPending ?? false, false);
  assert.deepEqual(handoffLog(finished), [], 'the run log never claims a hand-off');
});

test('a probe run never runs the hand-off', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_probe', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];
  const probe = stubProbe();

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });

  assert.equal(finished.status, 'passed');
  assert.deepEqual(probe.executed, ['note'], 'only the proof step was executed');
  assert.equal(finished.handoff ?? null, null, 'the probe run recorded no hand-off');
  assert.equal(finished.handoffPending ?? false, false);
  assert.deepEqual(handoffLog(finished), [], 'the run log never claims a hand-off');
});

test('a failing hand-off step is reported but never changes the verdict', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_failure', {
    enabled: true,
    steps: [
      // A live write with no text fails inside the step itself, after the verdict.
      { type: 'writeNote', name: 'Write the hand-off note', params: {} },
      { type: 'note', name: 'Park the cursor on Notifications', params: { text: 'on Notifications' } },
    ],
  });
  d.workflows = [wf];

  const run = engine.createRun(wf, { dryRun: false, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });

  assert.equal(finished.dryRun, false, 'the live run was not downgraded to a simulation');
  assert.equal(finished.status, 'passed', 'the verdict stands: the hand-off is best-effort');
  assert.equal(finished.steps[0].status, 'passed', 'the proof step itself passed');
  assert.ok(finished.handoff, 'the hand-off is still recorded');
  assert.equal(finished.handoff.ok, false, 'the failure is visible on the hand-off');
  assert.equal(finished.handoff.steps[0].ok, false);
  assert.match(String(finished.handoff.steps[0].error || ''), /needs text/i);
  assert.equal(finished.handoff.steps[1].ok, true, 'later hand-off steps still get their turn');
  assert.equal(finished.handoffPending, false, 'a failed step never leaves the hand-off pending');
  assert.ok(
    (finished.log || []).some(
      (line) => line.level === 'warn' && /Hand-off step “Write the hand-off note” did not complete/.test(line.message)
    ),
    'the run log warns about the failed step'
  );
  assert.ok(
    !(finished.log || []).some((line) => /Run finished: failed/.test(String(line.message || ''))),
    'the verdict was not rewritten'
  );
});
