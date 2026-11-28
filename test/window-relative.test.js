import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-window-relative-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');
const aim = await load('server/aim.js');
const relative = await load('server/window-relative.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const RECT = { found: true, left: 600, top: 300, width: 900, height: 700 };

test('a click recorded inside the window follows the window when it moves', () => {
  const step = { type: 'click', params: { anchor: 'window', x: 120, y: 44, foreground: 'Calculator' } };
  const wasAt = relative.resolveWindowRelative(step, { ...RECT, left: 100, top: 80 });
  assert.deepEqual([wasAt.params.x, wasAt.params.y], [220, 124], 'the same offset in the window where it was recorded');
  const nowAt = relative.resolveWindowRelative(step, RECT);
  assert.deepEqual([nowAt.params.x, nowAt.params.y], [720, 344], 'the same offset in the window where it is now');
  assert.equal(nowAt.params.anchor, 'window', 'the step keeps its anchor for the next run');
  assert.equal(nowAt.params.foreground, 'Calculator');
  assert.deepEqual(nowAt.points, [{ offset: { x: 120, y: 44 }, point: { x: 720, y: 344 } }]);
  assert.deepEqual(nowAt.window, { title: 'Calculator', rect: { left: 600, top: 300, width: 900, height: 700 } });
});

test('a drag resolves both ends of the drag', () => {
  const step = { type: 'drag', params: { anchor: 'window', x1: 10, y1: 20, x2: 300, y2: 40 } };
  const resolved = relative.resolveWindowRelative(step, RECT);
  assert.deepEqual([resolved.params.x1, resolved.params.y1], [610, 320]);
  assert.deepEqual([resolved.params.x2, resolved.params.y2], [900, 340]);
  assert.equal(resolved.points.length, 2);
});

test('an offset written for a bigger window stays inside it', () => {
  assert.deepEqual(relative.fromWindowOffset({ x: 5000, y: -400 }, RECT), { x: 600 + 900 - 1, y: 300 });
});

test('a screen-relative step is left exactly as it is', () => {
  assert.equal(relative.resolveWindowRelative({ type: 'click', params: { x: 720, y: 344 } }, RECT), null);
  assert.equal(relative.isWindowRelative({ x: 1, y: 2 }), false);
  assert.equal(relative.isWindowRelative({ anchor: 'window' }), true);
  assert.equal(relative.isWindowRelative({ windowRelative: true }), true);
  assert.equal(relative.isWindowRelative({ anchor: 'screen' }), false, '“screen” is the default');
});

test('a window that cannot be read resolves nothing', () => {
  const step = { type: 'click', params: { anchor: 'window', x: 10, y: 10 } };
  assert.equal(relative.resolveWindowRelative(step, { found: false, reason: 'window not found' }), null);
  assert.equal(
    relative.resolveWindowRelative(step, { found: true, left: 0, top: 0, width: 0, height: 0 }),
    null,
    'a minimized window reports a placeholder rectangle of no size'
  );
  assert.equal(relative.resolveWindowRelative(step, null), null);
});

test('a step whose point is optional is not resolved at all', () => {
  assert.equal(relative.hasWindowPoint({ amount: 3, anchor: 'window' }), false, 'a scroll with no point has nothing to resolve');
  assert.equal(relative.resolveWindowRelative({ type: 'scroll', params: { amount: 3, anchor: 'window' } }, RECT), null);
  assert.equal(relative.hasWindowPoint({ x: 0, y: 0 }), true, 'zero is a real offset');
});

test('toWindowOffset records where a click landed inside its window', () => {
  assert.deepEqual(relative.toWindowOffset({ x: 720, y: 344 }, RECT), { x: 120, y: 44 });
  assert.equal(relative.toWindowOffset({ x: 720, y: 344 }, null), null);
});

test('an offset is never recorded as an absolute click point', () => {
  assert.equal(
    engine.clickPointOf({ type: 'click', params: { anchor: 'window', x: 120, y: 44 } }),
    null,
    'recording the offset would later hover empty desktop'
  );
  assert.deepEqual(
    engine.clickPointOf({
      type: 'click',
      params: { anchor: 'window', x: 120, y: 44 },
      clickPoint: { x: 720, y: 344, name: 'Save', method: 'window-relative' },
    }),
    { x: 720, y: 344, name: 'Save', method: 'window-relative' },
    'the point the executor reported is the one recorded'
  );
  assert.deepEqual(engine.clickPointOf({ type: 'click', params: { x: 720, y: 344 } }), {
    x: 720,
    y: 344,
    name: '',
    method: 'coordinates',
  });
});

test('aiming a relative point moves the pointer to where the window is now', async () => {
  const target = aim.aimTargetFor({ type: 'click', params: { anchor: 'window', x: 120, y: 44, foreground: 'Calculator' } });
  assert.equal(target.relative, true);
  assert.deepEqual([target.x, target.y], [120, 44], 'the step keeps its offset');
  assert.equal(aim.knownAimPoint(target), null, 'an offset is not a screen point the pointer can already be on');

  const moved = [];
  const run = { id: 'run_relative_aim', dryRun: false, shadow: false, lastActionAt: 0 };
  const result = await aim.aimAt(run, target, {
    presence: async () => ({ idleMs: 60000, foreground: { title: 'Calculator', process: 'calc' }, cursor: { x: 5, y: 5 } }),
    readRect: async () => RECT,
    find: async () => ({ found: false }),
    readText: async () => ({ found: false }),
    cursor: async () => ({ x: 5, y: 5 }),
    move: async (_run, point) => moved.push(point),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(moved, [{ x: 720, y: 344 }], 'the pointer moved to the resolved screen point');
});

test('a relative point whose window cannot be located is not aimed by guesswork', async () => {
  aim.resetAimState();
  const target = aim.aimTargetFor({ type: 'click', params: { anchor: 'window', x: 120, y: 44 } });
  const moved = [];
  const run = { id: 'run_relative_missing', dryRun: false, shadow: false, lastActionAt: 0 };
  const result = await aim.aimAt(run, target, {
    presence: async () => ({ idleMs: 60000, foreground: { title: 'Anything' }, cursor: { x: 5, y: 5 } }),
    readRect: async () => ({ found: false, reason: 'window not found' }),
    find: async () => ({ found: false }),
    readText: async () => ({ found: false }),
    cursor: async () => ({ x: 5, y: 5 }),
    move: async (_run, point) => moved.push(point),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be located/);
  assert.deepEqual(moved, [], 'the pointer was left alone');
});
