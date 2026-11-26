import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedWindow,
  motionOf,
  optionsFor,
  positionLine,
  positionOf,
  referenceCompare,
  whereToNext,
} from '../server/navigate.js';

const screen = (overrides = {}) => ({
  foreground: { title: 'Sightline Accounts', process: 'python', handle: 4242, ...(overrides.foreground || {}) },
  windows: [{ title: 'Sightline Accounts' }, { title: 'Chrome' }],
  ...overrides,
});

const cells = (value) => Array.from({ length: 16 }, () => value);

test('the position names the window in front and whether it is the expected one', () => {
  const here = positionOf({ screen: screen(), step: { params: { foregroundHandle: 4242 } } });
  assert.equal(here.title, 'Sightline Accounts');
  assert.equal(here.app, 'python');
  assert.equal(here.handle, 4242);
  assert.equal(here.named, true);
  assert.equal(here.windows, 2);

  const wrong = positionOf({ screen: screen(), step: { params: { foregroundHandle: 999 } } });
  assert.equal(wrong.named, false);

  const byTitle = positionOf({ screen: screen(), step: { params: { window: 'accounts' } } });
  assert.equal(byTitle.named, true);

  const byProcess = positionOf({ screen: screen({ foreground: { title: '', process: 'chrome' } }), step: { params: { app: 'chrome' } } });
  assert.equal(byProcess.named, true);

  const unnamed = positionOf({ screen: screen(), step: { params: {} } });
  assert.equal(unnamed.named, null);
});

test('a position falls back to the window the run last opened', () => {
  const expected = expectedWindow({ params: {} }, { lastWindow: { title: 'Sightline Accounts', hwnd: 4242 } });
  assert.equal(expected.handle, 4242);
  assert.equal(expected.source, 'run');
  assert.equal(positionOf({ screen: screen(), run: { lastWindow: { title: 'Sightline Accounts', hwnd: 4242 } } }).named, true);
});

test('the position line reads like a place, not a data dump', () => {
  const line = positionLine(positionOf({ screen: screen(), step: { params: { foregroundHandle: 4242 } } }));
  assert.match(line, /^Where: “Sightline Accounts” \(python\) hwnd 4242/);
  assert.match(line, /the window this run is working in/);

  const elsewhere = positionLine(positionOf({ screen: screen(), step: { params: { window: 'Notepad' } } }));
  assert.match(elsewhere, /not the window this run expects/);

  assert.match(positionLine(null), /could not be read/);
});

test('two frames say whether the screen is moving or still', () => {
  const before = { cells: cells('101010') };
  const same = { cells: cells('101010') };
  const moved = { cells: cells('f0f0f0') };

  assert.equal(motionOf(before, same).still, true);
  assert.equal(motionOf(before, same).moving, false);
  assert.equal(motionOf(before, moved).still, false);
  assert.equal(motionOf(before, moved).moving, true);
  assert.equal(motionOf(null, moved).known, false);
});

test('options are ordered by their own score and carry their band', () => {
  const options = optionsFor({
    choices: [
      { id: 'a', name: 'Type the address', type: 'type', confidence: 0.62, ok: true },
      { id: 'b', name: 'Click “Dan”', type: 'clickElement', confidence: 0.95, ok: true },
      { id: 'c', name: 'Press Escape', type: 'key', confidence: 0.2, ok: true },
      { id: 'd', name: 'Unsampled', type: 'key', ok: false },
    ],
  });
  assert.deepEqual(options.map((entry) => entry.id), ['b', 'a', 'c']);
  assert.deepEqual(options.map((entry) => entry.band), ['act', 'replan', 'hold']);
});

test('a reference signature answers whether this is still the screen that worked', () => {
  const reference = { cells: cells('202020') };
  const same = referenceCompare({ now: { cells: cells('202020') }, reference });
  assert.equal(same.known, true);
  assert.equal(same.matches, true);
  assert.match(same.detail, /still matches the reference/);

  const different = referenceCompare({ now: { cells: cells('e0e0e0') }, reference });
  assert.equal(different.matches, false);

  const byHash = referenceCompare({ now: { hash: 'abcd1234' }, reference: { hash: 'abcd1234' } });
  assert.equal(byHash.matches, true);

  const none = referenceCompare({ now: { cells: cells('202020') }, reference: null });
  assert.equal(none.known, false);
});

test('where-to-next states the place, the goal and the move the ladder allows', () => {
  const position = positionOf({ screen: screen(), step: { params: { foregroundHandle: 4242 } } });
  const options = optionsFor({
    choices: [
      { id: 'a', name: 'Click “Dan”', confidence: 0.95, ok: true },
      { id: 'b', name: 'Press Enter', confidence: 0.55, ok: true },
    ],
  });

  const act = whereToNext({ position, goal: 'Sign in as Dan', options, decision: { band: 'act', action: 'act' } });
  assert.match(act.from, /Sightline Accounts/);
  assert.equal(act.to, 'Sign in as Dan');
  assert.equal(act.next, 'Click “Dan”');
  assert.deepEqual(act.options.map((entry) => entry.band), ['act', 'replan']);

  const held = whereToNext({ position, goal: 'Sign in as Dan', options, decision: { band: 'hold', action: 'hold', reason: '41% approval' } });
  assert.equal(held.next, 'hold');
  assert.equal(held.reason, '41% approval');
});
