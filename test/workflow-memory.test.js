import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-memory-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const memory = await import('../server/workflow-memory.js');

const workflow = {
  id: 'wf_kiro_memory',
  name: 'Kiro answer capture',
  description: 'Ask Kiro a question, wait for the answer, copy it and save it.',
  steps: [
    { id: 's1', type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
    { id: 's2', type: 'clickElement', name: 'Copy message', params: { name: 'Copy message' } },
  ],
};

const run = {
  id: 'run_memory_1',
  workflowId: workflow.id,
  workflowName: workflow.name,
  missionId: 'msn_memory',
  status: 'passed',
  dryRun: false,
  createdAt: '2026-11-16T06:00:00.000Z',
  endedAt: '2026-11-16T06:01:00.000Z',
  evidence: [{ kind: 'screenshot', caption: 'answer', path: 'captures/a.png' }],
  steps: [
    {
      id: 's1',
      type: 'focusWindow',
      name: 'Focus Kiro',
      params: { title: 'Kiro' },
      status: 'passed',
      output: 'Focused Kiro',
      visual: { changedPct: 8.5, meanDelta: 22, noVisibleChange: false },
    },
    {
      id: 's2',
      type: 'type',
      name: 'Ask the question',
      params: { text: 'what is a diamond', foreground: 'Kiro' },
      status: 'passed',
      output: 'typed',
      visual: { changedPct: 6.2, meanDelta: 18, noVisibleChange: false },
    },
    {
      id: 's3',
      type: 'clickElement',
      name: 'Copy message',
      params: { name: 'Copy message' },
      status: 'passed',
      output: 'Copied 480 characters',
      visual: { changedPct: 0, meanDelta: 0, noVisibleChange: true },
      audit: { level: 'warning', message: 'No visible screen change after “Copy message”.' },
    },
  ],
};

after(() => {
  store.flush();
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a finished run becomes a scored, reusable workflow episode', () => {
  const d = store.db();
  d.workflows = [workflow];
  d.missions = [{ id: 'msn_memory', goal: 'Ask Kiro about a diamond and save the answer.', conditions: {} }];
  d.runs = [];
  d.workflowMemory = [];

  const episode = memory.rememberRun(run, workflow);
  assert.equal(episode.runId, run.id);
  assert.equal(episode.mode, 'live');
  assert.equal(episode.quality, 1);
  assert.equal(episode.visual.length, 3);
  assert.ok(episode.hindrances.some((entry) => /no visible screen change/i.test(entry)));
  assert.equal(store.db().workflowMemory.length, 1);
});

test('similar goals recall the prior sequence and its hindrances', () => {
  const recalled = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    app: { name: 'Kiro' },
    limit: 3,
  });
  assert.equal(recalled.length, 1);
  assert.ok(recalled[0].score >= 0.8);
  assert.ok(recalled[0].recency > 0);
  assert.equal(typeof recalled[0].trend, 'number');
  const text = memory.formatWorkflowMemory(recalled);
  assert.match(text, /Focus Kiro/);
  assert.match(text, /what is a diamond/);
  assert.match(text, /no visible change/i);
  assert.match(text, /No visible screen change/i);
});

test('a different subject is not reused as the remembered question', () => {
  const hits = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a ruby and save the answer to Notepad.',
    workflow,
    app: { name: 'Kiro' },
  });
  assert.equal(hits.length, 0);
});

test('a passed episode whose typed question contradicts its goal is excluded', () => {
  const d = store.db();
  d.missions.push({ id: 'msn_ruby', goal: 'Ask Kiro about a ruby and save the answer.', conditions: {} });
  const stale = {
    ...run,
    id: 'run_stale_ruby',
    missionId: 'msn_ruby',
    steps: run.steps.map((step) => step.type === 'type'
      ? { ...step, params: { ...step.params, text: 'what is a diamond' } }
      : step),
  };
  memory.rememberRun(stale, workflow);
  const hits = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a ruby and save the answer.',
    workflow,
    app: { name: 'Kiro' },
  });
  assert.equal(hits.length, 0);
});

test('a recalled episode can seed a plan with its conditions intact', () => {
  const recalled = memory.recallWorkflowMemory({ goal: 'Ask Kiro about a diamond', workflow })[0];
  const steps = memory.planStepsFromMemory({ steps: [{ ...recalled.steps[0], condition: 'newChat' }] });
  assert.equal(steps[0].type, 'focusWindow');
  assert.equal(steps[0].condition, 'newChat');
});

test('the same run is replaced instead of duplicated', () => {
  memory.rememberRun(run, workflow);
  assert.equal(store.db().workflowMemory.filter((entry) => entry.runId === run.id).length, 1);
});

test('state summary exposes memory counts without full step payloads', () => {
  const summary = memory.summarizeWorkflowMemory();
  assert.equal(summary.count, 2);
  assert.equal(summary.passed, 2);
  assert.ok(summary.recent[0].visualWarnings >= 1);
});

test('the memory list exposes typed detail and hindrances for the UI', () => {
  const listed = memory.listWorkflowMemory({ limit: 10 });
  assert.equal(listed.count, 2);
  assert.equal(listed.episodes.length, 2);
  const typed = listed.episodes.flatMap((episode) => episode.steps).find((step) => step.type === 'type');
  assert.match(typed.detail, /what is a diamond/);
  assert.ok(listed.episodes.some((episode) => episode.hindrances.length));
});

test('a newer matching pass gets a recency advantage over an older one', () => {
  const newer = {
    ...run,
    id: 'run_memory_2',
    createdAt: '2026-11-16T12:00:00.000Z',
    endedAt: '2026-11-16T12:00:00.000Z',
  };
  memory.rememberRun(newer, workflow);
  const recalled = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    app: { name: 'Kiro' },
    limit: 2,
    nowMs: Date.parse('2026-11-16T12:10:00.000Z'),
  });
  assert.equal(recalled[0].runId, newer.id);
  assert.ok(recalled[0].recency > 0.98);
  assert.ok(recalled[1].recency < 0.7);
  assert.ok(recalled[0].recency > recalled[1].recency);
  assert.equal(recalled[0].trend, 1);
});

test('a recent failed run applies a success-trend penalty to matching memory', () => {
  const reference = Date.parse('2026-11-16T12:30:00.000Z');
  const before = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    limit: 5,
    nowMs: reference,
  }).find((entry) => entry.runId === 'run_memory_2');
  assert.ok(before);

  const failed = {
    ...run,
    id: 'run_memory_failed',
    status: 'failed',
    createdAt: '2026-11-16T12:20:00.000Z',
    endedAt: '2026-11-16T12:20:00.000Z',
    steps: run.steps.map((step, index) => index === 0
      ? { ...step, status: 'failed', error: 'Window lost focus' }
      : step),
  };
  memory.rememberRun(failed, workflow);

  const after = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    limit: 5,
    nowMs: reference,
  }).find((entry) => entry.runId === 'run_memory_2');
  assert.ok(after);
  assert.ok(after.trend < 0);
  assert.ok(after.trend < before.trend);
  assert.ok(after.score < before.score);
});

test('template lookup backfills historical runs before selecting a live template', () => {
  const d = store.db();
  const previousMemory = d.workflowMemory;
  const previousRuns = d.runs;
  try {
    d.workflowMemory = [];
    d.runs = [
      { ...run, id: 'simulated_template', dryRun: true, endedAt: '2026-11-17T12:00:00.000Z' },
      { ...run, id: 'live_template', endedAt: '2026-11-16T12:00:00.000Z' },
    ];
    const result = memory.recallWorkflowTemplate({ apps: ['Kiro'] });
    assert.equal(result.runId, 'live_template');
    assert.equal(result.mode, 'live');
    assert.equal(d.workflowMemory.length, 2);
  } finally {
    d.workflowMemory = previousMemory;
    d.runs = previousRuns;
  }
});

test('a changed app version blocks reuse of a versioned memory', () => {
  const versioned = {
    ...run,
    id: 'run_memory_versioned',
    createdAt: '2026-11-16T12:25:00.000Z',
    endedAt: '2026-11-16T12:25:00.000Z',
    steps: run.steps.map((step, index) => index === 1
      ? { ...step, appContext: { process: 'Kiro', title: 'Kiro', version: '1.2.3' } }
      : step),
  };
  const episode = memory.rememberRun(versioned, workflow);
  assert.equal(episode.appVersions.kiro, '1.2.3');

  const current = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    app: { name: 'Kiro', process: 'Kiro', version: '1.2.3' },
    limit: 5,
    nowMs: Date.parse('2026-11-16T12:30:00.000Z'),
  });
  assert.ok(current.some((entry) => entry.runId === versioned.id));

  const changed = memory.recallWorkflowMemory({
    goal: 'Ask Kiro about a diamond and save the answer.',
    workflow,
    app: { name: 'Kiro', process: 'Kiro', version: '2.0.0' },
    limit: 5,
    nowMs: Date.parse('2026-11-16T12:30:00.000Z'),
  });
  assert.ok(!changed.some((entry) => entry.runId === versioned.id));
});
