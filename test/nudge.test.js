import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-nudge-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const nudge = await load('server/nudge.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(async () => {
  const d = store.db();
  d.runs = [];
  d.suggestions = [];
  store.persist();
  nudge.setNudgeOptions({ debounce: 0 });
  nudge.setNudgeSource(async () => ({ idleMs: 30000 }));
  await nudge.__tick(); // reset the baseline
});

/** Drive one watcher tick with a faked physical input signal. */
async function tickWith(idleMs) {
  nudge.setNudgeSource(async () => ({ idleMs, foreground: null, at: new Date().toISOString() }));
  return nudge.__tick();
}

test('fresh input while an operator-paused run waits resumes it as a continue signal', async () => {
  const d = store.db();
  const run = { id: 'r1', workflowId: 'wf1', workflowName: 'Paused probe', status: 'running', paused: true, pauseRequested: true, log: [], createdAt: new Date().toISOString() };
  d.runs.unshift(run);
  store.persist();

  // Quiet first (baseline), then fresh input (the nudge).
  nudge.setNudgeSource(async () => ({ idleMs: 9000 }));
  await nudge.__tick?.();
  nudge.setNudgeSource(async () => ({ idleMs: 800 }));
  await nudge.__tick?.();

  assert.equal(run.paused, false, 'the run resumed');
  assert.equal(run.pauseRequested, false);
  assert.ok((run.log || []).some((line) => /continue signal/i.test(line.message || '')));
});

test('a presence hold is never broken by a nudge, but repeated nudges surface the bypass', async () => {
  const d = store.db();
  const run = { id: 'r2', workflowId: 'wf1', workflowName: 'Hold probe', status: 'running', paused: false, presence: { holding: true, reason: 'operator busy' }, log: [], createdAt: new Date().toISOString() };
  d.runs.unshift(run);
  store.persist();

  nudge.setNudgeSource(async () => ({ idleMs: 9000 }));
  await nudge.__tick?.();
  nudge.setNudgeSource(async () => ({ idleMs: 700 }));
  await nudge.__tick?.();

  assert.equal(run.presence.holding, true, 'the hold stays');
  assert.equal(run.nudges, 1);
  assert.equal(run.nudgeHinted, undefined, 'one nudge only notices, no hint yet');

  nudge.setNudgeSource(async () => ({ idleMs: 9000 }));
  await nudge.__tick?.();
  nudge.setNudgeSource(async () => ({ idleMs: 600 }));
  await nudge.__tick?.();
  assert.equal(run.nudges, 2);
  assert.equal(run.nudgeHinted, true, 'two nudges surface the “Run now anyway” hint');
});

test('a run waiting for review counts nudges and drafts one suggestion, never auto-retries', async () => {
  const d = store.db();
  const run = { id: 'r3', workflowId: 'wf1', workflowName: 'Review probe', status: 'needs_review', endedAt: new Date().toISOString(), log: [], createdAt: new Date().toISOString() };
  d.runs.unshift(run);
  store.persist();

  for (let round = 0; round < 3; round += 1) {
    nudge.setNudgeSource(async () => ({ idleMs: 9000 }));
    await nudge.__tick?.();
    nudge.setNudgeSource(async () => ({ idleMs: 500 }));
    await nudge.__tick?.();
  }
  assert.equal(run.nudges, 3);
  assert.equal(run.status, 'needs_review', 'no automatic retry');
  const suggestions = d.suggestions.filter((entry) => entry.kind === 'nudge' && entry.runId === 'r3');
  assert.equal(suggestions.length, 1, 'one suggestion drafted, not one per nudge');
});

test('input while a run is working asks for a fresh read instead of waiting for the next tick', async () => {
  const d = store.db();
  const run = { id: 'r5', workflowId: 'wf1', workflowName: 'Working probe', status: 'running', paused: false, log: [], createdAt: new Date().toISOString() };
  d.runs.unshift(run);
  store.persist();
  const calls = [];
  nudge.registerActiveStep(run, { id: 'stp1', name: 'Click the Email field' }, (payload) => calls.push(payload));

  nudge.setNudgeSource(async () => ({ idleMs: 9000 }));
  await nudge.__tick?.();
  nudge.setNudgeSource(async () => ({ idleMs: 400 }));
  await nudge.__tick?.();

  assert.equal(calls.length, 1, 'the input triggered one re-read');
  assert.equal(calls[0].reason, 'operator input');
  assert.match(run.log[0].message, /re-reading the screen now/);
  assert.equal(run.nudges, undefined, 'a working run is not nudged like a waiting one');
  nudge.clearActiveStep(run.id);
});

test('quiet desktops produce nothing', async () => {
  const d = store.db();
  const run = { id: 'r4', workflowId: 'wf1', workflowName: 'Quiet probe', status: 'needs_review', endedAt: new Date().toISOString(), log: [], createdAt: new Date().toISOString() };
  d.runs.unshift(run);
  store.persist();
  nudge.setNudgeSource(async () => ({ idleMs: 30000 }));
  await nudge.__tick?.();
  await nudge.__tick?.();
  assert.equal(run.nudges, undefined);
  assert.equal((run.log || []).length, 0);
});
