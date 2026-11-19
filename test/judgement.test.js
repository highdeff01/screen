import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
// A private working directory keeps the store module from touching the real
// data folder; every writer here is a fake anyway.
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-judgement-'));
process.chdir(tempRoot);
const judgement = await import(pathToFileURL(path.join(root, 'server/judgement.js')).href);

after(() => {
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const foreground = (over = {}) => ({ title: 'Untitled - Notepad', process: 'Notepad', hwnd: 111, ...over });
const target = (over = {}) => ({ hwnd: 111, title: 'Untitled - Notepad', process: 'Notepad', scoped: true, source: 'run-window', ...over });

function fakeDb() {
  return { settings: { verifyJudgeMode: 'parallel' }, workflows: [{ id: 'wf1', judgeMode: '' }], judgement: null };
}

test('the same app in a different window fails the deterministic judge', () => {
  const facts = judgement.windowFacts({ target: target(), foreground: foreground({ hwnd: 222 }) });

  assert.equal(facts.status, 'fail');
  assert.match(facts.detail, /not the run's window/);
});

test('the exact window handle passes without any model help', () => {
  const facts = judgement.windowFacts({ target: target(), foreground: foreground() });

  assert.equal(facts.status, 'pass');
});

test('a scoped title is enough when no handle was recorded', () => {
  const facts = judgement.windowFacts({
    target: target({ hwnd: 0, title: 'report.txt - Notepad' }),
    foreground: foreground({ hwnd: 0, title: 'report.txt - Notepad' }),
  });

  assert.equal(facts.status, 'pass');
});

test('expected and stale text are read from the window, not the desktop', () => {
  const present = judgement.windowFacts({
    target: target(),
    foreground: foreground(),
    expectedText: 'Sightline screen agent{ENTER}Automated typing check.',
    windowText: 'Sightline screen agent\r\nAutomated typing check.\r\n',
  });
  assert.equal(present.status, 'pass');

  const stale = judgement.windowFacts({
    target: target(),
    foreground: foreground(),
    absentText: 'Sightline screen agent',
    windowText: 'Sightline screen agent\r\n',
  });
  assert.equal(stale.status, 'fail');

  const unknown = judgement.windowFacts({ target: target(), foreground: foreground(), expectedText: 'anything' });
  assert.equal(unknown.status, 'unknown', 'an app without readable text is not evidence of absence');
});

test('an unscoped check judges the desktop and says so', () => {
  const facts = judgement.windowFacts({
    target: { hwnd: 0, title: '', process: '', scoped: false },
    foreground: foreground(),
    expectedText: 'hello',
  });

  assert.equal(facts.status, 'unknown');
  assert.match(facts.detail, /whole desktop/);
});

test('the target is the run window even when the step names it loosely', () => {
  const step = { type: 'verifyScreen', params: { title: 'Notepad' } };
  const run = { lastWindow: { process: 'Notepad', title: 'Untitled - Notepad', hwnd: 4242 } };

  const chosen = judgement.judgeTargetFor(step, run);

  assert.equal(chosen.hwnd, 4242);
  assert.equal(chosen.source, 'run-window');

  const other = judgement.judgeTargetFor({ type: 'verifyScreen', params: { title: 'Save As' } }, run);
  assert.equal(other.hwnd, 0, 'a different window keeps its own title');
});

test('parallel mode lets the window facts block a passing model', () => {
  const facts = { status: 'fail' };
  const vision = { pass: true };

  const merged = judgement.mergeJudgement({ mode: 'parallel', facts, vision });

  assert.equal(merged.pass, false);
  assert.equal(merged.decidedBy, 'facts');
  assert.equal(merged.agreement, 'disagree');
});

test('the switch changes which judge decides, without hiding the other', () => {
  const vision = { pass: true };
  const facts = { status: 'fail' };

  assert.equal(judgement.mergeJudgement({ mode: 'vision', facts, vision }).pass, true);
  assert.equal(judgement.mergeJudgement({ mode: 'facts', facts, vision }).pass, false);
  assert.equal(judgement.mergeJudgement({ mode: 'strict', facts: { status: 'pass' }, vision: { pass: false } }).pass, false);
  assert.equal(judgement.mergeJudgement({ mode: 'parallel', facts: { status: 'unknown' }, vision }).pass, true);
});

test('repeated disagreement drafts a review but changes nothing on its own', () => {
  const d = fakeDb();
  const deps = { db: d, persist: () => {} };
  const entry = {
    mode: 'parallel',
    facts: { status: 'fail' },
    vision: { pass: true },
    agreement: 'disagree',
    workflowId: 'wf1',
    question: 'Does the note show the text?',
  };

  for (let i = 0; i < 3; i += 1) judgement.recordJudgement(entry, deps);

  assert.equal(d.settings.verifyJudgeMode, 'parallel', 'the switch is not changed by learning');
  const summary = d.judgement;
  assert.equal(summary.stats.visionOnlyPass, 3);
  assert.equal(summary.reviews.length, 1);
  assert.equal(summary.reviews[0].status, 'pending');

  judgement.resolveJudgementReview(summary.reviews[0].id, 'accept', deps);
  assert.equal(d.settings.verifyJudgeMode, 'parallel', 'parallel is already the mode this suggestion names');
  assert.equal(summary.reviews[0].status, 'accepted');
});

test('unscoped checks earn a scope condition that only accepting applies', () => {
  const d = fakeDb();
  const deps = { db: d, persist: () => {} };
  const entry = {
    mode: 'parallel',
    facts: { status: 'unknown' },
    vision: { pass: true },
    agreement: 'partial',
    target: { scoped: false },
  };

  for (let i = 0; i < 3; i += 1) judgement.recordJudgement(entry, deps);
  const review = d.judgement.reviews.find((item) => item.kind === 'unscoped');
  assert.ok(review, 'a repeated unscoped check becomes a review');
  assert.equal(d.settings.verifyJudgeRequireScope, undefined, 'nothing is applied before review');

  judgement.resolveJudgementReview(review.id, 'accept', deps);
  assert.equal(d.settings.verifyJudgeRequireScope, true);
});

test('a facts-only pass suggests trusting the deterministic check for that workflow', () => {
  const d = fakeDb();
  const deps = { db: d, persist: () => {} };
  const entry = {
    mode: 'parallel',
    facts: { status: 'pass' },
    vision: { pass: false },
    agreement: 'disagree',
    workflowId: 'wf1',
  };

  for (let i = 0; i < 3; i += 1) judgement.recordJudgement(entry, deps);
  const review = d.judgement.reviews[0];
  assert.equal(review.kind, 'facts-only-pass');

  judgement.resolveJudgementReview(review.id, 'accept', deps);
  assert.equal(d.workflows[0].judgeMode, 'facts', 'accepting scopes the switch to the workflow');
  assert.equal(judgement.judgeModeFor(d.workflows[0], d.settings), 'facts');
  assert.equal(judgement.judgeModeFor({ judgeMode: '' }, d.settings), 'parallel');
});
