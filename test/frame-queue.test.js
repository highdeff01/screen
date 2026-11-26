import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const queue = await load('server/frame-queue.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('judgements run in the order they were taken, one at a time', async () => {
  const runId = 'run_order';
  const seen = [];
  let active = 0;
  const job = (label) =>
    queue.enqueueFrameJob(runId, {
      kind: label,
      run: async () => {
        active += 1;
        assert.equal(active, 1, 'only one judgement at a time');
        await sleep(5);
        seen.push(label);
        active -= 1;
      },
    });
  job('first');
  job('second');
  job('third');
  await queue.drainFrameQueue(runId);
  assert.deepEqual(seen, ['first', 'second', 'third']);
  queue.clearFrameQueue(runId);
});

test('draining waits for every queued judgement', async () => {
  const runId = 'run_drain';
  let finished = 0;
  queue.enqueueFrameJob(runId, { run: async () => { await sleep(10); finished += 1; } });
  queue.enqueueFrameJob(runId, { run: async () => { await sleep(10); finished += 1; } });
  const state = await queue.drainFrameQueue(runId);
  assert.equal(finished, 2);
  assert.equal(state.pending, 0);
  assert.equal(state.jobs, 2);
  assert.equal(state.ran, 2);
  queue.clearFrameQueue(runId);
});

test('an unreadable frame marks the reader blind and the rest are recorded, not re-read', async () => {
  const runId = 'run_blind';
  const ran = [];
  const skipped = [];
  queue.enqueueFrameJob(runId, {
    run: async () => {
      ran.push('first');
      const err = new Error('Request timed out');
      err.unreadable = true;
      throw err;
    },
  });
  queue.enqueueFrameJob(runId, {
    run: async () => ran.push('second'),
    onBlind: (reason) => skipped.push(reason),
  });
  const state = await queue.drainFrameQueue(runId);
  assert.deepEqual(ran, ['first']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /timed out/);
  assert.equal(state.blind, true);
  assert.equal(queue.readerIsBlind(runId), true);
  queue.clearFrameQueue(runId);
});

test('a normal failure is recorded and the queue keeps going', async () => {
  const runId = 'run_error';
  const ran = [];
  queue.enqueueFrameJob(runId, {
    run: async () => {
      throw new Error('the reply was not JSON');
    },
  });
  queue.enqueueFrameJob(runId, { run: async () => ran.push('next') });
  const state = await queue.drainFrameQueue(runId);
  assert.deepEqual(ran, ['next']);
  assert.match(state.lastError, /not JSON/);
  assert.equal(state.blind, false, 'a broken reply is not an unreachable reader');
  queue.clearFrameQueue(runId);
});

test('clearing a run forgets its queue and its blindness', async () => {
  const runId = 'run_clear';
  queue.markReaderBlind(runId, 'endpoint timed out');
  assert.equal(queue.readerIsBlind(runId), true);
  queue.clearFrameQueue(runId);
  assert.equal(queue.readerIsBlind(runId), false);
  assert.equal(queue.frameQueueState(runId).jobs, 0);
});
