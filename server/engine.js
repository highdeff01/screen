import fs from 'node:fs';
import path from 'node:path';
import { db, persist, uid, now, logActivity } from './store.js';
import {
  executeStep,
  captureScreenSignature,
  inspectWindowState,
  readFocusedElement,
  findUiElement,
  findOpenUrl,
  findExistingDownload,
  findDownloadedFile,
  readScreenContext,
  readPresence,
  readForegroundWindow,
  readWindowText,
  silentCheck,
  resolveCheckFile,
} from './automation.js';
import { judgeTargetFor, normalizeText } from './judgement.js';
import { assessStep, launchProducedNewWindow, looksLikeSavedDocument, reviewPrevious } from './step-context.js';
import { classifyPresence, holdDecision, learnHold, completionFor, isFocusStealing, isQuickStep, silentChecksFor } from './presence.js';
import { recordAction } from './action-log.js';
import { sendContinuation } from './agent-awareness.js';
import { enqueue } from './pipeline.js';
import { firewallCheck } from './firewall.js';
import { addNote } from './handoff.js';
import { noteStepOutcome, pinStepIntents, similarSolutions, spotIntent } from './step-factoring.js';
import { recordCloseout } from './closeout.js';
import { checkStepMonitor } from './monitors.js';
import { beginRunObservation, endRunObservation } from './app-observer.js';
import { liveControl, probeLiveBackend, isPlatformRefusal } from './platform.js';
import { expectsScreenChange, windowChecksFor, resumePlan, corroboratesNoChange, lookupWindowFor, screenChangeVerdict } from './step-effects.js';

// Per-run adapters supplied by tests so the screen policy can run without a UI.
const runProbes = new Map();
import { deliberateStep } from './deliberation.js';
import { beginStepThink, recordThinkOutcome, stepThinkSettings, thinkBlocked, thinkRepairCandidates } from './step-think.js';
import { carryCompletedSteps, normalizeRecheckSettings, runPendingRecheck, markRunInterrupted } from './pending-recheck.js';
import {
  normalizeScreenReviewSettings,
  reviewOutcome,
  screenReviewAttempts,
  screenReviewCaption,
  screenReviewCheck,
  shouldReviewStep,
} from './screen-review.js';
import { diffSignatures, signatureHash, shouldAuditVisual, visualChangeMatters } from './visual.js';
import { analyzeRun, writeRunNote, addSuggestion, suggestionsFor, planSteps, workflowGoal } from './planner.js';
import { canRetry, recordRetryOutcome } from './retry-budget.js';
import { catalogEntry, isInstalledAppWindow } from './app-install.js';
import { presenterStart, presenterBeginStep, presenterAfterStep, presenterFailStep, presenterFinish, presenterAdoptApp } from './foreground-presenter.js';
import { ensureLeadingFocusLaunch } from './run-recovery.js';
import { agentReplan, rememberAgentLesson } from './agent-replan.js';
import {
  repairCandidates,
  recallRepairMemory,
  rememberRepairMemory,
  repairAdvice,
  repairSignature,
  canContinueSafely,
  failedStepEntries,
  failureSummary,
} from './repair.js';

const queue = [];
let busy = false;
let runFinishedHook = null;

export function setRunFinishedHook(fn) {
  runFinishedHook = typeof fn === 'function' ? fn : null;
}
let tickTimer = null;

const MAX_RUNS = 120;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry backoff is a control boundary, not an uninterruptible sleep. Paused
// time does not consume the delay, and cancellation must prevent another try.
async function waitBeforeRetry(run, ms) {
  let remaining = ms;
  while (remaining > 0) {
    await waitWhileRunPaused(run);
    if (run.cancelRequested) return;
    const chunk = Math.min(250, remaining);
    const started = Date.now();
    await sleep(chunk);
    remaining -= Math.min(chunk, Date.now() - started);
  }
  await waitWhileRunPaused(run);
}

async function waitWhileRunPaused(run) {
  let paused = false;
  while (run.pauseRequested && !run.cancelRequested) {
    if (!paused) {
      run.paused = true;
      pushLog(run, 'info', 'Run paused by operator; holding before the next step.');
      persist();
      paused = true;
    }
    await sleep(250);
  }
  if (paused) {
    run.paused = false;
    pushLog(run, 'info', 'Run resumed by operator.');
    persist();
  }
}

function categorizeFailure(step) {
  const text = `${step.error || ''} ${step.type} ${step.name || ''}`.toLowerCase();
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (step.type === 'runTool') return 'tool_missing';
  if (step.type === 'launchApp' || step.type === 'focusWindow') return 'window_not_found';
  if (step.type === 'verifyScreen' || step.type === 'verifyPlayback' || step.type === 'mediaHold') return 'visual_assertion_failed';
  if (step.type === 'aiExtract') return 'ai_error';
  if (step.type === 'waitFor' || step.type === 'expect') return /window/.test(text) ? 'window_not_found' : 'assertion_failed';
  if (step.type === 'openUrl') return 'navigation_failed';
  if (step.type === 'type' || step.type === 'key' || step.type === 'clipboard' || step.type === 'click' || step.type === 'doubleClick' || step.type === 'drag') return 'input_failed';
  if (/file|path|directory/.test(text)) return 'file_issue';
  if (/tool/.test(text)) return 'tool_missing';
  if (/process/.test(text)) return 'process_missing';
  if (/ai|model|empty response/.test(text)) return 'ai_error';
  return 'unknown';
}

function failureSignature(step) {
  const message = String(step.error || 'failed')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${step.type}:${message}`;
}

const ERROR_CODES = {
  timeout: 'TIMEOUT',
  window_not_found: 'WINDOW_NOT_FOUND',
  process_missing: 'PROCESS_MISSING',
  tool_missing: 'TOOL_NOT_FOUND',
  navigation_failed: 'NAVIGATION_FAILED',
  input_failed: 'INPUT_FAILED',
  assertion_failed: 'ASSERTION_FAILED',
  visual_assertion_failed: 'VISUAL_ASSERTION_FAILED',
  file_issue: 'FILE_ERROR',
  ai_error: 'AI_ERROR',
  unknown: 'UNKNOWN',
};

export function estimateComplexity(workflow) {
  const steps = workflow.steps || [];
  let score = 10 + steps.length * 4;
  if (steps.some((step) => step.type === 'waitFor')) score += 10;
  if (steps.some((step) => step.type === 'runTool')) score += 12;
  score += steps.filter((step) => step.optional).length * 4;
  if (workflow.failurePolicy?.onFailure === 'retry') score += 5;
  if ((workflow.patternTags || []).some((tag) => /security|login|credential/i.test(tag))) score += 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function needsAdvancedPlanning(workflow) {
  const steps = workflow.steps || [];
  const score = estimateComplexity(workflow);
  return (
    score >= 55 ||
    steps.some((step) => step.type === 'runTool') ||
    steps.filter((step) => step.optional).length >= 2 ||
    (workflow.patternTags || []).some((tag) => /security|login|credential|replan/i.test(tag))
  );
}

export function workflowStats(workflow) {
  const runs = db().runs.filter((run) => run.workflowId === workflow.id && !run.shadow);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = runs.filter((run) => new Date(run.createdAt || 0).getTime() >= cutoff);
  const considered = recent.filter((run) => ['passed', 'failed', 'needs_review', 'cancelled'].includes(run.status));
  const failed7d = recent.filter((run) => run.status === 'failed').length;
  const soft = considered.filter((run) => run.status === 'needs_review').length;
  const retries = considered.reduce((total, run) => total + Number(run.retryCount || 0), 0);
  const base = considered.length ? Math.round((100 * (failed7d + 0.5 * soft)) / considered.length) : 0;
  const retryPenalty = considered.length ? Math.min(25, Math.round((100 * retries) / (considered.length * 3))) : 0;
  const complexity = estimateComplexity(workflow);
  const latest = runs[0];
  return {
    totalRuns: runs.length,
    totalFailures7d: failed7d,
    flakinessScore: Math.min(100, base + retryPenalty),
    avgComplexity: complexity,
    requiresAdvancedPlanning: needsAdvancedPlanning(workflow),
    latestErrorCode: latest?.lastErrorCode || null,
    latestErrorCategory: latest?.errorCategory || null,
  };
}

export function summary(run) {
  const steps = run.steps || [];
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    // The operator's own words stay in the header: the run was queued to reach
    // this intent, not just to execute a list of steps.
    goal: run.goal || '',
    screenReviewCount: (run.screenReviews || []).length,
    // Reads the check could not make (model offline, no window scope). They are
    // counted apart so "checked" only ever means "actually judged".
    screenReviewSkipped: (run.screenReviews || []).filter((entry) => entry.status === 'skipped').length,
    // A verdict per automatic check, not just a picture: pass, mismatch, or an
    // honest "could not read". A mismatch that survived its retry sends the run
    // to review instead of letting it read as a clean pass.
    screenReviewMismatches: (run.screenMismatches || []).length,
    screenReviewUnresolved: Boolean(run.screenReviewUnresolved),
    screenReviews: (run.screenReviews || []).slice(-4),
    screenMismatches: (run.screenMismatches || []).slice(-3),
    status: run.status,
    dryRun: run.dryRun,
    liveFallback: run.liveFallback || null,
    shadow: Boolean(run.shadow),
    trigger: run.trigger,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    paused: Boolean(run.pauseRequested),
    skipRequested: Boolean(run.skipRequested),
    cancelRequested: Boolean(run.cancelRequested),
    total: steps.length,
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    // Steps whose silent checks have not settled yet: they read as passed in the
    // run but must not be presented as finished until those checks answer.
    awaitingChecks: (run.pendingVerification || []).length,
    // What the observer engine said about this run while it was executing.
    observations: (run.observations || []).slice(-6),
    // "checking" only while the review loop will actually re-read it; a failed or
    // cancelled run keeps its queued check as history ("unverified").
    verificationState:
      run.verificationState ||
      (run.pendingVerification?.length
        ? ['passed', 'needs_review'].includes(run.status)
          ? 'checking'
          : 'unverified'
        : ''),
    verificationAttempts: Number(run.verificationAttempts || 0),
    verificationStalled: Boolean(run.verificationStalled),
    verificationReviews: (run.verificationReview || []).slice(-3).map((entry) => ({
      kind: entry.kind,
      attempt: entry.attempt,
      detail: String(entry.detail || '').slice(0, 240),
      drift: entry.drift ?? null,
      suggestions: (entry.suggestions || []).slice(0, 2),
    })),
    stepStalled: run.stepStalled
      ? { stepName: run.stepStalled.stepName, elapsedMs: run.stepStalled.elapsedMs, suggestion: run.stepStalled.suggestion }
      : null,
    evidenceCount: (run.evidence || []).length,
    retryCount: Number(run.retryCount || 0),
    errorCategory: run.errorCategory || null,
    failureSignature: run.failureSignature || null,
    errorSummary: run.errorSummary || null,
    failedSteps: (run.failedSteps || []).slice(0, 8).map((entry) => ({
      ...entry,
      error: String(entry.error || '').slice(0, 400),
    })),
    repairCount: Number(run.repairCount || 0),
    continuedAfterFailure: Boolean(run.continuedAfterFailure),
    replanCount: Number(run.replanCount || 0),
    replannedAfterFailure: Boolean(run.replannedAfterFailure),
    supersededSteps: (run.supersededSteps || []).slice(-8),
    agentReplans: (run.agentReplans || []).slice(-4).map((entry) => ({
      step: entry.step,
      method: entry.method,
      diagnosis: String(entry.diagnosis || '').slice(0, 300),
      confidence: entry.confidence,
      replacesStep: Boolean(entry.replacesStep),
      steps: entry.steps || [],
      remaining: entry.remaining || [],
      at: entry.at,
    })),
    followup: run.followup || null,
    followupFailed: Boolean(run.followupFailed),
    closeout: run.closeout || null,
    recovered: Boolean(run.recovered),
    patternTags: run.patternTags || [],
    agentRole: run.agentRole || 'operator',
    missionId: run.missionId || null,
    lastErrorCode: run.lastErrorCode || null,
    lastErrorCategory: run.lastErrorCategory || run.errorCategory || null,
    runComplexityScore: Number(run.runComplexityScore || 0),
    requiresAdvancedPlanning: Boolean(run.requiresAdvancedPlanning),
    reviewed: Boolean(run.review && run.review.status === 'reviewed'),
    analyzed: Boolean(run.analysis),
    ledgerCount: (run.ledger || []).length,
    visualWarnings: (run.visualWarnings || []).length,
    visualChecks: run.visualChecks !== false,
    position: run.position || null,
    presence: run.presence || null,
    deferrals: (run.deferrals || []).slice(-3),
    recoveryOf: run.recoveryOf || null,
    recoveryPackId: run.recoveryPackId || null,
    recoveryDepth: Number(run.recoveryDepth || 0),
    recoveryStatus: run.recovery?.status || null,
    recoveryVerdict: run.recovery?.verdict || null,
  };
}

/**
 * A finished run is not waiting for the desktop any more. Without this the last
 * presence reading stays `holding: true` and a passed run still looks queued
 * behind the user in the console.
 */
export function clearPresenceHold(run = null) {
  if (!run?.presence) return run;
  run.presence = { ...run.presence, holding: false, waitMs: 0, reason: '' };
  return run;
}

export function findRun(id) {
  const run = db().runs.find((r) => r.id === id) || null;
  if (run) {
    if (!Array.isArray(run.ledger)) run.ledger = [];
    if (run.position === undefined) run.position = null;
  }
  return run;
}

export async function waitForRun(id, { timeoutMs = 30000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 30000);
  while (Date.now() < deadline) {
    const run = findRun(id);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, Math.max(50, Number(intervalMs) || 100)));
  }
  return findRun(id);
}

export function createRun(workflow, { trigger = 'manual', dryRun = null, agentRole = null, missionId = null, shortcutReplayHabitId = null, workflowSnapshot = null, shadowProposalId = null, probe = null, repair = null, aiReplan = null, liveFallback = null, liveConsent = false, carryFrom = null } = {}) {
  const d = db();
  if (!workflow || !workflow.steps?.length) {
    throw new Error('Workflow has no steps to run.');
  }
  // A probe simulates the whole desktop: every stub answers instantly, so a
  // real launch prerequisite would only add steps and real-timer waits the
  // simulation cannot use. Injection stays for live runs, which never pass one.
  const preparedSteps = probe ? workflow.steps : ensureLeadingFocusLaunch(workflow.steps);
  if (preparedSteps.length !== workflow.steps.length) {
    workflow.steps = preparedSteps;
    workflow.updatedAt = now();
    persist();
    logActivity('workflow', `Added a launch prerequisite before the first focus in "${workflow.name}"`, { workflowId: workflow.id });
  }
  if (preparedSteps.length !== workflow.steps.length) {
    workflow.steps = preparedSteps;
    workflow.updatedAt = now();
    persist();
    logActivity('workflow', `Added a launch prerequisite before the first focus in "${workflow.name}"`, { workflowId: workflow.id });
  }
  const run = {
    id: uid('run'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    goal: String(workflow.description || workflow.name || '').trim().slice(0, 2000),
    status: 'queued',
    dryRun: dryRun == null ? Boolean(d.settings.dryRun) : Boolean(dryRun),
    trigger,
    agentRole: agentRole || (trigger === 'scheduler' ? 'scheduler' : 'operator'),
    missionId: missionId || null,
    shortcutReplayHabitId: shortcutReplayHabitId || null,
    shadow: Boolean(shadowProposalId),
    shadowProposalId: shadowProposalId || null,
    ...(workflowSnapshot ? { workflowSnapshot: JSON.parse(JSON.stringify(workflowSnapshot)) } : {}),
    policy: { ...workflow.failurePolicy },
    patternTags: [...(workflow.patternTags || [])],
    retryCount: 0,
    errorCategory: null,
    failureSignature: null,
    recovered: false,
    matchedPatternTags: [],
    lastErrorCode: null,
    lastErrorCategory: null,
    runComplexityScore: estimateComplexity(workflow),
    requiresAdvancedPlanning: needsAdvancedPlanning(workflow),
    visualChecks: db().settings.visualChecks !== false,
    // Why a live request became a simulated run, when it did. Kept on the run
    // so the engine can test the refusal instead of trusting it.
    ...(liveFallback ? { liveFallback: String(liveFallback) } : {}),
    // The operator saw the offer and asked for the real desktop. Without this,
    // a run that was shown as simulated is never switched to live input.
    ...(liveConsent ? { liveConsent: true } : {}),
    liveRepair: repair == null ? null : Boolean(repair),
    aiReplan: aiReplan == null ? db().settings.agentReplans !== false : Boolean(aiReplan),
    replanCount: 0,
    replannedAfterFailure: false,
    agentReplans: [],
    supersededSteps: [],
    visualWarnings: [],
    createdAt: now(),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    currentStepId: null,
    position: null,
    ledger: [],
    cancelRequested: false,
    triageDone: false,
    supervised: false,
    escalated: false,
    steps: workflow.steps.map((s) => ({
      id: s.id,
      type: s.type,
      name: s.name,
      params: { ...s.params },
      timeoutMs: s.timeoutMs,
      optional: Boolean(s.optional),
      condition: s.condition || null,
      status: 'pending',
      attempts: 0,
      repairs: [],
      startedAt: null,
      endedAt: null,
      ms: null,
      output: '',
      error: null,
      evidenceIds: [],
      appContext: null,
    })),
    evidence: [],
    variables: {},
    log: [],
    analysis: null,
    review: { status: 'unreviewed', comment: '', at: null },
  };
  // Spot and pin each step's intent on the run's own step copies, so similar
  // steps across runs carry the same tag without rewriting the saved workflow.
  // The builder's "Pin intents" button persists them into the workflow itself.
  try {
    for (const step of run.steps) {
      const spotted = spotIntent(step);
      if (!step.intent) {
        step.intent = spotted.intent;
        step.intentBasis = spotted.basis;
      }
    }
  } catch { /* pinning never blocks a run */ }
  // A retry keeps the steps that already passed: the same type and params means
  // the effect already happened, so running it again would duplicate it.
  if (carryFrom) {
    const carried = carryCompletedSteps(carryFrom.steps, run.steps, { runId: carryFrom.id, at: run.createdAt });
    run.steps = carried.steps;
    if (carried.carried.length) run.carriedSteps = carried.carried;
  }
  d.runs.unshift(run);
  d.runs = d.runs.slice(0, MAX_RUNS);
  persist();
  logActivity('run', `Queued "${workflow.name}" (${run.dryRun ? 'simulated' : 'live'})`, {
    runId: run.id,
    workflowId: workflow.id,
  });
  if (probe) runProbes.set(run.id, probe);
  queue.push(run.id);
  void pump();
  return run;
}

async function pump() {
  if (busy) return;
  const nextId = queue.shift();
  if (!nextId) return;
  busy = true;
  try {
    await executeRun(nextId);
  } catch (err) {
    console.error('[engine] run crashed:', err);
    const run = findRun(nextId);
    if (run) {
      run.status = 'failed';
      run.endedAt = now();
      clearPresenceHold(run);
      run.log.push({ at: now(), level: 'error', message: `Engine error: ${err.message}` });
      if (run.shadow) delete run.workflowSnapshot;
      persist();
      reportRunFailure(run, `engine crash: ${err.message}`, err.stack || err.message);
    }
  } finally {
    busy = false;
    if (queue.length) void pump();
  }
}

function pushLog(run, level, message, stepId = null) {
  run.log.push({ at: now(), level, message, stepId });
  if (run.log.length > 400) run.log = run.log.slice(-400);
  persist();
}

function ledgerStepBrief(step) {
  if (!step) return null;
  return {
    id: step.id,
    type: step.type,
    name: step.name,
    params: { ...(step.params || {}) },
    status: step.status,
  };
}

function recordLedger(run, step) {
  if (!run || !step) return null;
  // Step factoring: every settled step feeds the fingerprint ledger, so the
  // proven form of this exact step grows stronger (or weaker) across runs.
  try {
    noteStepOutcome(run, step);
  } catch { /* the ledger never breaks the run */ }
  if (!Array.isArray(run.ledger)) run.ledger = [];
  const index = run.steps.indexOf(step);
  const next = run.steps.slice(index + 1).find((entry) => entry.status === 'pending') || run.steps[index + 1] || null;
  const evidence = (run.evidence || [])
    .filter((entry) => (step.evidenceIds || []).includes(entry.id))
    .map((entry) => ({ path: entry.path, caption: entry.caption, kind: entry.kind, simulated: Boolean(entry.simulated) }));
  const entry = {
    id: `led_${run.id}_${step.id}`,
    at: now(),
    seq: index + 1,
    index,
    total: run.steps.length,
    stepId: step.id,
    type: step.type,
    name: step.name,
    params: { ...(step.params || {}) },
    status: step.status,
    decision: step.deliberation || null,
    attempts: Number(step.attempts || 0),
    startedAt: step.startedAt || null,
    endedAt: step.endedAt || null,
    ms: step.ms || null,
    output: String(step.output || '').slice(0, 900),
    error: step.error || null,
    visual: step.visual || null,
    audit: step.audit || null,
    evidence,
    next: next ? ledgerStepBrief(next) : null,
  };
  const existing = run.ledger.find((item) => item.stepId === step.id);
  if (existing) Object.assign(existing, entry);
  else run.ledger.push(entry);
  run.ledger.sort((a, b) => a.index - b.index);
  if (run.ledger.length > 400) run.ledger = run.ledger.slice(-400);
  run.position = {
    phase: step.status === 'running' ? 'executing' : 'between-steps',
    index,
    stepNumber: index + 1,
    total: run.steps.length,
    stepId: step.id,
    step: ledgerStepBrief(step),
    decision: step.deliberation || null,
    next: next ? ledgerStepBrief(next) : null,
    cursor: step.params?.x !== undefined ? { x: step.params.x, y: step.params.y } : null,
    at: now(),
  };
  persist();
  return entry;
}

async function captureFailureEvidence(run, step, workflow) {
  const attempt = Math.max(1, Number(step.attempts || 1));
  const attemptLabel = attempt > 1 ? ` (attempt ${attempt})` : '';
  const shotStep = {
    id: uid('ev'),
    type: 'screenshot',
    name: `Failure evidence — ${step.name}${attemptLabel}`,
    params: { caption: `Failure evidence — ${step.name}${attemptLabel}` },
    timeoutMs: 20000,
  };
  try {
    const res = await executeStep(shotStep, {
      live: !run.dryRun,
      runId: run.id,
      run,
      workflow,
      getTool: (id) => db().tools.find((t) => t.id === id),
    });
    for (const ev of res.evidence || []) {
      const evidence = {
        id: uid('evd'),
        kind: ev.kind,
        caption: ev.caption,
        path: ev.path,
        simulated: ev.simulated,
        width: ev.width || null,
        height: ev.height || null,
        stepId: step.id,
        createdAt: now(),
      };
      run.evidence.push(evidence);
      step.evidenceIds.push(evidence.id);
    }
    pushLog(run, 'info', `Failure evidence captured for "${step.name}"`, step.id);
  } catch (err) {
    pushLog(run, 'warn', `Could not capture failure evidence: ${err.message}`, step.id);
  }
}

export function screenReviewSettings() {
  return normalizeScreenReviewSettings(db().settings?.screenReview || {});
}

/**
 * Re-read the screen right after an action settled and judge the frame it
 * captured. This reuses the existing verifyScreen path — cropped to the run's
 * own window, deterministic window facts plus the vision model, one recorded
 * verdict — instead of filing an unread screenshot. A mismatch is retried once
 * (a slow app often catches up between the action and the frame); a mismatch
 * that survives the retry flags the step, and the run goes to review instead of
 * being reported as a clean pass.
 */
async function reviewScreenAfterStep(run, step, workflow, probe = null) {
  if (run.dryRun || run.shadow) return null;
  // A probe without its own screen reviewer is a desktop-free run: there is no
  // real screen to judge, and reading it would touch the machine running tests.
  if (probe && typeof probe.screenReview !== 'function') return null;
  const cfg = screenReviewSettings();
  if (!shouldReviewStep(step, (run.screenReviews || []).length, cfg)) return null;
  const caption = screenReviewCaption(step);
  const check = screenReviewCheck(step, { variables: run.variables || {} });
  const target = judgeTargetFor(step, run);
  const limit = screenReviewAttempts(cfg);
  const checkStep = {
    id: uid('chk'),
    type: 'verifyScreen',
    name: caption,
    params: {
      question: check.question,
      caption,
      // An unreadable frame (vision offline, no window scope) is recorded as
      // unverified: only the judges saying "this is not it" is a mismatch.
      onError: 'warn',
      minConfidence: cfg.minConfidence,
      ...(check.expectedText ? { text: check.expectedText } : {}),
      ...(check.absentText ? { absent: check.absentText } : {}),
      ...(target.title ? { title: target.title } : {}),
      ...(target.process ? { app: target.process } : {}),
    },
    timeoutMs: 90000,
  };
  let outcome = null;
  let evidenceId = null;
  let evidencePath = null;
  let judgement = null;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    try {
      const res = probe?.screenReview
        ? await probe.screenReview(checkStep, { run, workflow, runId: run.id, live: true, attempt })
        : await executeStep(checkStep, {
            live: true,
            runId: run.id,
            run,
            workflow,
            getTool: (id) => db().tools.find((tool) => tool.id === id),
          });
      outcome = { ...reviewOutcome({ skipped: res?.skipped, output: res?.output }), attempts: attempt };
      judgement = res?.judgement || null;
      for (const ev of res?.evidence || []) {
        const stored = collectReviewEvidence(run, step, ev, caption);
        if (stored) {
          evidenceId = stored.id;
          evidencePath = stored.path;
        }
      }
      break;
    } catch (err) {
      outcome = { ...reviewOutcome({ error: err }), attempts: attempt };
      for (const ev of err?.evidence || []) {
        const stored = collectReviewEvidence(run, step, ev, caption);
        if (stored) {
          evidenceId = stored.id;
          evidencePath = stored.path;
        }
      }
      // Only a real contradiction is worth a second frame; an unreadable failure
      // is retried by nothing the operator can wait for.
      if (attempt < limit && !run.cancelRequested && outcome.status === 'mismatch') {
        pushLog(
          run,
          'warn',
          `Screen check after “${step.name}” did not match${outcome.mismatch ? ` — ${outcome.mismatch}` : ''}; re-reading in ${cfg.retryDelayMs} ms (${attempt + 1}/${limit}).`,
          step.id
        );
        if (cfg.retryDelayMs > 0) await sleep(cfg.retryDelayMs);
      } else {
        // Stop here: the loop must not read again just because it can.
        break;
      }
    }
  }
  if (!outcome) return null;
  const entry = {
    stepId: step.id,
    stepName: step.name,
    type: step.type,
    at: now(),
    question: check.question,
    title: target.title || '',
    app: target.process || '',
    evidenceId,
    path: evidencePath,
    simulated: false,
    status: outcome.status,
    verdict: outcome.verdict,
    attempts: outcome.attempts,
    retried: outcome.attempts > 1,
    detail: outcome.detail,
    mismatch: outcome.mismatch,
    judgement,
  };
  run.screenReviews = [...(run.screenReviews || []), entry].slice(-200);
  step.screenReview = {
    at: entry.at,
    evidenceId,
    status: entry.status,
    attempts: entry.attempts,
    detail: entry.detail,
    ...(entry.mismatch ? { mismatch: entry.mismatch } : {}),
  };
  if (entry.status === 'mismatch') {
    // Every step said it passed, but the frame says otherwise after a re-read:
    // the run is not a clean pass, so it is kept for review.
    run.screenReviewFailed = true;
    run.screenMismatches = [
      ...(run.screenMismatches || []),
      {
        stepId: step.id,
        stepName: step.name,
        at: entry.at,
        detail: entry.detail,
        mismatch: entry.mismatch,
        attempts: entry.attempts,
      },
    ].slice(-20);
    step.audit = {
      level: 'warning',
      message: `Screen check after “${step.name}” did not match: ${entry.mismatch || entry.detail}`,
      at: entry.at,
    };
    pushLog(
      run,
      'error',
      `Screen check after “${step.name}” did not match after ${entry.attempts} read(s): ${entry.mismatch || entry.detail}`,
      step.id
    );
  } else if (entry.status === 'skipped') {
    pushLog(run, 'warn', `Screen check after “${step.name}” could not read the screen: ${entry.detail}`, step.id);
  } else {
    pushLog(
      run,
      'info',
      `Screen check passed after “${step.name}”${entry.retried ? ` (matched on read ${entry.attempts})` : ''}: ${entry.detail}`,
      step.id
    );
  }
  persist();
  return entry;
}

/** Keep one copy of a review screenshot on the run, as evidence. */
function collectReviewEvidence(run, step, evidence, caption) {
  if (!evidence?.path) return null;
  const label = evidence.caption || caption;
  if ((run.evidence || []).some((item) => item.path === evidence.path && item.caption === label)) return null;
  const entry = {
    id: uid('evd'),
    kind: evidence.kind || 'screenshot',
    caption: label,
    path: evidence.path,
    simulated: Boolean(evidence.simulated),
    width: evidence.width || null,
    height: evidence.height || null,
    stepId: step.id,
    createdAt: now(),
  };
  run.evidence.push(entry);
  step.evidenceIds.push(entry.id);
  return entry;
}

function buildPostCheck(step) {
  const raw = step.params?.verifyAfter ?? step.params?.verify ?? null;
  if (!raw) return null;
  if (typeof raw === 'string') {
    const app = step.params?.app || step.params?.foreground || step.params?.window || '';
    return {
      id: uid('chk'),
      type: 'verifyScreen',
      name: `Verify after ${step.name}`,
      params: { question: raw, app, title: app, onError: 'fail', minConfidence: 0.6 },
      timeoutMs: 120000,
    };
  }
  if (typeof raw === 'object' && raw.type) {
    return {
      id: uid('chk'),
      type: raw.type,
      name: raw.name || `Verify after ${step.name}`,
      params: raw.params || raw,
      timeoutMs: Number(raw.timeoutMs) || 30000,
    };
  }
  if (typeof raw === 'object' && raw.kind) {
    return {
      id: uid('chk'),
      type: 'expect',
      name: `Verify after ${step.name}`,
      params: raw,
      timeoutMs: Number(raw.timeoutMs) || 15000,
    };
  }
  return null;
}

async function runPostChecks(step, ctx, probe = null) {
  const checks = [];
  const explicit = buildPostCheck(step);
  if (explicit) checks.push(explicit);
  const guard = String(step.params?.foreground === true ? '' : step.params?.foreground || '').trim();
  // With an inherited handle the window may rename itself (an untitled
  // document takes its first line as its title), so the post-check names the
  // handle instead of the title.
  const handle = Math.max(0, Number(step.params?.foregroundHandle) || 0);
  if (guard && !handle && ['type', 'key', 'clipboard'].includes(step.type)) {
    checks.push({
      id: uid('chk'),
      type: 'expect',
      name: `Confirm ${guard} stayed in front`,
      params: { kind: 'foreground', value: guard },
      timeoutMs: 5000,
    });
  }
  const results = [];
  for (const check of checks) {
    results.push(probe?.executeStep ? await probe.executeStep(check, ctx) : await executeStep(check, ctx));
  }
  return results;
}

export function stepConditionMet(step, run) {
  const condition = String(step.condition || '').trim();
  if (!condition) return true;
  if (condition !== 'newChat') return true;
  const mission = run.missionId ? db().missions.find((entry) => entry.id === run.missionId) : null;
  if (mission?.conditions?.newChat === true) return true;
  if (mission?.conditions?.newChat === false) return false;
  const goal = String(mission?.goal || '');
  const asksNew =
    /\b(?:new|another|different|fresh)\s+(?:chat|session|conversation|topic)\b|\bdifferent topic\b|\bswitch topic\b/i.test(goal);
  if (asksNew) return true;
  // Auto mode must not reuse a chat that may be busy or about another topic.
  // Reuse only when the operator explicitly asks to keep/continue it.
  const asksReuse =
    /\b(?:keep|reuse|re-use|continue|resume|stay|same|current|existing)\b[\s\S]{0,60}\b(?:chat|session|conversation|topic)\b/i.test(goal) ||
    /\b(?:chat|session|conversation|topic)\b[\s\S]{0,60}\b(?:keep|reuse|re-use|continue|resume|same|current|existing)\b/i.test(goal);
  if (asksReuse) return false;
  return true;
}

/**
 * Read the desktop once and decide whether this step is already satisfied or
 * should be retargeted at the dialog that is actually open. Only runs without a
 * probe (a live run) or with a probe that supplies the same read, so tests keep
 * their own desktop-free adapters.
 */
async function applyStepContext(step, run, workflow, probe = null) {
  if (probe && typeof probe.readScreenContext !== 'function') return null;
  const screen = probe?.readScreenContext ? await probe.readScreenContext() : await readScreenContext();
  if (!screen?.foreground?.title && !(screen?.windows || []).length) return null;
  const goal = workflowGoal(workflow, run) || run.workflowName || '';
  const history = (run.steps || []).filter((entry) => entry.status && entry.id !== step.id).slice(-3);
  const assessment = assessStep({ step, screen, goal, history });
  step.context = { at: now(), ...assessment };
  if (assessment.adjustments && Object.keys(assessment.adjustments).length) {
    step.params = { ...(step.params || {}), ...assessment.adjustments };
    pushLog(
      run,
      'info',
      `Adjusted “${step.name}” to the open state: ${Object.entries(assessment.adjustments)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}.`,
      step.id
    );
  }
  if (assessment.focus) {
    try {
      const focusStep = {
        id: uid('ctx'),
        type: 'focusWindow',
        name: `Bring “${assessment.focus}” forward`,
        params: { title: assessment.focus },
        timeoutMs: 10000,
      };
      const ctx = { live: true, runId: run.id, run, workflow, getTool: () => undefined };
      if (probe?.executeStep) await probe.executeStep(focusStep, ctx);
      else await executeStep(focusStep, ctx);
      pushLog(run, 'info', `Brought the open dialog “${assessment.focus}” forward before “${step.name}”.`, step.id);
    } catch (err) {
      pushLog(run, 'warn', `Could not bring “${assessment.focus}” forward: ${err.message}`, step.id);
    }
  }
  if (assessment.note) pushLog(run, 'info', `State check for “${step.name}”: ${assessment.note}`, step.id);
  if (assessment.inProgress) run.contextSkips = (run.contextSkips || 0) + (assessment.alreadySatisfied ? 1 : 0);
  return assessment;
}

/**
 * Wait for the user to finish what they are doing before a step takes focus.
 * The desktop must be quiet for `presenceHoldMs` (learned per workstation); a
 * run that has waited past `presenceMaxDeferMs` continues anyway and says so.
 */
/** Remember the window this run opened or focused, so typing has a guard. */
const WINDOW_OUTPUT = /(?:front|already focused|focused existing|focused window|focused)\s+(\S[^:]*?)\s*::\s*(.+)/;
/**
 * A launch or focus reports the exact window it raised, including its handle.
 * The handle is what makes a later check read that window and not a lookalike.
 */
export function parseWindowOutput(output) {
  const match = WINDOW_OUTPUT.exec(String(output || ''));
  if (!match) return null;
  const hwnd = Number((/\[hwnd=(\d+)\]/.exec(match[2]) || [])[1]) || 0;
  const title = match[2]
    .replace(/\s*\[(?:hwnd=\d+|[^\]]*)\]/g, '')
    .trim();
  return { process: match[1].trim(), title, hwnd };
}
export function rememberWindow(run, step) {
  if (!['launchApp', 'focusWindow'].includes(step.type) || step.status !== 'passed') return;
  const parsed = parseWindowOutput(step.output);
  if (!parsed) return;
  const carried = !parsed.hwnd && parsed.title && parsed.title === run.lastWindow?.title ? Number(run.lastWindow?.hwnd) || 0 : 0;
  run.lastWindow = { ...parsed, hwnd: parsed.hwnd || carried, at: now(), by: step.id };
}

/**
 * Typing needs a destination. A step without a foreground guard inherits the
 * window this run last opened or focused — “type anywhere that looks like a
 * text area” is exactly how text ended up in the wrong place.
 */
export function deriveTypingGuard(step, run) {
  const typing = ['type', 'key', 'clipboard'].includes(step.type);
  const clicking = step.type === 'clickElement' && !String(step.params?.window || '').trim();
  if (!typing && !clicking) return;
  // `foreground: true` is “the window this run opened”, not a real title.
  if (typing && step.params?.foreground !== true && String(step.params?.foreground || '').trim()) return;
  const window = run.lastWindow;
  if (!window?.title) return;
  step.params = {
    ...(step.params || {}),
    ...(typing
      ? { foreground: window.title, ...(window.hwnd ? { foregroundHandle: window.hwnd } : {}) }
      : { window: window.title }),
  };
  pushLog(
    run,
    'info',
    `No window named for “${step.name}”; it inherits “${window.title}”${
      window.hwnd ? ` (hwnd ${window.hwnd})` : ''
    }, the window this run opened.`,
    step.id
  );
}

/**
 * A focus step that names an app loosely (“Notepad”) can land on any window of
 * that app: an older document, another run's, the operator's own file. When
 * this run already opened or focused an exact window for that app, aim the
 * focus at that title instead, so the run uses the window it opened.
 */
export function deriveFocusTarget(step, run) {
  if (step.type !== 'focusWindow') return;
  const window = run?.lastWindow;
  if (!window?.title) return;
  const asked = String(step.params?.title || step.params?.windowName || step.params?.windowTitle || '').trim();
  if (!asked || window.title === asked) return;
  const process = String(step.params?.process || '').trim();
  const sameApp = process
    ? String(window.process || '').toLowerCase().includes(process.toLowerCase())
    : window.title.toLowerCase().includes(asked.toLowerCase());
  if (!sameApp) return;
  step.params = { ...(step.params || {}), title: window.title, ...(window.hwnd ? { handle: window.hwnd } : {}) };
  pushLog(
    run,
    'info',
    `“${step.name}” asks for “${asked}”, which several windows match; focusing “${window.title}”, the window this run opened.`,
    step.id
  );
}

/** Report a failed or crashed run to the action log and the working agents. */
function reportRunFailure(run, summary, error = '') {
  try {
    const item = recordAction({
      kind: 'run',
      action: `run-failed:${run.workflowName || run.workflowId || 'unknown'}`,
      error: String(error || summary || 'the run failed').slice(0, 2000),
      detail: { runId: run.id, status: run.status, failing: (run.steps || []).filter((s) => s.status === 'failed').map((s) => s.name).slice(0, 5) },
      forceReport: true,
    });
    sendContinuation({
      from: 'engine',
      reason: `${run.workflowName || 'run'} ended ${run.status}`,
      detail: `${summary} (run ${run.id}); fix, then re-run`,
      tags: ['run-failed'],
    });
    return item;
  } catch (err) {
    console.warn(`[engine] failure report failed: ${err.message}`);
    return null;
  }
}

/**
 * The operator is active and a step goes ahead anyway. Re-run the read-only
 * checks the run still owes first, so a step they finished or moved on from is
 * noticed now rather than after the next action.
 */
async function recheckBeforeContinue(run, step) {
  const pending = (run.pendingVerification || []).length;
  if (!pending) return { at: now(), pending: 0, remaining: 0 };
  try {
    const result = await verifyRunSilently(run.id);
    const remaining = Number(result?.remaining) || 0;
    pushLog(
      run,
      remaining ? 'warn' : 'info',
      `Presence: re-checked ${pending} pending verification(s) while the operator was active — ${remaining} still open${
        remaining ? '; the run continues and the open check stays queued' : ''
      }.`,
      step.id
    );
    return { at: now(), pending, remaining };
  } catch (err) {
    return { at: now(), pending, remaining: pending, error: err.message };
  }
}

async function awaitUserSettle(step, run, probe = null) {
  // A probe without presence belongs to a desktop-free test run.
  if (probe && typeof probe.readPresence !== 'function') return;
  if (run.dryRun || run.shadow) return;
  if (db().settings.presenceEnabled === false) return;
  if (!isFocusStealing(step)) return;
  const habits = db().presence || {};
  const holdMs = Math.max(1000, Number(db().settings.presenceHoldMs) || Number(habits.holdMs) || 10000);
  const maxDeferMs = Math.max(holdMs, Number(db().settings.presenceMaxDeferMs) || 60000);
  const target = String(
    step.params?.title || step.params?.target || step.params?.windowName || step.params?.process || step.params?.url || ''
  ).trim();
  let deferredMs = 0;
  for (;;) {
    if (run.presenceBypass) {
      // "Run now anyway" was pressed: the desktop activity no longer holds the step.
      return;
    }
    let presence;
    try {
      presence = probe?.readPresence ? await probe.readPresence() : await readPresence();
    } catch (err) {
      pushLog(run, 'warn', `Presence check failed: ${err.message}`, step.id);
      return;
    }
    if (presence?.error) return;
    const classified = classifyPresence({ idleMs: presence.idleMs, foreground: presence.foreground, target, holdMs });
    // The window this run opened, in front, means the operator is steering the
    // same task rather than working somewhere else.
    const ownTitle = String(run.lastWindow?.title || '').trim().toLowerCase();
    const steering = Boolean(
      ownTitle && String(classified.foreground?.title || '').trim().toLowerCase() === ownTitle
    );
    const decision = holdDecision({
      step,
      presence: classified,
      target,
      holdMs,
      maxDeferMs,
      deferredMs,
      // A playback check with a named player must run with that player in
      // front, so it cannot fall back to a silent read-only check.
      silentAvailable: step.type === 'verifyPlayback' ? false : silentChecksFor(step).length > 0,
      quick: isQuickStep(step),
      steering,
    });
    // A held step says so on the run itself: the console can then explain why a
    // step is still "running" without opening the log.
    run.presence = {
      at: now(),
      idleMs: classified.idleMs,
      state: classified.state,
      watching: classified.watching,
      holdMs,
      holding: decision.action === 'wait',
      deferredMs,
      waitMs: Number(decision.waitMs) || 0,
      reason: decision.reason,
      note: classified.note,
    };
    if (decision.action !== 'wait') {
      run.presence = { ...run.presence, holding: false };
      if (deferredMs > 0) {
        run.deferrals = [...(run.deferrals || []), { stepId: step.id, waitedMs: deferredMs, at: now() }];
        db().presence = learnHold(habits, [{ waitedMs: deferredMs }]);
        persist();
        pushLog(run, 'info', `Presence: waited ${Math.round(deferredMs / 1000)}s for the desktop to settle before “${step.name}”.`, step.id);
      }
      if (classified.state !== 'idle' && !classified.watching) {
        pushLog(run, 'info', `Presence: ${decision.reason}.`, step.id);
      }
      if (decision.fastPath) {
        run.presence = {
          ...run.presence,
          fastPath: true,
          rechecked: await recheckBeforeContinue(run, step),
        };
        persist();
      }
      return;
    }
    const chunk = Math.min(decision.waitMs, Math.max(250, holdMs - classified.idleMs));
    pushLog(run, 'info', `Presence: ${decision.reason}; holding “${step.name}”.`, step.id);
    const until = Date.now() + chunk;
    while (Date.now() < until) {
      await waitWhileRunPaused(run);
      if (run.cancelRequested || run.presenceBypass) return;
      await sleep(Math.min(250, Math.max(0, until - Date.now())));
    }
    deferredMs += chunk;
    persist();
  }
}

/** Skip a launch/focus that would only re-activate the window already in front. */
async function alreadyInFront(step, probe = null) {
  if (!['launchApp', 'focusWindow'].includes(step.type)) return '';
  // A launch with arguments (e.g. notepad.exe <file>) must actually run.
  if (step.type === 'launchApp' && (step.params?.args || []).length) return '';
  // A launch is the flow asking for a window or tab, not for a window that
  // already exists.
  // Reuse is opt-in: without it a launch opens a new instance instead of
  // adopting whatever window of that app happens to be open. Adopting silently
  // once typed a workflow's text into the operator's own Notepad document.
  if (step.type === 'launchApp' && step.params?.reuseExisting !== true && step.params?.reuse !== true) return '';
  const title = String(step.params?.title || '').trim();
  const target = String(step.params?.target || '').trim();
  const processName = String(step.params?.process || '').trim() || (/\.exe$/i.test(target) ? target.replace(/\.exe$/i, '') : '');
  const windowTitle = title || (/\s/.test(target) && !/[\\/]/.test(target) && !/\.\w+$/.test(target) ? target : '');
  // A process match alone is never enough to skip: two windows of the same app
  // are different documents. The foreground must carry the exact window title
  // the step asked for; a focus step with no exact title is simply run again
  // (focusing an already-focused window is harmless, typing into the wrong one
  // is not).
  if (!windowTitle) return '';
  const state = probe?.inspectWindowState
    ? await probe.inspectWindowState({ title: windowTitle, process: processName })
    : await inspectWindowState({ title: windowTitle, process: processName });
  if (state.state !== 'foreground') return '';
  const foregroundTitle = String(state.foreground?.title || '').trim().toLowerCase();
  if (foregroundTitle !== windowTitle.toLowerCase()) return '';
  // A setup wizard, installer, updater or browser page that carries the app's
  // name is not the installed app. "Already in front" must not skip the launch
  // just because the installer window or the download page still has focus.
  const entry = catalogEntry([target, title, processName].filter(Boolean));
  if (!isInstalledAppWindow({ title: state.foreground?.title || '', process: state.foreground?.process || '', entry })) {
    return '';
  }
  return step.type === 'focusWindow'
    ? 'Already focused; no action was needed.'
    : 'Already open and in front; the launch was skipped.';
}

/**
 * Skip a step whose effect already exists. Each check is read-only and returns
 * the fact it found, so a re-run continues instead of creating a duplicate
 * window, tab or download.
 */
export async function preStepSkip(step, probe = null, run = null) {
  const already = await alreadyInFront(step, probe);
  if (already) return already;
  if (step.type === 'openUrl') {
    const url = String(step.params?.url || '').trim();
    if (!url || step.params?.reuseExisting === false) return '';
    // An explicit new-window request is honoured unless the step also asks for reuse.
    if (step.params?.newWindow === true && step.params?.reuseExisting !== true) return '';
    let found = null;
    try {
      found = probe?.findOpenUrl
        ? await probe.findOpenUrl({ url, matchTitle: step.params?.matchTitle || '' })
        : await findOpenUrl({ url, matchTitle: step.params?.matchTitle || '' });
    } catch {
      return '';
    }
    if (!found?.found) return '';
    let focused = false;
    if (found.process || found.title) {
      try {
        const focusStep = {
          id: uid('pre'),
          type: 'focusWindow',
          name: 'Focus the page that is already open',
          params: { title: found.title || '', process: found.process || '' },
          timeoutMs: 8000,
        };
        const ctx = { live: true, runId: run?.id || null, run, workflow: null, getTool: () => undefined };
        if (probe?.executeStep) await probe.executeStep(focusStep, ctx);
        else await executeStep(focusStep, ctx);
        focused = true;
      } catch {
        // The page is still open even when focus is refused; skip the duplicate anyway.
      }
    }
    return `Already open${found.url ? ` at ${found.url}` : ''}${
      found.title ? ` in “${found.title}”` : ''
    } (${found.method || 'reuse'}); ${focused ? 'focused the existing page' : 'kept the existing page'} instead of opening another.`;
  }
  if (['click', 'clickElement', 'doubleClick'].includes(step.type) && step.params?.skipIfDownload) {
    let existing = null;
    try {
      existing = probe?.findDownloadedFile
        ? await probe.findDownloadedFile({ pattern: step.params.skipIfDownload, withinDays: step.params.skipIfDownloadDays })
        : findDownloadedFile({ pattern: step.params.skipIfDownload, withinDays: step.params.skipIfDownloadDays });
    } catch {
      return '';
    }
    if (!existing?.found) return '';
    return `Already downloaded ${existing.name}${existing.bytes ? ` (${Math.round(existing.bytes / 1024 / 1024)} MB)` : ''}; skipped the download click.`;
  }
  if (step.type === 'downloadMedia' && step.params?.overwrite !== true) {
    const url = String(
      step.params?.url || (step.params?.urlVar ? run?.variables?.[step.params.urlVar] : '') || ''
    ).trim();
    if (!url) return '';
    let existing = null;
    try {
      existing = probe?.findExistingDownload
        ? await probe.findExistingDownload({ ...step.params, url })
        : findExistingDownload({ ...step.params, url });
    } catch {
      return '';
    }
    if (!existing?.found) return '';
    if (run) {
      if (!run.variables) run.variables = {};
      run.variables[String(step.params?.outputVar || 'savedFile')] = existing.path;
      run.files = [
        ...(run.files || []),
        {
          path: existing.path,
          bytes: existing.bytes,
          filename: existing.filename,
          url,
          kind: step.params?.kind || 'file',
          reused: true,
        },
      ];
    }
    return `Already saved at ${existing.path} (${existing.filename}); skipped the download.`;
  }
  return '';
}

/** A step that claims to open a window must actually produce one. */
async function verifyStepWindow(step, run, probe = null) {
  if (run?.dryRun) return { ok: true };
  const checks = windowChecksFor(step);
  if (!checks.length) return { ok: true };
  // A focused element that names the destination window is live proof the
  // step's target is really there — no need to poll the OS for a window list.
  // Exact title match only: contains-matches are how focus was lost before.
  try {
    const focused = probe?.readFocusedElement ? await probe.readFocusedElement() : await readFocusedElement();
    const focusedWindow = String(focused?.window || focused?.title || '').trim();
    if (focused?.found !== false && focusedWindow) {
      const match = checks.find((check) => String(check.title || '').trim().toLowerCase() === focusedWindow.toLowerCase());
      if (match) return { ok: true, detail: `${match.label} confirmed by the focused element` };
    }
  } catch {
    // Fall through to window inspection.
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    for (const check of checks) {
      const state = probe?.inspectWindowState
        ? await probe.inspectWindowState({ title: check.title || '', process: check.process || '' })
        : await inspectWindowState({ title: check.title || '', process: check.process || '' });
      if (['foreground', 'background', 'minimized', 'hidden'].includes(state.state)) {
        return { ok: true, detail: `${check.label} ${state.state}` };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(500);
  }
  return { ok: false, message: `“${step.name}” reported success, but no ${checks[0].label} window appeared.` };
}

/** A "focused existing" launch claim is only true if the app reaches the foreground. */
async function confirmLaunchFocus(step, result, run, probe = null) {
  if (run?.dryRun || step.type !== 'launchApp') return { ok: true };
  const output = String(result?.output || '');
  // The launch reports the process it really focused; the step target is often
  // a display name such as "Google Chrome", which is not a process name.
  const reported = output.match(/^focused\s+(?:existing\s+)?(\S+)(?:\s+::\s+(.*))?$/i);
  if (!reported) return { ok: true };
  const processName = reported[1].trim();
  const reportedTitle = String(reported[2] || '').trim();
  const inspect = (params) =>
    probe?.inspectWindowState ? probe.inspectWindowState(params) : inspectWindowState(params);
  let state = await inspect({ process: processName, title: reportedTitle });
  if (state.state === 'foreground') return { ok: true, detail: `${processName} foreground` };
  try {
    await executeStep(
      { id: uid('chk'), type: 'focusWindow', name: `Confirm ${processName}`, params: { process: processName }, timeoutMs: 10000 },
      { live: true, runId: run.id, run, workflow: null, getTool: () => undefined }
    );
  } catch {
    // Fall through to the observed state; the message below reports reality.
  }
  state = await inspect({ process: processName, title: reportedTitle });
  if (state.state === 'foreground') return { ok: true, detail: `${processName} foreground (reinstated)` };
  return {
    ok: false,
    message: `“${step.name}” reported focusing ${processName}, but it is still ${state.state}; foreground is “${state.foreground?.title || 'unknown'}”.`,
  };
}

/** Look for independent evidence before failing a step for an unchanged screen. */
async function corroborateNoChange(step, checks, probe = null) {
  let focused = null;
  try {
    focused = probe?.readFocusedElement ? await probe.readFocusedElement() : await readFocusedElement();
  } catch {
    focused = null;
  }
  let textFound = false;
  const text = String(step.params?.text || '').trim();
  const window = lookupWindowFor({ step, focused });
  if (step.type === 'type' && text && (window || step.params?.foregroundHandle)) {
    // The free proof: read the window's own text and look for what was typed.
    // Accessible names cannot prove a paragraph; the document text can.
    try {
      const readTextFn = probe?.readWindowText || readWindowText;
      const seen = await readTextFn({ handle: Number(step.params?.foregroundHandle) || 0, title: window || '' });
      const haystack = normalizeText(seen?.text);
      const needle = normalizeText(text).slice(0, 160);
      textFound = Boolean(needle && haystack.includes(needle));
    } catch {
      textFound = false;
    }
  }
  if (!textFound && step.type === 'type' && window && text) {
    try {
      const element = probe?.findUiElement
        ? await probe.findUiElement({ window, name: text.slice(0, 80), controlType: 'Text|Document|Edit' })
        : await findUiElement({ window, name: text.slice(0, 80), controlType: 'Text|Document|Edit' });
      textFound = Boolean(element?.found);
    } catch {
      textFound = false;
    }
  }
  return corroboratesNoChange({ step, checks, focused, textFound });
}

const HINDRANCE_TITLE =
  /\b(save as|open file|confirm|are you sure|error|failed|failure|warning|not responding|setup|installer|installing|waiting|blocked|sign in|permission|administrator|user account control|update available)\b/i;

/** A focused dialog or error window that can explain why the last step failed. */
async function detectHindrance(probe = null) {
  try {
    const foreground = probe?.readForegroundWindow
      ? await probe.readForegroundWindow()
      : await readForegroundWindow();
    const title = String(foreground?.title || '').trim();
    if (!title || !HINDRANCE_TITLE.test(title)) return null;
    return {
      title,
      process: String(foreground.process || ''),
      className: String(foreground.className || ''),
      at: now(),
    };
  } catch {
    return null;
  }
}

/** Reinstate focus and record what was seen before an app-dependent step. */
async function perceiveStep(step, run, workflow, getTool, probe = null) {
  // `foreground: true` means "the window this run opened", the same convention
  // the typing guard uses. Reading it as the string "true" made a real window
  // check impossible.
  const declared = step.params?.foreground;
  const guard = String(
    (declared === true
      ? step.params?.window || step.params?.title || step.params?.expectedWindow || run.lastWindow?.title
      : declared || (step.type === 'focusWindow' ? step.params?.title : '')) || ''
  ).trim();
  const guardHandle = Math.max(0, Number(step.params?.foregroundHandle) || 0);
  if (!guard && !guardHandle) return;
  // A probe without a foreground reader is a desktop-free run: there is no real
  // desktop to perceive, and reading it would touch the machine running tests.
  if (probe && typeof probe.readForegroundWindow !== 'function') return;
  try {
    const state = await inspectWindowState({ title: guard });
    step.perception = { guard: guard || `hwnd ${guardHandle}`, state: state.state, foreground: state.foreground?.title || null, at: now() };
    if (state.state === 'background' || state.state === 'minimized') {
      await executeStep(
        { id: uid('chk'), type: 'focusWindow', name: `Reinstate ${guard}`, params: { title: guard }, timeoutMs: 8000 },
        { live: true, runId: run.id, run, workflow, getTool }
      );
      pushLog(run, 'info', `Focus reinstated for “${guard}” before ${step.type}.`, step.id);
    }
    // Keystrokes must not land in whatever happens to be in front. If the guard
    // window is not in front, bring it forward and read again; if it still is
    // not, the runner skips the step rather than typing into the wrong app.
    // Only a real run reads (and moves) the desktop; a test's probe owns that.
    if (!probe && ['type', 'key', 'clipboard'].includes(step.type)) {
      const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      // An inherited handle names one exact window; a title can be shared by
      // several documents of the same app.
      const inFrontWindow = (window) =>
        guardHandle && Number(window?.hwnd)
          ? Number(window.hwnd) === guardHandle
          : norm(window?.title).includes(norm(guard));
      const inFront = (title) => inFrontWindow({ title });
      if (!inFront(state.foreground?.title)) {
        try {
          await executeStep(
            {
              id: uid('chk'),
              type: 'focusWindow',
              name: `Focus ${guard || 'the run window'} before typing`,
              params: { ...(guard ? { title: guard } : {}), ...(guardHandle ? { handle: guardHandle } : {}) },
              timeoutMs: 8000,
            },
            { live: true, runId: run.id, run, workflow, getTool }
          );
        } catch (err) {
          pushLog(run, 'warn', `Could not focus “${guard}” before ${step.type}: ${err.message}`, step.id);
        }
        const after = await readForegroundWindow().catch(() => null);
        step.perception.foregroundAfterFocus = after?.title || null;
        if (!inFrontWindow(after)) {
          step.perception.guardFailed = true;
          pushLog(
            run,
            'warn',
            `“${guard}” is not the window in front (“${after?.title || 'unknown'}”) after focusing it; ${step.type} would type into the wrong app.`,
            step.id
          );
        }
      }
    }
  } catch (err) {
    pushLog(run, 'warn', `Perception check failed: ${err.message}`, step.id);
  }
}

/** Check that a passed prerequisite is still in effect before blaming the next step. */
async function priorEffectState(previous, run) {
  if (!previous || previous.status !== 'passed') return null;
  const checks = windowChecksFor(previous);
  if (checks.length) {
    for (const check of checks) {
      try {
        const state = await inspectWindowState({ title: check.title || '', process: check.process || '' });
        if (['foreground', 'background', 'minimized', 'hidden'].includes(state.state)) {
          return { ok: true, detail: `${check.label} ${state.state}` };
        }
      } catch {
        // Try the next independent window check.
      }
    }
    return { ok: false, detail: `no ${checks[0].label} window is open` };
  }
  // Every step that writes a file is re-read the way the silent verifier reads
  // it, so a repair never blames the next step for a file the previous one lost.
  if (silentChecksFor(previous).includes('file')) {
    const display = recordedOutputPath(run, previous);
    if (!display) return null;
    const absolute = resolveCheckFile(display);
    return absolute && fs.existsSync(absolute)
      ? { ok: true, detail: absolute }
      : { ok: false, detail: `${display} is missing` };
  }
  return null;
}

/**
 * Independent post-run check: verification steps must have passed and the last
 * window-producing step must still be open, unless the workflow closed it.
 */
async function runFollowup(run, probe = null) {
  if (run.dryRun || probe) return null;
  const verification = run.steps.filter((step) =>
    ['expect', 'waitFor', 'verifyScreen', 'verifyPlayback', 'mediaHold'].includes(step.type)
  );
  const failedVerification = verification.filter((step) => step.status === 'failed');
  const closedOnPurpose = run.steps.some(
    (step) =>
      (step.type === 'closeWindow' && step.status === 'passed') ||
      (step.type === 'windowAction' &&
        step.status === 'passed' &&
        String(step.params?.action || '').toLowerCase() === 'close')
  );
  let target = null;
  let windowOk = null;
  // A repair can switch the app the run really drives; the final check then
  // describes that app instead of the window the plan originally named.
  const app = run.effectiveApp?.target ? run.effectiveApp : null;
  if (!closedOnPurpose) {
    if (app && (app.title || app.process || app.target)) {
      // An app described only by its target still names a real process: resolve
      // it from the install catalogue instead of reporting the window as gone.
      const known = app.process || app.title ? null : catalogEntry([app.target, app.name]);
      const check = { title: app.title || '', process: app.process || known?.process || '' };
      if (check.title || check.process) {
        try {
          const state = await inspectWindowState(check);
          windowOk = ['foreground', 'background', 'minimized', 'hidden'].includes(state.state);
        } catch {
          windowOk = null;
        }
      } else {
        windowOk = null;
      }
    } else {
      target = [...run.steps].reverse().find((step) => windowChecksFor(step).length) || null;
      if (target) {
        const check = windowChecksFor(target)[0];
        try {
          const state = await inspectWindowState({ title: check.title || '', process: check.process || '' });
          windowOk = ['foreground', 'background', 'minimized', 'hidden'].includes(state.state);
        } catch {
          windowOk = null;
        }
      }
    }
  }
  const windowLabel = app?.name || app?.target || target?.name || '';
  const ok = failedVerification.length === 0 && windowOk !== false;
  let summary;
  if (!verification.length && !windowLabel) {
    summary = 'No independent verification step or window target was recorded; review the evidence before trusting the pass.';
  } else if (ok) {
    summary = `${verification.length} verification step(s) passed${
      windowOk === true && windowLabel ? ` and “${windowLabel}” is still open` : ''
    }.`;
  } else {
    summary = `${failedVerification.length ? `${failedVerification.length} verification step(s) failed` : ''}${
      windowOk === false && windowLabel ? `${failedVerification.length ? '; ' : ''}“${windowLabel}” is no longer open` : ''
    }.`;
  }
  return {
    at: now(),
    ok,
    summary,
    verificationFound: verification.length,
    verificationFailed: failedVerification.map((step) => step.name),
    window: windowOk,
    windowTarget: windowLabel || null,
    app: app ? { name: app.name || '', target: app.target, replacedFrom: app.replacedTarget || null } : null,
  };
}

/** A safe prerequisite redo: never replay a mutating input step here. */
function priorRepairCandidate(previous) {
  if (!previous) return null;
  const steps = [];
  if (['launchApp', 'openUrl', 'focusWindow'].includes(previous.type)) {
    steps.push({ ...JSON.parse(JSON.stringify(previous)), id: uid('back'), status: 'pending', attempts: 0, repairs: [] });
  } else {
    const check = windowChecksFor(previous)[0];
    if (!check) return null;
    steps.push({
      id: uid('back'),
      type: 'focusWindow',
      name: `Re-establish ${check.label}`,
      params: check.process ? { process: check.process } : { title: check.title },
      timeoutMs: 12000,
    });
  }
  steps.push({ id: uid('back'), type: 'wait', name: 'Settle after backtrack', params: { ms: 800 }, timeoutMs: 5000 });
  return { method: `backtrack ${previous.name}`, steps };
}

async function executeRun(runId) {
  const run = findRun(runId);
  if (!run || run.status !== 'queued') return;
  const probe = runProbes.get(run.id) || null;
  // Platform fallback at the source of truth: any run that reaches the queue
  // while no live backend is available (hosted previews, headless machines)
  // converts to simulation here — whichever path created it. But detection is
  // a prediction, not proof: the machine gets a real chance to answer before
  // the run is downgraded, and a live step that hits the guard mid-run gets
  // one workaround attempt with a fresh probe.
  if (!probe) {
    const control = liveControl();
    const refusedLive = !run.dryRun && !control.available;
    // A run can also be downgraded to simulation before it reaches the queue:
    // the API does it when detection refuses a live request and records why.
    // That refusal is still only a prediction — and a stale one may even name a
    // different OS, as when a Linux refusal is carried onto a Windows host. So
    // a downgraded run gets the same real chance to answer as a live one, and
    // continues live (through the platform's own implementation) when it does.
    const downgradedAtRequest = run.dryRun && Boolean(run.liveFallback);
    if (refusedLive || downgradedAtRequest) {
      const reason = refusedLive ? control.reason : run.liveFallback;
      const proof = await probeLiveBackend();
      if (proof.ok) {
        const wasSimulated = run.dryRun;
        if (wasSimulated && run.liveConsent !== true) {
          // The console already told the operator this run is a simulation.
          // Switching it to driving the real desktop mid-run would change what
          // they were shown without asking them, so the correction is offered
          // instead: the run stays simulated and the offer waits for an
          // explicit live start.
          run.liveOffer = {
            at: now(),
            reason: String(reason || 'no live backend'),
            detail: String(proof.detail || 'answered'),
          };
          pushLog(
            run,
            'warn',
            `The run was downgraded to simulated (“${reason}”), but the machine answers natively (${proof.detail}). It stays simulated: switching to real desktop input needs the operator's consent, and a live run can be started from this offer.`,
            null
          );
        } else {
          run.dryRun = false;
          run.liveFallback = null;
          run.liveOffer = null;
          run.detectionCorrected = true;
          pushLog(run, 'warn', wasSimulated
            ? `The run was downgraded to simulated (“${reason}”), but the machine answers natively (${proof.detail}) — initial detection was wrong. Workaround applied: the run continues live.`
            : `Detection said “${control.reason}”, but the machine answers natively (${proof.detail}); initial detection was wrong — the run continues live.`, null);
        }
      } else if (refusedLive) {
        run.dryRun = true;
        run.liveFallback = `${control.reason || 'no live backend'} (probe: ${proof.detail || 'no answer'})`;
        pushLog(run, 'warn', `Live refused on this machine (${run.liveFallback}); the run continues simulated instead.`, null);
        try {
          recordAction({ kind: 'run', action: `start-run:${run.workflowName}`, error: run.liveFallback, detail: { runId: run.id, requestedMode: 'live' } });
        } catch { /* logging never blocks the run */ }
      } else {
        pushLog(run, 'info', `Simulated run: the earlier refusal (“${reason}”) still holds (probe: ${proof.detail || 'no answer'}).`, null);
      }
    } else if (!run.dryRun && control.backend === 'linux' && !control.mobile) {
      const proof = await probeLiveBackend();
      if (!proof.ok) {
        run.dryRun = true;
        run.liveFallback = `Linux X11 display is not reachable or authorized (probe: ${proof.detail || 'no answer'}).`;
        pushLog(run, 'warn', `Live refused on this machine (${run.liveFallback}); the run continues simulated instead.`, null);
      }
    }
  }
  const repairEnabled = !run.dryRun && run.liveRepair !== false && (run.liveRepair === true || !probe);
  const capture = () => (probe?.captureScreenSignature ? probe.captureScreenSignature() : captureScreenSignature());
  const workflow = run.workflowSnapshot || db().workflows.find((w) => w.id === run.workflowId);
  run.status = 'running';
  run.startedAt = now();
  persist();
  logActivity('run', `Running "${run.workflowName}" (${run.dryRun ? 'simulated' : 'live'})`, { runId: run.id });
  beginRunObservation(run);
  try {
    await presenterStart(run, workflow);
  } catch (err) {
    pushLog(run, 'warn', `Presenter start failed: ${err.message}`);
  }

  const getTool = (id) => db().tools.find((t) => t.id === id);
  let failedCount = 0;
  let firstFailure = null;
  const startedAll = Date.now();
  let visualEnabled = !run.dryRun && run.visualChecks !== false;
  let lastSignature = null;
  if (visualEnabled) {
    try {
      lastSignature = await capture();
      run.visualBaseline = { hash: signatureHash(lastSignature), at: lastSignature.at };
    } catch (err) {
      visualEnabled = false;
      run.visualError = String(err.message || err).slice(0, 300);
      pushLog(run, 'warn', `Visual step audits disabled: ${run.visualError}`);
    }
  }

  const auditVisual = async (step) => {
    if (!visualEnabled || !shouldAuditVisual(step)) return;
    try {
      const after = await capture();
      if (lastSignature) {
        const delta = diffSignatures(lastSignature, after);
        step.visual = {
          ...delta,
          beforeHash: signatureHash(lastSignature),
          afterHash: signatureHash(after),
          noVisibleChange: delta.changedPct < 1,
          at: after.at,
        };
        if (step.visual.noVisibleChange && visualChangeMatters(step)) {
          step.audit = {
            level: 'warning',
            message: `No visible screen change after “${step.name}”; verify the control landed or add a wait/assertion.`,
            at: after.at,
          };
          run.visualWarnings.push({ stepId: step.id, step: step.name, changedPct: delta.changedPct, at: after.at });
          if (run.visualWarnings.length > 80) run.visualWarnings = run.visualWarnings.slice(-80);
          pushLog(run, 'warn', step.audit.message, step.id);
        }
      }
      lastSignature = after;
    } catch (err) {
      visualEnabled = false;
      run.visualError = String(err.message || err).slice(0, 300);
      pushLog(run, 'warn', `Visual step audits disabled: ${run.visualError}`, step.id);
    }
  };

  // Repairs use the same execute + verify path as a normal attempt, so a
  // repaired step cannot report success without the window/effect/screen checks.
  const tryCandidate = async (candidate) => {
    const ctx = { live: !run.dryRun, runId: run.id, run, workflow, getTool };
    let result = probe?.executeStep ? await probe.executeStep(candidate, ctx) : await executeStep(candidate, ctx);
    const focusClaim = await confirmLaunchFocus(candidate, result, run, probe);
    if (!focusClaim.ok) {
      const err = new Error(focusClaim.message);
      err.verification = true;
      throw err;
    }
    if (focusClaim.detail) candidate.verification = { kind: 'window', detail: focusClaim.detail, at: now() };
    const effect = await verifyStepWindow(candidate, run, probe);
    if (!effect.ok) {
      const err = new Error(effect.message);
      err.verification = true;
      throw err;
    }
    if (effect.detail && !candidate.verification) candidate.verification = { kind: 'window', detail: effect.detail, at: now() };
    const checks = await runPostChecks(candidate, ctx, probe);
    if (checks.length) {
      const checkOutput = checks.map((check) => check.output).filter(Boolean).join(' | ');
      result.output = [result.output, checkOutput].filter(Boolean).join(' | Follow-up: ');
      result.evidence = [...(result.evidence || []), ...checks.flatMap((check) => check.evidence || [])];
    }
    if (expectsScreenChange(candidate) && visualEnabled) {
      const after = await capture();
      if (lastSignature) {
        const delta = diffSignatures(lastSignature, after);
        const confirmedBy =
          delta.changedPct < 1 ? await corroborateNoChange(candidate, buildPostCheck(candidate) ? checks : [], probe) : '';
        const verdict = screenChangeVerdict({ step: candidate, changedPct: delta.changedPct, confirmedBy });
        if (!verdict.ok) {
          const err = new Error(verdict.message);
          err.verification = true;
          throw err;
        }
        // A proof already on the step (the named window, a launch claim) stays:
        // the screen diff is evidence, not a replacement for the destination.
        if (!candidate.verification) {
          candidate.verification = {
            kind: 'screen',
            changedPct: delta.changedPct,
            ...(verdict.corroborated ? { corroborated: verdict.corroborated } : {}),
            at: after.at,
          };
        }
      }
      lastSignature = after;
    }
    return result;
  };

  const attemptRepair = async (step, errorText, think = null) => {
    const failure = { signature: repairSignature(step, errorText), category: categorizeFailure({ ...step, error: errorText }) };
    // An error dialog, installer window or modal that now has focus is a
    // hindrance, not the failed action's fault. Record it so the repair agent
    // can work inside it or clear it instead of repeating the same step.
    const hindrance = await detectHindrance(probe);
    if (hindrance) {
      run.hindrance = hindrance;
      step.hindrance = hindrance;
      pushLog(
        run,
        'warn',
        `Blocked by “${hindrance.title}” (${hindrance.process || 'unknown process'}) while “${step.name}” failed; the repair looks for a way past it.`,
        step.id
      );
    }
    const advice = repairAdvice(db(), { step, failure });
    // Re-conjoin: a step with the same fingerprint already passed somewhere
    // else — hand its proven form to the agents instead of a fresh guess.
    try {
      for (const solution of similarSolutions({ step, excludeWorkflowId: workflow.id })) {
        advice.push({
          name: 'step factoring',
          kind: 'pattern',
          advice: `This exact step form already passed ${solution.successes}× in “${solution.workflowName}” (step “${solution.stepName}”, strength ${solution.strength}); adopt its params ${JSON.stringify(solution.params).slice(0, 260)} before trying a new method.`,
        });
      }
    } catch { /* factoring advice is additive, never required */ }
    if (advice.length) {
      run.repairAdvice = [...(run.repairAdvice || []), { stepId: step.id, at: now(), advice }].slice(-12);
      pushLog(
        run,
        'info',
        `Agents reviewing “${step.name}”: ${advice.map((entry) => `${entry.name}: ${entry.advice}`).join(' ')}`,
        step.id
      );
    }
    // Start the model call now so its latency overlaps the fast deterministic
    // repairs. If a deterministic method succeeds, the result is ignored.
    const aiPromise =
      run.aiReplan !== false && (!probe || typeof probe.agentAsk === 'function')
        ? agentReplan({
            run,
            workflow,
            step,
            index: run.steps.indexOf(step),
            error: errorText,
            failure,
            hindrance,
            advice,
            ask: probe?.agentAsk || null,
            database: db(),
          }).catch((err) => ({ ok: false, error: String(err.message || err), steps: [], remainingSteps: [] }))
        : null;

    const previous = run.steps[run.steps.indexOf(step) - 1];
    let prior = null;
    try {
      prior = await priorEffectState(previous, run);
    } catch (err) {
      pushLog(run, 'warn', `Backtrack check failed: ${err.message}`, step.id);
    }
    if (prior && prior.ok === false) {
      pushLog(
        run,
        'warn',
        `Backtrack: “${previous.name}” is no longer in effect (${prior.detail}). Re-establishing it before retrying “${step.name}”.`,
        step.id
      );
      const backtrack = priorRepairCandidate(previous);
      if (backtrack) {
        try {
          for (const sub of backtrack.steps) await tryCandidate(sub);
          step.repairs = [...(step.repairs || []), { method: backtrack.method, ok: true, at: now() }];
        } catch (err) {
          step.repairs = [...(step.repairs || []), { method: backtrack.method, ok: false, at: now(), error: String(err.message || err).slice(0, 240) }];
          pushLog(run, 'warn', `Backtrack repair failed: ${err.message}`, step.id);
        }
      }
    }
    // Corrections prepared while the step was still running go first: they were
    // sampled against the screen as it actually is, not reconstructed after the
    // fact. They never replace the step; a dialog they answer still leaves the
    // original action to prove itself.
    const thinkCandidates = thinkRepairCandidates({ run, step, think, settings: stepThinkSettings() });
    if (thinkCandidates.length) {
      pushLog(
        run,
        'info',
        `Step thinking prepared ${thinkCandidates.length} correction(s) for “${step.name}”: ${thinkCandidates.map((entry) => entry.think.why).join(' | ')}`,
        step.id
      );
    }
    const candidates = [
      ...thinkCandidates,
      ...recallRepairMemory(db(), { step, failure, workflowId: run.workflowId }),
      ...repairCandidates({ step, run, workflow, goal: workflowGoal(workflow, run), error: errorText }),
    ];
    const applyRepairCandidate = async (candidate, meta = {}) => {
      let result = null;
      for (const sub of candidate.steps) result = await tryCandidate(sub);
      if (!candidate.replaces) result = await tryCandidate(step);
      step.repairs = [...(step.repairs || []), { method: candidate.method, ok: true, at: now(), replaces: Boolean(candidate.replaces) }];
      // The repair may have opened a different app than the plan named. Adopt
      // it so the presenter, fallbacks, continuation and final check describe
      // the app that actually ran (for example Calculator, not the missing window).
      try {
        await presenterAdoptApp(run, workflow, { steps: candidate.steps, method: candidate.method, step });
      } catch (err) {
        pushLog(run, 'warn', `Presenter could not adopt the repaired app: ${err.message}`, step.id);
      }
      rememberRepairMemory(db(), {
        workflowId: run.workflowId,
        step,
        failure,
        method: candidate.method,
        steps: candidate.steps,
        replaces: candidate.replaces,
      });
      if (meta.lesson) {
        rememberAgentLesson(db(), {
          goal: workflowGoal(workflow, run),
          workflowId: run.workflowId,
          step,
          method: candidate.method,
          diagnosis: meta.ai?.diagnosis || '',
          lesson: meta.lesson,
        });
      }
      pushLog(run, 'info', `Repaired “${step.name}” via ${candidate.method}.`, step.id);
      if (candidate.method.startsWith('step-think:')) {
        recordThinkOutcome(run, step, { method: candidate.method, ok: true });
      }
      return { ok: true, result, method: candidate.method, failure };
    };

    let lastRepairError = null;
    for (const candidate of candidates.slice(0, 7)) {
      await waitWhileRunPaused(run);
      if (run.cancelRequested) return { ok: false, error: 'Repair chain cancelled by operator.', failure };
      if (candidate.method.startsWith('step-think:')) {
        const blocked = thinkBlocked(run, step, stepThinkSettings());
        if (blocked) {
          pushLog(run, 'warn', `Step thinking held back for “${step.name}”: ${blocked}.`, step.id);
          continue;
        }
      }
      try {
        return await applyRepairCandidate(candidate);
      } catch (err) {
        lastRepairError = err.message || String(err);
        step.repairs = [
          ...(step.repairs || []),
          { method: candidate.method, ok: false, at: now(), error: String(lastRepairError).slice(0, 240) },
        ];
        pushLog(run, 'warn', `Repair “${candidate.method}” failed: ${lastRepairError}`, step.id);
        if (candidate.method.startsWith('step-think:')) {
          const outcome = recordThinkOutcome(run, step, { method: candidate.method, ok: false, error: lastRepairError });
          if (outcome.blocked) {
            pushLog(run, 'warn', `Step thinking stopped for “${step.name}”: ${outcome.blocked}.`, step.id);
          }
        }
      }
    }

    // One model call can either replace the step or rewrite the remainder of
    // the plan. It runs only after the fast deterministic methods are exhausted.
    if (aiPromise) {
      const ai = await aiPromise;
      if (ai?.error) {
        pushLog(run, 'warn', `AI repair unavailable: ${ai.error}`, step.id);
      }
      if (ai && !ai.steps?.length && !ai.remainingSteps?.length && (ai.method || ai.diagnosis)) {
        const brief = {
          at: now(),
          diagnosis: ai.diagnosis,
          method: ai.method,
          confidence: ai.confidence,
          replacesStep: ai.replacesStep,
          steps: [],
          remaining: [],
        };
        step.agentReplan = brief;
        run.agentReplans = [...(run.agentReplans || []), { stepId: step.id, step: step.name, ...brief }].slice(-12);
        pushLog(run, 'warn', `AI repair found no executable step for “${step.name}”${ai.diagnosis ? `: ${ai.diagnosis}` : ''}`, step.id);
      }
      if (ai && (ai.steps?.length || ai.remainingSteps?.length)) {
        const brief = {
          at: now(),
          diagnosis: ai.diagnosis,
          method: ai.method,
          confidence: ai.confidence,
          replacesStep: ai.replacesStep,
          steps: (ai.steps || []).map((entry) => `${entry.type}: ${entry.name}`),
          remaining: (ai.remainingSteps || []).map((entry) => `${entry.type}: ${entry.name}`),
        };
        step.agentReplan = brief;
        run.agentReplans = [...(run.agentReplans || []), { stepId: step.id, step: step.name, ...brief }].slice(-12);
        pushLog(
          run,
          'info',
          `AI repair for “${step.name}”: ${ai.method}${ai.diagnosis ? ` — ${ai.diagnosis}` : ''}${
            ai.steps?.length ? ` (${ai.steps.length} replacement step(s))` : ''
          }${ai.remainingSteps?.length ? ` (${ai.remainingSteps.length} remaining step(s) replanned)` : ''}`,
          step.id
        );
        if (ai.steps?.length) {
          try {
            const applied = await applyRepairCandidate(
              { method: `AI replan: ${ai.method}`, steps: ai.steps, replaces: ai.replacesStep },
              { lesson: ai.remember, ai }
            );
            return { ...applied, aiMethod: ai.method };
          } catch (err) {
            lastRepairError = err.message || String(err);
            step.repairs = [
              ...(step.repairs || []),
              { method: `AI replan: ${ai.method}`, ok: false, at: now(), error: String(lastRepairError).slice(0, 240) },
            ];
            pushLog(run, 'warn', `AI repair “${ai.method}” failed: ${lastRepairError}`, step.id);
          }
        }
        if (ai.remainingSteps?.length) {
          run.replanLesson = ai.remember || '';
          return { ok: false, error: lastRepairError, failure, remainingSteps: ai.remainingSteps, ai };
        }
      }
    }
    return { ok: false, error: lastRepairError, failure };
  };

  for (const step of run.steps) {
    await waitWhileRunPaused(run);
    if (run.cancelRequested) {
      step.status = step.status === 'pending' ? 'skipped' : step.status;
      continue;
    }
    if (run.skipRequested) {
      run.skipRequested = false;
      step.status = 'skipped';
      step.output = 'Skipped by operator before it ran.';
      pushLog(run, 'warn', `Skipped step "${step.name}" by operator.`, step.id);
      persist();
      continue;
    }
    if (step.status === 'passed' && step.carriedFrom) {
      pushLog(run, 'info', `Passed through “${step.name}” — it already completed in ${step.carriedFrom.runId || 'the previous attempt'}.`, step.id);
      continue;
    }
    const conditionMet = stepConditionMet(step, run);
    const decision = await deliberateStep({
      step,
      index: run.steps.indexOf(step),
      run,
      workflow,
      live: !run.dryRun,
      conditionMet,
    });
    step.deliberation = decision;
    if (decision.action === 'skip') {
      step.status = 'skipped';
      step.output = `Skipped by step check: ${decision.reason}`;
      recordLedger(run, step);
      pushLog(run, 'info', `Step check skipped "${step.name}": ${decision.reason}`, step.id);
      persist();
      continue;
    }
    if (!conditionMet) {
      step.status = 'skipped';
      step.output = 'Skipped: new chat was not requested.';
      recordLedger(run, step);
      pushLog(run, 'info', `Skipped "${step.name}": condition not met.`, step.id);
      persist();
      continue;
    }
    if (decision.reason && step.condition === 'newChat') {
      pushLog(run, 'info', `Step check for "${step.name}": ${decision.reason}${decision.observation ? ` ${decision.observation}` : ''}`, step.id);
    }
    if (!run.dryRun) {
      try {
        await awaitUserSettle(step, run, probe);
      } catch (err) {
        pushLog(run, 'warn', `Presence hold failed: ${err.message}`, step.id);
      }
      try {
        const context = await applyStepContext(step, run, workflow, probe);
        if (context?.skipReason) {
          step.status = 'skipped';
          step.output = context.skipReason;
          recordLedger(run, step);
          pushLog(run, 'info', `Skipped "${step.name}": ${context.skipReason}`, step.id);
          persist();
          continue;
        }
      } catch (err) {
        pushLog(run, 'warn', `State check failed: ${err.message}`, step.id);
      }
      try {
        const skipReason = await preStepSkip(step, probe, run);
        if (skipReason) {
          step.status = 'skipped';
          step.output = skipReason;
          recordLedger(run, step);
          pushLog(run, 'info', `Skipped "${step.name}": ${skipReason}`, step.id);
          persist();
          continue;
        }
      } catch (err) {
        pushLog(run, 'warn', `Pre-step window check failed: ${err.message}`, step.id);
      }
      // A launch that only re-raised an already-open document is not a new
      // window: typing into it would overwrite the operator's own work.
      if (['type', 'key', 'clipboard'].includes(step.type) && !String(step.params?.foreground || '').trim()) {
        const adopted = [...(run.steps || [])].reverse().find((entry) => entry.launch?.adopted);
        if (adopted) {
          step.status = 'skipped';
          step.output = `Skipped: “${adopted.launch.target}” was already showing the saved document “${adopted.launch.after}”, so the launch opened no new window; ${step.type} would have landed in that file.`;
          recordLedger(run, step);
          pushLog(run, 'warn', step.output, step.id);
          persist();
          continue;
        }
      }
      deriveFocusTarget(step, run);
      deriveTypingGuard(step, run);
      // After inheritance a typing step still without a window has no destination
      // this run can name, and "whatever is in front" is how it typed into an
      // unrelated text area. Nothing is sent; the console asks for a window.
      if (['type', 'key', 'clipboard'].includes(step.type) && !String(step.params?.foreground || '').trim()) {
        step.status = 'skipped';
        step.output = `Skipped: no window was named or opened before “${step.name}”, so the keystrokes were not sent anywhere. Add a focusWindow step or set the step's foreground window.`;
        recordLedger(run, step);
        pushLog(run, 'warn', step.output, step.id);
        persist();
        continue;
      }
      await perceiveStep(step, run, workflow, getTool, probe);
      if (step.perception?.guardFailed) {
        step.status = 'skipped';
        step.output = `Skipped: “${step.perception.guard}” is not the window in front (“${step.perception.foregroundAfterFocus || 'unknown'}”), so the keystrokes were not sent.`;
        recordLedger(run, step);
        pushLog(run, 'warn', step.output, step.id);
        persist();
        continue;
      }
      // The firewall gate: the last thing that happens before a step acts.
      // Deny skips with the reason; review offers the step as a decision.
      const verdict = firewallCheck(step, run);
      if (verdict.verdict === 'deny') {
        step.status = 'skipped';
        step.output = `Firewall denied: ${verdict.reason}`;
        step.firewall = verdict;
        recordLedger(run, step);
        pushLog(run, 'error', `Firewall denied “${step.name}” (${verdict.ruleName}): ${verdict.reason}`, step.id);
        recordAction({ kind: 'firewall', action: `deny:${step.type}`, error: verdict.reason, detail: { runId: run.id, step: step.name, rule: verdict.ruleName } });
        persist();
        continue;
      }
      if (verdict.verdict === 'review') {
        step.status = 'skipped';
        step.output = `Firewall held for review: ${verdict.reason}`;
        step.firewall = verdict;
        recordLedger(run, step);
        pushLog(run, 'warn', `Firewall held “${step.name}” for review: ${verdict.reason}`, step.id);
        try {
          addNote({ by: 'firewall', tags: ['must-check', 'firewall'], text: `Review needed on “${run.workflowName}” step “${step.name}” (${step.type}): ${verdict.reason}` });
        } catch { /* notes never break the run */ }
        persist();
        continue;
      }
    }
    try {
      await presenterBeginStep(run, workflow, step);
    } catch (err) {
      pushLog(run, 'warn', `Presenter step start failed: ${err.message}`, step.id);
    }
    step.status = 'running';
    step.startedAt = now();
    run.currentStepId = step.id;
    recordLedger(run, step);
    persist();
    pushLog(run, 'info', `Step ${step.name} (${step.type})`, step.id);
    let maxAttempts = run.policy?.onFailure === 'retry' ? Math.max(1, Number(run.policy.maxRetries || 0) + 1) : 1;
    let lastError = null;
    let verificationFailure = false;
    let succeeded = false;
    let result = null;
    let repairResult = null;
    let skipped = false;
    let cancelled = false;
    let thinkLoop = null;
    let think = null;

    // Thinking starts with the step, not after it fails: the loop reads the
    // desktop while the action runs, samples its candidate continuations, and
    // keeps the record on the step. It is read-only; only the repair chain acts.
    if (!run.dryRun && !run.shadow) {
      try {
        const config = stepThinkSettings();
        const canObserve = !probe || typeof probe.readThinkObservation === 'function';
        if (config.enabled && canObserve) {
          thinkLoop = beginStepThink(run, step, {
            workflow,
            probe,
            settings: config,
            ask: probe?.agentAsk || null,
            onNote: (message) => pushLog(run, 'info', `Thinking: ${message}`, step.id),
          });
        }
      } catch (err) {
        pushLog(run, 'warn', `Step thinking did not start: ${err.message}`, step.id);
      }
    }

    if (step.type === 'wait') {
      step.attempts = 1;
      const requestedWait = Math.min(600000, Math.max(0, Number(step.params?.ms || 0)));
      const waitMs = run.dryRun ? Math.min(3000, requestedWait) : requestedWait;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await waitWhileRunPaused(run);
        if (run.cancelRequested) {
          cancelled = true;
          break;
        }
        if (run.skipRequested) {
          run.skipRequested = false;
          skipped = true;
          break;
        }
        await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      }
      if (!cancelled && !skipped) {
        succeeded = true;
        result = { output: `Waited ${waitMs}ms (operator-controllable).`, evidence: [] };
      }
    } else {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await waitWhileRunPaused(run);
        if (run.cancelRequested) {
          cancelled = true;
          break;
        }
        step.attempts = attempt;
        try {
          const ctx = {
            live: !run.dryRun,
            runId: run.id,
            run,
            workflow,
            getTool,
          };
          result = probe?.executeStep ? await probe.executeStep(step, ctx) : await executeStep(step, ctx);
          const focusClaim = await confirmLaunchFocus(step, result, run, probe);
          if (!focusClaim.ok) {
            const err = new Error(focusClaim.message);
            err.verification = true;
            throw err;
          }
          if (focusClaim.detail) step.verification = { kind: 'window', detail: focusClaim.detail, at: now() };
          const effect = await verifyStepWindow(step, run, probe);
          if (!effect.ok) {
            const err = new Error(effect.message);
            err.verification = true;
            throw err;
          }
          if (effect.detail && !step.verification) step.verification = { kind: 'window', detail: effect.detail, at: now() };
          // A typing step that names its window proves the destination directly:
          // the focused element is sitting in exactly the window the step named.
          const destination = String(step.params?.foreground || '').trim();
          if (!step.verification && destination && ['type', 'key', 'clipboard'].includes(step.type)) {
            try {
              const focused = probe?.readFocusedElement ? await probe.readFocusedElement() : await readFocusedElement();
              const focusedWindow = String(focused?.window || '').trim();
              if (focused?.found !== false && focusedWindow.toLowerCase() === destination.toLowerCase()) {
                step.verification = { kind: 'window', detail: `${destination} is the focused window; the destination is proven, not guessed`, at: now() };
              }
            } catch {
              // No focused element to consult; the screen diff remains the proof.
            }
          }
          const checks = await runPostChecks(step, ctx, probe);
          // Review the step's own expectation against the screen before the next
          // action is planned from it; an open dialog here shapes what comes next.
          if (!probe || typeof probe.readScreenContext === 'function') {
            try {
              const screen = probe?.readScreenContext ? await probe.readScreenContext() : await readScreenContext();
              const review = reviewPrevious({ previous: step, screen });
              if (review) {
                step.review = review;
                if (review.dialogOpen) {
                  pushLog(run, 'info', `Continuation: “${step.name}” left a ${review.dialogKind} dialog open (${review.observed}).`, step.id);
                }
                if (review.matches === false) {
                  pushLog(run, 'warn', `Continuation review: ${review.revisit}`, step.id);
                }
              }
            } catch (err) {
              pushLog(run, 'warn', `Continuation review failed: ${err.message}`, step.id);
            }
          }
          if (checks.length) {
            const checkOutput = checks.map((check) => check.output).filter(Boolean).join(' | ');
            result.output = [result.output, checkOutput].filter(Boolean).join(' | Follow-up: ');
            result.evidence = [...(result.evidence || []), ...checks.flatMap((check) => check.evidence || [])];
            pushLog(run, 'info', `Follow-up check passed for "${step.name}"${checkOutput ? `: ${checkOutput}` : ''}`, step.id);
          }
          if (expectsScreenChange(step) && visualEnabled) {
            const after = await capture();
            if (lastSignature) {
              const delta = diffSignatures(lastSignature, after);
              const confirmedBy =
                delta.changedPct < 1 ? await corroborateNoChange(step, buildPostCheck(step) ? checks : [], probe) : '';
              const verdict = screenChangeVerdict({ step, changedPct: delta.changedPct, confirmedBy });
              if (!verdict.ok) {
                const err = new Error(verdict.message);
                err.verification = true;
                throw err;
              }
              // A proof already on the step (the named window, a launch claim)
              // stays: the screen diff is evidence, not a replacement.
              if (!step.verification) {
                step.verification = {
                  kind: 'screen',
                  changedPct: delta.changedPct,
                  ...(verdict.corroborated ? { corroborated: verdict.corroborated } : {}),
                  at: after.at,
                };
              }
              if (verdict.corroborated) {
                pushLog(run, 'info', `No visible change after "${step.name}"; confirmed because ${verdict.corroborated}.`, step.id);
              }
            }
            lastSignature = after;
          }
          verificationFailure = false;
          succeeded = true;
          break;
        } catch (err) {
          lastError = err.message || String(err);
          verificationFailure = Boolean(err.verification);
          if (err.appContext) step.appContext = err.appContext;
          for (const ev of err.evidence || []) {
            if (!ev?.path || run.evidence.some((item) => item.path === ev.path)) continue;
            const evidence = {
              id: uid('evd'),
              kind: ev.kind || 'screenshot',
              caption: ev.caption || 'Failed step evidence',
              path: ev.path,
              simulated: Boolean(ev.simulated),
              width: ev.width || null,
              height: ev.height || null,
              stepId: step.id,
              createdAt: now(),
            };
            run.evidence.push(evidence);
            step.evidenceIds.push(evidence.id);
          }
          pushLog(run, 'warn', `Attempt ${attempt}/${maxAttempts} failed: ${lastError}`, step.id);
          // The platform workaround: a refusal that names the platform may be
          // detection being wrong, not the step being impossible. Prove it with
          // a real action once per run; if the machine answers natively, grant
          // one more attempt and continue live.
          if (!run.dryRun && !run.liveWorkaroundTried && isPlatformRefusal(lastError)) {
            run.liveWorkaroundTried = true;
            const proof = await probeLiveBackend();
            if (proof.ok) {
              run.detectionCorrected = true;
              maxAttempts += 1;
              pushLog(run, 'warn', `Step hit a platform guard (“${String(lastError).slice(0, 120)}”), but the machine answers natively (${proof.detail}) — initial detection was wrong. Workaround applied: one more live attempt.`, step.id);
              continue;
            }
            pushLog(run, 'info', `Platform guard confirmed by probe (${proof.detail || 'no answer'}); the refusal stands.`, step.id);
          }
          if (attempt < maxAttempts && !run.cancelRequested) {
            const pause = Math.max(0, Number(run.policy?.pauseBeforeRetryMs || 0));
            await waitBeforeRetry(run, pause ? Math.min(pause, 10000) : 300);
          }
        }
      }
      // Monitor reflex: a coordinate step that landed on a different screen
      // than the window it drives is visible here instead of mysterious.
      if (succeeded && !run.dryRun) {
        try {
          const monitor = await checkStepMonitor(step, run);
          if (monitor?.kind === 'mismatch') {
            pushLog(run, 'warn', `Monitor note: ${step.monitorNote}`, step.id);
          }
        } catch { /* the reflex never fails a passed step */ }
      }
      if (succeeded && step.type === 'launchApp' && !probe) {
        // A launch that only re-raised a window already on the desktop did not
        // open the window the flow asked for. Remembering that lets a later
        // typing step refuse to write into the operator’s existing document.
        const target = String(step.params?.target || step.params?.title || step.params?.app || '').trim();
        const windowsBefore = step.context?.state?.windows || [];
        const after = (await readForegroundWindow().catch(() => null))?.title || '';
        step.launch = {
          target,
          before: windowsBefore.slice(0, 8),
          after,
          adopted:
            windowsBefore.length > 0 &&
            !launchProducedNewWindow({ windows: windowsBefore, after }) &&
            looksLikeSavedDocument(after),
        };
        if (step.launch.adopted) {
          pushLog(
            run,
            'warn',
            `“${target}” was already showing the saved document “${after}”; the launch opened no new window, so typing will not touch that file.`,

            step.id
          );
        }
      }
      if (thinkLoop) think = await thinkLoop.stop();
      if (think?.overseer) {
        pushLog(
          run,
          'info',
          `Overseer: ${think.overseer.decision} — ${think.overseer.recommend}${think.overseer.why ? ` (${think.overseer.why})` : ''}`,
          step.id
        );
      }
      if (run.cancelRequested && !succeeded) cancelled = true;
      if (!succeeded && !cancelled && !skipped && repairEnabled) {
        step.repairStartedAt = now();
        repairResult = await attemptRepair(step, lastError, think);
        if (repairResult.ok) {
          succeeded = true;
          result = repairResult.result;
          step.repairedBy = repairResult.method;
          step.repairSummary = `Recovered via ${repairResult.method}`;
          pushLog(run, 'info', `Step “${step.name}” recovered; continuing with the workflow.`, step.id);
        } else if (repairResult.error) {
          lastError = `${lastError ? `${lastError} | ` : ''}repair chain exhausted: ${repairResult.error}`;
        }
      }
    }

    step.endedAt = now();
    step.ms = runnerMs(step.startedAt, step.endedAt);
    if (!cancelled && !skipped) await auditVisual(step);
    recordLedger(run, step);

    if (cancelled) {
      step.status = 'skipped';
      step.output = 'Cancelled before completion.';
      break;
    }
    if (skipped) {
      step.status = 'skipped';
      step.output = 'Skipped by operator during the wait.';
      pushLog(run, 'warn', `Skipped wait "${step.name}" by operator.`, step.id);
      persist();
      continue;
    }
    if (result?.skipped) {
      step.status = 'skipped';
      step.output = result.output || 'Skipped.';
      pushLog(run, 'warn', `Step "${step.name}" skipped: ${step.output}`, step.id);
      persist();
      continue;
    }

    if (succeeded) {
      step.output = result?.output || '';
      if (result?.judgement) step.judgement = result.judgement;
      step.completion = completionFor(step, { ...(result || {}), output: step.output });
      if (step.completion.pending.length) {
        run.pendingVerification = [
          ...(run.pendingVerification || []).filter((entry) => entry.stepId !== step.id),
          {
            stepId: step.id,
            stepName: step.name,
            type: step.type,
            checks: step.completion.pending,
            target: String(step.params?.title || step.params?.target || step.params?.path || step.params?.filename || ''),
            at: now(),
          },
        ];
        pushLog(
          run,
          'info',
          `“${step.name}” succeeded but is not finished: ${step.completion.reason}. Silent checks queued: ${step.completion.pending.join(', ')}.`,
          step.id
        );
      }
      if (result?.appContext) step.appContext = result.appContext;
      for (const ev of result?.evidence || []) {
        const evidence = {
          id: uid('evd'),
          kind: ev.kind,
          caption: ev.caption,
          path: ev.path,
          simulated: ev.simulated,
          width: ev.width || null,
          height: ev.height || null,
          stepId: step.id,
          createdAt: now(),
        };
        run.evidence.push(evidence);
        step.evidenceIds.push(evidence.id);
      }
      try {
        await presenterAfterStep(run, workflow, step, { ok: true });
      } catch (err) {
        pushLog(run, 'warn', `Presenter verification failed: ${err.message}`, step.id);
      }
      step.status = 'passed';
      rememberWindow(run, step);
      // A screenshot is taken after every action, automatically, so the review
      // is evidence in the run instead of a button the operator has to press.
      await reviewScreenAfterStep(run, step, workflow, probe);
      recordLedger(run, step);
    } else {
      step.status = 'failed';
      step.error = lastError || 'Step failed';
      if (verificationFailure) {
        step.verificationFailed = true;
        run.effectFailures = (run.effectFailures || 0) + 1;
      }
      failedCount++;
      if (!firstFailure) firstFailure = step;
      pushLog(run, 'error', `Step "${step.name}" failed: ${step.error}`, step.id);
      if (run.policy?.captureScreenshot) await captureFailureEvidence(run, step, workflow);
      try {
        await presenterFailStep(run, workflow, step, step.error);
      } catch (err) {
        pushLog(run, 'warn', `Presenter failure update failed: ${err.message}`, step.id);
      }

      // When the step itself cannot be repaired, replace the whole remainder
      // from the current screen. Action steps become superseded (the goal may
      // still be reached), but failed verification stays failed so a pass is
      // never manufactured by rewriting around it.
      if (
        repairResult?.remainingSteps?.length &&
        run.aiReplan !== false &&
        Number(run.replanCount || 0) <
          Math.max(0, Number(run.policy?.maxReplans ?? stepThinkSettings().maxReplans ?? 2))
      ) {
        const at = run.steps.indexOf(step);
        const tail = at >= 0 ? run.steps.slice(at + 1) : [];
        if (at >= 0 && tail.length) {
          const replacement = repairResult.remainingSteps.map((entry) => ({
            ...entry,
            id: entry.id || uid('stp'),
            status: 'pending',
            attempts: 0,
            repairs: [],
            startedAt: null,
            endedAt: null,
            ms: null,
            output: '',
            error: null,
            evidenceIds: [],
            appContext: null,
          }));
          run.steps.splice(at + 1, tail.length, ...replacement);
          run.replanCount = Number(run.replanCount || 0) + 1;
          run.replannedAfterFailure = true;
          const supersede = !['expect', 'verifyScreen', 'verifyPlayback', 'mediaHold'].includes(step.type);
          if (supersede) {
            step.status = 'superseded';
            step.supersededAt = now();
            step.output = `Superseded by AI replan: ${repairResult.ai?.method || 'rewritten remainder'}.`;
            failedCount = Math.max(0, failedCount - 1);
            if (firstFailure === step) firstFailure = null;
            run.supersededSteps = [
              ...(run.supersededSteps || []),
              {
                id: step.id,
                name: step.name,
                type: step.type,
                error: step.error,
                method: repairResult.ai?.method || 'AI replan',
                at: now(),
              },
            ].slice(-12);
            recordLedger(run, step);
          }
          pushLog(
            run,
            'info',
            `AI replanned the remaining ${tail.length} step(s) after “${step.name}”${
              repairResult.ai?.method ? `: ${repairResult.ai.method}` : ''
            } (${replacement.length} new step(s)).`,
            step.id
          );
          persist();
          continue;
        }
      }

      // Keep-running: an unrepaired failure is recorded, and the rest of the
      // plan still runs up to the cap. Unguarded input steps are skipped so a
      // keystroke cannot land in the wrong app.
      const keepConfig = stepThinkSettings();
      const keepRunning = run.policy?.keepRunning === true || keepConfig.keepRunning === true;
      const maxStepFailures = Math.max(
        1,
        Number(run.policy?.maxStepFailures ?? keepConfig.maxStepFailures) || 1
      );
      if (keepRunning && failedCount < maxStepFailures) {
        run.keptRunning = [
          ...(run.keptRunning || []),
          { stepId: step.id, name: step.name, error: String(step.error || '').slice(0, 240), at: now() },
        ].slice(-20);
        pushLog(
          run,
          'warn',
          `Keeping the run going after “${step.name}” failed (${failedCount}/${maxStepFailures} this run); guarded steps still run, unguarded input steps are skipped.`,
          step.id
        );
        for (const rest of run.steps.slice(run.steps.indexOf(step) + 1)) {
          if (rest.status !== 'pending' || canContinueSafely(rest)) continue;
          rest.status = 'skipped';
          rest.output = `Skipped because “${step.name}” failed and this input step has no window or foreground guard.`;
          recordLedger(run, rest);
          pushLog(run, 'warn', rest.output, rest.id);
        }
        persist();
        continue;
      }
      const policy = run.policy?.onFailure || 'stop';
      const optional = step.optional;
      if ((policy === 'stop' || policy === 'retry') && !optional) {
        if (repairEnabled) {
          run.continuedAfterFailure = true;
          pushLog(
            run,
            'warn',
            `Continuing after “${step.name}” failed; later independent steps will still run. Input steps without a window guard are skipped so keystrokes cannot land in the wrong app.`,
            step.id
          );
          for (const rest of run.steps.slice(run.steps.indexOf(step) + 1)) {
            if (rest.status !== 'pending' || canContinueSafely(rest)) continue;
            rest.status = 'skipped';
            rest.output = `Skipped because “${step.name}” failed and this input step has no window or foreground guard.`;
            recordLedger(run, rest);
            pushLog(run, 'warn', rest.output, rest.id);
          }
        } else {
          for (const rest of run.steps.slice(run.steps.indexOf(step) + 1)) {
            if (rest.status === 'pending') rest.status = 'skipped';
          }
          break;
        }
      }
    }
    persist();
  }

  for (const step of run.steps) recordLedger(run, step);
  const failedEntries = failedStepEntries(run);
  run.failedSteps = failedEntries;
  run.repairCount = run.steps.reduce(
    (total, entry) => total + (entry.repairs || []).filter((repair) => repair.ok).length,
    0
  );
  run.errorSummary = failedEntries.length ? failureSummary(failedEntries) : null;
  run.error = failedEntries[0]?.error || null;
  const followup = await runFollowup(run, probe);
  if (followup) {
    run.followup = followup;
    pushLog(run, followup.ok ? 'info' : 'warn', `Follow-up check: ${followup.summary}`);
    if (!followup.ok && !run.errorSummary) {
      run.errorSummary = `Follow-up check failed: ${followup.summary}`;
    }
  }
  if (failedEntries.length) {
    pushLog(run, 'error', `Failure report: ${run.errorSummary}`);
  }
  run.currentStepId = null;
  run.position = {
    phase: 'finished',
    index: run.steps.length - 1,
    stepNumber: run.steps.length,
    total: run.steps.length,
    stepId: null,
    step: null,
    next: null,
    at: now(),
  };
  run.endedAt = now();
  run.durationMs = Date.now() - startedAll;
  run.pauseRequested = false;
  run.paused = false;
  run.skipRequested = false;
  clearPresenceHold(run);

  if (run.cancelRequested) {
    run.status = 'cancelled';
    for (const s of run.steps) if (s.status === 'pending') s.status = 'skipped';
  } else if (failedCount > 0) {
    const policy = run.policy?.onFailure || 'stop';
    const onlyOptional = run.steps.filter((s) => s.status === 'failed').every((s) => s.optional);
    run.status = policy === 'continue' || onlyOptional || (run.keptRunning || []).length ? 'needs_review' : 'failed';
  } else {
    run.status = 'passed';
  }
  // A failed run is a message, not just a record: the action log reports it
  // (with logs) and the working agents get a continuation addressed to them.
  if (['failed', 'needs_review'].includes(run.status)) {
    const failing = (run.steps || []).filter((s) => s.status === 'failed')[0];
    reportRunFailure(run, failing?.error || run.errorSummary || `${failedCount} step(s) failed`, failing?.error || '');
  }
  if (run.followup && run.followup.ok === false && run.status === 'passed') {
    run.status = 'needs_review';
    run.followupFailed = true;
  }
  // An automatic screen check that never matched is a soft failure: every step
  // reported success, but the frame disagreed — even on a second read. The run
  // goes to review, which also hands it to the end-of-run recheck.
  if (run.screenReviewFailed && run.status === 'passed') {
    run.status = 'needs_review';
    run.screenReviewUnresolved = true;
    const lastMismatch = (run.screenMismatches || []).slice(-1)[0];
    run.errorSummary =
      run.errorSummary ||
      `Automatic screen check did not match after “${lastMismatch?.stepName || 'a step'}”: ${
        lastMismatch?.mismatch || lastMismatch?.detail || 'no detail'
      }.`;
    pushLog(
      run,
      'warn',
      `Run sent to review: an automatic screen check did not match after “${lastMismatch?.stepName || 'a step'}”.`,
      lastMismatch?.stepId || null
    );
  }
  // Closeout prediction: the state the run leaves behind, judged once.
  try {
    recordCloseout(run);
  } catch { /* the prediction never breaks the finish */ }
  run.retryCount = run.steps.reduce((total, step) => total + Math.max(0, Number(step.attempts || 0) - 1), 0);
  run.recovered =
    run.status === 'passed' &&
    (run.retryCount > 0 || Number(run.repairCount || 0) > 0 || Boolean(run.replannedAfterFailure));
  if (firstFailure) {
    run.errorCategory = categorizeFailure(firstFailure);
    run.failureSignature = failureSignature(firstFailure);
    run.lastErrorCategory = run.errorCategory;
    run.lastErrorCode = ERROR_CODES[run.errorCategory] || 'UNKNOWN';
  } else {
    run.lastErrorCode = null;
    run.lastErrorCategory = null;
  }
  try {
    presenterFinish(run, workflow, { passed: run.status === 'passed', error: firstFailure?.error || '' });
  } catch (err) {
    pushLog(run, 'warn', `Presenter finish failed: ${err.message}`);
  }
  // Every step can pass while the app the goal names was never touched (a VLC
  // request played in Chrome). That is not a success for lists, memory or the
  // companion, so it is recorded as needs review with the evidence that failed.
  if (run.status === 'passed' && run.presenter?.summary?.goalMet === false) {
    const evidence = run.presenter.verifier?.appEvidence || {};
    const requested = run.presenter.verifier?.requestedApp || '';
    const reason = evidence.reason || `${requested || 'the app named by the goal'} was not verified`;
    run.status = 'needs_review';
    run.goalVerdict = { at: now(), app: requested, evidenced: false, reason };
    run.goalUnverified = true;
    run.errorSummary = `Goal not verified: ${reason}.`;
    pushLog(run, 'warn', `Marked needs review: ${reason}.`);
  }
  // Decide after follow-up and goal verification, so a run whose commands all
  // passed but whose goal was not proved still gets an evidence-gathering pass.
  if (!run.dryRun && !run.shadow && ['failed', 'needs_review'].includes(run.status)) {
    try {
      enqueue({ kind: 'deep-focus', payload: { id: run.id }, key: `deep-focus:${run.id}`, priority: 3 });
    } catch { /* pipeline may not be available during boot */ }
  }
  if (run.status === 'passed' && run.replannedAfterFailure && run.replanLesson && !run.replanLessonSaved) {
    const superseded = (run.supersededSteps || []).slice(-1)[0];
    rememberAgentLesson(db(), {
      goal: workflowGoal(workflow, run),
      workflowId: run.workflowId,
      step: superseded ? { type: superseded.type, name: superseded.name } : null,
      method: superseded?.method || 'AI remainder replan',
      lesson: run.replanLesson,
    });
    run.replanLessonSaved = true;
  }
  if (!run.shadow && !run.dryRun && ['passed', 'failed', 'needs_review'].includes(run.status)) {
    run.retryBudget = recordRetryOutcome(run.workflowId, {
      ok: run.status === 'passed',
      source: run.trigger || 'run',
      reason: run.failureSignature || firstFailure?.error || run.status,
    });
  }
  runProbes.delete(run.id);
  if (run.shadow) delete run.workflowSnapshot;
  persist();
  pushLog(run, run.status === 'failed' ? 'error' : 'info', `Run finished: ${run.status}`);
  endRunObservation(run);
  logActivity('run', `"${run.workflowName}" finished ${run.status}`, { runId: run.id, status: run.status });

  // The screenshot review also runs on its own at the end of a live run: open
  // steps are re-read with a fresh screenshot and, when "continue after" is
  // checked, the run continues with the completed steps passed through.
  if (
    !probe &&
    !run.dryRun &&
    !run.shadow &&
    !run.autoRecheckDone &&
    Number(run.retryDepth || 0) < 1 &&
    ['failed', 'needs_review'].includes(run.status)
  ) {
    const cfg = recheckSettings();
    if (cfg.enabled) {
      run.autoRecheckDone = true;
      persist();
      try {
        await recheckRun(run.id, { continueAfter: cfg.continueAfter });
      } catch (err) {
        pushLog(run, 'warn', `Automatic recheck failed: ${err.message}`);
      }
    }
  }

  if (runFinishedHook) {
    Promise.resolve(runFinishedHook(run)).catch((err) => {
      run.log.push({ at: now(), level: 'warn', message: `Run-finished hook failed: ${err.message}` });
    });
  }

  // A simulated run reads no desktop and executes no input: a needs-review result
  // there is a rehearsal, not a failure, so it must not spend analysis, repair or
  // retry-budget work on a goal that nothing actually exercised.
  const simulatedRun = Boolean(run.dryRun);
  const shouldAnalyze = !simulatedRun && (run.status === 'failed' || run.status === 'needs_review');
  if (!simulatedRun && run.status === 'failed') {
    run.triageDone = false;
  }

  if (db().settings.autoNotes && !run.shadow) {
    if (shouldAnalyze) {
      void analyzeRun(run)
        .then((analysis) => {
          if (!findRun(run.id)) return;
          run.analysis = analysis;
          persist();
          if (analysis.nextActions?.length) {
            addSuggestion(
              `Failure in "${firstFailure?.name}": ${analysis.nextActions[0]}`,
              'failure',
              run.workflowId,
              run.id
            );
          }
          writeRunNote(run);
        })
        .catch((err) => {
          run.log.push({ at: now(), level: 'warn', message: `Analysis failed: ${err.message}` });
          writeRunNote(run);
        });
    } else {
      writeRunNote(run);
    }
  }

  for (const text of suggestionsFor(workflow, run)) {
    addSuggestion(text, 'workflow', run.workflowId, run.id);
  }
}

function runnerMs(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function controlRun(id, action) {
  const run = findRun(id);
  if (!run) throw new Error('Run not found');
  const code = String(action || '').toLowerCase();
  if (!['pause', 'resume', 'continue', 'skip', 'bypass'].includes(code)) {
    throw new Error('Unknown run control. Use pause, resume, continue, skip or bypass.');
  }
  if (!['queued', 'running'].includes(run.status)) {
    throw new Error(`Run is ${run.status}; controls only apply while queued or running.`);
  }
  if (code === 'pause') {
    run.pauseRequested = true;
    pushLog(run, 'info', 'Pause requested; holding at the next step or wait boundary.');
  } else if (code === 'resume') {
    run.pauseRequested = false;
    run.paused = false;
    pushLog(run, 'info', 'Resume requested.');
  } else if (code === 'continue') {
    run.pauseRequested = false;
    run.paused = false;
    run.skipRequested = false;
    pushLog(run, 'info', 'Continue requested; clearing pause and skip flags.');
  } else if (code === 'skip') {
    run.skipRequested = true;
    pushLog(run, 'warn', 'Skip requested; the current wait or next step will be skipped.');
  } else if (code === 'bypass') {
    run.presenceBypass = true;
    run.presence = { ...(run.presence || {}), holding: false, reason: 'bypassed by the operator' };
    pushLog(run, 'info', 'Run now anyway: the presence hold is bypassed; the step takes focus immediately.');
  }
  persist();
  logActivity('run', `Control ${code} on ${run.workflowName}`, { runId: run.id });
  return run;
}

export function cancelRun(id) {
  const run = findRun(id);
  if (!run) return null;
  if (run.status === 'queued') {
    run.cancelRequested = true;
    run.status = 'cancelled';
    run.endedAt = now();
    clearPresenceHold(run);
    const idx = queue.indexOf(id);
    if (idx >= 0) queue.splice(idx, 1);
    persist();
    logActivity('run', `Cancelled queued run ${id}`, { runId: id });
    return run;
  }
  if (run.status === 'running') {
    run.cancelRequested = true;
    pushLog(run, 'warn', 'Cancellation requested; finishing current step.');
    persist();
    return run;
  }
  return run;
}

export async function retryRun(id, { replan = true, planner = planSteps, carry = true, probe = null } = {}) {
  const original = findRun(id);
  if (!original) throw new Error('Run not found');
  const workflow = db().workflows.find((w) => w.id === original.workflowId);
  if (!workflow) throw new Error('Workflow for this run no longer exists');
  let planInfo = null;
  if (replan && ['failed', 'needs_review', 'cancelled'].includes(original.status)) {
    const goal = workflowGoal(workflow, original);
    if (goal) {
      try {
        const plan = await planner(goal, { ...workflow, steps: [] });
        const rawSteps = Array.isArray(plan?.steps) ? plan.steps : [];
        const planned = rawSteps.filter((step) => step?.type);
        // A repair plan does not have to type anything (screenshots, waits,
        // notes and window steps are valid). Only reject a plan that is
        // shorter than the original or contains unusable entries.
        const minimum = Math.min(6, workflow.steps?.length || 1);
        if (planned.length >= minimum && planned.length === rawSteps.length) {
          workflow.steps = planned.map((step, index) => ({
            ...step,
            id: step.id || uid('stp'),
            name: String(step.name || `Step ${index + 1}`).slice(0, 80),
          }));
          workflow.description = goal;
          workflow.lastPlanSource = plan.source || 'retry-repair';
          workflow.lastPlanNote = String(plan.note || '').slice(0, 500);
          workflow.autoPlannedAt = now();
          workflow.updatedAt = now();
          persist();
          logActivity('workflow', `Replanned "${workflow.name}" from goal before retry (${plan.source || 'planner'})`, { runId: original.id });
          planInfo = { source: plan.source, note: plan.note, steps: workflow.steps.length };
        }
      } catch (err) {
        original.retryPlanError = String(err.message || err).slice(0, 300);
        logActivity('run', `Retry replan failed for "${workflow.name}": ${original.retryPlanError}`, { runId: original.id });
        persist();
      }
    }
  }
  const failedStep = (original.steps || []).find((step) => step.status === 'failed');
  // Only resume when the plan before the failed step is untouched; a changed
  // prefix means the plan was repaired and must replay in full.
  const resumed = failedStep ? resumePlan(workflow.steps, original.steps, failedStep.id) : null;
  // The plan replays whole so the steps that already passed can be passed
  // through; a sliced plan forgets the work that was done and redoes it.
  const run = createRun(workflow, {
    trigger: planInfo ? 'retry-replanned' : 'retry',
    dryRun: original.dryRun,
    probe,
    carryFrom: carry === false ? null : original,
  });
  run.retryOf = original.id;
  // Depth stops the automatic recheck from retrying itself in a loop.
  run.retryDepth = Number(original.retryDepth || 0) + 1;
  if (run.carriedSteps?.length) {
    logActivity('run', `Passed through ${run.carriedSteps.length} completed step(s) from ${original.id}.`, { runId: run.id });
  }
  if (resumed) {
    run.resumedFrom = {
      stepId: failedStep.id,
      step: failedStep.name,
      skipped: resumed.skipped,
    };
    logActivity('run', `Resuming "${workflow.name}" at "${failedStep.name}" instead of starting over.`, { runId: run.id });
  }
  if (planInfo) {
    run.replanned = true;
    run.retryPlan = planInfo;
    persist();
  }
  return run;
}

const recheckingRuns = new Set();

export function recheckSettings() {
  return normalizeRecheckSettings(db().settings?.recheck || {});
}

/**
 * Read-only: is this candidate's finish line on screen now? Silent checks and
 * window state only; nothing is clicked or typed.
 */
async function verifyRecheckCandidate(candidate, run, probe = null) {
  const step = (run.steps || []).find((entry) => entry.id === candidate.stepId) || {};
  const params = step.params || {};
  const target = String(
    candidate.target || params.value || params.title || params.foreground || params.windowName || params.process || ''
  ).trim();
  const checks = (candidate.checks || []).filter(Boolean);
  const details = [];
  for (const check of checks) {
    const options = { title: target, process: params.process || '', path: params.path || params.filename || '' };
    const result = probe?.silentCheck ? await probe.silentCheck(check, options) : await silentCheck(check, options);
    if (result?.ok !== true) return { ok: false, detail: result?.detail || `${check} is not satisfied yet` };
    details.push(`${check}: ${result.detail || 'ok'}`);
  }
  if (checks.length) return { ok: true, detail: details.join('; ') };
  if (target) {
    const state = probe?.inspectWindowState
      ? await probe.inspectWindowState({ title: target, process: params.process || '' })
      : await inspectWindowState({ title: target, process: params.process || '' });
    const present = ['foreground', 'background', 'minimized', 'visible'].includes(state?.state);
    return { ok: present, detail: `${target}: window ${state?.state || 'unknown'}` };
  }
  return { ok: false, detail: 'nothing read-only to confirm; this step has to run again' };
}

/**
 * Recheck a finished run: passed steps are never repeated, and the steps that
 * failed or sat pending too long get a bounded, screenshot-backed re-read. The
 * optional "continue after" retries the run with every completed step passed
 * through instead of starting over.
 */
export async function recheckRun(id, { continueAfter = null, probe = null } = {}) {
  const run = findRun(id);
  if (!run) throw new Error('Run not found');
  if (['queued', 'running'].includes(run.status)) throw new Error('This run is still running; recheck it after it finishes.');
  if (recheckingRuns.has(run.id)) throw new Error('A pending recheck is already running for this run.');
  const settings = recheckSettings();
  if (!settings.enabled) throw new Error('Pending recheck is turned off in Settings.');
  const cfg = continueAfter == null
    ? settings
    : normalizeRecheckSettings({ ...settings, continueAfter: Boolean(continueAfter) });
  recheckingRuns.add(run.id);
  run.recheck = {
    status: 'checking',
    startedAt: now(),
    attempts: 0,
    checked: 0,
    resolved: 0,
    unresolved: 0,
    continueAfter: Boolean(cfg.continueAfter),
  };
  pushLog(run, 'info', `Pending recheck started${cfg.continueAfter ? ' (continue after)' : ''}: failed and stalled steps are re-read with a fresh screenshot.`);
  persist();
  try {
    const workflow = db().workflows.find((entry) => entry.id === run.workflowId) || null;
    const summary = await runPendingRecheck(run, cfg, {
      now,
      uid,
      sleep,
      capture: async () => {
        const step = { type: 'screenshot', name: 'Recheck screen', params: { caption: 'Pending recheck' } };
        const ctx = { live: !run.dryRun, runId: run.id, run, workflow };
        const result = probe?.executeStep ? await probe.executeStep(step, ctx) : await executeStep(step, ctx);
        return result?.evidence?.[0] || null;
      },
      verify: (candidate) => verifyRecheckCandidate(candidate, run, probe),
    });
    run.recheck = {
      ...run.recheck,
      ...summary,
      status: summary.status,
      checked: summary.checked,
      resolved: summary.resolved.length,
      unresolved: summary.unresolved.length,
      needsRun: summary.needsRun.length,
      endedAt: now(),
      continued: false,
    };
    for (const entry of summary.resolved) {
      const settled = (run.steps || []).find((candidate) => candidate.id === entry.stepId);
      if (settled) recordLedger(run, settled);
    }
    if (
      summary.status === 'resolved' &&
      ['failed', 'needs_review'].includes(run.status) &&
      !run.followupFailed &&
      !run.goalUnverified
    ) {
      run.status = 'passed';
      run.recovered = true;
      run.error = null;
      run.errorSummary = null;
      run.failedSteps = [];
      run.endedAt = now();
      const startedAt = Date.parse(run.startedAt || run.createdAt || 0);
      if (Number.isFinite(startedAt)) run.durationMs = Math.max(0, Date.now() - startedAt);
      pushLog(run, 'info', 'Recheck settled every open step; the completed steps were kept and the run now passes.');
    } else {
      pushLog(
        run,
        summary.unresolved.length ? 'warn' : 'info',
        `Recheck ${String(summary.status).replace('_', ' ')}: ${summary.resolved.length} step(s) passed, ${summary.unresolved.length} still open, ${summary.needsRun.length} need a real re-run${summary.tasks.length ? `; ${summary.tasks.length} task(s) assigned` : ''}.`
      );
    }
    persist();
    const remaining = (run.steps || []).filter((step) => !['passed', 'skipped', 'superseded'].includes(step.status));
    if (cfg.continueAfter && remaining.length) {
      const retry = await retryRun(run.id, { replan: false, carry: true, probe });
      run.recheck.continued = true;
      run.recheck.retryRunId = retry.id;
      pushLog(run, 'info', `Continuing after the recheck as ${retry.id}; ${Number(retry.carriedSteps?.length || 0)} completed step(s) are passed through.`);
      persist();
    }
    return run;
  } catch (err) {
    run.recheck = { ...(run.recheck || {}), status: 'failed', error: String(err.message || err), endedAt: now() };
    persist();
    throw err;
  } finally {
    recheckingRuns.delete(run.id);
  }
}

/**
 * Boot-time cleanup: a run this process does not own was interrupted, not
 * erased. With "continue after recheck" on, it is rechecked and continued in
 * the background; otherwise it waits for the operator.
 */
export function recoverInterruptedRuns({ probe = null } = {}) {
  const touched = [];
  for (const run of db().runs || []) {
    if (!markRunInterrupted(run, { at: now() })) continue;
    pushLog(run, 'warn', `The console restarted while this run was ${run.interruptedFrom}; completed steps were kept and open steps can be rechecked.`);
    touched.push(run);
  }
  if (!touched.length) return [];
  persist();
  logActivity('run', `Kept ${touched.length} interrupted run(s) instead of erasing their progress.`);
  const cfg = recheckSettings();
  if (cfg.enabled && cfg.continueAfter) {
    for (const run of touched.slice(0, 3)) {
      recheckRun(run.id, { continueAfter: true, probe }).catch((err) =>
        pushLog(run, 'warn', `Automatic recheck failed: ${err.message}`)
      );
    }
  }
  return touched.map((run) => run.id);
}

export function addEvidence(run, evidence) {
  run.evidence.push(evidence);
  persist();
  return evidence;
}

export function activeRunCount() {
  return db().runs.filter((r) => r.status === 'running' || r.status === 'queued').length;
}

/* ---------------- Background agents ---------------- */

function agentLog(agent, message) {
  agent.log.unshift({ at: now(), message });
  agent.log = agent.log.slice(0, 40);
  persist();
}

async function runScheduler(agent) {
  const d = db();
  if (!agent.workflowId) return { skipped: 'no workflow bound' };
  const workflow = d.workflows.find((w) => w.id === agent.workflowId);
  if (!workflow) {
    agentLog(agent, 'Bound workflow no longer exists; agent paused.');
    agent.enabled = false;
    persist();
    return { skipped: 'workflow missing' };
  }
  if (workflow.status !== 'ready') return { skipped: 'workflow not ready' };
  const busyForWorkflow = d.runs.some(
    (r) => r.workflowId === workflow.id && (r.status === 'running' || r.status === 'queued')
  );
  if (busyForWorkflow) return { skipped: 'run already active' };
  const budget = canRetry(workflow.id, 'scheduler');
  if (!budget.ok) {
    agent.enabled = false;
    agent.budgetPaused = true;
    agentLog(agent, `Paused: ${budget.reason}`);
    logActivity('agent', `${agent.name} paused by shared retry budget`, { workflowId: workflow.id, reason: budget.reason });
    return { skipped: budget.reason, retryBudget: budget };
  }

  if (agent.stopOnFailure) {
    const last = d.runs.find((r) => r.workflowId === workflow.id);
    if (last && !last.dryRun && (last.status === 'failed' || last.status === 'needs_review')) {
      agent.enabled = false;
      agentLog(agent, `Paused after ${last.status} on "${workflow.name}".`);
      logActivity('agent', `${agent.name} paused after failure`, { runId: last.id });
      return { skipped: 'paused after failure' };
    }
  }

  const run = createRun(workflow, { trigger: 'agent' });
  agent.runsStarted = (agent.runsStarted || 0) + 1;
  agent.lastRunAt = now();
  agentLog(agent, `Queued "${workflow.name}" as ${run.id}.`);
  logActivity('agent', `${agent.name} queued "${workflow.name}"`, { runId: run.id });
  return { started: run.id };
}

async function runWatchdog(agent) {
  const d = db();
  const handled = new Set(agent.handled || []);
  const cutoff = Date.now() - 120000;
  const pending = d.runs.filter(
    (r) =>
      !r.dryRun &&
      (r.status === 'failed' || r.status === 'needs_review') &&
      !r.triageDone &&
      !handled.has(r.id) &&
      (r.escalated || new Date(r.endedAt || r.createdAt).getTime() < cutoff)
  );
  if (!pending.length) return { skipped: 'nothing to triage' };
  const results = [];
  for (const run of pending.slice(0, 3)) {
    const failedSteps = run.steps.filter((s) => s.status === 'failed');
    if (failedSteps.length && !run.evidence.some((e) => e.kind === 'screenshot')) {
      await captureFailureEvidence(run, failedSteps[0], d.workflows.find((w) => w.id === run.workflowId));
    }
    run.triageDone = true;
    if (!run.analysis) {
      run.analysis = {
        summary: `Watchdog: ${failedSteps.length} step(s) failed in "${run.workflowName}".`,
        rootCause: failedSteps[0]?.error || 'No error message captured.',
        nextActions: [
          'Open the run and review the captured evidence.',
          'Fix the failing step, then re-run in simulated mode.',
        ],
        source: 'watchdog',
        at: now(),
      };
    }
    writeRunNote(run);
    addSuggestion(
      `Watchdog triaged "${run.workflowName}": ${failedSteps[0]?.name || 'run'} failed. Add a retry or a wait step.`,
      'failure',
      run.workflowId,
      run.id
    );
    handled.add(run.id);
    agentLog(agent, `Triaged ${run.id} (${failedSteps.length} failed step${failedSteps.length === 1 ? '' : 's'}).`);
    results.push(run.id);
    const budget = canRetry(run.workflowId, 'watchdog');
    if (!budget.ok) {
      addSuggestion(
        `Retry budget paused for "${run.workflowName}": ${budget.reason}. Repair the workflow before retrying.`,
        'retry-budget',
        run.workflowId,
        run.id
      );
      agentLog(agent, `Shared retry budget blocks ${run.workflowName}: ${budget.reason}`);
    }
  }
  agent.handled = Array.from(handled).slice(-200);
  agent.lastRunAt = now();
  persist();
  if (results.length) logActivity('agent', `${agent.name} triaged ${results.length} failed run(s)`, { runIds: results });
  return { triaged: results };
}

async function runObserver(agent) {
  const { observeActiveMissions } = await import('./missions.js');
  const result = await observeActiveMissions(agent);
  agent.observerCount = (agent.observerCount || 0) + Number(result.observed?.length || 0);
  agent.lastRunAt = result.observed?.length ? now() : agent.lastRunAt;
  if (result.observed?.length) {
    agentLog(agent, `Observed ${result.observed.length} active mission(s): ${result.observed.join(', ')}.`);
    logActivity('agent', `${agent.name} observed ${result.observed.length} mission(s)`, { missionIds: result.observed });
  }
  return result;
}

async function runSupervisor(agent) {
  const d = db();
  const candidates = d.runs.filter(
    (r) =>
      !r.dryRun &&
      (r.status === 'failed' || r.status === 'needs_review') &&
      !r.supervised &&
      r.review?.status !== 'reviewed'
  );
  if (!candidates.length) return { skipped: 'no failures awaiting supervision' };

  const watchdog = d.agents.find((a) => a.kind === 'watchdog');
  const supervised = [];
  for (const run of candidates.slice(0, 2)) {
    let analysis = run.analysis;
    if (!analysis) {
      analysis = await analyzeRun(run);
      run.analysis = analysis;
    }
    run.supervised = true;
    run.escalated = true;
    agent.supervisedCount = (agent.supervisedCount || 0) + 1;
    addSuggestion(
      `Supervisor on “${run.workflowName}”: ${analysis.summary || 'failure reviewed'}${
        analysis.nextActions?.[0] ? ` Next: ${analysis.nextActions[0]}` : ''
      }`,
      'supervisor',
      run.workflowId,
      run.id
    );
    agentLog(
      agent,
      `Reviewed ${run.id} (${run.status}); delegated evidence + note to ${watchdog?.name || 'no sub-agent'}.`
    );
    if (watchdog) {
      agentLog(watchdog, `Delegated by ${agent.name}: triage ${run.id} and confirm evidence.`);
      await runWatchdog(watchdog);
    }
    supervised.push(run.id);
  }
  agent.lastRunAt = now();
  persist();
  logActivity('agent', `${agent.name} supervised ${supervised.length} run(s)`, { runIds: supervised });
  return { supervised };
}

async function tickAgent(agent) {
  agent.lastTickAt = now();
  agent.status = agent.enabled ? 'working' : 'paused';
  persist();
  let result;
  try {
    if (agent.kind === 'scheduler') result = await runScheduler(agent);
    else if (agent.kind === 'watchdog') result = await runWatchdog(agent);
    else if (agent.kind === 'supervisor') result = await runSupervisor(agent);
    else if (agent.kind === 'observer') result = await runObserver(agent);
    else if (agent.kind === 'companion') {
      const { scanCompanion } = await import('./companion.js');
      result = await scanCompanion({ system: true });
      agent.learned = Number(result?.summary?.patterns || 0);
      agent.lastRunAt = now();
      agentLog(agent, `Learned ${result?.summary?.apps || 0} app(s), ${result?.summary?.files || 0} file habit(s); ${result?.summary?.proposals || 0} proposal(s) pending.`);
    }
    else if (agent.kind === 'continuity') {
      const { tickContinuity } = await import('./continuity-engine.js');
      result = await tickContinuity();
      const active = result?.active || null;
      const reviewed = result?.review || null;
      agent.reviewed = Number(agent.reviewed || 0) + (reviewed || active ? 1 : 0);
      agent.lastRunAt = now();
      agentLog(
        agent,
        active
          ? `Watching ${active.workflowName || active.runId} · ${active.window?.state || 'window unknown'} · ${active.decision} · ${active.score}%`
          : reviewed
            ? `Reviewed ${reviewed.runId || 'latest run'} · ${reviewed.status} · ${reviewed.score}%`
            : 'No active run or unreviewed failure; continuity idle.'
      );
    }
    else if (agent.kind === 'presentation') {
      const { watchPresentationDecks } = await import('./presentation-watch.js');
      result = await watchPresentationDecks(agent);
    } else result = { skipped: 'unknown agent kind' };
  } finally {
    agent.status = agent.enabled ? 'idle' : 'paused';
    agent.lastResult = result;
    persist();
  }
  return result;
}

export async function tickAll() {
  const d = db();
  const results = {};
  for (const agent of d.agents) {
    if (!agent.enabled) continue;
    const last = agent.lastTickAt ? new Date(agent.lastTickAt).getTime() : 0;
    if (Date.now() - last < Math.max(3000, Number(agent.intervalMs) || 15000)) continue;
    try {
      results[agent.id] = await tickAgent(agent);
    } catch (err) {
      agentLog(agent, `Tick error: ${err.message}`);
    }
  }
  persist();
  return results;
}

export async function tickAgentNow(id) {
  const agent = db().agents.find((a) => a.id === id);
  if (!agent) throw new Error('Agent not found');
  return tickAgent(agent);
}

export function startAgents() {
  if (tickTimer) return;
  // Recover runs orphaned by a previous process.
  const d = db();
  let recovered = 0;
  for (const run of d.runs) {
    if (run.status === 'running' || run.status === 'queued') {
      const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
      run.status = 'failed';
      run.currentStepId = null;
      run.endedAt = now();
      clearPresenceHold(run);
      run.durationMs = started ? Math.max(0, Date.now() - started) : null;
      run.pauseRequested = false;
      run.paused = false;
      run.skipRequested = false;
      run.errorCategory = 'interrupted';
      run.lastErrorCategory = 'interrupted';
      run.lastErrorCode = 'CONSOLE_RESTART';
      run.failureSignature = 'runtime:console restarted';
      for (const step of run.steps || []) {
        if (step.status === 'running') {
          step.status = 'failed';
          step.error = 'Interrupted by a console restart before this step completed.';
          step.endedAt = now();
        } else if (step.status === 'pending') {
          step.status = 'skipped';
        }
      }
      run.log.push({ at: now(), level: 'error', message: 'Interrupted: console restarted before this run finished.' });
      recovered++;
    }
  }
  // Repair older failed runs that a previous process left with a step still "running"
  // and no error metadata, so the UI never shows a failed run with a live-looking step.
  for (const run of d.runs) {
    if (run.status !== 'failed') continue;
    const stuck = (run.steps || []).filter((step) => step.status === 'running');
    if (!stuck.length) continue;
    for (const step of stuck) {
      step.status = 'failed';
      step.error = 'Interrupted by a console restart before this step completed.';
      step.endedAt = step.endedAt || now();
    }
    for (const step of run.steps || []) {
      if (step.status === 'pending') step.status = 'skipped';
    }
    run.currentStepId = null;
    run.pauseRequested = false;
    run.paused = false;
    run.skipRequested = false;
    run.errorCategory = run.errorCategory || 'interrupted';
    run.lastErrorCategory = run.lastErrorCategory || 'interrupted';
    run.lastErrorCode = run.lastErrorCode || 'CONSOLE_RESTART';
    run.failureSignature = run.failureSignature || 'runtime:console restarted';
    run.log.push({ at: now(), level: 'error', message: 'Repaired: a step was left running by an interrupted console process.' });
    recovered++;
  }
  if (recovered) persist();
  tickTimer = setInterval(() => {
    tickAll().catch((err) => console.error('[agents] tick failed:', err.message));
  }, Math.max(3000, Number(d.settings.agentTickMs) || 5000));
  tickTimer.unref?.();
}

export function stopAgents() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

export function queuedCount() {
  return queue.length;
}

/**
 * The file a step actually wrote, read from the run's own records. Every writer
 * stores its output in one variable (`savedTextFile`, `savedFile`, ...) even
 * when the step names none; reading the params alone made a downloaded file
 * look missing because the step names a url and a folder, never the final path.
 */
const OUTPUT_VAR = {
  writeTextFile: 'savedTextFile',
  downloadMedia: 'savedFile',
  saveImage: 'savedImage',
  recordVideo: 'savedVideo',
};

function recordedOutputPath(run, step) {
  const params = step?.params || {};
  const outputVar = String(params.outputVar || OUTPUT_VAR[step?.type] || '').trim();
  const remembered = outputVar ? String(run?.variables?.[outputVar] || '').trim() : '';
  if (remembered) return remembered;
  // Older runs kept the file only in the run's file list or in the step's name.
  const filename = String(params.filename || params.path || '').trim();
  const files = Array.isArray(run?.files) ? run.files : [];
  const recorded = files.find(
    (file) => (filename && file.filename === filename) || (params.url && file.url === params.url)
  );
  return String(recorded?.path || filename).trim();
}

/**
 * Finish the verification a run still owes without touching the desktop: only
 * read-only checks (window/process/file/clipboard) run here, so this is safe
 * while the user is working. Interactive checks stay on `pendingVerification`.
 */
export async function verifyRunSilently(runId) {
  const run = (db().runs || []).find((entry) => entry.id === runId);
  if (!run) return { ok: false, error: 'Run not found.' };
  const entries = [...(run.pendingVerification || [])];
  if (!entries.length) return { ok: true, run, results: [], remaining: 0 };
  const results = [];
  for (const entry of entries) {
    const step = (run.steps || []).find((candidate) => candidate.id === entry.stepId) || {};
    const target = entry.target || String(step.params?.title || step.params?.target || '');
    for (const check of entry.checks || []) {
      let result;
      try {
        result = await silentCheck(check, {
          title: target,
          process: String(step.params?.process || step.params?.target || ''),
          path: recordedOutputPath(run, step),
        });
      } catch (err) {
        result = { ok: false, detail: err.message };
      }
      results.push({ stepId: entry.stepId, check, ok: result.ok, detail: result.detail, at: now() });
      if (result.ok !== null) {
        pushLog(
          run,
          result.ok ? 'info' : 'warn',
          `Silent verification ${result.ok ? 'passed' : 'still open'} for “${entry.stepName}”: ${result.detail}.`,
          entry.stepId
        );
      }
    }
  }
  const stillOpen = entries.filter((entry) =>
    (entry.checks || []).some((check) => {
      const hit = results.filter((result) => result.stepId === entry.stepId && result.check === check).pop();
      return !hit || hit.ok !== true;
    })
  );
  run.pendingVerification = stillOpen;
  run.silentVerification = { at: now(), results };
  if (run.status === 'passed' && !stillOpen.length) run.verificationState = 'complete';
  persist();
  return { ok: true, run, results, remaining: stillOpen.length };
}

export { writeRunNote };
