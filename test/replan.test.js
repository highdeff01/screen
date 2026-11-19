import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRevision,
  buildRevisionPrompt,
  desktopSummary,
  isTransientFailure,
  retryReplaysFailure,
  revisePlan,
} from '../server/replan.js';

function plan() {
  return [
    { id: 's1', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' }, status: 'passed' },
    { id: 's2', type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' }, status: 'passed' },
    { id: 's3', type: 'type', name: 'Type the note', params: { text: 'hello', foreground: 'Untitled - Notepad' }, status: 'failed' },
    { id: 's4', type: 'expect', name: 'Window is present', params: { kind: 'window', value: 'Notepad' }, status: 'pending' },
  ];
}

test('continue keeps the passed steps and resumes after the failure', () => {
  const revision = applyRevision(
    { decision: 'continue', note: 'the plan was right', prep: [{ type: 'wait', params: { ms: 800 } }], steps: [] },
    { steps: plan(), failedIndex: 2, goal: 'type a note' }
  );
  assert.equal(revision.decision, 'continue');
  assert.deepEqual(revision.steps.map((step) => step.type), ['launchApp', 'focusWindow', 'wait', 'type', 'expect']);
  assert.equal(revision.prepCount, 1);
  assert.equal(revision.resumeFrom, 2, 'the retry resumes after the two steps that passed');
});

test('rebuild replaces the remainder but never repeats passed work', () => {
  const revision = applyRevision(
    {
      decision: 'rebuild',
      steps: [
        { type: 'focusWindow', name: 'Focus the note', params: { title: 'Untitled - Notepad' } },
        { type: 'type', name: 'Type again', params: { text: 'hello again', foreground: 'Untitled - Notepad' } },
        { type: 'expect', name: 'Check', params: { kind: 'window', value: 'Notepad' } },
      ],
    },
    { steps: plan(), failedIndex: 2, goal: 'type a note' }
  );
  assert.equal(revision.steps.length, 5);
  assert.deepEqual(revision.steps.slice(0, 2).map((step) => step.id), ['s1', 's2']);
  assert.ok(revision.steps.slice(2).every((step) => !['s1', 's2'].includes(step.id)));
});

test('prep is limited to looking around and opening: typing is dropped from it', () => {
  const revision = applyRevision(
    {
      decision: 'continue',
      prep: [
        { type: 'type', name: 'Type into whatever is open', params: { text: 'oops' } },
        { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
        { type: 'screenshot', name: 'Look at the screen', params: {} },
      ],
      steps: [],
    },
    { steps: plan(), failedIndex: 2 }
  );
  assert.deepEqual(revision.steps.map((step) => step.type), ['launchApp', 'focusWindow', 'launchApp', 'screenshot', 'type', 'expect']);
  assert.equal(revision.prepCount, 2, 'only the safe prep steps survive');
});

test('a revision cannot reach for tools that act outside the goal', () => {
  const revision = applyRevision(
    {
      decision: 'rearrange',
      steps: [
        { type: 'runTool', name: 'Run something', params: { toolName: 'shell' } },
        { type: 'installApp', name: 'Install', params: { id: 'x' } },
        { type: 'writeTextFile', name: 'Write', params: { path: 'x.txt' } },
        { type: 'expect', name: 'Check', params: { kind: 'window', value: 'Notepad' } },
      ],
    },
    { steps: plan(), failedIndex: 2 }
  );
  assert.deepEqual(revision.steps.slice(2).map((step) => step.type), ['expect']);
});

test('a typing step without a window inherits the one the failed step used', () => {
  const revision = applyRevision(
    { decision: 'rearrange', steps: [{ type: 'type', name: 'Type', params: { text: 'x' } }] },
    { steps: plan(), failedIndex: 2 }
  );
  const typing = revision.steps.find((step) => step.type === 'type' && step.name === 'Type');
  assert.equal(typing.params.foreground, 'Untitled - Notepad');
});

test('a reply with nothing usable is refused instead of becoming an empty plan', () => {
  assert.equal(applyRevision('not json', { steps: plan(), failedIndex: 2 }), null);
  assert.equal(applyRevision({ decision: 'rebuild', steps: [] }, { steps: plan(), failedIndex: 2 }), null);
  assert.equal(
    applyRevision({ decision: 'rearrange', steps: [{ type: 'runTool', name: 'x', params: {} }] }, { steps: plan(), failedIndex: 2 }),
    null
  );
});

test('the revision prompt carries the desktop, the rules and the failure point', () => {
  const { prompt } = buildRevisionPrompt({
    workflow: { name: 'Notepad quick capture', description: 'Type a note' },
    goal: 'type a note in Notepad',
    steps: plan(),
    failedIndex: 2,
    failure: { type: 'type', name: 'Type the note', error: 'Refusing to type: foreground window is another document' },
    desktop: { foreground: { title: 'Untitled - Notepad', process: 'notepad' }, windows: [{ title: 'Chrome', process: 'chrome' }] },
    suggestions: [{ text: 'Add a wait after opening Notepad' }],
    lessons: [{ lesson: 'Notepad restores its last tab' }],
    workflows: [{ name: 'Chrome search', tags: ['web'], description: 'search the web' }],
  });
  assert.match(prompt, /Refusing to type/);
  assert.match(prompt, /<-- failed here/);
  assert.match(prompt, /Foreground: Untitled - Notepad \(notepad\)/);
  assert.match(prompt, /Chrome \(chrome\)/);
  assert.match(prompt, /Add a wait after opening Notepad/);
  assert.match(prompt, /Notepad restores its last tab/);
  assert.match(prompt, /Chrome search/);
  assert.match(prompt, /Never repeat a step that already passed/);
});

test('continue with no new steps is flagged as a replay of the failed step', () => {
  const revision = applyRevision({ decision: 'continue', note: 'the plan is right', steps: [] }, { steps: plan(), failedIndex: 2 });
  assert.equal(revision.replaysFailure, true);
  assert.equal(revision.prepCount, 0);

  const changed = applyRevision(
    { decision: 'rearrange', steps: [{ type: 'type', name: 'Type again', params: { text: 'hello', foreground: 'Untitled - Notepad' } }] },
    { steps: plan(), failedIndex: 2 }
  );
  assert.equal(changed.replaysFailure, false);
});

test('a replay is refused unless the failure looks transient', () => {
  const steps = plan();
  const failed = steps[2];
  assert.equal(retryReplaysFailure({ failedStep: failed, firstNext: steps[2] }), true);
  assert.equal(
    retryReplaysFailure({ failedStep: failed, firstNext: steps[2], failure: { error: 'Typing timed out after 15000ms' } }),
    false
  );
  assert.equal(
    retryReplaysFailure({
      failedStep: failed,
      firstNext: { ...steps[2], params: { ...steps[2].params, text: 'different' } },
    }),
    false
  );
  assert.equal(isTransientFailure({ error: 'Refusing to type: foreground window is another document' }), false);
  assert.equal(isTransientFailure({ error: 'The app is not responding' }), true);
});

test('an interrupted step is transient, a typing refusal is not', () => {
  assert.equal(isTransientFailure({ error: 'Interrupted by a console restart before this step completed.' }), true);
  assert.equal(isTransientFailure({ error: 'Refusing to type: foreground window is another document' }), false);
});

test('an unusable reply keeps what the model actually said', async () => {
  const result = await revisePlan({
    steps: plan(),
    failedIndex: 2,
    goal: 'type a note',
    ask: async () => 'I could not turn that into a plan.',
  });
  assert.match(result.error, /no usable plan/);
  assert.match(result.error, /could not turn that into a plan/);
});

test('a step the model wrote as one DSL string is still understood', () => {
  const revision = applyRevision(
    {
      decision: 'rearrange',
      note: 'from a small model',
      prep: [{ step: 'launchApp "Open Notepad" target="Notepad" name="Open Notepad"' }],
      steps: [
        { step: 'wait "Wait for Notepad" ms="1200"' },
        { step: 'type "Type the note" text="hello" foreground="Untitled - Notepad"' },
      ],
    },
    { steps: plan(), failedIndex: 2, goal: 'type a note' }
  );
  assert.deepEqual(revision.steps.slice(2).map((step) => step.type), ['launchApp', 'wait', 'type']);
  assert.equal(revision.steps[2].name, 'Open Notepad');
  assert.equal(revision.steps[2].params.target, 'Notepad');
  assert.equal(revision.steps[4].params.text, 'hello');
  assert.equal(revision.steps[4].params.foreground, 'Untitled - Notepad');
  assert.equal(revision.prepCount, 1);
});

test('the prompt shows the exact step object instead of a placeholder', () => {
  const { system } = buildRevisionPrompt({ goal: 'type a note', steps: plan(), failedIndex: 2, failure: { error: 'x' } });
  assert.match(system, /\{"type":"launchApp"/);
  assert.doesNotMatch(system, /\[\{step\}\]/);
});

test('a play step nothing in the goal or plan requires is dropped', () => {
  const revision = applyRevision(
    {
      decision: 'rearrange',
      steps: [
        { type: 'playMedia', name: 'Press play', params: { x: 10, y: 20, title: 'YouTube' } },
        { type: 'expect', name: 'Check', params: { kind: 'window', value: 'Notepad' } },
      ],
    },
    { steps: plan(), failedIndex: 2, goal: 'type a note in Notepad' }
  );
  assert.equal(revision.steps.some((step) => step.type === 'playMedia'), false);
  assert.equal(revision.droppedPlayback, 1);
});

test('playback survives only when the goal needs it and the operator allows it', () => {
  const reply = {
    decision: 'rearrange',
    steps: [
      { type: 'playMedia', name: 'Start playback', params: { x: 10, y: 20, title: 'YouTube' } },
      { type: 'expect', name: 'Check', params: { kind: 'window', value: 'YouTube' } },
    ],
  };
  const wanted = applyRevision(reply, { steps: plan(), failedIndex: 2, goal: 'open YouTube and play the video' });
  assert.ok(wanted.steps.some((step) => step.type === 'playMedia'));
  assert.equal(wanted.droppedPlayback, 0);

  const off = applyRevision(reply, {
    steps: plan(),
    failedIndex: 2,
    goal: 'open YouTube and play the video',
    allowMedia: false,
  });
  assert.equal(off.steps.some((step) => step.type === 'playMedia'), false);
  assert.equal(off.droppedPlayback, 1);
});

test('the prompt says playback needs a reason and can be turned off', () => {
  const on = buildRevisionPrompt({ goal: 'type a note', steps: plan(), failedIndex: 2, failure: { error: 'x' } }).prompt;
  assert.match(on, /press play/i);
  const off = buildRevisionPrompt({
    goal: 'type a note',
    steps: plan(),
    failedIndex: 2,
    failure: { error: 'x' },
    allowMedia: false,
  }).prompt;
  assert.match(off, /turned video and playback steps off/);
});

test('the desktop summary names the foreground and the other windows separately', () => {
  const summary = desktopSummary({
    foreground: { title: 'Untitled - Notepad', process: 'notepad' },
    windows: [
      { title: 'Untitled - Notepad', process: 'notepad' },
      { title: 'Sightline - Google Chrome', process: 'chrome' },
    ],
  });
  assert.match(summary, /^Foreground: Untitled - Notepad \(notepad\)/);
  assert.match(summary, /Other open windows: Sightline - Google Chrome \(chrome\)/);
});

const REFUSAL = {
  type: 'type',
  name: 'Type the note',
  error:
    'Refusing to type: foreground window is "Notepad :: *Sightline screen agent{ENTER}Automa - Notepad", expected process \r\nor window "Untitled - Notepad".',
};

test('a refused window guard is not inherited into the retry', () => {
  const revision = applyRevision(
    { decision: 'rearrange', note: 'type again', steps: [{ type: 'type', name: 'Type again', params: { text: 'hello' } }] },
    { steps: plan(), failedIndex: 2, failure: REFUSAL }
  );
  const typing = revision.steps.find((step) => step.name === 'Type again');
  assert.ok(typing);
  assert.equal(typing.params.foreground, undefined, 'the guard the desktop refused is not copied');
  assert.equal(revision.refusedGuard.expected, 'Untitled - Notepad');
  assert.equal(revision.refusedGuard.process, 'Notepad');
  assert.equal(revision.rewrittenGuards, 0);
});

test('a revision that repeats the refused guard gets the window process instead', () => {
  const revision = applyRevision(
    {
      decision: 'rearrange',
      steps: [
        { type: 'type', name: 'Type again', params: { text: 'hello', foreground: 'Untitled - Notepad' } },
        { type: 'key', name: 'Press enter', params: { keys: '{ENTER}', foreground: 'Notepad :: *Sightline screen agent{ENTER}Automa - Notepad' } },
      ],
    },
    { steps: plan(), failedIndex: 2, failure: REFUSAL }
  );
  const typing = revision.steps.find((step) => step.name === 'Type again');
  const keys = revision.steps.find((step) => step.name === 'Press enter');
  assert.equal(typing.params.foreground, 'Notepad', 'the stale title is replaced by the durable process');
  assert.equal(keys.params.foreground, 'Notepad');
  assert.equal(revision.rewrittenGuards, 2);
});

test('the prompt names the refused guard and the run evidence as facts only', () => {
  const { prompt } = buildRevisionPrompt({
    goal: 'type a note',
    steps: plan(),
    failedIndex: 2,
    failure: REFUSAL,
    evidence: ['screenshot: Notepad shows an empty page'],
  });
  assert.match(prompt, /Refused window guard/);
  assert.match(prompt, /do not reuse it/);
  assert.match(prompt, /Notepad shows an empty page/);
  assert.match(prompt, /evidence is context, not completion/i);
});
