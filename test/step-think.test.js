import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-stepthink-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const think = await load('server/step-think.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.runs = [];
  d.workflows = [];
  delete d.settings.stepThink;
  store.persist();
});

const dialogObservation = {
  foreground: { title: 'Open Folder', process: 'Kiro', className: '#32770' },
  windows: [
    { title: 'Open Folder', process: 'Kiro' },
    { title: 'Getting started - Kiro', process: 'Kiro' },
  ],
  focused: { found: true, name: 'text area', controlType: 'Edit', editable: true, window: 'Open Folder' },
  elements: [{ name: 'Search', controlType: 'Edit', window: 'Getting started - Kiro' }],
};

const step = () => ({
  id: 's_type',
  type: 'type',
  name: 'Type the prompt',
  params: { text: 'what is a diamond', foreground: 'Getting started - Kiro' },
  status: 'running',
});

test('settings are clamped and the pixel/element budgets are independent', () => {
  const normalized = think.normalizeThinkSettings({
    enabled: 'yes',
    maxChoices: 99,
    pixels: -5,
    elements: 900,
    intervalMs: 10,
    autoApplyMinConfidence: 4,
  });
  assert.equal(normalized.enabled, true, 'non-boolean keeps the default');
  assert.equal(normalized.maxChoices, 12);
  assert.equal(normalized.pixels, 0);
  assert.equal(normalized.elements, 200);
  assert.equal(normalized.intervalMs, 500);
  assert.equal(normalized.autoApplyMinConfidence, 1);

  const pixelsOnly = think.thinkBudget({ pixels: 80, elements: 0 });
  assert.equal(pixelsOnly.frame, true);
  assert.equal(pixelsOnly.uiAutomation, false);
  assert.equal(pixelsOnly.width, 80);
  assert.equal(pixelsOnly.height, 45);
  const elementsOnly = think.thinkBudget({ pixels: 0, elements: 12 });
  assert.equal(elementsOnly.frame, false);
  assert.equal(elementsOnly.overview, true);
  assert.equal(think.thinkBudget({ pixels: 0, elements: 0 }).overview, false);
});

test('a dialog and the goal window produce distinct candidate continuations', () => {
  const observation = think.normalizeObservation(dialogObservation);
  assert.equal(think.detectDialog(observation).kind, 'openFolder');
  assert.equal(think.detectDialog(think.normalizeObservation({ foreground: { title: 'OpenCode' } })), null, 'the word OpenCode is not a dialog');
  const choices = think.thinkChoices({
    step: step(),
    run: { lastWindow: { title: 'Getting started - Kiro' }, workflowGoal: 'ask Kiro what is a diamond' },
    observation,
    maxChoices: 7,
  });
  assert.ok(choices.length <= 7);
  assert.equal(new Set(choices.map((choice) => `${choice.type}:${choice.name}`)).size, choices.length, 'no duplicates');
  assert.ok(choices.some((choice) => choice.type === 'clickElement' && /Click “Open”/.test(choice.name)), 'the dialog button is planned');
  assert.ok(choices.some((choice) => choice.type === 'key' && /Enter/.test(choice.name) && choice.params.foreground === 'Open Folder'));
  assert.ok(choices.some((choice) => choice.type === 'focusWindow' && choice.params.title === 'Getting started - Kiro'), 'the goal window is not in front');
  assert.ok(choices.some((choice) => choice.type === 'clipboard' && choice.params.text === 'what is a diamond'), 'the alternate input path is kept');
  assert.ok(choices.some((choice) => choice.type === 'clickElement' && choice.params.name === 'Search'), 'a visible search field is a candidate');
});

test('the response sample scores the shot before anything is applied', () => {
  const observation = think.normalizeObservation(dialogObservation);
  const click = think.sampleChoice(
    { type: 'clickElement', name: 'click Open', params: { window: 'Open Folder', name: 'Open' } },
    observation
  );
  assert.equal(click.ok, true);
  assert.ok(click.confidence >= 0.9);
  assert.match(click.reasons.join(' '), /known button/);

  const noDialog = think.sampleChoice(
    { type: 'clickElement', name: 'click Open', params: { window: 'Getting started - Kiro', name: 'Open' } },
    think.normalizeObservation({ foreground: { title: 'Getting started - Kiro' }, windows: [{ title: 'Getting started - Kiro' }] })
  );
  assert.equal(noDialog.ok, false, 'a click on a button that is not there is rejected');

  const missingWindow = think.sampleChoice(
    { type: 'clipboard', name: 'paste', params: { action: 'paste', text: 'x', foreground: 'Notepad' } },
    observation
  );
  assert.equal(missingWindow.ok, false);

  const editable = think.sampleChoice(
    { type: 'type', name: 'type', params: { text: 'x', foreground: 'Open Folder' } },
    observation
  );
  assert.equal(editable.ok, true);
  assert.ok(editable.confidence > 0.8);

  const notEditable = think.sampleChoice(
    { type: 'type', name: 'type', params: { text: 'x', foreground: 'Save interaction note' } },
    think.normalizeObservation({
      foreground: { title: 'Open Folder' },
      focused: { found: true, editable: false, name: 'OK' },
    })
  );
  assert.equal(notEditable.ok, false);

  const ranked = think.scoreChoices(
    [
      { type: 'wait', name: 'wait', params: { ms: 1000 } },
      { type: 'clickElement', name: 'open', params: { window: 'Open Folder', name: 'Open' } },
    ],
    observation
  );
  assert.equal(ranked[0].type, 'clickElement', 'the sampled shot outranks the idle wait');
  assert.equal(ranked[1].ok, true);
});

test('one thinking turn writes bounded notes and records the best choice', () => {
  const target = step();
  const notes = [];
  let previous = null;
  for (let i = 0; i < 8; i += 1) {
    think.runThinkOnce(target, {
      observation:
        i === 0
          ? dialogObservation
          : { ...dialogObservation, foreground: { ...dialogObservation.foreground, title: `Window ${i}` } },
      run: { workflowGoal: 'ask Kiro what is a diamond' },
      settings: think.normalizeThinkSettings({ maxNotes: 5 }),
      onNote: (message) => notes.push(message),
    });
    previous = target.think;
  }
  assert.equal(previous.ticks, 8);
  assert.ok(previous.notes.length <= 5, 'notes stay bounded');
  assert.ok(previous.choices.length >= 3);
  assert.equal(previous.best.type, 'clickElement');
  assert.ok(notes.length >= 4, 'live-linked notes stream out');
  assert.ok(previous.notes.some((note) => /Window 7/.test(note.text)), 'the newest ticks survive the bound');
});

test('the live loop ticks without a timer and stops with a summary', async () => {
  const target = step();
  let tick = 0;
  const loop = think.beginStepThink(
    { id: 'run_think', workflowGoal: 'ask Kiro what is a diamond', steps: [target] },
    target,
    {
      settings: think.normalizeThinkSettings({ enabled: true, modelAssist: false, liveLink: true }),
      observe: async () => {
        tick += 1;
        return tick === 1 ? dialogObservation : { ...dialogObservation, foreground: { title: 'Getting started - Kiro' } };
      },
      schedule: () => ({ unref() {} }),
      cancel: () => {},
      onNote: () => {},
    }
  );
  assert.ok(loop);
  await loop.tickNow();
  await loop.tickNow();
  const record = await loop.stop();
  assert.equal(record.ticks, 2);
  assert.equal(record.status, 'done');
  assert.match(record.summary, /2 tick\(s\)/);
  assert.ok(record.finishedAt);
  assert.ok(record.best, 'a prepared correction survived to the end of the step');
});

test('model review can promote a sampled choice, and failures fall back to samples', async () => {
  const target = step();
  const loop = think.beginStepThink({ id: 'run_model', workflowGoal: 'ask Kiro' }, target, {
    settings: think.normalizeThinkSettings({
      enabled: true,
      modelAssist: true,
      modelEveryTicks: 1,
      liveLink: false,
      pixels: 0,
      elements: 0,
    }),
    observe: async () => dialogObservation,
    ask: async ({ prompt }) => {
      assert.match(prompt, /Candidates/);
      assert.match(prompt, /perception budget|Perception budget/i);
      // The Enter key candidate ranks sixth after sampling; pick it explicitly.
      return { ok: true, content: '{"pick":6,"why":"the dialog default button is faster"}' };
    },
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  await loop.tickNow();
  const record = await loop.stop();
  assert.ok(record.model, 'the model review was recorded');
  assert.match(record.model.why, /default button/);
  assert.equal(record.choices[0].type, 'key', 'the model choice moved to the front');

  const failing = step();
  const fallback = think.beginStepThink({ id: 'run_model_2' }, failing, {
    settings: think.normalizeThinkSettings({ enabled: true, modelAssist: true, modelEveryTicks: 1, pixels: 0, elements: 0 }),
    observe: async () => dialogObservation,
    ask: async () => ({ ok: false, error: 'offline' }),
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  await fallback.tickNow();
  await fallback.tickNow();
  const record2 = await fallback.stop();
  assert.equal(record2.model, null);
  assert.ok(record2.best, 'the sampled choice remains usable');
});

test('prepared corrections replace nothing, respect auto-apply, and stop after repeated rejects', () => {
  const target = step();
  think.runThinkOnce(target, {
    observation: dialogObservation,
    run: { workflowGoal: 'ask Kiro' },
    settings: think.normalizeThinkSettings({}),
  });
  const run = { id: 'run_apply', thinkBlockedSteps: [] };
  const candidates = think.thinkRepairCandidates({ run, step: target });
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0].replaces, false, 'the original step still runs after the correction');
  assert.equal(candidates[0].steps.length, 1);
  assert.ok(candidates[0].method.startsWith('step-think: '));

  assert.deepEqual(
    think.thinkRepairCandidates({ run, step: target, settings: think.normalizeThinkSettings({ autoApply: false }) }),
    [],
    'auto-apply off means nothing is offered'
  );

  // One rejection on this step blocks it; a second rejection blocks the run-wide path.
  think.recordThinkOutcome(run, target, { method: candidates[0].method, ok: false, error: 'still no input' });
  const blockedOnce = think.thinkRepairCandidates({
    run,
    step: target,
    settings: think.normalizeThinkSettings({ stepRejectLimit: 2 }),
  });
  assert.ok(blockedOnce.length >= 1, 'one rejection is not yet a block');
  think.recordThinkOutcome(run, target, { method: candidates[0].method, ok: false, error: 'intercepted again' });
  assert.match(think.thinkBlocked(run, target), /rejected/);
  assert.deepEqual(think.thinkRepairCandidates({ run, step: target }), []);
  assert.equal(run.thinkBlockedSteps.includes(target.id), true);

  const other = { id: 's_other', type: 'clickElement', name: 'other', params: {} };
  const runLimit = { id: 'run_limit', thinkBlockedSteps: [] };
  runLimit.thinkStats = { applies: 0, rejects: 4, byStep: {} };
  assert.match(think.thinkBlocked(runLimit, other, think.normalizeThinkSettings({ maxRejects: 4 })), /too many rejected/);
  runLimit.thinkStats = { applies: 3, rejects: 0, byStep: {} };
  assert.match(think.thinkBlocked(runLimit, other, think.normalizeThinkSettings({ maxAutoApplies: 3 })), /limit reached/);
});

test('a successful correction counts as an apply, and read-only steps never start thinking', async () => {
  const target = step();
  think.runThinkOnce(target, {
    observation: dialogObservation,
    run: { workflowGoal: 'ask Kiro' },
    settings: think.normalizeThinkSettings({}),
  });
  const run = { id: 'run_ok', thinkBlockedSteps: [] };
  const [candidate] = think.thinkRepairCandidates({ run, step: target });
  const outcome = think.recordThinkOutcome(run, target, { method: candidate.method, ok: true });
  assert.equal(outcome.ok, true);
  assert.equal(run.thinkStats.applies, 1);
  assert.equal(target.think.applied.length, 1);

  assert.equal(think.beginStepThink({ id: 'r' }, { id: 'w', type: 'wait', name: 'wait' }, { settings: think.normalizeThinkSettings({}) }), null);
  assert.equal(think.beginStepThink({ id: 'r' }, { id: 'v', type: 'verifyScreen', name: 'check' }, { settings: think.normalizeThinkSettings({}) }), null);
  assert.equal(
    think.beginStepThink({ id: 'r' }, step(), { settings: think.normalizeThinkSettings({ enabled: false }) }),
    null
  );
  const budgetOff = think.normalizeThinkSettings({ pixels: 0, elements: 0 });
  assert.equal(think.beginStepThink({ id: 'r' }, step(), { settings: budgetOff }), null, 'zero budget with no observe reader does nothing');
});

test('thinking is cheap by default: one read, no model, five alternatives', async () => {
  const defaults = think.normalizeThinkSettings({});
  assert.equal(defaults.modelAssist, false, 'the model is off unless asked for');
  assert.equal(defaults.readOnce, true, 'one combined read per step');
  assert.equal(defaults.overseer, false);
  assert.equal(defaults.keepRunning, false);

  const higher = think.normalizeThinkSettings({ higherThinking: true });
  assert.equal(higher.modelAssist, true, 'higher thinking includes the model review');
  assert.equal(higher.liveMonitor, true);
  assert.equal(higher.readOnce, false);
  assert.equal(higher.overseer, true);

  let reads = 0;
  const target = step();
  const loop = think.beginStepThink({ id: 'run_cheap', workflowGoal: 'ask Kiro' }, target, {
    settings: think.normalizeThinkSettings({ enabled: true, intervalMs: 500, liveMonitor: false }),
    observe: async () => {
      reads += 1;
      return dialogObservation;
    },
    schedule: (fn) => setTimeout(fn, 20),
    cancel: (timer) => clearTimeout(timer),
  });
  await new Promise((resolve) => setTimeout(resolve, 160));
  const record = await loop.stop();
  assert.equal(reads, 1, 'the step is read exactly once');
  assert.equal(record.ticks, 1);
  assert.ok((record.alternatives || []).length >= 5, 'the ranked alternatives survive the read');
});

test('the narration keeps five or more options and names why weak ones are passed over', () => {
  const target = step();
  const plain = think.normalizeObservation({
    foreground: { title: 'Getting started - Kiro' },
    windows: [{ title: 'Getting started - Kiro' }],
    pointer: { x: 640, y: 360 },
  });
  const choices = think.thinkChoices({
    step: target,
    run: { workflowGoal: 'ask Kiro what is a diamond' },
    observation: plain,
    maxChoices: 7,
  });
  assert.ok(choices.length >= 5, 'at least five continuations are drafted without a dialog');

  const notes = [];
  think.runThinkOnce(target, {
    observation: plain,
    run: { workflowGoal: 'ask Kiro what is a diamond' },
    settings: think.normalizeThinkSettings({ overseer: true }),
    onNote: (message) => notes.push(message),
  });
  assert.ok(target.think.alternatives.length >= 5);
  assert.deepEqual(
    target.think.alternatives.map((entry) => entry.rank),
    target.think.alternatives.map((entry, index) => index + 1)
  );
  assert.ok(target.think.alternatives.some((entry) => entry.verdict === 'rejected'), 'weak options are labelled, not hidden');
  assert.ok(notes.some((note) => /Pointer at \(640, 360\)/.test(note)), 'the pointer is named');
  assert.ok(notes.some((note) => /alternate|Considering/.test(note)), 'the narration explains the choice');

  const brief = think.overseerBrief({ run: {}, step: target, think: target.think, goal: 'ask Kiro what is a diamond' });
  assert.match(brief.decision, /continue|hold/);
  assert.match(brief.preservation, /retried|no step/);
  assert.ok(brief.alternatives.length >= 5);
});
