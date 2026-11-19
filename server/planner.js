import { STEP_TYPES, normalizeShortcutKeys, discoverApps, inspectWindowState } from './automation.js';
import { firstAppStep, opensTargetBefore, launchAndWaitSteps } from './app-launch-hints.js';
import { uid, now, db, persist, logActivity, NOTES, writeFileDurable } from './store.js';
import { chat, parseJsonLoose } from './llm.js';
import fs from 'node:fs';
import path from 'node:path';
import { slug } from './store.js';
import { eligibleShortcuts } from './shortcuts.js';
import { recallWorkflowMemory, recallWorkflowTemplate, formatWorkflowMemory, planStepsFromMemory } from './workflow-memory.js';
import { buildWorkflowResearch, compactResearch } from './research.js';
import { strategyBrief } from './strategy.js';

const TYPE_SET = new Set(STEP_TYPES.map((s) => s.type));
const SAMPLE_VIDEO_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const ALIASES = {
  open: 'launchApp',
  openapp: 'launchApp',
  launch: 'launchApp',
  start: 'launchApp',
  navigate: 'openUrl',
  goto: 'openUrl',
  browse: 'openUrl',
  url: 'openUrl',
  focus: 'focusWindow',
  activate: 'focusWindow',
  window: 'focusWindow',
  windowaction: 'windowAction',
  minimize: 'windowAction',
  minimizewindow: 'windowAction',
  minimizepopup: 'windowAction',
  maximize: 'windowAction',
  restorewindow: 'windowAction',
  hover: 'move',
  movemouse: 'move',
  pointer: 'move',
  shift: 'move',
  tap: 'click',
  pressbutton: 'click',
  dblclick: 'doubleClick',
  doubleclick: 'doubleClick',
  rightclick: 'rightClick',
  drag: 'drag',
  highlight: 'drag',
  dragcopy: 'dragCopy',
  highlightcopy: 'dragCopy',
  selectcopy: 'dragCopy',
  mousedragcopy: 'dragCopy',
  selecttext: 'drag',
  scroll: 'scroll',
  input: 'type',
  write: 'type',
  entertext: 'type',
  keyboard: 'type',
  hotkey: 'key',
  shortcut: 'key',
  keycombo: 'key',
  sendkeys: 'key',
  selectall: 'key',
  clipboard: 'clipboard',
  copy: 'clipboard',
  paste: 'clipboard',
  selectcopy: 'clipboard',
  aiextract: 'aiExtract',
  extracttext: 'aiExtract',
  extract: 'aiExtract',
  sleep: 'wait',
  delay: 'wait',
  pause: 'wait',
  waituntil: 'waitFor',
  waitfor: 'waitFor',
  screenshot: 'screenshot',
  capture: 'screenshot',
  verifyscreen: 'verifyScreen',
  verifyplayback: 'verifyPlayback',
  playbackcheck: 'verifyPlayback',
  checkplayback: 'verifyPlayback',
  clickelement: 'clickElement',
  clickuielement: 'clickElement',
  findelement: 'clickElement',
  mediahold: 'mediaHold',
  holdmedia: 'mediaHold',
  watchmedia: 'mediaHold',
  playbackhold: 'mediaHold',
  screencheck: 'verifyScreen',
  visualcheck: 'verifyScreen',
  see: 'verifyScreen',
  assert: 'expect',
  verify: 'expect',
  check: 'expect',
  tool: 'runTool',
  command: 'runTool',
  note: 'note',
  writenote: 'writeNote',
  savenote: 'writeNote',
  appendnote: 'writeNote',
  readnote: 'readNote',
  notes: 'readNote',
  copylink: 'copyLink',
  getlink: 'copyLink',
  addressbar: 'copyLink',
  download: 'downloadMedia',
  save: 'downloadMedia',
  savemedia: 'downloadMedia',
  savevideo: 'downloadMedia',
  downloadvideo: 'downloadMedia',
  recordvideo: 'recordVideo',
  screenrecord: 'recordVideo',
  recording: 'recordVideo',
  writefile: 'writeTextFile',
  savetext: 'writeTextFile',
  savetextfile: 'writeTextFile',
  captureimage: 'saveImage',
  saveclipboardimage: 'saveImage',
  install: 'installApp',
  installapp: 'installApp',
  winget: 'installApp',
  testapp: 'testApp',
  smoketest: 'testApp',
  apptest: 'testApp',
  watchvideo: 'watchVideo',
  videonotes: 'watchVideo',
  waituntil: 'expect',
};

function deriveElementLabel(value) {
  let label = String(value || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:button|icon|link|tab|menu item|window)\b/gi, ' ')
    .replace(/\b(?:in|on)\s+the\s+.*$/i, ' ')
    .replace(/^(?:click|tap|press|select|open)\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = label.split(' ').filter(Boolean);
  if (words.length > 4) label = words.slice(0, 4).join(' ');
  return label;
}

function coerceRawStep(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  // Some small models return an array of strings such as
  // "clickElement {name:Install}". Preserve those instead of discarding them.
  const match = text.match(/^([a-zA-Z][\w-]*)\s*(?:\{([\s\S]*)\})?\s*$/);
  if (!match) return null;
  const params = {};
  for (const pair of String(match[2] || '').split(',')) {
    const kv = pair.match(/^\s*([\w.-]+)\s*:\s*([\s\S]*?)\s*$/);
    if (!kv) continue;
    params[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { type: match[1], params };
}

/**
 * Resolve the approved tool a runTool step names. A plan may hold the tool's id
 * or only its name; execution knows ids, so every insertion path resolves here
 * instead of running a step that fails with "Tool not found: (missing id)".
 * Returns null when nothing matches, which callers treat as unusable.
 */
export function resolveToolRef(params = {}, tools = db().tools) {
  const id = String(params?.toolId || '').trim();
  const name = String(params?.toolName || '').trim();
  const list = Array.isArray(tools) ? tools : [];
  const tool =
    (id && list.find((entry) => entry.id === id || entry.name === id)) ||
    (name && list.find((entry) => entry.name === name || entry.id === name)) ||
    null;
  return tool || null;
}

function normalizeStep(input, index = 0) {
  const raw = coerceRawStep(input);
  if (!raw || typeof raw !== 'object') return null;
  let type = String(raw.type || raw.action || raw.step || '').replace(/[\s_-]/g, '').toLowerCase();
  const canonical = STEP_TYPES.find((entry) => entry.type.toLowerCase() === type);
  if (canonical) type = canonical.type;
  else type = ALIASES[type] || null;
  if (!type || !TYPE_SET.has(type)) {
    if (String(raw.type || '').toLowerCase() === 'screenshot') type = 'screenshot';
    else return null;
  }
  const params = { ...(raw.params || {}) };
  const pick = (...keys) => keys.map((k) => raw[k]).find((v) => v !== undefined && v !== null && v !== '');
  const p = (key, ...aliases) => {
    if (params[key] !== undefined) return;
    const v = pick(key, ...aliases);
    if (v !== undefined) params[key] = v;
  };
  p('target', 'app', 'application', 'program', 'path');
  p('args', 'arguments', 'arg');
  p('name', 'element', 'control', 'controlName', 'selector');
  p('url', 'href', 'address');
  p('title', 'windowTitle', 'window', 'windowName', 'titleContains');
  p('x', 'left');
  p('y', 'top');
  p('x1', 'startX', 'fromX');
  p('y1', 'startY', 'fromY');
  p('x2', 'endX', 'toX');
  p('y2', 'endY', 'toY');
  p('question', 'check', 'expectation');
  p('foreground', 'foregroundTitle', 'requiredWindow');
  p('process', 'processName', 'appProcess');
  p('app', 'expectedApp', 'applicationName');
  p('repeat', 'times', 'count');
  p('text', 'value', 'input', 'content', 'message');
  p('keys', 'shortcut', 'combo', 'hotkey');
  p('action', 'clipboardAction');
  p('outputVar', 'var', 'variable', 'saveAs');
  p('instructions', 'extract', 'extraction', 'prompt');
  p('ms', 'delay', 'milliseconds', 'duration');
  p('caption', 'label');
  p('amount', 'lines', 'delta');
  p('filename', 'fileName', 'saveAsFile');
  p('folder', 'directory', 'saveTo');
  p('kind', 'mediaKind', 'fileKind');
  p('urlVar', 'linkVar', 'sourceVar');
  p('id', 'packageId', 'wingetId');
  p('noteTitle', 'notesTitle', 'noteName');
  p('notes', 'observations', 'comments');
  p('maxMB', 'maxSizeMB', 'sizeLimitMB');
  p('question', 'testQuestion', 'expectedState');
  p('state', 'operation', 'windowAction');
  p('toolId', 'tool_id', 'toolID');
  p('toolName', 'tool_name', 'toolLabel');

  if (type === 'key') {
    const modifierHint =
      params.modifier ||
      params.modifiers ||
      params.modifierKey ||
      params.shortcut ||
      params.combo ||
      params.ctrl ||
      params.control ||
      raw.modifier ||
      raw.modifiers ||
      raw.modifierKey ||
      raw.ctrl ||
      raw.control ||
      (raw.shortcut && !String(raw.keys || '').includes('+') ? raw.shortcut : '');
    const keyHint = params.keys ?? raw.keys ?? raw.key;
    if (modifierHint && keyHint) {
      const mod = modifierHint === true ? 'ctrl' : String(modifierHint).replace(/[^a-z]/gi, '');
      const base = Array.isArray(keyHint) ? keyHint.join('+') : String(keyHint);
      if (mod && base && !/[+^%#]/.test(base)) {
        try {
          const combined = normalizeShortcutKeys(`${mod}+${base}`);
          if (combined.length) params.keys = combined;
        } catch {}
      }
    }
  }
  if (type === 'key' && params.keys !== undefined) {
    try {
      const normalized = normalizeShortcutKeys(params.keys);
      if (normalized.length) params.keys = normalized;
    } catch {
      // Keep the raw value so execution reports the exact bad shortcut.
    }
  }

  if (type === 'runTool') {
    // Store the concrete id: a name alone cannot be executed.
    const tool = resolveToolRef(params);
    if (tool) {
      params.toolId = tool.id;
      params.toolName = tool.name;
    }
  }

  if (type === 'doubleClick') params.clicks = 2;
  if (type === 'wait' && params.ms === undefined) {
    const namedMs = String(raw.name || raw.label || '').match(/\b(\d+)\s*ms\b/i);
    params.ms = namedMs ? Math.max(0, Math.min(600000, Number(namedMs[1]))) : 1000;
  }
  if (type === 'waitFor') {
    if (!params.kind) params.kind = 'window';
    if (!params.mode) params.mode = 'present';
    if (!params.value) params.value = params.title || params.process || '';
    if (params.timeoutMs === undefined) params.timeoutMs = stepTimeout(raw);
    if (params.intervalMs === undefined) params.intervalMs = 1000;
  }
  if (type === 'screenshot' && !params.caption) params.caption = `Screenshot after step ${index + 1}`;
  if (type === 'openUrl' && !params.url) params.url = 'https://example.com';
  if (type === 'expect' && !params.kind) params.kind = 'window';
  if (type === 'expect' && params.value === undefined) params.value = params.title || params.process || '';
  if (type === 'verifyScreen' && !params.question) params.question = params.title ? `Does the screen clearly show ${params.title}?` : 'Does the screen show the expected app or page in the expected state?';
  if (type === 'verifyScreen' && params.app && !params.title) params.title = params.app;
  if (type === 'verifyPlayback') {
    if (!params.title) params.title = 'YouTube video';
    if (params.intervalMs === undefined) params.intervalMs = 4000;
    if (params.minConfidence === undefined) params.minConfidence = 0.7;
  }
  if (type === 'clickElement') {
    if (!params.window && params.title) params.window = params.title;
    if (!params.name) {
      params.name = deriveElementLabel(raw.element || raw.label || raw.target || raw.text || raw.name || '');
    }
  }
  if (type === 'clipboard') {
    if (!params.action) params.action = 'copy';
    if (!params.outputVar) params.outputVar = 'clipboardText';
  }
  if (type === 'aiExtract') {
    if (!params.source) params.source = 'clipboard';
    if (!params.outputVar) params.outputVar = 'extractedText';
  }
  if (type === 'mediaHold') {
    if (!params.title) params.title = 'YouTube';
    if (params.bufferMs === undefined) params.bufferMs = 5000;
    if (params.checkMs === undefined) params.checkMs = 5000;
    if (params.stallMs === undefined) params.stallMs = 30000;
    if (params.adGraceMs === undefined) params.adGraceMs = 180000;
    if (params.maxMs === undefined) params.maxMs = 900000;
  }
  if (type === 'launchApp') {
    const target = String(params.target || '').trim();
    // A window title (spaces, no path, no extension) is not an executable.
    if (target && !/[\\/]/.test(target) && !/\.\w+$/.test(target) && /\s/.test(target)) {
      type = 'focusWindow';
      params.title = target;
      delete params.target;
    }
  }
  if (type === 'openUrl' && params.url) params.url = normalizeUrlValue(params.url);
  if (type === 'windowAction') {
    if (!params.action) params.action = String(params.state || params.operation || 'minimize').toLowerCase();
    if (!['minimize', 'maximize', 'restore', 'close'].includes(params.action)) params.action = 'minimize';
    if (!params.title && !params.process && params.value) params.title = String(params.value);
  }
  if (type === 'dragCopy') {
    if (!params.outputVar) params.outputVar = 'selectedText';
    if (params.minChars === undefined) params.minChars = 1;
  }
  if (type === 'drag') {
    if (params.x1 === undefined) params.x1 = params.x ?? 400;
    if (params.y1 === undefined) params.y1 = params.y ?? 300;
    if (params.x2 === undefined) params.x2 = params.x1 + 200;
    if (params.y2 === undefined) params.y2 = params.y1;
  }

  return {
    id: uid('stp'),
    type,
    name: String(raw.name || raw.label || describeType(type)).slice(0, 80),
    params,
    timeoutMs: Number(raw.timeoutMs) || 15000,
    optional: Boolean(raw.optional),
    condition: raw.condition ? String(raw.condition).slice(0, 80) : null,
  };
}

/**
 * Normalize model-supplied steps through the same schema the planner uses.
 * `align:false` keeps a small repair sequence exactly as supplied while still
 * validating types, defaults and shortcut syntax.
 */
export function normalizePlanSteps(rawSteps, goal = '', appContext = {}, { align = true } = {}) {
  const normalized = (Array.isArray(rawSteps) ? rawSteps : [])
    .map((step, index) => normalizeStep(step, index))
    .filter(Boolean);
  if (!align) return normalized;
  return alignPlanToGoal(normalized, String(goal || ''), appContext).steps;
}

function describeType(type) {
  return STEP_TYPES.find((s) => s.type === type)?.label || type;
}

function stepTimeout(raw) {
  const n = Number(raw?.timeoutMs);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 600000) : 30000;
}

function normalizeUrlValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) return `https://${raw}`;
  return raw;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsApp(goal, name) {
  const needle = String(name || '').trim();
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`, 'i').test(String(goal || ''));
}

/** Pick the app the goal actually names, preferring a running window. */
export function findGoalApp(goal, context = {}) {
  const candidates = [];
  for (const win of context.windows || []) {
    if (win.process) candidates.push({ name: win.process, process: win.process, window: win.title, version: win.version || '' });
  }
  for (const app of context.apps || []) {
    if (app.name) candidates.push({ name: app.name, process: '', window: '' });
  }
  const unique = candidates.filter(
    (entry, index, all) =>
      entry.name &&
      all.findIndex((other) => other.name.toLowerCase() === entry.name.toLowerCase()) === index
  );
  const named = unique
    .filter((entry) => mentionsApp(goal, entry.name) || mentionsApp(goal, entry.window))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return named;

  const phrase = String(goal || '').match(
    /\b(?:open|launch|start|use|switch\s+to|go\s+to)\s+(?:the\s+)?([a-z][\w .+#-]{0,30}?)(?=\s+(?:and|then|to|for|with)\b|[,.;]|$)/i
  );
  if (phrase) {
    const name = phrase[1].trim();
    if (name && !/^(app|application|browser|window|file|document|program)$/i.test(name)) {
      const known = unique.find(
        (entry) => entry.name.toLowerCase() === name.toLowerCase() || entry.process.toLowerCase() === name.toLowerCase()
      );
      return known || { name, process: '', window: '' };
    }
  }
  return null;
}

function replaceNotepad(step, app) {
  if (!app || /notepad/i.test(app.name) || !/notepad/i.test(JSON.stringify(step))) return false;
  let changed = false;
  const replace = (value) => {
    if (typeof value !== 'string' || !/notepad/i.test(value)) return value;
    changed = true;
    return value.replace(/notepad(\.exe)?/gi, app.name);
  };
  step.name = replace(step.name);
  for (const [key, value] of Object.entries(step.params || {})) {
    step.params[key] = replace(value);
  }
  if (['launchApp', 'focusWindow', 'waitFor', 'expect', 'verifyScreen', 'clickElement'].includes(step.type)) {
    if (step.type === 'launchApp') step.params.target = step.params.target || app.name;
    if (step.type === 'focusWindow') {
      step.params.title = step.params.title || app.name;
      if (app.process) step.params.process = app.process;
    }
    if (step.type === 'waitFor' && !step.params.value) step.params.value = app.name;
    if (step.type === 'expect' && !step.params.value) step.params.value = app.name;
    if (step.type === 'clickElement' && !step.params.window) step.params.window = app.name;
    if (step.type === 'verifyScreen') {
      step.params.app = step.params.app || app.name;
      step.params.title = step.params.title || app.name;
    }
  }
  return changed;
}

/**
 * Small models fall back to Notepad from their training examples. If the goal
 * never says Notepad, replace that substitution with the app the user named.
 * Foreground guards are then carried forward so typing/shortcuts cannot land in
 * whatever window happens to be in front.
 */
export function alignPlanToGoal(steps, goal, context = {}) {
  const app = findGoalApp(goal, context);
  const notepadAllowed = /\bnotepad\b/i.test(String(goal || ''));
  let corrected = false;
  if (app && !notepadAllowed && !/notepad/i.test(app.name)) {
    for (const step of steps) corrected = replaceNotepad(step, app) || corrected;
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const p = step.params || {};
    if (step.type === 'clickElement') {
      const label = String(p.name || '').trim();
      if (!label || /^(?:ui\s+element|element|control|button|click\s+ui\s+element)\b/i.test(label)) {
        // The model emitted a placeholder instead of a visible control. A
        // placeholder click is worse than no click: drop it rather than click
        // an arbitrary node.
        steps.splice(i, 1);
        corrected = true;
        continue;
      }
    }
    if (['click', 'doubleClick', 'rightClick', 'move'].includes(step.type)) {
      const x = Number(p.x);
      const y = Number(p.y);
      const valid = Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0;
      if (!valid && step.type !== 'move') {
        // A model often knows the control name but not its pixel position. Keep
        // the action and let UI Automation (then the vision fallback) find it.
        const label = String(p.name || p.target || p.text || '')
          .replace(/^(?:click|tap|press|double[-\s]?click|right[-\s]?click|select|open)\s+/i, '')
          .trim();
        if (label) {
          const originalType = step.type;
          step.type = 'clickElement';
          step.params = {
            ...p,
            window: p.window || p.foreground || app?.name || '',
            name: label,
            button: originalType === 'rightClick' ? 'right' : p.button || 'left',
            clicks: originalType === 'doubleClick' ? 2 : 1,
            visionFallback: p.visionFallback ?? true,
          };
          step.name = step.name || `Click ${label}`;
          corrected = true;
          continue;
        }
      }
      if (!valid) {
        // `move` without a target is a no-op; a click without a name or point
        // has no executable meaning. Drop only that truly empty action.
        steps.splice(i, 1);
        corrected = true;
        continue;
      }
    }
    if (step.type === 'focusWindow' && !String(p.title || p.process || '').trim()) {
      steps.splice(i, 1);
      corrected = true;
      continue;
    }
    if (step.type === 'launchApp' && !String(p.target || '').trim()) {
      steps.splice(i, 1);
      corrected = true;
      continue;
    }
    if (step.type === 'key' && !(Array.isArray(p.keys) ? p.keys.length : String(p.keys || '').trim())) {
      steps.splice(i, 1);
      corrected = true;
      continue;
    }
    if (step.type === 'runTool') {
      const tool = resolveToolRef(p);
      if (!tool) {
        steps.splice(i, 1);
        corrected = true;
        continue;
      }
      // A step that named its tool by name must carry the id execution reads.
      p.toolId = tool.id;
      p.toolName = tool.name;
    }
    if (step.type === 'type' && !String(p.text || '').trim() && !String(p.textVar || '').trim()) {
      steps.splice(i, 1);
      corrected = true;
      continue;
    }
    if ((step.type === 'waitFor' || step.type === 'expect') && !String(p.value || '').trim()) {
      steps.splice(i, 1);
      corrected = true;
    }
  }
  if (!steps.some((step) => step.type === 'type')) {
    const request = inferRequestText(goal);
    const inputIndex = steps.findIndex((step) => ['key', 'clipboard', 'aiExtract'].includes(step.type));
    if (request && inputIndex >= 0) {
      const typeStep = normalizeStep({
        type: 'type',
        name: 'Enter the request',
        params: { text: request, foreground: app?.name || '' },
      });
      const hasEnter = steps.some((step) => {
        const keys = step.params?.keys;
        return JSON.stringify(keys || '').toLowerCase().includes('enter');
      });
      steps.splice(
        inputIndex,
        0,
        typeStep
      );
      if (!hasEnter) {
        steps.splice(
          inputIndex + 1,
          0,
          normalizeStep({
            type: 'key',
            name: 'Send the request',
            params: { keys: ['{ENTER}'], foreground: app?.name || '' },
          })
        );
      }
      corrected = true;
    }
  }
  const requestedText = inferRequestText(goal);
  const requestTypeIndex = steps.findIndex((step) => {
    if (step.type !== 'type' || !requestedText) return false;
    return String(step.params?.text || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase() ===
      requestedText.replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  });
  const hasEnterStep = steps.some((step) => JSON.stringify(step.params?.keys || '').toLowerCase().includes('enter'));
  if (requestTypeIndex >= 0 && !hasEnterStep) {
    steps.splice(
      requestTypeIndex + 1,
      0,
      normalizeStep({
        type: 'key',
        name: 'Send the request',
        params: { keys: ['{ENTER}'], foreground: steps[requestTypeIndex].params?.foreground || app?.name || '' },
      })
    );
    corrected = true;
  }
  let lastWindow = '';
  for (const step of steps) {
    const p = step.params || {};
    if (step.type === 'focusWindow') lastWindow = p.title || p.process || lastWindow;
    if (step.type === 'clickElement' && p.window) lastWindow = p.window;
    if (
      step.type === 'verifyScreen' &&
      app &&
      !notepadAllowed &&
      !p.app &&
      mentionsApp(`${p.question || ''} ${p.title || ''} ${step.name || ''}`, app.name)
    ) {
      p.app = app.name;
      p.title = p.title || app.name;
    }
    if (['type', 'key', 'clipboard', 'drag', 'scroll', 'click'].includes(step.type)) {
      const explicit = typeof p.foreground === 'string' ? p.foreground.trim() : '';
      if (!explicit && (p.foreground === true || !p.foreground)) {
        const guard = p.window || lastWindow || (app && !notepadAllowed ? app.name : '');
        if (guard) p.foreground = guard;
      }
    }
  }
  if (app && !notepadAllowed && !/notepad/i.test(app.name)) {
    const appInPlan = steps.some((step) =>
      JSON.stringify([step.params, step.name]).toLowerCase().includes(app.name.toLowerCase())
    );
    if (!appInPlan && steps.some((step) => ['type', 'key', 'clipboard'].includes(step.type))) {
      steps.unshift(
        normalizeStep({
          type: 'focusWindow',
          name: `Focus ${app.name}`,
          params: { title: app.name, process: app.process || '' },
        })
      );
      corrected = true;
    }
  }
  const wantsTextFile = /\b(text file|\.txt|notepad)\b/i.test(String(goal || ''));
  if (/\b(copy|select all|response|answer)\b/i.test(String(goal || '')) && !steps.some(isCopyStep)) {
    steps.push(
      normalizeStep({
        type: 'clipboard',
        name: 'Copy the response',
        params: { action: 'copyAll', outputVar: 'clipboardText', foreground: app?.name || '' },
      })
    );
    corrected = true;
  }
  if (wantsTextFile && !/\bword\b/i.test(String(goal || ''))) {
    for (const step of steps) {
      if (/microsoft word|winword|microsoft\.?\s*notes?/i.test(JSON.stringify([step.name, step.params]))) {
        step.name = step.name.replace(/microsoft word|winword|microsoft\.?\s*notes?/gi, 'Notepad');
        for (const [key, value] of Object.entries(step.params || {})) {
          if (typeof value === 'string') step.params[key] = value.replace(/microsoft word|winword|microsoft\.?\s*notes?/gi, 'Notepad');
        }
        if (step.type === 'focusWindow' && /notepad/i.test(step.params?.title || '')) {
          step.params.process = 'Notepad';
        }
        corrected = true;
      }
    }
    const firstNotepad = steps.findIndex(
      (step) => step.type === 'focusWindow' && /notepad/i.test(`${step.params?.title || ''} ${step.params?.process || ''}`)
    );
    const hasLaunch = steps.some((step) => step.type === 'launchApp' && /notepad/i.test(step.params?.target || ''));
    if (firstNotepad >= 0 && !hasLaunch) {
      steps.splice(
        firstNotepad,
        0,
        normalizeStep({ type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } }),
        normalizeStep({ type: 'wait', name: 'Wait for Notepad', params: { ms: 800 } })
      );
      corrected = true;
    }
  }
  if (!/https?:\/\//i.test(String(goal || '')) && app?.window) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === 'openUrl') {
        steps.splice(i, 1);
        corrected = true;
      }
    }
  }
  if (!/\b(drag|highlight|draw|resize)\b/i.test(String(goal || ''))) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === 'drag') {
        steps.splice(i, 1);
        corrected = true;
      }
    }
  }
  const copyIndex = steps.findIndex(
    (step) =>
      (step.type === 'clipboard' && ['copy', 'copyall', 'cut'].includes(String(step.params?.action || '').toLowerCase())) ||
      (step.type === 'key' && JSON.stringify(step.params?.keys || '').includes('^c'))
  );
  if (copyIndex >= 0 && /\b(response|answer|extract)\b/i.test(String(goal || '')) && !steps.some((step) => step.type === 'aiExtract')) {
    steps.splice(
      copyIndex + 1,
      0,
      normalizeStep({
        type: 'aiExtract',
        name: 'Extract the response',
        params: {
          source: 'clipboard',
          instructions: `Extract only the answer or response requested by this goal, not the prompt or app chrome: ${goal}`,
          outputVar: 'extractedText',
        },
      })
    );
    corrected = true;
  }
  const extractIndex = steps.findIndex((step) => step.type === 'aiExtract');
  const copyStillThere = steps.findIndex(
    (step) =>
      (step.type === 'clipboard' && ['copy', 'copyall', 'cut'].includes(String(step.params?.action || '').toLowerCase())) ||
      (step.type === 'key' && JSON.stringify(step.params?.keys || '').includes('^c'))
  );
  const hasNotepadDestination = steps.some(
    (step) =>
      (step.type === 'launchApp' && /notepad/i.test(step.params?.target || '')) ||
      (step.type === 'focusWindow' && /notepad/i.test(`${step.params?.title || ''} ${step.params?.process || ''}`))
  );
  if (wantsTextFile && !hasNotepadDestination && (extractIndex >= 0 || copyStillThere >= 0)) {
    const insertAt = extractIndex >= 0 ? extractIndex + 1 : copyStillThere + 1;
    steps.splice(
      insertAt,
      0,
      normalizeStep({ type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } }),
      normalizeStep({ type: 'wait', name: 'Wait for Notepad', params: { ms: 800 } }),
      normalizeStep({
        type: 'focusWindow',
        name: 'Focus Notepad',
        params: { title: 'Notepad', process: 'Notepad' },
      }),
      normalizeStep({
        type: 'clipboard',
        name: 'Paste the extracted response',
        params: { action: 'paste', foreground: 'Notepad', ...(extractIndex >= 0 ? { textVar: 'extractedText' } : {}) },
      })
    );
    corrected = true;
  }
  if (wantsTextFile && hasNotepadDestination) {
    const notepadFocus = steps.map((step, index) => ({ step, index })).filter(
      ({ step }) => step.type === 'focusWindow' && /notepad/i.test(`${step.params?.title || ''} ${step.params?.process || ''}`)
    ).pop();
    const hasNotepadPaste = steps.some(
      (step) =>
        step.type === 'clipboard' &&
        String(step.params?.action || '').toLowerCase() === 'paste' &&
        /notepad/i.test(`${step.params?.foreground || ''} ${step.name || ''}`)
    );
    if (notepadFocus && !hasNotepadPaste) {
      steps.splice(
        notepadFocus.index + 1,
        0,
        normalizeStep({
          type: 'clipboard',
          name: 'Paste the extracted response',
          params: {
            action: 'paste',
            foreground: 'Notepad',
            ...(extractIndex >= 0 ? { textVar: 'extractedText' } : {}),
          },
        })
      );
      corrected = true;
    }
  }
  const hasClipboardPaste = steps.some(
    (step) => step.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'paste'
  );
  if (hasClipboardPaste) {
    for (const step of steps) {
      if (step.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'paste' && step.params?.text == null && !step.params?.textVar) {
        step.params.textVar = 'extractedText';
      }
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].type === 'key' && JSON.stringify(steps[i].params?.keys || '').includes('^v')) {
        steps.splice(i, 1);
        corrected = true;
      }
    }
    const pastes = [];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].type === 'clipboard' && String(steps[i].params?.action || '').toLowerCase() === 'paste') pastes.push(i);
    }
    if (pastes.length > 1) {
      const keep =
        pastes.find((index) => /notepad|text file/i.test(`${steps[index].params?.foreground || ''} ${steps[index].name || ''}`)) ??
        pastes[pastes.length - 1];
      for (let i = pastes.length - 1; i >= 0; i--) {
        if (pastes[i] !== keep) {
          steps.splice(pastes[i], 1);
          corrected = true;
        }
      }
    }
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.type === 'openUrl' && /^https?:\/\/example\.com\/?$/i.test(step.params?.url || '') && !/example\.com/i.test(String(goal || ''))) {
      steps.splice(i, 1);
      corrected = true;
      continue;
    }
    if (
      step.type === 'clipboard' &&
      String(step.params?.action || '').toLowerCase() === 'paste' &&
      String(step.params?.textVar || '') === 'extractedText' &&
      !steps.some((candidate) => candidate.type === 'aiExtract' || isCopyStep(candidate))
    ) {
      steps.splice(i, 1);
      corrected = true;
    }
  }
  const wantsTextFileSave = /\b(?:save|write|create)\b/i.test(String(goal || '')) && /\b(?:text file|\.txt|desktop)\b/i.test(String(goal || ''));
  if (wantsTextFileSave && !steps.some((step) => step.type === 'writeTextFile')) {
    const typed = [...steps].reverse().find((step) => step.type === 'type' && String(step.params?.text || '').trim());
    const body = String(typed?.params?.text || inferRequestText(goal) || 'Saved by Sightline');
    const insertAt = steps.findIndex((step) => step.type === 'verifyScreen');
    steps.splice(
      insertAt >= 0 ? insertAt : steps.length,
      0,
      normalizeStep({
        type: 'writeTextFile',
        name: 'Save the text file',
        params: { location: 'desktop', path: outputFileName('', goal), text: body, overwrite: false },
      })
    );
    corrected = true;
  }
  const seenKeys = new Set();
  for (let i = steps.length - 1; i > 0; i--) {
    if (steps[i].type === 'wait' && steps[i - 1].type === 'wait') {
      steps[i - 1].params.ms = Math.min(
        10000,
        Math.max(0, Number(steps[i - 1].params?.ms) || 0) + Math.max(0, Number(steps[i].params?.ms) || 0)
      );
      steps.splice(i, 1);
      corrected = true;
    }
  }
  if (enforceCopyExtractOrder(steps, app)) corrected = true;
  for (let i = steps.length - 1; i > 0; i--) {
    if (steps[i].type === 'wait' && steps[i - 1].type === 'wait') {
      steps[i - 1].params.ms = Math.min(
        10000,
        Math.max(0, Number(steps[i - 1].params?.ms) || 0) + Math.max(0, Number(steps[i].params?.ms) || 0)
      );
      steps.splice(i, 1);
      corrected = true;
    }
  }
  const unique = [];
  for (const step of steps) {
    if (step.type === 'key') {
      const signature = `${JSON.stringify(step.params?.keys || [])}|${step.params?.foreground || ''}`;
      if (seenKeys.has(signature)) {
        corrected = true;
        continue;
      }
      seenKeys.add(signature);
    }
    const previous = unique[unique.length - 1];
    if (
      step.type === 'clickElement' &&
      previous?.type === 'clickElement' &&
      String(previous.params?.name || '') === String(step.params?.name || '') &&
      String(previous.params?.window || '') === String(step.params?.window || '')
    ) {
      // Repeated identical control clicks are a planning loop, not a task.
      corrected = true;
      continue;
    }
    unique.push(step);
  }
  for (let i = unique.length - 1; i > 0; i--) {
    if (unique[i].type === 'wait' && unique[i - 1].type === 'wait') {
      unique[i - 1].params.ms = Math.min(
        30000,
        Math.max(0, Number(unique[i - 1].params?.ms) || 0) + Math.max(0, Number(unique[i].params?.ms) || 0)
      );
      unique.splice(i, 1);
      corrected = true;
    }
  }
  // Never truncate a plan to an arbitrary step count. Multi-phase desktop tasks
  // legitimately need 20-30 steps, and silently dropping the middle makes the
  // remaining steps run against the wrong screen state. Only redundant waits
  // are merged above; every distinct action is preserved in its original order.
  for (const step of unique) {
    if (
      step.type === 'downloadMedia' &&
      /video|movie|clip/i.test(step.params?.kind || '') &&
      /\.(?:exe|msi|zip|7z)(?:[?#]|$)/i.test(step.params?.url || '')
    ) {
      // A setup executable is not a video. Keep the download phase executable
      // by using a real public sample clip when the model supplied an installer.
      step.params.url = SAMPLE_VIDEO_URL;
      step.params.filename = step.params.filename || 'sample-video.mp4';
      step.params.kind = 'video';
      corrected = true;
    }
    if (step.type === 'playMedia' && !String(step.params?.title || '').trim()) {
      step.params.title = 'VLC';
      corrected = true;
    }
  }
  const hasSaveStep = unique.some(
    (step) => step.type === 'key' && JSON.stringify(step.params?.keys || '').toLowerCase().includes('^s')
  );
  if (wantsTextFile && !hasSaveStep) {
    for (const step of unique) {
      if (step.type === 'verifyScreen' && /\b(saved|save|file|desktop)\b/i.test(step.params?.question || '')) {
        step.params.question = 'Does the destination window visibly contain the extracted response text?';
        step.params.title = step.params.title || 'Notepad';
        step.params.app = step.params.app || 'Notepad';
        step.params.caption = step.params.caption || 'Extracted response pasted';
        corrected = true;
      }
    }
  }
  steps.splice(0, steps.length, ...unique);
  return { steps, app, corrected };
}

function appContextText(context = {}) {
  const windows = (context.windows || [])
    .slice(0, 24)
    .map((win) => `- ${win.process}: ${win.title}`)
    .join('\n');
  const apps = (context.apps || [])
    .slice(0, 40)
    .map((app) => `- ${app.name}`)
    .join('\n');
  return `Running windows:\n${windows || '- none detected'}\nInstalled Start-menu apps:\n${apps || '- none detected'}`;
}

/** Recover complete step objects when a model truncates the outer JSON array. */
function salvageSteps(text) {
  const source = String(text || '');
  const out = [];
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf('{', index);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      index = start + 1;
      continue;
    }
    try {
      const obj = JSON.parse(source.slice(start, end + 1));
      if (obj && (obj.type || obj.action || obj.step)) out.push(obj);
    } catch {}
    index = end + 1;
  }
  return out;
}

export function inferRequestText(goal) {
  const text = String(goal || '');
  const quoted = text.match(/\b(?:type|enter|write|ask)\s+["“']([^"”']+)["”']/i);
  if (quoted) return quoted[1].trim();
  const asked = text.match(
    /\bask(?:\s+(?:the\s+)?(?:ai|assistant|chat|model))?\s+(?:about\s+)?(?:["“'])?([^"'”]+?)(?=\s*(?:[,;.]|\b(?:then|than)\b|\band\s+(?:save|copy|select|paste)\b|$))/i
  );
  if (asked) return asked[1].trim();
  const question = text.match(/\b(?:what|who|why|how|when|where)\b[\s\S]*?(?=\s*(?:[,;.]|\b(?:then|than)\b|$))/i);
  return question ? question[0].trim() : '';
}

/**
 * Recognize the common two-app pattern: open/ask in a source app, then save
 * the answer in a destination app. This must be parsed separately because
 * findGoalApp intentionally returns one app and can otherwise pin the whole
 * plan to the destination (for example Notepad).
 */
export function parseGoalIntent(goal, appContext = {}) {
  const text = String(goal || '');
  const sourceMatch = text.match(/\b(?:open|launch|start|use)\s+(?:the\s+)?([a-z][\w .+#-]{1,30}?)(?=\s+(?:and|then|than|to|for|with)\b|[,.;]|$)/i);
  const destinationMatch = text.match(/\b(?:save|store|write|put|paste|copy)\b[\s\S]{0,80}?\b(?:to|in|into|on)\s+(?:the\s+)?([a-z][\w .+#-]{1,30}?)(?=\s+(?:on|at|and|then|than)\b|[,.;]|$)/i);
  const question = inferRequestText(text);
  if (!sourceMatch || !destinationMatch || !question) return null;
  const sourceName = sourceMatch[1].trim();
  const destinationName = destinationMatch[1].trim();
  if (sourceName.toLowerCase() === destinationName.toLowerCase()) return null;
  const source = findGoalApp(`open ${sourceName}`, appContext) || { name: sourceName, process: '' };
  const destination = findGoalApp(`save to ${destinationName}`, appContext) || { name: destinationName, process: '' };
  return {
    goal: text,
    question,
    source,
    destination,
  };
}

function questionSubject(question) {
  const ignored = new Set(['what', 'who', 'why', 'how', 'when', 'where', 'is', 'are', 'was', 'were', 'a', 'an', 'the', 'of', 'to', 'for', 'and', 'in', 'on', 'about', 'do', 'does', 'can', 'could', 'should']);
  const words = String(question || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.find((word) => !ignored.has(word)) || 'answer';
}

function outputFileName(question, goal = '') {
  const subjectText = question || inferRequestText(goal) || '';
  const subject = subjectText ? questionSubject(subjectText) : 'notes';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
  return `${subject}${subjectText ? '-answer' : ''}-${stamp}.txt`;
}

function replaceRememberedSubject(value, intent) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(?:diamond|ruby)\b/gi, questionSubject(intent.question))
    .replace(/kiro-answer\.txt/gi, `${questionSubject(intent.question)}-answer.txt`);
}

/** Adapt a passed Kiro-style sequence to a new question without changing its controls. */
export function adaptTemplateSteps(steps, intent) {
  const filename = outputFileName(intent.question, intent.goal);
  return (steps || []).map((step) => {
    const next = { ...step, params: { ...(step.params || {}) } };
    if (next.type === 'type' && (next.params.text || next.params.textVar)) {
      next.params.text = intent.question;
      next.name = `Ask ${intent.source.name}: ${intent.question}`.slice(0, 120);
      next.params.name = next.name;
    }
    if (next.type === 'aiExtract') {
      next.params.instructions = `Extract only the answer or response requested by this goal, not the prompt or app chrome: ${intent.goal}`;
      next.name = 'Extract the response';
    }
    if (next.type === 'writeTextFile') {
      for (const key of ['target', 'path', 'filename']) {
        if (typeof next.params[key] === 'string') next.params[key] = replaceRememberedSubject(next.params[key], intent);
      }
      next.params.location = 'desktop';
      next.params.path = filename;
      next.params.overwrite = false;
      if (!next.params.textVar) next.params.textVar = 'answer';
      delete next.params.text;
      next.params.noteTitle = `Answer — ${intent.question}`.slice(0, 160);
      next.name = `Save answer to Desktop (${filename})`;
    }
    for (const [key, value] of Object.entries(next.params)) {
      next.params[key] = replaceRememberedSubject(value, intent);
      if (typeof next.params[key] === 'string') {
        next.params[key] = next.params[key].replace(/[A-Za-z0-9_-]+-answer\.txt/gi, filename);
      }
    }
    next.name = replaceRememberedSubject(next.name, intent);
    next.name = next.name.replace(/[A-Za-z0-9_-]+-answer\.txt/gi, filename);
    return next;
  });
}

const STEP_PHASE_ORDER = {
  'source.open': 10,
  'source.focus': 20,
  'source.newChat': 30,
  'source.input': 40,
  'source.question': 50,
  'source.send': 60,
  'source.wait': 70,
  'source.copy': 80,
  'source.extract': 90,
  'source.verify': 100,
  'file.write': 110,
  'destination.open': 120,
  'destination.wait': 130,
  'destination.focus': 140,
  'destination.paste': 150,
  'destination.save': 160,
  'destination.verify': 170,
  'verify.capture': 180,
  other: 190,
};

function stepText(step) {
  return `${step?.name || ''} ${JSON.stringify(step?.params || {})}`.toLowerCase();
}

function mentionsDestination(step, intent) {
  const text = stepText(step);
  const filename = `${questionSubject(intent.question)}-answer.txt`.toLowerCase();
  return [intent.destination?.name, filename, '.txt', 'notepad', 'desktop']
    .filter(Boolean)
    .some((value) => text.includes(String(value).toLowerCase()));
}

function stepPhase(step, intent) {
  const text = stepText(step);
  const destination = mentionsDestination(step, intent);
  const keys = JSON.stringify(step?.params?.keys || step?.params?.key || '').toLowerCase();
  if (step?.type === 'writeTextFile') return 'file.write';
  if (step?.type === 'launchApp') return destination ? 'destination.open' : 'source.open';
  if (step?.type === 'focusWindow') return destination ? 'destination.focus' : 'source.focus';
  if (step?.type === 'waitFor') return destination ? 'destination.wait' : 'source.wait';
  if (step?.type === 'expect') return destination ? 'destination.verify' : 'source.verify';
  if (step?.type === 'verifyScreen') return destination ? 'destination.verify' : 'source.verify';
  if (step?.type === 'screenshot') return 'verify.capture';
  if (step?.type === 'type') return 'source.question';
  if (step?.type === 'wait') return 'source.wait';
  if (step?.type === 'aiExtract') return 'source.extract';
  if (step?.type === 'clipboard') {
    const action = String(step.params?.action || '').toLowerCase();
    if (action === 'paste') return 'destination.paste';
    if (action === 'read') return 'source.extract';
    if (['copy', 'copyall', 'cut', 'clear'].includes(action)) return 'source.copy';
    return 'other';
  }
  if (step?.type === 'clickElement') {
    if (/new\s+(?:session|chat)|new\s+conversation/.test(text)) return 'source.newChat';
    if (/\bcopy\b/.test(text)) return 'source.copy';
    if (/ask a question|chat input|message|prompt/.test(text)) return 'source.input';
    return destination ? 'destination.focus' : 'source.input';
  }
  if (step?.type === 'key') {
    if (keys.includes('enter') || keys.includes('return')) return 'source.send';
    if (keys.includes('^s') || keys.includes('ctrl+s')) return 'destination.save';
    if (keys.includes('^v') || keys.includes('ctrl+v')) return 'destination.paste';
    if (keys.includes('^a') || keys.includes('ctrl+a')) return destination ? 'destination.paste' : 'source.input';
    if (keys.includes('^c') || keys.includes('ctrl+c')) return 'source.copy';
  }
  return 'other';
}

function isActualCopyStep(step) {
  if (step?.type === 'clipboard') return ['copy', 'copyall', 'cut'].includes(String(step.params?.action || '').toLowerCase());
  if (step?.type === 'key') return JSON.stringify(step.params?.keys || '').toLowerCase().includes('^c');
  if (step?.type === 'clickElement') return /\bcopy\b/.test(stepText(step));
  return false;
}

function producedVariable(step) {
  if (step?.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'read') {
    return String(step.params?.outputVar || 'clipboardText');
  }
  if (step?.type === 'aiExtract') return String(step.params?.outputVar || 'extractedText');
  if (step?.type === 'writeTextFile') return String(step.params?.outputVar || '');
  if (step?.type === 'readNote') return String(step.params?.outputVar || 'noteText');
  return '';
}

function backupStepsFor(phase, intent) {
  const filename = `${questionSubject(intent.question)}-answer.txt`;
  const source = intent.source?.name || 'source app';
  const destination = intent.destination?.name || 'Notepad';
  const rows = {
    'source.open': [{ type: 'launchApp', name: `Open ${source}`, params: { target: source } }],
    'source.focus': [{ type: 'focusWindow', name: `Focus ${source}`, params: { title: source, process: intent.source?.process || '' } }],
    'source.input': [{ type: 'clickElement', name: `Click the ${source} input`, params: { window: source, name: 'Ask a question', fallbackX: 1067, fallbackY: 587, visionFallback: true } }],
    'source.question': [{ type: 'type', name: `Ask ${source}: ${intent.question}`, params: { text: intent.question, foreground: source } }],
    'source.send': [{ type: 'key', name: 'Send question', params: { keys: ['{ENTER}'], foreground: source } }],
    'source.copy': [{ type: 'clipboard', name: 'Copy the visible answer', params: { action: 'copyAll', outputVar: 'clipboardText', foreground: source } }],
    'source.extract': [{ type: 'clipboard', name: 'Read the copied answer', params: { action: 'read', outputVar: 'answer', minChars: 100 } }],
    'file.write': [{ type: 'writeTextFile', name: `Save answer to Desktop (${filename})`, params: { location: 'desktop', path: filename, textVar: 'answer', overwrite: false } }],
    'destination.open': [{ type: 'launchApp', name: `Open saved answer in ${destination}`, params: { target: `C:/Users/Dan/Desktop/${filename}` } }],
    'destination.focus': [{ type: 'focusWindow', name: `Focus ${destination}`, params: { title: filename } }],
    'destination.paste': [{ type: 'clipboard', name: `Paste answer into ${destination}`, params: { action: 'paste', textVar: 'answer', foreground: filename } }],
    'destination.save': [{ type: 'key', name: `Save ${destination} file`, params: { keys: ['^s'], foreground: filename } }],
  };
  return (rows[phase] || []).map((step, index) => normalizeStep(step, index)).filter(Boolean);
}

/**
 * Assemble a two-app answer flow phase by phase. Each candidate comes from a
 * proven sequence, but every step is checked against what was already produced.
 * A write/copy/paste that consumes missing text is rejected instead of replayed.
 */
export function validateStepSequence(steps, intent, { templateName = '' } = {}) {
  const rejected = [];
  const decisions = [];
  const kept = [];
  const produced = new Set();
  let copied = false;
  let typed = false;
  let sent = false;
  let fileWritten = false;
  let destinationOpen = false;
  let pasted = false;
  let saved = false;

  for (const [index, raw] of (steps || []).entries()) {
    const step = { ...raw, params: { ...(raw.params || {}) } };
    const phase = stepPhase(step, intent);
    const variable = String(step.params?.textVar || '').trim();
    let reason = '';

    if (phase === 'file.write') {
      if (!variable) reason = 'writeTextFile needs a textVar produced by a previous source step.';
      else if (!produced.has(variable)) reason = `writeTextFile consumes "${variable}" before any step produces it.`;
    }
    if (phase === 'source.copy' && isActualCopyStep(step) && intent.question && (!typed || !sent)) {
      reason = 'copy step appears before the question was typed and sent.';
    }
    if (phase === 'source.extract' && !copied && !produced.size) {
      reason = 'extract step appears before any copy step.';
    }
    if (phase === 'destination.open' && !fileWritten && !produced.size) {
      reason = 'destination app opens before an answer was captured.';
    }
    if (phase === 'destination.focus' && !destinationOpen && !fileWritten) {
      reason = 'destination focus appears before the destination is open or written.';
    }
    if (phase === 'destination.paste' && !copied && !produced.size) {
      reason = 'paste appears before an answer was copied or produced.';
    }
    if (phase === 'destination.save' && !destinationOpen && !pasted) {
      reason = 'save appears before the destination paste.';
    }
    if (phase === 'source.send' && !typed) {
      reason = 'send appears before the question was typed.';
    }

    if (reason) {
      rejected.push({ index, phase, type: step.type, name: step.name, reason });
      continue;
    }

    if (isActualCopyStep(step)) copied = true;
    const output = producedVariable(step);
    if (output) produced.add(output);
    if (phase === 'file.write') fileWritten = true;
    if (phase === 'destination.open' || phase === 'destination.focus') destinationOpen = true;
    if (phase === 'source.question') typed = true;
    if (phase === 'source.send') sent = true;
    if (phase === 'destination.paste') pasted = true;
    if (phase === 'destination.save') saved = true;
    decisions.push({
      index: kept.length,
      phase,
      type: step.type,
      name: step.name,
      confidence: 0.92,
      why: `Matches the ${templateName || 'validated'} flow and its preconditions hold.`,
    });
    kept.push(step);
  }

  const present = new Set(kept.map((step) => stepPhase(step, intent)));
  const missing = [];
  const fallbackContext = { ...intent, question: intent.question };
  const add = (phase, reason) => {
    if (present.has(phase)) return;
    const added = backupStepsFor(phase, fallbackContext);
    if (!added.length) return;
    missing.push(phase);
    const rank = STEP_PHASE_ORDER[phase] || STEP_PHASE_ORDER.other;
    let at = kept.findIndex((step) => (STEP_PHASE_ORDER[stepPhase(step, intent)] || STEP_PHASE_ORDER.other) > rank);
    if (at < 0) at = kept.length;
    for (const step of added) {
      decisions.push({ phase, type: step.type, name: step.name, confidence: 0.55, why: reason, added: true });
    }
    kept.splice(at, 0, ...added);
    present.add(phase);
  };

  if (intent.question && !present.has('source.question')) add('source.question', 'The goal asks a question but the candidate flow had no input step.');
  if (intent.source && !present.has('source.focus')) add('source.focus', 'The source app needs a foreground focus before typing.');
  if (intent.source && !present.has('source.input')) add('source.input', 'The question needs a visible input control in the source app.');
  if (intent.question && !present.has('source.send')) add('source.send', 'A typed question needs an explicit send action.');
  if (!present.has('source.copy')) add('source.copy', 'The answer must be copied before it can be saved or pasted.');
  if (!present.has('source.extract')) add('source.extract', 'The copied text needs a readable variable before a file write.');
  if (!present.has('file.write')) add('file.write', 'The goal asks to save the answer, so a file write is required.');
  if (!present.has('destination.open')) add('destination.open', 'Saving in a destination app requires opening that app or file.');
  if (!present.has('destination.focus')) add('destination.focus', 'The destination needs foreground focus before paste.');
  if (!present.has('destination.paste')) add('destination.paste', 'The saved answer must be pasted into the destination.');
  if (!present.has('destination.save')) add('destination.save', 'The destination app needs an explicit save action.');

  const critical = ['source.question', 'source.send', 'source.copy', 'source.extract', 'file.write', 'destination.open', 'destination.paste', 'destination.save'];
  const criticalPresent = critical.filter((phase) => present.has(phase)).length;
  const confidence = Math.max(
    0.25,
    Math.min(0.99, 0.58 + (criticalPresent / critical.length) * 0.38 - rejected.length * 0.06 - missing.length * 0.02)
  );
  const backups = [...new Set([...present])]
    .filter((phase) => phase.startsWith('source.') || phase.startsWith('destination.') || phase === 'file.write')
    .map((phase) => ({
      phase,
      reason: `Use if the primary ${phase} control fails or reports the wrong state.`,
      steps: backupStepsFor(phase, intent),
    }))
    .filter((backup) => backup.steps.length);

  const phaseAt = (phase) => kept.findIndex((step) => stepPhase(step, intent) === phase);
  const copyAt = Math.min(...['source.copy', 'source.extract'].map(phaseAt).filter((index) => index >= 0));
  const writeAt = phaseAt('file.write');
  const destinationAt = phaseAt('destination.open');
  const pasteAt = phaseAt('destination.paste');
  const saveAt = phaseAt('destination.save');
  const preflight = [
    {
      check: 'copy-before-write',
      ok: copyAt >= 0 && writeAt >= 0 && copyAt < writeAt,
      reason: 'The answer must exist before writeTextFile consumes it.',
    },
    {
      check: 'write-before-destination',
      ok: writeAt >= 0 && destinationAt >= 0 && writeAt < destinationAt,
      reason: 'Do not open the destination app before the answer file exists.',
    },
    {
      check: 'paste-after-copy',
      ok: copyAt >= 0 && pasteAt >= 0 && copyAt < pasteAt,
      reason: 'Copy or extract must happen before a paste.',
    },
    {
      check: 'save-after-paste',
      ok: pasteAt >= 0 && saveAt >= 0 && pasteAt < saveAt,
      reason: 'Save the destination after the answer has been pasted.',
    },
    {
      check: 'reject-early-write',
      ok: !rejected.some((item) => item.phase === 'file.write'),
      reason: 'A write step that arrived without its text variable is not probable.',
    },
  ];

  return {
    steps: kept,
    decisions,
    rejected,
    missingPhases: missing,
    backups,
    preflight,
    confidence: Math.round(confidence * 100) / 100,
    templateName,
    stepwise: true,
    typed,
    sent,
    copied,
    fileWritten,
    destinationOpen,
    pasted,
    saved,
  };
}

function planFromTemplate(goal, appContext) {
  const intent = parseGoalIntent(goal, appContext);
  if (!intent) return null;
  const template = recallWorkflowTemplate({
    apps: [intent.source.name, intent.destination.name],
    versions: {
      [intent.source.name]: intent.source.version || '',
      [intent.destination.name]: intent.destination.version || '',
    },
    limit: 1,
  });
  if (!template) {
    if (/kiro/i.test(intent.source.name) && /notepad/i.test(intent.destination.name)) {
      const filename = outputFileName(intent.question, intent.goal);
      const steps = [
        { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
        { type: 'expect', name: 'Assert Kiro is foreground', params: { kind: 'foreground', value: 'Kiro' } },
        { type: 'clickElement', name: 'Start a new Kiro chat only when the question is absent', params: { window: 'Kiro', name: 'New Session', controlType: 'Button', fallbackX: 1781, fallbackY: 132, visionFallback: true }, condition: 'newChat' },
        { type: 'focusWindow', name: 'Refocus Kiro after opening chat', params: { title: 'Kiro' } },
        { type: 'clickElement', name: 'Click the Kiro chat input', params: { window: 'Kiro', name: 'Ask a question', fallbackX: 1067, fallbackY: 587, visionFallback: true, preferRight: true } },
        { type: 'focusWindow', name: 'Refocus Kiro before typing', params: { title: 'Kiro' } },
        { type: 'key', name: 'Clear chat input', params: { keys: ['^a'], foreground: 'Kiro' } },
        { type: 'type', name: `Ask Kiro: ${intent.question}`, params: { text: intent.question, foreground: 'Kiro' } },
        { type: 'key', name: 'Send question', params: { keys: ['{ENTER}'], foreground: 'Kiro' } },
        { type: 'wait', name: 'Wait for Kiro answer', params: { ms: 10000 } },
        { type: 'expect', name: 'Assert Kiro is still foreground', params: { kind: 'foreground', value: 'Kiro' } },
        { type: 'focusWindow', name: 'Refocus Kiro before copying', params: { title: 'Kiro' } },
        { type: 'clipboard', name: 'Clear clipboard before copying', params: { action: 'clear' } },
        { type: 'clickElement', name: 'Copy Kiro answer', params: { window: 'Kiro', name: 'Copy message', controlType: 'Button', preferLast: true, waitMs: 60000, visionFallback: false } },
        { type: 'clipboard', name: 'Capture copied answer', params: { action: 'read', outputVar: 'answer', minChars: 100 } },
        { type: 'writeTextFile', name: `Save answer to Desktop (${filename})`, params: { location: 'desktop', path: filename, textVar: 'answer', overwrite: false, noteTitle: `Answer — ${intent.question}` } },
        { type: 'launchApp', name: 'Open saved answer in Notepad', params: { target: `C:/Users/Dan/Desktop/${filename}` } },
        { type: 'waitFor', name: 'Wait for Notepad', params: { kind: 'window', value: filename, mode: 'present', timeoutMs: 12000, intervalMs: 500 } },
        { type: 'focusWindow', name: 'Focus Notepad', params: { title: filename } },
        { type: 'key', name: 'Select existing Notepad text', params: { keys: ['^a'], foreground: filename } },
        { type: 'key', name: 'Paste answer into Notepad', params: { keys: ['^v'], foreground: filename } },
        { type: 'key', name: 'Save Notepad file', params: { keys: ['^s'], foreground: filename } },
        { type: 'expect', name: 'Assert Notepad is foreground', params: { kind: 'foreground', value: filename } },
        { type: 'screenshot', name: 'Capture final Notepad answer', params: { caption: 'Notepad answer saved' } },
      ].map((step, index) => normalizeStep(step, index)).filter(Boolean);
      const validated = validateStepSequence(steps, intent, { templateName: 'built-in Kiro recipe' });
      return { ...validated, steps: validated.steps, template: null, intent, builtin: true, stepwise: true };
    }
    return null;
  }
  const steps = planStepsFromMemory(template)
    .map((step, index) => normalizeStep(step, index))
    .filter(Boolean);
  if (steps.length < 6) return null;
  const adapted = adaptTemplateSteps(steps, intent);
  const validated = validateStepSequence(adapted, intent, { templateName: template.workflowName });
  return {
    ...validated,
    steps: validated.steps,
    template,
    intent,
    stepwise: true,
  };
}

/** Recover the full operator goal when a workflow description was truncated. */
export function workflowGoal(workflow, run = null) {
  const candidates = [];
  if (workflow?.description) candidates.push(String(workflow.description).trim());
  if (run?.missionId) {
    const mission = db().missions.find((entry) => entry.id === run.missionId);
    if (mission?.goal) candidates.push(String(mission.goal).trim());
  }
  for (const step of [...(workflow?.steps || []), ...(run?.steps || [])]) {
    const instructions = String(step?.params?.instructions || '');
    const match = instructions.match(/app chrome:\s*([\s\S]+)$/i);
    if (match?.[1]) candidates.push(match[1].trim());
  }
  return candidates.filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
}

function isCopyStep(step) {
  return (
    (step.type === 'clipboard' && ['copy', 'copyall', 'cut'].includes(String(step.params?.action || '').toLowerCase())) ||
    (step.type === 'key' && JSON.stringify(step.params?.keys || '').toLowerCase().includes('^c'))
  );
}

function isNotepadStep(step) {
  return /notepad/i.test(`${step.name || ''} ${JSON.stringify(step.params || {})}`);
}

/** Keep source copy → AI extraction → destination paste in that order. */
function enforceCopyExtractOrder(steps, app) {
  const extractIndex = steps.findIndex((step) => step.type === 'aiExtract');
  if (extractIndex < 0) return false;
  const extract = steps[extractIndex];
  if (!String(extract.params?.instructions || '').trim()) {
    extract.params.instructions = 'Extract only the requested answer or response, not the prompt or app interface.';
  }
  const copies = steps.filter(isCopyStep);
  let copy =
    [...copies]
      .reverse()
      .find((step) => step.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'copyall') ||
    copies[copies.length - 1];
  if (!copy) {
    copy = normalizeStep({
      type: 'clipboard',
      name: 'Copy the response',
      params: { action: 'copyAll', outputVar: 'clipboardText', foreground: app?.name || '' },
    });
  }
  const destination = steps.filter(isNotepadStep);
  const source = steps.filter((step) => {
    if (isCopyStep(step) || step.type === 'aiExtract' || destination.includes(step)) return false;
    if (step.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'paste') return false;
    if (step.type === 'key' && JSON.stringify(step.params?.keys || '').toLowerCase().includes('^v')) return false;
    return true;
  });
  for (const step of destination) {
    if (step.type === 'clipboard' && String(step.params?.action || '').toLowerCase() === 'paste') {
      step.params.textVar = step.params.textVar || 'extractedText';
    }
  }
  steps.splice(0, steps.length, ...source, copy, extract, ...destination);
  return true;
}

export function heuristicPlan(goal, appContext = {}) {
  const text = String(goal || '');
  const steps = [];
  const seen = new Set();
  const add = (step) => {
    if (!step) return;
    const sig = JSON.stringify([step.type, step.params]);
    if (seen.has(sig)) return;
    seen.add(sig);
    steps.push(step);
  };

  const appMatch = text.match(
    /\b(?:open|launch|start|use)\s+(?:the\s+)?([a-z][\w .+#-]{1,30}?)(?=\s+(?:and|then|to|for|with)\b|[,.;]|$)/i
  );
  if (appMatch) {
    const phrase = appMatch[1].trim();
    const name = phrase.toLowerCase().replace(/\s+/g, ' ');
    const exe = {
      notepad: 'notepad.exe',
      calculator: 'calc.exe',
      calc: 'calc.exe',
      paint: 'mspaint.exe',
      explorer: 'explorer.exe',
      chrome: 'chrome.exe',
      firefox: 'firefox.exe',
      edge: 'msedge.exe',
      word: 'winword.exe',
      excel: 'excel.exe',
      vscode: 'code',
      terminal: 'wt.exe',
      kiro: 'Kiro',
    }[name];
    const known = findGoalApp(goal, appContext);
    const label = phrase;
    const target = known?.name || exe || phrase;
    add(normalizeStep({ type: 'launchApp', name: `Open ${label}`, params: { target } }));
    add(normalizeStep({ type: 'wait', name: 'Wait for app window', params: { ms: 1500 } }));
    add(
      normalizeStep({
        type: 'focusWindow',
        name: `Focus ${label}`,
        params: { title: name === 'calc' ? 'Calculator' : label, process: known?.process || '' },
      })
    );
  }

  const urlMatch = text.match(/https?:\/\/[^\s"']+/i);
  if (urlMatch) {
    add(normalizeStep({ type: 'openUrl', name: 'Open URL', params: { url: urlMatch[0] } }));
    add(normalizeStep({ type: 'wait', name: 'Wait for page', params: { ms: 2000 } }));
  }

  const clickMatch = text.match(/(double[-\s]?click|right[-\s]?click|click)\D{0,20}(\d{2,4})\s*[,x ]\s*(\d{2,4})/i);
  if (clickMatch) {
    const kind = clickMatch[1].toLowerCase();
    const type = kind.startsWith('double') ? 'doubleClick' : kind.startsWith('right') ? 'rightClick' : 'click';
    add(normalizeStep({ type: 'move', name: `Move to ${clickMatch[2]},${clickMatch[3]}`, params: { x: +clickMatch[2], y: +clickMatch[3] } }));
    add(normalizeStep({ type, name: describeType(type), params: { x: +clickMatch[2], y: +clickMatch[3] } }));
  }

  const typeMatch = text.match(/type\s+["“']([^"”']+)["”']/i);
  if (typeMatch) {
    add(normalizeStep({ type: 'type', name: 'Type text', params: { text: typeMatch[1] } }));
  }

  const shortcutRegex = /\b(?:ctrl|control|ctr|alt|shift|win|cmd)\s*\+\s*(?:[a-z0-9]|enter|escape|esc|tab|space|backspace|delete|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))\b/gi;
  const shortcuts = [...new Set((text.match(shortcutRegex) || []).map((value) => value.toLowerCase()))];
  if (shortcuts.length) {
    let normalized = [];
    try {
      normalized = normalizeShortcutKeys(shortcuts);
    } catch {}
    if (normalized.length) {
      add(normalizeStep({ type: 'key', name: `Press ${shortcuts.join(', ')}`, params: { keys: normalized } }));
    }
  } else if (/\b(select all|copy all|copy the (?:response|text|document))\b/i.test(text)) {
    add(normalizeStep({ type: 'key', name: 'Select all and copy', params: { keys: ['^a', '^c'] } }));
  }
  if (/\b(extract|response|answer)\b/i.test(text) && /\b(copy|select all|save|document)\b/i.test(text)) {
    add(
      normalizeStep({
        type: 'aiExtract',
        name: 'Extract the response',
        params: {
          source: 'clipboard',
          instructions: `Extract only the answer or response requested by this goal, not the prompt or app chrome: ${text}`,
          outputVar: 'extractedText',
        },
        optional: false,
      })
    );
  }

  const waitMatch = text.match(/(?:wait|sleep|pause)\s*(?:for\s*)?(\d+)\s*(ms|milliseconds|s|sec|seconds)?/i);
  if (waitMatch && !appMatch) {
    const amount = Number(waitMatch[1]);
    const ms = /^s|sec/i.test(waitMatch[2] || '') ? amount * 1000 : amount;
    add(normalizeStep({ type: 'wait', name: `Wait ${ms}ms`, params: { ms } }));
  }

  if (steps.length === 0) {
    // A usable skeleton when the goal is too vague to parse.
    add(normalizeStep({ type: 'screenshot', name: 'Capture starting state', params: { caption: 'Starting state' } }));
    add(normalizeStep({ type: 'note', name: 'Describe expected result', params: { text: `Goal: ${text}` } }));
  }

  if (/screenshot|capture|evidence/i.test(text) || steps.length >= 2) {
    add(normalizeStep({ type: 'screenshot', name: 'Capture result', params: { caption: 'Final state' } }));
  }
  return steps;
}

const PLAN_SYSTEM = `You are the workflow planner inside Sightline, a Windows desktop automation console.
Convert the user's goal into an ordered array of executable UI steps. Reply with JSON only, in this shape:
{"steps":[{"type":"focusWindow","name":"Focus the target app","params":{"title":"Exact app or window name","process":"optional process name"},"timeoutMs":15000}]}
Optional step field: "condition":"newChat" marks a step that starts a new chat/session; the runner skips it unless the mission goal asks for a new chat or different topic. Omit condition for normal steps.
Allowed types and params:
- launchApp {target,args?} — app name, executable, shortcut name or document path; args opens a document or passes command-line arguments
- openUrl {url}
- focusWindow {title,process?} — substring of the window title or the process name; never use Notepad as a fallback
- move {x,y}
- click {x,y,button:"left|right|middle",foreground} — foreground optionally refuses to click unless that window title is active
- doubleClick {x,y}
- rightClick {x,y}
- drag {x1,y1,x2,y2,durationMs,foreground} — press, move and release for highlighting or drag/drop
- dragCopy {text?|x1,y1,x2,y2,window?,controlType?,outputVar?,minChars?} — drag-highlights visible text and copies it. Prefer this over ctrl+a when only part of a page or document should be copied. If only text is given, UI Automation finds its bounds.
- scroll {amount,x?,y?,foreground} — positive scrolls up, negative down
- type {text,foreground} — foreground is the app/window that must be active before typing
- key {keys,repeat?,intervalMs?,foreground} — shortcuts and keys. Write "ctrl+a", "ctrl+c", "ctrl+v" or an array like ["ctrl+a","ctrl+c"]. SendKeys forms such as "^a" are also accepted.
- clipboard {action:"copy|copyAll|cut|paste|selectAll|read|write|clear",text?,textVar?,outputVar?,foreground?,minChars?} — copyAll selects all then copies and stores the clipboard; paste can use text/textVar; read stores text in outputVar
- aiExtract {source:"clipboard|text",instructions,textVar?,outputVar?,maxChars?} — asks the model to extract the exact requested passage from the clipboard/document text and stores it in outputVar; use this before pasting a long response
- wait {ms}
- waitFor {kind:"window|process|file", value, mode:"present|absent", timeoutMs} — polls until the state is reached
- screenshot {caption}
- verifyScreen {question,title?,app?,caption?,onError:"fail|warn"} — reads a fresh screenshot with vision and fails unless the visible page/state matches; app is the process/app that must be in the foreground
- verifyPlayback {title?,caption?,intervalMs?,minConfidence?} — captures two frames a few seconds apart and fails unless the video is visibly advancing (use after and during long playback waits)
- mediaHold {title,bufferMs?,maxMs?,checkMs?,stallMs?} — reads the player's seek slider through Windows UI Automation, holds for the actual remaining media duration, polls progress, and fails on a stall
- expect {kind:"window|file|process|foreground", value}
- playMedia {x,y,title} — starts playback only if audio is stopped and the media window is foreground
- clickElement {window,name,controlType?,button?,fallbackX?,fallbackY?,visionFallback?,verifyAfter?,preview?,humanize?,expect?} — focuses the window, scores visible UI Automation names, retries shortened labels, then uses a confidence-gated vision locator; verifyAfter runs a screen check before the next step; preview reads a screenshot before clicking (skips when expect is already visible, names surrounding elements and can correct the position); humanize moves the pointer through the area so hover menus render
- closeWindow {title} — closes only the foreground window when its title matches
- windowAction {action:"minimize|maximize|restore|close",title?,process?} — controls a specific window by title or process. Use minimize for a popup that keeps stealing focus, restore to bring it back, and close only when the goal says to close it.
- runTool {toolId}
- note {text} — run-log observation only; it is not saved as a file
- writeNote {title,text?,textVar?,append?,tags?,outputVar?} — save or append a detailed Markdown interaction note under data/notes; use for observations, copied links, install/test results and anything the next step must reuse
- readNote {noteId?|title?,outputVar?,maxChars?} — read a saved note (or the latest whose title contains the text) into a variable so later steps can type it, paste it or use it as data
- copyLink {outputVar?,url?,urlVar?,foreground?,noteTitle?} — focuses the browser address bar with ctrl+l, copies it with ctrl+c and stores the http(s) link in outputVar; pass url directly to store a known link
- downloadMedia {url?|urlVar?,filename?,folder?,kind:"image|video|file",maxMB?,overwrite?,outputVar?,noteTitle?} — saves an image, video or other file from an http(s) URL into data/<folder>
- saveImage {source:"screen|clipboard|url",url?,urlVar?,filename?,folder?,caption?,outputVar?} — saves a screenshot, the clipboard image or a URL image as PNG
- recordVideo {durationMs,fps?,filename?,folder?,x?,y?,width?,height?,caption?,note?,noteTitle?,outputVar?} — records the desktop (or a rectangle) to an MP4 with ffmpeg for the requested duration, saves a note and returns the file path
- writeTextFile {location:"desktop|data",path,text?,textVar?,append?,overwrite?,noteTitle?,outputVar?} — writes the captured text to a .txt file on the Desktop or under data/files; use textVar for a captured Kiro answer
- watchVideo {title,notes?,textVar?,noteTitle?,bufferMs?,maxMs?,checkMs?,stallMs?,outputVar?} — holds for the real video duration, confirms progress through the player clock, captures before/after frames and saves a Markdown note with the duration, outcome and observations
- installApp {app?,id?,url?,urls?,installerArgs?,discover?,maxAttempts?,verify?,noteTitle?} — installs a program and proves it; app is the name the goal uses (VLC, 7-Zip, Notepad++), id is a winget package id, url/urls are explicit installers, and discover (default true) searches the vendor page for the official .exe/.msi. The runner tries up to maxAttempts methods in order (winget first, then installers), safe-checks every source and switch, then verifies the executable or uninstall entry. Use only when the goal explicitly asks to install it
- testApp {target,title?,process?,question?,waitMs?,settleMs?,note?,noteTitle?,close?} — launches the app, waits for its window/process, checks the foreground (and optional vision question), captures a screenshot and saves the smoke-test note
Rules: use the steps the goal actually needs (typically 10-20, at most 24). Cover each phase once, in order, then stop; never repeat the same action, never add a wait after every click, and never pad the plan with placeholder clicks. Include a focusWindow before typing, foreground guards when a specific app/page matters, and verifyScreen after navigation, installation or playback so success is judged from pixels rather than command logs. For video work, use watchVideo (or mediaHold plus writeNote) rather than a fixed wait. For copied links use copyLink, and for saving media use downloadMedia/saveImage or recordVideo; never invent local file URLs. For installing use installApp with a real winget package id, and for smoke tests use testApp. Save important interaction details with writeNote, then readNote when a later step needs them. Do not stop after the first successful sub-goal: continue through download, launch and verification.
Prefer element-based actions over guessed pixels. Use clickElement with the actual visible control name (for example Install, Search, Open, Play); never use placeholders such as "UI element", "button" or "control". It searches the whole UI Automation tree, scores near matches and retries with alternate labels plus a vision fallback. Only use click when the goal gives explicit coordinates. If a control name is uncertain, give a short visible label and let clickElement resolve it. Add verifyAfter to a critical click when the next step depends on it; the runner performs that check before continuing.
Default to mouse and visible-control actions for navigation, opening panels, switching chats and sending messages. Reuse the current chat/tab; never open a New Session or New Chat unless the goal explicitly asks for a new topic. When the goal does ask for one, mark the step that starts it with "condition":"newChat" so reuse missions skip that step. Use keyboard shortcuts only when the goal asks for one, no visible control exists, or the exact shortcut is already a validated step in this workflow; otherwise use the visible control first. Clipboard ctrl+a/ctrl+c/ctrl+v is allowed after focus is established.
Never substitute a different app for the one the user named. If the goal says Kiro, use Kiro, not Notepad. Use the running-window and installed-app context supplied with the goal. For copy/paste tasks use key or clipboard steps with ctrl+a/ctrl+c/ctrl+v; do not type the shortcut words as text.
Before choosing steps, consider that part of the goal may already be in progress. If the goal needs a Save/Open dialog, an installer window or an app that is already running, plan the step that continues from it (type the file name, click that dialog's own Next/Save/Finish) rather than restarting the flow; the runner re-reads the foreground window before every step and skips a launch or focus that is already satisfied. Give a critical click params.preview=true so the screen is read before the click (it skips when the expected state is already visible, lists the elements around the target and can correct the position), and params.humanize=true when a hover menu or tooltip must appear on the way. Expect each step's stated result, not just a green status: an open dialog changes what the next step should be.
The research pack may include failed attempts, screenshots and conversation corrections from this workstation. Treat failed attempts as negative evidence: do not replay their order, their wrong target app or their failure signature unchanged. Treat passed attempts as positive evidence, but replace old typed questions and filenames with the current goal. If a screenshot marker shows a control, use a visible-control action rather than a guessed coordinate.
Prior workflow memory is evidence from this workstation, not a script to copy blindly. Reuse validated step sequences and control labels when the app and goal match. If a remembered step had no visible screen change, add an explicit wait/assertion or choose a more reliable visible control. If memory reports stale clipboard, focus loss or old tab labels, add clipboard clearing, foreground guards and active-message scoping instead of guessing. Never treat a tab label or filename as proof that an app state is current.`;

export function lintWorkflow(workflow) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const goal = `${workflow?.name || ''} ${workflow?.description || ''}`.trim();
  const issues = planIssues(steps, goal).map((code) => ({ code, severity: 'error', scope: 'plan' }));
  const seen = new Map();
  for (const [index, step] of steps.entries()) {
    const signature = `${step.type}|${JSON.stringify(step.params || {})}`;
    if (seen.has(signature)) {
      issues.push({
        code: 'duplicate step',
        severity: 'warning',
        scope: 'step',
        stepId: step.id || null,
        stepNumber: index + 1,
        message: `Step ${index + 1} repeats step ${seen.get(signature) + 1}.`,
      });
    } else {
      seen.set(signature, index);
    }
    if (step.type === 'key' && !String(step.params?.foreground || '').trim()) {
      issues.push({
        code: 'key step has no foreground guard',
        severity: 'warning',
        scope: 'step',
        stepId: step.id || null,
        stepNumber: index + 1,
        message: `Step ${index + 1} can send keys to whichever window happens to be focused.`,
      });
    }
  }
  if (steps.filter((step) => step.type === 'wait').length > 4) {
    issues.push({ code: 'too many fixed waits', severity: 'warning', scope: 'plan' });
  }
  if (steps.length > 24) {
    issues.push({ code: 'too many steps', severity: 'warning', scope: 'plan' });
  }
  return { issues, errors: issues.filter((issue) => issue.severity === 'error').length };
}

/**
 * Drop steps that carry a question or search query from an older task. A plan
 * for "download vlc" must not inherit "what is python" from workflow history.
 */
export function dropStaleQuestionSteps(steps, goal) {
  const list = Array.isArray(steps) ? steps : [];
  const text = String(goal || '').toLowerCase();
  const asksQuestion = /\b(?:what|who|why|how|when|where|which)\b/.test(text) || text.includes('?');
  const asksSearch = /\b(?:search|google|look\s*up|lookup|find|browse|web|youtube|download)\b/.test(text);
  const staleQueries = [];
  const kept = [];
  for (const step of list) {
    if (step?.type === 'openUrl') {
      const url = String(step.params?.url || '');
      const raw = (url.match(/[?&]q=([^&]+)/i) || [])[1] || '';
      let query = raw;
      try {
        query = decodeURIComponent(raw).replace(/\+/g, ' ');
      } catch {
        query = raw.replace(/\+/g, ' ');
      }
      query = query.trim();
      if (query) {
        const tokens = query.toLowerCase().split(/\s+/).filter((token) => token.length > 2);
        const inGoal = tokens.length ? tokens.some((token) => text.includes(token)) : text.includes(query.toLowerCase());
        if (!inGoal && (!asksQuestion || !asksSearch)) {
          staleQueries.push(query.toLowerCase());
          continue;
        }
        if (!inGoal) {
          staleQueries.push(query.toLowerCase());
          continue;
        }
      }
    }
    if (step?.type === 'type') {
      const typed = String(step.params?.text || '').trim();
      const questionLike = /\?\s*$/.test(typed) || /^(?:what|who|why|how|when|where|which)\b/i.test(typed);
      if (questionLike && !text.includes(typed.toLowerCase().slice(0, 12))) {
        staleQueries.push(typed.toLowerCase());
        continue;
      }
    }
    if (step?.type === 'clickElement' && staleQueries.length) {
      let window = String(step.params?.window || '').toLowerCase();
      try {
        window = decodeURIComponent(window).replace(/\+/g, ' ');
      } catch {
        window = window.replace(/\+/g, ' ');
      }
      if (staleQueries.some((query) => window.includes(query))) continue;
    }
    kept.push(step);
  }
  return kept;
}

export function planIssues(steps, goal) {
  const text = String(goal || '').toLowerCase();
  const issues = [];
  if (!Array.isArray(steps) || steps.length < 6) issues.push('too few steps');
  if ((steps || []).some((step) => step.type === 'clickElement' && !String(step.params?.name || '').trim())) {
    issues.push('placeholder click');
  }
  const asksNewSession = /\b(?:new|another|different|fresh)\s+(?:chat|session|conversation|topic)\b|\bdifferent topic\b|\bswitch topic\b/i.test(
    String(goal || '')
  );
  const hasNewChatCondition = (steps || []).some((step) => step.condition === 'newChat');
  if (asksNewSession && !hasNewChatCondition) issues.push('missing new-chat condition');
  if (!asksNewSession && hasNewChatCondition) issues.push('unrequested new-chat condition');
  if (/\binstall\b/.test(text) && !(steps || []).some((step) =>
    step.type === 'installApp' || (step.type === 'clickElement' && /\b(?:install|get|download|add)\b/i.test(step.params?.name || ''))
  )) issues.push('missing install');
  const hasDownload = (steps || []).some(
    (step) =>
      step.type === 'downloadMedia' ||
      step.type === 'installApp' ||
      (step.type === 'clickElement' && /\b(?:download|get|install)\b/i.test(step.params?.name || '')) ||
      (step.type === 'launchApp' && /\bvlc\b/i.test(step.params?.target || ''))
  );
  if (/\bdownload\b/.test(text) && !hasDownload) issues.push('missing download');
  if ((steps || []).some((step) =>
    step.type === 'downloadMedia' &&
    /video|movie|clip/i.test(step.params?.kind || '') &&
    /\.(?:exe|msi|zip|7z)(?:[?#]|$)/i.test(step.params?.url || '')
  )) issues.push('not a video URL');
  if (/\bplay\b/.test(text) && !(steps || []).some((step) =>
    ['playMedia', 'watchVideo'].includes(step.type) ||
    (step.type === 'clickElement' && /\bplay/i.test(step.params?.name || '')) ||
    (step.type === 'launchApp' && /vlc/i.test(step.params?.target || ''))
  )) issues.push('missing playback');
  if (/\b(?:store|marketplace)\b/.test(text) && !(steps || []).some((step) =>
    (step.type === 'openUrl' && /ms-windows-store:|microsoft\.com.*store/i.test(step.params?.url || '')) ||
    (step.type === 'launchApp' && /store/i.test(step.params?.target || ''))
  )) issues.push('missing store');
  return issues;
}

const REPAIR_SYSTEM = `You are a precise Windows desktop workflow planner. Rewrite the plan from scratch as JSON only: {"steps":[...]}.
Allowed step types: openUrl, launchApp, focusWindow, wait, type, key, clipboard, clickElement, waitFor, downloadMedia, installApp, playMedia, watchVideo, verifyScreen, screenshot, writeNote.
Rules:
- Mark a step that starts a new chat/session with "condition":"newChat"; reuse missions then skip it.
- Use 10-20 steps, one action per step, in execution order.
- Cover every phase named by the user. Do not stop after the first phase.
- clickElement needs the real visible control label in params.name (Install, Get, Search, Open, Play); never use placeholder names like "UI element" or "button".
- Default to mouse/visible-control actions. Reuse the current chat or tab; do not open a New Session/New Chat unless the goal explicitly asks for a new topic. Use a shortcut only when no visible control exists, the goal requests it, or it is already a validated workflow step.
- Include one short wait after navigation or installation only; never add a wait after every click.
- Use installApp {app} (the name the goal uses) when installation is requested: it tries winget and then the official installer, verifies the result and records the rollback. Add id only when you know the real winget package id. Use downloadMedia {url,kind:"video"} when a file must be downloaded. Use playMedia after the player is open, or watchVideo for a long video.
- Use verifyScreen after the last phase. Never repeat identical steps.
Common knowledge examples: Microsoft Store VLC search uses ms-windows-store://search/?query=VLC; VLC's winget id is VideoLAN.VLC; VLC's usual desktop path is C:\\Program Files\\VideoLAN\\VLC\\vlc.exe; a real sample video URL is ${SAMPLE_VIDEO_URL}.`;

async function repairPlan(goal, original, appContext, research = null) {
  const reply = await chat(
    [
      { role: 'system', content: REPAIR_SYSTEM },
      {
        role: 'user',
        content: `Goal: ${goal}\nThe first draft was incomplete (${planIssues(original, goal).join(', ') || 'too generic'}). Produce the complete corrected plan now.\nSTRATEGY BRIEF:\n${strategyBrief({ goal, longTermGoal: db().settings?.longTermGoal || '' }).text}\n${research?.promptText ? `Research evidence from prior attempts:\n${research.promptText}` : ''}`,
      },
    ],
    { format: 'json', kind: 'plan-repair', timeoutMs: 90000, temperature: 0.1, maxTokens: 8000 }
  );
  if (!reply.ok) return null;
  const parsed = parseJsonLoose(reply.content);
  const rawSteps = Array.isArray(parsed) ? parsed : parsed?.steps;
  if (!Array.isArray(rawSteps) || !rawSteps.length) return null;
  const normalized = rawSteps.map((step, index) => normalizeStep(step, index)).filter(Boolean);
  if (!normalized.length) return null;
  const aligned = alignPlanToGoal(normalized, goal, appContext).steps;
  console.log('[planner] repair', `raw=${rawSteps.length}`, `normalized=${normalized.length}`, `aligned=${aligned.length}`, `issues=${planIssues(aligned, goal).join('|') || 'none'}`);
  return { steps: aligned, reply };
}

async function buildPlan(goal, workflow, options = {}) {
  const ctx = workflow
    ? `Workflow: ${workflow.name}\nExisting steps: ${(workflow.steps || []).map((s) => s.name).join(' -> ') || 'none'}`
    : '';
  const research = options.research || buildWorkflowResearch({ workflow, goal });
  const researchFailures = research?.failedAttempts?.length || 0;
  const appContext = await discoverApps();
  const templatePlan = planFromTemplate(goal, appContext);
  if (templatePlan) {
    return {
      ok: true,
      steps: collapseDuplicatePlanSteps(templatePlan.steps),
      source: 'stepwise',
      app: templatePlan.intent.source.name,
      memoryUsed: 1,
      note: (templatePlan.template
        ? `Assembled the ${templatePlan.intent.source.name} → ${templatePlan.intent.destination.name} flow step by step from "${templatePlan.template.workflowName}", rejecting candidates whose preconditions did not hold.`
        : `Assembled the built-in ${templatePlan.intent.source.name} → ${templatePlan.intent.destination.name} answer-capture flow step by step.`) +
        ` Confidence ${Math.round(Number(templatePlan.confidence || 0) * 100)}%; ${templatePlan.rejected?.length || 0} candidate(s) rejected; ${templatePlan.missingPhases?.length || 0} missing phase(s) filled.` +
        (researchFailures ? ` Reviewed and avoided ${researchFailures} prior failed attempt${researchFailures === 1 ? '' : 's'} for this input.` : ''),
      confidence: templatePlan.confidence,
      decisions: templatePlan.decisions,
      rejectedSteps: templatePlan.rejected,
      backups: templatePlan.backups,
      preflight: templatePlan.preflight,
      research: compactResearch(research),
      memoryMatches: templatePlan.template ? [{
        workflowId: templatePlan.template.workflowId,
        workflowName: templatePlan.template.workflowName,
        mode: templatePlan.template.mode,
        status: templatePlan.template.status,
        quality: templatePlan.template.quality,
      }] : [],
      ms: 0,
      model: 'workflow-memory-recipe',
    };
  }
  const namedApp = parseGoalIntent(goal, appContext)?.source || findGoalApp(goal, appContext);
  const contextText = appContextText(appContext);
  const shortcutScope = namedApp ? { app: namedApp.name, process: namedApp.process } : null;
  const learned = shortcutScope ? eligibleShortcuts(8, shortcutScope) : [];
  const shortcutText = learned.length
    ? learned
        .map((entry) => {
          const title = entry.preconditions?.windowTitle || entry.windowTitle || '';
          const context = title ? `; only when the focused window contains "${title}"` : '';
          return `- ${entry.app} / ${entry.action}: ${entry.keys} (${entry.confidence}% confidence, ${entry.successes} success, ${entry.failures} failure${context})`;
        })
        .join('\n')
    : `None for ${namedApp ? namedApp.name : 'this goal'}. Use mouse/visible controls; do not invent shortcuts from another app.`;
  const memories = recallWorkflowMemory({ goal, workflow, app: namedApp, limit: 5 });
  const memoryText = formatWorkflowMemory(memories);
  const goalTokens = new Set(String(goal || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const relevantLessons = (db().agentLessons || [])
    .map((entry) => {
      const words = `${entry.goal || ''} ${entry.lesson || ''}`.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      return { entry, score: words.filter((word) => goalTokens.has(word)).length };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => item.entry.lesson);
  const memoryAttempts = memories
    .flatMap((entry) => (entry.hindrances || []).map((item) => (typeof item === 'string' ? item : item?.detail || item?.error || '')))
    .filter(Boolean)
    .slice(0, 4);
  const strategyText = strategyBrief({
    goal,
    app: namedApp,
    lessons: relevantLessons,
    attempts: memoryAttempts,
    longTermGoal: db().settings?.longTermGoal || '',
  }).text;
  const emptyWorkflow = !Array.isArray(workflow?.steps) || workflow.steps.length === 0;
  const exactMemory = pickReusableMemory(memories, { emptyWorkflow });
  if (exactMemory) {
    const reused = memoryPlanFrom([exactMemory], goal, appContext);
    if (reused?.steps?.length >= 6) {
      return {
        ok: true,
        steps: collapseDuplicatePlanSteps(reused.steps),
        source: 'memory',
        app: reused.app?.name || null,
        note: `Reused a validated ${exactMemory.mode} sequence from "${exactMemory.workflowName}" (${exactMemory.passed}/${exactMemory.total} steps passed).`,
        memoryUsed: 1,
        memoryMatches: memories.map((entry) => ({
          workflowId: entry.workflowId,
          workflowName: entry.workflowName,
          mode: entry.mode,
          status: entry.status,
          quality: entry.quality,
          score: entry.score,
          hindrances: (entry.hindrances || []).length,
        })),
        ms: 0,
        model: 'workflow-memory',
      };
    }
  }
  const reply = await chat(
    [
      { role: 'system', content: PLAN_SYSTEM },
      {
        role: 'user',
        content: `Goal: ${goal}\n${ctx}\n${contextText}\nGoal app: ${
          namedApp ? `${namedApp.name}${namedApp.process ? ` (process ${namedApp.process})` : ''}` : 'not named'
        }\nSTRATEGY BRIEF — plan against this, keep the fallback order and the continuations:\n${strategyText}\nValidated shortcuts from passed live reviewed runs (only reuse when the same app/control matches; otherwise prefer the visible control):\n${shortcutText}\nPrior workflow memory and visual checks from this workstation (use as evidence, adapt to the current screen, and do not repeat a known hindrance):\n${memoryText}\nRESEARCH PACK (conversation, failed attempts, screenshots and all-workflow history):\n${research?.promptText || 'No cross-referenced history yet.'}\nIf you reuse a learned shortcut, set the key step's params.foreground to the window title shown for it so the runner refuses the wrong window.\nUse the goal app above. Never use Notepad unless the goal says Notepad.\nReturn JSON.`,
      },
    ],
    { format: 'json', kind: 'plan', timeoutMs: 90000, temperature: 0.15, maxTokens: 12000, images: research?.images || [] }
  );

  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    let rawSteps = Array.isArray(parsed) ? parsed : parsed?.steps;
    if (!Array.isArray(rawSteps) || !rawSteps.length) rawSteps = salvageSteps(reply.content);
    if (Array.isArray(rawSteps) && rawSteps.length) {
      const normalized = rawSteps.map((s, i) => normalizeStep(s, i)).filter(Boolean);
      if (normalized.length) {
        let aligned = alignPlanToGoal(normalized, goal, appContext);
        const stepIntent = parseGoalIntent(goal, appContext);
        let stepwise = stepIntent ? validateStepSequence(aligned.steps, stepIntent, { templateName: 'AI draft' }) : null;
        if (stepwise && stepwise.steps.length >= 6) {
          aligned = { ...aligned, steps: stepwise.steps };
        }
        let repaired = null;
        const issues = planIssues(aligned.steps, goal);
        if (issues.length) {
          repaired = await repairPlan(goal, aligned.steps, appContext, research);
          const repairedIssues = repaired ? planIssues(repaired.steps, goal) : [];
          if (
            repaired &&
            (repairedIssues.length < issues.length ||
              (repairedIssues.length === issues.length && repaired.steps.length > aligned.steps.length + 2))
          ) {
            aligned = { ...aligned, steps: repaired.steps };
          } else {
            console.log('[planner] repair rejected', `original=${aligned.steps.length}`, `repaired=${repaired?.steps?.length || 0}`, `issues=${planIssues(repaired?.steps || [], goal).join('|') || 'none'}`);
            repaired = null;
          }
        }
        stepwise = stepIntent ? validateStepSequence(aligned.steps, stepIntent, { templateName: 'AI final' }) : null;
        if (stepwise && stepwise.steps.length >= 6) {
          aligned = { ...aligned, steps: stepwise.steps };
        }
        return {
          ok: true,
          steps: collapseDuplicatePlanSteps(aligned.steps),
          source: stepwise ? 'ai-stepwise' : 'ai',
          app: aligned.app?.name || null,
          note: repaired
            ? `AI draft repaired: ${issues.join('; ')}. Full ${aligned.steps.length}-step plan kept.`
            : aligned.corrected
            ? `Pinned the plan to ${aligned.app?.name || 'the named app'} and cleaned unsafe or redundant steps (${aligned.steps.length} steps kept).`
            : stepwise && (stepwise.rejected.length || stepwise.missingPhases.length)
            ? `Assembled ${aligned.steps.length} steps after rejecting ${stepwise.rejected.length} candidate(s) and filling ${stepwise.missingPhases.length} missing phase(s).`
            : undefined,
          confidence: stepwise?.confidence,
          decisions: stepwise?.decisions,
          rejectedSteps: stepwise?.rejected,
          backups: stepwise?.backups,
          preflight: stepwise?.preflight,
          ms: reply.ms + (repaired?.reply?.ms || 0),
          model: repaired?.reply?.model || reply.model,
          memoryMatches: memories.map((entry) => ({
            workflowId: entry.workflowId,
            workflowName: entry.workflowName,
            mode: entry.mode,
            status: entry.status,
            quality: entry.quality,
            score: entry.score,
            hindrances: (entry.hindrances || []).length,
          })),
          research: compactResearch(research),
        };
      }
    }
    console.warn('[planner] model plan was not usable:', String(reply.content || '').slice(0, 800));
    const fromMemory = memoryPlanFrom(memories, goal, appContext);
    return {
      ok: true,
      steps: fromMemory?.steps || alignPlanToGoal(heuristicPlan(goal, appContext), goal, appContext).steps,
      source: fromMemory ? 'memory' : 'heuristic',
      note: fromMemory
        ? `Model reply was not usable; reused a validated sequence from ${fromMemory.workflowName}.`
        : 'Model reply was not usable as steps; used the local planner.',
      raw: reply.content.slice(0, 500),
      memoryUsed: fromMemory ? 1 : 0,
      memoryMatches: memories.map((entry) => ({ workflowName: entry.workflowName, score: entry.score })),
      research: compactResearch(research),
    };
  }
  const fromMemory = memoryPlanFrom(memories, goal, appContext);
  return {
    ok: true,
    steps: fromMemory?.steps || alignPlanToGoal(heuristicPlan(goal, appContext), goal, appContext).steps,
    source: fromMemory ? 'memory' : 'heuristic',
    note: fromMemory
      ? `AI unavailable (${reply.error}); reused a validated sequence from ${fromMemory.workflowName}.`
      : `AI unavailable (${reply.error}); used the local planner.`,
    memoryUsed: fromMemory ? 1 : 0,
    memoryMatches: memories.map((entry) => ({ workflowName: entry.workflowName, score: entry.score })),
    research: compactResearch(research),
  };
}

const RUNNING_WINDOW_STATES = new Set(['foreground', 'background', 'minimized', 'hidden']);

async function appIsRunning(hint) {
  try {
    const state = await inspectWindowState({ title: hint.label || '', process: hint.process || '' });
    return Boolean(state.processRunning) || RUNNING_WINDOW_STATES.has(state.state);
  } catch {
    return false;
  }
}

/**
 * A plan that starts by focusing or typing into an app that is not open fails
 * with window_not_found. Insert an explicit launch and settle before the first
 * step that needs that app, unless it already opens the app or is running.
 */
export async function ensurePlanLaunch(steps, { isAppRunning } = {}) {
  const plan = JSON.parse(JSON.stringify(Array.isArray(steps) ? steps : []));
  const found = firstAppStep(plan);
  if (!found) return plan;
  const { index, hint } = found;
  if (opensTargetBefore(plan, index, hint)) return plan;
  if (typeof isAppRunning === 'function' && (await isAppRunning(hint))) return plan;
  plan[index].params = { ...(plan[index].params || {}) };
  if (!plan[index].params.process && hint.process) plan[index].params.process = hint.process;
  plan.splice(
    index,
    0,
    ...launchAndWaitSteps(hint).map((step, offset) => normalizeStep(step, index + offset))
  );
  return plan;
}

/** Every planning result goes through here, so saved plans carry the launch step. */
export async function preparePlanForLaunch(result, options = {}) {
  if (!Array.isArray(result?.steps) || !result.steps.length) return result;
  const isAppRunning = typeof options.isAppRunning === 'function' ? options.isAppRunning : appIsRunning;
  const steps = await ensurePlanLaunch(result.steps, { isAppRunning });
  if (steps.length === result.steps.length) return result;
  return { ...result, steps };
}

function collapseDuplicatePlanSteps(steps) {
  const out = [];
  for (const step of steps || []) {
    const previous = out[out.length - 1];
    if (previous && previous.type === step.type && JSON.stringify(previous.params || {}) === JSON.stringify(step.params || {})) continue;
    out.push(step);
  }
  // The model sometimes emits a repeated copy/extract or focus/type block.
  // Remove an identical block that immediately follows the first one.
  for (let index = 0; index < out.length; index++) {
    for (let length = 2; length <= 4; length++) {
      if (index + length * 2 > out.length) break;
      const first = out.slice(index, index + length);
      const second = out.slice(index + length, index + length * 2);
      const same = first.every((step, offset) =>
        step.type === second[offset].type && JSON.stringify(step.params || {}) === JSON.stringify(second[offset].params || {})
      );
      if (same) {
        out.splice(index + length, length);
        index = Math.max(-1, index - 1);
        break;
      }
    }
  }
  return out;
}

export async function planSteps(goal, workflow, options = {}) {
  const build = typeof options.planBuilder === 'function' ? options.planBuilder : buildPlan;
  const plan = await build(goal, workflow, options);
  const all = Array.isArray(plan?.steps) ? plan.steps : [];
  const steps = dropStaleQuestionSteps(all, goal);
  const cleaned = steps.length === all.length
    ? plan
    : {
        ...plan,
        steps,
        note: [plan.note, `Removed ${all.length - steps.length} step(s) that carried an older question or search.`]
          .filter(Boolean)
          .join(' '),
      };
  return preparePlanForLaunch(cleaned, options);
}

function pickReusableMemory(memories, { emptyWorkflow = false, allowLowScore = false } = {}) {
  return (memories || [])
    .filter((entry) =>
      entry.status === 'passed' &&
      entry.quality >= 0.9 &&
      entry.topicScore === 1 &&
      entry.subjectScore !== 0 &&
      entry.appScore === 1 &&
      entry.steps?.length >= 6 &&
      (allowLowScore || entry.score >= 0.7 || emptyWorkflow)
    )
    .sort((a, b) =>
      b.quality - a.quality ||
      (b.mode === 'live' ? 1 : 0) - (a.mode === 'live' ? 1 : 0) ||
      b.steps.length - a.steps.length ||
      b.score - a.score
    )[0] || null;
}

function memoryPlanFrom(memories, goal, appContext) {
  const memory = pickReusableMemory(memories, { allowLowScore: true });
  if (!memory) return null;
  const normalized = planStepsFromMemory(memory)
    .map((step, index) => normalizeStep(step, index))
    .filter(Boolean);
  if (!normalized.length) return null;
  // This sequence already passed on this workstation. Do not re-expand it with
  // generic alignment steps, which can add duplicate focus/copy/paste actions.
  return { steps: normalized, workflowName: memory.workflowName, memory };
}

/**
 * An empty workflow is filled from the goal before a run starts. The plan uses
 * the same memory-aware planner as the builder, so simulated and live starts
 * behave the same way.
 */
export async function ensureWorkflowSteps(workflow, goal) {
  if (!workflow) throw new Error('Workflow not found');
  if (Array.isArray(workflow.steps) && workflow.steps.length) return { created: 0, source: 'existing' };
  const text = String(goal || workflow.description || workflow.name || '').trim();
  if (!text) throw new Error('Describe the workflow goal before auto-creating steps');
  const plan = await planSteps(text, workflow);
  if (!Array.isArray(plan.steps) || !plan.steps.length) throw new Error('The planner returned no steps');
  workflow.steps = plan.steps.map((step, index) => ({
    ...step,
    id: step.id || uid('stp'),
    name: String(step.name || `Step ${index + 1}`).slice(0, 80),
  }));
  workflow.autoPlannedAt = now();
  workflow.lastPlanSource = plan.source || 'planner';
  workflow.updatedAt = now();
  persist();
  logActivity('workflow', `Auto-created ${workflow.steps.length} step(s) for "${workflow.name}" (${plan.source || 'planner'})`);
  return {
    created: workflow.steps.length,
    source: plan.source || 'planner',
    note: plan.note || '',
    steps: workflow.steps.length,
    memoryMatches: plan.memoryMatches || [],
  };
}

export function heuristicAnalysis(run) {
  const failed = (run.steps || []).filter((s) => s.status === 'failed');
  if (!failed.length) {
    return {
      summary: `Run finished ${run.status} with ${run.steps.filter((s) => s.status === 'passed').length}/${run.steps.length} steps passing.`,
      rootCause: 'No failing step.',
      nextActions: ['Keep the workflow as a regression check.'],
      source: 'heuristic',
    };
  }
  const first = failed[0];
  return {
    summary: `Run failed at step "${first.name}" (${first.type}) after ${first.attempts || 1} attempt(s).`,
    rootCause: first.error || 'Step threw an error without a message.',
    nextActions: [
      'Confirm the target window is focused before this step and add a wait if the app was still loading.',
      'Check that coordinates and selectors still match the current screen resolution.',
      `Re-run in simulated mode first, then live, and compare evidence for "${first.name}".`,
    ],
    source: 'heuristic',
  };
}

export async function analyzeRun(run) {
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  const goal = workflow ? workflowGoal(workflow, run) : '';
  const evidence = (run.evidence || []).map((e) => `${e.kind}: ${e.caption || e.path || ''}`);
  const prompt = `A desktop UI test run finished with status "${run.status}".
Original operator goal: ${goal || '(not recorded)'}
Workflow: ${run.workflowName}
Mode: ${run.dryRun ? 'simulated' : 'live desktop control'}
Failure policy: ${JSON.stringify(run.policy || {})}
Steps:
${(run.steps || [])
  .map(
    (s, i) =>
      `${i + 1}. ${s.name} (${s.type}) -> ${s.status}${s.error ? ` | error: ${s.error}` : ''}${
        s.output ? ` | output: ${String(s.output).slice(0, 200)}` : ''
      }`
  )
  .join('\n')}
Evidence: ${evidence.join('; ') || 'none'}
Reply as JSON: {"summary":"...","rootCause":"...","nextActions":["..."],"suggestedSteps":[{"type":"wait","name":"Wait for dialog","params":{"ms":1500}}]}
Only include suggestedSteps when a concrete missing step would prevent this failure (max 3).
Do not suggest a wait unless the logs explicitly mention timing, loading, a dialog, or a timeout. Do not suggest a step that consumes a variable produced by an earlier skipped step. If the step order or the initial plan is wrong, explain that in rootCause and recommend rebuilding the plan from the goal; suggestedSteps may be empty.`;

  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You are the failure-analysis agent in a Windows screen-automation console. Diagnose test failures from step logs and screenshots. Separate the operator goal from the workflow plan and from the execution error: if the plan starts by consuming text that a later step should produce, say the plan order is wrong and recommend rebuilding from the goal rather than patching a single step. Do not invent a wait for a non-timing failure. Be specific and concise. Reply with JSON only.',
      },
      { role: 'user', content: prompt },
    ],
    { format: 'json', kind: 'analysis', timeoutMs: 90000, temperature: 0.2 }
  );

  if (reply.ok) {
    const parsed = parseJsonLoose(reply.content);
    if (parsed && (parsed.summary || parsed.rootCause)) {
      const failureText = (run.steps || [])
        .filter((step) => step.status === 'failed')
        .map((step) => `${step.name || ''} ${step.type || ''} ${step.error || ''}`)
        .join(' ');
      const timingRelated = /wait|timeout|timed out|loading|dialog|not ready|slow/i.test(failureText);
      const suggestedSteps = Array.isArray(parsed.suggestedSteps)
        ? parsed.suggestedSteps
            .map((s, i) => normalizeStep(s, i))
            .filter(Boolean)
            .filter((step) => {
              if (step.type === 'wait' && !timingRelated) return false;
              if (step.type === 'writeTextFile' && !step.params?.text && !step.params?.textVar) return false;
              if (step.type === 'aiExtract' && !String(step.params?.instructions || '').trim()) return false;
              return true;
            })
        : [];
      return {
        summary: String(parsed.summary || '').slice(0, 1000),
        rootCause: String(parsed.rootCause || '').slice(0, 1200),
        nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map(String).slice(0, 6) : [],
        suggestedSteps,
        source: 'ai',
        model: reply.model,
        at: now(),
      };
    }
  }
  return { ...heuristicAnalysis(run), at: now() };
}

export function writeRunNote(run) {
  const d = db();
  const title = `${run.workflowName} — ${run.status}`;
  const lines = [
    `# ${title}`,
    '',
    `- Run: \`${run.id}\``,
    `- Mode: ${run.dryRun ? 'Simulated (no desktop input)' : 'Live desktop control'}`,
    `- Started: ${run.startedAt || run.createdAt}`,
    `- Duration: ${run.durationMs != null ? `${run.durationMs} ms` : 'n/a'}`,
    `- Steps passed: ${(run.steps || []).filter((s) => s.status === 'passed').length}/${(run.steps || []).length}`,
    '',
    '## Steps',
    ...(run.steps || []).map(
      (s, i) =>
        `${i + 1}. **${s.name}** (${s.type}) — ${s.status}${s.error ? `\n   - Error: ${s.error}` : ''}${
          s.output ? `\n   - Output: ${String(s.output).slice(0, 300)}` : ''
        }`
    ),
    '',
    '## Evidence',
    ...((run.evidence || []).length
      ? run.evidence.map((e) => `- ${e.kind}${e.simulated ? ' (simulated)' : ''}: ${e.caption || ''} ${e.path ? `\`${e.path}\`` : ''}`)
      : ['- None captured']),
  ];
  if (run.analysis) {
    lines.push('', '## Diagnosis', run.analysis.summary || '', '', run.analysis.rootCause || '');
    if (run.analysis.nextActions?.length) {
      lines.push('', '### Next actions', ...run.analysis.nextActions.map((a) => `- ${a}`));
    }
  }
  const body = lines.join('\n');
  const file = path.join(NOTES, `${slug(title)}-${run.id}.md`);
  writeFileDurable(file, body);
  const note = {
    id: uid('note'),
    title,
    body,
    file: path.relative(process.cwd(), file).split(path.sep).join('/'),
    source: run.analysis?.source === 'ai' ? 'ai' : 'auto',
    runId: run.id,
    workflowId: run.workflowId,
    tags: ['run', run.status],
    createdAt: now(),
  };
  d.notes.unshift(note);
  persist();
  logActivity('note', `Note written for ${run.workflowName} (${run.status})`, { runId: run.id });
  return note;
}

export function addSuggestion(text, kind, workflowId, runId) {
  const d = db();
  const exists = d.suggestions.some((s) => !s.dismissed && s.text === text);
  if (exists) return null;
  const suggestion = {
    id: uid('sug'),
    text,
    kind: kind || 'general',
    workflowId: workflowId || null,
    runId: runId || null,
    createdAt: now(),
    dismissed: false,
    status: 'open',
  };
  d.suggestions.unshift(suggestion);
  d.suggestions = d.suggestions.slice(0, 60);
  persist();
  return suggestion;
}

export function suggestionsFor(workflow, run) {
  const out = [];
  if (run && run.status === 'failed') {
    out.push(`Pin the failing step evidence from ${run.workflowName} into the workflow description so the next reviewer sees it.`);
  }
  if (workflow) {
    const hasScreenshot = workflow.steps.some((s) => s.type === 'screenshot');
    const hasAssert = workflow.steps.some((s) => s.type === 'expect');
    if (!hasScreenshot) out.push('No capture step yet — add one so failures come with visual evidence.');
    if (!hasAssert) out.push('No assertion step — add an "Assert state" step to turn a bare sequence into a real test.');
    if (workflow.steps.length > 2 && !workflow.steps.some((s) => s.type === 'wait')) {
      out.push('UI actions run back-to-back; insert a wait after launch/open steps.');
    }
    if (workflow.steps.some((s) => s.type === 'type') && !workflow.steps.some((s) => s.type === 'focusWindow')) {
      out.push('Typing without focusing a window is fragile — add a focusWindow step first.');
    }
  }
  return out;
}

export { normalizeStep };
