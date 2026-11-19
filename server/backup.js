/**
 * A second copy of this project on this machine, kept at the same commit as
 * GitHub — in both directions.
 *
 * The console's own sync (git-sync.js) already commits and pushes what changes
 * here, and fast-forwards what other apps pushed. This module covers the other
 * half of the request: a real folder on disk holding a checkout of the same
 * repository, so there is always a local copy that is not the working tree.
 *
 *   - GitHub → mirror: `fetch` then `merge --ff-only`. Never a reset, never a
 *     force, so a commit someone else pushed can arrive but nothing is lost.
 *   - mirror → GitHub: changes made inside the backup folder (someone editing a
 *     file there) are committed and pushed, so the two sides converge whichever
 *     one moved.
 *   - A divergence is held and reported for a person to merge. It is not
 *     "fixed" automatically.
 *   - A mirror that would delete a pile of tracked files at once is refused
 *     before anything is committed: the index is reset and the reason reported.
 *   - Every 10 seconds a cheap `git ls-remote` proves the link, with latency and
 *     consecutive failures recorded, so a dead network is visible instead of
 *     looking like a quiet project.
 *
 * The folder is opt-in (`localBackupEnabled`) because a clone costs disk and a
 * network round trip every ten seconds.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, logActivity, now, ROOT } from './store.js';

/** How many tracked deletions in one pass are too many to accept silently. */
const DEFAULT_MAX_DELETES = 25;

const state = {
  timer: null,
  intervalMs: 10000,
  enabled: false,
  busy: false,
  status: 'idle',
  mirrorPath: '',
  lastCheckAt: null,
  lastOkAt: null,
  latencyMs: null,
  consecutiveFailures: 0,
  failures: 0,
  checks: 0,
  lastError: '',
  remote: '',
  branch: 'main',
  remoteSha: '',
  localSha: '',
  mirrorSha: '',
  inSync: false,
  mirror: {
    exists: false,
    clonedAt: null,
    dirty: 0,
    ahead: 0,
    behind: 0,
    lastSyncAt: null,
    lastError: '',
  },
  held: null,
  offlineReported: false,
  history: [],
};

function runGit(args, cwd = ROOT, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || '').trimEnd(),
          stderr: String(stderr || '').trim(),
          ms: 0,
        });
      }
    );
  });
}

/** A setting that may not exist in an older database file yet. */
function setting(settings, key, fallback) {
  const value = settings?.[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

export function backupStatus() {
  const settings = db().settings || {};
  const enabled = state.enabled || backupWanted(settings);
  return {
    enabled,
    running: Boolean(state.timer),
    intervalMs: state.intervalMs,
    status: enabled ? state.status : 'disabled',
    mirrorPath: state.mirrorPath || String(settings.localBackupPath || ''),
    busy: state.busy,
    lastCheckAt: state.lastCheckAt,
    lastOkAt: state.lastOkAt,
    latencyMs: state.latencyMs,
    consecutiveFailures: state.consecutiveFailures,
    failures: state.failures,
    checks: state.checks,
    lastError: state.lastError,
    remote: state.remote,
    branch: state.branch,
    remoteSha: state.remoteSha,
    localSha: state.localSha,
    mirrorSha: state.mirrorSha,
    inSync: state.inSync,
    mirror: { ...state.mirror },
    held: state.held,
    history: state.history.slice(0, 10),
    maxDeletes: Number(setting(settings, 'autoSyncMaxDeletes', DEFAULT_MAX_DELETES)),
  };
}

function remember(status, message) {
  state.history.unshift({ at: now(), status, message: String(message || '').slice(0, 300) });
  state.history = state.history.slice(0, 10);
}

/**
 * `git status --porcelain` lines, split into the deletions and the rest. The
 * porcelain columns matter: " D" is a deleted worktree file, "D " a staged one,
 * and "R " a rename (which is not a deletion for this purpose).
 */
export function readPorcelain(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean);
  const deletions = lines.filter((line) => /^(?:D | D|DD)/.test(line)).map((line) => line.slice(3).trim());
  const modified = lines.filter((line) => !/^(?:D | D|DD)/.test(line)).map((line) => line.slice(3).trim());
  return { lines, count: lines.length, deletions, modified };
}

/**
 * The deletion guard. Returns `{allowed}` or `{allowed:false, why}`; the caller
 * refuses the pass and reports, rather than committing a mass deletion and
 * pushing it to everyone.
 */
export function deletionGuard(lines, { maxDeletes = DEFAULT_MAX_DELETES } = {}) {
  const parsed = readPorcelain(lines);
  const limit = Math.max(1, Number(maxDeletes) || DEFAULT_MAX_DELETES);
  if (parsed.deletions.length >= limit) {
    return {
      allowed: false,
      deletions: parsed.deletions,
      why: `${parsed.deletions.length} tracked file(s) would be deleted in one pass (limit ${limit}). Nothing was committed; review the folder and run a sync by hand if this is intended.`,
    };
  }
  return { allowed: true, deletions: parsed.deletions, why: '' };
}

/** The cheapest honest connection test: ask the remote which commit it has. */
export async function checkLink({ run, root = ROOT, branch = 'main', timeoutMs = 15000 } = {}) {
  const git = run || runGit;
  const started = Date.now();
  const result = await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], root, timeoutMs);
  const latencyMs = Date.now() - started;
  if (!result.ok) {
    return { ok: false, latencyMs, sha: '', error: result.stderr || result.stdout || 'git ls-remote failed.' };
  }
  const line = String(result.stdout || '').split('\n').map((entry) => entry.trim()).filter(Boolean)[0] || '';
  const sha = line.split(/\s+/)[0] || '';
  if (!sha) {
    return { ok: false, latencyMs, sha: '', error: `origin has no branch called ${branch}.` };
  }
  return { ok: true, latencyMs, sha, error: '' };
}

/** Create the mirror folder once, from the same remote the console uses. */
async function ensureMirror({ git, dir, branch }) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], dir);
  if (inside.ok && String(inside.stdout).trim() === 'true') return { ok: true, created: false };

  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  if (entries.length) {
    return {
      ok: false,
      created: false,
      error: `${dir} exists and is not empty but is not a git checkout. Pick an empty folder or remove it by hand; nothing here is ever deleted automatically.`,
    };
  }
  const remote = await git(['remote', 'get-url', 'origin']);
  const url = String(remote.stdout || '').trim();
  if (!remote.ok || !url) {
    return { ok: false, created: false, error: remote.stderr || 'No origin remote is configured, so there is nothing to mirror.' };
  }
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (err) {
    return { ok: false, created: false, error: `Could not create ${path.dirname(dir)}: ${err.message}` };
  }
  const clone = await git(['clone', url, dir], ROOT, 300000);
  if (!clone.ok) {
    return { ok: false, created: false, error: clone.stderr || clone.stdout || 'git clone failed.' };
  }
  const checkout = await git(['checkout', branch], dir);
  if (!checkout.ok && !/already on|did not match/i.test(`${checkout.stderr}\n${checkout.stdout}`)) {
    return { ok: false, created: true, error: checkout.stderr || `The mirror has no ${branch} branch.` };
  }
  state.mirror.clonedAt = now();
  state.mirror.exists = true;
  remember('cloned', `Created ${dir} from ${url}.`);
  return { ok: true, created: true };
}

async function countsAgainst(git, dir, branch) {
  const counts = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], dir);
  if (!counts.ok) return null;
  const [ahead, behind] = String(counts.stdout).split(/\s+/).map((value) => Number(value) || 0);
  return { ahead, behind };
}

/**
 * Converge the mirror with origin in whichever direction it moved. Returns a
 * small report; never throws, never force-pushes, never resets.
 */
async function syncMirror({ git, dir, branch, maxDeletes }) {
  const status = await git(['status', '--porcelain', '--untracked-files=no'], dir);
  if (!status.ok) return { ok: false, error: status.stderr || 'git status failed in the backup folder.' };
  const parsed = readPorcelain(status.stdout);
  state.mirror.dirty = parsed.count;

  if (parsed.count) {
    const guard = deletionGuard(status.stdout, { maxDeletes });
    if (!guard.allowed) {
      // Nothing is staged yet, but clear anything a person may have staged.
      await git(['reset', '--quiet'], dir);
      state.held = { at: now(), reason: 'deletions', where: 'mirror', files: guard.deletions.slice(0, 12), message: guard.why };
      state.mirror.lastError = guard.why;
      remember('held', guard.why);
      return { ok: false, held: true, error: guard.why };
    }
    const add = await git(['add', '-u'], dir);
    if (!add.ok) return { ok: false, error: add.stderr || 'git add failed in the backup folder.' };
    const commit = await git(['commit', '-m', `Backup changes to ${parsed.modified.concat(parsed.deletions).slice(0, 8).join(', ')}`], dir);
    if (!commit.ok && !/nothing to commit|no changes added/i.test(`${commit.stdout}\n${commit.stderr}`)) {
      return { ok: false, error: commit.stderr || commit.stdout || 'git commit failed in the backup folder.' };
    }
    remember('mirror-commit', `Committed ${parsed.count} file(s) changed in the backup folder.`);
  }

  const fetched = await git(['fetch', 'origin', branch], dir, 60000);
  if (!fetched.ok) return { ok: false, error: fetched.stderr || fetched.stdout || 'git fetch failed in the backup folder.' };

  const counts = await countsAgainst(git, dir, branch);
  if (!counts) return { ok: false, error: 'Could not compare the backup folder with origin.' };
  state.mirror.ahead = counts.ahead;
  state.mirror.behind = counts.behind;

  if (counts.ahead && counts.behind) {
    state.held = {
      at: now(),
      reason: 'diverged',
      where: 'mirror',
      message: `The backup folder and origin/${branch} both have commits (${counts.ahead} local, ${counts.behind} remote). Merge deliberately; nothing is reset or forced.`,
    };
    state.mirror.lastError = state.held.message;
    remember('held', state.held.message);
    return { ok: false, held: true, error: state.held.message };
  }

  if (counts.ahead) {
    const pushed = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], dir, 120000);
    if (!pushed.ok) {
      // Someone else pushed first: fetch again on the next tick and fast-forward.
      return { ok: false, error: pushed.stderr || pushed.stdout || 'git push from the backup folder failed.' };
    }
    state.mirror.lastSyncAt = now();
    remember('mirror-push', `Pushed ${counts.ahead} commit(s) from the backup folder to origin/${branch}.`);
    return { ok: true, pushed: counts.ahead, pulled: 0 };
  }

  if (counts.behind) {
    const merge = await git(['merge', '--ff-only', `origin/${branch}`], dir, 60000);
    if (!merge.ok) {
      return {
        ok: false,
        error: merge.stderr || merge.stdout || `origin/${branch} cannot fast-forward into the backup folder.`,
      };
    }
    state.mirror.lastSyncAt = now();
    state.mirror.lastError = '';
    remember('mirror-pull', `Fast-forwarded the backup folder by ${counts.behind} commit(s).`);
    return { ok: true, pushed: 0, pulled: counts.behind };
  }
  return { ok: true, pushed: 0, pulled: 0 };
}

/**
 * One pass: prove the link, converge the mirror, and say whether the working
 * tree, the mirror and GitHub are all at the same commit.
 */
export async function backupTick({ run, root = ROOT, settings = db().settings || {}, force = false } = {}) {
  const git = run || runGit;
  state.enabled = backupWanted(settings);
  if (!state.enabled && !force) {
    state.status = 'disabled';
    return backupStatus();
  }
  if (state.busy) return backupStatus();

  state.busy = true;
  state.lastCheckAt = now();
  try {
    const branch = String(setting(settings, 'localBackupBranch', '')) || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim() || 'main';
    state.branch = branch;
    state.remote = String((await git(['remote', 'get-url', 'origin'], root)).stdout || '').trim();
    state.mirrorPath = String(setting(settings, 'localBackupPath', '')).trim() || (fs.existsSync(path.join(suggestedBackupPath(), '.git')) ? suggestedBackupPath() : '');

    const link = await checkLink({ run: git, root, branch });
    state.checks += 1;
    state.latencyMs = link.latencyMs;
    if (!link.ok) {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastError = link.error;
      state.status = 'offline';
      if (state.consecutiveFailures === 3 && !state.offlineReported) {
        state.offlineReported = true;
        remember('offline', `Three connection tests failed. Last: ${link.error}`);
        logActivity('backup', `GitHub link failed three times in a row: ${link.error}`);
      }
      return backupStatus();
    }
    state.remoteSha = link.sha;
    state.consecutiveFailures = 0;
    state.offlineReported = false;
    state.lastOkAt = now();
    state.lastError = '';

    const localHead = await git(['rev-parse', 'HEAD'], root);
    state.localSha = String(localHead.stdout || '').trim();

    if (!state.mirrorPath) {
      state.status = 'no-path';
      state.lastError = 'No backup folder is configured. Set one on the Sync page to keep a local copy.';
      return backupStatus();
    }
    // A relative path is taken from the project folder, so "..\\backup" works.
    const dir = path.resolve(root, state.mirrorPath);
    if (dir === path.resolve(root)) {
      state.status = 'error';
      state.lastError = 'The backup folder cannot be the project folder itself.';
      return backupStatus();
    }

    const ready = await ensureMirror({ git, dir, branch });
    state.mirror.exists = ready.ok || state.mirror.exists;
    if (!ready.ok) {
      state.status = 'error';
      state.lastError = ready.error;
      state.mirror.lastError = ready.error;
      return backupStatus();
    }

    const synced = await syncMirror({ git, dir, branch, maxDeletes: Number(setting(settings, 'autoSyncMaxDeletes', DEFAULT_MAX_DELETES)) });
    if (!synced.ok && !synced.held) {
      state.mirror.lastError = synced.error || 'The backup folder could not be updated.';
      state.lastError = state.mirror.lastError;
    }
    if (synced.held) {
      state.status = 'held';
      state.lastError = synced.error;
      state.inSync = false;
      return backupStatus();
    }

    const mirrorHead = await git(['rev-parse', 'HEAD'], dir);
    state.mirrorSha = String(mirrorHead.stdout || '').trim();
    const remoteHead = await git(['rev-parse', 'HEAD'], root);
    state.localSha = String(remoteHead.stdout || '').trim();
    state.inSync = Boolean(state.localSha) && state.localSha === state.mirrorSha && state.localSha === state.remoteSha;
    state.status = state.inSync ? 'in-sync' : 'drift';
    if (!state.inSync) {
      state.mirror.lastError = '';
      state.lastError = [
        state.localSha !== state.remoteSha ? 'This folder is not at the GitHub commit.' : '',
        state.mirrorSha !== state.remoteSha ? 'The backup folder is not at the GitHub commit.' : '',
      ].filter(Boolean).join(' ');
    }
    return backupStatus();
  } catch (err) {
    state.failures += 1;
    state.status = 'error';
    state.lastError = err.message;
    remember('error', err.message);
    return backupStatus();
  } finally {
    state.busy = false;
  }
}

/** The "check now" button: one pass, regardless of the opt-in flag. */
export function checkBackupNow(opts = {}) {
  return backupTick({ ...opts, force: true });
}

export function startBackup({ intervalMs } = {}) {
  const settings = db().settings || {};
  state.enabled = backupWanted(settings);
  const configured = Number(intervalMs) || Number(setting(settings, 'localBackupIntervalMs', 10000)) || 10000;
  // Ten seconds by default; five is the floor, matching auto-sync.
  state.intervalMs = Math.max(5000, Math.min(600000, configured));
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    backupTick().catch((err) => {
      state.status = 'error';
      state.lastError = err.message;
    });
  }, state.intervalMs);
  state.timer.unref?.();
  return backupStatus();
}

export function stopBackup() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return backupStatus();
}

/** Where a mirror would default to if someone just turns the feature on. */
export function suggestedBackupPath() {
  return path.join(os.homedir(), 'Sightline-backup');
}

/**
 * Whether a backup pass should run. Explicit opt-in wins; when the setting was
 * never decided (`undefined`) an existing mirror folder counts as a yes, so a
 * mirror that was created on request comes alive after a restart without the
 * settings write surviving the old console's periodic save.
 */
export function backupWanted(settings = db().settings || {}) {
  if (settings.localBackupEnabled === true) return true;
  if (settings.localBackupEnabled === false) return false;
  try {
    return fs.existsSync(path.join(suggestedBackupPath(), '.git'));
  } catch {
    return false;
  }
}

export { state as __backupState };
