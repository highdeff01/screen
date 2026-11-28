/**
 * Live control: the loop that keeps watching after its own action.
 *
 * The engine is a small fake whose frames change on cue, the model is a stub
 * that answers on a script, and the action is a counter — so what is asserted is
 * the loop's behaviour: retry a throw, replan a screen that did not move, stop
 * when the goal is reached, and never click a control the screen does not show.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVisionController,
  createLiveActor,
  cleanAction,
  describeAction,
  controlPrompt,
  readerLine,
  screenPoint,
  stepForAction,
} from '../server/vision-control.js';

function fakeEngine({ changes = [], elements = [] } = {}) {
  const queue = [...changes];
  let seq = 0;
  let current = null;
  const engine = {
    reached: null,
    state: () => ({ goal: { text: 'the goal', reachedAt: engine.reached }, elements, current }),
    digest: () => 'Frame #1 now · 10% changed',
    async step() {
      const change = queue.length ? queue.shift() : 0;
      if (!change) return { skipped: true, quiet: true, changedPct: 0 };
      seq += 1;
      current = { seq, file: `vision/frame-${String(seq).padStart(6, '0')}.png`, changedPct: change, dirtySections: [], labels: [], elements };
      return current;
    },
    markGoalReached(reason) {
      engine.reached = reason;
      return { reason };
    },
    setGoal() {},
    onFrame: () => () => {},
  };
  return engine;
}

async function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for live control');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function scripted(answers) {
  const prompts = [];
  const ask = async (messages) => {
    prompts.push(messages);
    const answer = answers.shift() ?? { done: true, why: 'the script ended' };
    return { ok: true, content: JSON.stringify(answer), ms: 5 };
  };
  return { ask, prompts };
}

function controller({ engine, answers, act, ...options }) {
  const script = scripted(answers);
  const controller = createVisionController({
    engine,
    ask: script.ask,
    act,
    wait: async () => {},
    schedule: () => ({ unref() {} }),
    cancel: () => {},
    settleMs: 0,
    retryDelayMs: 0,
    maxSteps: 1,
    ...options,
  });
  return { controller, prompts: script.prompts };
}

test('an action that throws is retried before the plan is touched', async () => {
  const engine = fakeEngine({ changes: [100, 20] });
  let calls = 0;
  const act = async () => {
    calls += 1;
    if (calls === 1) throw new Error('the click landed nowhere');
    return { output: 'clicked' };
  };
  const { controller: loop, prompts } = controller({ engine, answers: [{ action: { type: 'click', x: 0.5, y: 0.5 } }], act });
  loop.start({ goal: 'open the export dialog' });
  await waitFor(() => loop.state().running === false);

  const state = loop.state();
  assert.equal(calls, 2, 'the same action was attempted twice');
  assert.equal(state.retries, 1, 'the retry is recorded');
  assert.equal(state.replans, 0, 'a retry is not a replan');
  assert.equal(state.history[0].changed, true, 'the frame after the action is what is recorded');
  assert.match(state.stopReason, /step limit/);
  assert.doesNotMatch(String(prompts[0][1].content), /Last attempt failed/);
});

test('a screen that did not change sends the failure back and the next action differs', async () => {
  const engine = fakeEngine({ changes: [100, 0, 40] });
  const actions = [];
  const act = async (action) => {
    actions.push(action);
    return { output: 'done' };
  };
  const { controller: loop, prompts } = controller({
    engine,
    answers: [
      { action: { type: 'click', x: 0.1, y: 0.1 } },
      { action: { type: 'click', x: 0.9, y: 0.9 } },
    ],
    act,
  });
  loop.start({ goal: 'submit the form' });
  await waitFor(() => loop.state().running === false);

  const state = loop.state();
  assert.equal(actions.length, 2, 'the unchanged click was not repeated');
  assert.equal(state.replans, 1);
  assert.match(String(prompts[1][1].content), /did not change after click at 0\.10,0\.10/);
  assert.match(String(prompts[1][1].content), /Do not repeat it/);
  assert.equal(state.history[0].changed, true, 'the second action did change the screen');
});

test('done ends the loop and marks the goal on the stream', async () => {
  const engine = fakeEngine({ changes: [100] });
  let acted = 0;
  const { controller: loop } = controller({
    engine,
    answers: [{ done: true, why: 'the export dialog is closed' }],
    act: async () => {
      acted += 1;
    },
  });
  loop.start({ goal: 'close the export dialog' });
  await waitFor(() => loop.state().running === false);

  assert.equal(acted, 0, 'a done answer performs no action');
  assert.match(engine.reached, /the export dialog is closed/);
  assert.equal(loop.state().running, false);
  assert.match(loop.state().stopReason, /goal reached/);
});

test('a target the screen does not show is never clicked', async () => {
  const engine = fakeEngine({ changes: [100], elements: [] });
  let acted = 0;
  const { controller: loop, prompts } = controller({
    engine,
    answers: [
      { action: { type: 'click', target: 'Save' } },
      { action: { type: 'click', target: 'Save' } },
      { done: true, why: 'there is nothing to save' },
    ],
    act: async () => {
      acted += 1;
    },
  });
  loop.start({ goal: 'save the report' });
  await waitFor(() => loop.state().running === false);

  assert.equal(acted, 0, 'an unlabelled target is never guessed into a click');
  assert.equal(loop.state().replans, 2);
  assert.match(String(prompts[1][1].content), /does not show anything called “Save”/);
});

test('an answer with no usable action is replanned and then stopped, not looped forever', async () => {
  const engine = fakeEngine({ changes: [100] });
  const { controller: loop } = controller({
    engine,
    answers: Array.from({ length: 10 }, () => ({ action: { type: 'jump' } })),
    act: async () => {
      throw new Error('should not act');
    },
  });
  loop.start({ goal: 'do something' });
  await waitFor(() => loop.state().running === false);
  const state = loop.state();
  assert.equal(state.replans, 4, 'maxReplans + 1 decisions, then a stop');
  assert.match(state.stopReason, /no progress/);
});

test('the after-action check waits for a frame captured after the action, not the stream\'s held one', async () => {
  // The stream never stops capturing, so right after a click its newest frame is
  // the one taken before it, and a busy read hands exactly that frame back.
  // Judging that frame calls a click that worked a miss and re-plans it.
  let seq = 0;
  let current = null;
  let acted = false;
  let busyReads = 0;
  const engine = {
    reached: null,
    state: () => ({ goal: { text: 'the goal', reachedAt: engine.reached }, elements: [], current }),
    digest: () => '',
    async step() {
      if (!acted) {
        seq += 1;
        current = { seq, at: 'before', changedPct: 100, dirtySections: [], labels: [], elements: [] };
        return current;
      }
      // A capture that was already in flight when the click landed.
      if (busyReads < 2) {
        busyReads += 1;
        return { skipped: true, busy: true, at: 'before' };
      }
      seq += 1;
      current = { seq, at: 'after', changedPct: 12, dirtySections: [], labels: [], elements: [] };
      return current;
    },
    markGoalReached(reason) {
      engine.reached = reason;
      return { reason };
    },
    setGoal() {},
    onFrame: () => () => {},
  };
  let clicks = 0;
  const { controller: loop, prompts } = controller({
    engine,
    answers: [
      { action: { type: 'click', x: 0.5, y: 0.5 } },
      { action: { type: 'click', x: 0.5, y: 0.5 } },
    ],
    act: async () => {
      clicks += 1;
      acted = true;
      return { output: 'clicked' };
    },
  });
  loop.start({ goal: 'open the export dialog' });
  await waitFor(() => loop.state().running === false);

  const state = loop.state();
  assert.equal(clicks, 1, 'the click that worked was not repeated');
  assert.equal(state.replans, 0, 'a frame from before the action is not a failed action');
  assert.equal(state.history[0].changed, true, 'the fresh frame after the action judged it');
  assert.equal(prompts.length, 1, 'the model was asked once — the click was never re-planned');
  assert.doesNotMatch(String(prompts[0][1].content), /did not change/);
});

test('a check that never gets a fresh frame is unknown, not a miss', async () => {
  let seq = 0;
  let current = null;
  let acted = false;
  const engine = {
    reached: null,
    state: () => ({ goal: { text: 'the goal', reachedAt: engine.reached }, elements: [], current }),
    digest: () => '',
    async step() {
      if (!acted) {
        seq += 1;
        current = { seq, at: 'before', changedPct: 100, dirtySections: [], labels: [], elements: [] };
        return current;
      }
      // The stream is mid-capture for the whole window the check is allowed.
      return { skipped: true, busy: true, at: 'before' };
    },
    markGoalReached(reason) {
      engine.reached = reason;
      return { reason };
    },
    setGoal() {},
    onFrame: () => () => {},
  };
  let clicks = 0;
  const { controller: loop, prompts } = controller({
    engine,
    answers: [{ action: { type: 'click', x: 0.5, y: 0.5 } }, { done: true, why: 'it opened' }],
    act: async () => {
      clicks += 1;
      acted = true;
      return { output: 'clicked' };
    },
    verifyTimeoutMs: 40,
    verifyPollMs: 1,
    // A second turn, so the next decision can be checked for how it was told.
    maxSteps: 2,
  });
  loop.start({ goal: 'open the export dialog' });
  await waitFor(() => loop.state().running === false);

  const state = loop.state();
  assert.equal(clicks, 1, 'the action was not repeated over a missing frame');
  assert.equal(state.history[0].changed, null, 'an impossible check is recorded as no check');
  assert.equal(state.replans, 0, 'a missing frame is never a replan');
  assert.match(String(prompts[1][1].content), /no check/, 'the next decision is told there was no check');
});

test("the decision prompt carries the reviewer's reading of the screen", async () => {
  // The engine records pixels and never a reading, so the summary has to come
  // from the session's reviewer; reading it off the engine loses it silently.
  const engine = fakeEngine({ changes: [100] });
  const { controller: loop, prompts } = controller({
    engine,
    answers: [{ done: true, why: 'the dialog is gone' }],
    act: async () => ({ output: '' }),
    readReview: () => ({ seq: 1, summary: 'an export dialog is open with a Save button', next: 'click Save' }),
  });
  loop.start({ goal: 'close the export dialog' });
  await waitFor(() => loop.state().running === false);

  assert.equal(prompts.length, 1);
  assert.match(String(prompts[0][1].content), /Reader on frame #1 \(the frame being decided\): an export dialog is open with a Save button/);
  assert.match(String(prompts[0][1].content), /Next it suggested: click Save/);
});

test("a reading of an older frame is shown with the frame it describes and how far behind it is", async () => {
  // The reviewer only reads changed frames and skips a gap, so by the time the
  // action after next is decided its summary is about an earlier screen. Saying
  // "Reader:" as if it were this frame is how a closed dialog stays "open".
  const engine = fakeEngine({ changes: [100, 20] });
  const { controller: loop, prompts } = controller({
    engine,
    answers: [{ action: { type: 'click', x: 0.5, y: 0.5 } }, { done: true, why: 'the dialog is gone' }],
    act: async () => ({ output: 'clicked' }),
    readReview: () => ({ seq: 1, summary: 'an export dialog is open', next: 'click Save' }),
    maxSteps: 2,
  });
  loop.start({ goal: 'close the export dialog' });
  await waitFor(() => loop.state().running === false);

  assert.equal(prompts.length, 2);
  const second = String(prompts[1][1].content);
  assert.match(second, /^Frame #2/m);
  assert.match(second, /Reader on frame #1 \(1 frame behind #2\): an export dialog is open/);
  assert.match(second, /Next it suggested: click Save/);
});

test('a reading too old for the frame being decided is dropped from the prompt', async () => {
  // A reading seven frames behind is not about this screen; quoting it would
  // tell the model something that may have already changed.
  const engine = {
    reached: null,
    state: () => ({
      goal: { text: 'the goal', reachedAt: engine.reached },
      elements: [],
      current: { seq: 9, changedPct: 10, dirtySections: [], labels: [], elements: [] },
    }),
    digest: () => '',
    async step() {
      return { skipped: true, quiet: true, changedPct: 0 };
    },
    markGoalReached(reason) {
      engine.reached = reason;
      return { reason };
    },
    setGoal() {},
    onFrame: () => () => {},
  };
  const { controller: loop, prompts } = controller({
    engine,
    answers: [{ done: true, why: 'nothing left to do' }],
    act: async () => ({ output: '' }),
    readReview: () => ({ seq: 2, summary: 'an export dialog is open', next: 'click Save' }),
  });
  loop.start({ goal: 'close the export dialog' });
  await waitFor(() => loop.state().running === false);

  assert.equal(prompts.length, 1);
  const prompt = String(prompts[0][1].content);
  assert.match(prompt, /^Frame #9/m);
  assert.doesNotMatch(prompt, /Reader/);
  assert.doesNotMatch(prompt, /an export dialog is open/);
});

test('a reading with no frame number cannot be placed in time, so it is not quoted as current', () => {
  const frame = { seq: 12 };
  assert.equal(readerLine({ review: { summary: 'a dialog is open' }, frame }), null, 'no frame number, no reading');
  assert.equal(readerLine({ review: { seq: 12, summary: 'a dialog is open' }, frame }), 'Reader on frame #12 (the frame being decided): a dialog is open');
  assert.equal(readerLine({ review: { seq: 12, summary: 'a dialog is open', next: 'close it' }, frame }), 'Reader on frame #12 (the frame being decided): a dialog is open Next it suggested: close it');
  assert.match(readerLine({ review: { seq: 11, summary: 'a dialog is open' }, frame }), /\(1 frame behind #12\)/);
  assert.match(readerLine({ review: { seq: 9, summary: 'a dialog is open' }, frame }), /\(3 frames behind #12\)/);
  assert.equal(readerLine({ review: { seq: 8, summary: 'a dialog is open' }, frame }), null, 'four frames behind is too old');
  assert.match(readerLine({ review: { seq: 3, summary: 'a dialog is open' }, frame: {} }), /the current frame is unknown/, 'a reading is never shown as current when the frame has no number');
});

test('a reviewer that cannot be asked leaves the decision without a reading, not without an action', async () => {
  const engine = fakeEngine({ changes: [100], elements: [{ label: 'Save', x: 0.7, y: 0.1, w: 0.1, h: 0.04, seen: 2 }] });
  const actions = [];
  const { controller: loop, prompts } = controller({
    engine,
    answers: [{ action: { type: 'click', target: 'Save' } }, { done: true, why: 'saved' }],
    act: async (action) => {
      actions.push(action);
      return { output: 'clicked' };
    },
    readReview: () => {
      throw new Error('the reviewer has no session');
    },
  });
  loop.start({ goal: 'save the report' });
  await waitFor(() => loop.state().running === false);

  assert.equal(actions.length, 1, 'a broken reviewer does not stop the loop acting');
  assert.doesNotMatch(String(prompts[0][1].content), /Reader:/);
});

test('the actor maps a normalized point onto the desktop, origin included', async () => {
  let step = null;
  const actor = createLiveActor({
    screen: async () => ({ x: -100, y: 40, width: 1000, height: 800 }),
    execute: async (value) => {
      step = value;
      return { output: 'clicked' };
    },
    wait: async () => {},
  });
  await actor({ type: 'click', x: 0.5, y: 0.5 });
  assert.deepEqual(step.params, { x: 400, y: 440 });
  assert.equal(step.type, 'click');

  await actor({ type: 'type', text: 'hello' });
  assert.equal(step.type, 'type');
  assert.equal(step.params.text, 'hello');

  const blind = createLiveActor({ screen: async () => null, execute: async () => ({ output: '' }) });
  await assert.rejects(() => blind({ type: 'click', x: 0.2, y: 0.2 }), /screen size could not be read/);
});

test('actions are validated, clamped and described, and a point needs bounds', () => {
  assert.equal(cleanAction({ type: 'jump' }), null);
  assert.equal(cleanAction({ type: 'type' }), null, 'typing needs text');
  assert.deepEqual(cleanAction({ type: 'click', x: 4, y: -2, target: ' Save ' }), {
    type: 'click',
    why: '',
    target: 'Save',
    x: 1,
    y: 0,
  });
  assert.deepEqual(cleanAction({ type: 'done', why: 'finished' }), { type: 'done', why: 'finished' });
  assert.equal(cleanAction({ type: 'scroll' }).amount, -3);
  assert.equal(describeAction({ type: 'click', x: 0.25, y: 0.5 }), 'click at 0.25,0.50');
  assert.equal(describeAction({ type: 'click', target: 'Save' }), 'click at “Save”');
  assert.deepEqual(screenPoint({ x: 0.5, y: 0.5 }, { x: 0, y: 0, width: 1000, height: 500 }), { x: 500, y: 250 });
  assert.equal(screenPoint({ x: 0.5, y: 0.5 }, { width: 0, height: 0 }), null);
  assert.equal(stepForAction({ type: 'click', x: 0.1, y: 0.1 }, null), null, 'a point action needs a point');
});

test('the decision prompt carries the goal, the labels and the last failure', () => {
  const [system, user] = controlPrompt({
    goal: 'export the report',
    frame: { seq: 4, changedPct: 12, dirtySections: [{ index: 1 }] },
    digest: 'frame #4',
    elements: [{ label: 'Save', x: 0.7, y: 0.1, w: 0.1, h: 0.04, seen: 3 }],
    history: [{ action: 'click at 0.10,0.10', changed: false }],
    failure: 'the screen did not change after click at 0.10,0.10',
    review: { seq: 4, summary: 'a save dialog is open', next: 'click Save' },
  });
  assert.match(system.content, /"action"/);
  assert.match(system.content, /one action/i);
  assert.match(user.content, /Goal: export the report/);
  assert.match(user.content, /Frame #4, 12% changed, 1 section\(s\) moved/);
  assert.match(user.content, /“Save” \(0\.75,0\.12\) seen 3×/);
  assert.match(user.content, /click at 0\.10,0\.10 — the screen did not change/);
  assert.match(user.content, /Last attempt failed: the screen did not change/);
  assert.match(user.content, /Reader on frame #4 \(the frame being decided\): a save dialog is open/);
  assert.match(system.content, /may be older than the one above/);
});
