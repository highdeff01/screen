/**
 * Automatic sync of this console's own source to GitHub.
 *
 * The console lives in a git working tree; when that tree changes, this loop
 * commits and pushes to the configured remote so the repository matches the
 * machine. It is deliberately conservative:
 *
 *   - the tree must be unchanged for two consecutive checks (no half-written
 *     files, no committing while an editor is still saving)
 *   - a conflicted tree is never committed; it reports and stops
 *   - if the remote has moved, it commits locally and reports `behind` instead
 *     of inventing a merge
 *   - `data/` stays untracked (it holds tokens and captures) because git ignores
 *     it, and the loop only ever runs `git add -A` inside the repo
 *
 * Everything is injectable so the decisions can be tested without a repo.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { db, now, ROOT } from './store.js';

const COMMIT_FOOTER =
  '🤖 Generated with Codebuff\nCo-Authored-By: Codebuff <noreply@codebuff.com>';

const state = {
  timer: null,
  intervalMs: 20000,
  busy: false,
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
          stdout: String(stdout || '').trim(),
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
  const enabled = db().settings.autoSync !== false;
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
  };
}

function commitMessage(files) {
  const shown = files.slice(0, 8).join(', ');
  const more = files.length > 8 ? ` (+${files.length - 8} more)` : '';
  return `Auto-sync console changes\n\n${shown}${more}\n\n${COMMIT_FOOTER}`;
}

/**
 * One check. Returns the status object; `deps.run` replaces git for tests and
 * `deps.force` commits without waiting for a second identical observation.
 */
export async function checkAndSync(deps = {}) {
  const run = deps.run || runGit;
  const settings = db().settings || {};
  if (settings.autoSync === false) {
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

    const status = await run(['status', '--porcelain']);
    const parsed = parseStatus(status.stdout);
    state.pending = parsed.count;
    state.files = parsed.files;

    if (parsed.conflicts.length) {
      state.status = 'conflict';
      state.lastError = `${parsed.conflicts.length} conflicted file(s) need a manual merge: ${parsed.files.slice(0, 4).join(', ')}.`;
      return gitSyncStatus();
    }
    if (!parsed.count) {
      state.status = 'clean';
      state.lastError = '';
      state.lastStatusHash = '';
      const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      if (counts.ok) {
        const [ahead, behind] = String(counts.stdout).split(/\s+/).map((value) => Number(value) || 0);
        state.ahead = ahead;
        state.behind = behind;
      }
      return gitSyncStatus();
    }

    // Wait for a second identical observation unless the operator asked now.
    const hash = createHash('md5').update(status.stdout).digest('hex');
    if (!deps.force && state.lastStatusHash !== hash) {
      state.lastStatusHash = hash;
      state.status = 'waiting';
      return gitSyncStatus();
    }

    const add = await run(['add', '-A']);
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

    const fetched = await run(['fetch', 'origin', branch], 60000);
    if (fetched.ok) {
      const counts = await run(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]);
      if (counts.ok) {
        const [ahead, behind] = String(counts.stdout).split(/\s+/).map((value) => Number(value) || 0);
        state.ahead = ahead;
        state.behind = behind;
      }
    }
    if (state.behind > 0) {
      state.status = 'behind';
      state.lastError = `origin/${branch} has ${state.behind} commit(s) that are not local; commit kept locally, no push. Merge when convenient.`;
      return gitSyncStatus();
    }

    const push = await run(['push', 'origin', branch], 120000);
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
  } catch (err) {
    state.status = 'error';
    state.lastError = err.message;
    return gitSyncStatus();
  } finally {
    state.busy = false;
  }
}

/** Do not sync for a while (used when the console is editing its own files). */
export function pauseAutoSync(ms = 60000) {
  state.pausedUntil = Date.now() + Math.max(0, Number(ms) || 0);
  return gitSyncStatus();
}

export function startAutoSync({ intervalMs } = {}) {
  const fromSettings = Number(db().settings.autoSyncIntervalMs);
  state.intervalMs = Math.max(5000, Number(intervalMs) || fromSettings || 20000);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    checkAndSync().catch((err) => {
      state.status = 'error';
      state.lastError = err.message;
    });
  }, state.intervalMs);
  state.timer.unref?.();
  return gitSyncStatus();
}

export function stopAutoSync() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return gitSyncStatus();
}

/** Used by the tests in place of the real timer. */
export { state as __gitSyncState };
