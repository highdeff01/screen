import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-verloop-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const loop = await load('server/verification-loop.js');

after(() => {
  loop.stopVerificationLoop();
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function makeRun(overrides = {}) {
  const d = store.db();
  const run = {
    id: `run_${Math.random().toString(36).slice(2)}`,
    workflowName: 'Check the save',
    workflowGoal: 'save the file in the editor',
    status: 'passed',
    dryRun: false,
    steps: [{ id: 'stp_1', name: 'Save file', type: 'key', status: 'passed', startedAt: new Date().toISOString() }],
    pendingVerification: [
      { stepId: 'stp_1', stepName: 'Save file', checks: ['fileExists'], target: 'Code', at: new Date().toISOString() },
    ],
    log: [],
    ...overrides,
  };
  d.runs = [...(d.runs || []), run];
  return run;
}

const quietDesk = async () => ({ idleMs: 60000, foreground: null });
const busyDesk = async () => ({ idleMs: 0, foreground: null });

test('a review that settles the check finishes the run and says so', async () => {
  const run = makeRun();
  const entry = await loop.reviewRun(run, { verify: async () => ({ remaining: 0 }), presence: quietDesk });
  assert.equal(entry.kind, 'settled');
  assert.equal(run.verificationState, 'complete');
  assert.equal(run.verificationAttempts, 1);
  assert.equal(run.verificationReview.length, 1);
});

test('open checks are re-reviewed and the screen baseline is taken once', async () => {
  const run = makeRun();
  const verify = async () => ({ remaining: 1 });
  const shots = ['aaaa1111', 'aaaa1111', 'bbbb2222'];
  let taken = 0;
  const screenSignature = async () => shots[Math.min(taken++, shots.length - 1)];

  const first = await loop.reviewRun(run, { verify, presence: quietDesk, screenSignature });
  assert.equal(first.kind, 'review');
  assert.equal(first.drift, null, 'the first screen read is the baseline, not drift');
  assert.equal(first.remaining, 1);

  const second = await loop.reviewRun(run, { verify, presence: quietDesk, screenSignature });
  assert.equal(second.drift, false, 'an identical screen is not drift');

  const third = await loop.reviewRun(run, { verify, presence: quietDesk, screenSignature });
  assert.equal(third.drift, true, 'a changed screen is drift');
  assert.equal(run.verificationState, 'checking');
});

test('screen reads wait while the person at the desk is typing', async () => {
  const run = makeRun();
  let reads = 0;
  const entry = await loop.reviewRun(
    run,
    {
      verify: async () => ({ remaining: 2 }),
      presence: busyDesk,
      screenSignature: async () => {
        reads += 1;
        return 'cccc3333';
      },
      policy: { driftAfterAttempts: 1 },
    }
  );
  assert.equal(reads, 0);
  assert.match(String(entry.deferred), /quiet/);
});

test('learned habits are offered as workarounds once the check keeps failing', async () => {
  const run = makeRun();
  const entry = await loop.reviewRun(
    run,
    {
      verify: async () => ({ remaining: 1 }),
      presence: quietDesk,
      habits: () => [
        { status: 'passed', apps: ['Code', 'Finder'], summary: 'saved then closed the editor preview' },
      ],
      policy: { habitAfterAttempts: 1 },
    }
  );
  assert.equal(entry.suggestions.length, 1);
  assert.match(entry.suggestions[0], /Learned passed for Code\/Finder/);
});

test('a check that never settles is declared stalled with a strategy suggestion', async () => {
  const run = makeRun({ verificationAttempts: 5 });
  const entry = await loop.reviewRun(run, {
    verify: async () => ({ remaining: 1 }),
    presence: quietDesk,
    policy: { stallAfterAttempts: 6 },
  });
  assert.equal(entry.kind, 'stalled');
  assert.equal(run.verificationStalled, true);
  assert.match(entry.suggestions.at(-1), /Replan or repair/);
});

test('a live step that has not moved for minutes is reported as blocked once', async () => {
  const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const run = makeRun({
    id: 'run_blocked',
    status: 'running',
    pendingVerification: [],
    steps: [{ id: 'stp_wait', name: 'Click Save', type: 'click', status: 'running', startedAt }],
  });
  const first = loop.detectBlockedRuns({ clock: () => Date.now() });
  assert.equal(first.some((entry) => entry.runId === 'run_blocked'), true);
  const second = loop.detectBlockedRuns({ clock: () => Date.now() });
  assert.equal(second.length, 0, 'the same blocked step is only recorded once');
  assert.equal(run.verificationReview.at(-1).kind, 'blocked');
});

test('a failed run keeps its queued check as history and is not polled', async () => {
  const run = makeRun({ status: 'failed', endedAt: new Date().toISOString() });
  let verified = 0;
  const summary = await loop.reviewPendingVerifications(
    {
      verify: async () => {
        verified += 1;
        return { remaining: 1 };
      },
      presence: quietDesk,
      detectBlocked: false,
    },
    { onlyRunIds: [run.id] }
  );
  assert.equal(verified, 0);
  assert.equal(summary.reviewed, 0);
});

test('each further review of the same run waits longer', async () => {
  const run = makeRun({ endedAt: new Date().toISOString() });
  const verify = async () => ({ remaining: 1 });
  const first = await loop.reviewRun(run, { verify, presence: quietDesk });
  assert.equal(first.nextReviewInMs, 5000);
  const eligible = await loop.reviewPendingVerifications(
    { verify, presence: quietDesk, detectBlocked: false, policy: { maxRunsPerPass: 4 } },
    { onlyRunIds: [run.id] }
  );
  assert.equal(eligible.reviewed, 0, 'the run is not due again yet');

  const manual = await loop.reviewPendingVerifications(
    { verify, presence: quietDesk, detectBlocked: false, ignoreBackoff: true },
    { onlyRunIds: [run.id] }
  );
  assert.equal(manual.reviewed, 1, 'an operator asking now still gets a read');
  assert.equal(run.verificationAttempts, 2);
  assert.equal(run.verificationReview.at(-1).nextReviewInMs, 15000);
});

test('a queued check left open for hours is marked stale, not re-read', async () => {
  const run = makeRun({ endedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
  let verified = 0;
  const summary = await loop.reviewPendingVerifications(
    {
      verify: async () => {
        verified += 1;
        return { remaining: 1 };
      },
      presence: quietDesk,
      detectBlocked: false,
    },
    { onlyRunIds: [run.id] }
  );
  assert.equal(verified, 0);
  assert.equal(run.verificationState, 'stale');
  assert.equal(summary.stale >= 1, true);
});


test('one pass reviews only a handful of fresh runs', async () => {
  const runs = [1, 2, 3, 4, 5].map((n) =>
    makeRun({ id: `run_cap_${n}`, endedAt: new Date(Date.now() - n * 1000).toISOString() })
  );
  const reviewed = [];
  const summary = await loop.reviewPendingVerifications(
    {
      verify: async (id) => {
        reviewed.push(id);
        return { remaining: 1 };
      },
      presence: quietDesk,
      detectBlocked: false,
      policy: { maxRunsPerPass: 2 },
    },
    { onlyRunIds: runs.map((run) => run.id) }
  );
  assert.equal(summary.reviewed, 2);
  assert.deepEqual(reviewed, ['run_cap_1', 'run_cap_2'], 'newest first, capped per pass');
});

test('the loop starts, ticks and stops', async () => {
  const run = makeRun({ id: 'run_loop_tick', endedAt: new Date().toISOString() });
  let settled = false;
  const status = loop.startVerificationLoop({
    intervalMs: 1000,
    deps: {
      verify: async () => {
        settled = true;
        return { remaining: 0 };
      },
      presence: quietDesk,
      onlyRunIds: [run.id],
    },
  });
  assert.equal(status.running, true);
  assert.equal(status.intervalMs, 1000);
  await loop.sleep(1400);
  assert.equal(settled, true, 'the timer ran a pass');
  assert.equal(loop.loopStatus().passes >= 1, true);
  const stopped = loop.stopVerificationLoop();
  assert.equal(stopped.running, false);
  assert.equal(run.verificationState, 'complete');
});
