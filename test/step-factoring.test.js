import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-factoring-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const factoring = await load('server/step-factoring.js');

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
  d.workflows = [];
  d.stepPatterns = [];
  d.refactorPlans = [];
  d.suggestions = [];
  store.persist();
});

const typeStep = (overrides = {}) => ({ id: 's1', type: 'type', name: 'Type the note', params: { text: 'hello', foreground: 'Untitled - Notepad' }, ...overrides });

test('fingerprints are stable and ignore volatile params', () => {
  const a = factoring.fingerprintStep(typeStep());
  const b = factoring.fingerprintStep(typeStep({ params: { text: 'HELLO', foreground: 'untitled - notepad', timeoutMs: 9999 } }));
  assert.equal(a, b);
  const c = factoring.fingerprintStep(typeStep({ params: { text: 'different text', foreground: 'Untitled - Notepad' } }));
  assert.notEqual(a, c);
});

test('intents are spotted and pinned onto steps', () => {
  assert.equal(factoring.spotIntent(typeStep()).intent, 'input-into-window');
  assert.equal(factoring.spotIntent({ type: 'type', params: {} }).intent, 'input');
  assert.equal(factoring.spotIntent({ type: 'launchApp', params: {} }).intent, 'open');
  assert.equal(factoring.spotIntent({ type: 'expect', params: {} }).intent, 'evidence');
  const workflow = { id: 'wf1', name: 'Demo', steps: [typeStep(), { id: 's2', type: 'launchApp', params: { target: 'notepad.exe' } }] };
  const pinned = factoring.pinStepIntents(workflow);
  assert.equal(pinned.pinned, 2);
  assert.equal(workflow.steps[0].intent, 'input-into-window');
  // Already-set intents are kept, never overwritten.
  workflow.steps[0].intent = 'operator-choice';
  const again = factoring.pinStepIntents(workflow);
  assert.equal(again.kept, 2);
  assert.equal(again.pinned, 0);
  assert.equal(workflow.steps[0].intent, 'operator-choice');
});

test('outcomes feed the ledger and upscale with corroboration', () => {
  const run = { id: 'run1', workflowId: 'wf1', workflowName: 'Demo', steps: [typeStep({ status: 'passed' })] };
  const pattern = factoring.noteStepOutcome(run, run.steps[0]);
  assert.equal(pattern.successes, 1);
  assert.equal(pattern.strength, 1);
  // Same run+step counted once, not twice.
  factoring.noteStepOutcome(run, run.steps[0]);
  const ledger = factoring.upscaleSummary();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].successes, 1);
  // A second run with the same form strengthens it; a failure bleeds it.
  const run2 = { id: 'run2', workflowId: 'wf1', workflowName: 'Demo', steps: [typeStep({ status: 'passed', id: 's9' })] };
  factoring.noteStepOutcome(run2, run2.steps[0]);
  const run3 = { id: 'run3', workflowId: 'wf2', workflowName: 'Other', steps: [typeStep({ status: 'failed', id: 's10' })] };
  factoring.noteStepOutcome(run3, run3.steps[0]);
  const top = factoring.upscaleSummary()[0];
  assert.equal(top.successes, 2);
  assert.equal(top.failures, 1);
  assert.equal(top.strength, 1);
});

test('the proven form is extracted and offered to similar steps in later runs', () => {
  const sampleRun = { id: 'runA', workflowId: 'wfA', workflowName: 'First workflow', steps: [typeStep({ status: 'passed' })] };
  factoring.noteStepOutcome(sampleRun, sampleRun.steps[0]);

  const solutions = factoring.similarSolutions({ step: typeStep(), excludeWorkflowId: 'wfB' });
  assert.equal(solutions.length, 1);
  assert.equal(solutions[0].workflowName, 'First workflow');
  assert.equal(solutions[0].params.foreground, 'Untitled - Notepad');

  // The failed workflow itself is excluded from its own advice.
  const own = factoring.similarSolutions({ step: typeStep(), excludeWorkflowId: 'wfA' });
  assert.equal(own.length, 0);
});

test('duplication across workflows is noticed and re-conjoined into a refactor plan', () => {
  const d = store.db();
  d.workflows = [
    { id: 'wfA', name: 'Notepad note', steps: [typeStep(), { id: 'x', type: 'expect', params: { kind: 'window', value: 'Notepad' } }] },
    { id: 'wfB', name: 'Notepad again', steps: [typeStep({ id: 'b1' }), { id: 'y', type: 'screenshot', params: {} }] },
    { id: 'wfC', name: 'Unrelated', steps: [{ id: 'z', type: 'openUrl', params: { url: 'https://example.com' } }] },
  ];
  store.persist();
  const plan = factoring.planRefactoring({});
  assert.match(plan.summary, /duplication cluster/);
  const cross = plan.clusters.find((cluster) => cluster.kind === 'cross-workflow');
  assert.ok(cross, 'the shared type step is noticed across two workflows');
  assert.deepEqual(cross.workflows.map((workflow) => workflow.workflowName).sort(), ['Notepad again', 'Notepad note']);
  assert.equal(cross.intent, 'input-into-window');

  // Application is advice: concrete suggestions in the builder, no silent edits.
  const applied = factoring.pushRefactorToBuilder(plan.id);
  assert.ok(applied.suggestions.length >= 2);
  const suggestions = store.db().suggestions.filter((entry) => entry.kind === 'refactor' && !entry.dismissed);
  assert.ok(suggestions.length >= 2);
  assert.match(suggestions[0].text, /Refactor/);
  assert.match(suggestions[0].text, /input-into-window/);
  assert.throws(() => factoring.pushRefactorToBuilder(plan.id), /already pushed/);
});

test('a repeated block inside one workflow is also considered', () => {
  const d = store.db();
  d.workflows = [
    { id: 'wfA', name: 'Repeater', steps: [typeStep(), typeStep({ id: 'copy1' }), typeStep({ id: 'copy2' })] },
  ];
  store.persist();
  const plan = factoring.planRefactoring({});
  const intra = plan.clusters.find((cluster) => cluster.kind === 'in-workflow');
  assert.ok(intra, 'the repeated step form is noticed inside the workflow');
  assert.equal(intra.workflows[0].steps.length, 3);
});

test('status summarizes the ledger and plans', () => {
  const status = factoring.factoringStatus();
  assert.ok(Array.isArray(status.patterns));
  assert.ok(typeof status.patternCount === 'number');
  assert.ok(Array.isArray(status.plans));
});
