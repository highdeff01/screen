/**
 * The live map: what is on screen now, and how it differs from a moment ago.
 *
 * A screenshot is a still of a moment that has already passed, and asking for
 * one costs a process and a wait. Watching needs the opposite: a cheap read that
 * can be repeated often, kept for a few seconds, and compared with the read
 * before it — so "did the window move", "how much changed" and "where is the
 * pointer" are answered from a short history instead of a fresh capture.
 *
 * Each sample is a signature (a small colour grid, not an image), the window
 * rect it belongs to, the pointer and the foreground app. Consecutive samples
 * are compared on arrival: movement between the two rects, the share of the
 * grid that changed, and the distance the pointer travelled. The ring keeps the
 * last `max` samples, so the panel can show current, previous and the trend
 * without any extra reading.
 *
 * The capture is injected, so the whole thing is testable with plain objects and
 * a fake clock; `captureDesktopFrame` is the real one, built from the reads the
 * console already makes.
 */
import { captureScreenSignature, readPresence, readWindowRect } from './automation.js';
import { diffSignatures, signatureHash } from './visual.js';
import { describeMotion, motionBetween } from './motion.js';

/** Samples kept: at 100 ms this is twelve seconds of recent screen. */
export const LIVE_MAP_MAX = 120;
/** Two reads closer together than this describe the same instant. */
export const LIVE_MAP_MIN_INTERVAL_MS = 100;

/**
 * What changed between two samples. Pure: the reader calls it on arrival, and a
 * test calls it with two hand-built frames.
 */
export function compareFrames(before, after) {
  if (!before || !after) return { motion: null, changedPct: null, pointer: null, note: 'nothing to compare' };
  const motion = motionBetween(before.window, after.window);
  const change =
    Array.isArray(before.signature?.cells) && Array.isArray(after.signature?.cells)
      ? diffSignatures(before.signature, after.signature)
      : null;
  const from = before.cursor;
  const to = after.cursor;
  const pointer =
    from && to && Number.isFinite(Number(from.x)) && Number.isFinite(Number(to.x))
      ? {
          dx: Math.round(Number(to.x) - Number(from.x)),
          dy: Math.round(Number(to.y) - Number(from.y)),
          distance: Math.round(Math.hypot(Number(to.x) - Number(from.x), Number(to.y) - Number(from.y)) * 10) / 10,
        }
      : null;
  return {
    motion,
    changedPct: change ? Math.round(change.changedPct * 10) / 10 : null,
    changedCells: change ? change.changedCells : null,
    pointer,
    note: describeMotion(motion),
  };
}

function frameShape(frame) {
  const signature = frame?.signature;
  const cells = Array.isArray(signature?.cells) ? signature.cells.length : 0;
  return {
    at: Number(frame?.at) || 0,
    window: frame?.window?.found === false ? null : frame?.window || null,
    foreground: frame?.foreground || null,
    cursor: frame?.cursor || null,
    signatureHash: cells ? signatureHash(signature) : '',
    cells,
    error: frame?.error || '',
  };
}

/**
 * A bounded history of screen samples.
 *
 * `sample()` never throws: a capture that fails is recorded as the sample's
 * error, because a reader that goes quiet must say so rather than look like a
 * still screen. Concurrent callers share the capture in flight, and a caller
 * asking again inside `minIntervalMs` gets the last sample back with
 * `reused: true` — the panel polls faster than the desktop should be read.
 */
export function createLiveMap({ capture, now = () => Date.now(), max = LIVE_MAP_MAX, minIntervalMs = LIVE_MAP_MIN_INTERVAL_MS } = {}) {
  if (typeof capture !== 'function') throw new Error('createLiveMap needs a capture function');
  const limit = Math.max(2, Math.floor(Number(max) || LIVE_MAP_MAX));
  const gap = Math.max(0, Number(minIntervalMs) || 0);
  const samples = [];
  const stats = { samples: 0, errors: 0, reused: 0 };
  let inflight = null;
  let lastAt = 0;
  // The previous grid is kept for comparison only: samples expose its hash, not
  // 576 cells per poll, but the change percentage needs the cells themselves.
  let lastSignature = null;

  function push(sample) {
    samples.push(sample);
    while (samples.length > limit) samples.shift();
    return sample;
  }

  async function take() {
    const at = now();
    let frame = null;
    let error = '';
    try {
      frame = await capture();
    } catch (err) {
      error = err?.message || 'the screen could not be read';
    }
    const shape = frameShape({ ...(frame || {}), at });
    const sample = { ...shape, at, error: error || shape.error };
    if (!sample.error) stats.samples++;
    else stats.errors++;
    const previous = samples[samples.length - 1] || null;
    const compared = compareFrames(
      previous ? { window: previous.window, cursor: previous.cursor, signature: lastSignature } : null,
      { window: sample.window, cursor: sample.cursor, signature: frame?.signature || null }
    );
    lastSignature = frame?.signature || null;
    sample.motion = compared.motion;
    sample.changedPct = compared.changedPct;
    sample.changedCells = compared.changedCells;
    sample.pointer = compared.pointer;
    sample.note = compared.note;
    lastAt = at;
    return push(sample);
  }

  function state() {
    const current = samples[samples.length - 1] || null;
    const previous = samples[samples.length - 2] || null;
    const trend = samples.slice(-12).map((sample) => ({
      at: sample.at,
      window: sample.window ? { left: sample.window.left, top: sample.window.top } : null,
      cursor: sample.cursor,
      changedPct: sample.changedPct,
      dx: sample.motion?.dx ?? null,
      dy: sample.motion?.dy ?? null,
      error: sample.error || '',
    }));
    return {
      at: now(),
      samples: samples.length,
      limit,
      minIntervalMs: gap,
      current,
      previous,
      motion: current?.motion || null,
      changedPct: current?.changedPct ?? null,
      pointer: current?.pointer || null,
      trend,
      stats: { ...stats },
      error: current?.error || '',
    };
  }

  return {
    async sample({ force = false } = {}) {
      if (!force && lastAt && now() - lastAt < gap && samples.length) {
        stats.reused++;
        return { ok: true, reused: true, sample: samples[samples.length - 1], map: state() };
      }
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const sample = await take();
          return { ok: !sample.error, reused: false, sample, map: state() };
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    state,
    reset() {
      samples.length = 0;
      lastSignature = null;
      lastAt = 0;
      return state();
    },
  };
}

/**
 * The real frame: one presence read (foreground, pointer, idle) and one
 * signature, plus the foreground window's rect. The rect read is skipped when
 * there is no foreground title to ask about, rather than asking for "".
 */
export async function captureDesktopFrame({ presence = readPresence, signature = captureScreenSignature, rectOf = readWindowRect } = {}) {
  const activity = await presence();
  const title = String(activity?.foreground?.title || '').trim();
  let window = null;
  if (title) {
    try {
      window = await rectOf(title);
    } catch {
      window = null;
    }
  }
  const shot = await signature();
  return {
    window,
    foreground: activity?.foreground || null,
    cursor: activity?.cursor || null,
    idleMs: activity?.idleMs ?? null,
    signature: shot,
  };
}

export const liveMap = createLiveMap({ capture: () => captureDesktopFrame() });
