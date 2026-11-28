/**
 * What the vision reviewer already named, in the shape a prompt can use.
 *
 * The reviewer looks at frames and answers with labels — short names with
 * normalized boxes — plus a one-line summary and the action it thinks comes
 * next. Every other prompt in the console (the plan, the between-step reading,
 * a replan) used to know only pixels and window titles, so a plan could name a
 * control it guessed at a coordinate, or invent a label that is not on screen.
 * These helpers turn the reviewer's reading into prompt text: the exact labels
 * it found, where they are, what it said, and what it suggested — so a step can
 * name a control the console has already seen.
 *
 * Pure on purpose: no engine, no model, no clock of its own, so a test can age a
 * reading without waiting and a prompt can be built without a desktop. A reading
 * that is too old to describe the current screen is dropped rather than quoted
 * as if it were live.
 */

export const FINDINGS_MAX_LABELS = 12;
/** Older than this and a reading describes a screen the run has already left. */
export const FINDINGS_MAX_AGE_MS = 150000;

const clean = (value, limit) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
const clamp01 = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
};
const fixed = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '?');

/**
 * The reviewer's last reading plus the elements the engine still tracks, in one
 * object: `{ seq, at, ageMs, summary, next, labels: [{ text, at, seen }] }`.
 *
 * Tracked elements are preferred over the reading's own label names because the
 * engine keeps them current — a button that moved is still the same button, at
 * its new position — while the reading is a snapshot from the frame it read.
 */
export function reviewerFindings({
  review = null,
  elements = [],
  nowMs = Date.now(),
  maxAgeMs = FINDINGS_MAX_AGE_MS,
  maxLabels = FINDINGS_MAX_LABELS,
} = {}) {
  const summary = clean(review?.summary, 400);
  const next = clean(review?.next, 300);
  const labels = [];
  const seen = new Set();
  for (const element of Array.isArray(elements) ? elements : []) {
    const text = clean(element?.label ?? element?.text, 80);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const x = clamp01(element.x);
    const y = clamp01(element.y);
    const w = clamp01(element.w);
    const h = clamp01(element.h);
    labels.push({
      text,
      x,
      y,
      w,
      h,
      // Rounded so a prompt does not show 0.12000000000000001 for a centre.
      at: { x: Math.round((x + w / 2) * 10000) / 10000, y: Math.round((y + h / 2) * 10000) / 10000 },
      seen: Math.max(1, Number(element.seen) || 1),
    });
    if (labels.length >= Math.max(1, Number(maxLabels) || FINDINGS_MAX_LABELS)) break;
  }
  if (!labels.length && !summary) return null;
  const at = typeof review?.at === 'string' && review.at ? review.at : null;
  const readAt = at ? Date.parse(at) : Number.NaN;
  const ageMs = Number.isFinite(readAt) ? Math.max(0, Number(nowMs) - readAt) : null;
  if (ageMs !== null && ageMs > Math.max(0, Number(maxAgeMs) || 0)) return null;
  const seq = Number(review?.seq);
  return {
    seq: Number.isFinite(seq) && seq > 0 ? Math.round(seq) : null,
    at,
    ageMs,
    summary,
    next,
    labels,
  };
}

let source = null;

/**
 * Where `currentFindings` asks for the live reading. The reviewer registers
 * itself, so a plan or a replan can include what the console has named without
 * importing the vision engine — that module clears its frame directory when it
 * loads, which is the last side effect a planner should carry.
 */
export function setFindingsSource(provider) {
  source = typeof provider === 'function' ? provider : null;
}

/** The live findings, or null when nothing has been read (or nothing loaded). */
export function currentFindings(options = {}) {
  if (!source) return null;
  try {
    return source(options) || null;
  } catch {
    return null;
  }
}

/**
 * The findings as a short paragraph a prompt can quote: which frame was read and
 * how long ago, the labels with their normalized centre, the summary, and the
 * reviewer's suggested next action. Empty when there is nothing to say.
 */
export function findingsBrief(
  findings,
  { max = FINDINGS_MAX_LABELS, lead = 'The vision reviewer already named these controls on screen' } = {}
) {
  if (!findings) return '';
  const labels = Array.isArray(findings.labels) ? findings.labels.slice(0, Math.max(1, Number(max) || 1)) : [];
  const summary = clean(findings.summary, 400);
  if (!labels.length && !summary) return '';
  const age = Number.isFinite(findings.ageMs) ? Math.round(findings.ageMs / 1000) : null;
  const when = [findings.seq ? `frame #${findings.seq}` : '', age === null ? '' : age < 1 ? 'read just now' : `read ${age} s ago`]
    .filter(Boolean)
    .join(', ');
  const parts = [
    labels.length
      ? `${lead}${when ? ` (${when})` : ''}: ${labels
          .map((label) => `“${label.text}” at (${fixed(label.at?.x)},${fixed(label.at?.y)}) seen ${Math.max(1, Number(label.seen) || 1)}×`)
          .join('; ')}.`
      : `The vision reviewer read the screen${when ? ` (${when})` : ''} but has not pinned a control yet.`,
  ];
  if (summary) parts.push(`It read the screen as: ${summary}`);
  if (clean(findings.next, 300)) parts.push(`Its suggested next action: ${clean(findings.next, 300)}`);
  return parts.join('\n');
}
