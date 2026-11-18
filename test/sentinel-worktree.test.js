import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-worktree-'));

/** A throwaway repository: the folder the console would live in. */
const git = (...args) =>
  execFileSync('git', args, { cwd: tempRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

git('init', '-q');
git('config', 'user.email', 'sentinel@example.com');
git('config', 'user.name', 'Sentinel test');
fs.writeFileSync(path.join(tempRoot, '.gitignore'), 'data/\n');
fs.mkdirSync(path.join(tempRoot, 'public'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'public', 'app.js'), 'original\n');
fs.writeFileSync(path.join(tempRoot, 'public', 'old.js'), 'to be deleted\n');
git('add', '-A');
git('commit', '-qm', 'base');

process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const sentinel = await load('server/sentinel.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const failingOutput = [
  '✖ renders the sync page (12.4ms)',
  '  AssertionError [ERR_ASSERTION]: expected 2 to equal 3',
  '      at TestContext.<anonymous> (file:///C:/work/test/app-observer.test.js:42:9)',
  '',
  'ℹ tests 12',
  'ℹ pass 10',
  'ℹ fail 2',
  '',
  '✖ failing tests:',
  '',
  '✖ test/sync-page.test.js (14.1ms)',
].join('\n');

test('the worktree holds this folder exactly as it is right now', async () => {
  fs.writeFileSync(path.join(tempRoot, 'public', 'app.js'), 'edited but not committed\n');
  fs.writeFileSync(path.join(tempRoot, 'public', 'extra.js'), 'brand new\n');
  fs.rmSync(path.join(tempRoot, 'public', 'old.js'));

  const worktree = await sentinel.prepareWorktree();
  assert.ok(worktree.ok, worktree.error);
  assert.notEqual(worktree.dir, tempRoot);
  assert.equal(fs.readFileSync(path.join(worktree.dir, 'public', 'app.js'), 'utf8'), 'edited but not committed\n');
  assert.equal(fs.readFileSync(path.join(worktree.dir, 'public', 'extra.js'), 'utf8'), 'brand new\n');
  assert.equal(fs.existsSync(path.join(worktree.dir, 'public', 'old.js')), false, 'a deletion is applied too');
  assert.ok(fs.existsSync(path.join(worktree.dir, '.git')), 'it is a real worktree');

  await worktree.cleanup();
  assert.equal(fs.existsSync(worktree.dir), false, 'the worktree is removed after the run');
});

test('machine state is never copied into the worktree', async () => {
  fs.mkdirSync(path.join(tempRoot, 'data', 'worktrees'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'data', 'db.json'), '{"private":true}\n');
  const worktree = await sentinel.prepareWorktree();
  assert.ok(worktree.ok, worktree.error);
  assert.equal(fs.existsSync(path.join(worktree.dir, 'data', 'db.json')), false);
  await worktree.cleanup();
});

test('verifying a commit tests that commit, not the uncommitted edits', async () => {
  const head = git('rev-parse', 'HEAD');
  let seenCwd = '';
  const result = await sentinel.verifyCommit(head, {
    run: async (_command, { cwd }) => {
      seenCwd = cwd;
      const body = fs.readFileSync(path.join(cwd, 'public', 'app.js'), 'utf8');
      return { ok: true, code: 0, output: `ℹ tests 3\nℹ pass 3\nℹ fail 0\n${body}` };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.isolated, true);
  assert.equal(result.commit, head);
  assert.notEqual(seenCwd, tempRoot);
  assert.equal(fs.existsSync(seenCwd), false, 'the verified worktree is cleaned up');
});

test('an unknown commit is reported, not guessed', async () => {
  const result = await sentinel.verifyCommit('deadbeef');
  assert.equal(result.ok, false);
  assert.equal(result.isolated, false);
  assert.match(result.error, /invalid reference|worktree|revision|unknown/i);
});

test('the spec output keeps the failing file, line and assertion', () => {
  const details = sentinel.parseFailureDetails(failingOutput);
  const first = details.find((item) => item.name === 'renders the sync page');
  assert.ok(first, 'the failing test is parsed');
  assert.match(first.file, /test\/app-observer\.test\.js$/);
  assert.equal(first.line, 42);
  assert.match(first.message, /expected 2 to equal 3/);
  assert.ok(details.some((item) => item.file === 'test/sync-page.test.js'));
  assert.deepEqual(sentinel.parseFailureDetails('ℹ tests 1\nℹ fail 0'), []);
});

test('a failing run writes the machine-readable queue file', async () => {
  await sentinel.runSentinelNow({
    run: async () => ({ ok: false, code: 1, output: failingOutput, durationMs: 9 }),
    worktree: false,
  });
  const file = path.join(tempRoot, 'must-check', 'repair-queue.json');
  assert.ok(fs.existsSync(file), 'the queue file exists');
  const queue = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(queue.version, 1);
  assert.equal(queue.by, 'sentinel');
  assert.equal(queue.open, 1);
  assert.equal(queue.lastRun.ok, false);
  const item = queue.items[0];
  assert.equal(item.status, 'queued');
  assert.ok(item.report.startsWith('must-check/'));
  assert.ok(item.details.some((detail) => detail.name === 'renders the sync page' && detail.line === 42));

  const handoff = await load('server/handoff.js');
  assert.ok(handoff.listNotes({ limit: 5 }).some((note) => note.by === 'sentinel'));
});

test('a verdict only applies while the source has not changed since it began', async () => {
  const passing = 'ℹ tests 3\nℹ pass 3\nℹ fail 0';
  await sentinel.runSentinelNow({ run: async () => ({ ok: true, code: 0, output: passing }), worktree: false });
  const state = sentinel.__sentinelState;
  state.lastChangeAt = null;
  const fresh = sentinel.lastVerdict();
  assert.equal(fresh.ok, true);
  assert.equal(fresh.isolated, false);
  // An edit after the run began means the run proves nothing about the edit.
  state.lastChangeAt = new Date(Date.now() + 1000).toISOString();
  assert.equal(sentinel.lastVerdict(), null);
});

test('dismissing the item leaves the queue file consistent', async () => {
  const open = sentinel.sentinelStatus().failures.filter((f) => f.status === 'queued');
  assert.ok(open.length, 'a queued item is there to dismiss');
  sentinel.dismissFailure(open[0].id);
  const queue = JSON.parse(fs.readFileSync(path.join(tempRoot, 'must-check', 'repair-queue.json'), 'utf8'));
  assert.equal(queue.open, 0);
  assert.deepEqual(queue.items, []);
});
