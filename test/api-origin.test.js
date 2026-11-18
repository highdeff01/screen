import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('API mutations require a valid same-host Origin when one is present', { timeout: 30000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'api-origin-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  fs.writeFileSync(path.join(cwd, 'data', 'db.json'), JSON.stringify({
    settings: { autoRecoverFailures: false, continuityAutoContinue: false, continuityEnabled: false, continuityFrameWatch: false, companionEnabled: false, agentTickMs: 600000 },
  }));
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
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
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { ready = (await fetch(`${base}/api/companion/notes`)).ok; } catch { await sleep(50); }
  }
  assert.ok(ready, output);
  const notes = async () => (await (await fetch(`${base}/api/companion/notes`)).json()).notes;
  const post = (origin, text) => fetch(`${base}/api/companion/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) },
    body: JSON.stringify({ text }),
  });

  const before = await notes();
  const badOrigins = [
    'http://evil.example', 'null', '', 'not an origin', 'file://localhost',
    `ftp://127.0.0.1:${port}`, `${base}/path`, `${base}/`, `${base}?x=1`,
    `http://user@127.0.0.1:${port}`, `${base} https://evil.example`,
    'http://127.0.0.1:', `http://127.0.0.1:${port + 1}`,
  ];
  for (const origin of badOrigins) {
    const response = await post(origin, 'must not be stored');
    assert.equal(response.status, 403, `rejected Origin ${JSON.stringify(origin)}`);
    assert.deepEqual(await response.json(), { ok: false, error: 'Origin not allowed' });
  }
  assert.deepEqual(await notes(), before, 'rejected requests did not reach the handler');
  assert.equal((await post(base, 'same-origin note')).status, 200);
  assert.equal((await post(`https://127.0.0.1:${port}`, 'https-origin note')).status, 200);
  assert.equal((await post(undefined, 'CLI note')).status, 200);
  const after = await notes();
  assert.equal(after.length, before.length + 3);

  // The guard applies before route matching for all unsafe methods, but not reads.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await fetch(`${base}/api/no-such-route`, { method, headers: { origin: 'http://evil.example' } })).status, 403, method);
    assert.equal((await fetch(`${base}/api/no-such-route`, { method })).status, 404, method);
  }
  assert.equal((await fetch(`${base}/api/companion/notes`, { headers: { origin: 'http://evil.example' } })).status, 200);

  // Preserve preview validation and heartbeat without starting a capture.
  const preview = (origin) => fetch(`${base}/api/live/preview`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin === undefined ? {} : { origin }) }, body: JSON.stringify({ action: 'heartbeat' }) });
  assert.equal((await preview('http://evil.example')).status, 403);
  assert.equal((await preview(base)).status, 200);
  assert.equal((await preview(undefined)).status, 200);
  const shared = (origin) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/live/preview`, {
      method: 'POST', headers: { host: 'shared.example', origin, 'content-type': 'application/json' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ action: 'heartbeat' }));
  });
  assert.equal(await shared('https://shared.example'), 200);
  assert.equal(await shared(base), 403);
});
