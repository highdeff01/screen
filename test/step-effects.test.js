import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  expectsScreenChange,
  windowChecksFor,
  resumePlan,
  resumeSteps,
  resumeRecoveryPlan,
  carryForwardPassedEffects,
  repeatsSideEffect,
  corroboratesNoChange,
  lookupWindowFor,
} from '../server/step-effects.js';

test('typing, clicking and mutating keys must change the screen', () => {
  assert.equal(expectsScreenChange({ type: 'type', params: { text: 'python' } }), true);
  assert.equal(expectsScreenChange({ type: 'type', params: { text: '   ' } }), false);
  assert.equal(expectsScreenChange({ type: 'type', params: { textVar: 'answer' } }), true);
  assert.equal(expectsScreenChange({ type: 'click', params: { name: 'Search' } }), true);
  assert.equal(expectsScreenChange({ type: 'key', params: { keys: 'Enter' } }), true);
  assert.equal(expectsScreenChange({ type: 'key', params: { keys: ['Control', 'A'] } }), true);
});

test('copy and select-all are not expected to repaint the screen', () => {
  assert.equal(expectsScreenChange({ type: 'key', params: { keys: '^c' } }), false);
  assert.equal(expectsScreenChange({ type: 'key', params: { keys: 'ctrl+c' } }), false);
  assert.equal(expectsScreenChange({ type: 'key', params: { keys: ['ctrl+a', 'ctrl+c'] } }), false);
  assert.equal(expectsScreenChange({ type: 'scroll', params: { amount: -3 } }), false);
  assert.equal(expectsScreenChange({ type: 'wait', params: { ms: 1000 } }), false);
});

test('launchApp only claims a process window when the target is an executable', () => {
  assert.deepEqual(windowChecksFor({ type: 'launchApp', params: { target: 'chrome.exe' } }), [
    { process: 'chrome', label: 'chrome' },
  ]);
  assert.deepEqual(windowChecksFor({ type: 'launchApp', params: { target: 'C:/Users/Dan/Desktop/a.txt' } }), []);
  assert.deepEqual(windowChecksFor({ type: 'launchApp', params: { target: 'Google Chrome' } }), [
    { title: 'Google Chrome', label: 'Google Chrome' },
  ]);
  assert.equal(windowChecksFor({ type: 'openUrl', params: { url: 'https://google.com' } }).length, 3);
  assert.deepEqual(windowChecksFor({ type: 'type', params: { text: 'x' } }), []);
});

test('resumePlan resumes only while the plan prefix is unchanged', () => {
  const original = [
    { id: 'a', type: 'launchApp', params: { target: 'chrome.exe' } },
    { id: 'b', type: 'type', params: { text: 'question' } },
    { id: 'c', type: 'key', params: { keys: 'enter' } },
  ];
  assert.deepEqual(resumePlan(original, original, 'b').steps.map((s) => s.id), ['b', 'c']);
  assert.equal(resumePlan(original, original, 'b').skipped, 1);

  const repairedPrefix = [{ id: 'fix', type: 'wait', params: { ms: 500 } }, ...original];
  assert.equal(resumePlan(repairedPrefix, original, 'b'), null);

  const changedParams = original.map((step) =>
    step.id === 'a' ? { ...step, params: { target: 'msedge.exe' } } : step
  );
  assert.equal(resumePlan(changedParams, original, 'b'), null);
  assert.equal(resumePlan(original, original, 'missing'), null);
  assert.equal(resumePlan(original, original, 'a'), null);
});

test('a no-change screen passes when something else confirms the action', () => {
  const typeStep = { type: 'type', params: { text: 'already here' } };
  assert.equal(corroboratesNoChange({ step: typeStep }), '');
  assert.match(corroboratesNoChange({ step: typeStep, textFound: true }), /already present in the window/);
  assert.match(corroboratesNoChange({ step: typeStep, focused: { value: 'already here' } }), /field already contains/);
  assert.equal(corroboratesNoChange({ step: typeStep, focused: { name: 'Search' } }), '');
  assert.match(corroboratesNoChange({ step: typeStep, checks: [{ output: 'ok' }] }), /follow-up check passed/);
  assert.match(
    corroboratesNoChange({ step: { type: 'click', params: { name: 'Remember me' } }, focused: { name: 'Remember me' } }),
    /already focused or selected/
  );
  assert.equal(corroboratesNoChange({ step: { type: 'click', params: { name: 'Buy' } }, focused: { name: 'Cancel' } }), '');
});

test('the identical-text lookup uses the foreground window when there is no guard', () => {
  assert.equal(lookupWindowFor({ step: { params: { foreground: 'Chrome' } }, focused: { window: 'Notepad' } }), 'Chrome');
  assert.equal(lookupWindowFor({ step: { params: {} }, focused: { window: 'probe.txt - Notepad' } }), 'probe.txt - Notepad');
  assert.equal(lookupWindowFor({ step: { params: {} }, focused: null }), '');

  const unguarded = { type: 'type', params: { text: 'same text' } };
  assert.equal(corroboratesNoChange({ step: unguarded }), '');
  assert.match(corroboratesNoChange({ step: unguarded, focused: { value: 'same text' } }), /field already contains/);
  assert.match(corroboratesNoChange({ step: unguarded, textFound: true }), /already present in the window/);
});

test('recovery resumes only when the snapshot is the exact plan that ran', () => {
  const ran = [
    { id: 'a', type: 'launchApp', params: { target: 'chrome.exe' } },
    { id: 'b', type: 'type', params: { text: 'question' } },
    { id: 'c', type: 'key', params: { keys: 'enter' } },
  ];
  assert.deepEqual(resumeRecoveryPlan(ran, ran, 'b').steps.map((s) => s.id), ['b', 'c']);

  const repairBeforeFailure = [
    { id: 'fix_wait', type: 'wait', params: { ms: 500 } },
    { id: 'fix_focus', type: 'focusWindow', params: { title: 'Chrome' } },
    ...ran,
  ];
  assert.equal(resumeRecoveryPlan(repairBeforeFailure, ran, 'b'), null);

  const replacedPrefix = ran.map((step) => (step.id === 'a' ? { ...step, params: { target: 'msedge.exe' } } : step));
  assert.equal(resumeRecoveryPlan(replacedPrefix, ran, 'b'), null);
  assert.equal(resumeRecoveryPlan(ran.slice(0, 2), ran, 'b'), null);

  // A repair after the failure is kept in the resumed suffix, not dropped.
  const repairAfterFailure = [ran[0], ran[1], { id: 'fix_shot', type: 'screenshot', params: {} }];
  assert.deepEqual(
    resumeRecoveryPlan(repairAfterFailure, ran, 'b').steps.map((s) => s.id),
    ['b', 'fix_shot']
  );
});

test('a whole-plan replay does not repeat an effect that already happened', () => {
  const ran = [
    { id: 'a', type: 'launchApp', params: { target: 'notepad.exe' }, status: 'passed' },
    { id: 'b', type: 'type', params: { text: 'hello', foreground: 'Notepad' }, status: 'passed' },
    { id: 'c', type: 'writeTextFile', params: { text: 'hello', filename: 'note.txt' }, status: 'passed' },
    { id: 'd', type: 'expect', params: { kind: 'window', value: 'Notepad' }, status: 'failed' },
  ];
  const snapshot = [
    { id: 'fix', type: 'focusWindow', params: { title: 'Notepad' } },
    ...ran.map((step) => ({ ...step })),
  ];
  const result = carryForwardPassedEffects(snapshot, ran);
  assert.deepEqual(result.steps.map((step) => step.id), ['fix', 'a', 'd']);
  assert.deepEqual(result.carried.map((step) => step.type), ['type', 'writeTextFile']);

  // A changed step is a new attempt, so it is kept.
  const changed = snapshot.map((step) =>
    step.id === 'b' ? { ...step, params: { text: 'hello again', foreground: 'Notepad' } } : step
  );
  assert.equal(carryForwardPassedEffects(changed, ran).steps.some((step) => step.id === 'b'), true);
  // A failed step was never carried, and an omission is not a completion.
  assert.equal(carryForwardPassedEffects([ran[3]], ran).carried.length, 0);
  assert.equal(repeatsSideEffect({ type: 'launchApp' }), false);
  assert.equal(repeatsSideEffect({ type: 'type' }), true);
});

test('resumeSteps starts at the failed step and keeps the rest', () => {
  const steps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(resumeSteps(steps, 'b').map((s) => s.id), ['b', 'c']);
  assert.deepEqual(resumeSteps(steps, 'a').map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(resumeSteps(steps, 'missing').map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(resumeSteps(null, 'a'), []);
});

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-step-effects-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

async function settle(runId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (!run || !['queued', 'running'].includes(run.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows can hold a handle on a file that was just renamed into place, so
    // removing the temp root right after flush occasionally returns EPERM.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('retryRun resumes at the failed step instead of restarting the workflow', async () => {
  const d = store.db();
  d.settings.dryRun = true;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;

  const workflow = {
    id: 'wf_resume_probe',
    name: 'Resume probe',
    description: 'Type a question in Chrome.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_open', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' }, timeoutMs: 10000 },
      { id: 'stp_ask', type: 'type', name: 'Ask the question', params: { text: 'what is python', foreground: 'Chrome' }, timeoutMs: 10000 },
      { id: 'stp_copy', type: 'key', name: 'Copy the answer', params: { keys: 'ctrl+c', foreground: 'Chrome' }, timeoutMs: 10000 },
    ],
  };
  d.workflows = [workflow];
  d.runs = [
    {
      id: 'run_resume_probe',
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'failed',
      dryRun: true,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      policy: { onFailure: 'stop', maxRetries: 0 },
      variables: {},
      evidence: [],
      log: [],
      steps: workflow.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? 'passed' : index === 1 ? 'failed' : 'skipped',
        error: index === 1 ? 'Type failed' : undefined,
        attempts: 1,
        evidenceIds: [],
      })),
    },
  ];
  d.recoveryPacks = [];

  const retry = await engine.retryRun('run_resume_probe', { replan: false });
  assert.equal(retry.resumedFrom?.step, 'Ask the question');
  assert.equal(retry.resumedFrom?.skipped, 1);
  const ids = retry.steps.map((step) => step.id);
  assert.equal(ids.includes('stp_open'), false);
  assert.equal(ids.includes('stp_ask'), true);
  assert.equal(ids.includes('stp_copy'), true);
  await settle(retry.id);
  store.flush();
});

test('retryRun replays in full when the plan was repaired before the failure', async () => {
  const d = store.db();
  const workflow = {
    id: 'wf_resume_repair_probe',
    name: 'Repair probe',
    description: 'Type a question in Chrome after a repair wait.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_repair_wait', type: 'wait', name: 'Repair wait', params: { ms: 400 }, timeoutMs: 3000 },
      { id: 'stp_repair_open', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' }, timeoutMs: 10000 },
      { id: 'stp_repair_ask', type: 'type', name: 'Ask the question', params: { text: 'what is python', foreground: 'Chrome' }, timeoutMs: 10000 },
      { id: 'stp_repair_copy', type: 'key', name: 'Copy the answer', params: { keys: 'ctrl+c', foreground: 'Chrome' }, timeoutMs: 10000 },
    ],
  };
  d.workflows.push(workflow);
  d.runs.push({
    id: 'run_resume_repair_probe',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'failed',
    dryRun: true,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    policy: { onFailure: 'stop', maxRetries: 0 },
    variables: {},
    evidence: [],
    log: [],
    steps: workflow.steps.slice(1).map((step, index) => ({
      ...step,
      status: index === 0 ? 'passed' : index === 1 ? 'failed' : 'skipped',
      error: index === 1 ? 'Type failed' : undefined,
      attempts: 1,
      evidenceIds: [],
    })),
  });

  const retry = await engine.retryRun('run_resume_repair_probe', { replan: false });
  assert.equal(retry.resumedFrom, undefined);
  const ids = retry.steps.map((step) => step.id);
  assert.equal(ids.includes('stp_repair_wait'), true);
  assert.equal(ids.includes('stp_repair_open'), true);
  assert.equal(ids.includes('stp_repair_ask'), true);
  await settle(retry.id);
  store.flush();
});
