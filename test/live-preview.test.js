import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureDesktop, createLivePreview } from '../server/live-preview.js';

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = 0;
  const jobs = [];
  const preview = createLivePreview({
    platform: 'win32', dataDir,
    capture: async () => Buffer.from('png'),
    monotonic: () => time,
    clock: () => new Date('2026-01-01T00:00:00Z'),
    schedule: (fn, delay) => { const job = { fn, delay, due: time + delay }; jobs.push(job); jobs.sort((a, b) => a.due - b.due); return job; },
    cancel: (job) => { const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1); },
    ...options,
  });
  const run = async () => {
    const job = jobs.shift();
    assert.ok(job, 'scheduled job');
    time = Math.max(time, job.due);
    job.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return job.delay;
  };
  const advance = async (ms) => {
    const target = time + ms;
    while (jobs.length && jobs[0].due <= target) await run();
    time = target;
  };
  return { preview, jobs, run, advance, elapse: (ms) => { time += ms; }, dataDir };
}

test('opt-in capture is single-file, periodic, clamped and removed on stop', async (t) => {
  const { preview, jobs, run, dataDir } = harness(t);
  assert.deepEqual(preview.state(), { running: false, available: true, reason: null, imagePath: null, capturedAt: null, error: null, intervalMs: 2000 });
  assert.equal(preview.start({ intervalMs: 1 }).intervalMs, 1000);
  assert.equal(preview.start({ intervalMs: 1 }).running, true);
  assert.equal(jobs.length, 2);
  await run();
  assert.equal(preview.state().imagePath, 'live-preview.png');
  assert.equal(preview.state().capturedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(fs.readFileSync(path.join(dataDir, 'live-preview.png'), 'utf8'), 'png');
  assert.equal(jobs[0].delay, 1000);
  await run();
  assert.deepEqual(fs.readdirSync(dataDir), ['live-preview.png']);
  preview.stop();
  assert.equal(jobs.length, 0);
  assert.equal(preview.state().imagePath, null);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal(preview.start({ intervalMs: 999999 }).intervalMs, 10000);
  assert.equal(jobs[0].delay, 1000, 'restart cannot bypass minimum rate');
  assert.throws(() => preview.start({ intervalMs: '1' }), /finite number/);
});

test('stopping during capture discards it; restart waits for it', async (t) => {
  let resolveCapture;
  let calls = 0;
  let signal;
  const { preview, jobs, run, dataDir } = harness(t, { capture: (captureSignal) => { signal = captureSignal; calls++; return new Promise((resolve) => { resolveCapture = resolve; }); } });
  preview.start();
  await run();
  preview.stop();
  assert.equal(signal.aborted, true);
  preview.start();
  assert.equal(jobs.length, 1, 'only the lease timer runs while capture is in flight');
  resolveCapture(Buffer.from('stale'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.state().imagePath, null);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].delay, 1000);
  assert.equal(calls, 1);
  await run();
  preview.stop();
  resolveCapture(Buffer.from('stale again'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('capture errors stop the loop without exposing error details', async (t) => {
  const { preview, jobs, run } = harness(t, { capture: async () => { throw new Error('secret token'); } });
  preview.start();
  await run();
  assert.equal(preview.state().running, false);
  assert.match(preview.state().error, /capture failed/i);
  assert.doesNotMatch(JSON.stringify(preview.state()), /secret token/);
  assert.equal(jobs.length, 0);
  assert.equal(preview.stop().error, null);
});

test('lease expires without heartbeats, removes the image and never captures again', async (t) => {
  let calls = 0;
  const { preview, jobs, run, advance, dataDir } = harness(t, { capture: async () => { calls++; return Buffer.from('png'); } });
  preview.start({ intervalMs: 1000 });
  await run();
  assert.equal(fs.existsSync(path.join(dataDir, 'live-preview.png')), true);
  await advance(14000);
  assert.equal(preview.state().running, true); // Reads do not extend the lease.
  preview.start({ intervalMs: 1000 }); // Nor does an idempotent start.
  await advance(1000);
  assert.equal(preview.state().running, false);
  assert.match(preview.state().reason, /heartbeat timed out/i);
  assert.equal(preview.state().imagePath, null);
  assert.equal(preview.state().capturedAt, null);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal(jobs.length, 0);
  const expiredCalls = calls;
  await advance(30000);
  assert.equal(calls, expiredCalls);
  assert.equal(preview.heartbeat().running, false, 'heartbeat cannot restart an expired preview');
  assert.match(preview.heartbeat().reason, /heartbeat timed out/i);
  assert.equal(preview.stop().reason, null);
});

test('regular heartbeats extend the lease, but a late heartbeat cannot revive it', async (t) => {
  const { preview, advance, elapse, dataDir } = harness(t);
  assert.equal(preview.heartbeat().running, false);
  preview.start();
  for (let i = 0; i < 3; i++) {
    await advance(10000);
    assert.equal(preview.heartbeat().running, true);
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'live-preview.png')), true);
  // Simulate a delayed event loop: a heartbeat must check the deadline itself.
  elapse(15000);
  assert.equal(preview.heartbeat().running, false);
  assert.match(preview.state().reason, /heartbeat timed out/i);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  assert.equal(preview.start().running, true);
  assert.equal(preview.state().reason, null);
  preview.stop();
});

test('lease aborts an in-flight capture and restart cannot publish stale pixels', async (t) => {
  let resolveCapture;
  let signal;
  let calls = 0;
  const { preview, jobs, run, advance, dataDir } = harness(t, {
    capture: (s) => { signal = s; calls++; return new Promise((resolve) => { resolveCapture = resolve; }); },
  });
  preview.start();
  await run();
  await advance(15000);
  assert.equal(signal.aborted, true);
  assert.equal(preview.state().running, false);
  assert.match(preview.state().reason, /heartbeat timed out/i);
  assert.equal(preview.start().running, true);
  assert.equal(jobs.length, 1, 'restart waits for old capture while lease remains active');
  resolveCapture(Buffer.from('stale'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.state().imagePath, null);
  assert.deepEqual(fs.readdirSync(dataDir), []);
  await run();
  assert.equal(calls, 2);
  preview.stop();
  resolveCapture(Buffer.from('stale again'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('capture completing after the deadline is discarded even if lease timer is delayed', async (t) => {
  let resolveCapture;
  const { preview, run, elapse, jobs, dataDir } = harness(t, {
    capture: () => new Promise((resolve) => { resolveCapture = resolve; }),
  });
  preview.start();
  await run();
  elapse(15000);
  resolveCapture(Buffer.from('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(preview.state().running, false);
  assert.match(preview.state().reason, /heartbeat timed out/i);
  assert.equal(jobs.length, 0);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('large high-resolution desktop captures are not rejected at 20 MiB', async (t) => {
  const pixels = Buffer.alloc(21 * 1024 * 1024, 42);
  const { preview, run, dataDir } = harness(t, { capture: async () => pixels });
  preview.start();
  await run();
  assert.equal(preview.state().running, true);
  assert.equal(fs.statSync(path.join(dataDir, 'live-preview.png')).size, pixels.length);
  preview.stop();
});

test('worker timeout kills the Windows process tree before cleaning its work directory', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-worker-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const work = path.join(dataDir, 'live-preview-work');
  let workerDone;
  let killDone;
  let workerKills = 0;
  const commands = [];
  const execute = (command, args, options, callback) => {
    commands.push({ command, args, options });
    if (command === 'taskkill') {
      killDone = callback;
      // The parent can exit before taskkill finishes with its descendants.
      workerDone(new Error('terminated'));
      return {};
    }
    workerDone = callback;
    return { pid: 123, kill: () => { workerKills++; } };
  };
  const capture = captureDesktop(dataDir, new AbortController().signal, { execute, platform: 'win32', timeoutMs: 5 });
  // Keep the event loop alive while the unref'ed timeout triggers.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1].args, ['/PID', '123', '/T', '/F']);
  assert.equal(fs.existsSync(work), true, 'work remains until descendants are terminated');
  killDone(null);
  await assert.rejects(capture, /interrupted/);
  assert.equal(fs.existsSync(work), false);
  assert.equal(workerKills, 0);
});

test('failed taskkill falls back to terminating the capture worker', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-worker-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let workerDone;
  let fallbackKills = 0;
  const execute = (command, _args, _options, callback) => {
    if (command === 'taskkill') {
      setImmediate(() => callback(new Error('taskkill failed')));
      return {};
    }
    workerDone = callback;
    return { pid: 123, kill: () => { fallbackKills++; setImmediate(() => workerDone(new Error('terminated'))); } };
  };
  const controller = new AbortController();
  const capture = captureDesktop(dataDir, controller.signal, { execute, platform: 'win32' });
  controller.abort();
  await assert.rejects(capture, /interrupted/);
  assert.equal(fallbackKills, 1);
  assert.equal(fs.existsSync(path.join(dataDir, 'live-preview-work')), false);
});

test('unsupported platforms never capture', async (t) => {
  let calls = 0;
  const { preview, jobs } = harness(t, { platform: 'linux', capture: async () => { calls++; } });
  const state = preview.start();
  assert.equal(state.running, false);
  assert.equal(state.available, false);
  assert.match(state.reason, /Windows/);
  assert.equal(jobs.length, 0);
  assert.equal(calls, 0);
});

test('HTTP endpoints expose state, validate actions and reject cross-origin starts', async (t) => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-http-'));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'server/index.js')], { cwd: temp, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    // Windows releases the temp folder's handles a moment after the server exits.
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const url = `http://127.0.0.1:${port}/api/live/preview`;
  let response;
  for (let i = 0; i < 100; i++) {
    try { response = await fetch(url); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  assert.ok(response, 'server started');
  const state = await response.json();
  assert.equal(state.ok, true);
  assert.deepEqual(Object.keys(state.preview), ['running', 'available', 'reason', 'imagePath', 'capturedAt', 'error', 'intervalMs']);
  assert.equal(state.preview.running, false);
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'invalid' })).status, 400);
  assert.equal((await post({ action: 'start' }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ action: 'heartbeat' }, { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await post({ action: 'heartbeat' }, { origin: `https://127.0.0.1:${port}` })).status, 200);
  const started = await (await post({ action: 'start', intervalMs: 1000 })).json();
  if (process.platform !== 'win32') {
    assert.equal(started.preview.available, false);
    assert.equal(started.preview.running, false);
  }
  const stopped = await (await post({ action: 'stop' })).json();
  assert.equal(stopped.preview.running, false);
});
