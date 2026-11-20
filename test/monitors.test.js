import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-monitors-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const monitors = await load('server/monitors.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const TWO_SCREENS = [
  { device: '\\\\.\\DISPLAY1', primary: true, x: 0, y: 0, w: 1920, h: 1080 },
  { device: '\\\\.\\DISPLAY2', primary: false, x: 1920, y: 0, w: 2560, h: 1440 },
];

/** Inject a synthetic layout so the test never touches the real desktop. */
function fakeLayout(list) {
  monitors.setLayoutSourceForTests(() => list);
  return () => monitors.setLayoutSourceForTests(null);
}

test('monitorOfPoint maps virtual-screen coordinates to the right display', () => {
  const list = TWO_SCREENS;
  assert.equal(monitors.monitorOfPoint(list, 500, 500).device, '\\\\.\\DISPLAY1');
  assert.equal(monitors.monitorOfPoint(list, 3000, 200).device, '\\\\.\\DISPLAY2');
  assert.equal(monitors.monitorOfPoint(list, 5000, 5000), null, 'outside every monitor');
});

test('layoutSignature changes when the layout does', () => {
  const before = monitors.layoutSignature(TWO_SCREENS);
  const moved = [{ ...TWO_SCREENS[0] }, { ...TWO_SCREENS[1], x: 1930 }];
  assert.notEqual(before, monitors.layoutSignature(moved));
  assert.equal(before, monitors.layoutSignature(TWO_SCREENS));
});

test('the reflex flags a pointer step aimed at a different display than its window', async () => {
  const run = {
    id: 'run_mon',
    workflowId: 'wf_mon',
    workflowName: 'Monitor probe',
    lastWindow: { title: 'Untitled - Notepad', process: 'Notepad', hwnd: 7 },
    log: [],
  };
  const step = {
    id: 's_click',
    type: 'click',
    name: 'Click the control',
    params: { x: 3000, y: 400 }, // DISPLAY2
    status: 'passed',
  };
  const restore = fakeLayout(TWO_SCREENS);
  try {
    const result = await monitors.checkStepMonitor(step, run, {
      readRect: async () => ({ x: 100, y: 100, w: 400, h: 300 }), // window centered on DISPLAY1
    });
    assert.equal(result.kind, 'mismatch');
    assert.match(step.monitorNote, /different monitor|DISPLAY/);
  } finally {
    restore();
  }
});

test('a step aimed at the same display as its window passes silently', async () => {
  const run = {
    id: 'run_mon2',
    workflowId: 'wf_mon',
    workflowName: 'Monitor probe',
    lastWindow: { title: 'Untitled - Notepad', hwnd: 7 },
    log: [],
  };
  const step = { id: 's_click2', type: 'click', name: 'Click', params: { x: 500, y: 500 }, status: 'passed' };
  const restore = fakeLayout(TWO_SCREENS);
  try {
    const result = await monitors.checkStepMonitor(step, run, {
      readRect: async () => ({ x: 400, y: 400, w: 300, h: 200 }), // DISPLAY1, like the point
    });
    assert.equal(result.kind, 'target-ok');
    assert.equal(step.monitorNote, undefined);
  } finally {
    restore();
  }
});

test('non-coordinate steps and failed steps are skipped', async () => {
  const restore = fakeLayout(TWO_SCREENS);
  try {
    assert.equal(await monitors.checkStepMonitor({ id: 's1', type: 'type', params: { text: 'x' }, status: 'passed' }, { lastWindow: null }), null);
    assert.equal(await monitors.checkStepMonitor({ id: 's2', type: 'click', params: { x: 10, y: 10 }, status: 'failed' }, { lastWindow: null }), null);
  } finally {
    restore();
  }
});
