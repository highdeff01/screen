import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The monitor imports the store and the automation layer, both of which create
// data files relative to the working directory.
const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-monitor-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const monitor = await load('server/live-monitor.js');

after(() => {
  try {
    monitor.stopLiveMonitor();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a first snapshot suggests a read and a capture', () => {
  const steps = monitor.suggestSubSteps({ title: 'Downloads - Chrome', process: 'chrome', className: 'Chrome_WidgetWin_1' }, null);
  assert.equal(steps[0].type, 'verifyScreen');
  assert.equal(steps[1].type, 'screenshot');
  assert.ok(steps.every((step) => step.why));
});

test('a process change adds a window guard and a refocus', () => {
  const steps = monitor.suggestSubSteps(
    { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' },
    { title: 'Google', process: 'chrome', className: 'Chrome_WidgetWin_1' }
  );
  const types = steps.map((step) => step.type);
  assert.ok(types.includes('waitFor'));
  assert.ok(types.includes('focusWindow'));
  assert.equal(steps.find((step) => step.type === 'waitFor').params.kind, 'window');
});

test('a dialog gets a capture and a read before any click', () => {
  const steps = monitor.suggestSubSteps(
    { title: 'Save As', process: 'explorer', className: '#32770' },
    { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' }
  );
  const types = steps.map((step) => step.type);
  assert.ok(types.includes('screenshot'));
  assert.ok(types.includes('verifyScreen'));
  assert.ok(!types.includes('click'));
});

test('a new browser page offers the link, an editor offers a content check', () => {
  const browser = monitor.suggestSubSteps(
    { title: 'VLC: Official site - Google Chrome', process: 'chrome', className: 'Chrome_WidgetWin_1' },
    { title: 'New Tab', process: 'chrome', className: 'Chrome_WidgetWin_1' }
  );
  assert.ok(browser.some((step) => step.type === 'copyLink'));
  const editor = monitor.suggestSubSteps(
    { title: 'notes.txt - Notepad', process: 'notepad', className: 'Notepad' },
    { title: 'Untitled - Notepad', process: 'notepad', className: 'Notepad' }
  );
  assert.ok(editor.some((step) => step.type === 'verifyScreen'));
});

test('an unexplained change still yields evidence rather than input', () => {
  const steps = monitor.suggestSubSteps(
    { title: 'sightline-window-755075', process: 'powershell', className: 'WindowsForms10.Window.8.app' },
    { title: 'sightline-window-755075', process: 'powershell', className: 'WindowsForms10.Window.8.app' }
  );
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'screenshot');
});

test('monitor state is serializable and starts idle', () => {
  const state = monitor.monitorState();
  assert.equal(state.running, false);
  assert.ok(Array.isArray(state.events));
  assert.deepEqual(monitor.latestMonitorSuggestions(), []);
  const json = JSON.parse(JSON.stringify(state));
  assert.equal(typeof json.platform, 'string');
});
