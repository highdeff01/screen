import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const stepPlan = await load('server/step-plan.js');
const screenReview = await load('server/screen-review.js');
const judgement = await load('server/judgement.js');
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

test('the automatic check asks the frame the step’s own question', () => {
  const typed = screenReview.screenReviewCheck({ type: 'type', name: 'Input “hi”', params: { text: 'hi', foreground: 'Notepad' } });
  assert.match(typed.question, /“hi”/);
  assert.equal(typed.expectedText, 'hi', 'the free window read is told what must be there');
  assert.equal(typed.caption, 'Screen check — Input “hi”');

  const fromVar = screenReview.screenReviewCheck(
    { type: 'type', name: 'Input', params: { textVar: 'answer' } },
    { variables: { answer: 'forty two' } }
  );
  assert.equal(fromVar.expectedText, 'forty two');

  const clicked = screenReview.screenReviewCheck({ type: 'clickElement', name: 'Click Save', params: { name: 'Save' } });
  assert.match(clicked.question, /“Save”/);
  assert.equal(clicked.expectedText, '');

  const closed = screenReview.screenReviewCheck({ type: 'closeWindow', name: 'Close', params: { title: 'Untitled - Notepad' } });
  assert.equal(closed.absentText, 'Untitled - Notepad');
});

test('one reading becomes a pass, a mismatch or an honest unverified', () => {
  assert.deepEqual(screenReview.reviewOutcome({ output: 'Screen verified: the text is visible' }), {
    status: 'pass',
    verdict: 'pass',
    detail: 'Screen verified: the text is visible',
    mismatch: '',
  });
  const bad = screenReview.reviewOutcome({
    error:
      'Screen check failed (vision 40%) | the text “hi” is not visible: the document is empty · window facts: fail — the foreground window is “Calculator” [data/shots/a.png]',
  });
  assert.equal(bad.status, 'mismatch');
  assert.equal(bad.mismatch, 'the text “hi” is not visible', 'the review keeps what is wrong, not the log tail');
  const unreadable = screenReview.reviewOutcome({ skipped: true, output: 'the vision model was unreachable' });
  assert.equal(unreadable.status, 'skipped');
  assert.equal(unreadable.verdict, 'unverified');
  // A check that reported it could not read the frame is not a mismatch, even
  // when it arrives as an error instead of a skipped result.
  const offline = screenReview.reviewOutcome({
    error: Object.assign(new Error('Screen check could not read the screen: the vision model was unreachable'), {
      unreadable: true,
    }),
  });
  assert.equal(offline.status, 'skipped');
  assert.equal(offline.verdict, 'unverified');
  assert.equal(offline.mismatch, '');
  assert.match(offline.detail, /vision model was unreachable/);
  // The same message without the flag is a real contradiction.
  assert.equal(
    screenReview.reviewOutcome({ error: new Error('Screen check could not read the screen: the vision model was unreachable') }).status,
    'mismatch'
  );
});

test('a check that names a handle keeps judging that window after it renames', () => {
  const run = { lastWindow: { hwnd: 4242, title: 'Untitled - Notepad', process: 'Notepad' } };
  const byHandle = judgement.judgeTargetFor({ params: { handle: 4242, app: 'Notepad' } }, run);
  assert.equal(byHandle.hwnd, 4242);
  assert.equal(byHandle.process, 'Notepad');
  assert.equal(byHandle.source, 'step-handle');

  // Notepad takes the document's first line as its name, so the title the run
  // opened is gone by the time the frame is judged.
  const renamed = { lastWindow: { hwnd: 4242, title: 'Sightline screen agent - Notepad', process: 'Notepad' } };
  const byTitle = judgement.judgeTargetFor({ params: { title: 'Untitled - Notepad' } }, renamed);
  assert.equal(byTitle.hwnd, 0, 'a stale title no longer identifies the window');
  const stillScoped = judgement.judgeTargetFor({ params: { handle: 4242 } }, renamed);
  assert.equal(stillScoped.hwnd, 4242);
  assert.equal(stillScoped.scoped, true);
});

test('screen review retries and confidence are clamped', () => {
  const settings = screenReview.normalizeScreenReviewSettings({ retries: 99, retryDelayMs: -5, minConfidence: 5 });
  assert.equal(settings.retries, 3);
  assert.equal(settings.retryDelayMs, 0);
  assert.equal(settings.minConfidence, 1);
  assert.equal(screenReview.screenReviewAttempts(settings), 4);
  assert.equal(screenReview.screenReviewAttempts({ retries: 0 }), 1);
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
