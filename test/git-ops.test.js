import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const git = await load('server/git-sync.js');

/**
 * A scripted stand-in for git: the first matching fragment decides the reply, so
 * each test describes only the commands it cares about.
 */
function scripted(rules) {
  const calls = [];
  const run = async (args) => {
    const line = args.join(' ');
    calls.push(line);
    const rule = rules.find(([fragment]) => line.includes(fragment));
    const reply = rule ? rule[1] : { ok: true, stdout: '', stderr: '' };
    return typeof reply === 'function' ? reply(args, line) : { ok: true, stdout: '', stderr: '', ...reply };
  };
  return { run, calls };
}

const BRANCH = ['rev-parse --abbrev-ref', { stdout: 'main' }];
const REMOTE = ['remote get-url origin', { stdout: 'https://github.com/highdeff01/screen.git' }];
const FETCH_OK = ['fetch origin main', { stdout: '' }];

test('parseRemote understands https and ssh remotes', () => {
  assert.deepEqual(git.parseRemote('https://github.com/highdeff01/screen.git'), {
    owner: 'highdeff01',
    repo: 'screen',
    webUrl: 'https://github.com/highdeff01/screen',
  });
  assert.equal(git.parseRemote('git@github.com:highdeff01/screen.git').webUrl, 'https://github.com/highdeff01/screen');
  assert.equal(git.parseRemote('').webUrl, '');
});

test('pull does nothing when the folder already matches the remote', async () => {
  const { run, calls } = scripted([BRANCH, FETCH_OK, ['rev-list', { stdout: '0\t0' }]]);
  const result = await git.pullNow({ run });
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.ok, true);
  assert.ok(!calls.some((line) => line.startsWith('merge')), 'no merge when there is nothing to take');
});

test('pull fast-forwards commits another app pushed', async () => {
  const { run, calls } = scripted([
    BRANCH,
    FETCH_OK,
    ['rev-list', { stdout: '0\t3' }],
    ['rev-parse origin/main', { stdout: 'abc123' }],
    ['merge --ff-only origin/main', { stdout: 'Updating a1..b2\n file.js | 4 ++\n' }],
  ]);
  const result = await git.pullNow({ run, verify: async (sha) => ({ ok: sha === 'abc123' }), backup: async () => ({ ok: true }) });
  assert.equal(result.status, 'pulled');
  assert.match(result.message, /Pulled 3 commit\(s\) from origin\/main/);
  assert.ok(calls.includes('merge --ff-only origin/main'));
});

test('pull holds a failing remote commit before taking a snapshot or merging', async () => {
  const { run, calls } = scripted([
    BRANCH,
    FETCH_OK,
    ['rev-list', { stdout: '0\t1' }],
    ['rev-parse origin/main', { stdout: 'bad123' }],
  ]);
  const result = await git.pullNow({ run, verify: async () => ({ ok: false }), backup: async () => ({ ok: true }) });
  assert.equal(result.status, 'held');
  assert.ok(!calls.some((line) => line.startsWith('merge')));
});

test('pull refuses to rewrite a diverged branch', async () => {
  const { run, calls } = scripted([BRANCH, FETCH_OK, ['rev-list', { stdout: '2\t3' }]]);
  const result = await git.pullNow({ run });
  assert.equal(result.status, 'diverged');
  assert.equal(result.ok, false);
  assert.ok(!calls.some((line) => line.startsWith('merge')), 'a diverged branch waits for an explicit merge');
});

test('pull reports the files a merge could not settle', async () => {
  const { run } = scripted([
    BRANCH,
    FETCH_OK,
    ['rev-list', { stdout: '0\t1' }],
    ['rev-parse origin/main', { stdout: 'def456' }],
    ['merge --ff-only', { ok: false, stderr: 'CONFLICT (content): Merge conflict in server/index.js' }],
    ['diff --name-only --diff-filter=U', { stdout: 'server/index.js\nREADME.md\n' }],
  ]);
  const result = await git.pullNow({ run, verify: async () => ({ ok: true }), backup: async () => ({ ok: true }) });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts, ['server/index.js', 'README.md']);
  assert.match(result.message, /2 conflicted file/);
});

test('mergeOrigin combines both sides and reports a clean merge', async () => {
  const { run } = scripted([
    BRANCH,
    FETCH_OK,
    ['merge --no-edit origin/main', { ok: true }],
    ['diff --name-only --diff-filter=U', { stdout: '' }],
    ['rev-list', { stdout: '1\t0' }],
  ]);
  const result = await git.mergeOrigin({ run });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'merged');
});

test('push reports a rejected push instead of claiming success', async () => {
  const { run } = scripted([BRANCH, ['push origin main', { ok: false, stderr: 'rejected (fetch first)' }]]);
  const result = await git.pushNow({ run });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'push-failed');
  assert.match(result.message, /fetch first/);
});

test('pull requests are read from the refs GitHub publishes', async () => {
  const { run } = scripted([
    REMOTE,
    [
      'ls-remote origin refs/pull/*/head',
      { stdout: 'aaaa1111\trefs/pull/7/head\nbbbb2222\trefs/pull/12/head\n' },
    ],
  ]);
  const result = await git.listPullRequests({ run });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.prs.map((pr) => pr.number),
    [12, 7],
    'newest first'
  );
  assert.equal(result.prs[0].url, 'https://github.com/highdeff01/screen/pull/12');
});

test('resolving conflicts takes one side and stages the file', async () => {
  const { run, calls } = scripted([
    ['diff --name-only --diff-filter=U', { stdout: 'server/index.js\n' }],
    ['checkout --theirs -- server/index.js', { ok: true }],
    ['add -- server/index.js', { ok: true }],
  ]);
  const result = await git.resolveConflicts({ side: 'theirs', run });
  assert.equal(result.ok, true);
  assert.equal(result.side, 'theirs');
  assert.deepEqual(result.resolved, ['server/index.js']);
  assert.ok(calls.includes('checkout --theirs -- server/index.js'));
});

test('the overview reads branch, counts and conflicts in one pass', async () => {
  const { run } = scripted([
    REMOTE,
    BRANCH,
    FETCH_OK,
    ['rev-list', { stdout: '1\t4' }],
    ['diff --name-only --diff-filter=U', { stdout: '' }],
  ]);
  const overview = await git.syncOverview({ run });
  assert.equal(overview.ok, true);
  assert.equal(overview.branch, 'main');
  assert.equal(overview.ahead, 1);
  assert.equal(overview.behind, 4);
  assert.deepEqual(overview.conflicts, []);
  assert.equal(overview.remote, 'https://github.com/highdeff01/screen');
});
