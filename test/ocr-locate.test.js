import test from 'node:test';
import assert from 'node:assert/strict';
import { lineInk, matchOcrLine, ocrLabelScore, ocrLineAnchor, ocrLines, ocrScreenPoint } from '../server/ocr-locate.js';

// A Profile-window OCR read at 150%: the title bar, the nav buttons, and the
// form's wide Save button. Boxes are what Windows.Media.Ocr returns — line
// boxes, taller than the glyphs they hold.
const WORDS = [
  { text: 'Sightline', x: 24, y: 12, w: 84, h: 22 },
  { text: 'Profile', x: 116, y: 12, w: 62, h: 22 },
  { text: 'Profile', x: 41, y: 152, w: 56, h: 20, ink: { x: 68, y: 156, pixels: 40 } },
  { text: 'Notifications', x: 36, y: 240, w: 110, h: 20, ink: { x: 90, y: 245, pixels: 60 } },
  { text: 'Save', x: 222, y: 360, w: 40, h: 20, ink: { x: 241, y: 363, pixels: 25 } },
  { text: 'profile', x: 266, y: 360, w: 54, h: 20, ink: { x: 292, y: 365, pixels: 35 } },
];

test('words on one baseline are one line of text', () => {
  const lines = ocrLines(WORDS);
  const save = lines.find((line) => line.text.startsWith('Save'));
  assert.equal(save.text, 'Save profile', 'a two-word label is not split into two lines');
  assert.deepEqual([save.left, save.top, save.right, save.bottom], [222, 360, 320, 380]);
});

test('the title bar is chrome, not a control', () => {
  // minY is the client area's top in capture pixels: title bar and frame are
  // above it, so "Sightline Profile" there can never outrank the button.
  const lines = ocrLines(WORDS, { minY: 46 });
  assert.equal(lines.length, 3);
  assert.ok(!lines.some((line) => line.text === 'Sightline Profile'));
});

test('an exact label outranks a longer line that only contains the name', () => {
  assert.ok(ocrLabelScore('Profile', 'Profile') > ocrLabelScore('Sightline Profile', 'Profile'));
  assert.ok(ocrLabelScore('Save profile', 'Save') > ocrLabelScore('Save profile', 'Cancel'));
  assert.equal(ocrLabelScore('', 'Save'), 0);
});

test('the best line for a name is the one inside the window, not the one in the title', () => {
  const best = matchOcrLine(ocrLines(WORDS, { minY: 46 }), ['Profile']);
  assert.equal(best.line.text, 'Profile');
  assert.equal(best.score, 120);
});

test('a control named by two words matches the line that holds both', () => {
  const best = matchOcrLine(ocrLines(WORDS, { minY: 46 }), ['Save profile']);
  assert.equal(best.line.text, 'Save profile');
});

test('any of the label variants the UIA search would try can match', () => {
  const best = matchOcrLine(ocrLines(WORDS, { minY: 46 }), ['Notifications tab', 'Notifications']);
  assert.equal(best.line.text, 'Notifications');
  assert.equal(best.matched, 'Notifications');
});

test('a control the window does not name matches nothing', () => {
  assert.equal(matchOcrLine(ocrLines(WORDS, { minY: 46 }), ['Settings']), null);
});

test('the label’s ink, not its line box, is where the click goes', () => {
  const lines = ocrLines(WORDS, { minY: 46 });
  const line = lines.find((entry) => entry.text === 'Notifications');
  const boxed = ocrLineAnchor(line, null);
  const inked = ocrLineAnchor(line, lineInk(line));
  // The line box is 20 px tall around 20 px of text, so its centre is low.
  assert.equal(boxed.y, 250);
  assert.equal(inked.x, 90);
  assert.equal(inked.y, 245, 'the ink centroid is what a person sees as the label');
});

test('ink from a neighbour is refused rather than trusted', () => {
  const line = ocrLines(WORDS, { minY: 46 }).find((entry) => entry.text === 'Profile');
  assert.equal(ocrLineAnchor(line, { x: line.left - 40, y: 156, pixels: 90 }).x, Math.round((line.left + line.right) / 2));
  assert.equal(ocrLineAnchor(line, { x: 68, y: 400, pixels: 90 }).y, Math.round((line.top + line.bottom) / 2));
});

test('a label with no dark pixels falls back to its box', () => {
  // Light text on a dark theme has no ink below the threshold to measure.
  const line = { text: 'Light', words: [{ text: 'Light', x: 10, y: 20, w: 40, h: 18 }], left: 10, top: 20, right: 50, bottom: 38 };
  assert.equal(lineInk(line), null);
  assert.deepEqual(ocrLineAnchor(line, null), { x: 30, y: 29 });
});

test('the anchor becomes a screen point through the capture’s origin', () => {
  assert.deepEqual(ocrScreenPoint({ x: 90, y: 245 }, { x: 101, y: 101 }), { x: 191, y: 346 });
  assert.equal(ocrScreenPoint({ x: NaN, y: 1 }, { x: 0, y: 0 }), null);
});

test('a line’s ink is weighted by how much of it is glyphs', () => {
  const ink = lineInk({
    words: [
      { text: 'I', ink: { x: 0, y: 0, pixels: 1 } },
      { text: 'mmmm', ink: { x: 100, y: 10, pixels: 99 } },
    ],
  });
  assert.ok(ink.x > 95);
  assert.equal(ink.pixels, 100);
});
