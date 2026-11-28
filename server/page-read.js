/**
 * Between-step page reading.
 *
 * The automatic screen review asks one closed question after a step: did the
 * frame show what the step claimed? That catches a lie, but it never reads the
 * page. A real desktop is full of states the plan did not name — a browser
 * profile chooser, a cookie wall, a search box that is already focused, a result
 * list where a video still has to be picked — and a plan that walks past them
 * either fails at a keystroke or claims a pass it never earned.
 *
 * This module reads the frame between steps: which app and page is visible, is
 * there a dialog in front, can it be used without a secret, and what single
 * action does the goal imply here. The answer is recorded on the run. A
 * confident action the plan does not already contain is added as a step (bounded
 * per run), so the run follows the screen as well as the script — while a
 * sign-in wall it cannot pass is reported, never guessed through.
 */

import fs from 'node:fs';
import path from 'node:path';
import { liveScreenshot } from './automation.js';
import { chat, parseJsonLoose } from './llm.js';
import { DATA } from './store.js';
import { findingsBrief } from './vision-findings.js';

const DEFAULTS = Object.freeze({
  enabled: true,
  maxPerRun: 6,
  maxInserts: 3,
  minConfidence: 0.55,
});

// Steps whose result can change the page; a wait or an assertion is not a page.
const READ_AFTER = new Set([
  'launchApp',
  'openUrl',
  'focusWindow',
  'click',
  'doubleClick',
  'rightClick',
  'clickElement',
  'key',
  'type',
  'playMedia',
  'mediaHold',
  'windowAction',
  'scroll',
]);

// Actions the reader may add. Every one of them is executed by the ordinary
// step runner, so the same guards (a window must be named before input, a click
// needs a target) still apply.
const INSERTABLE = new Set(['focusWindow', 'click', 'clickElement', 'key', 'type', 'openUrl', 'wait']);

const MAX_TEXT = 240;

function str(value, limit = MAX_TEXT) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(min, Math.min(max, number)) * 100) / 100;
}

export function normalizePageReadSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled !== false,
    maxPerRun: clampInt(source.maxPerRun, 1, 40, DEFAULTS.maxPerRun),
    maxInserts: clampInt(source.maxInserts, 0, 8, DEFAULTS.maxInserts),
    minConfidence: clampNumber(source.minConfidence, 0.3, 1, DEFAULTS.minConfidence),
  };
}

/** Is a reading worth taking after this step, within the run's budget? */
export function shouldReadPage(step, { reads = 0, settings = DEFAULTS } = {}) {
  const cfg = normalizePageReadSettings(settings);
  if (!cfg.enabled || !step) return false;
  if (Number(reads) >= cfg.maxPerRun) return false;
  return READ_AFTER.has(String(step.type || ''));
}

/**
 * The question. It is deliberately open: a verifier that is only allowed to say
 * "match" or "mismatch" can never notice the profile chooser the plan forgot.
 */
export function pageReadPrompt({ goal = '', stepName = '', nextNames = [], variables = {}, findings = null } = {}) {
  const system =
    'You read one live desktop screenshot between automation steps and answer what is actually there. ' +
    'Judge only from visible pixels, never from step names, logs, titles or assumptions. ' +
    'Return JSON only: {"page":"the page or document name","app":"the app or process",' +
    '"visible":"one or two sentences describing what is on screen right now",' +
    '"blockers":["profile chooser, consent wall, sign-in wall, error dialog or empty page in front, or empty"],' +
    '"usable":true|false,' +
    '"nextAction":{"type":"click|clickElement|key|type|focusWindow|openUrl|wait","name":"short imperative label","params":{...},"why":"why the goal needs it now"}|null,' +
    '"goalLooksMet":true|false,"confidence":0-1}. ' +
    'usable is true only when the visible state can be used without a password, payment or an unverifiable guess; ' +
    'a sign-in or account wall that needs a secret is usable=false with nextAction=null. ' +
    'When the prompt lists controls the vision reviewer already found, click them by that exact label in params.name; ' +
    'use x,y only for something the reviewer has not named, and never guess a point for a control that is already named. ' +
    'nextAction is the single action a person would take here to move the goal forward. Report one even when the plan ' +
    'did not name it: choosing a browser profile, dismissing a consent prompt, clicking a search field, pressing Enter, ' +
    'picking the matching result, and starting the video when the goal implies playing one are all valid next actions. ' +
    'params must match the type: click {name} or {x,y} (put the control\'s own label in params.name); key {keys}; ' +
    'type {text}; focusWindow {title|process}; ' +
    'openUrl {url}; wait {ms}. Set nextAction=null when the goal is visibly done, when the screen shows nothing that ' +
    'belongs to the goal, or when the needed step is already contained in the plan. ' +
    'goalLooksMet is true only when the visible screen already shows the outcome the goal describes. ' +
    'When a video or result is unavailable, prefer scrolling for the next row, looking right at “Up next”, going back or choosing another result on the same topic over re-entering the address.';

  const next = (nextNames || []).filter(Boolean).slice(0, 6);
  const variableText = Object.entries(variables || {})
    .filter(([, value]) => String(value || '').trim())
    .slice(0, 4)
    .map(([key, value]) => `${key}="${str(value, 80)}"`)
    .join(', ');
  const visionText = findingsBrief(findings, {
    lead: 'Controls the vision reviewer already found (use the exact label in params.name instead of guessing coordinates)',
  });
  const user =
    `Goal: ${str(goal, 600) || '(the workflow description)'}\n` +
    `Step that just settled: ${str(stepName, 160) || '(none)'}\n` +
    `Steps the plan still has after this one: ${next.length ? next.join(' → ') : '(none)'}\n` +
    (variableText ? `Text the run already holds: ${variableText}\n` : '') +
    (visionText ? `${visionText}\n` : '') +
    'Read the screenshot now. If it shows a state the plan has to handle first, name that action in nextAction.';
  return { system, user };
}

/**
 * One reading, in the shape the engine records. Guessing is not reading: a
 * reply that is not JSON, or that cannot name what is visible, is no reading at
 * all.
 */
export function parsePageRead(text) {
  const parsed = parseJsonLoose(String(text || '')) || {};
  const confidence = clampNumber(parsed.confidence, 0, 1, 0);
  const nextAction = parsed.nextAction && typeof parsed.nextAction === 'object' ? parsed.nextAction : null;
  const reading = {
    page: str(parsed.page, 120),
    app: str(parsed.app, 80),
    visible: str(parsed.visible, 400),
    blockers: (Array.isArray(parsed.blockers) ? parsed.blockers : [])
      .map((entry) => str(entry, 160))
      .filter((entry) => entry && !/^none$/i.test(entry))
      .slice(0, 4),
    usable: parsed.usable === true,
    goalLooksMet: parsed.goalLooksMet === true,
    nextAction,
    confidence,
  };
  return reading;
}

/**
 * A proposed action is only usable if the step runner can execute it as it is.
 * A click without a target, or typing without text, is dropped rather than run
 * as a blind action.
 */
export function normalizeImpliedStep(raw, { id = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || '').trim();
  if (!INSERTABLE.has(type)) return null;
  const params = raw.params && typeof raw.params === 'object' ? { ...raw.params } : {};
  const name = str(raw.name, 120) || `${type} from the screen`;
  const clean = {};
  if (type === 'click' || type === 'clickElement') {
    // Models often put the control's label in the action name instead of params;
    // a short label is still a target, a sentence is not.
    const words = str(raw.name, 120).split(' ').filter(Boolean);
    const fallback = words.length && words.length <= 4 ? words.join(' ') : '';
    const target = str(params.name || params.label || params.control || fallback, 120);
    const x = Number(params.x);
    const y = Number(params.y);
    if (target) clean.name = target;
    else if (Number.isFinite(x) && Number.isFinite(y)) {
      clean.x = Math.round(x);
      clean.y = Math.round(y);
    } else return null;
    if (str(params.title || '')) clean.title = str(params.title, 120);
  } else if (type === 'key') {
    const keys = Array.isArray(params.keys) ? params.keys : [params.keys];
    const list = keys.map((key) => str(key, 40)).filter(Boolean);
    if (!list.length) return null;
    clean.keys = list;
  } else if (type === 'type') {
    const text = str(params.text, 2000);
    const textVar = str(params.textVar, 80);
    if (!text && !textVar) return null;
    if (text) clean.text = text;
    if (textVar) clean.textVar = textVar;
  } else if (type === 'focusWindow') {
    const title = str(params.title || params.windowTitle || '', 160);
    const process = str(params.process || params.app || '', 80);
    if (!title && !process) return null;
    if (title) clean.title = title;
    if (process) clean.process = process;
  } else if (type === 'openUrl') {
    const url = str(params.url, 600);
    if (!url) return null;
    clean.url = url;
  } else if (type === 'wait') {
    clean.ms = clampInt(params.ms, 1, 60000, 1200);
  }
  return {
    id: id || '',
    type,
    name,
    params: clean,
    timeoutMs: 30000,
    origin: 'page-read',
    why: str(raw.why, 240),
  };
}

/** Would this action repeat the step that is already next? */
export function duplicatesStep(implied, step) {
  if (!implied || !step) return false;
  if (implied.type !== step.type) return false;
  const a = implied.params || {};
  const b = step.params || {};
  const key = (params) =>
    JSON.stringify([
      str(params.name || params.label || '', 120),
      str(params.title || params.windowTitle || '', 160),
      str(params.url || '', 300),
      str(params.text || '', 200),
      Array.isArray(params.keys) ? params.keys.join('+') : str(params.keys || '', 60),
    ]);
  return key(a) === key(b);
}

/** One line for the run log: what the frame showed, not a verdict. */
export function describeReading(reading) {
  if (!reading) return '';
  const parts = [];
  if (reading.visible) parts.push(reading.visible);
  else if (reading.page || reading.app) parts.push([reading.app, reading.page].filter(Boolean).join(' · '));
  if (reading.blockers.length) parts.push(`in the way: ${reading.blockers.join('; ')}`);
  if (reading.goalLooksMet) parts.push('the goal already looks met on screen');
  if (!reading.usable) parts.push('not usable without a secret');
  return parts.join(' — ').slice(0, 500);
}

async function readImage(file) {
  const relative = String(file || '');
  if (!relative) return '';
  const absolute = path.isAbsolute(relative) ? relative : path.join(DATA, relative);
  return fs.readFileSync(absolute).toString('base64');
}

/**
 * The frame a between-step reading is about, taken when the step settled.
 * Exported so the runner can take it in the step and judge it later: a reading
 * of a screen the run has already left is worse than no reading.
 */
export async function capturePageFrame({ run = null, target = null } = {}) {
  return liveScreenshot(run?.id || null, {
    maxWidth: 1280,
    quality: 72,
    ...(target?.hwnd ? { crop: { window: target.hwnd } } : {}),
  });
}

/**
 * Capture one frame and read it. `capture` and `ask` are injectable so the
 * engine tests can read without a desktop or a model.
 */
export async function readPage({
  run = null,
  goal = '',
  stepName = '',
  nextNames = [],
  variables = {},
  target = null,
  findings = null,
  capture = null,
  ask = chat,
} = {}) {
  const shot = capture ? await capture() : await capturePageFrame({ run, target });
  const view = shot?.vision || { path: shot?.path, width: shot?.width, height: shot?.height };
  const image = await readImage(view?.path);
  if (!image) return { ok: false, error: 'the frame could not be read', shot };
  const { system, user } = pageReadPrompt({ goal, stepName, nextNames, variables, findings });
  const reply = await ask(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { images: [image], format: 'json', kind: 'page-read', timeoutMs: 60000, temperature: 0, maxTokens: 500 }
  );
  if (!reply?.ok) return { ok: false, error: String(reply?.error || 'the page read failed'), shot };
  const reading = parsePageRead(reply.content);
  if (!reading.visible && !reading.page && !reading.app) {
    return { ok: false, error: 'the reading did not name what is on screen', shot };
  }
  return { ok: true, reading, shot, path: view?.path || shot?.path || '' };
}

export const __pageRead = { DEFAULTS, READ_AFTER, INSERTABLE };
