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
} = {}) {
  const system =
    'You revise the plan of a Windows desktop automation workflow after one of its steps failed. ' +
    'You do not lower verification and you do not claim work happened. ' +
    'Return JSON only: {"decision":"continue|rearrange|rebuild","note":"one sentence explaining the change",' +
    '"prep":[{step}],"steps":[{step}]}. No prose outside the JSON.';

  const plan = (steps || []).length
    ? steps.map((step, index) => `${stepLine(step, index)}${index === failedIndex ? '  <-- failed here' : ''}`).join('\n')
    : 'no steps';
  const remaining = (steps || []).slice(failedIndex);
  const types = STEP_TYPES.map((entry) => `${entry.type} (${entry.group})`).join(', ');

  const prompt = `Goal: ${text(goal || workflow.description || workflow.name || 'unknown', 700)}
Workflow: ${text(workflow.name, 90)} — ${text(workflow.description, 400)}

Plan and outcome so far:
${plan}

Failure: ${text(failure.type, 30)} “${text(failure.name, 80)}” — ${text(failure.error, 600)}
Remaining steps that never ran: ${remaining.length}
${remaining.map((step, index) => `${index + 1}) ${step.type} “${text(step.name || step.type, 60)}” ${text(JSON.stringify(step.params || {}), 160)}`).join('\n')}

Live desktop right now:
${desktopSummary(desktop)}

Rules, suggestions and lessons:
${rulesSummary({ suggestions, lessons })}

Other workflows that already solve similar work:
${workflowSummary(workflows) || 'none'}

Available step types: ${types}
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
6. At most ${MAX_STEPS} steps in "steps", at most ${MAX_PREP} in "prep".`;

  return { system, prompt };
}

/**
 * Turn a model reply into a runnable plan. The passed prefix is preserved so a
 * retry continues from where the run stopped, prep is filtered to safe types and
 * a typing step without a window inherits the one the failed step used.
 */
export function applyRevision(
  reply,
  { steps = [], failedIndex = 0, goal = '', keepPassed = true } = {}
) {
  const parsed = typeof reply === 'string' ? parseJsonLoose(reply) : reply;
  if (!parsed || typeof parsed !== 'object') return null;
  const decision = DECISIONS.includes(parsed.decision) ? parsed.decision : 'rearrange';
  const guard = String(steps?.[failedIndex]?.params?.foreground || '').trim();

  const prep = normalizePlanSteps(parsed.prep, goal, {}, { align: false })
    .filter((step) => PREP_TYPES.has(step.type))
    .slice(0, MAX_PREP);

  const revised = normalizePlanSteps(parsed.steps, goal, {}, { align: false })
    .filter((step) => !FORBIDDEN_TYPES.has(step.type))
    .map((step) => {
      if (!['type', 'key', 'clipboard'].includes(step.type)) return step;
      if (String(step.params?.foreground || '').trim() || !guard) return step;
      return { ...step, params: { ...(step.params || {}), foreground: guard } };
    });

  const rest = decision === 'continue' ? (revised.length ? revised : steps.slice(failedIndex)) : revised;
  if (!rest.length) return null;

  const prefix = keepPassed ? steps.slice(0, Math.max(0, Math.min(failedIndex, steps.length))) : [];
  const merged = [...prefix, ...prep, ...rest]
    .slice(0, MAX_STEPS)
    .map((step, index) => ({ ...step, name: String(step.name || `Step ${index + 1}`).slice(0, 100) }));

  return {
    decision,
    steps: merged,
    prepCount: prep.length,
    resumeFrom: prefix.length,
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
  return { error: typeof reply === 'object' && reply?.error ? reply.error : 'the model returned no usable plan' };
}

export const REPLAN_LIMITS = { MAX_STEPS, MAX_PREP, PREP_TYPES, FORBIDDEN_TYPES };
