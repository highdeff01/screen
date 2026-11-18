import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-gitsync-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const sync = await load('server/git-sync.js');

after(() => {
  sync.stopAutoSync();
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  sync.__gitSyncState.lastStatusHash = '';
  sync.__gitSyncState.pausedUntil = 0;
  sync.__gitSyncState.busy = false;
  store.db().settings.autoSync = true;
});

/** A scripted git: handlers receive the argument list, calls are recorded. */
function fakeGit(handlers) {
  const calls = [];
  const run = async (args) => {
    const key = args[0];
    calls.push(args.join(' '));
    const handler = handlers[key];
    if (!handler) return { ok: true, stdout: '', stderr: '' };
    return typeof handler === 'function' ? handler(args) : handler;
  };
  return { run, calls };
}

test('a clean tree is left alone', async () => {
  const git = fakeGit({
    'rev-parse': { ok: true, stdout: 'true' },
    status: { ok: true, stdout: '' },
    'rev-list': { ok: true, stdout: '0\t0' },
  });
  const status = await sync.checkAndSync({ run: git.run });
  assert.equal(status.status, 'clean');
  assert.equal(git.calls.some((call) => call.startsWith('commit')), false);
});

test('auto-sync off means no git work at all', async () => {
  store.db().settings.autoSync = false;
  const git = fakeGit({});
  const status = await sync.checkAndSync({ run: git.run });
  assert.equal(status.status, 'disabled');
  assert.deepEqual(git.calls, []);
});

test('a change is committed only after it looks the same twice', async () => {
  const git = fakeGit({
    'rev-parse': { ok: true, stdout: 'true' },
    status: { ok: true, stdout: ' M public/app.js' },
    commit: { ok: true, stdout: '[main abc123] Auto-sync console changes' },
    'rev-parse': { ok: true, stdout: 'true' },
    fetch: { ok: true, stdout: '' },
    'rev-list': { ok: true, stdout: '1\t0' },
    push: { ok: true, stdout: 'ok' },
  });
  const first = await sync.checkAndSync({ run: git.run });
  assert.equal(first.status, 'waiting');
  assert.equal(first.pending, 1);
  assert.equal(git.calls.some((call) => call.startsWith('commit')), false);

  const second = await sync.checkAndSync({ run: git.run });
  assert.equal(second.status, 'pushed');
  assert.equal(git.calls.some((call) => call.startsWith('add -A')), true);
  assert.equal(git.calls.some((call) => call.startsWith('push origin')), true);
});

test('conflicts are reported and never committed', async () => {
  const git = fakeGit({
    'rev-parse': { ok: true, stdout: 'true' },
    status: { ok: true, stdout: 'UU server/index.js' },
  });
  const status = await sync.checkAndSync({ run: git.run });
  assert.equal(status.status, 'conflict');
  assert.match(status.lastError, /manual merge/);
  assert.equal(git.calls.some((call) => call.startsWith('commit')), false);
});

test('a remote that moved is not overwritten', async () => {
  const git = fakeGit({
    'rev-parse': (args) => ({
      ok: true,
      stdout: args.includes('--abbrev-ref') ? 'main' : args.includes('--is-inside-work-tree') ? 'true' : 'def4560',
    }),
    status: { ok: true, stdout: ' M README.md' },
    commit: { ok: true, stdout: '[main def456] Auto-sync console changes' },
    fetch: { ok: true, stdout: '' },
    'rev-list': { ok: true, stdout: '1\t2' },
  });
  const first = await sync.checkAndSync({ run: git.run });
  assert.equal(first.status, 'waiting');
  const second = await sync.checkAndSync({ run: git.run });
  assert.equal(second.status, 'behind');
  assert.equal(second.behind, 2);
  // Nothing is pushed while origin is ahead: the commit waits locally for a merge.
  assert.equal(git.calls.some((call) => call.startsWith('push')), false);
  assert.equal(git.calls.some((call) => call.includes('refs/heads/main')), false);
});

test('an operator asking now skips the settle wait', async () => {
  const git = fakeGit({
    'rev-parse': { ok: true, stdout: 'true' },
    status: { ok: true, stdout: ' M package.json' },
    commit: { ok: true, stdout: '[main ghi789] Auto-sync console changes' },
    fetch: { ok: true, stdout: '' },
    'rev-list': { ok: true, stdout: '1\t0' },
    push: { ok: true, stdout: 'ok' },
  });
  const status = await sync.checkAndSync({ run: git.run, force: true });
  assert.equal(status.status, 'pushed');
});

test('a folder that is not a repository says so once', async () => {
  const git = fakeGit({
    'rev-parse': { ok: false, code: 128, stdout: '', stderr: 'not a git repository' },
  });
  const status = await sync.checkAndSync({ run: git.run });
  assert.equal(status.status, 'not-a-repo');
  assert.match(status.lastError, /not a git repository/);
});
