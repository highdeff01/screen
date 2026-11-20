import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  sync.__gitSyncState.autoTickBusy = false;
  sync.__gitSyncState.ahead = 0;
  sync.__gitSyncState.behind = 0;
  store.db().settings.autoSync = true;
  store.db().settings.autoPull = true;
  sync.__gitSyncState.verified = null;
  sync.__gitSyncState.verifiedSha = '';
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

test('new installs default off and saved choices are preserved', () => {
  for (const choice of [undefined, true, false, null]) {
    const dir = fs.mkdtempSync(path.join(tempRoot, 'store-'));
    if (choice !== undefined) {
      fs.mkdirSync(path.join(dir, 'data'));
      fs.writeFileSync(path.join(dir, 'data', 'db.json'), JSON.stringify({ settings: choice === null ? {} : { autoSync: choice } }));
    }
    const script = `import { db } from ${JSON.stringify(pathToFileURL(path.join(root, 'server/store.js')).href)}; console.log(JSON.stringify(db().settings.autoSync));`;
    const value = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(JSON.parse(value), choice === true);
  }
});

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

test('disabled auto-sync never fetches or applies remote changes', async () => {
  store.db().settings.autoSync = false;
  const git = fakeGit({});
  const status = await sync.autoTick({ run: git.run });
  assert.equal(status.status, 'disabled');
  assert.deepEqual(git.calls, []);
});

test('missing opt-in and force do not run git', async () => {
  delete store.db().settings.autoSync;
  const git = fakeGit({});
  const status = await sync.checkAndSync({ run: git.run, force: true });
  assert.equal(status.enabled, false);
  assert.equal(status.status, 'disabled');
  assert.deepEqual(git.calls, []);
});

test('remote updates are tested before the local branch is fast-forwarded', async () => {
  const remoteSha = 'remote1234567890';
  const git = fakeGit({
    'rev-parse': (args) => ({
      ok: true,
      stdout: args.includes('--is-inside-work-tree') ? 'true' : args.includes('--abbrev-ref') ? 'main' : args[0] === 'rev-parse' && args[1] === `origin/main` ? remoteSha : 'head1234567890',
    }),
    status: { ok: true, stdout: '' },
    fetch: { ok: true, stdout: '' },
    'rev-list': (args) => ({ ok: true, stdout: String(args.at(-1)).includes('@{upstream}') ? '0\t0' : '0\t1' }),
    merge: { ok: true, stdout: 'Updating head..remote' },
  });
  const verified = [];
  const status = await sync.autoTick({
    run: git.run,
    verify: async (sha) => {
      verified.push(sha);
      return { ok: true };
    },
    backup: async () => ({ ok: true }),
  });
  assert.deepEqual(verified, [remoteSha]);
  assert.equal(status.status, 'pulled');
  assert.ok(git.calls.some((call) => call === `merge --ff-only ${remoteSha}`));
  assert.ok(!git.calls.some((call) => call === 'merge --ff-only origin/main'));
});

test('pausing sync during remote verification prevents applying the update', async () => {
  const git = fakeGit({
    'rev-parse': (args) => ({
      ok: true,
      stdout: args.includes('--is-inside-work-tree') ? 'true' : args.includes('--abbrev-ref') ? 'main' : 'remote1234567890',
    }),
    status: { ok: true, stdout: '' },
    fetch: { ok: true, stdout: '' },
    'rev-list': (args) => ({ ok: true, stdout: String(args.at(-1)).includes('@{upstream}') ? '0\t0' : '0\t1' }),
  });
  await sync.autoTick({
    run: git.run,
    verify: async () => {
      store.db().settings.autoSync = false;
      return { ok: true };
    },
    backup: async () => ({ ok: true }),
  });
  assert.equal(git.calls.some((call) => call.startsWith('merge')), false);
});

test('a remote update is not applied if the recovery snapshot fails', async () => {
  const git = fakeGit({
    'rev-parse': (args) => ({
      ok: true,
      stdout: args.includes('--is-inside-work-tree') ? 'true' : args.includes('--abbrev-ref') ? 'main' : args[1] === 'origin/main' ? 'remote1234567890' : 'head1234567890',
    }),
    status: { ok: true, stdout: '' },
    fetch: { ok: true, stdout: '' },
    'rev-list': (args) => ({ ok: true, stdout: String(args.at(-1)).includes('@{upstream}') ? '0\t0' : '0\t1' }),
  });
  const status = await sync.autoTick({
    run: git.run,
    verify: async () => ({ ok: true }),
    backup: async () => ({ ok: false, message: 'disk full' }),
  });
  assert.equal(status.status, 'backup-failed');
  assert.match(status.lastError, /disk full/);
  assert.equal(git.calls.some((call) => call.startsWith('merge')), false);
});

test('a failing remote update is held without changing local files', async () => {
  const remoteSha = 'badremote123456';
  const git = fakeGit({
    'rev-parse': (args) => ({
      ok: true,
      stdout: args.includes('--is-inside-work-tree') ? 'true' : args.includes('--abbrev-ref') ? 'main' : args[1] === `origin/main` ? remoteSha : 'head1234567890',
    }),
    status: { ok: true, stdout: '' },
    fetch: { ok: true, stdout: '' },
    'rev-list': (args) => ({ ok: true, stdout: String(args.at(-1)).includes('@{upstream}') ? '0\t0' : '0\t1' }),
  });
  const status = await sync.autoTick({
    run: git.run,
    verify: async () => ({ ok: false, fail: 2, failingTests: ['broken test'] }),
    backup: async () => ({ ok: true }),
  });
  assert.equal(status.status, 'held');
  assert.match(status.lastError, /failed testing/);
  assert.equal(git.calls.some((call) => call.startsWith('merge')), false);
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
  assert.equal(git.calls.includes('add -u -- . :(exclude)data'), true);
  assert.equal(git.calls.some((call) => call.startsWith('push origin')), true);
});

test('content edits reset the auto-commit settle window even when git status is unchanged', async () => {
  let diffCount = 0;
  const git = fakeGit({
    'rev-parse': { ok: true, stdout: 'true' },
    status: { ok: true, stdout: ' M public/app.js' },
    diff: () => ({ ok: true, stdout: ++diffCount === 1 ? 'first contents' : 'latest contents' }),
  });
  const first = await sync.checkAndSync({ run: git.run });
  const second = await sync.checkAndSync({ run: git.run });
  assert.equal(first.status, 'waiting');
  assert.equal(second.status, 'waiting');
  assert.equal(git.calls.some((call) => call.startsWith('commit')), false);
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

test('status failure and staged changes never cause a commit', async () => {
  for (const response of [
    { ok: false, stderr: 'status error' },
    { ok: true, stdout: 'A  private.txt\n M public/app.js' },
  ]) {
    const git = fakeGit({ 'rev-parse': { ok: true, stdout: 'true' }, status: response });
    const result = await sync.checkAndSync({ run: git.run, force: true });
    assert.equal(result.status, response.ok ? 'staged' : 'error');
    assert.equal(git.calls.some((call) => /^(add|commit|push)\b/.test(call)), false);
  }
});

test('fetch or comparison failure keeps the local commit without pushing', async () => {
  for (const failure of ['fetch', 'rev-list']) {
    const handlers = {
      'rev-parse': { ok: true, stdout: 'true' },
      status: { ok: true, stdout: ' M public/app.js' },
      commit: { ok: true, stdout: 'committed' },
      fetch: { ok: true, stdout: '' },
      'rev-list': { ok: true, stdout: '1\t0' },
    };
    handlers[failure] = { ok: false, stderr: 'offline' };
    const git = fakeGit(handlers);
    const result = await sync.checkAndSync({ run: git.run, force: true });
    assert.equal(result.status, 'push-failed');
    assert.equal(git.calls.some((call) => call.startsWith('push')), false);
  }
});

test('real git sync commits only tracked changes outside data and refuses staged files', async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'repo-'));
  const remote = fs.mkdtempSync(path.join(tempRoot, 'remote-'));
  const git = (args, cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--bare'], remote);
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, '.gitignore'), 'data/\nignored.txt\n');
  fs.writeFileSync(path.join(dir, 'source.js'), 'before');
  fs.writeFileSync(path.join(dir, 'deleted.js'), 'delete me');
  fs.writeFileSync(path.join(dir, 'data', 'tracked.json'), 'private before');
  git(['add', '.gitignore', 'source.js', 'deleted.js']);
  git(['add', '-f', 'data/tracked.json']);
  git(['commit', '-m', 'initial']);
  git(['push', '-u', 'origin', 'main']);
  fs.writeFileSync(path.join(dir, 'source.js'), 'after');
  fs.rmSync(path.join(dir, 'deleted.js'));
  fs.writeFileSync(path.join(dir, 'data', 'tracked.json'), 'private after');
  fs.writeFileSync(path.join(dir, 'unrelated-secret.txt'), 'secret');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'ignored');
  const run = async (args) => {
    try {
      return { ok: true, stdout: git(args).trimEnd(), stderr: '' };
    } catch (error) {
      return { ok: false, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
    }
  };
  git(['add', 'unrelated-secret.txt']);
  const blocked = await sync.checkAndSync({ run, force: true });
  assert.equal(blocked.status, 'staged');
  assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1');
  git(['reset', 'HEAD', '--', 'unrelated-secret.txt']);
  const result = await sync.checkAndSync({ run, force: true });
  assert.equal(result.status, 'pushed', result.lastError);
  assert.deepEqual(git(['show', '--pretty=format:', '--name-only', 'HEAD']).trim().split('\n').sort(), ['deleted.js', 'source.js']);
  assert.equal(git(['show', 'HEAD:data/tracked.json']), 'private before');
  assert.match(git(['status', '--porcelain']), /\?\? unrelated-secret\.txt/);
  assert.match(git(['status', '--porcelain']), / M data\/tracked\.json/);
  const clean = await sync.checkAndSync({ run, force: true });
  assert.equal(clean.status, 'clean');
});
