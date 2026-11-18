import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adbKeyArgs,
  androidCharCode,
  appleKeyScript,
  captureCommand,
  captureToolFor,
  commandOnPath,
  detectBackend,
  keyChords,
  LINUX_CAPTURE,
  liveControl,
  xdotoolKeyArgs,
} from '../server/platform.js';

test('key notation becomes one chord per key press', () => {
  assert.deepEqual(keyChords('ctrl+l'), ['ctrl+l']);
  assert.deepEqual(keyChords('^l'), ['ctrl+l']);
  assert.deepEqual(keyChords('%{F4}'), ['alt+f4']);
  assert.deepEqual(keyChords('{ENTER}'), ['enter']);
  assert.deepEqual(keyChords('ctrl+shift+t'), ['ctrl+shift+t']);
  assert.deepEqual(keyChords(['ctrl+a', 'ctrl+c']), ['ctrl+a', 'ctrl+c']);
  assert.deepEqual(keyChords('ctrl+a, ctrl+v'), ['ctrl+a', 'ctrl+v']);
  assert.deepEqual(keyChords(''), []);
});

test('each backend gets its own key invocation', () => {
  assert.deepEqual(xdotoolKeyArgs('ctrl+l'), ['key', '--clearmodifiers', 'ctrl+l']);
  assert.deepEqual(adbKeyArgs('enter'), ['shell', 'input', 'keyevent', '66']);
  assert.deepEqual(adbKeyArgs('ctrl+l'), ['shell', 'input', 'keycombination', '113', '40']);
  assert.deepEqual(adbKeyArgs('back'), ['shell', 'input', 'keyevent', '4']);
  assert.throws(() => adbKeyArgs('hyper+l'), /no modifier/);
  assert.match(appleKeyScript('ctrl+l'), /keystroke "l" using \{control down\}/);
  assert.match(appleKeyScript('enter'), /key code 36/);
  assert.match(appleKeyScript('meta+shift+z'), /keystroke "z" using \{command down, shift down\}/);
});

test('android letter and digit key codes match the framework constants', () => {
  assert.equal(androidCharCode('a'), 29);
  assert.equal(androidCharCode('z'), 54);
  assert.equal(androidCharCode('0'), 7);
  assert.equal(androidCharCode('9'), 16);
  assert.equal(androidCharCode('!'), null);
});

test('backend detection reports what a console can actually do', () => {
  const windows = detectBackend({ platform: 'win32', env: {} });
  assert.equal(windows.id, 'win32');
  assert.equal(windows.available, true);

  // Linux and macOS remain live backends with no optional helpers installed:
  // the missing tool is reported, and the step that needs it fails on its own.
  const linuxBare = detectBackend({ platform: 'linux', env: { PATH: '' } });
  assert.equal(linuxBare.available, true);
  assert.equal(linuxBare.reason, '');
  assert.equal(linuxBare.captureReady, false);
  assert.equal(linuxBare.inputReady, false);
  assert.match(linuxBare.capture, /no screenshot tool/);

  const macBare = detectBackend({ platform: 'darwin', env: { PATH: '' } });
  assert.equal(macBare.available, true);
  assert.equal(macBare.captureReady, false);
  assert.match(macBare.capture, /screencapture \(not found\)/);

  const phone = detectBackend({ platform: 'linux', env: { PATH: '', SIGHTLINE_TARGET: 'android' } });
  assert.equal(phone.id, 'android');
  assert.equal(phone.mobile, true);
  assert.equal(phone.available, false);
  assert.match(phone.reason, /adb/);

  const unsupported = detectBackend({ platform: 'freebsd', env: { PATH: '' } });
  assert.equal(unsupported.available, false);
  assert.match(unsupported.reason, /not implemented for freebsd/);
});

test('linux capture falls back through the common X11 and Wayland tools', () => {
  const tools = LINUX_CAPTURE.map((entry) => entry.tool);
  for (const tool of ['grim', 'gnome-screenshot', 'spectacle', 'scrot', 'maim', 'xfce4-screenshooter', 'flameshot', 'import']) {
    assert.ok(tools.includes(tool), `${tool} should be a capture candidate`);
  }
  const flameshot = LINUX_CAPTURE.find((entry) => entry.tool === 'flameshot');
  assert.deepEqual(flameshot.args('/tmp/shot.png'), ['full', '-p', '/tmp/shot.png']);
});

test('live control status reports the backend and the tools it will use', () => {
  const windows = liveControl({ platform: 'win32', env: {} });
  assert.equal(windows.available, true);
  assert.equal(windows.reason, '');
  assert.equal(windows.captureReady, true);
  assert.equal(windows.inputReady, true);
  const linuxBare = liveControl({ platform: 'linux', env: { PATH: '' } });
  assert.equal(linuxBare.available, true);
  assert.equal(linuxBare.reason, '');
  assert.equal(linuxBare.captureReady, false);
});

function fixture(t, tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

test('Linux reports its capture and input tools without refusing the backend', { skip: process.platform === 'win32' }, (t) => {
  const full = fixture(t, { grim: '', scrot: '', xdotool: '' });
  // grim captures Wayland and cannot stand in for an X11 session.
  assert.equal(captureToolFor('linux', { PATH: full }), 'scrot');

  const ready = detectBackend({ platform: 'linux', env: { PATH: full } });
  assert.equal(ready.available, true);
  assert.equal(ready.reason, '');
  assert.equal(ready.captureReady, true);
  assert.equal(ready.inputReady, true);
  assert.equal(ready.input, 'xdotool (X11)');

  // No helpers and no DISPLAY is still a live backend: the step that needs one
  // fails with its own install hint instead of the whole run being refused.
  const none = fixture(t, {});
  const bare = detectBackend({ platform: 'linux', env: { PATH: none } });
  assert.equal(bare.available, true);
  assert.equal(bare.reason, '');
  assert.equal(bare.captureReady, false);
  assert.equal(bare.inputReady, false);
  assert.equal(captureToolFor('linux', { PATH: none }), '');
});

test('PATH entries must be executable regular files', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { scrot: '' });
  fs.chmodSync(path.join(dir, 'scrot'), 0o644);
  fs.mkdirSync(path.join(dir, 'xdotool'));
  assert.equal(commandOnPath('scrot', { PATH: dir }), false);
  assert.equal(commandOnPath('xdotool', { PATH: dir }), false);
});

test('macOS reports which capture and input helpers it found', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { screencapture: '', osascript: '', cliclick: '' });
  const env = { PATH: dir };
  const ready = detectBackend({ platform: 'darwin', env });
  assert.equal(ready.available, true);
  assert.equal(ready.reason, '');
  assert.equal(ready.captureReady, true);
  assert.equal(ready.inputReady, true);
  assert.equal(ready.input, 'cliclick + System Events (AppleScript)');

  fs.unlinkSync(path.join(dir, 'cliclick'));
  assert.equal(detectBackend({ platform: 'darwin', env }).input, 'System Events (AppleScript)');
  fs.unlinkSync(path.join(dir, 'osascript'));
  assert.equal(detectBackend({ platform: 'darwin', env }).inputReady, false);
  fs.unlinkSync(path.join(dir, 'screencapture'));
  assert.equal(detectBackend({ platform: 'darwin', env }).captureReady, false);
});

test('Android requires a uniquely selected authorized device', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { adb: '#!/bin/sh\nprintf "%s\\n" "List of devices attached" "$FAKE_DEVICES"\n' });
  const check = (devices, serial = '', platform = 'linux') => detectBackend({
    platform, env: { PATH: dir, SIGHTLINE_TARGET: 'android', ANDROID_SERIAL: serial, FAKE_DEVICES: devices },
  });
  assert.equal(check('').available, false);
  assert.equal(check('phone offline').available, false);
  assert.equal(check('phone unauthorized').available, false);
  assert.equal(check('phone device').available, true);
  assert.equal(check('phone device\nother device').available, false);
  assert.equal(check('phone device\nother device', 'phone').available, true);
  assert.equal(check('phone device', 'other').available, false);
  assert.equal(check('phone device', '', 'win32').available, false);
  assert.equal(detectBackend({ platform: 'freebsd', env: { PATH: dir, FAKE_DEVICES: 'phone device' } }).available, false);
});

test('macOS capture command is a full-screen PNG', () => {
  const command = captureCommand('darwin', '/tmp/shot.png');
  assert.equal(command.cmd, 'screencapture');
  assert.deepEqual(command.args, ['-x', '/tmp/shot.png']);
});
