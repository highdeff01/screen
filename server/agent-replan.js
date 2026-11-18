/**
 * Live AI repair agent.
 *
 * One model call per irreparable step. It sees the full plan state, the exact
 * failure, enabled-agent advice, saved notes, successful methods from earlier
 * runs and durable lessons. It returns either a verified replacement sequence
 * for the failed step or a rewritten remainder of the plan. The engine executes
 * every returned step through the same window/effect/screen checks as a normal
 * step, so model output cannot claim success by itself.
 */

import { chat, parseJsonLoose } from './llm.js';
import { db } from './store.js';
import { normalizePlanSteps, workflowGoal } from './planner.js';
import { windowChecksFor } from './step-effects.js';
import { appFromGoal } from './repair.js';
import { catalogEntry } from './app-install.js';
import { strategyBrief } from './strategy.js';
import { matchAppHint } from './app-launch-hints.js';

const MAX_REPAIR_STEPS = 6;
const MAX_REMAINING_STEPS = 12;
const MAX_LESSONS = 80;

const INPUT_TYPES = new Set([
  'type',
  'key',
  'clipboard',
  'click',
  'doubleClick',
  'rightClick',
  'drag',
  'dragCopy',
  'scroll',
  'playMedia',
]);

// The model may repair an action, but it may not install software or run
// arbitrary PowerShell from a failure prompt.
const ALLOWED_TYPES = new Set([
  'launchApp',
  'openUrl',
  'focusWindow',
  'windowAction',
  'clickElement',
  'click',
  'doubleClick',
  'rightClick',
  'move',
  'drag',
  'dragCopy',
  'scroll',
  'type',
  'key',
  'clipboard',
  'wait',
  'waitFor',
  'expect',
  'screenshot',
  'verifyScreen',
  'verifyPlayback',
  'playMedia',
  'mediaHold',
  'readNote',
  'writeNote',
  'aiExtract',
  'copyLink',
  'downloadMedia',
  'closeWindow',
]);

const TYPE_GUIDE = `Allowed step types (params):
- launchApp {target,args?} — open an app, executable, shortcut or document
- openUrl {url,app?} — open a page; app may be chrome.exe
- focusWindow {title,process?} — bring a specific window forward
- windowAction {action:"minimize|maximize|restore|close",title?,process?} — control a popup or window by title/process
- clickElement {window,name,controlType?,fallbackX?,fallbackY?,visionFallback?,verifyAfter?,preview?,humanize?,expect?} — find and click a named visible control; preview reads the screen first (skips when the expected state already exists, lists nearby elements, can correct the position); humanize moves the pointer through the area for hover menus
- click {x,y,button?,foreground?} | doubleClick {x,y} | rightClick {x,y}
- move {x,y}
- drag {x1,y1,x2,y2,foreground?} — press, move, release
- dragCopy {text?|x1,y1,x2,y2,window?,outputVar?,minChars?} — drag-highlight visible text and copy it
- scroll {amount,x?,y?,foreground?}
- type {text|textVar,foreground} — foreground guard is required
- key {keys,foreground} — shortcuts such as ["ctrl+a","ctrl+c"]; foreground guard is required
- clipboard {action:"copy|copyAll|cut|paste|selectAll|read|write|clear",text?,textVar?,outputVar?,foreground?}
- aiExtract {source:"clipboard|text",instructions,textVar?,outputVar?}
- wait {ms} | waitFor {kind:"window|process|file",value,mode:"present|absent",timeoutMs}
- expect {kind,value} | screenshot {caption}
- verifyScreen {question,title?,app?} — vision check; use after a repaired flow
- verifyPlayback {title?,intervalMs?} | playMedia {x,y,title} | mediaHold {title,bufferMs?,maxMs?}
- readNote {title?,outputVar?,maxChars?} | writeNote {title,text?,textVar?,append?}
- copyLink {outputVar?} | downloadMedia {url,kind:"video|image|file",filename?}`;

const clip = (value, max = 240) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

function tokens(value) {
  return new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) || []
  );
}

function scoreText(haystack, needles) {
  const words = tokens(haystack);
  let score = 0;
  for (const needle of needles) if (words.has(needle)) score++;
  return score;
}

/** Notes are already durable; surface only the ones that match this failure. */
export function relevantNotes(database = db(), { goal = '', step = null, limit = 3 } = {}) {
  const needles = tokens(`${goal} ${step?.name || ''} ${JSON.stringify(step?.params || {})}`);
  if (!needles.size) return [];
  return (database.notes || [])
    .map((note) => ({
      note,
      score: scoreText(`${note.title || ''} ${note.body || ''}`, needles),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.note.updatedAt || b.note.createdAt || '').localeCompare(String(a.note.updatedAt || a.note.createdAt || '')))
    .slice(0, limit)
    .map(({ note }) => ({
      title: clip(note.title, 120),
      body: clip(note.body, 500),
      tags: (note.tags || []).slice(0, 6),
    }));
}

/** Successful methods from this or another workflow, so repairs get faster. */
export function relevantMethods(database = db(), { step = null, limit = 4 } = {}) {
  return (database.repairMemory || [])
    .filter(
      (entry) =>
        entry.stepType === step?.type ||
        entry.stepName === step?.name ||
        entry.workflowId === step?.workflowId
    )
    .slice()
    .sort((a, b) => Number(b.uses || 0) - Number(a.uses || 0))
    .slice(0, limit)
    .map((entry) => ({
      step: `${entry.stepType} “${entry.stepName || ''}”`,
      method: entry.method,
      replaces: entry.replaces !== false,
      steps: (entry.steps || []).map((saved) => `${saved.type} ${clip(JSON.stringify(saved.params || {}), 220)}`),
      uses: Number(entry.uses || 0),
    }));
}

export function relevantLessons(database = db(), { goal = '', limit = 4 } = {}) {
  const needles = tokens(goal);
  return (database.agentLessons || [])
    .map((entry) => ({ entry, score: scoreText(`${entry.goal || ''} ${entry.lesson || ''}`, needles) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => clip(entry.lesson, 280));
}

function defaultGuard(run, step, workflow) {
  const direct = String(step?.params?.foreground || step?.params?.window || step?.params?.title || '').trim();
  if (direct) return direct;
  const index = run?.steps?.indexOf(step) ?? -1;
  const prior = (run?.steps || []).slice(0, Math.max(0, index)).reverse();
  for (const entry of prior) {
    const checks = windowChecksFor(entry);
    if (checks.length) return checks[0].title || checks[0].process || checks[0].label;
    const p = entry.params || {};
    const value = String(p.foreground || p.window || p.title || p.process || p.target || '').trim();
    if (value && !/[\\/]/.test(value)) return value;
  }
  const app = (workflow?.steps || []).find((entry) => ['launchApp', 'focusWindow', 'openUrl'].includes(entry.type));
  if (app) {
    const checks = windowChecksFor(app);
    if (checks.length) return checks[0].title || checks[0].process || checks[0].label;
  }
  return '';
}

function sanitizeStep(step, guard, { failedStep = null, fallbackApp = null, goal = '' } = {}) {
  if (!step || !ALLOWED_TYPES.has(step.type)) return null;
  const p = { ...(step.params || {}) };
  const failedLabel = String(
    failedStep?.params?.title || failedStep?.params?.process || failedStep?.params?.target || failedStep?.name || ''
  ).trim().toLowerCase();
  // The goal names an app; a repair may use that app, never a substitute.
  const targetsGoalApp = (value) => {
    if (!fallbackApp) return true;
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    const hint = matchAppHint([value]);
    if (hint) return hint.label.toLowerCase() === fallbackApp.name.toLowerCase();
    return text.includes(fallbackApp.name.toLowerCase()) || text === String(fallbackApp.target || '').toLowerCase();
  };
  if (step.type === 'launchApp') {
    const target = String(p.target || '').trim();
    const missingTarget =
      !target ||
      (failedLabel && target.toLowerCase() === failedLabel) ||
      (failedLabel && target.toLowerCase() === `${failedLabel}.exe`);
    if (fallbackApp && (missingTarget || !targetsGoalApp(target))) {
      p.target = fallbackApp.target;
      step = { ...step, name: `Open ${fallbackApp.name}` };
    } else if (missingTarget && failedLabel) {
      return null;
    }
  }
  if ((step.type === 'focusWindow' || step.type === 'windowAction') && fallbackApp) {
    // The window this step names is gone or belongs to another app; use the goal app.
    const title = String(p.title || p.process || '').trim().toLowerCase();
    if (!title || title === failedLabel || !targetsGoalApp(title)) {
      p.title = fallbackApp.title;
      p.process = fallbackApp.process;
    }
  }
  if ((step.type === 'waitFor' || step.type === 'expect') && fallbackApp) {
    // "waitFor window mspaint.exe" never matches a window title; use the goal
    // app's real title or process name.
    const kind = String(p.kind || 'window').toLowerCase();
    const value = String(p.value || '').trim();
    const hint = value ? matchAppHint([value]) : null;
    const looksExecutable = /\.\w+$/.test(value) || Boolean(hint);
    const namesAnotherApp = Boolean(hint && hint.label.toLowerCase() !== fallbackApp.name.toLowerCase());
    if (kind === 'window' && (!value || looksExecutable)) p.value = fallbackApp.title;
    if (kind === 'process' && (!value || looksExecutable)) {
      p.value = String(fallbackApp.process || fallbackApp.target || fallbackApp.name).replace(/\.exe$/i, '');
    }
    // A foreground check written for a substituted app would fail a repair that
    // did the right thing. Only rewrite real app names, never page titles or URLs.
    if (kind === 'foreground' && (!value || namesAnotherApp)) p.value = fallbackApp.title;
  }
  if (step.type === 'verifyScreen' && fallbackApp) {
    // The repair was retargeted to the goal app; a check written for the app the
    // model first thought of would contradict the steps that actually ran.
    const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rewrite = (text) => {
      let out = String(text || '');
      const hint = matchAppHint([out]);
      if (!out || !hint || hint.label.toLowerCase() === fallbackApp.name.toLowerCase()) return out;
      out = out.replace(new RegExp(escape(hint.label), 'gi'), fallbackApp.name);
      if (hint.target) out = out.replace(new RegExp(escape(hint.target), 'gi'), fallbackApp.target);
      return out;
    };
    for (const key of ['question', 'expected', 'app', 'expectedApp', 'title', 'caption']) {
      if (p[key]) p[key] = rewrite(p[key]);
    }
  }
  const text = String(p.text ?? p.textVar ?? '').trim();
  if (step.type === 'type' && !text) return null;
  if (step.type === 'key' && !String(Array.isArray(p.keys) ? p.keys.join('') : p.keys || '').trim()) return null;
  if (step.type === 'clickElement' && !String(p.name || '').trim()) return null;
  if (step.type === 'focusWindow' && !String(p.title || p.process || '').trim()) return null;
  if (step.type === 'windowAction' && !String(p.title || p.process || '').trim()) return null;
  if (step.type === 'waitFor' && !String(p.value || '').trim()) return null;
  if (step.type === 'expect' && !String(p.value || '').trim()) return null;
  if (step.type === 'drag' && ![p.x1, p.y1, p.x2, p.y2].every((value) => Number.isFinite(Number(value)))) return null;
  if (step.type === 'dragCopy' && !p.text && !p.name && ![p.x1, p.y1, p.x2, p.y2].every((value) => Number.isFinite(Number(value)))) return null;
  const allowsClose = /\b(?:close|quit|exit|dismiss|shut\s+down)\b/i.test(String(goal || ''));
  if (step.type === 'closeWindow' && !allowsClose) return null;
  if (step.type === 'windowAction' && String(p.action || '').toLowerCase() === 'close' && !allowsClose) {
    p.action = 'minimize';
  }
  if (INPUT_TYPES.has(step.type)) {
    if (!p.foreground && !p.window && guard) p.foreground = guard;
    if (!p.foreground && step.type !== 'click' && step.type !== 'doubleClick' && step.type !== 'rightClick' && step.type !== 'dragCopy') return null;
  }
  // A guard such as "notepad.exe" never matches a real window title, so the input
  // is refused. Compare against the app name the way window matching does.
  const cleanGuard = (value) => String(value || '').replace(/\.exe$/i, '').trim();
  if (p.foreground) p.foreground = cleanGuard(p.foreground);
  if (p.window) p.window = cleanGuard(p.window);
  if (step.type === 'clickElement' && !p.window && guard) p.window = guard;
  if (step.type === 'type' && p.foreground == null && guard) p.foreground = guard;
  if (step.type === 'wait') p.ms = Math.max(0, Math.min(30000, Number(p.ms) || 500));
  return { ...step, params: p };
}

function sanitizeSteps(raw, { goal, guard, limit, failedStep = null, fallbackApp = null }) {
  const normalized = normalizePlanSteps(raw, goal, {}, { align: false });
  const out = [];
  for (const step of normalized) {
    const clean = sanitizeStep(step, guard, { failedStep, fallbackApp, goal });
    if (!clean) continue;
    const previous = out[out.length - 1];
    if (previous && previous.type === clean.type && JSON.stringify(previous.params) === JSON.stringify(clean.params)) continue;
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/** A repair for a window action must still perform that action on the window. */
function keepsWindowAction(failedStep, steps) {
  if (failedStep?.type !== 'windowAction') return true;
  const action = String(failedStep.params?.action || 'minimize').toLowerCase();
  return (steps || []).some(
    (entry) => entry.type === 'windowAction' && String(entry.params?.action || '').toLowerCase() === action
  );
}

function planOutline(run, failedIndex) {
  return (run?.steps || [])
    .slice(Math.max(0, failedIndex - 2), failedIndex + 6)
    .map((entry, offset) => {
      const index = Math.max(0, failedIndex - 2) + offset;
      const marker = index === failedIndex ? ' <-- FAILED' : '';
      return `${index + 1}. [${entry.status}] ${entry.name} (${entry.type})${entry.output ? ` | ${clip(entry.output, 140)}` : ''}${marker}`;
    })
    .join('\n');
}

function variableBrief(run) {
  return Object.entries(run?.variables || {})
    .map(([key, value]) => `- ${key}: ${clip(value, 180)}`)
    .slice(0, 12)
    .join('\n');
}

/**
 * Ask the repair agent for a replacement sequence or a rewritten remainder.
 * Pass `ask` in tests to avoid a model call.
 */
export async function agentReplan({
  run = null,
  workflow = null,
  step = null,
  index = -1,
  error = '',
  failure = null,
  hindrance = null,
  advice = [],
  ask = null,
  database = db(),
} = {}) {
  if (!run || !step) return null;
  const goal = workflowGoal(workflow, run) || run.workflowName || '';
  const failedIndex = index >= 0 ? index : run.steps.indexOf(step);
  const guard = defaultGuard(run, step, workflow);
  const fallbackApp = appFromGoal(goal);
  const notes = relevantNotes(database, { goal, step, limit: 3 });
  const methods = relevantMethods(database, { step, limit: 4 });
  const lessons = relevantLessons(database, { goal, limit: 4 });
  const attempts = (run.steps || [])
    .filter((entry) => entry.status === 'failed' || entry.status === 'needs_review')
    .map((entry) => `${entry.name} (${entry.type}): ${clip(entry.error || entry.output || 'failed', 150)}`)
    .slice(-4);
  const strategy = strategyBrief({
    goal,
    app: fallbackApp ? { ...fallbackApp, entry: catalogEntry(goal) } : null,
    lessons,
    attempts,
    longTermGoal: database?.settings?.longTermGoal || '',
  });
  const adviceText = (advice || [])
    .map((entry) => `- ${entry.name || entry.kind}: ${entry.advice}`)
    .join('\n');
  const prompt = `GOAL: ${goal || '(not recorded)'}
WORKFLOW: ${run.workflowName || workflow?.name || ''}
FAILED STEP: ${failedIndex + 1}/${run.steps.length} “${step.name}” (${step.type})
PARAMS: ${clip(JSON.stringify(step.params || {}), 900)}
ERROR: ${clip(error || step.error || 'step failed', 1800)}
FAILURE CLASS: ${failure?.category || 'unknown'}
BLOCKING WINDOW / HINDRANCE: ${
    hindrance
      ? `"${hindrance.title}" (${hindrance.process || 'unknown process'}) is in front — clear it, or act inside it, before retrying`
      : '(none detected)'
  }
DEFAULT WINDOW GUARD: ${guard || '(none derived)'}
GOAL FALLBACK APP: ${fallbackApp ? `${fallbackApp.name} (${fallbackApp.target})` : '(none)'}

STRATEGY BRIEF (long-term alignment, method order, continuations — pick the next alternative from here instead of repeating the failed method):
${strategy.text}

PLAN CONTEXT:
${planOutline(run, failedIndex)}

RUN VARIABLES:
${variableBrief(run) || '(none)'}

ENABLED AGENT ADVICE:
${adviceText || '(none)'}

SAVED NOTES THAT MAY HELP:
${notes.length ? notes.map((note) => `- ${note.title}: ${note.body}`).join('\n') : '(none matched)'}

METHODS THAT WORKED BEFORE (this or another workflow):
${methods.length ? methods.map((method) => `- ${method.step}: ${method.method} (used ${method.uses}x) -> ${method.steps.join(' ; ')}`).join('\n') : '(none saved)'}

DURABLE LESSONS:
${lessons.length ? lessons.map((lesson) => `- ${lesson}`).join('\n') : '(none matched)'}

TASK:
First compare the screen with what the failed step was trying to produce. If the desktop already shows that state — a Save/Open/install dialog, the app window, the requested page — repair by continuing from it (type into the open dialog, click its own Next/Save/Finish, focus the existing window) instead of restarting the flow, relaunching the app or opening another download. Set params.preview:true on a critical click so the screen is read before it, and params.humanize:true when the pointer must pass over a menu.
Diagnose why this failed and choose the fastest reliable fix. You may use your Windows/UI-automation knowledge to research an unfamiliar method; do not claim web access. Do not repeat the failed action unchanged.
If the failed step is a windowAction (minimize, maximize, restore), the repair must contain that same action on the same window; opening a different app is not a fix.
Use only the app the goal names; never substitute another app. Keep the repair to the fewest steps that perform the failed action and prove it.
Continue from the furthest step that already passed and from the current screen; do not rebuild phases that worked. If the failure is a blocker — an error or confirmation dialog, an installer window, a download page, a loader — deal with that blocker (dismiss it, click its own Next/Finish/Cancel, or act inside it) and then retry only the failed step.
If the failed step is a playback check, read the error: "never started" (progress at 0:00, play overlay) means start the media from the player's own control or reopen the same file once; "paused" or "buffering" means resume and wait; "finished" means the video already played, so verify the end state instead of replaying it. A video that demonstrably played to its end is a success, not a failure.
When the remaining steps are still valid, return them as remainingSteps so the run continues instead of failing the whole workflow.
If a window/focus target is missing, do not pass that window title to launchApp as an executable. Launch a real executable/app named by the goal (Calculator = calc.exe, Notepad = notepad.exe) or use another route entirely.
Return JSON only:
{
  "diagnosis": "one or two specific sentences",
  "method": "short name of the fix",
  "confidence": 0.0,
  "steps": [ ...up to ${MAX_REPAIR_STEPS} steps... ],
  "replacesStep": true,
  "remainingSteps": [ ...optional, up to ${MAX_REMAINING_STEPS}... ],
  "remember": "optional durable lesson for next time"
}
Semantics:
- If "replacesStep" is true, "steps" fully replace the failed step.
- If false, "steps" run first (prerequisite/setup), then the original failed step is retried.
- Use "remainingSteps" only when the failed step cannot be repaired and the rest of the plan should be rewritten from the current screen. It replaces all later pending steps, so include the remaining actions and at least one verification. Do not repeat phases that already passed.
- Every type/key/clipboard/drag/scroll input needs params.foreground (or clickElement params.window).
${TYPE_GUIDE}`;
  const system =
    'You are the live repair agent inside a Windows desktop automation runner. Be concrete and fast. Prefer visible UI Automation controls over guessed pixels. Diagnose from the error, the prior steps and the screen state, not from assumptions. Preserve verification: never lower a check to make a step pass. Return JSON only.';
  let reply;
  try {
    reply = typeof ask === 'function'
      ? await ask({ prompt, system })
      : await chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          {
            format: 'json',
            kind: 'replan',
            timeoutMs: 60000,
            temperature: 0.15,
            maxTokens: 5000,
            ...(database?.settings?.replanModel ? { model: database.settings.replanModel } : {}),
          }
        );
  } catch (err) {
    return { ok: false, error: String(err.message || err), diagnosis: 'AI repair call failed.', steps: [], remainingSteps: [] };
  }
  if (!reply || reply.ok === false) {
    return { ok: false, error: String(reply?.error || 'AI repair unavailable'), diagnosis: 'AI repair unavailable.', steps: [], remainingSteps: [] };
  }
  const content = typeof reply === 'string' ? reply : reply.content;
  let parsed;
  try {
    parsed = typeof content === 'object' && content ? content : parseJsonLoose(content);
  } catch {
    parsed = null;
  }
  if (!parsed) return { ok: false, error: 'AI repair reply was not JSON.', steps: [], remainingSteps: [] };
  const asList = (value) => {
    if (Array.isArray(value)) return value;
    if (value == null || value === '') return [];
    return [value];
  };
  const rawSteps = Array.isArray(parsed)
    ? parsed
    : parsed.steps ?? parsed.replacementSteps ?? parsed.prerequisiteSteps ?? parsed.newSteps ?? parsed.actions;
  const rawRemaining = parsed.remainingSteps ?? parsed.remaining ?? parsed.nextSteps ?? [];
  const stepList = asList(rawSteps);
  const remainingList = asList(rawRemaining);
  let steps = sanitizeSteps(stepList, { goal, guard, limit: MAX_REPAIR_STEPS, failedStep: step, fallbackApp });
  let remainingSteps = sanitizeSteps(remainingList, { goal, guard, limit: MAX_REMAINING_STEPS, failedStep: step, fallbackApp });
  // Opening another app is not a fix for a window action; the action has to run.
  if (steps.length && !keepsWindowAction(step, steps)) {
    console.log('[replan] replacement rejected: it does not perform the failed window action');
    steps = [];
  }
  if (remainingSteps.length && !keepsWindowAction(step, remainingSteps)) {
    console.log('[replan] remainder rejected: it does not perform the failed window action');
    remainingSteps = [];
  }
  // A rewritten remainder may only replace a failed action if it proves the
  // goal independently. Without a verification step it is not a repair.
  const VERIFY_TYPES = new Set(['verifyScreen', 'expect', 'verifyPlayback', 'mediaHold', 'waitFor']);
  if (remainingSteps.length && !remainingSteps.some((entry) => VERIFY_TYPES.has(entry.type))) {
    console.log('[replan] remainder rejected: no verification step');
    remainingSteps = [];
  }
  const diagnosis = clip(parsed.diagnosis || parsed.reason || '', 700);
  const method = clip(parsed.method || parsed.name || diagnosis.slice(0, 80) || 'AI replan', 120);
  const replacesStep = Boolean(parsed.replacesStep ?? parsed.replaces ?? (steps.length > 0 && parsed.retryOriginal !== true));
  console.log(
    '[replan]',
    `step=${step.type}`,
    `method=${method}`,
    `steps=${steps.length}`,
    `remaining=${remainingSteps.length}`,
    `replaces=${replacesStep}`
  );
  if (!steps.length && !remainingSteps.length) {
    console.log('[replan] unusable reply', clip(content, 1200));
  }
  return {
    ok: Boolean(steps.length || remainingSteps.length),
    source: 'agent-replan',
    diagnosis,
    method,
    confidence: Number(parsed.confidence) || null,
    steps,
    replacesStep,
    remainingSteps,
    remember: clip(parsed.remember || parsed.lesson || '', 500),
    at: new Date().toISOString(),
  };
}

/** Persist a durable lesson from a successful AI repair. */
export function rememberAgentLesson(
  database,
  { goal = '', workflowId = '', step = null, method = '', diagnosis = '', lesson = '' } = {}
) {
  if (!database || !lesson) return null;
  if (!Array.isArray(database.agentLessons)) database.agentLessons = [];
  const entry = {
    id: `les_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    goal: clip(goal, 300),
    workflowId,
    stepType: step?.type || '',
    stepName: step?.name || '',
    method: clip(method, 160),
    diagnosis: clip(diagnosis, 500),
    lesson: clip(lesson, 500),
    uses: 1,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  const existing = database.agentLessons.find(
    (item) => item.lesson === entry.lesson && item.workflowId === entry.workflowId
  );
  if (existing) {
    existing.uses = Number(existing.uses || 0) + 1;
    existing.lastUsedAt = entry.lastUsedAt;
    return existing;
  }
  database.agentLessons.unshift(entry);
  database.agentLessons = database.agentLessons.slice(0, MAX_LESSONS);
  return entry;
}
