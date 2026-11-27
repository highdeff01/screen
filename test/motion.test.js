import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_TOLERANCE_PX, adjustPoint, describeMotion, motionBetween, validRect, workableZone } from '../server/motion.js';

const rect = (left, top, width, height) => ({ left, top, width, height });

test('a window that moved is measured as a translation, not a resize', () => {
  const motion = motionBetween(rect(156, 156, 776, 559), rect(52, 52, 776, 559));
  assert.equal(motion.moved, true);
  assert.equal(motion.resized, false);
  assert.equal(motion.dx, -104);
  assert.equal(motion.dy, -104);
  assert.equal(motion.distance, 147.1, 'the diagonal distance, rounded to a tenth');
  assert.deepEqual(motion.after, rect(52, 52, 776, 559));
});

test('drift inside the tolerance is not movement, and anything beyond it is', () => {
  const base = rect(52, 52, 776, 559);
  assert.equal(motionBetween(base, rect(54, 51, 776, 559)).changed, false);
  assert.equal(motionBetween(base, rect(52, 52, 776, 559)).changed, false);
  assert.equal(motionBetween(base, rect(55, 52, 776, 559)).moved, true);
  assert.equal(motionBetween(base, rect(52, 52, 800, 559)).resized, true);
  assert.equal(MOTION_TOLERANCE_PX, 2);
});

test('an unreadable rect is not a window that stayed put', () => {
  assert.equal(motionBetween(null, rect(1, 2, 3, 4)), null);
  assert.equal(motionBetween(rect(1, 2, 3, 4), { found: false, reason: 'window is minimized' }), null);
  assert.equal(motionBetween(rect(1, 2, 0, 4), rect(1, 2, 3, 4)), null);
  assert.deepEqual(validRect({ left: '10', top: '20', width: '30', height: '40' }), rect(10, 20, 30, 40));
});

test('a point is carried by the window’s movement', () => {
  const carried = adjustPoint({ x: 325, y: 448 }, rect(156, 156, 776, 559), rect(52, 52, 776, 559));
  assert.deepEqual({ x: carried.x, y: carried.y }, { x: 221, y: 344 });
  assert.equal(carried.scaled, false);
});

test('a point is scaled with a resized window', () => {
  const carried = adjustPoint({ x: 325, y: 448 }, rect(100, 100, 700, 500), rect(100, 100, 1400, 1000));
  assert.deepEqual({ x: carried.x, y: carried.y }, { x: 550, y: 796 });
  assert.equal(carried.scaled, true);
  assert.deepEqual([carried.scaleX, carried.scaleY], [2, 2]);
});

test('a point with no usable rects is not carried anywhere', () => {
  assert.equal(adjustPoint({ x: 1, y: 2 }, null, rect(0, 0, 10, 10)), null);
  assert.equal(adjustPoint({ x: 1, y: 2 }, rect(0, 0, 10, 10), null), null);
  assert.equal(adjustPoint(null, rect(0, 0, 10, 10), rect(0, 0, 10, 10)), null);
  assert.equal(adjustPoint({ x: NaN, y: 2 }, rect(0, 0, 10, 10), rect(0, 0, 10, 10)), null);
});

test('a carried point never lands outside the window it belongs to', () => {
  const box = rect(52, 52, 776, 559);
  const inside = workableZone({ x: 300, y: 300 }, box);
  assert.deepEqual({ x: inside.x, y: inside.y, clamped: inside.clamped }, { x: 300, y: 300, clamped: false });
  const past = workableZone({ x: 900, y: 900 }, box);
  assert.equal(past.x, 52 + 776 - 2);
  assert.equal(past.y, 52 + 559 - 2);
  assert.equal(past.clamped, true);
  const before = workableZone({ x: 0, y: 0 }, box);
  assert.equal(before.x, 53);
  assert.equal(before.y, 53);
  assert.equal(workableZone({ x: 1, y: 1 }, null), null);
});

test('a movement is described in words a log can use', () => {
  assert.match(describeMotion(motionBetween(rect(156, 156, 776, 559), rect(52, 52, 776, 559))), /moved 104 px left and 104 px up/);
  assert.match(describeMotion(motionBetween(rect(10, 10, 100, 100), rect(10, 40, 100, 100))), /moved 30 px down/);
  assert.match(describeMotion(motionBetween(rect(10, 10, 100, 100), rect(10, 10, 200, 100))), /resized \+100 × \+0/);
  assert.match(describeMotion(motionBetween(rect(10, 10, 100, 100), rect(10, 10, 100, 100))), /where it was/);
  assert.match(describeMotion(null), /no movement could be measured/);
});
