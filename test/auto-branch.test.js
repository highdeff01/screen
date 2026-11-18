import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-autobranch-'));
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
  sync.__gitSyncState.verified = null;
  sync.__gitSyncState.held = null;
  store.db().settings.autoSync = true;
});

const HEAD = 'abcdef1234567890';

/** A scripted git that answers by subcommand and records every call. */
function fakeGit({ head = HEAD, pushOk = true, dirty = ' M public/app.js' } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    switch (args[0]) {
      case 'rev-parse':
        if (args.includes('--is-inside-work-tree')) return { ok: true, stdout: 'true', stderr: '' };
        if (args.includes('--abbrev-ref')) return { ok: true, stdout: 'main', stderr: '' };
        return { ok: true, stdout: head, stderr: '' };
      case 'status':
        return { ok: true, stdout: dirty, stderr: '' };
      case 'commit':
        return { ok: true, stdout: '[main abc1234] Auto-sync console changes', stderr: '' };
      case 'rev-list':
        return { ok: true, stdout: '1\t0', stderr: '' };
      case 'push':
        return pushOk ? { ok: true, stdout: 'ok', stderr: '' } : { ok: false, stdout: '', stderr: 'rejected' };
      default:
        return { ok: true, stdout: '', stderr: '' };
    }
  };
  return { run, calls };
}

const mainPushes = (calls) => calls.filter((call) => call === 'push origin HEAD:refs/heads/main');
const autoPushes = (calls) => calls.filter((call) => call === 'push --force origin HEAD:refs/heads/auto/main');

test('a failing commit stays on auto/main and main is never pushed', async () => {
  const git = fakeGit();
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    return { ok: false, fail: 2, failingTests: ['boot renders state without waiting', 'poll keeps the view fresh'] };
  };
  await sync.checkAndSync({ run: git.run, verify });
  const status = await sync.checkAndSync({ run: git.run, verify });

  assert.equal(status.status, 'held');
  assert.equal(status.autoBranch, 'auto/main');
  assert.equal(status.autoStaged, HEAD);
  assert.equal(status.held.sha, HEAD);
  assert.equal(autoPushes(git.calls).length, 1, 'the commit is staged on auto/main');
  assert.deepEqual(mainPushes(git.calls), [], 'main is held back');
  assert.match(status.lastError, /held back until the suite passes/);
  assert.equal(verifications, 1);
});

test('the same failing commit is not re-verified on every tick', async () => {
  const git = fakeGit();
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    return { ok: false, fail: 1, failingTests: ['one'] };
  };
  await sync.checkAndSync({ run: git.run, verify });
  await sync.checkAndSync({ run: git.run, verify });
  await sync.checkAndSync({ run: git.run, verify });
  assert.equal(verifications, 1);
  assert.equal(mainPushes(git.calls).length, 0);
});

test('a passing verdict fast-forwards main', async () => {
  const git = fakeGit();
  const verify = async () => ({ ok: true, fail: 0, failingTests: [] });
  await sync.checkAndSync({ run: git.run, verify });
  const status = await sync.checkAndSync({ run: git.run, verify });
  assert.equal(status.status, 'pushed');
  assert.equal(status.verifiedSha, HEAD);
  assert.equal(autoPushes(git.calls).length, 1);
  assert.deepEqual(mainPushes(git.calls), ['push origin HEAD:refs/heads/main']);
  assert.equal(status.ahead, 0);
});

test('an operator pushing now skips the gate but still stages first', async () => {
  const git = fakeGit();
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    return { ok: false, fail: 9, failingTests: [] };
  };
  const status = await sync.checkAndSync({ run: git.run, verify, force: true });
  assert.equal(status.status, 'pushed');
  assert.equal(verifications, 0, 'force means the operator already decided');
  assert.equal(autoPushes(git.calls).length, 1);
  assert.equal(mainPushes(git.calls).length, 1);
});

test('a verifier that throws holds main instead of pushing', async () => {
  const git = fakeGit();
  await sync.checkAndSync({
    run: git.run,
    verify: async () => {
      throw new Error('npm test could not start');
    },
  });
  const status = await sync.checkAndSync({
    run: git.run,
    verify: async () => {
      throw new Error('npm test could not start');
    },
  });
  assert.equal(status.status, 'held');
  assert.deepEqual(mainPushes(git.calls), []);
});

test('a suite that is already running defers the promotion', async () => {
  const git = fakeGit();
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    return { ok: false, deferred: true };
  };
  await sync.checkAndSync({ run: git.run, verify });
  const first = await sync.checkAndSync({ run: git.run, verify });
  assert.equal(first.status, 'verifying');
  assert.deepEqual(mainPushes(git.calls), []);
  const second = await sync.checkAndSync({ run: git.run, verify });
  assert.equal(second.status, 'verifying');
  assert.equal(verifications, 2, 'a deferred verdict is not cached');
});

test('a failed staging push stops before verification', async () => {
  const git = fakeGit({ pushOk: false });
  let verifications = 0;
  const verify = async () => {
    verifications += 1;
    return { ok: true };
  };
  await sync.checkAndSync({ run: git.run, verify });
  const status = await sync.checkAndSync({ run: git.run, verify });
  assert.equal(status.status, 'stage-failed');
  assert.equal(verifications, 0);
  assert.equal(mainPushes(git.calls).length, 0);
  assert.match(status.lastError, /rejected|auto\/main/);
});
