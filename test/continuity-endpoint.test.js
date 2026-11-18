import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-continuity-endpoint-'));
const dataDir = path.join(tempRoot, 'data');
const originalRunId = 'run_endpoint_approval_probe';
const packId = 'rcp_endpoint_approval_probe';
const workflowId = 'wf_endpoint_approval_probe';

function seedDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  const steps = [
    { id: 'stp_original_fail', type: 'note', name: 'Original failed note', params: { text: 'failed' } },
  ];
  const candidateSteps = [
    { id: 'stp_retry_note', type: 'note', name: 'Record approved retry', params: { text: 'approved retry' } },
  ];
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
      },
      workflows: [
        {
          id: workflowId,
          name: 'Endpoint approval probe',
          description: 'Prove that approval is explicit and queues one retry.',
          status: 'ready',
          failurePolicy: { onFailure: 'stop', maxRetries: 0 },
          steps,
        },
      ],
      runs: [
        {
          id: originalRunId,
          workflowId,
          workflowName: 'Endpoint approval probe',
          status: 'failed',
          trigger: 'manual',
          dryRun: true,
          recoveryPackId: packId,
          recoveryDepth: 0,
          steps: [{ ...steps[0], status: 'failed', attempts: 1, error: 'Intentional endpoint test failure.' }],
          evidence: [],
          log: [],
        },
      ],
      recoveryPacks: [
        {
          id: packId,
          workflowId,
          workflowName: 'Endpoint approval probe',
          originalRunId,
          retryRunId: null,
          depth: 0,
          status: 'ready',
          selectedCandidateId: 'candidate_tested',
          candidates: [
            {
              id: 'candidate_tested',
              label: 'Tested recovery candidate',
              reason: 'Passed the shadow test.',
              steps: candidateSteps,
              test: { ok: true, status: 'passed', passed: 1, total: 1 },
            },
            {
              id: 'candidate_untested',
              label: 'Untested recovery candidate',
              reason: 'Shadow test failed.',
              steps: candidateSteps,
              test: { ok: false, status: 'failed', passed: 0, total: 1 },
            },
          ],
          stages: [],
          logs: [],
          incorporated: false,
          verification: null,
        },
      ],
    }),
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(base, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before health check (${child.exitCode}).\n${output()}`);
    }
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

async function jsonRequest(base, route, body) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function runs(base) {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  return state.runs || [];
}

function recoveryRuns(allRuns) {
  return allRuns.filter((run) => run.id !== originalRunId && run.recoveryOf === originalRunId);
}

test('continuation requires explicit approval of a tested candidate and queues exactly one retry', { timeout: 30000 }, async () => {
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

    const before = await runs(base);
    assert.equal(recoveryRuns(before).length, 0);

    const preview = await jsonRequest(base, `/api/continuity/continuations/${originalRunId}`, {});
    assert.equal(preview.status, 200);
    assert.equal(preview.body.requiresApproval, true);
    assert.equal(preview.body.packId, packId);
    assert.equal(preview.body.candidateId, 'candidate_tested');
    assert.equal(preview.body.candidates.length, 2);
    assert.equal((await runs(base)).filter((run) => run.id !== originalRunId).length, 0, 'a preview must not queue a run');

    const missing = await jsonRequest(base, `/api/continuity/continuations/${originalRunId}`, {
      confirm: true,
      candidateId: 'candidate_missing',
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Choose a tested recovery candidate/i);
    assert.equal(recoveryRuns(await runs(base)).length, 0, 'a missing candidate must not queue a run');

    const untested = await jsonRequest(base, `/api/continuity/continuations/${originalRunId}`, {
      confirm: true,
      candidateId: 'candidate_untested',
    });
    assert.equal(untested.status, 409);
    assert.match(untested.body.error, /did not pass its shadow test/i);
    assert.equal(recoveryRuns(await runs(base)).length, 0, 'an untested candidate must not queue a run');

    const approved = await jsonRequest(base, `/api/continuity/continuations/${originalRunId}`, {
      confirm: true,
      candidateId: 'candidate_tested',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.ok, true);
    assert.ok(approved.body.run?.id);
    assert.equal(approved.body.pack?.retryRunId, approved.body.run.id);

    const after = await runs(base);
    const retries = recoveryRuns(after);
    assert.equal(retries.length, 1, 'a confirmed tested candidate must queue exactly one retry');
    assert.equal(retries[0].id, approved.body.run.id);
    assert.equal(retries[0].trigger, 'recovery');
    assert.equal(retries[0].recoveryPackId, packId);
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
