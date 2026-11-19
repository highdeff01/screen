/**
 * Opt-in synchronization of this console's working tree to origin.
 *
 * It stages modifications and deletions of already tracked files under the
 * console root, except data/ (runtime state, tokens and captures). It never
 * adds untracked files, even if they are not ignored. Files already tracked
 * elsewhere may still contain secrets: review the repository before enabling.
 * Any pre-existing staged changes or conflicts stop the sync for manual review,
 * including changes in data/. Existing commits may also be pushed to origin.
 *
 * Two identical content observations are required before auto-commit. Incoming
 * commits are tested in an isolated worktree and backed up before fast-forward.
 * If origin moved, the local commit is kept without a push. Git and verification
 * are injectable for testing.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, now, ROOT } from './store.js';

const COMMIT_FOOTER =
  '🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>';

const state = {
  timer: null,
  intervalMs: 10000,
  busy: false,
  autoTickBusy: false,
  status: 'idle',
  lastCheckAt: null,
  lastSyncAt: null,
  lastCommit: '',
  lastError: '',
  pending: 0,
  ahead: 0,
  behind: 0,
  files: [],
  branch: '',
  lastStatusHash: '',
  pausedUntil: 0,
  autoBranch: '',
  autoStaged: '',
  verified: null,
  verifiedSha: '',
  held: null,
};

function runGit(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: ROOT, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          // Porcelain status uses the first column; do not trim leading spaces.
          stdout: String(stdout || '').trimEnd(),
          stderr: String(stderr || '').trim(),
        });
      }
    );
  });
}

/** Read `git status --porcelain` output into the facts the loop needs. */
export function parseStatus(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const conflicts = lines.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line));
  const files = lines.map((line) => line.slice(3).trim()).filter(Boolean);
  return { lines, files, count: lines.length, conflicts };
}

export function gitSyncStatus() {
  const enabled = db().settings?.autoSync === true;
  return {
    enabled,
    running: Boolean(state.timer),
    intervalMs: state.intervalMs,
    status: enabled ? state.status : 'disabled',
    busy: state.busy,
    lastCheckAt: state.lastCheckAt,
    lastSyncAt: state.lastSyncAt,
    lastCommit: state.lastCommit,
    lastError: state.lastError,
    pending: state.pending,
    ahead: state.ahead,
    behind: state.behind,
    files: state.files.slice(0, 12),
    branch: state.branch,
    autoBranch: state.autoBranch,
    autoStaged: state.autoStaged,
    verifiedSha: state.verifiedSha,
    held: state.held,
  };
}

function commitMessage(files) {
  const shown = files.slice(0, 8).join(', ');
  const more = files.length > 8 ? ` (+${files.length - 8} more)` : '';
  return `Auto-sync console changes\n\n${shown}${more}\n\n${COMMIT_FOOTER}`;
}

/**
 * The suite verdict for one commit. Cached per commit; a failing verdict is not
 * retried for five minutes so a broken tree does not re-run the whole suite on
 * every twenty-second tick.
 */
async function verifyHead(sha, deps = {}) {
  const cached = state.verified;
  if (cached && cached.sha === sha && (cached.ok || Date.now() < (cached.retryAt || 0))) return cached;
  const verify = deps.verify || defaultVerify;
  let result;
  try {
    result = await verify(sha);
  } catch (err) {
    result = { ok: false, fail: null, failingTests: [], message: err.message };
  }
  const verdict = {
    sha,
    ok: Boolean(result?.ok),
    deferred: Boolean(result?.deferred),
    at: now(),
    fail: result?.fail ?? null,
    tests: Array.isArray(result?.failingTests) ? result.failingTests : [],
    message: result?.message || '',
  };
  if (verdict.deferred) return verdict;
  if (!verdict.ok) verdict.retryAt = Date.now() + 300000;
  state.verified = verdict;
  state.verifiedSha = sha;
  return verdict;
}

/**
 * The real check: the watchdog's verdict on the source as it is now. If it has
 * not run since the last edit, ask it for one run — never a second suite of our
 * own, which would compete with it for the machine and make both flaky.
 */
async function defaultVerify(sha) {
  const sentinel = await import('./sentinel.js');
  if (sentinel.sentinelBusy()) return { ok: false, deferred: true };
  const result = await sentinel.verifyCommit(sha);
  return {
    ok: result.ok === true,
    deferred: result.deferred === true,
    fail: result.fail ?? null,
    failingTests: result.failingTests || [],
    message: result.error || '',
  };
}

/**
 * Stage HEAD on auto/<branch> and, when the suite has passed on that exact
 * commit, fast-forward the real branch to it. Used after a fresh commit and
 * also when a clean tree still holds commits nobody pushed — a restart between
 * committing and verifying, or a push that failed, would otherwise leave them
 * ahead forever.
 */
async function stageAndPromote({ run, deps = {}, settings = {}, branch, head }) {
  const autoBranch = `auto/${branch}`;
  state.autoBranch = autoBranch;
  // The gate. `force` is the operator's explicit "push anyway"; an injected
  // `run` without `verify` is a unit test of the git plumbing, which keeps the
  // old path so those decisions stay testable without a suite.
  const gate = Boolean(deps.verify || !deps.run);
  if (gate) {
    const verdict = await verifyHead(head, deps);
    if (verdict.deferred) {
      state.status = 'verifying';
      state.lastError = `${autoBranch} has ${head.slice(0, 7)}; the suite is running, so ${branch} waits for the next check.`;
      return gitSyncStatus();
    }
    if (!verdict.ok) {
      state.status = 'held';
      state.held = { sha: head, at: now(), ok: false, fail: verdict.fail ?? null, tests: verdict.tests || [] };
      state.lastError = `${verdict.fail ?? '?'} failing test(s) on ${head.slice(0, 7)}; no remote branch was updated${
        verdict.tests?.length ? ` (first: ${verdict.tests[0]})` : ''
      }.`;
      return gitSyncStatus();
    }
    state.held = { sha: head, at: now(), ok: true };
  }

  const staged = await run(['push', 'origin', `HEAD:refs/heads/${autoBranch}`], 120000);
  if (!staged.ok) {
    state.status = 'stage-failed';
    state.lastError = staged.stderr || staged.stdout || `git push to ${autoBranch} failed.`;
    return gitSyncStatus();
  }
  state.autoStaged = head;

  const push = await run(['push', 'origin', `HEAD:refs/heads/${branch}`], 120000);
  if (!push.ok) {
    state.status = 'push-failed';
    state.lastError = push.stderr || push.stdout || 'git push failed.';
    return gitSyncStatus();
  }
  state.status = 'pushed';
  state.lastError = '';
  state.ahead = 0;
  state.lastSyncAt = now();
  state.lastStatusHash = '';
  return gitSyncStatus();
}

/**
 * One check. Returns the status object; `deps.run` replaces git for tests and
 * `deps.force` commits without waiting for a second identical observation.
 */
export async function checkAndSync(deps = {}) {
  const run = deps.run || runGit;
  const settings = db().settings || {};
  if (settings.autoSync !== true) {
    state.status = 'disabled';
    return gitSyncStatus();
  }
  if (state.busy) return gitSyncStatus();
  if (!deps.force && state.pausedUntil && Date.now() < state.pausedUntil) return gitSyncStatus();

  state.busy = true;
  state.lastCheckAt = now();
  try {
    const repo = await run(['rev-parse', '--is-inside-work-tree']);
    if (!repo.ok || String(repo.stdout).trim() !== 'true') {
      state.status = 'not-a-repo';
      state.lastError = repo.stderr || 'This folder is not a git working tree.';
      return gitSyncStatus();
    }

    // Inspect the entire index first: git commit would include *all* staged
    // entries, including newly added or ignored files outside our sync scope.
    const fullStatus = await run(['status', '--porcelain', '--untracked-files=no']);
    if (!fullStatus.ok) {
      state.status = 'error';
      state.lastError = fullStatus.stderr || 'git status failed.';
      return gitSyncStatus();
    }
    const full = parseStatus(fullStatus.stdout);
    if (full.conflicts.length) {
      state.lastStatusHash = '';
      state.status = 'conflict';
      state.lastError = `${full.conflicts.length} conflicted file(s) need a manual merge: ${full.files.slice(0, 4).join(', ')}.`;
      return gitSyncStatus();
    }
    if (full.lines.some((line) => line[0] !== ' ')) {
      state.lastStatusHash = '';
      state.status = 'staged';
      state.lastError = 'Staged changes need a manual commit or unstage before auto-sync.';
      return gitSyncStatus();
    }

    const scope = ['.', ':(exclude)data'];
    const status = await run(['status', '--porcelain', '--untracked-files=no', '--', ...scope]);
    if (!status.ok) {
      state.status = 'error';
      state.lastError = status.stderr || 'git status failed.';
      return gitSyncStatus();
    }
    const parsed = parseStatus(status.stdout);
    state.pending = parsed.count;
    state.files = parsed.files;
    if (!parsed.count) {
      state.pending = 0;
      state.files = [];
      state.status = 'clean';
      state.lastError = '';
      state.lastStatusHash = '';
      const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      if (counts.ok) {
        const [ahead, behind] = String(counts.stdout).split(/\s+/).map((value) => Number(value) || 0);
        state.ahead = ahead;
        state.behind = behind;
      }
      if (state.behind > 0) return gitSyncStatus();
      if (state.ahead > 0) {
        const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || 'main';
        const head = (await run(['rev-parse', 'HEAD'])).stdout.trim();
        state.branch = branch;
        return stageAndPromote({ run, deps, settings, branch, head });
      }
      return gitSyncStatus();
    }

    const diff = await run(['diff', '--binary', '--', ...scope]);
    if (!diff.ok) {
      state.status = 'error';
      state.lastError = diff.stderr || 'Could not inspect tracked file contents.';
      return gitSyncStatus();
    }

    // Wait for a second identical content observation unless the operator asked now.
    const hash = createHash('md5').update(`${status.stdout}\0${diff.stdout}`).digest('hex');
    if (!deps.force && state.lastStatusHash !== hash) {
      state.lastStatusHash = hash;
      state.status = 'waiting';
      return gitSyncStatus();
    }

    const add = await run(['add', '-u', '--', ...scope]);
    if (!add.ok) {
      state.status = 'error';
      state.lastError = add.stderr || 'git add failed.';
      return gitSyncStatus();
    }
    const commit = await run(['commit', '-m', commitMessage(parsed.files)]);
    if (!commit.ok && !/nothing to commit|no changes added/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      state.status = 'error';
      state.lastError = commit.stderr || commit.stdout || 'git commit failed.';
      return gitSyncStatus();
    }
    const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || 'main';
    state.branch = branch;
    state.lastCommit = commit.ok ? String(commit.stdout).split('\n')[0] : state.lastCommit;
    const head = (await run(['rev-parse', 'HEAD'])).stdout.trim();

    const fetched = await run(['fetch', 'origin', branch], 60000);
    if (!fetched.ok) {
      state.status = 'push-failed';
      state.lastError = fetched.stderr || fetched.stdout || 'git fetch failed; commit kept locally, no push.';
      return gitSyncStatus();
    }
    const counts = await run(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
    const countMatch = counts.ok && String(counts.stdout).trim().match(/^(\d+)\s+(\d+)$/);
    if (!countMatch) {
      state.status = 'push-failed';
      state.lastError = counts.stderr || 'Could not compare with origin; commit kept locally, no push.';
      return gitSyncStatus();
    }
    state.ahead = Number(countMatch[1]);
    state.behind = Number(countMatch[2]);
    if (state.behind > 0) {
      state.status = 'behind';
      state.lastError = `origin/${branch} has ${state.behind} commit(s) that are not local; commit kept locally, no push. Merge when convenient.`;
      return gitSyncStatus();
    }

    return stageAndPromote({ run, deps, settings, branch, head });
  } catch (err) {
    state.status = 'error';
    state.lastError = err.message;
    return gitSyncStatus();
  } finally {
    state.busy = false;
  }
}

/* ---------------- Manual sync: pull, merge, PRs, conflicts ---------------- */

/** owner/repo and the web URL for a remote, for `https://` and `git@` forms. */
export function parseRemote(url) {
  const text = String(url || '').trim().replace(/^git@([^:]+):/, 'https://$1/');
  const match = text.match(/^[a-z]+:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return { owner: '', repo: '', webUrl: '' };
  return { owner: match[1], repo: match[2], webUrl: `https://github.com/${match[1]}/${match[2]}` };
}

async function currentBranch(git) {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return String(branch.stdout || '').trim() || 'main';
}

async function aheadBehind(git, branch) {
  const counts = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  if (!counts.ok) return { ahead: 0, behind: 0 };
  const [ahead, behind] = String(counts.stdout).split(/\s+/).map((value) => Number(value) || 0);
  return { ahead, behind };
}

/** Files git left conflicted in the working tree. */
export async function conflictFiles({ run } = {}) {
  const git = run || runGit;
  const result = await git(['diff', '--name-only', '--diff-filter=U']);
  const files = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return { ok: result.ok, files, count: files.length };
}

/**
 * Pull the remote into this folder. Fast-forward only by default, because a
 * clean fast-forward is the one merge that cannot lose anyone's work; a
 * diverged branch is reported so it can be merged deliberately from the Sync
 * page (or by the operator).
 */
export async function pullNow({ ffOnly = true, run, verify, backup } = {}) {
  const git = run || runGit;
  const branch = await currentBranch(git);
  state.branch = branch;
  const fetched = await git(['fetch', 'origin', branch], 60000);
  if (!fetched.ok) {
    state.status = 'fetch-failed';
    state.lastError = fetched.stderr || fetched.stdout || 'git fetch failed.';
    return { ok: false, status: 'fetch-failed', message: state.lastError };
  }
  const { ahead, behind } = await aheadBehind(git, branch);
  state.ahead = ahead;
  state.behind = behind;
  if (!behind) {
    state.status = 'clean';
    return { ok: true, status: 'up-to-date', behind: 0, ahead, message: `Already up to date with origin/${branch}.` };
  }
  if (ffOnly && ahead) {
    state.status = 'diverged';
    state.lastError = `Local and origin/${branch} both have commits; merge from the Sync page to combine them.`;
    return { ok: false, status: 'diverged', behind, ahead, message: state.lastError };
  }
  if (ffOnly) {
    const remoteHead = await git(['rev-parse', `origin/${branch}`]);
    const sha = String(remoteHead.stdout || '').trim();
    if (!remoteHead.ok || !sha) {
      state.status = 'error';
      state.lastError = remoteHead.stderr || 'Could not read the remote commit.';
      return { ok: false, status: 'error', message: state.lastError };
    }
    const verdict = await verifyHead(sha, { run, verify });
    if (verdict.deferred) {
      state.status = 'verifying';
      state.lastError = `origin/${branch} has ${sha.slice(0, 7)}; testing is in progress.`;
      return { ok: false, status: 'verifying', message: state.lastError };
    }
    if (!verdict.ok) {
      state.status = 'held';
      state.lastError = `Remote commit ${sha.slice(0, 7)} failed testing; local files were not updated.`;
      return { ok: false, status: 'held', message: state.lastError };
    }
    const takeSnapshot = backup || (async () => {
      const snapshots = await import('./snapshots.js');
      return snapshots.createSnapshot(`before sync from ${branch}`);
    });
    const safety = await takeSnapshot();
    if (!safety?.ok) {
      state.status = 'backup-failed';
      state.lastError = safety?.message || 'Could not create a recovery snapshot; remote changes were not applied.';
      return { ok: false, status: 'backup-failed', message: state.lastError };
    }
  }
  const merge = await git(ffOnly ? ['merge', '--ff-only', `origin/${branch}`] : ['merge', '--no-edit', `origin/${branch}`], 60000);
  if (!merge.ok) {
    const conflicts = await conflictFiles({ run: git });
    state.status = conflicts.count ? 'conflict' : 'merge-failed';
    state.lastError = conflicts.count
      ? `${conflicts.count} conflicted file(s): ${conflicts.files.slice(0, 4).join(', ')}.`
      : merge.stderr || merge.stdout || 'git merge failed.';
    return { ok: false, status: conflicts.count ? 'conflict' : 'merge-failed', conflicts: conflicts.files, message: state.lastError };
  }
  state.behind = 0;
  state.lastSyncAt = now();
  state.status = 'pulled';
  state.lastError = '';
  return {
    ok: true,
    status: 'pulled',
    behind,
    message: `Pulled ${behind} commit(s) from origin/${branch}.`,
    files: String(merge.stdout || '').split('\n').filter((line) => line.includes('|')).length,
  };
}

/** Push local commits. */
export async function pushNow({ run } = {}) {
  const git = run || runGit;
  const branch = await currentBranch(git);
  state.branch = branch;
  const pushed = await git(['push', 'origin', branch], 120000);
  if (!pushed.ok) {
    state.status = 'push-failed';
    state.lastError = pushed.stderr || pushed.stdout || 'git push failed.';
    return { ok: false, status: 'push-failed', message: state.lastError };
  }
  state.ahead = 0;
  state.lastSyncAt = now();
  state.status = 'pushed';
  state.lastError = '';
  return { ok: true, status: 'pushed', message: `Pushed to origin/${branch}.` };
}

/** Merge the remote branch into the local one, reporting conflicts instead of guessing. */
export async function mergeOrigin({ run } = {}) {
  const git = run || runGit;
  const branch = await currentBranch(git);
  state.branch = branch;
  const fetched = await git(['fetch', 'origin', branch], 60000);
  if (!fetched.ok) {
    state.status = 'fetch-failed';
    state.lastError = fetched.stderr || fetched.stdout || 'git fetch failed.';
    return { ok: false, status: 'fetch-failed', message: state.lastError };
  }
  const merge = await git(['merge', '--no-edit', `origin/${branch}`], 60000);
  const conflicts = await conflictFiles({ run: git });
  if (conflicts.count) {
    state.status = 'conflict';
    state.lastError = `${conflicts.count} conflicted file(s) need a decision.`;
    return { ok: false, status: 'conflict', conflicts: conflicts.files, message: state.lastError };
  }
  if (!merge.ok) {
    state.status = 'merge-failed';
    state.lastError = merge.stderr || merge.stdout || 'git merge failed.';
    return { ok: false, status: 'merge-failed', message: state.lastError };
  }
  const counts = await aheadBehind(git, branch);
  state.ahead = counts.ahead;
  state.behind = counts.behind;
  state.status = 'merged';
  state.lastError = '';
  return { ok: true, status: 'merged', message: `Merged origin/${branch} into ${branch}. Push when the tests pass.` };
}

/**
 * Open pull requests, read without the GitHub CLI: the refs GitHub publishes for
 * every PR are visible with a plain `git ls-remote`.
 */
export async function listPullRequests({ run, limit = 10 } = {}) {
  const git = run || runGit;
  const remote = parseRemote((await git(['remote', 'get-url', 'origin'])).stdout);
  if (!remote.owner) return { ok: false, status: 'no-remote', available: false, prs: [], message: 'No GitHub remote is configured.' };
  const refs = await git(['ls-remote', 'origin', 'refs/pull/*/head'], 60000);
  if (!refs.ok) return { ok: false, available: false, prs: [], message: refs.stderr || 'git ls-remote failed.' };
  const prs = String(refs.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/\s+/);
      const number = Number((String(ref).match(/refs\/pull\/(\d+)\/head/) || [])[1]);
      return number ? { number, sha: String(sha).slice(0, 12), url: `${remote.webUrl}/pull/${number}` } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.number - a.number)
    .slice(0, Math.max(1, Math.min(30, Number(limit) || 10)));
  return { ok: true, available: true, remote: remote.webUrl, prs, message: prs.length ? `${prs.length} open pull request(s).` : 'No open pull requests.' };
}

/** Fetch one PR into a local branch so it can be run, reviewed or merged. */
export async function fetchPullRequest(number, { run } = {}) {
  const git = run || runGit;
  const id = Math.max(1, Number(number) || 0);
  if (!id) return { ok: false, message: 'A pull request number is required.' };
  const branch = `pr/${id}`;
  const fetched = await git(['fetch', 'origin', `refs/pull/${id}/head:${branch}`], 120000);
  if (!fetched.ok) {
    state.lastError = fetched.stderr || fetched.stdout || 'git fetch failed.';
    return { ok: false, status: 'fetch-failed', message: state.lastError };
  }
  const log = await git(['log', '-1', '--pretty=%s', branch]);
  return { ok: true, status: 'fetched', branch, subject: String(log.stdout || '').trim(), message: `Fetched pull request #${id} into ${branch}.` };
}

/** Resolve every conflicted file to one side, then stage it. */
export async function resolveConflicts({ side = 'ours', files = null, run } = {}) {
  const git = run || runGit;
  const which = side === 'theirs' ? 'theirs' : 'ours';
  const conflicts = files?.length ? { files, count: files.length } : await conflictFiles({ run: git });
  if (!conflicts.count) return { ok: true, status: 'no-conflicts', resolved: [], message: 'There are no conflicted files.' };
  const resolved = [];
  const failed = [];
  for (const file of conflicts.files) {
    const checkout = await git(['checkout', `--${which}`, '--', file]);
    const add = checkout.ok ? await git(['add', '--', file]) : { ok: false };
    if (checkout.ok && add.ok) resolved.push(file);
    else failed.push(file);
  }
  state.status = failed.length ? state.status : 'conflicts-resolved';
  return {
    ok: failed.length === 0,
    status: failed.length ? 'partial' : 'resolved',
    side: which,
    resolved,
    failed,
    message: `${resolved.length} file(s) resolved with ${which}${failed.length ? `, ${failed.length} failed` : ''}. Review, then commit the merge.`,
  };
}

/**
 * Ask the local model to merge each conflicted file, keeping a backup first and
 * refusing any reply that still contains conflict markers.
 */
export async function aiResolveConflicts({ run, chat: talk = null } = {}) {
  const git = run || runGit;
  const conflicts = await conflictFiles({ run: git });
  if (!conflicts.count) return { ok: true, status: 'no-conflicts', resolved: [], message: 'There are no conflicted files.' };
  let ask = talk;
  if (!ask) {
    const mod = await import('./llm.js');
    ask = async (messages) => mod.chat(messages, { timeoutMs: 90000 });
  }
  const backups = [];
  const resolved = [];
  const skipped = [];
  for (const file of conflicts.files) {
    const absolute = path.join(ROOT, file);
    let original = '';
    try {
      original = fs.readFileSync(absolute, 'utf8');
    } catch (err) {
      skipped.push({ file, reason: `unreadable: ${err.message}` });
      continue;
    }
    const reply = await ask([
      {
        role: 'system',
        content:
          'Merge git conflict markers. Reply with the complete merged file content only: no prose, no code fences, and no conflict markers. Preserve both sides where they do not contradict.',
      },
      { role: 'user', content: `File: ${file}\n\n${original.slice(0, 12000)}` },
    ]);
    const merged = reply?.ok ? String(reply.content || '').trim() : '';
    if (!merged || /^(<<<<<<<|=======|>>>>>>>)/m.test(merged)) {
      skipped.push({ file, reason: reply?.ok ? 'the model returned conflict markers or an empty file' : reply?.error || 'the model is offline' });
      continue;
    }
    fs.mkdirSync(path.join(DATA, 'git-backups'), { recursive: true });
    const backup = path.join(DATA, 'git-backups', `${Date.now()}-${file.replace(/[\\/]/g, '_')}`);
    fs.writeFileSync(backup, original);
    fs.writeFileSync(absolute, `${merged}\n`);
    const add = await git(['add', '--', file]);
    if (!add.ok) {
      skipped.push({ file, reason: add.stderr || 'git add failed' });
      continue;
    }
    backups.push(path.relative(ROOT, backup).split(path.sep).join('/'));
    resolved.push(file);
  }
  const remaining = await conflictFiles({ run: git });
  return {
    ok: resolved.length > 0 && remaining.count === 0,
    status: remaining.count ? 'partial' : 'resolved',
    resolved,
    skipped,
    backups,
    remaining: remaining.files,
    message: `${resolved.length} file(s) merged by the model${skipped.length ? `, ${skipped.length} left alone` : ''}${
      backups.length ? `; originals in ${backups[0]}` : ''
    }. Review the diff, then commit.`,
  };
}

/** Commit a finished merge (only when no conflicts remain). */
export async function commitMerge({ run } = {}) {
  const git = run || runGit;
  const conflicts = await conflictFiles({ run: git });
  if (conflicts.count) return { ok: false, status: 'conflict', message: `${conflicts.count} file(s) are still conflicted.` };
  const commit = await git(['commit', '--no-edit']);
  if (!commit.ok && !/nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
    return { ok: false, status: 'error', message: commit.stderr || commit.stdout || 'git commit failed.' };
  }
  const branch = await currentBranch(git);
  const counts = await aheadBehind(git, branch);
  state.ahead = counts.ahead;
  state.behind = counts.behind;
  state.status = 'merged';
  state.lastError = '';
  return { ok: true, status: 'merged', message: `Merge committed on ${branch}. ${counts.ahead} commit(s) ready to push.` };
}

/** Everything the Sync page needs in one read. */
export async function syncOverview({ run } = {}) {
  const git = run || runGit;
  const remote = parseRemote((await git(['remote', 'get-url', 'origin'])).stdout);
  const branch = await currentBranch(git);
  const fetched = await git(['fetch', 'origin', branch], 60000);
  const counts = fetched.ok ? await aheadBehind(git, branch) : { ahead: state.ahead, behind: state.behind };
  if (fetched.ok) {
    state.ahead = counts.ahead;
    state.behind = counts.behind;
    state.branch = branch;
  }
  const conflicts = await conflictFiles({ run: git });
  if (conflicts.count) state.status = 'conflict';
  return {
    ok: true,
    git: gitSyncStatus(),
    branch,
    remote: remote.webUrl,
    ahead: counts.ahead,
    behind: counts.behind,
    conflicts: conflicts.files,
    pulledAt: fetched.ok ? now() : null,
    note: fetched.ok ? '' : fetched.stderr || 'git fetch failed',
  };
}

/** Do not sync for a while (used when the console is editing its own files). */
export function pauseAutoSync(ms = 60000) {
  state.pausedUntil = Date.now() + Math.max(0, Number(ms) || 0);
  return gitSyncStatus();
}

export function startAutoSync({ intervalMs } = {}) {
  const fromSettings = Number(db().settings.autoSyncIntervalMs);
  state.intervalMs = Math.max(5000, Number(intervalMs) || fromSettings || 10000);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    autoTick().catch((err) => {
      state.status = 'error';
      state.lastError = err.message;
    });
  }, state.intervalMs);
  state.timer.unref?.();
  return gitSyncStatus();
}

/**
 * One automatic pass: test before publishing local commits, then test, snapshot,
 * and fast-forward remote updates. Diverged branches wait for manual review.
 */
async function autoTick(deps = {}) {
  const status = await checkAndSync(deps);
  if (state.autoTickBusy) return gitSyncStatus();
  state.autoTickBusy = true;
  try {
    return await autoPull(status, deps);
  } finally {
    state.autoTickBusy = false;
  }
}

async function autoPull(status, deps = {}) {
  const run = deps.run || runGit;
  if (db().settings.autoPull === false) return status;
  if (state.busy || status.pending || ['conflict', 'error', 'waiting', 'staged', 'held', 'verifying', 'push-failed'].includes(status.status)) return status;

  const worktree = await run(['status', '--porcelain']);
  if (!worktree.ok) return gitSyncStatus();
  if (worktree.stdout) {
    state.status = 'dirty';
    state.lastError = 'Remote updates are waiting until local tracked and untracked changes are resolved.';
    return gitSyncStatus();
  }

  const branchResult = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(branchResult.stdout || '').trim();
  if (!branchResult.ok || !branch) {
    state.status = 'error';
    state.lastError = branchResult.stderr || 'Could not determine the current branch.';
    return gitSyncStatus();
  }
  state.branch = branch;

  const fetched = await run(['fetch', 'origin', branch], 60000);
  if (!fetched.ok) {
    state.status = 'fetch-failed';
    state.lastError = fetched.stderr || fetched.stdout || 'Could not fetch the remote branch.';
    return gitSyncStatus();
  }
  const counts = await run(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
  const countMatch = counts.ok && String(counts.stdout).trim().match(/^(\d+)\s+(\d+)$/);
  if (!countMatch) {
    state.status = 'error';
    state.lastError = counts.stderr || 'Could not compare the local and remote branches.';
    return gitSyncStatus();
  }
  state.ahead = Number(countMatch[1]);
  state.behind = Number(countMatch[2]);
  if (!state.behind) return gitSyncStatus();
  if (state.ahead) {
    state.status = 'diverged';
    state.lastError = `Local and origin/${branch} have diverged; merge them manually.`;
    return gitSyncStatus();
  }

  const remoteHead = await run(['rev-parse', `origin/${branch}`]);
  const sha = String(remoteHead.stdout || '').trim();
  if (!remoteHead.ok || !sha) {
    state.status = 'error';
    state.lastError = remoteHead.stderr || 'Could not read the remote commit.';
    return gitSyncStatus();
  }
  const verdict = await verifyHead(sha, deps);
  if (verdict.deferred) {
    state.status = 'verifying';
    state.lastError = `origin/${branch} has ${sha.slice(0, 7)}; testing is in progress.`;
    return gitSyncStatus();
  }
  if (!verdict.ok) {
    state.status = 'held';
    state.held = { sha, at: now(), ok: false, fail: verdict.fail ?? null, tests: verdict.tests || [] };
    state.lastError = `Remote commit ${sha.slice(0, 7)} failed testing; local files were not updated${verdict.tests?.length ? ` (first: ${verdict.tests[0]})` : ''}.`;
    return gitSyncStatus();
  }

  const backup = deps.backup || (async () => {
    const snapshots = await import('./snapshots.js');
    return snapshots.createSnapshot(`before sync from ${branch}`);
  });
  const safety = await backup();
  if (!safety?.ok) {
    state.status = 'backup-failed';
    state.lastError = safety?.message || 'Could not create a recovery snapshot; remote changes were not applied.';
    return gitSyncStatus();
  }

  const pulled = await run(['merge', '--ff-only', `origin/${branch}`], 60000);
  if (!pulled.ok) {
    const conflicts = await conflictFiles({ run });
    state.status = conflicts.count ? 'conflict' : 'pull-failed';
    state.lastError = conflicts.count
      ? `${conflicts.count} conflicted file(s): ${conflicts.files.slice(0, 4).join(', ')}.`
      : pulled.stderr || pulled.stdout || `Could not fast-forward ${branch}.`;
    return gitSyncStatus();
  }
  state.status = 'pulled';
  state.behind = 0;
  state.lastError = '';
  state.lastSyncAt = now();
  return gitSyncStatus();
}

export { autoTick };

export function stopAutoSync() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return gitSyncStatus();
}

/** Used by the tests in place of the real timer. */
export { state as __gitSyncState };
