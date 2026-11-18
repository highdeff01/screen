import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-agent-replan-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const agent = await load('server/agent-replan.js');
const planner = await load('server/planner.js');
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function fakeDb() {
  return {
    notes: [],
    repairMemory: [],
    agentLessons: [],
  };
}

const runFor = (step) => ({
  workflowName: 'Ask an app',
  workflowId: 'wf_agent',
  steps: [{ id: 's0', type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' }, status: 'passed' }, step],
  variables: { answer: '42' },
});

test('AI replacement steps inherit the failed step window guard and reject unsafe tools', async () => {
  const step = { id: 's1', type: 'type', name: 'Ask the question', params: { text: 'old', foreground: 'Notepad' } };
  let promptSeen = '';
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: { name: 'Ask an app', steps: [] },
    step,
    index: 1,
    error: 'synthetic failure',
    failure: { category: 'input_failed' },
    advice: [{ name: 'Watchdog', advice: 'Use the alternate input path.' }],
    database: fakeDb(),
    ask: async ({ prompt }) => {
      promptSeen = prompt;
      return JSON.stringify({
        diagnosis: 'The field lost focus before the text arrived.',
        method: 'refocus and retype',
        confidence: 0.9,
        replacesStep: true,
        steps: [
          { type: 'focusWindow', params: { title: 'Notepad' } },
          { type: 'type', params: { text: 'new question' } },
          { type: 'key', params: { keys: 'enter' } },
          { type: 'runTool', params: { toolId: 'unsafe' } },
          { type: 'installApp', params: { id: 'Unsafe.App' } },
          { type: 'closeWindow', params: { title: 'Notepad' } },
        ],
        remember: 'Refocus Notepad before typing.',
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.replacesStep, true);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[1].params.text, 'new question');
  assert.equal(result.steps[1].params.foreground, 'Notepad');
  assert.equal(result.steps[2].params.foreground, 'Notepad');
  assert.ok(result.steps.every((entry) => entry.type !== 'runTool' && entry.type !== 'installApp'));
  assert.match(promptSeen, /FAILED STEP: 2\/2/);
  assert.match(promptSeen, /Use the alternate input path/);
});

test('AI can rewrite the remaining plan without repeating passed phases', async () => {
  const step = { id: 's1', type: 'clickElement', name: 'Open the report', params: { name: 'Report' } };
  const result = await agent.agentReplan({
    run: {
      workflowName: 'Open report',
      steps: [
        { id: 's0', type: 'openUrl', name: 'Open app', params: { url: 'https://example.com' }, status: 'passed' },
        step,
        { id: 's2', type: 'type', name: 'Write summary', params: { text: 'x' }, status: 'pending' },
      ],
      variables: {},
    },
    workflow: { name: 'Open report', steps: [] },
    step,
    index: 1,
    error: 'control not found',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The page exposes a menu instead of the report control.',
        method: 'navigate from the menu',
        remainingSteps: [
          { type: 'clickElement', params: { name: 'Menu' } },
          { type: 'clickElement', params: { name: 'Report' } },
          { type: 'verifyScreen', params: { question: 'Is the report visible?' } },
        ],
      }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps, []);
  assert.equal(result.remainingSteps.length, 3);
  assert.equal(result.remainingSteps[0].params.window, 'chrome');
  assert.equal(result.remainingSteps[2].type, 'verifyScreen');
});

test('AI cannot relaunch a missing window title; the goal fallback app is used', async () => {
  const step = { id: 's1', type: 'focusWindow', name: 'Focus the probe', params: { title: 'SightlineMissingWindow' } };
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: { name: 'Probe', description: 'If the probe window is missing, open Calculator and verify it.' },
    step,
    index: 1,
    error: 'No window matching title SightlineMissingWindow',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window is missing.',
        method: 'launch the missing title',
        replacesStep: true,
        steps: [
          { type: 'launchApp', params: { target: 'SightlineMissingWindow' } },
          { type: 'focusWindow', params: { title: 'SightlineMissingWindow' } },
        ],
      }),
  });
  assert.equal(result.steps[0].params.target, 'calc.exe');
  assert.equal(result.steps[0].name, 'Open Calculator');
  assert.equal(result.steps[1].params.title, 'Calculator');
});

test('notes, successful methods and lessons are matched for the failure', () => {
  const db = fakeDb();
  db.notes.push({
    title: 'VLC download notes',
    body: 'The Download VLC button is below the hero and opens the installer page.',
    tags: ['vlc'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  db.notes.push({ title: 'Unrelated', body: 'Nothing about this task.', tags: [] });
  db.repairMemory.push({
    workflowId: 'wf_other',
    stepType: 'clickElement',
    stepName: 'Download VLC',
    method: 'control type Button',
    steps: [{ type: 'clickElement', params: { name: 'Download VLC', controlType: 'Button' } }],
    replaces: true,
    uses: 4,
  });
  const step = { type: 'clickElement', name: 'Download VLC', params: { name: 'Download VLC' } };
  assert.equal(agent.relevantNotes(db, { goal: 'Download VLC and play a video', step })[0].title, 'VLC download notes');
  assert.equal(agent.relevantMethods(db, { step })[0].method, 'control type Button');
  agent.rememberAgentLesson(db, {
    goal: 'Download VLC and play a video',
    workflowId: 'wf_agent',
    step,
    method: 'control type Button',
    lesson: 'Use the Button control type on the VLC page.',
  });
  assert.equal(agent.relevantLessons(db, { goal: 'Download VLC' })[0], 'Use the Button control type on the VLC page.');
  agent.rememberAgentLesson(db, {
    goal: 'Download VLC and play a video',
    workflowId: 'wf_agent',
    step,
    method: 'control type Button',
    lesson: 'Use the Button control type on the VLC page.',
  });
  assert.equal(db.agentLessons[0].uses, 2);
});

test('an executable-style guard from the AI is reduced to a matchable app name', async () => {
  const step = { id: 's1', type: 'dragCopy', name: 'Copy the line', params: { text: 'line', window: 'Notepad' } };
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: { name: 'Ask an app', steps: [] },
    step,
    index: 1,
    error: 'Drag-copy could not find the text',
    failure: { category: 'input_failed' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The label was not in the UI Automation tree.',
        method: 'retype and copy',
        steps: [
          { type: 'type', params: { text: 'line', foreground: 'notepad.exe' } },
          { type: 'key', params: { keys: 'shift+home', foreground: 'NOTEPAD.EXE' } },
        ],
        replacesStep: true,
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].params.foreground, 'notepad');
  assert.equal(result.steps[1].params.foreground, 'NOTEPAD');
});

test('a window action repair must perform the same window action', async () => {
  const step = { id: 's1', type: 'windowAction', name: 'Restore the probe', params: { title: 'Probe', action: 'restore' } };
  const base = {
    run: runFor(step),
    workflow: { name: 'Probe', steps: [] },
    step,
    index: 1,
    error: 'No window matched title "Probe"',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
  };
  const substituted = await agent.agentReplan({
    ...base,
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window is gone.',
        method: 'open another app',
        steps: [{ type: 'launchApp', params: { target: 'calc.exe' } }],
        replacesStep: true,
      }),
  });
  assert.equal(substituted.ok, false);
  assert.equal(substituted.steps.length, 0);

  const repaired = await agent.agentReplan({
    ...base,
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window was closed.',
        method: 'reopen and restore it',
        steps: [
          { type: 'launchApp', params: { target: 'notepad.exe' } },
          { type: 'windowAction', params: { title: 'Probe', action: 'restore' } },
        ],
        replacesStep: true,
      }),
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.steps.filter((entry) => entry.type === 'windowAction' && entry.params.action === 'restore').length, 1);
});

test('an unusable AI reply is reported, not thrown', async () => {
  const step = { id: 's1', type: 'waitFor', name: 'Wait', params: { value: 'Notepad' } };
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: { name: 'Wait' },
    step,
    index: 1,
    error: 'timeout',
    database: fakeDb(),
    ask: async () => 'not json at all',
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 0);
});

test('planner validates the new window and drag-copy actions', () => {
  const steps = planner.normalizePlanSteps(
    [
      { type: 'minimize', params: { title: 'Popup', state: 'minimize' } },
      { type: 'dragcopy', params: { text: 'paragraph', window: 'Notepad' } },
    ],
    'minimize the popup and copy a paragraph',
    {},
    { align: false }
  );
  assert.equal(steps[0].type, 'windowAction');
  assert.equal(steps[0].params.action, 'minimize');
  assert.equal(steps[1].type, 'dragCopy');
  assert.equal(steps[1].params.outputVar, 'selectedText');
});

function probeFor({ succeed, agentAsk }) {
  return {
    captureScreenSignature: async () => ({ at: new Date().toISOString(), hash: 'x', cells: [] }),
    inspectWindowState: async () => ({ state: 'absent', foreground: null }),
    readFocusedElement: async () => ({ found: false }),
    findUiElement: async () => ({ found: false }),
    agentAsk,
    executeStep: async (step) => {
      if (!succeed(step)) throw new Error(`synthetic failure for ${step.type}`);
      return { output: `did ${step.name}`, evidence: [] };
    },
  };
}

test('the engine executes an AI replacement and records the repair', async () => {
  store.db().settings.visualChecks = false;
  store.db().settings.autoNotes = false;
  store.db().settings.autoRecoverFailures = false;
  let asked = 0;
  const workflow = {
    id: 'wf_ai_replace',
    name: 'AI replacement',
    description: 'AI replacement',
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps: [
      { id: 's1', type: 'type', name: 'Type the answer', params: { text: 'old', foreground: 'GhostApp' }, timeoutMs: 5000 },
    ],
  };
  const probe = probeFor({
    succeed: (step) => step.type === 'expect' || (step.type === 'type' && step.params.text === 'AI fixed'),
    agentAsk: async () => {
      asked++;
      return JSON.stringify({
        diagnosis: 'The original text never landed.',
        method: 'refocus and type the corrected answer',
        confidence: 0.8,
        replacesStep: true,
        steps: [{ type: 'type', params: { text: 'AI fixed', foreground: 'GhostApp' } }],
        remember: 'Refocus GhostApp before typing.',
      });
    },
  });
  const run = engine.createRun(workflow, { dryRun: false, probe, repair: true });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 20000 });
  assert.equal(asked, 1);
  assert.equal(finished.status, 'passed');
  assert.equal(finished.steps[0].status, 'passed');
  assert.match(finished.steps[0].repairedBy || '', /AI replan/);
  assert.equal(finished.repairCount, 1);
  assert.equal(finished.agentReplans.length, 1);
});

test('a repair that opens another app is adopted by the presenter and verifier', async () => {
  store.db().settings.visualChecks = false;
  store.db().settings.autoNotes = false;
  store.db().settings.autoRecoverFailures = false;
  const workflow = {
    id: 'wf_app_adopt',
    name: 'Open the note app',
    description: 'Open the note app and type a line.',
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps: [
      { id: 's1', type: 'launchApp', name: 'Open GhostApp', params: { target: 'GhostApp' }, timeoutMs: 5000 },
      { id: 's2', type: 'type', name: 'Type a line', params: { text: 'hello', foreground: 'GhostApp' }, timeoutMs: 5000 },
    ],
  };
  const live = async ({ title = '', process = '' } = {}) =>
    /calc|calculator/i.test(`${title} ${process}`)
      ? { state: 'foreground', foreground: { title: 'Calculator', process: 'calc' } }
      : { state: 'absent', foreground: null };
  const probe = {
    ...probeFor({
      succeed: () => true,
      agentAsk: async () =>
        JSON.stringify({
          diagnosis: 'GhostApp is not installed, so the named window can never appear.',
          method: 'open Calculator instead',
          confidence: 0.7,
          replacesStep: true,
          steps: [
            { type: 'launchApp', params: { target: 'calc.exe' } },
            { type: 'focusWindow', params: { title: 'Calculator', process: 'calc' } },
          ],
        }),
    }),
    inspectWindowState: live,
  };
  probe.executeStep = async (step) => {
    if (step.type !== 'type' && /ghost/i.test(JSON.stringify(step.params || {}))) {
      throw new Error(`no window matching ${step.params?.target || step.params?.title || 'GhostApp'}`);
    }
    return { output: step.type === 'launchApp' ? 'focused calc :: Calculator' : `did ${step.name}`, evidence: [] };
  };
  const run = engine.createRun(workflow, { dryRun: false, probe, repair: true });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 25000 });
  assert.equal(finished.status, 'passed');
  assert.match(finished.steps[0].repairedBy || '', /launch the app named|AI replan/i);
  assert.match(finished.effectiveApp?.target || '', /calc/i);
  assert.equal(finished.effectiveApp?.name, 'Calculator');
  assert.equal(finished.effectiveApp?.replacedTarget, 'GhostApp');
  assert.match(finished.presenter.app.target, /calc/i);
  assert.equal(finished.presenter.verifier.app.name, 'Calculator');
  assert.equal(finished.presenter.verifier.app.replacedFrom, 'GhostApp');
  assert.match(finished.presenter.verifier.summary, /Calculator/);
  assert.ok(finished.presenter.fallbacks.every((entry) => !/ghost/i.test(String(entry.label || ''))));
  assert.ok(finished.presenter.timeline.some((entry) => /Target app changed to Calculator/.test(entry.text)));
});

test('the engine rewrites the remainder after an irreparable action and still passes', async () => {
  store.db().settings.visualChecks = false;
  store.db().settings.autoNotes = false;
  store.db().settings.autoRecoverFailures = false;
  let asked = 0;
  const workflow = {
    id: 'wf_ai_remaining',
    name: 'AI remainder',
    description: 'AI remainder',
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps: [
      { id: 's1', type: 'type', name: 'Type the answer', params: { text: 'old', foreground: 'GhostApp' }, timeoutMs: 5000 },
      { id: 's2', type: 'writeNote', name: 'Save the old note', params: { title: 'old', text: 'old' }, timeoutMs: 5000 },
    ],
  };
  const probe = probeFor({
    succeed: (step) => ['note', 'screenshot', 'writeNote', 'verifyScreen'].includes(step.type),
    agentAsk: async () => {
      asked++;
      return JSON.stringify({
        diagnosis: 'The input field is gone; finish by recording what is already on screen.',
        method: 'record the visible result',
        steps: [],
        remainingSteps: [
          { type: 'note', params: { text: 'Visible result confirmed.' } },
          { type: 'screenshot', params: { caption: 'Final state after replan' } },
          { type: 'verifyScreen', params: { question: 'Is the final state visible?' } },
        ],
      });
    },
  });
  const run = engine.createRun(workflow, { dryRun: false, probe, repair: true });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 20000 });
  assert.equal(asked, 1);
  assert.equal(finished.status, 'passed');
  assert.equal(finished.replannedAfterFailure, true);
  assert.equal(finished.replanCount, 1);
  assert.equal(finished.supersededSteps.length, 1);
  assert.equal(finished.failedSteps.length, 0);
  assert.equal(finished.steps.find((step) => step.name === 'Save the old note'), undefined);
  assert.ok(finished.steps.some((step) => step.type === 'screenshot' && step.status === 'passed'));
});

const goalPaint = () => ({
  name: 'Restore Paint',
  description: 'Open Microsoft Paint and restore its window so it is in front, then confirm it is in front.',
  steps: [],
});

const restoreStep = () => ({
  id: 's1',
  type: 'windowAction',
  name: 'Restore the design window',
  params: { title: 'SightlineGhostWindow42', action: 'restore' },
});

test('a repair that names another app is retargeted to the app the goal names', async () => {
  const step = restoreStep();
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: goalPaint(),
    step,
    index: 1,
    error: 'No window matched title "SightlineGhostWindow42" or process "".',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The named window is gone; the goal names Paint.',
        method: 'launch and focus the app named by the goal',
        confidence: 0.9,
        replacesStep: true,
        steps: [
          { type: 'launchApp', params: { target: 'calc.exe' } },
          { type: 'focusWindow', params: { title: 'Calculator', process: 'calc' } },
          { type: 'windowAction', params: { title: 'Calculator', action: 'restore' } },
          {
            type: 'verifyScreen',
            params: {
              title: 'Calculator',
              expected: 'Calculator',
              question: 'Is Calculator restored and in front?',
              caption: 'Calculator check',
            },
          },
        ],
      }),
  });
  assert.equal(result.ok, true);
  const [open, focus, action, check] = result.steps;
  assert.equal(open.type, 'launchApp');
  assert.equal(open.params.target, 'mspaint.exe');
  assert.equal(open.name, 'Open Paint');
  assert.equal(focus.params.title, 'Paint');
  assert.equal(focus.params.process, 'mspaint');
  assert.equal(action.type, 'windowAction');
  assert.equal(action.params.action, 'restore');
  assert.equal(action.params.title, 'Paint');
  assert.equal(check.type, 'verifyScreen');
  assert.equal(check.params.title, 'Paint');
  assert.equal(check.params.expected, 'Paint');
  assert.match(String(check.params.question), /Paint/);
  assert.doesNotMatch(String(check.params.question), /calculator/i);
  assert.doesNotMatch(String(check.params.caption), /calculator/i);
});

test('waitFor values that name an executable are rewritten for the goal app', async () => {
  const step = { id: 's1', type: 'focusWindow', name: 'Focus the design window', params: { title: 'SightlineGhostWindow42' } };
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: goalPaint(),
    step,
    index: 1,
    error: 'No window matching title SightlineGhostWindow42',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window never opened.',
        method: 'open the goal app and wait for it',
        confidence: 0.8,
        replacesStep: true,
        steps: [
          { type: 'launchApp', params: { target: 'mspaint.exe' } },
          { type: 'waitFor', params: { kind: 'window', value: 'mspaint.exe', timeoutMs: 8000 } },
          { type: 'waitFor', params: { kind: 'process', value: 'mspaint.exe', timeoutMs: 8000 } },
          { type: 'focusWindow', params: { title: 'Untitled - Paint', process: 'mspaint' } },
        ],
      }),
  });
  assert.equal(result.ok, true);
  // A target that already names the goal app is left alone.
  assert.equal(result.steps[0].params.target, 'mspaint.exe');
  // "waitFor window mspaint.exe" can never match a title.
  assert.equal(result.steps[1].params.kind, 'window');
  assert.equal(result.steps[1].params.value, 'Paint');
  // A process wait wants the process name, not the executable file.
  assert.equal(result.steps[2].params.kind, 'process');
  assert.equal(result.steps[2].params.value, 'mspaint');
  // The real window of the goal app is a match, so it is kept.
  assert.equal(result.steps[3].params.title, 'Untitled - Paint');
});

test('a verifyScreen that already names the goal app is left unchanged', async () => {
  const step = restoreStep();
  const question = 'Is Paint restored and in front?';
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: goalPaint(),
    step,
    index: 1,
    error: 'No window matched title "SightlineGhostWindow42" or process "".',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window is gone.',
        method: 'open the goal app and restore it',
        confidence: 0.9,
        replacesStep: true,
        steps: [
          { type: 'launchApp', params: { target: 'mspaint.exe' } },
          { type: 'windowAction', params: { title: 'Paint', action: 'restore' } },
          { type: 'verifyScreen', params: { title: 'Paint', question } },
        ],
      }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].params.target, 'mspaint.exe');
  assert.equal(result.steps[1].params.title, 'Paint');
  assert.equal(result.steps[2].params.title, 'Paint');
  assert.equal(result.steps[2].params.question, question);
});

test('an AI expect check that names another app is retargeted to the goal app', async () => {
  const step = { id: 's1', type: 'focusWindow', name: 'Focus the design window', params: { title: 'SightlineGhostWindow42' } };
  const result = await agent.agentReplan({
    run: runFor(step),
    workflow: goalPaint(),
    step,
    index: 1,
    error: 'No window matching title SightlineGhostWindow42',
    failure: { category: 'window_not_found' },
    database: fakeDb(),
    ask: async () =>
      JSON.stringify({
        diagnosis: 'The window never opened.',
        method: 'open the goal app and check the foreground',
        confidence: 0.8,
        replacesStep: true,
        steps: [
          { type: 'launchApp', params: { target: 'mspaint.exe' } },
          { type: 'expect', params: { kind: 'foreground', value: 'Calculator' } },
          { type: 'expect', params: { kind: 'foreground', value: 'Paint' } },
          { type: 'expect', params: { kind: 'foreground', value: 'Example Domain' } },
          { type: 'expect', params: { kind: 'text', value: 'Calculator' } },
        ],
      }),
  });
  assert.equal(result.ok, true);
  // Another app's foreground check becomes the goal app's check, and the
  // goal app's own duplicate check collapses into it.
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[1].params.kind, 'foreground');
  assert.equal(result.steps[1].params.value, 'Paint');
  assert.equal(result.steps.filter((entry) => entry.params?.value === 'Paint').length, 1);
  // A page title is not an app name and must not be rewritten.
  assert.equal(result.steps[2].params.value, 'Example Domain');
  // A non-app check keeps its text.
  assert.equal(result.steps[3].params.value, 'Calculator');
});
