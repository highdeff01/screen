import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-run-goal-'));
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

function workflowWith(steps, { name, description }) {
  return {
    id: `wf_run_goal_${name.replace(/\W+/g, '_')}`,
    name,
    description,
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps,
  };
}

function probeFor() {
  const windowFor = ({ title = '', process = '' } = {}) => {
    const label = title || `${process || 'app'} window`;
    return {
      state: 'foreground',
      title: label,
      process,
      matches: [{ title: label, process, state: 'foreground' }],
      foreground: { title: label, process, id: 1 },
    };
  };
  return {
    captureScreenSignature: async () => ({ at: new Date().toISOString(), hash: 'x', cells: [] }),
    inspectWindowState: async (params = {}) => windowFor(params),
    readFocusedElement: async () => ({ found: false }),
    findUiElement: async () => ({ found: false }),
    executeStep: async (step) => ({ output: `did ${step.name}`, evidence: [] }),
  };
}

function quietSettings() {
  const s = store.db().settings;
  s.visualChecks = false;
  s.autoNotes = false;
  s.autoRecoverFailures = false;
  s.presenceEnabled = false;
}

test('a run records the goal check after every step, with the rest of the plan named', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture the first screen', params: {} },
      { id: 's3', type: 'screenshot', name: 'Capture the second screen', params: {} },
    ],
    { name: 'Capture two Chrome screens', description: 'Open Chrome and capture the first and second screens.' }
  );
  store.db().workflows = [workflow];
  const run = engine.createRun(workflow, { dryRun: false, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.status, 'passed');

  const checks = finished.goalChecks || [];
  assert.ok(checks.length >= 3, 'one check per executed step, plus the verdict');
  const afterStep = (id) => checks.find((check) => check.stepId === id);
  for (const id of ['s1', 's2', 's3']) {
    const check = afterStep(id);
    assert.ok(check, `step ${id} has its own goal check`);
    assert.equal(check.trigger, 'command');
    assert.equal(check.runId, finished.id);
    assert.ok(check.goal, 'the check carries the run goal');
    assert.ok(Array.isArray(check.remaining) && Array.isArray(check.wentWrong) && Array.isArray(check.tryNext));
  }

  const first = afterStep('s1');
  assert.equal(first.complete, null, 'one step of three is not the goal');
  assert.ok(
    first.remaining.some((item) => /Capture the second screen/.test(item.text) && /pending/.test(item.text)),
    'what remains names the steps that have not run'
  );
  const second = afterStep('s2');
  assert.ok(
    second.remaining.some((item) => /Capture the second screen/.test(item.text)),
    'the pending tail is still visible one step later'
  );
  assert.equal(second.complete, null);

  assert.equal(finished.goalCheck.complete, true, 'the settled run can say the goal was reached');
  assert.equal(finished.goalCheck.stepName, '', 'the verdict check belongs to the run, not a step');

  const summary = engine.summary(finished);
  assert.ok(summary.goalCheck, 'the run summary carries the latest check');
  assert.equal(summary.goalCheck.status, 'complete');
  assert.equal(summary.goalChecks, undefined, 'the trace stays out of the polled summary');
});

test('a failed step records what went wrong and what is still pending', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 'f1', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 'f2', type: 'screenshot', name: 'Save the profile', params: {} },
      { id: 'f3', type: 'screenshot', name: 'Capture the second screen', params: {} },
    ],
    {
      name: 'Save a profile in Chrome',
      description: 'Open Chrome, save the profile, and capture the second screen.',
    }
  );
  store.db().workflows = [workflow];
  const probe = probeFor();
  probe.executeStep = async (step) => {
    if (step.id === 'f2') throw new Error('the Save button never appeared');
    return { output: `did ${step.name}`, evidence: [] };
  };
  const run = engine.createRun(workflow, { dryRun: false, probe });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });

  const failed = (finished.goalChecks || []).find((check) => check.stepId === 'f2');
  assert.ok(failed, 'the failed step has its own check');
  assert.equal(failed.status, 'incomplete');
  assert.equal(failed.complete, false);
  assert.equal(failed.stepStatus, 'failed');
  assert.ok(
    failed.wentWrong.some((item) => /Save button never appeared/.test(item.detail || '')),
    'the check says what went wrong, while the run is still going'
  );
  assert.equal(
    failed.wentWrong.filter((item) => /Save the profile/.test(item.what || '')).length,
    1,
    'the failure is listed once, not as both a command and a step'
  );
  assert.ok(
    failed.remaining.some((item) => /Capture the second screen/.test(item.text)),
    'and what the plan has not reached yet'
  );
  assert.equal(finished.goalCheck.complete, false, 'the settled failed run stays uncompromised');
});

test('the verdict check is recorded after a passing run flips to review', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 'v1', type: 'screenshot', name: 'Capture the first screen', params: {} },
      { id: 'v2', type: 'screenshot', name: 'Capture the second screen', params: {} },
    ],
    { name: 'Play a video in VLC', description: 'Open VLC and play a video.' }
  );
  store.db().workflows = [workflow];
  // Every step passes, but nothing in the run ever touched VLC: the presenter
  // withholds the goal and the finish path sends the run to review after the
  // steps are already done.
  const run = engine.createRun(workflow, { dryRun: false, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });

  assert.equal(finished.status, 'needs_review', 'all steps passed, but the app the goal names was never verified');
  assert.equal(finished.goalCheck.complete, false, 'the verdict check reads the status the run actually ended with');
  assert.equal(finished.goalCheck.status, 'incomplete');
  assert.equal(finished.goalCheck.stepName, '', 'the verdict check belongs to the run, not a step');
  assert.ok(
    finished.goalCheck.wentWrong.some((item) => /needs review/i.test(item.what || '')),
    'the check says the run went to review instead of claiming the goal was reached'
  );
  for (const check of (finished.goalChecks || []).filter((item) => item.stepId)) {
    assert.equal(check.complete, null, 'a passing step of the plan is not the goal');
  }
});
