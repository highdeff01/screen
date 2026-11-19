import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-missions-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const missions = await load('server/missions.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.missions = [];
  d.workflows = [{ id: 'wf_m', name: 'Mission probe', description: 'probe the mission lifecycle', status: 'ready', steps: [] }];
  store.persist();
});

test('a mission is created from a workflow with clamped conditions', () => {
  const mission = missions.createMission({
    workflowId: 'wf_m',
    goal: 'Prove the workflow',
    conditions: { maxAttempts: 99, checkIntervalMs: 1 },
  });
  assert.equal(mission.status, 'queued');
  assert.equal(mission.maxAttempts, 4, 'maxAttempts is clamped to 4');
  assert.equal(mission.conditions.checkIntervalMs, 1000, 'checkIntervalMs is clamped to 1000');
  assert.equal(mission.mode, 'dry');
  const summary = missions.missionSummary(mission);
  assert.equal(summary.goal, 'Prove the workflow');
  assert.equal(summary.workflowName, 'Mission probe');
});

test('createMission falls back to the workflow description when no goal is given', () => {
  const mission = missions.createMission({ workflowId: 'wf_m' });
  assert.equal(mission.goal, 'probe the mission lifecycle');
  assert.throws(() => missions.createMission({ workflowId: 'nope' }), /Workflow not found/);
});

test('the lifecycle moves through pause, resume, cancel', () => {
  const mission = missions.createMission({ workflowId: 'wf_m', goal: 'Lifecycle probe' });
  assert.equal(missions.pauseMission(mission.id).paused, true);
  assert.equal(missions.resumeMission(mission.id).paused, false);
  const controlled = missions.controlMission(mission.id, 'pause');
  assert.equal(controlled.mission.paused, true, 'controlMission returns { mission, run }');
  assert.throws(() => missions.controlMission(mission.id, 'explode'), /Unknown mission control/i);
  const cancelled = missions.cancelMission(mission.id);
  assert.equal(cancelled.status, 'cancelled');
});

test('operator commands are recorded on the mission', async () => {
  const mission = missions.createMission({ workflowId: 'wf_m', goal: 'Command probe' });
  const { mission: after } = await missions.operatorCommand(mission.id, 'CHECKPOINT', 'operator checkpoint', 'operator');
  assert.ok((after.commands || []).some((entry) => entry.command === 'CHECKPOINT' && entry.by === 'operator'));
});

test('retryMission starts a fresh mission for the same goal', () => {
  const mission = missions.createMission({ workflowId: 'wf_m', goal: 'Retry probe' });
  store.db().missions.find((entry) => entry.id === mission.id).status = 'failed';
  store.persist();
  const retried = missions.retryMission(mission.id);
  assert.notEqual(retried.id, mission.id, 'a new mission is started, not the failed one resurrected');
  assert.equal(retried.goal, mission.goal);
  assert.equal(retried.trigger, 'retry');
});
