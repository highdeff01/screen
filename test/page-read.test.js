import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-page-read-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');
const pageRead = await load('server/page-read.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

/* ---------------------------------------------------------------- pure policy */

test('the reader only runs after steps that can change the page, within its budget', () => {
  assert.equal(pageRead.shouldReadPage({ type: 'click' }), true);
  assert.equal(pageRead.shouldReadPage({ type: 'launchApp' }), true);
  assert.equal(pageRead.shouldReadPage({ type: 'screenshot' }), false);
  assert.equal(pageRead.shouldReadPage({ type: 'wait' }), false);
  assert.equal(pageRead.shouldReadPage({ type: 'click' }, { reads: 6, settings: { maxPerRun: 6 } }), false);
  assert.equal(pageRead.shouldReadPage({ type: 'click' }, { settings: { enabled: false } }), false);
});

test('the reading is clamped and a non-answer is an empty reading', () => {
  const cfg = pageRead.normalizePageReadSettings({ maxPerRun: 999, maxInserts: -4, minConfidence: 9 });
  assert.equal(cfg.maxPerRun, 40);
  assert.equal(cfg.maxInserts, 0);
  assert.equal(cfg.minConfidence, 1);
  assert.equal(pageRead.normalizePageReadSettings({ enabled: false }).enabled, false);

  const reading = pageRead.parsePageRead(
    '```json\n{"page":"New Tab","app":"chrome","visible":"A profile chooser covers the page.",' +
      '"blockers":["profile chooser"],"usable":false,"goalLooksMet":false,' +
      '"nextAction":null,"confidence":0.82}\n```'
  );
  assert.equal(reading.app, 'chrome');
  assert.equal(reading.usable, false);
  assert.deepEqual(reading.blockers, ['profile chooser']);
  assert.equal(reading.confidence, 0.82);
  assert.equal(pageRead.parsePageRead('not json at all').confidence, 0);
});

test('an implied action is only kept when the step runner can execute it', () => {
  assert.equal(pageRead.normalizeImpliedStep({ type: 'click', params: {} }), null);
  assert.equal(pageRead.normalizeImpliedStep({ type: 'type', params: {} }), null);
  assert.equal(pageRead.normalizeImpliedStep({ type: 'focusWindow', params: {} }), null);
  assert.equal(pageRead.normalizeImpliedStep({ type: 'verifyScreen', params: { title: 'x' } }), null);

  const click = pageRead.normalizeImpliedStep({ type: 'click', name: 'Use the profile', params: { name: 'Work' } });
  assert.equal(click.type, 'click');
  assert.equal(click.params.name, 'Work');
  assert.equal(click.origin, 'page-read');

  // A model that puts the control's label in the action name still names a target;
  // a whole sentence is not a control.
  assert.equal(pageRead.normalizeImpliedStep({ type: 'click', name: 'Search', params: {} }).params.name, 'Search');
  assert.equal(pageRead.normalizeImpliedStep({ type: 'click', name: 'Click the search box and submit it', params: {} }), null);

  const focus = pageRead.normalizeImpliedStep({ type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Untitled - Notepad' } });
  assert.equal(focus.params.title, 'Untitled - Notepad');
  assert.equal(pageRead.duplicatesStep(focus, { type: 'focusWindow', params: { title: 'Untitled - Notepad' } }), true);
  assert.equal(pageRead.duplicatesStep(focus, { type: 'focusWindow', params: { title: 'Chrome' } }), false);
});

test('the question asks what is on screen, not whether the step matched', () => {
  const { system, user } = pageRead.pageReadPrompt({
    goal: 'chrome go to youtube type diamond lattice',
    stepName: 'Input “diamond lattice”',
    nextNames: ['Screen check'],
  });
  assert.match(system, /nextAction/);
  assert.match(system, /profile chooser/);
  assert.match(system, /usable=false/);
  assert.match(system, /starting the video/);
  assert.match(user, /chrome go to youtube type diamond lattice/);
  assert.match(user, /Steps the plan still has after this one: Screen check/);
});

/* -------------------------------------------------------------- engine wiring */

function resetDb(overrides = {}) {
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
  d.settings.recheck = { enabled: false, continueAfter: false, prepMs: 0, maxAttempts: 1, intervalMs: 50, maxPendingMs: 1000 };
  d.settings.screenReview = { enabled: false };
  d.settings.pageRead = { enabled: true, maxPerRun: 6, maxInserts: 3, minConfidence: 0.55, ...overrides };
  d.workflows = [];
  d.runs = [];
  return d;
}

function probeWith({ readings = [], executeStep = null } = {}) {
  const reads = [];
  const calls = [];
  const base = {
    executeStep: async (step, ctx) => {
      calls.push(step.type);
      return executeStep ? executeStep(step, ctx, calls) : { output: `${step.type} ok`, evidence: [] };
    },
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    readFocusedElement: async () => ({ found: false }),
    inspectWindowState: async () => ({ state: 'foreground', foreground: { title: 'Untitled - Notepad', process: 'notepad' } }),
    screenReview: async () => ({ output: 'Screen verified (vision 90%)', evidence: [] }),
    pageRead: async ({ step }) => {
      reads.push(step.name);
      const next = readings.length ? readings.shift() : null;
      return { ok: true, reading: pageRead.parsePageRead(JSON.stringify(next || neutral())) };
    },
  };
  return { probe: base, reads, calls };
}

function neutral(extra = {}) {
  return {
    page: 'Untitled - Notepad',
    app: 'notepad',
    visible: 'An empty Notepad document is in front.',
    blockers: [],
    usable: true,
    goalLooksMet: false,
    nextAction: null,
    confidence: 0.8,
    ...extra,
  };
}

function typeWorkflow(id) {
  return {
    id,
    name: 'Type the note',
    // No app is named: the run must not depend on goal verification opening one.
    description: 'Type “hi” in the focused window.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_type', type: 'type', name: 'Input “hi”', params: { text: 'hi' }, timeoutMs: 5000 },
    ],
  };
}

async function settle(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await sleep(25);
  }
  return store.db().runs.find((entry) => entry.id === runId);
}

test('an input with no window is unblocked by the screen and retried once', async () => {
  const d = resetDb();
  const wf = typeWorkflow('wf_page_read_unblock');
  d.workflows = [wf];
  const { probe } = probeWith({
    readings: [
      neutral({
        visible: 'Notepad is open and empty, with the caret in the document.',
        nextAction: {
          type: 'focusWindow',
          name: 'Focus Notepad',
          params: { title: 'Untitled - Notepad' },
          why: 'the note must be typed into Notepad',
        },
        confidence: 0.86,
      }),
    ],
    executeStep: async (step, ctx) => {
      if (step.type === 'focusWindow') {
        // The shape the engine reads back into run.lastWindow.
        return { output: 'focused Notepad :: Untitled - Notepad [hwnd=4242]', evidence: [] };
      }
      if (step.type === 'type' && !ctx.run.lastWindow && !step.params?.foreground) {
        return {
          skipped: true,
          output:
            'Skipped: no window was named or opened before “Input “hi””, so the keystrokes were not sent anywhere. Add a focusWindow step or set the step’s foreground window.',
        };
      }
      return { output: 'Typed “hi”', evidence: [] };
    },
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(done.status, 'passed', 'the run reaches its goal after the screen-guided step');
  assert.equal(done.steps.length, 3, 'skipped input, the step the reader added, and one retry');
  assert.equal(done.steps[0].status, 'skipped');
  assert.equal(done.steps[1].type, 'focusWindow');
  assert.equal(done.steps[1].origin, 'page-read');
  assert.equal(done.steps[1].params.title, 'Untitled - Notepad');
  assert.equal(done.steps[2].readRetry, true);
  assert.equal(done.steps[2].status, 'passed');
  assert.equal(done.steps[2].retriedAfterRead.by, 'Focus Notepad');
  assert.ok(done.pageReads.length >= 1, 'the reading is on the run');
  assert.equal(done.pageReads[0].inserted, 'Focus Notepad');
  assert.match(JSON.stringify(done.log), /Screen read added “Focus Notepad”/);
  assert.match(JSON.stringify(done.log), /will be tried again after “Focus Notepad”/);
});

test('a confident action on screen is added and run before the rest of the plan', async () => {
  const d = resetDb();
  const wf = {
    id: 'wf_page_read_insert',
    name: 'Search for the clip',
    description: 'Search the page for the clip.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_open', type: 'openUrl', name: 'Open the page', params: { url: 'https://example.test' }, timeoutMs: 5000 }],
  };
  d.workflows = [wf];
  const { probe } = probeWith({
    readings: [
      neutral({
        page: 'Example',
        app: 'chrome',
        visible: 'The page is open with a search field and no results yet.',
        nextAction: {
          type: 'click',
          name: 'Click the search field',
          params: { name: 'Search' },
          why: 'the goal needs a search before the clip can be picked',
        },
        confidence: 0.9,
      }),
    ],
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(done.status, 'passed');
  assert.equal(done.steps.length, 2);
  assert.equal(done.steps[1].name, 'Click the search field');
  assert.equal(done.steps[1].type, 'click');
  assert.equal(done.steps[1].origin, 'page-read');
  assert.equal(done.steps[1].status, 'passed');
  assert.equal(done.screenReadSteps.length, 1);
  assert.match(JSON.stringify(done.log), /the goal needs a search/);
  assert.equal(engine.summary(done).screenReadSteps[0].name, 'Click the search field');
});

test('a sign-in wall the reader cannot pass is reported, not clicked through', async () => {
  const d = resetDb();
  const wf = typeWorkflow('wf_page_read_wall');
  d.workflows = [wf];
  const { probe } = probeWith({
    readings: [
      neutral({
        page: 'Sign in',
        app: 'chrome',
        visible: 'A sign-in wall asks for an email and password.',
        blockers: ['sign-in wall'],
        usable: false,
        nextAction: null,
        confidence: 0.9,
      }),
    ],
  });
  const inner = probe.executeStep;
  probe.executeStep = async (step, ctx) => {
    if (step.type === 'type' && !ctx.run.lastWindow) {
      return { skipped: true, output: 'Skipped: no window was named or opened before “Input “hi””, so the keystrokes were not sent anywhere.' };
    }
    return inner(step, ctx);
  };

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(done.steps.length, 1, 'nothing was added for a wall it cannot pass');
  assert.equal(done.pageReads[0].usable, false);
  assert.deepEqual(done.pageReads[0].blockers, ['sign-in wall']);
  assert.equal(done.pageReads[0].inserted, null);
  assert.match(JSON.stringify(done.log), /in the way: sign-in wall/);
});

test('a low-confidence guess is recorded but never run', async () => {
  const d = resetDb({ minConfidence: 0.8 });
  const wf = typeWorkflow('wf_page_read_guess');
  d.workflows = [wf];
  const { probe } = probeWith({
    readings: [
      neutral({
        nextAction: { type: 'focusWindow', name: 'Focus something', params: { title: 'Notepad' } },
        confidence: 0.4,
      }),
    ],
    executeStep: async (step, ctx) => {
      if (step.type === 'type' && !ctx.run.lastWindow && !step.params?.foreground) {
        return { skipped: true, output: 'Skipped: no window was named or opened before “Input “hi””, so the keystrokes were not sent anywhere.' };
      }
      return { output: 'ok', evidence: [] };
    },
  });

  const run = engine.createRun(wf, { dryRun: false, probe, repair: false, aiReplan: false });
  const done = await settle(run.id);

  assert.equal(done.steps.length, 1, 'a 40% guess is not a step');
  assert.equal(done.pageReads[0].confidence, 0.4);
  assert.equal(done.pageReads[0].inserted, null);
});
