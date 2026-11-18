import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-alog-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const alog = await load('server/action-log.js');
const pipeline = await load('server/pipeline.js');

beforeEach(() => {
  const d = store.db();
  d.actionLog = [];
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

test('the same error from the same place is one item with a count', () => {
  const first = alog.recordAction({ kind: 'ui', action: 'run-workflow', error: 'Live control is not implemented for linux.' });
  const again = alog.recordAction({ kind: 'ui', action: 'run-workflow', error: 'Live control is not implemented for linux.' });
  assert.equal(again.id, first.id, 'the repeat merged into the first item');
  assert.equal(again.count, 2);
  assert.equal(alog.actionLogStatus().items.length, 1);
});

test('a repeated error lands in must-check and enqueues AI triage', async () => {
  pipeline.registerHandler('error-triage', async ({ id }) => {
    const item = await alog.triageItem({ id }, {
      chat: async () => ({ ok: true, content: 'Skip the Linux-only check; the host is Windows.' }),
    });
    return item?.suggestion ? 'suggested' : 'none';
  });
  alog.recordAction({ kind: 'run', action: 'start-run:demo', error: 'boom' });
  const second = alog.recordAction({ kind: 'run', action: 'start-run:demo', error: 'boom' });
  assert.equal(second.count, 2, 'the second occurrence trips the default threshold');
  assert.ok(second.reportedAt, 'the item was reported');
  assert.match(second.reportFile, /^must-check\/action-/, 'the report lives in the synced folder');
  const report = fs.readFileSync(path.join(process.cwd(), second.reportFile), 'utf8');
  assert.match(report, /seen: \*\*2×\*\*/i);
  assert.match(report, /boom/);
  // The pipeline really picked the job up and the suggestion reached the file.
  pipeline.runNow();
  const status = await pipeline.drain();
  assert.equal(status.done[0].ok, true);
  const updated = fs.readFileSync(path.join(process.cwd(), second.reportFile), 'utf8');
  assert.match(updated, /Skip the Linux-only check/, 'the AI suggestion is carried in the synced report');
});

test('a known platform mismatch carries advice, and the report file keeps notes', () => {
  const item = alog.recordAction({
    kind: 'ui',
    action: 'run-workflow',
    error: 'Live control is not implemented for linux. Set SIGHTLINE_TARGET=android with adb.',
    detail: { view: 'builder' },
  });
  assert.equal(item.pattern?.id, 'platform-mismatch');
  assert.match(item.pattern.advice, /Windows/);
  // Append a human note, then let a new occurrence rewrite the report: the note stays.
  alog.writeActionReport({ ...item, count: item.count });
  const file = path.join(process.cwd(), 'must-check');
  const reportPath = fs.readdirSync(file).find((name) => name.startsWith('action-'));
  fs.writeFileSync(path.join(file, reportPath), `${fs.readFileSync(path.join(file, reportPath), 'utf8')}\nMy note for the fixer.\n`);
  alog.recordAction({ kind: 'ui', action: 'run-workflow', error: 'Live control is not implemented for linux.' });
  const report = fs.readFileSync(path.join(file, reportPath), 'utf8');
  assert.match(report, /My note for the fixer/, 'operator notes survive report updates');
});

test('benign noise is suppressed and never reported', () => {
  const result = alog.recordAction({ kind: 'server', action: 'save', error: "ENOENT: no such file or directory, rename 'x\\data\\db.json.tmp'" });
  assert.equal(result.status, 'suppressed');
  assert.equal(alog.actionLogStatus().items.length, 0, 'suppressed noise is not even kept');
});

test('items settle: dismiss and fix-applied stop the loop', () => {
  const item = alog.recordAction({ kind: 'ui', action: 'click', error: 'one-off' });
  const dismissed = alog.dismissItem(item.id);
  assert.equal(dismissed.status, 'dismissed');
  const handled = alog.applyFix(item.id, { note: 'operator fixed the window guard' });
  assert.equal(handled.status, 'fix-applied');
  assert.match(handled.appliedNote, /operator fixed/);
});

test('the model being offline leaves an error, not a crash', async () => {
  const item = alog.recordAction({ kind: 'ui', action: 'click', error: 'mystery failure', report: false });
  const triaged = await alog.triageItem({ id: item.id }, { chat: async () => ({ ok: false, error: 'the model is offline' }) });
  assert.equal(triaged.suggestion, null);
  assert.match(triaged.suggestionError, /offline/);
  assert.equal(triaged.status, 'new', 'an untriaged item keeps its status');
});
