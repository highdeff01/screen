import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-engine-recheck-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function resetDb(recheck = {}) {
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.agentReplans = false;
  d.settings.aiSuggestions = false;
  d.settings.visualChecks = false;
  d.settings.presenterSettleMs = 0;
  d.settings.presenceEnabled = false;
  d.settings.stepThink = { enabled: false };
  d.settings.recheck = {
    enabled: true,
    continueAfter: false,
    prepMs: 0,
    maxAttempts: 2,
    intervalMs: 250,
    maxPendingMs: 1000,
    ...recheck,
  };
  d.workflows = [];
  d.runs = [];
  d.recoveryPacks = [];
  return d;
}

function workflow(id) {
  return {
    id,
    name: 'Recheck keeps progress',
    description: 'Type a note, wait for the window and record the result.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      {
        id: 'stp_type',
        type: 'type',
        name: 'Type the note',
        params: { text: 'hello', foreground: 'Untitled - Notepad' },
        timeoutMs: 5000,
      },
      {
        id: 'stp_wait',
        type: 'expect',
        name: 'Assert the Notepad window',
        params: { title: 'Untitled - Notepad' },
        timeoutMs: 6000,
      },
      { id: 'stp_note', type: 'note', name: 'Record the result', params: { text: 'done' } },
    ],
  };
}

function stubProbe() {
  const executed = [];
  return {
    executed,
    executeStep: async (step) => {
      executed.push(step.type);
      if (step.type === 'expect' && /Assert the Notepad/.test(step.name || '')) {
        throw new Error('Timed out after 5000ms waiting for window to be present: Untitled - Notepad');
      }
      if (step.type === 'screenshot') {
        return {
          output: 'captured',
          evidence: [{ kind: 'screenshot', path: 'data/shots/recheck.png', width: 640, height: 360 }],
        };
      }
      return { output: `${step.type} ok`, evidence: [] };
    },
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    readFocusedElement: async () => ({
      found: true,
      name: 'text area',
      controlType: 'Edit',
      editable: true,
      window: 'Untitled - Notepad',
    }),
    findUiElement: async () => ({ found: true }),
    // The window is missing until the recheck reads it, so the waitFor really
    // runs and times out instead of being pre-skipped as already present.
    inspectWindowState: async ({ title } = {}) => ({ state: 'closed', foreground: null, matches: [], requested: title || '' }),
    silentCheck: async (kind) => ({
      ok: kind === 'window',
      detail: 'window foreground: notepad :: Untitled - Notepad',
    }),
    readScreenContext: async () => ({
      foreground: { title: 'Untitled - Notepad', process: 'notepad' },
      windows: [{ title: 'Untitled - Notepad', process: 'notepad' }],
    }),
    readThinkObservation: async () => null,
    agentAsk: async () => ({ ok: false, error: 'offline' }),
  };
}

async function settle(runId) {
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await sleep(25);
  }
  return store.db().runs.find((entry) => entry.id === runId);
}

test('a recheck settles a timed-out wait without repeating the step that passed', async () => {
  const d = resetDb();
  const wf = workflow('wf_recheck_pass');
  d.workflows = [wf];
  const probe = stubProbe();

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const first = await settle(run.id);
  assert.equal(first.steps[1].status, 'failed', 'the wait timed out');
  assert.equal(first.steps[0].status, 'passed');

  const rechecked = await engine.recheckRun(first.id, { probe });
  assert.equal(rechecked.steps[1].status, 'passed', 'the window is visible now');
  assert.equal(rechecked.recheck.status, 'resolved');
  assert.equal(rechecked.recheck.attempts, 1, 'the first read already saw the window');
  assert.ok((rechecked.recheck.evidence || []).length >= 1, 'the recheck keeps a fresh screenshot');
  assert.equal(probe.executed.filter((type) => type === 'type').length, 1, 'typing was never repeated');
  assert.equal(rechecked.status, 'passed');
});

test('continue-after passes completed steps through and runs only the remainder', async () => {
  const d = resetDb({ continueAfter: true });
  const wf = workflow('wf_recheck_continue');
  d.workflows = [wf];
  const probe = stubProbe();

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const first = await settle(run.id);
  assert.equal(first.steps[1].status, 'failed');
  // Simulate the restart case: the last step never got its turn.
  first.steps[2].status = 'pending';
  first.status = 'needs_review';
  store.persist();

  const rechecked = await engine.recheckRun(first.id, { probe });
  assert.equal(rechecked.recheck.continued, true);
  const retryId = rechecked.recheck.retryRunId;
  assert.ok(retryId, 'a continuation run was queued');
  const retry = await settle(retryId);
  assert.equal(retry.carriedSteps.length, 2, 'the passed type and the rechecked wait are passed through');
  assert.equal(retry.steps[0].carriedFrom.stepId, 'stp_type');
  assert.equal(retry.steps[1].status, 'passed');
  assert.equal(retry.steps[2].status, 'passed', 'the remaining note step ran');
  assert.equal(probe.executed.filter((type) => type === 'type').length, 1, 'the completed typing was not repeated');
  assert.match(JSON.stringify(retry.log || []), /Passed through/);
});
