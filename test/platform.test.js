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
  parseWindowsProbe,
  probeLiveBackend,
  selectWindowsMechanism,
  windowsProbeCommand,
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
  assert.equal(windows.label, 'Windows');
  assert.equal(windows.available, true);
  assert.equal(windows.target, 'desktop');
  assert.equal(windows.captureReady, true);
  assert.equal(windows.inputReady, true);
  assert.match(windows.capture, /PowerShell.*System\.Drawing/);
  assert.match(windows.input, /PowerShell.*Win32/);

  const linuxBare = detectBackend({ platform: 'linux', env: { PATH: '' } });
  assert.equal(linuxBare.available, false);
  assert.match(linuxBare.reason, /DISPLAY.*xdotool.*screenshot/);
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
  assert.equal(linuxBare.available, false);
  assert.match(linuxBare.reason, /DISPLAY.*xdotool.*screenshot/);
  assert.equal(linuxBare.captureReady, false);
  assert.equal(linuxBare.inputReady, false);
});

function fixture(t, tools) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(tools)) {
    fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  }
  return dir;
}

test('Linux live control requires its X11 input, capture and display prerequisites', { skip: process.platform === 'win32' }, (t) => {
  const full = fixture(t, { grim: '', scrot: '', xdotool: '' });
  const env = { PATH: full, DISPLAY: ':0' };
  // grim is not used by the X11 capture command.
  assert.equal(captureToolFor('linux', env), 'scrot');

  const ready = detectBackend({ platform: 'linux', env });
  assert.equal(ready.available, true);
  assert.equal(ready.reason, '');
  assert.equal(ready.captureReady, true);
  assert.equal(ready.inputReady, true);
  assert.equal(ready.input, 'xdotool (X11)');
  assert.equal(liveControl({ platform: 'linux', env }).available, true);

  // A Wayland session with XWayland is usable; Wayland alone is not enough.
  assert.equal(detectBackend({ platform: 'linux', env: { ...env, WAYLAND_DISPLAY: 'wayland-0' } }).available, true);
  for (const display of ['', '   ']) {
    const noDisplay = detectBackend({ platform: 'linux', env: { ...env, DISPLAY: display, WAYLAND_DISPLAY: 'wayland-0' } });
    assert.equal(noDisplay.available, false);
    assert.match(noDisplay.reason, /DISPLAY/);
    assert.equal(noDisplay.captureReady, false);
    assert.equal(noDisplay.inputReady, false);
  }

  const noInput = fixture(t, { scrot: '', ydotool: '' });
  const missingInput = detectBackend({ platform: 'linux', env: { PATH: noInput, DISPLAY: ':0' } });
  assert.equal(missingInput.available, false);
  assert.match(missingInput.reason, /xdotool/);
  assert.equal(missingInput.inputReady, false);
  assert.equal(missingInput.captureReady, true);

  const noCapture = fixture(t, { xdotool: '', grim: '' });
  const missingCapture = detectBackend({ platform: 'linux', env: { PATH: noCapture, DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' } });
  assert.equal(missingCapture.available, false);
  assert.match(missingCapture.reason, /screenshot/);
  assert.equal(missingCapture.inputReady, true);
  assert.equal(missingCapture.captureReady, false);
  assert.equal(captureToolFor('linux', { PATH: noCapture }), '');
});

test('Linux live probe requires both X11 prerequisites and a reachable display', { skip: process.platform === 'win32' }, async (t) => {
  const tools = fixture(t, { xdotool: '#!/bin/sh\nexit 0\n' });
  const env = { PATH: tools, DISPLAY: ':99' };
  const noCapture = await probeLiveBackend({ platform: 'linux', env });
  assert.equal(noCapture.ok, false);
  assert.match(noCapture.detail, /screenshot tool/);

  fs.writeFileSync(path.join(tools, 'scrot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal((await probeLiveBackend({ platform: 'linux', env })).ok, true);
  fs.writeFileSync(path.join(tools, 'xdotool'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.equal((await probeLiveBackend({ platform: 'linux', env })).ok, false);
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

test('the Windows probe asks for the version and selects the mechanism before a live switch', () => {
  const command = windowsProbeCommand();
  assert.match(command, /CurrentBuild/);
  assert.match(command, /CurrentVersion/);
  assert.match(command, /UserInteractive/);
  // The question itself must be read-only: asking may not open, focus or type
  // into anything, or the check would interrupt the operator's session.
  assert.doesNotMatch(command, /Start-Process|SendKeys|SetCursorPos|mouse_event|keybd_event|AppActivate/);

  assert.deepEqual(parseWindowsProbe('sightline build=26200 version=25H2 interactive=True'), {
    build: 26200,
    version: '25H2',
    interactive: true,
  });
  assert.deepEqual(parseWindowsProbe('sightline build=19045 version=22H2 interactive=False'), {
    build: 19045,
    version: '22H2',
    interactive: false,
  });
  assert.deepEqual(parseWindowsProbe(''), { build: 0, version: '', interactive: false });

  const supported = selectWindowsMechanism({ build: 26200, version: '25H2', interactive: true });
  assert.equal(supported.ok, true);
  assert.equal(supported.mechanism, 'powershell+sendinput');
  assert.match(supported.label, /build 26200/);
  assert.match(supported.label, /SendInput/);

  // No interactive desktop: a live switch would drive a screen nobody can see.
  const headless = selectWindowsMechanism({ build: 26200, interactive: false });
  assert.equal(headless.ok, false);
  assert.equal(headless.mechanism, '');
  assert.match(headless.reason, /interactive desktop/);

  // A build below the Win32 SendInput floor cannot be driven live at all.
  const ancient = selectWindowsMechanism({ build: 7601, version: '7', interactive: true });
  assert.equal(ancient.ok, false);
  assert.equal(ancient.mechanism, '');
  assert.match(ancient.reason, /older than 10240/);
});

test('the real probe only claims a Windows mechanism it could select', async (t) => {
  if (process.platform !== 'win32') return t.skip('the Windows probe is exercised on Windows hosts');
  const proof = await probeLiveBackend({ timeoutMs: 20000 });
  assert.equal(proof.ok, true, proof.detail);
  assert.equal(proof.mechanism, 'powershell+sendinput');
  assert.ok(proof.os.build >= 10240, `reported build ${proof.os.build}`);
  assert.match(proof.detail, /Windows .*build \d+/);
});
