import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

import {
  agentGoal,
  checkAgentAction,
  checkGoal,
  goalRequirements,
  recordGoalCheck,
  shouldCheckScreen,
} from '../server/goal-check.js';

test('a goal is read as one requirement per clause, with the verb and its words', () => {
  const requirements = goalRequirements('Triage every failed run, then write a triage note.');
  assert.equal(requirements.length, 2);
  assert.deepEqual(requirements.map((entry) => entry.verb), ['triage', 'write']);
  assert.deepEqual(requirements[0].keywords, ['failed', 'run']);
  assert.ok(requirements[1].keywords.includes('note'));
  assert.match(requirements[0].hint, /failed run/i);
  assert.equal(requirements[0].text, 'Triage every failed run');
  assert.equal(goalRequirements('   ').length, 0);
});

test('a goal is complete only when the command evidence covers every requirement', () => {
  const check = checkGoal({
    goal: 'Save the profile and confirm the saved state.',
    trigger: 'command',
    command: { name: 'save-profile', ok: true, stdout: 'profile saved state confirmed' },
    at: '2026-11-27T12:00:00.000Z',
  });
  assert.equal(check.status, 'complete');
  assert.equal(check.complete, true);
  assert.equal(check.proven, 2);
  assert.deepEqual(check.remaining, []);
  assert.equal(check.wentWrong.length, 0);
  assert.match(check.note, /proved by the last command/);
  assert.equal(check.at, '2026-11-27T12:00:00.000Z');
});

test('part of a goal being absent is remaining, not a failure', () => {
  const check = checkGoal({
    goal: 'Save the profile and confirm the saved state.',
    trigger: 'command',
    command: { name: 'save-profile', ok: true, stdout: 'profile saved' },
  });
  assert.equal(check.status, 'unknown', 'the command cannot prove the confirmation happened');
  assert.equal(check.complete, null);
  assert.equal(check.remaining.length, 1);
  assert.match(check.remaining[0].text, /confirm/i);
  assert.equal(check.wentWrong.length, 0);
  assert.ok(check.tryNext.some((item) => /confirm/i.test(item)));
});

test('a failed command records what went wrong and what to try next', () => {
  const check = checkGoal({
    goal: 'Install VLC and verify playback.',
    trigger: 'command',
    command: { name: 'winget install VLC', ok: false, code: 1, stderr: 'winget not found' },
  });
  assert.equal(check.status, 'incomplete');
  assert.equal(check.complete, false);
  assert.match(check.wentWrong[0].what, /winget install VLC/);
  assert.match(check.wentWrong[0].detail, /winget not found/);
  assert.equal(check.wentWrong[0].detail, 'winget not found · exit 1');
  assert.ok(check.tryNext.some((item) => item.startsWith('Fix the failure')));
  assert.equal(check.remaining.length, 2, 'both requirements are still outstanding');
});

test('a screen read lists the helpful controls but never claims the goal is done', () => {
  const check = checkGoal({
    goal: 'Save the profile.',
    trigger: 'screen',
    screen: {
      title: 'Sightline Profile',
      process: 'sightline-profile',
      labels: ['Save', 'Cancel', 'Profile'],
      changedPct: 12.5,
    },
  });
  assert.equal(check.status, 'unknown');
  assert.equal(check.complete, null);
  assert.equal(check.remaining.length, 1);
  assert.deepEqual(check.helpfulElements.map((element) => element.label), ['Save', 'Profile']);
  assert.match(check.helpfulElements[0].why, /save/i);
  assert.equal(check.screen.title, 'Sightline Profile');
  assert.equal(check.screen.elements, 3);
  assert.equal(check.screen.changedPct, 12.5);
  assert.ok(check.tryNext.some((item) => item.includes('Save')));
});

test('a tick with nothing to do is unknown, with nothing outstanding', () => {
  const agent = { id: 'agent_watchdog_probe', name: 'Watchdog probe', kind: 'watchdog', goal: 'Triage every failed run' };
  const check = checkAgentAction(agent, { skipped: 'no failures awaiting triage' });
  assert.equal(check.status, 'unknown');
  assert.equal(check.complete, null);
  assert.deepEqual(check.remaining, []);
  assert.match(check.note, /Nothing to do/);
  assert.ok(check.tryNext[0].includes('no failures awaiting triage'));
  assert.equal(agent.goalCheck, check);
  assert.equal(agent.goalChecks.length, 1);
});

test('a run settles the goal: a pass proves it, a failed step disproves it', () => {
  const passed = checkGoal({
    goal: 'Play the clip.',
    run: {
      status: 'passed',
      steps: [{ name: 'Play', type: 'playMedia', status: 'passed' }],
      presenter: { summary: { goalMet: true } },
    },
  });
  assert.equal(passed.status, 'complete');

  const failed = checkGoal({
    goal: 'Play the clip.',
    run: {
      status: 'failed',
      steps: [{ name: 'Play', type: 'playMedia', status: 'failed', error: 'no player window' }],
    },
  });
  assert.equal(failed.status, 'incomplete');
  assert.match(failed.wentWrong[0].what, /Play/);
  assert.match(failed.wentWrong[0].detail, /no player window/);
  assert.ok(failed.remaining.some((entry) => /Step “Play” failed/.test(entry.text)));
});

test('the trace keeps the latest checks, newest first, and the previous verdict', () => {
  const agent = { id: 'agent_trace', name: 'Trace' };
  const first = recordGoalCheck(agent, checkGoal({ goal: 'Save the profile.', command: { name: 'save', ok: true, stdout: 'profile' } }));
  const second = recordGoalCheck(agent, checkGoal({ goal: 'Save the profile.', command: { name: 'save', ok: false, stderr: 'denied' } }));
  assert.equal(agent.goalCheck, second);
  assert.equal(agent.goalChecks[0], second);
  assert.equal(agent.goalChecks[1], first);
  assert.equal(first.previousStatus, null);
  assert.equal(second.previousStatus, first.status);
  for (let index = 0; index < 12; index += 1) recordGoalCheck(agent, checkGoal({ goal: `save item ${index}` }));
  assert.equal(agent.goalChecks.length, 8, 'the trace is bounded');
  assert.equal(recordGoalCheck(null, second), null);
});

test('screen watching is opt-in and throttled', () => {
  const at = Date.parse('2026-11-27T12:00:00.000Z');
  assert.equal(shouldCheckScreen({ goal: '', enabled: true }, { changedPct: 20 }, { at }), false, 'no declared goal, no screen check');
  assert.equal(shouldCheckScreen({ goal: 'Save the profile', enabled: false }, { changedPct: 20 }, { at }), false);
  assert.equal(shouldCheckScreen({ goal: 'Save the profile', enabled: true }, { changedPct: 0.6 }, { at }), false);
  assert.equal(shouldCheckScreen({ goal: 'Save the profile', enabled: true }, { changedPct: 20, reused: true }, { at }), false);
  assert.equal(shouldCheckScreen({ goal: 'Save the profile', enabled: true }, { changedPct: 20, error: 'no read' }, { at }), false);
  assert.equal(shouldCheckScreen({ goal: 'Save the profile', enabled: true }, { changedPct: 20 }, { at }), true);
  assert.equal(
    shouldCheckScreen({ goal: 'Save the profile', enabled: true, screenCheckedAt: '2026-11-27T11:59:58.000Z' }, { changedPct: 20 }, { at }),
    false,
    'a check that just ran waits out the gap'
  );
  assert.equal(
    shouldCheckScreen({ goal: 'Save the profile', enabled: true, screenCheckedAt: '2026-11-27T11:59:55.000Z' }, { changedPct: 20 }, { at }),
    true
  );
  assert.equal(agentGoal({ description: 'Watch the queue' }), 'Watch the queue', 'the job description is the fallback goal');
});

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-goal-check-'));
const dataDir = path.join(tempRoot, 'data');
const agentId = 'agent_goal_probe';

function seedDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'db.json'),
    JSON.stringify({
      settings: {
        autoRecoverFailures: false,
        continuityAutoContinue: false,
        continuityEnabled: false,
        continuityFrameWatch: false,
        companionEnabled: false,
        agentTickMs: 600000,
        autoNotes: false,
        autoSync: false,
      },
      workflows: [],
      runs: [],
      agents: [
        {
          id: agentId,
          name: 'Goal probe',
          kind: 'watchdog',
          status: 'idle',
          description: 'Reviews failed runs and writes a triage note.',
          enabled: false,
          intervalMs: 60000,
          log: [],
        },
      ],
    })
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(base, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check (${child.exitCode}).\n${output()}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await sleep(100);
  }
  throw new Error(`Server did not become healthy at ${base}.\n${output()}`);
}

async function request(base, route, method, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('the goal is saved on the agent and the check is recorded and served', { timeout: 30000 }, async () => {
  seedDb();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: tempRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(base, child, () => output);

    const saved = await request(base, `/api/agents/${agentId}`, 'PATCH', { goal: 'Save the profile.' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.agent.goal, 'Save the profile.');

    // A supplied screen read keeps this test off the real desktop; the route
    // takes exactly the same path as the operator's button.
    const checked = await request(base, `/api/agents/${agentId}/goal-check`, 'POST', {
      screen: { title: 'Sightline Profile', process: 'sightline-profile', labels: ['Save', 'Cancel', 'Profile'], changedPct: 9 },
    });
    assert.equal(checked.status, 200);
    const check = checked.body.check;
    assert.equal(check.status, 'unknown');
    assert.equal(check.complete, null);
    assert.equal(check.trigger, 'screen');
    assert.equal(check.goal, 'Save the profile.');
    assert.equal(check.remaining.length, 1);
    assert.equal(check.helpfulElements[0].label, 'Save');
    assert.equal(check.screen.title, 'Sightline Profile');
    assert.ok(check.at, 'the record carries the time it was taken');

    const state = await (await fetch(`${base}/api/state`)).json();
    const agent = state.agents.find((entry) => entry.id === agentId);
    assert.equal(agent.goal, 'Save the profile.', 'the state view carries the goal');
    assert.equal(agent.goalCheck.status, 'unknown', 'and the latest check');
    assert.equal(agent.goalChecks.length, 1);

    const failed = await request(base, `/api/agents/${agentId}/goal-check`, 'POST', {
      command: { name: 'save-profile', ok: false, code: 1, stderr: 'access denied' },
    });
    assert.equal(failed.body.check.status, 'incomplete');
    assert.match(failed.body.check.wentWrong[0].detail, /access denied/);
    assert.equal(failed.body.agent.goalChecks.length, 2, 'both checks are kept');

    const cleared = await request(base, `/api/agents/${agentId}`, 'PATCH', { goal: '   ' });
    assert.equal(cleared.body.agent.goal, '');
    assert.equal(cleared.body.agent.goalCheck, null, 'a new goal invalidates the old verdict');

    const missing = await request(base, '/api/agents/agent_missing/goal-check', 'POST', {});
    assert.equal(missing.status, 404);
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Windows can briefly hold the server's temp database open.
    }
  }
});
