import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-goal-check-tick-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function seed() {
  const s = store.db().settings;
  s.autoNotes = false;
  s.autoRecoverFailures = false;
  s.presenceEnabled = false;
  s.visualChecks = false;
  const db = store.db();
  db.suggestions = [];
  // Three failed runs waiting for the supervisor; one tick handles two of them
  // by design, so the tick is a partial pass over the goal, not the whole job.
  db.runs = ['run_a', 'run_b', 'run_c'].map((id, index) => ({
    id,
    workflowId: `wf_${id}`,
    workflowName: `Probe ${index + 1}`,
    status: 'failed',
    dryRun: false,
    steps: [],
    evidence: [],
    log: [],
    createdAt: new Date(Date.UTC(2026, 10, 27, 10, index)).toISOString(),
    analysis: { summary: `probe ${index + 1} failed`, rootCause: 'dialog', nextActions: ['Retry with a wait.'] },
  }));
  db.agents = [
    {
      id: 'agent_supervisor_probe',
      name: 'Supervisor probe',
      kind: 'supervisor',
      role: 'supervisor',
      status: 'idle',
      description: 'Owns the failure queue.',
      goal: 'Review every failed run and record a suggestion',
      enabled: false,
      intervalMs: 60000,
      delegatesTo: [],
      log: [],
    },
  ];
  return db.agents[0];
}

test('a partial supervisor tick is recorded as unproven, not complete', { timeout: 30000 }, async () => {
  const agent = seed();
  const result = await engine.tickAgentNow(agent.id);
  assert.deepEqual(result.supervised, ['run_a', 'run_b'], 'the tick handled its two-run share');

  const remainingRuns = store.db().runs.filter((run) => !run.supervised);
  assert.deepEqual(remainingRuns.map((run) => run.id), ['run_c'], 'the third run is still waiting, so the goal is not done');

  assert.ok(agent.goalCheck, 'the engine tick hook recorded a check');
  assert.equal(agent.goalCheck.trigger, 'command');
  assert.equal(agent.goalCheck.command.name, 'supervisor');
  assert.notEqual(agent.goalCheck.status, 'complete', 'matching words in the result are not proof the queue is empty');
  assert.equal(agent.goalCheck.complete, null);
  assert.equal(agent.goalCheck.status, 'unknown');
  assert.match(agent.goalCheck.note, /did not report the goal finished/);
  assert.equal(agent.goalChecks.length, 1, 'the check is kept on the agent trace');
  assert.ok(
    agent.log.some((entry) => /Goal unknown|did not report the goal finished/.test(entry.message)),
    'the changed verdict is noted in the agent log'
  );

  // Now a goal the tick's own words fully cover. The second tick handles the
  // last queued run, so its result says “supervised … run_c” — under the old
  // inference that made the goal complete, which is exactly the bug: one pass
  // over the queue is not an empty queue.
  agent.goal = 'Supervise the run';
  const second = await engine.tickAgentNow(agent.id);
  assert.deepEqual(second.supervised, ['run_c']);
  assert.equal(agent.goalCheck.complete, null, 'a covering result is still not an explicit signal');
  assert.equal(agent.goalCheck.status, 'unknown');
  assert.equal(agent.goalCheck.proven, 1, 'the words did cover the single requirement');
  assert.match(agent.goalCheck.note, /did not report the goal finished/);
});