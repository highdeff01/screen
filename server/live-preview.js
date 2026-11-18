import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA } from './store.js';

export const MIN_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 10000;
export const DEFAULT_INTERVAL_MS = 2000;
export const PREVIEW_LEASE_MS = 15000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Isolate the existing capture routine: it creates uniquely named files even on
// some failures. A private working directory lets us remove all of them without
// touching captures produced by runs or the live monitor.
async function captureDesktop(dataDir, signal) {
  const work = path.join(dataDir, 'live-preview-work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const moduleUrl = new URL('./automation.js', import.meta.url).href;
    const script = `import { liveScreenshot } from ${JSON.stringify(moduleUrl)}; await liveScreenshot(null);`;
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, ['--input-type=module', '-e', script], {
        cwd: work, windowsHide: true, maxBuffer: 1024 * 1024,
      }, (error) => {
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      });
      const abort = () => {
        // Kill the worker and its PowerShell descendant together on Windows.
        if (process.platform === 'win32' && child.pid) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else child.kill();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const dir = path.join(work, 'data', 'captures');
    const files = fs.readdirSync(dir).filter((name) => /^cap_[a-z0-9]+\.png$/.test(name));
    if (files.length !== 1) throw new Error('Invalid capture');
    const file = path.join(dir, files[0]);
    const size = fs.statSync(file).size;
    if (!size || size > MAX_IMAGE_BYTES) throw new Error('Invalid capture size');
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Opt-in, single-flight, read-only screenshot loop. Dependencies are injectable. */
export function createLivePreview({
  platform = process.platform,
  dataDir = DATA,
  capture = (signal) => captureDesktop(dataDir, signal),
  schedule = setTimeout,
  cancel = clearTimeout,
  clock = () => new Date(),
  monotonic = () => performance.now(),
} = {}) {
  const available = platform === 'win32';
  const imagePath = 'live-preview.png';
  const image = path.join(dataDir, imagePath);
  const temporary = path.join(dataDir, 'live-preview.tmp');
  let running = false;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let capturedAt = null;
  let error = null;
  let hasImage = false;
  let timer = null;
  let leaseTimer = null;
  let leaseDeadline = null;
  let stopReason = null;
  let inFlight = false;
  let controller = null;
  let lastStartedAt = null;
  let generation = 0;

  // A previous process may have exited mid-capture. Never publish stale pixels.
  fs.mkdirSync(dataDir, { recursive: true });
  for (const file of [image, temporary, path.join(dataDir, 'live-preview-work')]) {
    fs.rmSync(file, { recursive: true, force: true });
  }

  function state() {
    expireIfNeeded();
    return { running, available, reason: available ? stopReason : 'Live preview is available only on Windows.', imagePath: hasImage ? imagePath : null, capturedAt, error, intervalMs };
  }
  function expireIfNeeded() {
    if (running && monotonic() >= leaseDeadline) {
      stop('Live preview stopped because the viewer heartbeat timed out.');
      return true;
    }
    return false;
  }
  function scheduleLease() {
    if (leaseTimer !== null) cancel(leaseTimer);
    leaseTimer = schedule(() => {
      leaseTimer = null;
      if (running && !expireIfNeeded()) scheduleLease();
    }, Math.max(0, leaseDeadline - monotonic()));
    leaseTimer?.unref?.();
  }
  function heartbeat() {
    if (running && !expireIfNeeded()) {
      leaseDeadline = monotonic() + PREVIEW_LEASE_MS;
      scheduleLease();
    }
    return state();
  }
  function queue(delay) {
    const rateDelay = lastStartedAt === null ? 0 : Math.max(0, MIN_INTERVAL_MS - (monotonic() - lastStartedAt));
    timer = schedule(() => { timer = null; void tick(); }, Math.max(delay, rateDelay));
    timer?.unref?.();
  }
  async function tick() {
    if (!running || expireIfNeeded() || inFlight) return;
    inFlight = true;
    lastStartedAt = monotonic();
    const current = generation;
    controller = new AbortController();
    try {
      const bytes = await capture(controller.signal);
      if (!running || expireIfNeeded() || current !== generation) return;
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Invalid capture');
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, image);
      hasImage = true;
      capturedAt = clock().toISOString();
      error = null;
    } catch {
      if (running && !expireIfNeeded() && current === generation) {
        running = false;
        if (leaseTimer !== null) cancel(leaseTimer);
        leaseTimer = null;
        leaseDeadline = null;
        error = 'Desktop capture failed. Check the interactive Windows desktop and try again.';
        hasImage = false;
        capturedAt = null;
        fs.rmSync(image, { force: true });
        fs.rmSync(temporary, { force: true });
      }
    } finally {
      controller = null;
      inFlight = false;
      // A stop/start during capture waits for the old operation to finish.
      if (running && !expireIfNeeded()) queue(current === generation ? intervalMs : 0);
    }
  }
  function start(options = {}) {
    if (!available) return state();
    const value = options.intervalMs;
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('intervalMs must be a finite number');
    intervalMs = value === undefined ? DEFAULT_INTERVAL_MS : Math.round(Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, value)));
    expireIfNeeded();
    if (!running) {
      running = true;
      error = null;
      stopReason = null;
      generation++;
      leaseDeadline = monotonic() + PREVIEW_LEASE_MS;
      scheduleLease();
      if (!inFlight) queue(0);
    }
    return state();
  }
  function stop(reason = null) {
    running = false;
    generation++;
    controller?.abort();
    if (timer !== null) cancel(timer);
    if (leaseTimer !== null) cancel(leaseTimer);
    timer = null;
    leaseTimer = null;
    leaseDeadline = null;
    stopReason = reason;
    hasImage = false;
    capturedAt = null;
    error = null;
    fs.rmSync(image, { force: true });
    fs.rmSync(temporary, { force: true });
    return state();
  }
  return { state, start, stop, heartbeat };
}

export const livePreview = createLivePreview();
