import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameCache, createStillnessTracker, isStill, waitUntilStill } from '../server/frames.js';

const cells = (value) => Array.from({ length: 16 }, () => value);

function clock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

test('a frame captured moments ago is reused instead of captured again', async () => {
  const time = clock();
  let captures = 0;
  const cache = createFrameCache({ capture: async () => ({ cells: cells(String(++captures).padStart(6, '1')) }), maxAgeMs: 400, now: time.now });

  const first = await cache.read();
  const second = await cache.read();
  assert.equal(captures, 1);
  assert.equal(first, second);

  time.advance(401);
  await cache.read();
  assert.equal(captures, 2);

  // A caller that needs the present can always refuse the cache.
  await cache.read({ maxAgeMs: 0 });
  assert.equal(captures, 3);
  assert.deepEqual(cache.stats(), { reads: 4, hits: 1, captures: 3, errors: 0, hitRate: 25 });
});

test('two readers arriving together share one capture', async () => {
  let captures = 0;
  const cache = createFrameCache({
    capture: async () => {
      captures += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { cells: cells('101010') };
    },
  });
  const [a, b] = await Promise.all([cache.read(), cache.read()]);
  assert.equal(captures, 1);
  assert.equal(a, b);
});

test('a failed capture is counted and not cached', async () => {
  let attempt = 0;
  const cache = createFrameCache({
    capture: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('screen unavailable');
      return { cells: cells('202020') };
    },
  });
  await assert.rejects(() => cache.read(), /screen unavailable/);
  assert.equal(cache.stats().errors, 1);
  const frame = await cache.read();
  assert.equal(frame.cells.length, 16);
  assert.equal(attempt, 2);
});

test('invalidate drops the frame so the next read captures again', async () => {
  let captures = 0;
  const cache = createFrameCache({ capture: async () => ({ cells: cells('303030'), n: ++captures }) });
  await cache.read();
  cache.invalidate();
  const next = await cache.read();
  assert.equal(next.n, 2);
});

test('the run waits for a still screen and reports how long it waited', async () => {
  const time = clock(0);
  const frames = [cells('101010'), cells('101010')];
  let index = 0;
  const result = await waitUntilStill({
    capture: async () => ({ cells: frames[Math.min(index++, frames.length - 1)] }),
    settleMs: 100,
    timeoutMs: 1000,
    now: time.now,
    sleep: async (ms) => time.advance(ms),
  });
  assert.equal(result.still, true);
  assert.equal(result.samples, 2);
  assert.ok(result.changedPct <= 1);
  assert.equal(result.waitedMs, 100);
  assert.equal(result.changedPct, 0);
});

test('a screen that never settles stops at the timeout instead of holding the step', async () => {
  const time = clock(0);
  let value = 0;
  // Alternating black and white is a frame that really did change; a one-digit
  // difference is below the stillness threshold and would (correctly) read still.
  const result = await waitUntilStill({
    capture: async () => ({ cells: cells(value++ % 2 ? 'ffffff' : '000000') }),
    settleMs: 200,
    timeoutMs: 600,
    now: time.now,
    sleep: async (ms) => time.advance(ms),
  });
  assert.equal(result.still, false);
  assert.ok(result.waitedMs >= 600);
  assert.ok(result.samples >= 3);
});

test('a frame at or below one percent change counts as still', () => {
  assert.equal(isStill({ changedPct: 0 }), true);
  assert.equal(isStill({ changedPct: 1 }), true);
  assert.equal(isStill({ changedPct: 1.1 }), false);
  assert.equal(isStill({ changedPct: 12 }), false);
});

test('the stillness tracker measures how long the screen has been quiet', () => {
  const tracker = createStillnessTracker();
  assert.equal(tracker.observe({ cells: cells('101010') }, 1000).still, null);
  const same = tracker.observe({ cells: cells('101010') }, 1200);
  assert.equal(same.still, true);
  assert.equal(same.quietMs, 200);
  const moved = tracker.observe({ cells: cells('f0f0f0') }, 1400);
  assert.equal(moved.still, false);
  assert.equal(moved.quietMs, 0);
  tracker.reset();
  assert.equal(tracker.observe({ cells: cells('101010') }, 2000).still, null);
});
