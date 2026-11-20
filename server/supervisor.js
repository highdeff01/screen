/**
 * Watch this console itself, so a crash or a vanished project file is a fact
 * somebody can read rather than a silence.
 *
 * Three things happen here:
 *
 *   - A heartbeat is written to data/supervisor.json every few seconds. On the
 *     next start the gap between the last beat and now is reported, which is the
 *     difference between "nobody used it" and "it went away".
 *   - Uncaught exceptions and unhandled rejections are recorded with the last
 *     lines of the run log instead of killing the process. The console keeps
 *     answering and says it is degraded; a person decides what to restart.
 *   - The tracked files this project consists of are listed once and checked
 *     periodically. A file that disappears is reported by path, never restored:
 *     restoring automatically would overwrite whatever replaced it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA, ROOT, now } from './store.js';

const HEARTBEAT = path.join(DATA, 'supervisor.json');
const INCIDENTS = path.join(DATA, 'incidents.ndjson');
const RUN_LOG = path.join(DATA, 'live-run.log');

const state = {
  startedAt: null,
  beatAt: null,
  beats: 0,
  intervalMs: 5000,
  timer: null,
  degraded: false,
  handlersInstalled: false,
  incidents: [],
  trackedFiles: [],
  missingFiles: [],
  lastGap: null,
  scannedAt: null,
  scanMs: 60000,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function logTail(lines = 15) {
  try {
    return fs.readFileSync(RUN_LOG, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Append one incident and keep the newest 50 in memory. */
export function recordIncident({ kind = 'error', message = '', stack = '', root = ROOT, tail = '' } = {}) {
  const entry = {
    at: now(),
    kind,
    message: String(message || '').slice(0, 500),
    stack: String(stack || '').slice(0, 4000),
    tail: String(tail || '').slice(0, 4000),
    pid: process.pid,
  };
  state.incidents.unshift(entry);
  state.incidents = state.incidents.slice(0, 50);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(INCIDENTS, `${JSON.stringify(entry)}\n`);
  } catch {
    // A full or read-only disk must not become the second failure.
  }
  return entry;
}

/** Tracked paths, relative to the project root. */
export function readTrackedFiles({ root = ROOT, run = null } = {}) {
  try {
    const out = run
      ? run(['ls-files'], root)
      : execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return String(out?.stdout ?? out ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Files from the manifest that are no longer on disk. */
export function missingFiles({ root = ROOT, tracked = state.trackedFiles } = {}) {
  const missing = [];
  for (const file of tracked) {
    try {
      if (!fs.existsSync(path.join(root, file))) missing.push(file);
    } catch {
      // An unreadable parent is reported as missing rather than throwing.
      missing.push(file);
    }
  }
  return missing;
}

/** One heartbeat, plus the file check when it is due. */
export function supervisorTick({ root = ROOT, tracked = state.trackedFiles, scan = false } = {}) {
  const beat = {
    pid: process.pid,
    at: now(),
    startedAt: state.startedAt,
    beats: state.beats + 1,
    degraded: state.degraded,
    uptimeMs: Math.round(process.uptime() * 1000),
    rss: process.memoryUsage().rss,
  };
  state.beats = beat.beats;
  state.beatAt = beat.at;
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(HEARTBEAT, `${JSON.stringify(beat, null, 2)}\n`);
  } catch {
    state.degraded = true;
  }
  if (scan) {
    state.scannedAt = beat.at;
    const gone = missingFiles({ root, tracked });
    const fresh = gone.filter((file) => !state.missingFiles.includes(file));
    state.missingFiles = gone;
    for (const file of fresh) {
      recordIncident({
        kind: 'file-missing',
        message: `Tracked file is gone: ${file}`,
        root,
      });
    }
  }
  return beat;
}

function installProcessHandlers() {
  if (state.handlersInstalled) return;
  state.handlersInstalled = true;
  process.on('uncaughtException', (err) => {
    state.degraded = true;
    recordIncident({ kind: 'uncaught-exception', message: err?.message, stack: err?.stack, tail: logTail() });
  });
  process.on('unhandledRejection', (reason) => {
    state.degraded = true;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    recordIncident({ kind: 'unhandled-rejection', message: err.message, stack: err.stack, tail: logTail() });
  });
}

/**
 * Start watching. Resolves to the status right after the first heartbeat, so a
 * caller can see the restart gap immediately.
 */
export function startSupervisor({ intervalMs = 5000, root = ROOT, scanMs = 60000 } = {}) {
  const previous = readJson(HEARTBEAT);
  if (previous?.at) {
    const gapMs = Math.max(0, Date.now() - new Date(previous.at).getTime());
    if (gapMs > intervalMs * 3) {
      state.lastGap = {
        since: previous.at,
        gapMs,
        previousPid: previous.pid ?? null,
        samePid: previous.pid === process.pid,
      };
    }
  }
  state.startedAt = now();
  state.intervalMs = Math.max(1000, Number(intervalMs) || 5000);
  state.scanMs = Math.max(5000, Number(scanMs) || 60000);
  state.trackedFiles = readTrackedFiles({ root });
  installProcessHandlers();
  supervisorTick({ root, scan: true });
  if (state.timer) clearInterval(state.timer);
  let lastScan = Date.now();
  state.timer = setInterval(() => {
    const due = Date.now() - lastScan >= state.scanMs;
    if (due) lastScan = Date.now();
    supervisorTick({ root, scan: due });
  }, state.intervalMs);
  state.timer.unref?.();
  return supervisorStatus();
}

export function stopSupervisor() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return supervisorStatus();
}

export function supervisorStatus() {
  return {
    running: Boolean(state.timer),
    startedAt: state.startedAt,
    beatAt: state.beatAt,
    beats: state.beats,
    intervalMs: state.intervalMs,
    degraded: state.degraded,
    lastGap: state.lastGap,
    trackedFiles: state.trackedFiles.length,
    missingFiles: state.missingFiles.slice(0, 40),
    missingCount: state.missingFiles.length,
    scannedAt: state.scannedAt,
    incidents: state.incidents.slice(0, 12),
    incidentCount: state.incidents.length,
  };
}

export { state as __supervisorState, HEARTBEAT, INCIDENTS };
