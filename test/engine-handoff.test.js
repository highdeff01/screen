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

// The suite runs two test files at once, and a live run waits on the desktop
// and the disk. These budgets leave real headroom instead of assuming an idle
// machine; they bound a hang, they do not hide one.
test('a live run runs the declared hand-off steps after its verdict', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_live', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];

  const run = engine.createRun(wf, { dryRun: false, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

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

test('a live run that will hand back records the start screen before its steps', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_start', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];
  const probe = stubProbe();
  const reads = [];
  probe.readScreenContext = async () => ({
    foreground: { title: 'Sightline Profile', process: 'pythonw', handle: 4242 },
    windows: [],
  });
  probe.findUiElementByOcr = async (query) => {
    reads.push(query);
    return {
      found: false,
      labels: ['Sightline Profile', 'Open Settings to edit your profile.', 'Settings'],
      title: 'Sightline Profile',
    };
  };

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

  assert.equal(finished.status, 'passed');
  assert.ok(finished.startScreen, 'the start screen is on the run');
  assert.equal(finished.startScreen.window.title, 'Sightline Profile');
  assert.equal(finished.startScreen.window.handle, 4242);
  assert.equal(finished.startScreen.label, 'Open Settings to edit your profile.');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].labelsOnly, true, 'one label read, not a control lookup');
  assert.deepEqual(probe.executed, ['note'], 'recording the start screen executes nothing');
  const messages = (finished.log || []).map((line) => String(line.message || ''));
  assert.ok(messages.some((message) => /Start screen: “Open Settings to edit your profile\.”/.test(message)));
});

test('a simulated run never runs the hand-off', async () => {
  const d = resetDb();
  const wf = workflow('wf_handoff_simulated', { enabled: true, steps: RESTORE_STEPS });
  d.workflows = [wf];

  const run = engine.createRun(wf, { dryRun: true, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

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
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

  assert.equal(finished.status, 'passed');
  assert.deepEqual(probe.executed, ['note'], 'only the proof step was executed');
  assert.equal(finished.handoff ?? null, null, 'the probe run recorded no hand-off');
  assert.equal(finished.handoffPending ?? false, false);
  assert.deepEqual(handoffLog(finished), [], 'the run log never claims a hand-off');
});

test('a hand-off click honours skipIfVisible: it logs a skip and never clicks the lookalike heading', async () => {
  resetDb();
  const wf = workflow('wf_handoff_skip', {
    enabled: true,
    steps: [
      {
        type: 'clickElement',
        name: 'Return to Settings',
        params: { window: 'Sightline Profile', name: 'Settings', skipIfVisible: 'Notifications' },
      },
      { type: 'move', name: 'Park the cursor on Notifications', params: { x: 195, y: 318 } },
    ],
  });
  const run = {
    id: 'run_handoff_skip',
    workflowId: wf.id,
    workflowName: wf.name,
    status: 'passed',
    dryRun: false,
    shadow: false,
    steps: [],
    log: [],
    visualWarnings: [],
    handoffPending: false,
  };
  const executed = [];
  const checked = [];

  await engine.runHandoff(run, wf, {
    execute: async (step) => {
      executed.push(step.name);
      return { output: `${step.type} ok` };
    },
    skipCheck: async (step, _probe, checkedRun) => {
      checked.push({ name: step.name, run: checkedRun === run });
      return step.params?.skipIfVisible
        ? `“${step.params.skipIfVisible}” is already visible in “${step.params.window}”; the screen this click opens is already showing, so the click was skipped.`
        : '';
    },
  });

  assert.deepEqual(executed, ['Park the cursor on Notifications'], 'the lookalike click never runs');
  assert.deepEqual(checked.map((entry) => entry.name), ['Return to Settings', 'Park the cursor on Notifications']);
  assert.ok(checked.every((entry) => entry.run), 'every hand-off step is checked against this run');
  assert.equal(run.handoff.steps[0].skipped, true);
  assert.equal(run.handoff.steps[0].ok, true);
  assert.match(run.handoff.steps[0].output, /already visible/);
  assert.equal(run.handoff.steps[1].ok, true);
  assert.equal(run.handoff.steps[1].skipped, undefined);
  assert.equal(run.handoff.ok, true, 'a skip is a completed hand-off, not a failure');
  assert.equal(run.handoffPending, false);
  assert.ok(
    run.log.some((line) => /Hand-off: skipped “Return to Settings” — “Notifications” is already visible/.test(line.message)),
    'the skip is logged'
  );
});

test('the skip check never blocks a hand-off step it does not know', async () => {
  resetDb();
  const wf = workflow('wf_handoff_plain', { enabled: true, steps: RESTORE_STEPS });
  const run = {
    id: 'run_handoff_plain',
    workflowId: wf.id,
    workflowName: wf.name,
    status: 'passed',
    dryRun: false,
    shadow: false,
    steps: [],
    log: [],
    visualWarnings: [],
    handoffPending: false,
  };
  const executed = [];
  await engine.runHandoff(run, wf, {
    execute: async (step) => {
      executed.push(step.name);
      return { output: `${step.type} ok` };
    },
    skipCheck: async () => '',
  });

  assert.deepEqual(executed, RESTORE_STEPS.map((step) => step.name), 'both declared steps ran');
  assert.equal(run.handoff.steps.every((step) => step.ok === true && !step.skipped), true);
});

test('a run with no declared hand-off gets a drafted reverse and executes nothing', async () => {
  const d = resetDb();
  const wf = {
    id: 'wf_handoff_draft',
    name: 'Draft a hand-off',
    description: 'Click Settings, declare no hand-off.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      {
        id: 'stp_click_settings',
        type: 'clickElement',
        name: 'Click Settings',
        params: { window: 'Sightline Profile', name: 'Settings', skipIfVisible: 'Notifications' },
        timeoutMs: 5000,
      },
    ],
    handoff: { enabled: false, steps: [] },
  };
  d.workflows = [wf];
  const probe = stubProbe();
  const asked = [];
  probe.findUiElementByOcr = async ({ name, names }) => {
    asked.push({ name, names });
    if (names) return { found: true, text: 'Back', x: 40, y: 60, method: 'OCR' };
    return { found: false, reason: 'not visible' };
  };

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

  assert.equal(finished.status, 'passed');
  assert.equal(finished.handoff ?? null, null, 'no hand-off was run');
  const suggestion = finished.handoffSuggestion;
  assert.ok(suggestion, 'the run carries a draft hand-off');
  assert.equal(suggestion.complete, true);
  assert.equal(suggestion.stepName, 'Click Settings');
  assert.deepEqual(suggestion.steps.map((step) => step.type), ['clickElement']);
  assert.deepEqual(suggestion.steps[0].params, { window: 'Sightline Profile', name: 'Back' });
  assert.deepEqual(probe.executed, ['clickElement'], 'only the proof step ran; the draft was never executed');
  assert.ok(asked.some((entry) => Array.isArray(entry.names) && entry.names.includes('Back')), 'the end screen was read for a back control');
  assert.ok(
    (finished.log || []).some((line) => /Hand-off draft: The end screen .* shows “Back”/.test(String(line.message || ''))),
    'the draft is logged as a proposal'
  );
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
  const finished = await engine.waitForRun(run.id, { timeoutMs: 90000, intervalMs: 20 });

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
