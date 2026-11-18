/**
 * Annotations — the drawing layer over live frames and captures.
 *
 * Marks say where something is; annotations say what it means. An AI review
 * (deep focus, sentinel, relay review) can pin its findings onto the exact
 * frame it was looking at — "the caret is here, the unsaved document is there"
 * — and the operator can draw on the same frame from the lightbox: pins,
 * labels, boxes and arrows, stored in normalized coordinates so they survive
 * different capture sizes.
 *
 * Annotations attach to a reference (a capture, a run, a deep-focus round) and
 * are read back by everything that shows that frame, so the pinpointing done
 * during back-thinking stays visible where the evidence lives.
 */
import { db, logActivity, now, persist, uid } from './store.js';

const LIMIT = 400;
const KINDS = new Set(['pin', 'label', 'box', 'arrow']);

function annotations() {
  const d = db();
  if (!Array.isArray(d.annotations)) d.annotations = [];
  return d.annotations;
}

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

/** A reference picks what frame the annotation lives on. */
function refKey(ref = {}) {
  const parts = [ref.captureId, ref.runId, ref.roundIndex, ref.surface].map((part) => (part === undefined || part === null ? '' : String(part)));
  const key = parts.join('|');
  if (!key.replace(/\|/g, '')) throw new Error('An annotation needs a reference: captureId, runId or surface.');
  return key;
}

export function addAnnotation({ ref = {}, kind = 'pin', x = 0.5, y = 0.5, w = 0, h = 0, points = null, text = '', color = '#e5484d', by = 'operator' } = {}) {
  const shape = KINDS.has(kind) ? kind : 'pin';
  const body = String(text || '').trim().slice(0, 300);
  if (shape === 'label' && !body) throw new Error('A label needs text.');
  if (shape === 'arrow' && !Array.isArray(points)) throw new Error('An arrow needs points.');
  const annotation = {
    id: uid('ann'),
    at: now(),
    ref: { captureId: ref.captureId || null, runId: ref.runId || null, roundIndex: ref.roundIndex ?? null, surface: ref.surface || null, refKey: refKey(ref) },
    kind: shape,
    x: clamp01(x),
    y: clamp01(y),
    w: clamp01(w),
    h: clamp01(h),
    points: Array.isArray(points) ? points.slice(0, 32).map(([px, py]) => [clamp01(px), clamp01(py)]) : null,
    text: body,
    color: String(color || '#e5484d').slice(0, 20),
    by: String(by || 'operator').slice(0, 60),
  };
  const list = annotations();
  list.push(annotation);
  if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
  persist();
  logActivity('annotations', `${annotation.by} annotated a frame (${shape})`, { annotationId: annotation.id, runId: ref.runId || null });
  return annotation;
}

export function listAnnotations(ref = {}) {
  const key = refKey(ref);
  return annotations()
    .filter((entry) => entry.ref.refKey === key)
    .slice(-100);
}

/** Annotations for a whole run: every round and capture under it. */
export function annotationsForRun(runId) {
  return annotations().filter((entry) => entry.ref.runId === runId).slice(-100);
}

export function removeAnnotation(id) {
  const list = annotations();
  const index = list.findIndex((entry) => entry.id === id);
  if (index === -1) throw new Error('Annotation not found');
  const [removed] = list.splice(index, 1);
  persist();
  return removed;
}

/**
 * AI pinpointing: turn structured findings (from a focus round, a review, a
 * test failure) into annotations on one frame, in one call.
 */
export function pinFindings(ref = {}, findings = [], { by = 'ai', color = '#7c5cff' } = {}) {
  const added = [];
  for (const finding of Array.isArray(findings) ? findings.slice(0, 12) : []) {
    try {
      added.push(addAnnotation({
        ref,
        kind: KINDS.has(finding.kind) ? finding.kind : 'pin',
        x: finding.x ?? 0.5,
        y: finding.y ?? 0.5,
        w: finding.w ?? 0,
        h: finding.h ?? 0,
        text: finding.text || '',
        color: finding.color || color,
        by,
      }));
    } catch { /* one bad finding never blocks the rest */ }
  }
  return added;
}

/** Validate before the client draws: keeps malformed overlays out of storage. */
export function normalizeClientAnnotation(body = {}) {
  return {
    ref: body.ref || {},
    kind: body.kind,
    x: body.x,
    y: body.y,
    w: body.w,
    h: body.h,
    points: body.points,
    text: body.text,
    color: body.color,
    by: body.by || 'operator',
  };
}
