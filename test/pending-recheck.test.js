import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const {
  normalizeRecheckSettings,
  carryCompletedSteps,
  recheckCandidates,
  runPendingRecheck,
  markRunInterrupted,
} = await load('server/pending-recheck.js');

test('recheck settings are bounded and cheap by default', () => {
  const defaults = normalizeRecheckSettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.continueAfter, false);
  assert.equal(defaults.maxAttempts, 3);
  assert.equal(defaults.prepMs, 4000);
  const clamped = normalizeRecheckSettings({
    maxAttempts: 999,
    intervalMs: 1,
    prepMs: -50,
    maxPendingMs: 1,
    maxTasks: 999,
    continueAfter: true,
  });
  assert.equal(clamped.maxAttempts, 10);
  assert.equal(clamped.intervalMs, 250);
  assert.equal(clamped.prepMs, 0);
  assert.equal(clamped.maxPendingMs, 1000);
  assert.equal(clamped.maxTasks, 20);
  assert.equal(clamped.continueAfter, true);
});

test('completed steps are passed through, changed or failed steps are kept', () => {
  const previous = [
    { id: 'p1', type: 'type', status: 'passed', params: { text: 'hi' }, output: 'typed once', attempts: 1 },
    { id: 'p2', type: 'wait', status: 'failed', params: { ms: 5 } },
    { id: 'p3', type: 'note', status: 'passed', params: { text: 'done' } },
  ];
  const next = [
    { id: 'n1', type: 'type', params: { text: 'hi' } },
    { id: 'n2', type: 'wait', params: { ms: 5 } },
    { id: 'n3', type: 'type', params: { text: 'different' } },
    { id: 'n4', type: 'note', params: { text: 'done' } },
  ];
  const carried = carryCompletedSteps(previous, next, { runId: 'run_prev', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(carried.steps[0].status, 'passed');
  assert.equal(carried.steps[0].carriedFrom.runId, 'run_prev');
  assert.equal(carried.steps[0].carriedFrom.stepId, 'p1');
  assert.equal(carried.steps[1].status, undefined, 'the failed step still runs');
  assert.equal(carried.steps[2].status, undefined, 'a changed effect still runs');
  assert.equal(carried.steps[3].status, 'passed');
  assert.deepEqual(
    carried.carried.map((entry) => entry.id),
    ['n1', 'n4']
  );
});

test('recheck candidates are stalled or timing-shaped steps only', () => {
  const run = {
    createdAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    steps: [
      { id: 'a', type: 'type', status: 'passed', params: {} },
      {
        id: 'b',
        type: 'waitFor',
        status: 'failed',
        error: 'Timed out after 5000ms waiting for window to be present: Notepad',
        params: { kind: 'window', value: 'Notepad' },
      },
      { id: 'c', type: 'click', status: 'failed', error: 'Refusing to send keys: wrong window', params: {} },
      { id: 'd', type: 'wait', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', params: {} },
      { id: 'e', type: 'wait', status: 'pending', params: {} },
    ],
    pendingVerification: [
      { stepId: 'f', stepName: 'Awaiting file', type: 'writeTextFile', checks: ['file'], target: 'x.txt' },
    ],
  };
  const candidates = recheckCandidates(run, { maxPendingMs: 45000 }, { nowMs: Date.parse('2026-01-01T00:02:00.000Z') });
  assert.deepEqual(candidates.map((entry) => entry.stepId).sort(), ['b', 'd', 'e', 'f']);
  assert.equal(candidates.find((entry) => entry.stepId === 'b').passable, true, 'a timed-out wait can be re-read');
  assert.equal(candidates.find((entry) => entry.stepId === 'd').passable, false, 'an open action needs a real run');
  assert.equal(candidates.find((entry) => entry.stepId === 'f').passable, true, 'a silent check can be re-read');
  assert.equal(candidates.some((entry) => entry.stepId === 'c'), false, 'an intent failure is not retried blindly');
});

test('the recheck loop keeps a screenshot per attempt and uses retry timing', async () => {
  const run = {
    steps: [
      {
        id: 's1',
        type: 'waitFor',
        status: 'failed',
        error: 'Timed out after 5000ms waiting for window to be present: Notepad',
        params: { kind: 'window', value: 'Notepad' },
      },
    ],
    evidence: [],
    pendingVerification: [],
  };
  const sleeps = [];
  let reads = 0;
  const summary = await runPendingRecheck(
    run,
    { prepMs: 1000, intervalMs: 500, maxAttempts: 3 },
    {
      sleep: async (ms) => sleeps.push(ms),
      now: () => '2026-01-01T00:00:00.000Z',
      uid: (prefix) => `${prefix}_1`,
      capture: async () => ({ path: 'data/shots/recheck.png', width: 640, height: 360 }),
      verify: async () => {
        reads += 1;
        return reads < 2 ? { ok: false, detail: 'window is closed' } : { ok: true, detail: 'window foreground: Notepad' };
      },
    }
  );
  assert.deepEqual(sleeps, [1000, 500], 'prep allowance first, then the retry timing');
  assert.equal(summary.attempts, 2);
  assert.equal(summary.evidence.length, 2);
  assert.equal(run.evidence.length, 2);
  assert.equal(summary.status, 'resolved');
  assert.equal(run.steps[0].status, 'passed');
  assert.match(run.steps[0].output, /Recheck passed on attempt 2/);
  assert.equal(run.steps[0].rechecked.evidenceId, 'evd_1');
});

test('an unresolved recheck becomes an operator task instead of vanishing', async () => {
  const run = {
    steps: [{ id: 's1', type: 'expect', status: 'failed', error: 'No window title contains "Untitled - Notepad"', params: {} }],
    evidence: [],
    pendingVerification: [],
  };
  const summary = await runPendingRecheck(
    run,
    { prepMs: 0, intervalMs: 250, maxAttempts: 2 },
    {
      sleep: async () => {},
      now: () => '2026-01-01T00:00:00.000Z',
      uid: (prefix) => `${prefix}_1`,
      capture: async () => null,
      verify: async () => ({ ok: false, detail: 'window is closed' }),
    }
  );
  assert.equal(summary.status, 'needs_attention');
  assert.equal(summary.tasks.length, 1);
  assert.equal(summary.tasks[0].assignedTo, 'operator');
  assert.equal(summary.tasks[0].kind, 'recheck');
  assert.equal(run.recheckTasks.length, 1);
  assert.equal(run.steps[0].status, 'failed');
});

test('an interrupted run keeps its completed steps and reopens the step in flight', () => {
  const run = {
    id: 'run_live',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    steps: [
      { id: 'a', status: 'passed' },
      { id: 'b', status: 'running', startedAt: '2026-01-01T00:00:10.000Z' },
      { id: 'c', status: 'pending' },
    ],
  };
  assert.equal(markRunInterrupted(run, { at: '2026-01-01T00:00:30.000Z' }), true);
  assert.equal(run.status, 'needs_review');
  assert.equal(run.interruptedFrom, 'running');
  assert.equal(run.durationMs, 30000);
  assert.equal(run.steps[0].status, 'passed');
  assert.equal(run.steps[1].status, 'failed');
  assert.match(run.steps[1].error, /Interrupted/);
  assert.equal(run.steps[2].status, 'pending');
  assert.equal(markRunInterrupted(run, { at: '2026-01-01T00:01:00.000Z' }), false);
});
