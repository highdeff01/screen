import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-focus-launch-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('a workflow that starts with focusWindow gets a launch prerequisite', async () => {
  const d = store.db();
  d.settings.dryRun = true;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  const workflow = {
    id: 'wf_focus_launch_probe',
    name: 'Focus launch probe',
    description: 'Ask Chrome a question.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      {
        id: 'stp_focus_chrome',
        type: 'focusWindow',
        name: 'Focus Chrome',
        params: { title: 'Sightline - screen agent console - Google Chrome' },
        timeoutMs: 10000,
      },
      { id: 'stp_ask', type: 'type', name: 'Ask Chrome', params: { text: 'hello', foreground: 'Chrome' }, timeoutMs: 10000 },
    ],
  };
  d.workflows = [workflow];
  d.runs = [];
  d.recoveryPacks = [];

  const run = engine.createRun(workflow, { dryRun: true });
  const types = workflow.steps.map((step) => step.type);
  assert.deepEqual(types.slice(0, 3), ['launchApp', 'wait', 'focusWindow']);
  assert.equal(workflow.steps[0].params.target, 'chrome.exe');
  assert.equal(workflow.steps[2].params.process, 'chrome');
  assert.deepEqual(run.steps.map((step) => step.type).slice(0, 3), ['launchApp', 'wait', 'focusWindow']);

  for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  store.flush();
});

const recovery = await load('server/run-recovery.js');
const planner = await load('server/planner.js');

async function settleRun(run) {
  for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function probeWorkflow(id, name, steps) {
  return {
    id,
    name,
    description: 'Launch repair probe.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: steps.map((step, index) => ({ id: `stp_${id}_${index}`, timeoutMs: 10000, ...step })),
  };
}

function freshProbeDb() {
  const d = store.db();
  d.settings.dryRun = true;
  d.settings.autoNotes = false;
  d.settings.visualChecks = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.activity = [];
  d.runs = [];
  return d;
}

test('a workflow that does not start with focusWindow is left unchanged', async () => {
  const d = freshProbeDb();
  const workflow = probeWorkflow('wf_launch_first_probe', 'Launch first probe', [
    { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    { type: 'wait', name: 'Wait for Notepad', params: { ms: 200 } },
    { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
  ]);
  const before = JSON.parse(JSON.stringify(workflow.steps));
  d.workflows = [workflow];

  assert.deepEqual(recovery.ensureLeadingFocusLaunch(workflow.steps), before, 'the helper must not prepend to a plan that opens the app itself');
  assert.deepEqual(workflow.steps, before, 'the helper must not mutate its input');

  const run = engine.createRun(workflow, { dryRun: true });
  assert.deepEqual(workflow.steps, before, 'createRun must not rewrite a plan that already launches first');
  assert.deepEqual(run.steps.map((step) => step.id), before.map((step) => step.id));
  assert.equal(workflow.steps[2].params.process, undefined, 'the focus step must not gain a process fallback');
  assert.equal(
    d.activity.some((entry) => /launch prerequisite/i.test(entry.message || '')),
    false,
    'no repair activity should be logged for an untouched plan'
  );

  await settleRun(run);
  store.flush();
});

test('an already repaired plan does not get a second launch step', async () => {
  const d = freshProbeDb();
  const workflow = probeWorkflow('wf_repaired_probe', 'Repaired probe', [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
    { type: 'wait', name: 'Wait for Chrome', params: { ms: 2000 } },
    {
      type: 'focusWindow',
      name: 'Focus Chrome',
      params: { title: 'Sightline - screen agent console - Google Chrome', process: 'chrome' },
    },
    { type: 'type', name: 'Ask Chrome', params: { text: 'hello', foreground: 'Chrome' } },
  ]);
  const before = JSON.parse(JSON.stringify(workflow.steps));
  d.workflows = [workflow];

  assert.deepEqual(recovery.ensureLeadingFocusLaunch(workflow.steps), before, 'a repaired plan must pass through untouched');
  assert.deepEqual(
    recovery.ensureLeadingFocusLaunch(recovery.ensureLeadingFocusLaunch(workflow.steps)),
    before,
    'reapplying the repair must be idempotent'
  );

  const run = engine.createRun(workflow, { dryRun: true });
  assert.deepEqual(workflow.steps, before, 'the repaired plan must not be rewritten');
  assert.equal(workflow.steps.filter((step) => step.type === 'launchApp').length, 1, 'one launch in the workflow');
  assert.equal(run.steps.filter((step) => step.type === 'launchApp').length, 1, 'one launch in the queued run');
  assert.deepEqual(run.steps.map((step) => step.type).slice(0, 3), ['launchApp', 'wait', 'focusWindow']);

  await settleRun(run);
  store.flush();
});

test('createRun repairs a plan whose first app step is not the first step', async () => {
  const d = freshProbeDb();
  const workflow = probeWorkflow('wf_late_focus_probe', 'Late focus probe', [
    { type: 'note', name: 'Record intent', params: { text: 'open notepad' } },
    { type: 'wait', name: 'Settle', params: { ms: 300 } },
    { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
  ]);
  d.workflows = [workflow];

  const run = engine.createRun(workflow, { dryRun: true });

  assert.deepEqual(workflow.steps.map((step) => step.type), ['note', 'wait', 'launchApp', 'wait', 'focusWindow']);
  assert.equal(workflow.steps[2].params.target, 'notepad.exe');
  assert.equal(workflow.steps[4].params.process, 'Notepad');
  assert.deepEqual(run.steps.map((step) => step.type), ['note', 'wait', 'launchApp', 'wait', 'focusWindow']);

  await settleRun(run);
  store.flush();
});

test('planSteps applies the launch prerequisite to the plan it returns', async () => {
  const result = await planner.planSteps('ask chrome a question', null, {
    planBuilder: async () => ({
      ok: true,
      source: 'probe',
      steps: [
        { type: 'focusWindow', name: 'Focus Chrome', params: { title: 'Google Chrome' }, timeoutMs: 10000 },
        { type: 'type', name: 'Ask', params: { text: 'hello' }, timeoutMs: 10000 },
      ],
    }),
    isAppRunning: () => false,
  });

  assert.equal(result.source, 'probe');
  assert.deepEqual(result.steps.map((step) => step.type), ['launchApp', 'wait', 'focusWindow', 'type']);
  assert.equal(result.steps[0].params.target, 'chrome.exe');
});

test('planning adds a launch and settle when the target app is not running', async () => {
  const plan = [
    {
      type: 'focusWindow',
      name: 'Focus Chrome',
      params: { title: 'Sightline - screen agent console - Google Chrome' },
      timeoutMs: 10000,
    },
    { type: 'type', name: 'Ask Chrome', params: { text: 'hello', foreground: 'Chrome' }, timeoutMs: 10000 },
  ];

  const prepared = await planner.ensurePlanLaunch(plan, { isAppRunning: () => false });

  assert.deepEqual(prepared.map((step) => step.type), ['launchApp', 'wait', 'focusWindow', 'type']);
  assert.equal(prepared[0].params.target, 'chrome.exe');
  assert.equal(prepared[1].params.ms, 2000);
  assert.equal(prepared[2].params.process, 'chrome');
  assert.deepEqual(plan.map((step) => step.type), ['focusWindow', 'type'], 'the input plan must not be mutated');
});

test('planning leaves the plan alone when the target app is already running', async () => {
  let probes = 0;
  const plan = [
    { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' }, timeoutMs: 10000 },
    { type: 'type', name: 'Type note', params: { text: 'hello' }, timeoutMs: 10000 },
  ];

  const prepared = await planner.ensurePlanLaunch(plan, {
    isAppRunning: () => {
      probes += 1;
      return true;
    },
  });

  assert.equal(probes, 1, 'the running state is checked once');
  assert.deepEqual(prepared, plan);
});

test('planning does not add a second launch to a plan that already opens the app', async () => {
  const plan = [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' }, timeoutMs: 30000 },
    { type: 'wait', name: 'Wait for Chrome', params: { ms: 2000 }, timeoutMs: 5000 },
    { type: 'focusWindow', name: 'Focus Chrome', params: { title: 'Google Chrome' }, timeoutMs: 10000 },
  ];

  const prepared = await planner.ensurePlanLaunch(plan, { isAppRunning: () => false });

  assert.equal(prepared.filter((step) => step.type === 'launchApp').length, 1);
  assert.deepEqual(prepared.map((step) => step.type), ['launchApp', 'wait', 'focusWindow']);
});

test('planning inserts the launch before the first app step, not only at the top', async () => {
  const plan = [
    { type: 'note', name: 'Record intent', params: { text: 'open notepad' }, timeoutMs: 5000 },
    { type: 'wait', name: 'Settle', params: { ms: 300 }, timeoutMs: 5000 },
    { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' }, timeoutMs: 10000 },
  ];

  const prepared = await planner.ensurePlanLaunch(plan, { isAppRunning: () => false });

  assert.deepEqual(prepared.map((step) => step.type), ['note', 'wait', 'launchApp', 'wait', 'focusWindow']);
  assert.equal(prepared[2].params.target, 'notepad.exe');
});

test('a planning result carries the launch prerequisite to the saved plan', async () => {
  const result = {
    ok: true,
    source: 'heuristic',
    steps: [{ type: 'focusWindow', name: 'Focus Edge', params: { title: 'Microsoft Edge' }, timeoutMs: 10000 }],
  };

  const prepared = await planner.preparePlanForLaunch(result, { isAppRunning: () => false });
  assert.equal(prepared.source, 'heuristic');
  assert.deepEqual(prepared.steps.map((step) => step.type), ['launchApp', 'wait', 'focusWindow']);
  assert.equal(prepared.steps[0].params.target, 'msedge.exe');

  const unchanged = await planner.preparePlanForLaunch(result, { isAppRunning: () => true });
  assert.equal(unchanged, result, 'a running app must return the plan untouched');
});