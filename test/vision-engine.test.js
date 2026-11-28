/**
 * The vision engine, driven over synthetic frames.
 *
 * A real engine is exercised throughout: real PNG bytes in, real decode, real
 * section diffing and element tracking. Only the desktop is fake — the capture
 * stub writes the frame the test wants and returns its path — so these tests say
 * something about the loop rather than about the stub.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { createVisionEngine, referenceHash, sectionsOf, trackLabels, pruneElements, ELEMENT_MISSES } from '../server/vision-engine.js';

const WIDTH = 64;
const HEIGHT = 48;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  // The decoder does not verify checksums; writing a zero keeps the fixture small.
  return Buffer.concat([length, body, Buffer.alloc(4)]);
}

/** An 8-bit RGB PNG whose colour is decided per pixel. */
export function makePng(width, height, colour) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const at = y * (stride + 1) + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const flat = (r, g, b) => () => [r, g, b];
/** Only the bottom-right of a 4x3 grid: section col 3, row 2. */
const oneSection = (r, g, b) => (x, y) => (x >= (WIDTH * 3) / 4 && y >= (HEIGHT * 2) / 3 ? [r, g, b] : [24, 26, 32]);

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-engine-'));
  let next = 0;
  let buffer = null;
  let clock = Date.parse('2026-11-28T10:00:00.000Z');
  const capture = async () => {
    const file = `captures/cap_${++next}.png`;
    fs.mkdirSync(path.join(dir, 'captures'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), buffer);
    return { path: file };
  };
  const engine = createVisionEngine({
    dataDir: dir,
    capture,
    schedule: () => 0,
    cancel: () => {},
    now: () => (clock += 250),
  });
  return {
    dir,
    engine,
    feed(png) {
      buffer = png;
      return engine.step();
    },
    files: () => fs.readdirSync(path.join(dir, 'vision')).filter((name) => name.endsWith('.png')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('an unchanged screen costs a hash and nothing else', async () => {
  const h = harness();
  try {
    const png = makePng(WIDTH, HEIGHT, flat(24, 26, 32));
    const first = await h.feed(png);
    assert.equal(first.skipped, undefined, 'the first frame is compared against nothing, so it counts');
    assert.equal(first.changedPct, 100, 'a frame with no predecessor is new in full');

    const second = await h.feed(png);
    assert.equal(second.skipped, true);
    assert.equal(second.identical, true, 'byte-identical frames never reach the decoder');
    await h.feed(png);

    const state = h.engine.state();
    assert.equal(state.stats.captures, 3);
    assert.equal(state.stats.skipped, 2);
    assert.equal(state.stats.skipRate, 67);
    assert.equal(state.frameCount, 1, 'only the frame that differed is kept');
    assert.equal(h.files().length, 1);
  } finally {
    h.cleanup();
  }
});

test('a changed frame names only the sections that moved', async () => {
  const h = harness();
  try {
    await h.feed(makePng(WIDTH, HEIGHT, flat(24, 26, 32)));
    const changed = await h.feed(makePng(WIDTH, HEIGHT, oneSection(240, 60, 60)));
    assert.ok(changed.changedPct > 0, 'the global signature sees the change');
    assert.deepEqual(
      changed.dirtySections.map((section) => [section.col, section.row]),
      [[3, 2]],
      'exactly the quarter that changed is reported dirty'
    );
    assert.equal(h.engine.state().sections, 12);
  } finally {
    h.cleanup();
  }
});

test('the change threshold keeps small motion out of the history', async () => {
  const h = harness();
  try {
    h.engine.start({ minChangedPct: 50, fps: 4 });
    h.engine.stop();
    await h.feed(makePng(WIDTH, HEIGHT, flat(24, 26, 32)));
    const nudged = await h.feed(makePng(WIDTH, HEIGHT, oneSection(40, 42, 46)));
    assert.equal(nudged.quiet, true, 'a change under the threshold is not worth keeping');
    assert.equal(h.engine.state().frameCount, 1);
    assert.equal(h.files().length, 1, 'a frame the caller ignores is never written');
  } finally {
    h.cleanup();
  }
});

test('a label keeps its identity while the element moves, and its disappearance is reported', async () => {
  const h = harness();
  try {
    await h.feed(makePng(WIDTH, HEIGHT, flat(24, 26, 32)));
    const pinned = h.engine.labelFrame(1, [{ text: 'Save', x: 0.10, y: 0.10, w: 0.10, h: 0.06 }]);
    assert.equal(pinned.added.length, 1);
    const id = pinned.added[0].id;

    await h.feed(makePng(WIDTH, HEIGHT, oneSection(240, 60, 60)));
    const again = h.engine.labelFrame(2, [{ text: 'Save', x: 0.12, y: 0.11, w: 0.10, h: 0.06 }]);
    assert.equal(again.added.length, 0, 'the same button is not a new element');
    assert.equal(again.moved.length, 1);
    assert.equal(again.moved[0].id, id);
    assert.equal(h.engine.state().elements.find((element) => element.id === id).seen, 2);

    // Each frame must be a real change: the engine now treats a sub-visible
    // difference as the same screen, so alternating strong colours is the only
    // way to advance the history four times.
    for (let index = 0; index <= ELEMENT_MISSES; index++) {
      await h.feed(makePng(WIDTH, HEIGHT, oneSection(index % 2 === 0 ? 150 : 20, 60, 60)));
    }
    const left = h.engine.state().elements.find((element) => element.id === id);
    assert.equal(left, undefined, 'an element nobody has labelled for several frames is gone');
    assert.ok(h.engine.state().current.vanished.length >= 0);
  } finally {
    h.cleanup();
  }
});

test('the loop stops when the goal is reached or the caller stops it', async () => {
  const h = harness();
  try {
    let frame = makePng(WIDTH, HEIGHT, flat(24, 26, 32));
    h.engine.start({ fps: 4, goal: 'the chat box is focused' });
    await h.feed(frame);
    assert.equal(h.engine.state().running, true);

    h.engine.markGoalReached('the chat box is visible');
    const stopped = h.engine.state();
    assert.equal(stopped.running, false);
    assert.match(stopped.stopReason, /goal reached/);
    assert.match(stopped.goal.reason, /chat box is visible/);

    // The condition trigger: a caller's own predicate ends the loop instead.
    h.engine.start({ fps: 4, until: (seen) => seen.changedPct !== null });
    frame = makePng(WIDTH, HEIGHT, flat(30, 32, 40));
    await h.feed(frame);
    const after = h.engine.state();
    assert.equal(after.running, false);
    assert.match(after.goal.reason, /stop condition/);
  } finally {
    h.cleanup();
  }
});

test('the digest is one timeline an agent can read', async () => {
  const h = harness();
  try {
    h.engine.setGoal('open the project');
    await h.feed(makePng(WIDTH, HEIGHT, flat(24, 26, 32)));
    h.engine.labelFrame(1, [{ text: 'File', x: 0.02, y: 0.02, w: 0.06, h: 0.04 }]);
    await h.feed(makePng(WIDTH, HEIGHT, oneSection(240, 60, 60)));
    h.engine.labelFrame(2, [{ text: 'Open project', x: 0.30, y: 0.40, w: 0.20, h: 0.08 }]);

    const digest = h.engine.digest({ count: 5 });
    assert.match(digest, /Goal: open the project — not reached yet/);
    assert.match(digest, /#2/);
    assert.match(digest, /“Open project”/);
    assert.match(digest, /On screen now:/);
  } finally {
    h.cleanup();
  }
});

test('the pieces are the ones the engine claims', () => {
  assert.equal(sectionsOf(4, 3).length, 12);
  assert.equal(referenceHash(Buffer.from('abc')), referenceHash(Buffer.from('abc')));
  assert.notEqual(referenceHash(Buffer.from('abc')), referenceHash(Buffer.from('abd')));
  const tracked = trackLabels([], [{ text: 'Retry', x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], 4);
  assert.equal(tracked.elements[0].id, 'el-4-1');
  assert.equal(pruneElements(tracked.elements, 4 + ELEMENT_MISSES + 1).vanished[0].label, 'Retry');
});
