import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-live-fallback-'));
process.chdir(tempRoot);
// Force the live backend unavailable (as a hosted preview or headless host is)
// without stubbing: no adb device is attached, so android targeting refuses.
process.env.SIGHTLINE_TARGET = 'android';
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('a live run reaches the queue, finds no backend, and continues simulated', async () => {
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.presenterSettleMs = 0;
  d.workflows = [
    {
      id: 'wf_live_fallback',
      name: 'Live fallback probe',
      description: '',
      status: 'ready',
      failurePolicy: { onFailure: 'stop', maxRetries: 0 },
      steps: [{ id: 'stp_note', type: 'note', name: 'Say what happened', params: { text: 'hello' }, timeoutMs: 1000 }],
    },
  ];
  // A live request on a machine without a live backend: the run must not
  // bounce on the refusal — it converts and finishes simulated.
  const run = engine.createRun(d.workflows[0], { dryRun: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 20000, intervalMs: 20 });
  assert.equal(finished.status, 'passed', `run finished ${finished.status}: ${(finished.steps?.[0] || {}).error || ''}`);
  assert.equal(finished.dryRun, true, 'the run continues as simulation');
  assert.match(String(finished.liveFallback || ''), /not supported|not implemented|unavailable/i);
  assert.equal(finished.steps[0].status, 'passed');
  assert.ok(
    (finished.log || []).some((line) => /simulated instead/i.test(line.message || '')),
    'the run log names the conversion'
  );
});
