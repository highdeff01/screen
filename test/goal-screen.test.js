import test from 'node:test';
import assert from 'node:assert/strict';

import { createScreenGoalChecker } from '../server/goal-screen.js';

const AT = '2026-11-27T12:00:00.000Z';

function agent(overrides = {}) {
  return { id: 'agent_screen_probe', name: 'Screen probe', enabled: true, goal: 'Save the profile', ...overrides };
}

test('a changed screen is answered before the label read, then recorded', async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let scheduled = null;
  const reads = [];
  let persisted = 0;
  const checker = createScreenGoalChecker({
    readScreen: async () => {
      reads.push('read');
      await gate;
      return { title: 'Sightline Profile', labels: ['Save', 'Cancel'] };
    },
    persist: () => {
      persisted += 1;
    },
    now: () => AT,
    schedule: (fn) => {
      scheduled = fn;
    },
  });
  const target = agent();

  assert.equal(checker.trigger({ changedPct: 9 }, [target]), true);
  assert.equal(reads.length, 0, 'the caller is not made to wait for the label read');
  assert.equal(target.goalCheck, undefined, 'nothing is recorded on the caller’s stack');
  assert.equal(checker.busy, true);

  const run = scheduled();
  release();
  await run;

  assert.equal(reads.length, 1);
  assert.equal(persisted, 1);
  assert.equal(target.goalCheck.trigger, 'screen');
  assert.equal(target.goalCheck.screen.title, 'Sightline Profile');
  assert.equal(target.goalCheck.status, 'unknown', 'a screen read never claims the goal is done');
  assert.equal(target.screenCheckedAt, AT, 'the throttle clock starts when the read ran');
  assert.equal(checker.busy, false);
});

test('one read at a time: a change that arrives mid-read is skipped, not queued', async () => {
  let scheduled = 0;
  let release = () => {};
  let pending = null;
  const checker = createScreenGoalChecker({
    readScreen: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { title: 'Sightline Profile', labels: ['Save'] };
    },
    now: () => AT,
    schedule: (fn) => {
      scheduled += 1;
      pending = fn;
    },
  });
  const target = agent();
  assert.equal(checker.trigger({ changedPct: 9 }, [target]), true);
  assert.equal(checker.trigger({ changedPct: 20 }, [target]), false, 'the read in flight already covers this change');
  assert.equal(scheduled, 1);

  const run = pending();
  release();
  await run;
  assert.equal(checker.busy, false);
});

test('agents that opted out, and changes too small to matter, start nothing', () => {
  let scheduled = 0;
  const checker = createScreenGoalChecker({
    readScreen: async () => ({ title: '', labels: [] }),
    now: () => AT,
    schedule: () => {
      scheduled += 1;
    },
  });
  assert.equal(checker.trigger({ changedPct: 9 }, [agent({ goal: '' })]), false, 'screen watching needs a declared goal');
  assert.equal(checker.trigger({ changedPct: 9 }, [agent({ enabled: false })]), false);
  assert.equal(checker.trigger({ changedPct: 0.4 }, [agent()]), false);
  assert.equal(checker.trigger({ changedPct: 9, reused: true }, [agent()]), false);
  assert.equal(checker.trigger({ changedPct: 9, error: 'no read' }, [agent()]), false);
  assert.equal(checker.trigger({ changedPct: 9 }, []), false);
  assert.equal(scheduled, 0);
});

test('a failed label read is swallowed: the sample and the agent stay as they were', async () => {
  let pending = null;
  const checker = createScreenGoalChecker({
    readScreen: async () => {
      throw new Error('the OCR read failed');
    },
    persist: () => {
      throw new Error('persist must not run when there is nothing to save');
    },
    now: () => AT,
    schedule: (fn) => {
      pending = fn;
    },
  });
  const target = agent();
  assert.equal(checker.trigger({ changedPct: 9 }, [target]), true);
  await pending();
  assert.equal(target.goalCheck, undefined);
  assert.equal(target.screenCheckedAt, undefined);
  assert.equal(checker.busy, false, 'the next change can still be checked');
});
