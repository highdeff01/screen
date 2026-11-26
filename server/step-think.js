/**
 * Live step thinking.
 *
 * A step used to be a black box: the runner fired an action, waited, and only
 * afterwards noticed the screen was showing a file dialog, or that the caret was
 * in another window. This loop runs *while* the step runs. On each tick it:
 *
 *   1. reads the desktop (window in front, focused element, window list, an
 *      optional coarse frame signature) — read-only, bounded by the perception
 *      budget the operator sets (pixels and elements separately)
 *   2. writes one short note about what changed, so the run reads like a train
 *      of thought instead of a single verdict
 *   3. drafts the candidate continuations (click the dialog's Open button, press
 *      Enter, focus the goal window, retype, paste instead of typing, wait), up
 *      to the configured number of choices
 *   4. pre-tests every candidate against the observation it just read — the
 *      "response sample": would that click land on a button that exists? is
 *      there an editable caret to type into? — and keeps the score, so the best
 *      choice is known before anything is applied
 *
 * It never types, clicks or otherwise touches the desktop from inside the loop.
 * Acting stays in the runner's normal path, where every step still passes the
 * window guard, the firewall and post-checks. When a step does fail, the runner
 * offers these prepared corrections to its repair chain (before the generic
 * methods), and the operator's reject rate decides how long that may continue:
 * too many rejected corrections for one run, or for one step, stops them and
 * leaves the rest to the normal repair path and review.
 *
 * Everything that reads the desktop or calls the model is injectable, so the
 * behaviour is testable without either.
 */
import { db, persist, now, uid } from './store.js';
import { captureScreenSignature, readFocusedElement, readScreenContext } from './automation.js';
import { signatureHash } from './visual.js';
import { chat, parseJsonLoose } from './llm.js';

export const THINK_DEFAULTS = {
  enabled: true,
  // Cheap by default: one combined desktop read per step and no model call.
  // Both are opt-in, so thinking a normal step costs a single observation.
  modelAssist: false,
  // Stream thoughts and the chosen correction into the run log.
  liveLink: true,
  // Offer the prepared correction to the repair chain when the step fails.
  autoApply: true,
  intervalMs: 1800,
  // One read, taken once per step. Nothing keeps polling unless live
  // monitoring or higher thinking is on.
  readOnce: true,
  maxChoices: 7,
  maxNotes: 40,
  maxTicks: 60,
  // Higher thinking is the opt-in that buys more perception: periodic combined
  // reads, the model review, and an overseer verdict at the end of the step.
  higherThinking: false,
  liveMonitor: false,
  monitorIntervalMs: 3000,
  maxAlternatives: 5,
  overseer: false,
  // Keep the run going after an unrepaired failure, up to a cap.
  keepRunning: false,
  maxStepFailures: 3,
  maxReplans: 2,
  // Perception budget. `pixels` is the width of the sampled frame; 0 turns the
  // frame off. `elements` caps how many UI Automation details are read; 0 turns
  // focused-element reads off. They are independent, so either or both may grow.
  pixels: 48,
  elements: 25,
  // Side-by-side review rates: the operator preview and the AI mirror can run
  // at different speeds at the same time.
  previewIntervalMs: 2000,
  mirrorIntervalMs: 4000,
  sideBySide: false,
  // Applying the best prepared correction.
  autoApplyMinConfidence: 0.65,
  maxAutoApplies: 3,
  maxRejects: 4,
  stepRejectLimit: 2,
  modelEveryTicks: 4,
  maxModelCalls: 4,
};

const MAX_TEXT = 300;
const MAX_PARAM_TEXT = 2000;
const DIALOG_KINDS = [
  {
    kind: 'openFolder',
    re: /\b(open folder|select folder|choose folder|browse for folder|folder picker)\b/i,
    buttons: ['Open', 'Open Folder', 'Select Folder'],
  },
  {
    kind: 'filePicker',
    re: /\b(open file|open a file|select file|choose file|browse)\b/i,
    buttons: ['Open', 'Choose', 'Select'],
  },
  { kind: 'saveAs', re: /\b(save as|save file|save a copy)\b/i, buttons: ['Save', 'Save As'] },
  {
    kind: 'confirm',
    re: /\b(confirm|are you sure|warning|security alert|permission|allow access|do you want to)\b/i,
    buttons: ['OK', 'Yes', 'Continue', 'Allow'],
  },
  { kind: 'dialog', re: /\b(dialog|prompt|notice|alert)\b/i, buttons: ['OK', 'Continue'] },
];

// Step types whose failure a correction can genuinely rescue. Read-only steps
// (verification, notes, captures, waits) are not thinking targets.
const THINKABLE = new Set([
  'launchApp',
  'focusWindow',
  'openUrl',
  'type',
  'key',
  'clipboard',
  'click',
  'doubleClick',
  'rightClick',
  'clickElement',
  'drag',
  'dragCopy',
  'scroll',
  'windowAction',
  'playMedia',
  'installApp',
  'testApp',
]);

const text = (value, max = MAX_TEXT) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
const number = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n * 1000) / 1000)) : fallback;
};
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

export function normalizeThinkSettings(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  // Higher thinking is one switch for the expensive path: model review, live
  // re-reads and the overseer. It is the only thing that turns the model on by
  // itself; otherwise the model runs only when its own box is ticked.
  const higherThinking = flag(input.higherThinking, THINK_DEFAULTS.higherThinking);
  return {
    enabled: flag(input.enabled, THINK_DEFAULTS.enabled),
    modelAssist: higherThinking ? true : flag(input.modelAssist, THINK_DEFAULTS.modelAssist),
    liveLink: flag(input.liveLink, THINK_DEFAULTS.liveLink),
    autoApply: flag(input.autoApply, THINK_DEFAULTS.autoApply),
    intervalMs: number(input.intervalMs, 500, 15000, THINK_DEFAULTS.intervalMs),
    readOnce: flag(input.readOnce, higherThinking ? false : THINK_DEFAULTS.readOnce),
    higherThinking,
    liveMonitor: flag(input.liveMonitor, higherThinking ? true : THINK_DEFAULTS.liveMonitor),
    monitorIntervalMs: number(input.monitorIntervalMs, 500, 30000, THINK_DEFAULTS.monitorIntervalMs),
    maxAlternatives: number(input.maxAlternatives, 3, 12, THINK_DEFAULTS.maxAlternatives),
    overseer: flag(input.overseer, higherThinking ? true : THINK_DEFAULTS.overseer),
    keepRunning: flag(input.keepRunning, THINK_DEFAULTS.keepRunning),
    maxStepFailures: number(input.maxStepFailures, 1, 20, THINK_DEFAULTS.maxStepFailures),
    maxReplans: number(input.maxReplans, 0, 10, THINK_DEFAULTS.maxReplans),
    maxChoices: number(input.maxChoices, 3, 12, THINK_DEFAULTS.maxChoices),
    maxNotes: number(input.maxNotes, 5, 200, THINK_DEFAULTS.maxNotes),
    maxTicks: number(input.maxTicks, 1, 300, THINK_DEFAULTS.maxTicks),
    pixels: number(input.pixels, 0, 100, THINK_DEFAULTS.pixels),
    elements: number(input.elements, 0, 200, THINK_DEFAULTS.elements),
    previewIntervalMs: number(input.previewIntervalMs, 500, 15000, THINK_DEFAULTS.previewIntervalMs),
    mirrorIntervalMs: number(input.mirrorIntervalMs, 500, 30000, THINK_DEFAULTS.mirrorIntervalMs),
    sideBySide: flag(input.sideBySide, THINK_DEFAULTS.sideBySide),
    autoApplyMinConfidence: number(input.autoApplyMinConfidence, 0, 1, THINK_DEFAULTS.autoApplyMinConfidence),
    maxAutoApplies: number(input.maxAutoApplies, 0, 10, THINK_DEFAULTS.maxAutoApplies),
    maxRejects: number(input.maxRejects, 1, 20, THINK_DEFAULTS.maxRejects),
    stepRejectLimit: number(input.stepRejectLimit, 1, 10, THINK_DEFAULTS.stepRejectLimit),
    modelEveryTicks: number(input.modelEveryTicks, 1, 30, THINK_DEFAULTS.modelEveryTicks),
    maxModelCalls: number(input.maxModelCalls, 0, 30, THINK_DEFAULTS.maxModelCalls),
  };
}

export function stepThinkSettings() {
  const current = normalizeThinkSettings(db().settings.stepThink);
  db().settings.stepThink = current;
  return current;
}

export function thinkBudget(settings = stepThinkSettings()) {
  const pixels = number(settings.pixels, 0, 100, THINK_DEFAULTS.pixels);
  const elements = number(settings.elements, 0, 200, THINK_DEFAULTS.elements);
  const width = pixels > 0 ? Math.max(8, Math.round(pixels)) : 0;
  return {
    pixels,
    elements,
    width,
    height: width ? Math.max(5, Math.round((width * 9) / 16)) : 0,
    frame: pixels > 0,
    uiAutomation: elements > 0,
    overview: pixels > 0 || elements > 0,
  };
}

export function isThinkableStep(step) {
  return Boolean(step && THINKABLE.has(String(step.type || '')));
}

/* ---------------- observation ---------------- */

export function normalizeObservation(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const foreground = source.foreground && typeof source.foreground === 'object' ? source.foreground : {};
  const seen = new Set();
  const windows = [];
  for (const entry of [foreground, ...(Array.isArray(source.windows) ? source.windows : [])]) {
    if (!entry || typeof entry !== 'object') continue;
    const title = text(entry.title);
    if (!title || seen.has(norm(title))) continue;
    seen.add(norm(title));
    windows.push({ title, process: text(entry.process), className: text(entry.className) });
    if (windows.length >= 40) break;
  }
  const rawFocused = source.focused && typeof source.focused === 'object' ? source.focused : null;
  const focused =
    rawFocused && rawFocused.found !== false
      ? {
          name: text(rawFocused.name || rawFocused.label),
          controlType: text(rawFocused.controlType),
          editable: typeof rawFocused.editable === 'boolean' ? rawFocused.editable : null,
          window: text(rawFocused.window),
        }
      : null;
  const elements = (Array.isArray(source.elements) ? source.elements : [])
    .slice(0, 200)
    .map((entry) => ({
      name: text(entry?.name || entry?.label, 120),
      controlType: text(entry?.controlType, 40),
      window: text(entry?.window),
    }))
    .filter((entry) => entry.name);
  return {
    at: text(source.at) || now(),
    foreground: {
      title: text(foreground.title),
      process: text(foreground.process),
      className: text(foreground.className),
    },
    windows,
    focused,
    elements,
    frameHash: text(source.frameHash, 80) || null,
    changed: typeof source.changed === 'boolean' ? source.changed : null,
    // Where the pointer is, when the reader could see it, so the narration can
    // name coordinates instead of pretending the next move is invisible.
    pointer: (() => {
      const raw = source.pointer || source.cursor;
      const x = Number(raw?.x);
      const y = Number(raw?.y);
      return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
    })(),
  };
}

export function detectDialog(observation) {
  if (!observation) return null;
  const title = String(observation.foreground?.title || '');
  const className = String(observation.foreground?.className || '');
  const explicit = observation.dialog && typeof observation.dialog === 'object' ? observation.dialog : null;
  if (explicit) {
    const rule = DIALOG_KINDS.find((entry) => entry.kind === explicit.kind) || DIALOG_KINDS[DIALOG_KINDS.length - 1];
    return {
      kind: text(explicit.kind) || rule.kind,
      title: text(explicit.title) || title,
      buttons: (Array.isArray(explicit.buttons) && explicit.buttons.length ? explicit.buttons : rule.buttons)
        .map((label) => text(label, 40))
        .filter(Boolean)
        .slice(0, 8),
    };
  }
  if (!title) return null;
  for (const rule of DIALOG_KINDS) {
    if (!rule.re.test(title)) continue;
    return { kind: rule.kind, title, buttons: rule.buttons.slice(0, 8) };
  }
  // A classic Win32 dialog class is a dialog even when the title is plain.
  if (className === '#32770') return { kind: 'dialog', title, buttons: ['OK', 'Cancel'] };
  return null;
}

/* ---------------- candidate choices ---------------- */

function goalApp(run = {}, workflow = {}) {
  return text(
    run?.presenter?.verifier?.requestedApp ||
      run?.presenter?.requestedApp ||
      workflow?.goalApp ||
      run?.goalApp ||
      '',
    80
  );
}

function guardFor({ step, run, workflow }) {
  const declared = step?.params?.foreground;
  return text(
    (declared === true ? step?.params?.window || step?.params?.title : declared) ||
      step?.params?.window ||
      step?.params?.title ||
      run?.lastWindow?.title ||
      goalApp(run, workflow) ||
      '',
    120
  );
}

function typingAlt(step) {
  const params = step?.params || {};
  if (typeof params.textVar === 'string' && params.textVar.trim()) return { textVar: params.textVar.trim() };
  const value = typeof params.text === 'string' ? params.text : typeof params.value === 'string' ? params.value : '';
  return value ? { text: value.slice(0, MAX_PARAM_TEXT) } : null;
}

function includesWindow(observation, needle) {
  const wanted = norm(needle);
  if (!wanted) return false;
  if (norm(observation?.foreground?.title).includes(wanted)) return true;
  return (observation?.windows || []).some((entry) => norm(entry.title).includes(wanted));
}

/**
 * Draft the candidate continuations from the live observation. Nothing here
 * executes; each entry is a step the runner could take if it needs to.
 */
export function thinkChoices({
  step = null,
  run = {},
  workflow = {},
  observation = {},
  goal = '',
  maxChoices = THINK_DEFAULTS.maxChoices,
} = {}) {
  const obs = observation || {};
  const dialog = detectDialog(obs);
  const guard = guardFor({ step, run, workflow });
  const foregroundTitle = String(obs.foreground?.title || '');
  const choices = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.type}|${norm(entry.name)}|${JSON.stringify(entry.params || {})}`;
    if (seen.has(key) || choices.length >= Math.max(3, maxChoices) + 3) return;
    seen.add(key);
    choices.push({ id: uid('thc'), ...entry });
  };
  const dialogLabel = dialog ? { openFolder: 'folder dialog', filePicker: 'file dialog', saveAs: 'save dialog', confirm: 'confirmation', dialog: 'dialog' }[dialog.kind] || 'dialog' : '';

  if (dialog) {
    const elementButtons = (obs.elements || [])
      .filter((entry) => /^(button|splitbutton|menu item)$/i.test(entry.controlType || 'button'))
      .map((entry) => entry.name)
      .filter((name) => /^(open|open folder|select folder|choose|select|save|save as|ok|yes|continue|allow|replace)$/i.test(name));
    // Two buttons at most: “Open” and “Open Folder” are usually the same target,
    // and the remaining slots belong to the focus, field and input alternatives.
    const buttons = [...new Set([...elementButtons, ...(dialog.buttons || [])])].slice(0, 2);
    for (const label of buttons) {
      push({
        type: 'clickElement',
        name: `Click “${label}” in the ${dialogLabel}`,
        params: { window: foregroundTitle || guard, name: label, controlType: 'Button' },
        why: `the ${dialogLabel} is open and “${label}” is how it is answered`,
      });
    }
    push({
      type: 'key',
      name: `Accept the ${dialogLabel} with Enter`,
      params: { keys: 'enter', ...(foregroundTitle || guard ? { foreground: foregroundTitle || guard } : {}) },
      why: 'Enter accepts the default button when the dialog already has keyboard focus',
    });
  }

  if (guard && !norm(foregroundTitle).includes(norm(guard))) {
    push({
      type: 'focusWindow',
      name: `Bring “${guard}” to the front`,
      params: { title: guard },
      why: 'the window this step needs is not the one in front',
    });
  }

  const field = (obs.elements || []).find(
    (entry) =>
      /edit|text|combobox/i.test(entry.controlType || '') &&
      /search|find|ask|prompt|query|message|input/i.test(entry.name || '')
  );
  if (field) {
    push({
      type: 'clickElement',
      name: `Click the “${field.name}” field before typing`,
      params: { window: field.window || foregroundTitle || guard, name: field.name, controlType: 'Edit' },
      why: 'the visible search/input field has to hold the caret before text lands',
    });
  }

  const typing = typingAlt(step);
  const target = foregroundTitle || guard;
  if (typing && target) {
    push({
      type: 'type',
      name: `Type the text again in “${target}”`,
      params: { ...typing, foreground: target },
      why: 'the previous attempt reported success without visible input, so the caret path is retried explicitly',
    });
    push({
      type: 'clipboard',
      name: 'Paste the text instead of typing',
      params: { action: 'paste', ...typing, foreground: target },
      why: 'clipboard paste is the alternate input path when synthesized keystrokes are dropped',
    });
  }

  if (!dialog) {
    // Only offered when no dialog is open: with a dialog, Escape would dismiss
    // the very thing the step needs to answer.
    push({
      type: 'key',
      name: 'Press Enter in the target window',
      params: { keys: 'enter', ...(target ? { foreground: target } : {}) },
      why: 'submitting is the usual next move once the text is in the field',
    });
    push({
      type: 'key',
      name: 'Press Escape to clear a stray overlay',
      params: { keys: 'escape', ...(target ? { foreground: target } : {}) },
      why: 'a menu, tooltip or overlay can swallow the click; Escape clears it without touching the document',
    });
  }

  push({
    type: 'wait',
    name: 'Wait for the window to settle',
    params: { ms: 1200 },
    why: 'a dialog or the app itself may still be painting; a short settle makes the next read truthful',
  });

  return choices.slice(0, Math.max(3, maxChoices));
}

/**
 * The response sample: pre-test a candidate against the observation without
 * acting. Confidence is the evidence the shot would land, not optimism.
 */
export function sampleChoice(choice, observation, { step = null, guard = '' } = {}) {
  const obs = observation || {};
  const dialog = detectDialog(obs);
  const foregroundTitle = String(obs.foreground?.title || '');
  const reasons = [];
  let confidence = 0.4;
  let risk = 'medium';
  const type = String(choice?.type || '');
  const params = choice?.params || {};

  if (type === 'clickElement') {
    const windowWanted = String(params.window || '');
    const windowPresent = !windowWanted || includesWindow(obs, windowWanted);
    if (!windowPresent) {
      confidence = 0.2;
      reasons.push(`“${windowWanted}” is not on screen`);
    } else if (!dialog) {
      confidence = 0.35;
      reasons.push('no dialog is open, so there is no button to answer it');
    } else if ((dialog.buttons || []).some((label) => norm(label) === norm(params.name))) {
      confidence = 0.92;
      reasons.push(`“${params.name}” is a known button of the open ${dialog.kind} dialog`);
    } else {
      confidence = 0.58;
      reasons.push(`the dialog is open but “${params.name}” was not read as one of its buttons`);
    }
    risk = 'low';
  } else if (type === 'key') {
    if (norm(params.keys) === 'enter' && dialog) {
      confidence = 0.78;
      reasons.push('a dialog is open and Enter accepts its default button');
      risk = 'medium';
    } else if (guard && norm(foregroundTitle).includes(norm(guard))) {
      confidence = 0.5;
      reasons.push(`“${guard}” is in front, so the keys land in the intended window`);
    } else {
      confidence = 0.28;
      reasons.push('no dialog and no confirmed target window for the keypress');
    }
  } else if (type === 'type' || type === 'clipboard') {
    const hasText = Boolean(params.text) || Boolean(params.textVar);
    const wanted = String(params.foreground || '');
    const windowPresent = !wanted || includesWindow(obs, wanted);
    const focused = obs.focused;
    const reference = wanted || foregroundTitle;
    const focusedHere =
      Boolean(focused) &&
      windowPresent &&
      (focused.editable === true || (focused.window ? norm(focused.window).includes(norm(reference)) : false));
    if (!hasText) {
      confidence = 0.15;
      reasons.push('the candidate has no text to send');
    } else if (!windowPresent) {
      confidence = 0.28;
      reasons.push(`“${wanted}” is not on screen, so the text has no destination`);
    } else if (focused?.editable === false) {
      confidence = 0.18;
      reasons.push(`the focused control is not editable${focused.name ? ` (“${focused.name}”)` : ''}`);
    } else if (focused?.editable === true && focusedHere) {
      confidence = type === 'clipboard' ? 0.9 : 0.86;
      reasons.push(`an editable control holds the caret${focused.name ? ` (“${focused.name}”)` : ''}`);
      risk = type === 'clipboard' ? 'low' : 'medium';
    } else if (guard && norm(foregroundTitle).includes(norm(guard))) {
      confidence = 0.55;
      reasons.push(`“${guard}” is in front but no editable caret was read`);
      risk = 'medium';
    } else {
      confidence = 0.3;
      reasons.push('neither the target window nor an editable caret was confirmed');
    }
  } else if (type === 'focusWindow') {
    if (includesWindow(obs, params.title)) {
      confidence = 0.8;
      reasons.push(`“${params.title}” is open and can be raised`);
      risk = 'low';
    } else {
      confidence = 0.4;
      reasons.push(`“${params.title}” was not found in the window list`);
    }
  } else if (type === 'wait') {
    confidence = 0.5;
    reasons.push('waiting is always safe; it does not change the desktop by itself');
    risk = 'low';
  }

  return {
    confidence: Math.round(confidence * 100) / 100,
    ok: confidence >= 0.5,
    risk,
    reasons: reasons.slice(0, 3),
  };
}

export function scoreChoices(choices, observation, context = {}) {
  const guard = context.guard || '';
  return (choices || [])
    .map((choice, index) => ({ ...choice, order: index, ...sampleChoice(choice, observation, { ...context, guard }) }))
    .sort((a, b) => (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || b.confidence - a.confidence || a.order - b.order)
    .map(({ order, ...rest }) => rest);
}

/* ---------------- the thinking record on a step ---------------- */

function ensureThink(step, settings) {
  if (!step.think || step.think.finishedAt) {
    step.think = {
      id: uid('thk'),
      startedAt: now(),
      finishedAt: null,
      status: 'running',
      ticks: 0,
      notes: [],
      observation: null,
      dialog: null,
      choices: [],
      alternatives: [],
      best: null,
      overseer: null,
      model: null,
      applied: [],
      rejects: [],
      availability: null,
      summary: '',
    };
  }
  return step.think;
}

function addNote(think, message, settings) {
  const value = text(message, 240);
  if (!value) return false;
  const last = think.notes[think.notes.length - 1];
  if (last && last.text === value) return false;
  think.notes.push({ at: now(), text: value });
  if (think.notes.length > settings.maxNotes) think.notes = think.notes.slice(-settings.maxNotes);
  return true;
}

/**
 * One turn of the loop, separated from the timer so it is deterministic.
 * Returns the same record the step carries.
 */
export function runThinkOnce(step, {
  observation = null,
  run = {},
  workflow = {},
  goal = '',
  settings = null,
  onNote = null,
} = {}) {
  const config = settings || stepThinkSettings();
  const think = ensureThink(step, config);
  think.ticks += 1;
  const obs = normalizeObservation(observation || {});
  const previous = think.observation;
  think.observation = obs;
  const dialog = detectDialog(obs);
  think.dialog = dialog;

  const front = obs.foreground.title
    ? `${obs.foreground.title}${obs.foreground.process ? ` (${obs.foreground.process})` : ''}`
    : 'nothing in front';
  const frontChanged = !previous || previous.foreground.title !== obs.foreground.title;
  if (frontChanged) {
    if (addNote(think, `In front: ${front}`, config) && onNote) onNote(`In front: ${front}`);
  }
  if (dialog && think.lastDialogTitle !== dialog.title) {
    think.lastDialogTitle = dialog.title;
    const message = `Dialog: ${dialog.title} — ${dialog.kind}${dialog.buttons.length ? `; buttons: ${dialog.buttons.join(', ')}` : ''}`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }
  if (obs.changed === true) {
    if (addNote(think, 'The sampled screen changed since the last tick', config) && onNote) onNote('The screen changed since the last tick');
  }
  if (obs.focused?.editable === true) {
    const message = `Caret: ${obs.focused.controlType || 'control'}${obs.focused.name ? ` “${obs.focused.name}”` : ''}`;
    if (addNote(think, message, config) && onNote) onNote(message);
  } else if (obs.focused?.editable === false) {
    const message = `Caret is not editable${obs.focused.name ? ` (“${obs.focused.name}”)` : ''}; typing would not land`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }

  const guard = guardFor({ step, run, workflow });
  const choices = scoreChoices(
    thinkChoices({ step, run, workflow, observation: obs, goal, maxChoices: config.maxChoices }),
    obs,
    { step, guard }
  ).slice(0, Math.max(3, config.maxChoices));
  think.choices = choices;
  think.best = choices.find((choice) => choice.ok) || null;
  think.choiceAt = now();
  // The alternates are kept in rank order with the reason each landed where it
  // did, so the run reads as a decision instead of a verdict.
  think.alternatives = choices.slice(0, Math.max(5, config.maxAlternatives)).map((choice, index) => ({
    rank: index + 1,
    id: choice.id,
    type: choice.type,
    name: choice.name,
    confidence: choice.confidence,
    risk: choice.risk,
    why: choice.why,
    reasons: choice.reasons,
    verdict: choice.id === think.best?.id ? 'best' : choice.ok ? 'backup' : 'rejected',
  }));
  if (obs.pointer) {
    const message = `Pointer at (${obs.pointer.x}, ${obs.pointer.y})`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }
  if (think.best) {
    const message = `Best of ${choices.length}: ${think.best.name} (${Math.round(think.best.confidence * 100)}%) — ${(think.best.reasons || [])[0] || think.best.why || ''}`;
    if (addNote(think, message, config) && onNote) onNote(message);
  } else {
    const message = `Considered ${choices.length} option(s); none passed its sample, so the normal repair leads`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }
  const backup = choices.find((choice) => choice.ok && choice.id !== think.best?.id);
  if (backup) {
    const message = `Keeping ${backup.name} (${Math.round(backup.confidence * 100)}%) as the alternate — ${(backup.reasons || [])[0] || backup.why || ''}`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }
  for (const weak of choices.filter((choice) => !choice.ok).slice(0, 2)) {
    const message = `Considering ${weak.name} — but ${(weak.reasons || [])[0] || 'the screen gives it no support'}; looking for a better option`;
    if (addNote(think, message, config) && onNote) onNote(message);
  }
  return think;
}

/* ---------------- the live loop ---------------- */

async function observeDesktop({ budget, previousHash = null } = {}) {
  const out = { foreground: null, windows: [], focused: null, elements: [], at: now() };
  if (!budget?.overview) return out;
  try {
    const screen = await readScreenContext();
    if (screen && !screen.error) {
      out.foreground = screen.foreground || null;
      out.windows = Array.isArray(screen.windows) ? screen.windows : [];
    }
  } catch {
    // A failed read is recorded by the caller as an unavailable observation.
  }
  if (budget.uiAutomation) {
    try {
      const focused = await readFocusedElement();
      if (focused && focused.found !== false) {
        out.focused = {
          name: focused.name || focused.label || '',
          controlType: focused.controlType || '',
          editable: typeof focused.editable === 'boolean' ? focused.editable : null,
          window: focused.window || '',
        };
      }
    } catch {
      // The window list still makes the tick useful.
    }
  }
  if (budget.frame) {
    try {
      const frame = await captureScreenSignature({ width: budget.width, height: budget.height });
      out.frameHash = signatureHash(frame);
      out.changed = previousHash ? out.frameHash !== previousHash : null;
    } catch {
      // Pixels are an extra signal, not a requirement.
    }
  }
  return out;
}

function pickModelChoice(reply, count) {
  if (!reply || reply.ok === false) return null;
  let parsed = null;
  try {
    parsed = parseJsonLoose(String(reply.content || ''));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const pick = Math.round(Number(parsed.pick));
  if (!Number.isFinite(pick) || pick < 1 || pick > count) return null;
  return { pick, why: text(parsed.why, 240) };
}

async function askThinkModel({ ask, goal, step, observation, choices, budget }) {
  const list = choices
    .map((choice, index) => `${index + 1}. ${choice.type}: ${choice.name} — sample ${Math.round(choice.confidence * 100)}% (${choice.reasons.join('; ')})`)
    .join('\n');
  const prompt = [
    `Goal: ${text(goal, 800) || 'not stated'}`,
    `Step that is running: ${step.type}: ${step.name}`,
    `Window in front: ${observation.foreground?.title || 'unknown'}${observation.foreground?.process ? ` (${observation.foreground.process})` : ''}`,
    `Focused control: ${observation.focused ? `${observation.focused.controlType || 'control'} “${observation.focused.name || ''}”, editable=${observation.focused.editable}` : 'not read'}`,
    `Perception budget: ${budget.pixels}px frame, ${budget.elements} element(s)`,
    `Candidates (each was already pre-tested against the screen):\n${list}`,
    'Pick the single most likely continuation. Reply as JSON only: {"pick":1,"why":"one sentence"}.',
  ].join('\n');
  const system =
    'You review a desktop-automation step while it is still running. Choose the candidate that continues toward the stated goal using the visible UI. Do not invent coordinates or controls you were not given. Return JSON only.';
  const reply = typeof ask === 'function'
    ? await ask({ prompt, system })
    : await chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        { format: 'json', kind: 'think', timeoutMs: 20000, temperature: 0.1, maxTokens: 300 }
      );
  return pickModelChoice(reply, choices.length);
}

/** Live re-reads are opt-in; a normal step is read once and the loop ends. */
export function isLiveMonitoring(settings) {
  return settings?.liveMonitor === true || settings?.higherThinking === true;
}

/**
 * Start thinking about `step` while it runs. The loop is read-only and its
 * timer is unref'd; `stop()` waits for an in-flight tick and returns the record.
 */
export function beginStepThink(run, step, {
  workflow = {},
  probe = null,
  settings = null,
  observe = null,
  ask = null,
  onNote = null,
  onAim = null,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  const config = settings || stepThinkSettings();
  if (!config.enabled || !isThinkableStep(step)) return null;
  if (!probe && !observe && !thinkBudget(config).overview) return null;
  const think = ensureThink(step, config);
  let timer = null;
  let inFlight = null;
  let stopped = false;
  let modelCalls = 0;
  let modelFailures = 0;
  let lastHash = null;
  const note = (message) => {
    if (!message) return;
    if (config.liveLink && onNote) {
      try {
        onNote(message);
      } catch {
        // Logging a thought never breaks the loop.
      }
    }
  };

  const read = async () => {
    const budget = thinkBudget(config);
    if (typeof observe === 'function') return observe({ budget, run, step });
    if (probe && typeof probe.readThinkObservation === 'function') return probe.readThinkObservation({ budget, run, step });
    if (probe) return null;
    return observeDesktop({ budget, previousHash: lastHash });
  };

  async function tickNow() {
    if (stopped || think.status !== 'running') return think;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const observation = await read();
        if (!observation) {
          if (think.availability !== 'unavailable') {
            think.availability = 'unavailable';
            if (addNote(think, 'No desktop observation is available for this step', config)) note('No desktop observation is available for this step');
          }
          return think;
        }
        think.availability = 'observed';
        think.reads = (Number(think.reads) || 0) + 1;
        const budget = thinkBudget(config);
        if (budget.frame && observation.frameHash) {
          observation.changed = lastHash ? observation.frameHash !== lastHash : null;
          lastHash = observation.frameHash;
        }
        runThinkOnce(step, {
          observation,
          run,
          workflow,
          goal: run?.workflowGoal || run?.goal || '',
          settings: config,
          onNote: note,
        });
        // The best prepared move is where the pointer belongs: aiming from the
        // thinking loop is what makes thinking visible on the desktop instead
        // of only in the log.
        if (typeof onAim === 'function' && think.best) {
          try {
            await onAim(think.best);
          } catch {
            // Aiming is a convenience; it never breaks the thinking loop.
          }
        }
        const choices = think.choices || [];
        if (
          config.modelAssist &&
          choices.length &&
          modelCalls < config.maxModelCalls &&
          modelFailures < 2 &&
          think.ticks % Math.max(1, config.modelEveryTicks) === 0
        ) {
          modelCalls += 1;
          const picked = await askThinkModel({
            ask,
            goal: run?.workflowGoal || run?.goal || '',
            step,
            observation: think.observation,
            choices,
            budget,
          });
          if (picked) {
            const index = choices.findIndex((choice) => choice.ok);
            const chosen = choices[picked.pick - 1];
            if (chosen && chosen.ok) {
              think.choices = [chosen, ...choices.filter((choice) => choice.id !== chosen.id)];
              think.best = { ...chosen, modelWhy: picked.why };
              think.model = { at: now(), pick: picked.pick, why: picked.why };
              if (addNote(think, `Model review: ${chosen.name}${picked.why ? ` — ${picked.why}` : ''}`, config)) {
                note(`Model review: ${chosen.name}${picked.why ? ` — ${picked.why}` : ''}`);
              }
            } else if (index >= 0) {
              think.model = { at: now(), pick: null, why: picked.why || 'the model picked a candidate that failed its sample' };
            }
          } else {
            modelFailures += 1;
            if (modelFailures >= 2 && addNote(think, 'Model review unavailable; continuing with sampled choices', config)) {
              note('Model review unavailable; continuing with sampled choices');
            }
          }
        }
      } catch (err) {
        think.availability = `failed: ${text(String(err?.message || err), 160)}`;
      } finally {
        inFlight = null;
      }
      return think;
    })();
    return inFlight;
  }

  const monitoring = isLiveMonitoring(config);
  const cadence = Math.max(
    500,
    Number(monitoring ? config.monitorIntervalMs : config.intervalMs) || config.intervalMs
  );

  function pump() {
    if (stopped) return;
    void tickNow().finally(() => {
      if (stopped) return;
      if (think.ticks >= config.maxTicks) {
        stopped = true;
        return;
      }
      // One combined read per step is the default. Without live monitoring the
      // loop is finished as soon as that read is in, which is what keeps a
      // normal step cheap.
      if (config.readOnce && !monitoring) {
        stopped = true;
        return;
      }
      timer = schedule(pump, cadence);
      timer?.unref?.();
    });
  }

  timer = schedule(pump, cadence);
  timer?.unref?.();

  async function stop() {
    if (!stopped) stopped = true;
    if (timer !== null) cancel(timer);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The record already notes the failure.
      }
    }
    if (config.overseer || config.higherThinking) {
      think.overseer = overseerBrief({ run, step, think, goal: run?.workflowGoal || run?.goal || '' });
    }
    think.finishedAt = now();
    think.status = 'done';
    think.summary = think.best
      ? `${think.ticks} tick(s); best ${think.best.name} (${Math.round(think.best.confidence * 100)}%)`
      : `${think.ticks} tick(s); ${think.choices.length} choice(s), none passed its sample`;
    persist();
    return think;
  }

  return { think, tickNow, stop, get running() { return !stopped; } };
}

/* ---------------- applying, with a reject-rate guard ---------------- */

function stats(run) {
  if (!run.thinkStats || typeof run.thinkStats !== 'object') {
    run.thinkStats = { applies: 0, rejects: 0, byStep: {} };
  }
  if (!run.thinkStats.byStep || typeof run.thinkStats.byStep !== 'object') run.thinkStats.byStep = {};
  return run.thinkStats;
}

export function thinkBlocked(run, step, settings = stepThinkSettings()) {
  const current = stats(run);
  if (current.applies >= settings.maxAutoApplies) {
    return `auto-applied step-thinking limit reached (${current.applies}/${settings.maxAutoApplies})`;
  }
  if (current.rejects >= settings.maxRejects) {
    return `too many rejected step-thinking corrections this run (${current.rejects}/${settings.maxRejects})`;
  }
  const per = current.byStep?.[step?.id] || { rejects: 0 };
  if (per.rejects >= settings.stepRejectLimit) {
    return `“${step?.name || step?.type || 'this step'}” already rejected ${per.rejects} step-thinking correction(s)`;
  }
  if ((run.thinkBlockedSteps || []).includes(step?.id)) {
    return `“${step?.name || step?.type || 'this step'}” is blocked after repeated interception`;
  }
  return '';
}

/**
 * The prepared corrections the runner's repair chain may try, best first. The
 * steps run *before* the failed step is retried (`replaces: false`), so a dialog
 * that was answered still leaves the original action to prove itself.
 */
export function thinkRepairCandidates({ run, step, think = step?.think, settings = null } = {}) {
  const config = settings || stepThinkSettings();
  if (!config.autoApply || !think) return [];
  const blocked = thinkBlocked(run, step, config);
  if (blocked) {
    if (think) think.autoApplyBlocked = blocked;
    return [];
  }
  const choices = (think.choices || []).filter(
    (choice) => choice.ok && choice.confidence >= config.autoApplyMinConfidence
  );
  return choices.slice(0, 3).map((choice) => ({
    method: `step-think: ${choice.name}`,
    steps: [
      {
        id: uid('stp'),
        type: choice.type,
        name: choice.name,
        params: { ...(choice.params || {}) },
        timeoutMs: 15000,
      },
    ],
    replaces: false,
    think: {
      choiceId: choice.id,
      confidence: choice.confidence,
      risk: choice.risk,
      why: choice.why,
      reasons: choice.reasons,
      modelWhy: choice.modelWhy || null,
    },
  }));
}

/** Record how a step-thinking correction ended. Called by the runner. */
export function recordThinkOutcome(run, step, { method = '', ok = false, error = '' } = {}) {
  const current = stats(run);
  const per = current.byStep[step?.id] || (current.byStep[step?.id] = { tries: 0, rejects: 0 });
  per.tries += 1;
  if (ok) {
    current.applies += 1;
    if (step?.think) step.think.applied = [...(step.think.applied || []), { at: now(), method, confidence: null }].slice(-8);
    return { blocked: '', ok: true };
  }
  current.rejects += 1;
  per.rejects += 1;
  if (step?.think) {
    step.think.rejects = [...(step.think.rejects || []), { at: now(), method, error: text(error, 240) }].slice(-8);
  }
  const config = stepThinkSettings();
  if (per.rejects >= config.stepRejectLimit) {
    run.thinkBlockedSteps = [...new Set([...(run.thinkBlockedSteps || []), step.id])].slice(-20);
  }
  return { blocked: thinkBlocked(run, step, config), ok: false };
}

/**
 * The overseer's verdict for one step: what it would do next, why, and whether
 * the original step is still preserved. Deterministic and free; it summarises
 * the sampled alternatives instead of making another model call.
 */
export function overseerBrief({ run = {}, step = null, think = null, goal = '' } = {}) {
  const best = think?.best || (think?.choices || []).find((choice) => choice.ok) || null;
  const alternatives = (think?.alternatives || []).slice(0, 5);
  return {
    at: now(),
    decision: best
      ? think?.dialog
        ? 'clear the blocker, then continue the step'
        : 'continue with the prepared move'
      : 'hold; the normal repair path leads',
    recommend: best ? `${best.type}: ${best.name}` : 'no prepared move passed its sample',
    why: best ? (best.reasons || [])[0] || best.why || '' : 'nothing on screen matched a usable continuation',
    confidence: best ? best.confidence : 0,
    preservation: step?.name
      ? `Original step “${step.name}” is kept and retried after the correction`
      : 'no step to preserve',
    alternatives: alternatives.map((entry) => entry.name),
    goal: text(goal, 200),
  };
}

/** The UI can show a short headline without walking the whole record. */
export function thinkHeadline(think) {
  if (!think) return '';
  const best = think.best ? `best: ${think.best.name} (${Math.round(think.best.confidence * 100)}%)` : 'no choice passed its sample';
  const alts = (think.alternatives || []).length;
  return `${think.ticks || 0} tick(s) · ${(think.choices || []).length} choice(s)${alts ? ` · ${alts} alt(s)` : ''} · ${best}`;
}
