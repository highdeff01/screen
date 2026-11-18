import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-escalation-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const escalation = await load('server/auto-escalation.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

let seq = 0;
const stamp = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

function reset({ minFailures = 2, dailyCap = 3, enabled = true } = {}) {
  const d = store.db();
  d.settings.autoForwardFailures = enabled;
  d.settings.autoEscalateMinFailures = minFailures;
  d.settings.autoEscalateDailyCap = dailyCap;
  d.runs = [];
  d.missions = [];
  d.workflows = [
    { id: 'wf_escalation', name: 'Escalation target', status: 'ready', steps: [{ id: 'stp_1', type: 'wait', name: 'Wait', params: {} }] },
  ];
}

function addRun(overrides = {}) {
  const run = {
    id: `run_esc_${++seq}`,
    workflowId: 'wf_escalation',
    workflowName: 'Escalation target',
    status: 'failed',
    dryRun: false,
    trigger: 'manual',
    createdAt: stamp(seq),
    steps: [{ id: 'stp_1', type: 'wait', name: 'Wait', status: 'failed', error: 'timeout' }],
    evidence: [],
    ...overrides,
  };
  store.db().runs.unshift(run);
  return run;
}

function addMission(overrides = {}) {
  const mission = {
    id: `msn_esc_${++seq}`,
    workflowId: 'wf_escalation',
    workflowName: 'Escalation target',
    status: 'running',
    trigger: 'failure',
    createdAt: stamp(0),
    events: [],
    checks: [],
    ...overrides,
  };
  store.db().missions.unshift(mission);
  return mission;
}

const stubs = () => {
  const calls = { forwarded: [], started: [] };
  return {
    calls,
    // Mirrors forwardRunToControlCenter: records a mission and links the run.
    forward: (run, options) => {
      const id = `msn_stub_${run.id}`;
      calls.forwarded.push({ runId: run.id, ...options });
      store.db().missions.unshift({
        id,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        status: 'queued',
        trigger: options?.auto ? 'failure' : 'manual',
        createdAt: stamp(0),
        events: [],
        checks: [],
      });
      run.forwardedMissionId = id;
      return { id };
    },
    start: (id) => calls.started.push(id),
  };
};

test('one failure is a streak too short to escalate', () => {
  reset();
  const run = addRun();
  const decision = escalation.escalationDecision(run);
  assert.equal(decision.escalate, false);
  assert.match(decision.reason, /1\/2 consecutive failures/);
});

test('the second consecutive failure becomes a mission', () => {
  reset();
  addRun({ id: 'run_esc_first', createdAt: stamp(0) });
  const second = addRun({ createdAt: stamp(5) });
  const decision = escalation.escalationDecision(second);
  assert.equal(decision.escalate, true);
  assert.equal(decision.streak, 2);

  const stub = stubs();
  const outcome = escalation.escalateFailedRun(second, { forward: stub.forward, start: stub.start });
  assert.ok(outcome.mission);
  assert.deepEqual(stub.calls.started, [`msn_stub_${second.id}`]);
  assert.deepEqual(stub.calls.forwarded, [{ runId: second.id, auto: true }]);
  assert.equal(second.forwardedMissionId, `msn_stub_${second.id}`);
});

test('a pass resets the streak', () => {
  reset();
  addRun({ createdAt: stamp(0) });
  addRun({ status: 'passed', createdAt: stamp(5) });
  const run = addRun({ createdAt: stamp(10) });
  assert.equal(escalation.failureStreak('wf_escalation'), 1);
  assert.equal(escalation.escalationDecision(run).escalate, false);
});

test('a queued automatic repair keeps the failure out of the Command Center', () => {
  reset();
  addRun({ createdAt: stamp(0) });
  const run = addRun({ createdAt: stamp(5) });
  const decision = escalation.escalationDecision(run, { recoveryQueued: true });
  assert.equal(decision.escalate, false);
  assert.match(decision.reason, /repair is already queued/);
});

test('mission and shadow runs are never escalated again', () => {
  reset();
  for (const trigger of ['mission', 'shadow', 'shortcut-replay', 'presentation-audit']) {
    addRun({ createdAt: stamp(0) });
    const run = addRun({ createdAt: stamp(5), trigger });
    const decision = escalation.escalationDecision(run);
    assert.equal(decision.escalate, false, trigger);
    assert.match(decision.reason, /not escalated/);
  }
});

test('one live mission per workflow is enough', () => {
  reset({ minFailures: 1 });
  addMission({ status: 'running' });
  const run = addRun();
  const decision = escalation.escalationDecision(run);
  assert.equal(decision.escalate, false);
  assert.match(decision.reason, /already working on this workflow/);

  store.db().missions[0].status = 'passed';
  assert.equal(escalation.escalationDecision(run).escalate, true);
});

test('the daily cap counts only missions this policy started', () => {
  reset({ minFailures: 1, dailyCap: 1 });
  addMission({ id: 'msn_manual', trigger: 'manual', status: 'passed' });
  const run = addRun();
  assert.equal(escalation.escalationDecision(run).escalate, true);

  addMission({ id: 'msn_auto_past', trigger: 'failure', status: 'passed' });
  const capped = escalation.escalationDecision(addRun());
  assert.equal(capped.escalate, false);
  assert.match(capped.reason, /daily cap/);
  assert.equal(escalation.escalatedToday(), 1);
});

test('turning the policy off leaves failures in Test runs', () => {
  reset({ enabled: false, minFailures: 1 });
  const run = addRun();
  const decision = escalation.escalationDecision(run);
  assert.equal(decision.escalate, false);
  assert.match(decision.reason, /auto-escalation is off/);
});

test('the backlog offers one failure per workflow and skips claimed runs', () => {
  reset({ minFailures: 1 });
  store.db().workflows.push({ id: 'wf_other', name: 'Other workflow', status: 'ready', steps: [] });
  addRun({ id: 'run_old', createdAt: stamp(0) });
  addRun({ id: 'run_new', createdAt: stamp(30) });
  addRun({ id: 'run_forwarded', createdAt: stamp(10), forwardedMissionId: 'msn_known' });
  addMission({ id: 'msn_known', status: 'passed', trigger: 'manual' });
  addRun({ id: 'run_other', workflowId: 'wf_other', workflowName: 'Other workflow', createdAt: stamp(20) });

  const candidates = escalation.escalationCandidates();
  assert.deepEqual(
    candidates.map((candidate) => candidate.runId).sort(),
    ['run_new', 'run_other'],
    'newest failure per workflow, nothing already claimed'
  );
  const status = escalation.escalationStatus();
  assert.equal(status.candidateCount, 2);
  assert.equal(status.remaining, 3);
});

test('the operator backlog action respects the limit and the room left today', () => {
  reset({ minFailures: 3, dailyCap: 2 });
  addRun({ id: 'run_a', createdAt: stamp(10) });
  store.db().workflows.push({ id: 'wf_b', name: 'B', status: 'ready', steps: [] });
  addRun({ id: 'run_b', workflowId: 'wf_b', workflowName: 'B', createdAt: stamp(20) });
  store.db().workflows.push({ id: 'wf_c', name: 'C', status: 'ready', steps: [] });
  addRun({ id: 'run_c', workflowId: 'wf_c', workflowName: 'C', createdAt: stamp(30) });

  const stub = stubs();
  const result = escalation.escalateBacklog({ limit: 5, forward: stub.forward, start: stub.start });
  assert.equal(result.started.length, 2, 'the daily cap of 2 wins over the requested 5');
  assert.deepEqual(stub.calls.started, ['msn_stub_run_c', 'msn_stub_run_b']);
  assert.equal(result.remaining, 0);

  const again = escalation.escalateBacklog({ limit: 3, forward: stub.forward, start: stub.start });
  assert.equal(again.started.length, 0);
  assert.match(again.skipped[0].reason, /daily cap/);
});

test('a cap of zero blocks the backlog action without starting anything', () => {
  reset({ minFailures: 1, dailyCap: 0 });
  addRun();
  const stub = stubs();
  const result = escalation.escalateBacklog({ limit: 3, forward: stub.forward, start: stub.start });
  assert.equal(result.started.length, 0);
  assert.deepEqual(stub.calls.started, []);
});

test('escalation needs the forwarder and starter to be supplied', () => {
  reset({ minFailures: 1 });
  const run = addRun();
  assert.throws(() => escalation.escalateFailedRun(run), /forward and start/);
  assert.throws(() => escalation.escalateBacklog({ limit: 1 }), /forward and start/);
});
