import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const serverPath = path.resolve('server/index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(t, available) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-run-mode-'));
  const bin = path.join(cwd, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(cwd, 'data'));
  if (available && process.platform !== 'win32') {
    // A fake adb makes backend detection deterministic without controlling a device.
    fs.writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\nprintf "List of devices attached\\ntest-device\\tdevice\\n"\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(cwd, 'data', 'db.json'), JSON.stringify({
    settings: {
      dryRun: false, autoNotes: false, autoRecoverFailures: false,
      endpoint: 'http://127.0.0.1:1/api/chat', gatewayEnabled: false,
      continuityAutoContinue: false, continuityEnabled: false, continuityFrameWatch: false,
      companionEnabled: false, agentTickMs: 600000,
    },
    workflows: [
      { id: 'wf_mode', name: 'Mode test', status: 'ready', failurePolicy: { onFailure: 'stop', maxRetries: 0 }, steps: [{ id: 'note', type: 'note', name: 'Note', params: { text: 'test' } }] },
      { id: 'wf_empty', name: 'Unplanned workflow', status: 'ready', steps: [] },
    ],
    runs: [],
  }));
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port) };
  if (available && process.platform === 'win32') {
    delete env.SIGHTLINE_TARGET;
  } else {
    env.PATH = bin;
    env.SIGHTLINE_TARGET = 'android';
    env.ANDROID_SERIAL = '';
  }
  let output = '';
  const child = spawn(process.execPath, [serverPath], {
    cwd, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    // Windows can keep the child's working directory handle for a moment
    // after it exits, so the first removal races; retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 9) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    let response;
    try { response = await fetch(`${base}/api/health`); } catch { /* Listener is not ready. */ }
    if (response?.ok) {
      assert.equal((await response.json()).available, available);
      return base;
    }
    await sleep(50);
  }
  throw new Error(`Server did not start: ${output}`);
}

async function request(base, route, method = 'GET', body) {
  const response = await fetch(`${base}${route}`, {
    method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('live check reports unavailable backend and explicit live requests do not simulate silently', { timeout: 30000 }, async (t) => {
  const base = await startServer(t, false);
  const run = (body, id = 'wf_mode') => request(base, `/api/workflows/${id}/runs`, 'POST', body);
  const state = async () => (await request(base, '/api/state')).body;
  const before = await state();
  const refusal = before.platform.reason;
  assert.ok(refusal);
  const check = await request(base, '/api/live/check', 'POST', {});
  assert.equal(check.status, 200);
  assert.equal(check.body.available, false);
  assert.ok(check.body.reason);
  const runIds = [];

  for (const body of [{}, { mode: '' }]) {
    const response = await run(body);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.run.dryRun, true);
    assert.equal(response.body.liveFallback, refusal);
    runIds.push(response.body.run.id);
  }
  const after = await state();
  for (const id of runIds) {
    assert.equal(after.runs.find((entry) => entry.id === id)?.dryRun, true, 'queued run is simulated');
  }
  assert.equal(after.runs.length, before.runs.length + runIds.length);
  const action = after.actionLog.items.find((item) => item.action === 'start-run:Mode test');
  assert.equal(action?.count, 2);
  assert.deepEqual(action.detail, { workflowId: 'wf_mode', requestedMode: 'live' });
  assert.equal(action.error, refusal);
  assert.equal(after.activity.filter((entry) => entry.itemId === action.id && /running simulated instead/.test(entry.message)).length, 2);

  const unplanned = await run({}, 'wf_empty');
  assert.equal(unplanned.status, 200);
  assert.equal(unplanned.body.run.dryRun, true);
  assert.equal(unplanned.body.liveFallback, refusal);
  assert.ok(unplanned.body.autoPlan.created > 0, 'fallback still plans empty workflows');

  for (const mode of ['dry', 'simulated']) {
    const response = await run({ mode });
    assert.equal(response.status, 200);
    assert.equal(response.body.run.dryRun, true);
    assert.equal(response.body.liveFallback, null);
  }
  assert.equal((await request(base, '/api/settings', 'PATCH', { dryRun: true })).status, 200);
  const defaultDry = await run({});
  assert.equal(defaultDry.status, 200);
  assert.equal(defaultDry.body.run.dryRun, true);
  assert.equal(defaultDry.body.liveFallback, null);
  const explicitLive = await run({ mode: 'live' });
  assert.equal(explicitLive.status, 409, 'explicit live is refused instead of silently becoming simulated');
  // Any refusal that names the platform limitation is enough; on Windows an
  // android target is refused by the automation dispatcher instead of X11 terms.
  assert.match(explicitLive.body.error, /unavailable|display|xdotool|screenshot|adb|not supported|dispatcher/i);
  assert.equal((await state()).actionLog.items.find((item) => item.id === action.id).count, 2);
});

test('verified backend permits saved and explicit live modes', { timeout: 30000 }, async (t) => {
  const base = await startServer(t, true);
  const readiness = await request(base, '/api/live/check', 'POST', {});
  assert.equal(readiness.body.available, true);
  const run = (body) => request(base, '/api/workflows/wf_mode/runs', 'POST', body);
  for (const body of [{}, { mode: '' }, { mode: 'live' }]) {
    const response = await run(body);
    assert.equal(response.status, 200);
    assert.equal(response.body.run.dryRun, false);
    assert.equal(response.body.liveFallback, null);
  }
  assert.equal((await request(base, '/api/settings', 'PATCH', { dryRun: true })).status, 200);
  const explicitLive = await run({ mode: 'live' });
  assert.equal(explicitLive.body.run.dryRun, false);
  assert.equal(explicitLive.body.liveFallback, null);
  const defaultDry = await run({});
  assert.equal(defaultDry.body.run.dryRun, true);
  assert.equal(defaultDry.body.liveFallback, null);
  const state = (await request(base, '/api/state')).body;
  assert.equal(state.actionLog.items.some((item) => item.action === 'start-run:Mode test'), false);
});
