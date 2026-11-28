/**
 * The labelling agent, over real frames and a stubbed model.
 *
 * The engine, the PNG, the frame ring and the label tracking are real; only the
 * model call is a stub, so these tests say what the reviewer does with an answer
 * rather than whether a particular endpoint is up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import { createVisionEngine } from '../server/vision-engine.js';
import { createVisionReviewer, cleanLabels, reviewPrompt, MAX_LABELS } from '../server/vision-review.js';

const WIDTH = 64;
const HEIGHT = 48;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  return Buffer.concat([length, body, Buffer.alloc(4)]);
}

/** An 8-bit RGB PNG whose colour is decided per pixel. */
function makePng(width, height, colour) {
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
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const flat = (r, g, b) => () => [r, g, b];

async function waitFor(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the reviewer');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(ask, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-review-'));
  let next = 0;
  let buffer = makePng(WIDTH, HEIGHT, flat(20, 22, 28));
  const capture = async () => {
    const file = `captures/cap_${++next}.png`;
    fs.mkdirSync(path.join(dir, 'captures'), { recursive: true });
    fs.writeFileSync(path.join(dir, file), buffer);
    return { path: file };
  };
  const engine = createVisionEngine({ dataDir: dir, capture, schedule: () => 0, cancel: () => {} });
  const reviewer = createVisionReviewer({ engine, dataDir: dir, ask, log: () => {}, minGapMs: 0, ...options });
  return {
    dir,
    engine,
    reviewer,
    feed(png) {
      buffer = png;
      return engine.step();
    },
    cleanup() {
      reviewer.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('labels are clamped, de-duplicated and capped', () => {
  const labels = cleanLabels([
    { text: '  Save  ', x: 1.4, y: -0.2, w: 0.2, h: 0.1 },
    { text: 'save', x: 0.1, y: 0.1 },
    { text: '', x: 0.5, y: 0.5 },
    { label: 'Export', kind: 'arrow', x: 0.3, y: 0.4, w: 0.1, h: 0.05 },
    { name: 'Cancel', kind: 'circle', x: 0.2, y: 0.2 },
    null,
  ]);
  assert.equal(labels.length, 3, 'empty text and a duplicate name are dropped');
  assert.deepEqual(labels[0], { text: 'Save', kind: 'box', x: 1, y: 0, w: 0.2, h: 0.1 });
  assert.equal(labels[1].kind, 'arrow');
  assert.equal(labels[2].kind, 'box', 'an unknown kind falls back to a box');

  const many = cleanLabels(Array.from({ length: 40 }, (_, index) => ({ text: `Control ${index}`, x: 0, y: 0 })));
  assert.equal(many.length, MAX_LABELS);
});

test('the prompt asks for labels, keeps the goal and the timeline', () => {
  const [system, user] = reviewPrompt({
    goal: 'Export the report',
    digest: 'Vision engine — frame #3 changed 12%',
    frame: { seq: 3, changedPct: 12, dirtySections: [{ col: 1, row: 1 }] },
  });
  assert.match(system.content, /JSON only/);
  assert.match(system.content, /"labels"/);
  assert.match(user.content, /Goal: Export the report/);
  assert.match(user.content, /Frame #3, 12% of the screen changed, 1 section\(s\) moved/);
  assert.match(user.content, /Recent timeline:/);
});

test('a reviewed frame comes back labelled and tracked', async () => {
  const calls = [];
  const ask = async (messages, options) => {
    calls.push({ messages, options });
    return {
      ok: true,
      ms: 120,
      content:
        '```json\n{"labels":[{"text":" Save ","kind":"box","x":0.7,"y":0.1,"w":0.1,"h":0.05},{"text":"Export","x":0.4,"y":0.6,"w":0.2,"h":0.05}],"summary":"The export dialog is open.","next":"Click Save"}\n```',
    };
  };
  const h = harness(ask);
  try {
    await h.feed(makePng(WIDTH, HEIGHT, flat(20, 22, 28)));
    const entry = await h.reviewer.reviewNow();
    assert.equal(entry.seq, 1);
    assert.equal(entry.summary, 'The export dialog is open.');
    assert.equal(entry.next, 'Click Save');
    assert.deepEqual(entry.labels, ['Save', 'Export']);
    assert.equal(entry.tracked, true);
    assert.equal(entry.ms, 120);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.images.length, 1, 'the frame itself is sent');
    assert.ok(calls[0].options.images[0].length > 50, 'the image is a base64 PNG, not an empty string');
    assert.match(calls[0].messages.at(-1).content, /Frame #1/);

    const engine = h.engine.state();
    assert.equal(engine.elements.length, 2, 'both labels became tracked elements');
    assert.ok(engine.current.labels.some((label) => label.text === 'Save'));

    const review = h.reviewer.state();
    assert.equal(review.calls, 1);
    assert.equal(review.labels, 2);
    assert.equal(review.errors, 0);
    assert.equal(review.lastError, '');
    assert.equal(review.history.length, 1);
  } finally {
    h.cleanup();
  }
});

test('a failed call is recorded, not thrown, and the stream keeps its pixels', async () => {
  const h = harness(async () => ({ ok: false, error: 'Endpoint 500: no model' }));
  try {
    await h.feed(makePng(WIDTH, HEIGHT, flat(20, 22, 28)));
    await assert.rejects(h.reviewer.reviewNow(), /no model/);
    const review = h.reviewer.state();
    assert.equal(review.errors, 1);
    assert.match(review.lastError, /no model/);
    assert.equal(review.labels, 0);
    assert.equal(review.lastReview, null);
    assert.equal(h.engine.state().elements.length, 0);
    assert.equal(h.engine.state().frameCount, 1, 'the frame was kept even though its reading failed');
  } finally {
    h.cleanup();
  }
});

test('a new frame triggers one review, and the gap defers the next', async () => {
  let clockValue = 1_000_000;
  const calls = [];
  const ask = async () => {
    calls.push(1);
    return { ok: true, content: '{"labels":[],"summary":"ok","next":""}' };
  };
  const h = harness(ask, { minGapMs: 5000, clock: () => clockValue });
  try {
    await h.feed(makePng(WIDTH, HEIGHT, flat(20, 22, 28)));
    h.reviewer.start();
    await waitFor(() => calls.length === 1);

    clockValue += 1000;
    await h.feed(makePng(WIDTH, HEIGHT, (x) => (x > WIDTH / 2 ? [200, 40, 40] : [20, 22, 28])));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls.length, 1, 'a frame inside the gap is not sent');
    assert.ok(h.reviewer.state().deferred >= 1);
    assert.equal(h.engine.state().frameCount, 2);

    clockValue += 5000;
    await h.feed(makePng(WIDTH, HEIGHT, (x, y) => (y > HEIGHT / 2 ? [30, 160, 60] : [20, 22, 28])));
    await waitFor(() => calls.length === 2);
    assert.equal(h.reviewer.state().calls, 2);
    assert.equal(h.reviewer.state().lastReview.seq, 3);
  } finally {
    h.cleanup();
  }
});
