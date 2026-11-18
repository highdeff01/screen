import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-snapshots-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');

/** Real git, run in the temporary repo the store now calls ROOT. */
const git = (args) => new Promise((resolve) => {
  execFile('git', args, { cwd: process.cwd(), windowsHide: true }, (error, stdout, stderr) => {
    resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
  });
});

const snapshots = await load('server/snapshots.js');
let snapA;
let snapB;

after(async () => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('snapshots need a git repository', async () => {
  const result = await snapshots.createSnapshot('no repo here');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-a-repo');
  await git(['init']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
});

test('a snapshot captures the folder without touching any branch', async () => {
  fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'version one');
  const made = await snapshots.createSnapshot('first');
  assert.equal(made.ok, true, made.message);
  snapA = made.snapshot;
  const head = await git(['rev-parse', 'HEAD']);
  assert.equal(head.stdout, '', 'no commit was made on any branch');
  // The snapshot survives garbage collection via its own ref.
  const ref = await git(['rev-parse', `refs/snapshots/${snapA.id}`]);
  assert.equal(ref.stdout, snapA.commit);
  const listed = snapshots.snapshotStatus().snapshots;
  assert.equal(listed[0].label, 'first');
});

test('a second snapshot and a diff between them', async () => {
  fs.writeFileSync(path.join(process.cwd(), 'app.txt'), 'version two');
  fs.writeFileSync(path.join(process.cwd(), 'extra.txt'), 'new file');
  const made = await snapshots.createSnapshot('second');
  snapB = made.snapshot;
  assert.notEqual(snapB.commit, snapA.commit);
  const stat = await snapshots.diffSnapshots(snapA.id, snapB.id, { stat: true });
  assert.equal(stat.ok, true);
  assert.match(stat.patch, /app\.txt/);
  assert.match(stat.patch, /extra\.txt/);
  const full = await snapshots.diffSnapshots(snapA.id, snapB.id);
  assert.match(full.patch, /version two/);
});

test('transferring changes between versions lands them on the current tree', async () => {
  // Go back to version one, then carry "second" forward onto it.
  const restored = await snapshots.restoreSnapshot(snapA.id);
  assert.equal(restored.ok, true, restored.message);
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'app.txt'), 'utf8'), 'version one');
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'extra.txt')), 'a restore leaves out files the snapshot never had');
  // The restore kept what was here as its own safety snapshot.
  assert.match(restored.message, /safety/);

  const transfer = await snapshots.transferBetween(snapA.id, snapB.id);
  assert.equal(transfer.ok, true, transfer.message);
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'app.txt'), 'utf8'), 'version two');
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'extra.txt'), 'utf8'), 'new file');
});

test('unknown snapshots are reported, not guessed', async () => {
  await assert.rejects(async () => snapshots.diffSnapshots('snap_nope', snapB.id), /Snapshot not found/);
  await assert.rejects(async () => snapshots.restoreSnapshot('snap_nope'), /Snapshot not found/);
});
