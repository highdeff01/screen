import test from 'node:test';
import assert from 'node:assert/strict';
import { mapVisionPoint } from '../server/vision-map.js';

// A crop of the window at 39,39 on a desktop whose virtual origin is -1366,0,
// which is this machine's layout: a monitor to the left of the main one.
const view = {
  width: 1164,
  height: 839,
  cropX: 1405,
  cropY: 39,
  cropWidth: 1164,
  cropHeight: 839,
  originX: -1366,
  originY: 0,
};

test('a point in a cropped image maps back to its absolute screen position', () => {
  assert.deepEqual(mapVisionPoint({ view, x: 111, y: 211 }), { x: 150, y: 250 });
});

test('the virtual desktop origin is added, so a left-hand monitor does not shift every point', () => {
  const single = { ...view, cropX: 39, originX: 0 };
  assert.deepEqual(mapVisionPoint({ view: single, x: 111, y: 211 }), { x: 150, y: 250 });
  const shifted = mapVisionPoint({ view, x: 111, y: 211 });
  assert.equal(shifted.x - 150, 0, 'the origin and the crop offset cancel out, leaving the true point');
});

test('a downscaled image is scaled back to the crop it came from', () => {
  const wide = { ...view, width: 582, height: 419.5, cropWidth: 1164, cropHeight: 839 };
  const point = mapVisionPoint({ view: wide, x: 55.5, y: 105.5 });
  assert.deepEqual(point, { x: 150, y: 250 });
});

test('a point outside the captured region is refused, never clamped', () => {
  assert.equal(mapVisionPoint({ view, x: 5000, y: 10 }), null);
  assert.equal(mapVisionPoint({ view, x: -5, y: 10 }), null);
  assert.equal(mapVisionPoint({ view, x: 10, y: 5000 }), null);
});

test('unusable geometry or coordinates are refused', () => {
  assert.equal(mapVisionPoint({ view: { ...view, width: 0 }, x: 10, y: 10 }), null);
  assert.equal(mapVisionPoint({ view, x: 'left', y: 10 }), null);
  assert.equal(mapVisionPoint(), null);
});
