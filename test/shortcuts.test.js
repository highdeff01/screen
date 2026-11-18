import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-shortcuts-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const shortcuts = await import('../server/shortcuts.js');
const planner = await import('../server/planner.js');

const mission = (mode = 'live') => ({ id: 'msn_test', mode, workflowId: 'wf_test', workflowName: 'Kiro' });
const keyStep = (name, keys, status = 'passed', app = 'Kiro') => ({
  id: `stp_${name.toLowerCase().replace(/\W+/g, '_')}`,
  type: 'key',
  name,
  status,
  params: { keys, foreground: app },
});
const passedRun = (id = 'run_test') => ({ id, status: 'passed', steps: [keyStep('Send question', '{ENTER}')] });
const review = { summary: 'The live pass was reviewed.' };

function reset() {
  const d = store.db();
  d.shortcutCandidates = [];
  d.shortcutHabits = [];
  d.shortcutBlocks = [];
  d.shortcutDecisions = [];
  d.shortcutApps = {};
}

function contextualStep({ name = 'Send question', keys = '{ENTER}', status = 'passed', process = 'Kiro', title = 'Kiro — Ruby', className = 'Chrome_WidgetWin_1', version = '1.2.3' } = {}) {
  return {
    id: `stp_${name.toLowerCase().replace(/\W+/g, '_')}`,
    type: 'key',
    name,
    status,
    params: { keys },
    appContext: { process, title, className, version },
  };
}

function pending() {
  return shortcuts.listShortcuts().candidates;
}

after(() => {
  store.flush();
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('queues passed key steps only from a reviewed live pass', () => {
  reset();
  shortcuts.queueShortcutCandidates(
    mission(),
    { ...passedRun(), steps: [keyStep('Send question', '{ENTER}'), keyStep('Save answer', '^s', 'failed')] },
    review
  );
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].action, 'Send question');
  assert.equal(pending()[0].fingerprint, 'kiro|{enter}|send question');

  shortcuts.queueShortcutCandidates(mission('dry'), passedRun('run_dry'), review);
  assert.equal(pending().length, 1, 'dry runs must not queue candidates');

  shortcuts.queueShortcutCandidates(mission(), passedRun('run_unreviewed'), { summary: '' });
  assert.equal(pending().length, 1, 'an unreviewed pass must not queue candidates');

  shortcuts.queueShortcutCandidates(mission(), passedRun('run_second'), review);
  assert.equal(pending().length, 1, 'the same action is not duplicated');
  assert.equal(pending()[0].seen, 2, 'repeat exposure is counted');
});

test('approval enables planner use and disabling removes it', () => {
  reset();
  shortcuts.queueShortcutCandidates(mission(), passedRun(), review);
  const candidate = pending()[0];
  const approved = shortcuts.decideShortcut(candidate.id, 'approve');

  assert.equal(approved.habit.approved, true);
  assert.equal(approved.habit.enabled, true);
  assert.equal(approved.habit.replayStatus, 'pending');
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 0, 'approval alone must not unlock the planner');

  shortcuts.recordShortcutReplayOutcome(approved.habit.id, { id: 'run_replay', status: 'passed' });
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 1);
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Notepad' }).length, 0, 'shortcuts are scoped to their app');

  shortcuts.setShortcutHabit(approved.habit.id, false);
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 0, 'disabled habits must not reach the planner');
  assert.equal(shortcuts.listShortcuts().habits[0].enabled, false);

  shortcuts.setShortcutHabit(approved.habit.id, true);
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 1);

  shortcuts.queueShortcutCandidates(mission(), passedRun('run_after_approval'), review);
  assert.equal(pending().length, 0, 'approved actions are not re-queued');
});

test('reject and never block future candidates; never can be undone', () => {
  reset();
  shortcuts.queueShortcutCandidates(mission(), passedRun(), review);
  const candidate = pending()[0];
  shortcuts.decideShortcut(candidate.id, 'reject');
  assert.equal(pending().length, 0);
  shortcuts.queueShortcutCandidates(mission(), passedRun('run_after_reject'), review);
  assert.equal(pending().length, 0, 'a rejected action stays rejected');

  shortcuts.queueShortcutCandidates(mission(), { ...passedRun('run_second_action'), steps: [keyStep('Save answer', '^s')] }, review);
  const save = pending().find((entry) => entry.action === 'Save answer');
  const blocked = shortcuts.decideShortcut(save.id, 'never');
  assert.equal(shortcuts.listShortcuts().blocked.length, 1);
  assert.ok(blocked.candidate.id);

  shortcuts.queueShortcutCandidates(mission(), { ...passedRun('run_after_block'), steps: [keyStep('Save answer', '^s')] }, review);
  assert.equal(pending().length, 0, 'Never learn blocks the action');

  const block = shortcuts.listShortcuts().blocked[0];
  shortcuts.removeShortcutBlock(block.id);
  assert.equal(pending().length, 1, 'undoing Never learn returns the candidate to review');
});

test('confidence rewards success, penalizes failure, and decays', () => {
  assert.ok(shortcuts.shortcutConfidence({ successes: 1, failures: 0 }) >= 60);
  assert.ok(shortcuts.shortcutConfidence({ successes: 1, failures: 1 }) < 60);
  assert.ok(
    shortcuts.shortcutConfidence({ successes: 3, failures: 0, lastAt: '2020-01-01T00:00:00.000Z' }) < 60,
    'stale habits lose confidence'
  );

  reset();
  shortcuts.queueShortcutCandidates(mission(), passedRun(), review);
  const approved = shortcuts.decideShortcut(pending()[0].id, 'approve');
  const before = approved.habit.confidence;
  shortcuts.recordShortcutOutcomes(
    mission(),
    { id: 'run_failure', status: 'failed', steps: [keyStep('Send question', '{ENTER}', 'failed')] }
  );
  const habit = store.db().shortcutHabits.find((entry) => entry.id === approved.habit.id);
  assert.equal(habit.failures, 1);
  assert.ok(habit.confidence < before);
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 0, 'a failed approved shortcut is demoted');
});

test('captures real app context and invalidates a habit when the app version changes', () => {
  reset();
  shortcuts.queueShortcutCandidates(
    mission(),
    { id: 'run_context', status: 'passed', steps: [contextualStep()] },
    review
  );
  const candidate = pending()[0];
  assert.equal(candidate.process, 'Kiro');
  assert.equal(candidate.appKey, 'kiro|chrome_widgetwin_1');
  assert.equal(candidate.appVersion, '1.2.3');
  assert.deepEqual(candidate.preconditions, {
    process: 'Kiro',
    windowTitle: 'Kiro — Ruby',
    windowClass: 'Chrome_WidgetWin_1',
  });

  const approved = shortcuts.decideShortcut(candidate.id, 'approve');
  shortcuts.recordShortcutReplayOutcome(approved.habit.id, { id: 'replay_context', status: 'passed' });
  assert.equal(shortcuts.eligibleShortcuts(8, { process: 'Kiro' }).length, 1);

  shortcuts.queueShortcutCandidates(
    mission(),
    { id: 'run_updated_app', status: 'passed', steps: [contextualStep({ version: '2.0.0' })] },
    review
  );
  const habit = store.db().shortcutHabits.find((entry) => entry.id === approved.habit.id);
  assert.equal(habit.enabled, false);
  assert.equal(habit.replayStatus, 'pending');
  assert.equal(habit.reviewReason, 'app-update');
  assert.equal(pending().length, 1, 'the app update returns the shortcut to review');
  assert.equal(shortcuts.eligibleShortcuts(8, { process: 'Kiro' }).length, 0);
  assert.ok(shortcuts.listShortcuts().decisions.some((entry) => entry.action === 'invalidate'));

  const reapproved = shortcuts.decideShortcut(pending()[0].id, 'approve');
  assert.equal(reapproved.habit.reviewReason, null);
  assert.equal(reapproved.habit.replayStatus, 'pending');
  assert.equal(shortcuts.eligibleShortcuts(8, { process: 'Kiro' }).length, 0, 're-approval still requires a replay');
});

test('an app update requires re-approval and an independent replay after the update', () => {
  reset();
  const first = { id: 'run_v1', status: 'passed', steps: [contextualStep()] };
  shortcuts.queueShortcutCandidates(mission(), first, review);
  const { habit } = shortcuts.decideShortcut(pending()[0].id, 'approve');
  shortcuts.recordShortcutReplayOutcome(habit.id, { id: 'replay_v1', status: 'passed' });

  // Older stores can have a versioned habit without an app observation.
  store.db().shortcutApps = {};
  const update = { id: 'run_v2', status: 'passed', steps: [contextualStep({ version: '2.0.0' })] };
  shortcuts.recordShortcutOutcomes(mission(), update);
  shortcuts.queueShortcutCandidates(mission(), update, review);
  let current = shortcuts.getShortcutHabit(habit.id);
  assert.equal(current.reviewReason, 'app-update');
  assert.equal(current.replayStatus, 'pending', 'the run that detected the update cannot validate it');
  assert.equal(pending()[0].runId, update.id, 're-approval records the update observation run');
  shortcuts.recordShortcutReplayOutcome(habit.id, { id: 'old_inflight_replay', status: 'passed' });
  assert.equal(shortcuts.getShortcutHabit(habit.id).replayStatus, 'pending');

  shortcuts.decideShortcut(pending()[0].id, 'approve');
  shortcuts.recordShortcutReplayOutcome(habit.id, { id: 'old_inflight_replay', status: 'passed', createdAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(shortcuts.getShortcutHabit(habit.id).replayStatus, 'pending', 'a replay started before re-approval cannot validate it');
  shortcuts.recordShortcutOutcomes(mission(), update);
  current = shortcuts.getShortcutHabit(habit.id);
  assert.equal(current.replayStatus, 'pending', 'reprocessing the approval run is not a replay');
  shortcuts.recordShortcutOutcomes(mission(), { ...update, id: 'run_v2_independent' });
  assert.equal(shortcuts.getShortcutHabit(habit.id).replayStatus, 'passed');
  assert.equal(shortcuts.eligibleShortcuts(8, { process: 'Kiro' }).length, 1);
});

test('app observations are persisted even for already learned shortcuts', () => {
  reset();
  shortcuts.queueShortcutCandidates(mission(), passedRun(), review);
  shortcuts.decideShortcut(pending()[0].id, 'approve');
  const d = store.db();
  const before = d.rev;
  shortcuts.queueShortcutCandidates(mission(), passedRun('run_observe'), review);
  assert.ok(d.rev > before);
  assert.ok(d.shortcutApps.kiro);
});

test('only live successful runs can validate replay and repeated failures are counted', () => {
  reset();
  shortcuts.queueShortcutCandidates(mission(), { ...passedRun(), dryRun: true }, review);
  assert.equal(pending().length, 0);
  shortcuts.queueShortcutCandidates(mission(), passedRun(), review);
  const { habit } = shortcuts.decideShortcut(pending()[0].id, 'approve');
  shortcuts.recordShortcutOutcomes(mission(), { ...passedRun('run_simulated'), dryRun: true });
  shortcuts.recordShortcutReplayOutcome(habit.id, { id: 'dry_replay', dryRun: true, status: 'passed' });
  assert.equal(shortcuts.getShortcutHabit(habit.id).replayStatus, 'pending');
  shortcuts.recordShortcutOutcomes(mission(), { ...passedRun('run_failed_later'), status: 'failed' });
  assert.equal(shortcuts.getShortcutHabit(habit.id).replayStatus, 'pending');

  shortcuts.recordShortcutOutcomes(mission(), {
    id: 'run_repeated', status: 'failed',
    steps: [keyStep('Send question', '{ENTER}'), keyStep('Send question', '{ENTER}', 'failed')],
  });
  const current = shortcuts.getShortcutHabit(habit.id);
  assert.equal(current.failures, 1);
  assert.equal(current.replayStatus, 'failed');
  assert.equal(shortcuts.eligibleShortcuts(8, { app: 'Kiro' }).length, 0);
});

test('legacy auto-promoted habits are returned to review, once', () => {
  reset();
  store.db().shortcutHabits = [
    {
      id: 'legacy_habit',
      app: 'Kiro',
      keys: '{ENTER}',
      name: 'Send question',
      wins: 3,
      lastAt: new Date().toISOString(),
    },
  ];
  shortcuts.ensureShortcutStore();
  assert.equal(store.db().shortcutHabits.length, 0);
  assert.equal(pending().length, 1);
  assert.equal(pending()[0].source, 'legacy');
  assert.equal(pending()[0].seen, 3);
  shortcuts.ensureShortcutStore();
  assert.equal(pending().length, 1, 'legacy migration must be idempotent');
});

test('workflow lint catches new-chat, duplicate, and unguarded key steps', () => {
  const steps = Array.from({ length: 6 }, (_, index) => ({ type: 'wait', name: `Wait ${index}`, params: { ms: 500 } }));
  steps.push({ type: 'key', name: 'Send', params: { keys: '{ENTER}' } });
  steps.push({ type: 'key', name: 'Send', params: { keys: '{ENTER}' } });
  const result = planner.lintWorkflow({ name: 'Start a new chat', description: 'A new chat about ruby', steps });
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes('missing new-chat condition'));
  assert.ok(codes.includes('duplicate step'));
  assert.ok(codes.includes('key step has no foreground guard'));
});

test('planner flags missing and unrequested new-chat conditions', () => {
  const steps = Array.from({ length: 6 }, (_, index) => ({ type: 'wait', name: `Wait ${index}`, params: { ms: 500 } }));
  const conditional = steps.map((step, index) => (index === 0 ? { ...step, condition: 'newChat' } : step));

  assert.ok(planner.planIssues(steps, 'Start a new chat about a ruby').includes('missing new-chat condition'));
  assert.ok(!planner.planIssues(conditional, 'Start a new chat about a ruby').includes('missing new-chat condition'));
  assert.ok(planner.planIssues(conditional, 'Keep using the current chat').includes('unrequested new-chat condition'));
  assert.equal(planner.planIssues(steps, 'Wait for the app').length, 0);
});
