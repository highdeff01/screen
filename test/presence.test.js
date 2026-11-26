import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPresence,
  holdDecision,
  learnHold,
  completionFor,
  isFocusStealing,
  isQuickStep,
  silentChecksFor,
  continuationMode,
  isOwnInput,
} from '../server/presence.js';

test('the run’s own keystrokes are not the operator, so they never hold a step', () => {
  const at = Date.now();
  // The action ended 200 ms ago and the idle timer says input 100 ms ago: ours.
  assert.equal(isOwnInput({ idleMs: 100, lastActionEndAt: at - 200, at }), true);
  // The action ended long ago and input just happened: someone else typed.
  assert.equal(isOwnInput({ idleMs: 100, lastActionEndAt: at - 9000, at }), false);
  // Nothing this run did is known: never assume input is ours.
  assert.equal(isOwnInput({ idleMs: 100, lastActionEndAt: 0, at }), false);
});

test('steps that move the pointer, type or change windows take focus', () => {
  for (const type of ['type', 'key', 'clickElement', 'launchApp', 'focusWindow', 'installApp', 'playMedia']) {
    assert.equal(isFocusStealing({ type }), true, type);
  }
  for (const type of ['screenshot', 'expect', 'waitFor', 'verifyScreen', 'writeNote', 'wait']) {
    assert.equal(isFocusStealing({ type }), false, type);
  }
});

test('a playback check that names its player takes focus, like the player itself', () => {
  assert.equal(isFocusStealing({ type: 'verifyPlayback', params: { title: 'VLC media player' } }), true);
  assert.equal(isFocusStealing({ type: 'verifyPlayback', params: {} }), false);
  const decision = holdDecision({
    step: { type: 'verifyPlayback', params: { title: 'VLC media player' } },
    presence: classifyPresence({ idleMs: 400, foreground: { title: 'Code - main.js', process: 'Code' }, holdMs: 10000 }),
    target: 'VLC media player',
    holdMs: 10000,
    silentAvailable: false,
  });
  assert.equal(decision.action, 'wait', 'the check waits for the user to stop working');
});

test('presence is typing, then moving, then idle as the desktop goes quiet', () => {
  assert.equal(classifyPresence({ idleMs: 300 }).state, 'typing');
  assert.equal(classifyPresence({ idleMs: 4000 }).state, 'moving');
  assert.equal(classifyPresence({ idleMs: 15000 }).state, 'idle');
  assert.match(classifyPresence({ idleMs: 4000 }).note, /settling/);
});

test('a foreground window that matches the target counts as watching', () => {
  const seen = classifyPresence({
    idleMs: 500,
    foreground: { title: 'Save As - Notepad', process: 'notepad' },
    target: 'notepad',
    holdMs: 10000,
  });
  assert.equal(seen.watching, true);
  const elsewhere = classifyPresence({
    idleMs: 500,
    foreground: { title: 'Freebuff', process: 'Freebuff' },
    target: 'Save As',
  });
  assert.equal(elsewhere.watching, false);
});

test('a focus-stealing step waits for the rest of the hold when the user is moving', () => {
  const decision = holdDecision({
    step: { type: 'type' },
    presence: classifyPresence({ idleMs: 3000 }),
    holdMs: 10000,
    maxDeferMs: 60000,
  });
  assert.equal(decision.action, 'wait');
  assert.ok(decision.waitMs >= 7000 && decision.waitMs <= 8200, String(decision.waitMs));
  assert.match(decision.reason, /holding 7s/);
});

test('one quick action is recognised and a long edit is not', () => {
  for (const type of ['click', 'clickElement', 'key', 'scroll', 'focusWindow', 'clipboard']) {
    assert.equal(isQuickStep({ type }), true, type);
  }
  assert.equal(isQuickStep({ type: 'type', params: { text: 'Hello' } }), true);
  assert.equal(isQuickStep({ type: 'type', params: { text: 'x'.repeat(400) } }), false);
  assert.equal(isQuickStep({ type: 'type' }), false);
  for (const type of ['launchApp', 'openUrl', 'playMedia', 'installApp', 'recordVideo']) {
    assert.equal(isQuickStep({ type }), false, type);
  }
});

test('a quick action continues while the user is only nudging the pointer', () => {
  const decision = holdDecision({
    step: { type: 'clickElement' },
    presence: classifyPresence({ idleMs: 4000 }),
    holdMs: 10000,
    quick: true,
  });
  assert.equal(decision.action, 'proceed');
  assert.equal(decision.fastPath, true);
  assert.match(decision.reason, /quick action/);
});

test('a quick action still waits while the user is typing', () => {
  const decision = holdDecision({
    step: { type: 'clickElement' },
    presence: classifyPresence({ idleMs: 300 }),
    holdMs: 10000,
    quick: true,
  });
  assert.equal(decision.action, 'wait');
  assert.equal(decision.fastPath, false);
});

test('a step continues when the user is working in the window this run opened', () => {
  const steering = holdDecision({
    step: { type: 'type', params: { text: 'a long body' } },
    presence: classifyPresence({ idleMs: 4000 }),
    holdMs: 10000,
    steering: true,
  });
  assert.equal(steering.action, 'proceed');
  assert.equal(steering.fastPath, true);
  assert.match(steering.reason, /window this run opened/);

  const typing = holdDecision({
    step: { type: 'type', params: { text: 'a long body' } },
    presence: classifyPresence({ idleMs: 300 }),
    holdMs: 10000,
    steering: true,
  });
  assert.equal(typing.action, 'wait', 'their own edit is not interrupted');
});

test('nothing is held when the target is already in front or the user is away', () => {
  const watching = holdDecision({
    step: { type: 'clickElement' },
    presence: classifyPresence({ idleMs: 200, foreground: { title: 'VLC media player', process: 'vlc' }, target: 'VLC' }),
    holdMs: 10000,
  });
  assert.equal(watching.action, 'proceed');
  assert.match(watching.reason, /already targets/);

  const away = holdDecision({
    step: { type: 'clickElement' },
    presence: classifyPresence({ idleMs: 30000 }),
    holdMs: 10000,
  });
  assert.equal(away.action, 'proceed');
});

test('read-only steps never wait for the user', () => {
  const decision = holdDecision({
    step: { type: 'expect' },
    presence: classifyPresence({ idleMs: 100 }),
    holdMs: 10000,
  });
  assert.equal(decision.action, 'proceed');
});

test('after the maximum deferral the run continues, silently when it has read-only work', () => {
  const presence = classifyPresence({ idleMs: 200 });
  const giveUp = holdDecision({
    step: { type: 'clickElement' },
    presence,
    holdMs: 10000,
    maxDeferMs: 10000,
    deferredMs: 10000,
  });
  assert.equal(giveUp.action, 'proceed');
  assert.match(giveUp.reason, /maximum hold/);

  const silent = holdDecision({
    step: { type: 'clickElement' },
    presence,
    holdMs: 10000,
    maxDeferMs: 5000,
    deferredMs: 6000,
    silentAvailable: true,
  });
  assert.equal(silent.action, 'silent');
  assert.match(silent.reason, /read-only/);
});

test('deferrals teach the workstation hold time, clamped to 4-20s', () => {
  assert.deepEqual(learnHold(null, []), { samples: [], holdMs: 10000, count: 0, medianMs: 0 });
  // A couple of waits is not a habit yet: the default holds until three agree.
  const first = learnHold(null, [{ waitedMs: 1000 }]);
  assert.equal(first.holdMs, 10000);
  assert.equal(first.count, 1);
  const short = learnHold(null, [{ waitedMs: 1000 }, { waitedMs: 1500 }, { waitedMs: 2000 }]);
  assert.equal(short.holdMs, 4000);
  const long = learnHold(null, [{ waitedMs: 30000 }, { waitedMs: 40000 }, { waitedMs: 50000 }]);
  assert.equal(long.holdMs, 20000);
  const mid = learnHold(null, [{ waitedMs: 4000 }, { waitedMs: 6000 }, { waitedMs: 12000 }]);
  assert.equal(mid.medianMs, 6000);
  assert.equal(mid.holdMs, 8000);
  assert.equal(mid.samples.length, 3);
});

test('a playing video counts as success but not as finished', () => {
  const completion = completionFor({ type: 'playMedia' }, { output: 'Playing.' });
  assert.equal(completion.status, 'awaiting');
  assert.deepEqual(completion.pending, ['verifyPlayback']);
  assert.match(completion.reason, /playback/);

  const held = completionFor({ type: 'mediaHold' }, {});
  assert.deepEqual(held.pending, ['playbackEnd']);
});

test('an install that was verified is finished; an unverified one still owes a launch', () => {
  assert.equal(completionFor({ type: 'installApp' }, { verified: true }).status, 'verified');
  const unverified = completionFor({ type: 'installApp' }, { verified: false });
  assert.equal(unverified.status, 'awaiting');
  assert.deepEqual(unverified.pending, ['launchApp']);
  assert.match(unverified.reason, /still has to launch/);
});

test('a launch or a download keeps a read-only follow-up, and typed input does not', () => {
  assert.deepEqual(completionFor({ type: 'launchApp' }, {}).pending, ['window']);
  assert.deepEqual(completionFor({ type: 'downloadMedia' }, {}).pending, ['file']);
  assert.equal(completionFor({ type: 'type' }, {}).status, 'verified');
  assert.equal(completionFor({ type: 'type' }, { skipped: true }).status, 'skipped');
});

test('silent checks exist for the steps that can be verified without focus', () => {
  assert.deepEqual(silentChecksFor({ type: 'launchApp' }), ['window']);
  assert.deepEqual(silentChecksFor({ type: 'installApp' }), ['registry', 'exe']);
  assert.deepEqual(silentChecksFor({ type: 'clipboard' }), ['clipboard']);
  assert.deepEqual(silentChecksFor({ type: 'type' }), []);
});

test('the continuation mode keeps a watched window alone and goes silent or minimized otherwise', () => {
  assert.equal(
    continuationMode({ presence: classifyPresence({ idleMs: 30000 }) }).mode,
    'normal'
  );
  assert.equal(
    continuationMode({
      presence: classifyPresence({ idleMs: 100 }),
      step: { type: 'launchApp' },
    }).mode,
    'silent'
  );
  assert.equal(
    continuationMode({
      presence: classifyPresence({ idleMs: 100 }),
      step: { type: 'type' },
    }).mode,
    'minimize'
  );
  assert.equal(
    continuationMode({
      presence: classifyPresence({ idleMs: 100 }),
      step: { type: 'type' },
      allowMinimize: false,
    }).mode,
    'preview'
  );
});
