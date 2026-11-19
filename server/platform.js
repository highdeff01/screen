/**
 * Platform backends for live desktop and mobile control.
 *
 * Windows keeps its native PowerShell + Win32 path in automation.js. This module
 * covers the rest: macOS (screencapture + System Events/cliclick), Linux
 * (X11 tools) and Android (adb), and it is the single place that answers "can
 * this console drive a screen, and with what?".
 *
 * Everything here is either a pure command builder (so it can be checked without
 * that operating system) or a thin probe of what is installed.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOST = process.platform;
const IS_WINDOWS = HOST === 'win32';

/**
 * Windows live control uses PowerShell plus Win32 SendInput, which every
 * supported Windows 10/11 build has. Older builds have no working SendInput
 * path, so a run must stay simulated there instead of being switched live.
 */
const WINDOWS_MIN_BUILD = 10240;

/** Run a command and never throw; returns { ok, stdout, stderr, code }. */
export function runCommand(cmd, args = [], { timeoutMs = 20000, input = '' } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: Buffer.isBuffer(stdout) ? stdout : String(stdout || ''),
          stderr: String(stderr || '').trim() || (error?.killed ? 'Command timed out.' : ''),
        });
      }
    );
    if (input) {
      child.stdin?.end(input);
    }
  });
}

/** True when an executable is found on PATH (honours PATHEXT on Windows). */
export function commandOnPath(name, env = process.env) {
  if (!name) return false;
  const exts = IS_WINDOWS
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // An unreadable PATH entry is simply not a hit.
      }
    }
  }
  return false;
}

const LINUX_CAPTURE = [
  { tool: 'grim', args: (file) => [file] },
  { tool: 'gnome-screenshot', args: (file) => ['-f', file] },
  { tool: 'spectacle', args: (file) => ['-b', '-n', '-o', file] },
  { tool: 'scrot', args: (file) => [file] },
  { tool: 'maim', args: (file) => [file] },
  { tool: 'xfce4-screenshooter', args: (file) => ['-f', '-s', file] },
  { tool: 'flameshot', args: (file) => ['full', '-p', file] },
  { tool: 'import', args: (file) => ['-window', 'root', file] },
];

const LINUX_INPUT = [{ tool: 'xdotool', label: 'xdotool (X11)' }];

function firstPresent(candidates, env) {
  return candidates.find((entry) => commandOnPath(entry.tool, env)) || null;
}

/** Return a uniquely selected, authorized adb device, not just an installed adb. */
export function androidDevice({ env = process.env } = {}) {
  if (!commandOnPath('adb', env)) return null;
  const serial = String(env.ANDROID_SERIAL || '').trim();
  try {
    const output = execFileSync('adb', ['devices'], {
      env, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const devices = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter(([id, state]) => id && state === 'device')
      .map(([id]) => id);
    if (serial ? !devices.includes(serial) : devices.length !== 1) return null;
    // Without -s adb also rejects a mix of online and offline/unauthorized devices.
    const all = output.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter(([, state]) => ['device', 'offline', 'unauthorized'].includes(state));
    if (!serial && all.length !== 1) return null;
    return { serial, tool: 'adb' };
  } catch {
    return null;
  }
}

export const ANDROID_KEYCODES = {
  enter: 66,
  return: 66,
  tab: 61,
  esc: 111,
  escape: 111,
  space: 62,
  backspace: 67,
  bksp: 67,
  delete: 112,
  del: 112,
  insert: 124,
  home: 122,
  end: 123,
  pageup: 92,
  pagedown: 93,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  back: 4,
  menu: 82,
  win: 3,
  meta: 3,
  shift: 59,
  ctrl: 113,
  control: 113,
  alt: 57,
  f1: 131,
  f2: 132,
  f3: 133,
  f4: 134,
  f5: 135,
  f6: 136,
  f7: 137,
  f8: 138,
  f9: 139,
  f10: 140,
  f11: 141,
  f12: 142,
};

export const MAC_KEYCODES = {
  enter: 36,
  return: 36,
  tab: 48,
  esc: 53,
  escape: 53,
  space: 49,
  backspace: 51,
  bksp: 51,
  delete: 117,
  del: 117,
  insert: 114,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

/**
 * Turn the step's key notation — SendKeys-style "ctrl+l", "^l", "ctrl+shift+t",
 * "{ENTER}", or an array of them — into canonical chords: ['ctrl+l'].
 */
export function keyChords(input) {
  const entries = (Array.isArray(input) ? input : [input])
    .flatMap((entry) => String(entry ?? '').split(/\s*,\s*/))
    .filter((entry) => entry.trim());
  return entries.map(pieceToChord).filter(Boolean);
}

function pieceToChord(token) {
  let text = String(token).trim().toLowerCase();
  if (!text) return '';
  const modifiers = [];
  // SendKeys prefixes: ^ control, % alt, + shift.
  while (/^[\^%+]/.test(text)) {
    const mark = text[0];
    if (mark === '^') modifiers.push('ctrl');
    else if (mark === '%') modifiers.push('alt');
    else modifiers.push('shift');
    text = text.slice(1);
  }
  const parts = text.split('+').filter(Boolean);
  const keyParts = [];
  for (const part of parts) {
    const clean = part.trim().replace(/^\{|\}$/g, '').toLowerCase();
    if (!clean) continue;
    if (['ctrl', 'control'].includes(clean)) modifiers.push('ctrl');
    else if (clean === 'alt' || clean === 'option') modifiers.push('alt');
    else if (clean === 'shift') modifiers.push('shift');
    else if (['cmd', 'command', 'meta', 'win', 'super'].includes(clean)) modifiers.push('meta');
    else keyParts.push(clean);
  }
  const key = keyParts.join('+') || modifiers.pop() || '';
  if (!key) return modifiers.join('+');
  return [...new Set(modifiers), key].join('+');
}

/** xdotool: "ctrl+l" → ["key", "--clearmodifiers", "ctrl+l"]. */
export function xdotoolKeyArgs(chord) {
  return ['key', '--clearmodifiers', chord];
}

/** Android: single key → keyevent; a chord → keycombination (API 31+). */
export function adbKeyArgs(chord) {
  const parts = String(chord).split('+');
  const key = parts.pop();
  const code = ANDROID_KEYCODES[key] ?? (/^[a-z0-9]$/.test(key) ? androidCharCode(key) : null);
  if (code == null) throw new Error(`Android has no key code for "${key}".`);
  if (!parts.length) return ['shell', 'input', 'keyevent', String(code)];
  const modifiers = parts.map((mod) => {
    const modifierCode = ANDROID_KEYCODES[mod];
    if (modifierCode == null) throw new Error(`Android has no modifier "${mod}".`);
    return String(modifierCode);
  });
  return ['shell', 'input', 'keycombination', ...modifiers, String(code)];
}

/** KEYCODE_A = 29 … KEYCODE_Z = 54, KEYCODE_0 = 7 … KEYCODE_9 = 16. */
export function androidCharCode(char) {
  const code = String(char).toLowerCase().charCodeAt(0);
  if (code >= 97 && code <= 122) return 29 + (code - 97);
  if (code >= 48 && code <= 57) return 7 + (code - 48);
  return null;
}

/** AppleScript that presses one chord through System Events. */
export function appleKeyScript(chord) {
  const parts = String(chord).split('+');
  const key = parts.pop();
  const APPLE_MODIFIER = { ctrl: 'control', control: 'control', meta: 'command', cmd: 'command', alt: 'option', option: 'option', shift: 'shift' };
  const using = parts.map((mod) => `${APPLE_MODIFIER[mod] || mod} down`).join(', ');
  const code = MAC_KEYCODES[key];
  if (code != null) {
    return using
      ? `tell application "System Events" to key code ${code} using {${using}}`
      : `tell application "System Events" to key code ${code}`;
  }
  if (key.length > 1) throw new Error(`macOS has no key code for "${key}".`);
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return using
    ? `tell application "System Events" to keystroke "${escaped}" using {${using}}`
    : `tell application "System Events" to keystroke "${escaped}"`;
}

/** The tool that will take the screenshot, or '' when none is installed. */
export function captureToolFor(backend, env = process.env) {
  if (backend === 'darwin') return commandOnPath('screencapture', env) ? 'screencapture' : '';
  // The portable input and window operations use X11. Do not select grim,
  // which captures Wayland and cannot capture a plain X11 session.
  if (backend === 'linux') return firstPresent(LINUX_CAPTURE.filter((entry) => entry.tool !== 'grim'), env)?.tool || '';
  return '';
}

/** Full-screen capture command for a desktop backend. */
export function captureCommand(backend, file) {
  if (backend === 'darwin') return { cmd: 'screencapture', args: ['-x', file] };
  if (backend === 'linux') {
    const entry = LINUX_CAPTURE.find((candidate) => candidate.tool === captureToolFor('linux'));
    if (!entry) {
      throw new Error(
        'No X11 screenshot tool found. Install one of scrot, maim, flameshot, gnome-screenshot, spectacle, xfce4-screenshooter or imagemagick import.'
      );
    }
    return { cmd: entry.tool, args: entry.args(file) };
  }
  throw new Error(`No capture command for ${backend}.`);
}

/**
 * The backend this console should use. `SIGHTLINE_TARGET=android` deliberately
 * drives a phone from any host; otherwise the local desktop decides.
 */
export function detectBackend({ env = process.env, platform = HOST } = {}) {
  const forced = String(env.SIGHTLINE_TARGET || '').trim().toLowerCase();
  if (forced === 'android' || forced === 'mobile') {
    // The Windows automation dispatcher always uses its native backend.
    if (platform === 'win32') return {
      id: 'android', label: 'Android device', available: false, mobile: true, target: forced,
      reason: 'Android targeting is not supported by the Windows automation dispatcher; use a non-Windows host.',
    };
    const device = androidDevice({ env });
    return device
      ? {
          id: 'android',
          label: 'Android device',
          available: true,
          reason: '',
          capture: 'adb screencap',
          input: 'adb input',
          captureReady: true,
          inputReady: true,
          mobile: true,
          target: forced,
        }
      : {
          id: 'android',
          label: 'Android device',
          available: false,
          mobile: true,
          target: forced,
          captureReady: false,
          inputReady: false,
          reason:
            'SIGHTLINE_TARGET=android needs adb on PATH with a device attached; check `adb devices`.',
        };
  }
  if (platform === 'win32') {
    return {
      id: 'win32',
      label: 'Windows',
      available: true,
      reason: '',
      capture: 'PowerShell + System.Drawing',
      input: 'PowerShell + Win32 SendInput',
      captureReady: true,
      inputReady: true,
      mobile: false,
      target: 'desktop',
    };
  }
  if (platform === 'darwin') {
    const capture = captureToolFor('darwin', env);
    const scripting = commandOnPath('osascript', env);
    // macOS is a live backend with or without the optional helpers; a step that
    // needs a missing one fails there, with its own install hint.
    return {
      id: 'darwin',
      label: 'macOS',
      available: true,
      reason: '',
      capture: capture || 'screencapture (not found)',
      input: scripting
        ? commandOnPath('cliclick', env)
          ? 'cliclick + System Events (AppleScript)'
          : 'System Events (AppleScript)'
        : 'osascript (not found)',
      captureReady: Boolean(capture),
      inputReady: scripting,
      mobile: false,
      target: 'desktop',
    };
  }
  if (platform === 'linux') {
    const capture = captureToolFor('linux', env);
    const input = commandOnPath('xdotool', env) ? LINUX_INPUT[0] : null;
    // Pointer, keys and window operations use xdotool, even when a Wayland
    // session is present. XWayland works when it supplies an X11 DISPLAY;
    // ydotool and grim alone are not sufficient for this backend.
    const display = Boolean(String(env.DISPLAY || '').trim());
    const missing = [];
    if (!display) missing.push('an X11 DISPLAY (including XWayland)');
    if (!input) missing.push('xdotool on PATH for input');
    if (!capture) missing.push('an X11 screenshot tool on PATH (such as scrot or maim)');
    return {
      id: 'linux',
      label: 'Linux',
      available: missing.length === 0,
      reason: missing.length ? `Linux live control needs ${missing.join(', ')}.` : '',
      capture: capture || 'no screenshot tool',
      input: input ? input.label : 'no input tool (xdotool)',
      captureReady: display && Boolean(capture),
      inputReady: display && Boolean(input),
      mobile: false,
      target: 'desktop',
    };
  }
  return {
    id: 'unknown',
    label: platform,
    available: false,
    mobile: false,
    target: 'desktop',
    capture: 'none',
    input: 'none',
    captureReady: false,
    inputReady: false,
    reason: `Live control is not implemented for ${platform}. Set SIGHTLINE_TARGET=android with adb and a device attached, or run the console on Windows, macOS or Linux.`,
  };
}

/**
 * The one PowerShell query the Windows probe runs. It is read-only: it asks the
 * registry for the release and build and .NET whether this process owns an
 * interactive desktop. It never opens a window, moves the pointer or sends a
 * key, so asking cannot interrupt the operator's session.
 */
export function windowsProbeCommand() {
  return [
    "$k='HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'",
    '$p=Get-ItemProperty $k -ErrorAction SilentlyContinue',
    '$b=if($p.CurrentBuild){[int]$p.CurrentBuild}else{[Environment]::OSVersion.Version.Build}',
    "$v=if($p.DisplayVersion){$p.DisplayVersion}else{'unknown'}",
    '"sightline build=$b version=$v interactive=$([Environment]::UserInteractive)"',
  ].join('; ');
}

/** Read windowsProbeCommand's single output line. */
export function parseWindowsProbe(output) {
  const text = String(output || '');
  const build = Number((text.match(/build=(\d+)/) || [])[1] || 0);
  const version = (text.match(/version=(\S+)/) || [])[1] || '';
  const interactive = /interactive=(?:True|true)/.test(text);
  return { build, version, interactive };
}

/**
 * Choose the mechanism that may be used to switch a run live on Windows, and
 * refuse when the session cannot support it. A run is only flipped live when a
 * mechanism is selected, so the switch cannot land on a desktop the console
 * cannot drive (which would interrupt the operator for no result).
 */
export function selectWindowsMechanism({ build = 0, version = '', interactive = false } = {}) {
  if (!interactive) {
    return {
      ok: false,
      mechanism: '',
      reason: 'this process has no interactive desktop session, so live control would drive a screen the operator cannot see',
    };
  }
  if (!(Number(build) >= WINDOWS_MIN_BUILD)) {
    return {
      ok: false,
      mechanism: '',
      reason: `Windows build ${build || 'unknown'} is older than ${WINDOWS_MIN_BUILD}, where the Win32 SendInput path is not supported`,
    };
  }
  return {
    ok: true,
    mechanism: 'powershell+sendinput',
    reason: '',
    label: `Windows ${version && version !== 'unknown' ? version : 'desktop'} (build ${build}), PowerShell + Win32 SendInput`,
  };
}

/**
 * Prove live control with a real action instead of trusting detection.
 *
 * Initial detection reads the process environment (PATH, DISPLAY, forced
 * targets) — any of which can be wrong about a machine that would actually
 * answer. The probe runs each platform's cheapest real command with a short
 * timeout: if it talks back, live control works, whatever the checklists
 * claimed. Used by the engine before converting a run to simulation and as
 * the workaround when a step hits a platform guard mid-run.
 */
export function probeLiveBackend({ timeoutMs = 5000 } = {}) {
  if (probeOverride) return Promise.resolve(probeOverride());
  const platform = process.platform;
  const attempt = (command, args) =>
    new Promise((resolve) => {
      try {
        const child = execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
          resolve(err ? { ok: false, detail: String(err.message || err).slice(0, 200) } : { ok: true, detail: String(stdout || '').trim().slice(0, 80) || 'answered' });
        });
        if (child && child.on) child.on('error', () => {}); // execFile reports through the callback
      } catch (err) {
        resolve({ ok: false, detail: String(err.message || err).slice(0, 200) });
      }
    });
  if (platform === 'win32') {
    // Ask for the OS version and the session, then select the mechanism. The
    // switch to live only happens when both answer as required, so a stale
    // refusal is not undone on a build or session that cannot drive the desktop
    // (which would interrupt the operator without doing any work).
    return attempt('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsProbeCommand()])
      .then((answer) => {
        if (!answer.ok) return { ...answer, mechanism: '' };
        const os = parseWindowsProbe(answer.detail);
        const choice = selectWindowsMechanism(os);
        if (!choice.ok) {
          return { ok: false, detail: `${choice.reason} (probe: ${answer.detail})`, os, mechanism: '' };
        }
        return { ok: true, detail: choice.label, os, mechanism: choice.mechanism };
      });
  }
  if (platform === 'darwin') {
    return attempt('osascript', ['-e', 'return 1']);
  }
  if (platform === 'linux') {
    // xdotool talking back is the actual input proof — DISPLAY may be missing
    // from this process's env while XWayland still serves it.
    return attempt('xdotool', ['getmouselocation']);
  }
  return Promise.resolve({ ok: false, detail: `no live backend for ${platform}` });
}

let probeOverride = null;

/** Tests replace the real probe with a canned answer. */
export function setProbeOverride(fn) {
  probeOverride = fn;
}

/** The refusal messages a platform guard produces at execution time. */
export function isPlatformRefusal(message) {
  return /live control is not implemented|needs an X11 DISPLAY|xdotool on PATH|screenshot tool on PATH|Set SIGHTLINE_TARGET/i.test(String(message || ''));
}

/** What the API and the UI banner report. */
export function liveControl(options) {
  const backend = detectBackend(options);
  return {
    available: backend.available,
    reason: backend.reason,
    backend: backend.id,
    label: backend.label,
    capture: backend.capture,
    input: backend.input,
    captureReady: backend.captureReady !== false,
    inputReady: backend.inputReady !== false,
    mobile: backend.mobile,
    target: backend.target,
  };
}

export { HOST, IS_WINDOWS, LINUX_CAPTURE, LINUX_INPUT };
