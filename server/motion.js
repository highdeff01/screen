/**
 * Movement, measured.
 *
 * A learned point is a pair of screen coordinates, and the window it was learned
 * in is what makes it mean anything. When that window moves, the same pair
 * points at whatever now occupies that spot — so the point has to be carried
 * across the move rather than either trusted as-is or thrown away.
 *
 * Carrying it is arithmetic: the control keeps its place relative to the window,
 * so translate by the window's own movement and scale by any resize. That is
 * `adjustPoint`. `motionBetween` is the measurement it starts from, and
 * `workableZone` keeps a carried point inside the window it belongs to — a
 * window dragged half off the screen must not produce a target on the desktop.
 *
 * All of it is pure: no desktop, no clock, no captures. The live-map reader and
 * the aim both use these, and the tests drive them with plain rectangles.
 */

/** A window may drift this far (DPI rounding) before it counts as moved. */
export const MOTION_TOLERANCE_PX = 2;

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** A rectangle usable for arithmetic, or null. */
export function validRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  const left = num(rect.left);
  const top = num(rect.top);
  const width = num(rect.width);
  const height = num(rect.height);
  if (left == null || top == null || width == null || height == null) return null;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

const pick = (rect) => {
  const clean = validRect(rect);
  return clean ? { left: clean.left, top: clean.top, width: clean.width, height: clean.height } : null;
};

/**
 * How one window rect differs from another: a translation, a resize, both, or
 * neither. `null` when either rect is unusable — an unreadable window is not a
 * window that stayed put.
 */
export function motionBetween(before, after, tolerance = MOTION_TOLERANCE_PX) {
  const from = validRect(before);
  const to = validRect(after);
  if (!from || !to) return null;
  const dx = Math.round(to.left - from.left);
  const dy = Math.round(to.top - from.top);
  const dw = Math.round(to.width - from.width);
  const dh = Math.round(to.height - from.height);
  const limit = Math.max(0, Number(tolerance) || 0);
  const moved = Math.abs(dx) > limit || Math.abs(dy) > limit;
  const resized = Math.abs(dw) > limit || Math.abs(dh) > limit;
  return {
    dx,
    dy,
    dw,
    dh,
    distance: Math.round(Math.hypot(dx, dy) * 10) / 10,
    moved,
    resized,
    changed: moved || resized,
    before: pick(from),
    after: pick(to),
  };
}

/**
 * Carry a screen point from the window rect it was recorded in to the rect the
 * window has now. The point's place inside the window is preserved: a window
 * that only moved translates its points, and one that was resized scales them
 * with it. Returns null when either rect is unusable, so a caller can tell "I
 * cannot carry this" from "this is the same point".
 */
export function adjustPoint(point, before, after) {
  const from = validRect(before);
  const to = validRect(after);
  const x = num(point?.x);
  const y = num(point?.y);
  if (!from || !to || x == null || y == null) return null;
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  return {
    x: Math.round(to.left + (x - from.left) * scaleX),
    y: Math.round(to.top + (y - from.top) * scaleY),
    scaleX: Math.round(scaleX * 1000) / 1000,
    scaleY: Math.round(scaleY * 1000) / 1000,
    scaled: Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001,
  };
}

/**
 * Keep a point inside the rect it belongs to. A carried point on a window that
 * was dragged partly off the screen, or squeezed smaller than the control's old
 * offset, would otherwise land on the desktop or on another window; the edge of
 * its own window is the farthest useful place it can be.
 */
export function workableZone(point, rect, margin = 1) {
  const box = validRect(rect);
  const x = num(point?.x);
  const y = num(point?.y);
  if (!box || x == null || y == null) return null;
  const inset = Math.max(0, Math.min(Number(margin) || 0, Math.floor(Math.min(box.width, box.height) / 2) - 1));
  const minX = box.left + inset;
  const minY = box.top + inset;
  const maxX = box.left + box.width - 1 - inset;
  const maxY = box.top + box.height - 1 - inset;
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
    clamped: x < minX || x > maxX || y < minY || y > maxY,
  };
}

/** One sentence for a log or a panel, from the measurement above. */
export function describeMotion(motion) {
  if (!motion) return 'no movement could be measured';
  if (!motion.changed) return `the window is where it was (${motion.dx}, ${motion.dy} from its recorded rect)`;
  const parts = [];
  if (motion.moved) {
    const across = motion.dx === 0 ? '' : `${Math.abs(motion.dx)} px ${motion.dx > 0 ? 'right' : 'left'}`;
    const down = motion.dy === 0 ? '' : `${Math.abs(motion.dy)} px ${motion.dy > 0 ? 'down' : 'up'}`;
    parts.push(`moved ${[across, down].filter(Boolean).join(' and ')}`);
  }
  if (motion.resized) {
    parts.push(`resized ${motion.dw >= 0 ? '+' : ''}${motion.dw} × ${motion.dh >= 0 ? '+' : ''}${motion.dh}`);
  }
  return `the window ${parts.join(' and ')}`;
}
