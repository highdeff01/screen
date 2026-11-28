/**
 * Isolated vision sessions: one stream per job, not one stream for the console.
 *
 * The engine was a singleton, which is fine for a single eye but wrong the
 * moment two things want to look at the screen at once. A live-control run
 * moving the pointer and a step-by-step workflow verifying a click do not share
 * a goal, must not share a frame ring, and must not stop each other's stream.
 * Each isolated session gets its own engine, its own hundred-frame history and
 * its own directory under `data/vision-sessions/<id>`, so one session closing
 * cannot delete the frames another one is about to read.
 *
 * The console's own stream keeps its old identity: session `main` is the
 * existing engine singleton and its frames stay at `data/vision`, so everything
 * built on the old route keeps working and the UI's default view does not move.
 *
 * Fan-out is deliberately small: sessions are opened on request, capped, and
 * closed when idle, because each one is a capture worker (a real PowerShell
 * process) and a directory of PNGs. A session registry that grows without a
 * limit is a memory leak with screenshots in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.js';
import { createVisionEngine, vision } from './vision-engine.js';

export const SESSION_DIR = 'vision-sessions';
export const MAX_SESSIONS = 4;
export const IDLE_MS = 10 * 60 * 1000;

/** A session id that is safe as a directory name and stable across calls. */
export function sessionId(value) {
  const text = String(value || 'main')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return text || 'main';
}

export function createVisionSessions({
  dataDir = DATA,
  engine: mainEngine = vision,
  makeEngine = null,
  max = MAX_SESSIONS,
  idleMs = IDLE_MS,
  clock = () => Date.now(),
  log = null,
} = {}) {
  const sessions = new Map();
  const make = typeof makeEngine === 'function' ? makeEngine : (dir) => createVisionEngine({ dataDir: dir });

  function mainSession() {
    return {
      id: 'main',
      name: 'Console stream',
      dir: null,
      engine: mainEngine,
      isolated: false,
      openedAt: new Date(clock()).toISOString(),
      touchedAt: clock(),
    };
  }
  sessions.set('main', mainSession());

  /** A frame file is relative to the session's data dir; the file route is not. */
  function framePath(session, file) {
    if (!file || !session.dir) return file;
    return `${session.dir}/${file}`;
  }

  function decorate(session, state) {
    if (!state) return state;
    if (!session.dir) return state;
    return {
      ...state,
      dir: session.dir,
      current: state.current ? { ...state.current, file: framePath(session, state.current.file) } : null,
      frames: (state.frames || []).map((frame) => ({ ...frame, file: framePath(session, frame.file) })),
    };
  }

  function view(id) {
    const session = sessions.get(id);
    if (!session) return null;
    session.touchedAt = clock();
    return {
      id: session.id,
      name: session.name,
      isolated: session.isolated,
      dir: session.dir,
      openedAt: session.openedAt,
      touchedAt: new Date(session.touchedAt).toISOString(),
      state: decorate(session, session.engine.state()),
    };
  }

  function get(id = 'main') {
    const key = sessionId(id);
    const session = sessions.get(key);
    if (!session) return null;
    session.touchedAt = clock();
    return session;
  }

  function engineFor(id = 'main') {
    return get(id)?.engine || null;
  }

  /**
   * Open a session, or return the one that already has this id. An optional
   * `fps`/`goal` is applied to the engine; `start: true` starts the stream.
   */
  function open({ id = '', name = '', fps, goal, start = false } = {}) {
    const key = sessionId(id);
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size > max) {
        throw new Error(`Only ${max} isolated vision session(s) can be open at once; close one first.`);
      }
      const dir = path.join(dataDir, SESSION_DIR, key);
      fs.mkdirSync(dir, { recursive: true });
      const engine = make(dir, key);
      if (!engine || typeof engine.state !== 'function') throw new Error('The session engine could not be created.');
      session = {
        id: key,
        name: String(name || key).slice(0, 60),
        dir: `${SESSION_DIR}/${key}`,
        engine,
        isolated: true,
        openedAt: new Date(clock()).toISOString(),
        touchedAt: clock(),
      };
      sessions.set(key, session);
      try {
        log?.('vision', `Opened isolated vision session “${session.name}” (${key})`);
      } catch {
        // A feed that cannot be written is not a reason to refuse a session.
      }
    }
    if (name) session.name = String(name).slice(0, 60);
    if (fps !== undefined || goal !== undefined) {
      session.engine.start({ ...(fps === undefined ? {} : { fps }), ...(goal === undefined ? {} : { goal }) });
    } else if (start) {
      session.engine.start({});
    }
    return view(key);
  }

  function close(id = '') {
    const key = sessionId(id);
    if (key === 'main') throw new Error('The console stream cannot be closed.');
    const session = sessions.get(key);
    if (!session) return false;
    try {
      session.engine.stop('the session was closed');
    } catch {
      // A session whose engine is already stopped still has a directory to remove.
    }
    sessions.delete(key);
    try {
      fs.rmSync(path.join(dataDir, SESSION_DIR, key), { recursive: true, force: true });
    } catch {
      // A frame file held open by a reader is not a session that is still open.
    }
    try {
      log?.('vision', `Closed vision session “${session.name}” (${key})`);
    } catch {
      // See above.
    }
    return true;
  }

  /** Close isolated sessions nobody has asked about for a while. */
  function sweep() {
    const cutoff = clock() - idleMs;
    const closed = [];
    for (const session of [...sessions.values()]) {
      if (!session.isolated) continue;
      if (session.touchedAt > cutoff) continue;
      if (session.engine.state().running) {
        // A running session is being used even if nobody polls it; keep it and
        // let it expire after this sweep's grace period instead of killing work.
        session.touchedAt = clock();
        continue;
      }
      close(session.id);
      closed.push(session.id);
    }
    return closed;
  }

  function list() {
    sweep();
    return [...sessions.keys()].map((id) => view(id));
  }

  function closeAll() {
    for (const session of [...sessions.values()]) {
      if (!session.isolated) continue;
      close(session.id);
    }
  }

  return { get, view, engineFor, open, close, list, sweep, closeAll };
}

export const visionSessions = createVisionSessions();
