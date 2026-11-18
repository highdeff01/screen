import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adbKeyArgs,
  androidCharCode,
  appleKeyScript,
  captureCommand,
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

  const phone = detectBackend({ platform: 'win32', env: { PATH: '', SIGHTLINE_TARGET: 'android' } });
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

test('macOS capture command is a full-screen PNG', () => {
  const command = captureCommand('darwin', '/tmp/shot.png');
  assert.equal(command.cmd, 'screencapture');
  assert.deepEqual(command.args, ['-x', '/tmp/shot.png']);
});
