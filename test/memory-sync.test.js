import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-memory-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const memory = await load('server/memory-sync.js');

after(() => {
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('the newer copy of an id wins, and nothing is deleted', () => {
  const local = [
    { id: 'g1', title: 'local old', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'g2', title: 'only local', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const incoming = [
    { id: 'g1', title: 'incoming new', updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'g3', title: 'only incoming', updatedAt: '2026-02-01T00:00:00.000Z' },
  ];
  const merged = memory.mergeById(local, incoming);
  assert.equal(merged.added, 1);
  assert.equal(merged.updated, 1);
  assert.equal(merged.kept, 0);
  assert.equal(merged.items.length, 3);
  assert.equal(merged.items.find((item) => item.id === 'g1').title, 'incoming new');
  assert.equal(merged.items.some((item) => item.id === 'g2'), true);
});

test('an older incoming copy leaves the local one alone', () => {
  const local = [{ id: 'g1', title: 'current', updatedAt: '2026-03-01T00:00:00.000Z' }];
  const incoming = [{ id: 'g1', title: 'stale', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const merged = memory.mergeById(local, incoming);
  assert.equal(merged.updated, 0);
  assert.equal(merged.kept, 1);
  assert.equal(merged.items[0].title, 'current');
});

test('items without an id are ignored rather than merged blindly', () => {
  const merged = memory.mergeById([], [{ title: 'no id' }, { id: 'x', title: 'has id' }]);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.added, 1);
});

test('a bundle round-trips through import with additive reporting', () => {
  const target = {
    goals: [{ id: 'g1', title: 'ship it', updatedAt: '2026-01-01T00:00:00.000Z' }],
    missions: [{ id: 'm1', title: 'first', updatedAt: '2026-01-01T00:00:00.000Z' }],
  };
  let saves = 0;
  const bundle = {
    version: 1,
    goals: [
      { id: 'g1', title: 'ship it better', updatedAt: '2026-04-01T00:00:00.000Z' },
      { id: 'g2', title: 'second goal', updatedAt: '2026-04-01T00:00:00.000Z' },
    ],
    missions: [{ id: 'm2', title: 'second mission', updatedAt: '2026-04-01T00:00:00.000Z' }],
  };
  const out = memory.importBundle(bundle, { target, save: () => (saves += 1) });
  assert.equal(out.ok, true);
  assert.equal(out.goals.added, 1);
  assert.equal(out.goals.updated, 1);
  assert.equal(out.missions.added, 1);
  assert.equal(target.goals.length, 2);
  assert.equal(target.missions.length, 2);
  assert.equal(saves, 1);
  assert.match(out.message, /Nothing was deleted/);
});

test('a bundle that is not a bundle is refused, and nothing is written', () => {
  const target = { goals: [], missions: [] };
  assert.equal(memory.importBundle(null, { target }).ok, false);
  assert.equal(memory.importBundle({ hello: 'there' }, { target }).ok, false);
  assert.deepEqual(target, { goals: [], missions: [] });
});

test('export includes the local goals and missions with counts', () => {
  const bundle = memory.exportBundle();
  assert.equal(bundle.version, 1);
  assert.equal(Array.isArray(bundle.goals), true);
  assert.equal(Array.isArray(bundle.missions), true);
  assert.equal(typeof bundle.counts.goals, 'number');
});
