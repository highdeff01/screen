/**
 * Snapshots — version history copies of the whole project, without touching the
 * working tree or any branch.
 *
 * A snapshot is a real git commit object built from a temporary index: the
 * current, gitignored-excluded contents of the folder are captured exactly as
 * they are, attached to the current HEAD as a parent, and recorded here. It
 * never becomes a commit on any branch, so auto-sync and the operator's own
 * history are untouched.
 *
 * From snapshots you can:
 *   - diff any two versions (stat or full patch)
 *   - transfer the changes between two versions onto the current tree, with a
 *     three-way apply that reports conflicts instead of guessing
 *   - restore a version (after taking a safety snapshot of what is here now)
 *
 * Everything runs real `git` in this folder; timeouts and output are bounded.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, logActivity, now, persist, ROOT, uid } from './store.js';

const PATCH_LIMIT = 40000;
const SNAP_LIMIT = 40;

function snapshots() {
  const d = db();
  if (!Array.isArray(d.snapshots)) d.snapshots = [];
  return d.snapshots;
}

function runGit(args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      }
    );
  });
}

const tempIndex = () => path.join(DATA, 'snap-index.tmp');

export function snapshotStatus() {
  const list = snapshots();
  return {
    count: list.length,
    snapshots: list.slice(0, 20),
    lastError: '',
  };
}

/** Build the tree of the current folder into a detached commit and record it. */
export async function createSnapshot(label = '', deps = {}) {
  const run = deps.run || runGit;
  const repo = await run(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.stdout !== 'true') {
    return { ok: false, status: 'not-a-repo', message: 'This folder is not a git working tree.' };
  }
  const index = tempIndex();
  try { fs.rmSync(index, { force: true }); } catch { /* nothing to remove */ }
  const add = await run(['add', '-A', '--'], { env: { GIT_INDEX_FILE: index } });
  if (!add.ok) return { ok: false, status: 'add-failed', message: add.stderr || 'git add failed' };
  const tree = await run(['write-tree'], { env: { GIT_INDEX_FILE: index } });
  if (!tree.ok) return { ok: false, status: 'tree-failed', message: tree.stderr || 'git write-tree failed' };
  const head = (await run(['rev-parse', 'HEAD']));
  const args = ['commit-tree', tree.stdout, '-m', `snapshot: ${label || now()}`];
  if (head.ok) args.push('-p', head.stdout);
  const commit = await run(args);
  try { fs.rmSync(index, { force: true }); } catch { /* best effort */ }
  if (!commit.ok) return { ok: false, status: 'commit-failed', message: commit.stderr || 'git commit-tree failed' };
  const snapshot = {
    id: uid('snap'),
    at: now(),
    label: String(label || '').trim().slice(0, 120) || 'unlabelled',
    commit: commit.stdout.slice(0, 40),
    parent: head.ok ? head.stdout.slice(0, 40) : null,
  };
  const list = snapshots();
  list.unshift(snapshot);
  while (list.length > SNAP_LIMIT) {
    const dropped = list.pop();
    try { await run(['update-ref', '-d', `refs/snapshots/${dropped.id}`]); } catch { /* ref may not exist */ }
  }
  // A named ref keeps the snapshot commit alive against git's garbage collector.
  await run(['update-ref', `refs/snapshots/${snapshot.id}`, snapshot.commit]);
  persist();
  logActivity('snapshots', `Snapshot “${snapshot.label}” taken`, { snapshotId: snapshot.id, commit: snapshot.commit });
  return { ok: true, status: 'created', snapshot, message: `Snapshot “${snapshot.label}” saved (${snapshot.commit.slice(0, 8)}).` };
}

function findSnapshot(id) {
  const snapshot = snapshots().find((entry) => entry.id === id);
  if (!snapshot) throw new Error('Snapshot not found');
  return snapshot;
}

/** Diff two versions: `stat: true` for the short form, otherwise the patch. */
export async function diffSnapshots(aId, bId, { stat = false } = {}, deps = {}) {
  const a = findSnapshot(aId);
  const b = findSnapshot(bId);
  const run = deps.run || runGit;
  const diff = await run(['diff', a.commit, b.commit, ...(stat ? ['--stat'] : [])]);
  if (!diff.ok) return { ok: false, status: 'diff-failed', message: diff.stderr || 'git diff failed' };
  const patch = diff.stdout.slice(0, PATCH_LIMIT);
  return { ok: true, status: 'diff', from: a.label, to: b.label, patch, truncated: diff.stdout.length > PATCH_LIMIT };
}

/**
 * Transfer the changes between two snapshots onto the current tree. Three-way,
 * so unrelated edits survive; conflicts are left as markers and reported, never
 * resolved by guesswork.
 */
export async function transferBetween(aId, bId, deps = {}) {
  const a = findSnapshot(aId);
  const b = findSnapshot(bId);
  const run = deps.run || runGit;
  const patchFile = path.join(DATA, `transfer-${a.id}-${b.id}.patch`);
  const diff = await run(['diff', a.commit, b.commit]);
  if (!diff.ok) return { ok: false, status: 'diff-failed', message: diff.stderr || 'git diff failed' };
  fs.mkdirSync(path.dirname(patchFile), { recursive: true });
  fs.writeFileSync(patchFile, diff.stdout);
  // A three-way apply merges against the index, so stage the current tree into
  // a temporary index first — the real index is never touched.
  const index = tempIndex();
  try { fs.rmSync(index, { force: true }); } catch { /* nothing to remove */ }
  await run(['add', '-A', '--'], { env: { GIT_INDEX_FILE: index } });
  const apply = await run(['apply', '--3way', '--whitespace=nowarn', patchFile], { env: { GIT_INDEX_FILE: index }, timeoutMs: 60000 });
  try {
    fs.rmSync(index, { force: true });
  } catch { /* best effort */ }
  if (apply.ok) {
    return { ok: true, status: 'applied', message: `Changes from “${a.label}” to “${b.label}” applied to the working tree. Review, test, then commit.` };
  }
  const conflicted = await run(['diff', '--name-only', '--diff-filter=U']);
  const conflicts = String(conflicted.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    ok: false,
    status: conflicts.length ? 'conflicts' : 'apply-failed',
    conflicts,
    patch: path.relative(ROOT, patchFile).split(path.sep).join('/'),
    message: conflicts.length
      ? `${conflicts.length} file(s) conflicted: ${conflicts.slice(0, 5).join(', ')}. Resolve, then commit.`
      : apply.stderr || apply.stdout || 'git apply failed',
  };
}

/** Restore a version after snapshotting what is here right now. */
export async function restoreSnapshot(id, deps = {}) {
  const snapshot = findSnapshot(id);
  const safety = await createSnapshot(`before restore of “${snapshot.label}”`, deps);
  if (!safety.ok) return { ok: false, status: safety.status, message: `Refusing to restore without a safety snapshot: ${safety.message}` };
  const run = deps.run || runGit;
  const index = tempIndex();
  const read = await run(['read-tree', snapshot.commit], { env: { GIT_INDEX_FILE: index } });
  if (!read.ok) return { ok: false, status: 'read-failed', message: read.stderr || 'git read-tree failed' };
  // checkout-index only touches paths present in the snapshot; anything new in
  // the current tree stays, so a restore is never a destructive wipe.
  const checkout = await run(['checkout-index', '-f', '-a'], { env: { GIT_INDEX_FILE: index } });
  try { fs.rmSync(index, { force: true }); } catch { /* best effort */ }
  if (!checkout.ok) return { ok: false, status: 'checkout-failed', message: checkout.stderr || 'git checkout-index failed' };
  logActivity('snapshots', `Restored “${snapshot.label}”`, { snapshotId: snapshot.id, safetySnapshot: safety.snapshot.id });
  return {
    ok: true,
    status: 'restored',
    message: `“${snapshot.label}” restored; what was here is kept as snapshot “${safety.snapshot.label}”.`,
  };
}
