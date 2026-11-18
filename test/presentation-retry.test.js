import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldCreateRepairProposal, maybeCreateRepairProposal } = await import('../server/presentation-retry.js');
const { normalizeBudget, budgetView, recordBudgetFailure, recordBudgetSuccess, resetBudget, reEnableBudgetAgents } = await import('../server/retry-budget.js');

function budget() {
  return normalizeBudget({ failures: [], maxFailures: 3, windowMs: 3600000, paused: false, manual: false, reason: null });
}

function deck() {
  return { id: 'deck_auto', control: { manual: false }, lineage: { rootDeckId: 'deck_auto', parentDeckId: null, depth: 0, events: [] } };
}

test('auto repair proposals wait for the third consecutive failure', async () => {
  const target = deck();
  let calls = 0;
  const create = async () => {
    calls += 1;
    return { id: `prop_${calls}`, status: 'pending' };
  };
  const below = await maybeCreateRepairProposal(target, { consecutive: 2, maxFailedAttempts: 3, create });
  assert.equal(below.create, false);
  assert.equal(calls, 0);
  assert.equal(target.autoProposalId, undefined);

  const atLimit = await maybeCreateRepairProposal(target, { consecutive: 3, maxFailedAttempts: 3, create });
  assert.equal(atLimit.create, true);
  assert.equal(calls, 1);
  assert.equal(target.autoProposalId, 'prop_1');
  assert.equal(target.lineage.events[0].type, 'repair-proposal');
  assert.match(target.lineage.events[0].summary, /3 failed re-tests/);
});

test('auto repair proposals reuse a pending proposal and replace a rejected one', async () => {
  const target = deck();
  let calls = 0;
  const create = async () => {
    calls += 1;
    return { id: 'prop_new', status: 'pending' };
  };
  const pending = { id: 'prop_pending', status: 'pending' };
  const reused = await maybeCreateRepairProposal(target, { consecutive: 3, maxFailedAttempts: 3, existing: pending, create });
  assert.equal(reused.reuse, true);
  assert.equal(calls, 0);
  assert.equal(target.autoProposalId, 'prop_pending');

  const replaced = await maybeCreateRepairProposal(target, {
    consecutive: 3,
    maxFailedAttempts: 3,
    existing: { id: 'prop_rejected', status: 'rejected' },
    create,
  });
  assert.equal(replaced.create, true);
  assert.equal(calls, 1);
  assert.equal(target.autoProposalId, 'prop_new');
});

test('manual control and proposal errors are explicit', async () => {
  const manualDeck = deck();
  manualDeck.control.manual = true;
  let calls = 0;
  const manual = await maybeCreateRepairProposal(manualDeck, { consecutive: 3, maxFailedAttempts: 3, create: async () => { calls += 1; return { id: 'x' }; } });
  assert.equal(manual.create, false);
  assert.equal(calls, 0);

  const failingDeck = deck();
  const failed = await maybeCreateRepairProposal(failingDeck, {
    consecutive: 3,
    maxFailedAttempts: 3,
    create: async () => { throw new Error('planner offline'); },
  });
  assert.equal(failed.proposal, null);
  assert.match(failingDeck.autoProposalError, /planner offline/);

  const noCreator = await maybeCreateRepairProposal(deck(), { consecutive: 3, maxFailedAttempts: 3 });
  assert.equal(noCreator.create, true);
  assert.equal(noCreator.proposal, null);
  assert.equal(noCreator.reason, 'no-creator');
});

test('shared retry budgets pause on the third failure and reset cleanly', () => {
  const shared = budget();
  assert.equal(budgetView(shared).ok, true);
  assert.equal(recordBudgetFailure(shared, { reason: 'first' }).view.ok, true);
  assert.equal(recordBudgetFailure(shared, { reason: 'second' }).view.remaining, 1);
  const third = recordBudgetFailure(shared, { reason: 'third' });
  assert.equal(third.view.ok, false);
  assert.equal(third.view.paused, true);
  assert.equal(third.pausedNow, true);
  assert.match(third.view.reason, /3 failure/);
  resetBudget(shared);
  assert.equal(budgetView(shared).ok, true);
  assert.equal(budgetView(shared).failures, 0);
});

test('resetting the shared budget re-enables only agents paused by that budget', () => {
  const agents = [
    { id: 'a1', workflowId: 'wf_1', enabled: false, budgetPaused: true, status: 'paused', log: [] },
    { id: 'a2', workflowId: 'wf_2', enabled: false, budgetPaused: true, status: 'paused', log: [] },
    { id: 'a3', workflowId: 'wf_1', enabled: false, budgetPaused: false, status: 'paused', log: [] },
  ];
  const count = reEnableBudgetAgents(agents, 'wf_1');
  assert.equal(count, 1);
  assert.equal(agents[0].enabled, true);
  assert.equal(agents[0].budgetPaused, false);
  assert.equal(agents[1].enabled, false);
  assert.equal(agents[2].enabled, false);
});

test('a successful retry clears automatic pauses but never an operator pause', () => {
  const automatic = budget();
  recordBudgetFailure(automatic, { reason: 'one' });
  recordBudgetFailure(automatic, { reason: 'two' });
  recordBudgetFailure(automatic, { reason: 'three' });
  assert.equal(budgetView(automatic).paused, true);
  recordBudgetSuccess(automatic);
  assert.equal(budgetView(automatic).paused, false);
  assert.equal(budgetView(automatic).failures, 0);

  const manual = budget();
  manual.paused = true;
  manual.manual = true;
  manual.reason = 'operator hold';
  recordBudgetSuccess(manual);
  assert.equal(budgetView(manual).paused, true);
  assert.equal(budgetView(manual).manual, true);
  assert.equal(budgetView(manual).reason, 'operator hold');
});

test('old failures expire from the shared retry window', () => {
  const shared = normalizeBudget({
    failures: [
      { at: '2026-11-16T00:00:00.000Z', source: 'deck' },
      { at: '2026-11-16T00:00:01.000Z', source: 'scheduler' },
    ],
    maxFailures: 2,
    windowMs: 60000,
    paused: false,
  });
  const later = Date.parse('2026-11-16T01:00:00.000Z');
  assert.equal(budgetView(shared, later).failures, 0);
  assert.equal(budgetView(shared, later).ok, true);
  const current = recordBudgetFailure(shared, { at: '2026-11-16T01:00:00.000Z', nowMs: later });
  assert.equal(current.view.failures, 1);
  assert.equal(current.view.ok, true);
});