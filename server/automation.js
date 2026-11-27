import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPTURES, DATA, NOTES, ROOT, TOOLS, db, now, persist, slug, uid, writeFileDurable } from './store.js';
import { chat, parseJsonLoose } from './llm.js';
import { findSetupCommand, runSetupCommand, setupSummary } from './setup-commands.js';
import { executePortableStep, portableLiveScreenshot } from './portable.js';
import { mapVisionPoint } from './vision-map.js';
import { caretNote, placeCaret } from './caret.js';
import { lineInk, matchOcrLine, ocrLineAnchor, ocrLines, ocrScreenPoint } from './ocr-locate.js';
import { decidePreview, describeSurroundings } from './step-context.js';
import { judgeMode, judgeTargetFor, mergeJudgement, recordJudgement, windowFacts } from './judgement.js';
import {
  catalogEntry,
  discoverInstallerUrls,
  installAttemptSummary,
  installHealth,
  installMethodsFor,
  installNoteBody,
  parseVerification,
  reviewInstaller,
  verificationChecksFor,
  verificationScript,
} from './app-install.js';

const IS_WINDOWS = process.platform === 'win32';
const PS = IS_WINDOWS ? 'powershell.exe' : 'pwsh';
// Used only to read a known media file's real length; a missing ffprobe simply
// means that extra corroboration is unavailable.
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const BASE_PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SightlineInput {
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# A click is a physical pixel position. Without this the process is DPI-unaware,
# so Windows silently scales every SetCursorPos: on a 125% display a click at
# 150,250 landed at 187,312 and missed the control the run had just found.
[void][SightlineInput]::SetProcessDPIAware()
`;

const MOUSE = { left: [2, 4], right: [8, 16], middle: [32, 64] };

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function runPowerShell(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, CB_DATA: DATA } },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim() || (error?.killed ? 'Command timed out.' : ''),
          ms: Date.now() - started,
        });
      }
    );
  });
}

/**
 * SendKeys key expressions an author may write on purpose inside typed text.
 * These are expanded as keys, not escaped as literal braces — a quick-capture
 * note that ends its first line with {ENTER} means "press Enter here".
 */
const SENDKEY_PHRASES =
  /(\{ENTER\}|\{TAB\}|\{ESC\}|\{BACKSPACE\}|\{BKSP\}|\{DELETE\}|\{DEL\}|\{INSERT\}|\{INS\}|\{HOME\}|\{END\}|\{PGUP\}|\{PGDN\}|\{UP\}|\{DOWN\}|\{LEFT\}|\{RIGHT\}|\{PRTSC\}|\{CAPSLOCK\}|\{F[1-9]\}|\{F1[0-2]\}|\{\s*enter\s*\}|\{\s*tab\s*\}|\{\s*esc\s*\})/gi;

export function sendKeysText(text) {
  const raw = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '{ENTER}')
    .replace(/\t/g, '{TAB}');
  // Pass intentional key phrases through; escape everything else so prose
  // containing braces, carets or percent signs stays literal prose.
  const escaped = raw
    .split(SENDKEY_PHRASES)
    .map((chunk, index) => {
      if (index % 2 === 1) return chunk.toUpperCase().replace(/\s+/g, '');
      return chunk.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`);
    })
    .join('');
  return Buffer.from(escaped, 'utf8').toString('base64');
}

const KEY_ALIASES = {
  enter: '{ENTER}',
  return: '{ENTER}',
  esc: '{ESC}',
  escape: '{ESC}',
  tab: '{TAB}',
  space: ' ',
  backspace: '{BACKSPACE}',
  bksp: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  ins: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  capslock: '{CAPSLOCK}',
  printscreen: '{PRTSC}',
};

const MODIFIER_ALIASES = {
  ctrl: '^',
  control: '^',
  ctr: '^',
  ctl: '^',
  alt: '%',
  option: '%',
  shift: '+',
  win: '#',
  windows: '#',
  meta: '#',
  cmd: '^',
  command: '^',
};

/**
 * Accept the shortcut notation people and models actually write
 * ("ctrl+a", "ctr+c", "Ctrl+Shift+V", "ctrl+a, ctrl+c") and turn it into
 * SendKeys expressions. Unknown prose is rejected instead of being typed as
 * literal text, which is how a bad shortcut used to look successful.
 */
export function normalizeShortcutKeys(input) {
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const item of list) {
    const text = String(item ?? '');
    // A shortcut made only of spaces is the Space key itself, not noise.
    // Trimming it away is how `space` used to reach SendKeys as an empty list.
    if (text && !text.trim() && /[ \u00a0]/.test(text)) {
      out.push(' ');
      continue;
    }
    const raw = text.trim();
    if (!raw) continue;
    const chunks = raw.split(/\s*(?:,|;|\bthen\b|\|\|)\s*/i);
    for (const chunk of chunks) {
      const bare = chunk.replace(/^["'“”]+|["'“”]+$/g, '');
      if (bare && !bare.trim() && /[ \u00a0]/.test(bare)) {
        out.push(' ');
        continue;
      }
      let token = bare.trim();
      if (!token) continue;
      // Already a SendKeys expression.
      if (/^[\^%+#]/.test(token) || /^\{[A-Z0-9]+\}$/i.test(token)) {
        out.push(token);
        continue;
      }
      const parts = token.split(/\s*\+\s*|\s*-\s*/).filter(Boolean);
      if (parts.length > 1) {
        let prefix = '';
        let key = '';
        for (const part of parts) {
          const lower = part.toLowerCase();
          if (MODIFIER_ALIASES[lower]) prefix += MODIFIER_ALIASES[lower];
          else key = part;
        }
        if (!key) throw new Error(`Shortcut "${chunk}" has modifiers but no key.`);
        const lowerKey = key.toLowerCase();
        const mapped = KEY_ALIASES[lowerKey] || (lowerKey.length === 1 ? lowerKey : null);
        if (!mapped) throw new Error(`Unknown shortcut key "${key}" in "${chunk}". Use ctrl+a, ctrl+c, ctrl+v, ctrl+s, alt+f4, etc.`);
        out.push(prefix + mapped);
        continue;
      }
      const lower = token.toLowerCase();
      if (KEY_ALIASES[lower]) {
        out.push(KEY_ALIASES[lower]);
        continue;
      }
      if (/^f(?:[1-9]|1[0-2])$/.test(lower)) {
        out.push(`{${lower.toUpperCase()}}`);
        continue;
      }
      if (MODIFIER_ALIASES[lower]) {
        throw new Error(`Shortcut "${chunk}" is only a modifier. Add the key, for example ctrl+a.`);
      }
      if (token.length === 1) {
        out.push(token);
        continue;
      }
      throw new Error(`Unrecognized shortcut "${chunk}". Use ctrl+a, ctrl+c, ctrl+v, ctrl+s, ctrl+shift+v or a SendKeys expression like ^a.`);
    }
  }
  return out;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function flag(value, fallback = false) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

/**
 * Windows media players silently ignore a path written with forward slashes:
 * VLC opens its idle window and plays nothing, which then looks exactly like a
 * video that refused to start. Every absolute path handed to a desktop app is
 * normalized to the Windows separator first.
 */
export function windowsPath(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return text;
  if (/^file:\/\//i.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) return text.replace(/\//g, '\\');
  return text;
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) return `https://${raw}`;
  return raw;
}

function foregroundGuard(p, action) {
  const expected = (p.foreground === true ? str(p.window || p.title || p.expectedWindow) : str(p.foreground)).trim();
  const expectedHandle = Math.max(0, Number(p.foregroundHandle) || 0);
  if (!expected && !expectedHandle) return '';
  return `
$fg = [IntPtr]::Zero
# A foreground handle can be momentarily zero while a window is being created
# or destroyed; wait for it instead of refusing a guard that is about to match.
for ($attempt = 0; $attempt -lt 6; $attempt++) {
  $fg = [SightlineInput]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
$fgPid = 0
if ($fg -ne [IntPtr]::Zero) { [void][SightlineInput]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
$fgProc = if ($fgPid -gt 0) { Get-Process -Id $fgPid -ErrorAction SilentlyContinue } else { $null }
# Read the title from the foreground handle itself: a process can own several
# windows, so MainWindowHandle is not a reliable lookup for the front window.
$fgTitle = ''
if ($fg) {
  $len = [SightlineInput]::GetWindowTextLength($fg)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][SightlineInput]::GetWindowText($fg, $sb, $sb.Capacity)
  $fgTitle = [string]$sb.ToString()
}
if (-not $fgTitle -and $fg -ne [IntPtr]::Zero) {
  # Dialogs have no MainWindowTitle; their UI Automation name is the real title.
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $fgElement = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
    if ($fgElement) { $fgTitle = [string]$fgElement.Current.Name }
  } catch { }
}
if (-not $fgTitle -and $fgProc) { $fgTitle = [string]$fgProc.MainWindowTitle }
$fgProcess = if ($fgProc) { [string]$fgProc.ProcessName } else { '' }
$expected = ${psQuote(expected)}
$expectedHandle = [int64]${expectedHandle}
# An inherited handle is the exact window this run opened; a title match alone
# would accept another document of the same app.
$handleOk = if ($expectedHandle -gt 0) { $fg.ToInt64() -eq $expectedHandle } else { $true }
# A handle is authoritative: typing into an untitled document renames it, and
# the title check would then refuse the very window that received the text.
$titleOk = if ($expected -and $expectedHandle -le 0) { ($fgProcess -like ('*' + $expected + '*')) -or ($fgTitle -like ('*' + $expected + '*')) } else { $true }
$guardMatch = $handleOk -and $titleOk
if (-not $guardMatch) {
  $actual = if ($fgProcess -or $fgTitle) { $fgProcess + ' :: ' + $fgTitle } else { '(unknown)' }
  $wanted = if ($expected) { 'process or window "' + $expected + '"' } else { 'the window this run opened' }
  throw ('Refusing to ${action}: foreground window is "' + $actual + '", expected ' + $wanted + '.')
}`;
}

/* Simulated evidence: a self-describing SVG so the gallery still has a reviewable artifact. */
function writeSimulatedEvidence({ caption, stepName, workflowName, runId }) {
  const file = path.join(CAPTURES, `${uid('sim')}.svg`);
  const safe = (v) => String(v || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><pattern id="g" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#1f2937" stroke-width="1"/></pattern></defs>
  <rect width="1280" height="720" fill="#0b0f14"/><rect width="1280" height="720" fill="url(#g)"/>
  <rect x="60" y="60" width="1160" height="600" rx="18" fill="#111820" stroke="#2b3644"/>
  <text x="100" y="140" fill="#fbbf24" font-family="Consolas, monospace" font-size="22">SIMULATED CAPTURE</text>
  <text x="100" y="200" fill="#e5edf5" font-family="Segoe UI, sans-serif" font-size="34">${safe(caption || stepName)}</text>
  <text x="100" y="260" fill="#8b9bad" font-family="Segoe UI, sans-serif" font-size="22">Workflow: ${safe(workflowName)}</text>
  <text x="100" y="300" fill="#8b9bad" font-family="Segoe UI, sans-serif" font-size="22">Step: ${safe(stepName)}</text>
  <text x="100" y="340" fill="#8b9bad" font-family="Consolas, monospace" font-size="18">run ${safe(runId)}</text>
  <text x="100" y="600" fill="#64748b" font-family="Segoe UI, sans-serif" font-size="20">No desktop input was performed. Switch live control on to record real pixels.</text>
</svg>`;
  writeFileDurable(file, svg);
  return { path: path.relative(DATA, file).split(path.sep).join('/'), simulated: true };
}

export async function captureScreenSignature({ width = 32, height = 18 } = {}) {
  if (!IS_WINDOWS) return null;
  const w = Math.max(8, Math.min(64, Number(width) || 32));
  const h = Math.max(6, Math.min(36, Number(height) || 18));
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[void][SightlineInput]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$src = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $src.Size)
$thumb = New-Object System.Drawing.Bitmap ${w}, ${h}
$tg = [System.Drawing.Graphics]::FromImage($thumb)
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$tg.DrawImage($src, 0, 0, ${w}, ${h})
$cells = New-Object System.Collections.Generic.List[string]
for ($y = 0; $y -lt ${h}; $y++) {
  for ($x = 0; $x -lt ${w}; $x++) {
    $c = $thumb.GetPixel($x, $y)
    $cells.Add(('{0:x2}{1:x2}{2:x2}' -f $c.R, $c.G, $c.B))
  }
}
$tg.Dispose(); $thumb.Dispose(); $g.Dispose(); $src.Dispose()
[pscustomobject]@{ width = ${w}; height = ${h}; cells = $cells } | ConvertTo-Json -Compress`;
  const res = await runPowerShell(`${BASE_PRELUDE}${script}`, 20000);
  if (!res.ok) throw new Error(`Screen signature failed: ${res.stderr || res.stdout || 'unknown error'}`);
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    return {
      width: Number(parsed.width) || w,
      height: Number(parsed.height) || h,
      cells: Array.isArray(parsed.cells) ? parsed.cells : [],
      at: new Date().toISOString(),
    };
  } catch {
    throw new Error(`Screen signature was not JSON: ${String(res.stdout).slice(0, 200)}`);
  }
}

/**
 * Capture the virtual screen. With options.maxWidth the same capture also writes
 * a downscaled JPEG for vision calls: a full-resolution PNG is a multi-megabyte
 * upload plus a huge image prefill, and that prefill is what a locate really
 * costs. A 32x18 luminance signature of the captured region lets a caller tell
 * whether a cached locate still describes what is on screen.
 */
async function liveScreenshot(runId, options = {}) {
  // macOS, Linux and Android capture through their own tools; the record shape
  // is identical so vision checks and evidence keep working off Windows.
  if (!IS_WINDOWS) {
    try {
      return await portableLiveScreenshot(runId, options);
    } catch (err) {
      err.unreadable = true;
      throw err;
    }
  }
  const file = path.join(CAPTURES, `${uid('cap')}.png`);
  const maxWidth = Math.max(0, Math.min(4096, Number(options.maxWidth) || 0));
  const quality = Math.max(30, Math.min(95, Number(options.quality) || 80));
  const wantVision = options.vision !== false && maxWidth > 0;
  const visionFile = wantVision ? path.join(CAPTURES, `${path.basename(file, '.png')}-vision.jpg`) : '';
  // A specific window is cropped by handle, so the picture a judge reads is the
  // run's own window rather than whichever window happens to be in front.
  const cropWindow = options.crop && typeof options.crop === 'object' && options.crop.window ? Number(options.crop.window) : 0;
  const crop =
    options.crop === 'foreground'
      ? 'foreground'
      : cropWindow
        ? 'window'
        : options.crop && typeof options.crop === 'object'
          ? 'rect'
          : 'none';
  const rect = crop === 'rect' ? options.crop : null;
  const cropScript =
    crop === 'foreground' || crop === 'window'
      ? `$fgHandle = ${crop === 'window' ? `[IntPtr]${cropWindow}` : '[SightlineInput]::GetForegroundWindow()'}
$fgRect = New-Object SightlineInput+RECT
$fgBox = $null
# The window's own rectangle is enough to crop to, and user32 still answers it
# for a window UI Automation refuses. UIA is the fallback, and its failure for a
# handle that is already gone is reported below instead of crashing the frame.
if ([SightlineInput]::GetWindowRect($fgHandle, [ref]$fgRect) -and ($fgRect.Right - $fgRect.Left) -gt 0 -and ($fgRect.Bottom - $fgRect.Top) -gt 0) {
  $fgBox = New-Object System.Drawing.Rectangle $fgRect.Left, $fgRect.Top, ($fgRect.Right - $fgRect.Left), ($fgRect.Bottom - $fgRect.Top)
} else {
  try {
    Add-Type -AssemblyName UIAutomationClient
    $fgBox = [System.Windows.Automation.AutomationElement]::FromHandle($fgHandle).Current.BoundingRectangle
  } catch { $fgBox = $null }
}
if (-not $fgBox -or $fgBox.Width -lt 1 -or $fgBox.Height -lt 1) {
  throw "The window to capture is gone or hidden (handle $fgHandle), so there is no frame of it to judge."
}
$cx = [int][math]::Max(0, [math]::Floor($fgBox.X) - $b.X)
$cy = [int][math]::Max(0, [math]::Floor($fgBox.Y) - $b.Y)
$cw = [int][math]::Min($b.Width - $cx, [math]::Max(1, [math]::Floor($fgBox.Width)))
$ch = [int][math]::Min($b.Height - $cy, [math]::Max(1, [math]::Floor($fgBox.Height)))
if ($cw -lt 1) { $cw = 1 }
if ($ch -lt 1) { $ch = 1 }
$cropBuf = New-Object System.Text.StringBuilder 512
[void][SightlineInput]::GetWindowText($fgHandle, $cropBuf, $cropBuf.Capacity)
$cropTitle = [string]$cropBuf.ToString()`
      : crop === 'rect'
        ? `$cx = [int][math]::Min($b.Width - 1, [math]::Max(0, ${Math.round(Number(rect.x) || 0)}))
$cy = [int][math]::Min($b.Height - 1, [math]::Max(0, ${Math.round(Number(rect.y) || 0)}))
$cw = [int][math]::Min($b.Width - $cx, [math]::Max(1, ${Math.round(Number(rect.width) || 0)}))
$ch = [int][math]::Min($b.Height - $cy, [math]::Max(1, ${Math.round(Number(rect.height) || 0)}))
$cropTitle = ''`
        : `$cx = 0
$cy = 0
$cw = $b.Width
$ch = $b.Height
$cropTitle = ''`;
  const visionScript = !wantVision
    ? `$vw = $cw
$vh = $ch`
    : `
$vw = $cw
$vh = $ch
if ($cw -gt ${maxWidth}) {
  $vw = ${maxWidth}
  $vh = [int][math]::Round($ch * (${maxWidth} / $cw))
}
if ($vh -lt 1) { $vh = 1 }
$vb = New-Object System.Drawing.Bitmap $vw, $vh
$vg = [System.Drawing.Graphics]::FromImage($vb)
$vg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$vg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$vg.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $vw, $vh), (New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch), [System.Drawing.GraphicsUnit]::Pixel)
$vg.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$encoder = New-Object System.Drawing.Imaging.EncoderParameters 1
$encoder.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [int64]${quality})
$vb.Save(${psQuote(visionFile)}, $codec, $encoder)
$vb.Dispose()`;
  const script = `${BASE_PRELUDE}
[void][SightlineInput]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
${cropScript}
${visionScript}
$thumb = New-Object System.Drawing.Bitmap 32, 18
$tg = [System.Drawing.Graphics]::FromImage($thumb)
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
$tg.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, 32, 18), (New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch), [System.Drawing.GraphicsUnit]::Pixel)
$tg.Dispose()
$sb = New-Object System.Text.StringBuilder
for ($ty = 0; $ty -lt 18; $ty++) {
  for ($tx = 0; $tx -lt 32; $tx++) {
    $px = $thumb.GetPixel($tx, $ty)
    [void]$sb.Append(([int][math]::Floor(($px.R + $px.G + $px.B) / 3)).ToString('x2'))
  }
}
$thumb.Dispose()
$bmp.Dispose()
$record = [pscustomobject]@{
  screen = ("{0}x{1}" -f $b.Width, $b.Height)
  view = ("{0}x{1}" -f $vw, $vh)
  x = $cx
  y = $cy
  ox = $b.X
  oy = $b.Y
  w = $cw
  h = $ch
  image = ${psQuote(wantVision ? visionFile : '')}
  cropTitle = $cropTitle
  signature = $sb.ToString()
}
Write-Output ($record | ConvertTo-Json -Compress)`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok || !fs.existsSync(file)) {
    // A frame that could not be taken is an unread screen, not a screen that
    // disagreed: a review records it as unverified instead of a mismatch.
    const error = new Error(`Screenshot failed: ${res.stderr || res.stdout || 'unknown error'}`);
    error.unreadable = true;
    throw error;
  }
  const line = String(res.stdout || '').split(/\r?\n/).filter(Boolean).pop() || '';
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    const error = new Error(`Screenshot returned an unreadable record: ${line.slice(0, 200)}`);
    error.unreadable = true;
    throw error;
  }
  const [width, height] = String(record.screen || '').split('x').map((n) => Number(n));
  const [visionWidth, visionHeight] = String(record.view || '').split('x').map((n) => Number(n));
  const visionPath = String(record.image || '');
  const vision =
    wantVision && visionPath && fs.existsSync(visionPath)
      ? {
          path: path.relative(DATA, visionPath).split(path.sep).join('/'),
          width: visionWidth || null,
          height: visionHeight || null,
          cropX: Number(record.x) || 0,
          cropY: Number(record.y) || 0,
          cropWidth: Number(record.w) || 0,
          cropHeight: Number(record.h) || 0,
          originX: Number(record.ox) || 0,
          originY: Number(record.oy) || 0,
          bytes: fs.statSync(visionPath).size,
        }
      : null;
  return {
    path: path.relative(DATA, file).split(path.sep).join('/'),
    simulated: false,
    width: width || null,
    height: height || null,
    signature: record.signature ? createHash('md5').update(String(record.signature)).digest('hex').slice(0, 16) : '',
    cropTitle: String(record.cropTitle || ''),
    originX: Number(record.ox) || 0,
    originY: Number(record.oy) || 0,
    vision,
    runId,
  };
}

/**
 * Composite steps (testApp, watchVideo) run several sub-steps. Each sub-step
 * used to carry its own fixed timeout, so the total could overrun the step's
 * budget: PowerShell was killed mid-launch ("Command timed out.") and the retry
 * launched the app into a second window. These helpers hand out what is left of
 * one budget instead, keeping a reserve for the last sub-step to shut down.
 */
export function compositeBudget(timeoutMs, { fallbackMs = 60000, minMs = 6000, maxMs = 1900000 } = {}) {
  const declared = Number(timeoutMs) > 0 ? Number(timeoutMs) : fallbackMs;
  return { startedAt: Date.now(), totalMs: Math.max(minMs, Math.min(maxMs, declared)) };
}

export function budgetLeft(budget, reserveMs = 3000, floorMs = 1000, at = Date.now()) {
  return Math.max(floorMs, budget.totalMs - reserveMs - (at - budget.startedAt));
}

function describe(step) {
  const p = step.params || {};
  switch (step.type) {
    case 'move':
      return `pointer to ${num(p.x)},${num(p.y)}`;
    case 'click':
      return `${p.button || 'left'} click at ${num(p.x)},${num(p.y)}`;
    case 'drag':
      return `drag ${num(p.x1)},${num(p.y1)} to ${num(p.x2)},${num(p.y2)}`;
    case 'verifyScreen':
      return `look at the screen: ${String(p.question || p.title || '').slice(0, 90)}`;
    case 'verifyPlayback':
      return `compare two frames ${Math.max(1000, num(p.intervalMs, 4000))}ms apart for advancing playback`;
    case 'mediaHold':
      return `hold until “${str(p.title, 'YouTube')}” reaches its actual media end (buffer ${num(p.bufferMs, 5000)}ms)`;
    case 'playMedia':
      return `ensure playback in \"${str(p.title, 'YouTube')}\" (reads the player, clicks ${num(p.x)},${num(p.y)} only if visibly paused)`;
    case 'closeWindow':
      return `close the foreground window only if its title contains \"${str(p.title, 'YouTube')}\"`;
    case 'doubleClick':
      return `double click at ${num(p.x)},${num(p.y)}`;
    case 'rightClick':
      return `right click at ${num(p.x)},${num(p.y)}`;
    case 'scroll':
      return `scroll ${num(p.amount)} at ${p.x ?? 'current'},${p.y ?? 'current'}`;
    case 'type':
      return `type ${String(p.text || '').length} characters`;
    case 'key':
      return `press ${Array.isArray(p.keys) ? p.keys.join(', ') : p.keys}`;
    case 'clipboard':
      return `${str(p.action, 'copy')} clipboard${p.outputVar ? ` → ${p.outputVar}` : ''}`;
    case 'windowAction':
      return `${str(p.action, 'minimize')} window ${str(p.title || p.process, '(foreground)')}`;
    case 'dragCopy':
      return `drag-highlight ${str(p.text || p.name, 'a region')} and copy${p.outputVar ? ` → ${p.outputVar}` : ''}`;
    case 'aiExtract':
      return `AI extract${p.outputVar ? ` → ${p.outputVar}` : ''}: ${String(p.instructions || '').slice(0, 80)}`;
    case 'writeNote':
      return `save note “${p.title || p.noteTitle || 'interaction'}”${p.append !== false ? ' (append)' : ''}`;
    case 'readNote':
      return `read note “${p.title || p.query || p.noteId || 'latest'}” → ${p.outputVar || 'noteText'}`;
    case 'writeTextFile':
      return `save text to ${p.location === 'desktop' ? 'Desktop' : 'data/files'}/${p.path || p.filename || 'text.txt'}`;
    case 'copyLink':
      return `copy browser link → ${p.outputVar || 'copiedLink'}`;
    case 'downloadMedia':
      return `save ${p.kind || 'file'}: ${p.url || p.urlVar || '(missing url)'}`;
    case 'saveImage':
      return `save ${p.source || 'screen'} image${p.filename ? ` as ${p.filename}` : ''}`;
    case 'recordVideo':
      return `record ${Math.round(num(p.durationMs, 10000) / 1000)}s video`;
    case 'installApp':
      return `install ${p.app || p.name || p.id || p.packageId || p.url || '(missing app)'}${p.url ? ` from ${p.url}` : ''}`;
    case 'testApp':
      return `launch and test ${p.title || p.target || 'app'}`;
    case 'watchVideo':
      return `watch “${p.title || 'YouTube'}” and save notes`;
    case 'launchApp':
      return `launch ${p.target}`;
    case 'openUrl':
      return `open ${p.url}`;
    case 'focusWindow':
      return `focus window "${p.title || p.windowName || p.windowTitle || ''}"`;
    case 'wait':
      return `wait ${num(p.ms, 1000)}ms`;
    case 'waitFor':
      return `until ${p.kind || 'window'} “${p.value || ''}” is ${p.mode || 'present'}`;
    case 'screenshot':
      return `capture ${p.caption || 'screen'}`;
    case 'expect':
      return `assert ${p.kind} contains "${p.value}"`;
    case 'runTool':
      return `run tool ${p.toolName || p.toolId || '(none)'}`;
    case 'note':
      return `note ${String(p.text || '').slice(0, 40)}`;
    default:
      return step.type;
  }
}

export const STEP_TYPES = [
  { type: 'launchApp', label: 'Launch app', group: 'Environment' },
  { type: 'openUrl', label: 'Open URL', group: 'Environment' },
  { type: 'focusWindow', label: 'Focus window', group: 'Environment' },
  { type: 'windowAction', label: 'Minimize / maximize / restore / close window', group: 'Environment' },
  { type: 'move', label: 'Move pointer', group: 'Pointer' },
  { type: 'click', label: 'Click', group: 'Pointer' },
  { type: 'doubleClick', label: 'Double click', group: 'Pointer' },
  { type: 'rightClick', label: 'Right click', group: 'Pointer' },
  { type: 'drag', label: 'Drag / highlight', group: 'Pointer' },
  { type: 'dragCopy', label: 'Drag-highlight and copy', group: 'Pointer' },
  { type: 'clickElement', label: 'Click UI element (UIA)', group: 'Pointer' },
  { type: 'copyLink', label: 'Copy browser link', group: 'Data' },
  { type: 'downloadMedia', label: 'Save image / video from URL', group: 'Files' },
  { type: 'saveImage', label: 'Save image (screen/clipboard/URL)', group: 'Files' },
  { type: 'writeTextFile', label: 'Save text file', group: 'Files' },
  { type: 'recordVideo', label: 'Record screen video', group: 'Files' },
  { type: 'playMedia', label: 'Start media playback', group: 'Pointer' },
  { type: 'closeWindow', label: 'Close guarded window', group: 'Environment' },
  { type: 'verifyScreen', label: 'Verify screen (vision)', group: 'Evidence' },
  { type: 'verifyPlayback', label: 'Verify playback (2 frames)', group: 'Evidence' },
  { type: 'mediaHold', label: 'Hold until media ends', group: 'Timing' },
  { type: 'scroll', label: 'Scroll', group: 'Pointer' },
  { type: 'type', label: 'Type text', group: 'Keyboard' },
  { type: 'key', label: 'Press keys / shortcut', group: 'Keyboard' },
  { type: 'clipboard', label: 'Clipboard (select/copy/paste)', group: 'Keyboard' },
  { type: 'aiExtract', label: 'AI extract text from clipboard', group: 'AI' },
  { type: 'wait', label: 'Wait', group: 'Timing' },
  { type: 'waitFor', label: 'Wait for state', group: 'Timing' },
  { type: 'screenshot', label: 'Capture screen', group: 'Evidence' },
  { type: 'expect', label: 'Assert state', group: 'Evidence' },
  { type: 'runTool', label: 'Run tool', group: 'Tools' },
  { type: 'note', label: 'Add note (run log)', group: 'Notes' },
  { type: 'writeNote', label: 'Save interaction note', group: 'Notes' },
  { type: 'readNote', label: 'Read note into variable', group: 'Notes' },
  { type: 'watchVideo', label: 'Watch video + take notes', group: 'Media' },
  { type: 'installApp', label: 'Install app (winget or installer)', group: 'Apps' },
  { type: 'testApp', label: 'Launch and test app', group: 'Apps' },
];

export function buildScript(step) {
  const p = step.params || {};
  const pre = BASE_PRELUDE;
  switch (step.type) {
    case 'move':
      return `${pre}
if (-not [SightlineInput]::SetCursorPos(${num(p.x)}, ${num(p.y)})) { throw 'SetCursorPos failed' }
Write-Output 'moved'`;
    case 'click':
    case 'doubleClick':
    case 'rightClick': {
      const btn = step.type === 'rightClick' ? 'right' : str(p.button, 'left');
      const [down, up] = MOUSE[btn] || MOUSE.left;
      const times = step.type === 'doubleClick' ? 2 : 1;
      const clicks = Array.from({ length: times }, () => `
[SightlineInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[SightlineInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 90`).join('');
      return `${pre}${foregroundGuard(p, step.type)}
[SightlineInput]::SetCursorPos(${num(p.x)}, ${num(p.y)}) | Out-Null
${clicks}
Write-Output 'clicked'`;
    }
    case 'drag': {
      const [down, up] = MOUSE[str(p.button, 'left')] || MOUSE.left;
      const x1 = num(p.x1 ?? p.x, 0);
      const y1 = num(p.y1 ?? p.y, 0);
      const x2 = num(p.x2 ?? x1, x1);
      const y2 = num(p.y2 ?? y1, y1);
      const steps = Math.max(2, Math.min(120, num(p.steps, 24)));
      const duration = Math.max(50, Math.min(10000, num(p.durationMs, 600)));
      const pause = Math.max(1, Math.round(duration / steps));
      const moves = Array.from({ length: steps }, (_, i) => {
        const t = (i + 1) / steps;
        const x = Math.round(x1 + (x2 - x1) * t);
        const y = Math.round(y1 + (y2 - y1) * t);
        return `[SightlineInput]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds ${pause}`;
      }).join('\n');
      return `${pre}${foregroundGuard(p, 'drag')}
[SightlineInput]::SetCursorPos(${x1}, ${y1}) | Out-Null
Start-Sleep -Milliseconds 80
[SightlineInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 120
${moves}
[SightlineInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'dragged ${x1},${y1} to ${x2},${y2}'`;
    }
    case 'playMedia': {
      const title = str(p.title, 'YouTube');
      const pattern = psQuote(`*${title}*`);
      const [down, up] = MOUSE[str(p.button, 'left')] || MOUSE.left;
      return `${pre}
$pattern = ${pattern}
$fg = [SightlineInput]::GetForegroundWindow()
$target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
if (-not $target) { throw 'No foreground media window; focus it before requesting playback.' }
if ($target.MainWindowTitle -notlike $pattern) { throw ('Foreground window "' + $target.MainWindowTitle + '" does not match ${title}.') }
[void][SightlineInput]::ShowWindow($target.MainWindowHandle, 9)
[void][SightlineInput]::BringWindowToTop($target.MainWindowHandle)
[void][SightlineInput]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 300
[SightlineInput]::SetCursorPos(${num(p.x)}, ${num(p.y)}) | Out-Null
[SightlineInput]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[SightlineInput]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
Write-Output 'clicked play control'`;
    }
    case 'windowAction': {
      const title = str(p.title, '');
      const process = str(p.process, '');
      const action = str(p.action, 'minimize').toLowerCase();
      const preferred = Math.max(0, num(p.handle, 0));
      const allowed = new Set(['minimize', 'maximize', 'restore', 'close']);
      if (!allowed.has(action)) throw new Error(`Unknown window action: ${action}`);
      return `${pre}
$action = ${psQuote(action)}
$title = ${psQuote(title)}
$process = ${psQuote(process)}
$preferred = [Int64]${preferred}
# Only real, visible top-level windows count; packaged apps expose hidden twins
# that accept ShowWindow but never change state.
$candidates = @(Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and [SightlineInput]::IsWindowVisible($_.MainWindowHandle) -and (
    ($title -ne '' -and $_.MainWindowTitle -like ('*' + $title + '*')) -or
    ($process -ne '' -and $_.ProcessName -like ('*' + $process + '*'))
  )
} | Sort-Object Id)
if ($candidates.Count -eq 0 -and $title -eq '' -and $process -eq '') {
  $fg = [SightlineInput]::GetForegroundWindow()
  $candidates = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg })
}
if ($candidates.Count -eq 0) { throw ('No window matched title "' + $title + '" or process "' + $process + '".') }
# Try the window this run already resolved first, then the foreground one, then
# the rest; a frame/content twin may refuse the action, so verify each attempt.
$fgWindow = [SightlineInput]::GetForegroundWindow()
$ordered = New-Object System.Collections.ArrayList
foreach ($c in $candidates) {
  if ($preferred -gt 0 -and $c.MainWindowHandle.ToInt64() -eq $preferred) { [void]$ordered.Add($c) }
}
foreach ($c in $candidates) {
  if ($c.MainWindowHandle -eq $fgWindow) { [void]$ordered.Add($c) }
}
foreach ($c in $candidates) { [void]$ordered.Add($c) }
$seen = New-Object System.Collections.ArrayList
$result = $null
foreach ($candidate in $ordered) {
  $h = $candidate.MainWindowHandle
  if ($seen -contains $h.ToInt64()) { continue }
  [void]$seen.Add($h.ToInt64())
  $windowTitle = $candidate.MainWindowTitle
  $done = $false
  switch ($action) {
    'minimize' {
      [void][SightlineInput]::ShowWindow($h, 6)
      Start-Sleep -Milliseconds 300
      $done = [SightlineInput]::IsIconic($h)
    }
    'maximize' {
      [void][SightlineInput]::ShowWindow($h, 3)
      Start-Sleep -Milliseconds 300
      $done = [SightlineInput]::IsZoomed($h)
      if ($done) { [void][SightlineInput]::SetForegroundWindow($h) }
    }
    'restore' {
      [void][SightlineInput]::ShowWindow($h, 9)
      if ([SightlineInput]::IsIconic($h)) {
        [SightlineInput]::SwitchToThisWindow($h, $true)
        Start-Sleep -Milliseconds 300
      }
      $done = -not [SightlineInput]::IsIconic($h)
      if ($done) {
        [void][SightlineInput]::BringWindowToTop($h)
        [void][SightlineInput]::SetForegroundWindow($h)
      }
    }
    'close' {
      if ($candidate.CloseMainWindow()) {
        Start-Sleep -Milliseconds 700
        $candidate.Refresh()
        $done = $candidate.HasExited -or $candidate.MainWindowHandle -eq 0
      }
    }
  }
  if ($done) { $result = $candidate; break }
}
if (-not $result) { throw ('Windows did not ' + $action + ' any window matching title "' + $title + '" or process "' + $process + '".') }
Start-Sleep -Milliseconds 200
Write-Output ($action + ' ' + $result.MainWindowTitle + ' hwnd=' + $result.MainWindowHandle)`;
    }
    case 'closeWindow': {
      const title = str(p.title, 'YouTube');
      const pattern = psQuote(`*${title}*`);
      return `${pre}
$pattern = ${pattern}
$fg = [SightlineInput]::GetForegroundWindow()
$target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
if (-not $target) { throw 'No foreground window to close.' }
if ($target.MainWindowTitle -notlike $pattern) { throw ('Refusing to close "' + $target.MainWindowTitle + '": it does not match ${title}.') }
$closedTitle = $target.MainWindowTitle
if (-not $target.CloseMainWindow()) { throw ('Windows refused to close "' + $closedTitle + '".') }
Start-Sleep -Milliseconds 700
Write-Output ('closed ' + $closedTitle)`;
    }
    case 'scroll': {
      const lines = num(p.amount, 3);
      const delta = Math.max(-20, Math.min(20, lines)) * 120;
      return `${pre}${foregroundGuard(p, 'scroll')}
${p.x != null && p.y != null ? `[SightlineInput]::SetCursorPos(${num(p.x)}, ${num(p.y)}) | Out-Null` : ''}
[SightlineInput]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)
Write-Output 'scrolled'`;
    }
    case 'type': {
      const b64 = sendKeysText(str(p.text));
      return `${pre}${foregroundGuard(p, 'type')}
$escaped = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
# One SendKeys expression for the whole paragraph lost characters in a busy
# app (“Alpha bravo charlie” arrived as “Alpha ravo crlie”, and a capital after
# Enter arrived lowercase), so each unit is sent on its own with a short pause.
$i = 0
while ($i -lt $escaped.Length) {
  if ($escaped[$i] -eq [char]'{') {
    $end = $escaped.IndexOf('}', $i)
    $unit = $escaped.Substring($i, $end - $i + 1)
    $i = $end + 1
  } else {
    $unit = [string]$escaped[$i]
    $i = $i + 1
  }
  [System.Windows.Forms.SendKeys]::SendWait($unit)
  Start-Sleep -Milliseconds 12
}
Write-Output 'typed'`;
    }
    case 'key': {
      const repeat = Math.max(1, Math.min(50, num(p.repeat, 1)));
      const interval = Math.max(0, Math.min(5000, num(p.intervalMs, 120)));
      const shortcuts = normalizeShortcutKeys(p.keys);
      if (!shortcuts.length) throw new Error('Key step needs at least one shortcut, e.g. ctrl+a or ctrl+c.');
      const sends = shortcuts
        .map(
          (keys) => `  [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})
  Start-Sleep -Milliseconds ${Math.max(30, Math.min(2000, num(p.gapMs, interval)))}`
        )
        .join('\n');
      return `${pre}${foregroundGuard(p, 'send keys')}
for ($i = 0; $i -lt ${repeat}; $i++) {
${sends}
  if (${interval} -gt 0 -and $i -lt ${repeat - 1}) { Start-Sleep -Milliseconds ${interval} }
}
Write-Output ('sent ${repeat}x ' + ${psQuote(shortcuts.join(', '))})`;
    }
    case 'launchApp': {
      const launchArgs = Array.isArray(p.args) ? p.args : p.args ? [p.args] : [];
      const argList = launchArgs.map((arg) => psQuote(arg)).join(', ');
      const argSuffix = launchArgs.length ? ` -ArgumentList @(${argList})` : '';
      // Everything below has to finish inside the step's timeout: PowerShell
      // start-up, a Get-StartApps lookup, Start-Process and the fronting poll.
      // A fixed 8 second poll overran a 15 second budget when the lookup was
      // slow, so the step was killed ("Command timed out.") and its retry
      // launched the app again — the second window in the report. The poll now
      // spends only the time the step has left.
      const launchBudgetMs = Math.max(4000, Math.min(120000, num(step.timeoutMs, 15000)));
      // A known app may not be on PATH: its catalogue entry lists the real
      // executable paths, which also lets arguments (a video file) be passed.
      const known = catalogEntry([str(p.app), str(p.target)].filter(Boolean));
      const knownExes = (known?.exe || []).filter(Boolean);
      const knownProcess = str(known?.process);
      const catalogueBlock = knownExes.length
        ? `$catalogue = @(${knownExes.map((exe) => psQuote(exe)).join(', ')})
foreach ($candidate in $catalogue) {
  if (Test-Path -LiteralPath $candidate) {
    $launched = Start-Process -FilePath $candidate${argSuffix} -PassThru
    Show-SightlineFront $frontLeaf $launched.Id
    Write-Output ('launched ' + $candidate)
    exit 0
  }
}`
        : '';
      return `${pre}
$launchBudgetMs = ${launchBudgetMs}
$scriptStarted = Get-Date
$target = ${psQuote(str(p.target))}
if (-not $target) { throw 'Launch app step needs a target app name, executable or document path.' }
$leaf = [System.IO.Path]::GetFileNameWithoutExtension($target)
$isPath = $target -match '[\\/]' -or $target -match '\.\w+$'
# Installer, updater and download windows are not the installed app. They are
# never adopted as "already open", and after a launch the real app window is
# raised instead of leaving whichever window was in front on top.
$frontLeaf = ${psQuote(knownProcess)}
$reuseExisting = ${p.reuseExisting === true || p.reuse === true ? 1 : 0}
if (-not $frontLeaf) { $frontLeaf = $leaf }
$setupPattern = '(?i)(setup|installer|installing|installation|uninstall|downloading|download|wizard|extracting|updating)'
# Prefer the exact process this launch created: raising “whichever window has
# that app's name” once brought the operator's own document to the front and
# the run typed into it. Start-Process -PassThru gives the new process's Id;
# the fronting waits for that process's window specifically and only falls
# back to a name search when the launched process never shows one.
function Show-SightlineFront($processLeaf, $preferPid) {
  if (-not $processLeaf) { return }
  # Spend only what the step has left, keeping 3s for PowerShell to shut down.
  # A slow Get-StartApps lookup therefore shortens the poll instead of pushing
  # the script past the step timeout, which killed it and let the retry launch
  # a second window. At most 8s is ever spent looking for the window.
  $left = $launchBudgetMs - 3000 - ((Get-Date) - $scriptStarted).TotalMilliseconds
  $budget = [Math]::Max(0, [Math]::Min(8000, $left))
  $deadline = (Get-Date).AddMilliseconds($budget)
  $front = $null
  # Check once even with no budget left: the window may already be there, and
  # the front line is the evidence the following steps rely on.
  while ($true) {
    if ($preferPid) {
      $own = @(Get-Process -Id $preferPid -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
      if ($own.Count) { $front = $own[0]; break }
    } else {
      $hits = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like ('*' + $processLeaf + '*') })
      $front = $hits | Where-Object { $_.MainWindowTitle -notmatch $setupPattern } | Sort-Object Id -Descending | Select-Object -First 1
      if (-not $front) { $front = $hits | Sort-Object Id -Descending | Select-Object -First 1 }
      if ($front) { break }
    }
    if ((Get-Date) -ge $deadline) { break }
    Start-Sleep -Milliseconds 300
  }
  if (-not $front -and $preferPid) {
    # Tab-hosted apps (Notepad on Windows 11) hang the new tab on an existing
    # window's process, so the launched Id never shows its own window. Fall back
    # to the name search; the app itself activated the new tab on launch.
    $hits = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like ('*' + $processLeaf + '*') })
    $front = $hits | Where-Object { $_.MainWindowTitle -notmatch $setupPattern } | Sort-Object Id -Descending | Select-Object -First 1
    if (-not $front) { $front = $hits | Sort-Object Id -Descending | Select-Object -First 1 }
  }
  if (-not $front) { return }
  [void][SightlineInput]::ShowWindow($front.MainWindowHandle, 9)
  [void][SightlineInput]::SetWindowPos($front.MainWindowHandle, [IntPtr]::Zero, 0, 0, 0, 0, 0x43)
  [void][SightlineInput]::BringWindowToTop($front.MainWindowHandle)
  [void][SightlineInput]::SetForegroundWindow($front.MainWindowHandle)
  Start-Sleep -Milliseconds 250
  Write-Output ('front ' + $front.ProcessName + ' :: ' + $front.MainWindowTitle + ' [hwnd=' + $front.MainWindowHandle.ToInt64() + ']')
}
if (-not $isPath -and ${launchArgs.length} -eq 0 -and $reuseExisting -eq 1) {
  $existing = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like ('*' + $leaf + '*') -or $_.MainWindowTitle -like ('*' + $target + '*'))
  } | Where-Object { $_.MainWindowTitle -notmatch $setupPattern } | Sort-Object Id -Descending)
  $existing = $existing | Select-Object -First 1
  if ($existing) {
    [void][SightlineInput]::ShowWindow($existing.MainWindowHandle, 9)
    [void][SightlineInput]::BringWindowToTop($existing.MainWindowHandle)
    [void][SightlineInput]::SetForegroundWindow($existing.MainWindowHandle)
    Write-Output ('focused existing ' + $existing.ProcessName + ' :: ' + $existing.MainWindowTitle + ' [hwnd=' + $existing.MainWindowHandle.ToInt64() + ']')
    exit 0
  }
}
${catalogueBlock}
$windowMatch = if (-not $isPath -and $target -match '\\s') {
  $windowHits = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like ('*' + $target + '*') } | Where-Object { $_.MainWindowTitle -notmatch $setupPattern })
  $windowHits | Sort-Object Id | Select-Object -First 1
}
if ($windowMatch) {
  [void][SightlineInput]::ShowWindow($windowMatch.MainWindowHandle, 9)
  [void][SightlineInput]::BringWindowToTop($windowMatch.MainWindowHandle)
  [void][SightlineInput]::SetForegroundWindow($windowMatch.MainWindowHandle)
  Write-Output ('focused window ' + $windowMatch.ProcessName + ' :: ' + $windowMatch.MainWindowTitle + ' [hwnd=' + $windowMatch.MainWindowHandle.ToInt64() + ']')
  exit 0
}
if (Test-Path -LiteralPath $target) {
  $launched = Start-Process -FilePath $target${argSuffix} -PassThru
  Show-SightlineFront $frontLeaf $launched.Id
  Write-Output ('launched ' + $target)
  exit 0
}
$startApp = $null
try { $startApp = Get-StartApps | Where-Object { $_.Name -like ('*' + $target + '*') } | Select-Object -First 1 } catch { }
if ($startApp) {
  $launched = Start-Process ('shell:AppsFolder\\' + $startApp.AppID) -PassThru
  Show-SightlineFront $frontLeaf $launched.Id
  Write-Output ('launched ' + $startApp.Name)
  exit 0
}
$shortcut = $null
# A desktop icon is how the operator launches an app, so the Desktop is
# searched first: a shortcut there is as much an installed app as one in the
# Start Menu.
foreach ($root in @([Environment]::GetFolderPath('Desktop'), "$env:PUBLIC\\Desktop", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $shortcut = Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -like ('*' + $target + '*') } | Select-Object -First 1
  if ($shortcut) { break }
}
if ($shortcut) {
  $launched = Start-Process -FilePath $shortcut.FullName${argSuffix} -PassThru
  Show-SightlineFront $frontLeaf $launched.Id
  Write-Output ('launched shortcut ' + $shortcut.BaseName)
  exit 0
}
try {
  $launched = Start-Process -FilePath $target${argSuffix} -PassThru
  Show-SightlineFront $frontLeaf $launched.Id
} catch {
  throw ('Cannot launch "' + $target + '": it is not an executable, path or installed app. For a window title, use focusWindow. ' + $_.Exception.Message)
}
Write-Output ('launched ' + $target)`;
    }
    case 'openUrl': {
      const app = str(p.app);
      const url = normalizeUrl(p.url);
      const newWindow = p.newWindow !== false;
      if (app) {
        return `${pre}
$chromeArgs = @()
if (${newWindow ? '$true' : '$false'}) { $chromeArgs += '--new-window' }
if (${p.maximized === true ? '$true' : '$false'}) { $chromeArgs += '--start-maximized' }
$chromeArgs += ${psQuote(url)}
Start-Process -FilePath ${psQuote(app)} -ArgumentList $chromeArgs
Write-Output 'opened'`;
      }
      return `${pre}
Start-Process ${psQuote(url)}
Write-Output 'opened'`;
    }
    case 'focusWindow': {
      // A handle recorded at launch names one exact window. Title and process
      // stay as fallbacks so old steps and hand-written steps keep working.
      const handle = Math.max(0, Number(p.handle || p.hwnd || p.windowHandle) || 0);
      return `${pre}
$title = ${psQuote(str(p.title || p.windowName || p.windowTitle))}
$processName = ${psQuote(str(p.process))}
$requestedHandle = [int64]${handle}
if (-not $title -and -not $processName -and $requestedHandle -le 0) { throw 'Focus window needs a title, process name or handle.' }
$pattern = '*' + $title + '*'
$desiredProcess = $processName
if (-not $desiredProcess -and $title) {
  $candidate = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $pattern } | Sort-Object Id | Select-Object -First 1
  if ($candidate) { $desiredProcess = $candidate.ProcessName }
}
$procPattern = '*' + $desiredProcess + '*'
$fg = [SightlineInput]::GetForegroundWindow()
$fgProc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
# A window of the same app is not the window that was asked for: several
# documents often share one process (Notepad, Explorer). Count the foreground
# only when its title matches too, or the step would type into the wrong file.
$handleOk = if ($requestedHandle -gt 0) { $fg.ToInt64() -eq $requestedHandle } else { $true }
$fgMatch = if ($fgProc -and $handleOk) {
  $procOk = if ($desiredProcess) { $fgProc.ProcessName -like $procPattern } else { $true }
  # With an exact handle the title is informational; it changes as documents do.
  $titleOk = if ($title -and $requestedHandle -le 0) { $fgProc.MainWindowTitle -like $pattern } else { $true }
  $procOk -and $titleOk
} else { $false }
if ($fgMatch) {
  Write-Output ('already focused ' + $fgProc.ProcessName + ' :: ' + $fgProc.MainWindowTitle + ' [hwnd=' + $fg.ToInt64() + ']')
  exit 0
}
if ($requestedHandle -gt 0) {
  # The exact window wins over every name match, including a dialog that is not
  # its process's MainWindow.
  $byHandle = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq ([IntPtr]$requestedHandle) } | Select-Object -First 1
  if ($byHandle) {
    $target = $byHandle
  } else {
    $hTitle = New-Object System.Text.StringBuilder 512
    [void][SightlineInput]::GetWindowText([IntPtr]$requestedHandle, $hTitle, $hTitle.Capacity)
    $hPid = 0
    [void][SightlineInput]::GetWindowThreadProcessId([IntPtr]$requestedHandle, [ref]$hPid)
    $hProc = ''
    try { $hProc = (Get-Process -Id $hPid -ErrorAction Stop).ProcessName } catch { }
    $target = [pscustomobject]@{ MainWindowHandle = [IntPtr]$requestedHandle; ProcessName = $hProc; MainWindowTitle = [string]$hTitle.ToString(); Id = $hPid }
  }
} else {
  $target = $null
}
$lookalike = '(?i)(setup|installer|installing|installation|uninstall|downloading|download|wizard|extracting)'
if (-not $target) {
  $candidates = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and (
      ($desiredProcess -and $_.ProcessName -like $procPattern) -or
      (-not $desiredProcess -and $_.MainWindowTitle -like $pattern)
    )
  })
  $target = $candidates | Where-Object { $_.MainWindowTitle -notmatch $lookalike } | Sort-Object Id -Descending | Select-Object -First 1
}
if (-not $target) { $target = $candidates | Sort-Object Id -Descending | Select-Object -First 1 }
if (-not $target -and $title) {
  # Dialogs (Save As, Open, installers) are windows without being a process's
  # MainWindow; find them through UI Automation before giving up.
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      $childName = [string]$child.Current.Name
      if (-not $childName -or $childName -notlike $pattern) { continue }
      $childHandle = [IntPtr]$child.Current.NativeWindowHandle
      if ($childHandle -eq [IntPtr]::Zero) { continue }
      $childPid = [int]$child.Current.ProcessId
      $childProc = ''
      try { $childProc = (Get-Process -Id $childPid -ErrorAction Stop).ProcessName } catch { }
      $target = [pscustomobject]@{ MainWindowHandle = $childHandle; ProcessName = $childProc; MainWindowTitle = $childName; Id = $childPid }
      break
    }
  } catch { }
}
if (-not $target) { throw ('No window matching title "' + $title + '" or process "' + $processName + '".') }
$focusMethod = 'SetForegroundWindow'
if ([SightlineInput]::IsIconic($target.MainWindowHandle)) {
  [void][SightlineInput]::ShowWindow($target.MainWindowHandle, 9)
  $focusMethod = 'restore+SetForegroundWindow'
}
# SetWindowPos with HWND_TOP plus SHOWWINDOW lifts the window out of the
# background. The title-bar click below is the final activation fallback.
[void][SightlineInput]::ShowWindowAsync($target.MainWindowHandle, 9)
[void][SightlineInput]::SetWindowPos($target.MainWindowHandle, [IntPtr]::Zero, 0, 0, 0, 0, 0x43)
[void][SightlineInput]::BringWindowToTop($target.MainWindowHandle)
[void][SightlineInput]::SetForegroundWindow($target.MainWindowHandle)
Start-Sleep -Milliseconds 350
# Packaged apps raise a frame window owned by another process, so a process-id
# comparison reports failure even when the requested window is in front. Check
# the foreground window itself and the requested title/process instead.
function Test-Focused {
  $fgNow = [SightlineInput]::GetForegroundWindow()
  if ($fgNow -eq $target.MainWindowHandle) { return $true }
  $fgNowProc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fgNow } | Select-Object -First 1
  if (-not $fgNowProc) { return $false }
  if ($title -and $fgNowProc.MainWindowTitle -like $pattern) { return $true }
  if ($desiredProcess -and $fgNowProc.ProcessName -like $procPattern) { return $true }
  return $false
}
if (-not (Test-Focused)) {
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate($target.Id)
  Start-Sleep -Milliseconds 250
}
if (-not (Test-Focused)) {
  $focusMethod = 'SwitchToThisWindow'
  [SightlineInput]::SwitchToThisWindow($target.MainWindowHandle, $true)
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Focused)) {
  # Focus-stealing prevention: a synthetic Alt tap unlocks SetForegroundWindow,
  # and AttachThreadInput lets this thread attach to the current foreground.
  $focusMethod = 'AttachThreadInput'
  [SightlineInput]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [SightlineInput]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  $fgThread = 0
  $targetThread = 0
  $fgOwner = 0
  $targetOwner = 0
  $fgThread = [SightlineInput]::GetWindowThreadProcessId([SightlineInput]::GetForegroundWindow(), [ref]$fgOwner)
  $targetThread = [SightlineInput]::GetWindowThreadProcessId($target.MainWindowHandle, [ref]$targetOwner)
  if ($fgThread -and $targetThread -and $fgThread -ne $targetThread) {
    [void][SightlineInput]::AttachThreadInput($fgThread, $targetThread, $true)
  }
  [void][SightlineInput]::SetFocus($target.MainWindowHandle)
  [void][SightlineInput]::BringWindowToTop($target.MainWindowHandle)
  [void][SightlineInput]::SetForegroundWindow($target.MainWindowHandle)
  if ($fgThread -and $targetThread -and $fgThread -ne $targetThread) {
    [void][SightlineInput]::AttachThreadInput($fgThread, $targetThread, $false)
  }
  Start-Sleep -Milliseconds 350
}
if (-not (Test-Focused)) {
  # Some Windows foreground locks ignore every API attempt but still accept a
  # real click in the title bar. This click is only used after all API paths.
  $focusMethod = 'title-bar click'
  $rect = New-Object SightlineInput+RECT
  $oldCursor = New-Object SightlineInput+POINT
  $hadCursor = [SightlineInput]::GetCursorPos([ref]$oldCursor)
  if ([SightlineInput]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
    $clickX = [int](($rect.Left + $rect.Right) / 2)
    $clickY = [int]([Math]::Max(0, $rect.Top + 10))
    [void][SightlineInput]::SetCursorPos($clickX, $clickY)
    [SightlineInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 45
    [SightlineInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 350
  }
  if ($hadCursor) { [void][SightlineInput]::SetCursorPos($oldCursor.X, $oldCursor.Y) }
}
$label = if ($desiredProcess) { $desiredProcess } elseif ($title) { $title } else { $processName }
if (-not (Test-Focused)) {
  $fgNow = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq ([SightlineInput]::GetForegroundWindow()) } | Select-Object -First 1
  $actual = if ($fgNow) { $fgNow.ProcessName + ' :: ' + $fgNow.MainWindowTitle } else { '(unknown)' }
  throw ('Window "' + $label + '" was found but Windows would not bring it to the foreground after ' + $focusMethod + '. Foreground is "' + $actual + '".')
}
Write-Output ('focused ' + $target.ProcessName + ' :: ' + $target.MainWindowTitle + ' [hwnd=' + $target.MainWindowHandle.ToInt64() + '] [' + $focusMethod + ']')`;
    }
    case 'wait':
      return `Start-Sleep -Milliseconds ${Math.min(num(p.ms, 1000), 600000)}
Write-Output 'waited'`;
    case 'waitFor': {
      const kind = str(p.kind, 'window');
      const value = str(p.value);
      const present = str(p.mode, 'present') !== 'absent';
      const timeout = Math.min(Math.max(num(p.timeoutMs ?? step.timeoutMs, 30000), 1000), 600000);
      const interval = Math.min(Math.max(num(p.intervalMs, 1000), 200), 10000);
      const check =
        kind === 'file'
          ? `Test-Path -LiteralPath ${psQuote(value)}`
          : kind === 'process'
          ? `[bool](Get-Process -Name ${psQuote(value)} -ErrorAction SilentlyContinue)`
          : `$( $hitWindow = $false; try { Add-Type -AssemblyName UIAutomationClient; $rootEl = [System.Windows.Automation.AutomationElement]::RootElement; foreach ($child in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) { if ([string]$child.Current.Name -like ${psQuote(`*${value}*`)}) { $hitWindow = $true; break } } } catch { }; $hitWindow )`;
      return `${pre}
$deadline = (Get-Date).AddMilliseconds(${timeout})
$met = $false
while ((Get-Date) -lt $deadline) {
  $hit = ${check}
  if ($hit -eq $${present}) { $met = $true; break }
  Start-Sleep -Milliseconds ${interval}
}
if (-not $met) { throw ${psQuote(
        `Timed out after ${timeout}ms waiting for ${kind} to be ${present ? 'present' : 'absent'}: ${value}`
      )} }
Write-Output ${psQuote(`${kind} ${present ? 'present' : 'absent'}: ${value}`)}`;
    }
    case 'expect': {
      const kind = str(p.kind, 'window');
      const value = str(p.value);
      if (kind === 'file') {
        return `if (-not (Test-Path -LiteralPath ${psQuote(value)})) { throw ${psQuote(`File not found: ${value}`)} }
Write-Output 'file present'`;
      }
      if (kind === 'process') {
        return `$p = Get-Process -Name ${psQuote(value)} -ErrorAction SilentlyContinue
if (-not $p) { throw ${psQuote(`Process not running: ${value}`)} }
Write-Output 'process running'`;
      }
      if (kind === 'foreground') {
        return `${pre}
# Read the title from the foreground handle itself: dialogs and packaged apps are
# not a process's MainWindowTitle, so Get-Process would report "(unknown)".
$fg = [IntPtr]::Zero
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  $fg = [SightlineInput]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
$fgTitle = ''
$fgProcess = ''
if ($fg -ne [IntPtr]::Zero) {
  $len = [SightlineInput]::GetWindowTextLength($fg)
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][SightlineInput]::GetWindowText($fg, $sb, $sb.Capacity)
  $fgTitle = [string]$sb.ToString()
  [uint32]$fgPid = 0
  [void][SightlineInput]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  if ($fgPid) { try { $fgProcess = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { } }
  if (-not $fgTitle) {
    try {
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $fgElement = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
      if ($fgElement) { $fgTitle = [string]$fgElement.Current.Name }
    } catch { }
  }
}
$expected = ${psQuote(value)}
$matched = ($fgTitle -like ('*' + $expected + '*')) -or ($fgProcess -like ('*' + $expected + '*'))
$actual = if ($fgProcess -or $fgTitle) { $fgProcess + ' :: ' + $fgTitle } else { '(no foreground window title)' }
if (-not $matched) { throw ('Foreground window is "' + $actual + '", expected process or window "${value}".') }
Write-Output ('foreground: ' + $actual)`;
      }
      if (kind === 'window') {
        return `$foundWindow = ''
try {
  Add-Type -AssemblyName UIAutomationClient
  $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($child in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $childName = [string]$child.Current.Name
    if ($childName -like ${psQuote(`*${value}*`)}) { $foundWindow = $childName; break }
  }
} catch { }
if (-not $foundWindow) { throw ${psQuote(`No window title contains "${value}"`)} }
Write-Output ('window: ' + $foundWindow)`;
      }
      if (kind === 'url') {
        return `Write-Output 'url assertions are not supported in this executor build'`;
      }
      return `throw ${psQuote(`Unsupported assertion kind: ${kind}`)}`;
    }
    default:
      return null;
  }
}

/**
 * Execute one workflow step.
 * ctx: { live, runId, run, workflow, getTool, tools }
 * Returns { output, evidence: [] }
 */
export async function readMediaProgress(title = 'YouTube') {
  const expected = str(title, 'YouTube');
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
$fg = [SightlineInput]::GetForegroundWindow()
$target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
if (-not $target) { throw 'No foreground media window.' }
if ($target.MainWindowTitle -notlike ${psQuote(`*${expected}*`)}) { throw ('Foreground window "' + $target.MainWindowTitle + '" does not match ${expected}.') }
$old = New-Object SightlineInput+POINT
[void][SightlineInput]::GetCursorPos([ref]$old)
$rect = New-Object SightlineInput+RECT
if ([SightlineInput]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
  $cx = [int](($rect.Left + $rect.Right) / 2); $cy = [int](($rect.Top + $rect.Bottom) / 2)
  [void][SightlineInput]::SetCursorPos($cx + 24, $cy)
  Start-Sleep -Milliseconds 90
  [void][SightlineInput]::SetCursorPos($cx, $cy)
  Start-Sleep -Milliseconds 700
}
$win = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$best = $null
$bestMax = -1
$bestValue = -1
$timePos = -1
$timeDur = -1
$playing = $null
$ad = $false
foreach ($e in $all) {
  try {
    $ct = [string]$e.Current.ControlType.ProgrammaticName
    $name = [string]$e.Current.Name
    if ($ct -match 'Button' -and $name -match '^(Pause|Play) \(k\)$') {
      $playing = $name -match '^Pause'
    }
    if ($name -match '(?i)^(ad|advertisement)$|skip ad|sponsored') { $ad = $true }
    if ($name -match '(?i)^(?:(\d+)\s+Minutes?\s+)?(\d+)\s+Seconds?\s+of\s+(?:(\d+)\s+Minutes?\s+)?(\d+)\s+Seconds?$') {
      $m = [int]$matches[1]; $s = [int]$matches[2]; $dm = [int]$matches[3]; $ds = [int]$matches[4]
      if ($m -ge 0 -and $dm -ge 0) { $timePos = $m * 60 + $s; $timeDur = $dm * 60 + $ds }
    }
    if ($ct -match 'Slider' -and $name -match 'seek|progress|position|timeline') {
      $range = $e.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
      $max = [double]$range.Current.Maximum
      $value = [double]$range.Current.Value
      if ($max -le 0) { continue }
      if ($max -lt $bestMax -or ($max -eq $bestMax -and $value -le $bestValue)) { continue }
      $bestMax = $max
      $bestValue = $value
      $best = [pscustomobject]@{
        title = [string]$target.MainWindowTitle
        position = [math]::Round($value, 2)
        duration = [math]::Round($max, 2)
        control = $name
        source = 'uia-seek-slider'
      }
    }
  } catch { }
}
if (-not $best -and $timeDur -le 0) {
  [void][SightlineInput]::SetCursorPos($old.X, $old.Y)
  throw 'No seek slider or time display found in the foreground media window.'
}
if ($timeDur -gt 0 -and ($null -eq $best -or ($timeDur -ge $bestMax - 5 -and $timePos -ge $bestValue - 2))) {
  $best = [pscustomobject]@{
    title = [string]$target.MainWindowTitle
    position = [math]::Round($timePos, 2)
    duration = [math]::Round($timeDur, 2)
    control = 'time display'
    source = 'uia-time-display'
  }
}
$best | Add-Member -NotePropertyName playing -NotePropertyValue $playing -Force
$best | Add-Member -NotePropertyName ad -NotePropertyValue $ad -Force
[void][SightlineInput]::SetCursorPos($old.X, $old.Y)
$best | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) throw new Error(res.stderr || res.stdout || 'Could not read media progress.');
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Media progress was not JSON: ${res.stdout.slice(0, 300)}`);
  }
  return {
    title: str(parsed.title, expected),
    position: Number(parsed.position) || 0,
    duration: Number(parsed.duration) || 0,
    control: str(parsed.control, 'seek slider'),
    source: str(parsed.source, 'uia-seek-slider'),
    playing: parsed.playing === true ? true : parsed.playing === false ? false : null,
    ad: Boolean(parsed.ad),
  };
}

export async function findUiElement({ window = '', name = '', controlType = '', preferLast = false, preferRight = false } = {}) {
  const needle = str(name).trim();
  if (!needle) throw new Error('An element name is required.');
  const windowNeedle = str(window).trim();
  const pattern = windowNeedle ? '*' + windowNeedle + '*' : '*';
  const namePattern = '*' + needle + '*';
  const typeCheck = controlType
    ? `if ($ct -notmatch ${psQuote(str(controlType))}) { continue }`
    : '';
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
$pattern = ${psQuote(pattern)}
if ($pattern -eq '*') {
  $fg = [SightlineInput]::GetForegroundWindow()
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
} else {
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $pattern } | Sort-Object Id | Select-Object -First 1
  if (-not $target) {
    $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $pattern } | Sort-Object Id | Select-Object -First 1
  }
}
if (-not $target) { Write-Output '{"found":false,"reason":"window not found"}'; exit 0 }
$win = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $best = $null
    $bestScore = -1
    $bestX = -1
$needle = ${psQuote(needle)}
$needleLower = $needle.ToLowerInvariant()
$tokens = @($needleLower -split '[^a-z0-9]+' | Where-Object { $_.Length -gt 1 })
$dpi = 96
try { $dpi = [SightlineInput]::GetDpiForWindow($target.MainWindowHandle) } catch { }
if (-not $dpi -or $dpi -le 0) { $dpi = 96 }
foreach ($e in $all) {
  try {
    $ct = [string]$e.Current.ControlType.ProgrammaticName
    $n = [string]$e.Current.Name
    if (-not $n -or $n.Length -gt 240) { continue }
    ${typeCheck}
    if ($e.Current.IsOffscreen) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    $nl = $n.ToLowerInvariant()
    $score = 0
    if ($nl -eq $needleLower) { $score = 120 }
    elseif ($nl.StartsWith($needleLower)) { $score = 100 }
    elseif ($nl.Contains($needleLower)) { $score = 80 }
    elseif ($tokens.Count -gt 0) {
      $matched = @($tokens | Where-Object { $nl.Contains($_) }).Count
      if ($matched -eq $tokens.Count) { $score = 60 }
      elseif ($matched -gt 0) { $score = 20 + (10 * $matched) }
    }
    if ($score -le 0) { continue }
    if ($ct -match 'Button') { $score += 4 }
    if ($e.Current.IsEnabled) { $score += 2 }
    if ($score -lt $bestScore) { continue }
    if ($score -eq $bestScore) {
      if (${preferRight ? '$true' : '$false'} -and $r.X -le $bestX) { continue }
      if (-not ${preferRight ? '$true' : '$false'} -and -not ${preferLast ? '$true' : '$false'}) { continue }
    }
    $bestScore = $score
    $bestX = $r.X
    $best = [pscustomobject]@{
      found = $true
      title = [string]$target.MainWindowTitle
      name = $n
      controlType = $ct
      x = [math]::Round($r.X + ($r.Width / 2))
      y = [math]::Round($r.Y + ($r.Height / 2))
      width = [math]::Round($r.Width)
      height = [math]::Round($r.Height)
      scale = [math]::Round($dpi / 96.0, 2)
      score = $score
    }
  } catch { }
}
if (-not $best) { Write-Output '{"found":false,"reason":"element not present"}'; exit 0 }
$best | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) throw new Error(res.stderr || res.stdout || 'Could not inspect UI elements.');
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Element inspection was not JSON: ${res.stdout.slice(0, 300)}`);
  }
  if (!parsed.found) return { found: false, reason: str(parsed.reason, 'not present'), window: str(parsed.title) };
  return {
    found: true,
    title: str(parsed.title),
    name: str(parsed.name, needle),
    controlType: str(parsed.controlType),
    x: Number(parsed.x) || 0,
    y: Number(parsed.y) || 0,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
    scale: Number(parsed.scale) || 1,
    score: Number(parsed.score) || 0,
  };
}

/**
 * Find a named control by reading the window's text.
 *
 * UI Automation is the right answer and the wrong one for a Tk app: the toolkit
 * exposes no element tree, so every named click fell through to the vision
 * model — 0.7–52 s a call, and on this app's Settings button 39 px off centre and
 * only 4 px from the button's edge. The desktop's own OCR reads the same label in
 * 19–46 ms, and the label sits inside the control that carries it.
 *
 * One capture, one OCR pass and one ink pass run in a single PowerShell call: the
 * label's dark pixels give the anchor, because a Windows OCR box is a line box
 * and its centre sits about half a line low on a small button. Chrome above the
 * client area is ignored, so a title bar's "Profile" cannot outrank the button.
 *
 * restore:false leaves a minimized window as it is. A minimized window still
 * reports a small rectangle, so the capture succeeds and reads nothing — the
 * failure this guard prevents, reproducible on demand for the comparison test.
 * Production callers never pass it.
 */
/**
 * The controls in a window that can hold a caret, as Windows reports them.
 *
 * Only focusable, on-screen, not-read-only Edit, Document and ComboBox
 * descendants are returned. The window's own rectangle comes back too, because
 * where a control sits in its window is what tells a chat box (low, small) from
 * an editor surface (the whole pane).
 */
export async function findEditableControls({ window = '', limit = 40 } = {}) {
  if (!IS_WINDOWS) return { found: false, controls: [], reason: 'UI Automation requires Windows' };
  const windowNeedle = str(window).trim();
  const pattern = windowNeedle ? '*' + windowNeedle + '*' : '*';
  const cap = Math.max(1, Math.min(60, Number(limit) || 40));
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
$pattern = ${psQuote(pattern)}
if ($pattern -eq '*') {
  $fg = [SightlineInput]::GetForegroundWindow()
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
} else {
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $pattern } | Sort-Object Id | Select-Object -First 1
  if (-not $target) {
    $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $pattern } | Sort-Object Id | Select-Object -First 1
  }
}
if (-not $target) { Write-Output '{"found":false,"controls":[],"reason":"window not found"}'; exit 0 }
$win = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
$wr = $win.Current.BoundingRectangle
$list = @()
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($e in $all) {
  try {
    $ct = ([string]$e.Current.ControlType.ProgrammaticName) -replace '^ControlType\.',''
    if ($ct -notmatch '^(Edit|Document|ComboBox)$') { continue }
    if ($e.Current.IsOffscreen) { continue }
    if (-not $e.Current.IsKeyboardFocusable) { continue }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -lt 40 -or $r.Height -lt 12) { continue }
    $readonly = $false
    try {
      $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $readonly = [bool]$vp.Current.IsReadOnly
    } catch { }
    if ($readonly) { continue }
    $list += [pscustomobject]@{
      name = [string]$e.Current.Name
      controlType = $ct
      x = [math]::Round($r.X + ($r.Width / 2))
      y = [math]::Round($r.Y + ($r.Height / 2))
      width = [math]::Round($r.Width)
      height = [math]::Round($r.Height)
      keyboardFocusable = [bool]$e.Current.IsKeyboardFocusable
      readonly = $readonly
      window = [string]$target.MainWindowTitle
    }
    if ($list.Count -ge ${cap}) { break }
  } catch { }
}
if (-not $list.Count) { Write-Output '{"found":false,"controls":[],"reason":"no editable control in the window"}'; exit 0 }
[pscustomobject]@{
  found = $true
  window = [string]$target.MainWindowTitle
  windowTop = [math]::Round($wr.Y)
  windowHeight = [math]::Round($wr.Height)
  controls = $list
} | ConvertTo-Json -Depth 4 -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) throw new Error(res.stderr || res.stdout || 'Could not inspect editable controls.');
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Editable control inspection was not JSON: ${res.stdout.slice(0, 300)}`);
  }
  if (!parsed.found) return { found: false, controls: [], reason: str(parsed.reason, 'not present'), window: str(parsed.window) };
  const controls = (Array.isArray(parsed.controls) ? parsed.controls : []).map((item) => ({
    name: str(item.name),
    controlType: str(item.controlType),
    x: Number(item.x) || 0,
    y: Number(item.y) || 0,
    width: Number(item.width) || 0,
    height: Number(item.height) || 0,
    keyboardFocusable: item.keyboardFocusable !== false,
    readonly: item.readonly === true,
    window: str(item.window),
  }));
  return {
    found: true,
    window: str(parsed.window),
    windowTop: Number(parsed.windowTop) || 0,
    windowHeight: Number(parsed.windowHeight) || 0,
    controls,
  };
}

export async function findUiElementByOcr({ window = '', name = '', names = null, timeoutMs = 20000, restore = true, labelsOnly = false } = {}) {
  const wanted = (Array.isArray(names) && names.length ? names : [name]).map((item) => str(item).trim()).filter(Boolean);
  if (!wanted.length && !labelsOnly) throw new Error('An element name is required.');
  if (!IS_WINDOWS) return { found: false, reason: 'reading a label with OCR requires Windows' };
  const file = path.join(CAPTURES, `${uid('ocr')}.png`);
  const windowNeedle = str(window).trim();
  const pattern = windowNeedle ? '*' + windowNeedle + '*' : '*';
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$windowPattern = ${psQuote(pattern)}
if ($windowPattern -eq '*') {
  $fg = [SightlineInput]::GetForegroundWindow()
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
} else {
  $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like $windowPattern } | Sort-Object Id | Select-Object -First 1
  if (-not $target) {
    $target = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $windowPattern } | Sort-Object Id | Select-Object -First 1
  }
}
if (-not $target) { Write-Output '{"found":false,"reason":"window not found"}'; exit 0 }
$handle = $target.MainWindowHandle
# A minimized window has no screen area to read: the capture below would grab an
# off-screen rectangle, OCR would find no text and a named control would quietly
# fall through to the vision model. Restore it first, the way the vision path does.
$restoreWindow = ${restore ? '$true' : '$false'}
if ($restoreWindow -and [SightlineInput]::IsIconic($handle)) {
  [void][SightlineInput]::ShowWindow($handle, 9)
  Start-Sleep -Milliseconds 250
}
$rect = New-Object SightlineInput+RECT
if (-not [SightlineInput]::GetWindowRect($handle, [ref]$rect)) { Write-Output '{"found":false,"reason":"window rectangle unavailable"}'; exit 0 }
$width = [int]($rect.Right - $rect.Left)
$height = [int]($rect.Bottom - $rect.Top)
if ($width -lt 8 -or $height -lt 8) { Write-Output '{"found":false,"reason":"window has no readable area (minimized or off-screen)"}'; exit 0 }
# Everything above the client area is title bar and frame, never a control.
$contentTop = 0
$clientRect = New-Object SightlineInput+RECT
$clientOrigin = New-Object SightlineInput+POINT
if ([SightlineInput]::GetClientRect($handle, [ref]$clientRect)) {
  if ([SightlineInput]::ClientToScreen($handle, [ref]$clientOrigin)) { $contentTop = [int]($clientOrigin.Y - $rect.Top) }
}
$t0 = Get-Date
$bmp = New-Object System.Drawing.Bitmap $width, $height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$msCapture = [int]((Get-Date) - $t0).TotalMilliseconds
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await-Ocr($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { $bmp.Dispose(); Write-Output '{"found":false,"reason":"no OCR language is installed"}'; exit 0 }
$fileRef = Await-Ocr ([Windows.Storage.StorageFile]::GetFileFromPathAsync(${psQuote(file)})) ([Windows.Storage.StorageFile])
$stream = Await-Ocr ($fileRef.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-Ocr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$software = Await-Ocr ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$decodeMs = [int]((Get-Date) - $t0).TotalMilliseconds - $msCapture
$started = Get-Date
$result = Await-Ocr ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
$ms = [int]((Get-Date) - $started).TotalMilliseconds
$words = @()
foreach ($line in $result.Lines) {
  foreach ($word in $line.Words) {
    $box = $word.BoundingRect
    $wx = [int]$box.X
    $wy = [int]$box.Y
    $ww = [int]$box.Width
    $wh = [int]$box.Height
    # The label's own dark pixels, measured inside its box with a little room for
    # the glyph edges the OCR box clips.
    $ink = $null
    if ($ww -gt 2 -and $wh -gt 2 -and $ww -lt 800 -and $wh -lt 200) {
      $sumX = 0.0
      $sumY = 0.0
      $count = 0
      $pad = 4
      $x0 = [math]::Max(0, $wx - $pad)
      $y0 = [math]::Max(0, $wy - $pad)
      $x1 = [math]::Min($width - 1, $wx + $ww + $pad)
      $y1 = [math]::Min($height - 1, $wy + $wh + $pad)
      for ($py = $y0; $py -le $y1; $py += 1) {
        for ($px = $x0; $px -le $x1; $px += 1) {
          $colour = $bmp.GetPixel($px, $py)
          $luminance = (0.299 * $colour.R) + (0.587 * $colour.G) + (0.114 * $colour.B)
          if ($luminance -lt 128) { $sumX += $px; $sumY += $py; $count += 1 }
        }
      }
      if ($count -gt 0) { $ink = @{ x = [math]::Round($sumX / $count, 1); y = [math]::Round($sumY / $count, 1); pixels = $count } }
    }
    $words += @{ text = [string]$word.Text; x = $wx; y = $wy; w = $ww; h = $wh; ink = $ink }
  }
}
$bmp.Dispose()
[pscustomobject]@{
  ok = $true
  ms = $ms
  captureMs = $msCapture
  decodeMs = $decodeMs
  inkMs = [int]((Get-Date) - $t0).TotalMilliseconds - $msCapture - $decodeMs - $ms
  image = ${psQuote(file)}
  origin = @{ x = [int]$rect.Left; y = [int]$rect.Top }
  width = $width
  height = $height
  contentTop = $contentTop
  title = [string]$target.MainWindowTitle
  words = $words
} | ConvertTo-Json -Compress -Depth 6`;
  const res = await runPowerShell(script, Math.max(10000, Number(timeoutMs) || 20000));
  if (!res.ok) return { found: false, reason: res.stderr || res.stdout || 'the OCR read failed' };
  const line = String(res.stdout || '').split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`OCR read was not JSON: ${line.slice(0, 300)}`);
  }
  const shot = {
    kind: 'screenshot',
    caption: 'Window read for a text locator',
    path: path.relative(DATA, file).split(path.sep).join('/'),
    width: Number(parsed.width) || null,
    height: Number(parsed.height) || null,
  };
  if (!parsed.ok) return { found: false, reason: str(parsed.reason, 'no OCR result'), shot };
  // The client area starts below the title bar; the capture starts at the
  // window's corner, so the difference is where chrome ends in capture pixels.
  const lines = ocrLines(parsed.words, { minY: Math.max(0, Number(parsed.contentTop) || 0) });
  // Callers that need to know what a screen says (not where one control is) get
  // the read text instead of a point: one capture, one OCR pass, same cost.
  if (labelsOnly) {
    return {
      found: false,
      labels: lines.map((line) => line.text).filter(Boolean),
      title: str(parsed.title),
      shot,
      ms: Number(parsed.ms) || 0,
    };
  }
  const best = matchOcrLine(lines, wanted);
  if (!best) {
    return {
      found: false,
      reason: lines.length ? `no line in “${str(parsed.title)}” reads as ${wanted.map((item) => `“${item}”`).join(' or ')}` : 'no text was read in the window',
      shot,
      lines: lines.length,
      ms: Number(parsed.ms) || 0,
    };
  }
  const ink = lineInk(best.line);
  const anchor = ocrLineAnchor(best.line, ink);
  const point = ocrScreenPoint(anchor, parsed.origin);
  if (!point) return { found: false, reason: `“${best.line.text}” was read but has no usable box`, shot, ms: Number(parsed.ms) || 0 };
  return {
    found: true,
    x: point.x,
    y: point.y,
    text: best.line.text,
    score: best.score,
    method: 'OCR',
    ink: Boolean(ink),
    ms: Number(parsed.ms) || 0,
    // Where the time went: the read itself is milliseconds, the process and
    // the frame around it are not. Recorded so the cost is never guessed.
    timings: {
      captureMs: Number(parsed.captureMs) || 0,
      decodeMs: Number(parsed.decodeMs) || 0,
      inkMs: Number(parsed.inkMs) || 0,
    },
    shot,
  };
}

export async function readFocusedElement() {
  if (!IS_WINDOWS) throw new Error('Focused element inspection requires Windows UI Automation.');
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
$focused = $null
try { $focused = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { }
if (-not $focused) { Write-Output '{"found":false,"reason":"nothing is focused"}'; exit 0 }
$name = [string]$focused.Current.Name
if (-not $name) { $name = [string]$focused.Current.AutomationId }
$ct = ([string]$focused.Current.ControlType.ProgrammaticName) -replace '^ControlType\.',''
$local = [string]$focused.Current.LocalizedControlType
$targetPid = 0
[void][SightlineInput]::GetWindowThreadProcessId($focused.Current.NativeWindowHandle, [ref]$targetPid)
$window = ''
$procName = ''
if ($targetPid -gt 0) {
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($proc) { $window = [string]$proc.MainWindowTitle; $procName = [string]$proc.ProcessName }
}
$fg = [SightlineInput]::GetForegroundWindow()
$fgProc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
$fgWindow = if ($fgProc) { [string]$fgProc.MainWindowTitle } else { '' }
$fgProcess = if ($fgProc) { [string]$fgProc.ProcessName } else { '' }
if (-not $window) { $window = $fgWindow }
if (-not $procName) { $procName = $fgProcess }
if (-not $window) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $node = $focused
  for ($i = 0; $i -lt 12 -and $node; $i++) {
    if ($node.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') { $window = [string]$node.Current.Name; break }
    $node = $walker.GetParent($node)
  }
}
if (-not $name) { Write-Output '{"found":false,"reason":"focused control has no accessible name"}'; exit 0 }
$value = ''
try {
  $vp = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value = [string]$vp.Current.Value
} catch { }
$editable = $false
$readonly = $false
if ($ct -eq 'Edit' -or $ct -eq 'Document') { $editable = $true }
try {
  $vpRead = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $readonly = [bool]$vpRead.Current.IsReadOnly
} catch { }
if ($readonly) { $editable = $false }
if (-not $focused.Current.IsKeyboardFocusable) { $editable = $false }
$r = $focused.Current.BoundingRectangle
[pscustomobject]@{
  found = $true
  name = $name
  controlType = $ct
  localizedControlType = $local
  value = $value
  window = $window
  process = $procName
  x = [math]::Round($r.X + ($r.Width / 2))
  y = [math]::Round($r.Y + ($r.Height / 2))
  width = [math]::Round($r.Width)
  height = [math]::Round($r.Height)
  editable = $editable
  readonly = $readonly
} | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) throw new Error(res.stderr || res.stdout || 'Could not read the focused element.');
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`Focused element was not JSON: ${res.stdout.slice(0, 300)}`);
  }
  if (!parsed.found) return { found: false, reason: str(parsed.reason, 'nothing is focused') };
  return {
    found: true,
    name: str(parsed.name),
    value: str(parsed.value).slice(0, 4000),
    controlType: str(parsed.controlType),
    localizedControlType: str(parsed.localizedControlType),
    editable: parsed.editable === true,
    readonly: parsed.readonly === true,
    window: str(parsed.window),
    process: str(parsed.process),
    x: Number(parsed.x) || 0,
    y: Number(parsed.y) || 0,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
  };
}

let appCache = { at: 0, value: null };

/** Running windows and installed Start-menu apps, used to ground the planner. */
export async function discoverApps({ force = false } = {}) {
  if (!IS_WINDOWS) return { windows: [], apps: [], processes: [] };
  if (!force && appCache.value && Date.now() - appCache.at < 15000) return appCache.value;
  const script = `${BASE_PRELUDE}
$windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
  $version = ''
  try { $version = [string]$_.MainModule.FileVersionInfo.FileVersion } catch { }
  [pscustomobject]@{
    process = [string]$_.ProcessName
    title = [string]$_.MainWindowTitle
    id = [int]$_.Id
    version = $version
  }
} | Sort-Object process | Select-Object -First 60)
$apps = @()
try {
  $apps = @(Get-StartApps | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.Name; appId = [string]$_.AppID }
  } | Sort-Object name | Select-Object -First 100)
} catch { }
$processes = @($windows | ForEach-Object { $_.process } | Sort-Object -Unique)
[pscustomobject]@{ windows = $windows; apps = $apps; processes = $processes } | ConvertTo-Json -Depth 4 -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) return { windows: [], apps: [], processes: [], error: res.stderr || res.stdout };
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { windows: [], apps: [], processes: [], error: 'App discovery was not JSON.' };
  }
  const value = {
    windows: Array.isArray(parsed.windows) ? parsed.windows : [],
    apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
  };
  appCache = { at: Date.now(), value };
  return value;
}

export async function readForegroundWindow() {
  if (!IS_WINDOWS) return { title: '', process: '', id: null, hwnd: 0, className: '', path: '', version: '' };
  const script = `${BASE_PRELUDE}
$fg = [SightlineInput]::GetForegroundWindow()
# Read the title and process from the handle itself: a process can own several
# windows, and a dialog is nobody's MainWindow.
$fgTitle = ''
if ($fg -ne [IntPtr]::Zero) {
  $len = [SightlineInput]::GetWindowTextLength($fg)
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    [void][SightlineInput]::GetWindowText($fg, $sb, $sb.Capacity)
    $fgTitle = [string]$sb.ToString()
  }
}
$fgPid = 0
if ($fg -ne [IntPtr]::Zero) { [void][SightlineInput]::GetWindowThreadProcessId($fg, [ref]$fgPid) }
$p = if ($fgPid -gt 0) { Get-Process -Id $fgPid -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
if (-not $fgTitle -and $p) { $fgTitle = [string]$p.MainWindowTitle }
if (-not $fgTitle -and $fg -ne [IntPtr]::Zero) {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $fgElement = [System.Windows.Automation.AutomationElement]::FromHandle($fg)
    if ($fgElement) { $fgTitle = [string]$fgElement.Current.Name }
  } catch { }
}
$class = New-Object System.Text.StringBuilder 256
if ($fg -ne [IntPtr]::Zero) { [void][SightlineInput]::GetClassName($fg, $class, $class.Capacity) }
$path = ''
if ($p) { try { $path = [string]$p.Path } catch { } }
$version = ''
if ($path) {
  try {
    $info = (Get-Item -LiteralPath $path).VersionInfo
    $version = [string]$info.FileVersion
    if (-not $version) { $version = [string]$info.ProductVersion }
  } catch { }
}

[pscustomobject]@{
  title = $fgTitle
  process = if ($p) { [string]$p.ProcessName } else { '' }
  id = if ($p) { [int]$p.Id } else { 0 }
  hwnd = if ($fg -ne [IntPtr]::Zero) { $fg.ToInt64() } else { 0 }
  className = [string]$class.ToString()
  path = $path
  version = $version
} | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 10000);
  if (!res.ok) return { title: '', process: '', id: null, className: '', path: '', version: '', error: res.stderr || res.stdout };
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    return {
      title: str(parsed.title),
      process: str(parsed.process),
      id: Number(parsed.id) || null,
      hwnd: Number(parsed.hwnd) || 0,
      className: str(parsed.className),
      path: str(parsed.path),
      version: str(parsed.version),
    };
  } catch {
    return { title: '', process: '', id: null, hwnd: 0, className: '', path: '', version: '', error: 'Foreground window was not JSON.' };
  }
}

/**
 * Read the text a window exposes through UI Automation. This is the free half
 * of a screen judgement: no model call, no pixels, and it can prove that the
 * expected text is in the run's own document (or that stale text is gone).
 */
export async function readWindowText({ handle = 0, title = '', limit = 20000 } = {}) {
  if (!IS_WINDOWS) return { text: '', source: '', error: 'UI Automation text is only available on Windows.' };
  const maxChars = Math.max(200, Math.min(200000, Number(limit) || 20000));
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$handle = [int64]${Math.max(0, Number(handle) || 0)}
$title = ${psQuote(String(title || ''))}
$win = $null
if ($handle -gt 0) {
  try { $win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle) } catch { $win = $null }
}
if (-not $win -and $title) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($child in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ([string]$child.Current.Name -like ('*' + $title + '*')) { $win = $child; break }
  }
}
if (-not $win) { Write-Output '{"text":"","source":""}'; exit 0 }
$docType = [System.Windows.Automation.ControlType]::Document
$docCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $docType)
$docs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)
$parts = New-Object System.Collections.Generic.List[string]
$total = 0
foreach ($doc in $docs) {
  try {
    $tp = $doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $text = [string]$tp.DocumentRange.GetText(${maxChars})
    if ($text) { $parts.Add($text); $total += $text.Length }
  } catch { }
  if ($total -ge ${maxChars}) { break }
}
$source = 'document'
if ($parts.Count -eq 0) {
  # Apps without a Document control still expose their visible labels; the
  # concatenated names are enough to prove a passage is on screen.
  $source = 'labels'
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
  foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $name = [string]$el.Current.Name
    if (-not $name) { continue }
    $parts.Add($name)
    $total += $name.Length
    if ($total -ge ${maxChars}) { break }
  }
}
$text = ($parts -join [Environment]::NewLine)
if ($text.Length -gt ${maxChars}) { $text = $text.Substring(0, ${maxChars}) }
[pscustomobject]@{ text = $text; source = $source } | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) return { text: '', source: '', error: res.stderr || res.stdout };
  const line = String(res.stdout || '').split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(line);
    return { text: str(parsed.text).slice(0, maxChars), source: str(parsed.source) };
  } catch {
    return { text: '', source: '', error: 'Window text was not JSON.' };
  }
}

/**
 * Distinguish a foreground target from the same app sitting in the background,
 * minimized, running without a visible window, or genuinely closed. This is
 * read-only and is used by the continuity verifier before suggesting a relaunch.
 */
export async function inspectWindowState({ title = '', process: processName = '' } = {}) {
  const requested = { title: String(title || '').trim(), process: String(processName || '').trim() };
  if (!IS_WINDOWS) return { state: 'unknown', supported: false, ...requested, foreground: null, matches: [] };
  if (!requested.title && !requested.process) {
    return { state: 'unknown', supported: true, ...requested, foreground: null, matches: [] };
  }
  const script = `${BASE_PRELUDE}
$title = ${psQuote(requested.title)}
$processName = ${psQuote(requested.process)}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$fg = [SightlineInput]::GetForegroundWindow()
$fgText = New-Object System.Text.StringBuilder 512
$fgClass = New-Object System.Text.StringBuilder 256
if ($fg -ne [IntPtr]::Zero) {
  [void][SightlineInput]::GetWindowText($fg, $fgText, $fgText.Capacity)
  [void][SightlineInput]::GetClassName($fg, $fgClass, $fgClass.Capacity)
}
[uint32]$fgProcessId = 0
if ($fg -ne [IntPtr]::Zero) { [void][SightlineInput]::GetWindowThreadProcessId($fg, [ref]$fgProcessId) }
$fgProcessName = ''
if ($fgProcessId) { try { $fgProcessName = (Get-Process -Id $fgProcessId -ErrorAction Stop).ProcessName } catch { } }
$fgProc = if ($fg -ne [IntPtr]::Zero) { [pscustomobject]@{ ProcessName = $fgProcessName; MainWindowTitle = [string]$fgText; Id = [int]$fgProcessId } } else { $null }
# Dialogs are not a process's MainWindow, so enumerate real top-level windows
# through UI Automation and match their titles (a Save As dialog is a window).
$matches = @()
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($child in $children) {
    $name = [string]$child.Current.Name
    if (-not $name) { continue }
    $childPid = [int]$child.Current.ProcessId
    $childProc = ''
    try { $childProc = (Get-Process -Id $childPid -ErrorAction Stop).ProcessName } catch { }
    $titleHit = $title -and ($name -like ('*' + $title + '*'))
    $processHit = $processName -and ($childProc -like ('*' + $processName + '*'))
    if (-not ($titleHit -or $processHit)) { continue }
    $handle = [IntPtr]$child.Current.NativeWindowHandle
    $windowState = if ($name -eq [string]$fgText) { 'foreground' } elseif ([SightlineInput]::IsIconic($handle)) { 'minimized' } elseif ([SightlineInput]::IsWindowVisible($handle)) { 'background' } else { 'hidden' }
    $matches += [pscustomobject]@{ process = $childProc; title = $name; id = $childPid; state = $windowState }
    if ($matches.Count -ge 8) { break }
  }
} catch { }
$proc = $null
if ($processName) {
  $proc = Get-Process -Name ('*' + $processName + '*') -ErrorAction SilentlyContinue | Select-Object -First 1
} elseif ($matches.Count -gt 0) {
  $proc = Get-Process -Id $matches[0].id -ErrorAction SilentlyContinue | Select-Object -First 1
}
$state = 'closed'
if ($matches | Where-Object { $_.state -eq 'foreground' }) { $state = 'foreground' }
elseif ($matches | Where-Object { $_.state -eq 'minimized' }) { $state = 'minimized' }
elseif ($matches | Where-Object { $_.state -eq 'background' }) { $state = 'background' }
elseif ($proc) { $state = 'hidden' }
[pscustomobject]@{
  state = $state
  processRunning = [bool]$proc
  foreground = if ($fgProc) { [pscustomobject]@{ process = [string]$fgProc.ProcessName; title = [string]$fgProc.MainWindowTitle; id = [int]$fgProc.Id } } else { $null }
  matches = $matches
} | ConvertTo-Json -Depth 4 -Compress`;
  const res = await runPowerShell(script, 12000);
  if (!res.ok) return { state: 'unknown', supported: true, ...requested, foreground: null, matches: [], error: res.stderr || res.stdout };
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    return {
      state: ['foreground', 'background', 'minimized', 'hidden', 'closed'].includes(parsed.state) ? parsed.state : 'unknown',
      supported: true,
      ...requested,
      processRunning: Boolean(parsed.processRunning),
      foreground: parsed.foreground || null,
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
    };
  } catch {
    return { state: 'unknown', supported: true, ...requested, foreground: null, matches: [], error: 'Window state was not JSON.' };
  }
}

export async function readClipboardText() {
  if (!IS_WINDOWS) throw new Error('Clipboard access requires Windows.');
  const script = `
$text = ''
try { $text = Get-Clipboard -Raw -ErrorAction Stop } catch { }
if ($null -eq $text) { $text = '' }
[pscustomobject]@{ text = [string]$text } | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 10000);
  if (!res.ok) throw new Error(`Could not read the clipboard: ${res.stderr || res.stdout || 'unknown error'}`);
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  try {
    return String(JSON.parse(line).text ?? '');
  } catch {
    throw new Error('Clipboard contents were not JSON.');
  }
}

export async function writeClipboardText(text) {
  if (!IS_WINDOWS) throw new Error('Clipboard access requires Windows.');
  const value = String(text ?? '');
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const script = value
    ? `
$text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))
Set-Clipboard -Value $text
Write-Output ('clipboard ' + $text.Length + ' chars')`
    : `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::Clear()
Write-Output 'clipboard 0 chars'`;
  const res = await runPowerShell(script, 10000);
  if (!res.ok) throw new Error(`Could not write the clipboard: ${res.stderr || res.stdout || 'unknown error'}`);
  return String(text ?? '');
}

function resolveNote(params = {}) {
  const d = db();
  if (params.noteId) return d.notes.find((note) => note.id === params.noteId) || null;
  const needle = String(params.title || params.query || '').trim().toLowerCase();
  if (!needle) return null;
  return d.notes.find((note) => String(note.title || '').toLowerCase().includes(needle)) || null;
}

function saveInteractionNote({ title, body, tags = [], runId, workflowId, append = true }) {
  fs.mkdirSync(NOTES, { recursive: true });
  const d = db();
  const cleanTitle = String(title || 'Interaction notes').trim().slice(0, 180) || 'Interaction notes';
  const text = String(body || '').trim();
  if (!text) throw new Error('A note needs some text to save.');
  const stamp = new Date().toISOString();
  let note = append ? d.notes.find((item) => String(item.title || '') === cleanTitle) : null;
  if (note) {
    const previous = note.body || (note.file ? fs.readFileSync(path.join(ROOT, note.file), 'utf8') : '');
    note.body = `${previous.trim()}\n\n---\n\n_${stamp}_\n\n${text}`;
    note.updatedAt = stamp;
    note.tags = [...new Set([...(note.tags || []), ...tags])];
    if (note.file) writeFileDurable(path.join(ROOT, note.file), note.body);
  } else {
    const id = uid('note');
    const file = path.join(NOTES, `${slug(cleanTitle)}-${id}.md`);
    const full = `# ${cleanTitle}\n\n_${stamp}_\n\n${text}`;
    writeFileDurable(file, full);
    note = {
      id,
      title: cleanTitle,
      body: full,
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      source: 'workflow',
      workflowId: workflowId || null,
      runId: runId || null,
      tags: [...new Set(tags)],
      createdAt: now(),
    };
    d.notes.unshift(note);
  }
  persist();
  return note;
}

function safeFileName(value, fallback = 'file') {
  const base = path.basename(String(value || '').replace(/[\\/]+/g, '-'));
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 160) : fallback;
}

function desktopFolder() {
  const standard = path.join(os.homedir(), 'Desktop');
  if (fs.existsSync(standard)) return standard;
  const oneDrive = path.join(os.homedir(), 'OneDrive', 'Desktop');
  if (fs.existsSync(oneDrive)) return oneDrive;
  return standard;
}

function uniqueFile(folder, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(folder, name);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(folder, `${stem}-${n++}${ext}`);
  return candidate;
}

/** Mirror the download step's folder and filename rules so a re-run can skip work. */
function downloadDestination(url, params = {}) {
  const folderName = safeFileName(params.folder || 'media', 'media').replace(/\.[^.]+$/, '');
  const folder = path.join(DATA, folderName);
  let name = safeFileName(params.filename, '');
  if (!name) {
    try {
      name = safeFileName(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''), '');
    } catch {}
  }
  if (!name) name = `${params.kind || 'media'}-${Date.now()}`;
  if (!path.extname(name)) name += params.kind === 'video' ? '.mp4' : params.kind === 'image' ? '.png' : '.bin';
  return { folder, name };
}

/** A file this step already downloaded is a fact; report it instead of downloading again. */
export function findExistingDownload(params = {}) {
  const url = String(params.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { found: false, reason: 'no url' };
  const { folder, name } = downloadDestination(url, params);
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  try {
    const entries = fs.readdirSync(folder);
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?:-\\d+)?${escapedExt}$`, 'i');
    const match = entries.find((entry) => pattern.test(entry));
    if (!match) return { found: false };
    const full = path.join(folder, match);
    const stat = fs.statSync(full);
    return {
      found: true,
      path: path.relative(ROOT, full).split(path.sep).join('/'),
      filename: match,
      bytes: stat.size,
    };
  } catch {
    return { found: false };
  }
}

/**
 * Find a file matching a glob in the user's Downloads folder. Used before a
 * download click so a re-run continues when the installer is already there.
 */
export function findDownloadedFile({ pattern = '', dir = '', withinDays = 0 } = {}) {
  const folder = dir || path.join(os.homedir(), 'Downloads');
  const glob = String(pattern || '').trim();
  if (!glob) return { found: false, reason: 'no pattern' };
  const regex = new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i'
  );
  try {
    const cutoff = withinDays > 0 ? Date.now() - withinDays * 86400000 : 0;
    const entries = fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile());
    const matches = entries
      .filter((entry) => regex.test(entry.name))
      .map((entry) => {
        const full = path.join(folder, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, path: full, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), mtime: stat.mtimeMs };
      })
      .filter((entry) => !cutoff || entry.mtime >= cutoff)
      .sort((left, right) => right.mtime - left.mtime);
    if (!matches.length) return { found: false, folder };
    const [latest] = matches;
    return { found: true, folder, ...latest };
  } catch {
    return { found: false, folder };
  }
}

/** Parse an address that may be displayed without its scheme (Chrome hides https://). */
function parseAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {}
  try {
    return new URL(`https://${raw.replace(/^\/+/g, '')}`);
  } catch {
    return null;
  }
}

/** True when the URL's host/path already matches one of its own page URLs. */
function samePageAddress(address, target) {
  const left = parseAddress(address);
  const right = parseAddress(target);
  if (!left || !right) return String(address || '').trim() === String(target || '').trim();
  if (left.hostname.replace(/^www\./i, '') !== right.hostname.replace(/^www\./i, '')) return false;
  const leftPath = left.pathname.replace(/\/$/, '');
  const rightPath = right.pathname.replace(/\/$/, '');
  return leftPath === rightPath || (leftPath && rightPath && (leftPath.startsWith(rightPath) || rightPath.startsWith(leftPath)));
}

const GENERIC_URL_TOKENS = new Set([
  'download', 'downloads', 'windows', 'index', 'watch', 'video', 'videos', 'media', 'page', 'pages',
  'html', 'home', 'docs', 'file', 'files', 'www', 'http', 'https', 'en-us', 'en-gb', 'en', 'last',
  'com', 'org', 'net', 'edu', 'gov', 'co', 'uk', 'io', 'html', 'php', 'asp', 'aspx',
]);
const usefulToken = (value) => {
  const token = String(value || '').toLowerCase();
  return token.length >= 3 && !GENERIC_URL_TOKENS.has(token) && !/^\d+$/.test(token);
};

/** Distinctive words from a URL's host and path, used when an address bar is unreadable. */
export function urlTitleTokens(url) {
  try {
    const parsed = new URL(url);
    const labels = parsed.hostname
      .replace(/^www\./i, '')
      .split('.')
      .filter(usefulToken);
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .map((segment) => segment.replace(/\.[^.]+$/, ''))
      .filter(usefulToken);
    return [...new Set([...labels, ...segments].map((token) => token.toLowerCase()))];
  } catch {
    return [];
  }
}

/**
 * Look for a browser window that already shows this page, using each browser's
 * address-bar value first and a distinctive window-title token as a fallback.
 * This keeps a re-run on the page it already has instead of opening a new tab.
 */
export async function findOpenUrl({ url = '', matchTitle = '' } = {}) {
  const target = normalizeUrl(url);
  if (!/^https?:\/\//i.test(target)) return { found: false, supported: IS_WINDOWS, reason: 'no http(s) url' };
  if (!IS_WINDOWS) return { found: false, supported: false };
  const script = `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$procs = Get-Process chrome, msedge, firefox, brave, opera, vivaldi -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
$editCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$hits = @()
foreach ($p in $procs) {
  $address = ''
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
    $seen = 0
    foreach ($e in $edits) {
      if ($seen -ge 16) { break }
      $seen++
      try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $val = if ($vp) { [string]$vp.Current.Value } else { '' }
        # Chrome, Edge and Firefox do not always name the omnibox consistently;
        # accept the first control whose value looks like a URL.
        if ($val -match '^(https?://|www\.)' -or $val -match '^[\w.-]+\.[a-z]{2,}(/|$|:)' -or $val -match '^\d{1,3}(\.\d{1,3}){3}(:\d+)?') {
          $address = $val
          break
        }
      } catch { }
    }
  } catch { }
  $hits += [pscustomobject]@{ process = [string]$p.ProcessName; title = [string]$p.MainWindowTitle; id = [int]$p.Id; address = $address }
}
$hits | ConvertTo-Json -Compress`;
  try {
    const res = await runPowerShell(script, 20000);
    if (!res.ok) return { found: false, supported: true, error: (res.stderr || res.stdout || '').slice(0, 200) };
    const line = String(res.stdout || '').split(/\r?\n/).filter(Boolean).pop() || '[]';
    const parsed = JSON.parse(line);
    const windows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    const exact = windows.find((win) => samePageAddress(win.address, target));
    if (exact) return { found: true, process: exact.process, title: exact.title, url: exact.address, method: 'address bar' };
    const tokens = urlTitleTokens(target);
    if (matchTitle) tokens.push(String(matchTitle).toLowerCase());
    const titled = windows.find((win) => {
      const haystack = String(win.title || '').toLowerCase();
      return tokens.some((token) => token && haystack.includes(token));
    });
    if (titled) return { found: true, process: titled.process, title: titled.title, url: titled.address || target, method: 'window title' };
    return {
      found: false,
      supported: true,
      windows: windows.length,
      candidates: windows.slice(0, 4).map((win) => ({
        process: win.process,
        title: String(win.title || '').slice(0, 120),
        address: String(win.address || '').slice(0, 160),
      })),
      tokens,
    };
  } catch (err) {
    return { found: false, supported: true, error: err.message };
  }
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ].filter(Boolean);
  const packages = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  if (packages && fs.existsSync(packages)) {
    try {
      for (const pkg of fs.readdirSync(packages)) {
        if (!/^Gyan\.FFmpeg/i.test(pkg)) continue;
        const packageDir = path.join(packages, pkg);
        for (const build of fs.readdirSync(packageDir)) {
          candidates.push(path.join(packageDir, build, 'bin', 'ffmpeg.exe'));
        }
      }
    } catch {}
  }
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) || '';
}

function runExecutable(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim() || (error?.killed ? 'Command timed out.' : ''),
        ms: Date.now() - started,
      });
    });
  });
}

export function elementLabels(name) {
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  const labels = [raw];
  const clean = raw
    .replace(/[.…:•·|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean && clean !== raw) labels.push(clean);
  const words = clean.split(' ').filter(Boolean);
  if (words.length > 4) labels.push(words.slice(0, 4).join(' '));
  if (words.length > 2) labels.push(words.slice(-2).join(' '));
  return [...new Set(labels.filter((label) => label.length >= 2))];
}

async function getWindowDpiScale(title = '') {
  if (!IS_WINDOWS) return 1;
  const pattern = title ? `*${String(title).replace(/[\r\n]/g, ' ')}*` : '*';
  const script = `${BASE_PRELUDE}
$p = if (${psQuote(pattern)} -eq '*') {
  $fg = [SightlineInput]::GetForegroundWindow()
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowHandle -eq $fg } | Select-Object -First 1
} else {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like ${psQuote(pattern)} } | Select-Object -First 1
}
if (-not $p) { Write-Output '1'; exit 0 }
$dpi = 96
try { $dpi = [SightlineInput]::GetDpiForWindow($p.MainWindowHandle) } catch { }
if (-not $dpi -or $dpi -le 0) { $dpi = 96 }
Write-Output ([math]::Round($dpi / 96.0, 2))`;
  const res = await runPowerShell(script, 10000);
  const scale = Number(String(res.stdout || '').trim());
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// --- fast vision locate ------------------------------------------------------
// A locate is slow because of what it sends: a full-resolution PNG upload and
// its image prefill. Downscaling to a JPEG, capping the reply budget, sharing
// duplicate asks onto one request and reusing a result while the screen is
// unchanged removes most of that cost without changing the decision itself.
const VISION_MAX_WIDTH = Math.max(0, Math.min(2560, Number(process.env.SIGHTLINE_VISION_MAX_WIDTH ?? 1280)));
const VISION_JPEG_QUALITY = Math.max(40, Math.min(95, Number(process.env.SIGHTLINE_VISION_JPEG_QUALITY ?? 80)));
const VISION_ENABLED = process.env.SIGHTLINE_VISION_JPEG !== '0';
// Opt-in crop: send only the foreground window instead of the whole desktop.
const VISION_CROP = process.env.SIGHTLINE_VISION_CROP === 'foreground' ? 'foreground' : undefined;
const LOCATE_CACHE_MS = Math.max(0, Math.min(60000, Number(process.env.SIGHTLINE_LOCATE_CACHE_MS ?? 4000)));
const locateInflight = new Map();
const locateCache = new Map();
// A visual check reads the same screen more than once while nothing changes on
// it, so a verdict for an identical frame and question is reusable briefly.
const VERDICT_CACHE_MS = Math.max(0, Math.min(60000, Number(process.env.SIGHTLINE_VERDICT_CACHE_MS ?? 5000)));
const verdictCache = new Map();

/** Base64 for the model, preferring the downscaled view over the full PNG. */
function modelImage(shot) {
  const relative = shot?.vision?.path || shot?.path;
  if (!relative) return '';
  return fs.readFileSync(path.join(DATA, relative)).toString('base64');
}

function verdictCacheKey(question, signature) {
  return `${String(question || '').slice(0, 240)}::${signature || ''}`;
}

function readVerdict(question, signature) {
  if (VERDICT_CACHE_MS <= 0 || !signature) return null;
  const key = verdictCacheKey(question, signature);
  const hit = verdictCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > VERDICT_CACHE_MS) {
    verdictCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeVerdict(question, signature, value) {
  if (VERDICT_CACHE_MS <= 0 || !signature) return;
  if (verdictCache.size >= 40) verdictCache.delete(verdictCache.keys().next().value);
  verdictCache.set(verdictCacheKey(question, signature), { at: Date.now(), value });
}

function locateKey(description, title = '') {
  return `${String(title || '').toLowerCase()}::${String(description || '').trim().toLowerCase()}`;
}

async function locateElementOnce({ description, title = '', minConfidence = 0.6 } = {}) {
  const target = String(description || '').trim();
  if (!target) return { found: false, reason: 'no target description' };
  const key = locateKey(target, title);
  const shot = await liveScreenshot(null, {
    maxWidth: VISION_ENABLED ? VISION_MAX_WIDTH : 0,
    quality: VISION_JPEG_QUALITY,
    // A locate over the whole desktop can match a control in another app, which
    // is how keystrokes end up somewhere the workflow never named. With a named
    // window the frame is that window alone.
    crop: title ? 'foreground' : VISION_CROP,
  });
  if (!frameIsTargetWindow(shot, title)) {
    return { found: false, reason: `“${title}” is not the window on screen (“${shot.cropTitle}”)`, shot };
  }
  const cached = locateCache.get(key);
  if (
    LOCATE_CACHE_MS > 0 &&
    cached &&
    shot.signature &&
    cached.signature === shot.signature &&
    Date.now() - cached.at < LOCATE_CACHE_MS
  ) {
    return { ...cached.result, shot, cached: true };
  }
  const view = shot.vision || {
    path: shot.path,
    width: Number(shot.width) || 1920,
    height: Number(shot.height) || 1080,
    cropX: 0,
    cropY: 0,
    cropWidth: Number(shot.width) || 1920,
    cropHeight: Number(shot.height) || 1080,
    bytes: null,
  };
  const width = Number(view.width) || 1920;
  const height = Number(view.height) || 1080;
  const image = fs.readFileSync(path.join(DATA, view.path)).toString('base64');
  const started = Date.now();
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You locate one visible control in a Windows desktop screenshot. Return JSON only: ' +
          '{"found":true|false,"x":number,"y":number,"confidence":0-1,"observed":"short"}. ' +
          'x and y must be absolute pixel coordinates of the CENTRE of the requested control in the supplied image. ' +
          'If the control is not clearly visible, return found=false. Never guess between unrelated controls.',
      },
      {
        role: 'user',
        content: `Target control: ${target}\nExpected window: ${title || 'the foreground window'}\nImage size: ${width}x${height}. Locate it now.`,
      },
    ],
    { images: [image], format: 'json', kind: 'element-locate', timeoutMs: 60000, temperature: 0, maxTokens: 256 }
  );
  if (!reply.ok) return { found: false, reason: reply.error, shot };
  const parsed = parseJsonLoose(reply.content) || {};
  let x = Number(parsed.x);
  let y = Number(parsed.y);
  let confidence = Number(parsed.confidence);
  if (Number.isFinite(confidence) && confidence > 1) confidence /= 100;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && x <= 1 && y > 0 && y <= 1) {
    x *= width;
    y *= height;
  }
  const found =
    parsed.found !== false &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= width &&
    y <= height &&
    confidence >= Math.max(0, Math.min(1, Number(minConfidence) || 0.6));
  if (!found) {
    return { found: false, confidence, observed: str(parsed.observed), shot, reason: 'vision did not confirm the target' };
  }
  // Map the downscaled (and optionally cropped) view back to virtual-screen pixels.
  const cropWidth = Number(view.cropWidth) || width;
  const cropHeight = Number(view.cropHeight) || height;
  const result = {
    found: true,
    // The crop offset and the virtual-desktop origin both decide the answer.
    x: mapVisionPoint({ view: { ...view, cropWidth, cropHeight }, x, y })?.x ?? null,
    y: mapVisionPoint({ view: { ...view, cropWidth, cropHeight }, x, y })?.y ?? null,
    confidence,
    observed: str(parsed.observed),
    shot,
    reason: '',
    locateMs: Date.now() - started,
    imageBytes: view.bytes || null,
  };
  if (shot.signature) {
    if (locateCache.size >= 40) locateCache.delete(locateCache.keys().next().value);
    locateCache.set(key, { signature: shot.signature, at: Date.now(), result });
  }
  return result;
}

/**
 * Single-flight locate: a second ask for the same target while one is running
 * joins that request instead of queueing another behind the model.
 */
async function findVisualElement(options = {}) {
  const key = locateKey(options.description, options.title);
  const inflight = locateInflight.get(key);
  if (inflight) return inflight;
  const pending = locateElementOnce(options).finally(() => locateInflight.delete(key));
  locateInflight.set(key, pending);
  return pending;
}

/** Only the window the step named may be searched for a control. */
function frameIsTargetWindow(shot, title) {
  const wanted = String(title || '').toLowerCase().trim();
  if (!wanted) return true;
  const captured = String(shot?.cropTitle || '').toLowerCase().trim();
  if (!captured) return false;
  return captured.includes(wanted) || wanted.includes(captured);
}

function resolveTextFile(params = {}) {
  const location = str(params.location, 'data').toLowerCase();
  const requested = str(params.path || params.filename).trim();
  const desktop = desktopFolder();
  const dataFiles = path.join(DATA, 'files');
  let destination;
  if (requested && path.isAbsolute(requested)) {
    destination = path.resolve(requested);
    const allowed = destination.startsWith(DATA + path.sep) || destination.startsWith(desktop + path.sep) || destination === desktop;
    if (!allowed) throw new Error('Text files can only be written inside data/ or the Desktop folder.');
  } else {
    const base = location === 'desktop' ? desktop : dataFiles;
    fs.mkdirSync(base, { recursive: true });
    const name = requested ? safeFileName(requested, '') : `text-${Date.now()}.txt`;
    if (!name) throw new Error('A text file needs a filename.');
    destination = path.join(base, path.extname(name) ? name : `${name}.txt`);
  }
  if (!path.extname(destination)) destination += '.txt';
  return destination;
}

/** "0 KB" for a 16-byte file reads like a failure; keep bytes below 1 KB. */
export function sizeLabel(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} bytes`;
}

async function downloadUrlToData(url, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only http(s) URLs can be downloaded.');
  const folderName = safeFileName(options.folder || 'media', 'media').replace(/\.[^.]+$/, '');
  const folder = path.join(DATA, folderName);
  fs.mkdirSync(folder, { recursive: true });
  let name = safeFileName(options.filename, '');
  if (!name) {
    try {
      name = safeFileName(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''), '');
    } catch {}
  }
  if (!name) name = `${options.kind || 'media'}-${Date.now()}`;
  if (!path.extname(name)) name += options.kind === 'video' ? '.mp4' : options.kind === 'image' ? '.png' : '.bin';
  const destination = options.overwrite ? path.join(folder, name) : uniqueFile(folder, name);
  const script = `$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri ${psQuote(url)} -OutFile ${psQuote(destination)} -UseBasicParsing -MaximumRedirection 8 -TimeoutSec 180
$item = Get-Item -LiteralPath ${psQuote(destination)}
Write-Output ('downloaded ' + $item.Length + ' bytes')`;
  const res = await runPowerShell(script, Math.max(120000, Number(options.timeoutMs) || 180000));
  if (!res.ok) throw new Error(`Download failed: ${res.stderr || res.stdout || 'unknown error'}`);
  const stat = fs.statSync(destination);
  const maxBytes = Math.max(1, Math.min(2048, Number(options.maxMB) || 200)) * 1024 * 1024;
  if (stat.size > maxBytes) {
    fs.unlinkSync(destination);
    throw new Error(`Downloaded file is ${Math.round(stat.size / 1024 / 1024)} MB, above the ${maxBytes / 1024 / 1024} MB limit.`);
  }
  return {
    path: path.relative(ROOT, destination).split(path.sep).join('/'),
    bytes: stat.size,
    filename: path.basename(destination),
    url,
    kind: options.kind || 'file',
  };
}

/**
 * Foreground plus the visible top-level windows (including dialogs) in one
 * call, so a step can be judged against the state that is really on screen
 * instead of a single window title.
 */
export async function readScreenContext() {
  const empty = { foreground: { title: '', process: '', className: '', handle: 0 }, windows: [], app: null };
  if (!IS_WINDOWS) return empty;
  const script = `${BASE_PRELUDE}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$fgHandle = [SightlineInput]::GetForegroundWindow()
$fgTitle = New-Object System.Text.StringBuilder 512
$fgClass = New-Object System.Text.StringBuilder 256
if ($fgHandle -ne [IntPtr]::Zero) {
  [void][SightlineInput]::GetWindowText($fgHandle, $fgTitle, $fgTitle.Capacity)
  [void][SightlineInput]::GetClassName($fgHandle, $fgClass, $fgClass.Capacity)
}
$fgProc = ''
$fgProcessId = 0
if ($fgHandle -ne [IntPtr]::Zero) {
  [void][SightlineInput]::GetWindowThreadProcessId($fgHandle, [ref]$fgProcessId)
  try { $fgProc = (Get-Process -Id $fgProcessId -ErrorAction Stop).ProcessName } catch { }
}
$windows = @()
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($child in $children) {
    $name = [string]$child.Current.Name
    if (-not $name) { continue }
    $childProcessId = [int]$child.Current.ProcessId
    $childProc = ''
    try { $childProc = (Get-Process -Id $childProcessId -ErrorAction Stop).ProcessName } catch { }
    $windows += [pscustomobject]@{ title = $name; process = $childProc; className = [string]$child.Current.ClassName }
    if ($windows.Count -ge 30) { break }
  }
} catch { }
[pscustomobject]@{
  foreground = [pscustomobject]@{ title = [string]$fgTitle; process = $fgProc; className = [string]$fgClass; handle = $(if ($fgHandle -ne [IntPtr]::Zero) { $fgHandle.ToInt64() } else { 0 }) }
  windows = @($windows)
} | ConvertTo-Json -Compress -Depth 4`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) return { ...empty, error: res.stderr || res.stdout };
  const line = res.stdout.split(/\r?\n/).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    const foreground = {
      title: str(parsed?.foreground?.title),
      process: str(parsed?.foreground?.process),
      className: str(parsed?.foreground?.className),
      handle: Number(parsed?.foreground?.handle) || 0,
    };
    const windows = (Array.isArray(parsed?.windows) ? parsed.windows : parsed?.windows ? [parsed.windows] : [])
      .map((entry) => ({ title: str(entry?.title), process: str(entry?.process), className: str(entry?.className) }))
      .filter((entry) => entry.title);
    const app = windows.find(
      (entry) => entry.process && entry.process === foreground.process && entry.title !== foreground.title
    ) || null;
    return { foreground, windows, app };
  } catch {
    return { ...empty, error: 'Screen context was not JSON.' };
  }
}

/**
 * Where the pointer is, in physical screen pixels. Aiming reads this before it
 * moves: a pointer already on the control a step names costs the step nothing,
 * and a hover that would change no pixels is not worth a wait. The script is
 * deliberately small — no UI Automation, no capture — because it runs inside
 * the gap before a step.
 */
export async function readCursor() {
  if (!IS_WINDOWS) return null;
  const script = `Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SightlineCursor {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][SightlineCursor]::SetProcessDPIAware()
$p = New-Object SightlineCursor+POINT
if (-not [SightlineCursor]::GetCursorPos([ref]$p)) { Write-Output '' } else { Write-Output ("$($p.X),$($p.Y)") }`;
  const res = await runPowerShell(script, 8000);
  if (!res.ok) return null;
  const [x, y] = String(res.stdout || '').trim().split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
}

/**
 * How long the person at the keyboard has been still, and what they are looking
 * at. A step that steals focus reads this first so it can wait for the desktop
 * to settle instead of yanking a window away mid-keystroke.
 */
export async function readPresence() {
  const empty = { idleMs: 0, foreground: null, at: new Date().toISOString() };
  if (!IS_WINDOWS) return empty;
  const script = `${BASE_PRELUDE}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SightlineIdle {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
}
"@
$info = New-Object SightlineIdle+LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
[void][SightlineIdle]::GetLastInputInfo([ref]$info)
$idle = [Environment]::TickCount - [int]$info.dwTime
if ($idle -lt 0) { $idle = 0 }
$fg = [SightlineInput]::GetForegroundWindow()
$title = ''
$proc = ''
if ($fg -ne [IntPtr]::Zero) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][SightlineInput]::GetWindowText($fg, $sb, $sb.Capacity)
  $title = [string]$sb.ToString()
  [uint32]$fgPid = 0
  [void][SightlineInput]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  if ($fgPid) { try { $proc = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName } catch { } }
}
$cursor = New-Object SightlineInput+POINT
$cursorX = -1
$cursorY = -1
# The pointer's place comes from this same read: aiming asks presence where the
# mouse is, so an aim that would move nothing costs no extra process.
if ([SightlineInput]::GetCursorPos([ref]$cursor)) { $cursorX = [int]$cursor.X; $cursorY = [int]$cursor.Y }
[pscustomobject]@{ idleMs = [int]$idle; title = $title; process = $proc; cursorX = $cursorX; cursorY = $cursorY } | ConvertTo-Json -Compress`;
  const res = await runPowerShell(script, 15000);
  if (!res.ok) return { ...empty, error: res.stderr || res.stdout };
  try {
    const parsed = JSON.parse(res.stdout.split(/\r?\n/).filter(Boolean).pop());
    return {
      idleMs: Math.max(0, Number(parsed?.idleMs) || 0),
      foreground: parsed?.title ? { title: str(parsed.title), process: str(parsed.process) } : null,
      cursor:
        Number(parsed?.cursorX) >= 0 && Number(parsed?.cursorY) >= 0
          ? { x: Math.round(Number(parsed.cursorX)), y: Math.round(Number(parsed.cursorY)) }
          : null,
      at: new Date().toISOString(),
    };
  } catch {
    return { ...empty, error: 'Presence was not JSON.' };
  }
}

/**
 * The on-disk file a run recorded. Steps store either a project-root path
 * ("data/media/clip.mp4") or one relative to data/ ("media/clip.mp4"), and a
 * hand-written step may name only the file, so each layout is tried before the
 * file is called missing.
 */
export function resolveCheckFile(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  const rooted = path.resolve(ROOT, raw);
  if (fs.existsSync(rooted)) return rooted;
  const dirs = [DATA, path.join(DATA, 'media'), path.join(DATA, 'files'), path.join(DATA, 'videos')];
  for (const dir of dirs) {
    const candidate = path.join(dir, raw);
    if (fs.existsSync(candidate)) return candidate;
  }
  return rooted;
}

/**
 * Read-only evidence for a step that already ran, used to finish verification
 * quietly while the user keeps working (no focus change, no input).
 */
export async function silentCheck(kind, { title = '', process = '', path: filePath = '' } = {}) {
  switch (kind) {
    case 'window': {
      // A pending target is often an executable (`notepad.exe`), which is a
      // process name, not a window title; match on the process in that case.
      const wanted = String(title || '').trim();
      const exeLike = /\.exe$/i.test(wanted) || /[\\/]/.test(wanted);
      const state = await inspectWindowState({
        title: exeLike ? '' : wanted,
        process: String(process || wanted).replace(/\.exe$/i, ''),
      });
      const ok = ['foreground', 'visible', 'background', 'minimized'].includes(state.state);
      const seen = state.matches?.[0];
      return { ok, detail: `window ${state.state}${seen ? `: ${seen.process} :: ${seen.title}` : ''}` };
    }
    case 'process': {
      const name = String(process || title || '').replace(/\.exe$/i, '');
      if (!name) return { ok: false, detail: 'no process name' };
      const res = await runPowerShell(
        `$p = Get-Process -Name ${psQuote(name)} -ErrorAction SilentlyContinue; if ($p) { Write-Output ('running: ' + (($p | Select-Object -First 1).ProcessName)) } else { Write-Output 'not running' }`,
        10000
      );
      return { ok: /^running:/i.test(res.stdout), detail: res.stdout || res.stderr || 'no output' };
    }
    case 'file':
    case 'exe': {
      if (!filePath) return { ok: false, detail: 'no file path recorded' };
      const resolved = resolveCheckFile(filePath);
      const exists = Boolean(resolved) && fs.existsSync(resolved);
      const size = exists ? fs.statSync(resolved).size : 0;
      return { ok: exists && size > 0, detail: exists ? `${resolved} (${sizeLabel(size)})` : `${resolved || filePath} is missing` };
    }
    case 'clipboard': {
      const text = await readClipboardText();
      return { ok: Boolean(String(text || '').trim()), detail: `${String(text || '').length} characters on the clipboard` };
    }
    default:
      return { ok: null, detail: `${kind} needs the window in front or another interactive check` };
  }
}

/**
 * One vision call before acting: does the expected outcome already exist, what
 * surrounds the target, and where would the control really land? The caller
 * decides whether to skip, adjust or keep the planned action.
 */
export async function previewActionOnce({ step = null, description = '', title = '', expected = '', minConfidence = 0.55 } = {}) {
  const target = String(description || '').trim();
  if (!target) return { found: false, reason: 'no target description' };
  const shot = await liveScreenshot(null, {
    maxWidth: VISION_ENABLED ? VISION_MAX_WIDTH : 0,
    quality: VISION_JPEG_QUALITY,
    // Previewing the whole desktop finds “a text area” anywhere; with a named
    // window only that window is read.
    crop: title ? 'foreground' : VISION_CROP,
  });
  if (!frameIsTargetWindow(shot, title)) {
    return { found: false, reason: `“${title}” is not the window on screen (“${shot.cropTitle}”)`, shot };
  }
  const view = shot.vision || {
    path: shot.path,
    width: Number(shot.width) || 1920,
    height: Number(shot.height) || 1080,
    cropX: 0,
    cropY: 0,
    cropWidth: Number(shot.width) || 1920,
    cropHeight: Number(shot.height) || 1080,
    bytes: null,
  };
  const width = Number(view.width) || 1920;
  const height = Number(view.height) || 1080;
  const image = fs.readFileSync(path.join(DATA, view.path)).toString('base64');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You preview a Windows desktop screenshot before an automation step runs. Return JSON only: ' +
          '{"found":true|false,"x":number,"y":number,"confidence":0-1,"window":"title of the window this screenshot shows",' +
          '"alreadyDone":true|false,"alreadyEvidence":"what proves it is already done",' +
          '"nearby":["label (direction)"],"distraction":"advert, overlay or popup near the target, or empty","observed":"short"}. ' +
          'x and y are the CENTRE of the control the step will use, in image pixels. ' +
          'alreadyDone is true only when the state the step is trying to produce is visibly present already (an open Save dialog, the installed app window, the requested page). ' +
          'List up to four labelled elements around the target. Never guess: found=false when the control is not clearly visible.',
      },
      {
        role: 'user',
        content: `Step: ${step?.type || 'action'} ${step?.name ? `“${step.name}”` : ''}\nTarget control: ${target}\nExpected window: ${title || 'the foreground window'}\nExpected outcome after the step: ${expected || 'the step completes and the next state appears'}\nImage size: ${width}x${height}. Preview it now.`,
      },
    ],
    { images: [image], format: 'json', kind: 'step-preview', timeoutMs: 60000, temperature: 0, maxTokens: 420 }
  );
  if (!reply.ok) return { found: false, reason: reply.error, shot };
  const parsed = parseJsonLoose(reply.content) || {};
  let x = Number(parsed.x);
  let y = Number(parsed.y);
  let confidence = Number(parsed.confidence);
  if (Number.isFinite(confidence) && confidence > 1) confidence /= 100;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && x <= 1 && y > 0 && y <= 1) {
    x *= width;
    y *= height;
  }
  const cropWidth = Number(view.cropWidth) || width;
  const cropHeight = Number(view.cropHeight) || height;
  const found = parsed.found !== false && Number.isFinite(x) && Number.isFinite(y) && confidence >= minConfidence;
  return {
    found,
    x: found ? mapVisionPoint({ view: { ...view, cropWidth, cropHeight }, x, y })?.x ?? null : null,
    y: found ? mapVisionPoint({ view: { ...view, cropWidth, cropHeight }, x, y })?.y ?? null : null,
    confidence,
    alreadyDone: parsed.alreadyDone === true || Boolean(parsed.alreadyDone) === true,
    alreadyEvidence: str(parsed.alreadyEvidence),
    window: str(parsed.window),
    nearby: (Array.isArray(parsed.nearby) ? parsed.nearby : []).map((value) => str(value)).filter(Boolean).slice(0, 6),
    caution: str(parsed.distraction),
    observed: str(parsed.observed),
    shot,
    reason: found ? '' : 'preview did not confirm the target',
  };
}

/** Move the pointer through a few points so the step does not jump across the screen. */
async function movePointerPath(points = [], stepMs = 45) {
  const clean = (points || []).filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))).slice(0, 8);
  if (clean.length < 2) return false;
  const moves = clean
    .map((point) => `[void][SightlineInput]::SetCursorPos(${Math.round(Number(point.x))}, ${Math.round(Number(point.y))})\nStart-Sleep -Milliseconds ${Math.max(10, Math.min(200, Number(stepMs) || 45))}`)
    .join('\n');
  const res = await runPowerShell(`${BASE_PRELUDE}
${moves}
Write-Output 'moved'`, 15000);
  return res.ok;
}

/**
 * Two-frame playback verification prompts. Deliberately host-agnostic: a
 * direct video file, a browser tab or a desktop player such as VLC are all
 * valid, so the check cannot fail just for missing a YouTube address.
 */
export function playbackCheckPrompts({ expected = '', question = '', gap = 4000 } = {}) {
  const target = String(expected || 'the video page or player').trim();
  const check =
    String(question || '').trim() ||
    'Did the same video play? It must have advanced between frame 1 and frame 2, or have reached its end after visibly playing.';
  return {
    system:
      'You are a strict video-playback verifier. You are shown TWO live desktop screenshots of the same screen, taken in order: frame 1 first, then frame 2. ' +
      'Judge only from visible pixels, never from step names, logs, titles, or assumptions. ' +
      'Any video surface counts: a browser video page, a direct video file, or a desktop player such as VLC, MPV, or Windows Media Player. Do not require a specific website. ' +
      'Judge the player window only. Change anywhere else on the desktop — wallpaper or an animated background, a clock, the cursor, notifications, the taskbar, or another app — is not playback and never counts as progress or as proof that the video played. ' +
      'The player\'s own time readout (for example 00:12 / 00:32) or its seek bar is the progress evidence: read it, put the text in progress, and report the same readout as numbers of seconds in elapsed and duration (null when no readout is visible). ' +
      'Report the time readout of EACH frame separately in frames, frame 1 first and then frame 2, as {"readout":"that frame\'s visible time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null}. Read each frame on its own: never copy one frame\'s readout into the other, and never write a value into a frame where you cannot see it. ' +
      'First identify the player state in frame 2 as one of: "playing", "paused", "buffering", "ended", "not_started", "unknown". ' +
      '"ended" means the same player shows the end of the media: progress at or near the full duration (for example 00:32 / 00:32), a completion or replay overlay, or a stopped state after the media played. ' +
      'A timeline whose elapsed readout equals its total (for example 02:36 / 02:36) is at the end even when the video surface is black, holds only the last frame, or is replaced by a replay or stop overlay, and even when the pause button is shown: that is ended, not paused and not not_started. ' +
      '"not_started" means the player still shows the beginning: progress at 0:00 with no elapsed time, a large centre play button, a blank/black surface, a loading screen or an empty playlist. ' +
      'Set "started" true only when there is visible evidence inside the player that playback ran: progress beyond 0:00, an elapsed-time value above zero (including one at the full duration), or a mid-video frame. ' +
      'A player showing only its idle/logo art (for example VLC\'s traffic-cone logo), a blank surface or no loaded media, with its timeline at 0:00, has no such evidence: call that not_started, never ended. ' +
      'Set "finished" true only for an ended state with started true. Two identical frames after the media reached its end are a finished video, not a stalled one: set finished true and progressed false. ' +
      'An ended state needs the player\'s own readout at or near the full duration, or a completion/replay overlay; if the player has fallen back to 0:00 with idle art, do not call it ended. ' +
      'Pass when the video advanced between the frames (playing true and progressed true), or when it visibly played to its end (finished true and started true). ' +
      'Fail when the video never started, is paused part-way, is buffering, shows an error or ad, the page is a search grid or hover preview, another app covers the player, or you cannot tell whether playback ran. Never pass on a guess. ' +
      'Return JSON only: {"pass":true|false,"playing":true|false,"progressed":true|false,"started":true|false,"finished":true|false,"state":"playing|paused|buffering|ended|not_started|unknown","progress":"the visible time text","elapsed":seconds-or-null,"duration":seconds-or-null,"frames":[{"readout":"frame 1 time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null},{"readout":"frame 2 time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null}],"confidence":0-1,"observed":"what is visible in each frame, including progress","mismatch":"what is wrong or missing"}.',
    user: `Check: ${check}\nExpected page or player: ${target}\nFrame 1 is the first image; frame 2 is the second image, taken ${gap}ms later.`,
  };
}

/** The same check, but between this run's earlier screenshot and the current screen. */
export function playbackHistoryPrompts({ expected = '', gap = 4000 } = {}) {
  const target = String(expected || 'the video page or player').trim();
  return {
    system:
      'You are a strict video-playback verifier using a run\'s own screenshot history. You are shown TWO live desktop screenshots: image 1 was captured earlier in the same run, image 2 is the current screen. ' +
      'Decide from visible pixels only whether both show the same player and media, and whether playback can be proven from them. ' +
      'Judge the player only: change elsewhere on the desktop (wallpaper or an animated background, clock, cursor, notifications, taskbar, other apps) is never progress. ' +
      'Read each image\'s player time readout (for example 00:46 / 01:36), and report image 2\'s readout as elapsed and duration in seconds; a readout above zero is proof that playback ran. ' +
      'Report both readouts separately in frames, image 1 first and then image 2, as {"readout":"that image\'s visible time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null}; never copy one image\'s readout into the other. ' +
      'The images may be framed differently: image 1 can be the whole desktop while image 2 is cropped to the player. Compare the player itself, not the screen around it. ' +
      'Set samePlayer true when both images show the same player window: the same app, and the same media title when a title is visible. ' +
      'A current image that shows that same player with no media loaded, its idle/logo art, or an emptied window is the same player after the media ended — do not fail samePlayer just because the media is no longer visible. ' +
      'Set advanced true when the media visibly moved on between the images: the elapsed time or progress changed, or the video frame changed while the player stayed visible and in the playing state. ' +
      'Set finished true when the earlier image shows the video in progress and the current image shows the same player at the end of the media (progress at or near full duration, a completion/replay overlay, or a stopped state). ' +
      'That includes a player that played and then fell back to its idle/logo art at 0:00 in the current image: if the earlier image proves the same media was running, it finished. ' +
      'A current readout whose elapsed time equals its total (for example 02:36 / 02:36) is also an end state, even when the surface is black or paused. ' +
      'Set started true when either image shows that playback actually ran (progress beyond 0:00 or a mid-video frame). ' +
      'Set state for the current image: playing, paused, buffering, ended, not_started or unknown. ' +
      'Fail when either image shows another app covering the player, a search grid, an error, a player that never left 0:00, or when the same media cannot be confirmed. Never pass on a guess. ' +
      'Return JSON only: {"pass":true|false,"samePlayer":true|false,"advanced":true|false,"started":true|false,"finished":true|false,"state":"playing|paused|buffering|ended|not_started|unknown","elapsed":seconds-or-null,"duration":seconds-or-null,"frames":[{"readout":"image 1 time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null},{"readout":"image 2 time text or empty","elapsed":seconds-or-null,"duration":seconds-or-null}],"confidence":0-1,"observed":"what is visible in each image","mismatch":"what is wrong or missing"}.',
    user: `Expected page or player: ${target}\nImage 1 was captured earlier in the same run; image 2 is the current screen, checked ${gap}ms after the two-frame comparison.`,
  };
}

/**
 * One verdict for both playback prompts. A video that played to its end is a
 * success; a video that never started is not, even though both show still
 * frames. The state fields decide, not the frame difference alone.
 */
/** Clock readouts in a structured field, in seconds: "02:36 / 02:36" → [156, 156]. */
function readoutSeconds(text = '') {
  return (String(text || '').match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || [])
    .map((stamp) => stamp.split(':').map(Number).reduce((total, part) => total * 60 + part, 0))
    .filter((seconds) => Number.isFinite(seconds));
}

/** One frame's own readout in seconds, or null when that frame reported none. */
function frameReadout(entry = null) {
  if (entry && typeof entry === 'object') {
    const elapsed = Number(entry.elapsed);
    const duration = Number(entry.duration);
    if (Number.isFinite(elapsed) && Number.isFinite(duration) && elapsed > 0 && duration > 0) {
      return { elapsed, duration };
    }
    const times = readoutSeconds(entry.readout ?? entry.progress);
    return times.length >= 2 ? { elapsed: times[0], duration: times[1] } : null;
  }
  const times = readoutSeconds(entry);
  return times.length >= 2 ? { elapsed: times[0], duration: times[1] } : null;
}

/** The per-frame readouts the model supplied, one per image, in frame order. */
function frameReadouts(parsed = null) {
  const raw = Array.isArray(parsed?.frames) ? parsed.frames : Array.isArray(parsed?.readouts) ? parsed.readouts : [];
  return raw.slice(0, 2).map(frameReadout).filter(Boolean);
}

const mediaDurations = new Map();
const MEDIA_FILE = /\.(mp4|m4v|webm|mkv|mov|avi|ogv|mpg|mpeg|wmv)$/i;

// A weaker verification must not be silent: every reason the media length is
// unavailable is logged once, so a run whose total was never cross-checked is
// visible in the console instead of looking like a full check.
const durationNotes = new Set();

function noteNoDuration(message) {
  if (durationNotes.has(message)) return;
  durationNotes.add(message);
  console.warn(`[playback] ${message}`);
}

function probeMediaSeconds(file) {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') {
            noteNoDuration('ffprobe is not installed, so the readout total is not cross-checked against the media file.');
          } else {
            noteNoDuration(
              `ffprobe could not read the media duration (${String(error.code || error.message).slice(0, 80)}), so the readout total is not cross-checked.`
            );
          }
          return resolve(null);
        }
        const seconds = Number(String(stdout || '').trim());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          noteNoDuration('ffprobe returned no usable duration, so the readout total is not cross-checked.');
          return resolve(null);
        }
        resolve(Math.round(seconds * 10) / 10);
      }
    );
  });
}

/**
 * The real length of the media this run opened, in seconds, or null when it
 * cannot be read. A known duration lets a readout's total be checked against
 * the file itself instead of trusting whatever number the model transcribed.
 */
export async function mediaDurationSeconds(run = null) {
  const seen = new Set();
  const candidates = [];
  for (const step of run?.steps || []) {
    const params = step?.params || {};
    for (const value of [params.target, params.url, ...(Array.isArray(params.args) ? params.args : [])]) {
      const text = String(value ?? '').trim();
      if (!MEDIA_FILE.test(text) || seen.has(text)) continue;
      seen.add(text);
      candidates.push(text);
    }
  }
  if (!candidates.length) {
    noteNoDuration('this run names no media file, so the readout total is not cross-checked against a file length.');
    return null;
  }
  for (const file of candidates) {
    let absolute;
    try {
      absolute = path.isAbsolute(file) ? file : path.join(DATA, file);
      if (!fs.existsSync(absolute)) {
        noteNoDuration(`the media file ${absolute} is missing, so the readout total is not cross-checked.`);
        continue;
      }
      const key = `${absolute}:${fs.statSync(absolute).mtimeMs}`;
      if (mediaDurations.has(key)) return mediaDurations.get(key);
      const seconds = await probeMediaSeconds(absolute);
      if (seconds) {
        mediaDurations.set(key, seconds);
        return seconds;
      }
    } catch {
      // An unreadable file is not evidence either way; the check continues
      // without the extra corroboration.
    }
  }
  return null;
}

/**
 * Visible windows stacked above the named player that cover a meaningful part
 * of it. A security prompt or dialog sitting on the player makes the crop a
 * picture of the dialog: the model then reads numbers from the wrong place,
 * which is how a clip at 00:43 was reported at 02:36 / 02:36.
 */
export async function coveringWindows(title = '', { minOverlap = 0.15 } = {}) {
  const target = String(title || '').trim();
  if (!target) return [];
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class SightlineCover {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  static string Title(IntPtr h) { int n = GetWindowTextLength(h); var sb = new StringBuilder(n + 2); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  public static string[] Above(string needle, double minOverlap) {
    var windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) { if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) windows.Add(h); return true; }, IntPtr.Zero);
    int index = -1;
    for (int i = 0; i < windows.Count; i++) {
      if (Title(windows[i]).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { index = i; break; }
    }
    if (index <= 0) return new string[0];
    RECT player;
    if (!GetWindowRect(windows[index], out player)) return new string[0];
    double area = Math.Max(1, (double)(player.Right - player.Left) * (player.Bottom - player.Top));
    uint playerPid;
    GetWindowThreadProcessId(windows[index], out playerPid);
    var found = new List<string>();
    for (int i = 0; i < index; i++) {
      RECT r;
      if (!GetWindowRect(windows[i], out r)) continue;
      int w = Math.Min(player.Right, r.Right) - Math.Max(player.Left, r.Left);
      int h = Math.Min(player.Bottom, r.Bottom) - Math.Max(player.Top, r.Top);
      if (w <= 0 || h <= 0) continue;
      if ((double)w * h / area < minOverlap) continue;
      uint pid;
      GetWindowThreadProcessId(windows[i], out pid);
      // The player's own windows (a separate video output, a tool panel) are
      // part of the player, not something covering it.
      if (pid == playerPid) continue;
      string proc = "";
      try { proc = Process.GetProcessById((int)pid).ProcessName; } catch { }
      found.Add(Title(windows[i]) + "\t" + proc);
      if (found.Count >= 4) break;
    }
    return found.ToArray();
  }
}
'@
  [SightlineCover]::Above(${psQuote(target)}, ${Number(minOverlap) || 0.15}) | ForEach-Object { Write-Output $_ }
`;
  const res = await runPowerShell(script, 20000);
  if (!res.ok) {
    // A scan that cannot run must not be mistaken for "nothing covers the
    // player", so it is reported even though the check continues.
    console.warn('[cover] window scan failed:', String(res.stderr || '').slice(0, 200));
    return [];
  }
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [windowTitle, process] = line.split('\t');
      return { title: String(windowTitle || '').trim(), process: String(process || '').trim() };
    })
    .filter((entry) => entry.title);
}

export function playbackVerdict(parsed = null, { minConfidence = 0.7, expectedDuration = null } = {}) {
  const raw = parsed?.confidence != null ? Number(parsed.confidence) : null;
  const confidence = Number.isFinite(raw) ? Math.round((raw > 1 ? raw / 100 : raw) * 100) : null;
  const state = String(parsed?.state || '').toLowerCase();
  // A timeline parked at its own full duration (02:36 / 02:36) is the end of a
  // video that ran. Players drop the picture there, so the readout is checked
  // directly instead of trusting the frame difference or the model's state.
  // The numeric fields are preferred, but the vision model reports the readout
  // in `progress` and leaves them null, so that field's visible text is parsed
  // when they are absent. `observed` prose is never read: it can quote the
  // prompt's own "02:36 / 02:36" example while denying any readout is visible.
  const elapsed = Number(parsed?.elapsed);
  const duration = Number(parsed?.duration);
  const numeric = Number.isFinite(elapsed) && Number.isFinite(duration) && elapsed > 0 && duration > 0;
  const times = numeric ? [elapsed, duration] : readoutSeconds(parsed?.progress);
  const claimedAtDuration = times.length >= 2 && times[0] > 0 && times[1] > 0 && Math.abs(times[1] - times[0]) <= 2;
  // One transcription is not proof. A dialog covering the player once made the
  // model merge the duration with a "100%" volume label into "02:36 / 02:36"
  // while the player was really at 00:43, and the single readout passed the
  // check. An end-of-media pass therefore needs each frame's OWN readout to
  // agree with the total: two frames, both at their own full duration.
  const perFrame = frameReadouts(parsed);
  const corroboratedEnd =
    perFrame.length >= 2 &&
    perFrame.every(
      (frame) => Math.abs(frame.duration - frame.elapsed) <= 2 && Math.abs(frame.duration - times[1]) <= 2
    );
  // When the media file's real length is known, the transcribed total has to
  // match it: a model that invents "02:36 / 02:36" for a 52s clip is caught
  // even if it invents the same number in both frames.
  const mediaSeconds = Number(expectedDuration) > 0 ? Number(expectedDuration) : null;
  const durationMatchesMedia = mediaSeconds == null || times.length < 2 || Math.abs(times[1] - mediaSeconds) <= 2;
  // A readout in frame 2 that is not at its own end contradicts a finish claim:
  // that is a clip that looped or restarted, not one that finished.
  const frameEndClaim = perFrame.length >= 2 ? Math.abs(perFrame[1].duration - perFrame[1].elapsed) <= 2 : null;
  const atDuration = claimedAtDuration && corroboratedEnd && durationMatchesMedia;
  const uncorroboratedEnd = claimedAtDuration && !atDuration;
  // A player that never loaded its media cannot pass just because the model
  // said so: an idle/logo screen at 0:00 is not playback.
  const neverStarted = state === 'not_started' && !atDuration;
  const playing = parsed?.playing === true && !neverStarted;
  const progressed = parsed?.progressed === true || parsed?.advanced === true;
  const finished =
    !neverStarted &&
    durationMatchesMedia &&
    frameEndClaim !== false &&
    (parsed?.finished === true || state === 'ended' || atDuration);
  const started = !neverStarted && (parsed?.started === true || progressed || atDuration);
  const passFlag = Boolean(parsed && (parsed.pass === true || parsed.ok === true || parsed.verified === true));
  const confident = confidence == null || confidence >= minConfidence * 100;
  const moving = playing && progressed;
  const completed = finished && started;
  // A pass flag is only believable with movement or a validated finish; a
  // readout at the full duration is proof on its own, even when the model
  // mislabelled the finished video as never started.
  const pass = Boolean(confident && ((passFlag && (moving || completed)) || atDuration));
  let reason = '';
  if (!pass) {
    if (!parsed) reason = 'the playback check returned no verdict';
    else if (!confident) reason = `confidence ${confidence}% is below the ${Math.round(minConfidence * 100)}% threshold`;
    else if (claimedAtDuration && !durationMatchesMedia)
      reason = `the readout's total does not match the media file's ${mediaSeconds}s`;
    else if (uncorroboratedEnd) reason = 'the readout at the full duration was not confirmed in both frames';
    else if (frameEndClaim === false && (parsed?.finished === true || state === 'ended'))
      reason = 'the second frame is not at the end of the media, so it restarted instead of finishing';
    else if (state === 'not_started') reason = 'the video never started';
    else if (state === 'paused') reason = 'the video is paused part-way through';
    else if (state === 'buffering') reason = 'the video is buffering';
    else if (finished && !started) reason = 'the player is at the end, but nothing shows the video ever played';
    else if (!passFlag) reason = 'the playback check reported failure';
    else reason = 'the two frames did not show advancing playback';
  }
  return {
    pass,
    confidence,
    state,
    playing,
    progressed,
    started,
    finished,
    moving,
    completed,
    atDuration,
    claimedAtDuration,
    corroboratedEnd,
    durationMatchesMedia,
    mediaSeconds,
    reason,
  };
}

/** Prior screenshots from this run, newest first, for a history-based check. */
export function playbackHistoryShots(run = null, { exclude = [], limit = 3 } = {}) {
  const entries = (run?.evidence || [])
    .filter((entry) => entry && entry.kind === 'screenshot' && !entry.simulated && entry.path && !exclude.includes(entry.path))
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const shots = [];
  for (const entry of entries) {
    const absolute = path.isAbsolute(entry.path) ? entry.path : path.join(DATA, entry.path);
    if (!fs.existsSync(absolute)) continue;
    const visionAbsolute = absolute.replace(/\.png$/i, '-vision.jpg');
    const visionPath = fs.existsSync(visionAbsolute)
      ? (path.isAbsolute(entry.path) ? visionAbsolute : entry.path.replace(/\.png$/i, '-vision.jpg'))
      : '';
    shots.push({ path: entry.path, vision: visionPath ? { path: visionPath } : null, caption: entry.caption || 'earlier frame' });
    if (shots.length >= limit) break;
  }
  return shots;
}

/**
 * Map a point in a vision image back to absolute screen coordinates. The vision
 * image is a resized crop of the screen, so the crop's origin and scale decide
 * where the model's pixel actually is.
 */
function visionPointToScreen(shot, control) {
  if (!control || control.visible === false) return null;
  const x = Number(control.x);
  const y = Number(control.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const vision = shot?.vision;
  if (!vision || !vision.width || !vision.height || !vision.cropWidth || !vision.cropHeight) return null;
  // The crop's offset inside the desktop, the desktop's own origin and the
  // downscale all decide the answer; a point outside the crop is refused.
  return mapVisionPoint({ view: vision, x, y });
}

/**
 * Show the player's controls the way a person would: raise the window, park the
 * pointer over the picture and let hover controls fade in before looking again.
 */
async function revealPlayerControls(step, shot, ctx) {
  const p = step.params || {};
  const title = str(p.title, '');
  if (title) {
    try {
      await executeStep(
        { type: 'focusWindow', name: `Focus ${title} before looking for its controls`, params: { title }, timeoutMs: 10000 },
        ctx
      );
    } catch {
      // The window may already be in front; the picture is read either way.
    }
  }
  const vision = shot?.vision;
  if (vision?.cropWidth) {
    try {
      await executeStep(
        {
          type: 'move',
          name: 'Hover over the player to reveal its controls',
          params: { x: vision.cropX + Math.round(vision.cropWidth / 2), y: vision.cropY + Math.round(vision.cropHeight * 0.6) },
        },
        ctx
      );
    } catch {
      // Hovering is best effort; the recapture below is what decides.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
}

/**
 * Capture the frame a screen check is about, without judging it.
 *
 * The frame has to be taken at the moment the step settled — the right window
 * raised, the pixels of that state. The judgement is the expensive half: on a
 * slow model it costs a hundred seconds. Splitting the two lets the runner
 * capture inside the step and judge afterwards, from the frame exactly as it
 * was, without a second look at a desktop that has moved on.
 */
export async function captureScreenFrame({ step = null, run = null, runId = null } = {}) {
  const p = step?.params || {};
  const caption = str(p.caption) || step?.name || 'Screen check';
  const target = judgeTargetFor(step, run);
  // A condition the operator accepted from the judgement review: judging the
  // whole desktop is never good enough to prove the run's own state.
  if (!target.scoped && db().settings.verifyJudgeRequireScope === true) {
    const message = `Screen check “${caption}” names no window, and the accepted judgement condition requires one. Add a title/app to the step or focus the window first.`;
    if (str(p.onError, 'fail') === 'warn') return { ok: false, skipped: message };
    throw new Error(message);
  }
  if (target.scoped) {
    try {
      await executeStep(
        {
          id: uid('chk'),
          type: 'focusWindow',
          name: `Bring the run's own window forward for “${caption}”`,
          params: {
            ...(target.hwnd ? { handle: target.hwnd } : {}),
            ...(target.title ? { title: target.title } : {}),
            ...(target.process ? { process: target.process } : {}),
          },
          timeoutMs: 15000,
        },
        { live: true, runId: runId || run?.id || null, run, workflow: null, getTool: () => null }
      );
    } catch (err) {
      // The deterministic judge decides whether this matters; onError=warn
      // keeps a missing window from failing the whole run.
      if (str(p.onError, 'fail') !== 'warn') {
        throw new Error(
          `Screen check could not reach “${target.title || target.process || 'the run window'}”: ${err.message}`
        );
      }
    }
  }
  const shot = await liveScreenshot(runId || run?.id || null, {
    maxWidth: VISION_ENABLED ? VISION_MAX_WIDTH : 0,
    quality: VISION_JPEG_QUALITY,
    ...(target.hwnd ? { crop: { window: target.hwnd } } : target.scoped ? { crop: 'foreground' } : {}),
  });
  const foreground = await readForegroundWindow();
  const expectedText = str(p.text || p.expectedText || p.contains).trim();
  const absentText = str(p.absent).trim();
  const windowText =
    target.scoped && (expectedText || absentText)
      ? await readWindowText({ handle: target.hwnd, title: target.title }).catch(() => ({ text: '', source: '' }))
      : { text: '', source: '' };
  return { ok: true, target, shot, foreground, windowText };
}

/**
 * Put the caret where the text is meant to go, before a type or paste step.
 *
 * SendKeys and ctrl+V go to whatever holds the caret. A chat pane in a
 * web-style app (Kiro, Slack, VS Code) holds no caret until it is clicked, so
 * the text went nowhere and the step still reported "Pasted 17 characters".
 * The field is the one the step names (params.field, found by UI Automation
 * then by OCR), else the only editable control that is confidently a text
 * field. When neither exists the step still types — but its output says the
 * text went to the window in front instead of pretending it landed.
 */
async function placeCaretForTyping(step, ctx) {
  const p = step.params || {};
  const guard = str(p.foreground || p.window || p.title);
  let window = guard;
  if (!window) {
    try {
      window = String((await readForegroundWindow()).title || '');
    } catch {
      window = '';
    }
  }
  const result = await placeCaret({
    step,
    window,
    deps: {
      readFocused: readFocusedElement,
      findControls: (options) => findEditableControls(options),
      findNamed: (options) => findUiElement(options),
      findNamedByOcr: (options) => findUiElementByOcr({ ...options, timeoutMs: 8000 }),
      clickAt: async (x, y, name) => {
        await executeStep(
          {
            type: 'click',
            name: `Click into ${name || 'the text field'}`,
            params: { x, y, ...(guard ? { foreground: guard } : {}) },
            timeoutMs: 10000,
          },
          ctx
        );
      },
    },
  });
  return caretNote(result);
}

export async function executeStep(step, ctx) {
  let p = step.params || {};
  const live = Boolean(ctx.live);
  if (step.type === 'openUrl' && p.urlVar && ctx.run?.variables?.[p.urlVar] != null) {
    step = { ...step, params: { ...p, url: String(ctx.run.variables[p.urlVar]) } };
    p = step.params;
  }

  if (step.type === 'launchApp' && (p.targetVar || p.argsVar)) {
    // A downloaded media file is kept in a run variable; VLC needs a real path,
    // so relative saved paths are resolved before they are handed to the app.
    const resolveFile = (value) => {
      const text = String(value == null ? '' : value);
      if (!text) return text;
      if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) return windowsPath(text);
      try {
        return fs.existsSync(text) ? windowsPath(path.resolve(text)) : text;
      } catch {
        return text;
      }
    };
    const target =
      p.targetVar && ctx.run?.variables?.[p.targetVar] != null ? resolveFile(ctx.run.variables[p.targetVar]) : p.target;
    const rawArgs = p.argsVar && ctx.run?.variables?.[p.argsVar] != null ? ctx.run.variables[p.argsVar] : p.args;
    const args = Array.isArray(rawArgs) ? rawArgs.map(resolveFile) : rawArgs ? [resolveFile(rawArgs)] : [];
    step = { ...step, params: { ...p, target, args } };
    p = step.params;
  }

  if (step.type === 'type' && p.textVar) {
    const fromVar = ctx.run?.variables?.[p.textVar];
    if (fromVar == null) throw new Error(`Type step needs variable "${p.textVar}", but it is not set.`);
    step = { ...step, params: { ...p, text: String(fromVar) } };
    p = step.params;
  }

  if (step.type === 'note') {
    return { output: `Note recorded: ${str(p.text).slice(0, 160)}`, evidence: [] };
  }

  if (step.type === 'writeNote') {
    if (!live) return { output: 'Simulated note save (set live mode to write the Markdown file).', evidence: [], skipped: true };
    const text = p.textVar ? ctx.run?.variables?.[p.textVar] : p.text;
    if (text == null || !String(text).trim()) throw new Error('Write note needs text or a textVar with content.');
    const note = saveInteractionNote({
      title: p.title || p.noteTitle || `${ctx.workflow?.name || 'Interaction'} notes`,
      body: String(text),
      tags: String(p.tags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      runId: ctx.runId,
      workflowId: ctx.workflow?.id,
      append: flag(p.append, true),
    });
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'noteId')] = note.id;
      ctx.run.variables.notePath = note.file;
    }
    return { output: `Saved note “${note.title}” to ${note.file}.`, evidence: [] };
  }

  if (step.type === 'writeTextFile') {
    if (!live) return { output: 'Simulated text-file save (set live mode to write the file).', evidence: [], skipped: true };
    const content = p.textVar ? ctx.run?.variables?.[p.textVar] : p.text;
    if (content == null || !String(content).trim()) throw new Error('Save text needs text or a textVar with content.');
    const destination = resolveTextFile(p);
    const append = flag(p.append, false);
    const overwrite = flag(p.overwrite, true);
    if (fs.existsSync(destination) && !append && !overwrite) {
      throw new Error(`Text file already exists: ${destination}. Enable overwrite or append.`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const body = String(content) + (flag(p.newline, true) ? '\n' : '');
    writeFileDurable(destination, body, { append });
    const insideRoot = destination.startsWith(ROOT + path.sep);
    const display = insideRoot ? path.relative(ROOT, destination).split(path.sep).join('/') : destination;
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'savedTextFile')] = display;
      ctx.run.files = [...(ctx.run.files || []), { path: display, kind: 'text', bytes: Buffer.byteLength(body), filename: path.basename(destination) }];
    }
    if (p.noteTitle) {
      saveInteractionNote({
        title: p.noteTitle,
        body: `Saved ${String(content).length} characters to ${display}`,
        tags: ['file', 'text'],
        runId: ctx.runId,
        workflowId: ctx.workflow?.id,
      });
    }
    return { output: `Saved ${String(content).length} characters to ${display}.`, evidence: [] };
  }

  if (step.type === 'readNote') {
    let note = null;
    if (p.path) {
      const absolute = path.resolve(ROOT, String(p.path));
      if (!absolute.startsWith(NOTES + path.sep) && absolute !== NOTES) throw new Error('Notes can only be read from data/notes.');
      if (!fs.existsSync(absolute)) throw new Error(`Note file not found: ${p.path}`);
      note = { title: path.basename(absolute), body: fs.readFileSync(absolute, 'utf8'), file: path.relative(ROOT, absolute) };
    } else {
      note = resolveNote(p);
    }
    if (!note) {
      if (flag(p.allowMissing, false)) {
        if (ctx.run) {
          if (!ctx.run.variables) ctx.run.variables = {};
          ctx.run.variables[str(p.outputVar, 'noteText')] = '';
        }
        return { output: 'No matching note found; the variable was set to empty text.', evidence: [] };
      }
      throw new Error(`No note matched ${p.noteId || p.title || p.query || '(missing title)'}.`);
    }
    const body = String(note.body || (note.file ? fs.readFileSync(path.join(ROOT, note.file), 'utf8') : ''));
    const maxChars = Math.max(1, Math.min(60000, num(p.maxChars, 60000)));
    const clipped = body.slice(0, maxChars);
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'noteText')] = clipped;
    }
    return { output: `Read ${clipped.length} characters from note “${note.title}” into ${str(p.outputVar, 'noteText')}.`, evidence: [] };
  }

  if (step.type === 'copyLink') {
    const outputVar = str(p.outputVar, 'copiedLink');
    const direct = p.url || (p.urlVar ? ctx.run?.variables?.[p.urlVar] : null);
    const remember = (link) => {
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[outputVar] = link;
      }
      return link;
    };
    if (direct) {
      const link = String(direct).trim();
      if (!/^https?:\/\//i.test(link)) throw new Error('Copy link needs an http(s) URL.');
      remember(link);
      if (p.noteTitle) saveInteractionNote({ title: p.noteTitle, body: `Copied link: ${link}`, tags: ['link'], runId: ctx.runId, workflowId: ctx.workflow?.id });
      return { output: `Stored link in ${outputVar}: ${link}`, evidence: [] };
    }
    if (!live) return { output: 'Simulated copy of the browser address bar (no live desktop input).', evidence: [], skipped: true };
    const send = (keys) =>
      executeStep(
        { type: 'key', name: `Copy link ${keys}`, params: { keys, foreground: p.foreground, gapMs: 160 }, timeoutMs: 10000 },
        ctx
      );
    await send('^l');
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Math.min(1500, num(p.waitMs, 250)))));
    await send('^c');
    await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.copyWaitMs, 400)))));
    const link = remember((await readClipboardText()).trim());
    if (!/^https?:\/\//i.test(link)) {
      throw new Error(`The browser address bar did not copy an http(s) link (clipboard: ${link.slice(0, 180) || 'empty'}).`);
    }
    if (p.noteTitle) {
      saveInteractionNote({ title: p.noteTitle, body: `Copied link: ${link}`, tags: ['link'], runId: ctx.runId, workflowId: ctx.workflow?.id });
    }
    return { output: `Copied link into ${outputVar}: ${link}`, evidence: [] };
  }

  if (step.type === 'downloadMedia') {
    const url = String(p.url || (p.urlVar ? ctx.run?.variables?.[p.urlVar] : '') || '').trim();
    if (!url) throw new Error('Save media needs a url or a urlVar that contains one.');
    if (!live) return { output: `Simulated download of ${url} (set live mode to save the file).`, evidence: [], skipped: true };
    const saved = await downloadUrlToData(url, {
      filename: p.filename,
      folder: p.folder || 'media',
      kind: str(p.kind, 'file'),
      maxMB: p.maxMB,
      overwrite: flag(p.overwrite, false),
      timeoutMs: step.timeoutMs,
    });
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'savedFile')] = saved.path;
      ctx.run.files = [...(ctx.run.files || []), saved];
    }
    if (p.noteTitle) {
      saveInteractionNote({
        title: p.noteTitle,
        body: `Saved ${saved.kind}: ${saved.url}\n\nFile: ${saved.path} (${sizeLabel(saved.bytes)})`,
        tags: ['file', saved.kind],
        runId: ctx.runId,
        workflowId: ctx.workflow?.id,
      });
    }
    return { output: `Saved ${saved.kind} to ${saved.path} (${sizeLabel(saved.bytes)}).`, evidence: [] };
  }

  if (step.type === 'saveImage') {
    const source = str(p.source, 'screen').toLowerCase();
    if (!live) return { output: `Simulated image save from ${source} (set live mode to capture or download).`, evidence: [], skipped: true };
    if (source === 'url') {
      const url = String(p.url || (p.urlVar ? ctx.run?.variables?.[p.urlVar] : '') || '').trim();
      if (!url) throw new Error('Save image from URL needs a url or urlVar.');
      const saved = await downloadUrlToData(url, {
        filename: p.filename,
        folder: p.folder || 'media',
        kind: 'image',
        maxMB: p.maxMB,
        overwrite: flag(p.overwrite, false),
      });
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[str(p.outputVar, 'savedImage')] = saved.path;
      }
      return { output: `Saved image to ${saved.path} (${sizeLabel(saved.bytes)}).`, evidence: [] };
    }
    if (source === 'clipboard') {
      fs.mkdirSync(CAPTURES, { recursive: true });
      const rawName = safeFileName(p.filename, `clipboard-image-${Date.now()}.png`);
      const name = path.basename(rawName, path.extname(rawName)) + '.png';
      const destination = uniqueFile(CAPTURES, name);
      const script = `${BASE_PRELUDE}
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { throw 'The clipboard does not contain an image.' }
try { $img.Save(${psQuote(destination)}, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
Write-Output ('saved image ' + ${psQuote(path.basename(destination))})`;
      const res = await runPowerShell(script, 20000);
      if (!res.ok) throw new Error(`Could not save the clipboard image: ${res.stderr || res.stdout || 'unknown error'}`);
      const relative = path.relative(DATA, destination).split(path.sep).join('/');
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[str(p.outputVar, 'savedImage')] = relative;
      }
      return { output: `Saved clipboard image to data/${relative}.`, evidence: [{ kind: 'screenshot', caption: str(p.caption, 'Clipboard image'), path: relative }] };
    }
    const shot = await liveScreenshot(ctx.runId);
    if (p.filename) {
      fs.mkdirSync(CAPTURES, { recursive: true });
      const rawName = safeFileName(p.filename, `screen-${Date.now()}.png`);
      const destination = uniqueFile(CAPTURES, path.basename(rawName, path.extname(rawName)) + '.png');
      fs.copyFileSync(path.join(DATA, shot.path), destination);
      const relative = path.relative(DATA, destination).split(path.sep).join('/');
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[str(p.outputVar, 'savedImage')] = relative;
      }
      return { output: `Saved screen image to data/${relative}.`, evidence: [{ kind: 'screenshot', caption: str(p.caption, 'Saved screen'), path: relative }] };
    }
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'savedImage')] = shot.path;
    }
    return { output: `Captured screen to data/${shot.path}.`, evidence: [{ kind: 'screenshot', caption: str(p.caption, step.name), ...shot }] };
  }

  if (step.type === 'recordVideo') {
    if (!live) return { output: 'Simulated screen recording (set live mode to record).', evidence: [], skipped: true };
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      throw new Error('Screen recording needs ffmpeg. Install it with installApp {id:"Gyan.FFmpeg"}, then retry.');
    }
    const durationMs = Math.max(1000, Math.min(600000, num(p.durationMs, 10000)));
    const fps = Math.max(5, Math.min(30, num(p.fps, 15)));
    const folderName = safeFileName(p.folder || 'media', 'media').replace(/\.[^.]+$/, '');
    const folder = path.join(DATA, folderName);
    fs.mkdirSync(folder, { recursive: true });
    let name = safeFileName(p.filename, `recording-${Date.now()}.mp4`);
    if (!/\.mp4$/i.test(name)) name = `${path.basename(name, path.extname(name))}.mp4`;
    const destination = flag(p.overwrite, false) ? path.join(folder, name) : uniqueFile(folder, name);
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps)];
    if (p.x != null && p.y != null && p.width != null && p.height != null) {
      args.push('-offset_x', String(num(p.x)), '-offset_y', String(num(p.y)), '-video_size', `${num(p.width)}x${num(p.height)}`);
    }
    args.push('-i', 'desktop', '-t', (durationMs / 1000).toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', destination);
    const res = await runExecutable(ffmpeg, args, durationMs + 60000);
    if (!res.ok || !fs.existsSync(destination)) {
      throw new Error(`Screen recording failed: ${res.stderr || res.stdout || 'ffmpeg did not create the file'}`);
    }
    const stat = fs.statSync(destination);
    const saved = {
      path: path.relative(ROOT, destination).split(path.sep).join('/'),
      bytes: stat.size,
      filename: path.basename(destination),
      kind: 'video',
      durationMs,
    };
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[str(p.outputVar, 'savedVideo')] = saved.path;
      ctx.run.files = [...(ctx.run.files || []), saved];
    }
    const evidence = [];
    try {
      const shot = await liveScreenshot(ctx.runId);
      evidence.push({ kind: 'screenshot', caption: `${str(p.caption, 'Screen recording')} — finished`, ...shot });
    } catch {}
    if (flag(p.note, true)) {
      saveInteractionNote({
        title: p.noteTitle || `Screen recording ${new Date().toLocaleString()}`,
        body: `Recorded ${(durationMs / 1000).toFixed(1)}s of the desktop at ${fps} fps.\n\nFile: ${saved.path} (${sizeLabel(saved.bytes)})`,
        tags: ['video', 'recording'],
        runId: ctx.runId,
        workflowId: ctx.workflow?.id,
      });
    }
    return { output: `Recorded ${(durationMs / 1000).toFixed(1)}s to ${saved.path} (${sizeLabel(saved.bytes)}).`, evidence };
  }

  if (step.type === 'installApp') {
    const entry = catalogEntry(
      [p.app, p.name, p.id, p.packageId, p.goal, ctx.workflow?.description, ctx.workflow?.name].filter(Boolean)
    );
    const appLabel = String(p.app || p.name || entry?.name || '').trim();
    const id = String(p.id || p.packageId || entry?.wingetId || '').trim();
    const explicitUrls = [p.url, ...(Array.isArray(p.urls) ? p.urls : [])].filter(Boolean);
    if (!id && !appLabel && !explicitUrls.length) {
      throw new Error('Install app needs a winget package id, an app name, or an installer URL.');
    }
    if (!live) {
      return {
        output: `Simulated install of ${appLabel || id || explicitUrls[0]}${entry?.pages?.length ? ' (would search the official page first)' : ''} (set live mode to install).`,
        evidence: [],
        skipped: true,
      };
    }

    // Nothing supplied for a known app: look for the real installer on the
    // vendor page instead of guessing a download URL.
    let discovered = [];
    if (entry && !explicitUrls.length && flag(p.discover, true)) {
      try {
        discovered = await discoverInstallerUrls(entry, { limit: Math.max(1, Math.min(4, num(p.maxSources, 3))) });
      } catch {
        discovered = [];
      }
    }
    const methods = installMethodsFor({ ...p, id, app: appLabel }, { entry, discovered });
    const checks = verificationChecksFor(entry, p);
    const attempts = [];
    const maxAttempts = Math.max(1, Math.min(4, num(p.maxAttempts, 3)));
    let verified = null;
    let usedMethod = '';
    let installedOutput = '';
    let keptInstaller = '';

    const verifyNow = async () => {
      const res = await runPowerShell(verificationScript(checks, p), 45000);
      return parseVerification(`${res.stdout || ''}\n${res.stderr || ''}`);
    };

    // Installs are idempotent only while the app works. Run history decides: an
    // app whose recent runs failed to launch, crashed or stopped responding —
    // or that the request explicitly asks to reinstall — is repaired instead of
    // skipped, because "installed" is not the same as "working".
    let health = null;
    if (!p.force) {
      try {
        const present = await verifyNow();
        if (present.ok) {
          health = installHealth({
            entry,
            app: appLabel,
            goal: [p.goal, ctx.run?.workflowGoal, ctx.workflow?.description, ctx.workflow?.name]
              .filter(Boolean)
              .join(' '),
            runs: db().runs,
            currentRun: ctx.run,
          });
          if (health.needsRepair && flag(p.reinstall, true)) {
            attempts.push({ method: 'already installed', ok: true, reason: `reinstalling because ${health.reason}` });
          } else {
            verified = present;
            usedMethod = 'already installed';
          }
        }
      } catch {
        // A verification hiccup falls through to the normal install methods.
      }
    }

    const forceInstall = Boolean(p.force || (health?.needsRepair && flag(p.reinstall, true)));
    const installMethods =
      verified || !forceInstall
        ? methods
        : methods.map((method) => (method.kind === 'winget' ? { ...method, force: true } : method));

    for (const method of verified ? [] : installMethods.slice(0, maxAttempts)) {
      const review =
        method.kind === 'direct'
          ? method.safe === false
            ? { safe: false, reason: method.reason }
            : reviewInstaller({ url: method.url, args: method.args, entry, allowUnknownSource: Boolean(p.allowUnknownSource) })
          : { safe: true, reason: '' };
      if (!review.safe) {
        attempts.push({ method: method.label, ok: false, reason: review.reason });
        continue;
      }
      try {
        if (method.kind === 'winget') {
          const args = ['install', '--id', method.id, '--exact'];
          if (method.source) args.push('--source', method.source);
          if (method.version) args.push('--version', method.version);
          if (method.scope) args.push('--scope', method.scope);
          if (method.silent) args.push('--silent');
          args.push('--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity');
          if (method.force) args.push('--force');
          const argLine = args.map((arg) => psQuote(arg)).join(', ');
          const script = `$ErrorActionPreference = 'Continue'
$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) { throw 'winget is not installed or not on PATH.' }
$wingetArgs = @(${argLine})
$out = & $winget.Source @wingetArgs 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { Write-Output ([string]$_) }
if ($code -ne 0) { throw ('winget exited with code ' + $code) }
Write-Output ('installed ' + ${psQuote(method.id)})`;
          const res = await runPowerShell(script, Math.max(120000, Math.min(1800000, Number(step.timeoutMs) || 900000)));
          installedOutput = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
          const alreadyInstalled = /already installed|No applicable installer|found an existing package|No newer package/i.test(installedOutput);
          if (!res.ok && !alreadyInstalled) {
            // winget can outlive our timeout while its installer still finishes;
            // check the filesystem and uninstall entries before calling it failed.
            let afterTimeout = null;
            try {
              afterTimeout = await verifyNow();
            } catch {
              afterTimeout = null;
            }
            if (afterTimeout?.ok) {
              verified = afterTimeout;
              usedMethod = `${method.label} (completed after the command timed out)`;
              attempts.push({ method: method.label, ok: true, reason: 'the install completed after the command timed out' });
              break;
            }
            throw new Error(installedOutput.slice(-900) || 'winget returned an error');
          }
        } else {
          const name = decodeURIComponent(new URL(method.url).pathname.split('/').filter(Boolean).pop() || 'installer.exe');
          const saved = await downloadUrlToData(method.url, {
            folder: 'downloads',
            filename: name,
            kind: 'file',
            maxMB: num(p.maxMB, 512),
            overwrite: true,
            timeoutMs: Math.max(120000, Number(step.timeoutMs) || 600000),
          });
          const args = String(method.args || '')
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean);
          const argScript = args.length ? `@(${args.map((arg) => psQuote(arg)).join(', ')})` : '@()';
          const installer = path.resolve(ROOT, saved.path);
          // A redirect or error page saved as "vlc.exe" is not runnable; say so
          // instead of handing Start-Process a broken file.
          const header = fs.readFileSync(installer).subarray(0, 2).toString('latin1');
          if (header !== 'MZ') {
            throw new Error(
              `the downloaded file is not a Windows installer (${Math.round(Number(saved.bytes || 0) / 1024)} KB, no MZ header); the link returned a page instead of the file`
            );
          }
          const script = `$ErrorActionPreference = 'Stop'
try {
  $proc = Start-Process -FilePath ${psQuote(installer)} -ArgumentList ${argScript} -Wait -PassThru
  Write-Output ('installer exit code ' + $proc.ExitCode)
  if ($proc.ExitCode -ne 0) { throw ('installer exited with code ' + $proc.ExitCode) }
} catch {
  throw ('installer failed: ' + $_.Exception.Message)
}`;
          const res = await runPowerShell(script, Math.max(180000, Math.min(1800000, Number(step.timeoutMs) || 900000)));
          installedOutput = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
          if (!res.ok) throw new Error(installedOutput.slice(-900) || 'the installer returned an error');
          keptInstaller = flag(p.keepInstaller, false) ? saved.path : '';
        }
        const check = await verifyNow();
        if (check.ok) {
          verified = check;
          usedMethod = method.label;
          attempts.push({ method: method.label, ok: true });
          break;
        }
        attempts.push({
          method: method.label,
          ok: false,
          reason: `ran but verification failed (no executable or uninstall entry found for ${appLabel || id || 'the app'})`,
        });
      } catch (err) {
        attempts.push({ method: method.label, ok: false, reason: String(err.message || err).slice(0, 300) });
      }
    }

    if (!verified) {
      throw new Error(`Install failed after ${attempts.length} attempt(s): ${installAttemptSummary(attempts) || 'no usable method'}`);
    }
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables.installedApp = appLabel || verified.displayName || id;
      if (id) ctx.run.variables.installedPackage = id;
      if (verified.version) ctx.run.variables.installedVersion = verified.version;
      if (verified.uninstall) ctx.run.variables.uninstallCommand = verified.uninstall;
    }
    if (flag(p.note, true)) {
      saveInteractionNote({
        title: p.noteTitle || `Installed ${appLabel || verified.displayName || id}`,
        body: installNoteBody({ app: appLabel || verified.displayName || id, method: usedMethod, verification: verified, attempts, downloaded: keptInstaller }),
        tags: ['install', 'verified'],
        runId: ctx.runId,
        workflowId: ctx.workflow?.id,
      });
    }
    const proof = verified.exe || verified.displayName || 'install entry';
    const version = verified.version ? ` ${verified.version}` : '';
    const repairReason =
      health?.needsRepair && usedMethod !== 'already installed'
        ? ` Reinstalled because ${health.reason}; the installed copy existed but recent evidence shows it failing.`
        : '';
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables.installDecision = usedMethod === 'already installed' ? 'skipped (healthy)' : health?.needsRepair ? 'reinstalled' : 'installed';
      if (health?.reason) ctx.run.variables.installReason = health.reason;
    }
    return {
      output:
        `${usedMethod === 'already installed' ? `${appLabel || id} was already installed` : `Installed ${appLabel || id} via ${usedMethod}`}; verified ${proof}${version}.${repairReason}` +
        `${installedOutput ? `\n${installedOutput.slice(-600)}` : ''}` +
        `${verified.uninstall ? `\nRollback: ${verified.uninstall}` : ''}`,
      evidence: [],
    };
  }

  if (step.type === 'testApp') {
    const target = String(p.target || '').trim();
    if (!live) return { output: `Simulated smoke test of ${target || 'the app'}.`, evidence: [], skipped: true };
    if (!target && flag(p.launch, true)) throw new Error('Test app needs the app/executable to launch.');
    const title = String(p.title || '').trim();
    const processName = String(p.process || '').trim();
    const waitMs = Math.max(500, Math.min(120000, num(p.waitMs, 15000)));
    // One budget for the whole smoke test: the launch, the settle, the window
    // wait, the capture and the vision check all spend what is left of it, so
    // the step cannot be killed mid-launch and retried into a second window.
    const testBudget = compositeBudget(step.timeoutMs, { fallbackMs: 60000, minMs: 6000, maxMs: 240000 });
    const evidence = [];
    const steps = [];
    try {
      if (flag(p.launch, true)) {
        const launched = await executeStep(
          { type: 'launchApp', name: `Launch ${target}`, params: { target }, timeoutMs: Math.min(30000, budgetLeft(testBudget, 4000)) },
          ctx
        );
        steps.push(launched.output);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(100, Math.min(10000, num(p.settleMs, 1500), budgetLeft(testBudget, 2500))))
      );
      // The wait gets only what the launch left; asking for its full timeout
      // after a slow launch is what pushed the step past its own budget.
      const readyMs = Math.min(waitMs, budgetLeft(testBudget, 2000));
      if (processName) {
        const ready = await executeStep(
          { type: 'waitFor', name: `Wait for ${processName}`, params: { kind: 'process', value: processName, mode: 'present', timeoutMs: readyMs }, timeoutMs: readyMs + 1000 },
          ctx
        );
        steps.push(ready.output);
      } else if (title) {
        const ready = await executeStep(
          { type: 'waitFor', name: `Wait for ${title}`, params: { kind: 'window', value: title, mode: 'present', timeoutMs: readyMs }, timeoutMs: readyMs + 1000 },
          ctx
        );
        steps.push(ready.output);
      }
      const foreground = await readForegroundWindow();
      if (title && !`${foreground.title} ${foreground.process}`.toLowerCase().includes(title.toLowerCase())) {
        throw new Error(`App test expected “${title}” in front, but the foreground window is “${foreground.title || '(unknown)'}”.`);
      }
      const shot = await executeStep(
        {
          type: 'screenshot',
          name: `Capture ${title || target}`,
          params: { caption: str(p.caption, `${target || title} smoke test`) },
          timeoutMs: Math.min(20000, budgetLeft(testBudget, 1500)),
        },
        ctx
      );
      evidence.push(...(shot.evidence || []));
      if (p.question) {
        const check = await executeStep(
          {
            type: 'verifyScreen',
            name: `Verify ${target}`,
            params: { question: p.question, title: p.title, app: p.process, caption: str(p.caption, `${target} verification`) },
            timeoutMs: Math.min(120000, budgetLeft(testBudget, 1000, 5000)),
          },
          ctx
        );
        evidence.push(...(check.evidence || []));
        steps.push(check.output);
      }
      const body = [
        `App test: ${target || title}`,
        `Foreground: ${foreground.title || '(unknown)'} (${foreground.process || 'unknown'})`,
        p.report ? `Observed: ${p.report}` : '',
        ...steps.map((line) => `- ${line}`),
        evidence[0]?.path ? `Screenshot: data/${evidence[0].path}` : '',
      ].filter(Boolean).join('\n');
      if (flag(p.note, true)) {
        saveInteractionNote({ title: p.noteTitle || `App test — ${title || target}`, body, tags: ['app-test'], runId: ctx.runId, workflowId: ctx.workflow?.id });
      }
      if (flag(p.close, false)) {
        const closeTitle = title || processName || target;
        await executeStep(
          { type: 'closeWindow', name: `Close ${closeTitle}`, params: { title: closeTitle }, timeoutMs: Math.min(15000, budgetLeft(testBudget, 1000)) },
          ctx
        );
      }
      return { output: `App test passed: ${title || target} is running${evidence[0]?.path ? ` and captured in data/${evidence[0].path}` : ''}.`, evidence };
    } catch (err) {
      if (flag(p.note, true)) {
        try {
          saveInteractionNote({
            title: p.noteTitle || `App test — ${title || target}`,
            body: `App test FAILED: ${target || title}\n\n${err.message}\n\n${evidence[0]?.path ? `Screenshot: data/${evidence[0].path}` : 'No screenshot captured.'}`,
            tags: ['app-test', 'failed'],
            runId: ctx.runId,
            workflowId: ctx.workflow?.id,
          });
        } catch {}
      }
      err.evidence = [...(err.evidence || []), ...evidence];
      throw err;
    }
  }

  if (step.type === 'watchVideo') {
    const title = str(p.title, 'YouTube');
    if (!live) return { output: `Simulated watch of “${title}” with notes.`, evidence: [], skipped: true };
    const noteText = p.textVar ? ctx.run?.variables?.[p.textVar] : p.notes;
    // The hold legitimately lasts as long as the media does, so this step's
    // budget comes from how long the hold may run (maxMs), not from the small
    // generic step timeout; the hold and the captures then share what is left
    // instead of being killed by a budget the hold never knew about.
    const holdCapMs = Math.max(30000, Math.min(1800000, num(p.maxMs, 900000)));
    const videoBudget = compositeBudget(holdCapMs + 60000, { fallbackMs: 960000, minMs: 60000, maxMs: 1900000 });
    const evidence = [];
    let startShot = null;
    if (flag(p.startCapture, true)) {
      try {
        startShot = await liveScreenshot(ctx.runId);
        evidence.push({ kind: 'screenshot', caption: `${title} — before watching`, ...startShot });
      } catch {}
    }
    try {
      const hold = await executeStep(
        {
          type: 'mediaHold',
          name: `Watch ${title}`,
          params: {
            title,
            bufferMs: p.bufferMs,
            maxMs: Math.min(holdCapMs, budgetLeft(videoBudget, 5000)),
            checkMs: p.checkMs,
            stallMs: p.stallMs,
            adGraceMs: p.adGraceMs,
            caption: str(p.caption, `${title} ended`),
          },
          timeoutMs: budgetLeft(videoBudget, 2000),
        },
        ctx
      );
      evidence.push(...(hold.evidence || []));
      const media = ctx.run?.media || {};
      const body = [
        `Video: ${title}`,
        `Result: ${hold.output}`,
        media.durationSec ? `Duration: ${Math.round(media.durationSec)}s (${Math.floor(media.durationSec / 60)}m ${Math.round(media.durationSec % 60)}s)` : '',
        media.endedNaturally ? 'Playback reached the end naturally.' : '',
        noteText ? `Observation notes:\n${String(noteText)}` : '',
        startShot?.path ? `Starting frame: data/${startShot.path}` : '',
        evidence.find((item) => item.path && item.caption?.includes('ended'))?.path
          ? `Ending frame: data/${evidence.find((item) => item.path && item.caption?.includes('ended')).path}`
          : '',
      ].filter(Boolean).join('\n');
      let note = null;
      if (flag(p.note, true)) {
        note = saveInteractionNote({
          title: p.noteTitle || `Video notes — ${title}`,
          body,
          tags: ['video', 'watch'],
          runId: ctx.runId,
          workflowId: ctx.workflow?.id,
          append: flag(p.append, true),
        });
      }
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[str(p.outputVar, 'videoNotesId')] = note?.id || '';
        if (note) ctx.run.variables.videoNotesPath = note.file;
      }
      return {
        output: `${hold.output}${note ? ` Notes saved to ${note.file}.` : ''}`,
        evidence,
      };
    } catch (err) {
      if (flag(p.note, true)) {
        try {
          saveInteractionNote({
            title: p.noteTitle || `Video notes — ${title}`,
            body: `Video watch FAILED: ${title}\n\n${err.message}${noteText ? `\n\nObservation notes:\n${String(noteText)}` : ''}`,
            tags: ['video', 'watch', 'failed'],
            runId: ctx.runId,
            workflowId: ctx.workflow?.id,
          });
        } catch {}
      }
      throw err;
    }
  }

  if (step.type === 'runTool') {
    const setupRef = String(p.setupCommandId || p.setupCommand || '').trim();
    if (setupRef) {
      if (p.toolId || p.toolName) {
        throw new Error('A runTool step names either a tool or an allowlisted setup command, not both.');
      }
      const entry = findSetupCommand(setupRef);
      if (!entry) throw new Error(`Setup command is not allowlisted: ${setupRef}`);
      if (entry.enabled === false) throw new Error(`Setup command "${entry.label}" is disabled.`);
      if (!live) return { output: `Simulated setup command: ${entry.label}`, evidence: [] };
      const result = await runSetupCommand(entry, { timeoutMs: step.timeoutMs });
      const caption = `Setup output — ${entry.label}`;
      if (!result.ok) {
        // The log is evidence even when the command failed, so attach it
        // before the step throws instead of losing it with the error.
        if (ctx.run && Array.isArray(ctx.run.evidence) && result.logRel) {
          const evidenceId = uid('evd');
          ctx.run.evidence.push({
            id: evidenceId,
            kind: 'log',
            caption,
            path: result.logRel,
            stepId: step.id,
            createdAt: now(),
          });
          const runStep = (ctx.run.steps || []).find((item) => item.id === step.id);
          if (runStep) runStep.evidenceIds.push(evidenceId);
        }
        throw new Error(`${setupSummary(entry, result)} Output: data/${result.logRel || '(log unavailable)'}`);
      }
      return {
        output: setupSummary(entry, result),
        evidence: result.logRel ? [{ kind: 'log', caption, path: result.logRel }] : [],
      };
    }
    const ref = String(p.toolId || p.toolName || '').trim();
    // Plans resolve names to ids before they run, but a workflow saved earlier
    // may still hold only the tool's name. Resolve either form so that step
    // keeps working, and name what failed when neither matches.
    const tool =
      (p.toolId && ctx.getTool ? ctx.getTool(p.toolId) : null) ||
      db().tools.find((entry) => entry.id === ref || entry.name === ref) ||
      null;
    if (!tool) throw new Error(`Tool not found: ${ref || '(missing id)'}`);
    if (!live) {
      return { output: `Simulated tool run: ${tool.name}`, evidence: [] };
    }
    const res = await runPowerShell(tool.code, step.timeoutMs || 30000);
    if (!res.ok) throw new Error(`Tool "${tool.name}" failed: ${res.stderr || res.stdout || 'non-zero exit'}`);
    return { output: res.stdout || `${tool.name} completed in ${res.ms}ms`, evidence: [] };
  }

  if (step.type === 'clipboard') {
    const action = str(p.action, 'copy').toLowerCase();
    const outputVar = str(p.outputVar, 'clipboardText');
    const minChars = Math.max(0, num(p.minChars, 1));
    if (!live) {
      return { output: `Simulated clipboard ${action}${p.outputVar ? ` → ${p.outputVar}` : ''}.`, evidence: [] };
    }
    const send = async (keys) =>
      executeStep(
        { type: 'key', name: `Clipboard ${action}`, params: { keys, foreground: p.foreground, gapMs: 180 }, timeoutMs: 10000 },
        ctx
      );
    const remember = (text) => {
      const clean = p.trim === false ? String(text ?? '') : String(text ?? '').replace(/^\s+|\s+$/g, '');
      if (ctx.run) {
        if (!ctx.run.variables) ctx.run.variables = {};
        ctx.run.variables[outputVar] = clean;
      }
      return clean;
    };
    if (action === 'write') {
      const text = p.textVar ? ctx.run?.variables?.[p.textVar] : p.text;
      if (text == null) throw new Error('Clipboard write needs text or a textVar.');
      await writeClipboardText(String(text));
      remember(String(text));
      return { output: `Wrote ${String(text).length} characters to the clipboard.`, evidence: [] };
    }
    if (action === 'read') {
      // Some apps (notably Electron/VS Code derivatives) acknowledge a copy
      // click before the clipboard actually changes. Poll briefly instead of
      // failing on the first empty read.
      const attempts = Math.max(1, Math.min(20, num(p.attempts, minChars > 0 ? 6 : 1)));
      const retryMs = Math.max(100, Math.min(3000, num(p.retryMs, 400)));
      let text = '';
      for (let attempt = 1; attempt <= attempts; attempt++) {
        text = remember(await readClipboardText());
        if (text.length >= minChars) break;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
      if (text.length < minChars) throw new Error(`Clipboard has ${text.length} characters, below minChars=${minChars} after ${attempts} read(s).`);
      // A length alone does not prove the copy; assert the content when known.
      const expectedText = String(p.expectText ?? p.text ?? '').replace(/\s+/g, ' ').trim();
      if (expectedText && p.verifyText !== false && !text.replace(/\s+/g, ' ').includes(expectedText)) {
        throw new Error(
          `Clipboard has ${text.length} characters but not the expected text “${expectedText.slice(0, 120)}”: “${text.slice(0, 120).replace(/\s+/g, ' ')}”`
        );
      }
      return { output: `Read ${text.length} characters from the clipboard: ${text.slice(0, 180).replace(/\s+/g, ' ')}`, evidence: [] };
    }
    if (action === 'clear') {
      await writeClipboardText('');
      remember('');
      return { output: 'Clipboard cleared.', evidence: [] };
    }
    if (action === 'paste') {
      const text = p.textVar ? ctx.run?.variables?.[p.textVar] : p.text;
      if (text != null) await writeClipboardText(String(text));
      const caretLine = await placeCaretForTyping(step, ctx);
      await send('^v');
      return {
        output: `${text != null ? `Pasted ${String(text).length} characters from the clipboard.` : 'Pasted the current clipboard.'}${caretLine ? ` | ${caretLine}` : ''}`,
        evidence: [],
      };
    }
    if (action === 'selectall') {
      await send('^a');
      return { output: 'Selected all content with ctrl+a.', evidence: [] };
    }
    if (!['copy', 'copyall', 'cut'].includes(action)) {
      throw new Error(`Unknown clipboard action: ${action}. Use copy, copyAll, cut, paste, selectAll, read, write or clear.`);
    }
    const before = await readClipboardText().catch(() => '');
    if (action === 'copyall') await send('^a');
    await send(action === 'cut' ? '^x' : '^c');
    await new Promise((resolve) => setTimeout(resolve, Math.max(120, Math.min(2000, num(p.waitMs, 350)))));
    const after = remember(await readClipboardText());
    if (after.length < minChars) {
      throw new Error(`Copy left only ${after.length} characters on the clipboard; the shortcut probably did not reach the selected app.`);
    }
    if (p.allowUnchanged !== true && before && before === after) {
      throw new Error('Clipboard did not change after the copy shortcut. Select the document text or check that the right app is focused.');
    }
    return {
      output: `Copied ${after.length} characters to the clipboard (${outputVar}): ${after.slice(0, 180).replace(/\s+/g, ' ')}`,
      evidence: [],
    };
  }

  if (step.type === 'dragCopy') {
    const outputVar = str(p.outputVar, 'selectedText');
    if (!live) {
      return { output: `Simulated drag-highlight copy → ${outputVar}.`, evidence: [] };
    }
    let x1 = Number(p.x1 ?? p.startX);
    let y1 = Number(p.y1 ?? p.startY);
    let x2 = Number(p.x2 ?? p.endX);
    let y2 = Number(p.y2 ?? p.endY);
    let guard = String(p.foreground || p.window || '').trim();
    const label = String(p.text || p.name || '').trim();
    let element = { found: false, reason: 'not searched' };
    const minChars = Math.max(1, num(p.minChars, 1));
    const expectedText = String(p.expectText ?? p.text ?? '').replace(/\s+/g, ' ').trim();
    const verifyCopy = (copied) => {
      if (copied.length < minChars) {
        throw new Error(`Drag-highlight copied ${copied.length} characters, below minChars=${minChars}. The drag may have missed the text.`);
      }
      if (expectedText && p.verifyText !== false) {
        const flat = copied.replace(/\s+/g, ' ');
        if (!flat.includes(expectedText)) {
          throw new Error(
            `Drag-highlight copied ${copied.length} characters, but they do not contain “${expectedText.slice(0, 120)}”: “${flat.slice(0, 120)}”.`
          );
        }
      }
    };
    const hasCoords = [x1, y1, x2, y2].every((value) => Number.isFinite(value) && value > 0);
    if (!hasCoords) {
      if (!label) throw new Error('Drag-copy needs x1/y1/x2/y2 or the visible text to select.');
      const searchWindow = String(p.window || p.foreground || '');
      const searches = [
        { window: searchWindow, name: label, controlType: String(p.controlType || '') },
        { window: searchWindow, name: label, controlType: 'Document|Edit|Text' },
        { window: searchWindow, name: label, controlType: 'Text|Document|Edit' },
        { window: searchWindow, name: label.slice(0, 40), controlType: '' },
      ];
      for (const search of searches) {
        element = await findUiElement(search);
        if (element.found) break;
      }
      if (!element.found) {
        if (p.fallbackKeyboard === false) {
          throw new Error(`Drag-copy could not find “${label}” to highlight (${element.reason || 'not present'}).`);
        }
        // WinUI apps such as Windows 11 Notepad keep the document text out of the
        // UI Automation name tree, so no element exists to drag over. Highlight
        // the same visible line from the caret instead and prove the copy by
        // reading the clipboard back.
        if (!guard) {
          try {
            const foreground = await readForegroundWindow();
            guard = String(foreground?.title || '').trim();
          } catch {
            guard = '';
          }
        }
        if (!guard) {
          throw new Error(`Drag-copy could not find “${label}” and no foreground window guard is available for the keyboard fallback.`);
        }
        const keyParams = { foreground: guard };
        const sendKeys = async (keys, name) => {
          await executeStep({ type: 'key', name, params: { keys, ...keyParams }, timeoutMs: 10000 }, ctx);
        };
        const copyWithKeys = async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(3000, num(p.copyWaitMs, 500)))));
          const text = String(await readClipboardText()).trim();
          verifyCopy(text);
          return text;
        };
        let copied = '';
        let lineError = '';
        try {
          await sendKeys('end', 'Place the caret after the text');
          await sendKeys('shift+home', 'Highlight the text back to the line start');
          await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.settleMs, 450)))));
          await sendKeys('^c', 'Copy the highlighted text');
          copied = await copyWithKeys();
        } catch (err) {
          lineError = err.message || String(err);
          // A line selection can start inside the text; select the whole document
          // and check that it contains the requested line before giving up.
          if (p.fallbackSelectAll === false || !expectedText) {
            throw new Error(
              `Drag-copy could not highlight “${label}” (${element.reason || 'not present'}) and the keyboard fallback failed: ${lineError}`
            );
          }
          try {
            await sendKeys('^a', 'Select all text in the document');
            await sendKeys('^c', 'Copy the selected text');
            copied = await copyWithKeys();
          } catch (retryError) {
            throw new Error(
              `Drag-copy could not highlight “${label}” (${element.reason || 'not present'}); line selection failed (${lineError}) and select-all did not copy the text (${retryError.message}).`
            );
          }
        }
        if (ctx.run) {
          if (!ctx.run.variables) ctx.run.variables = {};
          ctx.run.variables[outputVar] = copied;
        }
        return {
          output: `Highlighted “${label}” with the keyboard and copied ${copied.length} characters into ${outputVar} (UI Automation does not expose this text): ${copied.slice(0, 180).replace(/\s+/g, ' ')}`,
          evidence: [],
        };
      }
      // Highlight the whole visible control from just inside its left edge to
      // just inside its right edge, on the text baseline.
      const pad = Math.max(2, Math.min(10, Math.round((element.width || 20) * 0.03)));
      x1 = Math.round(element.x - element.width / 2 + pad);
      x2 = Math.round(element.x + element.width / 2 - pad);
      y1 = y2 = Math.round(element.y);
      guard = guard || element.title || '';
    }
    const dragAndCopy = async (ax, ay, bx, by) => {
      await executeStep(
        {
          type: 'drag',
          name: `Highlight ${str(p.text || p.name, 'text')}`,
          params: {
            x1: ax,
            y1: ay,
            x2: bx,
            y2: by,
            durationMs: Math.max(120, Math.min(3000, num(p.durationMs, 600))),
            button: p.button || 'left',
            ...(guard ? { foreground: guard } : {}),
          },
          timeoutMs: Math.max(10000, Number(step.timeoutMs) || 15000),
        },
        ctx
      );
      await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.settleMs, 450)))));
      await executeStep(
        {
          type: 'key',
          name: 'Copy the highlighted text',
          params: { keys: ['^c'], gapMs: 160, ...(guard ? { foreground: guard } : {}) },
          timeoutMs: 10000,
        },
        ctx
      );
      await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.copyWaitMs, 500)))));
      return String(await readClipboardText()).trim();
    };
    const failures = [];
    let copied = '';
    let dragError = '';
    try {
      copied = await dragAndCopy(x1, y1, x2, y2);
      verifyCopy(copied);
    } catch (err) {
      dragError = String(err.message || err);
      failures.push(`drag: ${dragError.replace(/\s+/g, ' ').slice(0, 160)}`);
      // A drag that starts inside the text copies only the tail; widen it to the
      // whole control before choosing a different method.
      if (element?.found) {
        const left = Math.round(element.x - (element.width || 20) / 2);
        const right = Math.round(element.x + (element.width || 20) / 2);
        if (left < x1 || right > x2) {
          try {
            copied = await dragAndCopy(Math.max(1, left - 2), Math.round(element.y), right + 2, Math.round(element.y));
            verifyCopy(copied);
            dragError = '';
          } catch (wideError) {
            failures.push(`full-width drag: ${String(wideError.message || wideError).replace(/\s+/g, ' ').slice(0, 160)}`);
          }
        }
      }
      if (dragError && (!expectedText || p.fallbackKeyboard === false)) {
        throw new Error(`Drag-copy could not copy “${label}”: ${failures.join(' | ')}`);
      }
      if (dragError) {
        // Keyboard fallbacks, best effort first: the line from the caret, then the
        // whole document. Each attempt still has to prove the copied text.
        const keyParams = guard ? { foreground: guard } : {};
        const sendKeys = async (keys, name) => {
          await executeStep({ type: 'key', name, params: { keys, ...keyParams }, timeoutMs: 10000 }, ctx);
        };
        const keyboardAttempts = [
          {
            name: 'keyboard line highlight',
            run: async () => {
              await sendKeys('end', 'Place the caret after the text');
              await sendKeys('shift+home', 'Highlight the text back to the line start');
              await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.settleMs, 450)))));
              await sendKeys('^c', 'Copy the highlighted text');
              await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.copyWaitMs, 500)))));
              return String(await readClipboardText()).trim();
            },
          },
          {
            name: 'select-all highlight',
            run: async () => {
              await sendKeys('^a', 'Select all text in the window');
              await sendKeys('^c', 'Copy the selected text');
              await new Promise((resolve) => setTimeout(resolve, Math.max(150, Math.min(2000, num(p.copyWaitMs, 500)))));
              return String(await readClipboardText()).trim();
            },
          },
        ];
        let recovered = false;
        for (const attempt of keyboardAttempts) {
          if (attempt.name === 'select-all highlight' && p.fallbackSelectAll === false) continue;
          try {
            copied = await attempt.run();
            verifyCopy(copied);
            recovered = true;
            break;
          } catch (keyError) {
            failures.push(`${attempt.name}: ${String(keyError.message || keyError).replace(/\s+/g, ' ').slice(0, 160)}`);
          }
        }
        if (!recovered) throw new Error(`Drag-copy could not copy “${label}”: ${failures.join(' | ')}`);
      }
    }
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[outputVar] = copied;
    }
    return {
      output: `Highlighted and copied ${copied.length} characters into ${outputVar}: ${copied.slice(0, 180).replace(/\s+/g, ' ')}`,
      evidence: [],
    };
  }

  if (step.type === 'aiExtract') {
    const outputVar = str(p.outputVar, 'extractedText');
    const instructions = str(p.instructions || p.question).trim();
    if (!instructions) throw new Error('AI extract needs instructions describing what to pull out.');
    let source = '';
    if (str(p.source, 'clipboard') === 'clipboard') {
      if (!live) {
        return {
          output: 'Simulated AI extraction — clipboard copy is skipped because there is no live desktop input.',
          evidence: [],
          skipped: true,
        };
      } else {
        source = await readClipboardText();
      }
    } else {
      source = str(p.textVar ? ctx.run?.variables?.[p.textVar] : p.text);
    }
    if (!source.trim()) throw new Error('AI extract found no source text. Copy the document or pass text/textVar first.');
    const maxChars = Math.max(500, Math.min(60000, num(p.maxChars, 24000)));
    const clipped = source.slice(0, maxChars);
    const reply = await chat(
      [
        {
          role: 'system',
          content:
            'You extract text from a document for a desktop workflow. Return JSON only: {"text":"...","found":true|false,"reason":"..."}. ' +
            'Copy the exact requested passage, preserving wording, line breaks and punctuation. Never invent, summarize unless asked, or add commentary. ' +
            'If the requested passage is not present, return found=false and empty text.',
        },
        {
          role: 'user',
          content: `What to extract: ${instructions}\n\nDocument text (${clipped.length} characters):\n${clipped}`,
        },
      ],
      { format: 'json', kind: 'extract', timeoutMs: 90000, temperature: 0 }
    );
    if (!reply.ok) throw new Error(`AI extraction failed: ${reply.error}`);
    const parsed = parseJsonLoose(reply.content);
    const extracted = String(parsed?.text ?? (parsed ? '' : reply.content)).trim();
    if (parsed?.found === false || !extracted) {
      throw new Error(`AI extraction found nothing for: ${instructions}. ${String(parsed?.reason || '').slice(0, 300)}`);
    }
    if (ctx.run) {
      if (!ctx.run.variables) ctx.run.variables = {};
      ctx.run.variables[outputVar] = extracted;
    }
    return {
      output: `AI extracted ${extracted.length} characters into ${outputVar}: ${extracted.slice(0, 220).replace(/\s+/g, ' ')}`,
      evidence: [],
    };
  }

  if (step.type === 'screenshot') {
    const caption = str(p.caption) || step.name;
    if (!live) {
      const sim = writeSimulatedEvidence({
        caption,
        stepName: step.name,
        workflowName: ctx.workflow?.name,
        runId: ctx.runId,
      });
      return {
        output: 'Simulated capture recorded (no screen input).',
        evidence: [{ kind: 'screenshot', caption, ...sim }],
      };
    }
    const shot = await liveScreenshot(ctx.runId);
    return {
      output: `Captured ${shot.width || '?'}x${shot.height || '?'} desktop.`,
      evidence: [{ kind: 'screenshot', caption, ...shot }],
    };
  }

  if (step.type === 'verifyScreen') {
    const caption = str(p.caption) || step.name;
    if (!live) {
      return {
        output: 'Simulated screen check — visual verification skipped because there are no live pixels.',
        evidence: [],
        skipped: true,
      };
    }
    // The subject is the window this run opened, not the whole desktop. A
    // lookalike document behind it used to be enough to make the model pass.
    // A pre-captured frame is the frame exactly as the step left it: judging it
    // must not focus, crop or photograph anything again.
    const preCaptured = p.frame && typeof p.frame === 'object' && p.frame.shot ? p.frame : null;
    const frame = preCaptured
      ? preCaptured
      : await captureScreenFrame({ step, run: ctx.run, runId: ctx.runId }).catch((err) => {
          const message = String(err?.skipped || err?.message || err);
          if (str(p.onError, 'fail') === 'warn') return { ok: false, skipped: message };
          throw new Error(message);
        });
    if (!frame.ok) {
      return { output: `${frame.skipped} (onError=warn)`, evidence: [], skipped: true };
    }
    const { target, shot, foreground, windowText } = frame;
    const expected = str(p.title || p.expected).trim();
    const expectedApp = str(p.app || p.expectedApp).trim();
    const expectedText = str(p.text || p.expectedText || p.contains).trim();
    const absentText = str(p.absent).trim();
    const facts = windowFacts({
      target: { ...target, process: target.process || expectedApp },
      foreground,
      expectedApp,
      expectedText,
      absentText,
      windowText: windowText.text,
      textSource: windowText.source,
    });
    const question =
      str(p.question).trim() ||
      `Does the screenshot clearly show ${expected || 'the expected application page'} in the expected state?`;
    const system =
      'You are a strict visual UI verifier. You are shown one live desktop screenshot. ' +
      'Judge only from visible pixels, never from step names, logs or assumptions. ' +
      'Return JSON only: {"pass":true|false,"confidence":0-1,"observed":"what is visibly on screen","mismatch":"what is wrong or missing"}. ' +
      'pass must be false when the wrong app or page is visible, the page is blank/loading, the requested control is absent, a video shows a large play overlay or is otherwise paused, or the evidence is unclear. ' +
      'Never pass on a guess. Name the visible app/page and the visible state in observed.';
    const user =
      `Check: ${question}${expected ? `\nExpected app/page: ${expected}` : ''}` +
      `${expectedApp ? `\nExpected app/process: ${expectedApp}` : ''}` +
      `\nActive foreground window: "${foreground.title || '(unknown)'}" (process: ${foreground.process || 'unknown'}). ` +
      `${target.scoped ? `The image is cropped to ${target.hwnd ? `the run's own window (hwnd ${target.hwnd})` : `“${target.title || target.process}”`}, not the whole desktop. ` : ''}` +
      (target.hwnd
        ? // The frame IS the run's window, so a title that changed is the document's
          // own name (typing into an untitled document makes its first line the
          // title), not a different program: the process is what names the app.
          `This frame is the run's own window, and a document renames itself as it is edited: typing into an untitled document makes its first line the title. Judge the app by its process (${foreground.process || target.process || 'unknown'}), not by the window title, and never fail a correct frame because the title differs.`
        : `If the expected app is named and this foreground window is a different program, fail even when another window behind it looks correct.`);
    const mode = judgeMode(db().settings);
    const cachedVerdict = readVerdict(question, shot.signature);
    let reply = null;
    let vision = cachedVerdict
      ? { pass: true, confidence: null, observed: String(cachedVerdict.output || ''), mismatch: '', cached: true }
      : null;
    let parsed = cachedVerdict ? { pass: true, observed: cachedVerdict.output } : null;
    if (!cachedVerdict) {
      reply = await chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          images: [modelImage(shot)],
          format: 'json',
          kind: 'screen-check',
          timeoutMs: Math.min(120000, Math.max(20000, Number(step.timeoutMs) || 90000)),
          temperature: 0,
          numCtx: 4096,
        }
      );
      if (!reply.ok) {
        // Facts mode is free: a conclusive deterministic pass stands on its own
        // when the model is unreachable.
        if (mode === 'facts' && facts.status === 'pass') {
          vision = {
            pass: false,
            confidence: null,
            observed: `the vision model was unreachable (${reply.error}); the deterministic check decided`,
            mismatch: '',
            offline: true,
          };
        } else {
          if (str(p.onError, 'fail') === 'warn') {
            return {
              output: `Screen check could not run (${reply.error}); continuing because onError=warn.`,
              evidence: [{ kind: 'screenshot', caption: `${caption} (unverified)`, ...shot }],
              // Unread is not a pass: the step is reported as skipped, not as
              // verified, so the run card never claims a check that never ran.
              skipped: true,
            };
          }
          const error = new Error(`Screen check could not read the screenshot: ${reply.error}`);
          error.evidence = [{ kind: 'screenshot', caption: `${caption} (unreadable)`, ...shot }];
          // A transport failure is an evidence gap, not a verdict: the frame was
          // never read, so the step must be reported as unverified, not failed.
          error.unreadable = true;
          throw error;
        }
      } else {
        parsed = parseJsonLoose(reply.content);
      }
    }
    if (!vision) {
      const rawConfidence = parsed?.confidence != null ? Number(parsed.confidence) : null;
      const confidence = Number.isFinite(rawConfidence)
        ? Math.round((rawConfidence > 1 ? rawConfidence / 100 : rawConfidence) * 100)
        : null;
      const minConfidence = Math.max(0, Math.min(1, Number(p.minConfidence ?? 0.7)));
      vision = {
        pass: Boolean(
          parsed &&
            (parsed.pass === true || parsed.ok === true || parsed.verified === true) &&
            (confidence == null || confidence >= minConfidence * 100)
        ),
        confidence,
        observed: String(parsed?.observed || parsed?.reason || reply?.content || '').slice(0, 700),
        mismatch: String(parsed?.mismatch || '').slice(0, 400),
        cached: false,
      };
    }
    // Two judges, one verdict. The mode is the operator's switch; agreement and
    // any repeated disagreement feed the review list, never an auto-change.
    const judge = mergeJudgement({ mode, facts, vision });
    const record = recordJudgement({
      mode: judge.mode,
      facts,
      vision,
      agreement: judge.agreement,
      decidedBy: judge.decidedBy,
      pass: judge.pass,
      workflowId: ctx.workflow?.id,
      runId: ctx.runId,
      stepId: step.id,
      question,
      target,
      detail: judge.detail,
    });
    const factsNote = `window facts: ${facts.status}${facts.status === 'unknown' ? '' : ` — ${facts.detail}`}`;
    // A model that is offline while the free facts are inconclusive is not a
    // judge saying "this is not it": there is no reading to disagree with. It is
    // reported as unreadable so a caller can record it as unverified instead of
    // failing the step on the evidence gap.
    if (!judge.pass && vision.offline && facts.status !== 'fail') {
      const message = `Screen check could not read the screen: ${vision.observed || 'the vision model was unreachable'}`;
      if (str(p.onError, 'fail') === 'warn') {
        return {
          output: `${message}; continuing because onError=warn.`,
          evidence: [{ kind: 'screenshot', caption: `${caption} (unverified)`, ...shot }],
          skipped: true,
        };
      }
      const error = new Error(`${message} · ${factsNote} [${shot.path}]`);
      error.evidence = [{ kind: 'screenshot', caption: `${caption} (unreadable)`, ...shot }];
      error.unreadable = true;
      throw error;
    }
    if (!judge.pass) {
      const reason = judge.decidedBy === 'facts' && facts.status === 'fail' ? facts.detail : vision.observed || 'no usable observation';
      const error = new Error(
        `Screen check failed${vision.confidence != null ? ` (vision ${vision.confidence}%)` : ''}${
          vision.mismatch ? ` | ${vision.mismatch}` : ''
        }: ${reason || 'no usable observation'} · ${factsNote} [${shot.path}]`
      );
      error.evidence = [{ kind: 'screenshot', caption: `${caption} (failed check)`, ...shot }];
      throw error;
    }
    const verified = `Screen verified${vision.confidence != null ? ` (vision ${vision.confidence}%)` : ''}${
      judge.agreement === 'agree' ? ', both judges agree' : judge.decidedBy === 'facts' ? ', facts decided' : ''
    }: ${vision.observed}${cachedVerdict ? ' (screen unchanged, cached verdict)' : ''} · ${factsNote}`;
    writeVerdict(question, shot.signature, { output: verified });
    return {
      output: verified,
      evidence: [{ kind: 'screenshot', caption, ...shot }],
      judgement: record,
    };
  }

  if (step.type === 'verifyPlayback') {
    const caption = str(p.caption) || step.name;
    if (!live) {
      return {
        output: 'Simulated playback check — frame comparison skipped because there are no live pixels.',
        evidence: [],
        skipped: true,
      };
    }
    const targetWindow = str(p.title || p.expected).trim();
    // A player that was raised at launch can lose the foreground to another
    // app. Reading the desktop then proves nothing, so the named player is put
    // in front and confirmed before any frame is captured.
    if (targetWindow) {
      let state = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await executeStep(
            {
              id: uid('chk'),
              type: 'focusWindow',
              name: `Bring ${targetWindow} to the front for the playback check`,
              params: { title: targetWindow },
              timeoutMs: 15000,
            },
            ctx
          );
        } catch {
          // The state check below decides; a refused focus is not conclusive.
        }
        state = await inspectWindowState({ title: targetWindow });
        if (state.state === 'foreground') break;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      if (state?.state !== 'foreground') {
        throw new Error(
          `Playback check could not start: “${targetWindow}” is not in the foreground (state ${state?.state || 'unknown'}; foreground is “${
            state?.foreground?.title || 'unknown'
          }”). The player must be visible before two frames can prove playback.`
        );
      }
    }
    const expected = str(p.title || p.expected, 'the video page or player').trim();
    const gap = Math.max(1000, Math.min(15000, num(p.intervalMs, 4000)));
    // With a named player the frames are cropped to the foreground window: a
    // moving wallpaper, clock or neighbouring app on the same desktop would
    // otherwise read as the video advancing.
    const visionShot = {
      maxWidth: VISION_ENABLED ? VISION_MAX_WIDTH : 0,
      quality: VISION_JPEG_QUALITY,
      crop: targetWindow ? 'foreground' : undefined,
    };
    await new Promise((resolve) => setTimeout(resolve, 500));
    const first = await liveScreenshot(ctx.runId, visionShot);
    // A player can slip behind another window the moment its media ends, so it is
    // raised again for the second frame instead of capturing whatever covers it.
    if (targetWindow) {
      try {
        await executeStep(
          {
            id: uid('chk'),
            type: 'focusWindow',
            name: `Bring ${targetWindow} back for the second frame`,
            params: { title: targetWindow },
            timeoutMs: 15000,
          },
          ctx
        );
      } catch {
        // The crop title below decides whether the frame really is the player.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, gap));
    const second = await liveScreenshot(ctx.runId, visionShot);
    const evidence = [
      { kind: 'screenshot', caption: `${caption} — frame 1`, ...first },
      { kind: 'screenshot', caption: `${caption} — frame 2`, ...second },
    ];
    // Each cropped frame records the window it was cut from at capture time. That
    // title is the proof these pictures are the player; reading focus later would
    // describe a different moment, and focus can change a second after capture.
    const stray = targetWindow
      ? [first, second].find(
          (shot) => shot.cropTitle && !shot.cropTitle.toLowerCase().includes(targetWindow.toLowerCase())
        )
      : null;
    if (stray) {
      throw Object.assign(
        new Error(
          `Playback check stopped early: a frame was cropped to “${stray.cropTitle}”, not “${targetWindow}”, so it is not the player.`
        ),
        { evidence }
      );
    }
    // A dialog on top of the player makes the crop a picture of the dialog, and
    // a model reading a covered player can transcribe a convincing readout that
    // does not exist. This runs before the model sees the frames.
    if (targetWindow) {
      const covering = await coveringWindows(targetWindow);
      const cover = covering[0];
      if (cover) {
        throw Object.assign(
          new Error(
            `Playback check stopped early: “${cover.title}”${cover.process ? ` (${cover.process})` : ''} covers “${targetWindow}”, so the two frames are not clean pictures of the player.`
          ),
          { evidence }
        );
      }
    }
    const prompts = playbackCheckPrompts({ expected, question: str(p.question).trim(), gap });
    const reply = await chat(
      [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user },
      ],
      {
        images: [modelImage(first), modelImage(second)],
        format: 'json',
        kind: 'playback-check',
        timeoutMs: Math.min(150000, Math.max(30000, Number(step.timeoutMs) || 120000)),
        temperature: 0,
        numCtx: 4096,
      }
    );
    if (!reply.ok) {
      if (str(p.onError, 'fail') === 'warn') {
        return {
          output: `Playback check could not run (${reply.error}); continuing because onError=warn.`,
          evidence,
          skipped: true,
        };
      }
      const error = new Error(`Playback check could not compare frames: ${reply.error}`);
      error.evidence = evidence;
      throw error;
    }
    const parsed = parseJsonLoose(reply.content);
    const minConfidence = Math.max(0, Math.min(1, Number(p.minConfidence ?? 0.7)));
    // The media file's own length, when it is known, is an independent total
    // that the transcription has to agree with.
    const mediaSeconds = await mediaDurationSeconds(ctx.run);
    const verdict = playbackVerdict(parsed, { minConfidence, expectedDuration: mediaSeconds });
    const observed = String(parsed?.observed || parsed?.reason || reply.content || '').slice(0, 700);
    const mismatch = String(parsed?.mismatch || '').slice(0, 400);

    // The two frames can be identical because the video reached its end, or
    // because it never started. When this check cannot tell, this run's own
    // earlier screenshots decide: they are real evidence that the media played.
    let history = null;
    let historyNote = '';
    if (!verdict.pass) {
      const prior = playbackHistoryShots(ctx.run, { exclude: [first.path, second.path], limit: 1 })[0];
      if (!prior) historyNote = 'this run has no earlier screenshot to compare against';
      else {
        const historyReply = await chat(
          [
            { role: 'system', content: playbackHistoryPrompts({ expected, gap }).system },
            { role: 'user', content: playbackHistoryPrompts({ expected, gap }).user },
          ],
          {
            images: [modelImage(prior), modelImage(second)],
            format: 'json',
            kind: 'playback-history-check',
            timeoutMs: 90000,
            temperature: 0,
            numCtx: 4096,
          }
        );
        if (historyReply.ok) {
          const historyParsed = parseJsonLoose(historyReply.content);
          const historyVerdict = playbackVerdict(historyParsed, { minConfidence, expectedDuration: mediaSeconds });
          const samePlayer = historyParsed?.samePlayer !== false && historyParsed?.same_player !== false;
          if (historyVerdict.pass && samePlayer) {
            history = { prior, parsed: historyParsed, verdict: historyVerdict };
            evidence.unshift({
              kind: 'screenshot',
              caption: `${caption} — earlier frame from this run`,
              ...prior,
            });
          } else {
            const why = historyVerdict.pass ? 'the player or media did not match' : historyVerdict.reason || 'no verdict';
            historyNote = `the earlier frame did not prove a finish: ${why}`;
          }
        } else {
          historyNote = `the history check could not run (${historyReply.error})`;
        }
      }
    }

    if (!verdict.pass && !history) {
      const error = new Error(
        `Playback check failed${verdict.confidence != null ? ` (${verdict.confidence}%)` : ''}: ${verdict.reason}. ${
          observed || 'no usable observation'
        }${mismatch ? ` | ${mismatch}` : ''}${historyNote ? ` | history fallback: ${historyNote}` : ''} [${first.path}, ${second.path}]`
      );
      error.evidence = evidence;
      throw error;
    }
    // A pass whose total was never cross-checked against the file is weaker, and
    // says so on the step instead of reading like a full check.
    const weaker = mediaSeconds == null ? ' The media length was unavailable, so the readout total was not cross-checked.' : '';
    if (history) {
      return {
        output: `Playback verified from this run's screenshot history${history.verdict.confidence != null ? ` (${history.verdict.confidence}%)` : ''}: ${
          String(history.parsed?.observed || history.parsed?.reason || '').slice(0, 500) || 'the earlier frame shows the video in progress'
        } [earlier ${history.prior.path}].${weaker}`,
        evidence,
        playback: {
          source: 'history',
          state: history.verdict.state,
          finished: history.verdict.finished,
          crossChecked: mediaSeconds != null,
        },
      };
    }
    return {
      output:
        (verdict.completed
          ? `Playback finished${verdict.confidence != null ? ` (${verdict.confidence}%)` : ''}: the video played to its end. ${observed}`
          : `Playback advancing${verdict.confidence != null ? ` (${verdict.confidence}%)` : ''}: ${observed}`) + weaker,
      evidence,
      playback: {
        source: 'frames',
        state: verdict.state,
        finished: verdict.completed,
        crossChecked: mediaSeconds != null,
      },
    };
  }

  if (step.type === 'playMedia' && live) {
    const title = str(p.title, 'YouTube');
    const visionShot = { maxWidth: VISION_ENABLED ? VISION_MAX_WIDTH : 0, quality: VISION_JPEG_QUALITY };
    const first = await liveScreenshot(ctx.runId, visionShot);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const second = await liveScreenshot(ctx.runId, visionShot);
    const system =
      'You are a strict video state checker. You are shown TWO live desktop screenshots taken in order, frame 1 then frame 2. ' +
      'Decide whether the video is actively playing, paused, or unknown. ' +
      'Return JSON only: {"state":"playing|paused|unknown","playing":true|false,"progressed":true|false,"confidence":0-1,"playControl":{"visible":true|false,"x":0,"y":0},"observed":"what is visible in each frame"}. ' +
      'In playControl give the pixel centre of the play/pause control in frame 2 when one is visible; set visible to false when the controls are hidden, cut off, or hidden behind another window. ' +
      'Use "playing" only when a watch page/player is visible, a pause control (not a large centre play button) is shown, there is no buffering spinner, progress is beyond 0:00, and the elapsed time or video frame advanced between frame 1 and frame 2. ' +
      'Use "paused" when the frames are effectively identical and a large play overlay or play control is visible. ' +
      'Use "unknown" for another app, a search grid, a blank/loading page, an ad, or anything ambiguous. Never guess.';
    const user = `Expected media window: ${title}. Frame 1 is the first image; frame 2 is the second image, taken 3000ms later.`;
    const reply = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        images: [modelImage(first), modelImage(second)],
        format: 'json',
        kind: 'playback-state',
        timeoutMs: 90000,
        temperature: 0,
        numCtx: 4096,
      }
    );
    const evidence = [
      { kind: 'screenshot', caption: 'Playback state before play attempt — frame 1', ...first },
      { kind: 'screenshot', caption: 'Playback state before play attempt — frame 2', ...second },
    ];
    if (!reply.ok) {
      const error = new Error(`Could not determine playback state: ${reply.error}`);
      error.evidence = evidence;
      throw error;
    }
    const parsed = parseJsonLoose(reply.content);
    const rawConfidence = parsed?.confidence != null ? Number(parsed.confidence) : null;
    const confidence = Number.isFinite(rawConfidence)
      ? Math.round((rawConfidence > 1 ? rawConfidence / 100 : rawConfidence) * 100)
      : null;
    const state = String(parsed?.state || '').toLowerCase();
    const playing = parsed?.playing === true;
    const progressed = parsed?.progressed === true;
    const minConfidence = Math.max(0, Math.min(1, Number(p.minConfidence ?? 0.6)));
    const confident = confidence == null || confidence >= minConfidence * 100;
    if (state === 'playing' && playing && progressed && confident) {
      return {
        output: `Already playing${confidence != null ? ` (${confidence}%)` : ''}: ${String(parsed?.observed || '').slice(0, 500)}`,
        evidence,
      };
    }
    const looksPaused = state === 'paused' || (state === 'playing' && !progressed);
    if (!looksPaused || !confident) {
      const error = new Error(
        `Refusing to click play because the playback state is unclear (state=${state || 'unknown'}, progressed=${progressed})${confidence != null ? ` (${confidence}%)` : ''}: ${String(parsed?.observed || '').slice(0, 500)}`
      );
      error.evidence = evidence;
      throw error;
    }
    // Click the control that is actually on screen. A blind click at the step's
    // stored coordinates lands on whatever happens to be there when the player
    // has hidden its controls or another window is in front.
    let target = visionPointToScreen(second, parsed?.playControl);
    if (!target) {
      await revealPlayerControls(step, second, ctx);
      let retryShot = null;
      try {
        retryShot = await liveScreenshot(ctx.runId, visionShot);
        evidence.push({ kind: 'screenshot', caption: 'Play control after revealing the player controls', ...retryShot });
      } catch {
        retryShot = null;
      }
      if (retryShot) {
        const retry = await chat(
          [
            {
              role: 'system',
              content:
                'You locate a video player control. Return JSON only: {"visible":true|false,"x":0,"y":0,"observed":"what you see"}. ' +
                'x and y are the pixel centre of the play/pause control in this image. Use visible:false when no play control can be seen, and never guess coordinates.',
            },
            { role: 'user', content: `Expected media window: ${title}.` },
          ],
          {
            images: [modelImage(retryShot)],
            format: 'json',
            kind: 'playback-state',
            timeoutMs: 60000,
            temperature: 0,
            numCtx: 2048,
          }
        );
        if (retry.ok) target = visionPointToScreen(retryShot, parseJsonLoose(retry.content));
      }
    }
    if (!target) {
      const error = new Error(
        `The play control is not visible on screen, so no click was made at ${num(p.x)},${num(p.y)}. ` +
          `Bring the player to the front (focusWindow) or exit full screen, then retry. Observed: ${String(
            parsed?.observed || 'no play button found'
          ).slice(0, 300)}`
      );
      error.evidence = evidence;
      throw error;
    }
    await executeStep(
      {
        type: 'click',
        name: `Click play in ${title}`,
        params: { x: target.x, y: target.y, button: str(p.button, 'left'), ...(title ? { foreground: title } : {}) },
        timeoutMs: step.timeoutMs || 20000,
      },
      ctx
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return {
      output: `Paused player detected; clicked the play control inside the player at ${target.x},${target.y}${
        target.x !== num(p.x) || target.y !== num(p.y) ? ' (adjusted from the step\'s stored point to where the control actually is)' : ''
      }. Verify playback next.`,
      evidence,
    };
  }

  if (step.type === 'clickElement') {
    const requested = str(p.name).trim();
    if (!live) return { output: `Simulated: find and click “${requested}” in ${str(p.window, 'the window')}.`, evidence: [] };
    if (!requested) throw new Error('Click element needs a visible control name.');
    const title = str(p.window || p.title);
    // A control is only meaningful inside the window it belongs to: without one
    // the search matches whatever looks similar anywhere on the desktop.
    if (!title) {
      throw new Error(
        `“${requested}” needs the window it belongs to (params.window). Without it the search could click a control in another app, so nothing was clicked.`
      );
    }
    await executeStep({ type: 'focusWindow', name: 'Focus target window', params: { title }, timeoutMs: 15000 }, ctx);

    const labels = elementLabels(requested);
    const controlTypes = [...new Set([str(p.controlType).trim(), ''])];
    let el = { found: false, reason: 'not searched' };
    let matchedLabel = '';
    let matchedType = '';
    const waitMs = Math.max(0, Math.min(120000, num(p.waitMs, 0)));
    const findDeadline = Date.now() + waitMs;
    while (true) {
      outer: for (const label of labels) {
        for (const controlType of controlTypes) {
          el = await findUiElement({ window: title, name: label, controlType, preferLast: p.preferLast === true, preferRight: p.preferRight === true });
          if (el.found) {
            matchedLabel = label;
            matchedType = controlType;
            break outer;
          }
        }
      }
      if (el.found || Date.now() >= findDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!el.found && waitMs) el.reason = `${el.reason}; waited ${waitMs}ms for the control`;

    const clickFound = async (x, y, method, evidence = [], surroundings = null, note = '') => {
      const clicks = Math.max(1, Math.min(2, Number(p.clicks) || 1));
      // A deliberate approach: the pointer passes just above-left of the target
      // instead of teleporting, which also makes hover menus render.
      if (flag(p.humanize, false)) {
        try {
          await movePointerPath([{ x: x - 40, y: y - 30 }, { x, y }], num(p.moveStepMs, 45));
        } catch {
          // Pointer approach is cosmetic; the click below still runs.
        }
      }
      const clicked = await executeStep(
        {
          type: clicks > 1 ? 'doubleClick' : 'click',
          name: `Click ${requested}`,
          params: { x, y, button: str(p.button, 'left'), ...(title ? { foreground: title } : {}) },
          timeoutMs: 10000,
        },
        ctx
      );
      const around = surroundings?.summary ? ` Nearby: ${surroundings.summary}.` : '';
      const caution = surroundings?.caution ? ` ${surroundings.caution}` : '';
      return {
        output: `Clicked “${el.name || requested}” via ${method} at ${x},${y}.${note ? ` ${note}.` : ''}${around}${caution}`,
        // Why the earlier locators did not answer, when the click came from a
        // fallback. Kept as a field too, so a run's record can be reviewed
        // without re-reading the sentence.
        ...(note ? { locateNote: note } : {}),
        // Where the click actually landed, as a fact rather than a sentence: a
        // vision-fallback click, a preview-corrected one and a plain UIA match
        // all report the same shape, so the point is always learnable.
        clickPoint: { x, y, method, name: String(el.name || requested).slice(0, 80), window: title },
        evidence: [...evidence, ...(clicked.evidence || [])],
        ...(surroundings ? { surroundings } : {}),
      };
    };

    if (el.found) {
      // The inspection script is DPI-aware, so these are physical pixels, the
      // same units the input script now moves in.
      const x = Math.round(el.x);
      const y = Math.round(el.y);
      el.name = el.name || matchedLabel;
      return clickFound(
        x,
        y,
        `UI Automation (${el.controlType || 'element'}${el.score ? `, score ${el.score}` : ''}${matchedType ? `, ${matchedType}` : ''})`
      );
    }

    // Preview before acting: one vision read of the current screen can prove the
    // outcome already exists (skip the click), name the elements around the
    // target, or correct the position the step was about to use.
    let preview = null;
    if (flag(p.preview, false)) {
      try {
        preview = await previewActionOnce({
          step,
          description: requested,
          title,
          expected: str(p.expect || p.verifyAfter || ''),
        });
      } catch (err) {
        preview = { found: false, reason: err.message };
      }
      const decision = decidePreview({ preview, step, minConfidence: num(p.minConfidence, 0.6) });
      if (decision.skip) {
        return {
          output: `Screen preview: ${decision.reason}. The click was skipped; the next step continues from the state that is already open.`,
          evidence: preview?.shot ? [preview.shot] : [],
          skipped: true,
          preview: { alreadyDone: true, nearby: decision.nearby, caution: decision.caution },
        };
      }
      if (!el.found && decision.apply) {
        el = { ...el, name: requested };
        return clickFound(
          decision.x,
          decision.y,
          `preview (${decision.reason})`,
          preview?.shot ? [preview.shot] : [],
          preview ? describeSurroundings({ target: { x: decision.x, y: decision.y }, elements: [] }) : null
        );
      }
    }

    // A control with a label does not need a model. The desktop's own OCR reads
    // the window in 19–46 ms and the label sits inside the control, so this runs
    // before the vision fallback and answers most of what the model used to.
    let ocrReason = '';
    // The failed read keeps its capture as evidence: a reason in words alone
    // cannot show that OCR ran over a blank or off-screen window.
    let ocrEvidence = [];
    let ocrNote = '';
    if (p.ocr !== false) {
      const ocrStarted = Date.now();
      try {
        const read = await findUiElementByOcr({ window: title, names: labels });
        if (read.found) {
          el = { ...el, name: read.text };
          return clickFound(
            read.x,
            read.y,
            `OCR “${read.text}”${read.ink ? ' (ink-centred)' : ''}, read in ${read.ms}ms`,
            read.shot ? [read.shot] : []
          );
        }
        ocrReason = read.reason || 'no label read';
        if (read.shot) {
          ocrEvidence = [{ ...read.shot, caption: `OCR found nothing — ${ocrReason}` }];
        }
      } catch (err) {
        ocrReason = err.message;
      }
      ocrNote = `OCR did not answer (${ocrReason}, ${Date.now() - ocrStarted}ms${
        ocrEvidence.length ? ', the read is attached' : ', no capture was written'
      })`;
    } else {
      ocrNote = 'OCR was disabled for this step (ocr:false)';
    }

    // Last-resort element search: ask the vision model where the target is on a
    // fresh full-screen capture. This covers controls that carry no text at all
    // — an icon, a toolbar glyph — while the confidence threshold prevents blind
    // clicks.
    let visionNote = '';
    if (p.visionFallback !== false && p.vision !== false) {
      const visual = await findVisualElement({
        description: requested,
        title,
        minConfidence: p.minConfidence ?? 0.65,
      });
      if (visual.found) {
        // The capture and the locate are DPI-aware, so this point is already in
        // physical pixels; dividing by the display scale moved it off target.
        const x = Math.round(visual.x);
        const y = Math.round(visual.y);
        el = { ...el, name: requested };
        // Say why the text locator did not answer: a silent drop to the model
        // looks exactly like a control that carries no text at all.
        return clickFound(
          x,
          y,
          `vision ${Math.round((visual.confidence || 0) * 100)}%`,
          [...ocrEvidence, ...(visual.shot ? [visual.shot] : [])],
          null,
          ocrNote
        );
      }
      visionNote = `vision did not answer (${visual.reason || 'no confident match'})`;
    } else {
      visionNote = 'the vision fallback was disabled for this step';
    }

    if (p.fallbackX != null && p.fallbackY != null) {
      // A blind coordinate click reports both reasons: without them the run looks
      // like a successful locate instead of two failed ones.
      el = { ...el, name: requested };
      return clickFound(
        Number(p.fallbackX),
        Number(p.fallbackY),
        'fallback coordinates',
        ocrEvidence,
        null,
        `${ocrNote}. ${visionNote}`
      );
    }
    throw new Error(
      `UI element not found: “${requested}” in ${title || 'the foreground window'} after trying [${labels.join(' | ')}], an OCR read${ocrReason ? ` (${ocrReason})` : ''} and a vision fallback (${el.reason || 'not present'}).`
    );
  }

  if (step.type === 'mediaHold') {
    const caption = str(p.caption) || step.name;
    if (!live) {
      return {
        output: 'Simulated media hold — no player clock is available without live control.',
        evidence: [],
        skipped: true,
      };
    }
    const title = str(p.title, 'YouTube');
    const bufferMs = Math.max(0, Math.min(60000, num(p.bufferMs, 5000)));
    const checkMs = Math.max(1000, Math.min(30000, num(p.checkMs, 5000)));
    const stallMs = Math.max(5000, Math.min(120000, num(p.stallMs, 30000)));
    const adGraceMs = Math.max(30000, Math.min(300000, num(p.adGraceMs, 180000)));
    const maxMs = Math.max(30000, Math.min(1800000, num(p.maxMs, 900000)));
    const started = Date.now();
    let progress;
    try {
      progress = await readMediaProgress(title);
    } catch (err) {
      throw new Error(`Media hold could not read the player clock: ${err.message}`);
    }
    if (!(progress.duration > 0)) {
      throw new Error(`Media hold found a player but no positive duration (position ${progress.position}s, duration ${progress.duration}s).`);
    }
    const requestedMs = Math.max(0, (progress.duration - progress.position) * 1000) + bufferMs;
    if (requestedMs > maxMs) {
      throw new Error(
        `Media hold needs ${Math.round(requestedMs / 1000)}s for this ${Math.round(progress.duration)}s video, above maxMs=${maxMs}. Raise maxMs or pick a shorter media item.`
      );
    }
    let lastPosition = progress.position;
    let lastDuration = progress.duration;
    let lastAdvanceAt = Date.now();
    let lastFrameCheckAt = 0;
    let nextCheck = Date.now() + checkMs;
    let lastObserved = progress;
    while (true) {
      const run = ctx.run || {};
      if (run.cancelRequested) throw new Error('Media hold cancelled by operator.');
      if (run.skipRequested) {
        run.skipRequested = false;
        return { output: 'Media hold skipped by operator.', evidence: [], skipped: true };
      }
      if (run.pauseRequested || run.paused) {
        lastAdvanceAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (Date.now() < nextCheck) continue;
      nextCheck = Date.now() + checkMs;
      let current;
      try {
        current = await readMediaProgress(title);
      } catch (err) {
        throw new Error(`Media hold lost the player clock: ${err.message}`);
      }
      lastObserved = current;
      const ended =
        current.position >= current.duration - 1.5 ||
        (lastPosition > lastDuration * 0.7 && current.position < lastPosition - 3) ||
        Math.abs(current.duration - lastDuration) > 5;
      if (ended) {
        const evidence = [];
        try {
          const shot = await liveScreenshot(ctx.runId);
          evidence.push({ kind: 'screenshot', caption: `${caption} — media ended`, ...shot });
        } catch {}
        if (ctx.run) {
          ctx.run.media = {
            title: current.title,
            durationSec: current.duration,
            positionSec: current.position,
            source: current.source,
            endedNaturally: true,
            at: new Date().toISOString(),
          };
        }
        return {
          output: `Media reached its end after ${Math.round((Date.now() - started) / 1000)}s (${current.position.toFixed(1)}/${current.duration.toFixed(1)}s, ${current.source}).`,
          evidence,
        };
      }
      if (current.position > lastPosition + 0.2) {
        lastPosition = current.position;
        lastDuration = current.duration;
        lastAdvanceAt = Date.now();
      } else {
        const frozenMs = Date.now() - lastAdvanceAt;
        if (current.playing !== false && frozenMs > stallMs && Date.now() - lastFrameCheckAt >= stallMs) {
          lastFrameCheckAt = Date.now();
          try {
            const first = await liveScreenshot(ctx.runId);
            await new Promise((resolve) => setTimeout(resolve, 1400));
            const second = await liveScreenshot(ctx.runId);
            const same = fs.readFileSync(path.join(DATA, first.path)).equals(fs.readFileSync(path.join(DATA, second.path)));
            if (same) {
              const error = new Error(
                `Media paused at ${current.position.toFixed(1)}/${current.duration.toFixed(1)}s: two frames 1.4s apart are identical (${current.source}).`
              );
              error.evidence = [{ kind: 'screenshot', caption: `${caption} — paused`, ...second }];
              throw error;
            }
          } catch (err) {
            if (String(err.message).startsWith('Media paused')) throw err;
          }
        }
        const blockedMs = current.playing === false ? stallMs : adGraceMs;
        if (frozenMs <= blockedMs) {
          // A paused player fails on stallMs. A playing window with a frozen
          // clock is usually a mid-roll ad or buffering, so allow adGraceMs.
        } else {
        let evidence = [];
        try {
          const shot = await liveScreenshot(ctx.runId);
          evidence = [{ kind: 'screenshot', caption: `${caption} — stalled`, ...shot }];
        } catch {}
        const reason = current.playing === false ? 'paused' : current.ad ? 'ad playing' : 'stalled';
        const error = new Error(
          `Media ${reason} at ${current.position.toFixed(1)}/${current.duration.toFixed(1)}s for ${Math.round(blockedMs / 1000)}s (${current.source}).`
        );
        error.evidence = evidence;
        throw error;
        }
      }
      if (Date.now() - started > requestedMs + Math.max(stallMs, adGraceMs) + 30000) {
        throw new Error(
          `Media hold timed out at ${lastObserved.position.toFixed(1)}/${lastObserved.duration.toFixed(1)}s after ${Math.round((Date.now() - started) / 1000)}s.`
        );
      }
    }
  }

  if (!live) {
    return {
      output: `Simulated: ${describe(step)}.`,
      evidence: [],
    };
  }

  if (!IS_WINDOWS) {
    // Clicks, typing, keys, windows and apps run through the platform backend.
    return executePortableStep(step, ctx);
  }

  const foregroundExpectation =
    step.type === 'expect' && String(p.kind || '').toLowerCase() === 'foreground'
      ? String(p.value || '').trim()
      : '';
  if (live && step.type !== 'focusWindow') {
    const expected =
      foregroundExpectation ||
      (p.foreground === true
        ? String(p.window || p.title || p.expectedWindow || '').trim()
        : String(p.foreground || '').trim());
    if (expected) {
      try {
        await executeStep(
          {
            type: 'focusWindow',
            name: `Ensure ${expected} is foreground`,
            params: { title: expected, process: str(p.foregroundProcess) },
            timeoutMs: 10000,
          },
          ctx
        );
      } catch {
        // The foreground guard below reports the actionable mismatch.
      }
    }
  }

  // A window action that minimized or maximized a window must act on that same
  // window next time, even when another app shares its title or process name.
  const windowKey =
    step.type === 'windowAction' ? `${str(p.title, '')}|${str(p.process, '')}`.trim().toLowerCase() : '';
  if (windowKey && live) {
    const remembered = ctx.run?.windowHandles?.[windowKey];
    if (remembered?.handle) {
      step = { ...step, params: { ...p, handle: remembered.handle } };
      p = step.params;
    }
  }

  // Typing goes wherever the caret is, and a pane that was never clicked holds
  // no caret at all. Place it first, and say what happened either way.
  let caretLine = '';
  if (live && step.type === 'type') {
    caretLine = await placeCaretForTyping(step, ctx);
  }

  const script = buildScript(step);
  if (!script) throw new Error(`Unsupported step type: ${step.type}`);
  let timeout = step.timeoutMs || 15000;
  if (step.type === 'wait' || step.type === 'waitFor') {
    const requested = Number(step.type === 'wait' ? p.ms : p.timeoutMs) || 0;
    timeout = Math.max(timeout, Math.min(requested, 600000) + 5000);
  }
  const appContext = step.type === 'key' ? await readForegroundWindow() : null;
  let res = await runPowerShell(script, timeout);
  if (!res.ok && live && foregroundExpectation) {
    // Windows can hand focus to another app between a focus step and the next
    // assertion. Reclaim it and check once more before reporting a failure.
    try {
      await executeStep(
        {
          type: 'focusWindow',
          name: `Reclaim ${foregroundExpectation} before assertion`,
          params: { title: foregroundExpectation },
          timeoutMs: 10000,
        },
        ctx
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      res = await runPowerShell(script, timeout);
    } catch {
      // The original assertion error below is the actionable diagnosis.
    }
  }
  if (!res.ok) {
    const error = new Error(res.stderr || res.stdout || `${step.type} failed`);
    if (appContext) error.appContext = appContext;
    throw error;
  }
  if (windowKey && live) {
    const resolved = String(res.stdout || '').match(/hwnd=(-?\d+)/i);
    if (resolved && ctx.run) {
      if (!ctx.run.windowHandles) ctx.run.windowHandles = {};
      ctx.run.windowHandles[windowKey] = {
        handle: Number(resolved[1]),
        window: String(res.stdout || '').slice(0, 180),
        at: new Date().toISOString(),
      };
    }
  }
  if (live && step.type === 'windowAction') {
    const action = String(p.action || 'minimize').toLowerCase();
    if (action === 'restore' || action === 'maximize') {
      // Bringing the window back is only half the job; make sure it is in front so
      // the next step and the final check see the same window.
      try {
        await executeStep(
          {
            type: 'focusWindow',
            name: `Keep ${p.title || p.process || 'the window'} in front`,
            params: { ...(p.title ? { title: p.title } : {}), ...(p.process ? { process: p.process } : {}) },
            timeoutMs: 12000,
          },
          ctx
        );
      } catch {
        // The action already verified the window state; focus is best effort.
      }
    }
  }
  const focusContext = step.type === 'focusWindow' ? await readForegroundWindow() : null;
  return {
    output: [res.stdout || describe(step), caretLine].filter(Boolean).join(' | '),
    evidence: [],
    ...(appContext || focusContext ? { appContext: focusContext || appContext } : {}),
  };
}

export {
  writeSimulatedEvidence,
  liveScreenshot,
  describe,
  IS_WINDOWS,
};
