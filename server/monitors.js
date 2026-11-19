/**
 * Monitor tracking — which screen is what, and which screen got the click.
 *
 * A desktop with more than one display shifts every absolute coordinate the
 * moment the layout, DPI or a disconnected cable changes. This module names
 * the monitors (System.Windows.Forms.Screen.AllScreens), places any point or
 * window on one of them, and gives the engine a reflex: after a pointer step
 * that used absolute coordinates, the monitor the step aimed at is compared
 * with the monitor the step's window actually sits on. A mismatch is not a
 * failure — a window can span two screens — but it is logged on the step so
 * “the click landed on the wrong display” becomes visible instead of silent.
 *
 * The layout is cached for 30 seconds; a reflex that needs fresh geometry
 * bypasses the cache.
 */
import { db, persist, now, logActivity } from './store.js';
import { execFile } from 'node:child_process';

const CACHE_MS = 30000;
let cache = { at: 0, monitors: [] };
let layoutSource = null; // tests inject a synthetic layout

/** Tests replace the OS layout read with a canned one. */
export function setLayoutSourceForTests(fn) {
  layoutSource = fn;
}

function psScript() {
  return `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    device = $_.DeviceName
    primary = $_.Primary
    x = $_.Bounds.X
    y = $_.Bounds.Y
    w = $_.Bounds.Width
    h = $_.Bounds.Height
  }
} | ConvertTo-Json -Compress`;
}

async function readMonitors({ fresh = false } = {}) {
  if (layoutSource) return layoutSource();
  if (!fresh && cache.monitors.length && Date.now() - cache.at < CACHE_MS) return cache.monitors;
  const monitors = await new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript()], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve([]);
        let parsed;
        try {
          parsed = JSON.parse(stdout || '[]');
        } catch {
          parsed = stdout && stdout.trim() ? [JSON.parse(stdout)] : [];
        }
        const list = (Array.isArray(parsed) ? parsed : [parsed])
          .filter(Boolean)
          .map((screen) => ({
            device: String(screen.device || ''),
            primary: Boolean(screen.primary),
            x: Number(screen.x) || 0,
            y: Number(screen.y) || 0,
            w: Number(screen.w) || 0,
            h: Number(screen.h) || 0,
          }));
        resolve(list);
      });
    } catch {
      resolve([]);
    }
  });
  if (monitors.length) cache = { at: Date.now(), monitors };
  return monitors;
}

export async function monitorsStatus({ fresh = false } = {}) {
  const monitors = await readMonitors({ fresh });
  const primary = monitors.find((monitor) => monitor.primary) || monitors[0] || null;
  return { platform: process.platform, count: monitors.length, primary, monitors };
}

/** Which monitor holds a point in virtual-screen coordinates? */
export function monitorOfPoint(monitors, x, y) {
  const px = Number(x) || 0;
  const py = Number(y) || 0;
  return (
    monitors.find((monitor) => px >= monitor.x && px < monitor.x + monitor.w && py >= monitor.y && py < monitor.y + monitor.h) || null
  );
}

/** The engine's reflex after a coordinate step. Read-only; never fails a step. */
export async function checkStepMonitor(step, run, { readRect = null } = {}) {
  if (!step || !run) return null;
  const hasPoint = step.params && (Number.isFinite(Number(step.params.x)) || Number.isFinite(Number(step.params.y)));
  if (!hasPoint || step.status !== 'passed') return null;
  const monitors = await readMonitors({ fresh: true });
  if (!monitors.length) return null;
  const target = monitorOfPoint(monitors, step.params.x, step.params.y);
  if (!target) {
    step.monitorNote = `The step's coordinates (${step.params.x}, ${step.params.y}) are outside every monitor this machine knows about.`;
    return { kind: 'outside', target: null };
  }
  // The window the run is driving should share the screen the step aimed at.
  let rect = null;
  try {
    rect = readRect ? await readRect(run.lastWindow) : await windowRect(run.lastWindow);
  } catch {
    rect = null;
  }
  if (!rect) return { kind: 'target-ok', target: target.device || `monitor ${monitors.indexOf(target) + 1}` };
  const windowMonitor = monitorOfPoint(monitors, rect.x + rect.w / 2, rect.y + rect.h / 2);
  if (!windowMonitor) return { kind: 'target-ok', target: target.device || `monitor ${monitors.indexOf(target) + 1}` };
  if (windowMonitor.device !== target.device) {
    step.monitorNote = `The step aimed at ${target.device || 'a different monitor'} but the window “${run.lastWindow?.title || ''}” sits on ${windowMonitor.device || 'another monitor'} — check the display layout if the click landed oddly.`;
    logActivity('monitors', `${run.workflowName}: ${step.monitorNote}`, { runId: run.id, stepId: step.id });
    persist();
    return { kind: 'mismatch', target: target.device, window: windowMonitor.device };
  }
  return { kind: 'target-ok', target: target.device };
}

/** The bounding rect of a window by title, on Windows. */
export async function windowRect(window) {
  if (!window?.title || process.platform !== 'win32') return null;
  const title = String(window.title).replace(/'/g, "''");
  const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); }
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
$h = [W]::FindWindow($null, '${title}')
if ($h -eq [IntPtr]::Zero) { Write-Output 'none'; exit }
$r = New-Object RECT
[void][W]::GetWindowRect($h, [ref]$r)
[pscustomobject]@{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top } | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout || /none/.test(stdout)) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          resolve({ x: Number(parsed.x) || 0, y: Number(parsed.y) || 0, w: Number(parsed.w) || 0, h: Number(parsed.h) || 0 });
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/** Cheap layout fingerprint — a change here explains coordinate drift. */
export function layoutSignature(monitors) {
  return (monitors || [])
    .map((monitor) => `${monitor.device}@${monitor.x},${monitor.y}#${monitor.w}x${monitor.h}${monitor.primary ? '*' : ''}`)
    .join('|');
}
