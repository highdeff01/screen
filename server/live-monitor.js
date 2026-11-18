/**
 * Fast background desktop monitor.
 *
 * A run only sees the screen at its own step boundaries, which makes the
 * console feel blind between steps and slow to react to a dialog that appeared
 * 300 ms ago. This module keeps one lightweight PowerShell watcher process that
 * polls the foreground window and prints a line only when it changes, so the
 * console can render the active window immediately, capture it for evidence and
 * offer the next sub-steps while the operator (or a run) is still deciding.
 *
 * The watcher is read-only: it never focuses, clicks or types. Captures are
 * throttled so a busy desktop cannot flood the capture folder.
 */

import { spawn } from 'node:child_process';
import { CAPTURES, now } from './store.js';
import { liveScreenshot } from './automation.js';

const IS_WINDOWS = process.platform === 'win32';
const PS = IS_WINDOWS ? 'powershell.exe' : 'pwsh';
const MAX_EVENTS = 80;

const runtime = {
  child: null,
  running: false,
  startedAt: null,
  stoppedAt: null,
  intervalMs: 500,
  capture: true,
  captureMinMs: 1200,
  lastCaptureAt: 0,
  capturing: false,
  current: null,
  events: [],
  errors: [],
  buffer: '',
  pid: null,
};

const clip = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const DIALOG = /\b(?:save as|open file|open|confirm|are you sure|install|setup|download|security warning|user account control|options|properties|print|select)\b/i;
const BROWSER = /^(?:chrome|msedge|firefox|brave|opera|vivaldi)$/i;
const EDITOR = /^(?:notepad|code|notepad\+\+|wordpad|sublime_text)$/i;

/**
 * Steps worth adding right now, derived only from what visibly changed. These
 * are suggestions for the operator/planner, never automatic input.
 */
export function suggestSubSteps(event = {}, previous = null) {
  const title = String(event.title || '').trim();
  const process = String(event.process || '').trim();
  const guard = title ? { foreground: title } : process ? { foreground: process } : {};
  const out = [];
  const add = (type, name, params, why) => out.push({ type, name, params, why });
  const previousTitle = String(previous?.title || '').trim();
  const previousProcess = String(previous?.process || '').trim();

  if (!previous) {
    if (title) {
      add('verifyScreen', `Confirm ${title} is ready`, { question: `Is “${title}” fully loaded and ready for input, with no modal dialog or spinner covering it?`, title }, 'Establish what is on screen before adding input steps.');
    }
    add('screenshot', title ? `Capture ${title}` : 'Capture the desktop', { caption: `Live watch: ${title || 'desktop'}` }, 'Evidence for the state that just appeared.');
    return out.slice(0, 3);
  }

  if (DIALOG.test(title) || /^#32770$/.test(String(event.className || ''))) {
    add('screenshot', `Capture the ${clip(title || 'dialog', 40)} dialog`, { caption: `Dialog: ${title || process || 'unknown'}` }, 'A dialog needs a fresh capture before any click; guessed coordinates are the usual failure here.');
    add('verifyScreen', 'Read the dialog before acting', { question: `Which controls are visible in “${title || 'this dialog'}”, and what do they ask for?`, title }, 'Read the real button labels from pixels instead of guessing them.');
  }
  if (process && process !== previousProcess) {
    add('waitFor', `Wait for ${title || process}`, { kind: 'window', value: title || process, mode: 'present', timeoutMs: 8000 }, `${process} took the foreground, so a window-presence guard is cheap and removes a race.`);
  }
  if (title && title !== previousTitle) {
    add('focusWindow', `Focus ${clip(title, 60)}`, title ? { title } : { process }, 'Re-focus is safer than assuming focus stayed put between steps.');
  }
  if (BROWSER.test(process) && title && title !== previousTitle) {
    add('copyLink', 'Copy the new page link', { outputVar: 'observedLink' }, 'A changed browser title is a new page; keeping its URL makes the next step reproducible.');
  }
  if (EDITOR.test(process) && title && title !== previousTitle) {
    add('verifyScreen', `Check ${clip(title, 50)} content`, { question: `Does “${title}” show the expected content with the caret ready in the document?`, title }, 'Editors change their title as soon as a document opens; confirm the document, not just the window.');
  }
  if (!out.length) {
    add('screenshot', 'Capture the new foreground', { caption: `Foreground changed to ${title || process || 'another window'}` }, 'The desktop changed; a capture keeps the run log honest.');
  }
  return out.slice(0, 4);
}

function pushEvent(record) {
  runtime.events.unshift(record);
  runtime.events = runtime.events.slice(0, MAX_EVENTS);
}

function watcherScript(intervalMs) {
  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class SightlineWatch {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$last = [IntPtr]::Zero
while ($true) {
  $handle = [SightlineWatch]::GetForegroundWindow()
  if ($handle -ne $last) {
    $last = $handle
    $title = New-Object System.Text.StringBuilder 512
    [void][SightlineWatch]::GetWindowText($handle, $title, $title.Capacity)
    $class = New-Object System.Text.StringBuilder 256
    [void][SightlineWatch]::GetClassName($handle, $class, $class.Capacity)
    [uint32]$procId = 0
    [void][SightlineWatch]::GetWindowThreadProcessId($handle, [ref]$procId)
    $procName = ''
    try { $procName = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
    $payload = [pscustomobject]@{
      handle = $handle.ToInt64()
      title = [string]$title
      className = [string]$class
      process = $procName
      pid = [int]$procId
    } | ConvertTo-Json -Compress
    Write-Output $payload
  }
  Start-Sleep -Milliseconds ${Math.max(200, Math.min(5000, Number(intervalMs) || 500))}
}`;
}

function handleSnapshot(payload) {
  const previous = runtime.current;
  const event = {
    at: now(),
    handle: Number(payload.handle) || 0,
    title: String(payload.title || '').trim(),
    process: String(payload.process || '').trim(),
    className: String(payload.className || '').trim(),
    pid: Number(payload.pid) || 0,
    capture: null,
    suggestions: suggestSubSteps(payload, previous),
  };
  runtime.current = event;
  pushEvent({ ...event, suggestions: event.suggestions });
  if (runtime.capture) captureFor(event);
}

async function captureFor(event) {
  if (!IS_WINDOWS || runtime.capturing) return;
  const wait = runtime.lastCaptureAt + runtime.captureMinMs - Date.now();
  if (wait > 0) return;
  runtime.capturing = true;
  try {
    const shot = await liveScreenshot(null);
    runtime.lastCaptureAt = Date.now();
    event.capture = shot?.path || null;
    const stored = runtime.events[0];
    if (stored && stored.at === event.at) stored.capture = event.capture;
  } catch (err) {
    runtime.errors.unshift({ at: now(), message: clip(err.message || err, 200) });
    runtime.errors = runtime.errors.slice(0, 20);
  } finally {
    runtime.capturing = false;
  }
}

/** Start (or restart) the watcher. Safe to call twice. */
export function startLiveMonitor({ intervalMs = 500, capture = true, captureMinMs = 1200 } = {}) {
  if (!IS_WINDOWS) {
    return { ...monitorState(), running: false, error: 'Live monitoring is Windows-only.' };
  }
  stopLiveMonitor();
  runtime.intervalMs = Math.max(200, Math.min(5000, Number(intervalMs) || 500));
  runtime.capture = capture !== false;
  runtime.captureMinMs = Math.max(400, Math.min(10000, Number(captureMinMs) || 1200));
  runtime.buffer = '';
  runtime.startedAt = now();
  runtime.stoppedAt = null;
  runtime.errors = [];
  runtime.events = [];
  runtime.current = null;
  try {
    const child = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', watcherScript(runtime.intervalMs)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    runtime.child = child;
    runtime.running = true;
    runtime.pid = child.pid || null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      runtime.buffer += chunk;
      const lines = runtime.buffer.split(/\r?\n/);
      runtime.buffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text.startsWith('{') || !text.endsWith('}')) continue;
        try {
          handleSnapshot(JSON.parse(text));
        } catch {
          // A partial or noisy line is ignored; the next change prints a full one.
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const message = clip(chunk, 200);
      if (message) {
        runtime.errors.unshift({ at: now(), message });
        runtime.errors = runtime.errors.slice(0, 20);
      }
    });
    child.on('exit', (code) => {
      runtime.running = false;
      runtime.child = null;
      runtime.pid = null;
      runtime.stoppedAt = now();
      if (code && code !== 0) runtime.errors.unshift({ at: now(), message: `watcher exited with code ${code}` });
    });
  } catch (err) {
    runtime.running = false;
    runtime.errors.unshift({ at: now(), message: clip(err.message || err, 200) });
  }
  return monitorState();
}

/** Stop the watcher. Captures and events stay readable. */
export function stopLiveMonitor() {
  const child = runtime.child;
  const pid = runtime.pid;
  runtime.child = null;
  runtime.running = false;
  runtime.pid = null;
  runtime.stoppedAt = now();
  if (child) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  // A Windows child started with spawn can outlive a plain kill(); taskkill /T
  // removes the watcher and anything it started, so no polling stays behind.
  if (pid && IS_WINDOWS) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {
      // Best effort only.
    }
  }
  return monitorState();
}

/** Serializable view for the API and the console. */
export function monitorState() {
  return {
    running: runtime.running,
    pid: runtime.pid,
    intervalMs: runtime.intervalMs,
    capture: runtime.capture,
    captureMinMs: runtime.captureMinMs,
    startedAt: runtime.startedAt,
    stoppedAt: runtime.stoppedAt,
    lastEventAt: runtime.events[0]?.at || null,
    current: runtime.current
      ? {
          title: runtime.current.title,
          process: runtime.current.process,
          className: runtime.current.className,
          at: runtime.current.at,
          capture: runtime.current.capture,
        }
      : null,
    events: runtime.events.slice(0, 20).map((event) => ({
      at: event.at,
      title: event.title,
      process: event.process,
      capture: event.capture,
      suggestions: event.suggestions,
    })),
    errors: runtime.errors.slice(0, 5),
    capturesDir: CAPTURES,
    platform: IS_WINDOWS ? 'windows' : process.platform,
  };
}

/** Latest suggestions, so the UI can offer them without reading the events. */
export function latestMonitorSuggestions(limit = 3) {
  const event = runtime.events[0];
  return event ? (event.suggestions || []).slice(0, limit) : [];
}
