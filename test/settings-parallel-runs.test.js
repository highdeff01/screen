import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// The settings route and the scheduler share one clamp; a value written here is
// the value the engine starts runs with, so nothing can be saved out of range.
test('PATCH /api/settings stores parallelRuns through the engine clamp', { timeout: 60000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-parallel-runs-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  fs.writeFileSync(path.join(cwd, 'data', 'db.json'), JSON.stringify({
    settings: { autoRecoverFailures: false, continuityAutoContinue: false, continuityEnabled: false, continuityFrameWatch: false, companionEnabled: false, agentTickMs: 600000 },
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.resolve('server/index.js')], { cwd, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    // Windows releases the temp folder's handles a moment after the server exits.
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch { await sleep(50); }
  }
  assert.ok(ready, output);

  const patch = async (value) => {
    const response = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parallelRuns: value }),
    });
    return { status: response.status, body: await response.json() };
  };
  const stored = async () => (await (await fetch(`${base}/api/state`)).json()).settings.parallelRuns;

  const cases = [
    [4, 4, 'a value inside the range is kept'],
    [99, 6, 'above the range is held at the ceiling'],
    [0, 1, 'below the range is held at one'],
    [-3, 1, 'a negative value is held at one'],
    [2.6, 3, 'a fraction is rounded'],
    ['5', 5, 'a numeric string is accepted'],
    ['two', 3, 'a non-numeric value falls back to the default'],
  ];
  for (const [value, expected, why] of cases) {
    const response = await patch(value);
    assert.equal(response.status, 200, `PATCH ${JSON.stringify(value)}`);
    assert.equal(response.body.settings.parallelRuns, expected, why);
    assert.equal(await stored(), expected, `${why} (and it is what /api/state reports)`);
  }

  // The console writes its state asynchronously, so give the write a moment:
  // what reaches disk is still inside the clamp.
  let saved = null;
  for (let i = 0; i < 60; i += 1) {
    saved = JSON.parse(fs.readFileSync(path.join(cwd, 'data', 'db.json'), 'utf8')).settings.parallelRuns;
    if (saved === 3) break;
    await sleep(50);
  }
  assert.equal(saved, 3, 'the last saved value reaches disk');
});
