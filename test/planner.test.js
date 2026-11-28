import test from 'node:test';
import assert from 'node:assert/strict';

const planner = await import('../server/planner.js');
const store = await import('../server/store.js');

const context = {
  windows: [
    { process: 'Kiro', title: 'Extension: kiroAgent - Kiro', version: '1.4.178' },
    { process: 'Notepad', title: 'kiro-answer.txt - Notepad', version: '11.2609.11.0' },
  ],
  apps: [],
  processes: [],
};

test('a new goal does not inherit the previous question or search', () => {
  const steps = [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome' } },
    { type: 'openUrl', name: 'Search Google for what is python', params: { url: 'https://google.com/search?q=what+is+python' } },
    { type: 'clickElement', name: 'Search', params: { window: 'google.com/search?q=what+is+python', name: 'Search' } },
    { type: 'clickElement', name: 'Install', params: { window: 'vlc', name: 'Install' } },
  ];
  const kept = planner.dropStaleQuestionSteps(
    steps,
    'open chrome , download vlc media player , download and play a video on vlc using chrome'
  );
  assert.deepEqual(kept.map((step) => step.name), ['Open Chrome', 'Install']);
});

test('downloading an app satisfies the download phase without a media download step', () => {
  const steps = [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome' } },
    { type: 'wait', name: 'Wait', params: { ms: 1000 } },
    { type: 'openUrl', name: 'Open VLC', params: { url: 'https://www.videolan.org/vlc/' } },
    { type: 'wait', name: 'Wait', params: { ms: 2000 } },
    { type: 'clickElement', name: 'Install', params: { name: 'Install' } },
    { type: 'clickElement', name: 'Play', params: { name: 'Play' } },
  ];
  const issues = planner.planIssues(steps, 'open chrome, download vlc media player, download and play a video on vlc using chrome');
  assert.equal(issues.includes('missing download'), false);
  assert.equal(issues.includes('missing playback'), false);
});

test('a plan prompt names the controls the reviewer already found, or says it has none', () => {
  const named = planner.planFindingsText({
    seq: 9,
    ageMs: 2000,
    summary: 'A Save dialog is open over the document.',
    next: 'click Save',
    labels: [{ text: 'Save', at: { x: 0.8, y: 0.1 }, seen: 2 }],
  });
  assert.match(named, /Controls the vision reviewer already found on the current screen/);
  assert.match(named, /“Save” at \(0\.80,0\.10\) seen 2×/);
  assert.match(named, /clickElement params\.name/);
  assert.match(named, /A Save dialog is open over the document\./);
  assert.match(named, /click Save/);
  assert.match(planner.planFindingsText(null), /No live vision reading yet/);
});

test('a window title is normalized to a focus step and a bare URL gains a scheme', () => {
  const titleStep = planner.normalizeStep(
    { type: 'launchApp', name: 'Open Google Search', params: { target: 'Open Google Search - Google Chrome' } },
    0
  );
  assert.equal(titleStep.type, 'focusWindow');
  assert.equal(titleStep.params.title, 'Open Google Search - Google Chrome');
  // A space alone does not make an app name a window title: this one is a real
  // installed app, so it must stay a launch or it is never started.
  const appStep = planner.normalizeStep({ type: 'launchApp', name: 'Open Sightline Profile', params: { target: 'Sightline Profile' } }, 0);
  assert.equal(appStep.type, 'launchApp');
  assert.equal(appStep.params.target, 'Sightline Profile');
  const urlStep = planner.normalizeStep({ type: 'openUrl', name: 'Search', params: { url: 'google.com/search?q=vlc' } }, 0);
  assert.equal(urlStep.params.url, 'https://google.com/search?q=vlc');
});

test('parses a source question and a destination app instead of pinning to Notepad', () => {
  const intent = planner.parseGoalIntent(
    'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
    context
  );
  assert.equal(intent.source.name, 'Kiro');
  assert.equal(intent.destination.name, 'Notepad');
  assert.equal(intent.question, 'what is a cats favorite thing to eat');
});

test('adapts a remembered Kiro sequence without keeping the old answer text', () => {
  const intent = planner.parseGoalIntent(
    'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
    context
  );
  const steps = planner.adaptTemplateSteps([
    {
      type: 'type',
      name: 'Ask Kiro about a diamond',
      params: { text: 'what is a diamond', foreground: 'Kiro' },
    },
    {
      type: 'writeTextFile',
      name: 'Save answer to Desktop',
      params: { location: 'desktop', path: 'kiro-answer.txt', textVar: 'answer', text: 'old text' },
    },
    {
      type: 'launchApp',
      name: 'Open saved answer in Notepad',
      params: { target: 'C:/Users/Dan/Desktop/kiro-answer.txt' },
    },
  ], intent);

  assert.equal(steps[0].params.text, intent.question);
  assert.match(steps[1].params.path, /^cats-answer-\d{17}\.txt$/);
  assert.equal(steps[1].params.overwrite, false);
  assert.equal(steps[1].params.textVar, 'answer');
  assert.equal(steps[1].params.text, undefined);
  assert.match(steps[2].params.target, /cats-answer-\d{17}\.txt$/);
});

test('recovers the complete goal when the workflow description was truncated', () => {
  const goal = 'open kiro and ask what is a cats favorite thing to eat, than save answer to notepad on desktop';
  const workflow = {
    description: 'open kiro and ask what is a cats favorite thing to eat',
    steps: [{
      type: 'aiExtract',
      params: { instructions: `Extract only the answer or response requested by this goal, not the prompt or app chrome: ${goal}` },
    }],
  };
  assert.equal(planner.workflowGoal(workflow), goal);
});

test('rejects a write step before any step produces its text variable', () => {
  const intent = planner.parseGoalIntent(
    'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
    context
  );
  const result = planner.validateStepSequence(
    [
      { type: 'writeTextFile', name: 'Save early', params: { path: 'x.txt', textVar: 'answer' } },
      { type: 'type', name: 'Ask', params: { text: 'what is a cats favorite thing to eat', foreground: 'Kiro' } },
    ],
    intent,
    { templateName: 'test' }
  );
  assert.equal(result.rejected[0].phase, 'file.write');
  assert.match(result.rejected[0].reason, /before any step produces/);
  assert.equal(result.steps.some((step) => step.type === 'writeTextFile' && step.params.textVar === 'answer'), true);
  assert.equal(result.backups.some((backup) => backup.phase === 'file.write'), true);
  assert.equal(result.preflight.some((check) => check.check === 'reject-early-write' && !check.ok), true);
});

test('keeps a valid copy-before-write sequence and records step decisions', () => {
  const intent = planner.parseGoalIntent(
    'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
    context
  );
  const steps = planner.adaptTemplateSteps(
    [
      { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
      { type: 'clickElement', name: 'Click input', params: { window: 'Kiro', name: 'Ask a question' } },
      { type: 'type', name: 'Ask', params: { text: 'what is a diamond', foreground: 'Kiro' } },
      { type: 'key', name: 'Send', params: { keys: ['{ENTER}'], foreground: 'Kiro' } },
      { type: 'clipboard', name: 'Clear clipboard', params: { action: 'clear' } },
      { type: 'clickElement', name: 'Copy Kiro answer', params: { window: 'Kiro', name: 'Copy message' } },
      { type: 'clipboard', name: 'Capture answer', params: { action: 'read', outputVar: 'answer' } },
      { type: 'writeTextFile', name: 'Save', params: { path: 'kiro-answer.txt', textVar: 'answer' } },
      { type: 'launchApp', name: 'Open Notepad', params: { target: 'C:/Users/Dan/Desktop/kiro-answer.txt' } },
      { type: 'focusWindow', name: 'Focus Notepad', params: { title: 'kiro-answer.txt' } },
      { type: 'key', name: 'Paste', params: { keys: ['^v'], foreground: 'kiro-answer.txt' } },
      { type: 'key', name: 'Save', params: { keys: ['^s'], foreground: 'kiro-answer.txt' } },
    ],
    intent
  );
  const result = planner.validateStepSequence(steps, intent, { templateName: 'test' });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.steps.length, 12);
  assert.equal(result.decisions.length, 12);
  assert.ok(result.confidence >= 0.9);
  assert.equal(result.preflight.every((check) => check.ok), true);
  const writeIndex = result.steps.findIndex((step) => step.type === 'writeTextFile');
  const copyIndex = result.steps.findIndex((step) => step.type === 'clickElement' && /copy/i.test(step.name));
  assert.ok(copyIndex >= 0 && copyIndex < writeIndex);
});

test('a tool reference resolves by id or by name and refuses anything else', () => {
  const tools = [
    { id: 'tool_cleanup', name: 'Cleanup' },
    { id: 'tool_window_list', name: 'List visible windows' },
  ];
  assert.equal(planner.resolveToolRef({ toolId: 'tool_cleanup' }, tools)?.id, 'tool_cleanup');
  assert.equal(planner.resolveToolRef({ toolName: 'List visible windows' }, tools)?.id, 'tool_window_list');
  assert.equal(planner.resolveToolRef({ toolId: 'List visible windows' }, tools)?.id, 'tool_window_list');
  assert.equal(planner.resolveToolRef({ toolName: 'shell' }, tools), null);
  assert.equal(planner.resolveToolRef({}, tools), null);
  assert.equal(planner.resolveToolRef({ toolId: 'tool_cleanup' }, []), null);
});

/** Add an approved tool to the in-memory store for one test, then remove it. */
function withTool(tool) {
  const tools = store.db().tools;
  tools.push(tool);
  return () => {
    const index = tools.indexOf(tool);
    if (index >= 0) tools.splice(index, 1);
  };
}

test('a tool step keeps the id execution looks up, even when the plan names the tool', () => {
  const drop = withTool({ id: 'tool_under_test', name: 'Tool under test' });
  try {
    const step = planner.normalizeStep({ type: 'runTool', name: 'Run the tool', toolName: 'Tool under test' });
    assert.equal(step.type, 'runTool');
    assert.equal(step.params.toolId, 'tool_under_test');
    assert.equal(step.params.toolName, 'Tool under test');
  } finally {
    drop();
  }
});

test('a tool step that names no approved tool is dropped instead of run', () => {
  const drop = withTool({ id: 'tool_under_test', name: 'Tool under test' });
  try {
    const result = planner.alignPlanToGoal(
      [
        { type: 'runTool', name: 'Run nothing', params: {} },
        { type: 'runTool', name: 'Run an unapproved tool', params: { toolName: 'tool_that_does_not_exist' } },
        { type: 'runTool', name: 'Run an approved tool by name', params: { toolName: 'Tool under test' } },
        { type: 'screenshot', name: 'Look at the screen', params: {} },
      ],
      'list the windows'
    );
    assert.deepEqual(result.steps.map((step) => step.type), ['runTool', 'screenshot']);
    assert.equal(result.steps[0].params.toolId, 'tool_under_test');
  } finally {
    drop();
  }
});
