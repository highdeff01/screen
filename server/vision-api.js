/**
 * The vision engine's HTTP surface.
 *
 * One route pair, so the console has a single place to start the stream, set
 * what it is watching for, hand the review agent's labels back for tracking,
 * open an isolated session and read the timeline. Frames themselves are
 * ordinary files under `data/vision` (or `data/vision-sessions/<id>/vision`),
 * served by the existing `/api/files/raw` route — no second image endpoint.
 *
 * The stream route is the fast path: `/api/vision/stream` is an SSE channel
 * that pushes frames, labels and live-control decisions as they happen, with a
 * keep-alive ping, so the browser does not poll a card that already knows what
 * changed. `GET /api/vision` stays for the first paint and for anything that
 * cannot hold a connection open.
 *
 * Everything that names a session works on that session: its engine, its
 * reviewer, its frames and its controller. The console's own stream is session
 * `main`, so an old caller that never mentions a session gets exactly the
 * behaviour it had before.
 */
import path from 'node:path';
import { vision } from './vision-engine.js';
import { visionReview, createVisionReviewer } from './vision-review.js';
import { visionSessions, sessionId } from './vision-sessions.js';
import { visionBus } from './vision-bus.js';
import { createVisionController, visionControl, MAX_STEPS, MAX_MS } from './vision-control.js';
import { DATA, logActivity } from './store.js';

/** Controllers and reviewers are per session: one loop cannot drive two goals. */
const controllers = new Map([['main', visionControl]]);
const reviewers = new Map([['main', visionReview]]);
const wired = new WeakSet();

function requireSession(id) {
  const key = sessionId(id);
  const session = visionSessions.get(key);
  if (!session) throw new Error(`No vision session “${key}” is open.`);
  return session;
}

function engineFor(id) {
  const key = sessionId(id);
  if (key === 'main') return vision;
  wireEngine(key, requireSession(key).engine);
  return requireSession(key).engine;
}

function controllerFor(id) {
  const key = sessionId(id);
  if (controllers.has(key)) return controllers.get(key);
  const session = requireSession(key);
  wireEngine(key, session.engine);
  const controller = createVisionController({
    engine: session.engine,
    sessionId: key,
    // The reviewer reads this session's frames, so its summary is the reading
    // the decision prompt needs; the engine itself never holds one.
    readReview: () => reviewerFor(key).state()?.lastReview,
    publish: (type, data) => visionBus.publish(type, data),
  });
  controllers.set(key, controller);
  return controller;
}

/**
 * A reviewer reads the frames of one engine, so its data directory has to be
 * that engine's own — otherwise an isolated session's relative frame paths
 * would be looked up under the console stream's ring.
 */
function reviewerFor(id) {
  const key = sessionId(id);
  if (reviewers.has(key)) return reviewers.get(key);
  const session = requireSession(key);
  const reviewer = createVisionReviewer({
    engine: session.engine,
    dataDir: path.join(DATA, session.dir),
  });
  reviewers.set(key, reviewer);
  return reviewer;
}

/** Every kept frame is pushed to the viewers of that session, path and all. */
function wireEngine(id, engine) {
  if (!engine || wired.has(engine)) return;
  wired.add(engine);
  engine.onFrame?.((record) => {
    const session = visionSessions.view(id);
    const file = session?.dir ? `${session.dir}/${record.file}` : record.file;
    visionBus.publish('frame', { session: id, frame: { ...record, file } });
  });
}

function sessionView(id) {
  const key = sessionId(id);
  const session = visionSessions.view(key);
  if (!session) throw new Error(`No vision session “${key}” is open.`);
  wireEngine(key, visionSessions.get(key)?.engine);
  return { ...session, control: controllerFor(key).state() };
}

export function registerVisionRoutes({ route, sendJson, fail, readBody }) {
  wireEngine('main', vision);

  route('GET', /^\/api\/vision$/, async (req, res) => {
    let selected = 'main';
    try {
      selected = sessionId(new URL(req.url, 'http://127.0.0.1').searchParams.get('session') || 'main');
    } catch {
      // A request URL this server cannot parse is still the console's own stream.
    }
    let session = null;
    let review = visionReview.state();
    try {
      session = sessionView(selected);
      review = reviewerFor(selected).state();
    } catch {
      session = null;
    }
    return sendJson(res, 200, {
      ok: true,
      vision: session?.state || vision.state(),
      review,
      sessions: visionSessions.list(),
      session,
      control: session?.control || visionControl.state(),
      stream: visionBus.state(),
    });
  });

  // Server-sent events: the card's live view. One connection, one session.
  route('GET', /^\/api\/vision\/stream$/, async (req, res) => {
    let id = 'main';
    try {
      id = sessionId(new URL(req.url, 'http://127.0.0.1').searchParams.get('session') || 'main');
    } catch {
      id = 'main';
    }
    let session = null;
    try {
      session = requireSession(id);
    } catch (err) {
      return fail(res, 404, String(err?.message || err).slice(0, 200));
    }
    wireEngine(id, session.engine);
    try {
      const client = visionBus.subscribe(res, {
        session: id,
        hello: { vision: session.engine.state(), control: controllerFor(id).state() },
      });
      return client;
    } catch (err) {
      return fail(res, err?.busy ? 429 : 500, String(err?.message || err).slice(0, 300));
    }
  });

  route('POST', /^\/api\/vision$/, async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, 'Invalid request body');
    }
    const action = String(body?.action || '');
    const target = sessionId(body?.session || 'main');
    try {
      /* ---------------- the stream itself ---------------- */
      if (action === 'start' || action === 'stop' || action === 'step' || action === 'goal' || action === 'digest') {
        const engine = engineFor(target);
        if (action === 'start') {
          const started = engine.start({ fps: body.fps, goal: body.goal, minChangedPct: body.minChangedPct });
          logActivity('vision', `Vision engine started at ${started.fps} fps${started.goal.text ? ` for “${started.goal.text}”` : ''}`);
          return sendJson(res, 200, { ok: true, vision: started });
        }
        if (action === 'stop') {
          const stopped = engine.stop();
          logActivity('vision', 'Vision engine stopped');
          return sendJson(res, 200, { ok: true, vision: stopped });
        }
        if (action === 'step') {
          const frame = await engine.step();
          return sendJson(res, 200, { ok: true, frame, vision: engine.state() });
        }
        if (action === 'goal') {
          if (body.reached === true) {
            const goal = engine.markGoalReached(body.reason || 'the goal was marked reached');
            logActivity('vision', `Vision goal reached: ${goal.reason}`);
            return sendJson(res, 200, { ok: true, goal, vision: engine.state() });
          }
          return sendJson(res, 200, { ok: true, goal: engine.setGoal(body.goal), vision: engine.state() });
        }
        return sendJson(res, 200, { ok: true, digest: engine.digest({ count: body.count }) });
      }

      // The review agent's labels come back here: text plus a normalized box.
      if (action === 'label') {
        const engine = engineFor(target);
        const result = engine.labelFrame(body.seq, body.labels);
        logActivity('vision', `Labeled frame ${result.frame} (${result.added.length} new element(s))`);
        return sendJson(res, 200, { ok: true, ...result, vision: engine.state() });
      }
      // The labelling agent: on, off, or one look at the newest frame now.
      if (action === 'review') {
        const reviewer = reviewerFor(target);
        if (body.enabled === false) {
          const review = reviewer.stop();
          logActivity('vision', 'Model labelling stopped');
          return sendJson(res, 200, { ok: true, review, vision: engineFor(target).state() });
        }
        // A label agent with no stream has nothing to read, so turning it on
        // starts the stream too rather than idling behind a second button.
        const engine = engineFor(target);
        const already = engine.state().running;
        if (!already) engine.start({ fps: body.fps, goal: body.goal });
        const review = reviewer.start();
        logActivity('vision', already ? 'Model labelling on' : 'Vision engine started and model labelling on');
        return sendJson(res, 200, { ok: true, review, vision: engine.state() });
      }
      if (action === 'review-now') {
        const entry = await reviewerFor(target).reviewNow();
        return sendJson(res, 200, { ok: true, entry, review: reviewerFor(target).state(), vision: engineFor(target).state() });
      }

      /* ---------------- isolated sessions ---------------- */
      if (action === 'session-open' || action === 'session') {
        const session = visionSessions.open({
          id: target,
          name: body.name,
          fps: body.fps,
          goal: body.goal,
          start: body.start === true,
        });
        wireEngine(session.id, visionSessions.get(session.id)?.engine);
        return sendJson(res, 200, {
          ok: true,
          session,
          sessions: visionSessions.list(),
          control: controllerFor(session.id).state(),
        });
      }
      if (action === 'session-close') {
        if (target === 'main') return fail(res, 400, 'The console stream cannot be closed.');
        const controller = controllers.get(target);
        if (controller?.state().running) return fail(res, 409, 'Stop live control in that session before closing it.');
        const reviewer = reviewers.get(target);
        reviewer?.stop();
        reviewers.delete(target);
        if (!visionSessions.close(target)) return fail(res, 404, `No vision session “${target}” is open.`);
        controllers.delete(target);
        return sendJson(res, 200, { ok: true, sessions: visionSessions.list() });
      }

      /* ---------------- live control (video mode) ---------------- */
      if (action === 'control' || action === 'control-stop' || action === 'control-reset') {
        const session = requireSession(target);
        wireEngine(target, session.engine);
        const controller = controllerFor(target);
        if (action === 'control-stop') {
          return sendJson(res, 200, { ok: true, control: controller.stop(body.reason || 'stopped by the operator') });
        }
        if (action === 'control-reset') {
          return sendJson(res, 200, { ok: true, control: controller.reset() });
        }
        // The goal is checked before anything starts: a live loop with no goal
        // would capture the desktop forever and never act.
        if (!String(body.goal || '').trim()) return fail(res, 400, 'Live control needs a goal to work towards.');
        // Live control reads the stream, so a stopped stream is started here
        // rather than asking the operator to press two buttons in order.
        if (!session.engine.state().running) {
          session.engine.start({ fps: body.fps === undefined ? 4 : body.fps, goal: body.goal });
        }
        const control = controller.start({
          goal: body.goal,
          maxSteps: body.maxSteps === undefined ? MAX_STEPS : body.maxSteps,
          maxMs: body.maxMs === undefined ? MAX_MS : body.maxMs,
        });
        return sendJson(res, 200, { ok: true, control, vision: session.engine.state() });
      }

      return fail(
        res,
        400,
        'action must be start, stop, step, goal, label, review, review-now, digest, session-open, session-close, control, control-stop or control-reset'
      );
    } catch (err) {
      return fail(res, 400, String(err?.message || err).slice(0, 300));
    }
  });
}
