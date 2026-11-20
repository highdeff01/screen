import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-bench-client-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const bench = await load('server/bench.js');

after(() => {
  bench.stopBenchWatch();
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.settings.benchUrl = 'http://127.0.0.1:4319';
  store.persist();
});

/** A fake fetch that plays the bench's API endpoints. */
function fakeBench({ online = true, popups = [], targets = [] } = {}) {
  return async (url) => {
    if (!online) throw new Error('connect ECONNREFUSED 127.0.0.1:4319');
    const pathPart = new URL(url).pathname;
    if (pathPart === '/api/health') return json({ ok: true, app: 'sightline-bench' });
    if (pathPart === '/api/status') return json({ ok: true, targets, runs: targets.map((t) => t.lastRun).filter(Boolean) });
    if (pathPart === '/api/popup') return json({ ok: true, popups });
    if (/\/api\/popup\/[\w-]+\/resolve/.test(pathPart)) return json({ ok: true });
    if (/\/api\/test\//.test(pathPart)) return json({ ok: true, run: { id: 'run_new', ok: true } });
    return json({ ok: false }, 404);
  };
}
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('an offline bench is a quiet result, not a crash', async () => {
  const status = await bench.pollBench({ fetchFn: fakeBench({ online: false }) });
  assert.equal(status.online, false);
  assert.match(status.lastError, /ECONNREFUSED/);
  assert.equal(status.openPopups, 0);
  const again = await bench.pollBench({ fetchFn: fakeBench({ online: false }) });
  assert.equal(again.failures, 2, 'failures accumulate but nothing throws');
});

test('a live poll records targets, verdicts and open popups', async () => {
  const status = await bench.pollBench({
    fetchFn: fakeBench({
      targets: [{ id: 'tgt_1', name: 'sightline-console', status: 'passing', lastRun: { id: 'run_1', ok: true, pass: 41, tests: 41 } }],
      popups: [{ id: 'pop_1', text: 'About to run the suite — OK?', source: 'bench', status: 'open', ageMin: 0, options: [{ id: 'ok', label: 'OK' }] }],
    }),
  });
  assert.equal(status.online, true);
  assert.equal(status.targets.length, 1);
  assert.equal(status.targets[0].lastRun.ok, true);
  assert.equal(status.openPopups, 1);
  assert.match(status.popups[0].text, /About to run/);
  assert.ok(status.latencyMs >= 0);
});

test('the operator answers a bench popup from here', async () => {
  let answered = null;
  const fetchFn = async (url, opts = {}) => {
    if (/\/resolve/.test(url)) {
      answered = JSON.parse(opts.body);
      return json({ ok: true });
    }
    return fakeBench({ popups: [] })(url);
  };
  const result = await bench.answerBenchPopup('pop_1', 'ok', { fetchFn, by: 'operator' });
  assert.equal(result.ok, true);
  assert.equal(answered.decision, 'ok');
  assert.equal(answered.by, 'operator');
});

test('asking the bench to test a target works and refreshes the picture', async () => {
  let sawTest = false;
  const fetchFn = async (url) => {
    if (/\/api\/test\//.test(url)) {
      sawTest = true;
      return json({ ok: true, run: { id: 'run_x', ok: true } });
    }
    return fakeBench({ targets: [{ id: 'tgt_1', name: 'demo', status: 'passing' }] })(url);
  };
  const result = await bench.testBenchTarget('tgt_1', { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(sawTest, true);
  assert.equal(bench.benchStatus().targets[0].name, 'demo');
});

test('adding a target goes through to the bench', async () => {
  let received = null;
  const fetchFn = async (url, opts = {}) => {
    if (url.endsWith('/api/targets')) {
      received = JSON.parse(opts.body);
      return json({ ok: true, target: { id: 'tgt_new', name: received.name } });
    }
    return fakeBench({})(url);
  };
  const result = await bench.addBenchTarget({ path: 'C:/repos/other', name: 'other' }, { fetchFn });
  assert.equal(result.ok, true);
  assert.equal(received.path, 'C:/repos/other');
});


test('a live poll picks up pending reviews', async () => {
  const status = await bench.pollBench({
    fetchFn: async (url) => {
      const pathPart = new URL(url).pathname;
      if (pathPart === '/api/health') return json({ ok: true, app: 'sightline-bench' });
      if (pathPart === '/api/status') return json({ ok: true, targets: [], runs: [], pendingReviews: [{ id: 'prp_1', from: 'app-b', status: 'awaiting-review', fileCount: 2, totalBytes: 300, deletions: 0, note: 'add a feature', files: [{ path: 'docs/x.md', action: 'add', bytes: 3 }] }] });
      if (pathPart === '/api/popup') return json({ ok: true, popups: [] });
      return json({ ok: false }, 404);
    },
  });
  assert.equal(status.pendingReviews, 1);
  assert.equal(status.reviews[0].from, 'app-b');
  assert.equal(status.reviews[0].files[0].path, 'docs/x.md');
});

test('reviewBenchProposal posts the verdict to the bench', async () => {
  let received = null;
  const fetchFn = async (url, opts = {}) => {
    if (/\/verdict$/.test(new URL(url).pathname)) {
      received = JSON.parse(opts.body);
      return json({ ok: true });
    }
    const pathPart = new URL(url).pathname;
    if (pathPart === '/api/health') return json({ ok: true, app: 'sightline-bench' });
    if (pathPart === '/api/status') return json({ ok: true, targets: [], runs: [], pendingReviews: [] });
    if (pathPart === '/api/popup') return json({ ok: true, popups: [] });
    return json({ ok: false }, 404);
  };
  const result = await bench.reviewBenchProposal('prp_1', 'deny', { reasons: ['needs a test'], fetchFn });
  assert.equal(result.ok, true);
  assert.equal(received.decision, 'deny');
  assert.deepEqual(received.reasons, ['needs a test']);
  assert.equal(received.by, 'operator');
  assert.equal(bench.benchStatus().pendingReviews, 0, 'the reviewed proposal left the pending list');
});

test('the status snapshot is available synchronously for buildState', () => {
  const snapshot = bench.benchStatus();
  assert.equal(snapshot.url, 'http://127.0.0.1:4319');
  assert.ok('online' in snapshot);
  assert.ok('openPopups' in snapshot);
});