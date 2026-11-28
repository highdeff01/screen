/**
 * Window-relative targeting.
 *
 * A workflow recorded on this desktop breaks the moment its window is dragged:
 * the same pair of screen coordinates now points at whatever moved into that
 * place. A pointer step can instead record where it sits *inside* its window —
 * `params.anchor: 'window'` makes `x`/`y` an offset from the window's top-left —
 * and the runner adds the window's current position to it just before acting, so
 * the step follows the window instead of the screen.
 *
 * Everything here is pure: a step and a rectangle in, points out. The rule can
 * then be tested without a desktop, and the executor and the aimer resolve a
 * step the same way.
 */

export const WINDOW_ANCHOR = 'window';

// Every pair of coordinates a pointer step can carry: a click's point, and the
// two ends of a drag.
const POINT_FIELDS = [
  ['x', 'y'],
  ['x1', 'y1'],
  ['x2', 'y2'],
];

/** Whether the step carries a point pair at all (a scroll's is optional). */
export function hasWindowPoint(params = {}) {
  return POINT_FIELDS.some(([xKey, yKey]) => params?.[xKey] != null && params?.[yKey] != null);
}

/** Whether this step's coordinates are offsets inside its window. */
export function isWindowRelative(params = {}) {
  return String(params?.anchor || '').trim().toLowerCase() === WINDOW_ANCHOR || params?.windowRelative === true;
}

/**
 * The window a relative step is measured in: the guard the step already names,
 * else nothing — which means the window in front when it runs.
 */
export function anchorWindowFor(params = {}) {
  return String(
    params?.window || (typeof params?.foreground === 'string' ? params.foreground : '') || params?.title || ''
  ).trim();
}

/** A rectangle fit to do arithmetic with, or null when it cannot be trusted. */
export function usableRect(rect) {
  if (!rect || rect.found === false) return null;
  const left = Math.round(Number(rect.left));
  const top = Math.round(Number(rect.top));
  const width = Math.round(Number(rect.width));
  const height = Math.round(Number(rect.height));
  if (![left, top, width, height].every(Number.isFinite)) return null;
  // A minimized window reports a placeholder rectangle of no size: it does not
  // say where the window is, so nothing may be resolved against it.
  if (width <= 1 || height <= 1) return null;
  return { left, top, width, height };
}

/** A screen point as a place inside the window. */
export function toWindowOffset(point, rect) {
  const box = usableRect(rect);
  if (!box) return null;
  const x = Math.round(Number(point?.x));
  const y = Math.round(Number(point?.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x - box.left, y: y - box.top };
}

/** A place inside the window as a screen point, kept inside the window. */
export function fromWindowOffset(offset, rect) {
  const box = usableRect(rect);
  if (!box) return null;
  const dx = Math.round(Number(offset?.x));
  const dy = Math.round(Number(offset?.y));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  // An offset written for a larger window must not land on whatever sits beside
  // the window now; the nearest point inside it is the honest answer.
  return {
    x: Math.min(box.left + box.width - 1, Math.max(box.left, box.left + dx)),
    y: Math.min(box.top + box.height - 1, Math.max(box.top, box.top + dy)),
  };
}

/**
 * Screen coordinates for a window-relative step, or null when the step is not
 * relative (or its window cannot be read). `points` keeps the arithmetic so the
 * executor can say where each offset landed.
 */
export function resolveWindowRelative(step, rect) {
  const params = step?.params || {};
  if (!isWindowRelative(params)) return null;
  const box = usableRect(rect);
  if (!box) return null;
  const next = { ...params };
  const points = [];
  for (const [xKey, yKey] of POINT_FIELDS) {
    if (params[xKey] == null || params[yKey] == null) continue;
    const offset = { x: Math.round(Number(params[xKey])), y: Math.round(Number(params[yKey])) };
    if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) continue;
    const point = fromWindowOffset(offset, box);
    if (!point) continue;
    next[xKey] = point.x;
    next[yKey] = point.y;
    points.push({ offset, point });
  }
  if (!points.length) return null;
  return { params: next, points, window: { title: anchorWindowFor(params), rect: box } };
}
