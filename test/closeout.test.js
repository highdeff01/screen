import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-closeout-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const closeout = await load('server/closeout.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.runs = [];
  d.workflows = [];
  d.suggestions = [];
  store.persist();
});

const typeStep = (overrides = {}) => ({
  id: 's_type',
  type: 'type',
  name: 'Type the note',
  params: { text: 'hello' },
  status: 'passed',
  output: 'typed :: Untitled - Notepad',
  ...overrides,
});

/** A run that opened a scratch Notepad and typed into it. */
function probeRun({ title = 'Untitled - Notepad', status = 'passed', history = [] } = {}) {
  const d = store.db();
  d.runs = [...history, {
    id: 'run_closeout_probe',
    workflowId: 'wf_probe',
    workflowName: 'Notepad quick capture',
    status,
    steps: [typeStep()],
    ledger: [{ type: 'type', name: 'Type the note', params: { text: 'hello' }, status: 'passed' }],
    lastWindow: { title, process: 'Notepad', hwnd: 4242, at: new Date().toISOString() },
    log: [],
  }];
  d.workflows = [{ id: 'wf_probe', name: 'Notepad quick capture', description: 'capture a quick note', steps: [], status: 'ready' }];
  store.persist();
  return d.runs[d.runs.length - 1]; // the probe run, not the history runs
}

test('unsaved scratch work predicts save', () => {
  const run = probeRun();
  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'save');
  assert.match(prediction.reasons.join(' '), /never saved/);
  const steps = prediction.followUpSteps || closeout.followUpSteps(prediction);
  assert.ok(steps.some((step) => step.type === 'key' && /ctrl\+s/i.test(JSON.stringify(step.params))));
});

test('previous runs that closed after the same step upgrade the verdict to save-close', () => {
  const history = [{
    id: 'run_history_1',
    workflowId: 'wf_probe',
    workflowName: 'Notepad quick capture',
    status: 'passed',
    ledger: [
      { type: 'type', name: 'Type the note', params: { text: 'hello' }, status: 'passed' },
      { type: 'closeWindow', name: 'Close it', params: { title: 'Untitled - Notepad' }, status: 'passed' },
    ],
  }];
  const run = probeRun({ history });
  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'save-close');
  assert.match(prediction.reasons.join(' '), /disposable/);
  const steps = prediction.followUpSteps || closeout.followUpSteps(prediction);
  assert.ok(steps.some((step) => step.type === 'key'));
  assert.ok(steps.some((step) => step.type === 'closeWindow'));
});

test('a saved document with no need to stay predicts close', () => {
  const run = probeRun({ title: 'https://example.com - Google Chrome' });
  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'close');
});

test('a window the goal asked for is left open on purpose', () => {
  const run = probeRun({ title: 'Untitled - Notepad' });
  run.workflowName = 'Open Notepad';
  store.db().workflows[0].name = 'Open Notepad';
  store.db().workflows[0].description = 'open Notepad and keep it open';
  store.persist();
  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'leave');
  assert.match(prediction.reasons.join(' '), /goal/);
});

test('recordCloseout logs the prediction and drafts one closeout suggestion', () => {
  const run = probeRun({ status: 'passed' });
  const recorded = closeout.recordCloseout(run);
  assert.equal(recorded.action, 'save');
  assert.ok((run.log || []).some((line) => /Follow-up prediction/.test(line.message || '')));
  // Second call is a no-op (recorded once).
  closeout.recordCloseout(run);
  const suggestions = store.db().suggestions.filter((entry) => entry.kind === 'closeout' && entry.runId === 'run_closeout_probe');
  assert.equal(suggestions.length, 1);
  // Failed runs get no closeout — there is nothing to finish.
  const failed = probeRun({ status: 'failed' });
  failed.id = 'run_failed_probe';
  store.db().runs[0] = failed;
  store.persist();
  assert.equal(closeout.recordCloseout(failed), null);
});

test('appendCloseout writes the steps into the workflow after operator approval', () => {
  const run = probeRun();
  closeout.recordCloseout(run);
  const result = closeout.appendCloseout('run_closeout_probe');
  assert.equal(result.appended, 2);
  const workflow = store.db().workflows.find((entry) => entry.id === 'wf_probe');
  assert.equal(workflow.steps.length, 2);
  assert.equal(workflow.steps[0].type, 'key');
  assert.equal(workflow.steps[0].params.foreground, 'Untitled - Notepad');
  assert.equal(run.closeout.appended, true);
  assert.throws(() => closeout.appendCloseout('run_closeout_probe'), /No closeout prediction|already/);
});

test('an unresolved screen mismatch is named before the window advice', () => {
  const run = probeRun();
  run.screenReviewUnresolved = true;
  run.screenMismatches = [
    {
      stepId: 's_type',
      stepName: 'Type the note',
      at: new Date().toISOString(),
      attempts: 2,
      mismatch: 'the note is not in the window',
    },
  ];
  store.persist();

  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'save', 'the window advice itself still stands');
  assert.equal(prediction.screenReview.unresolved, true);
  assert.equal(prediction.screenReview.step, 'Type the note');
  assert.match(prediction.reasons[0], /automatic screen check did not match after “Type the note”/);
  assert.ok(prediction.confidence < 0.7, 'the prediction is less certain while the frame disagrees');
  assert.match(prediction.reasons.join(' '), /never saved/, 'the window reason is kept, just not first');

  const recorded = closeout.recordCloseout(run);
  assert.equal(recorded.screenReview.unresolved, true, 'the closeout on the run carries the mismatch');
});

test('a run with no window gets a quiet leave', () => {
  const run = probeRun();
  run.lastWindow = null;
  store.persist();
  const prediction = closeout.predictCloseout(run);
  assert.equal(prediction.action, 'leave');
  assert.equal((prediction.followUpSteps || []).length, 0);
});
