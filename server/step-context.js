/**
 * Pre-step context: what is already on screen, and what the next action should
 * become because of it.
 *
 * The usual failure of a step runner is that it starts a flow from the top even
 * when the desktop is already halfway through it: a Save dialog is open, the
 * installer is waiting for Next, the app window already exists. This module
 * reads one screen snapshot (foreground plus visible windows) and decides
 * whether the planned step is already satisfied, needs to be retargeted at the
 * window that is actually in front, or should run unchanged.
 *
 * It also reviews the previous step's expectation, describes the elements
 * around a click target so pointer movement is deliberate rather than a jump,
 * and turns the vision model's preview of a screenshot into a small, bounded
 * adjustment. Pure functions: no desktop, no model, no I/O.
 */

const DIALOG_CLASS = /^#32770$/;
const DIALOG_TITLE =
  /\b(?:save as|save file|open file|open|browse|confirm|are you sure|warning|install|setup|next|finish|properties|options|preferences|print|select|download|extract|license|agreement|sign in|log in|sign-in)\b/i;
const ADVERT = /\b(?:ad|ads|advert|sponsored|promo|promotion|banner|popup|survey|cookie|subscribe|newsletter|upgrade)\b/i;

const AFFORDANCES = [
  { match: /\bsave as\b|\bsave file\b|\bsave\b/i, kind: 'save', actions: ['Save', 'Cancel'], hint: 'type the file name/path into the open Save dialog' },
  { match: /\bopen file\b|\bopen\b|\bbrowse\b/i, kind: 'open', actions: ['Open', 'Cancel'], hint: 'pick the path in the open dialog' },
  { match: /\binstall|\bsetup\b|\bextract\b|\blicense\b|\bagreement\b/i, kind: 'installer', actions: ['Next', 'Install', 'I Agree', 'Finish', 'Close'], hint: 'continue the installer that is already running' },
  { match: /\bconfirm|\bare you sure\b|\bwarning\b/i, kind: 'confirm', actions: ['Yes', 'OK', 'Cancel'], hint: 'answer the confirmation dialog' },
  { match: /\bproperties\b|\boptions\b|\bpreferences\b/i, kind: 'settings', actions: ['OK', 'Apply', 'Cancel'], hint: 'change the setting in the open dialog' },
  { match: /\bprint\b/i, kind: 'print', actions: ['Print', 'Cancel'], hint: 'finish the print dialog' },
];

const clip = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** Describe a window: which app it belongs to, whether it is a dialog, what it asks for. */
export function classifyWindow(window = {}) {
  const title = String(window.title || '').trim();
  const processName = String(window.process || '').trim();
  const className = String(window.className || window.class || '').trim();
  const dialog = DIALOG_CLASS.test(className) || (DIALOG_TITLE.test(title) && !/\s-\s/.test(title));
  const affordance = AFFORDANCES.find((entry) => entry.match.test(title)) || null;
  return {
    title,
    process: processName,
    className,
    dialog,
    kind: affordance?.kind || (dialog ? 'dialog' : processName ? 'app' : 'unknown'),
    actions: affordance?.actions || [],
    hint: affordance?.hint || '',
    advert: ADVERT.test(title),
  };
}

/** True when the foreground is a dialog belonging to the app the step names. */
function sameAppDialog(screen = null, guard = '') {
  const fg = classifyWindow(screen?.foreground || {});
  if (!fg.dialog) return false;
  const leaf = String(guard || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .trim();
  if (!leaf) return false;
  const windows = [screen?.app, ...(screen?.windows || [])].filter(Boolean);
  return windows.some((entry) => {
    const processName = String(entry.process || '').toLowerCase().replace(/\.exe$/i, '');
    const title = String(entry.title || '').toLowerCase();
    return (processName && processName.includes(leaf)) || title.includes(leaf);
  });
}

function sameAppProcess(window, guard = '') {
  const leaf = String(guard || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .trim();
  if (!leaf) return false;
  return String(window?.process || '')
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .includes(leaf);
}

function matchesTarget(window, target = '') {
  const value = String(target || '').trim().toLowerCase();
  if (!value) return false;
  const leaf = value.replace(/\.exe$/i, '');
  return (
    String(window.title || '').toLowerCase().includes(value) ||
    String(window.process || '').toLowerCase() === leaf ||
    String(window.title || '').toLowerCase().includes(leaf)
  );
}

/** The state a successful step should leave behind, in one sentence. */
export function expectationFor(step = {}) {
  const p = step.params || {};
  switch (step.type) {
    case 'launchApp':
      return `${p.target || 'the app'} has a window in front`;
    case 'openUrl':
      return `${p.url || 'the page'} is loaded in a browser`;
    case 'clickElement':
      return `“${p.name || 'the control'}” was clicked and the next state appeared`;
    case 'type':
      return 'the text appears in the intended field';
    case 'key':
      return `${Array.isArray(p.keys) ? p.keys.join('+') : p.keys || 'the shortcut'} reached the intended window`;
    case 'installApp':
      return `${p.app || p.id || 'the app'} is installed and verifiable`;
    case 'waitFor':
    case 'expect':
      return `${p.kind || 'window'} “${p.value || ''}” is ${p.mode || 'present'}`;
    case 'verifyScreen':
      return 'the screen matches the described state';
    default:
      return 'the step produced its effect';
  }
}

/**
 * Decide what this step should do given what is already on screen.
 *
 * `screen` is `{ foreground: {title, process, className}, windows?: [...] }`.
 */
export function assessStep({ step = {}, screen = null, goal = '', history = [] } = {}) {
  const p = step.params || {};
  const foreground = screen?.foreground || {};
  const fg = classifyWindow(foreground);
  const dialogs = (screen?.windows || []).map((entry) => classifyWindow(entry)).filter((entry) => entry.dialog);
  const target = String(p.target || p.title || p.window || p.app || '').trim();
  const guard = String(p.foreground || p.window || p.title || '').trim();
  const result = {
    stepType: step.type || '',
    state: { title: fg.title, process: fg.process, dialog: fg.dialog, kind: fg.kind, dialogs: dialogs.map((entry) => entry.title) },
    alreadySatisfied: false,
    skipReason: '',
    inProgress: false,
    adjustments: {},
    focus: '',
    note: '',
    expectation: expectationFor(step),
    risk: '',
  };
  if (!screen || (!fg.title && !dialogs.length)) return result;
  const prior = (history || []).slice(-3).map((entry) => `${entry.name || entry.type} (${entry.status || ''})`).join(' → ');
  // A dialog from the app named by the step is "already in progress" even when
  // it is behind another window; retargeting also brings it back to the front.
  const guardText = String(p.foreground || p.window || p.title || p.target || p.app || '').trim();
  const appName = String(p.app || p.name || p.target || '').trim();
  // The guard often names a document window (“Untitled - Notepad”), so match the
  // dialog through that window's process rather than the literal title.
  const guardWindow = (screen?.windows || []).find(
    (entry) => guardText && String(entry?.title || '').toLowerCase().includes(guardText.toLowerCase())
  );
  const guardProcess = String(guardWindow?.process || '').trim();
  const relatedDialog =
    fg.dialog
      ? fg
      : dialogs.find(
          (entry) =>
            (guardText && (matchesTarget(entry, guardText) || sameAppProcess(entry, guardText))) ||
            (guardProcess && sameAppProcess(entry, guardProcess)) ||
            (appName && matchesTarget(entry, appName)) ||
            (screen?.app && entry.process && screen.app.process === entry.process)
        ) || null;

  if (step.type === 'launchApp' && !fg.title) return result;

  if (step.type === 'launchApp') {
    const wantsArgs = Array.isArray(p.args) && p.args.length > 0;
    if (!wantsArgs && target && matchesTarget(fg, target)) {
      result.alreadySatisfied = true;
      result.skipReason = `Already open in front${fg.dialog ? ` with the “${clip(fg.title, 50)}” dialog in progress` : ''}; the launch was skipped.`;
      result.inProgress = fg.dialog;
    } else if (!wantsArgs && fg.dialog && target && matchesTarget({ title: screen?.app?.title || '', process: screen?.app?.process || '' }, target)) {
      result.alreadySatisfied = true;
      result.skipReason = `The app is already running with “${clip(fg.title, 50)}” open; continue that dialog instead of launching again.`;
      result.inProgress = true;
    }
    return result;
  }

  if (step.type === 'focusWindow') {
    if (guard && fg.title && fg.title.toLowerCase().includes(guard.toLowerCase())) {
      result.alreadySatisfied = true;
      result.skipReason = 'Already focused; no action was needed.';
    } else if (guard && fg.dialog && (fg.title.toLowerCase().includes(guard.toLowerCase()) || matchesTarget(fg, target) || sameAppDialog(screen, guard))) {
      result.alreadySatisfied = true;
      result.inProgress = true;
      result.skipReason = `Already focused on “${clip(fg.title, 50)}”, a dialog of the same app.`;
    }
    return result;
  }

  if (step.type === 'openUrl') {
    const url = String(p.url || '').trim();
    const browser = /chrome|msedge|firefox|brave|opera|vivaldi/i.test(`${fg.process} ${fg.title}`);
    if (url && browser) {
      let tokens = [];
      try {
        const parsed = new URL(url);
        tokens = parsed.pathname.split(/[^a-z0-9]+/i).filter((token) => token.length > 3);
      } catch {
        tokens = [];
      }
      const haystack = fg.title.toLowerCase();
      const matched = tokens.filter((token) => haystack.includes(token.toLowerCase()));
      const isBlank = /^new tab$|^about:blank$|^start\s*page$/i.test(fg.title);
      if (!isBlank && matched.length >= Math.min(2, tokens.length) && tokens.length) {
        result.alreadySatisfied = true;
        result.skipReason = `The browser already shows “${clip(fg.title, 60)}” for this URL; no second tab was opened.`;
      }
    }
    return result;
  }

  if (['clickElement', 'click', 'doubleClick', 'rightClick'].includes(step.type)) {
    const wanted = String(p.name || '').trim().toLowerCase();
    const dialog = relatedDialog;
    const available = dialog && wanted ? dialog.actions.find((action) => action.toLowerCase().includes(wanted)) : '';
    if (available) {
      // The control the step wants is already on the open dialog: use it there.
      result.inProgress = true;
      result.note = `The “${clip(dialog.title, 40)}” dialog is already open and shows “${available}”; use it instead of reopening the menu.`;
      if (!dialog.title.toLowerCase().includes(String(guard).toLowerCase()) && dialog.title !== fg.title) {
        result.adjustments = { window: dialog.title, ...(step.type === 'clickElement' ? { title: dialog.title } : { foreground: dialog.title }) };
        result.focus = dialog.title;
      }
    } else if (
      guard &&
      dialog &&
      !dialog.title.toLowerCase().includes(guard.toLowerCase()) &&
      (matchesTarget(dialog, guard) || sameAppProcess(dialog, guard) || sameAppDialog(screen, guard))
    ) {
      result.inProgress = true;
      result.adjustments = { window: dialog.title, ...(step.type === 'clickElement' ? { title: dialog.title } : { foreground: dialog.title }) };
      if (dialog.title !== fg.title) result.focus = dialog.title;
      result.note = `The step targets “${clip(guard, 40)}”, but “${clip(dialog.title, 50)}” is the open dialog for that app; the click is being aimed there instead.`;
      result.risk = 'The planned menu/control may not exist while the dialog is open; prefer the dialog’s own action.';
    } else if (dialog && dialog.actions.length) {
      result.inProgress = true;
      result.note = `The “${clip(dialog.title, 40)}” dialog is already open; expected actions: ${dialog.actions.join(', ')}.`;
      if (!fg.dialog) result.focus = dialog.title;
    }
    return result;
  }

  if (step.type === 'type' || step.type === 'key' || step.type === 'clipboard') {
    const dialog = relatedDialog;
    if (dialog && guard && !guard.toLowerCase().includes(dialog.title.toLowerCase())) {
      result.inProgress = true;
      result.adjustments = { foreground: dialog.title };
      if (dialog.title !== fg.title) result.focus = dialog.title;
      result.note = `Input is being aimed at the open “${clip(dialog.title, 40)}” dialog rather than the app window behind it.`;
    } else if (dialog && dialog.hint) {
      result.inProgress = true;
      result.note = `A “${clip(dialog.title, 40)}” dialog is ${fg.dialog ? 'in front' : 'open'}; ${dialog.hint}.`;
    }
    return result;
  }

  if (step.type === 'installApp') {
    const app = String(p.app || p.name || '').trim();
    if (fg.kind === 'installer' && app && matchesTarget({ title: `${fg.title} ${screen?.app?.title || ''}`, process: '' }, app)) {
      result.inProgress = true;
      result.alreadySatisfied = true;
      result.skipReason = `An installer dialog for ${app} is already open (“${clip(fg.title, 50)}”); finish it instead of starting another download.`;
    }
    return result;
  }

  if (step.type === 'waitFor' || step.type === 'expect') {
    if (p.kind === 'window' && p.mode !== 'absent' && p.value && fg.title.toLowerCase().includes(String(p.value).toLowerCase())) {
      result.alreadySatisfied = true;
      result.skipReason = `“${clip(fg.title, 50)}” is already in front.`;
    }
    if (p.kind === 'foreground' && p.value && fg.title.toLowerCase().includes(String(p.value).toLowerCase())) {
      result.alreadySatisfied = true;
      result.skipReason = `The foreground already shows “${clip(fg.title, 50)}”.`;
    }
    return result;
  }

  if (result.stepType === 'verifyScreen' && prior) {
    result.note = `Previous steps: ${prior}`;
  }
  return result;
}

/**
 * Compare the previous step's expectation with what the screen shows now. Used
 * between steps so the runner notices "the save dialog never opened" before it
 * fires the next action into the wrong window.
 */
export function reviewPrevious({ previous = null, screen = null } = {}) {
  if (!previous) return null;
  const fg = classifyWindow(screen?.foreground || {});
  const expectation = expectationFor(previous);
  let matches = null;
  let observed = fg.title ? `${fg.process || 'window'}: ${fg.title}` : 'no foreground window';
  if (previous.type === 'launchApp' || previous.type === 'openUrl') {
    const wanted = previous.type === 'openUrl' ? String(previous.params?.url || '') : String(previous.params?.target || '');
    matches = wanted ? matchesTarget(fg, wanted) || /browser/i.test(fg.process) : null;
  } else if (previous.type === 'clickElement' && fg.dialog) {
    // A dialog appearing is exactly what a menu-driven click is supposed to cause.
    matches = true;
    observed += ` (dialog: ${fg.kind})`;
  } else if (previous.type === 'type' && fg.dialog) {
    matches = true;
    observed += ' (typing carried into the dialog)';
  }
  return {
    expectation,
    observed,
    matches,
    revisit: matches === false ? `“${previous.name || previous.type}” may not have taken effect; re-check before continuing.` : '',
    dialogOpen: fg.dialog,
    dialogKind: fg.kind,
  };
}

/**
 * Elements around the target, with direction and distance, so movement can be
 * deliberate and an advert/overlay is named instead of clicked by accident.
 */
export function describeSurroundings({ target = null, elements = [], limit = 5 } = {}) {
  const point = target && Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y)) ? target : null;
  const list = (elements || [])
    .map((element) => {
      const x = Number(element.x);
      const y = Number(element.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const distance = point ? Math.round(Math.hypot(x - point.x, y - point.y)) : 0;
      const direction = point
        ? `${y < point.y - 20 ? 'above' : y > point.y + 20 ? 'below' : ''}${x < point.x - 20 ? ' left' : x > point.x + 20 ? ' right' : ''}`.trim() || 'at'
        : '';
      return {
        name: clip(element.name || element.label || 'element', 40),
        x,
        y,
        distance,
        direction,
        advert: ADVERT.test(String(element.name || element.label || '') + ' ' + String(element.role || '')),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, limit));
  const adverts = list.filter((entry) => entry.advert);
  return {
    target: point ? { x: point.x, y: point.y } : null,
    nearby: list,
    adverts,
    summary: list.length
      ? list.map((entry) => `${entry.name} (${entry.direction}${entry.distance ? `, ${entry.distance}px` : ''})`).join(', ')
      : 'no labelled elements around the target',
    caution: adverts.length
      ? `Possible advert/overlay near the target: ${adverts.map((entry) => entry.name).join(', ')}. Prefer the window titled by the goal over anything labelled like an ad.`
      : '',
  };
}

/** Intermediate pointer points so a click travels past the nearby controls. */
export function buildMovePath({ from = null, to = null, via = [], steps = 3 } = {}) {
  if (!to || !Number.isFinite(Number(to.x)) || !Number.isFinite(Number(to.y))) return [];
  const start = from && Number.isFinite(Number(from.x)) && Number.isFinite(Number(from.y)) ? from : null;
  const points = [];
  const waypoints = (via || []).filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))).slice(0, 2);
  const targets = [...waypoints, { x: Number(to.x), y: Number(to.y) }];
  let cursor = start ? { x: Number(start.x), y: Number(start.y) } : null;
  for (const target of targets) {
    if (!cursor) {
      points.push({ x: Math.round(target.x), y: Math.round(target.y) });
      cursor = target;
      continue;
    }
    const segments = Math.max(1, Math.min(6, Number(steps) || 3));
    for (let index = 1; index <= segments; index++) {
      const ratio = index / segments;
      points.push({
        x: Math.round(cursor.x + (target.x - cursor.x) * ratio),
        y: Math.round(cursor.y + (target.y - cursor.y) * ratio),
      });
    }
    cursor = target;
  }
  return points;
}

/** Timing habits from recorded runs, used for settle waits and pointer speed. */
export function userTiming(samples = []) {
  const gaps = (samples || [])
    .map((sample) => Number(sample?.gapMs ?? sample?.settleMs ?? sample?.ms))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 60000);
  if (!gaps.length) return { samples: 0, settleMs: 800, moveStepMs: 40, confidence: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    samples: gaps.length,
    settleMs: Math.max(250, Math.min(5000, Math.round(median))),
    moveStepMs: Math.max(20, Math.min(120, Math.round(median / 20))),
    confidence: Math.min(1, gaps.length / 6),
  };
}

/**
 * Turn a vision preview of the screen into a bounded adjustment. A small drift
 * is ignored, a confident better position is used, and a preview that says the
 * outcome already exists turns the click into a skip.
 */
export function decidePreview({ preview = null, step = null, minConfidence = 0.6, maxDriftPx = 8 } = {}) {
  const out = { apply: false, skip: false, reason: '', x: null, y: null, nearby: [], caution: '', alreadyDone: false };
  if (!preview) return { ...out, reason: 'no preview' };
  out.alreadyDone = Boolean(preview.alreadyDone);
  out.nearby = Array.isArray(preview.nearby) ? preview.nearby.slice(0, 6) : [];
  out.caution = String(preview.caution || preview.distraction || '');
  if (out.alreadyDone) {
    return { ...out, skip: true, reason: preview.alreadyEvidence || 'the expected state is already visible' };
  }
  const expectedWindow = String(step?.params?.window || step?.params?.foreground || step?.params?.title || '').trim();
  const seenWindow = String(preview.window || '').trim();
  if (
    seenWindow &&
    expectedWindow &&
    !seenWindow.toLowerCase().includes(expectedWindow.toLowerCase()) &&
    !expectedWindow.toLowerCase().includes(seenWindow.toLowerCase())
  ) {
    return { ...out, reason: `the preview shows “${seenWindow}”, not “${expectedWindow}”` };
  }
  const found = preview.found !== false;
  const confidence = Number(preview.confidence);
  const x = Number(preview.x);
  const y = Number(preview.y);
  if (step?.params?.fallbackX != null && step?.params?.fallbackY != null) {
    const drift = Math.hypot(x - Number(step.params.fallbackX), y - Number(step.params.fallbackY));
    if (!found || !Number.isFinite(confidence) || confidence < minConfidence || drift <= maxDriftPx) {
      return { ...out, reason: 'preview agrees with the planned position' };
    }
  }
  if (!found || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(confidence) || confidence < minConfidence) {
    return { ...out, reason: 'preview was not confident enough to adjust' };
  }
  return {
    ...out,
    apply: true,
    x: Math.round(x),
    y: Math.round(y),
    reason: `preview placed the control at ${Math.round(x)},${Math.round(y)} with ${Math.round(confidence * 100)}% confidence`,
  };
}
