/**
 * Isolated sessions: each has its own engine, directory and frame ring, and the
 * console's own stream keeps its old identity. The engines are fakes, because
 * what is being asserted is the registry — who owns which directory, what is
 * closed, and what a second session cannot touch.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createVisionSessions, sessionId, SESSION_DIR } from '../server/vision-sessions.js';

function fakeEngine(label = 'engine') {
  return {
    label,
    starts: 0,
    stops: 0,
    running: false,
    start(options = {}) {
      this.starts += 1;
      this.running = true;
      this.options = options;
      return this.state();
    },
    stop(reason = '') {
      this.stops += 1;
      this.running = false;
      this.reason = reason;
      return this.state();
    },
    state() {
      return {
        running: this.running,
        fps: 4,
        frameCount: 1,
        current: { seq: 1, file: 'vision/frame-000001.png', changedPct: 12 },
        frames: [{ seq: 1, file: 'vision/frame-000001.png', changedPct: 12 }],
        elements: [],
      };
    },
    onFrame: () => () => {},
  };
}

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-sessions-'));
  let clock = 1000;
  const main = fakeEngine('main');
  const made = [];
  const sessions = createVisionSessions({
    dataDir: dir,
    engine: main,
    makeEngine: (childDir, id) => {
      const engine = fakeEngine(id);
      engine.dir = childDir;
      made.push(engine);
      return engine;
    },
    max: 2,
    idleMs: 1000,
    clock: () => clock,
  });
  return {
    dir,
    main,
    made,
    sessions,
    advance(ms) {
      clock += ms;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('a session id is a safe directory name, and main is the default', () => {
  assert.equal(sessionId(), 'main');
  assert.equal(sessionId(''), 'main');
  assert.equal(sessionId('  Invoice ../Run '), 'invoice-run');
  assert.equal(sessionId('A'.repeat(80)), 'a'.repeat(24));
});

test('the console stream is the given engine and its frames keep their old paths', () => {
  const h = harness();
  try {
    const main = h.sessions.view('main');
    assert.equal(main.isolated, false);
    assert.equal(main.dir, null);
    assert.equal(main.state.current.file, 'vision/frame-000001.png', 'no directory is prefixed on the console stream');
    assert.throws(() => h.sessions.close('main'), /cannot be closed/);
  } finally {
    h.cleanup();
  }
});

test('a second session gets its own engine, directory and prefixed frames', () => {
  const h = harness();
  try {
    const opened = h.sessions.open({ id: 'live', name: 'Live control', fps: 6 });
    assert.equal(opened.id, 'live');
    assert.equal(opened.isolated, true);
    assert.equal(opened.dir, `${SESSION_DIR}/live`);
    assert.equal(h.made.length, 1, 'exactly one engine was created for the new session');
    assert.equal(h.made[0].starts, 1, 'the requested fps started the session stream');
    assert.equal(h.made[0].options.fps, 6);
    assert.equal(opened.state.current.file, 'vision-sessions/live/vision/frame-000001.png', 'the file route needs the session path');
    assert.ok(fs.existsSync(path.join(h.dir, SESSION_DIR, 'live')), 'the session directory exists');
    assert.equal(h.main.starts, 0, 'the console stream was not touched');

    const again = h.sessions.open({ id: 'live' });
    assert.equal(again.id, 'live');
    assert.equal(h.made.length, 1, 'opening an existing session reuses its engine');

    h.sessions.open({ id: 'audit' });
    const dirs = h.made.map((engine) => engine.dir);
    assert.notEqual(dirs[0], dirs[1], 'two isolated sessions never share a directory');
  } finally {
    h.cleanup();
  }
});

test('sessions are capped and closing one removes only its own frames', () => {
  const h = harness();
  try {
    h.sessions.open({ id: 'one' });
    h.sessions.open({ id: 'two' });
    assert.throws(() => h.sessions.open({ id: 'three' }), /Only 2 isolated vision session/);

    const before = h.sessions.view('two');
    assert.ok(before, 'the second session is still open');
    assert.equal(h.sessions.close('one'), true);
    assert.equal(h.sessions.close('one'), false, 'closing twice is harmless');
    assert.equal(h.made[0].stops, 1, 'the closed session engine was stopped');
    assert.equal(fs.existsSync(path.join(h.dir, SESSION_DIR, 'one')), false, 'its frames were removed');
    assert.equal(h.sessions.view('two').state.current.file, 'vision-sessions/two/vision/frame-000001.png');
  } finally {
    h.cleanup();
  }
});

test('an idle session is swept, a running one is not', () => {
  const h = harness();
  try {
    h.sessions.open({ id: 'idle' });
    h.sessions.open({ id: 'busy' });
    h.made[1].running = true;
    h.advance(5000);
    const closed = h.sessions.sweep();
    assert.deepEqual(closed, ['idle'], 'only the idle session was closed');
    assert.ok(h.sessions.view('busy'), 'a running session is never swept');
  } finally {
    h.cleanup();
  }
});
