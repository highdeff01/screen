/**
 * The vision engine's HTTP surface.
 *
 * One route pair, so the console has a single place to start the stream, set
 * what it is watching for, hand the review agent's labels back for tracking and
 * read the timeline. Frames themselves are ordinary files under `data/vision`,
 * served by the existing `/api/files/raw` route — no second image endpoint.
 */
import { vision } from './vision-engine.js';
import { visionReview } from './vision-review.js';
import { logActivity } from './store.js';

export function registerVisionRoutes({ route, sendJson, fail, readBody }) {
  route('GET', /^\/api\/vision$/, async (req, res) =>
    sendJson(res, 200, { ok: true, vision: vision.state(), review: visionReview.state() })
  );

  route('POST', /^\/api\/vision$/, async (req, res) => {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 400, 'Invalid request body');
    }
    const action = String(body?.action || '');
    try {
      if (action === 'start') {
        const started = vision.start({ fps: body.fps, goal: body.goal, minChangedPct: body.minChangedPct });
        logActivity('vision', `Vision engine started at ${started.fps} fps${started.goal.text ? ` for “${started.goal.text}”` : ''}`);
        return sendJson(res, 200, { ok: true, vision: started });
      }
      if (action === 'stop') {
        const stopped = vision.stop();
        logActivity('vision', 'Vision engine stopped');
        return sendJson(res, 200, { ok: true, vision: stopped });
      }
      // A single look now, for a caller that wants a frame without the stream.
      if (action === 'step') {
        const frame = await vision.step();
        return sendJson(res, 200, { ok: true, frame, vision: vision.state() });
      }
      if (action === 'goal') {
        if (body.reached === true) {
          const goal = vision.markGoalReached(body.reason || 'the goal was marked reached');
          logActivity('vision', `Vision goal reached: ${goal.reason}`);
          return sendJson(res, 200, { ok: true, goal, vision: vision.state() });
        }
        return sendJson(res, 200, { ok: true, goal: vision.setGoal(body.goal), vision: vision.state() });
      }
      // The review agent's labels come back here: text plus a normalized box.
      if (action === 'label') {
        const result = vision.labelFrame(body.seq, body.labels);
        logActivity('vision', `Labeled frame ${result.frame} (${result.added.length} new element(s))`);
        return sendJson(res, 200, { ok: true, ...result, vision: vision.state() });
      }
      // The labelling agent: on, off, or one look at the newest frame now.
      if (action === 'review') {
        if (body.enabled === false) {
          const review = visionReview.stop();
          logActivity('vision', 'Model labelling stopped');
          return sendJson(res, 200, { ok: true, review, vision: vision.state() });
        }
        // A label agent with no stream has nothing to read, so turning it on
        // starts the stream too rather than idling behind a second button.
        const already = vision.state().running;
        if (!already) vision.start({ fps: body.fps, goal: body.goal });
        const review = visionReview.start();
        logActivity('vision', already ? 'Model labelling on' : 'Vision engine started and model labelling on');
        return sendJson(res, 200, { ok: true, review, vision: vision.state() });
      }
      if (action === 'review-now') {
        const entry = await visionReview.reviewNow();
        return sendJson(res, 200, { ok: true, entry, review: visionReview.state(), vision: vision.state() });
      }
      if (action === 'digest') {
        return sendJson(res, 200, { ok: true, digest: vision.digest({ count: body.count }) });
      }
      return fail(res, 400, 'action must be start, stop, step, goal, label, review, review-now or digest');
    } catch (err) {
      return fail(res, 400, String(err?.message || err).slice(0, 300));
    }
  });
}
