/**
 * Apps a workflow can target by window title or process name. Shared by run
 * recovery and planning so both resolve the same launch target.
 */
export const APP_LAUNCH_HINTS = [
  [/\bchrome(?:\.exe)?\b|google chrome/i, { target: 'chrome.exe', process: 'chrome', label: 'Chrome' }],
  [/\bmsedge(?:\.exe)?\b|microsoft edge/i, { target: 'msedge.exe', process: 'msedge', label: 'Edge' }],
  [/\bnotepad(?:\.exe)?\b/i, { target: 'notepad.exe', process: 'Notepad', label: 'Notepad' }],
  [/\bcalc(?:\.exe)?\b|calculator/i, { target: 'calc.exe', process: '', label: 'Calculator' }],
  [/\bexplorer(?:\.exe)?\b|file explorer/i, { target: 'explorer.exe', process: 'explorer', label: 'File Explorer' }],
  [/\bcode(?:\.exe)?\b|visual studio code/i, { target: 'code', process: 'Code', label: 'VS Code' }],
  [/\bwinword(?:\.exe)?\b|microsoft word/i, { target: 'winword.exe', process: 'WINWORD', label: 'Word' }],
  [/\bexcel(?:\.exe)?\b|microsoft excel/i, { target: 'excel.exe', process: 'EXCEL', label: 'Excel' }],
  [/\bmspaint(?:\.exe)?\b|microsoft paint|\bpaint\b/i, { target: 'mspaint.exe', process: 'mspaint', label: 'Paint' }],
  [/\bwt(?:\.exe)?\b|windows terminal/i, { target: 'wt.exe', process: 'WindowsTerminal', label: 'Windows Terminal' }],
  [/\bvlc(?:\.exe)?\b|videolan/i, { target: 'vlc.exe', process: 'vlc', title: 'VLC media player', label: 'VLC' }],
  [/\bkiro\b/i, { target: 'Kiro', process: 'Kiro', label: 'Kiro' }],
];

/** Step types that need their app window to exist before they can run. */
export const APP_WINDOW_STEPS = new Set([
  'focusWindow',
  'clickElement',
  'verifyScreen',
  'verifyPlayback',
  'playMedia',
  'mediaHold',
  'closeWindow',
  'type',
  'key',
  'click',
  'doubleClick',
  'rightClick',
  'drag',
  'scroll',
  'clipboard',
]);

function sameTarget(left, right) {
  const norm = (value) => String(value || '').trim().replace(/\.exe$/i, '').toLowerCase();
  return norm(left) !== '' && norm(left) === norm(right);
}

/** First step that needs an app window, with the launch target resolved for it. */
export function firstAppStep(steps) {
  for (let index = 0; index < (steps || []).length; index += 1) {
    const step = steps[index];
    if (!step || !APP_WINDOW_STEPS.has(step.type)) continue;
    const hint = resolveLaunchHint(step.params);
    if (hint) return { index, hint };
  }
  return null;
}

/** True when the plan already opens that app before the given step. */
export function opensTargetBefore(steps, index, hint) {
  return (steps || []).slice(0, index).some(
    (step) =>
      (step?.type === 'launchApp' && sameTarget(step.params?.target, hint.target)) ||
      (step?.type === 'openUrl' && /chrome|msedge|edge|browser/i.test(`${hint.process} ${hint.label}`))
  );
}

/** The launch-and-settle pair both planning and run repair insert. */
export function launchAndWaitSteps(hint) {
  return [
    { type: 'launchApp', name: `Open ${hint.label}`, params: { target: hint.target }, timeoutMs: 30000 },
    { type: 'wait', name: `Wait for ${hint.label}`, params: { ms: 2000 }, timeoutMs: 5000 },
  ];
}

/** Resolve a step's window/process parameters to a launch target, if known. */
export function resolveLaunchHint(params = {}) {
  const known = matchAppHint([
    params.process,
    params.title,
    params.windowName,
    params.windowTitle,
    params.window,
    params.foreground,
    params.app,
  ]);
  if (known) return known;
  const processName = String(params.process || '').trim();
  if (!processName) return null;
  const base = processName.replace(/\.exe$/i, '');
  return { target: /\.exe$/i.test(processName) ? processName : `${base}.exe`, process: base, label: base };
}

/** First known app whose pattern matches one of the supplied values. */
export function matchAppHint(values) {
  const candidates = (values || []).map((value) => String(value || '').trim()).filter(Boolean);
  if (!candidates.length) return null;
  const known = APP_LAUNCH_HINTS.find(([pattern]) => candidates.some((value) => pattern.test(value)));
  return known ? known[1] : null;
}
