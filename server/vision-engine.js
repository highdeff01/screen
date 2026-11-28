/**
 * The vision engine: the screen as a stream, not a photograph per step.
 *
 * A run only opens its eyes at step boundaries, which is why the console has
 * always been a second behind the thing it is driving: a menu that opened, a
 * dialog that stole focus, a spinner that finally cleared — all of it happened
 * between two steps and none of it was seen. Live preview improves that but
 * writes every frame to disk and tops out at one per second.
 *
 * This engine runs faster and pays only for change:
 *
 *   frames        several captures a second, each compared by a reference hash
 *                 of the PNG bytes. An unchanged desktop costs a hash and
 *                 nothing else: no decode, no copy, no frame in the history.
 *   sections      a changed frame is decoded and split into a grid, and only the
 *                 sections whose own signature moved are reported, so a caller
 *                 can look at the fourth of the screen that changed instead of
 *                 all of it.
 *   elements      labels pinned onto a frame (by the review agent or a
 *                 detector) are tracked across frames with stable ids, so the
 *                 same button keeps its name while it moves, and its
 *                 disappearance is a fact the plan can act on.
 *   digest        the last hundred frames read back as one timeline: what
 *                 appeared, what left, what is on screen now — the material an
 *                 agent needs to say what it did, is doing and should do next.
 *
 * It also carries the two triggers a live loop needs: stop when the goal is
 * marked reached, or when a caller's own condition says the screen is finished.
 *
 * Everything is injectable — capture, clock, scheduler, frame store — so the
 * tests drive a real engine over synthetic frames with no desktop and no sleep.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './store.js';
import { decodePng, cellSignature } from './png.js';
import { diffSignatures, signatureHash } from './visual.js';
import { createCaptureStream, RAW_DIR } from './vision-capture.js';

export const MIN_FPS = 1;
export const MAX_FPS = 10;
export const DEFAULT_FPS = 4;
/** The review window: the last hundred frames, as the operator asked for. */
export const FRAME_KEEP = 100;
export const FRAME_DIR = 'vision';
export const SECTION_COLS = 4;
export const SECTION_ROWS = 3;
/** A section changed when its own signature moved by more than this. */
export const DIRTY_PCT = 1;
/**
 * How much of the screen must move before a frame is worth keeping. This is the
 * same rule the run loop already uses to call a screen settled: a blinking caret
 * or one antialiased edge is not a new frame, and storing it would fill the
 * hundred-frame history with pictures of the same moment.
 */
export const MIN_CHANGE_PCT = 1;
/** Stop rather than spin when the desktop cannot be read at all. */
export const CAPTURE_FAILURES = 3;
/** How many frames an element may go unlabelled before it counts as gone. */
export const ELEMENT_MISSES = 3;
/** Two labels with the same text this close together are the same element. */
export const MATCH_RADIUS = 0.15;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const centre = (box) => ({ x: (Number(box.x) || 0) + (Number(box.w) || 0) / 2, y: (Number(box.y) || 0) + (Number(box.h) || 0) / 2 });

/** A cheap reference hash over the whole file: identical bytes, identical screen. */
export function referenceHash(buffer) {
  let hash = 2166136261;
  for (let index = 0; index < buffer.length; index++) {
    hash ^= buffer[index];
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The grid a frame is split into, in normalized coordinates. */
export function sectionsOf(cols = SECTION_COLS, rows = SECTION_ROWS) {
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out.push({ index: out.length, col, row, x: col / cols, y: row / rows, w: 1 / cols, h: 1 / rows });
    }
  }
  return out;
}

/**
 * Match one frame's labels onto the tracked elements: same text and near the
 * old position is the same element, anything else is a new one. Returns the
 * updated elements and what changed.
 */
export function trackLabels(tracked, labels, seq) {
  const elements = tracked.map((element) => ({ ...element }));
  const added = [];
  const moved = [];
  for (const label of labels) {
    const text = String(label.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) continue;
    const box = { x: clamp01(label.x), y: clamp01(label.y), w: clamp01(label.w), h: clamp01(label.h) };
    const at = centre(box);
    let best = null;
    let bestDistance = Infinity;
    for (const element of elements) {
      if (element.label.toLowerCase() !== text.toLowerCase()) continue;
      const distance = Math.hypot(centre(element).x - at.x, centre(element).y - at.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
    }
    if (best && bestDistance <= MATCH_RADIUS) {
      if (Math.abs(centre(best).x - at.x) > 0.01 || Math.abs(centre(best).y - at.y) > 0.01) {
        moved.push({ id: best.id, label: best.label, from: { x: centre(best).x, y: centre(best).y }, to: at });
      }
      Object.assign(best, box, { kind: label.kind || best.kind || 'label', lastSeq: seq, seen: best.seen + 1 });
      continue;
    }
    const element = {
      id: `el-${seq}-${elements.length + 1}`,
      label: text,
      kind: label.kind || 'label',
      ...box,
      firstSeq: seq,
      lastSeq: seq,
      seen: 1,
    };
    elements.push(element);
    added.push(element);
  }
  return { elements, added, moved };
}

/** Drop elements that have not been labelled for a few frames. */
export function pruneElements(elements, seq, misses = ELEMENT_MISSES) {
  const kept = [];
  const vanished = [];
  for (const element of elements) {
    if (seq - element.lastSeq > misses) vanished.push(element);
    else kept.push(element);
  }
  return { kept, vanished };
}

/**
 * One engine. `capture` returns `{ path }` relative to `dataDir` (the shape
 * `liveScreenshot` already gives), `schedule`/`cancel` are the timer pair, and
 * `now` is the clock, so a test can run the whole loop with no desktop.
 */
export function createVisionEngine({
  dataDir = DATA,
  capture = null,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = () => Date.now(),
  keep = FRAME_KEEP,
  cols = SECTION_COLS,
  rows = SECTION_ROWS,
} = {}) {
  if (capture !== null && typeof capture !== 'function') throw new Error('capture must be a function');
  // Without a capture of its own the engine keeps one warm worker, because a
  // fresh process per frame costs more than everything else it does combined.
  let stream = null;
  const captureFrame = capture || (() => {
    if (!stream) stream = createCaptureStream({ dataDir });
    return stream.next();
  });
  const frameDir = path.join(dataDir, FRAME_DIR);
  const sections = sectionsOf(cols, rows);
  let running = false;
  let fps = DEFAULT_FPS;
  let timer = null;
  let inFlight = false;
  let seq = 0;
  let previous = null;
  let previousSections = null;
  let lastHash = null;
  let frames = [];
  let tracked = [];
  let stopReason = null;
  let goal = { text: '', setAt: null, reachedAt: null, reason: '' };
  let until = null;
  let minChangedPct = MIN_CHANGE_PCT;
  let consecutiveErrors = 0;
  let startedAt = null;
  let lastFrameAt = null;
  // Frame listeners are how the labelling agent hears about a changed frame
  // without the loop waiting for it: a model call is slower than the stream.
  const listeners = new Set();
  const stats = { captures: 0, skipped: 0, quiet: 0, changed: 0, undecodable: 0, errors: 0, lastError: '' };

  function resetFrames() {
    fs.rmSync(frameDir, { recursive: true, force: true });
    fs.mkdirSync(frameDir, { recursive: true });
    // A crashed run can leave raw captures behind; they are this engine's own
    // temporary files, so a fresh start never inherits them.
    fs.rmSync(path.join(dataDir, RAW_DIR), { recursive: true, force: true });
    frames = [];
    tracked = [];
    previous = null;
    previousSections = null;
    lastHash = null;
    seq = 0;
  }
  resetFrames();

  /** Tell every listener about a stored frame. Their failures are theirs. */
  function notifyFrame(record) {
    for (const listener of listeners) {
      try {
        const outcome = listener(record);
        if (outcome && typeof outcome.catch === 'function') {
          outcome.catch((err) => {
            stats.lastError = `a frame listener failed: ${String(err?.message || err).slice(0, 200)}`;
          });
        }
      } catch (err) {
        stats.lastError = `a frame listener failed: ${String(err?.message || err).slice(0, 200)}`;
      }
    }
  }

  function trim() {
    while (frames.length > keep) {
      const dropped = frames[frames.length - 1];
      try {
        fs.rmSync(path.join(dataDir, dropped.file), { force: true });
      } catch {
        // A frame already gone is not a problem; the history is what matters.
      }
      frames.pop();
    }
  }

  /**
   * Capture one frame and judge it. Public because a caller may want a single
   * look now, and because it is what the loop calls: the tests drive it directly.
   */
  async function step() {
    if (inFlight) return { skipped: true, busy: true };
    inFlight = true;
    stats.captures += 1;
    try {
      const shot = await captureFrame();
      const file = String(shot?.path || '');
      if (!file) throw new Error('the capture did not name a file');
      const absolute = path.resolve(dataDir, file);
      let bytes;
      try {
        bytes = fs.readFileSync(absolute);
      } finally {
        // The engine keeps its own ring of frames; the capture that produced
        // this one is a temporary no run will ever reference.
        try { fs.rmSync(absolute, { force: true }); } catch { /* a run may still hold it */ }
      }
      if (!bytes.length) throw new Error('the capture was empty');

      const hash = referenceHash(bytes);
      if (hash === lastHash) {
        stats.skipped += 1;
        return { skipped: true, identical: true, at: now() };
      }

      seq += 1;
      const at = new Date(now()).toISOString();
      const decoded = decodePng(bytes);
      let global = null;
      let dirtySections = [];
      let changedPct = 100;
      if (decoded) {
        global = cellSignature(decoded, { cols: 32, rows: 18 });
        const own = sections.map((section) => cellSignature(decoded, {
          cols: 8,
          rows: 6,
          left: Math.floor(section.x * decoded.width),
          top: Math.floor(section.y * decoded.height),
          width: Math.max(1, Math.floor(section.w * decoded.width)),
          height: Math.max(1, Math.floor(section.h * decoded.height)),
        }));
        if (previous) {
          const delta = diffSignatures(previous, global);
          changedPct = delta.changedPct;
        }
        if (previousSections) {
          dirtySections = own
            .map((signature, index) => ({ index, col: sections[index].col, row: sections[index].row, changedPct: diffSignatures(previousSections[index], signature).changedPct }))
            .filter((section) => section.changedPct > DIRTY_PCT);
        }
        previous = global;
        previousSections = own;
      } else {
        // A frame that cannot be decoded is still a real frame; it is recorded
        // as uncomparable rather than reported as unchanged.
        stats.undecodable += 1;
        changedPct = null;
        previousSections = null;
        previous = null;
      }

      const quiet = changedPct !== null && changedPct < minChangedPct;
      if (quiet) {
        // A frame the caller asked to ignore is a skipped frame in every way
        // that matters, but it still advanced the reference. Nothing is written:
        // the point of the threshold is to not pay for frames that do not count.
        stats.quiet += 1;
        lastHash = hash;
        lastFrameAt = now();
        return { skipped: true, quiet: true, changedPct, at };
      }

      const name = `frame-${String(seq).padStart(6, '0')}.png`;
      fs.writeFileSync(path.join(frameDir, name), bytes);
      const pruned = pruneElements(tracked, seq);
      tracked = pruned.kept;
      const record = {
        seq,
        at,
        file: `${FRAME_DIR}/${name}`,
        hash,
        signatureHash: global ? signatureHash(global) : null,
        changedPct,
        dirtySections,
        labels: [],
        elements: tracked.map((element) => ({ id: element.id, label: element.label, kind: element.kind, x: element.x, y: element.y, w: element.w, h: element.h, seen: element.seen })),
        vanished: pruned.vanished.map((element) => ({ id: element.id, label: element.label })),
        width: decoded?.width || null,
        height: decoded?.height || null,
      };
      frames.unshift(record);
      lastHash = hash;
      lastFrameAt = now();
      stats.changed += 1;
      trim();
      notifyFrame(record);

      if (goal.reachedAt === null && typeof until === 'function') {
        let verdict = false;
        try {
          verdict = Boolean(until(record, state()));
        } catch (err) {
          stats.lastError = `the stop condition failed: ${String(err?.message || err).slice(0, 200)}`;
        }
        if (verdict) markGoalReached('the stop condition was met');
      }
      return record;
    } catch (err) {
      stats.errors += 1;
      stats.lastError = String(err?.message || err).slice(0, 300);
      if (err?.unreadable) throw err;
      return { skipped: true, error: stats.lastError };
    } finally {
      inFlight = false;
    }
  }

  function queue(delay) {
    if (!running) return;
    timer = schedule(() => {
      timer = null;
      const tickAt = now();
      void (async () => {
        // A rejected capture must never escape: an unhandled rejection ends the
        // console, and a loop that fails three times in a row is a desktop that
        // cannot be read, which is a stop with a reason rather than a retry.
        let failed = false;
        try {
          const outcome = await step();
          failed = Boolean(outcome?.error);
        } catch (err) {
          failed = true;
          stats.errors += 1;
          stats.lastError = String(err?.message || err).slice(0, 300);
        }
        consecutiveErrors = failed ? consecutiveErrors + 1 : 0;
        if (running && consecutiveErrors >= CAPTURE_FAILURES) {
          stop(`the desktop could not be captured ${CAPTURE_FAILURES} times in a row — ${stats.lastError || 'no reason given'}`);
          return;
        }
        // The wait is the remainder of this frame's budget, not a full interval
        // added after it: otherwise every capture is paid twice and a 6 fps
        // stream drifts to 2.
        if (running) queue(Math.max(0, intervalMs() - (now() - tickAt)));
      })();
    }, delay);
    timer?.unref?.();
  }

  function intervalMs() {
    return Math.round(1000 / Math.max(MIN_FPS, Math.min(MAX_FPS, fps)));
  }

  function start(options = {}) {
    if (options.fps !== undefined) {
      const value = Number(options.fps);
      if (!Number.isFinite(value)) throw new TypeError('fps must be a finite number');
      fps = Math.round(Math.max(MIN_FPS, Math.min(MAX_FPS, value)) * 10) / 10;
    }
    if (options.goal !== undefined) {
      goal = { text: String(options.goal || '').slice(0, 500), setAt: new Date(now()).toISOString(), reachedAt: null, reason: '' };
    }
    if (options.until !== undefined) until = typeof options.until === 'function' ? options.until : null;
    minChangedPct = options.minChangedPct === undefined
      ? MIN_CHANGE_PCT
      : Math.max(0, Math.min(100, Number(options.minChangedPct) || 0));
    if (running) return state();
    resetFrames();
    // A new observation run has not reached the goal yet, whatever the last one
    // did: the trigger belongs to the run, not to the text.
    goal = { ...goal, reachedAt: null, reason: '' };
    // A run's counters describe that run; a second start must not inherit them.
    for (const key of Object.keys(stats)) stats[key] = typeof stats[key] === 'number' ? 0 : '';
    running = true;
    stopReason = null;
    startedAt = now();
    queue(0);
    return state();
  }

  function stop(reason = null) {
    running = false;
    stopReason = reason;
    if (timer !== null) cancel(timer);
    timer = null;
    // The worker exists only to feed this stream; a stopped stream leaves no
    // PowerShell host behind.
    if (stream) {
      stream.stop();
      stream = null;
    }
    return state();
  }

  function markGoalReached(reason = 'the goal was marked reached') {
    if (goal.reachedAt) return goal;
    goal = { ...goal, reachedAt: new Date(now()).toISOString(), reason: String(reason).slice(0, 300) };
    if (running) stop(`goal reached — ${goal.reason}`);
    return goal;
  }

  function setGoal(text) {
    goal = { text: String(text || '').slice(0, 500), setAt: new Date(now()).toISOString(), reachedAt: null, reason: '' };
    return goal;
  }

  /**
   * Pin labels onto a frame. The review agent's output lands here: text plus a
   * normalized box, matched onto the tracked element so the same control keeps
   * one identity across frames.
   */
  function labelFrame(target, labels = []) {
    const wanted = Number(target);
    const frame = Number.isFinite(wanted)
      ? frames.find((entry) => entry.seq === wanted)
      : frames[0];
    if (!frame) throw new Error('There is no frame to label yet.');
    const clean = (Array.isArray(labels) ? labels : []).slice(0, 40).map((label) => ({
      text: String(label?.text || label?.label || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      kind: ['label', 'pin', 'box', 'arrow'].includes(label?.kind) ? label.kind : 'box',
      x: clamp01(label?.x),
      y: clamp01(label?.y),
      w: clamp01(label?.w),
      h: clamp01(label?.h),
    })).filter((label) => label.text);
    if (!clean.length) throw new Error('A label needs text.');

    const result = trackLabels(tracked, clean, frame.seq);
    tracked = result.elements;
    for (const label of clean) {
      if (!frame.labels.some((entry) => entry.text.toLowerCase() === label.text.toLowerCase())) frame.labels.push(label);
    }
    frame.elements = tracked
      .filter((element) => element.lastSeq === frame.seq)
      .map((element) => ({ id: element.id, label: element.label, kind: element.kind, x: element.x, y: element.y, w: element.w, h: element.h, seen: element.seen }));
    return { frame: frame.seq, added: result.added, moved: result.moved, tracked: tracked.length };
  }

  /** The last N frames as one timeline for a review agent to read. */
  function digest(options = {}) {
    const count = Math.max(1, Math.min(keep, Number(options.count) || 30));
    const slice = frames.slice(0, count);
    if (!slice.length) {
      return `Vision engine: no changed frames yet${goal.text ? ` (goal: ${goal.text})` : ''}.`;
    }
    const lines = [];
    lines.push(`Vision engine — ${frames.length} frame(s) in the last ${keep}, ${stats.skipped} unchanged capture(s) skipped, ${state().measuredFps ?? '—'} fps measured.`);
    if (goal.text) {
      lines.push(`Goal: ${goal.text}${goal.reachedAt ? ` — marked reached (${goal.reason})` : ' — not reached yet'}`);
    }
    const newestFirst = slice.map((frame, index) => {
      const ago = index === 0 ? 'now' : `−${index} frame(s)`;
      const parts = [`#${frame.seq} ${ago}`, `change ${frame.changedPct === null ? 'unreadable' : `${frame.changedPct}%`}`];
      if (frame.dirtySections.length) {
        parts.push(`sections ${frame.dirtySections.map((section) => `${section.col},${section.row}`).join(' ')}`);
      }
      if (frame.labels.length) parts.push(`labels: ${frame.labels.map((label) => `“${label.text}”`).join(', ')}`);
      if (frame.vanished.length) parts.push(`gone: ${frame.vanished.map((element) => `“${element.label}”`).join(', ')}`);
      return parts.join(' · ');
    });
    lines.push(...newestFirst);
    const live = tracked.filter((element) => element.lastSeq === frames[0]?.seq);
    if (live.length) lines.push(`On screen now: ${live.map((element) => `“${element.label}”@(${element.x.toFixed(2)},${element.y.toFixed(2)})`).join(', ')}`);
    return lines.join('\n');
  }

  function state() {
    return {
      running,
      fps,
      intervalMs: intervalMs(),
      goal,
      frameCount: frames.length,
      keep,
      sections: sections.length,
      // Read live: how often the screen was read, not how often the reading was
      // worth keeping. A still desktop is still a frame rate.
      measuredFps: startedAt ? Math.round((stats.captures / Math.max(0.5, (now() - startedAt) / 1000)) * 10) / 10 : null,
      stopReason,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
      stats: { ...stats, skipRate: stats.captures ? Math.round((stats.skipped / stats.captures) * 100) : null },
      current: frames[0] || null,
      frames: frames.slice(0, 12).map((frame) => ({
        seq: frame.seq,
        at: frame.at,
        file: frame.file,
        changedPct: frame.changedPct,
        dirtySections: frame.dirtySections.length,
        labels: frame.labels.map((label) => label.text),
        elements: frame.elements.length,
      })),
      elements: tracked.map((element) => ({ id: element.id, label: element.label, x: element.x, y: element.y, w: element.w, h: element.h, seen: element.seen, lastSeq: element.lastSeq })),
    };
  }

  /** Subscribe to changed frames. Returns the unsubscribe function. */
  function onFrame(listener) {
    if (typeof listener !== 'function') throw new TypeError('a frame listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { step, start, stop, state, digest, labelFrame, markGoalReached, setGoal, intervalMs, onFrame };
}

export const vision = createVisionEngine();
