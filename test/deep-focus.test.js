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
  readForeground: async () => ({ title: 'Untitled - Notepad', process: 'Notepad', minimized: false }),
  readFocused: async () => ({ found: true, name: 'text area', controlType: 'Edit', editable: true }),
  listWindows: async () => [{ title: 'Untitled - Notepad' }],
};

test('reflex checks catch the wrong window, unsaved work and minimization', () => {
  const checks = deepFocus.reflexChecks({
    foreground: { title: '*knack convo.txt - Notepad', process: 'Notepad', minimized: false },
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

test('the cycle reads live state each round and reshapes after observing', async () => {
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
  assert.equal(focus.rounds[2].decision, 'reshape', 'the final round reshaped the plan');
  assert.ok(focus.reshaped.steps.length === 2);
  assert.match(focus.conclusion, /reshaped into 2 step/);
  assert.equal(focus.diff.added.length, 1, 'the retyped step is new against the baseline');
  assert.equal(focus.diff.removed.length, 2, 'the failed step is replaced and the re-launch is dropped (the caret is already there)');
  assert.ok(focus.lessons.length, 'the conclusion was kept as a lesson');
});

test('rethink receives the goal, step parameters and every observation before drafting', async () => {
  const run = seedRun();
  run.workflowGoal = 'Write hello, then verify the Notepad window';
  run.steps[1].params.foreground = 'Untitled - Notepad';
  run.steps[0].output = 'launch output: notepad is open';
  let round = 0;
  let prompt;
  let applications = 0;
  store.db().settings.deepFocus.autoApply = true;
  deepFocus.startDeepFocus(run.id, { rounds: 3 }, {
    readForeground: async () => ({ title: `Round ${++round} window`, process: `proc${round}` }),
    readFocused: async () => ({ name: `caret${round}`, editable: round !== 2, controlType: 'Edit' }),
    listWindows: async () => [{ title: `window list ${round}` }],
    chat: async (messages) => {
      assert.equal(round, 3, 'the model is called after the last read');
      prompt = messages[1].content;
      return { ok: true, content: JSON.stringify({ conclusion: 'review the caret', reshaped: [{ type: 'type', name: 'type', params: { text: 'hello' } }], retry: true }) };
    },
    snapshot: async () => { applications += 1; return { ok: true }; },
    applyAndRetry: async () => { applications += 1; return { ok: true }; },
  });
  for (let i = 0; i < 40 && !deepFocus.deepFocusStatus(run.id)?.finishedAt; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(prompt, 'the model received a prompt');
  assert.match(prompt, /Write hello, then verify/);
  assert.match(prompt, /launch output: notepad is open/);
  assert.match(prompt, /the caret was elsewhere/);
  assert.match(prompt, /"text":"hello"/);
  assert.match(prompt, /"foreground":"Untitled - Notepad"/);
  assert.match(prompt, /"kind":"window","value":"Notepad"/);
  for (let i = 1; i <= 3; i += 1) {
    assert.match(prompt, new RegExp(`Round ${i} window`));
    assert.match(prompt, new RegExp(`caret${i}`));
    assert.match(prompt, new RegExp(`window list ${i}`));
  }
  assert.match(prompt, /"typingFlow":\{"ok":false/, 'round reflexes reach the model');
  assert.equal(applications, 0, 'even autoApply cannot apply an unreviewed model proposal');
  assert.match(deepFocus.deepFocusStatus(run.id).conclusion, /review required/);
});

test('one round still sends observations to rethink', async () => {
  const run = seedRun();
  let calls = 0;
  deepFocus.startDeepFocus(run.id, { rounds: 1 }, {
    ...liveState,
    chat: async (messages) => {
      calls += 1;
      assert.match(messages[1].content, /Round 1:/);
      assert.match(messages[1].content, /text area/);
      return { ok: true, content: JSON.stringify({ conclusion: 'inspect', reshaped: [], retry: false }) };
    },
  });
  for (let i = 0; i < 40 && !deepFocus.deepFocusStatus(run.id)?.finishedAt; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const focus = deepFocus.deepFocusStatus(run.id);
  assert.equal(calls, 1);
  assert.equal(focus.rounds.length, 1);
  assert.equal(focus.rethinkStatus, 'completed');
  assert.match(focus.conclusion, /model proposed no reshaped steps/);
});

test('unavailable and failed readers are unknown, not evidence of success', async () => {
  const run = seedRun();
  let prompt;
  deepFocus.startDeepFocus(run.id, { rounds: 1 }, {
    readForeground: async () => { throw new Error('desktop offline'); },
    chat: async (messages) => {
      prompt = messages[1].content;
      return { ok: false };
    },
  });
  for (let i = 0; i < 40 && !deepFocus.deepFocusStatus(run.id)?.finishedAt; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const focus = deepFocus.deepFocusStatus(run.id);
  assert.match(prompt, /failed: desktop offline/);
  assert.match(prompt, /"focused":"unavailable"/);
  assert.match(prompt, /"windows":"unavailable"/);
  assert.equal(focus.reflexes.windowFocus.ok, null);
  assert.equal(focus.reflexes.saveCheck.ok, null);
  assert.equal(focus.reflexes.minimizeCheck.ok, null);
  assert.equal(focus.reflexes.tabCheck.count, null);
  assert.match(focus.conclusion, /observations unavailable or failed/);
  assert.match(focus.conclusion, /not verified/);
  assert.match(focus.conclusion, /model request failed/);
  assert.doesNotMatch(focus.conclusion, /reflexes clear/);
});

test('an empty foreground response is not proof of a visible window', async () => {
  const run = seedRun();
  deepFocus.startDeepFocus(run.id, { rounds: 1 }, {
    ...liveState,
    readForeground: async () => ({ title: '', process: '', id: null }),
  });
  for (let i = 0; i < 40 && !deepFocus.deepFocusStatus(run.id)?.finishedAt; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const focus = deepFocus.deepFocusStatus(run.id);
  assert.equal(focus.rounds[0].observation.availability.foreground, 'empty or invalid');
  assert.equal(focus.reflexes.minimizeCheck.ok, null);
  assert.match(focus.conclusion, /not verified/);
  assert.doesNotMatch(focus.conclusion, /reflexes clear/);
});

test('an unverified goal with no failed step sends the whole workflow to rethink', async () => {
  const run = seedRun({ status: 'needs_review' });
  for (const step of run.steps) step.status = 'passed';
  run.errorSummary = 'Goal not verified';
  let prompt;
  deepFocus.startDeepFocus(run.id, { rounds: 1 }, {
    ...liveState,
    chat: async (messages) => { prompt = messages[1].content; return { ok: false }; },
  });
  for (let i = 0; i < 40 && !deepFocus.deepFocusStatus(run.id)?.finishedAt; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(prompt, /Goal not verified/);
  assert.match(prompt, /"target":"notepad.exe"/);
  assert.match(prompt, /"text":"hello"/);
  assert.match(prompt, /"kind":"window"/);
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

  const missing = await deepFocus.applyReshaped('run_focus_1', {
    snapshot: async () => null,
    applyAndRetry: async () => { applied = true; return { ok: true }; },
  });
  assert.equal(missing.status, 'gate-blocked');
  assert.equal(applied, null);

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

test('a reshape is validated before it can be applied', () => {
  const run = { lastWindow: { title: 'Sightline Profile — home' } };
  const steps = deepFocus.executableReshape([
    // A model that copies the prompt's list into "type" must not reach the workflow.
    { type: 'focusWindow|clickElement|type', name: 'Settings', params: { name: 'Settings' } },
    { type: 'clickElement', name: 'Click Settings', params: { name: 'Settings' } },
    { type: 'clickElement', label: 'Notifications', params: {} },
    { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
    { type: 'dropDatabase', name: 'No such action', params: {} },
  ], run);
  assert.deepEqual(steps.map((step) => step.type), ['clickElement', 'clickElement', 'launchApp']);
  assert.equal(steps[0].params.window, 'Sightline Profile', 'a click gets the window the run was last in');
  assert.equal(steps[1].params.name, 'Notifications', 'a click gets its control label from the model alias');
  assert.ok(steps[1].name, 'every step keeps a readable name');
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
  assert.match(focus.conclusion, /model unavailable/);
  assert.match(focus.conclusion, /observed reflexes clear/);
});

test('stop ends the cycle early', async () => {
  seedRun();
  deepFocus.startDeepFocus('run_focus_1', { rounds: 6, reason: 'test' }, { ...liveState, chat: async () => ({ ok: false }) });
  deepFocus.stopDeepFocus('run_focus_1');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const focus = deepFocus.deepFocusStatus('run_focus_1');
  assert.ok(focus.stopped);
});
