import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const root = process.cwd();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(base, url, options) {
  const response = await fetch(base + url, options);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('observation review uses stored evidence and is read-only', { timeout: 30000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-review-http-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  const dbFile = path.join(cwd, 'data', 'db.json');
  const step = { id: 'step_1', name: 'Click', type: 'click', status: 'passed', params: {} };
  fs.writeFileSync(dbFile, JSON.stringify({
    settings: { autoRecoverFailures: false, continuityAutoContinue: false, continuityEnabled: false, continuityFrameWatch: false, companionEnabled: false, agentTickMs: 600000 },
    workflows: [{ id: 'wf_one', name: 'One', status: 'ready', steps: [step] }, { id: 'wf_two', name: 'Two', status: 'ready', steps: [] }],
    runs: [{ id: 'run_one', workflowId: 'wf_one', workflowName: 'One', status: 'completed', dryRun: true, steps: [step], evidence: [], log: [], ledger: [], position: null }],
    proposals: [
      { id: 'proposal_one', workflowId: 'wf_one', workflowName: 'One', status: 'pending', steps: [{ type: 'openUrl', name: 'Open', params: {} }] },
      { id: 'proposal_other', workflowId: 'wf_two', status: 'pending', steps: [step] },
    ],
    simulations: [{ id: 'sim_running', runId: 'run_one', workflowId: 'wf_one', status: 'running', breakdown: [{ verdict: 'confirmed' }] }],
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
      try { ready = (await fetch(base + '/api/health')).ok; } catch { await sleep(100); }
    }
    assert.ok(ready, output);
    assert.equal((await request(base, '/api/observation-review')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&proposalId=')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&proposalId=bad%20id')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&simulationId=sim_running')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&observations=fake')).status, 400);
    assert.equal((await request(base, '/api/observation-review?simulationId=missing')).status, 404);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&proposalId=missing')).status, 404);
    assert.equal((await request(base, '/api/observation-review?simulationId=sim_running&proposalId=proposal_other')).status, 409);
    const incomplete = await request(base, '/api/observation-review?simulationId=sim_running');
    assert.equal(incomplete.status, 200);
    assert.equal(incomplete.body.profile.observations.steps.length, 0);
    assert.ok(incomplete.body.profile.missingEvidence.some((item) => item.code === 'simulation_incomplete'));
    assert.equal(incomplete.body.proposalReview, null);

    // Create a genuine screenshot analysis through the existing endpoint, then
    // snapshot after its own background writes have settled.
    const started = await request(base, '/api/runs/run_one/simulate', { method: 'POST' });
    assert.equal(started.status, 200);
    const id = started.body.simulation.id;
    let simulation;
    for (let i = 0; i < 100; i++) {
      simulation = (await request(base, `/api/simulations/${id}`)).body.simulation;
      if (simulation.status !== 'running') break;
      await sleep(50);
    }
    assert.equal(simulation.status, 'completed');
    const beforeRun = (await request(base, '/api/runs/run_one')).body.run;
    const beforeProposal = (await request(base, '/api/proposals/proposal_one')).body.proposal;
    const beforeSimulation = (await request(base, `/api/simulations/${id}`)).body.simulation;
    await sleep(150);
    const before = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const review = await request(base, `/api/observation-review?simulationId=${id}&proposalId=proposal_one`);
    assert.equal(review.status, 200);
    assert.equal(review.headers.get('cache-control'), 'no-store');
    assert.equal(review.body.profile.provenance.simulation.id, id);
    assert.equal(review.body.profile.provenance.simulation.runId, 'run_one');
    assert.equal(review.body.profile.observations.steps[0].verdict, 'simulated');
    assert.ok(review.body.profile.missingEvidence.some((item) => item.code === 'simulated'));
    assert.ok(review.body.profile.uncertainty.some((item) => item.code === 'semantic_content'));
    assert.ok(review.body.profile.proposedNextSteps.length);
    assert.equal(review.body.proposalReview.proposalId, 'proposal_one');
    assert.equal(review.body.proposalReview.staticTest.status, 'failed');
    assert.match(review.body.proposalReview.staticTest.failures[0].reason, /missing url/);
    assert.deepEqual((await request(base, '/api/runs/run_one')).body.run, beforeRun);
    assert.deepEqual((await request(base, '/api/proposals/proposal_one')).body.proposal, beforeProposal);
    assert.deepEqual((await request(base, `/api/simulations/${id}`)).body.simulation, beforeSimulation);
    await sleep(150);
    const after = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    for (const key of ['runs', 'workflows', 'proposals', 'simulations', 'captures']) {
      assert.deepEqual(after[key], before[key], `review must not mutate ${key}`);
    }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, sleep(3000)]);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
