import { db, persist, uid, now } from './store.js';

const MAX_CANDIDATES = 80;
const MAX_HABITS = 60;
const MAX_BLOCKS = 60;
const MAX_DECISIONS = 200;
const MIN_CONFIDENCE = 60;
const UNSAFE = /(?:alt\+f4|ctrl\+w|ctrl\+shift\+delete|win\+l|super\+l|%\{f4\}|\^w)/i;

function clean(value, max = 180) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function keysOf(step) {
  const raw = Array.isArray(step?.params?.keys) ? step.params.keys.join('+') : String(step?.params?.keys || '').trim();
  return raw.replace(/\s+/g, '');
}

function contextOf(step) {
  const observed = step?.appContext || step?.context || {};
  const params = step?.params || {};
  return {
    process: clean(observed.process || params.process, 80),
    windowTitle: clean(observed.title || params.windowTitle || params.foreground || params.window, 180),
    windowClass: clean(observed.className || observed.windowClass || params.windowClass, 120),
    appVersion: clean(observed.version || observed.appVersion || params.appVersion, 80),
  };
}

function appOf(step, mission, context) {
  return clean(context?.process || step?.params?.foreground || step?.params?.window || mission?.workflowName || 'desktop', 80);
}

function appKeyOf(app, context) {
  if (context?.process) return `${context.process.toLowerCase()}|${context.windowClass.toLowerCase()}`;
  return String(app || 'desktop').toLowerCase();
}

function preconditionsOf(context) {
  return {
    process: context.process || '',
    windowTitle: context.windowTitle || '',
    windowClass: context.windowClass || '',
  };
}

export function shortcutSpec(step, mission) {
  if (step?.type !== 'key') return null;
  const keys = keysOf(step);
  if (!keys) return null;
  const context = contextOf(step);
  const app = appOf(step, mission, context);
  const action = clean(step?.name || step?.params?.actionName || 'shortcut', 100);
  const appKey = appKeyOf(app, context);
  return {
    app,
    appKey,
    keys,
    action,
    process: context.process,
    windowTitle: context.windowTitle,
    windowClass: context.windowClass,
    appVersion: context.appVersion,
    preconditions: preconditionsOf(context),
    fingerprint: `${appKey}|${keys.toLowerCase()}|${action.toLowerCase()}`,
  };
}

export function shortcutConfidence(habit) {
  const successes = Math.max(0, Number(habit?.successes ?? habit?.wins ?? 0));
  const failures = Math.max(0, Number(habit?.failures || 0));
  let confidence = ((successes + 1) / (successes + failures + 2)) * 100;
  const last = habit?.lastAt ? Date.parse(habit.lastAt) : 0;
  if (last) {
    const days = (Date.now() - last) / 86400000;
    if (days > 90) confidence -= 25;
    else if (days > 30) confidence -= 10;
  }
  if (habit?.lastFailedAt && (!habit?.lastAt || Date.parse(habit.lastFailedAt) > Date.parse(habit.lastAt))) {
    confidence -= 10;
  }
  return Math.max(0, Math.min(100, Math.round(confidence)));
}

function normalizePreconditions(raw = {}) {
  return {
    process: clean(raw.process || '', 80),
    windowTitle: clean(raw.windowTitle || raw.title || '', 180),
    windowClass: clean(raw.windowClass || raw.className || '', 120),
  };
}

function normalizeHabit(habit) {
  const context = normalizePreconditions(habit.preconditions || {});
  const app = clean(habit.app || 'desktop', 80);
  const action = clean(habit.action || habit.name || 'shortcut', 100);
  const appKey = clean(habit.appKey || appKeyOf(app, { process: habit.process || context.process, windowClass: habit.windowClass || context.windowClass }), 220);
  return {
    ...habit,
    app,
    appKey,
    action,
    process: clean(habit.process || context.process, 80),
    windowTitle: clean(habit.windowTitle || context.windowTitle, 180),
    windowClass: clean(habit.windowClass || context.windowClass, 120),
    preconditions: context,
    fingerprint: habit.fingerprint || `${appKey}|${String(habit.keys || '').toLowerCase()}|${action.toLowerCase()}`,
    approved: habit.approved === true,
    enabled: habit.enabled !== false,
    replayStatus: habit.replayStatus === 'passed' || habit.replayStatus === 'failed' ? habit.replayStatus : 'pending',
    replayPasses: Math.max(0, Number(habit.replayPasses || 0)),
    replayFailures: Math.max(0, Number(habit.replayFailures || 0)),
    successes: Math.max(0, Number(habit.successes ?? habit.wins ?? 0)),
    failures: Math.max(0, Number(habit.failures || 0)),
    confidence: shortcutConfidence(habit),
  };
}

function normalizeCandidate(candidate) {
  const context = normalizePreconditions(candidate.preconditions || {});
  const app = clean(candidate.app || 'desktop', 80);
  const action = clean(candidate.action || candidate.name || 'shortcut', 100);
  const appKey = clean(candidate.appKey || appKeyOf(app, { process: candidate.process || context.process, windowClass: candidate.windowClass || context.windowClass }), 220);
  return {
    ...candidate,
    app,
    appKey,
    action,
    process: clean(candidate.process || context.process, 80),
    windowTitle: clean(candidate.windowTitle || context.windowTitle, 180),
    windowClass: clean(candidate.windowClass || context.windowClass, 120),
    preconditions: context,
    fingerprint: candidate.fingerprint || `${appKey}|${String(candidate.keys || '').toLowerCase()}|${action.toLowerCase()}`,
    status: candidate.status || 'pending',
    seen: Math.max(1, Number(candidate.seen || 1)),
  };
}

function recordDecision(d, entry) {
  if (!Array.isArray(d.shortcutDecisions)) d.shortcutDecisions = [];
  d.shortcutDecisions.push({
    id: uid('sdc'),
    at: now(),
    ...entry,
  });
  d.shortcutDecisions = d.shortcutDecisions.slice(-MAX_DECISIONS);
}

function candidateFromHabit(habit, version, source = 'app-update') {
  return normalizeCandidate({
    ...habit,
    id: uid('sct'),
    status: 'pending',
    source,
    seen: Math.max(1, Number(habit.successes || 1)),
    firstSeenAt: habit.createdAt || habit.lastAt || now(),
    lastSeenAt: now(),
    appVersion: version || habit.appVersion || '',
    steps: [],
    reviewSummary: `Review after ${source === 'app-update' ? 'the app changed version' : 'replay'}: ${habit.fingerprint}`,
  });
}

function demoteHabitForAppUpdate(d, habit, version) {
  if (!habit || !habit.approved) return false;
  habit.enabled = false;
  habit.replayStatus = 'pending';
  habit.reviewReason = 'app-update';
  habit.previousAppVersion = habit.appVersion || null;
  habit.appVersion = version || habit.appVersion || '';
  habit.updatedAt = now();

  const existing = d.shortcutCandidates.find((candidate) => candidate.fingerprint === habit.fingerprint);
  if (existing) {
    if (existing.status !== 'never') {
      existing.status = 'pending';
      existing.lastSeenAt = now();
      existing.appVersion = habit.appVersion;
      existing.restoredAt = null;
    }
  } else {
    d.shortcutCandidates.push(candidateFromHabit(habit, habit.appVersion));
  }
  recordDecision(d, {
    action: 'invalidate',
    target: 'habit',
    candidateId: existing?.id || null,
    habitId: habit.id,
    app: habit.app,
    keys: habit.keys,
    shortcut: habit.action,
    reason: `App version changed from ${habit.previousAppVersion || 'unknown'} to ${habit.appVersion || 'unknown'}`,
    by: 'system',
  });
  return true;
}

function observeApp(d, spec) {
  if (!spec?.appKey) return false;
  if (!d.shortcutApps || typeof d.shortcutApps !== 'object' || Array.isArray(d.shortcutApps)) {
    d.shortcutApps = {};
  }
  const previous = d.shortcutApps[spec.appKey];
  d.shortcutApps[spec.appKey] = {
    app: spec.app,
    appKey: spec.appKey,
    process: spec.process,
    windowTitle: spec.windowTitle,
    windowClass: spec.windowClass,
    version: spec.appVersion || previous?.version || '',
    at: now(),
  };
  if (!previous?.version || !spec.appVersion || previous.version === spec.appVersion) return false;
  let changed = false;
  for (const habit of d.shortcutHabits) {
    if (habit.approved && habit.appKey === spec.appKey) {
      changed = demoteHabitForAppUpdate(d, habit, spec.appVersion) || changed;
    }
  }
  return changed;
}

function invalidateHabitsForObservedVersions(d) {
  let changed = false;
  for (const habit of d.shortcutHabits) {
    if (!habit.approved) continue;
    const observed = d.shortcutApps?.[habit.appKey]?.version;
    if (observed && habit.appVersion && observed !== habit.appVersion) {
      changed = demoteHabitForAppUpdate(d, habit, observed) || changed;
    }
  }
  return changed;
}

export function ensureShortcutStore() {
  const d = db();
  let changed = false;
  if (!Array.isArray(d.shortcutHabits)) {
    d.shortcutHabits = [];
    changed = true;
  }
  if (!Array.isArray(d.shortcutCandidates)) {
    d.shortcutCandidates = [];
    changed = true;
  }
  if (!Array.isArray(d.shortcutBlocks)) {
    d.shortcutBlocks = [];
    changed = true;
  }
  if (!Array.isArray(d.shortcutDecisions)) {
    d.shortcutDecisions = [];
    changed = true;
  }
  if (!d.shortcutApps || typeof d.shortcutApps !== 'object' || Array.isArray(d.shortcutApps)) {
    d.shortcutApps = {};
    changed = true;
  }

  // Habits created before explicit approval existed are moved back to the
  // review queue. They must not steer a planner until someone approves them.
  for (const habit of [...d.shortcutHabits]) {
    if (habit.approved !== undefined) continue;
    d.shortcutHabits = d.shortcutHabits.filter((entry) => entry.id !== habit.id);
    d.shortcutCandidates.push(
      normalizeCandidate({
        ...habit,
        id: uid('sct'),
        status: 'pending',
        source: 'legacy',
        seen: Math.max(1, Number(habit.wins || 1)),
        firstSeenAt: habit.createdAt || habit.lastAt || now(),
        lastSeenAt: habit.lastAt || now(),
        steps: [],
      })
    );
    changed = true;
  }

  d.shortcutHabits = d.shortcutHabits.map(normalizeHabit);
  d.shortcutCandidates = d.shortcutCandidates.map(normalizeCandidate).slice(-MAX_CANDIDATES);
  d.shortcutBlocks = d.shortcutBlocks
    .map((block) => {
      if (!block.id) changed = true;
      return { ...block, id: block.id || uid('sblk') };
    })
    .slice(-MAX_BLOCKS);
  if (invalidateHabitsForObservedVersions(d)) changed = true;
  if (changed) persist();
  return d;
}

export function queueShortcutCandidates(mission, run, review) {
  if (mission?.mode !== 'live' || run?.status !== 'passed' || !review?.summary) return;
  const d = ensureShortcutStore();
  const blocked = new Set(d.shortcutBlocks.map((entry) => entry.fingerprint));
  const evidencePath = (run.evidence || []).filter((item) => item.path).slice(-1)[0]?.path || null;
  let changed = false;

  for (const step of run.steps || []) {
    if (step.status !== 'passed') continue;
    const spec = shortcutSpec(step, mission);
    if (!spec || UNSAFE.test(spec.keys) || blocked.has(spec.fingerprint)) continue;
    const appChanged = observeApp(d, spec);
    if (appChanged) changed = true;
    const learned = d.shortcutHabits.find((habit) => habit.approved && habit.fingerprint === spec.fingerprint);
    if (learned && !appChanged) continue;

    const existing = d.shortcutCandidates.find((candidate) => candidate.fingerprint === spec.fingerprint);
    if (existing) {
      if (existing.status === 'pending') {
        existing.seen = Number(existing.seen || 1) + 1;
        existing.lastSeenAt = now();
        existing.steps = [...new Set([...(existing.steps || []), step.id].filter(Boolean))].slice(-8);
        existing.appVersion = spec.appVersion || existing.appVersion;
        changed = true;
      }
      continue;
    }

    d.shortcutCandidates.push({
      id: uid('sct'),
      ...spec,
      status: 'pending',
      source: 'mission',
      seen: 1,
      firstSeenAt: now(),
      lastSeenAt: now(),
      workflowId: mission.workflowId,
      workflowName: mission.workflowName,
      missionId: mission.id,
      runId: run.id,
      stepId: step.id || null,
      steps: step.id ? [step.id] : [],
      evidencePath,
      reviewSummary: String(review.summary || '').slice(0, 500),
    });
    changed = true;
  }

  if (changed) {
    d.shortcutCandidates.sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
    d.shortcutCandidates = d.shortcutCandidates.slice(0, MAX_CANDIDATES);
    persist();
  }
}

export function recordShortcutOutcomes(mission, run) {
  if (mission?.mode !== 'live' || !run) return;
  const d = ensureShortcutStore();
  let changed = false;
  for (const step of run.steps || []) {
    if (!['passed', 'failed'].includes(step.status)) continue;
    const spec = shortcutSpec(step, mission);
    if (!spec) continue;
    const appChanged = observeApp(d, spec);
    if (appChanged) changed = true;
    const habit = d.shortcutHabits.find((entry) => entry.approved && entry.fingerprint === spec.fingerprint);
    if (!habit || habit.lastRunId === run.id) continue;
    if (step.status === 'passed') {
      habit.successes = Math.max(0, Number(habit.successes || 0)) + 1;
      habit.lastAt = now();
      if (habit.replayStatus !== 'passed' && habit.approvedRunId && habit.approvedRunId !== run.id) {
        habit.replayStatus = 'passed';
        habit.replayPasses = Math.max(0, Number(habit.replayPasses || 0)) + 1;
        habit.lastReplayAt = now();
        habit.lastReplayRunId = run.id;
        habit.reviewReason = null;
        recordDecision(d, {
          action: 'replay-pass',
          target: 'habit',
          habitId: habit.id,
          app: habit.app,
          keys: habit.keys,
          shortcut: habit.action,
          reason: `Independent live run ${run.id} passed`,
          by: 'system',
        });
      }
    } else {
      habit.failures = Math.max(0, Number(habit.failures || 0)) + 1;
      habit.lastFailedAt = now();
      if (habit.replayStatus !== 'passed') {
        habit.replayStatus = 'failed';
        habit.replayFailures = Math.max(0, Number(habit.replayFailures || 0)) + 1;
        habit.enabled = false;
        habit.reviewReason = 'replay-failed';
      }
    }
    habit.lastRunId = run.id;
    habit.confidence = shortcutConfidence(habit);
    changed = true;
  }
  if (changed) persist();
}

export function recordShortcutReplayOutcome(id, run) {
  const d = ensureShortcutStore();
  const habit = d.shortcutHabits.find((entry) => entry.id === id);
  if (!habit) return null;
  habit.replayStatus = run?.status === 'passed' ? 'passed' : 'failed';
  habit.lastReplayAt = now();
  habit.lastReplayRunId = run?.id || null;
  if (run?.status === 'passed') {
    habit.replayPasses = Math.max(0, Number(habit.replayPasses || 0)) + 1;
    habit.reviewReason = null;
  } else {
    habit.replayFailures = Math.max(0, Number(habit.replayFailures || 0)) + 1;
    habit.enabled = false;
    habit.reviewReason = 'replay-failed';
  }
  habit.updatedAt = now();
  recordDecision(d, {
    action: habit.replayStatus === 'passed' ? 'replay-pass' : 'replay-fail',
    target: 'habit',
    habitId: habit.id,
    app: habit.app,
    keys: habit.keys,
    shortcut: habit.action,
    reason: `Replay run ${run?.id || 'unknown'} ${run?.status || 'failed'}`,
    by: 'system',
  });
  persist();
  return habit;
}

export function listShortcuts() {
  const d = ensureShortcutStore();
  return {
    candidates: d.shortcutCandidates
      .filter((candidate) => candidate.status === 'pending')
      .sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
      .slice(0, 40),
    habits: d.shortcutHabits
      .filter((habit) => habit.approved)
      .map((habit) => ({ ...habit, confidence: shortcutConfidence(habit) }))
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
      .slice(0, 40),
    blocked: d.shortcutBlocks.slice(-20),
    decisions: d.shortcutDecisions.slice(-40).reverse(),
  };
}

function appMatches(habit, scope) {
  if (!scope) return false;
  const wanted = typeof scope === 'string'
    ? { app: scope }
    : {
        app: scope.app || scope.name || '',
        process: scope.process || '',
        appKey: scope.appKey || '',
      };
  if (!wanted.app && !wanted.process && !wanted.appKey) return false;
  if (wanted.appKey && habit.appKey === wanted.appKey) return true;
  const values = [habit.app, habit.process].filter(Boolean).map((value) => String(value).toLowerCase());
  return [wanted.app, wanted.process].filter(Boolean).some((value) => values.includes(String(value).toLowerCase()));
}

export function eligibleShortcuts(limit = 8, scope = null) {
  const d = ensureShortcutStore();
  return d.shortcutHabits
    .filter(
      (habit) =>
        habit.approved &&
        habit.enabled !== false &&
        habit.replayStatus === 'passed' &&
        shortcutConfidence(habit) >= MIN_CONFIDENCE &&
        appMatches(habit, scope)
    )
    .map((habit) => ({ ...habit, confidence: shortcutConfidence(habit) }))
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

export function getShortcutHabit(id) {
  return ensureShortcutStore().shortcutHabits.find((entry) => entry.id === id) || null;
}

export function decideShortcut(id, decision, by = 'operator') {
  const d = ensureShortcutStore();
  const candidate = d.shortcutCandidates.find((entry) => entry.id === id);
  if (!candidate) throw new Error('Shortcut candidate not found');
  const action = String(decision || '').toLowerCase();
  if (!['approve', 'reject', 'never'].includes(action)) throw new Error('Decision must be approve, reject or never');

  if (action === 'never') {
    if (!d.shortcutBlocks.some((entry) => entry.fingerprint === candidate.fingerprint)) {
      d.shortcutBlocks.push({
        id: uid('sblk'),
        fingerprint: candidate.fingerprint,
        app: candidate.app,
        appKey: candidate.appKey,
        keys: candidate.keys,
        action: candidate.action,
        at: now(),
        by,
      });
      d.shortcutBlocks = d.shortcutBlocks.slice(-MAX_BLOCKS);
    }
    candidate.status = 'never';
    candidate.decidedAt = now();
    candidate.decidedBy = by;
    recordDecision(d, {
      action: 'never',
      target: 'candidate',
      candidateId: candidate.id,
      app: candidate.app,
      keys: candidate.keys,
      shortcut: candidate.action,
      reason: 'Blocked from future learning',
      by,
    });
    persist();
    return { candidate, blocked: true };
  }

  if (action === 'reject') {
    candidate.status = 'rejected';
    candidate.decidedAt = now();
    candidate.decidedBy = by;
    recordDecision(d, {
      action: 'reject',
      target: 'candidate',
      candidateId: candidate.id,
      app: candidate.app,
      keys: candidate.keys,
      shortcut: candidate.action,
      reason: 'Rejected by operator',
      by,
    });
    persist();
    return { candidate, blocked: false };
  }

  let habit = d.shortcutHabits.find((entry) => entry.fingerprint === candidate.fingerprint);
  if (!habit) {
    habit = {
      id: uid('sht'),
      fingerprint: candidate.fingerprint,
      app: candidate.app,
      appKey: candidate.appKey,
      keys: candidate.keys,
      action: candidate.action,
      name: candidate.action,
      process: candidate.process,
      windowTitle: candidate.windowTitle,
      windowClass: candidate.windowClass,
      preconditions: candidate.preconditions,
      appVersion: candidate.appVersion,
      successes: Math.max(1, Number(candidate.seen || 1)),
      failures: 0,
      approved: true,
      enabled: true,
      replayStatus: 'pending',
      replayPasses: 0,
      replayFailures: 0,
      approvedAt: now(),
      approvedBy: by,
      createdAt: candidate.firstSeenAt || now(),
      lastAt: candidate.lastSeenAt || now(),
      approvedRunId: candidate.runId || null,
      workflowId: candidate.workflowId || null,
      runId: candidate.runId || null,
      evidencePath: candidate.evidencePath || null,
    };
    habit.confidence = shortcutConfidence(habit);
    d.shortcutHabits.push(habit);
  } else {
    habit.approved = true;
    habit.approvedAt = now();
    habit.approvedBy = by;
    if (candidate.source === 'app-update' || habit.reviewReason === 'app-update') {
      habit.appKey = candidate.appKey;
      habit.process = candidate.process;
      habit.windowTitle = candidate.windowTitle;
      habit.windowClass = candidate.windowClass;
      habit.preconditions = candidate.preconditions;
      habit.appVersion = candidate.appVersion;
      habit.reviewReason = null;
      habit.replayStatus = 'pending';
      habit.enabled = true;
    }
    habit.confidence = shortcutConfidence(habit);
  }
  candidate.status = 'approved';
  candidate.decidedAt = now();
  candidate.decidedBy = by;
  d.shortcutHabits = d.shortcutHabits.slice(-MAX_HABITS);
  recordDecision(d, {
    action: 'approve',
    target: 'candidate',
    candidateId: candidate.id,
    habitId: habit.id,
    app: candidate.app,
    keys: candidate.keys,
    shortcut: candidate.action,
    reason: 'Approved; replay required before planner eligibility',
    by,
  });
  persist();
  return { candidate, habit, blocked: false };
}

export function setShortcutHabit(id, enabled, by = 'operator') {
  const d = ensureShortcutStore();
  const habit = d.shortcutHabits.find((entry) => entry.id === id);
  if (!habit) throw new Error('Approved shortcut not found');
  habit.enabled = Boolean(enabled);
  habit.updatedAt = now();
  habit.updatedBy = by;
  recordDecision(d, {
    action: habit.enabled ? 'enable' : 'disable',
    target: 'habit',
    habitId: habit.id,
    app: habit.app,
    keys: habit.keys,
    shortcut: habit.action,
    reason: habit.enabled ? 'Enabled by operator' : 'Disabled by operator',
    by,
  });
  persist();
  return habit;
}

export function removeShortcutBlock(id, by = 'operator') {
  const d = ensureShortcutStore();
  const block = d.shortcutBlocks.find((entry) => entry.id === id);
  if (!block) throw new Error('Blocked shortcut not found');
  d.shortcutBlocks = d.shortcutBlocks.filter((entry) => entry.id !== id);
  const candidate = d.shortcutCandidates.find(
    (entry) => entry.fingerprint === block.fingerprint && entry.status === 'never'
  );
  if (candidate) {
    candidate.status = 'pending';
    candidate.lastSeenAt = now();
    candidate.restoredAt = now();
    candidate.decidedAt = null;
    candidate.decidedBy = null;
  }
  recordDecision(d, {
    action: 'undo-never',
    target: 'block',
    blockId: block.id,
    candidateId: candidate?.id || null,
    app: block.app,
    keys: block.keys,
    shortcut: block.action,
    reason: 'Restored to review',
    by,
  });
  persist();
  return { block, candidate: candidate || null };
}
