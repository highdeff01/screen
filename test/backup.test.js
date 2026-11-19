import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-backup-'));
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const backup = await load('server/backup.js');

after(() => {
  backup.stopBackup();
  // Windows releases the temp folder's handles a moment after the last write.
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function git(args, cwd = tempRoot) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('porcelain lines are split into deletions and the rest', () => {
  const parsed = backup.readPorcelain(' D one.js\nD  two.js\nR  old.js -> new.js\n M keep.js\n');
  assert.deepEqual(parsed.deletions, ['one.js', 'two.js']);
  assert.equal(parsed.count, 4);
  // A rename is not a deletion: both sides still exist under different names.
  assert.equal(parsed.modified.length, 2);
});

test('the deletion guard refuses a pass over its limit and allows one under it', () => {
  const lines = ' D a.js\n D b.js\n M c.js\n';
  assert.equal(backup.deletionGuard(lines, { maxDeletes: 3 }).allowed, true);
  const held = backup.deletionGuard(lines, { maxDeletes: 2 });
  assert.equal(held.allowed, false);
  assert.deepEqual(held.deletions, ['a.js', 'b.js']);
  assert.match(held.why, /would be deleted in one pass/);
});

test('the link test reports the remote commit and why it failed', async () => {
  const good = await backup.checkLink({
    run: async () => ({ ok: true, stdout: 'abc123\trefs/heads/main', stderr: '' }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.sha, 'abc123');
  assert.equal(typeof good.latencyMs, 'number');

  const bad = await backup.checkLink({
    run: async () => ({ ok: false, stdout: '', stderr: 'fatal: unable to access the remote' }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unable to access/);
  assert.equal(bad.sha, '');
});

test('a disabled backup does nothing and says so', async () => {
  const status = await backup.backupTick({ settings: { localBackupEnabled: false } });
  assert.equal(status.enabled, false);
  assert.equal(status.status, 'disabled');
});

test('the mirror is cloned once, then follows GitHub in both directions', async () => {
  const originDir = path.join(tempRoot, 'origin.git');
  git(['init', '--bare', '-b', 'main', originDir]);
  const work = path.join(tempRoot, 'work');
  git(['init', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(['add', 'a.txt'], work);
  git(['commit', '-m', 'first'], work);
  git(['remote', 'add', 'origin', originDir], work);
  git(['push', '-u', 'origin', 'main'], work);

  const mirrorDir = path.join(tempRoot, 'mirror');
  const settings = {
    localBackupEnabled: true,
    localBackupPath: mirrorDir,
    localBackupIntervalMs: 10000,
    autoSyncMaxDeletes: 25,
  };

  // First pass: the folder does not exist, so it is cloned and matches.
  const first = await backup.backupTick({ root: work, settings });
  assert.equal(first.lastError, '', first.lastError);
  assert.equal(fs.existsSync(path.join(mirrorDir, '.git')), true);
  assert.equal(first.inSync, true);
  assert.equal(first.mirrorSha, git(['rev-parse', 'HEAD'], work));

  // Somebody else pushes: the mirror takes the commit on the next pass.
  const other = path.join(tempRoot, 'other');
  git(['clone', originDir, other]);
  fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
  git(['add', 'b.txt'], other);
  git(['commit', '-m', 'from elsewhere'], other);
  git(['push', 'origin', 'main'], other);
  const remoteSha = git(['rev-parse', 'HEAD'], other);

  const second = await backup.backupTick({ root: work, settings });
  assert.equal(second.mirrorSha, remoteSha);
  assert.equal(second.mirror.behind, 0);
  // The working tree has not pulled yet, so it is honestly reported as behind.
  assert.equal(second.inSync, false);
  assert.match(second.lastError, /not at the GitHub commit/);

  // This folder catches up, commits its own change, and everything is level.
  git(['pull', '--ff-only', 'origin', 'main'], work);
  fs.writeFileSync(path.join(work, 'c.txt'), 'c\n');
  git(['add', 'c.txt'], work);
  git(['commit', '-m', 'local work'], work);
  git(['push', 'origin', 'main'], work);
  const third = await backup.backupTick({ root: work, settings });
  assert.equal(third.inSync, true, third.lastError);

  // A change made inside the backup folder goes back up to GitHub.
  fs.writeFileSync(path.join(mirrorDir, 'mirror.txt'), 'edited in the backup\n');
  const fourth = await backup.backupTick({ root: work, settings });
  assert.equal(fourth.mirror.ahead, 0);
  assert.equal(git(['--git-dir', originDir, 'show', 'main:mirror.txt']), 'edited in the backup');

  // A pass that would delete tracked files is refused before anything is pushed.
  fs.rmSync(path.join(mirrorDir, 'a.txt'));
  fs.rmSync(path.join(mirrorDir, 'b.txt'));
  const guarded = await backup.backupTick({
    root: work,
    settings: { ...settings, autoSyncMaxDeletes: 2 },
  });
  assert.equal(guarded.status, 'held');
  assert.equal(guarded.held.reason, 'deletions');
  assert.match(guarded.lastError, /would be deleted in one pass/);
  // Both files still exist on GitHub: nothing was committed or pushed.
  assert.equal(git(['--git-dir', originDir, 'show', 'main:a.txt']), 'a');
  assert.equal(git(['--git-dir', originDir, 'show', 'main:b.txt']), 'b');
});
