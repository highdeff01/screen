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

  const linuxBare = detectBackend({ platform: 'linux', env: { PATH: '' } });
  assert.equal(linuxBare.available, false);
  assert.match(linuxBare.reason, /screenshot tool/);
  assert.match(linuxBare.reason, /xdotool/);

  const macBare = detectBackend({ platform: 'darwin', env: { PATH: '' } });
  assert.equal(macBare.available, false);
  assert.match(macBare.reason, /screencapture/);

  const phone = detectBackend({ platform: 'linux', env: { PATH: '', SIGHTLINE_TARGET: 'android' } });
  assert.equal(phone.id, 'android');
  assert.equal(phone.mobile, true);
  assert.equal(phone.available, false);
  assert.match(phone.reason, /adb/);

  const unsupported = detectBackend({ platform: 'freebsd', env: { PATH: '' } });
  assert.equal(unsupported.available, false);
  assert.match(unsupported.reason, /not implemented for freebsd/);
});

test('live control status carries the reason the UI banner shows', () => {
  const windows = liveControl({ platform: 'win32', env: {} });
  assert.equal(windows.available, true);
  assert.equal(windows.reason, '');
  const linuxBare = liveControl({ platform: 'linux', env: { PATH: '' } });
  assert.equal(linuxBare.available, false);
  assert.ok(linuxBare.reason.length > 20);
});

function fixture(t, tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

test('Linux requires X11 display, capture and the input backend actually implemented', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { grim: '', ydotool: '', xdotool: '', scrot: '' });
  const env = { PATH: dir };
  assert.equal(detectBackend({ platform: 'linux', env }).available, false);
  assert.match(detectBackend({ platform: 'linux', env }).reason, /DISPLAY/);
  assert.equal(captureToolFor('linux', env), 'scrot');
  assert.equal(detectBackend({ platform: 'linux', env: { ...env, DISPLAY: ':1' } }).available, true);
  fs.unlinkSync(path.join(dir, 'xdotool'));
  assert.match(detectBackend({ platform: 'linux', env: { ...env, DISPLAY: ':1' } }).reason, /xdotool/);
  fs.unlinkSync(path.join(dir, 'scrot'));
  assert.equal(captureToolFor('linux', env), '');
});

test('PATH entries must be executable regular files', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { scrot: '' });
  fs.chmodSync(path.join(dir, 'scrot'), 0o644);
  fs.mkdirSync(path.join(dir, 'xdotool'));
  assert.equal(commandOnPath('scrot', { PATH: dir }), false);
  assert.equal(commandOnPath('xdotool', { PATH: dir }), false);
});

test('macOS needs pointer and keyboard tools as well as capture', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t, { screencapture: '', osascript: '' });
  const env = { PATH: dir };
  assert.match(detectBackend({ platform: 'darwin', env }).reason, /cliclick/);
  fs.writeFileSync(path.join(dir, 'cliclick'), '', { mode: 0o755 });
  assert.equal(detectBackend({ platform: 'darwin', env }).available, true);
  fs.unlinkSync(path.join(dir, 'osascript'));
  assert.match(detectBackend({ platform: 'darwin', env }).reason, /osascript/);
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
