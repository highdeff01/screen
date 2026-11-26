import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-aim-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const aim = await load('server/aim.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  aim.resetAimState();
});

const liveRun = (extra = {}) => ({ id: `run_${Math.random().toString(36).slice(2)}`, dryRun: false, shadow: false, ...extra });

const presenceAt = (idleMs, title) => ({ idleMs, foreground: title ? { title, process: '' } : null });

test('a step with a coordinate is aimed at that coordinate', () => {
  const target = aim.aimTargetFor({ type: 'click', params: { x: 420, y: 310 } });
  assert.equal(target.kind, 'point');
  assert.deepEqual([target.x, target.y], [420, 310]);
});

test('a step that names a control is aimed at the control, not the app window', () => {
  const target = aim.aimTargetFor({
    type: 'clickElement',
    params: { window: 'Sightline Accounts', name: 'Email', controlType: 'Edit' },
  });
  assert.equal(target.kind, 'element');
  assert.equal(target.name, 'Email');
  assert.equal(target.window, 'Sightline Accounts');
  assert.equal(target.label, 'Email');
});

test('a step with no target is not aimed at anything', () => {
  assert.equal(aim.aimTargetFor({ type: 'wait', params: { ms: 500 } }), null);
  assert.equal(aim.aimTargetFor({ type: 'verifyScreen', params: { title: 'x' } }), null);
});

test('the pointer waits while the operator is still using the mouse or keyboard', () => {
  const target = aim.aimTargetFor({ type: 'click', params: { x: 10, y: 10 } });
  const decision = aim.shouldAim({ run: liveRun(), presence: presenceAt(200, 'Anything'), target });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /mouse or keyboard/);
});

test('the run’s own clicks are not mistaken for the operator working', () => {
  const target = aim.aimTargetFor({ type: 'click', params: { x: 10, y: 10 } });
  const at = Date.now();
  const decision = aim.shouldAim({
    run: { dryRun: false, shadow: false, lastActionAt: at - 400 },
    presence: { idleMs: 200, foreground: null },
    target,
    at,
  });
  assert.equal(decision.ok, true, 'a click this run just sent is its own input, not the operator’s');
});

test('the pointer does not move into a window this run does not own', () => {
  const target = aim.aimTargetFor({ type: 'clickElement', params: { window: 'Sightline Accounts', name: 'Email' } });
  const decision = aim.shouldAim({
    run: liveRun(),
    presence: presenceAt(9000, 'Some other app'),
    target,
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /not the window in front/);
});

test('a quiet desktop with the run window in front lets the aim go ahead and records it', async () => {
  const run = liveRun();
  const messages = [];
  const moves = [];
  const result = await aim.aimAt(run, aim.aimTargetFor({ type: 'clickElement', params: { window: 'Sightline Accounts', name: 'Email' } }), {
    log: (message) => messages.push(message),
    presence: async () => presenceAt(4000, 'Sightline Accounts — Sign up'),
    find: async () => ({ found: true, x: 512, y: 480 }),
    move: async (_run, point) => moves.push(point),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(moves, [{ x: 512, y: 480 }]);
  assert.equal(run.aims.length, 1);
  assert.equal(run.aims[0].target, 'Email');
  assert.match(messages[0], /Aimed the pointer at “Email”/);
});

test('aiming twice at the same control does not move the pointer twice', async () => {
  const run = liveRun();
  const moves = [];
  const options = {
    presence: async () => presenceAt(4000, 'Sightline Accounts — Sign up'),
    find: async () => ({ found: true, x: 10, y: 20 }),
    move: async (_run, point) => moves.push(point),
  };
  const target = aim.aimTargetFor({ type: 'clickElement', params: { window: 'Sightline Accounts', name: 'Email' } });
  await aim.aimAt(run, target, options);
  const second = await aim.aimAt(run, target, options);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already on that control/);
  assert.equal(moves.length, 1);
});

test('a simulated run or an opted-out run never moves the pointer', async () => {
  const moves = [];
  const options = {
    presence: async () => presenceAt(4000, 'Sightline Accounts'),
    find: async () => ({ found: true, x: 1, y: 2 }),
    move: async (_run, point) => moves.push(point),
  };
  const target = aim.aimTargetFor({ type: 'click', params: { x: 5, y: 6 } });
  assert.equal((await aim.aimAt(liveRun({ dryRun: true }), target, options)).ok, false);
  assert.equal((await aim.aimAt(liveRun({ pointerAim: false }), target, options)).ok, false);
  assert.equal(moves.length, 0);
});

test('a prepared thinking choice is aimed at only when it names a control', () => {
  assert.equal(aim.aimTargetForChoice({ type: 'key', params: { keys: 'enter' } }), null);
  const target = aim.aimTargetForChoice({
    type: 'clickElement',
    params: { window: 'Accounts', name: 'Submit' },
  });
  assert.equal(target.name, 'Submit');
  assert.equal(target.window, 'Accounts');
});

test('a control with no UI Automation tree is aimed at the point it was clicked at last time', async () => {
  const run = liveRun();
  const moves = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's1', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Dan' } },
    {
      workflow: { clickPoints: { s1: { x: 300, y: 240, name: 'Dan' } } },
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      move: async (_run, point) => moves.push(point),
    }
  );
  assert.equal(result.ok, true, 'the remembered point is a real aim target');
  assert.deepEqual(moves, [{ x: 300, y: 240 }]);
  assert.equal(run.aims[0].target, 'Dan');
});

test('a control that was never clicked and is not in the tree is reported, not guessed', async () => {
  const run = liveRun();
  const messages = [];
  const moves = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's2', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Settings' } },
    {
      workflow: { clickPoints: {} },
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      move: async (_run, point) => moves.push(point),
      log: (message) => messages.push(message),
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be located/);
  assert.equal(moves.length, 0, 'no guess is made at a control nobody has located');
  assert.match(messages[0], /Aiming paused/);
});
