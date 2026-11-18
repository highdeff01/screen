/**
 * Install knowledge for Windows apps.
 *
 * A workflow step, the deterministic repair policy and the AI planner all need
 * to agree on how an app is installed and how that install is proven. This
 * module is that single source: catalogue entries with the winget id, the
 * official pages to search for an installer, the silent-switch defaults, the
 * executable and uninstall names to verify against, plus the safety review that
 * refuses a risky source or installer argument before anything runs.
 *
 * Pure helpers plus one bounded network call (`discoverInstallerUrls`), so the
 * whole policy can be tested without touching a desktop.
 */

const SAFE_ARG_TOKENS = new Set([
  '/s',
  '/silent',
  '/quiet',
  '/verysilent',
  '/suppressmsgboxes',
  '/qn',
  '/qb',
  '/passive',
  '/norestart',
  '/i',
  '/install',
  '/mergetasks=!desktopicon',
  '--silent',
  '--quiet',
  '--verysilent',
  '--norestart',
  '-s',
  '-q',
  '-quiet',
  '-silent',
]);

const UNSAFE_ARG_TOKENS = /[;&|<>`$]|invoke-|powershell|cmd(?:\.exe)?\s+\/c|-enc(?:odedcommand)?|start-process|reg\s+delete|format\s/i;
const UNSAFE_URL = /\b(?:bit\.ly|tinyurl|adf\.ly|shorte\.st)\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i;

/** Install knowledge for the apps the console is asked about most often. */
export const INSTALL_CATALOG = [
  {
    name: 'VLC',
    match: /\bvlc\b|videolan/i,
    wingetId: 'VideoLAN.VLC',
    process: 'vlc',
    exe: [
      'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    ],
    displayNames: ['VLC media player', 'VLC'],
    silentArgs: '/L=1033 /S',
    pages: ['https://www.videolan.org/vlc/download-windows.html'],
    knownHosts: ['videolan.org', 'get.videolan.org', 'mirrors.videolan.org'],
    uninstall: 'winget uninstall --id VideoLAN.VLC --exact',
  },
  {
    name: '7-Zip',
    match: /\b7\s*-?\s*zip\b/i,
    wingetId: '7zip.7zip',
    process: '7zFM',
    exe: ['C:\\Program Files\\7-Zip\\7zFM.exe', 'C:\\Program Files (x86)\\7-Zip\\7zFM.exe'],
    displayNames: ['7-Zip'],
    silentArgs: '/S',
    pages: ['https://www.7-zip.org/download.html'],
    knownHosts: ['7-zip.org', 'www.7-zip.org'],
    uninstall: 'winget uninstall --id 7zip.7zip --exact',
  },
  {
    name: 'Notepad++',
    match: /notepad\s*\+\+|notepadplusplus/i,
    wingetId: 'Notepad++.Notepad++',
    process: 'notepad++',
    exe: ['C:\\Program Files\\Notepad++\\notepad++.exe', 'C:\\Program Files (x86)\\Notepad++\\notepad++.exe'],
    displayNames: ['Notepad++'],
    silentArgs: '/S',
    pages: ['https://notepad-plus-plus.org/downloads/'],
    knownHosts: ['notepad-plus-plus.org', 'github.com', 'objects.githubusercontent.com'],
    uninstall: 'winget uninstall --id Notepad++.Notepad++ --exact',
  },
  {
    name: 'Google Chrome',
    match: /google\s+chrome|\bchrome\b/i,
    wingetId: 'Google.Chrome',
    process: 'chrome',
    exe: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    displayNames: ['Google Chrome'],
    silentArgs: '/silent /install',
    pages: ['https://www.google.com/chrome/'],
    knownHosts: ['google.com', 'dl.google.com', 'www.google.com'],
    uninstall: 'winget uninstall --id Google.Chrome --exact',
  },
  {
    name: 'Firefox',
    match: /\bfirefox\b|mozilla/i,
    wingetId: 'Mozilla.Firefox',
    process: 'firefox',
    exe: ['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'],
    displayNames: ['Mozilla Firefox', 'Firefox'],
    silentArgs: '-ms',
    pages: ['https://www.mozilla.org/firefox/new/'],
    knownHosts: ['mozilla.org', 'www.mozilla.org', 'download.mozilla.org'],
    uninstall: 'winget uninstall --id Mozilla.Firefox --exact',
  },
  {
    name: 'Visual Studio Code',
    match: /visual\s+studio\s+code|\bvs\s*code\b|\bvscode\b/i,
    wingetId: 'Microsoft.VisualStudioCode',
    process: 'Code',
    exe: [
      'C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    ],
    displayNames: ['Microsoft Visual Studio Code', 'Visual Studio Code'],
    silentArgs: '/VERYSILENT /NORESTART /MERGETASKS=!runcode',
    pages: ['https://code.visualstudio.com/download'],
    knownHosts: ['code.visualstudio.com', 'code.visualstudio.com', 'vscode.download.prss.microsoft.com'],
    uninstall: 'winget uninstall --id Microsoft.VisualStudioCode --exact',
  },
  {
    name: 'FFmpeg',
    match: /\bffmpeg\b/i,
    wingetId: 'Gyan.FFmpeg',
    process: 'ffmpeg',
    exe: [
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-*\\bin\\ffmpeg.exe',
    ],
    displayNames: ['FFmpeg'],
    silentArgs: '',
    pages: [],
    knownHosts: [],
    uninstall: 'winget uninstall --id Gyan.FFmpeg --exact',
  },
  {
    name: 'GIMP',
    match: /\bgimp\b/i,
    wingetId: 'GIMP.GIMP',
    process: 'gimp',
    exe: ['C:\\Program Files\\GIMP 3\\bin\\gimp-3.0.exe', 'C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe'],
    displayNames: ['GIMP'],
    silentArgs: '/VERYSILENT /NORESTART',
    pages: ['https://www.gimp.org/downloads/'],
    knownHosts: ['gimp.org', 'www.gimp.org', 'download.gimp.org'],
    uninstall: 'winget uninstall --id GIMP.GIMP --exact',
  },
  {
    name: 'Audacity',
    match: /\baudacity\b/i,
    wingetId: 'Audacity.Audacity',
    process: 'audacity',
    exe: ['C:\\Program Files\\Audacity\\audacity.exe'],
    displayNames: ['Audacity'],
    silentArgs: '/VERYSILENT /NORESTART',
    pages: ['https://www.audacityteam.org/download/windows/'],
    knownHosts: ['audacityteam.org', 'www.audacityteam.org', 'fosshub.com', 'www.fosshub.com'],
    uninstall: 'winget uninstall --id Audacity.Audacity --exact',
  },
];

const psQuote = (value) => `'${String(value ?? '').replace(/'/g, "''")}'`;

/** First catalogue entry whose pattern matches any of the supplied values. */
export function catalogEntry(values) {
  const list = Array.isArray(values) ? values : [values];
  const text = list.map((value) => String(value || '')).filter(Boolean).join(' ');
  if (!text.trim()) return null;
  return INSTALL_CATALOG.find((entry) => entry.match.test(text)) || null;
}

/** True when the app is one whose executable path and uninstall name we know. */
export function catalogEntryFor(params = {}) {
  return catalogEntry([params.app, params.name, params.id, params.packageId, params.title, params.goal]);
}

function tokenList(args) {
  return String(args || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Decide whether an installer source and its switches are safe to run
 * unattended. Unknown hosts and non-allowlisted switches are refused unless the
 * operator explicitly opted in, so a model or a note can never quietly turn a
 * repair into an arbitrary download.
 */
export function reviewInstaller({ url = '', args = '', kind = 'direct', entry = null, allowUnknownSource = false } = {}) {
  const cleanUrl = String(url || '').trim();
  if (kind === 'direct') {
    if (!/^https:\/\//i.test(cleanUrl)) {
      return { safe: false, reason: 'Installer downloads must use https.' };
    }
    if (!/\.(?:exe|msi)(?:[?#].*)?$/i.test(cleanUrl)) {
      return { safe: false, reason: 'Direct installs must point at a .exe or .msi file.' };
    }
    if (UNSAFE_URL.test(cleanUrl)) {
      return { safe: false, reason: 'Link shorteners and raw IP addresses are not trusted installer sources.' };
    }
    const host = (() => {
      try {
        return new URL(cleanUrl).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const hosts = new Set(
      [...(entry?.knownHosts || []), ...INSTALL_CATALOG.flatMap((item) => item.knownHosts || [])].map((name) =>
        String(name).toLowerCase()
      )
    );
    const trusted = [...hosts].some((name) => host === name || host.endsWith(`.${name}`));
    if (!trusted && !allowUnknownSource) {
      return {
        safe: false,
        reason: `Refusing an unknown installer host (${host || 'no host'}); pass allowUnknownSource to override after checking it.`,
      };
    }
  }
  const text = String(args || '');
  if (UNSAFE_ARG_TOKENS.test(text)) {
    return { safe: false, reason: `Installer arguments contain a shell or system command: ${text.slice(0, 120)}` };
  }
  if (text.trim()) {
    const unsafe = tokenList(text).filter((token) => {
      const lower = token.toLowerCase();
      if (SAFE_ARG_TOKENS.has(lower)) return false;
      // Value switches such as /L=1033, /D=path, /SP- and --log=... are fine.
      if (/^\/[a-z]=[^\s]+$/i.test(token)) return false;
      if (/^--[a-z-]+=[^\s]+$/i.test(token)) return false;
      if (/^\/sp-$/i.test(token)) return false;
      return true;
    });
    if (unsafe.length) {
      return { safe: false, reason: `Installer arguments are not in the silent allowlist: ${unsafe.join(' ')}` };
    }
  }
  return { safe: true, reason: '' };
}

/** Silent switches that match the file and the catalogue entry. */
export function silentArgsFor(url, entry = null, override = '') {
  if (String(override || '').trim()) return String(override).trim();
  if (/\.msi(?:[?#].*)?$/i.test(String(url || ''))) return '/qn /norestart';
  if (entry?.silentArgs) return entry.silentArgs;
  return '/S';
}

/**
 * Ordered methods for one install step: winget first when a package id is
 * known, then an explicit URL, then URLs discovered from the official pages.
 */
export function installMethodsFor(params = {}, { entry = null, discovered = [] } = {}) {
  const methods = [];
  const id = String(params.id || params.packageId || entry?.wingetId || '').trim();
  if (id) {
    methods.push({
      kind: 'winget',
      id,
      label: `winget install ${id}`,
      source: String(params.source || '').trim(),
      version: String(params.version || '').trim(),
      scope: ['user', 'machine'].includes(String(params.scope || '').toLowerCase()) ? String(params.scope).toLowerCase() : '',
      silent: params.silent !== false,
      force: Boolean(params.force),
    });
  }
  const urls = [];
  const push = (value) => {
    const url = String(value || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (urls.includes(url)) return;
    urls.push(url);
  };
  push(params.url);
  for (const url of params.urls || []) push(url);
  for (const url of discovered || []) push(url);
  for (const url of entry?.urls || []) push(url);
  for (const url of urls) {
    const args = silentArgsFor(url, entry, params.installerArgs);
    const review = reviewInstaller({
      url,
      args,
      kind: 'direct',
      entry,
      allowUnknownSource: Boolean(params.allowUnknownSource),
    });
    methods.push({
      kind: 'direct',
      url,
      args,
      label: `install ${url.split('/').pop() || url}`,
      safe: review.safe,
      reason: review.reason,
    });
  }
  return methods;
}

/** Official .exe/.msi links found on a page, most useful first. */
export function extractInstallerLinks(html, baseUrl = '') {
  const text = String(html || '');
  const found = [];
  const push = (href) => {
    let url = String(href || '').trim();
    if (!url || /^(?:#|javascript:|mailto:)/i.test(url)) return;
    try {
      url = new URL(url, baseUrl || undefined).toString();
    } catch {
      return;
    }
    if (!/^https:\/\//i.test(url)) return;
    if (!/\.(?:exe|msi)(?:[?#].*)?$/i.test(url)) return;
    if (found.includes(url)) return;
    found.push(url);
  };
  for (const match of text.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) push(match[1]);
  if (!found.length) {
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+\.(?:exe|msi)/gi)) push(match[0]);
  }
  const score = (url) => {
    const lower = url.toLowerCase();
    let value = 0;
    if (/win64|x64|64-bit|amd64/.test(lower)) value += 6;
    if (/setup|installer|install/.test(lower)) value += 4;
    if (/win32|x86|32-bit/.test(lower)) value -= 3;
    if (/arm64/.test(lower)) value -= 2;
    if (/portable|\.zip/.test(lower)) value -= 2;
    if (/update|patch|beta|nightly|debug|symbols/.test(lower)) value -= 3;
    return value;
  };
  return found.sort((a, b) => score(b) - score(a)).slice(0, 6);
}

/**
 * Search the official pages for a real installer link. Bounded: a few pages,
 * short timeout, failures ignored so the remaining methods still run.
 */
export async function discoverInstallerUrls(entry, { fetchImpl = null, timeoutMs = 12000, limit = 4 } = {}) {
  const pages = (entry?.pages || []).filter(Boolean).slice(0, 3);
  if (!pages.length) return [];
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return [];
  const urls = [];
  for (const page of pages) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(2000, Number(timeoutMs) || 12000));
      const res = await doFetch(page, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Sightline/1.0 (installer discovery)' },
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (!res?.ok) continue;
      const html = await res.text();
      for (const url of extractInstallerLinks(html, page)) {
        if (!urls.includes(url)) urls.push(url);
      }
    } catch {
      // A missing page only removes one method; the rest of the chain remains.
    }
    if (urls.length >= limit) break;
  }
  return urls.slice(0, limit);
}

/** Verification rules for an app: paths, uninstall names and a process name. */
export function verificationChecksFor(entry, params = {}) {
  return {
    exe: [
      ...(Array.isArray(params.verify?.exe) ? params.verify.exe : params.verify?.exe ? [params.verify.exe] : []),
      ...(params.exe ? [String(params.exe)] : []),
      ...((entry?.exe || []).map((value) => value.replace('%USERNAME%', '%USERNAME%'))),
    ].filter(Boolean),
    displayNames: [
      ...(Array.isArray(params.verify?.displayNames) ? params.verify.displayNames : []),
      ...(params.displayName ? [String(params.displayName)] : []),
      ...(entry?.displayNames || []),
    ].filter(Boolean),
    process: String(params.verify?.process || params.process || entry?.process || '').trim(),
  };
}

/**
 * PowerShell that proves an install from the filesystem, the uninstall
 * registry and a running process, and reports a rollback command.
 */
export function verificationScript(checks = {}, params = {}) {
  const exe = (checks.exe || []).filter(Boolean);
  const names = (checks.displayNames || []).filter(Boolean);
  const process = String(checks.process || '').trim();
  const uninstallHint = String(params.uninstallCommand || '').trim();
  return `$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{ ok = $false; exe = ''; version = ''; displayName = ''; installLocation = ''; uninstall = '' }
$paths = @(${exe.map((value) => psQuote(value)).join(', ')})
foreach ($p in $paths) {
  if (-not $p) { continue }
  $expanded = [Environment]::ExpandEnvironmentVariables($p)
  $hit = Get-Item -Path $expanded -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $result.exe = [string]$hit.FullName; break }
}
$names = @(${names.map((value) => psQuote(value)).join(', ')})
if (-not $result.exe -or -not $result.displayName) {
  $roots = @(
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  )
  foreach ($root in $roots) {
    $entries = Get-ItemProperty $root -ErrorAction SilentlyContinue
    foreach ($entry in $entries) {
      $display = [string]$entry.DisplayName
      if (-not $display) { continue }
      $matched = $false
      foreach ($name in $names) { if ($name -and $display -like ('*' + $name + '*')) { $matched = $true; break } }
      if (-not $matched) { continue }
      $result.displayName = $display
      $result.installLocation = [string]$entry.InstallLocation
      $result.uninstall = [string]$entry.UninstallString
      if (-not $result.version) { $result.version = [string]$entry.DisplayVersion }
      break
    }
    if ($result.displayName) { break }
  }
}
${process ? `if (-not $result.exe) {
  $proc = Get-Process -Name ${psQuote(process)} -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($proc) { try { $result.exe = [string]$proc.Path } catch { } }
}` : ''}
if ($result.exe) {
  try { $fileVersion = (Get-Item -LiteralPath $result.exe).VersionInfo.FileVersion; if ($fileVersion) { $result.version = [string]$fileVersion } } catch { }
}
$result.ok = [bool]($result.exe -or $result.displayName)
if (-not $result.uninstall -and $result.ok) { $result.uninstall = ${psQuote(uninstallHint)} }
$result | ConvertTo-Json -Compress`;
}

/** Parse the JSON line printed by `verificationScript`. */
export function parseVerification(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      return {
        ok: Boolean(parsed.ok),
        exe: String(parsed.exe || ''),
        version: String(parsed.version || ''),
        displayName: String(parsed.displayName || ''),
        installLocation: String(parsed.installLocation || ''),
        uninstall: String(parsed.uninstall || ''),
      };
    } catch {
      // Try the next candidate line.
    }
  }
  return { ok: false, exe: '', version: '', displayName: '', installLocation: '', uninstall: '' };
}

/** One-line summary of every install method that was attempted. */
const SETUP_WINDOW = /\b(?:setup|installer|installing|installation|uninstall(?:er|ing)?|downloading|downloads?|wizard|extracting|updater?)\b/i;
const BROWSER_PROCESSES = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'iexplore']);
const APP_HEALTH_FAILURE =
  /not responding|stopped working|has crashed|\bcrash(?:ed|ing)?\b|failed to (?:start|launch|open)|could not (?:start|launch|open)|(?:app|application|program|window)[^.]{0,40}(?:is )?(?:broken|failing)|no [^.]{0,60}window appeared|does(?:n'?t| not) start|won'?t (?:start|open|launch)/i;
const REPAIR_REQUEST =
  /\b(?:reinstall|re-install|repair install|install (?:it|the app) again|keeps? (?:crashing|failing|freezing)|not working|broken|won'?t (?:open|start|launch)|does(?:n'?t| not) (?:open|start|launch))\b/i;

/** A setup, installer, updater or download window is not the installed app. */
export function windowLooksLikeSetup(title = '') {
  const text = String(title || '').trim();
  return Boolean(text) && SETUP_WINDOW.test(text);
}

/**
 * True when a foreground window can belong to the installed app. A setup
 * wizard or a browser page that merely mentions the app cannot, so it must
 * never satisfy "the app is already open" or be adopted as the target.
 */
export function isInstalledAppWindow({ title = '', process = '', entry = null } = {}) {
  const text = String(title || '').trim();
  if (!text || windowLooksLikeSetup(text)) return false;
  const proc = String(process || '').trim().toLowerCase();
  if (entry?.process && proc) {
    const wanted = String(entry.process).trim().toLowerCase();
    // Browsers and shells can carry the app's name in their title; they are
    // not the app itself. Other processes (a packaged app frame) still count.
    if (proc !== wanted && BROWSER_PROCESSES.has(proc)) return false;
  }
  return true;
}

/**
 * Decide whether an installed app needs a reinstall or is healthy enough to
 * skip. Install history is the evidence: a program the user asks to reinstall,
 * or one whose recent runs show failed launches, crashes or "not responding",
 * is repaired even though the uninstall entry and executable still exist.
 */
export function installHealth({ entry = null, app = '', goal = '', runs = [], currentRun = null } = {}) {
  const label = String(app || entry?.name || '').trim();
  const goalText = String(goal || '').trim();
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = entry?.match || (label ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i') : null);
  const mentions = (text) => Boolean(matcher && matcher.test(String(text || '')));
  const requested = REPAIR_REQUEST.test(goalText);
  const signals = [];
  const stepTarget = (step) => {
    const params = step?.params || {};
    return [
      params.target,
      params.app,
      params.title,
      params.window,
      params.windowName,
      params.process,
      params.value,
      params.question,
      params.caption,
      params.name,
    ]
      .filter(Boolean)
      .join(' ');
  };
  const recent = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.id !== currentRun?.id && !run.dryRun)
    .sort((a, b) => new Date(b.endedAt || b.startedAt || 0) - new Date(a.endedAt || a.startedAt || 0))
    .slice(0, 24);
  for (const run of recent) {
    const runText = [run.workflowGoal, run.workflowName, run.goal].filter(Boolean).join(' ');
    const steps = Array.isArray(run.steps) ? run.steps : [];
    const touches = mentions(runText) || steps.some((step) => mentions(stepTarget(step)));
    if (!touches) continue;
    const runSignals = [];
    for (const step of steps) {
      if (!['failed', 'needs_review'].includes(String(step?.status || ''))) continue;
      if (!['launchApp', 'focusWindow', 'testApp', 'verifyScreen', 'waitFor', 'expect'].includes(step.type)) continue;
      // The failed step must be about this app. A failed Chrome launch inside a
      // run whose goal mentions VLC says nothing about the VLC install.
      if (!mentions(stepTarget(step))) continue;
      const detail = `${step.error || ''} ${step.output || ''}`.replace(/\s+/g, ' ').trim();
      const broken =
        APP_HEALTH_FAILURE.test(detail) ||
        (['launchApp', 'focusWindow', 'testApp'].includes(step.type) && run.errorCategory === 'window_not_found');
      if (!broken) continue;
      runSignals.push({
        kind: step.type,
        runId: run.id,
        at: run.endedAt || run.startedAt || '',
        detail: `${step.type} failed in ${run.id}: ${detail.slice(0, 180) || 'no detail'}`,
      });
    }
    if (runSignals.length) {
      signals.push(...runSignals);
      if (signals.length >= 3) break;
      continue;
    }
    // A newer run where the app launched (or its window was focused/tested)
    // proves the install works; failures older than that are already repaired
    // and must not cause another reinstall.
    const worked = steps.some(
      (step) =>
        step.status === 'passed' &&
        ['launchApp', 'focusWindow', 'testApp'].includes(step.type) &&
        mentions(stepTarget(step))
    );
    if (worked) break;
  }
  const needsRepair = requested || signals.length > 0;
  return {
    app: label,
    requested,
    needsRepair,
    plan: needsRepair ? 'reinstall' : 'skip',
    reason: requested
      ? `the request asks to reinstall or repair ${label || 'the app'}`
      : signals[0]?.detail || '',
    signals,
  };
}

/** One-line summary of every install method that was attempted. */
export function installAttemptSummary(attempts = []) {
  return (attempts || [])
    .map((attempt) => `${attempt.method}: ${attempt.ok ? 'ok' : 'failed'}${attempt.reason ? ` (${attempt.reason})` : ''}`)
    .join('; ');
}

/** Markdown body for the run note, including how to undo the install. */
export function installNoteBody({ app = '', method = '', verification = null, attempts = [], downloaded = '' } = {}) {
  const lines = [`Installed: ${app || 'app'}`];
  if (method) lines.push(`Method: ${method}`);
  if (verification?.displayName || verification?.version) {
    lines.push(`Version: ${verification?.version || 'unknown'}${verification?.displayName ? ` (${verification.displayName})` : ''}`);
  }
  if (verification?.exe) lines.push(`Executable: ${verification.exe}`);
  if (downloaded) lines.push(`Installer kept at: ${downloaded}`);
  if (attempts.length) lines.push('', 'Attempts:', ...attempts.map((attempt) => `- ${attempt.method}: ${attempt.ok ? 'ok' : 'failed'}${attempt.reason ? ` — ${attempt.reason}` : ''}`));
  if (verification?.uninstall) lines.push('', `Rollback: ${verification.uninstall}`);
  else if (method) lines.push('', 'Rollback: use Settings → Apps → Installed apps, or `winget uninstall` for this package.');
  return lines.join('\n');
}
