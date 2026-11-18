import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-annotations-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const annotations = await load('server/annotations.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.annotations = [];
  store.persist();
});

test('annotations attach to a capture reference and read back', () => {
  const added = annotations.addAnnotation({ ref: { captureId: 'cap1' }, kind: 'pin', x: 0.25, y: 0.75, text: 'caret is here', by: 'ai' });
  assert.equal(added.kind, 'pin');
  const list = annotations.listAnnotations({ captureId: 'cap1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'caret is here');
  assert.equal(annotations.listAnnotations({ captureId: 'cap2' }).length, 0);
});

test('coordinates are clamped and a label requires text', () => {
  const added = annotations.addAnnotation({ ref: { captureId: 'cap1' }, x: 5, y: -2 });
  assert.equal(added.x, 1);
  assert.equal(added.y, 0);
  assert.throws(() => annotations.addAnnotation({ ref: { captureId: 'cap1' }, kind: 'label' }), /label needs text/);
});

test('a reference is required', () => {
  assert.throws(() => annotations.addAnnotation({}), /needs a reference/);
});

test('pinFindings drops a batch of AI findings onto one frame', () => {
  const added = annotations.pinFindings(
    { captureId: 'cap9', runId: 'r1' },
    [
      { x: 0.1, y: 0.2, text: 'Save button' },
      { kind: 'box', x: 0.4, y: 0.4, w: 0.2, h: 0.1, text: 'unsaved document' },
      { bogus: true },
    ],
    { by: 'deep-focus' }
  );
  assert.equal(added.length, 3); // the malformed one still becomes a default pin
  const runList = annotations.annotationsForRun('r1');
  assert.equal(runList.length, 3);
  assert.ok(runList.every((entry) => entry.by === 'deep-focus'));
});

test('annotations can be removed', () => {
  const added = annotations.addAnnotation({ ref: { surface: 'review' }, text: 'temp' });
  const removed = annotations.removeAnnotation(added.id);
  assert.equal(removed.id, added.id);
  assert.throws(() => annotations.removeAnnotation('nope'), /not found/i);
});
