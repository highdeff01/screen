/**
 * The labelling agent: the stream's frames, read and named for the main AI.
 *
 * The engine on its own only knows that pixels moved. That is enough to skip
 * frames but not enough to act: a planner still has to be told that the thing
 * which appeared is a Save button at the top right, that the dialog below it
 * says the export finished, and that the next move is to close it. This module
 * is that reader. It takes each changed frame, sends the picture and the recent
 * timeline to the model once, and hands back:
 *
 *   labels   short names with normalized boxes, pinned onto the frame through
 *            the engine's own tracking, so the same button keeps one identity
 *            while it moves and its disappearance is a fact.
 *   summary  what the screen shows now, in one line.
 *   next     the single action the goal implies, for the planner to accept.
 *
 * It is deliberately cheap and bounded: one frame in flight, a minimum gap
 * between model calls, no call for a frame already read, and a trailing call
 * for the newest frame when the gap expires instead of a queue of stale ones.
 * A failed call is recorded and retried only on a later frame — never in a loop
 * against an endpoint that is already saying no. Nothing here throws into the
 * capture loop: a review that cannot happen is a line of state, not a stopped
 * stream.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA, logActivity } from './store.js';
import { chat, parseJsonLoose } from './llm.js';
import { vision } from './vision-engine.js';
import { reviewerFindings, setFindingsSource } from './vision-findings.js';

export const MAX_LABELS = 24;
export const REVIEW_GAP_MS = 2000;
export const REVIEW_KEEP = 20;
export const REVIEW_TIMEOUT_MS = 60000;

const clamp01 = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
};
const textOf = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Normalize whatever the model called a label into the engine's label shape. */
export function cleanLabels(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = textOf(item?.text ?? item?.label ?? item?.name);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text,
      kind: ['label', 'pin', 'box', 'arrow'].includes(item?.kind) ? item.kind : 'box',
      x: clamp01(item?.x),
      y: clamp01(item?.y),
      w: clamp01(item?.w),
      h: clamp01(item?.h),
    });
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

/** The two messages one review sends: the rules, then this frame and its past. */
export function reviewPrompt({ goal = '', digest = '', frame = {} } = {}) {
  const system = [
    'You are the vision agent inside Sightline, a Windows desktop-automation console.',
    'You are shown one screenshot of the desktop. Name the controls and content that matter to the goal, so another agent can act on them without seeing the picture.',
    'Coordinates are normalized to the screenshot: x and y are the top-left corner, w and h the size, all between 0 and 1.',
    'Reply with JSON only, exactly this shape:',
    '{"labels":[{"text":"Save","kind":"box","x":0.71,"y":0.08,"w":0.06,"h":0.04}],"summary":"one sentence on what the screen shows now","next":"the single next action the goal implies, or an empty string"}',
    'Labels must be short, unique, and only for things actually visible. Do not invent controls. At most 12 labels.',
  ].join(' ');
  const moved = Array.isArray(frame.dirtySections) ? frame.dirtySections.length : 0;
  const lines = [
    goal ? `Goal: ${goal}` : 'Goal: none set — describe what is on screen.',
    `Frame #${frame.seq ?? '?'}${frame.changedPct === null || frame.changedPct === undefined ? '' : `, ${frame.changedPct}% of the screen changed`}${moved ? `, ${moved} section(s) moved` : ''}.`,
  ];
  if (digest) lines.push('', 'Recent timeline:', String(digest).slice(0, 4000));
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * One reviewer. `ask` is `chat` in production and a stub in tests, `log` is the
 * activity feed, and the clock is injectable so the gap can be tested without
 * waiting for it.
 */
export function createVisionReviewer({
  engine = vision,
  dataDir = DATA,
  ask = chat,
  log = logActivity,
  model = null,
  minGapMs = REVIEW_GAP_MS,
  timeoutMs = REVIEW_TIMEOUT_MS,
  keep = REVIEW_KEEP,
  clock = () => Date.now(),
} = {}) {
  let enabled = false;
  let inFlight = false;
  let timer = null;
  let unsubscribe = null;
  let lastReviewedSeq = 0;
  let lastCallAt = 0;
  let lastReview = null;
  const history = [];
  const stats = { calls: 0, labels: 0, errors: 0, deferred: 0, lastError: '', lastMs: null, lastAt: null };

  function liveState() {
    try {
      return engine.state() || {};
    } catch {
      return {};
    }
  }

  /** A changed frame arrived. Review it now, or defer to the end of the gap. */
  function consider(frame) {
    if (!enabled || !frame?.file) return;
    if (frame.seq <= lastReviewedSeq) return;
    const wait = minGapMs - (clock() - lastCallAt);
    if (wait > 0) {
      stats.deferred += 1;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (!enabled) return;
          const newest = liveState().current;
          if (newest?.file && newest.seq > lastReviewedSeq) consider(newest);
        }, wait);
        timer?.unref?.();
      }
      return;
    }
    void review(frame);
  }

  async function review(frame) {
    if (!enabled || inFlight || !frame?.file) return null;
    inFlight = true;
    // Claim the frame even if the call fails: a frame the model could not read
    // is not retried in a tight loop, and the next changed frame gets the call.
    lastReviewedSeq = frame.seq;
    const started = clock();
    try {
      const absolute = path.resolve(dataDir, String(frame.file));
      const bytes = fs.readFileSync(absolute);
      if (!bytes.length) throw new Error('the frame file is empty');
      const live = liveState();
      const messages = reviewPrompt({
        goal: live.goal?.text || '',
        digest: typeof engine.digest === 'function' ? engine.digest({ count: 30 }) : '',
        frame,
      });
      const reply = await ask(messages, {
        images: [bytes.toString('base64')],
        kind: 'vision-review',
        timeoutMs,
        temperature: 0.1,
        format: 'json',
        ...(model ? { model } : {}),
      });
      if (!reply?.ok) throw new Error(reply?.error || 'the model did not answer');
      const parsed = parseJsonLoose(reply.content);
      const labels = cleanLabels(parsed?.labels ?? parsed?.elements ?? []);
      let tracked = false;
      if (labels.length) {
        try {
          engine.labelFrame(frame.seq, labels);
          tracked = true;
        } catch (err) {
          // The frame may have aged out of the ring while the model answered;
          // the summary is still worth keeping, so this is not the call failing.
          stats.lastError = `labels were not tracked: ${String(err?.message || err).slice(0, 200)}`;
        }
      }
      lastReview = {
        seq: frame.seq,
        at: new Date(clock()).toISOString(),
        summary: textOf(parsed?.summary).slice(0, 400) || `Frame ${frame.seq} read.`,
        next: textOf(parsed?.next ?? parsed?.nextStep).slice(0, 300),
        labels: labels.map((label) => label.text),
        tracked,
        ms: Number(reply.ms) || clock() - started,
      };
      stats.calls += 1;
      stats.labels += labels.length;
      stats.lastMs = lastReview.ms;
      stats.lastAt = lastReview.at;
      lastCallAt = clock();
      history.unshift(lastReview);
      history.length = Math.min(history.length, keep);
      try {
        log('vision', `Reviewed frame ${frame.seq}: ${labels.length} label(s)${lastReview.next ? `, next: ${lastReview.next}` : ''}`);
      } catch {
        // An activity log that cannot be written must not undo a review.
      }
      return lastReview;
    } catch (err) {
      stats.errors += 1;
      stats.lastError = String(err?.message || err).slice(0, 300);
      // A failed call is still a call: the gap applies, so a dead endpoint is
      // asked once per gap instead of once per frame.
      lastCallAt = clock();
      return null;
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!enabled) {
      enabled = true;
      if (unsubscribe === null && typeof engine.onFrame === 'function') unsubscribe = engine.onFrame(consider);
    }
    // A frame already on screen deserves a name too, rather than waiting for
    // the next change.
    const current = liveState().current;
    if (current?.file && current.seq > lastReviewedSeq) consider(current);
    return state();
  }

  function stop() {
    enabled = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return state();
  }

  /** Read the newest frame on demand, ignoring the gap and the seen marker. */
  async function reviewNow() {
    const current = liveState().current;
    if (!current?.file) throw new Error('There is no frame to review yet — start the vision engine first.');
    if (inFlight) throw new Error('A review is already running.');
    lastReviewedSeq = Math.min(lastReviewedSeq, current.seq - 1);
    lastCallAt = 0;
    const wasEnabled = enabled;
    enabled = true;
    try {
      const entry = await review(current);
      if (!entry) throw new Error(stats.lastError || 'The review did not produce a result.');
      return entry;
    } finally {
      if (!wasEnabled) {
        enabled = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
      }
    }
  }

  /**
   * What this reviewer has named right now, ready for a prompt: its last
   * reading plus the elements the engine still tracks. A reading belongs to the
   * reviewer, never to the engine, so a planner asks here instead of reaching
   * for a summary the engine does not keep.
   */
  function findings(options = {}) {
    let elements = [];
    try {
      elements = liveState().elements || [];
    } catch {
      elements = [];
    }
    return reviewerFindings({ review: lastReview, elements, ...options });
  }

  function state() {
    return {
      enabled,
      busy: inFlight,
      minGapMs,
      model: model || null,
      calls: stats.calls,
      labels: stats.labels,
      errors: stats.errors,
      deferred: stats.deferred,
      lastError: stats.lastError,
      lastMs: stats.lastMs,
      lastAt: stats.lastAt,
      lastReview,
      history: history.slice(0, 5),
    };
  }

  return { start, stop, state, reviewNow, consider, findings };
}

export const visionReview = createVisionReviewer();

/**
 * The main reviewer's current findings, for a prompt that is about to name
 * controls: the labels it pinned, where they are, and what it summarised.
 * `null` when nothing has been read yet, so a prompt never claims a reading it
 * does not have.
 */
export function lastFindings(options = {}) {
  return visionReview.findings(options);
}

// A planner or a replan asks for the reading through the pure module, so their
// prompts can quote it without loading this engine (and its frame directory).
setFindingsSource((options) => visionReview.findings(options));
