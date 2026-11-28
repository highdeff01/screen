import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { claimDataFolder, releaseDataFolder } from '../server/data-lock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODULE = pathToFileURL(path.resolve(import.meta.dirname, '..', 'server', 'data-lock.js')).href;

function tempApp() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'data-lock-console-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  fs.writeFileSync(path.join(cwd, 'data', 'db.json'), JSON.stringify({
    settings: {
      autoRecoverFailures: false,
      continuityAutoContinue: false,
      continuityEnabled: false,
      continuityFrameWatch: false,
      companionEnabled: false,
      localModelAutoStart: false,
      agentTickMs: 600000,
    },
  }));
  return cwd;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function startConsole(cwd, port) {
  let output = '';
  const child = spawn(process.execPath, [path.resolve('server/index.js')], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, read: () => output };
}

async function waitFor(fn, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    await sleep(50);
  }
  return null;
}

const healthy = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
  } catch {
    return false;
  }
};

test('a folder held by a running console is refused, and a dead owner is replaced', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-lock-'));
  const script = path.join(dir, 'holder.mjs');
  fs.writeFileSync(script, `
import { claimDataFolder } from ${JSON.stringify(MODULE)};
const claim = claimDataFolder(process.argv[2], { port: 4517 });
console.log(claim.ok ? 'claimed' : 'refused');
if (claim.ok) setInterval(() => {}, 1000);
`);
  const holder = spawn(process.execPath, [script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  holder.stdout.on('data', (chunk) => { output += chunk; });
  try {
    for (let attempt = 0; attempt < 100 && !output.includes('claimed'); attempt += 1) await sleep(50);
    assert.match(output, /claimed/);
    const refused = claimDataFolder(dir);
    assert.equal(refused.ok, false);
    assert.equal(refused.owner.pid, holder.pid);
    assert.equal(refused.owner.port, 4517);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill('SIGKILL');
      await exited;
    }
  }

  const taken = claimDataFolder(dir, { port: 4599 });
  assert.equal(taken.ok, true, 'the lock of a console that exited can be replaced');
  assert.equal(releaseDataFolder(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'console.lock')), false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('a second console on one data folder stops and names the console that owns it', { timeout: 90000 }, async (t) => {
  const cwd = tempApp();
  const firstPort = await freePort();
  const secondPort = await freePort();
  const first = startConsole(cwd, firstPort);
  let second = null;
  t.after(async () => {
    for (const console of [second, first]) {
      if (!console || console.child.exitCode !== null || console.child.signalCode !== null) continue;
      const exited = once(console.child, 'exit');
      console.child.kill();
      await exited;
    }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  assert.ok(await waitFor(() => healthy(firstPort)), first.read());
  await sleep(300);
  second = startConsole(cwd, secondPort);

  const exitCode = await waitFor(() => (second.child.exitCode === null ? null : second.child.exitCode), 30000);
  assert.equal(exitCode, 1, `the second console did not stop:\n${second.read()}`);
  assert.match(
    second.read(),
    new RegExp(`is already owned by the console on http://127\\.0\\.0\\.1:${firstPort} \\(pid ${first.child.pid}\\)`)
  );
  assert.match(second.read(), /SIGHTLINE_ALLOW_SHARED_DATA=1/);
  assert.ok(await healthy(firstPort), 'the owning console stopped answering');
  assert.deepEqual(
    fs.readdirSync(path.join(cwd, 'data')).filter((name) => name.endsWith('.tmp')),
    [],
    'the refused console left a temp file behind'
  );
});
