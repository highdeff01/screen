import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-handoff-suggestion-endpoint-'));
const dataDir = path.join(tempRoot, 'data');
const workflowId = 'wf_draft_endpoint';
const completeRunId = 'run_draft_endpoint';
const emptyRunId = 'run_draft_endpoint_empty';

const SUGGESTION = {
  at: '2026-11-27T00:00:00.000Z',
  stepId: 'stp_click_settings',
  stepName: 'Click Settings',
  window: 'Sightline Profile',
  marker: 'Notifications',
  screenChangedPct: 8.4,
  control: { name: 'Back', x: 40, y: 60, method: 'OCR' },
  steps: [
    {
      id: 'handoff_suggested_1',
      type: 'clickElement',
      name: 'Reverse “Click Settings” — return via “Back”',
      params: { window: 'Sightline Profile', name: 'Back' },
      timeoutMs: 20000,
      optional: true,
    },
  ],
  complete: true,
  reason: 'The end screen in “Sightline Profile” shows “Back”; clicking it is the reverse of “Click Settings”.',
};

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
      workflows: [
        {
          id: workflowId,
          name: 'Draft endpoint probe',
          description: 'Accept a suggested hand-off without running anything.',
          status: 'ready',
          failurePolicy: { onFailure: 'stop', maxRetries: 0 },
          steps: [{ id: 'stp_note', type: 'note', name: 'Record the result', params: { text: 'done' } }],
          handoff: { enabled: false, steps: [] },
        },
      ],
      runs: [
        {
          id: completeRunId,
          workflowId,
          workflowName: 'Draft endpoint probe',
          status: 'passed',
          trigger: 'manual',
          dryRun: false,
          steps: [
            {
              id: 'stp_click_settings',
              type: 'clickElement',
              name: 'Click Settings',
              status: 'passed',
              params: { window: 'Sightline Profile', name: 'Settings', skipIfVisible: 'Notifications' },
            },
          ],
          evidence: [],
          log: [],
          handoffSuggestion: { ...SUGGESTION, steps: SUGGESTION.steps.map((step) => ({ ...step })) },
        },
        {
          id: emptyRunId,
          workflowId,
          workflowName: 'Draft endpoint probe',
          status: 'passed',
          trigger: 'manual',
          dryRun: false,
          steps: [],
          evidence: [],
          log: [],
          handoffSuggestion: {
            ...SUGGESTION,
            steps: [],
            complete: false,
            reason: 'No Back or Home control was found in “Sightline Profile”.',
          },
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

async function jsonRequest(base, route, body) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function state(base) {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  return res.json();
}

test('accepting a hand-off draft saves it to the workflow and runs nothing', { timeout: 30000 }, async () => {
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

    const before = await state(base);
    const detail = await (await fetch(`${base}/api/runs/${completeRunId}`)).json();
    assert.ok(detail.run?.handoffSuggestion, 'the run detail carries the draft');
    assert.equal(detail.run.handoffSuggestion.steps[0].params.name, 'Back');
    const workflowBefore = before.workflows.find((entry) => entry.id === workflowId);
    assert.equal(workflowBefore.handoff.enabled, false);
    assert.deepEqual(workflowBefore.handoff.steps, []);
    const runsBefore = before.runs.length;

    const empty = await jsonRequest(base, `/api/runs/${emptyRunId}/handoff-suggestion`, { action: 'accept' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /no steps to accept/i);
    assert.equal((await state(base)).runs.length, runsBefore, 'a draft with no steps queues nothing');

    const unknown = await jsonRequest(base, '/api/runs/run_missing/handoff-suggestion', { action: 'accept' });
    assert.equal(unknown.status, 404);

    const accepted = await jsonRequest(base, `/api/runs/${completeRunId}/handoff-suggestion`, { action: 'accept' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.workflow.handoff.enabled, true);
    assert.equal(accepted.body.workflow.handoff.steps.length, 1);
    assert.equal(accepted.body.workflow.handoff.steps[0].params.name, 'Back');
    assert.ok(accepted.body.run.handoffSuggestion.acceptedAt, 'the acceptance is recorded on the run');

    const after = await state(base);
    const workflowAfter = after.workflows.find((entry) => entry.id === workflowId);
    assert.equal(workflowAfter.handoff.enabled, true, 'the saved hand-off is what future runs use');
    assert.equal(workflowAfter.handoff.steps[0].params.window, 'Sightline Profile');
    assert.equal(after.runs.length, runsBefore, 'accepting a draft never queues a run');
    assert.equal(after.runs.find((run) => run.id === completeRunId).status, 'passed', 'the verdict is untouched');

    const again = await jsonRequest(base, `/api/runs/${completeRunId}/handoff-suggestion`, { action: 'accept' });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already accepted/i);
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
