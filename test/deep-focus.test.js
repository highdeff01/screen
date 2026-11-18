import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-deepfocus-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const deepFocus = await load('server/deep-focus.js');

/** A finished run with one failed step, seeded straight into the store. */
function seedRun({ id = 'run_focus_1', status = 'failed' } = {}) {
  const run = {
    id,
    workflowId: 'wf_demo',
    workflowName: 'Open Notepad and type',
    status,
    steps: [
      { id: 's1', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' }, status: 'passed', output: 'front Notepad :: Untitled - Notepad' },
      { id: 's2', type: 'type', name: 'Type the note', params: { text: 'hello' }, status: 'failed', error: 'the caret was elsewhere' },
      { id: 's3', type: 'expect', name: 'Window is present', params: { kind: 'window', value: 'Notepad' }, status: 'pending' },
    ],
    lastWindow: { title: 'Untitled - Notepad', process: 'Notepad' },
    errorSummary: 'the caret was elsewhere',
  };
  store.db().runs.unshift(run);
  store.db().workflows.push({
    id: 'wf_demo',
    name: 'Open Notepad and type',
    steps: run.steps.map((step) => ({ ...step })),
    status: 'draft',
  });
  store.persist();
  return run;
}

beforeEach(() => {
  const d = store.db();
  d.runs = [];
  d.workflows = [];
  d.settings.deepFocus = { enabled: true, rounds: 3, roundDelayMs: 10, autoApply: false };
  store.persist();
});

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const liveState = {
  readForeground: async () => ({ title: 'Untitled - Notepad', process: 'Notepad' }),
  readFocused: async () => ({ found: true, name: 'text area', controlType: 'Edit', editable: true }),
  listWindows: async () => [{ title: 'Untitled - Notepad' }],
};

test('reflex checks catch the wrong window, unsaved work and minimization', () => {
  const checks = deepFocus.reflexChecks({
    foreground: { title: '*knack convo.txt - Notepad', process: 'Notepad' },
    focused: { found: true, controlType: 'Edit', editable: false },
    windows: [{ title: 'a' }, { title: 'b' }],
    guard: 'Untitled - Notepad',
  });
  assert.equal(checks.windowFocus.ok, false, 'a different document in front is a focus failure');
  assert.equal(checks.saveCheck.ok, false, 'the * prefix means unsaved work');
  assert.match(checks.saveCheck.note, /save/);
  assert.equal(checks.typingFlow.ok, false, 'a non-editable caret fails the typing flow check');
  assert.equal(checks.minimizeCheck.ok, true);
  assert.equal(checks.tabCheck.count, 2);
});

test('deep focus is for finished runs that need thought', async () => {
  seedRun({ status: 'passed' });
  await assert.rejects(async () => deepFocus.startDeepFocus('run_focus_1', { rounds: 2 }, liveState), /finished runs that need thought/);
});

test('the cycle reads live state each round and reshapes at the rethink round', async () => {
  seedRun();
  const chat = async () => ({
    ok: true,
    content: JSON.stringify({
      conclusion: 'the caret is already in the new Notepad; do not re-launch, just retype and verify',
      reshaped: [
        { type: 'type', name: 'Type the note again', params: { text: 'hello', foreground: 'Untitled - Notepad' } },
        { type: 'expect', name: 'Window is present', params: { kind: 'window', value: 'Notepad' } },
      ],
      retry: true,
    }),
  });
  const status = deepFocus.startDeepFocus('run_focus_1', { rounds: 3, reason: 'test' }, { ...liveState, chat });
  assert.equal(status.requested, 3);
  // The cycle runs in the background; wait for the conclusion.
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (deepFocus.deepFocusStatus('run_focus_1')?.finishedAt) break;
  }
  const focus = deepFocus.deepFocusStatus('run_focus_1');
  assert.ok(focus.finishedAt, 'the cycle finished');
  assert.equal(focus.rounds.length, 3, 'one round per requested cycle');
  assert.equal(focus.rounds[0].foreground, 'Untitled - Notepad', 'live focus was read');
  assert.equal(focus.rounds[0].caret, 'Edit “text area”', 'the caret was read live');
  assert.equal(focus.rounds[1].decision, 'reshape', 'the rethink round reshaped the plan');
  assert.ok(focus.reshaped.steps.length === 2);
  assert.match(focus.conclusion, /reshaped into 2 step/);
  assert.equal(focus.diff.added.length, 1, 'the retyped step is new against the baseline');
  assert.equal(focus.diff.removed.length, 2, 'the failed step is replaced and the re-launch is dropped (the caret is already there)');
  assert.ok(focus.lessons.length, 'the conclusion was kept as a lesson');
});

test('applying reshaped steps passes the snapshot gate first', async () => {
  seedRun();
  let gateCalls = 0;
  let applied = null;
  deepFocus.startDeepFocus('run_focus_1', { rounds: 2, reason: 'test' }, {
    ...liveState,
    chat: async () => ({ ok: true, content: JSON.stringify({ conclusion: 'retype', reshaped: [{ type: 'wait', name: 'wait a moment', params: { ms: 500 } }], retry: true }) }),
  });
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (deepFocus.deepFocusStatus('run_focus_1')?.finishedAt) break;
  }
  // A blocked gate applies nothing.
  const blocked = await deepFocus.applyReshaped('run_focus_1', {
    snapshot: async () => ({ ok: false, message: 'not a repository' }),
    applyAndRetry: async () => { applied = true; return { ok: true }; },
  });
  assert.equal(blocked.ok, false);
  assert.equal(applied, null, 'nothing was applied behind a closed gate');
  assert.equal(deepFocus.deepFocusStatus('run_focus_1').applyGate.blocked, true);

  // An open gate snapshots, then applies and re-runs. In production the apply
  // path (index.js) patches the workflow; here the stub records the handover.
  const result = await deepFocus.applyReshaped('run_focus_1', {
    snapshot: async () => { gateCalls += 1; return { ok: true, snapshot: { commit: 'abc123' } }; },
    applyAndRetry: async (runId, steps) => {
      applied = steps;
      return { ok: true, status: 'applied' };
    },
  });
  assert.equal(gateCalls, 1, 'the snapshot was taken before the apply');
  assert.equal(applied.length, 1, 'the reshaped steps reached the apply path');
  assert.equal(applied[0].type, 'wait');
  assert.equal(result.ok, true);
  assert.equal(deepFocus.deepFocusStatus('run_focus_1').applyGate.snapshot, 'abc123');
});

test('without a model the rounds still conclude from the reflexes', async () => {
  seedRun();
  deepFocus.startDeepFocus('run_focus_1', { rounds: 2, reason: 'test' }, liveState);
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (deepFocus.deepFocusStatus('run_focus_1')?.finishedAt) break;
  }
  const focus = deepFocus.deepFocusStatus('run_focus_1');
  assert.ok(focus.finishedAt);
  assert.ok(!focus.reshaped, 'no model means no reshape, but the loop still concludes');
  assert.match(focus.conclusion, /reflexes clear/);
});

test('stop ends the cycle early', async () => {
  seedRun();
  deepFocus.startDeepFocus('run_focus_1', { rounds: 6, reason: 'test' }, { ...liveState, chat: async () => ({ ok: false }) });
  deepFocus.stopDeepFocus('run_focus_1');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const focus = deepFocus.deepFocusStatus('run_focus_1');
  assert.ok(focus.stopped);
});
