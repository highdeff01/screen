import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-pipeline-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const pipeline = await load('server/pipeline.js');

beforeEach(() => {
  pipeline.__resetPipeline();
});

after(() => {
  try {
    pipeline.__resetPipeline();
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a job needs a handler and runs to a recorded checkpoint', async () => {
  assert.throws(() => pipeline.enqueue({ kind: 'ghost' }), /No handler/);
  let called = 0;
  pipeline.registerHandler('echo', async (payload) => {
    called += 1;
    return `echo:${payload.word}`;
  });
  pipeline.enqueue({ kind: 'echo', payload: { word: 'hi' }, key: 'echo:hi' });
  pipeline.runNow();
  const status = await pipeline.drain();
  assert.equal(called, 1);
  assert.equal(status.done[0].ok, true);
  assert.deepEqual(status.done[0].result, 'echo:hi');
  // The backwards-flow record: what actually happened, newest first.
  assert.equal(status.checkpoints[0].kind, 'echo');
  assert.match(status.checkpoints[0].summary, /finished/);
  assert.equal(status.queued.length, 0, 'a finished job leaves the queue');
});

test('the same pending key is not queued twice', () => {
  pipeline.registerHandler('slow', async () => {
    await delay(50);
    return 'done';
  });
  const first = pipeline.enqueue({ kind: 'slow', key: 'slow:one' });
  const again = pipeline.enqueue({ kind: 'slow', key: 'slow:one' });
  assert.equal(again.id, first.id, 'the duplicate re-pointed at the pending job');
  assert.equal(pipeline.pipelineStatus().queued.length, 1);
});

test('workers cap concurrency and finish everything', async () => {
  let active = 0;
  let peak = 0;
  pipeline.registerHandler('measure', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(30);
    active -= 1;
    return 'ok';
  });
  const settings = pipeline.pipelineSettings();
  settings.workers = 2;
  for (let i = 0; i < 5; i += 1) pipeline.enqueue({ kind: 'measure', key: `m${i}` });
  pipeline.runNow();
  await pipeline.drain();
  assert.ok(peak <= 2, `never more than 2 at once (peak was ${peak})`);
  assert.equal(pipeline.pipelineStatus().done.length, 5);
  pipeline.pipelineSettings().workers = 2;
});

test('a failing handler is recorded, not lost, and re-enqueue retries', async () => {
  let attempts = 0;
  pipeline.registerHandler('flaky', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('the model is offline');
    return 'recovered';
  });
  pipeline.enqueue({ kind: 'flaky', key: 'flaky:1' });
  pipeline.runNow();
  let status = await pipeline.drain();
  assert.equal(status.done[0].ok, false);
  assert.match(status.done[0].error, /offline/);
  assert.match(status.checkpoints[0].summary, /failed/);
  // Re-enqueueing the same key after failure is a fresh retry.
  pipeline.enqueue({ kind: 'flaky', key: 'flaky:1' });
  pipeline.runNow();
  status = await pipeline.drain();
  assert.equal(status.done[0].ok, true);
  assert.equal(status.done[0].attempts, 2);
});

test('higher priority jobs are picked first', async () => {
  const order = [];
  pipeline.registerHandler('note', async (payload) => {
    order.push(payload.name);
    return payload.name;
  });
  pipeline.enqueue({ kind: 'note', payload: { name: 'low' }, key: 'low', priority: 0 });
  pipeline.enqueue({ kind: 'note', payload: { name: 'high' }, key: 'high', priority: 5 });
  pipeline.pipelineSettings().workers = 1;
  pipeline.runNow();
  await pipeline.drain();
  assert.equal(order[0], 'high', 'the urgent job went first');
  pipeline.pipelineSettings().workers = 2;
});
