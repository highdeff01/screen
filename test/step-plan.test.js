import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const stepPlan = await load('server/step-plan.js');
const screenReview = await load('server/screen-review.js');
const planner = await load('server/planner.js');

test('an explicit instruction becomes steps instead of a template', () => {
  const parsed = stepPlan.parseDirective('type hi in notepad');
  assert.equal(parsed.app.name, 'Notepad');
  assert.equal(parsed.input.kind, 'text');
  assert.equal(parsed.input.text, 'hi');
  assert.ok(parsed.confidence >= 0.6);

  const steps = stepPlan.directiveSteps(parsed);
  const types = steps.map((step) => step.type);
  assert.deepEqual(types, ['launchApp', 'wait', 'focusWindow', 'type', 'screenshot']);
  const typing = steps.find((step) => step.type === 'type');
  assert.equal(typing.params.text, 'hi');
  assert.equal(typing.params.foreground, 'Notepad');
});

test('open … and type … is one directive, unsupported work stays with the planner', () => {
  const both = stepPlan.parseDirective('open notepad and type hello world');
  assert.equal(both.app.name, 'Notepad');
  assert.equal(both.input.text, 'hello world');

  assert.equal(stepPlan.parseDirective('open chrome, download vlc and install it'), null);
  assert.equal(stepPlan.parseDirective('a long description of a workflow that should be planned by the model with history and screenshots'), null);
});

test('the local heuristic keeps the requested input', () => {
  const steps = planner.heuristicPlan('type hi in notepad', {});
  const typing = steps.find((step) => step.type === 'type');
  assert.ok(typing, 'a type step was created');
  assert.equal(typing.params.text, 'hi');
  assert.equal(typing.params.foreground, 'Notepad');
  assert.ok(steps.some((step) => step.type === 'launchApp'), 'Notepad is opened first');
});

test('an update changes the existing input step instead of typing twice', () => {
  const steps = [
    { id: 'a', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    { id: 'b', type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
    { id: 'c', type: 'type', name: 'Input “old”', params: { text: 'old', foreground: 'Notepad' } },
    { id: 'd', type: 'screenshot', name: 'Screen check', params: { caption: 'end' } },
  ];
  const plan = stepPlan.planStepChange({ instruction: 'type hi in notepad', steps });
  assert.equal(plan.ok, true);
  assert.equal(plan.steps.filter((step) => step.type === 'type').length, 1, 'no duplicate input step');
  const typing = plan.steps.find((step) => step.type === 'type');
  assert.equal(typing.params.text, 'hi');
  assert.equal(typing.id, 'c', 'the existing step is updated in place');
  assert.ok(plan.changes.some((change) => change.op === 'update' && change.before === 'old' && change.after === 'hi'));
  assert.equal(plan.review.inputConsidered.find((item) => item.field === 'input').source, 'instruction');
});

test('a change inserts missing prerequisites and re-syncs the following steps', () => {
  const steps = [{ id: 't', type: 'type', name: 'Type a note', params: { text: 'x' } }];
  const plan = stepPlan.planStepChange({ instruction: 'type hi in notepad', steps });
  assert.equal(plan.ok, true);
  const index = (type) => plan.steps.findIndex((step) => step.type === type);
  assert.equal(plan.steps[index('type')].params.text, 'hi');
  assert.ok(index('launchApp') >= 0 && index('launchApp') < index('type'), 'launch comes before the input');
  assert.ok(index('focusWindow') >= 0 && index('focusWindow') < index('type'), 'focus comes before the input');
  assert.equal(plan.steps[index('type')].params.foreground, 'Notepad', 'the input is guarded with the window it names');
  assert.ok(plan.steps.some((step) => step.type === 'screenshot'), 'a screen check follows the action');
});

test('a referenced value with no producer is surfaced at approval time', () => {
  const plan = stepPlan.planStepChange({
    instruction: 'type the answer in notepad',
    steps: [{ id: 's', type: 'screenshot', name: 'Start', params: { caption: 'start' } }],
  });
  assert.equal(plan.ok, true);
  assert.ok(
    plan.gaps.some((gap) => /produces|produce/.test(gap.reason || '')),
    'the missing producer is named instead of silently typing an empty variable'
  );
  const typing = plan.steps.find((step) => step.type === 'type');
  assert.equal(typing.params.textVar, 'extractedText');
});

test('an instruction that names no buildable step is refused with a reason', () => {
  const plan = stepPlan.planStepChange({ instruction: 'make it better', steps: [] });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /does not name a step/);
  assert.equal(plan.changes.length, 0);
});

test('screen review policy is clamped and only covers actions by default', () => {
  const settings = screenReview.normalizeScreenReviewSettings({ maxPerRun: 9999, mode: 'nonsense' });
  assert.equal(settings.maxPerRun, 200);
  assert.equal(settings.mode, 'actions');
  assert.equal(screenReview.shouldReviewStep({ type: 'type' }, 0, settings), true);
  assert.equal(screenReview.shouldReviewStep({ type: 'wait' }, 0, settings), false);
  assert.equal(screenReview.shouldReviewStep({ type: 'wait' }, 0, { ...settings, mode: 'every' }), true);
  assert.equal(screenReview.shouldReviewStep({ type: 'type' }, settings.maxPerRun, settings), false);
  assert.equal(screenReview.shouldReviewStep({ type: 'type' }, 0, { ...settings, enabled: false }), false);
  assert.equal(screenReview.screenReviewCaption({ name: 'Input “hi”' }), 'Screen check — Input “hi”');
});
