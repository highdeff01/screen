import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-simscreen-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const sim = await load('server/screenshot-sim.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- PNG fixtures */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function makePng(width, height, color) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const offset = y * stride;
    raw[offset] = 0;
    for (let x = 0; x < width; x++) {
      raw[offset + 1 + x * 3] = color[0];
      raw[offset + 2 + x * 3] = color[1];
      raw[offset + 3 + x * 3] = color[2];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeFrame(name, color, mtimeMs) {
  const file = path.join(tempRoot, name);
  fs.writeFileSync(file, makePng(64, 36, color));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return { path: file, mtimeMs };
}

const identity = (target) => target;

/* --------------------------------------------------------------------- tests */

test('a PNG screenshot decodes to a comparable signature grid', () => {
  const decoded = sim.decodePng(makePng(64, 36, [255, 0, 0]));
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 36);
  const signature = sim.signatureOfImage(decoded);
  assert.equal(signature.cells.length, 32 * 18);
  assert.equal(signature.cells[0], 'ff0000');
  assert.equal(signature.blank, true, 'a solid frame is flagged as flat');
  assert.equal(signature.width, 64);
});

test('frames are matched to steps by time and judged against the recorded status', () => {
  const base = Date.now() - 60000;
  const before = writeFrame('a-before.png', [20, 20, 20], base + 500);
  const unchanged = writeFrame('b-click.png', [20, 20, 20], base + 2500);
  const changed = writeFrame('c-wait.png', [200, 40, 40], base + 3600);
  const frames = [before, unchanged, changed];
  const run = {
    id: 'run_sim',
    workflowId: 'wf_sim',
    workflowName: 'Demo download',
    dryRun: false,
    evidence: [],
    steps: [
      { id: 's1', type: 'openUrl', name: 'Open the page', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 1000).toISOString() },
      { id: 's2', type: 'click', name: 'Click Download', status: 'passed', startedAt: new Date(base + 2000).toISOString(), endedAt: new Date(base + 3000).toISOString() },
      { id: 's3', type: 'wait', name: 'Wait for the page', status: 'passed', startedAt: new Date(base + 3000).toISOString(), endedAt: new Date(base + 4000).toISOString() },
    ],
  };
  const result = sim.analyzeRun(run, { frames, resolve: identity });
  assert.equal(result.runId, 'run_sim');
  assert.equal(result.method, 'screenshots');
  const click = result.breakdown.find((entry) => entry.stepId === 's2');
  assert.equal(click.verdict, 'mismatch', 'a passed click with identical frames is a mismatch');
  assert.equal(click.changedPct, 0);
  assert.equal(click.status, 'passed');
  assert.match(click.suggestion, /verifyScreen|did not change/);
  assert.equal(result.summary.mismatch, 1);
  assert.equal(result.summary.verdict, 'disagrees');
  assert.ok(result.suggestions.some((line) => /verifyScreen|did not change/i.test(line)));
  const wait = result.breakdown.find((entry) => entry.stepId === 's3');
  assert.equal(wait.verdict, 'observed', 'a wait is not required to change the screen');
  assert.equal(result.coverage.steps, 3);
});

test('a step with no capture is reported as uncovered instead of guessed', () => {
  const base = Date.now() - 60000;
  const run = {
    id: 'run_missing',
    workflowId: 'wf_sim',
    workflowName: 'Bare run',
    dryRun: false,
    evidence: [],
    steps: [
      { id: 'a', type: 'click', name: 'Click Install', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 800).toISOString() },
    ],
  };
  const result = sim.analyzeRun(run, { frames: [], resolve: identity });
  assert.equal(result.breakdown[0].verdict, 'missing');
  assert.match(result.breakdown[0].suggestion, /screenshot/i);
  assert.equal(result.summary.verdict, 'no_evidence');
  assert.ok(result.suggestions.some((line) => /live monitor|screenshot steps/i.test(line)));
});

test('proxy captures never confirm a step and cannot become a future baseline', () => {
  const base = Date.now() - 60000;
  const before = writeFrame('proxy-before.png', [0, 0, 0], base - 500);
  const later = writeFrame('proxy-later.png', [255, 255, 255], base + 5000);
  const run = { evidence: [], steps: [
    { id: 'a', type: 'click', name: 'Click A', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 500).toISOString() },
    { id: 'b', type: 'click', name: 'Click B', status: 'passed', startedAt: new Date(base + 1000).toISOString(), endedAt: new Date(base + 5500).toISOString() },
  ] };
  const result = sim.analyzeRun(run, { frames: [later, before], resolve: identity });
  assert.equal(result.breakdown[0].verdict, 'unclear');
  assert.equal(result.breakdown[0].changedPct, 100);
  assert.equal(result.breakdown[1].before, before.path);
  assert.equal(result.breakdown[1].verdict, 'confirmed');
  assert.equal(result.summary.verdict, 'needs_review');
  assert.ok(!result.suggestions.some((text) => /Pixel evidence agrees/.test(text)));
});

test('an old capture or a capture just before the step is not an after frame', () => {
  const base = Date.now() - 60000;
  const old = writeFrame('old.png', [0, 0, 0], base - 30000);
  const during = writeFrame('during.png', [255, 255, 255], base + 50);
  const run = { evidence: [], steps: [{ id: 'a', type: 'click', name: 'Click', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 100).toISOString() }] };
  const result = sim.analyzeRun(run, { frames: [old, during], resolve: identity });
  assert.equal(result.breakdown[0].verdict, 'missing_baseline');
  assert.equal(result.summary.verdict, 'needs_review');
  const justBefore = writeFrame('just-before.png', [0, 0, 0], base - 50);
  const baselineOnly = sim.analyzeRun(run, { frames: [justBefore], resolve: identity });
  assert.equal(baselineOnly.breakdown[0].verdict, 'missing');
});

test('invalid evidence paths do not abort analysis of other captures', () => {
  const base = Date.now() - 60000;
  const frame = writeFrame('fallback.png', [0, 0, 0], base + 50);
  const run = { evidence: [{ id: 'ev', path: '../escape.png', stepId: 'a' }], steps: [
    { id: 'a', type: 'click', name: 'Click', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 100).toISOString() },
  ] };
  const result = sim.analyzeRun(run, { frames: [frame], resolve: (target) => { if (target.includes('..')) throw new Error('outside root'); return target; } });
  assert.equal(result.breakdown[0].after, frame.path);
  assert.equal(result.breakdown[0].verdict, 'missing_baseline');
});

test('queued simulations analyze stored run evidence and expose the completed result', async () => {
  const base = Date.now() - 60000;
  const before = path.join(store.CAPTURES, 'job-before.png');
  const after = path.join(store.CAPTURES, 'job-after.png');
  fs.writeFileSync(before, makePng(64, 36, [0, 0, 0]));
  fs.writeFileSync(after, makePng(64, 36, [255, 255, 255]));
  fs.utimesSync(before, (base - 1000) / 1000, (base - 1000) / 1000);
  fs.utimesSync(after, (base + 500) / 1000, (base + 500) / 1000);
  const run = { id: 'queued-run', workflowName: 'Queued', evidence: [
    { id: 'ev', stepId: 'click', path: path.relative(store.DATA, after), kind: 'screenshot' },
  ], steps: [
    { id: 'click', name: 'Click', type: 'click', status: 'passed', startedAt: new Date(base).toISOString(), endedAt: new Date(base + 1000).toISOString() },
  ] };
  store.db().runs.push(run);
  const record = sim.startSimulation(run.id);
  assert.equal(record.status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = sim.findSimulation(record.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.breakdown[0].verdict, 'confirmed');
  assert.equal(result.summary.verdict, 'agrees');
  assert.equal(sim.simulationSummary(result).breakdown[0].changedPct, 100);
  assert.equal(sim.listSimulations(run.id)[0].id, record.id);
});

test('PNG decoding rejects truncated scanlines and oversized headers', () => {
  const header = (width, height) => {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4); data[8] = 8; data[9] = 2;
    return chunk('IHDR', data);
  };
  const png = (width, height, raw) => Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), header(width, height),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => sim.decodePng(png(1, 2, Buffer.alloc(6))), /length/);
  assert.throws(() => sim.decodePng(png(100000, 100000, Buffer.alloc(0))), /too large/);
});

test('simulated runs are labelled instead of judged from placeholder pixels', () => {
  const run = {
    id: 'run_dry',
    dryRun: true,
    workflowName: 'Dry run',
    evidence: [],
    steps: [{ id: 'a', type: 'click', name: 'Click', status: 'passed', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }],
  };
  const timestamp = Date.parse(run.steps[0].startedAt);
  const unrelated = writeFrame('dry-unrelated.png', [255, 255, 255], timestamp);
  const result = sim.analyzeRun(run, { frames: [unrelated], resolve: identity });
  assert.equal(result.breakdown[0].verdict, 'simulated');
  assert.equal(result.coverage.withFrames, 0);
  assert.equal(result.summary.verdict, 'no_evidence');
  assert.equal(result.mode, 'simulated');
  assert.ok(result.suggestions.some((line) => /live mode/i.test(line)));
});
