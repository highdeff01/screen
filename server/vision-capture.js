/**
 * A capture built for a stream, not for a step.
 *
 * `liveScreenshot` is the honest one-shot: it compiles its input helper, takes
 * the virtual screen at full resolution, writes a PNG and, for vision calls, a
 * second downscaled JPEG. That is the right cost once per step. Run in a loop it
 * is the wrong cost every 250 ms — measured on this workstation it managed 0.4
 * frames a second, so a "4 fps" stream was really a slideshow with a promise.
 *
 * This module is the same desktop, cheaper to ask: no compiled C# helper, no
 * second file, and the frame is downscaled before it is encoded, because a PNG
 * of a 3969-pixel desktop is mostly encoding time. What comes back is a single
 * file the vision engine reads and then removes.
 *
 * The frame is still a real capture of the real desktop: nothing here is
 * inferred, cropped or synthesised.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { DATA } from './store.js';

export const RAW_DIR = 'vision-raw';
export const MAX_WIDTH = 1600;
const TIMEOUT_MS = 15000;

const PS = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

/** The capture itself. Kept as a function so the shape can be asserted. */
export function visionCaptureScript(file, { maxWidth = MAX_WIDTH } = {}) {
  const limit = Math.max(320, Math.min(3840, Math.round(Number(maxWidth) || MAX_WIDTH)));
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($b.Width -lt 1 -or $b.Height -lt 1) { throw 'The desktop reported no area to capture.' }
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
try {
  $g = [System.Drawing.Graphics]::FromImage($full)
  try { $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size) } finally { $g.Dispose() }
  # Downscale before encoding: the decoder only needs enough pixels to see what
  # moved, and a smaller PNG is most of the saving.
  if ($b.Width -gt ${limit}) {
    $w = ${limit}
    $h = [int][Math]::Round($b.Height * (${limit} / $b.Width))
    if ($h -lt 1) { $h = 1 }
    $small = New-Object System.Drawing.Bitmap $w, $h
    try {
      $sg = [System.Drawing.Graphics]::FromImage($small)
      try {
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
        $sg.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle 0, 0, $b.Width, $b.Height), [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $sg.Dispose() }
      $small.Save(${JSON.stringify(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $small.Dispose() }
  } else {
    $full.Save(${JSON.stringify(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} finally { $full.Dispose() }
Write-Output 'captured'`;
}

/**
 * One frame, ready for the engine. Returns `{ path }` relative to `dataDir`, the
 * same contract `liveScreenshot` gives, and marks a failure `unreadable`: a
 * screen that cannot be read is not a screen that stayed still.
 */
export async function captureVisionFrame({
  dataDir = DATA,
  maxWidth = MAX_WIDTH,
  execute = execFile,
  platform = process.platform,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (platform !== 'win32') {
    throw Object.assign(new Error('The vision engine reads the desktop only on Windows.'), { unreadable: true });
  }
  const dir = path.join(dataDir, RAW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = `shot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.png`;
  const file = path.join(dir, name);
  try {
    await new Promise((resolve, reject) => {
      execute(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', visionCaptureScript(file, { maxWidth })],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message || '').replace(/\s+/g, ' ').trim().slice(0, 240);
            reject(Object.assign(new Error(`Screen capture failed: ${detail || 'no reason given'}`), { unreadable: true }));
            return;
          }
          resolve();
        }
      );
    });
    const size = fs.statSync(file).size;
    if (!size) throw Object.assign(new Error('The capture was empty.'), { unreadable: true });
    return { path: path.relative(dataDir, file).split(path.sep).join('/'), bytes: size };
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
}

/** A PowerShell single-quoted literal: no interpolation, quotes doubled. */
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * The worker's loop. It loads the two assemblies once, then captures on each
 * line it reads from stdin — lockstep with the caller, so a slow reader can
 * never make it pile up frames nobody asked for.
 */
export function captureStreamScript({ dir, maxWidth = MAX_WIDTH } = {}) {
  const limit = Math.max(320, Math.min(3840, Math.round(Number(maxWidth) || MAX_WIDTH)));
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dir = ${psLiteral(dir)}
$limit = ${limit}
$n = 0
while ($null -ne [Console]::In.ReadLine()) {
  try {
    $n++
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if ($b.Width -lt 1 -or $b.Height -lt 1) { throw 'The desktop reported no area to capture.' }
    $full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    try {
      $g = [System.Drawing.Graphics]::FromImage($full)
      try { $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size) } finally { $g.Dispose() }
      $file = Join-Path $dir ("shot_$n.png")
      if ($b.Width -gt $limit) {
        $w = $limit
        $h = [int][Math]::Round($b.Height * ($limit / $b.Width))
        if ($h -lt 1) { $h = 1 }
        $small = New-Object System.Drawing.Bitmap $w, $h
        try {
          $sg = [System.Drawing.Graphics]::FromImage($small)
          try {
            $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
            $sg.DrawImage($full, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle 0, 0, $b.Width, $b.Height), [System.Drawing.GraphicsUnit]::Pixel)
          } finally { $sg.Dispose() }
          $small.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $small.Dispose() }
      } else {
        $full.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
      }
    } finally { $full.Dispose() }
    Write-Output ("OK " + $file)
  } catch {
    Write-Output ("ERR " + $_.Exception.Message)
  }
}`;
}

/**
 * A warm capture worker.
 *
 * Measured on this workstation, one frame through a fresh PowerShell costs
 * 1.1–2.6 s, and 1.6 s of that is loading System.Windows.Forms and
 * System.Drawing — a cost paid per frame by `captureVisionFrame`. This keeps one
 * process alive and asks it for a frame per line on stdin, so that cost is paid
 * once. `next()` is the request: it resolves with the frame that answers it and
 * nothing else, which is why a timed-out worker is thrown away rather than
 * trusted to a later answer.
 */
export function createCaptureStream({
  dataDir = DATA,
  maxWidth = MAX_WIDTH,
  spawnProcess = spawn,
  platform = process.platform,
  timeoutMs = 8000,
} = {}) {
  let child = null;
  let dir = null;
  let buffer = '';
  let waiters = [];
  let failure = '';

  const settle = (waiter, fn, value) => {
    clearTimeout(waiter.timer);
    fn(value);
  };
  const fail = (message) => Object.assign(new Error(message), { unreadable: true });

  function handleLine(line) {
    const text = line.trim();
    if (!text) return;
    const waiter = waiters.shift();
    // No one is waiting: a line that arrives late answers an abandoned request
    // and must be dropped, or every later frame would be one behind.
    if (!waiter) return;
    if (text.startsWith('ERR')) {
      settle(waiter, waiter.reject, fail(`Screen capture failed: ${text.slice(3).trim().slice(0, 240)}`));
      return;
    }
    if (!text.startsWith('OK ')) {
      settle(waiter, waiter.reject, fail(`The capture worker said: ${text.slice(0, 200)}`));
      return;
    }
    const file = text.slice(3).trim();
    settle(waiter, waiter.resolve, { path: path.relative(dataDir, file).split(path.sep).join('/') });
  }

  function start() {
    if (child) return;
    if (platform !== 'win32') throw fail('The vision engine reads the desktop only on Windows.');
    dir = path.join(dataDir, 'vision-worker');
    // A console that was killed outright never runs its shutdown, so its worker
    // would idle here forever. The pid it left behind is how the next stream
    // finds that process and stops it before starting its own.
    try {
      const stale = Number(fs.readFileSync(path.join(dir, 'worker.pid'), 'utf8').trim());
      if (Number.isFinite(stale) && stale > 0) {
        const killer = spawnProcess('taskkill', ['/PID', String(stale), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
        killer.unref?.();
      }
    } catch {
      // No previous worker, which is the normal first start.
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'capture.ps1');
    fs.writeFileSync(script, captureStreamScript({ dir, maxWidth }), 'utf8');
    child = spawnProcess(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Written only once the process exists, so a crash before this point leaves
    // nothing to mis-kill on the next start.
    try { fs.writeFileSync(path.join(dir, 'worker.pid'), String(child.pid || '')); } catch { /* a missing pid only costs a reap */ }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = String(chunk).replace(/\s+/g, ' ').trim();
      if (message) failure = message.slice(0, 240);
    });
    const gone = (code) => {
      child = null;
      if (!failure) failure = `The capture worker stopped${code ? ` (code ${code})` : ''}.`;
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) settle(waiter, waiter.reject, fail(failure));
    };
    child.on('exit', gone);
    child.on('error', (err) => {
      failure = String(err?.message || err).slice(0, 240);
      gone(0);
    });
  }

  async function next() {
    if (!child) {
      // A worker that died, timed out or answered badly is replaced on the next
      // request. How many failures in a row are too many is the caller's call,
      // not this module's: a stream that refuses to restart is a dead stream.
      failure = '';
      start();
    }
    if (!child) throw fail('The capture worker is not running.');
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters = waiters.filter((entry) => entry !== waiter);
        reject(fail(`The capture worker did not answer within ${timeoutMs} ms.`));
        stop();
        failure = `The capture worker did not answer within ${timeoutMs} ms.`;
      }, timeoutMs);
      waiter.timer.unref?.();
      waiters.push(waiter);
      try {
        child.stdin.write('\n');
      } catch (err) {
        waiters = waiters.filter((entry) => entry !== waiter);
        clearTimeout(waiter.timer);
        reject(fail(String(err?.message || err)));
      }
    });
  }

  function stop() {
    const current = child;
    child = null;
    failure = '';
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) settle(waiter, waiter.reject, fail('The capture worker was stopped.'));
    if (current) {
      try { current.stdin.end(); } catch { /* already closed */ }
      try { current.kill(); } catch { /* already gone */ }
      // Windows keeps the child's tree alive after a plain kill(); taskkill /T
      // is what stops the PowerShell host this actually runs in.
      if (platform === 'win32' && current.pid) {
        try {
          const killer = spawnProcess('taskkill', ['/PID', String(current.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => {});
          killer.unref?.();
        } catch { /* nothing left to stop */ }
      }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  }

  return { next, stop, state: () => ({ running: Boolean(child), failure }) };
}
