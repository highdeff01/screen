/**
 * The capture worker's lockstep, without PowerShell.
 *
 * The worker is a real child process in production, but its contract is small
 * enough to state exactly: one request line, one answer, and a worker that
 * misses an answer is thrown away instead of asked again. A fake child lets the
 * test hold those promises to the letter — including the ones that are only
 * visible when a frame arrives too late.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureStreamScript, createCaptureStream } from '../server/vision-capture.js';

/** A stand-in for spawn() whose stdout the test writes to. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.requests = 0;
  child.killed = false;
  child.stdin = {
    write: (line) => {
      assert.equal(line, '\n', 'a request is a single newline');
      child.requests += 1;
      return true;
    },
    end: () => {},
  };
  child.kill = () => {
    child.killed = true;
  };
  child.pid = 4242;
  return child;
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-capture-'));
  const children = [];
  const stream = createCaptureStream({
    dataDir: dir,
    timeoutMs: 200,
    spawnProcess: (command) => {
      const child = fakeChild();
      // stop() also spawns taskkill on Windows; only the worker itself counts.
      if (!/^taskkill/i.test(String(command))) children.push(child);
      return child;
    },
    platform: 'win32',
  });
  return { dir, stream, children, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('one request, one frame, in order', async () => {
  const h = harness();
  try {
    const first = h.stream.next();
    assert.equal(h.children.length, 1, 'the worker starts on the first request');
    assert.equal(h.children[0].requests, 1);
    h.children[0].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'shot_1.png')}\n`);
    assert.deepEqual(await first, { path: 'vision-worker/shot_1.png' });

    const second = h.stream.next();
    assert.equal(h.children[0].requests, 2);
    h.children[0].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'shot_2.png')}\r\n`);
    assert.deepEqual(await second, { path: 'vision-worker/shot_2.png' });
    assert.equal(h.stream.state().failure, '');
  } finally {
    h.cleanup();
  }
});

test('a late answer is dropped instead of being given to the next request', async () => {
  const h = harness();
  try {
    const first = h.stream.next();
    h.children[0].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'shot_1.png')}\n`);
    await first;
    // Nothing is waiting now; this line must not become the next answer.
    h.children[0].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'stale.png')}\n`);

    const next = h.stream.next();
    h.children[0].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'shot_3.png')}\n`);
    assert.deepEqual(await next, { path: 'vision-worker/shot_3.png' });
  } finally {
    h.cleanup();
  }
});

test('a worker that does not answer is thrown away, not trusted later', async () => {
  const h = harness();
  try {
    await assert.rejects(() => h.stream.next(), (err) => {
      assert.equal(err.unreadable, true, 'a missed frame is unreadable, not unchanged');
      assert.match(err.message, /did not answer/);
      return true;
    });
    assert.equal(h.children[0].killed, true, 'the silent worker is stopped');
    // A later request starts a fresh worker rather than reusing the stale one.
    const retry = h.stream.next();
    assert.equal(h.children.length, 2, 'exactly one new worker, not the killed one');
    h.children[1].stdout.emit('data', `OK ${path.join(h.dir, 'vision-worker', 'shot_7.png')}\n`);
    assert.deepEqual(await retry, { path: 'vision-worker/shot_7.png' });
  } finally {
    h.cleanup();
  }
});

test('an error line is reported as a capture failure', async () => {
  const h = harness();
  try {
    const pending = h.stream.next();
    h.children[0].stdout.emit('data', 'ERR The desktop reported no area to capture.\n');
    await assert.rejects(() => pending, (err) => {
      assert.equal(err.unreadable, true);
      assert.match(err.message, /no area to capture/);
      return true;
    });
  } finally {
    h.cleanup();
  }
});

test('the worker script captures in lockstep and pays the assembly load once', () => {
  const script = captureStreamScript({ dir: 'C:\\data\\vision-worker', maxWidth: 1280 });
  assert.match(script, /Add-Type -AssemblyName System\.Windows\.Forms, System\.Drawing/);
  assert.equal(script.match(/Add-Type/g).length, 1, 'the load happens once, not per frame');
  assert.match(script, /\[Console\]::In\.ReadLine\(\)/, 'each frame is asked for, never streamed ahead');
  assert.match(script, /\$limit = 1280/);
  assert.match(script, /Write-Output \("OK " \+ \$file\)/);
  // A path with a quote would end the PowerShell string early; it is doubled.
  assert.match(captureStreamScript({ dir: "C:\\it's" }), /'C:\\it''s'/);
});
