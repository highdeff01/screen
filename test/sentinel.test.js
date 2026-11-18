import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-sentinel-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const sentinel = await load('server/sentinel.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const passing = [
  '✔ a note needs text',
  'ℹ tests 12',
  'ℹ pass 12',
  'ℹ fail 0',
].join('\n');

const failing = [
  '✔ a note needs text',
  '✖ boot renders state without waiting',
  '✖ poll keeps the view fresh',
  'ℹ tests 12',
  'ℹ pass 10',
  'ℹ fail 2',
].join('\n');

/** A run stub: everything outside the spawn is real. */
function runWith(output, ok = !/✖/.test(output)) {
  return async () => ({ ok, code: ok ? 0 : 1, output, durationMs: 12 });
}

test('the spec output parses into totals and failing test names', () => {
  const parsed = sentinel.parseTestOutput(failing);
  assert.equal(parsed.tests, 12);
  assert.equal(parsed.pass, 10);
  assert.equal(parsed.fail, 2);
  assert.deepEqual(parsed.failingTests, ['boot renders state without waiting', 'poll keeps the view fresh']);
  const good = sentinel.parseTestOutput(passing);
  assert.equal(good.fail, 0);
  assert.deepEqual(good.failingTests, []);
});

test('a passing run is recorded and the queue stays clear', async () => {
  await sentinel.runSentinelNow({ run: runWith(passing, true) });
  const status = sentinel.sentinelStatus();
  assert.equal(status.lastRun.ok, true);
  assert.equal(status.openFailures, 0);
  assert.equal(status.lastError, '');
});

test('a failing run is queued, reported to must-check and left as a note', async () => {
  await sentinel.runSentinelNow({ run: runWith(failing, false) });
  const status = sentinel.sentinelStatus();
  assert.equal(status.lastRun.ok, false);
  assert.equal(status.openFailures, 1);
  const failure = status.failures.find((f) => f.status === 'queued');
  assert.ok(failure, 'the failure is queued');
  assert.deepEqual(failure.tests, ['boot renders state without waiting', 'poll keeps the view fresh']);

  // The must-check report exists and mentions the failing tests.
  const dir = path.join(process.cwd(), 'must-check');
  const reports = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'README.md');
  assert.equal(reports.length, 1);
  const body = fs.readFileSync(path.join(dir, reports[0]), 'utf8');
  assert.match(body, /boot renders state without waiting/);
  assert.ok(body.includes(failure.id), 'the report carries the queue id');

  // A handoff note was left for the next agent.
  const handoff = await load('server/handoff.js');
  const notes = handoff.listNotes({ limit: 5 });
  assert.ok(notes.some((note) => note.by === 'sentinel' && /Auto-test failed/.test(note.text)));
});

test('the queue settles: dismiss and retry move the same item', async () => {
  const status = sentinel.sentinelStatus();
  const failure = status.failures.find((f) => f.status === 'queued' || f.status === 'planned');
  const dismissed = sentinel.dismissFailure(failure.id);
  assert.equal(dismissed.status, 'dismissed');
  await assert.rejects(async () => sentinel.dismissFailure('nope'), /Failure not found/);
  // A retry re-runs the suite; with a passing stub the run clears the error state.
  const retried = await sentinel.retryFailure(failure.id);
  assert.equal(retried.lastRun.ok, true);
  assert.equal(retried.lastError, '');
});

test('a repair plan can be drafted without a model and degrades gracefully', async () => {
  await sentinel.runSentinelNow({ run: runWith(failing, false) });
  const failure = sentinel.sentinelStatus().failures.find((f) => f.status === 'queued');
  const planned = await sentinel.planFailure(failure.id, {
    chat: async () => ({ ok: true, content: '1. The boot slice reads lastInteractionAt before it is declared.\n2. Move the declaration into boot().\n3. Re-run node --test test/app-boot.test.js.' }),
  });
  assert.equal(planned.status, 'planned');
  assert.match(planned.plan.text, /boot/);

  const offline = await sentinel.planFailure(failure.id, { chat: async () => ({ ok: false, error: 'the model is offline' }) });
  assert.equal(offline.status, 'queued');
  assert.match(offline.plan.error, /offline/);
});

test('a later passing run settles the failures still queued', async () => {
  await sentinel.runSentinelNow({ run: runWith(failing, false) });
  assert.ok(sentinel.sentinelStatus().openFailures > 0, 'the failing run leaves open work');
  await sentinel.runSentinelNow({ run: runWith(passing, true) });
  const status = sentinel.sentinelStatus();
  assert.equal(status.openFailures, 0);
  assert.ok(status.failures.some((f) => f.status === 'fixed'), 'the queued failures are marked fixed');
  const queue = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'must-check', 'repair-queue.json'), 'utf8'));
  assert.equal(queue.open, 0, 'the repair queue file no longer lists them as open');
});

test('watching ignores machine state and test scratch folders', () => {
  // Windows path separators, spelled without literal backslashes so the source
  // survives copy-through transports that collapse escape sequences.
  const BS = String.fromCharCode(92);
  const ignored = [`data${BS}db.json`, `server${BS}server.log`, `test${BS}tmp-sentinel-x${BS}f.txt`, `data${BS}captures${BS}a.png`];
  const watched = [`public${BS}app.js`, `server${BS}sentinel.js`, `package.json`];
  for (const file of ignored) assert.ok(sentinel.__sentinelIgnored.test(file), `${file} should be ignored`);
  for (const file of watched) assert.ok(!sentinel.__sentinelIgnored.test(file), `${file} should be watched`);
});
