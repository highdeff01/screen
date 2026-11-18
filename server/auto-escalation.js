/**
 * Automatic Command Center usage.
 *
 * A failed run is repaired in place first (run-recovery.js). When that repair is
 * impossible, cannot be prepared, or the workflow keeps failing, the run is
 * escalated into a supervised mission so the Command Center is actually used
 * instead of waiting for someone to click "forward". Every guard here is
 * bounded: a failure streak, one mission per workflow at a time, a daily cap and
 * a trigger filter, so an unattended console cannot start an unbounded number of
 * missions.
 */
import { db, logActivity } from './store.js';
import { findMission } from './missions.js';

export const ACTIVE_MISSION_STATUSES = ['queued', 'planning', 'running', 'verifying', 'reviewing', 'replanning'];
const BLOCKED_TRIGGERS = ['mission', 'shadow', 'shortcut-replay', 'presentation-audit'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min));

function settings() {
  return db().settings || {};
}

/** The escalation policy as it is configured right now, with usable bounds. */
export function escalationConfig() {
  const s = settings();
  return {
    enabled: s.autoForwardFailures !== false,
    minFailures: clamp(s.autoEscalateMinFailures ?? 2, 1, 10),
    dailyCap: clamp(s.autoEscalateDailyCap ?? 3, 0, 25),
  };
}

function dayKey(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** Missions the policy started today; the cap counts only its own work. */
export function escalatedToday(at = null) {
  const day = dayKey(at);
  return db().missions.filter((mission) => mission.trigger === 'failure' && dayKey(mission.createdAt) === day).length;
}

/**
 * Failed runs of one workflow since its last pass, newest first. The run that is
 * being decided is included, so a workflow with two failures in a row reports 2.
 */
export function failureStreak(workflowId) {
  const runs = db()
    .runs.filter((run) => run.workflowId === workflowId)
    .slice()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  let streak = 0;
  for (const run of runs) {
    if (run.status === 'passed') break;
    if (run.status === 'failed') streak += 1;
  }
  return streak;
}

function activeMissionFor(workflowId) {
  return (
    db().missions.find(
      (mission) => mission.workflowId === workflowId && ACTIVE_MISSION_STATUSES.includes(mission.status)
    ) || null
  );
}

/**
 * Whether this run should become a mission. Returns a decision object so the
 * caller, the UI and the tests can see the reason a failure was left alone.
 */
export function escalationDecision(run, { recoveryQueued = false, at = null } = {}) {
  const config = escalationConfig();
  if (!config.enabled) return { escalate: false, reason: 'auto-escalation is off', config };
  if (!run || run.status !== 'failed') return { escalate: false, reason: 'run did not fail', config };
  if (BLOCKED_TRIGGERS.includes(run.trigger)) {
    return { escalate: false, reason: `${run.trigger} runs are not escalated`, config };
  }
  if (run.forwardedMissionId && findMission(run.forwardedMissionId)) {
    return { escalate: false, reason: 'already forwarded to a mission', config };
  }
  if (run.forwardedMissionId) {
    // The mission was deleted, so the run is free to be escalated again.
    run.forwardedMissionId = null;
  }
  if (recoveryQueued) {
    return { escalate: false, reason: 'an automatic repair is already queued', config };
  }
  const workflow = db().workflows.find((entry) => entry.id === run.workflowId);
  if (!workflow) return { escalate: false, reason: 'the run workflow no longer exists', config };
  const active = activeMissionFor(workflow.id);
  if (active) return { escalate: false, reason: `mission ${active.id} is already working on this workflow`, config };
  const streak = failureStreak(workflow.id);
  if (streak < config.minFailures) {
    return { escalate: false, reason: `${streak}/${config.minFailures} consecutive failures`, streak, config };
  }
  const today = escalatedToday(at);
  if (today >= config.dailyCap) {
    return { escalate: false, reason: `the daily cap of ${config.dailyCap} mission(s) is reached`, streak, today, config };
  }
  return { escalate: true, reason: `${streak} consecutive failures`, streak, today, config };
}

/**
 * Apply the policy to one finished run. `forward` is the console's existing
 * "failed run → mission" builder and `start` is startMission(); both are
 * injected so a test can assert the decision without launching a real mission.
 */
export function escalateFailedRun(
  run,
  { recoveryQueued = false, forward, start, at = null } = {}
) {
  if (typeof forward !== 'function' || typeof start !== 'function') {
    throw new Error('escalateFailedRun needs the forward and start functions');
  }
  const decision = escalationDecision(run, { recoveryQueued, at });
  if (!decision.escalate) return { mission: null, decision };
  const mission = forward(run, { auto: true });
  start(mission.id);
  logActivity('mission', `Auto-escalated ${run.id} to the Command Center as ${mission.id}`, {
    runId: run.id,
    missionId: mission.id,
    reason: decision.reason,
  });
  return { mission, decision };
}

/**
 * Failed runs the operator can send to the Command Center in one step: newest
 * first, one per workflow (the newest failure stands for the whole streak), with
 * runs that already have a mission, a live mission on the same workflow, or an
 * ineligible trigger left out.
 */
export function escalationCandidates() {
  const missions = db().missions || [];
  const seen = new Set();
  const candidates = [];
  for (const run of db().runs) {
    if (run.status !== 'failed') continue;
    if (BLOCKED_TRIGGERS.includes(run.trigger)) continue;
    if (run.forwardedMissionId && missions.some((mission) => mission.id === run.forwardedMissionId)) continue;
    if (seen.has(run.workflowId)) continue;
    if (activeMissionFor(run.workflowId)) continue;
    seen.add(run.workflowId);
    candidates.push({
      runId: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      failedAt: run.completedAt || run.createdAt || null,
      dryRun: Boolean(run.dryRun),
      streak: failureStreak(run.workflowId),
      failedStep: (run.steps || []).find((step) => step.status === 'failed')?.name || '',
    });
  }
  return candidates.sort((a, b) => String(b.failedAt || '').localeCompare(String(a.failedAt || '')));
}

/** What the API and the Command Center banner report. */
export function escalationStatus() {
  const config = escalationConfig();
  const today = escalatedToday();
  const candidates = escalationCandidates();
  return {
    ...config,
    today,
    remaining: Math.max(0, config.dailyCap - today),
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 8),
    lastEscalatedAt:
      (db().missions || []).find((mission) => mission.trigger === 'failure')?.createdAt || null,
  };
}

/**
 * Send the newest failures to the Command Center, bounded by the daily cap.
 * This is the operator's "use the Command Center" button, not a background loop.
 */
export function escalateBacklog({ limit = 3, forward, start } = {}) {
  if (typeof forward !== 'function' || typeof start !== 'function') {
    throw new Error('escalateBacklog needs the forward and start functions');
  }
  const config = escalationConfig();
  const today = escalatedToday();
  const room = Math.max(0, config.dailyCap - today);
  const wanted = Math.min(Math.max(1, Number(limit) || 3), room, 10);
  const result = { started: [], skipped: [], room, remaining: room };
  if (wanted <= 0) {
    result.skipped.push({ reason: `the daily cap of ${config.dailyCap} mission(s) is reached` });
    return result;
  }
  for (const candidate of escalationCandidates().slice(0, wanted)) {
    const run = db().runs.find((entry) => entry.id === candidate.runId);
    if (!run) continue;
    try {
      const mission = forward(run, { auto: true });
      start(mission.id);
      result.started.push({ runId: run.id, missionId: mission.id, workflowName: run.workflowName });
      logActivity('mission', `Queued failed run ${run.id} in the Command Center as ${mission.id}`, {
        runId: run.id,
        missionId: mission.id,
      });
    } catch (err) {
      result.skipped.push({ runId: run.id, reason: err.message });
    }
  }
  result.remaining = Math.max(0, config.dailyCap - escalatedToday());
  return result;
}
