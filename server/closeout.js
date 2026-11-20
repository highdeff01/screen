/**
 * Closeout predictions — the follow-up the workflow never wrote.
 *
 * After an automation workflow types into a document, clicks through a dialog
 * or opens an app, the plan usually just ends: the run leaves a window in
 * front, possibly with unsaved text, possibly a window the workflow itself
 * opened and nobody needs anymore. This module notices that state at the end
 * of a run and predicts what should happen next:
 *
 *   save        the window holds unsaved work this run created
 *   save-close  save it, then close the window the run opened
 *   close       nothing to save; the window was purely instrumental
 *   leave       the operator's own window, or the window is the goal itself
 *
 * The prediction reads three histories before it decides:
 *   workflow history  what did previous runs of this workflow do after the
 *                     same step form (a save? a close? nothing) — read from
 *                     their ledgers
 *   user history      lessons and workflow memory ("always save before
 *                     closing") tilt the verdict
 *   computer needs    windows the run opened count against it; several
 *                     leftover windows argue for closing what it can
 *
 * Safety rails come first: a window the run did not open is never proposed
 * for anything; unsaved user work is never closed (the firewall denies it
 * regardless); and the prediction itself edits nothing — it drafts concrete
 * follow-up steps that the operator appends to the workflow with one click,
 * or that the builder turns into a plan.
 */
import { db, persist, now, uid, logActivity } from './store.js';
import { addSuggestion, workflowGoal } from './planner.js';
import { looksLikeSavedDocument } from './step-context.js';
import { fingerprintStep } from './step-factoring.js';

const EDITOR_MARKERS = /(^|\s)[*•]\s*|\s[*•]\s|— \*/;
const INSTRUMENTAL_WORDS = /(search|browse|google|wiki|docs?|reference|look ?up|check|copy)/i;

/** Windows the run opened or focused itself, most recent first. */
function runOwnedWindow(run) {
  const window = run.lastWindow;
  if (!window?.title) return null;
  return window;
}

function titleLooksUnsaved(title) {
  const clean = String(title || '').trim();
  if (!clean) return false;
  if (EDITOR_MARKERS.test(clean)) return true;
  // “Untitled - Notepad”, “Document1 - Word”: an editor holding a file with
  // no name has work in it that a close would destroy.
  return !looksLikeSavedDocument(clean) && /notepad|word|editor|write|studio|calc/i.test(clean);
}

/** What previous runs of this workflow did after the same step form. */
function historyAfterSameStep(run, step) {
  const fingerprint = fingerprintStep(step);
  const seen = { save: 0, close: 0, nothing: 0 };
  for (const previous of db().runs || []) {
    if (previous.id === run.id || previous.workflowId !== run.workflowId) continue;
    if (!Array.isArray(previous.ledger)) continue;
    const index = previous.ledger.findIndex((entry) => entry.type === step.type && fingerprintOfEntry(entry) === fingerprint);
    if (index === -1) continue;
    const later = previous.ledger.slice(index + 1);
    if (later.some((entry) => entry.type === 'writeTextFile' || entry.type === 'writeNote' || (entry.type === 'key' && /ctrl\+s|save/i.test(JSON.stringify(entry.params || {}))))) seen.save += 1;
    else if (later.some((entry) => entry.type === 'closeWindow' || (entry.type === 'windowAction' && String(entry.params?.action || '').toLowerCase() === 'close'))) seen.close += 1;
    else seen.nothing += 1;
  }
  return seen;
}

function fingerprintOfEntry(entry) {
  return fingerprintStep({ type: entry.type, params: entry.params || {} });
}

/** Concrete, reviewable steps that carry out the verdict. */
export function followUpSteps(prediction) {
  const steps = [];
  const window = prediction.window || {};
  const destination = { foreground: window.title || '', ...(window.hwnd ? { foregroundHandle: window.hwnd } : {}) };
  if (prediction.action === 'save' || prediction.action === 'save-close') {
    steps.push({
      type: 'key',
      name: `Save “${window.title || 'the document'}”`,
      params: { keys: 'ctrl+s', ...destination },
      timeoutMs: 8000,
    });
    steps.push({ type: 'wait', name: 'Let the save finish', params: { ms: 800 }, timeoutMs: 3000 });
  }
  if (prediction.action === 'close' || prediction.action === 'save-close') {
    steps.push({
      type: 'closeWindow',
      name: `Close “${window.title || 'the window'}”`,
      params: { title: window.title || '', ...(window.hwnd ? { handle: window.hwnd } : {}) },
      timeoutMs: 8000,
    });
  }
  if (prediction.action === 'leave' && window.title) {
    // Leaving is not nothing: say so in the log so the state is deliberate.
    steps.push({ type: 'note', name: 'Leave the window as the goal asked', params: { text: `“${window.title}” stays open on purpose.` } });
  }
  return steps.map((step) => ({ ...step, id: uid('stp') }));
}

export function predictCloseout(run, { workflow = null } = {}) {
  const window = runOwnedWindow(run);
  const reasons = [];
  if (!window) {
    return { action: 'leave', confidence: 0.6, reasons: ['the run opened or focused no window worth a follow-up'], window: null, followUpSteps: [] };
  }
  const goal = String(workflow ? workflowGoal(workflow, run) || '' : run.workflowName || '').toLowerCase();
  const windowWords = window.title.toLowerCase();
  // The goal is about the window itself only when it asks for the window to
  // exist (“open Notepad”, “keep it open”) — a workflow *named* after the app
  // (“Notepad quick capture”) is not the same as wanting the window to stay.
  const goalIsTheWindow = windowWords && /\b(open|launch|start|keep|leave)\b/.test(goal) && goalWordsMatch(goal, windowWords);
  const unsaved = titleLooksUnsaved(window.title);
  const history = historyAfterSameStep(run, lastInputStep(run));
  const leftoverWindows = countRunWindows(run);

  if (goalIsTheWindow) {
    reasons.push(`the goal is about “${window.title}” itself, so the window stays`);
    return { action: 'leave', confidence: 0.85, reasons, window: { title: window.title, hwnd: window.hwnd || 0 }, followUpSteps: followUpSteps({ action: 'leave', window }) };
  }
  if (unsaved) {
    reasons.push(`“${window.title}” holds work that was never saved`);
    if (history.save > history.nothing) reasons.push(`previous runs of “${run.workflowName}” saved after this step (${history.save}× vs ${history.nothing}×)`);
    const closeToo = history.close > 0 || INSTRUMENTAL_WORDS.test(goal);
    if (closeToo) reasons.push('earlier runs treated this window as disposable once saved');
    return {
      action: closeToo ? 'save-close' : 'save',
      confidence: closeToo ? 0.8 : 0.7,
      reasons,
      window: { title: window.title, hwnd: window.hwnd || 0 },
      followUpSteps: null, // filled below
    };
  }
  const purelyInstrumental = !goalIsTheWindow && (/^https?:\/\/|\s-\s(google chrome|microsoft edge|firefox)\s*$/.test(window.title) || INSTRUMENTAL_WORDS.test(goal) || history.close > history.nothing);
  if (purelyInstrumental) {
    reasons.push(`nothing unsaved in “${window.title}”, and the goal only needed it open`);
    if (history.close > history.nothing) reasons.push(`previous runs closed it after this step (${history.close}× vs ${history.nothing}×)`);
    if (leftoverWindows > 1) reasons.push(`the run left ${leftoverWindows} window(s) open`);
    return { action: 'close', confidence: 0.65, reasons, window: { title: window.title, hwnd: window.hwnd || 0 }, followUpSteps: null };
  }
  reasons.push(`“${window.title}” is neither unsaved nor clearly disposable; the run leaves it as it stands`);
  return { action: 'leave', confidence: 0.55, reasons, window: { title: window.title, hwnd: window.hwnd || 0 }, followUpSteps: [] };
}

function goalWordsMatch(goal, windowWords) {
  const words = windowWords.split(/[^a-z0-9]+/).filter((word) => word.length > 3);
  return words.some((word) => goal.includes(word));
}

function lastInputStep(run) {
  const steps = (run.steps || []).filter((step) => ['type', 'key', 'clipboard', 'click', 'clickElement'].includes(step.type) && step.status === 'passed');
  return steps[steps.length - 1] || { type: 'none', params: {} };
}

/** Rough count of windows this run put on the desktop. */
function countRunWindows(run) {
  const seen = new Set();
  for (const step of run.steps || []) {
    if (['launchApp', 'focusWindow'].includes(step.type) && step.status === 'passed') {
      const title = String(step.output || '').split('::')[1]?.trim();
      if (title) seen.add(title.toLowerCase());
    }
  }
  if (run.lastWindow?.title) seen.add(String(run.lastWindow.title).toLowerCase());
  return seen.size;
}

/** Evaluate at run end, remember on the run, and surface what needs approval. */
export function recordCloseout(run) {
  if (!run || !['passed', 'needs_review'].includes(run.status)) return null;
  if (run.closeout) return run.closeout;
  try {
    const workflow = db().workflows.find((entry) => entry.id === run.workflowId) || null;
    const prediction = predictCloseout(run, { workflow });
    prediction.followUpSteps = followUpSteps(prediction);
    run.closeout = { ...prediction, at: now() };
    if (prediction.action !== 'leave' && prediction.followUpSteps.length) {
      try {
        addSuggestion(
          `Follow-up after “${run.workflowName}” (${prediction.action}): ${prediction.reasons.join('; ')}. Review and append the ${prediction.followUpSteps.length} proposed step(s) from the run card.`,
          'closeout',
          run.workflowId,
          run.id
        );
      } catch { /* suggestions are additive */ }
    }
    pushCloseoutLog(run, prediction);
    persist();
    return run.closeout;
  } catch (err) {
    try {
      pushCloseoutLog(run, { action: 'leave', confidence: 0, reasons: [`closeout prediction failed: ${err.message}`] });
    } catch { /* never break the run */ }
    return null;
  }
}

function pushCloseoutLog(run, prediction) {
  run.log = run.log || [];
  run.log.push({
    at: now(),
    level: prediction.action === 'leave' ? 'info' : 'warn',
    message: `Follow-up prediction: ${prediction.action} — ${prediction.reasons.join('; ')}${prediction.action !== 'leave' ? ' (proposed steps wait in the run card for your approval)' : ''}`,
    stepId: null,
  });
}

/** Operator approval: append the proposed follow-up steps to the workflow. */
export function appendCloseout(runId) {
  const run = (db().runs || []).find((entry) => entry.id === runId);
  if (!run) throw new Error('Run not found');
  const closeout = run.closeout || recordCloseout(run);
  if (!closeout) throw new Error('No closeout prediction for this run');
  if (closeout.appended) throw new Error('Follow-up steps were already appended');
  const steps = closeout.followUpSteps || [];
  if (!steps.length) throw new Error('The prediction has no follow-up steps to append');
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('Workflow not found');
  if (!Array.isArray(workflow.steps)) workflow.steps = [];
  workflow.steps.push(...JSON.parse(JSON.stringify(steps)));
  workflow.updatedAt = now();
  run.closeout.appended = true;
  persist();
  logActivity('closeout', `Appended ${steps.length} follow-up step(s) to “${workflow.name}” from run ${run.id}`, { runId: run.id, workflowId: workflow.id });
  return { workflowId: workflow.id, appended: steps.length, steps: JSON.parse(JSON.stringify(steps)) };
}
