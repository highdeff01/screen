/**
 * Frames, cheaply.
 *
 * Every capture on this machine starts a PowerShell process, so the same moment
 * used to be paid for several times: thinking read a signature, aiming asked for
 * the foreground window, the step audit read another signature, and the screen
 * review took a picture — all within the same second, all describing the same
 * pixels.
 *
 * Two small things fix that without making any reading stale:
 *
 *   createFrameCache — one capture serves every caller inside a short window, and
 *                      two callers that arrive together share a single capture
 *                      instead of starting two processes
 *   waitUntilStill   — the operator's rule that the run acts on a settled screen:
 *                      sample until two frames agree, bounded by a timeout so a
 *                      video or a spinner cannot hold a step forever
 *
 * Both take their capture function and their clock as arguments, so the timing
 * is testable without a desktop or a real sleep.
 */
import { diffSignatures } from './visual.js';

/** A frame whose change is at or below this percentage counts as unchanged. */
export const STILL_PCT = 1;

export function isStill(delta, stillPct = STILL_PCT) {
  return Number(delta?.changedPct ?? 0) <= stillPct;
}

/**
 * A capture cache with a short life. `maxAgeMs` is the whole policy: a frame
 * older than that is never reused, so a caller that needs the present can always
 * ask for it with `read({ maxAgeMs: 0 })`.
 */
export function createFrameCache({ capture, maxAgeMs = 400, now = () => Date.now() } = {}) {
  if (typeof capture !== 'function') throw new Error('createFrameCache needs a capture function');
  let last = null;
  let inflight = null;
  const stats = { reads: 0, hits: 0, captures: 0, errors: 0 };
  const read = async ({ maxAgeMs: age = maxAgeMs } = {}) => {
    stats.reads += 1;
    // `maxAgeMs: 0` means "the present, please": it must never be served a frame
    // that was already on disk before the caller asked.
    const window = Math.max(0, Number(age) || 0);
    if (window > 0 && last && now() - last.atMs <= window) {
      stats.hits += 1;
      return last.frame;
    }
    // Two readers in the same tick want the same frame; one process answers both.
    if (inflight) return inflight;
    stats.captures += 1;
    inflight = Promise.resolve()
      .then(capture)
      .then((frame) => {
        last = { frame, atMs: now() };
        return frame;
      })
      .catch((err) => {
        stats.errors += 1;
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
  return {
    read,
    invalidate() {
      last = null;
    },
    stats: () => ({ ...stats, hitRate: stats.reads ? Math.round((stats.hits / stats.reads) * 100) : null }),
  };
}

/**
 * Wait for the screen to stop changing, then say so. `settleMs` is how long two
 * samples are apart; `timeoutMs` is the hard stop, because an animation that
 * never ends must not become a hung step.
 */
export async function waitUntilStill({
  capture,
  // A frame the caller already holds (the step audit's baseline) is the first
  // sample: one fewer capture, and the wait starts from the moment the run saw.
  seed = null,
  settleMs = 200,
  timeoutMs = 1500,
  stillPct = STILL_PCT,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  if (typeof capture !== 'function') throw new Error('waitUntilStill needs a capture function');
  const startedAt = now();
  let previous = seed || (await capture());
  let samples = seed ? 0 : 1;
  let changedPct = null;
  while (now() - startedAt < timeoutMs) {
    await sleep(settleMs);
    const next = await capture();
    samples += 1;
    const delta = diffSignatures(previous, next);
    changedPct = delta.changedPct;
    if (delta.changedPct <= stillPct) {
      return { still: true, waitedMs: now() - startedAt, samples, changedPct: delta.changedPct };
    }
    previous = next;
  }
  return { still: false, waitedMs: now() - startedAt, samples, changedPct };
}

/**
 * A stillness tracker across steps: how long the screen has been quiet, and the
 * frame it was quiet at. Used to tell "the app is idle" from "the app is
 * animating" without keeping more than one signature.
 */
export function createStillnessTracker({ stillPct = STILL_PCT } = {}) {
  let previous = null;
  let quietSince = null;
  return {
    observe(signature, atMs = Date.now()) {
      if (!signature) return { still: null, quietMs: null };
      if (!previous) {
        previous = signature;
        quietSince = atMs;
        return { still: null, quietMs: 0 };
      }
      const delta = diffSignatures(previous, signature);
      previous = signature;
      if (delta.changedPct > stillPct) {
        quietSince = atMs;
        return { still: false, quietMs: 0, changedPct: delta.changedPct };
      }
      return { still: true, quietMs: quietSince ? atMs - quietSince : 0, changedPct: delta.changedPct };
    },
    reset() {
      previous = null;
      quietSince = null;
    },
  };
}
