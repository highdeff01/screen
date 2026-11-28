import path from 'node:path';
import os from 'node:os';
import { db, persist, uid, now, logActivity } from './store.js';
import { planSteps, workflowGoal, normalizeStep, parseGoalIntent, addSuggestion } from './planner.js';
import { shadowTestPlan } from './shadow-test.js';
import { buildWorkflowResearch, compactResearch } from './research.js';
import { listShortcuts } from './shortcuts.js';
import { firstAppStep, opensTargetBefore, launchAndWaitSteps } from './app-launch-hints.js';
import { revisePlan, isTransientFailure } from './replan.js';
import { readScreenContext } from './automation.js';
import { currentFindings } from './vision-findings.js';

const MAX_PACKS = 80;
const MAX_PLAN_STEPS = 40;
const PLAN_TIMEOUT_MS = 45000;
// A failed revision (offline model, timeout, unusable reply) is remembered for a
// short while: the next pack skips the multi-second desktop capture it would
// only have fed to a model that is not answering.
const AI_OUTAGE_MS = 120000;
let aiOutageUntil = 0;

/**
 * The reviewer's reading for a replan prompt, if there is one. A failed run
 * never waits on the vision agent: no reading means no section, not no replan.
 */
function replanFindings() {
  try {
    return currentFindings();
  } catch {
    return null;
  }
}
// Durable rows are small — timings, the winning candidate, the retry verdict —
// so the whole comparison history stays inside the saved store.
const MAX_TELEMETRY = 200;

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

const AGENT_ADVICE = {
  supervisor: 'Rebuild from the operator intent, not from the failed step order.',
  watchdog: 'Do not replay the same failure signature unchanged; capture the missing evidence first.',
  observer: 'Look for the missing prerequisite before the failed step, especially launch/open/focus/wait.',
  scheduler: 'Respect the shared retry budget and stop after the bounded recovery chain.',
  presentation: 'Compare the recovery against the saved deck and preserve the visual evidence.',
};

function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Facts the run itself produced: evidence captions and step outputs. They are
 * given to the revision as context only — an artifact proves something was on
 * screen, never that a step already happened — so nothing is marked complete.
 */
function runEvidenceFacts(run) {
  const rows = [];
  for (const item of (run?.evidence || []).slice(-8)) {
    const caption = clip(item?.caption || '', 160);
    rows.push(`${item?.kind || 'evidence'}: ${caption || '(no caption)'}${item?.simulated ? ' [simulated]' : ''}`);
  }
  for (const step of run?.steps || []) {
    const output = clip(step?.output || '', 140);
    if (output) rows.push(`step “${clip(step.name || step.type || 'step', 70)}” output: ${output}`);
  }
  return rows.slice(-10);
}

function stepTarget(step) {
  const p = step?.params || {};
  const values = [p.title, p.windowName, p.windowTitle, p.window, p.foreground, p.process, p.target, p.value, p.app];
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

function normalizeTarget(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function looksLikeEnvironmentFailure(run, target) {
  const error = (run?.steps || []).filter((step) => step.status === 'failed').map((step) => step.error).join(' ');
  return Boolean(target) && /no window matching|window.*not found|no window|not running|window.*closed|no process|cannot find window|target window/i.test(error);
}

function launchTarget(target) {
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(target) || /[\\/]/.test(target)) return target;
  if (/\.(?:txt|md|json|csv|log)$/i.test(target)) return path.join(os.homedir(), 'Desktop', target);
  return target;
}

function repairStepsFor(target) {
  if (!target) return [];
  if (isUrl(target)) {
    return [normalizeStep({ type: 'openUrl', name: `Open ${target}`, params: { url: target } }, 0)].filter(Boolean);
  }
  const open = { type: 'launchApp', name: `Open ${target}`, params: { target: launchTarget(target) } };
  const wait = { type: 'waitFor', name: `Wait for ${target}`, params: { kind: 'window', value: target, mode: 'present', timeoutMs: 12000, intervalMs: 500 }, timeoutMs: 14000 };
  const focus = { type: 'focusWindow', name: `Focus ${target}`, params: { title: target }, timeoutMs: 12000 };
  return [open, wait, focus].map((step, index) => normalizeStep(step, index)).filter(Boolean);
}

/**
 * A workflow whose first app step focuses or types into an app never opens it.
 * Insert the same launch-and-settle pair planning uses before that step, unless
 * an earlier step already opens the app. createRun is synchronous, so it cannot
 * probe whether the app is running; the launch step focuses an existing matching
 * window instead of starting a duplicate.
 */
export function ensureLeadingFocusLaunch(steps) {
  const out = cloneSteps(steps);
  const found = firstAppStep(out);
  if (!found) return out;
  const { index, hint } = found;
  if (opensTargetBefore(out, index, hint)) return out;
  out[index].params = { ...(out[index].params || {}) };
  if (!out[index].params.process && hint.process) out[index].params.process = hint.process;
  out.splice(
    index,
    0,
    ...launchAndWaitSteps(hint).map((step, offset) => normalizeStep(step, index + offset))
  );
  return out;
}

function cloneSteps(steps) {
  return JSON.parse(JSON.stringify(Array.isArray(steps) ? steps : []));
}

/** Add the missing open/wait/focus prerequisite before the first app-dependent step. */
export function ensureOpenPrerequisites(steps) {
  const out = cloneSteps(steps).slice(0, MAX_PLAN_STEPS);
  const opened = new Set();
  for (let index = 0; index < out.length; index += 1) {
    const step = out[index];
    if (!step) continue;
    if (step.type === 'launchApp') {
      opened.add(normalizeTarget(step.params?.target));
      continue;
    }
    if (step.type === 'openUrl') {
      opened.add(normalizeTarget(step.params?.url));
      continue;
    }
    if (!['focusWindow', 'clickElement', 'type', 'key', 'waitFor', 'expect'].includes(step.type)) continue;
    const target = stepTarget(step);
    if (!target) continue;
    const key = normalizeTarget(target);
    if (!key || opened.has(key)) continue;
    const repair = repairStepsFor(target);
    if (!repair.length) continue;
    out.splice(index, 0, ...repair);
    index += repair.length - 1;
    opened.add(key);
  }
  return out;
}

function targetedRepair(workflow, failedStep, target) {
  if (!workflow || !failedStep || !target) return [];
  const index = Math.max(
    0,
    (workflow.steps || []).findIndex((step) => step.id === failedStep.id || step.name === failedStep.name)
  );
  const repair = repairStepsFor(target);
  if (!repair.length) return [];
  return [...cloneSteps(workflow.steps).slice(0, index), ...repair, ...cloneSteps(workflow.steps).slice(index)].slice(0, MAX_PLAN_STEPS);
}

function candidateTest(candidate) {
  const startedAt = performance.now();
  const test = shadowTestPlan({
    steps: candidate.steps || [],
    preflight: candidate.plan?.preflight || [],
    confidence: candidate.plan?.confidence ?? null,
    screenshots: candidate.plan?.screenshots || [],
    backups: candidate.plan?.backups || [],
    lint: candidate.plan?.lint || null,
  });
  const testMs = elapsedMs(startedAt);
  return { ...candidate, test, testMs, score: test.score, stepCount: (candidate.steps || []).length };
}

function stepSummary(steps) {
  return (steps || []).slice(0, 28).map((step, index) => ({
    index: index + 1,
    type: step.type,
    name: clip(step.name || step.type, 120),
    detail: clip(JSON.stringify(step.params || {}), 220),
  }));
}

function freshOutline(intent, target) {
  const rows = [{ name: target ? `Open ${target}` : 'Open the target app or URL', detail: 'Use launchApp, openUrl, Start Menu or an approved shortcut.' }];
  rows.push({ name: 'Wait for the app/window and focus it', detail: 'Do not type or click until the expected window is foreground.' });
  if (intent?.question) rows.push({ name: `Ask: ${intent.question}`, detail: 'Type the current question, not an old one from history.' });
  rows.push({ name: 'Capture the response', detail: 'Use clipboard/copy or aiExtract only after the response is present.' });
  if (intent?.destination?.name) rows.push({ name: `Save or paste into ${intent.destination.name}`, detail: 'Write the file first, then open and verify the destination.' });
  rows.push({ name: 'Verify the final state', detail: 'Take evidence and assert the expected window/content.' });
  return rows;
}

function addStage(pack, key, name, summary, supersteps = [], level = 'info') {
  const stage = {
    key,
    name,
    status: level === 'error' ? 'failed' : level === 'warn' ? 'warning' : 'done',
    summary: clip(summary, 700),
    supersteps,
    at: now(),
  };
  pack.stages.push(stage);
  pack.logs.push({ at: stage.at, level, stage: key, message: stage.summary });
  return stage;
}

function log(pack, level, stage, message) {
  pack.logs.push({ at: now(), level, stage, message: clip(message, 700) });
  if (pack.logs.length > 160) pack.logs = pack.logs.slice(-160);
}

function average(values) {
  const numbers = (values || []).filter((value) => Number.isFinite(value));
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((total, value) => total + value, 0) / numbers.length);
}

/**
 * One durable row per recovery pack: what planning cost at each stage, which
 * candidate won, and how the retry it queued finished. The row is written when
 * a candidate is selected and updated when the retry ends, so an AI revision can
 * be compared with the fresh rebuild by outcome instead of by recollection.
 */
export function recordRecoveryTelemetry(pack, { outcome = null } = {}) {
  if (!pack) return null;
  const d = db();
  d.recoveryTelemetry = Array.isArray(d.recoveryTelemetry) ? d.recoveryTelemetry : [];
  const existing = d.recoveryTelemetry.find((row) => row.packId === pack.id) || null;
  const selected = (pack.candidates || []).find((candidate) => candidate.id === pack.selectedCandidateId) || null;
  const aiCandidate = (pack.candidates || []).find((candidate) => candidate.id === 'candidate_ai') || null;
  const aiRevision = pack.aiRevision || null;
  const row = {
    packId: pack.id,
    workflowId: pack.workflowId,
    originalRunId: pack.originalRunId,
    retryRunId: pack.retryRunId || existing?.retryRunId || null,
    depth: pack.depth || 0,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    aiStatus: pack.aiStatus || 'off',
    aiError: clip(pack.aiError || '', 300) || null,
    ai: aiRevision
      ? {
          decision: aiRevision.decision || null,
          prepCount: aiRevision.prepCount ?? 0,
          replaysFailure: Boolean(aiRevision.replaysFailure),
          transient: Boolean(aiRevision.transient),
          blocked: Boolean(aiRevision.blocked),
          droppedPlayback: aiRevision.droppedPlayback || 0,
          evidenceCount: aiRevision.evidenceCount ?? 0,
          offered: Boolean(aiCandidate),
          score: aiCandidate?.score ?? null,
        }
      : { decision: null, prepCount: 0, replaysFailure: false, transient: false, blocked: false, droppedPlayback: 0, offered: false, score: null },
    timings: { ...(pack.timings || {}) },
    candidates: (pack.candidates || []).map((candidate) => ({
      id: candidate.id,
      source: candidate.source || candidate.id,
      ok: Boolean(candidate.test?.ok),
      score: candidate.score ?? null,
      testMs: candidate.testMs ?? null,
    })),
    selected: selected
      ? { id: selected.id, source: selected.source || selected.id, score: selected.score ?? null }
      : null,
    outcome: outcome || existing?.outcome || null,
  };
  row.blockedReason = blockedReasonOf(row);
  d.recoveryTelemetry = [row, ...d.recoveryTelemetry.filter((entry) => entry.packId !== pack.id)].slice(0, MAX_TELEMETRY);
  return row;
}

export function listRecoveryTelemetry(limit = 30) {
  const rows = Array.isArray(db().recoveryTelemetry) ? db().recoveryTelemetry : [];
  return rows.slice(0, Math.max(1, Math.min(MAX_TELEMETRY, Number(limit) || 30)));
}

/**
 * Why the AI revision did not supply the retry plan. A refused replay is a
 * different miss from a model that never answered, so outcomes are grouped by
 * the reason itself instead of one "blocked" bucket.
 */
function blockedReasonOf(row) {
  if (row?.blockedReason !== undefined && row?.blockedReason !== null) return row.blockedReason;
  if (row?.ai?.blocked) return 'replayed-failed-step';
  if (row?.aiStatus === 'unavailable') {
    return /tim(?:ed|e)[ -]?out|timeout/i.test(String(row.aiError || '')) ? 'model-timeout' : 'model-unavailable';
  }
  if (row?.aiStatus === 'off') return 'revision-off';
  if (row?.aiStatus === 'skipped') return 'revision-skipped';
  if (row?.aiStatus === 'pending') return 'revision-incomplete';
  if (row?.ai?.offered) return null;
  return 'unknown';
}

/** Pass rate and planning cost for one slice of the ledger. */
function groupStats(rows) {
  const finished = rows.filter((row) => row.outcome);
  const passed = finished.filter((row) => row.outcome.passed).length;
  // A retry carried by the fresh rebuild does not test the AI decision, so its
  // pass rate is kept apart from the whole group's.
  const aiFinished = finished.filter((row) => row.selected?.source === 'ai-replan');
  const aiPassed = aiFinished.filter((row) => row.outcome.passed).length;
  return {
    planned: rows.length,
    blocked: rows.filter((row) => blockedReasonOf(row)).length,
    aiSelected: rows.filter((row) => row.selected?.source === 'ai-replan').length,
    retries: finished.length,
    passed,
    passRate: finished.length ? Math.round((passed / finished.length) * 100) : null,
    aiRetries: aiFinished.length,
    aiPassed,
    aiPassRate: aiFinished.length ? Math.round((aiPassed / aiFinished.length) * 100) : null,
    avgScore: average(rows.map((row) => row.selected?.score)),
    avgPlanningMs: average(rows.map((row) => row.timings?.totalMs)),
    avgRevisionMs: average(rows.map((row) => row.timings?.revisionMs)),
  };
}

const DECISION_ORDER = ['continue', 'rearrange', 'rebuild'];

/** Aggregate the ledger into the comparisons the recovery agent exists for. */
export function recoveryTelemetrySummary() {
  const rows = Array.isArray(db().recoveryTelemetry) ? db().recoveryTelemetry : [];
  const sources = new Map();
  for (const row of rows) {
    const source = row.selected?.source || 'none';
    if (!sources.has(source)) {
      sources.set(source, { source, selected: 0, completed: 0, passed: 0, failed: 0, scores: [], planning: [] });
    }
    const bucket = sources.get(source);
    bucket.selected += 1;
    if (row.selected?.score != null) bucket.scores.push(row.selected.score);
    if (Number.isFinite(row.timings?.totalMs)) bucket.planning.push(row.timings.totalMs);
    if (row.outcome) {
      bucket.completed += 1;
      if (row.outcome.passed) bucket.passed += 1;
      else bucket.failed += 1;
    }
  }
  const bySource = [...sources.values()].map((bucket) => ({
    source: bucket.source,
    selected: bucket.selected,
    completed: bucket.completed,
    passed: bucket.passed,
    failed: bucket.failed,
    passRate: bucket.completed ? Math.round((bucket.passed / bucket.completed) * 100) : null,
    avgScore: average(bucket.scores),
    avgPlanningMs: average(bucket.planning),
  }));
  const ai = bySource.find((bucket) => bucket.source === 'ai-replan') || null;
  const fresh = bySource.find((bucket) => bucket.source === 'planner') || null;
  // Every decision is listed even before it has been tried, so a strategy that
  // never wins is visible instead of silently absent.
  const decisions = [...new Set([...DECISION_ORDER, ...rows.map((row) => row.ai?.decision).filter(Boolean)])];
  const byDecision = decisions.map((decision) => ({
    decision,
    ...groupStats(rows.filter((row) => row.ai?.decision === decision)),
  }));
  const withoutDecision = groupStats(rows.filter((row) => !row.ai?.decision));
  const reasons = new Map();
  for (const row of rows) {
    const reason = blockedReasonOf(row);
    if (!reason) continue;
    if (!reasons.has(reason)) reasons.set(reason, []);
    reasons.get(reason).push(row);
  }
  const byBlockedReason = [...reasons.entries()]
    .map(([reason, reasonRows]) => ({ reason, ...groupStats(reasonRows) }))
    .sort((a, b) => b.planned - a.planned || a.reason.localeCompare(b.reason));
  return {
    total: rows.length,
    withOutcome: rows.filter((row) => row.outcome).length,
    aiOffered: rows.filter((row) => row.ai?.offered).length,
    aiSelected: rows.filter((row) => row.selected?.source === 'ai-replan').length,
    aiBlocked: rows.filter((row) => row.ai?.blocked).length,
    bySource,
    byDecision,
    withoutDecision,
    byBlockedReason,
    stageAveragesMs: {
      desktopRead: average(rows.map((row) => row.timings?.desktopReadMs)),
      planner: average(rows.map((row) => row.timings?.plannerMs)),
      revision: average(rows.map((row) => row.timings?.revisionMs)),
      shadowTest: average(rows.map((row) => row.timings?.shadowTestMs)),
      agentConsult: average(rows.map((row) => row.timings?.agentConsultMs)),
      total: average(rows.map((row) => row.timings?.totalMs)),
    },
    aiVsFresh: {
      aiPassRate: ai?.passRate ?? null,
      freshPassRate: fresh?.passRate ?? null,
      aiAvgPlanningMs: ai?.avgPlanningMs ?? null,
      freshAvgPlanningMs: fresh?.avgPlanningMs ?? null,
      verdict:
        ai?.passRate != null && fresh?.passRate != null
          ? ai.passRate > fresh.passRate
            ? 'ai-better'
            : ai.passRate < fresh.passRate
              ? 'fresh-better'
              : 'tied'
          : 'insufficient-data',
    },
  };
}

function withTimeout(promise, ms, label) {
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  let timer;
  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function findRecoveryPack(id) {
  return (db().recoveryPacks || []).find((pack) => pack.id === id) || null;
}

/** Planning is bounded; never leave a pack looking active after a restart or a hung planner. */
export function reconcileStuckRecoveryPacks({ staleMs = 180000 } = {}) {
  const d = db();
  let changed = false;
  for (const pack of d.recoveryPacks || []) {
    if (pack.status !== 'planning') continue;
    const at = Date.parse(pack.updatedAt || pack.createdAt || 0) || 0;
    if (!at || Date.now() - at < staleMs) continue;
    pack.status = 'needs_review';
    pack.updatedAt = now();
    pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
    pack.logs.unshift({
      at: now(),
      level: 'warn',
      stage: 'plan',
      message: 'Planning stopped before a tested candidate was ready. No retry was approved; review the pack or retry planning.',
    });
    const run = (d.runs || []).find((entry) => entry.id === pack.originalRunId || entry.recoveryPackId === pack.id);
    if (run?.recovery) {
      run.recovery.status = 'needs_review';
      run.recovery.packId = pack.id;
    }
    changed = true;
  }
  if (changed) persist();
  return changed;
}

/**
 * A background replan lives in memory (the caller's `replanning` set). After a
 * restart nothing is planning, so a run still marked `planning` would refuse
 * every new replan forever. Downgrade it with an honest reason; queue nothing.
 */
export function reconcileStuckReplans({ live = null, staleMs = 180000 } = {}) {
  const isLive = (id) => (typeof live?.has === 'function' ? live.has(id) : Array.isArray(live) && live.includes(id));
  const d = db();
  let changed = false;
  for (const run of d.runs || []) {
    if (run?.replan?.status !== 'planning') continue;
    if (isLive(run.id)) continue;
    const startedAt = Date.parse(run.replan.startedAt || run.replan.at || 0) || 0;
    if (!startedAt || Date.now() - startedAt < staleMs) continue;
    run.replan = {
      ...run.replan,
      status: 'failed',
      reason: 'Re-planning stopped before a tested plan was ready (the console restarted or the planner hung). Nothing was retried; start the replan again.',
      at: now(),
    };
    const pack = run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
    if (pack && pack.status === 'planning') {
      pack.status = 'needs_review';
      pack.updatedAt = now();
      pack.logs = Array.isArray(pack.logs) ? pack.logs : [];
      pack.logs.unshift({
        at: now(),
        level: 'warn',
        stage: 'plan',
        message: 'Planning was interrupted before a tested candidate was ready. No retry was approved.',
      });
      run.recovery = { ...(run.recovery || {}), status: 'needs_review', packId: pack.id };
    }
    changed = true;
  }
  if (changed) persist();
  return changed;
}

export function listRecoveryPacks(limit = 30) {
  reconcileStuckRecoveryPacks();
  return (db().recoveryPacks || []).slice(0, Math.max(1, Math.min(80, Number(limit) || 30))).map((pack) => ({
    id: pack.id,
    status: pack.status,
    workflowId: pack.workflowId,
    workflowName: pack.workflowName,
    originalRunId: pack.originalRunId,
    retryRunId: pack.retryRunId || null,
    depth: pack.depth || 0,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
    selectedCandidateId: pack.selectedCandidateId || null,
    selectedLabel: (pack.candidates || []).find((candidate) => candidate.id === pack.selectedCandidateId)?.label || '',
    incorporated: Boolean(pack.incorporated),
    verification: pack.verification || null,
  }));
}

function consultControlPanel(workflow, goal, target) {
  const d = db();
  const agents = (d.agents || []).slice(0, 12).map((agent) => ({
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    enabled: Boolean(agent.enabled),
    status: agent.status || (agent.enabled ? 'idle' : 'paused'),
    advice: AGENT_ADVICE[agent.kind] || 'Review the latest failure and propose a smaller, testable correction.',
    lastLog: clip((agent.log || []).slice(-1)[0]?.message || '', 220),
  }));
  const suggestions = (d.suggestions || [])
    .filter((entry) => !entry.dismissed && (!entry.workflowId || entry.workflowId === workflow.id))
    .slice(0, 8)
    .map((entry) => clip(entry.text, 260));
  const shortcuts = listShortcuts();
  const key = normalizeTarget(target);
  const habits = (shortcuts.habits || [])
    .filter((habit) => !key || normalizeTarget(habit.app).includes(key) || key.includes(normalizeTarget(habit.app)))
    .slice(0, 6)
    .map((habit) => ({ app: habit.app, action: habit.action, keys: habit.keys, confidence: habit.confidence }));
  let research = null;
  try {
    research = compactResearch(buildWorkflowResearch({ workflow, goal, app: target ? { name: target } : null }));
  } catch (err) {
    research = { error: clip(err.message, 240) };
  }
  return { agents, suggestions, shortcuts: habits, research };
}

/**
 * Build a five-stage recovery pack. The saved workflow is never changed here;
 * the caller starts a retry from the returned snapshot and incorporates the
 * chosen plan only after it passes.
 */
export async function prepareRecovery(
  run,
  {
    plan = planSteps,
    maxDepth = null,
    force = false,
    ask = null,
    desktop: desktopInput = undefined,
    screen = null,
  } = {}
) {
  if (!run) return null;
  const previousPack = run.recoveryPackId ? findRecoveryPack(run.recoveryPackId) : null;
  // The original run already has a pack. A recovery retry that failed needs
  // the next pack in the chain, so only skip when this pack was made for another run.
  if (!force && previousPack && previousPack.retryRunId !== run.id) {
    return { pack: previousPack, existing: true, retryWorkflow: null };
  }
  const d = db();
  const workflow = (d.workflows || []).find((entry) => entry.id === run.workflowId);
  if (!workflow) return null;
  const depth = Math.max(0, Number(run.recoveryDepth || 0));
  const limit = Number(maxDepth ?? d.settings.recoveryMaxAttempts ?? 2);
  if (depth >= limit) return null;

  const failedRuntime = (run.steps || []).find((step) => step.status === 'failed') || run.steps?.[0] || null;
  const failedStep = (workflow.steps || []).find((step) => step.id === failedRuntime?.id) || (workflow.steps || [])[0] || null;
  const baseGoal = workflowGoal(workflow, run) || workflow.description || workflow.name;
  const guidance = (run.presenter?.userNotes || [])
    .slice(0, 3)
    .map((entry) => entry.text)
    .filter(Boolean)
    .join(' ');
  const goal = guidance ? `${baseGoal}\nOperator guidance: ${guidance}` : baseGoal;
  const intent = parseGoalIntent(goal) || {};
  const target = stepTarget(failedStep) || '';
  const targetLabel = target || intent.source?.name || '';
  const pack = {
    id: uid('rcp'),
    workflowId: workflow.id,
    workflowName: workflow.name,
    originalRunId: run.recoveryOf || run.id,
    retryRunId: null,
    parentPackId: previousPack?.id || null,
    depth,
    goal: clip(goal, 1000),
    guidance: clip(guidance, 700),
    target: targetLabel,
    status: 'planning',
    // Per-stage wall-clock costs. "Did the AI revision earn its extra latency?"
    // is answered by these numbers, not by how the run felt.
    timings: {
      startedAt: now(),
      desktopReadMs: null,
      plannerMs: null,
      revisionMs: null,
      shadowTestMs: 0,
      agentConsultMs: null,
      totalMs: null,
    },
    aiStatus: 'pending',
    selectedCandidateId: null,
    candidates: [],
    stages: [],
    agents: [],
    logs: [],
    incorporated: false,
    verification: null,
    createdAt: now(),
    updatedAt: now(),
  };
  d.recoveryPacks = [pack, ...(d.recoveryPacks || [])].slice(0, MAX_PACKS);
  run.recoveryPackId = pack.id;
  run.recoveryDepth = depth;
  run.recovery = { packId: pack.id, status: 'planning', depth, startedAt: now() };
  persist();
  log(pack, 'info', 'intent', `Recovery started for ${workflow.name}; failed step ${failedRuntime?.name || '(unknown)'}.`);

  addStage(
    pack,
    'intent',
    '1 · Identify input, intention and fresh completion steps',
    `Intent: ${goal}. Failure: ${clip(failedRuntime?.error || 'unknown', 320)}`,
    [
      {
        name: 'Input and intention',
        substeps: [
          { name: 'Original goal', detail: clip(goal, 500) },
          { name: 'Operator guidance', detail: guidance || 'none' },
          { name: 'Detected target', detail: targetLabel || 'not identified' },
          { name: 'Failure signature', detail: clip(failedRuntime?.error || 'unknown', 400) },
        ],
      },
      {
        name: 'Fresh completion steps',
        substeps: freshOutline(intent, targetLabel),
      },
    ]
  );

  const packStartedAt = performance.now();
  const candidates = [];
  let plannerPlan = null;
  const plannerStartedAt = performance.now();
  try {
    plannerPlan = await withTimeout(plan(goal, { ...workflow, steps: [] }), PLAN_TIMEOUT_MS, 'Recovery planner');
  } catch (err) {
    log(pack, 'warn', 'plan', `Planner unavailable: ${err.message}`);
  }
  pack.timings.plannerMs = elapsedMs(plannerStartedAt);
  if (plannerPlan?.steps?.length) {
    const steps = ensureOpenPrerequisites(plannerPlan.steps);
    candidates.push(
      candidateTest({
        id: 'candidate_fresh',
        label: 'Fresh plan with app-open prerequisites',
        source: 'planner',
        reason: plannerPlan.note || plannerPlan.source || 'Planner rebuilt the goal from scratch.',
        steps,
        plan: plannerPlan,
      })
    );
  }

  if (looksLikeEnvironmentFailure(run, target)) {
    const steps = targetedRepair(workflow, failedStep, target);
    if (steps.length) {
      candidates.push(
        candidateTest({
          id: 'candidate_targeted',
          label: `Reopen ${target} and resume the failed step`,
          source: 'targeted-repair',
          reason: 'The app/window was missing. Open it, wait for it, focus it, then resume where the run stopped.',
          steps,
        })
      );
    }
  }

  // The operator-level question after a failure: continue from where it stopped,
  // or should the plan gain, lose or reorder steps — and does the machine need
  // basic prep first? The model sees the live desktop, the rules and the other
  // workflows, and answers with a plan that starts after the passed steps.
  const aiSteps = cloneSteps((run.steps?.length ? run.steps : workflow.steps) || []).map((step) => ({
    ...step,
    params: step.params || {},
  }));
  const aiFailedIndex = Math.max(
    0,
    aiSteps.findIndex((step) => step.id === failedRuntime?.id || (step.name && step.name === failedRuntime?.name))
  );
  // The desktop capture is the revision's most expensive input and nothing else
  // in a pack uses it, so it only runs when the revision will actually run: not
  // when replanAi is off, not while a recent revision failure says the model is
  // unreachable, and not when the operator or a dry run turned capture off.
  const aiRevisionEnabled = typeof ask === 'function' || d.settings.replanAi !== false;
  pack.aiStatus = aiRevisionEnabled ? 'pending' : 'off';
  const readDesktop = typeof screen === 'function' ? screen : readScreenContext;
  let desktop = desktopInput === undefined ? {} : desktopInput || {};
  if (desktopInput === undefined) {
    if (!aiRevisionEnabled) {
      log(pack, 'info', 'plan', 'AI plan revision is turned off in settings; the desktop was not read.');
    } else if (Date.now() < aiOutageUntil) {
      log(pack, 'info', 'plan', 'The AI revision failed moments ago; skipping the desktop read until the model answers again.');
    } else if (!run.dryRun && d.settings.replanDesktop !== false) {
      const desktopStartedAt = performance.now();
      try {
        desktop = await withTimeout(readDesktop(), 8000, 'Desktop read');
      } catch (err) {
        log(pack, 'warn', 'plan', `Reading the desktop for the revision failed: ${err.message}`);
      } finally {
        pack.timings.desktopReadMs = elapsedMs(desktopStartedAt);
      }
    }
  }
  const evidenceFacts = runEvidenceFacts(run);
  const revisionStartedAt = performance.now();
  const revision = aiRevisionEnabled ? await withTimeout(
    revisePlan({
      ...(typeof ask === 'function' ? { ask } : {}),
      workflow,
      goal,
      steps: aiSteps,
      failedIndex: aiFailedIndex,
      failure: {
        type: failedRuntime?.type || '',
        name: failedRuntime?.name || '',
        error: failedRuntime?.error || '',
      },
      desktop,
      findings: replanFindings(),
      evidence: evidenceFacts,
      // Off means the revision may not plan video or playback work at all.
      allowMedia: d.settings.replanMedia !== false,
      suggestions: (d.suggestions || []).filter((entry) => !entry.dismissed).slice(0, 6),
      lessons: (d.agentLessons || [])
        .filter((entry) => !entry.workflowId || entry.workflowId === workflow.id)
        .slice(0, 6),
      workflows: (d.workflows || []).filter((entry) => entry.id !== workflow.id).slice(0, 8),
    }),
    60000,
    'AI plan revision'
  ).catch((err) => ({ error: err.message })) : null;
  if (aiRevisionEnabled) pack.timings.revisionMs = elapsedMs(revisionStartedAt);
  if (revision?.error) {
    pack.aiStatus = 'unavailable';
    pack.aiError = clip(revision.error, 300);
    aiOutageUntil = Date.now() + AI_OUTAGE_MS;
    log(pack, 'warn', 'plan', `AI plan revision unavailable: ${revision.error}`);
  } else if (revision?.skipped) {
    pack.aiStatus = 'skipped';
    log(pack, 'info', 'plan', 'AI plan revision is turned off in settings.');
  } else if (revision?.steps?.length) {
    aiOutageUntil = 0;
    const transient = isTransientFailure({ type: failedRuntime?.type, error: failedRuntime?.error });
    const replays = Boolean(revision.replaysFailure);
    // "continue" with nothing new hands the retry the exact step that failed, so
    // it only counts as a candidate when the failure may clear by itself.
    const blocked = replays && !transient;
    pack.aiStatus = blocked ? 'replayed' : 'candidate';
    pack.aiRevision = {
      decision: revision.decision,
      note: revision.note,
      prepCount: revision.prepCount,
      resumeFrom: revision.resumeFrom,
      replaysFailure: replays,
      transient,
      blocked,
      droppedPlayback: revision.droppedPlayback || 0,
      evidenceCount: evidenceFacts.length,
      at: now(),
    };
    if (revision.droppedPlayback) {
      log(
        pack,
        'info',
        'plan',
        `AI revision dropped ${revision.droppedPlayback} playback step(s) that no step or user input requires.`
      );
    }
    if (revision.rewrittenGuards) {
      log(
        pack,
        'info',
        'plan',
        `The revision replaced ${revision.rewrittenGuards} window guard(s) the desktop had already refused instead of reusing them.`
      );
    }
    if (blocked) {
      log(
        pack,
        'warn',
        'plan',
        `The AI chose “${revision.decision}” but returned the failed step unchanged; a retry would fail the same way, so it was not made a candidate.`
      );
    } else {
      log(
        pack,
        'info',
        'plan',
        `AI revision: ${revision.decision} with ${revision.prepCount} prep step(s), resuming after ${revision.resumeFrom} passed step(s).${transient ? ' The failure looks transient, so replaying the failed step is allowed.' : ''} ${revision.note}`
      );
      candidates.push(
        candidateTest({
          id: 'candidate_ai',
          label: `AI revision: ${revision.decision}${revision.prepCount ? ` +${revision.prepCount} prep` : ''}`,
          source: 'ai-replan',
          reason: revision.note || `The model chose to ${revision.decision} the plan.`,
          steps: ensureOpenPrerequisites(revision.steps),
        })
      );
    }
  }

  addStage(
    pack,
    'plan',
    '2 · Break the intent into plans and substeps',
    `${candidates.length} candidate plan(s) built.`,
    candidates.map((candidate) => ({
      name: candidate.label,
      substeps: stepSummary(candidate.steps),
    })),
    candidates.length ? 'info' : 'warn'
  );

  const adviseStartedAt = performance.now();
  const advice = consultControlPanel(workflow, goal, targetLabel);
  pack.timings.agentConsultMs = elapsedMs(adviseStartedAt);
  pack.agents = advice.agents;
  pack.research = advice.research;
  addStage(
    pack,
    'agents',
    '3 · Ask Control Panel agents for better solutions',
    `${advice.agents.length} agent(s), ${advice.suggestions.length} open suggestion(s), ${advice.shortcuts.length} learned shortcut(s) consulted.`,
    [
      {
        name: 'Agent advice',
        substeps: advice.agents.map((agent) => ({ name: `${agent.name} · ${agent.status}`, detail: agent.advice })),
      },
      {
        name: 'History and shortcuts',
        substeps: [
          { name: 'Open suggestions', detail: advice.suggestions.join(' · ') || 'none' },
          { name: 'Learned shortcuts', detail: advice.shortcuts.map((habit) => `${habit.app}: ${habit.action}`).join(' · ') || 'none' },
          { name: 'Research summary', detail: clip(JSON.stringify(advice.research?.summary || {}), 300) },
        ],
      },
    ]
  );

  pack.candidates = candidates;
  pack.timings.shadowTestMs = candidates.reduce((total, candidate) => total + (Number(candidate.testMs) || 0), 0);
  const environmentFailure = looksLikeEnvironmentFailure(run, target);
  const targeted = candidates.find((candidate) => candidate.id === 'candidate_targeted' && candidate.test.ok);
  const fresh = candidates.find((candidate) => candidate.id === 'candidate_fresh' && candidate.test.ok);
  const aiCandidate = candidates.find((candidate) => candidate.id === 'candidate_ai' && candidate.test.ok);
  // The operator asked for a replan: a passing AI revision outranks the fresh
  // rebuild unless the failure was a missing window, which the targeted repair
  // handles with fewer moving parts.
  const selected = (environmentFailure && targeted) || aiCandidate || fresh || candidates.find((candidate) => candidate.test.ok) || null;
  pack.selectedCandidateId = selected?.id || null;
  addStage(
    pack,
    'test',
    '4 · Test the candidates and select a workflow',
    selected
      ? `Selected “${selected.label}” after a non-destructive shadow test (${selected.score}%).`
      : pack.aiRevision?.blocked
        ? 'No candidate passed: the AI revision would have replayed the failed step unchanged, and no other candidate passed its test. The workflow was not changed.'
        : 'No candidate passed the shadow test; the workflow was not changed.',
    candidates.map((candidate) => ({
      name: candidate.label,
      substeps: [
        { name: candidate.test.status, detail: `${candidate.score}% · ${candidate.test.passed}/${candidate.test.total} checks` },
        { name: 'Failures', detail: (candidate.test.failures || []).map((item) => item.reason).join(' · ') || 'none' },
        { name: 'Warnings', detail: (candidate.test.warnings || []).join(' · ') || 'none' },
      ],
    })),
    selected ? 'info' : 'warn'
  );

  const history = (d.runs || [])
    .filter((entry) => entry.workflowId === workflow.id && entry.status === 'failed')
    .slice(0, 8)
    .map((entry) => ({ id: entry.id, at: entry.endedAt || entry.createdAt, signature: entry.failureSignature || entry.errorCategory || '' }));
  const followups = selected
    ? [
        selected.id === 'candidate_targeted' ? 'Resume the saved steps after the reopened window.' : 'Run the fresh plan end to end.',
        'Compare the retry result with the prior failure signatures before incorporating it.',
      ]
    : ['Review the failed shadow checks and edit the candidate before running it.', 'Forward to Control Center only if the local repair is unsafe.'];
  addStage(
    pack,
    'verify',
    '5 · Final verification, history and follow-ups',
    selected
      ? 'Candidate selected; retry will run from a snapshot and the saved workflow will update only after a pass.'
      : 'No safe candidate selected; the run remains failed for manual review.',
    [
      {
        name: 'History cross-reference',
        substeps: [
          { name: 'Prior failures', detail: history.map((entry) => `${entry.id}: ${entry.signature}`).join(' · ') || 'none' },
          { name: 'Research hints', detail: (advice.research?.memory || []).map((entry) => entry.hindrances?.[0]).filter(Boolean).slice(0, 4).join(' · ') || 'none' },
        ],
      },
      { name: 'Follow-ups', substeps: followups.map((item) => ({ name: item, detail: '' })) },
    ],
    selected ? 'info' : 'warn'
  );

  pack.status = selected ? 'ready' : 'needs_review';
  pack.timings.totalMs = elapsedMs(packStartedAt);
  pack.updatedAt = now();
  run.recovery.status = pack.status;
  run.recovery.selectedCandidateId = pack.selectedCandidateId;
  recordRecoveryTelemetry(pack);
  persist();

  const retryWorkflow = selected
    ? {
        ...workflow,
        steps: cloneSteps(selected.steps).map((step, index) => ({
          ...step,
          id: step.id || uid('stp'),
          name: String(step.name || `Step ${index + 1}`).slice(0, 100),
        })),
        failurePolicy: { ...(workflow.failurePolicy || {}), onFailure: 'stop', maxRetries: 0 },
        lastPlanSource: 'recovery',
        lastPlanNote: selected.reason,
      }
    : null;

  return { pack, retryWorkflow, selected: selected || null };
}

/** Incorporate one candidate into the saved workflow. */
export function applyRecoveryPack(id, { candidateId = null, by = 'operator', silent = false } = {}) {
  const pack = findRecoveryPack(id);
  if (!pack) throw new Error('Recovery pack not found');
  const chosen = (pack.candidates || []).find((candidate) => candidate.id === (candidateId || pack.selectedCandidateId));
  if (!chosen) throw new Error('No selected recovery candidate');
  const workflow = (db().workflows || []).find((entry) => entry.id === pack.workflowId);
  if (!workflow) throw new Error('Workflow for this recovery pack no longer exists');
  workflow.steps = cloneSteps(chosen.steps).map((step, index) => ({
    ...step,
    id: step.id || uid('stp'),
    name: String(step.name || `Step ${index + 1}`).slice(0, 100),
  }));
  workflow.updatedAt = now();
  workflow.lastRecoveryPackId = pack.id;
  workflow.lastRecoveryAt = now();
  workflow.lastPlanSource = 'recovery';
  workflow.lastPlanNote = chosen.reason;
  pack.incorporated = true;
  pack.appliedAt = now();
  pack.appliedBy = by;
  pack.updatedAt = now();
  log(pack, 'info', 'verify', `Candidate “${chosen.label}” incorporated into ${workflow.name}.`);
  persist();
  if (!silent) logActivity('recovery', `Applied recovery ${pack.id} to ${workflow.name}`, { workflowId: workflow.id, packId: pack.id });
  return { pack, workflow };
}

/** Record the retry result and only then incorporate a passing recovery. */
export function finalizeRecoveryPack(run) {
  if (!run?.recoveryPackId) return null;
  const pack = findRecoveryPack(run.recoveryPackId);
  if (!pack) return null;
  const passed = run.status === 'passed';
  pack.verification = {
    status: run.status,
    passed: (run.steps || []).filter((step) => step.status === 'passed').length,
    total: (run.steps || []).length,
    error: clip((run.steps || []).find((step) => step.status === 'failed')?.error || '', 500),
    evidenceCount: (run.evidence || []).length,
    analysis: run.analysis
      ? {
          source: run.analysis.source || null,
          summary: clip(run.analysis.summary || '', 500),
          rootCause: clip(run.analysis.rootCause || '', 500),
          nextActions: (run.analysis.nextActions || []).slice(0, 4),
        }
      : null,
    retryRunId: run.id,
    at: now(),
  };
  pack.updatedAt = now();
  pack.status = passed ? 'passed' : 'failed';
  recordRecoveryTelemetry(pack, {
    outcome: {
      status: run.status,
      passed,
      retryRunId: run.id,
      failedStep: clip((run.steps || []).find((step) => step.status === 'failed')?.name || '', 120) || null,
      durationMs: Number.isFinite(run.durationMs) ? run.durationMs : null,
      at: now(),
    },
  });
  log(pack, passed ? 'info' : 'warn', 'verify', `Retry ${run.id} finished ${run.status}.`);

  const original = (db().runs || []).find((entry) => entry.id === pack.originalRunId);
  if (original) {
    original.recoveryPackId = pack.id;
    original.recovery = {
      ...(original.recovery || {}),
      packId: pack.id,
      status: pack.status,
      verdict: passed ? 'recovered' : 'failed',
      completedAt: now(),
    };
    if (passed) original.recovered = true;
    else original.recovery.followup = 'A recovery retry failed; review the pack and edit the candidate before another attempt.';
  }

  if (passed) {
    try {
      applyRecoveryPack(pack.id, { by: 'auto-recovery', silent: true });
      pack.status = 'passed';
      logActivity('recovery', `Recovery ${pack.id} passed and was incorporated`, { workflowId: pack.workflowId, packId: pack.id });
    } catch (err) {
      log(pack, 'error', 'verify', `Passed retry could not be incorporated: ${err.message}`);
    }
  } else {
    log(pack, 'error', 'verify', 'Retry failed; saved workflow was left unchanged.');
    addSuggestion(
      `Recovery ${pack.id} failed on “${pack.workflowName}”. Review the pack and select a different candidate.`,
      'recovery',
      pack.workflowId,
      run.id
    );
  }
  persist();
  return pack;
}