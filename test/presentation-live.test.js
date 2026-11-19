import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-live-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const presentations = await load('server/presentations.js');
const retry = await load('server/presentation-retry.js');
const engine = await load('server/engine.js');
const budget = await load('server/retry-budget.js');
const index = await load('server/presentation-index.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the three-failure auto proposal uses the actual live planner path', async () => {
  const d = store.db();
  d.settings.autoNotes = false;
  const workflow = d.workflows[0];
  const deck = {
    id: 'deck_live_auto',
    workflowId: workflow.id,
    workflowName: workflow.name,
    focus: 'problem',
    title: 'Live auto proposal',
    slides: [],
    audit: {
      verdict: 'blocked',
      confidence: 40,
      summary: 'Open Kiro and ask "What is a diamond?" then save the answer to Notepad.',
      blockers: [],
      warnings: [],
      elements: [],
      suggestions: [],
      patterns: [],
      agents: [],
      visual: { available: false },
    },
    rechecks: [],
    notes: [],
    control: { paused: false, manual: false, reason: null, at: null },
    lineage: { rootDeckId: 'deck_live_auto', parentDeckId: null, depth: 0, events: [] },
  };
  d.presentations = [deck];
  const result = await retry.maybeCreateRepairProposal(deck, {
    consecutive: 3,
    maxFailedAttempts: 3,
    create: async () => (await presentations.proposalFromPresentation(deck.id)).proposal,
  });
  assert.equal(result.create, true);
  const proposal = d.proposals.find((entry) => entry.id === result.proposal.id);
  assert.ok(proposal, 'proposal was persisted');
  assert.ok(proposal.steps.length >= 6);
  assert.equal(proposal.plan.source, 'stepwise');
  assert.equal(proposal.plan.model, 'workflow-memory-recipe');
  assert.equal(deck.proposalId, proposal.id);
  assert.equal(deck.autoProposalId, proposal.id);
  assert.ok(deck.lineage.events.some((event) => event.type === 'repair-proposal'));
  store.flush();
});

test('three real failing runs pause the shared budget and reset re-enables the scheduler', async () => {
  const d = store.db();
  const workflow = {
    id: 'wf_live_budget',
    name: 'Live failure budget probe',
    description: 'Fails on a deliberately missing tool.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false, notifyAgent: false },
    steps: [{ id: 'stp_missing_tool', type: 'runTool', name: 'Run a missing tool', params: { toolId: 'tool_does_not_exist' }, timeoutMs: 1000 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  d.workflows.push(workflow);
  // A probe-backed live run fails without touching the desktop: simulated runs
  // are rehearsals and deliberately never spend the retry budget.
  const probe = {
    executeStep: async () => {
      throw new Error('Tool "tool_does_not_exist" was not found.');
    },
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    inspectWindowState: async () => ({ state: 'unknown', matches: [] }),
    readFocusedElement: async () => ({ found: false }),
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const run = engine.createRun(workflow, { trigger: 'live-test', dryRun: false, probe });
    // The run returns the moment it fails; the ceiling only matters under
    // suite-wide load, where observer and scheduler work can take seconds.
    const finished = await engine.waitForRun(run.id, { timeoutMs: 20000, intervalMs: 20 });
    assert.equal(finished.status, 'failed', `attempt ${attempt} failed`);
    assert.equal(budget.getRetryBudget(workflow.id).failures, attempt);
  }
  assert.equal(budget.getRetryBudget(workflow.id).paused, true);
  const agent = { id: 'agent_live_budget', kind: 'scheduler', workflowId: workflow.id, enabled: false, budgetPaused: true, status: 'paused', log: [] };
  d.agents.push(agent);
  const reset = budget.setRetryBudget(workflow.id, { action: 'reset' });
  assert.equal(reset.paused, false);
  assert.equal(reset.failures, 0);
  assert.equal(agent.enabled, true);
  assert.equal(agent.budgetPaused, false);
  store.flush();
});

test('compaction keeps the visual confidence detail needed to rescore a deck', () => {
  const d = store.db();
  const deck = {
    id: 'deck_visual_compact',
    workflowId: d.workflows[0].id,
    workflowName: d.workflows[0].name,
    title: 'Compaction confidence probe',
    focus: 'problem',
    slides: [{ kicker: 'Audit', title: 'Evidence', bullets: ['One', 'Two', 'Three'], note: 'Note', image: null }],
    audit: {
      verdict: 'review',
      confidence: 60,
      summary: 'Visual review.',
      blockers: [],
      warnings: [],
      elements: [{ stepName: 'Kiro', expected: 'Kiro', status: 'present' }],
      visual: {
        available: true,
        model: 'vision-test',
        summary: 'Two findings.',
        findings: [
          { index: 0, status: 'present', detail: 'Kiro is visible', confidence: 1 },
          { index: 1, status: 'present', detail: 'Input is visible', confidence: 0.5 },
        ],
      },
      generatedAt: new Date().toISOString(),
    },
    rechecks: [],
    notes: [],
    lineage: { rootDeckId: 'deck_visual_compact', parentDeckId: null, depth: 0, events: [] },
  };
  d.presentations = [deck];
  presentations.compactPresentations({ keep: 0 });
  assert.equal(deck.audit, null);
  assert.equal(deck.auditSummary.visual.findings.length, 2);
  assert.equal(deck.auditSummary.visual.findings[1].confidence, 0.5);
  const summary = index.presentationSummary(deck);
  assert.equal(summary.quality.factors.visual, 75);
  assert.equal(summary.quality.version, 3);
  store.flush();
});