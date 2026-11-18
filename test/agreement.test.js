import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-agreement-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const agreement = await load('server/agreement.js');
const store = await load('server/store.js');
const watch = await load('server/presentation-watch.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

const approve = (kind, weight) => ({ agentId: kind, name: kind, kind, vote: 'approve', weight });
const abstain = (kind, weight) => ({ agentId: kind, name: kind, kind, vote: 'abstain', weight });
const reject = (kind, weight, reason = 'no') => ({ agentId: kind, name: kind, kind, vote: 'reject', weight, reason });

test('three approving agents rank as unanimous agreement', () => {
  const ranked = agreement.rankProposalVotes([approve('supervisor', 3), approve('watchdog', 2), approve('observer', 2)]);
  assert.equal(ranked.rank, 'unanimous');
  assert.equal(ranked.score, 100);
  assert.equal(ranked.approved, true);
  assert.equal(ranked.voters, 3);
});

test('abstentions do not dilute a strong agreement', () => {
  const ranked = agreement.rankProposalVotes([approve('observer', 2), approve('continuity', 1), abstain('watchdog', 2)]);
  assert.equal(ranked.rank, 'strong');
  assert.equal(ranked.score, 100);
  assert.equal(ranked.abstentions, 1);
  assert.equal(ranked.voters, 2);
});

test('a rejecting agent blocks the override even after a failed step', () => {
  const decision = agreement.watcherApplyDecision({
    proposal: { status: 'pending', steps: [{ type: 'wait' }] },
    votes: [approve('supervisor', 3), reject('scheduler', 2, 'retry budget paused')],
    trigger: { trigger: 'step-failed' },
  });
  assert.equal(decision.apply, false);
  assert.equal(decision.agreement.rank, 'blocked');
  assert.match(decision.reason, /retry budget paused/);
});

test('a failed or stalled run applies a split proposal with one approval', () => {
  const proposal = { status: 'pending', steps: [{ type: 'wait' }] };
  const decision = agreement.watcherApplyDecision({
    proposal,
    votes: [approve('continuity', 1), abstain('watchdog', 2)],
    trigger: { trigger: 'agent-stalled' },
  });
  assert.equal(decision.apply, true);
  assert.match(decision.reason, /agent-stalled/);
});

test('an already approved proposal is never applied twice', () => {
  const decision = agreement.watcherApplyDecision({
    proposal: { status: 'approved', steps: [{ type: 'wait' }] },
    votes: [approve('supervisor', 3)],
    trigger: { trigger: 'step-failed' },
  });
  assert.equal(decision.apply, false);
});

test('runApplyTrigger reports failed steps and long-running steps', () => {
  const failed = agreement.runApplyTrigger({
    status: 'failed',
    steps: [{ status: 'failed', name: 'Click target', error: 'no window' }],
  });
  assert.equal(failed.trigger, 'step-failed');
  assert.match(failed.detail, /no window/);

  const stalled = agreement.runApplyTrigger(
    { status: 'running', steps: [{ status: 'running', name: 'Wait for window', startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() }] },
    Date.now()
  );
  assert.equal(stalled.trigger, 'agent-stalled');

  const fresh = agreement.runApplyTrigger(
    { status: 'running', steps: [{ status: 'running', name: 'Wait', startedAt: new Date().toISOString() }] },
    Date.now()
  );
  assert.equal(fresh, null);
});

function deckFor(workflow, id, proposal) {
  return {
    id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    focus: 'problem',
    title: id,
    slides: [],
    audit: { verdict: 'blocked', confidence: 40, blockers: [], suggestions: [] },
    attempts: { consecutive: 0, total: 0, maxFailedAttempts: 3 },
    lineage: { rootDeckId: id, parentDeckId: null, depth: 0, events: [] },
    notes: [],
    proposalId: proposal.id,
    updatedAt: new Date().toISOString(),
  };
}

test('the deck watcher applies a pending proposal when the agents agree', async () => {
  const d = store.db();
  d.settings.autoNotes = false;
  const workflow = d.workflows[0];
  workflow.steps = [{ id: 'stp_old', type: 'wait', name: 'Wait', params: { ms: 100 } }];
  workflow.retryBudget = { failures: [], maxFailures: 3, windowMs: 3600000, paused: false };
  const proposal = {
    id: 'prop_watch_agree',
    workflowId: workflow.id,
    workflowName: workflow.name,
    goal: 'Repair the Notepad flow',
    status: 'pending',
    source: 'test',
    createdAt: new Date().toISOString(),
    steps: [{ id: 'stp_new', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } }],
    changes: { changed: 1 },
    lint: { issues: [] },
  };
  d.proposals.push(proposal);
  d.presentations.push(deckFor(workflow, 'deck_watch_agree', proposal));

  await watch.watchPresentationDecks();

  assert.equal(proposal.status, 'approved');
  assert.deepEqual(workflow.steps.map((step) => step.name), ['Open Notepad']);
  const deck = d.presentations.find((entry) => entry.id === 'deck_watch_agree');
  assert.equal(deck.proposalApplied.proposalId, proposal.id);
  assert.ok(['strong', 'unanimous', 'majority'].includes(deck.proposalApplied.rank));
  assert.ok(deck.lineage.events.some((event) => event.type === 'proposal-applied'));
});

test('a failed step overrides the plan even without majority agreement', async () => {
  const d = store.db();
  const workflow = d.workflows[1];
  workflow.steps = [{ id: 'stp_before', type: 'wait', name: 'Hold', params: { ms: 100 } }];
  workflow.retryBudget = { failures: [], maxFailures: 3, windowMs: 3600000, paused: false };
  const proposal = {
    id: 'prop_watch_failure',
    workflowId: workflow.id,
    workflowName: workflow.name,
    goal: 'Restart the failed click flow',
    status: 'pending',
    source: 'test',
    createdAt: new Date().toISOString(),
    steps: [{ id: 'stp_repaired', type: 'click', name: 'Click the repaired target', params: { x: 10, y: 10 } }],
    changes: { changed: 0 },
    lint: { issues: [] },
  };
  d.proposals.push(proposal);
  d.presentations.push(deckFor(workflow, 'deck_watch_failure', proposal));
  d.runs.push({
    id: 'run_watch_failure',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'failed',
    createdAt: new Date().toISOString(),
    steps: [{ id: 'stp_before', type: 'wait', name: 'Hold', status: 'failed', error: 'target window closed' }],
  });

  await watch.watchPresentationDecks();

  assert.equal(proposal.status, 'approved');
  assert.deepEqual(workflow.steps.map((step) => step.name), ['Click the repaired target']);
  const deck = d.presentations.find((entry) => entry.id === 'deck_watch_failure');
  assert.equal(deck.proposalApplied.trigger, 'step-failed');
});
