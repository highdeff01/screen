/**
 * Whole-plan revision for a run that failed.
 *
 * The per-step repair agent rewrites the remainder from one failure. This agent
 * answers the question the operator asks after a failed run: continue from where
 * it stopped, or add / remove / reorder steps — and does the machine need basic
 * prep (open the app, look around) before another attempt. It sees the plan with
 * every step's outcome, the live desktop (open windows and tabs), the saved
 * rules, lessons and the other workflows, and returns a plan that begins after
 * the steps that already passed. Nothing here executes: the result is a
 * candidate that is shadow-tested like any other recovery plan.
 */

import { chat, parseJsonLoose } from './llm.js';
import { normalizePlanSteps } from './planner.js';
import { STEP_TYPES } from './automation.js';
import { courtesyBrief } from './courtesy.js';

const MAX_STEPS = 24;
const MAX_PREP = 4;
const MAX_WINDOWS = 14;
const MAX_WORKFLOWS = 12;

// Prep may look around and put the machine in the state the plan needs. It may
// not act on a document, click a guessed pixel or install anything.
const PREP_TYPES = new Set(['launchApp', 'openUrl', 'focusWindow', 'waitFor', 'wait', 'screenshot', 'readNote']);

// A revision may not hand the runner work that reaches outside the goal.
const FORBIDDEN_TYPES = new Set([
  'runTool',
  'installApp',
  'downloadMedia',
  'recordVideo',
  'watchVideo',
  'testApp',
  'writeTextFile',
  'closeWindow',
]);

// Video and playback work. A revision may only keep these when the operator
// allows them and the goal (or a real step) actually needs them: a bare "press
// play" with nothing to act on is the step that hangs a run.
const MEDIA_TYPES = new Set(['playMedia', 'mediaHold', 'watchVideo', 'recordVideo']);
const MEDIA_WORDS = /\b(?:play|plays|playing|paused|playback|watch|video|audio|music|movie|clip|youtube|listen|stream)\b/i;
// Failures that may clear on their own. Only then may a retry replay the exact
// step that just failed, because the next attempt has a real chance to differ.
const TRANSIENT_FAILURE = /\b(?:timeout|timed out|timed-out|not ready|still loading|loading|busy|try again|temporar|transient|interrupted|interrupt|network|connection reset|econnreset|etimedout|eai_again|unavailable|throttl|rate limit|not responding|503|429)\b/i;

const DECISIONS = ['continue', 'rearrange', 'rebuild'];

function text(value, max = 240) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function stepLine(step, index) {
  const params = Object.entries(step?.params || {})
    .slice(0, 6)
    .map(([key, value]) => `${key}=${text(JSON.stringify(value), 60)}`)
    .join(' ');
  return `${index + 1}. [${step?.status || 'pending'}] ${step?.type || 'step'} “${text(step?.name || step?.type, 80)}” ${params}`;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortedValue(value[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function stepKey(step) {
  return JSON.stringify([step?.type || '', sortedValue(step?.params || {})]);
}

/** True when a planned step is the same step, unchanged, that just failed. */
export function replaysFailedStep(step, failed) {
  if (!step || !failed) return false;
  return stepKey(step) === stepKey(failed);
}

/** True when the failure looks like something that may clear on its own. */
export function isTransientFailure(failure = {}) {
  const message = `${failure?.type || ''} ${failure?.name || ''} ${failure?.error || ''} ${failure?.message || ''}`;
  return TRANSIENT_FAILURE.test(message);
}

/** True when a retry would start with the failed step, unchanged, all over again. */
export function retryReplaysFailure({ failedStep = null, firstNext = null, failure = null } = {}) {
  if (!failedStep || !replaysFailedStep(firstNext, failedStep)) return false;
  return !isTransientFailure(failure || { type: failedStep.type, name: failedStep.name, error: failedStep.error });
}

/**
 * The window guard the engine just refused, when the failure was that refusal.
 * The run expected one window and found another in front; handing the same guard
 * to the retry re-arms a value the desktop has already rejected. The quoted
 * foreground is the window that is really open, and its process is the durable
 * half of it: the title changes as text is typed into the document.
 */
export function refusedWindow(failure = {}) {
  const message = `${failure?.error || ''} ${failure?.message || ''}`;
  const match = message.match(/Refusing to [^:]+: foreground window is "([^"]*)",\s+expected process\s+or window "([^"]*)"/i);
  if (!match) return null;
  const actual = match[1].trim();
  const expected = match[2].trim();
  if (!expected) return null;
  const process = actual.includes(' :: ') ? actual.split(' :: ')[0].trim() : '';
  return { expected, actual, process };
}

/**
 * Small models sometimes answer with one textual step per entry, for example
 * {"step":"type \"Type the note\" text=\"hello\" foreground=\"Untitled - Notepad\""}.
 * Read that shape instead of discarding a revision that is otherwise complete.
 */
function expandStepEntries(raw) {
  return (Array.isArray(raw) ? raw : []).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const source = typeof entry.step === 'string' ? entry.step.trim() : '';
    if (!source) return entry;
    const head = source.match(/^([a-zA-Z][\w-]*)\s+/);
    if (!head) return entry;
    const rest = source.slice(head[0].length);
    const nameMatch = rest.match(/^"([^"]*)"/);
    const tail = nameMatch ? rest.slice(nameMatch[0].length) : rest;
    const params = {};
    for (const pair of tail.matchAll(/([\w.-]+)\s*=\s*"([^"]*)"/g)) params[pair[1]] = pair[2];
    for (const pair of tail.matchAll(/([\w.-]+)\s*=\s*([^\s"]+)/g)) {
      if (params[pair[1]] === undefined) params[pair[1]] = pair[2];
    }
    if (!Object.keys(params).length && !nameMatch) return entry;
    return { type: head[1], ...(nameMatch ? { name: nameMatch[1] } : {}), params };
  });
}

/** Playback is required only by the goal or by work that feeds it, not by a play step itself. */
function planWantsPlayback(goal, steps = []) {
  if (MEDIA_WORDS.test(String(goal || ''))) return true;
  return (steps || []).some((step) => {
    if (!step || MEDIA_TYPES.has(step.type)) return false;
    const p = step.params || {};
    return MEDIA_WORDS.test(
      `${step.name || ''} ${p.url || ''} ${p.target || ''} ${p.title || ''} ${p.kind || ''} ${p.text || ''} ${p.app || ''}`
    );
  });
}

/** The desktop the revision may reason about: the window in front and other open windows. */
export function desktopSummary(desktop = {}) {
  const foreground = desktop?.foreground || {};
  const windows = Array.isArray(desktop?.windows) ? desktop.windows.slice(0, MAX_WINDOWS) : [];
  const front = foreground.title ? `${text(foreground.title, 120)} (${text(foreground.process || 'unknown', 40)})` : 'unknown';
  const others = windows
    .filter((entry) => entry?.title && entry.title !== foreground.title)
    .map((entry) => `${text(entry.title, 90)} (${text(entry.process || 'unknown', 30)})`);
  return `Foreground: ${front}${others.length ? `\nOther open windows: ${others.join(' · ')}` : '\nNo other open windows.'}`;
}

function rulesSummary({ suggestions = [], lessons = [] } = {}) {
  const rows = [
    ...(suggestions || []).slice(0, 6).map((entry) => `suggestion: ${text(entry?.text ?? entry, 200)}`),
    ...(lessons || []).slice(0, 6).map((entry) => `lesson: ${text(entry?.lesson ?? entry, 200)}`),
  ];
  return rows.length ? rows.join('\n') : 'none saved';
}

function workflowSummary(workflows = []) {
  return (workflows || [])
    .slice(0, MAX_WORKFLOWS)
    .map((entry) => `- ${text(entry?.name, 80)} [${text((entry?.tags || []).join(','), 60) || 'untagged'}] ${text(entry?.description, 110)}`)
    .join('\n');
}

export function buildRevisionPrompt({
  workflow = {},
  goal = '',
  steps = [],
  failedIndex = 0,
  failure = {},
  desktop = {},
  suggestions = [],
  lessons = [],
  workflows = [],
  evidence = [],
  allowMedia = true,
} = {}) {
  const system =
    'You revise the plan of a Windows desktop automation workflow after one of its steps failed. ' +
    'You do not lower verification and you do not claim work happened. ' +
    'Return JSON only: {"decision":"continue|rearrange|rebuild","note":"one sentence explaining the change",' +
    '"prep":[],"steps":[]}. Every prep and steps entry is one step object such as ' +
    '{"type":"launchApp","name":"Open Notepad","params":{"target":"notepad.exe"}} — never a string and never a nested "step" field. ' +
    'No prose outside the JSON.';

  const plan = (steps || []).length
    ? steps.map((step, index) => `${stepLine(step, index)}${index === failedIndex ? '  <-- failed here' : ''}`).join('\n')
    : 'no steps';
  const remaining = (steps || []).slice(failedIndex);
  const types = STEP_TYPES.map((entry) => `${entry.type} (${entry.group})`).join(', ');
  const refused = refusedWindow(failure);
  const facts = (Array.isArray(evidence) ? evidence : []).slice(0, 10).map((entry) => `- ${text(entry, 220)}`);

  const prompt = `Goal: ${text(goal || workflow.description || workflow.name || 'unknown', 700)}
Workflow: ${text(workflow.name, 90)} — ${text(workflow.description, 400)}

Plan and outcome so far:
${plan}

Failure: ${text(failure.type, 30)} “${text(failure.name, 80)}” — ${text(failure.error, 600)}
${refused ? `Refused window guard: the run expected “${text(refused.expected, 120)}” but the foreground was “${text(refused.actual, 160)}”. That guard is a value the desktop just rejected — do not reuse it. Name the window that is really open, or open and focus the intended one first.\n` : ''}
Facts already on record for this run (evidence and outputs — they do not prove a step passed):
${facts.length ? facts.join('\n') : '- none recorded'}

Remaining steps that never ran: ${remaining.length}
${remaining.map((step, index) => `${index + 1}) ${step.type} “${text(step.name || step.type, 60)}” ${text(JSON.stringify(step.params || {}), 160)}`).join('\n')}

Live desktop right now:
${desktopSummary(desktop)}

Rules, suggestions and lessons:
${rulesSummary({ suggestions, lessons })}

Other workflows that already solve similar work:
${workflowSummary(workflows) || 'none'}

Available step types: ${types}
${courtesyBrief({ goal: goal || workflow.description || workflow.name || '' })}
Prep is limited to: launchApp, openUrl, focusWindow, waitFor, wait, screenshot, readNote.

Decide:
- "continue" — the plan is right; keep the remaining steps and retry from where it stopped.
- "rearrange" — same goal, but steps must be reordered, added or removed (return the corrected remainder).
- "rebuild" — the plan cannot reach the goal as written (return a fresh remainder).

Rules for the answer:
1. Never repeat a step that already passed; the retry starts after the failure point.
2. Use "prep" for basic preparation only: opening or focusing the app, waiting for a window, a read-only look at the screen. Prep must not type into a document the run did not open, must not close the operator's windows and must not move the pointer around their work.
3. The operator may be using this machine. Prefer the smallest number of steps that completes the goal and gives their windows back.
4. Every type / key / clipboard step needs params.foreground (the window it types into) or params.window for clickElement.
5. Do not use runTool, installApp, downloadMedia, recordVideo, watchVideo, testApp, writeTextFile or closeWindow.
6. At most ${MAX_STEPS} steps in "steps", at most ${MAX_PREP} in "prep".
7. ${allowMedia
    ? 'Playback and recording steps (playMedia, mediaHold, watchVideo, recordVideo) are only for work the goal asks for. A "press play" step that no earlier step and no user input acts on is the step that hangs a run: re-check the workflow and replace it with the step that actually moves the goal forward instead of pressing play again.'
    : 'The operator turned video and playback steps off for revisions: do not return playMedia, mediaHold, watchVideo or recordVideo.'}
8. "continue" means the remaining steps are still right, but still return the remainder you stand behind. Returning the failed step unchanged with no prep and nothing else adjusted is refused, because the retry fails the same way.
9. Recorded evidence is context, not completion: never skip, drop or mark a step done because a screenshot or output exists. Use the facts to choose the step that still has to happen.
10. When a window guard was refused, do not copy the refused value into the retry. Name the window that is really open, or add a prep step that opens and focuses the right one.`;

  return { system, prompt };
}

/**
 * Turn a model reply into a runnable plan. The passed prefix is preserved so a
 * retry continues from where the run stopped, prep is filtered to safe types and
 * a typing step without a window inherits the one the failed step used.
 */
export function applyRevision(
  reply,
  { steps = [], failedIndex = 0, goal = '', failure = {}, keepPassed = true, allowMedia = true } = {}
) {
  const parsed = typeof reply === 'string' ? parseJsonLoose(reply) : reply;
  if (!parsed || typeof parsed !== 'object') return null;
  const decision = DECISIONS.includes(parsed.decision) ? parsed.decision : 'rearrange';
  // A guard the engine just refused is never inherited: it is a value the
  // desktop rejected, so the retry would refuse again for the same reason.
  const refused = refusedWindow(failure);
  const failedGuard = String(steps?.[failedIndex]?.params?.foreground || '').trim();
  const guard = refused ? '' : failedGuard;
  const refusedValues = refused
    ? new Set([refused.expected.toLowerCase(), refused.actual.toLowerCase()].filter(Boolean))
    : null;
  let rewrittenGuards = 0;
  // Playback survives only when the operator allows it and the goal or a real
  // step needs it; a bare "press play" is dropped and counted instead of kept.
  const playbackWanted = allowMedia && planWantsPlayback(goal, [...steps, ...(parsed.prep || [])]);
  const dropped = [];
  const keepStep = (step) => {
    if (!MEDIA_TYPES.has(step.type) || playbackWanted) return true;
    dropped.push(step);
    return false;
  };

  const prep = normalizePlanSteps(expandStepEntries(parsed.prep), goal, {}, { align: false })
    .filter((step) => PREP_TYPES.has(step.type))
    .filter(keepStep)
    .slice(0, MAX_PREP);

  const revised = normalizePlanSteps(expandStepEntries(parsed.steps), goal, {}, { align: false })
    .filter((step) => !FORBIDDEN_TYPES.has(step.type))
    .filter(keepStep)
    .map((step) => {
      if (!['type', 'key', 'clipboard'].includes(step.type)) return step;
      const current = String(step.params?.foreground || '').trim();
      if (refusedValues && current && refusedValues.has(current.toLowerCase())) {
        // The model repeated the refused guard (or the transient window that
        // refused it). A process-level guard survives the title change; with no
        // process to use, leave the step unguarded so the runner skips it rather
        // than typing into whatever happens to be in front.
        rewrittenGuards += 1;
        if (!refused.process) {
          const { foreground: _refusedGuard, ...rest } = step.params || {};
          return { ...step, params: rest };
        }
        return { ...step, params: { ...(step.params || {}), foreground: refused.process } };
      }
      // With a refused guard there is nothing safe to inherit; a step the model
      // left unguarded stays unguarded (the runner will not type blindly).
      if (current || !guard) return step;
      return { ...step, params: { ...(step.params || {}), foreground: guard } };
    });

  const fallback = steps.slice(failedIndex).filter(keepStep);
  const rest = decision === 'continue' ? (revised.length ? revised : fallback) : revised;
  if (!rest.length) return null;

  const prefix = keepPassed ? steps.slice(0, Math.max(0, Math.min(failedIndex, steps.length))) : [];
  const merged = [...prefix, ...prep, ...rest]
    .slice(0, MAX_STEPS)
    .map((step, index) => ({ ...step, name: String(step.name || `Step ${index + 1}`).slice(0, 100) }));
  // "continue" with no new steps hands the retry the exact step that failed, so
  // the caller can refuse it unless the failure may clear on its own.
  const replaysFailure = replaysFailedStep([...prep, ...rest][0], steps?.[failedIndex] || null);

  return {
    decision,
    steps: merged,
    prepCount: prep.length,
    resumeFrom: prefix.length,
    replaysFailure,
    droppedPlayback: dropped.length,
    mediaEnabled: allowMedia,
    refusedGuard: refused ? { expected: refused.expected, actual: refused.actual, process: refused.process || null } : null,
    rewrittenGuards,
    note: text(parsed.note || parsed.reason || '', 400),
  };
}

/** Ask the model for a revision. Returns {error} instead of throwing when it cannot. */
export async function revisePlan({ ask, timeoutMs = 60000, ...input } = {}) {
  const { system, prompt } = buildRevisionPrompt(input);
  let reply;
  try {
    reply = typeof ask === 'function'
      ? await ask({ prompt, system })
      : await chat(
          [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          { format: 'json', kind: 'replan', timeoutMs, temperature: 0.2, maxTokens: 3000 }
        );
  } catch (err) {
    return { error: err.message };
  }
  const content = reply && typeof reply === 'object' && 'ok' in reply ? (reply.ok ? reply.content : '') : reply;
  const applied = applyRevision(content, input);
  if (applied) return applied;
  if (typeof reply === 'object' && reply?.error) return { error: reply.error };
  // Keep what the model actually said: without it an unusable reply is
  // indistinguishable from a truncated one when the pack is reviewed later.
  const raw = typeof content === 'string' ? content : JSON.stringify(content || '');
  return { error: `the model returned no usable plan: ${text(raw, 320) || '(empty reply)'}` };
}

export const REPLAN_LIMITS = { MAX_STEPS, MAX_PREP, PREP_TYPES, FORBIDDEN_TYPES, MEDIA_TYPES };
