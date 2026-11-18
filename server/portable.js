/**
 * Live control for macOS, Linux and Android.
 *
 * Windows steps are still built and run as PowerShell in automation.js; this
 * module is the fallback for every other platform, using the tools detectBackend
 * found. Step params are the same shapes the Windows scripts read, so a workflow
 * written once runs wherever the backend supports it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CAPTURES, DATA, uid } from './store.js';
import {
  adbKeyArgs,
  appleKeyScript,
  captureCommand,
  commandOnPath,
  detectBackend,
  keyChords,
  runCommand,
  xdotoolKeyArgs,
} from './platform.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value, fallback = '') {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : fallback;
}

/** Desktop/mobile backend for this console, cached for a second. */
let cached = null;
export function backend() {
  if (!cached || Date.now() - cached.at > 1000) {
    cached = { at: Date.now(), value: detectBackend() };
  }
  return cached.value;
}

export function liveAvailable() {
  return backend().available;
}

async function adb(args, timeoutMs = 20000) {
  const device = backend();
  const serial = device.mobile ? String(process.env.ANDROID_SERIAL || '').trim() : '';
  const prefixed = serial ? ['-s', serial, ...args] : args;
  const res = await runCommand('adb', prefixed, { timeoutMs });
  if (!res.ok) {
    throw new Error(`adb ${args.join(' ')} failed: ${res.stderr || res.stdout || 'no output'}`);
  }
  return res;
}

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

/** Width/height straight from a PNG's IHDR chunk; no image library needed. */
export function pngSize(buffer) {
  if (!buffer || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function captureToFile(file) {
  const device = backend();
  if (device.mobile) {
    const remote = '/sdcard/sightline-capture.png';
    await adb(['shell', 'screencap', '-p', remote], 30000);
    const pulled = await adb(['pull', remote, file], 30000);
    if (!fs.existsSync(file)) throw new Error(`adb pull did not deliver a screenshot: ${pulled.stderr || pulled.stdout}`);
    return;
  }
  const { cmd, args } = captureCommand(device.id, file);
  const res = await runCommand(cmd, args, { timeoutMs: 30000 });
  if (!res.ok || !fs.existsSync(file)) {
    throw new Error(`Screenshot failed (${cmd}): ${res.stderr || res.stdout || 'no file written'}`);
  }
}

/** Downscale a capture for the vision model where the platform can do it. */
async function shrinkForVision(png, jpg, maxWidth) {
  if (process.platform === 'darwin' && commandOnPath('sips')) {
    const res = await runCommand('sips', ['-Z', String(maxWidth), png, '--out', jpg], { timeoutMs: 15000 });
    if (res.ok && fs.existsSync(jpg)) return true;
  }
  if (commandOnPath('magick') || commandOnPath('convert')) {
    const tool = commandOnPath('magick') ? 'magick' : 'convert';
    const res = await runCommand(tool, [png, '-resize', `${maxWidth}>`, jpg], { timeoutMs: 20000 });
    if (res.ok && fs.existsSync(jpg)) return true;
  }
  return false;
}

/**
 * Same record shape as automation.js liveScreenshot, so every caller (vision
 * verification, evidence, playback checks) works unchanged off Windows.
 */
export async function portableLiveScreenshot(runId, options = {}) {
  const device = backend();
  if (!device.available) throw new Error(device.reason);
  const file = path.join(CAPTURES, `${uid('cap')}.png`);
  fs.mkdirSync(CAPTURES, { recursive: true });
  const started = Date.now();
  await captureToFile(file);

  const maxWidth = Math.max(0, Math.min(4096, Number(options.maxWidth) || 0));
  const png = fs.readFileSync(file);
  const size = pngSize(png) || { width: null, height: null };

  let vision = null;
  if (maxWidth > 0 && size.width) {
    const visionFile = path.join(CAPTURES, `${path.basename(file, '.png')}-vision.jpg`);
    const shrunk = size.width > maxWidth ? await shrinkForVision(file, visionFile, maxWidth) : false;
    const chosen = shrunk ? visionFile : file;
    const scaled = shrunk ? { width: Math.min(maxWidth, size.width), height: Math.round((size.height * Math.min(maxWidth, size.width)) / size.width) } : size;
    vision = {
      path: path.relative(DATA, chosen).split(path.sep).join('/'),
      width: scaled.width,
      height: scaled.height,
      cropX: 0,
      cropY: 0,
      cropWidth: size.width,
      cropHeight: size.height,
      bytes: fs.statSync(chosen).size,
    };
  }

  return {
    path: path.relative(DATA, file).split(path.sep).join('/'),
    simulated: false,
    width: size.width,
    height: size.height,
    signature: createHash('md5').update(png.subarray(0, 8192)).digest('hex').slice(0, 16),
    cropTitle: '',
    vision,
    runId,
    ms: Date.now() - started,
    platform: device.id,
  };
}

/* ------------------------------------------------------------ input actions */

function requireDesktopTool() {
  const device = backend();
  if (!device.available) throw new Error(device.reason);
  return device;
}

/** Move/click/scroll through xdotool, cliclick or adb input. */
async function pointer(command, { timeoutMs = 15000 } = {}) {
  const device = requireDesktopTool();
  if (device.mobile) return adb(['shell', 'input', ...command], timeoutMs);
  if (device.id === 'darwin') {
    if (!commandOnPath('cliclick')) {
      throw new Error(
        'Clicking at screen coordinates on macOS needs cliclick (brew install cliclick). Typing and keys already work without it.'
      );
    }
    const res = await runCommand('cliclick', command, { timeoutMs });
    if (!res.ok) throw new Error(`cliclick failed: ${res.stderr || res.stdout}`);
    return res;
  }
  const tool = commandOnPath('xdotool') ? 'xdotool' : '';
  if (!tool) throw new Error('Linux input needs xdotool on X11 (or ydotool for Wayland), which is not installed.');
  const args = command[0] === 'xdotool' ? command.slice(1) : command;
  const res = await runCommand(tool, args, { timeoutMs });
  if (!res.ok) throw new Error(`xdotool failed: ${res.stderr || res.stdout}`);
  return res;
}

const MOUSE_BUTTON = { left: 1, middle: 2, right: 3 };

export async function portableMove({ x, y }) {
  const device = requireDesktopTool();
  if (device.mobile) return; // A phone has no pointer to park.
  if (device.id === 'darwin') return pointer([`m:${Math.round(x)},${Math.round(y)}`]);
  return pointer(['xdotool', 'mousemove', String(Math.round(x)), String(Math.round(y))]);
}

export async function portableClick({ x, y, button = 'left', clicks = 1, double = false }) {
  const device = requireDesktopTool();
  const times = double ? 2 : Math.max(1, Math.min(2, Number(clicks) || 1));
  if (device.mobile) return adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  if (device.id === 'darwin') {
    const prefix = button === 'right' ? 'rc' : 'c';
    for (let i = 0; i < times; i++) {
      await pointer([`${prefix}:${Math.round(x)},${Math.round(y)}`]);
      if (i < times - 1) await sleep(90);
    }
    return;
  }
  const index = MOUSE_BUTTON[button] || 1;
  await pointer(['xdotool', 'mousemove', String(Math.round(x)), String(Math.round(y))]);
  await pointer(['xdotool', 'click', '--repeat', String(times), '--delay', '90', String(index)]);
}

export async function portableDrag({ x1, y1, x2, y2, button = 'left', durationMs = 600 }) {
  const device = requireDesktopTool();
  if (device.mobile) {
    return adb([
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(Math.max(50, Math.round(durationMs))),
    ]);
  }
  if (device.id === 'darwin') {
    return pointer(['dd:' + `${Math.round(x1)},${Math.round(y1)}`, 'dm:' + `${Math.round(x2)},${Math.round(y2)}`, 'du:' + `${Math.round(x2)},${Math.round(y2)}`]);
  }
  const index = MOUSE_BUTTON[button] || 1;
  await pointer(['xdotool', 'mousemove', String(Math.round(x1)), String(Math.round(y1))]);
  await pointer(['xdotool', 'mousedown', String(index)]);
  await sleep(80);
  await pointer(['xdotool', 'mousemove', '--sync', String(Math.round(x2)), String(Math.round(y2))]);
  await pointer(['xdotool', 'mouseup', String(index)]);
}

export async function portableScroll({ x, y, amount = 3 }) {
  const device = requireDesktopTool();
  const ticks = Math.max(1, Math.min(30, Math.abs(Math.round(amount))));
  if (device.mobile) {
    // Swipe the content the other way to scroll down.
    const cx = x == null ? 540 : Math.round(x);
    const cy = y == null ? 900 : Math.round(y);
    const delta = amount > 0 ? -320 : 320;
    return adb(['shell', 'input', 'swipe', String(cx), String(cy), String(cx), String(cy + delta), '250']);
  }
  if (device.id === 'darwin') {
    return pointer(Array.from({ length: ticks }, () => `w:${amount > 0 ? -1 : 1}`));
  }
  if (x != null && y != null) {
    await pointer(['xdotool', 'mousemove', String(Math.round(x)), String(Math.round(y))]);
  }
  const button = amount > 0 ? 5 : 4;
  for (let i = 0; i < ticks; i++) await pointer(['xdotool', 'click', String(button)]);
}

export async function portableType(text) {
  const device = requireDesktopTool();
  const value = String(text ?? '');
  if (device.mobile) {
    if (!/^[\x20-\x7e\n\t]*$/.test(value)) {
      throw new Error('Android typing over adb only accepts printable ASCII; use a browser field or the clipboard instead.');
    }
    const escaped = value.replace(/\n/g, '\n').replace(/ /g, '%s').replace(/'/g, "'\\''");
    return adb(['shell', 'input', 'text', escaped]);
  }
  if (device.id === 'darwin') {
    const chunks = value.split('\n');
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i]) {
        const escaped = chunks[i].replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const res = await runCommand('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
        if (!res.ok) throw new Error(`osascript keystroke failed: ${res.stderr || res.stdout}`);
      }
      if (i < chunks.length - 1) await runCommand('osascript', ['-e', 'tell application "System Events" to key code 36']);
    }
    return;
  }
  const tool = commandOnPath('xdotool') ? 'xdotool' : commandOnPath('ydotool') ? 'ydotool' : '';
  if (!tool) throw new Error('Linux typing needs xdotool (X11) or ydotool (Wayland), which is not installed.');
  const res =
    tool === 'xdotool'
      ? await runCommand('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', value], { timeoutMs: 60000 })
      : await runCommand('ydotool', ['type', '--', value], { timeoutMs: 60000 });
  if (!res.ok) throw new Error(`${tool} type failed: ${res.stderr || res.stdout}`);
}

export async function portableKeys(keys) {
  const device = requireDesktopTool();
  const chords = keyChords(keys);
  if (!chords.length) throw new Error('Key step needs at least one shortcut, e.g. ctrl+a.');
  for (const chord of chords) {
    if (device.mobile) {
      await adb(adbKeyArgs(chord));
      continue;
    }
    if (device.id === 'darwin') {
      const res = await runCommand('osascript', ['-e', appleKeyScript(chord)]);
      if (!res.ok) throw new Error(`osascript key ${chord} failed: ${res.stderr || res.stdout}`);
      continue;
    }
    const tool = commandOnPath('xdotool') ? 'xdotool' : '';
    if (!tool) throw new Error('Linux keys need xdotool, which is not installed.');
    const res = await runCommand('xdotool', xdotoolKeyArgs(chord));
    if (!res.ok) throw new Error(`xdotool key ${chord} failed: ${res.stderr || res.stdout}`);
  }
  return chords;
}

/* --------------------------------------------------------- windows and apps */

/** Foreground window as { title, process, id } — used by expectations/logs. */
export async function portableForeground() {
  const device = backend();
  if (!device.available || device.mobile) return { title: '', process: '', id: null };
  if (device.id === 'darwin') {
    const script =
      'tell application "System Events" to set p to first process whose frontmost is true\n' +
      'tell application "System Events" to tell p to set t to name of front window\n' +
      'return (name of p) & "\u0001" & t';
    const res = await runCommand('osascript', ['-e', script]);
    if (!res.ok) return { title: '', process: '', id: null };
    const [proc, title] = String(res.stdout).split('\u0001');
    return { title: String(title || '').trim(), process: String(proc || '').trim(), id: null };
  }
  const res = await runCommand('xdotool', ['getactivewindow', 'getwindowname']);
  const idRes = await runCommand('xdotool', ['getactivewindow']);
  return {
    title: res.ok ? String(res.stdout).trim() : '',
    process: '',
    id: idRes.ok ? Number(String(idRes.stdout).trim()) || null : null,
  };
}

function appleWindowScript(title, body) {
  const safe = String(title).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "System Events"
  set hits to {}
  repeat with p in (every process whose background only is false)
    repeat with w in (every window of p)
      try
        if (${safe ? `(name of w as text) contains "${safe}"` : 'true'}) then set end of hits to w
      end try
    end repeat
  end repeat
  if (count of hits) is 0 then error "No window matched"
  set target to item 1 of hits
  ${body}
end tell`;
}

/** Bring a window to the front by title (or by process when no title is given). */
export async function portableFocusWindow({ title = '', process: processName = '' } = {}) {
  const device = requireDesktopTool();
  const needle = String(title || processName || '').trim();
  if (device.mobile) {
    const pkg = String(processName || '').trim();
    if (!pkg) return { ok: true, detail: 'A phone has one foreground app; nothing to focus.' };
    await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    return { ok: true, detail: `Launched ${pkg}` };
  }
  if (!needle) return { ok: true, detail: 'No window named; leaving focus alone.' };
  if (device.id === 'darwin') {
    const res = await runCommand('osascript', ['-e', appleWindowScript(needle, 'set frontmost of p to true')]);
    if (!res.ok) throw new Error(`Could not focus a window matching "${needle}": ${res.stderr || res.stdout}`);
    return { ok: true, detail: `Focused "${needle}"` };
  }
  const search = await runCommand('xdotool', ['search', '--onlyvisible', '--name', needle]);
  let ids = String(search.stdout).split(/\s+/).filter(Boolean);
  if (!ids.length) {
    const byClass = await runCommand('xdotool', ['search', '--onlyvisible', '--class', needle]);
    ids = String(byClass.stdout).split(/\s+/).filter(Boolean);
  }
  if (!ids.length) throw new Error(`No visible window matched "${needle}".`);
  const res = await runCommand('xdotool', ['windowactivate', '--sync', ids[0]]);
  if (!res.ok) throw new Error(`xdotool could not activate window ${ids[0]}: ${res.stderr || res.stdout}`);
  return { ok: true, detail: `Focused "${needle}"`, id: Number(ids[0]) };
}

export async function portableWindowAction({ title = '', process: processName = '', action = 'minimize' }) {
  const device = requireDesktopTool();
  const needle = String(title || processName || '').trim();
  if (device.mobile) {
    const pkg = String(processName || '').trim();
    if (!pkg) throw new Error('Android needs a package name to act on an app.');
    if (action === 'close') await adb(['shell', 'am', 'force-stop', pkg]);
    else await adb(['shell', 'am', 'start', pkg]);
    return { ok: true, detail: `${action} ${pkg}` };
  }
  if (!needle) throw new Error(`Window action "${action}" needs a title or process.`);
  if (device.id === 'darwin') {
    const body =
      action === 'close'
        ? 'click (first button of target whose subrole is "AXCloseButton")'
        : action === 'minimize'
          ? 'set value of attribute "AXMinimized" of target to true'
          : 'perform action "AXRaise" of target';
    const res = await runCommand('osascript', ['-e', appleWindowScript(needle, body)]);
    if (!res.ok) throw new Error(`Could not ${action} "${needle}": ${res.stderr || res.stdout}`);
    return { ok: true, detail: `${action} ${needle}` };
  }
  const search = await runCommand('xdotool', ['search', '--onlyvisible', '--name', needle]);
  const id = String(search.stdout).split(/\s+/).filter(Boolean)[0];
  if (!id) throw new Error(`No visible window matched "${needle}".`);
  const command =
    action === 'close'
      ? ['windowclose', id]
      : action === 'minimize'
        ? ['windowminimize', id]
        : ['windowactivate', '--sync', id];
  const res = await runCommand('xdotool', command);
  if (!res.ok) throw new Error(`xdotool could not ${action} "${needle}": ${res.stderr || res.stdout}`);
  return { ok: true, detail: `${action} ${needle}`, id: Number(id) };
}

export async function portableLaunch({ target = '', args = [] } = {}) {
  const device = requireDesktopTool();
  const value = String(target || '').trim();
  if (!value) throw new Error('Launch app step needs a target app name, executable or document path.');
  if (device.mobile) {
    await adb(['shell', 'monkey', '-p', value, '-c', 'android.intent.category.LAUNCHER', '1']);
    return { ok: true, detail: `Launched ${value}` };
  }
  const isUrl = /^https?:\/\//i.test(value);
  if (device.id === 'darwin') {
    const res = await runCommand('open', isUrl ? [value] : ['-a', value, ...args], { timeoutMs: 20000 });
    if (res.ok) return { ok: true, detail: `Opened ${value}` };
    const fallback = await runCommand('open', [value, ...args]);
    if (!fallback.ok) throw new Error(`Could not open "${value}": ${fallback.stderr || fallback.stdout}`);
    return { ok: true, detail: `Opened ${value}` };
  }
  if (isUrl) {
    spawnDetached('xdg-open', [value]);
    return { ok: true, detail: `Opened ${value}` };
  }
  if (fs.existsSync(value)) {
    spawnDetached(value, args);
    return { ok: true, detail: `Launched ${value}` };
  }
  spawnDetached('xdg-open', [value]);
  return { ok: true, detail: `Asked the desktop to open ${value}` };
}

export async function portableWindowPresent({ title = '', mode = 'present' } = {}) {
  const device = backend();
  const needle = String(title || '').toLowerCase();
  if (!needle) return { present: false, detail: 'No window title to look for.' };
  let titles = [];
  if (device.mobile) {
    const res = await adb(['shell', 'dumpsys', 'window']);
    const match = String(res.stdout).match(/mCurrentFocus=Window\{[^}]*\s([^\s}]+)\}/);
    titles = match ? [match[1]] : [];
  } else if (device.id === 'darwin') {
    const script = 'tell application "System Events" to get name of every window of (every process whose background only is false)';
    const res = await runCommand('osascript', ['-e', script]);
    titles = String(res.stdout).split(',').map((entry) => entry.trim());
  } else if (device.available) {
    const ids = await runCommand('xdotool', ['search', '--onlyvisible', '--name', '.+']);
    const list = String(ids.stdout).split(/\s+/).filter(Boolean).slice(0, 60);
    for (const id of list) {
      const name = await runCommand('xdotool', ['getwindowname', id]);
      if (name.ok && String(name.stdout).trim()) titles.push(String(name.stdout).trim());
    }
  }
  const present = titles.some((entry) => entry.toLowerCase().includes(needle));
  return { present, detail: `${mode} "${title}": ${present ? 'found' : 'not found'}` };
}

/* --------------------------------------------------------------- step runner */

/**
 * Execute one step on a non-Windows backend. Params mirror the Windows scripts.
 * Unsupported types fail with a specific message instead of a wrong action.
 */
export async function executePortableStep(step, ctx = {}) {
  const device = backend();
  if (!device.available) throw new Error(device.reason);
  const p = step.params || {};
  const live = Boolean(ctx.live);

  switch (step.type) {
    case 'move':
      if (!live) return { output: `Simulated: move to ${num(p.x)},${num(p.y)}.`, evidence: [] };
      await portableMove({ x: num(p.x), y: num(p.y) });
      return { output: `Moved the pointer to ${num(p.x)},${num(p.y)} (${device.label}).`, evidence: [] };

    case 'click':
    case 'doubleClick':
    case 'rightClick': {
      if (!live) return { output: `Simulated: ${step.type}.`, evidence: [] };
      const button = step.type === 'rightClick' ? 'right' : str(p.button, 'left');
      await portableClick({ x: num(p.x), y: num(p.y), button, double: step.type === 'doubleClick' });
      return { output: `Clicked ${button} at ${num(p.x)},${num(p.y)} (${device.label}).`, evidence: [] };
    }

    case 'drag': {
      if (!live) return { output: 'Simulated: drag.', evidence: [] };
      const x1 = num(p.x1 ?? p.x);
      const y1 = num(p.y1 ?? p.y);
      const x2 = num(p.x2 ?? x1, x1);
      const y2 = num(p.y2 ?? y1, y1);
      await portableDrag({ x1, y1, x2, y2, button: str(p.button, 'left'), durationMs: num(p.durationMs, 600) });
      return { output: `Dragged ${x1},${y1} to ${x2},${y2} (${device.label}).`, evidence: [] };
    }

    case 'scroll':
      if (!live) return { output: 'Simulated: scroll.', evidence: [] };
      await portableScroll({ x: p.x, y: p.y, amount: num(p.amount, 3) });
      return { output: `Scrolled ${num(p.amount, 3)} steps (${device.label}).`, evidence: [] };

    case 'type': {
      if (!live) return { output: 'Simulated: type.', evidence: [] };
      await portableType(str(p.text));
      return { output: `Typed ${String(p.text || '').length} characters (${device.label}).`, evidence: [] };
    }

    case 'key': {
      if (!live) return { output: 'Simulated: key press.', evidence: [] };
      const chords = await portableKeys(p.keys);
      const repeat = Math.max(1, Math.min(50, num(p.repeat, 1)));
      for (let i = 1; i < repeat; i++) {
        await sleep(Math.max(30, num(p.intervalMs, 120)));
        await portableKeys(p.keys);
      }
      return { output: `Sent ${repeat}x ${chords.join(', ')} (${device.label}).`, evidence: [] };
    }

    case 'wait': {
      const ms = Math.max(0, Math.min(600000, num(p.ms, 1000)));
      await sleep(ms);
      return { output: `Waited ${ms}ms.`, evidence: [] };
    }

    case 'waitFor': {
      const deadline = Date.now() + Math.max(500, Math.min(600000, num(p.timeoutMs, 15000)));
      const mode = str(p.mode, 'present').toLowerCase();
      let last = null;
      while (Date.now() < deadline) {
        last = await portableWindowPresent({ title: str(p.value || p.title), mode });
        const satisfied = mode === 'absent' ? !last.present : last.present;
        if (satisfied) return { output: `${p.value} is ${mode}.`, evidence: [] };
        await sleep(400);
      }
      throw new Error(
        `Waited ${Math.round((num(p.timeoutMs, 15000)) / 1000)}s for window "${p.value}" to be ${mode}; ${last?.detail || 'not seen'}.`
      );
    }

    case 'focusWindow': {
      const result = await portableFocusWindow({ title: str(p.title || p.windowName || p.windowTitle), process: str(p.process) });
      return { output: result.detail, evidence: [], appContext: await portableForeground() };
    }

    case 'windowAction': {
      const result = await portableWindowAction({
        title: str(p.title),
        process: str(p.process),
        action: str(p.action, 'minimize').toLowerCase(),
      });
      return { output: result.detail, evidence: [] };
    }

    case 'launchApp': {
      const result = await portableLaunch({ target: str(p.target), args: Array.isArray(p.args) ? p.args : p.args ? [p.args] : [] });
      return { output: result.detail, evidence: [] };
    }

    case 'openUrl': {
      if (!live) return { output: `Simulated: open ${p.url}.`, evidence: [] };
      const result = await portableLaunch({ target: str(p.url), args: [] });
      return { output: result.detail, evidence: [] };
    }

    case 'closeWindow': {
      const result = await portableWindowAction({ title: str(p.title, 'YouTube'), action: 'close' });
      return { output: result.detail, evidence: [] };
    }

    case 'expect': {
      const kind = str(p.kind).toLowerCase();
      if (kind !== 'window' && kind !== 'foreground') {
        throw new Error(`Expect "${kind || 'value'}" is not supported by the ${device.label} backend yet.`);
      }
      const state = await portableWindowPresent({ title: str(p.value), mode: str(p.mode, 'present') });
      const ok = str(p.mode, 'present').toLowerCase() === 'absent' ? !state.present : state.present;
      if (!ok) throw new Error(`Expected window "${p.value}" to be ${str(p.mode, 'present')}, but ${state.detail}.`);
      return { output: state.detail, evidence: [] };
    }

    default:
      throw new Error(
        `Step type "${step.type}" is not supported by the ${device.label} backend. Supported: move, click, doubleClick, rightClick, drag, scroll, type, key, wait, waitFor, focusWindow, windowAction, launchApp, openUrl, closeWindow, expect (window).`
      );
  }
}
