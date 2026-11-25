import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-screen-review-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function resetDb(screenReview = {}) {
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
  d.settings.recheck = { enabled: false, continueAfter: false, prepMs: 0, maxAttempts: 1, intervalMs: 50, maxPendingMs: 1000 };
  d.settings.screenReview = {
    enabled: true,
    mode: 'actions',
    maxPerRun: 40,
    retries: 1,
    retryDelayMs: 0,
    minConfidence: 0.6,
    ...screenReview,
  };
  d.workflows = [];
  d.runs = [];
  return d;
}

function workflow(id) {
  return {
    id,
    name: 'Type the note',
    description: 'Type “hi” in Notepad.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      {
        id: 'stp_type',
        type: 'type',
        name: 'Input “hi”',
        params: { text: 'hi', foreground: 'Untitled - Notepad' },
        timeoutMs: 5000,
      },
    ],
  };
}

function stubProbe(review) {
  const reviews = [];
  return {
    reviews,
    executeStep: async (step) => ({ output: `${step.type} ok`, evidence: [] }),
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    readFocusedElement: async () => ({ found: false }),
    inspectWindowState: async () => ({
      state: 'foreground',
      foreground: { title: 'Untitled - Notepad', process: 'notepad' },
    }),
    screenReview: async (checkStep, ctx) => {
      reviews.push({ checkStep, ctx });
      return review(reviews.length, checkStep);
    },
  };
}

async function settle(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await sleep(25);
  }
  return store.db().runs.find((entry) => entry.id === runId);
}

test('a frame that does not match is re-read and passes on the retry', async () => {
  const d = resetDb();
  const wf = workflow('wf_screen_review_retry');
  d.workflows = [wf];
  const probe = stubProbe((call) => {
    if (call === 1) {
      throw new Error(
        'Screen check failed (vision 40%) | the text “hi” is not visible: the document is empty · window facts: unknown — no readable text [data/shots/first.png]'
      );
    }
    return {
      output: 'Screen verified (vision 92%): “hi” is in the document · window facts: pass',
      evidence: [{ kind: 'screenshot', path: 'data/shots/auto-review.png', width: 640, height: 360 }],
      judgement: { pass: true },
    };
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(done.status, 'passed', 'a retried match is still a pass');
  assert.equal(probe.reviews.length, 2, 'the frame was read twice');
  const first = probe.reviews[0].checkStep;
  assert.equal(first.type, 'verifyScreen', 'the review reuses the screen check, not a bare screenshot');
  assert.equal(first.params.text, 'hi', 'the deterministic window read is told what must be there');
  assert.match(first.params.question, /“hi”/);
  assert.equal(first.params.onError, 'warn');

  assert.equal(done.screenReviews.length, 1);
  const entry = done.screenReviews[0];
  assert.equal(entry.status, 'pass');
  assert.equal(entry.attempts, 2);
  assert.equal(entry.retried, true);
  assert.equal(entry.stepId, 'stp_type');
  assert.match(entry.detail, /Screen verified/);
  assert.equal(done.steps[0].screenReview.status, 'pass');
  assert.equal(done.steps[0].screenReview.attempts, 2);
  assert.ok(
    done.evidence.some((item) => item.path === 'data/shots/auto-review.png'),
    'the judged frame is kept as the run’s evidence'
  );
  assert.match(JSON.stringify(done.log), /did not match.*re-reading/s);
  assert.equal(engine.summary(done).screenReviewMismatches, 0);
});

test('a mismatch that survives the retry flags the step and sends the run to review', async () => {
  const d = resetDb();
  const wf = workflow('wf_screen_review_mismatch');
  d.workflows = [wf];
  const probe = stubProbe(() => {
    throw Object.assign(
      new Error(
        'Screen check failed (vision 35%) | the text “hi” is not visible: the window shows a blank page · window facts: fail — the foreground window is “Calculator”'
      ),
      { evidence: [{ kind: 'screenshot', path: 'data/shots/auto-fail.png' }] }
    );
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(probe.reviews.length, 2, 'one retry, then it stops');
  assert.equal(done.status, 'needs_review', 'the run is not reported as a clean pass');
  assert.equal(done.screenReviewFailed, true);
  assert.equal(done.screenReviewUnresolved, true);
  assert.equal(done.screenMismatches.length, 1);
  assert.equal(done.screenMismatches[0].stepName, 'Input “hi”');
  assert.match(done.screenMismatches[0].mismatch, /not visible/);
  assert.match(String(done.errorSummary), /screen check did not match/i);
  assert.equal(done.steps[0].screenReview.status, 'mismatch');
  assert.equal(done.steps[0].screenReview.attempts, 2);
  assert.ok(done.steps[0].audit, 'the step carries the warning');
  assert.ok(done.evidence.some((item) => item.path === 'data/shots/auto-fail.png'));

  const summary = engine.summary(done);
  assert.equal(summary.screenReviewMismatches, 1);
  assert.equal(summary.screenReviewUnresolved, true);
  assert.equal(summary.screenReviews[0].status, 'mismatch');
});

test('a check that could not read the frame is unverified, not a contradiction', async () => {
  const d = resetDb();
  const wf = workflow('wf_screen_review_offline');
  d.workflows = [wf];
  const probe = stubProbe(() => {
    throw Object.assign(
      new Error(
        'Screen check could not read the screen: the vision model was unreachable (network) · window facts: unknown [data/shots/offline.png]'
      ),
      { unreadable: true, evidence: [{ kind: 'screenshot', path: 'data/shots/offline.png' }] }
    );
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(probe.reviews.length, 1, 'nothing contradicted the step, so there is no retry');
  assert.equal(done.screenReviews[0].status, 'skipped');
  assert.equal(done.screenReviews[0].verdict, 'unverified');
  assert.equal(done.screenReviews[0].mismatch, '');
  assert.equal(done.screenReviewFailed, undefined);
  assert.equal(done.status, 'passed', 'an offline model never fails a run');
  assert.ok(done.evidence.some((item) => item.path === 'data/shots/offline.png'), 'the unread frame is still kept');

  const summary = engine.summary(done);
  assert.equal(summary.screenReviewSkipped, 1, 'an unread frame is not reported as a check');
  assert.equal(summary.screenReviewMismatches, 0);
});

test('an unreadable frame is recorded as unverified, never as a failure', async () => {
  const d = resetDb();
  const wf = workflow('wf_screen_review_unreadable');
  d.workflows = [wf];
  const probe = stubProbe(() => ({
    skipped: true,
    output: 'Screen check could not run (model offline); continuing because onError=warn.',
  }));

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(probe.reviews.length, 1, 'nothing contradicts the step, so there is no retry');
  assert.equal(done.screenReviews[0].status, 'skipped');
  assert.equal(done.screenReviews[0].verdict, 'unverified');
  assert.equal(done.screenReviewFailed, undefined);
  assert.equal(done.status, 'passed');
});

test('the retry budget is respected when retries are turned off', async () => {
  const d = resetDb({ retries: 0 });
  const wf = workflow('wf_screen_review_single_read');
  d.workflows = [wf];
  const probe = stubProbe(() => {
    throw new Error('Screen check failed | the wrong window is visible');
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(probe.reviews.length, 1, 'retries=0 means one reading');
  assert.equal(done.screenReviews[0].attempts, 1);
  assert.equal(done.status, 'needs_review');
});
