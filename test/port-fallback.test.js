import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempApp() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'port-fallback-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  fs.writeFileSync(path.join(cwd, 'data', 'db.json'), JSON.stringify({
    settings: {
      autoRecoverFailures: false,
      continuityAutoContinue: false,
      continuityEnabled: false,
      continuityFrameWatch: false,
      companionEnabled: false,
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
    if (value) return value;
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

test('a console whose port is taken listens on the next free one', { timeout: 90000 }, async (t) => {
  const dirs = [tempApp(), tempApp()];
  const port = await freePort();
  const first = startConsole(dirs[0], port);
  let second = null;
  t.after(async () => {
    for (const console of [second, first]) {
      if (!console || console.child.exitCode !== null || console.child.signalCode !== null) continue;
      const exited = once(console.child, 'exit');
      console.child.kill();
      await exited;
    }
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  assert.ok(await waitFor(() => healthy(port)), first.read());
  second = startConsole(dirs[1], port);

  const chosen = await waitFor(() => {
    const match = second.read().match(/Sightline console running at http:\/\/127\.0\.0\.1:(\d+)/);
    return match && Number(match[1]);
  });
  assert.ok(chosen, `second console never started:\n${second.read()}`);
  assert.notEqual(chosen, port, 'the taken port was reused');
  assert.match(second.read(), new RegExp(`Port ${port} is already in use — trying ${port + 1}`));
  assert.ok(await waitFor(() => healthy(chosen), 10000), `second console did not answer on ${chosen}`);
  assert.ok(await healthy(port), 'the first console stopped answering on its port');
});
