import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFrames, createLiveMap } from '../server/live-map.js';

const cells = (value) => Array.from({ length: 4 }, () => value);
const frame = ({ at = 0, left = 100, top = 100, cursor = { x: 10, y: 10 }, colour = '112233' } = {}) => ({
  at,
  window: { found: true, left, top, width: 700, height: 500, title: 'Sightline Profile' },
  foreground: { title: 'Sightline Profile', process: 'pythonw' },
  cursor,
  signature: { width: 2, height: 2, cells: cells(colour) },
});

test('two frames are compared by movement, change and pointer travel', () => {
  const before = frame({ cursor: { x: 10, y: 10 }, colour: '112233' });
  const after = frame({ left: 180, top: 160, cursor: { x: 13, y: 14 }, colour: 'ffffff' });
  const compared = compareFrames(before, after);
  assert.equal(compared.motion.dx, 80);
  assert.equal(compared.motion.dy, 60);
  assert.equal(compared.changedPct, 100, 'every cell changed colour');
  assert.deepEqual(compared.pointer, { dx: 3, dy: 4, distance: 5 });
  assert.match(compared.note, /moved 80 px right and 60 px down/);
});

test('a frame with nothing to compare against says so instead of guessing', () => {
  assert.equal(compareFrames(null, frame()).changedPct, null);
  assert.match(compareFrames(null, frame()).note, /nothing to compare/);
});

test('the ring keeps the most recent samples and drops the oldest', async () => {
  let left = 0;
  const map = createLiveMap({ capture: async () => frame({ left: (left += 10) }), max: 3 });
  for (let index = 0; index < 5; index++) await map.sample({ force: true });
  const state = map.state();
  assert.equal(state.samples, 3);
  assert.equal(state.limit, 3);
  assert.equal(state.current.window.left, 50);
  assert.equal(state.previous.window.left, 40);
  assert.equal(state.trend.length, 3);
  assert.equal(state.motion.dx, 10, 'the current sample carries its movement from the one before it');
});

test('consecutive samples report how much of the screen changed', async () => {
  const colours = ['112233', 'ffffff'];
  let index = 0;
  const map = createLiveMap({ capture: async () => frame({ colour: colours[Math.min(index++, colours.length - 1)] }) });
  await map.sample({ force: true });
  assert.equal(map.state().changedPct, null, 'the first sample has nothing to compare against');
  await map.sample({ force: true });
  assert.equal(map.state().changedPct, 100, 'every cell changed colour between the two reads');
  assert.equal(map.state().current.changedCells, 4);
});

test('a second read inside the interval reuses the first instead of reading the desktop again', async () => {
  let clock = 1000;
  let captures = 0;
  const map = createLiveMap({
    capture: async () => {
      captures += 1;
      return frame();
    },
    now: () => clock,
    minIntervalMs: 100,
  });
  const first = await map.sample();
  assert.equal(first.reused, false);
  clock += 40;
  const second = await map.sample();
  assert.equal(second.reused, true);
  assert.equal(captures, 1);
  clock += 120;
  await map.sample();
  assert.equal(captures, 2);
  await map.sample({ force: true });
  assert.equal(captures, 3, 'a forced read is never skipped');
});

test('two callers at once share one capture', async () => {
  let captures = 0;
  let release = null;
  const map = createLiveMap({
    capture: () => {
      captures += 1;
      return new Promise((resolve) => {
        release = () => resolve(frame());
      });
    },
  });
  const a = map.sample();
  const b = map.sample();
  release();
  await Promise.all([a, b]);
  assert.equal(captures, 1);
});

test('a capture that fails is recorded as an error, not thrown at the caller', async () => {
  const map = createLiveMap({
    capture: async () => {
      throw new Error('the screen could not be captured');
    },
  });
  const result = await map.sample();
  assert.equal(result.ok, false);
  assert.equal(result.sample.error, 'the screen could not be captured');
  const state = map.state();
  assert.equal(state.error, 'the screen could not be captured');
  assert.equal(state.stats.errors, 1);
  assert.equal(state.samples, 1, 'the failure is kept, so a quiet reader is visible');
});
