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
    cursor: async () => null,
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
    cursor: async () => null,
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
      workflow: { clickPoints: { s1: { x: 300, y: 240, name: 'Dan', window: { left: 40, top: 60, width: 700, height: 500 } } } },
      windowRect: async () => ({ left: 40, top: 60, width: 700, height: 500 }),
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      readText: async () => ({ found: false, reason: 'no text read' }),
      move: async (_run, point) => moves.push(point),
      cursor: async () => ({ x: 900, y: 700 }),
    }
  );
  assert.equal(result.ok, true, 'the remembered point is a real aim target');
  assert.deepEqual(moves, [{ x: 300, y: 240 }]);
  assert.equal(run.aims[0].target, 'Dan');
});

test('a pointer already within a few pixels is left alone, with nothing resolved', async () => {
  const run = liveRun();
  const messages = [];
  let presenceReads = 0;
  let finds = 0;
  const moves = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's3', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Notifications' } },
    {
      workflow: { clickPoints: { s3: { x: 137, y: 250, name: 'Notifications', window: { left: 40, top: 60, width: 700, height: 500 } } } },
      windowRect: async () => ({ left: 40, top: 60, width: 700, height: 500 }),
      cursor: async () => ({ x: 135, y: 248 }),
      presence: async () => {
        presenceReads += 1;
        return presenceAt(4000, 'Sightline Profile');
      },
      find: async () => {
        finds += 1;
        return { found: true, x: 900, y: 900 };
      },
      move: async (_run, point) => moves.push(point),
      log: (message) => messages.push(message),
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.moved, false);
  assert.deepEqual(moves, [], 'the pointer was already there');
  assert.equal(presenceReads, 0, 'the presence read is skipped too');
  assert.equal(finds, 0, 'no UI Automation query is needed');
  assert.match(messages[0], /already on/);
  assert.equal(run.aims[0].moved, false);
  assert.equal(run.aims[0].target, 'Notifications');
  assert.equal(run.aims[0].stepId, 's3');
});

test('a pointer just outside the tolerance is still moved', async () => {
  const moves = [];
  const result = await aim.aimAt(liveRun(), aim.aimTargetFor({ type: 'click', params: { x: 400, y: 300 } }), {
    cursor: async () => ({ x: 407, y: 300 }),
    presence: async () => ({ ...presenceAt(4000, ''), cursor: { x: 407, y: 300 } }),
    find: async () => ({ found: false }),
    move: async (_run, point) => moves.push(point),
  });
  assert.equal(result.moved, true);
  assert.deepEqual(moves, [{ x: 400, y: 300 }]);
});

test('a point UI Automation resolves under the pointer does not move it', async () => {
  const run = liveRun();
  const moves = [];
  const result = await aim.aimAt(
    run,
    aim.aimTargetFor({ type: 'clickElement', params: { window: 'Sightline Accounts', name: 'Email' } }),
    {
      // No remembered point: the tree answers, and its answer is under the mouse.
      presence: async () => ({ ...presenceAt(4000, 'Sightline Accounts'), cursor: { x: 512, y: 481 } }),
      find: async () => ({ found: true, x: 512, y: 480 }),
      move: async (_run, point) => moves.push(point),
    }
  );
  assert.equal(result.moved, false);
  assert.deepEqual(moves, []);
  assert.equal(run.aims[0].moved, false);
});

test('the tolerance is a distance in screen pixels', () => {
  assert.equal(aim.pointerIsOnTarget({ x: 100, y: 100 }, { x: 103, y: 104 }), true);
  assert.equal(aim.pointerIsOnTarget({ x: 100, y: 100 }, { x: 107, y: 100 }), false);
  assert.equal(aim.pointerIsOnTarget({ x: 100, y: 100 }, { x: 100, y: 100 }, 0), true);
  assert.equal(aim.pointerIsOnTarget({ x: 100, y: 100 }, { x: 100, y: 101 }, 0), false);
  assert.equal(aim.pointerIsOnTarget({ x: 100, y: 100 }, null), false);
});

test('a control UI Automation cannot see is aimed at where its label is', async () => {
  const run = liveRun();
  const moves = [];
  const reads = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's4', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Profile' } },
    {
      // The remembered point is stale (the window moved); the fresh read wins.
      workflow: { clickPoints: { s4: { x: 10, y: 10, name: 'Profile', window: { left: 156, top: 156, width: 776, height: 559 } } } },
      windowRect: async () => ({ left: 52, top: 52, width: 776, height: 559 }),
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      readText: async (options) => {
        reads.push(options);
        return { found: true, x: 193, y: 255, text: 'Profile' };
      },
      move: async (_run, point) => moves.push(point),
      cursor: async () => ({ x: 900, y: 700 }),
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(reads[0].names, ['Profile'], 'the aim reads for the same labels the click would try');
  assert.deepEqual(moves, [{ x: 193, y: 255 }], 'the label’s own position, not the remembered point');
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
      readText: async () => ({ found: false, reason: 'no text read' }),
      move: async (_run, point) => moves.push(point),
      log: (message) => messages.push(message),
    }
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be located/);
  assert.equal(moves.length, 0, 'no guess is made at a control nobody has located');
  assert.match(messages[0], /Aiming paused/);
});

test('a point recorded in a window that has since moved is carried across the move, never trusted as-is', async () => {
  const run = liveRun();
  const moves = [];
  const messages = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's5', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Notifications' } },
    {
      // Learned at 156,156; the window is at 52,52 now, so the same coordinates
      // would point at whatever happens to be there.
      workflow: {
        clickPoints: {
          s5: { x: 325, y: 448, name: 'Notifications', window: { left: 156, top: 156, width: 776, height: 559 } },
        },
      },
      windowRect: async () => ({ left: 52, top: 52, width: 776, height: 559 }),
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: true, x: 221, y: 344 }),
      move: async (_run, point) => moves.push(point),
      cursor: async () => ({ x: 900, y: 700 }),
      log: (message) => messages.push(message),
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(moves, [{ x: 221, y: 344 }], 'the fresh read, not the point from the old window position');
  assert.match(messages.join(' '), /recorded at 325,448 in a window at 156,156/);
  assert.match(messages.join(' '), /moved 104 px left and 104 px up/, 'the movement is measured and named');
  assert.match(messages.join(' '), /carried to 221,344/, 'the point is re-adjusted into the window’s new place');
  assert.match(messages.join(' '), /located afresh first/);
});

test('when the control cannot be found fresh, the carried point is the aim', async () => {
  const run = liveRun();
  const moves = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's7', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Notifications' } },
    {
      workflow: {
        clickPoints: {
          s7: { x: 325, y: 448, name: 'Notifications', window: { left: 156, top: 156, width: 776, height: 559 } },
        },
      },
      windowRect: async () => ({ left: 52, top: 52, width: 776, height: 559 }),
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      readText: async () => ({ found: false, reason: 'no text read' }),
      move: async (_run, point) => moves.push(point),
      cursor: async () => ({ x: 900, y: 700 }),
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(moves, [{ x: 221, y: 344 }], 'the recorded point, translated by the window’s movement');
});

test('a carried point is scaled when the window was resized, and kept inside the window', async () => {
  const run = liveRun();
  const moves = [];
  const result = await aim.aimBeforeStep(
    run,
    { id: 's8', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Notifications' } },
    {
      workflow: {
        clickPoints: {
          // 325,448 in a 700x500 window at 100,100 is 225,348 into it; in the
          // window's new 1400x1000 size that is twice as far from its corner.
          s8: { x: 325, y: 448, name: 'Notifications', window: { left: 100, top: 100, width: 700, height: 500 } },
        },
      },
      windowRect: async () => ({ left: 100, top: 100, width: 1400, height: 1000 }),
      presence: async () => presenceAt(4000, 'Sightline Profile'),
      find: async () => ({ found: false, reason: 'no UI Automation tree' }),
      readText: async () => ({ found: false, reason: 'no text read' }),
      move: async (_run, point) => moves.push(point),
      cursor: async () => ({ x: 900, y: 700 }),
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(moves, [{ x: 550, y: 796 }]);
});

test('a point is trusted while its window is where it was recorded', async () => {
  const run = liveRun();
  const moves = [];
  const rect = { left: 52, top: 52, width: 776, height: 559 };
  let presenceReads = 0;
  const result = await aim.aimBeforeStep(
    run,
    { id: 's6', type: 'clickElement', params: { window: 'Sightline Profile', name: 'Notifications' } },
    {
      workflow: { clickPoints: { s6: { x: 325, y: 448, name: 'Notifications', window: { ...rect } } } },
      windowRect: async () => ({ ...rect }),
      cursor: async () => ({ x: 326, y: 449 }),
      presence: async () => {
        presenceReads += 1;
        return presenceAt(4000, 'Sightline Profile');
      },
      find: async () => assert.fail('no fresh read is needed when the pointer is already there'),
      move: async (_run, point) => moves.push(point),
    }
  );
  assert.equal(result.moved, false);
  assert.deepEqual(moves, [], 'the pointer was already on the point');
  assert.equal(presenceReads, 0);
});

test('a window that drifted a couple of pixels is still the same window', () => {
  const point = { x: 10, y: 10, window: { left: 52, top: 52, width: 776, height: 559 } };
  assert.equal(aim.pointMatchesWindow(point, { left: 54, top: 51, width: 776, height: 559 }), true);
  assert.equal(aim.pointMatchesWindow(point, { left: 57, top: 52, width: 776, height: 559 }), false, 'a 5px move is a move');
  assert.equal(aim.pointMatchesWindow(point, { left: 52, top: 52, width: 900, height: 559 }), false, 'a resize is not the same window');
  assert.equal(aim.pointMatchesWindow(point, null), false, 'an unreadable window is not a match');
  assert.equal(
    aim.pointMatchesWindow({ x: 10, y: 10 }, { left: 52, top: 52, width: 776, height: 559 }),
    false,
    'a point with no recorded window has no provenance'
  );
});
