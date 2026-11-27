import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  ROOT,
  DATA,
  DB_FILE,
  NOTES,
  TOOLS,
  CAPTURES,
  db,
  persist,
  flush,
  uid,
  now,
  slug,
  logActivity,
  recordUsage,
  resolveInside,
  writeFileDurable,
} from './store.js';
import { executeStep, runPowerShell, STEP_TYPES, IS_WINDOWS, describe, findUiElement, findUiElementByOcr, readFocusedElement, readForegroundWindow, readScreenContext } from './automation.js';
import { liveControl, probeLiveBackend } from './platform.js';
import {
  cancelDownload,
  downloadModel,
  installLlamaCpp,
  installOllama,
  localModelStatus,
  startLlamaServer,
  stopLlamaServer,
} from './local-model.js';
import { loopStatus, reviewPendingVerifications, startVerificationLoop, stopVerificationLoop } from './verification-loop.js';
import {
  aiResolveConflicts,
  checkAndSync,
  commitMerge,
  fetchPullRequest,
  gitSyncStatus,
  listPullRequests,
  mergeOrigin,
  pullNow,
  pushNow,
  resolveConflicts,
  startAutoSync,
  stopAutoSync,
  syncOverview,
} from './git-sync.js';
import { backupStatus, checkBackupNow, startBackup, backupTick } from './backup.js';
import { startSupervisor, supervisorStatus } from './supervisor.js';
import { auditLog, egressStatus, fetchFiltered, setPolicy as setEgressPolicy } from './egress.js';
import {
  addSource,
  dismissProposal,
  liveStatus,
  pollSource,
  removeSource,
  startLiveSources,
  subscribe as subscribeLive,
} from './live-sources.js';
import { bridgeStatus, closeBridge, openBridge, streamBridge } from './bridge.js';
import { createEnv, envLogin, envStatus, removeEnv, setEnvPolicy, verifyEnvToken } from './envs.js';
import { exportBundle, importBundle } from './memory-sync.js';
import { addNote, deleteCommand, listCommands, listNotes, runCommand, saveCommand } from './handoff.js';
import {
  addLink,
  approveReview,
  denyReview,
  receiveFromLink,
  relayStatus,
  removeLink,
  reviewOpinion,
  sendToLink,
  updateLink,
} from './connector.js';
import { answerRequest, ask, cancelRequest, listInbox, waitRequest } from './inbox.js';
import { drain, enqueue, pipelineStatus, pipelineSettings, registerHandler, runNow as pipelineRunNow, startPipeline, stopPipeline } from './pipeline.js';
import { createSnapshot, diffSnapshots, restoreSnapshot, snapshotStatus, transferBetween } from './snapshots.js';
import { addSecondOpinion, lensList } from './second-opinion.js';
import { actionLogStatus, applyFix, dismissItem, implementSuggestion, listActionLog, recordAction, triageItem } from './action-log.js';
import { agentActivity, heartbeat, heartbeatDone, sendContinuation, startAgentWatch } from './agent-awareness.js';
import { nudgeStatus, startNudgeWatch } from './nudge.js';
import { benchStatus, pollBench, startBenchWatch, stopBenchWatch, answerBenchPopup, testBenchTarget, addBenchTarget, reviewBenchProposal } from './bench.js';
import { applyReshaped, configureDeepFocus, deepFocusStatus, startDeepFocus, stopDeepFocus } from './deep-focus.js';
import { addAnnotation, annotationsForRun, listAnnotations, pinFindings, removeAnnotation } from './annotations.js';
import { presentationFromDeepFocus, deepFocusMarkdown } from './presentations-deep.js';
import { addFirewallRule, firewallCheck, firewallStatus, firewallTest, removeFirewallRule, resetFirewallRules, setFirewallMode } from './firewall.js';
import { factoringStatus, pinStepIntents, planRefactoring, pushRefactorToBuilder, similarSolutions } from './step-factoring.js';
import { normalizeThinkSettings } from './step-think.js';
import { appendCloseout, closeoutFor, recordCloseout } from './closeout.js';
import { applyAnalysisSteps, configureAutoRepair, normalizeAutoRepair, startAutoRepairMonitor, stopAutoRepairMonitor } from './auto-repair.js';
import { monitorsStatus } from './monitors.js';

/**
 * Apply the deep-focus reshaped steps: keep everything the run passed, replace
 * the failed step and everything after it with the reshaped plan, then re-run
 * from the failed step. The workflow is patched, not duplicated.
 */
async function applyReshapedToRun(runId, reshapedSteps, focus) {
  const run = db().runs.find((entry) => entry.id === runId);
  if (!run) throw new Error('Run not found');
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('Workflow for this run no longer exists');
  const firstFailedIndex = (run.steps || []).findIndex((step) => step.status === 'failed');
  // With no failed step, the goal itself needs review: replace the entire plan.
  const firstUnfinishedIndex = (run.steps || []).findIndex((step) => !['passed', 'skipped'].includes(step.status));
  const keepCount = firstFailedIndex >= 0 ? firstFailedIndex : Math.max(0, firstUnfinishedIndex);
  const kept = (workflow.steps || []).slice(0, keepCount);
  const reshaped = (reshapedSteps || []).map((step, index) => ({
    ...step,
    id: uid('stp'),
    name: String(step.name || `${step.type} ${index + 1}`).slice(0, 80),
  }));
  workflow.steps = [...kept, ...reshaped];
  workflow.updatedAt = now();
  workflow.lastPlanSource = 'deep-focus';
  workflow.lastPlanNote = focus?.reshaped?.conclusion || 'reshaped by deep focus';
  persist();
  logActivity('deep-focus', `Reshaped steps written into “${workflow.name}” (${kept.length} kept + ${reshaped.length} new)`, { runId });
  const retried = await retryRun(runId, { replan: false });
  return { ok: true, status: 'applied', kept: kept.length, added: reshaped.length, message: 'Reshaped steps applied (snapshot gate passed); the run is going again.', run: retried };
}

/**
 * The background monitor's one read: the labels drawn in the window in front.
 * It restores nothing and clicks nothing; the monitor only reorders steps whose
 * own control it could actually see.
 */
async function readMonitorLabels({ run } = {}) {
  // The run's own window, never whatever happens to be in front: reading an
  // unrelated app's labels is how a proof step got moved ahead of its focus.
  const title = String(run?.lastWindow?.title || '').split(' — ')[0].trim();
  if (!title) return [];
  try {
    const read = await findUiElementByOcr({ window: title, labelsOnly: true, timeoutMs: 4000 });
    return Array.isArray(read?.labels) ? read.labels : [];
  } catch {
    return [];
  }
}
import {
  dismissFailure,
  planFailure,
  pushSentinelFix,
  retryFailure,
  runSentinelNow,
  sentinelSettings,
  sentinelStatus,
  startSentinel,
  stopSentinel,
} from './sentinel.js';
import { shareStatus, startShare, stopShare } from './share.js';
import { escalateBacklog, escalateFailedRun, escalationStatus } from './auto-escalation.js';
import { chatWithProjectMemory, getHistory, clearHistory, health, parseJsonLoose, chat, listModels, getMemoryStats, summarizeConversation } from './llm.js';
import { ensureGateway, gatewayStatus, stopGateway } from './gateway.js';
import { estimateTokens } from './context.js';
import { readTextChunk, writeTextChunk, digestForSummary, isTextFile } from './longfiles.js';
import { planSteps, ensureWorkflowSteps, analyzeRun, writeRunNote, addSuggestion, normalizeStep, lintWorkflow } from './planner.js';
import { planStepChange } from './step-plan.js';
import { normalizeScreenReviewSettings } from './screen-review.js';
import { listProposals, findProposal, proposalView, createProposal, approveProposal, rejectProposal, createProposalForRun, shadowTestProposal } from './proposals.js';
import { JUDGE_MODES, judgementSummary, resolveJudgementReview } from './judgement.js';
import { visualTesterStatus, testScreenshot, rememberVisualTest } from './visual-tester.js';
import { stepMarks, normalizeMarks } from './research.js';
import { resumeRecoveryPlan, carryForwardPassedEffects } from './step-effects.js';
import { retryReplaysFailure } from './replan.js';
import { listPresentations, getPresentation, findRelatedPresentations, generatePresentation, auditPresentation, reapplyPresentation, proposalFromPresentation, reviewPresentation, setPresentationControl, compactPresentations, exportPresentation } from './presentations.js';
import { presentationGraph } from './presentation-index.js';
import { ensurePresentationAgent, watchPresentationDecks } from './presentation-watch.js';
import { getRetryBudget, setRetryBudget } from './retry-budget.js';
import { prepareRecovery, finalizeRecoveryPack, applyRecoveryPack, listRecoveryPacks, findRecoveryPack, reconcileStuckRecoveryPacks, reconcileStuckReplans, recoveryTelemetrySummary, listRecoveryTelemetry } from './run-recovery.js';
import { activePresenter, listPositionMemory, presenterUserInput } from './foreground-presenter.js';
import { latestMonitorSuggestions, monitorState, startLiveMonitor, stopLiveMonitor } from './live-monitor.js';
import { observerState } from './app-observer.js';
import { livePreview } from './live-preview.js';
import { liveMap } from './live-map.js';
import { findSimulation, listSimulations, simulationSummary, startSimulation } from './screenshot-sim.js';
import { buildTestReview, SORTS as TEST_REVIEW_SORTS } from './test-review.js';
import { replicateRun } from './alt-env.js';
import { prepareObservationReview } from './observation-review.js';
import {
  companionState,
  scanCompanion,
  learnRun as learnCompanionRun,
  companionProposalAction,
  companionQuickHelp,
  companionDismissQuickHelp,
  markCompanionNotification,
  clearCompanionNotifications,
  addCompanionNote,
  companionNotes,
  markCompanionContinuation,
} from './companion.js';
import {
  continuityState,
  continuityCounts,
  reviewRunContinuity,
  tickContinuity,
  prepareSuggestedWorkflow,
  dismissSuggestion,
  aiReviewContinuity,
  markContinuityContinuation,
} from './continuity-engine.js';
import { listExamples, findExample } from './examples.js';
import { PYTHON_FILES } from './pythonTemplates.js';
import { AUTOMATION_PYTHON_FILES } from './pythonKnack.js';

const ALL_PYTHON_FILES = [...PYTHON_FILES, ...AUTOMATION_PYTHON_FILES];
import { knackSchema, knackCsv, knackMarkdown, knackRecords, knackRecordsCsvs } from './knack.js';
import {
  listMissions,
  findMission,
  createMission,
  startMission,
  pauseMission,
  resumeMission,
  cancelMission,
  checkMissionNow,
  replanMissionNow,
  retryMission,
  missionSummary,
  recoverMissions,
  operatorCommand,
  missionPresentation,
  decideMission,
  autoDecideMission,
  controlMission,
  sendMissionNote,
} from './missions.js';
import {
  listShortcuts,
  decideShortcut,
  setShortcutHabit,
  removeShortcutBlock,
  getShortcutHabit,
  recordShortcutReplayOutcome,
} from './shortcuts.js';
import { adminStatus, loginAdmin, logoutAdmin, changeAdminPassword } from './auth.js';
import {
  ambientState,
  ambientSettings,
  createRule as createAmbientRule,
  updateRule as updateAmbientRule,
  deleteRule as deleteAmbientRule,
  runRuleNow,
  createSchedule as createAmbientSchedule,
  updateSchedule as updateAmbientSchedule,
  deleteSchedule as deleteAmbientSchedule,
  learnAmbient,
  proposalAction as ambientProposalAction,
  tickAmbient,
  startAmbient,
  stopAmbient,
  detectRefreshRate,
  markAmbientNotification,
  clearAmbientNotifications,
  addAmbientNote,
  ambientPreset,
  compactAmbient,
} from './ambient.js';
import { rememberRun, forgetWorkflowMemory, summarizeWorkflowMemory, backfillWorkflowMemory, listWorkflowMemory } from './workflow-memory.js';
import {
  createRun,
  findRun,
  summary,
  cancelRun,
  controlRun,
  retryRun,
  startAgents,
  stopAgents,
  tickAgentNow,
  activeRunCount,
  queuedCount,
  workflowStats,
  writeRunNote as writeNoteForRun,
  setRunFinishedHook,
  verifyRunSilently,
  recheckRun,
  recoverInterruptedRuns,
} from './engine.js';
import { normalizeRecheckSettings } from './pending-recheck.js';

import {
  approveJob,
  jobDecision,
  listJobs as listLinkJobs,
  markJob as markLinkJob,
  queueJob as queueLinkJob,
  readJob as readLinkJob,
  runnerSourceId,
  runnerToken,
  verifyRunnerToken,
} from './runner-jobs.js';
import {
  addSetupCommand,
  findSetupCommand,
  listSetupCommands,
  removeSetupCommand,
  runSetupCommand,
  setupSummary,
} from './setup-commands.js';

const PORT = Number(process.env.PORT) || 4317;
// The desktop-control API stays loopback-only by default, especially on Windows.
// This explicit Linux-only flag is for isolated sandbox previews, not remote control.
const HOST = process.platform !== 'win32' && process.argv.includes('--sandbox-preview') ? '0.0.0.0' : '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const PYTHON = path.join(DATA, 'python');
fs.mkdirSync(PYTHON, { recursive: true });
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function fail(res, code, message, detail = null) {
  if (code >= 400) {
    // Every server-side error feeds the action log, so a recurring one is
    // reported into the synced must-check folder for the fixer to read. The
    // request's method and URL ride along so the source is obvious.
    try {
      recordAction({ kind: 'server', action: 'http-error', error: message, detail: { code, ...(res?.requestInfo || {}), ...detail } });
    } catch { /* logging must never break the response */ }
  }
  sendJson(res, code, { ok: false, error: message });
}

function requireAdmin(req, res, action) {
  if (adminStatus(req).authenticated) return true;
  fail(res, 401, `Sign in as admin to ${action}`);
  return false;
}

/**
 * Live control is available on Windows, macOS, Linux and Android over adb.
 * Only a target with no backend at all (adb requested without a device, or an
 * unsupported host platform) is refused, and the message says why.
 */
function liveRefusal() {
  const control = liveControl();
  return control.reason || `Live control is unavailable on this console (${control.backend}).`;
}

function forwardRunToControlCenter(run, { auto = false } = {}) {
  if (!run || !['failed', 'needs_review'].includes(run.status)) {
    throw new Error('Only failed or needs-review runs can be forwarded.');
  }
  if (run.forwardedMissionId && findMission(run.forwardedMissionId)) return findMission(run.forwardedMissionId);
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) throw new Error('The run workflow no longer exists.');
  const failed = (run.steps || []).find((step) => step.status === 'failed');
  const evidence = (run.evidence || [])
    .filter((item) => item.path)
    .slice(-6)
    .map((item) => `${item.kind}: ${item.caption || 'evidence'} -> ${item.path}`);
  const context = [
    `Forwarded ${auto ? 'automatically' : 'by the operator'} from failed run ${run.id} (${run.workflowName}).`,
    `Mode: ${run.dryRun ? 'simulated' : 'live'}; status: ${run.status}; category: ${run.errorCategory || 'unknown'}; code: ${run.lastErrorCode || 'unknown'}.`,
    failed ? `Failed step: ${failed.name} (${failed.type}).` : 'No failed step was recorded.',
    failed?.error ? `Error: ${String(failed.error).slice(0, 900)}` : '',
    failed?.output ? `Last output: ${String(failed.output).slice(0, 600)}` : '',
    evidence.length ? `Evidence:\n${evidence.join('\n')}` : '',
    'Review the whole workflow rather than just retrying. Never substitute Notepad or another app for the app the goal names. Prefer mediaHold/verifyPlayback for media, avoid fixed holds when actual duration is available, add foreground/waitFor guards, and add a second independent method when clicks, shortcuts or window titles may vary with program settings.',
    'Use key/clipboard shortcuts such as ctrl+a, ctrl+c and ctrl+v rather than typing shortcut words; use aiExtract to pull the requested response out of a long copied document.',
    'You may add several steps, commands or approved tools. Test the repair, then keep the workflow updated.',
  ]
    .filter(Boolean)
    .join('\n');
  const mission = createMission({
    workflowId: workflow.id,
    goal: `Diagnose and repair failed run ${run.id}: ${workflow.name}`,
    context,
    mode: run.dryRun ? 'dry' : 'live',
    trigger: auto ? 'failure' : 'manual',
    conditions: {
      maxAttempts: 1,
      requireVerification: true,
      autoReplan: true,
      autoApplyReplan: true,
      useLearnedPatterns: true,
      vision: true,
    },
  });
  run.forwardedMissionId = mission.id;
  run.forwardedAt = now();
  persist();
  logActivity('run', `Forwarded ${run.id} to Control Center as ${mission.id}`, { runId: run.id, missionId: mission.id });
  return mission;
}

function triggerElementLink(link, { el = null } = {}) {
  const workflow = db().workflows.find((entry) => entry.id === link.workflowId);
  if (!workflow) throw new Error('The linked workflow no longer exists.');
  if (!workflow.steps?.length) throw new Error('The linked workflow has no steps.');
  const dryRun = Boolean(db().settings.dryRun);
  const match = el || { name: link.name, controlType: link.controlType, title: link.window, x: null, y: null };
  const context = [
    `Element link “${link.name}” detected in ${match.title || link.window}.`,
    `Matched: ${match.name || link.name}${match.controlType ? ` (${match.controlType})` : ''}${match.x != null ? ` at ${match.x},${match.y}` : ''}.`,
    `Linked workflow: ${workflow.name}. Action: ${link.action === 'mission' ? 'supervised mission' : 'workflow run'}; mode: ${dryRun ? 'simulated' : 'live'}.`,
    link.goal ? `Goal: ${link.goal}` : '',
    'Think about the current screen before acting. If the linked steps are unfamiliar or do not trigger, inspect the UI tree, try an independent method, and add the steps needed to finish the goal.',
  ]
    .filter(Boolean)
    .join('\n');
  let result;
  if (link.action === 'run') {
    const run = createRun(workflow, { trigger: 'element', dryRun });
    result = { kind: 'run', runId: run.id };
  } else {
    const mission = createMission({
      workflowId: workflow.id,
      goal: link.goal || `React to “${link.name}” in ${link.window}: ${workflow.name}`,
      context,
      mode: dryRun ? 'dry' : 'live',
      trigger: 'element',
      conditions: {
        maxAttempts: 1,
        requireVerification: true,
        autoReplan: true,
        autoApplyReplan: true,
        useLearnedPatterns: true,
        vision: true,
      },
    });
    startMission(mission.id);
    result = { kind: 'mission', missionId: mission.id };
  }
  link.lastTriggeredAt = now();
  link.triggerCount = Number(link.triggerCount || 0) + 1;
  link.lastMatch = { name: match.name, controlType: match.controlType || '', title: match.title || link.window, x: match.x ?? null, y: match.y ?? null };
  persist();
  logActivity('element', `Element link “${link.name}” triggered ${result.kind}`, { linkId: link.id, ...result });
  return result;
}

const elementPresence = new Map();
let elementScanBusy = false;

async function scanElementLinks() {
  if (!IS_WINDOWS || elementScanBusy) return;
  const links = (db().elementLinks || []).filter((link) => link.enabled !== false && link.mode === 'auto');
  if (!links.length) return;
  if (db().runs.some((run) => ['queued', 'running'].includes(run.status))) return;
  elementScanBusy = true;
  try {
    for (const link of links.slice(0, 8)) {
      let match = { found: false };
      try {
        match = await findUiElement({ window: link.window, name: link.name, controlType: link.controlType });
      } catch {}
      const wasPresent = elementPresence.get(link.id) === true;
      elementPresence.set(link.id, match.found);
      link.present = match.found;
      if (!match.found) continue;
      link.lastSeenAt = now();
      if (wasPresent) continue;
      const cooldown = Math.max(5000, Math.min(3600000, Number(link.cooldownMs) || 60000));
      if (link.lastTriggeredAt && Date.now() - Date.parse(link.lastTriggeredAt) < cooldown) continue;
      try {
        triggerElementLink(link, { el: match });
      } catch (err) {
        logActivity('element', `Element link “${link.name}” could not trigger: ${err.message}`, { linkId: link.id });
      }
    }
  } finally {
    elementScanBusy = false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function workflowView(w) {
  const runs = db().runs.filter((r) => r.workflowId === w.id && !r.shadow).slice(0, 6).map(summary);
  const steps = (w.steps || []).map((step) => {
    if (step.type !== 'focusWindow' || step.params?.title) return step;
    const title = step.params?.windowName || step.params?.windowTitle;
    return title ? { ...step, params: { ...step.params, title } } : step;
  });
  return { ...w, steps, runHistory: runs, stats: workflowStats(w) };
}

function buildState() {
  reconcileStuckReplans({ live: replanning });
  const d = db();
  const proposalState = listProposals({ limit: 20 });
  const continuity = continuityState();
  const continuitySummary = continuityCounts(continuity);
  return {
    ok: true,
    rev: d.rev,
    settings: d.settings,
    platform: {
      windows: IS_WINDOWS,
      shell: IS_WINDOWS ? 'PowerShell' : 'none',
      platform: process.platform,
      pid: process.pid,
      ...liveControl(),
    },
    localModel: localModelStatus(),
    workflows: d.workflows.map(workflowView),    runnerJobs: listLinkJobs(6),
    setupCommands: listSetupCommands(),

    runs: d.runs.slice(0, 80).map(summary),
    verificationLoop: loopStatus(),
    gitSync: gitSyncStatus(),
    backup: backupStatus(),
    supervisor: supervisorStatus(),
    egress: egressStatus(),
    live: liveStatus(),
    bridge: bridgeStatus(),
    envs: envStatus(),
    sentinel: sentinelStatus(),
    relay: relayStatus(),
    inbox: { open: listInbox({ status: 'open', limit: 12 }), lenses: lensList() },
    pipeline: pipelineStatus(),
    snapshots: snapshotStatus(),
    actionLog: actionLogStatus(),
    agentsWorking: agentActivity(),
    firewall: firewallStatus(),
    factoring: factoringStatus(),
    nudges: nudgeStatus(),
    bench: benchStatus(),
    share: shareStatus(),
    escalation: escalationStatus(),
    notes: d.notes.slice(0, 60).map(({ body, ...rest }) => ({
      ...rest,
      preview: body.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 180),
    })),
    suggestions: d.suggestions.filter((s) => !s.dismissed).slice(0, 20),
    proposals: proposalState.proposals,
    proposalStats: { count: proposalState.count, pending: proposalState.pending },
    visualTester: visualTesterStatus(),
    judgement: judgementSummary(d.settings),
    agents: d.agents,
    recoveryPacks: listRecoveryPacks(20),
    recoveryTelemetry: recoveryTelemetrySummary(),
    presenter: activePresenter(),
    live: monitorState(),
    observer: observerState(),
    handoff: { notes: listNotes({ limit: 12 }), commands: listCommands().slice(0, 12) },
    liveSuggestions: latestMonitorSuggestions(),
    positionMemory: listPositionMemory(8),
    companion: companionState(),
    ambient: ambientState(),
    continuity,
    tools: d.tools,
    knack: knackSchema(),
    captures: (d.captures || []).slice(0, 60),
    workflowMemory: summarizeWorkflowMemory(),
    activity: d.activity.slice(0, 60),
    usage: d.usage.slice(0, 60),
    counts: {
      activeRuns: activeRunCount(),
      queued: queuedCount(),
      suggestions: d.suggestions.filter((s) => !s.dismissed).length,
      pendingProposals: proposalState.pending,
      failures: d.runs.filter((r) => r.status === 'failed' && !r.review?.at).length,
      examples: listExamples().length,
      pythonFiles: fs.existsSync(PYTHON) ? fs.readdirSync(PYTHON).filter((f) => f.endsWith('.py')).length : 0,
      missionsActive: d.missions.filter((m) => ['queued', 'planning', 'running', 'verifying', 'reviewing', 'replanning'].includes(m.status)).length,
      missionsTotal: d.missions.length,
      patterns: d.patterns.length,
      retriedRuns: d.runs.filter((r) => Number(r.retryCount || 0) > 0).length,
      recoveredRuns: d.runs.filter((r) => r.recovered).length,
      recoveryPacks: (d.recoveryPacks || []).filter((pack) => ['planning', 'ready', 'retrying'].includes(pack.status)).length,
      presenterActive: (d.runs || []).some((run) => ['running', 'queued'].includes(run.status) && run.presenter),
      patternTaggedWorkflows: d.workflows.filter((w) => (w.patternTags || []).length).length,
      companionProposals: d.companion?.proposals?.filter((proposal) => proposal.status === 'pending').length || 0,
      companionUnread: d.companion?.notifications?.filter((notification) => !notification.read).length || 0,
      companionActive: d.companion?.continuations?.filter((entry) => ['needs_attention', 'retrying'].includes(entry.status)).length || 0,
      continuitySuggestions: continuitySummary.continuitySuggestions,
      continuityReady: continuitySummary.continuityReady,
      ambientRules: (d.ambient?.rules || []).filter((rule) => rule.enabled).length,
      ambientUnread: (d.ambient?.notifications || []).filter((notification) => !notification.read).length,
    },
    missions: listMissions(),
    presentations: listPresentations(),
    elementLinks: d.elementLinks || [],
    patterns: d.patterns,
    stepTypes: STEP_TYPES,
    aiHistoryLength: getHistory().length,
  };
}

function listFiles(dir, prefix = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.join(prefix, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      out.push(...listFiles(full, rel));
    } else {
      const stat = fs.statSync(full);
      out.push({
        path: rel,
        name: entry.name,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ext: path.extname(entry.name).toLowerCase(),
      });
    }
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function updateWorkflow(id, patch) {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) throw new Error('Workflow not found');
  Object.assign(wf, patch);
  wf.updatedAt = now();
  persist();
  return wf;
}

function validateStepInput(body, existing = {}) {
  const type = body.type || existing.type;
  if (!STEP_TYPES.some((s) => s.type === type)) throw new Error(`Unknown step type: ${type}`);
  const params = body.params && typeof body.params === 'object' ? { ...body.params } : { ...(existing.params || {}) };
  return {
    id: existing.id || uid('stp'),
    type,
    name: String(body.name ?? existing.name ?? `New ${type} step`).slice(0, 90) || 'Step',
    params,
    timeoutMs: Math.max(1000, Math.min(120000, Number(body.timeoutMs ?? existing.timeoutMs ?? 15000) || 15000)),
    optional: Boolean(body.optional ?? existing.optional ?? false),
    condition: String('condition' in body ? body.condition ?? '' : existing.condition ?? '').trim().slice(0, 80) || null,
  };
}

function captureRecord(shot, caption, meta = {}) {
  const d = db();
  const record = {
    id: uid('cap'),
    caption,
    path: shot.path,
    simulated: Boolean(shot.simulated),
    width: shot.width || null,
    height: shot.height || null,
    createdAt: now(),
    ...meta,
  };
  d.captures.unshift(record);
  d.captures = d.captures.slice(0, 80);
  persist();
  return record;
}

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

/* ---------------- State & health ---------------- */
route('GET', /^\/api\/state$/, async (req, res) => sendJson(res, 200, buildState()));
// Auto-sync of this source to GitHub, and the shareable test link.
route('GET', /^\/api\/git-sync$/, async (req, res) => {
  sendJson(res, 200, { ok: true, gitSync: gitSyncStatus() });
});

route('POST', /^\/api\/git-sync\/now$/, async (req, res) => {
  const status = await checkAndSync({ force: true });
  sendJson(res, 200, { ok: status.status !== 'error' && status.status !== 'push-failed', gitSync: status });
});

// The local copy of this repository: the mirror folder and the 10-second link test.
route('GET', /^\/api\/backup$/, async (req, res) => {
  sendJson(res, 200, { ok: true, backup: backupStatus() });
});

route('POST', /^\/api\/backup\/check$/, async (req, res) => {
  const backup = await checkBackupNow();
  sendJson(res, 200, {
    ok: backup.consecutiveFailures === 0 && !backup.held,
    backup,
    message: backup.lastError || (backup.inSync ? 'Local copy matches GitHub.' : 'Checked; see the details.'),
  });
});

route('POST', /^\/api\/backup\/sync$/, async (req, res) => {
  const backup = await backupTick({ force: true });
  sendJson(res, 200, {
    ok: !backup.lastError,
    backup,
    message: backup.lastError || (backup.inSync ? 'Local copy matches GitHub.' : 'Sync pass finished.'),
  });
});

/* ---------------- The standalone test bench ---------------- */
route('GET', /^\/api\/bench$/, async (req, res) => {
  sendJson(res, 200, { ok: true, bench: await pollBench() });
});

route('POST', /^\/api\/bench\/poll$/, async (req, res) => {
  sendJson(res, 200, { ok: true, bench: await pollBench() });
});

route('POST', /^\/api\/bench\/popup\/([\w-]+)\/answer$/, async (req, res, match) => {
  const body = await readBody(req);
  if (!body?.decision) return sendJson(res, 400, { ok: false, error: 'A decision is required (ok, later, or a choice id).' });
  const result = await answerBenchPopup(match[1], String(body.decision).slice(0, 40));
  sendJson(res, 200, {
    ok: result.ok,
    bench: benchStatus(),
    message: result.ok ? 'Answered on the bench.' : result.error || 'The bench did not take the answer.',
  });
});

route('POST', /^\/api\/bench\/test\/([\w-]+)$/, async (req, res, match) => {
  const result = await testBenchTarget(match[1]);
  sendJson(res, 200, {
    ok: result.ok,
    bench: benchStatus(),
    message: result.ok ? 'The bench finished the run.' : result.error || 'The bench could not run that target.',
  });
});

route('POST', /^\/api\/bench\/review\/([\w-]+)\/verdict$/, async (req, res, match) => {
  const body = await readBody(req);
  if (!body?.decision || !['approve', 'deny'].includes(body.decision)) {
    return sendJson(res, 400, { ok: false, error: 'A decision of approve or deny is required.' });
  }
  const result = await reviewBenchProposal(match[1], String(body.decision), { reasons: body.reasons || [], by: 'operator' });
  sendJson(res, 200, {
    ok: result.ok,
    bench: benchStatus(),
    message: result.ok ? `The proposal was ${body.decision}d on the bench.` : result.body?.error || 'The bench refused the verdict.',
  });
});

route('POST', /^\/api\/bench\/targets$/, async (req, res) => {
  const body = await readBody(req);
  if (!body?.path) return sendJson(res, 400, { ok: false, error: 'A repository path is required.' });
  const result = await addBenchTarget(body);
  sendJson(res, 200, {
    ok: result.ok,
    bench: benchStatus(),
    message: result.ok ? 'The bench is watching that repository.' : result.body?.error || 'The bench refused the target.',
  });
});

/* ---------------- Watching the console itself ---------------- */
route('GET', /^\/api\/supervisor$/, async (req, res) => {
  sendJson(res, 200, { ok: true, supervisor: supervisorStatus() });
});

/* ---------------- Filtered egress ---------------- */
route('GET', /^\/api\/egress$/, async (req, res) => {
  sendJson(res, 200, { ok: true, egress: egressStatus(), audit: auditLog(30) });
});

route('PATCH', /^\/api\/egress$/, async (req, res) => {
  const body = await readBody(req);
  sendJson(res, 200, { ok: true, egress: setEgressPolicy(body || {}) });
});

// One fetch through the rules, for an agent asking for a specific thing.
route('POST', /^\/api\/egress\/fetch$/, async (req, res) => {
  const body = await readBody(req);
  if (!body?.url) return sendJson(res, 400, { ok: false, error: 'A url is required.' });
  const out = await fetchFiltered(body.url, {
    headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
    maxBytes: body.maxBytes,
  });
  sendJson(res, 200, {
    ok: out.ok,
    why: out.why || '',
    result: out.ok
      ? { status: out.status, contentType: out.contentType, bytes: out.bytes, url: out.url, text: String(out.text || '').slice(0, 20000) }
      : { status: out.status || 0 },
  });
});

/* ---------------- Live sources ---------------- */
route('GET', /^\/api\/live$/, async (req, res) => {
  sendJson(res, 200, { ok: true, live: liveStatus() });
});

route('POST', /^\/api\/live\/sources$/, async (req, res) => {
  const body = await readBody(req);
  const made = addSource(body || {});
  sendJson(res, made.ok ? 200 : 400, made.ok ? { ok: true, source: made.source, live: liveStatus() } : { ok: false, error: made.why });
});

route('DELETE', /^\/api\/live\/sources\/([^/]+)$/, async (req, res, [id]) => {
  const out = removeSource(id);
  sendJson(res, 200, { ok: out.ok, live: liveStatus() });
});

route('POST', /^\/api\/live\/poll$/, async (req, res) => {
  const body = await readBody(req);
  if (!body?.id) return sendJson(res, 400, { ok: false, error: 'A source id is required.' });
  const out = await pollSource(body.id);
  sendJson(res, 200, { ok: out.ok, ...out, live: liveStatus() });
});

route('POST', /^\/api\/live\/proposals\/([^/]+)\/dismiss$/, async (req, res, [id]) => {
  const out = dismissProposal(id);
  sendJson(res, out.ok ? 200 : 404, { ok: out.ok, ...out, live: liveStatus() });
});

// Change notifications as they happen. No buffering, no replay: a reader takes
// the feed from the moment it connects and re-reads /api/live for the rest.
route('GET', /^\/api\/live\/stream$/, async (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const off = subscribeLive((event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      off();
    }
  });
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    off();
  });
});

/* ---------------- Stream bridge ---------------- */
route('GET', /^\/api\/bridge$/, async (req, res) => {
  sendJson(res, 200, { ok: true, bridge: bridgeStatus() });
});

route('POST', /^\/api\/bridge$/, async (req, res) => {
  const body = await readBody(req);
  if (!body?.path) return sendJson(res, 400, { ok: false, error: 'A path inside the project is required.' });
  const target = path.resolve(ROOT, String(body.path));
  if (target !== ROOT && !target.startsWith(`${ROOT}${path.sep}`)) {
    return sendJson(res, 400, { ok: false, error: 'Bridges serve files inside this project folder.' });
  }
  const out = openBridge({
    filePath: target,
    name: body.name,
    contentType: body.contentType,
    ttlMs: body.ttlMs,
    capBytesPerSec: body.capBytesPerSec,
  });
  sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true, ...out } : { ok: false, error: out.why });
});

route('POST', /^\/api\/bridge\/([^/]+)\/close$/, async (req, res, [id]) => {
  const out = closeBridge(id);
  sendJson(res, out.ok ? 200 : 404, { ok: out.ok, ...out, bridge: bridgeStatus() });
});

route('GET', /^\/api\/bridge\/pull\/([^/]+)$/, async (req, res, [id]) => {
  const token = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
  streamBridge(id, token, req, res);
});

/* ---------------- Environments per destination ---------------- */
route('GET', /^\/api\/envs$/, async (req, res) => {
  sendJson(res, 200, { ok: true, envs: envStatus() });
});

route('POST', /^\/api\/envs$/, async (req, res) => {
  const body = await readBody(req);
  const out = createEnv(body || {});
  sendJson(res, out.ok ? 200 : 400, out.ok ? { ok: true, env: out.env, envs: envStatus() } : { ok: false, error: out.why });
});

route('PATCH', /^\/api\/envs\/([^/]+)$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const out = setEnvPolicy(id, body || {});
  sendJson(res, out.ok ? 200 : 404, out.ok ? { ok: true, env: out.env } : { ok: false, error: out.why });
});

route('POST', /^\/api\/envs\/([^/]+)\/login$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const out = envLogin(id, body || {});
  // The token is shown once, here, to the operator who asked for it.
  sendJson(res, out.ok ? 200 : 404, out.ok ? { ok: true, token: out.token, env: out.env } : { ok: false, error: out.why });
});

route('POST', /^\/api\/envs\/([^/]+)\/verify$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const out = verifyEnvToken(id, body?.token);
  sendJson(res, out.ok ? 200 : 403, { ok: out.ok, env: out.env, error: out.why });
});

route('DELETE', /^\/api\/envs\/([^/]+)$/, async (req, res, [id]) => {
  const out = removeEnv(id);
  sendJson(res, out.ok ? 200 : 404, { ok: out.ok, ...out, envs: envStatus() });
});

/* ---------------- Goals and missions between instances ---------------- */
route('GET', /^\/api\/memory\/bundle$/, async (req, res) => {
  sendJson(res, 200, { ok: true, bundle: exportBundle() });
});

route('POST', /^\/api\/memory\/merge$/, async (req, res) => {
  const body = await readBody(req);
  const out = importBundle(body?.bundle || body);
  sendJson(res, out.ok ? 200 : 400, out);
});

/* ---------------- Sync page: pull, push, merge, PRs, conflicts ---------------- */
route('GET', /^\/api\/git$/, async (req, res) => {
  try {
    sendJson(res, 200, await syncOverview());
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/git\/pull$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await pullNow({ ffOnly: body.ffOnly !== false }));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/git\/push$/, async (req, res) => {
  try {
    sendJson(res, 200, await pushNow());
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/git\/merge$/, async (req, res) => {
  try {
    sendJson(res, 200, await mergeOrigin());
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/git\/prs$/, async (req, res) => {
  try {
    sendJson(res, 200, await listPullRequests({ limit: 12 }));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/git\/prs\/fetch$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await fetchPullRequest(body.number));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/git\/conflicts\/resolve$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await resolveConflicts({ side: body.side, files: Array.isArray(body.files) ? body.files : null }));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/git\/conflicts\/ai$/, async (req, res) => {
  try {
    sendJson(res, 200, await aiResolveConflicts());
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/git\/conflicts\/commit$/, async (req, res) => {
  try {
    sendJson(res, 200, await commitMerge());
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Sentinel: watch, auto-test, repair queue ---------------- */
route('GET', /^\/api\/sentinel$/, async (req, res) => {
  sendJson(res, 200, { ok: true, sentinel: sentinelStatus(), settings: sentinelSettings() });
});

route('POST', /^\/api\/sentinel\/run-now$/, async (req, res) => {
  try {
    sendJson(res, 200, { ok: true, sentinel: await runSentinelNow() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/sentinel\/settings$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const settings = sentinelSettings();
    if (body.enabled !== undefined) settings.enabled = body.enabled === true;
    if (body.autoPlan !== undefined) settings.autoPlan = body.autoPlan === true;
    if (body.showWindow !== undefined) settings.showWindow = body.showWindow === true;
    if (body.worktree !== undefined) settings.worktree = body.worktree === true;
    if (Number(body.cooldownMs)) settings.cooldownMs = Math.max(5000, Number(body.cooldownMs));
    if (typeof body.testCommand === 'string' && body.testCommand.trim()) settings.testCommand = body.testCommand.trim().slice(0, 300);
    persist();
    // Enabling the watcher from the UI should attach it without a restart.
    if (settings.enabled) startSentinel();
    else stopSentinel();
    sendJson(res, 200, { ok: true, sentinel: sentinelStatus() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/sentinel\/failures\/([^/]+)\/plan$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, failure: await planFailure(id) });
  } catch (err) {
    fail(res, err.message === 'Failure not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/sentinel\/failures\/([^/]+)\/dismiss$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, failure: dismissFailure(id) });
  } catch (err) {
    fail(res, err.message === 'Failure not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/sentinel\/failures\/([^/]+)\/retry$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, sentinel: await retryFailure(id) });
  } catch (err) {
    fail(res, err.message === 'Failure not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/sentinel\/push-fix$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await pushSentinelFix({ message: String(body.message || '').slice(0, 200) }));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

/* ---------------- Relay: links to other apps' repositories ---------------- */
route('GET', /^\/api\/relay$/, async (req, res) => {
  sendJson(res, 200, { ok: true, relay: relayStatus() });
});

route('POST', /^\/api\/relay\/links$/, async (req, res) => {
  if (!requireAdmin(req, res, 'manage repository links')) return;
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, link: addLink(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/relay\/links\/([^/]+)$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'manage repository links')) return;
  try {
    sendJson(res, 200, { ok: true, link: removeLink(id) });
  } catch (err) {
    fail(res, err.message === 'Link not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/relay\/links\/([^/]+)\/settings$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'change repository link permissions')) return;
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, link: updateLink(id, body) });
  } catch (err) {
    fail(res, err.message === 'Link not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/relay\/links\/([^/]+)\/send$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'send repository changes')) return;
  try {
    const body = await readBody(req);
    sendJson(res, 200, await sendToLink(id, body));
  } catch (err) {
    fail(res, err.message === 'Link not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/relay\/links\/([^/]+)\/receive$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'receive repository changes')) return;
  try {
    sendJson(res, 200, await receiveFromLink(id));
  } catch (err) {
    fail(res, err.message === 'Link not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/relay\/reviews\/([^/]+)\/approve$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'approve repository changes')) return;
  try {
    sendJson(res, 200, await approveReview(id));
  } catch (err) {
    fail(res, err.message === 'Review not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/relay\/reviews\/([^/]+)\/deny$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'resolve repository reviews')) return;
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, review: denyReview(id, body) });
  } catch (err) {
    fail(res, err.message === 'Review not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/relay\/reviews\/([^/]+)\/opinion$/, async (req, res, [id]) => {
  if (!requireAdmin(req, res, 'request a repository review')) return;
  try {
    sendJson(res, 200, { ok: true, review: await reviewOpinion(id) });
  } catch (err) {
    fail(res, err.message === 'Review not found' ? 404 : 500, err.message);
  }
});

/* ---------------- Inbox: questions from any connected agent ---------------- */
route('GET', /^\/api\/inbox$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, requests: listInbox({ status: url.searchParams.get('status') || 'open', limit: 40 }) });
});

route('POST', /^\/api\/inbox$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, request: ask(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/inbox\/([^/]+)\/wait$/, async (req, res, [id], url) => {
  sendJson(res, 200, await waitRequest(id, { timeoutMs: url.searchParams.get('timeoutMs') }));
});

route('POST', /^\/api\/inbox\/([^/]+)\/answer$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, request: answerRequest(id, body) });
  } catch (err) {
    fail(res, err.message === 'Request not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/inbox\/([^/]+)\/cancel$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, request: cancelRequest(id) });
  } catch (err) {
    fail(res, err.message === 'Request not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Pipeline: parallel workers over one queue ---------------- */
route('GET', /^\/api\/pipeline$/, async (req, res) => {
  sendJson(res, 200, { ok: true, pipeline: pipelineStatus(), settings: pipelineSettings() });
});

route('POST', /^\/api\/pipeline\/enqueue$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, job: enqueue(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/pipeline\/run-now$/, async (req, res) => {
  pipelineRunNow();
  sendJson(res, 200, { ok: true, pipeline: pipelineStatus() });
});

route('POST', /^\/api\/pipeline\/settings$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const settings = pipelineSettings();
    if (Number(body.workers)) settings.workers = Math.max(1, Math.min(8, Math.round(Number(body.workers))));
    persist();
    sendJson(res, 200, { ok: true, pipeline: pipelineStatus() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Snapshots: version copies, diff, transfer, restore ------- */
route('GET', /^\/api\/snapshots$/, async (req, res) => {
  sendJson(res, 200, { ok: true, snapshots: snapshotStatus() });
});

route('POST', /^\/api\/snapshots$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await createSnapshot(body.label));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/snapshots\/diff$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await diffSnapshots(body.a, body.b, { stat: body.stat === true }));
  } catch (err) {
    fail(res, err.message === 'Snapshot not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/snapshots\/transfer$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await transferBetween(body.a, body.b));
  } catch (err) {
    fail(res, err.message === 'Snapshot not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/snapshots\/([^/]+)\/restore$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, await restoreSnapshot(id));
  } catch (err) {
    fail(res, err.message === 'Snapshot not found' ? 404 : 500, err.message);
  }
});

/* ---------------- Second opinions: multi-lens review passes ---------------- */
route('GET', /^\/api\/opinions\/lenses$/, async (req, res) => {
  sendJson(res, 200, { ok: true, lenses: lensList() });
});

route('POST', /^\/api\/opinions\/([^/]+)\/([^/]+)$/, async (req, res, [kind, refId]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await addSecondOpinion(kind, refId, body.lens));
  } catch (err) {
    fail(res, err.message === 'Failure not found' || err.message === 'Review not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/sentinel\/failures\/([^/]+)\/opinion$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, await addSecondOpinion('sentinel-failure', id, body.lens || 'skeptic'));
  } catch (err) {
    fail(res, err.message === 'Failure not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Action log: app errors reported for the fixer ------------- */
route('GET', /^\/api\/action-log$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, actionLog: actionLogStatus(), items: listActionLog({ status: url.searchParams.get('status') || '', limit: 60 }) });
});

route('POST', /^\/api\/action-log\/report$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const item = recordAction(body);
    sendJson(res, 200, { ok: true, item: item && item.id ? { id: item.id, count: item.count, status: item.status } : item });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/action-log\/([^/]+)\/triage$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, item: await triageItem({ id }) });
  } catch (err) {
    fail(res, err.message === 'Item not found' ? 404 : 500, err.message);
  }
});

route('POST', /^\/api\/action-log\/([^/]+)\/fix$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, item: applyFix(id, body) });
  } catch (err) {
    fail(res, err.message === 'Item not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/action-log\/([^/]+)\/implement$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, await implementSuggestion(id));
  } catch (err) {
    fail(res, err.message === 'Item not found' ? 404 : 500, err.message);
  }
});

/* ---------------- Agent awareness: who is working on the app right now ------ */
route('GET', /^\/api\/agents\/active$/, async (req, res) => {
  sendJson(res, 200, { ok: true, activity: agentActivity() });
});

route('POST', /^\/api\/agents\/heartbeat$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, activity: heartbeat(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/agents\/done$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, left: heartbeatDone(String(body.name || '')) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/agents\/continuation$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...(await Promise.resolve(sendContinuation(body))) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/action-log\/([^/]+)\/dismiss$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, item: dismissItem(id) });
  } catch (err) {
    fail(res, err.message === 'Item not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Deep focus: re-think a finished run, live ---------------- */
route('GET', /^\/api\/deep-focus\/([^/]+)$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, deepFocus: deepFocusStatus(id) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/deep-focus\/([^/]+)\/start$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, deepFocus: startDeepFocus(id, { rounds: body.rounds, reason: body.reason }) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/deep-focus\/([^/]+)\/apply$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, await applyReshaped(id));
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/deep-focus\/([^/]+)\/stop$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, deepFocus: stopDeepFocus(id) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/deep-focus\/([^/]+)\/presentation$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, deck: await presentationFromDeepFocus(id) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('GET', /^\/api\/deep-focus\/([^/]+)\/notes\.md$/, async (req, res, [id]) => {
  try {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.end(deepFocusMarkdown(id));
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Annotations: the drawing layer over frames --------------- */
route('GET', /^\/api\/annotations$/, async (req, res, _params, url) => {
  try {
    const pick = (key) => url.searchParams.get(key);
    const ref = { captureId: pick('captureId'), runId: pick('runId'), roundIndex: pick('roundIndex'), surface: pick('surface') };
    const items = pick('runId') ? annotationsForRun(pick('runId')) : listAnnotations(ref);
    sendJson(res, 200, { ok: true, annotations: items });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/annotations$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, annotation: addAnnotation(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/annotations\/pin$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, added: pinFindings(body.ref || {}, body.findings, { by: body.by || 'ai' }) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/annotations\/([^/]+)$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, annotation: removeAnnotation(id) });
  } catch (err) {
    fail(res, err.message === 'Annotation not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Firewall: verdicts before any step acts ------------------ */
route('GET', /^\/api\/firewall$/, async (req, res) => {
  sendJson(res, 200, { ok: true, firewall: firewallStatus() });
});

route('POST', /^\/api\/firewall\/mode$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, firewall: setFirewallMode(body.mode) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/firewall\/rules$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, rule: addFirewallRule(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/firewall\/rules\/([^/]+)$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, rule: removeFirewallRule(id) });
  } catch (err) {
    fail(res, err.message === 'Rule not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/firewall\/reset$/, async (req, res) => {
  sendJson(res, 200, { ok: true, firewall: resetFirewallRules() });
});

route('POST', /^\/api\/firewall\/test$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, verdict: firewallTest(body.step || {}, body.run || null) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Step factoring: intents, patterns, refactors ------------- */
route('GET', /^\/api\/factoring$/, async (req, res) => {
  sendJson(res, 200, { ok: true, factoring: factoringStatus() });
});

route('POST', /^\/api\/factoring\/pin$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const workflow = (db().workflows || []).find((entry) => entry.id === body.workflowId);
    if (!workflow) throw new Error('Workflow not found');
    sendJson(res, 200, { ok: true, pinned: pinStepIntents(workflow) });
  } catch (err) {
    fail(res, err.message === 'Workflow not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/factoring\/plan$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, plan: planRefactoring({ minWorkflows: Number(body?.minWorkflows) || 2, minShared: Number(body?.minShared) || 2 }) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/factoring\/apply$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, applied: pushRefactorToBuilder(body.planId) });
  } catch (err) {
    fail(res, err.message === 'Refactor plan not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/factoring\/solutions$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, solutions: similarSolutions({ step: body.step || {}, excludeWorkflowId: body.excludeWorkflowId || '' }) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Closeout: predicted follow-up steps after a run ---------- */
route('GET', /^\/api\/closeout\/([^/]+)$/, async (req, res, [id]) => {
  try {
    const run = findRun(id);
    if (!run) throw new Error('Run not found');
    sendJson(res, 200, { ok: true, closeout: closeoutFor(run) || recordCloseout(run) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/closeout\/([^/]+)\/append$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, appended: appendCloseout(id) });
  } catch (err) {
    fail(res, err.message === 'Run not found' ? 404 : 400, err.message);
  }
});

/* ---------------- Monitor tracking: which screen got the click ------------ */
route('GET', /^\/api\/monitors$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, monitors: await monitorsStatus({ fresh: url.searchParams.get('fresh') === '1' }) });
});

/* ---------------- Notes for other agents, custom commands ---------------- */
route('GET', /^\/api\/handoff$/, async (req, res) => {
  sendJson(res, 200, { ok: true, notes: listNotes({ limit: 50 }), commands: listCommands() });
});

route('POST', /^\/api\/handoff\/notes$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, note: addNote(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/commands$/, async (req, res) => {
  sendJson(res, 200, { ok: true, commands: listCommands() });
});

route('POST', /^\/api\/commands$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, command: saveCommand(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/commands\/([^/]+)$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, command: deleteCommand(id) });
  } catch (err) {
    fail(res, 404, err.message);
  }
});

route('POST', /^\/api\/commands\/([^/]+)\/run$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...(await runCommand(id, { timeoutMs: body.timeoutMs })) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/share$/, async (req, res) => {
  sendJson(res, 200, { ok: true, share: shareStatus({ includeToken: true }) });
});

// Automatic Command Center usage: the policy, and the operator's one-click
// "send these failures to a mission" action.
route('GET', /^\/api\/control-center\/escalation$/, async (req, res) => {
  sendJson(res, 200, { ok: true, escalation: escalationStatus() });
});

route('POST', /^\/api\/control-center\/escalate$/, async (req, res) => {
  const body = await readBody(req);
  try {
    const result = escalateBacklog({
      limit: Number(body.limit) || 3,
      forward: forwardRunToControlCenter,
      start: startMission,
    });
    sendJson(res, 200, { ok: true, result, escalation: escalationStatus() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/share\/start$/, async (req, res) => {
  const body = await readBody(req);
  const share = await startShare({ port: Number(body.port) || undefined, tunnel: body.tunnel !== false });
  if (share.lastError && !share.active) return fail(res, 500, share.lastError);
  sendJson(res, 200, { ok: true, share });
});

route('POST', /^\/api\/share\/stop$/, async (req, res) => {
  sendJson(res, 200, { ok: true, share: stopShare() });
});

// The verification review loop: what it has done, and a way to run a pass now
// instead of waiting for the timer.
route('GET', /^\/api\/verification-loop$/, async (req, res) => {
  const runs = (db().runs || []).filter((run) => (run.verificationReview || []).length);
  sendJson(res, 200, {
    ok: true,
    loop: loopStatus(),
    runs: runs.slice(0, 20).map((run) => ({
      id: run.id,
      workflowName: run.workflowName,
      status: run.status,
      awaitingChecks: (run.pendingVerification || []).length,
      verificationState: run.verificationState || '',
      attempts: Number(run.verificationAttempts || 0),
      stalled: Boolean(run.verificationStalled),
      review: (run.verificationReview || []).slice(-6),
      stepStalled: run.stepStalled || null,
    })),
  });
});

route('POST', /^\/api\/verification-loop\/review$/, async (req, res) => {
  const body = await readBody(req);
  const onlyRunIds = Array.isArray(body?.runIds) ? body.runIds.map(String) : null;
  const summary = await reviewPendingVerifications({ ignoreBackoff: true }, { onlyRunIds });
  sendJson(res, 200, { ok: true, summary });
});

route('GET', /^\/api\/health$/, async (req, res) => {
  const h = await health();
  sendJson(res, 200, { ok: true, ...h, platform: process.platform, windows: IS_WINDOWS, ...liveControl() });
});

route('POST', /^\/api\/live\/check$/, async (req, res) => {
  const detected = liveControl();
  const proof = detected.available
    ? await probeLiveBackend()
    : { ok: false, detail: detected.reason || 'No desktop backend is available.' };
  const available = Boolean(detected.available && proof.ok);
  const reason = available ? '' : proof.detail || detected.reason || 'Desktop readiness check failed.';
  sendJson(res, 200, {
    ok: true,
    available,
    reason,
    platform: { platform: process.platform, ...detected, available, reason, verified: available },
  });
});

// The local Respan Gateway that fronts the model provider, when it is enabled.
route('GET', /^\/api\/gateway$/, async (req, res) => sendJson(res, 200, { ok: true, gateway: gatewayStatus() }));

/* ---------------- Local backup model: GGUF via llama.cpp, or a local Ollama ---------------- */
route('GET', /^\/api\/local-model$/, async (req, res) =>
  sendJson(res, 200, { ok: true, localModel: localModelStatus() })
);

route('POST', /^\/api\/local-model\/download$/, async (req, res) => {
  const body = await readBody(req);
  const id = String(body?.id || 'qwen2.5-0.5b-instruct-q4_k_m');
  try {
    const result = await downloadModel(id);
    sendJson(res, 200, { ok: true, ...result, localModel: localModelStatus() });
  } catch (err) {
    return fail(res, 502, err.message);
  }
});

route('POST', /^\/api\/local-model\/cancel$/, async (req, res) =>
  sendJson(res, 200, { ok: true, download: cancelDownload() })
);

route('POST', /^\/api\/local-model\/install$/, async (req, res) => {
  const body = await readBody(req);
  const runtime = body?.runtime === 'ollama' ? 'ollama' : 'llamacpp';
  try {
    const result = runtime === 'ollama' ? await installOllama() : await installLlamaCpp();
    sendJson(res, 200, { ok: true, runtime, ...result, localModel: localModelStatus() });
  } catch (err) {
    return fail(res, 502, err.message);
  }
});

route('POST', /^\/api\/local-model\/start$/, async (req, res) => {
  const body = await readBody(req);
  try {
    const server = await startLlamaServer({
      file: String(body?.file || ''),
      port: Number(body?.port) || undefined,
    });
    sendJson(res, 200, { ok: true, server, localModel: localModelStatus() });
  } catch (err) {
    return fail(res, 409, err.message);
  }
});

route('POST', /^\/api\/local-model\/stop$/, async (req, res) => {
  const server = await stopLlamaServer();
  sendJson(res, 200, { ok: true, server, localModel: localModelStatus() });
});

route('GET', /^\/api\/live\/preview$/, async (req, res) => sendJson(res, 200, { ok: true, preview: livePreview.state() }));
route('POST', /^\/api\/live\/preview$/, async (req, res) => {
  let body;
  try { body = await readBody(req); } catch { return fail(res, 400, 'Invalid request body'); }
  if (!body || typeof body !== 'object' || !['start', 'stop', 'heartbeat'].includes(body.action)) return fail(res, 400, 'action must be start, stop or heartbeat');
  try {
    const preview = body.action === 'stop' ? livePreview.stop() : body.action === 'heartbeat' ? livePreview.heartbeat() : livePreview.start({ intervalMs: body.intervalMs });
    return sendJson(res, 200, { ok: true, preview });
  } catch {
    return fail(res, 400, 'intervalMs must be a finite number');
  }
});

// The live map: a short history of cheap screen reads, with the movement and
// change measured between each pair. GET never touches the desktop; POST
// samples, so a closed panel costs nothing.
route('GET', /^\/api\/live-map$/, async (req, res) => sendJson(res, 200, { ok: true, map: liveMap.state() }));
route('POST', /^\/api\/live-map$/, async (req, res) => {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, 'Invalid request body');
  }
  const action = String(body?.action || 'sample').toLowerCase();
  if (action === 'reset') return sendJson(res, 200, { ok: true, map: liveMap.reset() });
  if (action !== 'sample') return fail(res, 400, 'action must be sample or reset');
  const result = await liveMap.sample({ force: body?.force === true });
  return sendJson(res, 200, { ok: true, reused: result.reused, sample: result.sample, map: result.map });
});

route('GET', /^\/api\/live\/monitor$/, async (req, res) => sendJson(res, 200, { ok: true, monitor: monitorState(), observer: observerState() }));
route('POST', /^\/api\/live\/monitor$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const action = String(body.action || 'start').toLowerCase();
    if (action === 'stop') return sendJson(res, 200, { ok: true, monitor: stopLiveMonitor() });
    if (action !== 'start') return fail(res, 400, 'action must be start or stop');
    const monitor = startLiveMonitor({
      intervalMs: body.intervalMs,
      capture: body.capture,
      captureMinMs: body.captureMinMs,
    });
    logActivity('monitor', `Live watch ${monitor.running ? 'started' : 'unavailable'} (${monitor.intervalMs}ms, ${monitor.capture ? 'captures on' : 'captures off'})`);
    sendJson(res, 200, { ok: true, monitor });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('GET', /^\/api\/companion$/, async (req, res) => sendJson(res, 200, companionState()));
route('POST', /^\/api\/companion\/scan$/, async (req, res) => {
  try {
    sendJson(res, 200, { ok: true, companion: await scanCompanion({ system: true }) });
  } catch (err) {
    fail(res, 500, err.message);
  }
});
route('POST', /^\/api\/companion\/proposals\/([^/]+)$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const proposal = companionProposalAction(id, body.action === 'dismiss' ? 'dismiss' : 'accept');
  if (!proposal) return fail(res, 404, 'Companion proposal not found');
  sendJson(res, 200, { ok: true, proposal, companion: companionState() });
});
route('POST', /^\/api\/companion\/quick-help\/([^/]+)\/dismiss$/, async (req, res, [id]) => {
  const result = companionDismissQuickHelp(id);
  if (!result) return fail(res, 404, 'Quick help not found');
  sendJson(res, 200, { ok: true, companion: companionState() });
});
route('POST', /^\/api\/companion\/quick-help\/([^/]+)$/, async (req, res, [id]) => {
  const item = companionQuickHelp(id);
  if (!item) return fail(res, 404, 'Quick help not found');
  if (!['launchApp', 'openUrl', 'focusWindow', 'key', 'clipboard', 'type'].includes(item.action?.type)) {
    return fail(res, 400, 'This quick help needs approval in the Companion tab first.');
  }
  const live = !db().settings.dryRun;
  const step = {
    id: uid('stp'),
    type: item.action.type,
    name: item.label,
    params: item.action.params || {},
    timeoutMs: 15000,
  };
  try {
    const result = await executeStep(step, { live, runId: null, run: { id: 'companion' }, workflow: null, getTool: () => null });
    logActivity('companion', `Quick help ran ${item.label} (${live ? 'live' : 'simulated'})`, { quickHelpId: item.id });
    sendJson(res, 200, { ok: true, output: result?.output || '', item, companion: companionState() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});
route('POST', /^\/api\/companion\/continuations\/([^/]+)$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const run = findRun(id);
    if (!run) return fail(res, 404, 'Run not found');
    if (!['failed', 'needs_review', 'cancelled'].includes(run.status)) {
      return fail(res, 400, `Run is ${run.status}; only a stopped or failed run can continue.`);
    }
    const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
    if (!workflow) return fail(res, 404, 'Workflow for this run no longer exists');

    let pack = run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
    if (pack?.retryRunId === run.id) pack = null;
    let snapshot = pack ? recoverySnapshotFromPack(pack, workflow) : null;
    if (!snapshot) {
      const outcome = await prepareRecovery(run);
      if (outcome?.retryWorkflow) {
        pack = outcome.pack;
        snapshot = outcome.retryWorkflow;
      } else if (outcome?.pack) {
        pack = outcome.pack;
        snapshot = recoverySnapshotFromPack(pack, workflow);
      }
    }
    if (!pack || !snapshot) {
      return fail(res, 409, 'No recovery candidate passed its safety check. Review the recovery pack before retrying.');
    }
    const retry = queueRecoveryRetry(run, pack, snapshot, {
      source: 'companion',
      dryRun: body.dryRun === undefined ? run.dryRun : Boolean(body.dryRun),
    });
    if (!retry) return fail(res, 409, RECOVERY_REPEAT);
    sendJson(res, 200, { ok: true, run: summary(retry), pack, companion: companionState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/companion\/notifications\/([^/]+)\/read$/, async (req, res, [id]) => {
  const notification = markCompanionNotification(id, true);
  if (!notification) return fail(res, 404, 'Companion notification not found');
  sendJson(res, 200, { ok: true, notification, companion: companionState() });
});

/* ---------------- Continuity verifier ---------------- */
route('GET', /^\/api\/continuity$/, async (req, res) => sendJson(res, 200, { ok: true, continuity: continuityState() }));
route('POST', /^\/api\/continuity\/scan$/, async (req, res) => {
  try {
    const result = await tickContinuity({ capture: true });
    sendJson(res, 200, { ok: true, ...result, continuity: continuityState() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});
route('POST', /^\/api\/continuity\/runs\/([^/]+)\/review$/, async (req, res, [id]) => {
  try {
    const run = findRun(id);
    if (!run) return fail(res, 404, 'Run not found');
    const review = await reviewRunContinuity(run, { capture: true });
    sendJson(res, 200, { ok: true, review, continuity: continuityState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/continuity\/ai-review$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const result = await aiReviewContinuity(body.runId || null);
    sendJson(res, 200, { ...result, continuity: continuityState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/continuity\/suggestions\/([^/]+)\/prepare$/, async (req, res, [id]) => {
  try {
    const workflow = prepareSuggestedWorkflow(id);
    sendJson(res, 200, { ok: true, workflow: workflowView(workflow), continuity: continuityState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/continuity\/suggestions\/([^/]+)\/dismiss$/, async (req, res, [id]) => {
  try {
    const suggestion = dismissSuggestion(id);
    sendJson(res, 200, { ok: true, suggestion, continuity: continuityState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/continuity\/continuations\/([^/]+)$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const run = findRun(id);
    if (!run) return fail(res, 404, 'Run not found');
    if (!['failed', 'needs_review', 'cancelled'].includes(run.status)) {
      return fail(res, 400, `Run is ${run.status}; only a stopped or failed run can continue.`);
    }
    const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
    if (!workflow) return fail(res, 404, 'Workflow for this run no longer exists');
    let pack = run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
    if (pack?.retryRunId === run.id) pack = null;
    let snapshot = pack ? recoverySnapshotFromPack(pack, workflow) : null;
    if (!snapshot) {
      const outcome = await prepareRecovery(run);
      if (outcome?.retryWorkflow) {
        pack = outcome.pack;
        snapshot = outcome.retryWorkflow;
      } else if (outcome?.pack) {
        pack = outcome.pack;
        snapshot = recoverySnapshotFromPack(pack, workflow);
      }
    }
    if (!pack) {
      return fail(res, 409, 'No recovery pack or tested candidate is available. Review the failure before retrying.');
    }
    const candidates = (pack.candidates || []).map(recoveryCandidateView);
    if (body.confirm !== true) {
      return sendJson(res, 200, {
        ok: true,
        requiresApproval: true,
        runId: run.id,
        packId: pack.id,
        packStatus: pack.status,
        candidateId: pack.selectedCandidateId || candidates.find((candidate) => candidate.test.ok)?.id || null,
        candidates,
        continuity: continuityState(),
      });
    }
    const candidateId = String(body.candidateId || pack.selectedCandidateId || '').trim();
    const candidate = (pack.candidates || []).find((entry) => entry.id === candidateId);
    if (!candidate) return fail(res, 400, 'Choose a tested recovery candidate before approving a retry.');
    if (!candidate.test?.ok) return fail(res, 409, 'That recovery candidate did not pass its shadow test. Review or repair it before retrying.');
    snapshot = recoverySnapshotFromPack(pack, workflow, candidate.id);
    if (!snapshot) return fail(res, 409, 'The selected candidate has no executable steps. Review the recovery pack before retrying.');
    const retry = queueRecoveryRetry(run, pack, snapshot, {
      source: 'continuity',
      dryRun: body.dryRun === undefined ? run.dryRun : Boolean(body.dryRun),
    });
    if (!retry) return fail(res, 409, RECOVERY_REPEAT);
    sendJson(res, 200, { ok: true, run: summary(retry), pack, continuity: continuityState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});
route('POST', /^\/api\/companion\/notifications\/read-all$/, async (req, res) => {
  clearCompanionNotifications();
  sendJson(res, 200, { ok: true, companion: companionState() });
});
route('GET', /^\/api\/companion\/notes$/, async (req, res) => sendJson(res, 200, { ok: true, notes: companionNotes() }));
route('POST', /^\/api\/companion\/notes$/, async (req, res) => {
  const body = await readBody(req);
  const note = addCompanionNote(body.text || '');
  sendJson(res, 200, { ok: true, note, notes: companionNotes(), companion: companionState() });
});

route('GET', /^\/api\/workflow-memory$/, async (req, res, _params, url) => {
  const result = listWorkflowMemory({
    workflowId: url.searchParams.get('workflowId') || '',
    status: url.searchParams.get('status') || '',
    limit: url.searchParams.get('limit') || 40,
  });
  sendJson(res, 200, { ok: true, ...result });
});

route('POST', /^\/api\/auth\/login$/, async (req, res) => {
  const body = await readBody(req);
  try {
    const admin = loginAdmin(req, res, body.username, body.password);
    sendJson(res, 200, { ok: true, admin });
  } catch (err) {
    fail(res, 401, err.message);
  }
});

route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
  logoutAdmin(req, res);
  sendJson(res, 200, { ok: true });
});

route('GET', /^\/api\/auth\/status$/, async (req, res) => sendJson(res, 200, adminStatus(req)));

route('POST', /^\/api\/auth\/password$/, async (req, res) => {
  const body = await readBody(req);
  try {
    changeAdminPassword(req, body.current, body.next);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/missions$/, async (req, res) => {
  sendJson(res, 200, { ok: true, missions: listMissions(), patterns: db().patterns });
});

route('GET', /^\/api\/shortcuts$/, async (req, res) => {
  sendJson(res, 200, { ok: true, ...listShortcuts() });
});

route('POST', /^\/api\/shortcuts\/([^/]+)\/decision$/, async (req, res, [id]) => {
  const body = await readBody(req);
  try {
    const result = decideShortcut(id, body.decision, 'operator');
    logActivity(
      'shortcut',
      `Shortcut ${body.decision}: ${result.candidate.app} ${result.candidate.keys} (${result.candidate.action})`
    );
    sendJson(res, 200, { ok: true, ...result, shortcuts: listShortcuts() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/shortcuts\/habits\/([^/]+)\/state$/, async (req, res, [id]) => {
  const body = await readBody(req);
  try {
    const habit = setShortcutHabit(id, body.enabled !== false, 'operator');
    logActivity('shortcut', `${habit.enabled ? 'Enabled' : 'Disabled'} shortcut ${habit.app} ${habit.keys}`);
    sendJson(res, 200, { ok: true, habit, shortcuts: listShortcuts() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/shortcuts\/blocks\/([^/]+)\/undo$/, async (req, res, [id]) => {
  try {
    const result = removeShortcutBlock(id);
    logActivity('shortcut', `Undid Never learn for ${result.block.app} ${result.block.keys}`);
    sendJson(res, 200, { ok: true, ...result, shortcuts: listShortcuts() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/shortcuts\/habits\/([^/]+)\/replay$/, async (req, res, [id]) => {
  try {
    const habit = getShortcutHabit(id);
    if (!habit || !habit.approved) return fail(res, 404, 'Approved shortcut not found');
    if (habit.reviewReason === 'app-update') {
      return fail(res, 400, 'The app changed. Re-approve the updated candidate before replaying this shortcut.');
    }
    if (!liveControl().available) return fail(res, 400, liveRefusal());
    const step = {
      id: uid('stp'),
      type: 'key',
      name: `Replay ${habit.action}`,
      params: {
        keys: habit.keys,
        ...(habit.windowTitle || habit.app ? { foreground: habit.windowTitle || habit.app } : {}),
      },
      timeoutMs: 15000,
      optional: false,
      condition: null,
    };
    const workflow = {
      id: `wf_replay_${habit.id}`,
      name: `Shortcut replay: ${habit.action}`,
      description: 'A single live key replay for an approved shortcut.',
      status: 'draft',
      patternTags: [],
      failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false, pauseBeforeRetryMs: 0, notifyAgent: false },
      steps: [step],
    };
    const run = createRun(workflow, {
      trigger: 'shortcut-replay',
      dryRun: false,
      agentRole: 'operator',
      shortcutReplayHabitId: habit.id,
    });
    logActivity('shortcut', `Started replay ${run.id} for ${habit.app} ${habit.keys}`);
    sendJson(res, 200, { ok: true, run: summary(run), habit, shortcuts: listShortcuts() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Ambient frame clock & preference rules ---------------- */
route('GET', /^\/api\/ambient$/, async (req, res) => sendJson(res, 200, { ok: true, ambient: ambientState() }));

route('GET', /^\/api\/ambient\/refresh$/, async (req, res) => {
  const rate = await detectRefreshRate();
  sendJson(res, 200, { ok: true, ...rate, ambient: ambientState() });
});

route('POST', /^\/api\/ambient\/settings$/, async (req, res) => {
  try {
    sendJson(res, 200, { ok: true, ambient: ambientSettings(await readBody(req)) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/tick$/, async (req, res) => {
  try {
    sendJson(res, 200, await tickAmbient({ force: true }));
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/rules$/, async (req, res) => {
  try {
    const rule = createAmbientRule(await readBody(req));
    sendJson(res, 200, { ok: true, rule, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/rules\/([^/]+)\/toggle$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const rule = updateAmbientRule(decodeURIComponent(id), { enabled: body.enabled !== false });
    logActivity('ambient', `${rule.enabled ? 'Enabled' : 'Paused'} rule “${rule.name}”`);
    sendJson(res, 200, { ok: true, rule, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/rules\/([^/]+)\/run$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, ...(await runRuleNow(decodeURIComponent(id))) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/ambient\/rules\/([^/]+)$/, async (req, res, [id]) => {
  try {
    deleteAmbientRule(decodeURIComponent(id));
    sendJson(res, 200, { ok: true, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/schedules$/, async (req, res) => {
  try {
    const schedule = createAmbientSchedule(await readBody(req));
    sendJson(res, 200, { ok: true, schedule, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/schedules\/([^/]+)\/toggle$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const schedule = updateAmbientSchedule(decodeURIComponent(id), { enabled: body.enabled !== false });
    sendJson(res, 200, { ok: true, schedule, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', /^\/api\/ambient\/schedules\/([^/]+)$/, async (req, res, [id]) => {
  try {
    deleteAmbientSchedule(decodeURIComponent(id));
    sendJson(res, 200, { ok: true, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/learn$/, async (req, res) => {
  try {
    sendJson(res, 200, { ok: true, ...learnAmbient() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/proposals\/([^/]+)$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...ambientProposalAction(decodeURIComponent(id), body.action === 'dismiss' ? 'dismiss' : 'accept') });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/presets$/, async (req, res) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...ambientPreset(body.name) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/notifications\/read-all$/, async (req, res) => {
  sendJson(res, 200, { ok: true, ambient: clearAmbientNotifications() });
});

route('POST', /^\/api\/ambient\/notifications\/([^/]+)\/read$/, async (req, res, [id]) => {
  const notification = markAmbientNotification(decodeURIComponent(id), true);
  if (!notification) return fail(res, 404, 'Ambient notification not found');
  sendJson(res, 200, { ok: true, notification, ambient: ambientState() });
});

route('POST', /^\/api\/ambient\/notes$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const note = addAmbientNote(body.text || '');
    sendJson(res, 200, { ok: true, note, ambient: ambientState() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/ambient\/compact$/, async (req, res) => {
  sendJson(res, 200, { ok: true, ambient: compactAmbient() });
});

route('GET', /^\/api\/presentations$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, presentations: listPresentations(url.searchParams.get('workflowId') || '') });
});

route('GET', /^\/api\/presentations\/search$/, async (req, res, _params, url) => {
  const results = findRelatedPresentations(url.searchParams.get('q') || '', {
    workflowId: url.searchParams.get('workflowId') || '',
    classification: url.searchParams.get('classification') || '',
    limit: url.searchParams.get('limit') || 12,
  });
  sendJson(res, 200, { ok: true, presentations: results });
});

route('GET', /^\/api\/presentations\/graph$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, ...presentationGraph({ workflowId: url.searchParams.get('workflowId') || '' }) });
});

route('POST', /^\/api\/presentations\/compact$/, async (req, res) => {
  const body = await readBody(req);
  try {
    sendJson(res, 200, { ok: true, ...compactPresentations({ keep: body.keep || 8 }), presentations: listPresentations() });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/presentations\/([^/]+)\/export$/, async (req, res, [id], url) => {
  try {
    const format = url.searchParams.get('format') === 'html' ? 'html' : 'md';
    const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
    let content = exportPresentation(decodeURIComponent(id), format);
    if (format === 'html') content = content.replaceAll('src="/api/', `src="${origin}/api/`);
    const name = `deck-${decodeURIComponent(id)}.${format === 'html' ? 'html' : 'md'}`;
    res.writeHead(200, {
      'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.end(content);
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/presentations\/([^/]+)$/, async (req, res, [id]) => {
  const presentation = getPresentation(decodeURIComponent(id));
  if (!presentation) return fail(res, 404, 'Presentation not found');
  sendJson(res, 200, { ok: true, presentation });
});

route('POST', /^\/api\/presentations\/watch$/, async (req, res) => {
  try {
    const result = await watchPresentationDecks();
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/([^/]+)\/watch$/, async (req, res, [id]) => {
  try {
    const result = await watchPresentationDecks();
    const presentation = getPresentation(decodeURIComponent(id));
    sendJson(res, 200, { ok: true, ...result, presentation });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/([^/]+)\/control$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, presentation: setPresentationControl(decodeURIComponent(id), body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/generate$/, async (req, res) => {
  const body = await readBody(req);
  try {
    const presentation = await generatePresentation(body);
    sendJson(res, 200, { ok: true, presentation });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/audit$/, async (req, res) => {
  const body = await readBody(req);
  try {
    sendJson(res, 200, { ok: true, audit: auditPresentation(body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/([^/]+)\/reapply$/, async (req, res, [id]) => {
  try {
    const result = await reapplyPresentation(decodeURIComponent(id));
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/workflows\/([^/]+)\/retry-budget$/, async (req, res, [id]) => {
  const workflow = db().workflows.find((entry) => entry.id === decodeURIComponent(id));
  if (!workflow) return fail(res, 404, 'Workflow not found');
  sendJson(res, 200, { ok: true, retryBudget: getRetryBudget(workflow.id) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/retry-budget$/, async (req, res, [id]) => {
  const body = await readBody(req);
  try {
    sendJson(res, 200, { ok: true, retryBudget: setRetryBudget(decodeURIComponent(id), body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/presentations\/([^/]+)\/propose$/, async (req, res, [id]) => {
  try {
    const result = await proposalFromPresentation(decodeURIComponent(id));
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('PATCH', /^\/api\/presentations\/([^/]+)$/, async (req, res, [id]) => {
  const body = await readBody(req);
  try {
    sendJson(res, 200, { ok: true, presentation: reviewPresentation(decodeURIComponent(id), body) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/missions$/, async (req, res) => {
  const body = await readBody(req);
  const workflow = db().workflows.find((entry) => entry.id === body.workflowId);
  if (!workflow) return fail(res, 400, 'Pick a workflow for the mission');
  if (body.mode === 'live' && !liveControl().available) return fail(res, 400, liveRefusal());
  let autoPlan = null;
  try {
    autoPlan = await ensureWorkflowSteps(workflow, body.goal);
  } catch (err) {
    return fail(res, 400, `Could not auto-create steps: ${err.message}`);
  }
  const mission = startMission(
    createMission({
      workflowId: workflow.id,
      goal: body.goal,
      mode: body.mode,
      conditions: body.conditions,
    }).id
  );
  sendJson(res, 200, { ok: true, mission: findMission(mission.id), autoPlan });
});

route('POST', /^\/api\/missions\/([^/]+)\/command$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const status = adminStatus(req);
  if (!status.authenticated) return fail(res, 401, 'Sign in as admin to issue operator commands');
  try {
    const result = await operatorCommand(id, body.command, body.reason, status.username);
    sendJson(res, 200, { ok: true, ...result, auth: status });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/missions\/([^/]+)$/, async (req, res, [id]) => {
  const mission = findMission(id);
  if (!mission) return fail(res, 404, 'Mission not found');
  const lastRun = mission.lastRunId ? findRun(mission.lastRunId) : null;
  sendJson(res, 200, {
    ok: true,
    mission: {
      ...mission,
      stepLedger: (lastRun?.ledger || []).slice(-30),
      runPosition: lastRun?.position || null,
    },
    summary: missionSummary(mission),
  });
});

route('GET', /^\/api\/missions\/([^/]+)\/presentation$/, async (req, res, [id]) => {
  try {
    sendJson(res, 200, { ok: true, presentation: missionPresentation(id) });
  } catch (err) {
    fail(res, 404, err.message);
  }
});

route('POST', /^\/api\/missions\/([^/]+)\/decision$/, async (req, res, [id]) => {
  const body = await readBody(req);
  try {
    const result = await decideMission(id, body);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/missions\/([^/]+)\/control$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const result = controlMission(id, body.action);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/missions\/([^/]+)\/(note|input)$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const result = await sendMissionNote(id, body.text, body);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/missions\/([^/]+)\/auto$/, async (req, res, [id]) => {
  try {
    const result = await autoDecideMission(id);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/missions\/([^/]+)\/(start|pause|resume|cancel|check|replan|retry)$/, async (req, res, [id, action]) => {
  if (!findMission(id)) return fail(res, 404, 'Mission not found');
  try {
    if (action === 'pause') return sendJson(res, 200, { ok: true, mission: pauseMission(id) });
    if (action === 'resume') return sendJson(res, 200, { ok: true, mission: resumeMission(id) });
    if (action === 'cancel') return sendJson(res, 200, { ok: true, mission: cancelMission(id) });
    if (action === 'start') return sendJson(res, 200, { ok: true, mission: startMission(id) });
    if (action === 'retry') {
      const mission = retryMission(id);
      return sendJson(res, 200, { ok: true, mission });
    }
    if (action === 'check') {
      const result = await checkMissionNow(id);
      return sendJson(res, 200, { ok: true, mission: result.mission, reference: result.reference });
    }
    if (action === 'replan') {
      const result = await replanMissionNow(id);
      return sendJson(res, 200, { ok: true, mission: result.mission, result: result.result });
    }
    return fail(res, 400, 'Unknown mission action');
  } catch (err) {
    return fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/models$/, async (req, res, _params, url) => {
  const result = await listModels(url.searchParams.get('refresh') === '1');
  sendJson(res, result.ok ? 200 : 502, result);
});

/* ---------------- Workflows ---------------- */
route('GET', /^\/api\/examples$/, async (req, res) => {
  sendJson(res, 200, { ok: true, examples: listExamples() });
});

/* ---------------- Knack mapping & export ---------------- */
route('GET', /^\/api\/knack$/, async (req, res) => sendJson(res, 200, knackSchema()));

route('GET', /^\/api\/knack\/records$/, async (req, res) =>
  sendJson(res, 200, { ok: true, records: knackRecords(db()) })
);

route('GET', /^\/api\/knack\/download$/, async (req, res, _params, url) => {
  const format = (url.searchParams.get('format') || 'md').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="knack-fields-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(knackCsv());
  }
  if (format === 'json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="knack-mapping-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ ...knackSchema(), records: knackRecords(db()), recordCsvs: knackRecordsCsvs(db()) }, null, 2));
  }
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Disposition': `attachment; filename="knack-command-center-${stamp}.md"`,
    'Cache-Control': 'no-store',
  });
  res.end(knackMarkdown());
});

route('GET', /^\/api\/examples\/([^/]+)$/, async (req, res, [id]) => {
  const example = findExample(id);
  if (!example) return fail(res, 404, 'Example not found');
  sendJson(res, 200, { ok: true, example });
});

route('POST', /^\/api\/examples\/([^/]+)\/import$/, async (req, res, [id]) => {
  const example = findExample(id);
  if (!example) return fail(res, 404, 'Example not found');
  const body = await readBody(req);
  const status = body.status === 'ready' ? 'ready' : 'draft';
  const ts = now();
  const wf = {
    id: uid('wf'),
    name: example.title.slice(0, 90),
    description: `${example.refined.summary}\n\nOriginal request: ${example.goal}`,
    status,
    autoRun: false,
    tags: [...example.tags, 'example'],
    patternTags: (example.patternTags?.length ? example.patternTags : example.tags).slice(0, 8),
    failurePolicy: { ...example.failurePolicy },
    steps: example.steps.map((step) => ({
      id: uid('stp'),
      type: step.type,
      name: step.name,
      params: { ...step.params },
      timeoutMs: step.timeoutMs,
      optional: Boolean(step.optional),
    })),
    sourceExampleId: example.id,
    createdAt: ts,
    updatedAt: ts,
  };
  db().workflows.unshift(wf);
  persist();
  logActivity('workflow', `Imported example “${example.title}” as ${status}`);
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('GET', /^\/api\/workflows\/([^/]+)$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/lint$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  sendJson(res, 200, { ok: true, workflowId: wf.id, ...lintWorkflow(wf) });
});

route('POST', /^\/api\/workflows$/, async (req, res) => {
  const body = await readBody(req);
  const name = String(body.name || 'Untitled workflow').slice(0, 90);
  const wf = {
    id: uid('wf'),
    name,
    description: String(body.description || ''),
    status: 'draft',
    autoRun: false,
    tags: [],
    patternTags: [],
    failurePolicy: {
      onFailure: 'stop',
      maxRetries: 1,
      captureScreenshot: true,
      pauseBeforeRetryMs: 800,
      notifyAgent: true,
    },
    // Empty until the author says what the app should look like afterwards.
    handoff: { enabled: false, steps: [] },
    steps: [],
    createdAt: now(),
    updatedAt: now(),
  };
  db().workflows.unshift(wf);
  persist();
  logActivity('workflow', `Created workflow "${name}"`);
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('PATCH', /^\/api\/workflows\/([^/]+)$/, async (req, res, [id]) => {
  const body = await readBody(req);
  const patch = {};
  if (body.name !== undefined) patch.name = String(body.name).slice(0, 90);
  if (body.description !== undefined) patch.description = String(body.description).slice(0, 4000);
  if (body.status !== undefined) {
    if (!['draft', 'ready', 'archived'].includes(body.status)) return fail(res, 400, 'Invalid workflow status');
    patch.status = body.status;
  }
  if (body.autoRun !== undefined) patch.autoRun = Boolean(body.autoRun);
  if (body.failurePolicy !== undefined) {
    const p = body.failurePolicy || {};
    patch.failurePolicy = {
      onFailure: ['stop', 'retry', 'continue'].includes(p.onFailure) ? p.onFailure : 'stop',
      maxRetries: Math.max(0, Math.min(5, Number(p.maxRetries) || 0)),
      captureScreenshot: p.captureScreenshot !== false,
      pauseBeforeRetryMs: Math.max(0, Math.min(10000, Number(p.pauseBeforeRetryMs) || 0)),
      notifyAgent: p.notifyAgent !== false,
    };
  }
  if (body.handoff !== undefined) {
    const h = body.handoff || {};
    const steps = (Array.isArray(h.steps) ? h.steps : []).slice(0, 10);
    patch.handoff = {
      enabled: h.enabled === true,
      steps: steps
        .map((step, index) => ({
          id: String(step?.id || `handoff_${index + 1}`).slice(0, 40),
          type: String(step?.type || '').trim(),
          name: String(step?.name || step?.type || `Hand-off step ${index + 1}`).slice(0, 90),
          params: step?.params && typeof step.params === 'object' && !Array.isArray(step.params) ? step.params : {},
          timeoutMs: Math.max(1000, Math.min(60000, Number(step?.timeoutMs) || 20000)),
          optional: true,
        }))
        .filter((step) => step.type),
    };
  }
  if (body.tags !== undefined && Array.isArray(body.tags)) patch.tags = body.tags.map(String).slice(0, 8);
  if (body.patternTags !== undefined) {
    const raw = Array.isArray(body.patternTags) ? body.patternTags : String(body.patternTags || '').split(',');
    patch.patternTags = [...new Set(raw.map((tag) => slug(tag)).filter(Boolean))].slice(0, 8);
  }
  const wf = updateWorkflow(id, patch);
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('DELETE', /^\/api\/workflows\/([^/]+)$/, async (req, res, [id]) => {
  const d = db();
  const idx = d.workflows.findIndex((w) => w.id === id);
  if (idx === -1) return fail(res, 404, 'Workflow not found');
  const [wf] = d.workflows.splice(idx, 1);
  for (const agent of d.agents) if (agent.workflowId === id) agent.workflowId = null;
  forgetWorkflowMemory(id);
  persist();
  logActivity('workflow', `Deleted workflow "${wf.name}"`);
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/workflows\/([^/]+)\/steps$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const body = await readBody(req);
  const step = validateStepInput(body.step || body);
  const index = Number.isInteger(body.index) ? Math.max(0, Math.min(wf.steps.length, body.index)) : wf.steps.length;
  wf.steps.splice(index, 0, step);
  wf.updatedAt = now();
  persist();
  sendJson(res, 200, { ok: true, step, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/steps\/bulk$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const body = await readBody(req);
  const incoming = Array.isArray(body.steps) ? body.steps : [];
  if (!incoming.length) return fail(res, 400, 'No steps supplied');
  const normalized = incoming
    .map((s, i) => {
      try {
        return normalizeStep(s, i) || validateStepInput(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!normalized.length) return fail(res, 400, 'No valid steps supplied');
  const goal = String(body.goal || '').trim();
  if (goal) wf.description = goal.slice(0, 2000);
  if (body.mode === 'replace') wf.steps = normalized;
  else if (Number.isInteger(body.index)) wf.steps.splice(body.index, 0, ...normalized);
  else wf.steps.push(...normalized);
  wf.updatedAt = now();
  persist();
  logActivity('workflow', `Added ${normalized.length} step(s) to "${wf.name}"`);
  sendJson(res, 200, { ok: true, added: normalized.length, workflow: workflowView(wf) });
});

route('PATCH', /^\/api\/workflows\/([^/]+)\/steps\/([^/]+)$/, async (req, res, [id, stepId]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const step = wf.steps.find((s) => s.id === stepId);
  if (!step) return fail(res, 404, 'Step not found');
  const body = await readBody(req);
  const direction = body.move;
  if (direction === 'up' || direction === 'down') {
    const idx = wf.steps.indexOf(step);
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target >= 0 && target < wf.steps.length) {
      wf.steps.splice(idx, 1);
      wf.steps.splice(target, 0, step);
    }
  } else {
    Object.assign(step, validateStepInput(body, step));
  }
  wf.updatedAt = now();
  persist();
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/steps\/([^/]+)\/duplicate$/, async (req, res, [id, stepId]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const idx = wf.steps.findIndex((s) => s.id === stepId);
  if (idx === -1) return fail(res, 404, 'Step not found');
  const copy = {
    ...JSON.parse(JSON.stringify(wf.steps[idx])),
    id: uid('stp'),
    name: `${wf.steps[idx].name} copy`.slice(0, 90),
  };
  wf.steps.splice(idx + 1, 0, copy);
  wf.updatedAt = now();
  persist();
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('DELETE', /^\/api\/workflows\/([^/]+)\/steps\/([^/]+)$/, async (req, res, [id, stepId]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const idx = wf.steps.findIndex((s) => s.id === stepId);
  if (idx === -1) return fail(res, 404, 'Step not found');
  wf.steps.splice(idx, 1);
  wf.updatedAt = now();
  persist();
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/plan$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const body = await readBody(req);
  const goal = String(body.goal || '').trim();
  if (!goal) return fail(res, 400, 'Describe the goal first');
  const result = await planSteps(goal, wf);
  sendJson(res, 200, { ok: true, ...result });
});

/* ---------------- Instruction-driven step changes ---------------- */
// An instruction is read into steps, checked against the current plan and then
// held for approval. Nothing here writes to a workflow until the operator
// approves the change.
route('POST', /^\/api\/workflows\/([^/]+)\/instruction$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const body = await readBody(req);
  const instruction = String(body.instruction || '').trim();
  if (!instruction) return fail(res, 400, 'Say what should change, for example “type hi in notepad”');
  if (instruction.length > 800) return fail(res, 400, 'Keep the instruction short enough to name one change');
  const plan = planStepChange({
    instruction,
    steps: wf.steps,
    goal: String(body.goal || wf.description || wf.name || ''),
  });
  if (!plan.ok) return fail(res, 400, plan.reason || 'That instruction did not change any step');
  const turn = Math.max(0, Number(wf.changeTurn || 0)) + 1;
  wf.pendingStepChange = {
    ...plan,
    id: uid('chg'),
    workflowId: wf.id,
    status: 'pending',
    turn,
    instruction,
    createdAt: now(),
    review: { ...(plan.review || {}), turn, status: 'pending', at: now() },
  };
  persist();
  logActivity('workflow', `Proposed ${plan.changes.length} step change(s) for "${wf.name}" from an instruction`, {
    workflowId: wf.id,
  });
  sendJson(res, 200, { ok: true, change: wf.pendingStepChange, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/instruction\/([^/]+)\/approve$/, async (req, res, [id, changeId]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const pending = wf.pendingStepChange;
  if (!pending || pending.id !== changeId || pending.status !== 'pending') {
    return fail(res, 404, 'That step change is no longer waiting for approval');
  }
  const body = await readBody(req);
  const before = (wf.steps || []).length;
  wf.steps = (pending.steps || []).map((step, index) => ({
    ...step,
    id: step.id || uid('stp'),
    name: String(step.name || `Step ${index + 1}`).slice(0, 80),
  }));
  wf.updatedAt = now();
  wf.changeTurn = Number(pending.turn || wf.changeTurn || 0);
  wf.lastChange = {
    id: pending.id,
    turn: wf.changeTurn,
    instruction: pending.instruction,
    summary: pending.review?.summary || '',
    changes: pending.changes || [],
    gaps: pending.gaps || [],
    status: 'approved',
    at: now(),
    note: String(body.note || '').slice(0, 500),
  };
  wf.stepChanges = [wf.lastChange, ...(wf.stepChanges || [])].slice(0, 20);
  delete wf.pendingStepChange;
  // One approval re-syncs the whole workflow: intents are re-pinned and the
  // plan is linted again so the change cannot leave a step behind.
  try {
    pinStepIntents(wf);
  } catch { /* pinning never blocks the approval */ }
  const lint = lintWorkflow(wf);
  wf.updatedAt = now();
  persist();
  logActivity('workflow', `Approved ${(pending.changes || []).length} step change(s) for "${wf.name}"`, {
    workflowId: wf.id,
  });
  sendJson(res, 200, {
    ok: true,
    workflow: workflowView(wf),
    change: wf.lastChange,
    lint,
    stepsChanged: wf.steps.length - before,
  });
});

route('POST', /^\/api\/workflows\/([^/]+)\/instruction\/([^/]+)\/decline$/, async (req, res, [id, changeId]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const pending = wf.pendingStepChange;
  if (!pending || pending.id !== changeId) return fail(res, 404, 'That step change is no longer waiting for approval');
  wf.stepChanges = [
    {
      id: pending.id,
      turn: pending.turn,
      instruction: pending.instruction,
      summary: pending.review?.summary || '',
      changes: pending.changes || [],
      gaps: pending.gaps || [],
      status: 'declined',
      at: now(),
    },
    ...(wf.stepChanges || []),
  ].slice(0, 20);
  delete wf.pendingStepChange;
  persist();
  logActivity('workflow', `Declined step change for "${wf.name}"`, { workflowId: wf.id });
  sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
});

route('POST', /^\/api\/workflows\/([^/]+)\/propose$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const proposal = await createProposal({
      workflowId: id,
      goal: String(body.goal || '').trim(),
      source: 'research-agent',
    });
    sendJson(res, 200, { ok: true, proposal, proposals: listProposals({ workflowId: id, limit: 20 }).proposals });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/proposals$/, async (req, res, _params, url) => {
  sendJson(res, 200, {
    ok: true,
    ...listProposals({
      workflowId: url.searchParams.get('workflowId') || '',
      status: url.searchParams.get('status') || '',
      limit: url.searchParams.get('limit') || 20,
    }),
  });
});

route('GET', /^\/api\/proposals\/([^/]+)$/, async (req, res, [id]) => {
  const proposal = findProposal(id);
  if (!proposal) return fail(res, 404, 'Proposal not found');
  sendJson(res, 200, { ok: true, proposal });
});

route('POST', /^\/api\/proposals\/([^/]+)\/approve$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const result = approveProposal(id, { mode: body.mode === 'append' ? 'append' : 'replace' });
    sendJson(res, 200, { ok: true, proposal: result.proposal, workflow: workflowView(result.workflow) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/proposals\/([^/]+)\/reject$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, proposal: rejectProposal(id, body.reason) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/proposals\/([^/]+)\/shadow-test$/, async (req, res, [id]) => {
  try {
    const result = await shadowTestProposal(id);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

function visualCandidate(body = {}) {
  const d = db();
  const proposal = body.proposalId ? findProposal(body.proposalId) : null;
  const run = body.runId ? d.runs.find((entry) => entry.id === body.runId) : null;
  const workflow = proposal
    ? d.workflows.find((entry) => entry.id === proposal.workflowId) || null
    : run
    ? d.workflows.find((entry) => entry.id === run.workflowId) || null
    : body.workflowId
    ? d.workflows.find((entry) => entry.id === body.workflowId) || null
    : null;
  const proposalShot = (proposal?.research?.screenshots || []).find((shot) => !shot.simulated) || proposal?.research?.screenshots?.[0];
  const runShot = (run?.evidence || []).find((item) => item.path && (item.kind === 'screenshot' || /\.(?:png|jpe?g|webp)$/i.test(item.path)));
  const latestRun = workflow ? d.runs.find((entry) => entry.workflowId === workflow.id) : null;
  const workflowShot = (latestRun?.evidence || []).find((item) => item.path && (item.kind === 'screenshot' || /\.(?:png|jpe?g|webp)$/i.test(item.path)));
  const screenshot = body.imagePath ? { path: body.imagePath, caption: body.caption || 'Selected screenshot' } : proposalShot || runShot || workflowShot || null;
  const stepIndex = Number.isFinite(Number(body.stepIndex)) ? Math.max(0, Number(body.stepIndex)) : 0;
  const step = body.step || proposal?.steps?.[stepIndex] || workflow?.steps?.[stepIndex] || null;
  return {
    proposal,
    run,
    workflow,
    imagePath: screenshot?.path || '',
    caption: body.caption || screenshot?.caption || '',
    width: screenshot?.width || null,
    height: screenshot?.height || null,
    goal: String(body.goal || proposal?.goal || workflow?.description || workflow?.name || ''),
    step,
    expected: String(body.expected || ''),
  };
}

route('GET', /^\/api\/visual-tester$/, async (req, res) => sendJson(res, 200, { ok: true, ...visualTesterStatus() }));

route('POST', /^\/api\/visual-tester\/test$/, async (req, res) => {
  try {
    const body = await readBody(req);
    const candidate = visualCandidate(body);
    if (!candidate.imagePath) return fail(res, 400, 'No screenshot is available for this workflow or proposal yet');
    const result = await testScreenshot(candidate);
    if (candidate.proposal) {
      rememberVisualTest(candidate.proposal, result);
      persist();
      logActivity('visual-tester', `External screenshot test completed for ${candidate.proposal.workflowName}`, {
        proposalId: candidate.proposal.id,
        path: candidate.imagePath,
      });
    }
    sendJson(res, 200, { ok: true, result, proposal: candidate.proposal ? proposalView(candidate.proposal) : null });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/proposals\/([^/]+)\/visual-test$/, async (req, res, [id]) => {
  try {
    const proposal = findProposal(id);
    if (!proposal) return fail(res, 404, 'Proposal not found');
    const body = await readBody(req);
    const candidate = visualCandidate({ ...body, proposalId: id });
    if (!candidate.imagePath) return fail(res, 400, 'This proposal has no screenshot evidence to send');
    const result = await testScreenshot(candidate);
    rememberVisualTest(proposal, result);
    persist();
    logActivity('visual-tester', `External screenshot test completed for ${proposal.workflowName}`, {
      proposalId: proposal.id,
      path: candidate.imagePath,
    });
    sendJson(res, 200, { ok: true, result, proposal: proposalView(proposal) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/propose$/, async (req, res, [id]) => {
  try {
    const proposal = await createProposalForRun(id);
    sendJson(res, 200, { ok: true, proposal });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Link-triggered jobs ---------------- *//* ---------------- Allowlisted setup commands ---------------- */
// A fixed exe plus fixed arguments, run hidden with its output captured.
// A runTool step can name an entry; it can never supply or change an argument.
const SETUP_LIST_ROUTE = new RegExp('^/api/setup-commands$');
const SETUP_ONE_ROUTE = new RegExp('^/api/setup-commands/([^/]+)$');
const SETUP_RUN_ROUTE = new RegExp('^/api/setup-commands/([^/]+)/run$');

route('GET', SETUP_LIST_ROUTE, async (req, res) => {
  sendJson(res, 200, { ok: true, windows: IS_WINDOWS, commands: listSetupCommands() });
});

route('POST', SETUP_LIST_ROUTE, async (req, res) => {
  const body = await readBody(req);
  try {
    const command = addSetupCommand(body);
    sendJson(res, 200, { ok: true, command: { ...command, refusal: '' } });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('DELETE', SETUP_ONE_ROUTE, async (req, res, [id]) => {
  const removed = removeSetupCommand(id);
  if (!removed) return fail(res, 404, 'Setup command not found');
  sendJson(res, 200, { ok: true });
});

route('POST', SETUP_RUN_ROUTE, async (req, res, [id]) => {
  const entry = findSetupCommand(id);
  if (!entry) return fail(res, 404, 'Setup command not found');
  const result = await runSetupCommand(entry);
  logActivity('setup', setupSummary(entry, result), { commandId: entry.id });
  sendJson(res, 200, { ok: result.ok, result });
});


// The file in data/runner/inbox is the instruction; the link only names it.
// Starting one needs data/runner/token, so a page in a browser cannot run a
// queued workflow just by reaching the loopback port.

const JOB_ROUTE = new RegExp('^/api/runner/jobs$');
const JOB_ONE_ROUTE = new RegExp('^/api/runner/jobs/([^/]+)$');
const JOB_START_ROUTE = new RegExp('^/api/runner/jobs/([^/]+)/start$');
const JOB_APPROVE_ROUTE = new RegExp('^/api/runner/jobs/([^/]+)/approve$');

function presentedRunnerToken(req, url) {
  const header = String(req.headers?.['x-sightline-token'] || '');
  return header || String(url?.searchParams?.get('token') || '');
}

async function startLinkJob(req, res, id, url) {
  if (!verifyRunnerToken(presentedRunnerToken(req, url))) {
    return fail(res, 401, 'A local runner token is required.');
  }
  const job = readLinkJob(id);
  if (!job) return fail(res, 404, 'Job not found');
  const decision = jobDecision(job, { autoApprove: db().settings.linkAutoApprove === true });
  if (!decision.ok) {
    // The tab that followed the link needs to know whether to wait for an
    // operator or give up, so this refusal carries the flag itself.
    recordAction({
      kind: 'run',
      action: 'link-job-refused',
      error: decision.why,
      detail: { jobId: job.id, workflowId: job.workflowId, needsApproval: Boolean(decision.needsApproval) },
    });
    return sendJson(res, 409, {
      ok: false,
      error: decision.why,
      jobId: job.id,
      needsApproval: Boolean(decision.needsApproval),
      status: job.status,
    });
  }
  const wf = decision.workflow;
  const dryRun = job.mode !== 'live';
  if (!dryRun) {
    const control = liveControl();
    const proof = control.available ? await probeLiveBackend() : { ok: false, detail: control.reason };
    if (!control.available || !proof.ok) {
      return fail(res, 409, proof.detail || liveRefusal(), { jobId: job.id, needsApproval: false });
    }
  }
  let run;
  try {
    run = createRun(wf, { trigger: 'link', dryRun });
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const record = markLinkJob(job.id, {
    status: 'started',
    startedAt: now(),
    runId: run.id,
    via: decision.auto ? 'link:auto' : 'link:approved',
  });
  const suffix = decision.auto ? ' (auto-approved)' : '';
  logActivity('run', 'Link job started "' + wf.name + '"' + suffix, {
    workflowId: wf.id,
    jobId: job.id,
    runId: run.id,
  });
  sendJson(res, 200, { ok: true, run: findRun(run.id), job: record, autoApproved: Boolean(decision.auto) });
}

route('GET', JOB_ROUTE, async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    source: runnerSourceId(),
    autoApprove: db().settings.linkAutoApprove === true,
    jobs: listLinkJobs(20),
  });
});

route('POST', JOB_ROUTE, async (req, res) => {
  const body = await readBody(req);
  let job;
  try {
    job = queueLinkJob({ workflowId: body.workflowId, mode: body.mode || 'simulate', goal: body.goal });
  } catch (err) {
    return fail(res, 400, err.message);
  }
  logActivity('run', 'Queued link job for "' + job.workflowName + '"', {
    workflowId: job.workflowId,
    jobId: job.id,
  });
  sendJson(res, 200, {
    ok: true,
    job: readLinkJob(job.id),
    link: 'http://127.0.0.1:' + PORT + '/api/runner/jobs/' + job.id + '/start?token=' + runnerToken(),
  });
});

route('GET', JOB_ONE_ROUTE, async (req, res, [id]) => {
  const job = readLinkJob(id);
  if (!job) return fail(res, 404, 'Job not found');
  sendJson(res, 200, { ok: true, job });
});

route('POST', JOB_APPROVE_ROUTE, async (req, res, [id]) => {
  const out = approveJob(id);
  if (!out.ok) return fail(res, 400, out.why);
  logActivity('run', 'Approved link job ' + id, { jobId: id, workflowId: out.job.workflowId });
  sendJson(res, 200, { ok: true, job: out.job });
});

route('POST', JOB_START_ROUTE, async (req, res, [id], url) => startLinkJob(req, res, id, url));
// A background tab can only issue GET, so the same token-guarded start answers one.
route('GET', JOB_START_ROUTE, async (req, res, [id], url) => startLinkJob(req, res, id, url));

/* ---------------- Runs ---------------- */


route('POST', /^\/api\/workflows\/([^/]+)\/runs$/, async (req, res, [id]) => {
  const wf = db().workflows.find((w) => w.id === id);
  if (!wf) return fail(res, 404, 'Workflow not found');
  if (wf.status === 'archived') return fail(res, 400, 'Archived workflows cannot run');
  const body = await readBody(req);
  let dryRun = body.mode ? body.mode !== 'live' : Boolean(db().settings.dryRun);
  let liveFallback = null;
  if (!dryRun) {
    const control = liveControl();
    const proof = control.available ? await probeLiveBackend() : { ok: false, detail: control.reason };
    if (!control.available || !proof.ok) {
      const reason = proof.detail || liveRefusal();
      if (body.mode === 'live') return fail(res, 409, reason);
      dryRun = true;
      liveFallback = reason;
      const item = recordAction({ kind: 'run', action: `start-run:${wf.name}`, error: liveFallback, detail: { workflowId: wf.id, requestedMode: 'live' } });
      logActivity('run', `Live refused (${reason}); running simulated instead`, { workflowId: wf.id, itemId: item?.id });
    }
  }
  let autoPlan = null;
  try {
    autoPlan = await ensureWorkflowSteps(wf, body.goal || wf.description || wf.name);
  } catch (err) {
    return fail(res, 400, `Could not auto-create steps: ${err.message}`);
  }
  const run = createRun(wf, { trigger: body.trigger || 'manual', dryRun, liveFallback });
  sendJson(res, 200, { ok: true, run: findRun(run.id), autoPlan, liveFallback });
});

route('POST', /^\/api\/runs\/([^/]+)\/run-live$/, async (req, res, [id]) => {
  const previous = findRun(id);
  if (!previous) return fail(res, 404, 'Run not found');
  const wf = db().workflows.find((w) => w.id === previous.workflowId);
  if (!wf) return fail(res, 404, 'Workflow not found');
  if (wf.status === 'archived') return fail(res, 400, 'Archived workflows cannot run');
  if (!wf.steps?.length) return fail(res, 400, 'Workflow has no steps to run');
  // The operator accepted the "this machine can run it live" offer. Consent is
  // recorded on the new run only: the simulated run that raised the offer keeps
  // its own record of what actually happened.
  let run;
  try {
    run = createRun(wf, {
      trigger: 'manual',
      dryRun: false,
      liveConsent: true,
      workflowSnapshot: previous.workflowSnapshot || null,
    });
  } catch (err) {
    return fail(res, 400, err.message);
  }
  logActivity('run', `Operator accepted the live offer for "${wf.name}"`, { workflowId: wf.id, previousRunId: previous.id });
  sendJson(res, 200, { ok: true, run: findRun(run.id) });
});

route('GET', /^\/api\/runs\/([^/]+)$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  // A stored closeout may predate the screen review: fill it in from the run so
  // the closeout box shows the mismatch on every run, not only new ones.
  closeoutFor(run);
  sendJson(res, 200, { ok: true, run, recoveryPack: run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null });
});

// The reverse of a run's screen-changing click, drafted when the workflow declared
// no hand-off. Accepting only saves the drafted steps as the workflow's hand-off
// and turns it on; the draft never executes anything on its own, and dismissing
// it is recorded on the run so the panel stops offering it.
route('POST', /^\/api\/runs\/([^/]+)\/handoff-suggestion$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const suggestion = run.handoffSuggestion;
  if (!suggestion) return fail(res, 400, 'This run has no hand-off draft');
  if (suggestion.acceptedAt) return fail(res, 400, 'This draft was already accepted');
  const body = await readBody(req);
  const action = String(body.action || 'accept').toLowerCase();
  if (action === 'dismiss') {
    suggestion.dismissedAt = now();
    persist();
    return sendJson(res, 200, { ok: true, run });
  }
  if (action !== 'accept') return fail(res, 400, 'action must be accept or dismiss');
  const steps = Array.isArray(suggestion.steps) ? suggestion.steps.filter((step) => step?.type) : [];
  if (!steps.length) return fail(res, 400, 'The draft has no steps to accept');
  const wf = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!wf) return fail(res, 404, 'Workflow not found');
  const updated = updateWorkflow(wf.id, { handoff: { enabled: true, steps } });
  suggestion.acceptedAt = now();
  persist();
  logActivity('workflow', `Accepted the suggested hand-off for "${wf.name}"`, { runId: run.id, workflowId: wf.id });
  sendJson(res, 200, { ok: true, run, workflow: workflowView(updated) });
});

route('POST', /^\/api\/runs\/([^/]+)\/simulate$/, async (req, res, [id]) => {
  try {
    const record = startSimulation(id);
    sendJson(res, 200, { ok: true, simulation: simulationSummary(record) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/runs\/([^/]+)\/simulations$/, async (req, res, [id]) => {
  const simulations = listSimulations(id, 5).map(simulationSummary);
  sendJson(res, 200, { ok: true, simulations });
});

route('GET', /^\/api\/simulations\/([^/]+)$/, async (req, res, [id]) => {
  const record = findSimulation(id);
  if (!record) return fail(res, 404, 'Simulation not found');
  sendJson(res, 200, { ok: true, simulation: simulationSummary(record) });
});

// One review per run: step breakdown sorted by risk/phase, cross-reference with
// the steps that worked before, the alternate-environment replication, and the
// immediate vs long-term app suggestions. Read-only and derived from records.
route('GET', /^\/api\/runs\/([^/]+)\/review$/, async (req, res, [id], url) => {
  res.setHeader('Cache-Control', 'no-store');
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const sort = String(url.searchParams.get('sort') || 'risk');
  if (!TEST_REVIEW_SORTS.includes(sort)) {
    return fail(res, 400, `sort must be one of ${TEST_REVIEW_SORTS.join(', ')}`);
  }
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId) || null;
  if (!Array.isArray(db().workflowMemory) || !db().workflowMemory.length) backfillWorkflowMemory();
  const review = buildTestReview({
    run,
    workflow,
    episodes: db().workflowMemory || [],
    simulation: listSimulations(run.id, 1)[0] || null,
    sort,
    longTermGoal: db().settings?.longTermGoal || '',
  });
  sendJson(res, 200, { ok: true, review });
});

route('POST', /^\/api\/runs\/([^/]+)\/replicate$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  let body = {};
  try {
    body = (await readBody(req)) || {};
  } catch {
    body = {};
  }
  sendJson(res, 200, { ok: true, replication: replicateRun({ run, env: body.env || body }) });
});

// Only stored records are reviewed; monitor events are global, not run-correlated.
route('GET', /^\/api\/observation-review$/, async (req, res, _params, url) => {
  res.setHeader('Cache-Control', 'no-store');
  const params = url.searchParams;
  const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  if ([...params.keys()].some((key) => !['simulationId', 'proposalId'].includes(key)) ||
      params.getAll('simulationId').length !== 1 || params.getAll('proposalId').length > 1 ||
      !validId(params.get('simulationId')) || (params.has('proposalId') && !validId(params.get('proposalId')))) {
    return fail(res, 400, 'A valid simulationId and optional proposalId are required');
  }
  const simulation = findSimulation(params.get('simulationId'));
  if (!simulation) return fail(res, 404, 'Simulation not found');
  const proposal = params.has('proposalId') ? findProposal(params.get('proposalId')) : null;
  if (params.has('proposalId') && !proposal) return fail(res, 404, 'Proposal not found');
  if (proposal && (!simulation.workflowId || !proposal.workflowId || simulation.workflowId !== proposal.workflowId)) {
    return fail(res, 409, 'Simulation and proposal must belong to the same workflow');
  }
  sendJson(res, 200, { ok: true, ...prepareObservationReview({ monitor: monitorState(), simulation, proposal }) });
});

route('POST', /^\/api\/runs\/([^/]+)\/verify-silent$/, async (req, res, [id]) => {
  try {
    const result = await verifyRunSilently(id);
    if (!result.ok) return fail(res, 404, result.error || 'Run not found');
    sendJson(res, 200, { ok: true, results: result.results, remaining: result.remaining, run: result.run });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/cancel$/, async (req, res, [id]) => {
  const run = cancelRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  sendJson(res, 200, { ok: true, run });
});

route('POST', /^\/api\/runs\/([^/]+)\/control$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const run = controlRun(id, body.action);
    sendJson(res, 200, { ok: true, run });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/retry$/, async (req, res, [id]) => {
  try {
    const run = await retryRun(id);
    sendJson(res, 200, { ok: true, run, replanned: Boolean(run.replanned) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

// Re-read a finished run: completed steps are kept and the failed/stalled ones
// are checked again with a fresh screenshot. Continue-after is a setting, and a
// request can ask for it per run.
route('POST', /^\/api\/runs\/([^/]+)\/recheck$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const run = await recheckRun(decodeURIComponent(id), {
      continueAfter: body?.continueAfter === undefined ? null : Boolean(body.continueAfter),
    });
    sendJson(res, 200, { ok: true, run, recheck: run.recheck });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/replan-retry$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const original = findRun(decodeURIComponent(id));
    if (!original) return fail(res, 404, 'Run not found');
    if (['queued', 'running'].includes(original.status)) {
      return fail(res, 409, 'This run is still running; replan it after it finishes.');
    }
    reconcileStuckReplans({ live: replanning });
    if (replanning.has(original.id) || original.replan?.status === 'planning') {
      return fail(res, 409, 'Re-planning this run is already in progress.');
    }
    const dryRun = body.dryRun === undefined ? Boolean(db().settings.dryRun) : Boolean(body.dryRun);
    const replan = startReplanRetry(original, { dryRun });
    // Planning reads the desktop, runs the planner and the model and shadow-tests
    // every candidate, which can take most of a minute. The request is answered
    // now and `run.replan` reports the outcome when it lands.
    sendJson(res, 202, {
      ok: true,
      planning: true,
      retried: false,
      runId: original.id,
      packId: original.recoveryPackId || replan?.packId || null,
      replan,
      reason: 'Re-planning in the background. Follow the run to see the tested plan and its retry.',
    });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/analyze$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const analysis = await analyzeRun(run);
  run.analysis = analysis;
  if (analysis.suggestedSteps?.length) {
    for (const s of analysis.suggestedSteps) {
      addSuggestion(`Add "${s.name}" (${s.type}) to ${run.workflowName}.`, 'failure', run.workflowId, run.id);
    }
  }
  persist();
  sendJson(res, 200, { ok: true, analysis });
});

route('POST', /^\/api\/runs\/([^/]+)\/apply-suggestions$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  try {
    // The button and the automatic pass share one implementation, so both apply
    // the same filter and leave the same record on the run.
    const applied = applyAnalysisSteps(run);
    const wf = db().workflows.find((w) => w.id === applied.workflowId);
    sendJson(res, 200, { ok: true, workflow: workflowView(wf) });
  } catch (err) {
    fail(res, err.message === 'Workflow not found' ? 404 : 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/review$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const body = await readBody(req);
  const status = body.status === 'reviewed' ? 'reviewed' : 'unreviewed';
  run.review = { status, comment: String(body.comment || '').slice(0, 2000), at: now() };
  if (status === 'reviewed') run.triageDone = true;
  persist();
  if (body.comment) {
    writeRunNote(run);
    logActivity('review', `Review note added to ${run.workflowName}`, { runId: run.id });
  }
  sendJson(res, 200, { ok: true, run });
});

route('POST', /^\/api\/runs\/([^/]+)\/capture$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const body = await readBody(req);
  const step = {
    id: uid('ev'),
    type: 'screenshot',
    name: 'Manual evidence capture',
    params: { caption: body.caption || 'Reviewer capture' },
  };
  try {
    const result = await executeStep(step, {
      live: !run.dryRun,
      runId: run.id,
      run,
      workflow: db().workflows.find((w) => w.id === run.workflowId),
      getTool: (tid) => db().tools.find((t) => t.id === tid),
    });
    for (const ev of result.evidence || []) {
      run.evidence.push({
        id: uid('evd'),
        kind: ev.kind,
        caption: ev.caption,
        path: ev.path,
        simulated: ev.simulated,
        width: ev.width || null,
        height: ev.height || null,
        stepId: null,
        createdAt: now(),
      });
    }
    persist();
    sendJson(res, 200, { ok: true, run });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('GET', /^\/api\/judgement$/, async (req, res) => {
  sendJson(res, 200, { ok: true, judgement: judgementSummary(db().settings) });
});

// The operator's switch between the two judges; the learned habits stay as
// suggestions in GET /api/judgement until one is accepted here.
route('POST', /^\/api\/judgement\/mode$/, async (req, res) => {
  const body = await readBody(req);
  if (!JUDGE_MODES.includes(body.mode)) return fail(res, 400, `Unknown judge mode: ${body.mode}`);
  db().settings.verifyJudgeMode = body.mode;
  persist();
  logActivity('judgement', `Screen judgement mode set to ${body.mode}`);
  sendJson(res, 200, { ok: true, judgement: judgementSummary(db().settings) });
});

route('POST', /^\/api\/judgement\/reviews\/([^/]+)\/(accept|dismiss)$/, async (req, res, [id, action]) => {
  try {
    const review = resolveJudgementReview(decodeURIComponent(id), action);
    sendJson(res, 200, { ok: true, review, judgement: judgementSummary(db().settings) });
  } catch (err) {
    fail(res, 404, err.message);
  }
});

route('GET', /^\/api\/recovery-packs$/, async (req, res, _params, url) => {
  const workflowId = url.searchParams.get('workflowId') || '';
  const packs = listRecoveryPacks(url.searchParams.get('limit') || 30).filter((pack) => !workflowId || pack.workflowId === workflowId);
  sendJson(res, 200, { ok: true, packs });
});

// Per-stage planning costs and revision-to-outcome results: the ledger behind
// "does the AI candidate beat the fresh rebuild, and what does it cost?".
route('GET', /^\/api\/recovery-telemetry$/, async (req, res, _params, url) => {
  sendJson(res, 200, {
    ok: true,
    ...recoveryTelemetrySummary(),
    recent: listRecoveryTelemetry(url.searchParams.get('limit') || 20),
  });
});

route('GET', /^\/api\/presenter$/, async (req, res) => {
  sendJson(res, 200, { ok: true, presenter: activePresenter(), positions: listPositionMemory(12) });
});

route('GET', /^\/api\/positions$/, async (req, res, _params, url) => {
  sendJson(res, 200, { ok: true, positions: listPositionMemory(url.searchParams.get('limit') || 30) });
});

route('POST', /^\/api\/runs\/([^/]+)\/presenter$/, async (req, res, [id]) => {
  const run = findRun(decodeURIComponent(id));
  if (!run) return fail(res, 404, 'Run not found');
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId) || null;
  try {
    const body = await readBody(req);
    const presenter = presenterUserInput(run, workflow, { message: body.message || '', action: body.action || 'guide' });
    sendJson(res, 200, { ok: true, presenter, run });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('GET', /^\/api\/recovery-packs\/([^/]+)$/, async (req, res, [id]) => {
  const pack = findRecoveryPack(decodeURIComponent(id));
  if (!pack) return fail(res, 404, 'Recovery pack not found');
  sendJson(res, 200, { ok: true, pack });
});

route('POST', /^\/api\/recovery-packs\/([^/]+)\/apply$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const result = applyRecoveryPack(decodeURIComponent(id), {
      candidateId: body.candidateId || null,
      by: 'operator',
    });
    sendJson(res, 200, { ok: true, pack: result.pack, workflow: result.workflow });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/recovery-packs\/([^/]+)\/retry$/, async (req, res, [id]) => {
  try {
    const body = await readBody(req);
    const pack = findRecoveryPack(decodeURIComponent(id));
    if (!pack) return fail(res, 404, 'Recovery pack not found');
    const chosen = (pack.candidates || []).find((candidate) => candidate.id === (body.candidateId || pack.selectedCandidateId));
    if (!chosen) return fail(res, 400, 'No selected recovery candidate');
    const workflow = db().workflows.find((entry) => entry.id === pack.workflowId);
    if (!workflow) return fail(res, 404, 'Workflow for this recovery pack no longer exists');
    const snapshot = recoverySnapshotFromPack(pack, workflow, body.candidateId || pack.selectedCandidateId);
    if (!snapshot) return fail(res, 400, 'No selected recovery candidate');
    const original = findRun(pack.originalRunId);
    if (!original) return fail(res, 404, 'Original run for this recovery pack no longer exists');
    const dryRun = body.dryRun === undefined ? Boolean(db().settings.dryRun) : Boolean(body.dryRun);
    const run = queueRecoveryRetry(original, pack, snapshot, { source: 'operator', dryRun });
    if (!run) return fail(res, 409, RECOVERY_REPEAT);
    sendJson(res, 200, { ok: true, pack, run: summary(run) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/recovery-packs\/([^/]+)\/replan$/, async (req, res, [id]) => {
  try {
    const pack = findRecoveryPack(decodeURIComponent(id));
    if (!pack) return fail(res, 404, 'Recovery pack not found');
    if (pack.retryRunId) return fail(res, 409, 'This recovery pack already produced a retry; start a new review from the failed run.');
    const original = findRun(pack.originalRunId);
    if (!original) return fail(res, 404, 'Original run for this recovery pack no longer exists');
    const outcome = await prepareRecovery(original, { force: true });
    const next = outcome?.pack || null;
    if (!next) return fail(res, 409, 'Recovery planning did not produce a pack. The previous pack is unchanged.');
    if (next.id !== pack.id) {
      pack.status = 'superseded';
      pack.updatedAt = now();
      pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
      pack.logs.unshift({ at: now(), level: 'info', stage: 'plan', message: `Replanned as ${next.id}; no retry was approved.` });
      persist();
    }
    const candidates = (next.candidates || []).map(recoveryCandidateView);
    sendJson(res, 200, {
      ok: true,
      requiresApproval: true,
      runId: original.id,
      packId: next.id,
      packStatus: next.status,
      candidateId: next.selectedCandidateId || candidates.find((candidate) => candidate.test.ok)?.id || null,
      candidates,
      continuity: continuityState(),
    });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/runs\/([^/]+)\/forward$/, async (req, res, [id]) => {
  const run = findRun(id);
  if (!run) return fail(res, 404, 'Run not found');
  const body = await readBody(req);
  if (run.status !== 'failed' && run.status !== 'needs_review') {
    return fail(res, 400, 'Only failed or needs-review runs can be forwarded.');
  }
  try {
    const mission = forwardRunToControlCenter(run, { auto: false });
    if (body.start !== false && mission.status === 'queued') startMission(mission.id);
    sendJson(res, 200, { ok: true, mission: findMission(mission.id) });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Element links ---------------- */
route('GET', /^\/api\/element-links$/, async (req, res) => {
  sendJson(res, 200, { ok: true, links: db().elementLinks || [] });
});

route('POST', /^\/api\/element-links\/pick$/, async (req, res) => {
  if (!IS_WINDOWS) return fail(res, 400, 'Focused element inspection requires Windows UI Automation');
  try {
    const el = await readFocusedElement();
    if (!el.found) return fail(res, 409, `Nothing usable is focused: ${el.reason || 'focus a labelled control'}`);
    if (!el.window) return fail(res, 409, 'The focused control has no usable window title');
    if (/screen agent console/i.test(el.window) || /^(node|electron|freebuff)$/i.test(el.process)) {
      return fail(res, 409, 'That is the Sightline console. Switch to the target app, focus the control, then pick again.');
    }
    sendJson(res, 200, { ok: true, ...el });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/element-links$/, async (req, res) => {
  const body = await readBody(req);
  const label = String(body.label || '').trim().slice(0, 120);
  const name = String(body.name || '').trim().slice(0, 240);
  const window = String(body.window || '').trim().slice(0, 160);
  if (!name || !window) return fail(res, 400, 'Element name and window title are required');
  const workflow = db().workflows.find((entry) => entry.id === body.workflowId);
  if (!workflow) return fail(res, 404, 'Workflow not found');
  if (!workflow.steps?.length) return fail(res, 400, 'The linked workflow has no steps');
  const link = {
    id: uid('lnk'),
    label: label || name,
    name,
    window,
    controlType: String(body.controlType || '').trim().slice(0, 80),
    workflowId: workflow.id,
    action: body.action === 'run' ? 'run' : 'mission',
    mode: body.mode === 'suggest' ? 'suggest' : 'auto',
    goal: String(body.goal || '').slice(0, 2000),
    cooldownMs: Math.max(5000, Math.min(3600000, Number(body.cooldownMs) || 60000)),
    enabled: body.enabled !== false,
    present: false,
    triggerCount: 0,
    lastSeenAt: null,
    lastTriggeredAt: null,
    lastMatch: null,
    createdAt: now(),
  };
  if (!Array.isArray(db().elementLinks)) db().elementLinks = [];
  db().elementLinks.push(link);
  persist();
  logActivity('element', `Linked “${link.label}” to ${workflow.name}`, { linkId: link.id, workflowId: workflow.id });
  sendJson(res, 200, { ok: true, link });
});

route('PATCH', /^\/api\/element-links\/([^/]+)$/, async (req, res, [id]) => {
  const link = (db().elementLinks || []).find((entry) => entry.id === id);
  if (!link) return fail(res, 404, 'Element link not found');
  const body = await readBody(req);
  if (body.label !== undefined) link.label = String(body.label).slice(0, 120);
  if (body.name !== undefined) link.name = String(body.name).trim().slice(0, 240);
  if (body.window !== undefined) link.window = String(body.window).trim().slice(0, 160);
  if (body.controlType !== undefined) link.controlType = String(body.controlType).trim().slice(0, 80);
  if (body.goal !== undefined) link.goal = String(body.goal).slice(0, 2000);
  if (body.action !== undefined) link.action = body.action === 'run' ? 'run' : 'mission';
  if (body.mode !== undefined) link.mode = body.mode === 'suggest' ? 'suggest' : 'auto';
  if (body.enabled !== undefined) link.enabled = Boolean(body.enabled);
  if (body.cooldownMs !== undefined) link.cooldownMs = Math.max(5000, Math.min(3600000, Number(body.cooldownMs) || 60000));
  if (body.workflowId !== undefined) {
    const workflow = db().workflows.find((entry) => entry.id === body.workflowId);
    if (!workflow) return fail(res, 404, 'Workflow not found');
    link.workflowId = workflow.id;
  }
  if (!link.name || !link.window) return fail(res, 400, 'Element name and window title are required');
  persist();
  sendJson(res, 200, { ok: true, link });
});

route('DELETE', /^\/api\/element-links\/([^/]+)$/, async (req, res, [id]) => {
  const index = (db().elementLinks || []).findIndex((entry) => entry.id === id);
  if (index < 0) return fail(res, 404, 'Element link not found');
  db().elementLinks.splice(index, 1);
  elementPresence.delete(id);
  persist();
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/element-links\/([^/]+)\/scan$/, async (req, res, [id]) => {
  const link = (db().elementLinks || []).find((entry) => entry.id === id);
  if (!link) return fail(res, 404, 'Element link not found');
  if (!IS_WINDOWS) return fail(res, 400, 'Element detection requires Windows UI Automation');
  try {
    const match = await findUiElement({ window: link.window, name: link.name, controlType: link.controlType });
    link.present = match.found;
    if (match.found) link.lastSeenAt = now();
    elementPresence.set(link.id, match.found);
    persist();
    sendJson(res, 200, { ok: true, ...match });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/element-links\/([^/]+)\/trigger$/, async (req, res, [id]) => {
  const link = (db().elementLinks || []).find((entry) => entry.id === id);
  if (!link) return fail(res, 404, 'Element link not found');
  try {
    let match = null;
    if (IS_WINDOWS) {
      const found = await findUiElement({ window: link.window, name: link.name, controlType: link.controlType });
      if (!found.found) return fail(res, 409, `Element not present: ${link.name} in ${link.window}`);
      match = found;
    }
    const result = triggerElementLink(link, { el: match });
    sendJson(res, 200, { ok: true, ...result, link });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

/* ---------------- Captures ---------------- */
function marksForScreenshot(evidence, run = null) {
  if (Array.isArray(evidence?.marks)) return normalizeMarks(evidence.marks);
  return normalizeMarks(stepMarks(run, evidence));
}

function findCaptureRecord(id) {
  const d = db();
  const manual = (d.captures || []).find((capture) => capture.id === id);
  if (manual) return { kind: 'manual', record: manual, run: null, evidence: manual };
  for (const run of d.runs) {
    const evidence = (run.evidence || []).find((entry) => entry.id === id);
    if (evidence) return { kind: 'run', record: evidence, run, evidence };
  }
  return null;
}

function captureView(found) {
  if (!found) return null;
  const { record, run, kind, evidence } = found;
  if (kind === 'manual') {
    return { ...record, source: 'manual', marks: marksForScreenshot(record) };
  }
  return {
    ...evidence,
    source: 'run',
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    stepName: (run.steps || []).find((step) => step.id === evidence.stepId)?.name || null,
    marks: marksForScreenshot(evidence, run),
  };
}

route('GET', /^\/api\/captures$/, async (req, res) => {
  const d = db();
  const fromRuns = [];
  for (const run of d.runs) {
    for (const e of run.evidence || []) {
      if (e.kind !== 'screenshot') continue;
      fromRuns.push({
        id: e.id,
        caption: e.caption,
        path: e.path,
        simulated: e.simulated,
        width: e.width,
        height: e.height,
        createdAt: e.createdAt,
        runId: run.id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        stepId: e.stepId,
        stepName: run.steps.find((s) => s.id === e.stepId)?.name || null,
        source: 'run',
        marks: marksForScreenshot(e, run),
      });
    }
  }
  const adhoc = (d.captures || []).map((c) => ({ ...c, source: 'manual' }));
  const all = [...fromRuns, ...adhoc].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  sendJson(res, 200, { ok: true, captures: all.slice(0, 120) });
});

route('GET', /^\/api\/captures\/([^/]+)$/, async (req, res, [id]) => {
  const capture = captureView(findCaptureRecord(decodeURIComponent(id)));
  if (!capture) return fail(res, 404, 'Capture not found');
  sendJson(res, 200, { ok: true, capture });
});

route('PATCH', /^\/api\/captures\/([^/]+)$/, async (req, res, [id]) => {
  const body = await readBody(req);
  if (!Array.isArray(body.marks)) return fail(res, 400, 'Provide a marks array');
  const found = findCaptureRecord(decodeURIComponent(id));
  if (!found) return fail(res, 404, 'Capture not found');
  const marks = normalizeMarks(body.marks);
  found.record.marks = marks;
  persist();
  logActivity('capture', `Updated ${marks.length} screenshot mark(s)`, {
    captureId: found.record.id,
    path: found.record.path,
  });
  sendJson(res, 200, { ok: true, capture: captureView(found) });
});

route('POST', /^\/api\/captures$/, async (req, res) => {
  const body = await readBody(req);
  const live = body.mode ? body.mode === 'live' : !db().settings.dryRun;
  const step = {
    id: uid('cap'),
    type: 'screenshot',
    name: 'Manual capture',
    params: { caption: body.caption || 'Manual capture' },
    timeoutMs: 20000,
  };
  try {
    const result = await executeStep(step, {
      live,
      runId: null,
      run: { id: 'manual' },
      workflow: null,
      getTool: (tid) => db().tools.find((t) => t.id === tid),
    });
    const ev = result.evidence[0];
    const record = captureRecord(ev, body.caption || 'Manual capture', {
      mode: live ? 'live' : 'simulated',
      missionId: body.missionId ? String(body.missionId) : null,
    });
    logActivity('capture', `Manual ${live ? 'live' : 'simulated'} capture`);
    sendJson(res, 200, { ok: true, capture: record });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('DELETE', /^\/api\/captures\/([^/]+)$/, async (req, res, [id]) => {
  const d = db();
  const adhocIdx = (d.captures || []).findIndex((c) => c.id === id);
  if (adhocIdx >= 0) {
    const [cap] = d.captures.splice(adhocIdx, 1);
    removeFile(cap.path);
    persist();
    return sendJson(res, 200, { ok: true });
  }
  for (const run of d.runs) {
    const idx = (run.evidence || []).findIndex((e) => e.id === id);
    if (idx >= 0) {
      const [ev] = run.evidence.splice(idx, 1);
      removeFile(ev.path);
      persist();
      return sendJson(res, 200, { ok: true });
    }
  }
  fail(res, 404, 'Capture not found');
});

function removeFile(relPath) {
  if (!relPath) return;
  const full = resolveInside(DATA, relPath);
  if (full && fs.existsSync(full)) {
    try {
      fs.unlinkSync(full);
    } catch {}
  }
}

/* ---------------- Tools ---------------- */
route('GET', /^\/api\/tools$/, async (req, res) => sendJson(res, 200, { ok: true, tools: db().tools }));

route('POST', /^\/api\/tools$/, async (req, res) => {
  const body = await readBody(req);
  const name = String(body.name || 'Untitled tool').slice(0, 90);
  const code = String(body.code || '').trim();
  if (!code) return fail(res, 400, 'Tool code is required');
  const tool = {
    id: uid('tool'),
    name,
    description: String(body.description || '').slice(0, 500),
    kind: 'powershell',
    code,
    status: body.status === 'approved' ? 'approved' : 'draft',
    createdBy: body.createdBy === 'ai' ? 'ai' : 'human',
    createdAt: now(),
    usage: [],
  };
  const file = path.join(TOOLS, `${slug(name)}-${tool.id}.ps1`);
  writeFileDurable(file, code);
  tool.file = path.relative(ROOT, file).split(path.sep).join('/');
  db().tools.unshift(tool);
  persist();
  logActivity('tool', `Created tool "${name}" (${tool.status})`);
  sendJson(res, 200, { ok: true, tool });
});

route('PATCH', /^\/api\/tools\/([^/]+)$/, async (req, res, [id]) => {
  const tool = db().tools.find((t) => t.id === id);
  if (!tool) return fail(res, 404, 'Tool not found');
  const body = await readBody(req);
  if (body.name !== undefined) tool.name = String(body.name).slice(0, 90);
  if (body.description !== undefined) tool.description = String(body.description).slice(0, 500);
  if (body.code !== undefined) {
    tool.code = String(body.code);
    const file = path.join(TOOLS, `${slug(tool.name)}-${tool.id}.ps1`);
    writeFileDurable(file, tool.code);
    tool.file = path.relative(ROOT, file).split(path.sep).join('/');
  }
  if (body.status !== undefined) {
    if (!['draft', 'approved', 'disabled'].includes(body.status)) return fail(res, 400, 'Invalid tool status');
    tool.status = body.status;
  }
  persist();
  sendJson(res, 200, { ok: true, tool });
});

route('DELETE', /^\/api\/tools\/([^/]+)$/, async (req, res, [id]) => {
  const d = db();
  const idx = d.tools.findIndex((t) => t.id === id);
  if (idx === -1) return fail(res, 404, 'Tool not found');
  const [tool] = d.tools.splice(idx, 1);
  if (tool.file) {
    const full = path.join(ROOT, tool.file);
    if (fs.existsSync(full)) {
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  }
  persist();
  logActivity('tool', `Deleted tool "${tool.name}"`);
  sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/tools\/([^/]+)\/run$/, async (req, res, [id]) => {
  const tool = db().tools.find((t) => t.id === id);
  if (!tool) return fail(res, 404, 'Tool not found');
  const settings = db().settings;
  if (settings.requireToolApproval && tool.status !== 'approved') {
    return fail(res, 400, 'This tool is not approved yet. Approve it before running.');
  }
  if (!IS_WINDOWS) return fail(res, 400, 'PowerShell tool execution requires Windows');
  const started = Date.now();
  const result = await runPowerShell(tool.code, 60000);
  const entry = {
    at: now(),
    ok: result.ok,
    ms: Date.now() - started,
    output: String(result.stdout || result.stderr || '').slice(0, 2000),
    trigger: 'manual',
  };
  tool.usage.unshift(entry);
  tool.usage = tool.usage.slice(0, 40);
  persist();
  recordUsage({ kind: 'tool', model: tool.name, ok: result.ok, ms: entry.ms, prompt: tool.description.slice(0, 160), reply: entry.output.slice(0, 200) });
  logActivity('tool', `Ran tool "${tool.name}" — ${result.ok ? 'ok' : 'failed'}`, { toolId: tool.id });
  sendJson(res, 200, { ok: true, result, tool });
});

route('POST', /^\/api\/tools\/generate$/, async (req, res) => {
  const body = await readBody(req);
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return fail(res, 400, 'Describe the tool you need');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You write small, safe PowerShell 5.1 helper scripts for a Windows desktop automation console. ' +
          'Prefer read-only inspection commands. Never delete files, never change system settings, never touch credentials or the registry. ' +
          'Reply with JSON only: {"name":"...","description":"...","code":"...","risk":"low|medium"}. ' +
          'The script must be non-interactive and print its result to stdout. Captures folder is available as $env:CB_DATA.',
      },
      { role: 'user', content: prompt },
    ],
    { format: 'json', kind: 'toolgen', timeoutMs: 90000, temperature: 0.2 }
  );
  if (!reply.ok) return fail(res, 502, `AI unavailable: ${reply.error}`);
  const parsed = parseJsonLoose(reply.content);
  if (!parsed || !parsed.code) return fail(res, 502, 'AI did not return a usable script');
  const name = String(parsed.name || 'AI tool').slice(0, 90);
  const tool = {
    id: uid('tool'),
    name,
    description: String(parsed.description || prompt).slice(0, 500),
    kind: 'powershell',
    code: String(parsed.code),
    status: 'draft',
    createdBy: 'ai',
    risk: ['low', 'medium'].includes(parsed.risk) ? parsed.risk : 'medium',
    createdAt: now(),
    usage: [],
  };
  const file = path.join(TOOLS, `${slug(name)}-${tool.id}.ps1`);
  writeFileDurable(file, tool.code);
  tool.file = path.relative(ROOT, file).split(path.sep).join('/');
  db().tools.unshift(tool);
  persist();
  logActivity('tool', `AI created tool "${name}" (draft — needs approval)`);
  sendJson(res, 200, { ok: true, tool });
});

/* ---------------- Notes & files ---------------- */
route('GET', /^\/api\/notes$/, async (req, res) =>
  sendJson(res, 200, { ok: true, notes: db().notes })
);

route('POST', /^\/api\/notes$/, async (req, res) => {
  const body = await readBody(req);
  const title = String(body.title || 'Untitled note').slice(0, 120);
  const text = String(body.body || '');
  const file = path.join(NOTES, `${slug(title)}-${Date.now().toString(36)}.md`);
  writeFileDurable(file, `# ${title}\n\n${text}\n`);
  const note = {
    id: uid('note'),
    title,
    body: `# ${title}\n\n${text}\n`,
    file: path.relative(ROOT, file).split(path.sep).join('/'),
    source: 'manual',
    tags: ['manual'],
    createdAt: now(),
  };
  db().notes.unshift(note);
  persist();
  logActivity('note', `Note created: ${title}`);
  sendJson(res, 200, { ok: true, note });
});

route('PATCH', /^\/api\/notes\/([^/]+)$/, async (req, res, [id]) => {
  const note = db().notes.find((n) => n.id === id);
  if (!note) return fail(res, 404, 'Note not found');
  const body = await readBody(req);
  if (body.title !== undefined) note.title = String(body.title).slice(0, 120);
  if (body.body !== undefined) note.body = String(body.body);
  if (note.file) {
    const full = path.join(ROOT, note.file);
    if (full.startsWith(NOTES)) writeFileDurable(full, note.body);
  }
  persist();
  sendJson(res, 200, { ok: true, note });
});

route('DELETE', /^\/api\/notes\/([^/]+)$/, async (req, res, [id]) => {
  const d = db();
  const idx = d.notes.findIndex((n) => n.id === id);
  if (idx === -1) return fail(res, 404, 'Note not found');
  const [note] = d.notes.splice(idx, 1);
  if (note.file) {
    const full = resolveInside(ROOT, note.file);
    if (full && fs.existsSync(full)) {
      try {
        fs.unlinkSync(full);
      } catch {}
    }
  }
  persist();
  sendJson(res, 200, { ok: true });
});

function pythonPurpose(code) {
  const match = String(code).match(/"""([\s\S]*?)"""/);
  if (!match) return '';
  const first = match[1]
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return (first || '').slice(0, 200);
}

function pythonFileView(name) {
  const file = path.join(PYTHON, name);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  const code = fs.readFileSync(file, 'utf8');
  return {
    name,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    purpose: pythonPurpose(code),
    lines: code.split('\n').length,
    code,
    path: `python/${name}`,
  };
}

route('GET', /^\/api\/python$/, async (req, res) => {
  const files = fs
    .readdirSync(PYTHON)
    .filter((name) => name.toLowerCase().endsWith('.py'))
    .map(pythonFileView)
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, { ok: true, files });
});

route('POST', /^\/api\/python$/, async (req, res) => {
  const body = await readBody(req);
  const name = String(body.name || '').trim();
  if (!/^[A-Za-z0-9_.-]+\.py$/.test(name)) return fail(res, 400, 'File name must end in .py and contain no path separators');
  const target = path.join(PYTHON, name);
  if (fs.existsSync(target) && !body.overwrite) return fail(res, 409, 'A Python file with that name already exists');
  writeFileDurable(target, String(body.code || ''));
  persist();
  logActivity('python', `Saved Python file ${name}`);
  sendJson(res, 200, { ok: true, file: pythonFileView(name) });
});

route('DELETE', /^\/api\/python\/([^/]+)$/, async (req, res, [name]) => {
  if (!/^[A-Za-z0-9_.-]+\.py$/.test(name)) return fail(res, 400, 'Invalid file name');
  const target = path.join(PYTHON, name);
  if (!fs.existsSync(target)) return fail(res, 404, 'Python file not found');
  fs.unlinkSync(target);
  logActivity('python', `Deleted Python file ${name}`);
  sendJson(res, 200, { ok: true });
});

route('GET', /^\/api\/python\/([^/]+)\/download$/, async (req, res, [name]) => {
  if (!/^[A-Za-z0-9_.-]+\.py$/.test(name)) return fail(res, 400, 'Invalid file name');
  const target = path.join(PYTHON, name);
  if (!fs.existsSync(target)) return fail(res, 404, 'Python file not found');
  res.writeHead(200, {
    'Content-Type': 'text/x-python; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
});

route('GET', /^\/api\/files$/, async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    files: listFiles(DATA),
    roots: [
      { label: 'Data', path: 'data' },
      { label: 'Captures', path: 'data/captures' },
      { label: 'Notes', path: 'data/notes' },
      { label: 'Tools', path: 'data/tools' },
    ],
  });
});

route('GET', /^\/api\/files\/raw$/, async (req, res, _params, url) => {
  const rel = url.searchParams.get('path') || '';
  const full = resolveInside(DATA, rel);
  if (!full) return fail(res, 404, 'File not found');
  try {
    if (!fs.statSync(full).isFile()) return fail(res, 404, 'File not found');
  } catch {
    return fail(res, 404, 'File not found');
  }
  const stream = fs.createReadStream(full);
  stream.once('error', () => {
    if (!res.headersSent) fail(res, 404, 'File not found');
    else res.destroy();
  });
  stream.once('open', () => {
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    });
    stream.pipe(res);
  });
  res.once('close', () => stream.destroy());
});

route('GET', /^\/api\/files\/read$/, async (req, res, _params, url) => {
  const rel = String(url.searchParams.get('path') || '').trim();
  const full = resolveInside(DATA, rel);
  if (!full) return fail(res, 400, 'Invalid file path');
  try {
    const chunk = readTextChunk(full, url.searchParams.get('offset'), url.searchParams.get('maxTokens'));
    sendJson(res, 200, { ok: true, path: rel, ...chunk });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

route('POST', /^\/api\/files\/write$/, async (req, res) => {
  const body = await readBody(req);
  const rel = String(body.path || '').trim().replace(/\\/g, '/');
  if (!rel) return fail(res, 400, 'File path is required');
  if (rel === 'db.json' || rel === 'conversation_history.txt' || rel.includes('..')) {
    return fail(res, 400, 'That file is managed by the console and cannot be edited here');
  }
  const full = resolveInside(DATA, rel);
  if (!full) return fail(res, 400, 'Invalid file path');
  if (!isTextFile(full)) return fail(res, 400, 'Only text files can be written through this endpoint');
  try {
    const result = writeTextChunk(full, body.content, body.mode);
    const d = db();
    d.memory.docs = (d.memory.docs || []).filter((doc) => doc.path !== rel);
    persist();
    logActivity('file', `${result.mode === 'append' ? 'Appended' : 'Wrote'} ${result.writtenTokens} token(s) to ${rel}`);
    sendJson(res, 200, { ok: true, ...result, path: rel });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('POST', /^\/api\/files\/summarize$/, async (req, res) => {
  const body = await readBody(req);
  const rel = String(body.path || '').trim();
  const full = resolveInside(DATA, rel);
  if (!full || !fs.existsSync(full)) return fail(res, 404, 'File not found');
  let text = '';
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return fail(res, 400, err.message);
  }
  const digest = digestForSummary(text);
  if (!digest.text) return fail(res, 400, 'File is empty');
  const reply = await chat(
    [
      {
        role: 'system',
        content:
          'You summarize a long file for an operator and an AI assistant. Preserve the purpose, structure, key facts, names, commands, paths, numbers, decisions, risks and open questions. ' +
          'Clearly label anything that is an inference. Do not invent missing content. Use compact plain text with short headings. Target 250-500 words.',
      },
      { role: 'user', content: `File: ${rel}\nCharacters: ${text.length}\nChunks reduced: ${digest.chunks}\n\n${digest.text}` },
    ],
    { kind: 'document-summary', timeoutMs: 120000, temperature: 0.15 }
  );
  if (!reply.ok) return fail(res, 502, `AI unavailable: ${reply.error}`);
  const summary = reply.content.trim().slice(0, 9000);
  const record = {
    id: uid('docmem'),
    path: rel,
    at: now(),
    tokens: estimateTokens(text),
    summaryTokens: estimateTokens(summary),
    chunks: digest.chunks,
    chars: text.length,
    summary,
    model: reply.model,
  };
  const d = db();
  d.memory.docs = [record, ...(d.memory.docs || []).filter((doc) => doc.path !== rel)].slice(0, 200);
  persist();
  logActivity('memory', `Summarized ${rel} (${digest.chunks} chunk(s))`);
  sendJson(res, 200, { ok: true, document: record });
});

/* ---------------- Chat & history ---------------- */
route('POST', /^\/api\/chat$/, async (req, res) => {
  const body = await readBody(req);
  const message = String(body.message || '').trim();
  if (!message) return fail(res, 400, 'Message is required');
  const reply = await chatWithProjectMemory(message);
  if (!reply.ok) return sendJson(res, 200, { ok: false, error: reply.error, history: getHistory(), memory: getMemoryStats() });
  sendJson(res, 200, { ok: true, reply: reply.content, ms: reply.ms, model: reply.model, context: reply.context, history: getHistory(), memory: getMemoryStats() });
});

route('GET', /^\/api\/history$/, async (req, res) =>
  sendJson(res, 200, { ok: true, history: getHistory(), memory: getMemoryStats(), usage: db().usage.slice(0, 80) })
);

route('POST', /^\/api\/memory\/summarize$/, async (req, res) => {
  const body = await readBody(req);
  try {
    const result = await summarizeConversation({ maxChunks: body.maxChunks || 6 });
    sendJson(res, 200, { ok: true, ...result, memory: getMemoryStats() });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

route('GET', /^\/api\/memory$/, async (req, res) => sendJson(res, 200, { ok: true, memory: getMemoryStats() }));

route('DELETE', /^\/api\/history$/, async (req, res) => {
  clearHistory();
  logActivity('ai', 'Conversation history cleared');
  sendJson(res, 200, { ok: true });
});

/* ---------------- Settings ---------------- */
route('PATCH', /^\/api\/settings$/, async (req, res) => {
  const body = await readBody(req);
  const s = db().settings;
  if (body.baseUrl !== undefined) s.baseUrl = String(body.baseUrl).trim().replace(/\/+$/, '');
  if (body.chatPath !== undefined) s.chatPath = String(body.chatPath || '/api/chat').trim() || '/api/chat';
  if (body.baseUrl !== undefined || body.chatPath !== undefined) {
    const base = String(s.baseUrl || '').replace(/\/+$/, '');
    const routePath = String(s.chatPath || '/api/chat');
    s.endpoint = base + (routePath.startsWith('/') ? routePath : `/${routePath}`);
  }
  if (body.endpoint !== undefined && body.baseUrl === undefined) {
    s.endpoint = String(body.endpoint).trim();
    try {
      const parsed = new URL(s.endpoint);
      const chatIndex = parsed.pathname.indexOf('/api/');
      s.baseUrl = parsed.origin + (chatIndex > 0 ? parsed.pathname.slice(0, chatIndex) : '');
      s.chatPath = chatIndex >= 0 ? parsed.pathname.slice(chatIndex) : '/api/chat';
    } catch {}
  }
  if (body.model !== undefined) s.model = String(body.model).trim();
  if (body.targetPlatform !== undefined) {
    const targetPlatform = String(body.targetPlatform);
    if (!['win32', 'linux', 'darwin', 'android'].includes(targetPlatform)) {
      return fail(res, 400, 'targetPlatform must be win32, linux, darwin or android');
    }
    s.targetPlatform = targetPlatform;
  }
  if (body.apiStyle !== undefined) s.apiStyle = body.apiStyle === 'openai' ? 'openai' : 'ollama';
  if (body.localModelEnabled !== undefined) s.localModelEnabled = Boolean(body.localModelEnabled);
  if (body.localModelProvider !== undefined) {
    s.localModelProvider = body.localModelProvider === 'ollama' ? 'ollama' : 'llamacpp';
  }
  if (body.localModelFile !== undefined) s.localModelFile = String(body.localModelFile || '').trim();
  if (body.localModelName !== undefined) s.localModelName = String(body.localModelName || '').trim();
  if (body.localModelPort !== undefined) {
    const port = Number(body.localModelPort);
    s.localModelPort = Number.isFinite(port) ? Math.max(1024, Math.min(65535, Math.round(port))) : 8399;
  }
  if (body.localModelAutoStart !== undefined) s.localModelAutoStart = Boolean(body.localModelAutoStart);
  if (body.gatewayEnabled !== undefined) s.gatewayEnabled = Boolean(body.gatewayEnabled);
  if (body.gatewayPort !== undefined) {
    const port = Number(body.gatewayPort);
    s.gatewayPort = Number.isFinite(port) ? Math.max(0, Math.min(65535, Math.round(port))) : 0;
  }
  if (body.gatewayKeyEnv !== undefined) s.gatewayKeyEnv = String(body.gatewayKeyEnv || '').trim();
  if (body.dryRun !== undefined) {
    const dryRun = Boolean(body.dryRun);
    if (!dryRun) {
      const detected = liveControl();
      const proof = detected.available ? await probeLiveBackend() : { ok: false, detail: detected.reason };
      if (!detected.available || !proof.ok) return fail(res, 409, proof.detail || detected.reason || 'Desktop readiness check failed.');
    }
    s.dryRun = dryRun;
  }
  if (body.autoSync !== undefined) s.autoSync = Boolean(body.autoSync);
  if (body.autoPull !== undefined) s.autoPull = Boolean(body.autoPull);
  if (body.autoSyncIntervalMs !== undefined) {
    s.autoSyncIntervalMs = Math.max(5000, Math.min(600000, Number(body.autoSyncIntervalMs) || 10000));
    if (gitSyncStatus().running) startAutoSync({ intervalMs: s.autoSyncIntervalMs });
  }
  if (body.autoSyncMaxDeletes !== undefined) {
    s.autoSyncMaxDeletes = Math.max(1, Math.min(1000, Number(body.autoSyncMaxDeletes) || 25));
  }
  // A second copy of this repository on this machine, kept level with GitHub.
  if (body.localBackupEnabled !== undefined) s.localBackupEnabled = Boolean(body.localBackupEnabled);
  if (body.localBackupPath !== undefined) s.localBackupPath = String(body.localBackupPath || '').trim();
  if (body.localBackupIntervalMs !== undefined) {
    s.localBackupIntervalMs = Math.max(5000, Math.min(600000, Number(body.localBackupIntervalMs) || 10000));
  }
  if (body.localBackupEnabled !== undefined || body.localBackupIntervalMs !== undefined) {
    startBackup({ intervalMs: Number(s.localBackupIntervalMs) || undefined });
    if (s.localBackupEnabled === true) backupTick().catch(() => {});
  }
  if (body.autoNotes !== undefined) s.autoNotes = Boolean(body.autoNotes);
  if (body.aiSuggestions !== undefined) s.aiSuggestions = Boolean(body.aiSuggestions);
  if (body.requireToolApproval !== undefined) s.requireToolApproval = Boolean(body.requireToolApproval);
  if (body.linkAutoApprove !== undefined) s.linkAutoApprove = Boolean(body.linkAutoApprove);
  if (body.visionEnabled !== undefined) s.visionEnabled = Boolean(body.visionEnabled);
  if (body.replanModel !== undefined) s.replanModel = String(body.replanModel || '').trim();
  // Who decides a screen check: the model with the facts as a veto (gate), or
  // the facts alone when they are conclusive (facts, works offline).
  if (body.verifyJudgeMode !== undefined) {
    s.verifyJudgeMode = JUDGE_MODES.includes(body.verifyJudgeMode) ? body.verifyJudgeMode : 'gate';
  }
  if (body.visualTesterUrl !== undefined) s.visualTesterUrl = String(body.visualTesterUrl || '').trim();
  if (body.visualTesterEnabled !== undefined) s.visualTesterEnabled = Boolean(body.visualTesterEnabled);
  if (body.visualTesterTimeoutMs !== undefined) {
    s.visualTesterTimeoutMs = Math.max(1000, Math.min(120000, Number(body.visualTesterTimeoutMs) || 25000));
  }
  if (body.autoActEnabled !== undefined) s.autoActEnabled = Boolean(body.autoActEnabled);
  if (body.autoActThreshold !== undefined) {
    s.autoActThreshold = Math.max(1, Math.min(100, Number(body.autoActThreshold) || 80));
  }
  if (body.autoForwardFailures !== undefined) s.autoForwardFailures = Boolean(body.autoForwardFailures);
  if (body.autoEscalateMinFailures !== undefined) {
    s.autoEscalateMinFailures = Math.max(1, Math.min(10, Number(body.autoEscalateMinFailures) || 2));
  }
  if (body.autoEscalateDailyCap !== undefined) {
    // Zero is a real value here ("do not auto-start any mission"), so it must not
    // fall back to the default the way a `|| 3` would.
    const cap = Number(body.autoEscalateDailyCap);
    s.autoEscalateDailyCap = Number.isFinite(cap) ? Math.max(0, Math.min(25, Math.round(cap))) : 3;
  }
  if (body.autoProposeFailures !== undefined) s.autoProposeFailures = Boolean(body.autoProposeFailures);
  if (body.autoRecoverFailures !== undefined) s.autoRecoverFailures = Boolean(body.autoRecoverFailures);
  if (body.recoveryMaxAttempts !== undefined) {
    s.recoveryMaxAttempts = Math.max(1, Math.min(4, Number(body.recoveryMaxAttempts) || 2));
  }
  // Whether an AI revision may plan video and playback work at all.
  if (body.replanMedia !== undefined) s.replanMedia = Boolean(body.replanMedia);
  if (body.presenceEnabled !== undefined) s.presenceEnabled = Boolean(body.presenceEnabled);
  if (body.presenceHoldMs !== undefined) {
    s.presenceHoldMs = Math.max(1000, Math.min(60000, Number(body.presenceHoldMs) || 10000));
  }
  if (body.presenceMaxDeferMs !== undefined) {
    s.presenceMaxDeferMs = Math.max(1000, Math.min(300000, Number(body.presenceMaxDeferMs) || 60000));
  }
  if (body.presenterSettleMs !== undefined) {
    s.presenterSettleMs = Math.max(0, Math.min(10000, Number(body.presenterSettleMs) || 0));
  }
  if (body.presenterAutoContinueMs !== undefined) {
    s.presenterAutoContinueMs = Math.max(1000, Math.min(120000, Number(body.presenterAutoContinueMs) || 15000));
  }
  if (body.presenterInputPolicy !== undefined) {
    s.presenterInputPolicy = ['auto', 'wait', 'stop'].includes(body.presenterInputPolicy) ? body.presenterInputPolicy : 'auto';
  }
  if (body.companionEnabled !== undefined) s.companionEnabled = Boolean(body.companionEnabled);
  if (body.companionLearning !== undefined) s.companionLearning = Boolean(body.companionLearning);
  if (body.companionNotifications !== undefined) s.companionNotifications = Boolean(body.companionNotifications);
  if (body.companionSystemScan !== undefined) s.companionSystemScan = Boolean(body.companionSystemScan);
  if (body.companionPopupPolicy !== undefined) {
    s.companionPopupPolicy = ['off', 'important', 'all'].includes(body.companionPopupPolicy) ? body.companionPopupPolicy : 'important';
  }
  if (body.continuityEnabled !== undefined) s.continuityEnabled = Boolean(body.continuityEnabled);
  if (body.continuityAutoContinue !== undefined) s.continuityAutoContinue = Boolean(body.continuityAutoContinue);
  if (body.continuityFrameWatch !== undefined) s.continuityFrameWatch = Boolean(body.continuityFrameWatch);
  if (body.continuityFrameMs !== undefined) {
    s.continuityFrameMs = Math.max(1000, Math.min(60000, Number(body.continuityFrameMs) || 5000));
  }
  if (body.continuityAiReview !== undefined) s.continuityAiReview = Boolean(body.continuityAiReview);
  if (body.missionCheckIntervalMs !== undefined) {
    s.missionCheckIntervalMs = Math.max(1000, Math.min(60000, Number(body.missionCheckIntervalMs) || 5000));
  }
  if (body.agentTickMs !== undefined) s.agentTickMs = Math.max(3000, Math.min(120000, Number(body.agentTickMs) || 5000));
  // Enabling, disabling or re-pointing the gateway applies without a restart.
  if (body.gatewayEnabled !== undefined || body.gatewayPort !== undefined) {
    if (s.gatewayEnabled) ensureGateway().catch((err) => console.warn(`[gateway] ${err.message}`));
    else stopGateway();
  }
  // Live step thinking: every key is normalized here too, so a hand-written
  // request cannot lift the reject limits or ask for an unbounded loop.
  if (body.stepThink !== undefined && body.stepThink && typeof body.stepThink === 'object') {
    s.stepThink = normalizeThinkSettings({ ...(s.stepThink || {}), ...body.stepThink });
  }
  if (body.recheck !== undefined && body.recheck && typeof body.recheck === 'object') {
    s.recheck = normalizeRecheckSettings({ ...(s.recheck || {}), ...body.recheck });
  }
  if (body.screenReview !== undefined && body.screenReview && typeof body.screenReview === 'object') {
    s.screenReview = normalizeScreenReviewSettings({ ...(s.screenReview || {}), ...body.screenReview });
  }
  // Automatic repair: the four checkboxes and their two bounds, normalized here
  // so a hand-written request cannot exceed them either.
  if (body.autoRepair !== undefined && body.autoRepair && typeof body.autoRepair === 'object') {
    s.autoRepair = normalizeAutoRepair({ ...(s.autoRepair || {}), ...body.autoRepair });
  }
  persist();
  logActivity('settings', 'Settings updated');
  sendJson(res, 200, { ok: true, settings: s });
});

/* ---------------- Agents ---------------- */
route('PATCH', /^\/api\/agents\/([^/]+)$/, async (req, res, [id]) => {
  const agent = db().agents.find((a) => a.id === id);
  if (!agent) return fail(res, 404, 'Agent not found');
  const body = await readBody(req);
  if (body.enabled !== undefined) {
    agent.enabled = Boolean(body.enabled);
    agent.status = agent.enabled ? 'idle' : 'paused';
  }
  if (body.intervalMs !== undefined) agent.intervalMs = Math.max(5000, Math.min(86400000, Number(body.intervalMs) || 60000));
  if (body.workflowId !== undefined) agent.workflowId = body.workflowId || null;
  if (body.stopOnFailure !== undefined) agent.stopOnFailure = Boolean(body.stopOnFailure);
  persist();
  logActivity('agent', `${agent.name} ${agent.enabled ? 'enabled' : 'disabled'}`);
  sendJson(res, 200, { ok: true, agent });
});

route('POST', /^\/api\/agents\/([^/]+)\/tick$/, async (req, res, [id]) => {
  if (!db().agents.some((a) => a.id === id)) return fail(res, 404, 'Agent not found');
  const result = await tickAgentNow(id);
  sendJson(res, 200, { ok: true, result, agent: db().agents.find((a) => a.id === id) });
});

/* ---------------- Suggestions ---------------- */
route('DELETE', /^\/api\/suggestions\/([^/]+)$/, async (req, res, [id]) => {
  const sug = db().suggestions.find((s) => s.id === id);
  if (!sug) return fail(res, 404, 'Suggestion not found');
  sug.dismissed = true;
  sug.status = 'dismissed';
  persist();
  sendJson(res, 200, { ok: true });
});

/* ---------------- Quick control ---------------- */
route('POST', /^\/api\/control$/, async (req, res) => {
  const body = await readBody(req);
  const type = String(body.type || '');
  if (!STEP_TYPES.some((s) => s.type === type)) return fail(res, 400, `Unknown action: ${type}`);
  if (type === 'screenshot') {
    const live = body.live === undefined ? !db().settings.dryRun : Boolean(body.live);
    const step = { id: uid('cap'), type: 'screenshot', name: 'Manual capture', params: { caption: body.params?.caption || 'Manual capture' } };
    try {
      const result = await executeStep(step, { live, runId: null, run: { id: 'manual' }, workflow: null, getTool: () => null });
      const capture = captureRecord(result.evidence[0], step.params.caption, { mode: live ? 'live' : 'simulated' });
      return sendJson(res, 200, { ok: true, output: result.output, capture });
    } catch (err) {
      return fail(res, 500, err.message);
    }
  }
  const live = body.live === undefined ? !db().settings.dryRun : Boolean(body.live);
  const step = {
    id: uid('stp'),
    type,
    name: body.name || `Manual ${type}`,
    params: body.params || {},
    timeoutMs: 15000,
  };
  try {
    const result = await executeStep(step, { live, runId: null, run: { id: 'manual' }, workflow: null, getTool: () => null });
    logActivity('control', `Manual ${type} (${live ? 'live' : 'simulated'}): ${describe(step)}`);
    sendJson(res, 200, { ok: true, output: result.output, evidence: result.evidence || [] });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

/* ---------------- Server ---------------- */
function allowedApiOrigin(req) {
  const value = req.headers.origin;
  if (value === undefined) return true; // Local CLI clients need not send Origin.
  // An Origin is a single scheme and authority, not a general URL or a list.
  if (!/^https?:\/\/[^\s\/?#@\\,]+$/i.test(value) || value.endsWith(':')) return false;
  try {
    const origin = new URL(value);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host?.toLowerCase();
  } catch {
    return false;
  }
}

// A share link (server/share.js) is for watching this console and queueing
// simulated runs. Everything that changes state stays on this machine, and the
// console enforces that itself so a new route is never exposed by a proxy rule.
const SHARED_RUN_PATH = /^\/api\/(workflows\/[^/]+\/runs|missions)$/;

function sharedMutationBlocked(req, url) {
  if (req.headers['x-sightline-shared'] !== '1') return false;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
  return !(req.method === 'POST' && SHARED_RUN_PATH.test(url.pathname));
}

async function handleApi(req, res, url) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = url.pathname.match(r.pattern);
    if (!match) continue;
    // Every error handler can name the exact request that failed, so the
    // action log records the true source instead of a generic guess.
    res.requestInfo = { method: req.method, url: url.pathname + (url.search || '') };
    try {
      await r.handler(req, res, match.slice(1), url);
    } catch (err) {
      console.error('[api]', url.pathname, err);
      if (!res.headersSent) fail(res, 500, err.message || 'Internal error');
    }
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname.startsWith('/api/')) {
    if (sharedMutationBlocked(req, url)) {
      return fail(
        res,
        403,
        "Blocked on a share link: git changes, notes, custom commands and other state changes only work on the console's own machine."
      );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedApiOrigin(req)) {
      return fail(res, 403, 'Origin not allowed');
    }
    const handled = await handleApi(req, res, url);
    if (!handled) fail(res, 404, 'Not found');
    return;
  }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const full = resolveInside(PUBLIC, rel);
  if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(full).pipe(res);
});

function ensurePythonFiles() {
  for (const file of ALL_PYTHON_FILES) {
    const target = path.join(PYTHON, file.name);
    if (!fs.existsSync(target)) writeFileDurable(target, file.code);
  }
}

function ensureToolFiles() {
  const d = db();
  let changed = false;
  for (const tool of d.tools) {
    if (tool.file) continue;
    const file = path.join(TOOLS, `${slug(tool.name)}-${tool.id}.ps1`);
    writeFileDurable(file, tool.code);
    tool.file = path.relative(ROOT, file).split(path.sep).join('/');
    changed = true;
  }
  if (changed) persist();
}

function recoverySnapshotFromPack(pack, workflow, candidateId = pack?.selectedCandidateId) {
  const chosen = (pack?.candidates || []).find((candidate) => candidate.id === candidateId);
  if (!chosen) return null;
  return {
    ...workflow,
    steps: JSON.parse(JSON.stringify(chosen.steps)).map((step, index) => ({
      ...step,
      id: step.id || uid('stp'),
      name: String(step.name || `Step ${index + 1}`).slice(0, 100),
    })),
    failurePolicy: { ...(workflow.failurePolicy || {}), onFailure: 'stop', maxRetries: 0 },
  };
}

function recoveryCandidateView(candidate) {
  return {
    id: candidate.id,
    label: candidate.label,
    reason: candidate.reason || '',
    score: candidate.score ?? candidate.test?.score ?? null,
    test: {
      ok: Boolean(candidate.test?.ok),
      status: candidate.test?.status || 'untested',
      passed: candidate.test?.passed ?? null,
      total: candidate.test?.total ?? null,
    },
    steps: (candidate.steps || []).map((step) => ({
      name: step.name || step.type,
      type: step.type,
    })),
  };
}

const RECOVERY_REPEAT =
  'The recovery plan starts with the step that just failed, unchanged, so it would fail the same way. The retry was not queued.';

// Runs whose recovery pack is being built in the background right now.
const replanning = new Set();

/**
 * Build a recovery pack in the background and queue its retry only when a tested
 * candidate differs from what just failed. The caller is answered immediately;
 * the run carries `replan` so the console can follow the planning.
 */
function startReplanRetry(run, { dryRun = run.dryRun } = {}) {
  replanning.add(run.id);
  run.replan = { status: 'planning', startedAt: now(), packId: run.recoveryPackId || null, retryRunId: null, reason: '' };
  persist();
  const finish = (patch) => {
    run.replan = { ...(run.replan || {}), ...patch, packId: run.recoveryPackId || patch.packId || null, at: now() };
    replanning.delete(run.id);
    persist();
  };
  (async () => {
    const outcome = await prepareRecovery(run, { force: true });
    const pack = outcome?.pack || null;
    if (!pack) {
      finish({ status: 'needs_review', reason: 'Recovery planning did not produce a pack, so nothing was retried.' });
      return;
    }
    if (!outcome.selected || !outcome.retryWorkflow) {
      finish({
        status: 'needs_review',
        packId: pack.id,
        reason: pack.aiRevision?.blocked
          ? 'The AI would have replayed the step that just failed, and no other candidate passed its test. The workflow was not changed.'
          : 'No candidate plan passed the shadow test, so no retry was started.',
      });
      return;
    }
    const retry = queueRecoveryRetry(run, pack, outcome.retryWorkflow, { source: 'operator', dryRun });
    if (!retry) {
      finish({ status: 'needs_review', packId: pack.id, reason: RECOVERY_REPEAT });
      return;
    }
    finish({ status: 'queued', packId: pack.id, retryRunId: retry.id });
  })().catch((err) => {
    try {
      const pack = run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
      if (pack) {
        pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
        pack.logs.unshift({ at: now(), level: 'error', stage: 'plan', message: `Background replan failed: ${err.message}` });
        pack.status = 'needs_review';
        pack.updatedAt = now();
      }
      run.recovery = { ...(run.recovery || {}), status: 'needs_review' };
    } catch {}
    finish({ status: 'failed', reason: err.message });
  });
  return run.replan;
}

function queueRecoveryRetry(run, pack, snapshot, { source = 'auto-recovery', dryRun = run.dryRun } = {}) {
  // Resume only when the snapshot is the exact plan that ran. Any repair step —
  // including one added before the failure — makes it a different plan, so the
  // whole snapshot replays rather than dropping the repair.
  const failedStep = (run.steps || []).find((step) => step.status === 'failed');
  const resumed = failedStep ? resumeRecoveryPlan(snapshot.steps, run.steps, failedStep.id) : null;
  // A whole-plan replay must not repeat an effect that already happened (the
  // same text typed twice, the same file written twice). Those steps are left
  // out of the retry and recorded as facts — they are never marked passed.
  const carried = !dryRun && !resumed
    ? carryForwardPassedEffects(snapshot.steps, run.steps)
    : { steps: snapshot.steps, carried: [] };
  // Only a plan that resumes at the failure point is a literal replay: the same
  // plan re-run from the step that just failed. A rebuilt or repaired plan that
  // merely starts with a step of the same shape is a different attempt and is
  // allowed through, unless the failure may clear by itself anyway.
  const firstNext = resumed ? resumed.steps[0] || null : null;
  if (retryReplaysFailure({ failedStep, firstNext })) {
    pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
    pack.logs.unshift({ at: now(), level: 'warn', stage: 'verify', message: RECOVERY_REPEAT });
    if (pack.status !== 'passed') pack.status = 'needs_review';
    pack.repeatBlocked = { stepId: failedStep.id, step: failedStep.name || failedStep.type, at: now() };
    pack.updatedAt = now();
    persist();
    return null;
  }
  if (!resumed && !carried.steps.length) {
    pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
    pack.logs.unshift({
      at: now(),
      level: 'warn',
      stage: 'verify',
      message: 'Every remaining step already had its effect in the earlier run; there was nothing left to retry.',
    });
    if (pack.status !== 'passed') pack.status = 'needs_review';
    pack.updatedAt = now();
    persist();
    return null;
  }
  const retrySteps = resumed ? resumed.steps : carried.steps;
  const retry = createRun({ ...snapshot, steps: retrySteps }, {
    trigger: 'recovery',
    dryRun: Boolean(dryRun),
    agentRole: 'recovery-agent',
    workflowSnapshot: snapshot,
  });
  if (resumed) {
    retry.resumedFrom = {
      stepId: failedStep.id,
      step: failedStep.name,
      skipped: resumed.skipped,
    };
  }
  retry.recoveryOf = pack.originalRunId || run.recoveryOf || run.id;
  retry.recoveryPackId = pack.id;
  retry.recoveryDepth = (Number(run.recoveryDepth) || Number(pack.depth) || 0) + 1;
  retry.recovery = { packId: pack.id, status: 'running', depth: retry.recoveryDepth, startedAt: now() };
  if (carried.carried.length) {
    retry.carriedSteps = carried.carried;
    retry.log = Array.isArray(retry.log) ? retry.log : [];
    retry.log.push({
      at: now(),
      level: 'info',
      message: `Not repeating ${carried.carried.length} step(s) whose effect already happened in ${run.id}: ${carried.carried.map((step) => step.name).join(', ')}.`,
    });
    pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
    pack.logs.unshift({
      at: now(),
      level: 'info',
      stage: 'verify',
      message: `The retry continues past ${carried.carried.length} step(s) that already had their effect (${carried.carried.map((step) => step.name).join(', ')}); they were not marked complete or run again.`,
    });
  }
  pack.retryRunId = retry.id;
  pack.status = 'retrying';
  pack.updatedAt = now();
  run.recovery = { ...(run.recovery || {}), status: 'retrying', retryRunId: retry.id, packId: pack.id };
  markCompanionContinuation(run.id, { status: 'retrying', retryRunId: retry.id });
  markContinuityContinuation(run.id, { status: 'retrying', retryRunId: retry.id, ready: true });
  if (Array.isArray(run.log)) {
    run.log.push({ at: now(), level: 'info', message: `Recovery pack ${pack.id} queued retry ${retry.id}.` });
  }
  persist();
  logActivity('recovery', `${source === 'companion' ? 'Companion' : source === 'operator' ? 'Operator' : 'Auto-recovery'} queued ${retry.id} from ${pack.id}`, {
    runId: run.id,
    workflowId: run.workflowId,
    packId: pack.id,
    retryRunId: retry.id,
  });
  return retry;
}

setRunFinishedHook(async (run) => {
  if (run.trigger === 'shadow') return;
  rememberRun(run);
  try {
    learnCompanionRun(run);
    await scanCompanion({ system: false });
  } catch (err) {
    run.log.push({ at: now(), level: 'warn', message: `Companion learning failed: ${err.message}` });
    persist();
  }
  if (run.recoveryPackId) {
    try {
      finalizeRecoveryPack(run);
    } catch (err) {
      run.log.push({ at: now(), level: 'warn', message: `Recovery finalize failed: ${err.message}` });
      persist();
    }
  }
  let continuityReview = null;
  // A simulated run's needs-review verdict says "nothing was exercised", not
  // "something broke": it must not create a continuity verdict, a continuation
  // or a suggested workflow to repair.
  const simulatedReview = Boolean(run.dryRun) && run.status !== 'passed';
  if (!simulatedReview && ['passed', 'failed', 'needs_review'].includes(run.status)) {
    try {
      continuityReview = await reviewRunContinuity(run, {
        capture: false,
        inspectWindow: run.status === 'failed' && !run.dryRun,
      });
    } catch (err) {
      run.log.push({ at: now(), level: 'warn', message: `Continuity review failed: ${err.message}` });
      persist();
    }
  }
  if (run.trigger === 'shortcut-replay' && run.shortcutReplayHabitId) {
    const habit = recordShortcutReplayOutcome(run.shortcutReplayHabitId, run);
    if (habit) {
      logActivity(
        'shortcut',
        `Replay ${habit.replayStatus} for ${habit.app} ${habit.keys}`,
        { runId: run.id, habitId: habit.id }
      );
    }
    return;
  }
  let recoveryQueued = false;
  const recoveryEligible =
    !run.dryRun &&
    (db().settings.autoRecoverFailures !== false ||
      (continuityReview?.continuation?.ready && db().settings.continuityAutoContinue !== false)) &&
    run.status === 'failed' &&
    !['mission', 'shadow', 'shortcut-replay', 'presentation-audit'].includes(run.trigger) &&
    !(run.presenter?.needsInput && db().settings.presenterInputPolicy === 'wait') &&
    !run.forwardedMissionId;
  if (recoveryEligible) {
    try {
      const outcome = await prepareRecovery(run);
      if (outcome?.retryWorkflow) {
        const retry = queueRecoveryRetry(run, outcome.pack, outcome.retryWorkflow, {
          source: db().settings.autoRecoverFailures === false ? 'continuity' : 'auto-recovery',
        });
        recoveryQueued = Boolean(retry);
      }
    } catch (err) {
      run.log.push({ at: now(), level: 'warn', message: `Auto-recovery failed: ${err.message}` });
      persist();
    }
  }
  if (run.status === 'failed') {
    // The policy decides whether this failure is worth a mission; the reason is
    // kept on the run so a failure that stayed out of the Command Center says why.
    try {
      const outcome = escalateFailedRun(run, {
        recoveryQueued,
        forward: forwardRunToControlCenter,
        start: startMission,
      });
      run.escalation = {
        at: now(),
        escalated: Boolean(outcome.mission),
        missionId: outcome.mission?.id || null,
        reason: outcome.decision?.reason || '',
      };
      persist();
    } catch (err) {
      run.log.push({ at: now(), level: 'warn', message: `Auto-escalation failed: ${err.message}` });
      persist();
    }
  }
  const autoPropose = db().settings.autoProposeFailures === true;
  if (
    autoPropose &&
    !run.dryRun &&
    ['failed', 'needs_review'].includes(run.status) &&
    run.trigger !== 'mission' &&
    run.trigger !== 'shortcut-replay' &&
    !run.recoveryPackId &&
    !recoveryQueued &&
    !run.autoProposalId
  ) {
    try {
      const proposal = await createProposalForRun(run.id);
      run.autoProposalId = proposal.id;
      persist();
      logActivity('proposal', `Auto-proposed a repair for ${run.id}`, { runId: run.id, proposalId: proposal.id });
    } catch (err) {
      run.log.push({ at: now(), level: 'warn', message: `Auto-propose failed: ${err.message}` });
      persist();
    }
  }
});

// A bind failure (another console instance or another app on the port) should
// end with a clear message, not a crash report — the fix is picking a free
// PORT, and the crash-report round-trip hides that.
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — another instance or app is bound to it. Start with a different port: PORT=<port> npm start`);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  ensureToolFiles();
  ensurePythonFiles();
  reconcileStuckRecoveryPacks();
  reconcileStuckReplans({ live: replanning });
  try {
    recoverInterruptedRuns();
  } catch (err) {
    console.warn(`[engine] Interrupted-run recovery failed: ${err.message}`);
  }
  try {
    backfillWorkflowMemory();
  } catch (err) {
    console.warn(`[memory] Backfill failed: ${err.message}`);
  }
  recoverMissions();
  ensurePresentationAgent();
  compactPresentations({ keep: 8 });
  startAgents();
  // Re-check what finished runs still owe, and look for blocked steps, on a
  // timer; read-only, so it is safe while the console is in use.
  startVerificationLoop({ intervalMs: Number(db().settings.verificationReviewMs) || undefined });
  // Keep the GitHub copy of this source current with the machine.
  startAutoSync({ intervalMs: Number(db().settings.autoSyncIntervalMs) || undefined });
  // Keep a second on-disk copy level with GitHub, and prove the link every 10s.
  startBackup({ intervalMs: Number(db().settings.localBackupIntervalMs) || undefined });
  // Follow the standalone test bench: its verdicts and operator popups show here.
  startBenchWatch();
  // Watch the process and the tracked files, and report instead of vanishing.
  startSupervisor();
  // Poll any live sources that were added, on their own schedules.
  startLiveSources({ intervalMs: Number(db().settings.liveSourceIntervalMs) || 60000 });
  // Watch the project's own files and auto-test them in a separate process.
  startSentinel();
  // The pipeline handlers: what the parallel workers actually do.
  registerHandler('sentinel-plan', async ({ id }) => {
    const result = await planFailure(id);
    return result?.plan?.text ? 'Plan drafted' : result?.plan?.error || 'No plan available';
  });
  registerHandler('relay-opinion', async ({ id }) => {
    const review = await reviewOpinion(id);
    return review?.opinion?.text ? 'Opinion drafted' : 'No opinion available';
  });
  registerHandler('error-triage', async ({ id }) => {
    const item = await triageItem({ id });
    return item?.suggestion ? 'Suggestion drafted' : 'No suggestion available';
  });
  registerHandler('deep-focus', async ({ id, rounds }) => {
    startDeepFocus(id, { rounds, reason: 'failed run' });
    return 'Focus cycle started';
  });
  startPipeline();
  // Know when AIs are working on the app; drives safeguards and continuations.
  startAgentWatch();
  startNudgeWatch();
  // Deep focus readers: live desktop state for the rethink rounds.
  configureDeepFocus({
    readForeground: readForegroundWindow,
    readFocused: readFocusedElement,
    listWindows: async () => (await readScreenContext()).windows,
    chat,
    snapshot: (label) => createSnapshot(label),
    applyAndRetry: applyReshapedToRun,
  });
  // The screen monitor lives in the backend: it reads the window in front on its
  // own timer and reorders pending steps, so the open tab is never the engine.
  configureAutoRepair({ read: readMonitorLabels });
  startAutoRepairMonitor();
  startAmbient();
  // Front the model provider with the local Respan Gateway when it is enabled.
  if (db().settings.gatewayEnabled) ensureGateway().catch((err) => console.warn(`[gateway] ${err.message}`));
  setInterval(scanElementLinks, 5000).unref?.();
  console.log(`Sightline console running at http://${HOST}:${PORT}`);
  console.log(`Data: ${DATA}`);
  const control = liveControl();
  console.log(`Platform: ${process.platform} — live control via ${control.label} (${control.input}; capture: ${control.capture}).`);
});

function shutdown() {
  console.log('\nShutting down…');
  stopAmbient();
  stopAgents();
  livePreview.stop();
  stopVerificationLoop();
  stopAutoSync();
  stopAutoRepairMonitor();
  stopSentinel();
  stopPipeline();
  stopShare();
  stopGateway();
  flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// A crash is a message too: report it with the stack into the synced
// must-check folder and keep the console alive if the failure is contained.
process.on('uncaughtException', (err) => {
  console.error('[crash] uncaught exception:', err);
  try {
    recordAction({ kind: 'crash', action: 'server-uncaught', error: err.stack || err.message, forceReport: true });
    sendContinuation({ from: 'console', reason: 'the console crashed', detail: String(err.message || err).slice(0, 400), tags: ['crash'] });
  } catch { /* never crash inside the crash handler */ }
});
process.on('unhandledRejection', (err) => {
  console.error('[crash] unhandled rejection:', err);
  try {
    recordAction({ kind: 'crash', action: 'server-rejection', error: err?.stack || String(err), forceReport: true });
  } catch { /* never crash inside the crash handler */ }
});
