/**
 * Sentinel — the console watching itself.
 *
 * When this project's source files change, the test suite runs in a separate
 * process, so the console never blocks and never runs tests inside its own
 * process. What happens with the result is deliberate:
 *
 *   - a passing run is recorded and the failure queue is left alone
 *   - a failing run is queued for repair, a must-check report is written to
 *     `must-check/` (a tracked folder, so auto-sync carries it to GitHub where
 *     other agents and apps read it), and a handoff note is left for the next
 *     agent
 *   - if the model is reachable, a repair plan is drafted for each new failure
 *     and attached to the queue item — suggestions only; the console never
 *     edits its own source files without the operator
 *   - "Push fix" lets the operator (or a trusted run) commit the current tree
 *     and push it, reusing the same conservative sync path as the Sync page
 *
 * Everything that touches the outside world is injectable, so the decisions can
 * be tested without spawning processes or a git remote.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, logActivity, now, persist, ROOT, uid } from './store.js';
import { addNote } from './handoff.js';

const MUST_CHECK_DIR = 'must-check';
const OUTPUT_LIMIT = 8000;
const RUN_LIMIT = 30;
const FAILURE_LIMIT = 20;
const REPORT_LIMIT = 40;

/** Folders and files worth watching; data/ holds machine state and is skipped. */
const WATCH_ROOTS = ['public', 'server', 'test', 'bin', 'examples', 'package.json'];
const IGNORED = /(^|[\\/])(node_modules|\.git|\.freebuff|data|must-check)([\\/]|$)|\.log$|\.pid$|~$|(^|[\\/])tmp-|-tmp/;
/** Machine state and dependencies never belong in a run's worktree. */
const OVERLAY_SKIP = /^(data|node_modules|\.git|\.freebuff)([\\/]|$)/;

const state = {
  watchers: [],
  watching: false,
  busy: false,
  pending: new Set(),
  settleTimer: null,
  lastChangeAt: null,
  lastRunAt: null,
  lastRun: null,
  lastError: '',
  cooldownUntil: 0,
  worktreeOk: null,
};

export function sentinelSettings() {
  const d = db();
  if (!d.settings.sentinel || typeof d.settings.sentinel !== 'object') d.settings.sentinel = {};
  const s = d.settings.sentinel;
  if (s.enabled === undefined) s.enabled = true;
  if (!Number(s.cooldownMs)) s.cooldownMs = 60000;
  if (!Number(s.timeoutMs)) s.timeoutMs = 600000;
  if (!s.testCommand) s.testCommand = 'npm test';
  if (s.autoPlan === undefined) s.autoPlan = true;
  if (s.showWindow === undefined) s.showWindow = false;
  // The suite runs in a git worktree copy by default, so a half-saved file or a
  // running console never changes what the tests see.
  if (s.worktree === undefined) s.worktree = true;
  return s;
}

export function sentinelStatus() {
  const settings = sentinelSettings();
  const d = db();
  if (!d.sentinel || typeof d.sentinel !== 'object') d.sentinel = { runs: [], failures: [] };
  if (!Array.isArray(d.sentinel.runs)) d.sentinel.runs = [];
  if (!Array.isArray(d.sentinel.failures)) d.sentinel.failures = [];
  const failures = d.sentinel.failures;
  return {
    enabled: settings.enabled !== false,
    watching: state.watching,
    busy: state.busy,
    cooldownMs: settings.cooldownMs,
    autoPlan: settings.autoPlan !== false,
    showWindow: settings.showWindow === true,
    worktree: settings.worktree !== false,
    worktreeAvailable: state.worktreeOk,
    queueFile: queueFilePath(),
    lastChangeAt: state.lastChangeAt,
    lastRunAt: state.lastRunAt,
    lastRun: state.lastRun,
    lastError: state.lastError,
    pendingFiles: state.pending.size,
    openFailures: failures.filter((f) => f.status === 'queued' || f.status === 'planned').length,
    failures,
    runs: d.sentinel.runs.slice(-8).reverse(),
  };
}

/* ---------------- parsing ---------------- */

/** Read the node --test spec output into totals and failing test names. */
export function parseTestOutput(text) {
  const lines = String(text || '').split('\n');
  const grab = (label) => {
    const match = [...lines].reverse().find((line) => line.includes(`ℹ ${label}`));
    const value = match ? (String(match).match(new RegExp(`ℹ ${label}\\s+(\\d+)`)) || [])[1] : undefined;
    return value === undefined ? null : Number(value);
  };
  const failing = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('✖') || trimmed.includes('failing tests:')) continue;
    const name = trimmed.replace(/^✖\s*/, '').trim();
    if (name && !failing.includes(name)) failing.push(name);
  }
  return {
    tests: grab('tests'),
    pass: grab('pass'),
    fail: grab('fail') ?? (failing.length ? failing.length : null),
    failingTests: failing,
  };
}

/* ---------------- running the suite ---------------- */

function runCommand(command, { cwd = ROOT, timeoutMs = 600000, showWindow = false } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      { cwd, shell: true, timeout: Math.max(5000, timeoutMs), windowsHide: !showWindow, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          output: `${String(stdout || '')}\n${String(stderr || '')}`.slice(-OUTPUT_LIMIT),
          timedOut: Boolean(error && error.killed),
        });
      }
    );
    child.on('error', () => {}); // handled by the close/error callback above
  });
}

/* ---------------- isolated runs: a git worktree per run ---------------- */

function runGit(args, cwd = ROOT, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

async function headSha() {
  const rev = await runGit(['rev-parse', 'HEAD']);
  return rev.ok ? rev.stdout.trim().slice(0, 12) : '';
}

/**
 * Copy this folder's uncommitted work into a fresh worktree, so the suite tests
 * the source as it is right now without touching the tree the console serves
 * from. `git status --porcelain -z` lists everything that differs from HEAD;
 * ignored paths (data/, node_modules) never appear in it.
 */
export async function overlayWorkingTree(dir, { run } = {}) {
  const git = run || ((args) => runGit(args, ROOT));
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all']);
  if (!status.ok) {
    return { ok: false, copied: 0, removed: 0, skipped: 0, error: status.stderr.trim() || 'git status failed' };
  }
  const tokens = String(status.stdout || '').split('\0');
  let copied = 0;
  let removed = 0;
  let skipped = 0;
  const drop = (rel) => {
    try {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
      removed += 1;
    } catch {
      skipped += 1;
    }
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    // A rename/copy carries the original path in the next token.
    if (code[0] === 'R' || code[0] === 'C') {
      const original = tokens[i + 1];
      if (original) {
        i += 1;
        drop(original);
      }
    }
    if (code.includes('D')) {
      drop(rel);
      continue;
    }
    if (OVERLAY_SKIP.test(rel.split('\\').join('/'))) continue;
    const from = path.join(ROOT, rel);
    const to = path.join(dir, rel);
    try {
      if (!fs.statSync(from).isFile()) {
        skipped += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    } catch {
      skipped += 1;
    }
  }
  return { ok: true, copied, removed, skipped, error: '' };
}

/**
 * Machine-local assets are shared with the worktree instead of copied. They are
 * gitignored (so they are not in the worktree), yet the suite needs them: the
 * gateway test runs the project's `.venv` python, and a project with packages
 * needs its `node_modules`.
 */
const LINKED_ASSETS = ['node_modules', '.venv'];

function linkLocalAssets(dir) {
  const linked = [];
  for (const name of LINKED_ASSETS) {
    const source = path.join(ROOT, name);
    const target = path.join(dir, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    try {
      fs.symlinkSync(source, target, 'junction');
      linked.push(name);
    } catch { /* a missing link is reported by the run that needed it */ }
  }
  return linked;
}

/**
 * A run that could not delete its worktree (a locked file, a killed process)
 * leaves a folder behind. Anything older than ten minutes is reclaimed here so
 * the next run starts clean instead of accumulating copies of the project.
 */
function pruneStaleWorktrees(base) {
  try {
    if (!fs.existsSync(base)) return;
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const name of fs.readdirSync(base)) {
      if (!name.startsWith('sentinel-')) continue;
      const stamp = Number(name.split('-')[1]);
      if (Number.isFinite(stamp) && stamp > cutoff) continue;
      try {
        fs.rmSync(path.join(base, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch { /* still held; the next run tries again */ }
    }
    execFile('git', ['worktree', 'prune'], { cwd: ROOT, windowsHide: true }, () => {});
  } catch { /* a missing or unreadable folder means there is nothing to prune */ }
}

/**
 * Create a throwaway worktree at HEAD (with this folder's uncommitted changes
 * laid over it) or at one exact commit. Always returns a cleanup function.
 */
export async function prepareWorktree({ commit = '', run } = {}) {
  const git = run || ((args) => runGit(args, ROOT));
  const base = path.join(DATA, 'worktrees');
  pruneStaleWorktrees(base);
  const dir = path.join(base, `sentinel-${Date.now()}-${process.pid}`);
  const cleanup = async () => {
    // A test that just finished can still hold a handle on its scratch files for
    // a moment on Windows, so removal is retried before it is left to the prune.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const removed = await runGit(['worktree', 'remove', '--force', dir], ROOT, 60000);
      if (removed.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
    } catch { /* a locked file is retried by the prune below */ }
    await runGit(['worktree', 'prune'], ROOT, 30000);
  };
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (err) {
    return { ok: false, dir: '', copied: 0, error: `cannot create the worktree folder: ${err.message}`, cleanup: async () => {} };
  }
  const added = await git(['worktree', 'add', '--detach', '--force', dir, commit || 'HEAD']);
  if (!added.ok) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    return { ok: false, dir: '', copied: 0, error: added.stderr.trim() || 'git worktree add failed', cleanup: async () => {} };
  }
  const overlay = commit ? { ok: true, copied: 0, removed: 0, skipped: 0 } : await overlayWorkingTree(dir);
  const linked = linkLocalAssets(dir);
  return { ok: true, dir, linked, ...overlay, cleanup };
}

/* ---------------- the queue file other apps and agents read ---------------- */

export function queueFilePath() {
  return `${MUST_CHECK_DIR}/repair-queue.json`;
}

/**
 * The spec reporter names each failing test and, below it, the assertion and a
 * stack frame. This keeps the name and the first file:line and message, which is
 * what a fixer needs; the raw output stays in the report for everything else.
 */
export function parseFailureDetails(text) {
  const lines = String(text || '').split('\n');
  const items = [];
  const byName = new Map();
  let current = null;
  let summary = false;
  const add = (item) => {
    if (!item.name) return;
    const existing = byName.get(item.name);
    if (existing) {
      if (!existing.file && item.file) {
        existing.file = item.file;
        existing.line = item.line;
      }
      if (!existing.message && item.message) existing.message = item.message;
      return;
    }
    byName.set(item.name, item);
    items.push(item);
  };
  for (const raw of lines) {
    const trimmed = String(raw).replace(/\r$/, '').trim();
    if (/^✖\s*failing tests:?$/.test(trimmed)) {
      summary = true;
      current = null;
      continue;
    }
    const head = trimmed.match(/^✖\s+(.+)$/);
    if (head) {
      const label = head[1].replace(/\s*\([\d.]+ms\)\s*$/, '').trim();
      const fileOnly = label.match(/^([A-Za-z0-9_./\\-]+\.(?:m?js|cjs|ts|jsx|tsx))$/);
      const item = {
        name: label,
        file: fileOnly ? fileOnly[1].split('\\').join('/') : '',
        line: null,
        message: '',
      };
      add(item);
      current = summary ? null : item;
      continue;
    }
    if (!current) continue;
    if (/^[✔ℹ]/.test(trimmed)) {
      current = null;
      continue;
    }
    if (!current.message) {
      const err = trimmed.match(/^([A-Za-z_$][\w$]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:.*)$/);
      if (err) current.message = err[1].slice(0, 400);
    }
    if (!current.file) {
      const loc = trimmed.match(/([A-Za-z0-9_./\\-]+\.(?:m?js|cjs|ts|jsx|tsx)):(\d+)(?::\d+)?/);
      if (loc) {
        current.file = loc[1].split('\\').join('/');
        current.line = Number(loc[2]);
      }
    }
  }
  return items.slice(0, 40);
}

/**
 * The machine-readable queue: everything open, with the parsed file:line for
 * each failure. It lives in must-check/, so auto-sync carries it to GitHub and
 * another app or agent can pick an item up without reading the console's state.
 */
export function writeRepairQueue() {
  try {
    const d = db();
    const failures = Array.isArray(d.sentinel?.failures) ? d.sentinel.failures : [];
    const open = failures.filter((f) => ['queued', 'planning', 'planned'].includes(f.status));
    const last = state.lastRun || null;
    const body = {
      version: 1,
      by: 'sentinel',
      updatedAt: now(),
      head: last?.head || '',
      lastRun: last
        ? {
            at: last.at,
            ok: last.ok,
            tests: last.tests,
            pass: last.pass,
            fail: last.fail,
            isolated: last.isolated === true,
            failingTests: last.failingTests || [],
          }
        : null,
      open: open.length,
      items: open
        .slice(-FAILURE_LIMIT)
        .reverse()
        .map((f) => ({
          id: f.id,
          at: f.at,
          status: f.status,
          attempts: f.attempts || 1,
          fail: f.fail ?? null,
          pass: f.pass ?? null,
          tests: f.tests || [],
          details: f.details || [],
          plan: f.plan?.text || '',
          planError: f.plan?.error || '',
          report: f.report || '',
        })),
    };
    const dir = path.join(ROOT, MUST_CHECK_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'repair-queue.json');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return queueFilePath();
  } catch {
    return '';
  }
}

/**
 * Run the suite against one exact commit in a worktree — the check auto-sync
 * uses before it lets the main branch move. Nothing is written into the live
 * tree, and the worktree is removed afterwards.
 */
export async function verifyCommit(sha, deps = {}) {
  const settings = sentinelSettings();
  const commit = String(sha || '').trim();
  if (!commit) return { ok: false, fail: null, failingTests: [], isolated: false, error: 'a commit is required' };
  // One suite at a time on this machine: two concurrent runs compete for ports
  // and make each other flaky. The caller retries on the next tick.
  if (state.busy) {
    return { ok: false, deferred: true, fail: null, failingTests: [], isolated: false, error: 'a test run is already in progress' };
  }
  const worktree = deps.worktree === false ? { ok: false, cleanup: async () => {} } : await prepareWorktree({ commit });
  if (!worktree.ok) return { ok: false, fail: null, failingTests: [], isolated: false, commit, error: worktree.error };
  try {
    const result = deps.run
      ? await deps.run(settings.testCommand, { cwd: worktree.dir })
      : await runCommand(settings.testCommand, { cwd: worktree.dir, timeoutMs: settings.timeoutMs, showWindow: settings.showWindow });
    const parsed = parseTestOutput(result.output || '');
    return {
      ok: Boolean(result.ok && (parsed.fail === null || parsed.fail === 0)),
      ...parsed,
      details: parseFailureDetails(result.output || ''),
      isolated: true,
      commit,
      output: String(result.output || '').slice(-OUTPUT_LIMIT),
      error: '',
    };
  } finally {
    await worktree.cleanup();
  }
}

/** One test run. `deps.run` replaces the process spawn for tests. */
export async function runSentinelNow(deps = {}) {
  const settings = sentinelSettings();
  if (state.busy) return sentinelStatus();
  state.busy = true;
  state.lastRunAt = now();
  let worktree = null;
  try {
    const isolate = deps.worktree === undefined ? settings.worktree !== false : deps.worktree !== false;
    if (isolate && !deps.run) {
      worktree = await prepareWorktree();
      state.worktreeOk = worktree.ok;
      if (!worktree.ok) state.lastError = `Isolated run unavailable, testing this folder instead: ${worktree.error}`;
    }
    const cwd = worktree?.ok ? worktree.dir : ROOT;
    const result = deps.run
      ? await deps.run(settings.testCommand, { cwd })
      : await runCommand(settings.testCommand, { cwd, timeoutMs: settings.timeoutMs, showWindow: settings.showWindow });
    const parsed = parseTestOutput(result.output || '');
    const details = parseFailureDetails(result.output || '');
    const head = await headSha();
    const run = {
      id: uid('sent'),
      at: now(),
      ok: Boolean(result.ok && (parsed.fail === null || parsed.fail === 0)),
      exitCode: result.code ?? null,
      timedOut: Boolean(result.timedOut),
      tests: parsed.tests,
      pass: parsed.pass,
      fail: parsed.fail,
      failingTests: parsed.failingTests,
      details,
      isolated: Boolean(worktree?.ok),
      head,
      output: (result.output || '').slice(-OUTPUT_LIMIT),
      durationMs: Number(result.durationMs) || null,
    };
    const d = db();
    if (!d.sentinel || typeof d.sentinel !== 'object') d.sentinel = { runs: [], failures: [] };
    if (!Array.isArray(d.sentinel.runs)) d.sentinel.runs = [];
    if (!Array.isArray(d.sentinel.failures)) d.sentinel.failures = [];
    d.sentinel.runs.push(run);
    if (d.sentinel.runs.length > RUN_LIMIT) d.sentinel.runs.splice(0, d.sentinel.runs.length - RUN_LIMIT);
    state.lastRun = { ...run, output: run.output.slice(-600) };
    state.lastError = run.ok ? '' : `${run.fail ?? '?'} failing test(s)`;
    persist();
    logActivity('sentinel', run.ok ? 'Auto-test run passed' : `Auto-test run failed (${run.failingTests.length || run.fail} failing)`, {
      runId: run.id,
    });
    if (!run.ok) queueFailure(run, settings);
    else writeRepairQueue();
    state.cooldownUntil = Date.now() + Math.max(5000, Number(settings.cooldownMs) || 60000);
    return sentinelStatus();
  } catch (err) {
    state.lastError = err.message;
    return sentinelStatus();
  } finally {
    state.busy = false;
    if (worktree?.ok) await worktree.cleanup();
  }
}

/* ---------------- the repair queue ---------------- */

function queueFailure(run, settings) {
  const d = db();
  const failure = {
    id: run.id,
    at: run.at,
    status: 'queued',
    attempts: 1,
    tests: run.failingTests,
    fail: run.fail,
    pass: run.pass,
    output: run.output.slice(-4000),
    details: run.details || [],
    isolated: run.isolated === true,
    plan: null,
  };
  const existing = d.sentinel.failures.find((f) => f.id === run.id);
  if (existing) {
    existing.attempts += 1;
    existing.status = 'queued';
    existing.tests = failure.tests;
    existing.output = failure.output;
  } else {
    d.sentinel.failures.push(failure);
  }
  while (d.sentinel.failures.length > FAILURE_LIMIT) {
    const settled = d.sentinel.failures.findIndex((f) => f.status === 'dismissed' || f.status === 'fixed');
    d.sentinel.failures.splice(settled === -1 ? 0 : settled, 1);
  }
  const report = writeMustCheckReport(failure);
  failure.report = report;
  addNote({
    by: 'sentinel',
    tags: ['must-check', 'auto-test'],
    text: `Auto-test failed: ${(run.failingTests || []).slice(0, 3).join('; ') || `${run.fail} failing`}. Queued for repair${report ? `; report in ${report}` : ''}.`,
  });
  persist();
  writeRepairQueue();
  if (settings.autoPlan !== false) {
    // A plan is advice, not action; if the model is offline the item stays queued.
    planFailure(failure.id).catch(() => {});
  }
}

/** Write the human- and agent-readable report into the tracked must-check folder. */
export function writeMustCheckReport(failure) {
  try {
    const dir = path.join(ROOT, MUST_CHECK_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = String(failure.at).replace(/[:.]/g, '-').slice(0, 19);
    const first = String(failure.tests?.[0] || 'suite').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const file = path.join(dir, `${stamp}-${first || 'suite'}.md`);
    const body = [
      `# Auto-test failure — ${failure.at}`,
      '',
      `- queued id: \`${failure.id}\``,
      `- failing: ${failure.fail ?? '?'} of ${failure.tests ?? '?'} tests`,
      ...(failure.details?.length
        ? failure.details.map(
            (d) => `  - ✖ ${d.name}${d.file ? ` — ${d.file}${d.line ? `:${d.line}` : ''}` : ''}${d.message ? ` — ${d.message}` : ''}`
          )
        : failure.tests?.length
        ? failure.tests.map((t) => `  - ✖ ${t}`)
        : []),
      '',
      '## Output tail',
      '',
      '```',
      String(failure.output || '').trimEnd().slice(-3000),
      '```',
      '',
      'Leave findings, fixes and follow-up questions below; auto-sync carries this folder to GitHub so every connected app and agent sees it.',
      '',
    ].join('\n');
    fs.writeFileSync(file, body);
    const entries = fs.readdirSync(dir).filter((name) => name.endsWith('.md') && name !== 'README.md').sort();
    while (entries.length > REPORT_LIMIT) {
      const oldest = entries.shift();
      try { fs.unlinkSync(path.join(dir, oldest)); } catch { /* already gone */ }
    }
    return `${MUST_CHECK_DIR}/${path.basename(file)}`;
  } catch {
    return '';
  }
}

/** Ask the model for a concrete repair plan. Advice only — nothing is applied. */
export async function planFailure(id, deps = {}) {
  const d = db();
  const item = d.sentinel.failures.find((f) => f.id === id);
  if (!item) throw new Error('Failure not found');
  if (state.busy) return { ...item, planError: 'a test run is in progress' };
  let ask = deps.chat || null;
  if (!ask) {
    try {
      const mod = await import('./llm.js');
      ask = async (messages) => mod.chat(messages, { timeoutMs: 90000 });
    } catch (err) {
      item.plan = { at: now(), error: err.message };
      persist();
      return item;
    }
  }
  item.status = 'planning';
  persist();
  try {
    const reply = await ask([
      {
        role: 'system',
        content:
          'You are reviewing a failing test run of a Node.js console app. Reply with a short, concrete repair plan: the most likely cause, the files to change, and the smallest change that should make the suite pass. Plain text, at most 12 lines. You are advising a human; do not claim to have changed anything.',
      },
      { role: 'user', content: `Failing tests:\n${(item.tests || []).map((t) => `- ${t}`).join('\n') || item.fail}\n\nOutput tail:\n${String(item.output || '').slice(-3000)}` },
    ]);
    item.plan = reply?.ok
      ? { at: now(), text: String(reply.content || '').trim().slice(0, 4000) }
      : { at: now(), error: reply?.error || 'the model is offline' };
  } catch (err) {
    item.plan = { at: now(), error: err.message };
  }
  item.status = item.plan?.text ? 'planned' : 'queued';
  persist();
  writeRepairQueue();
  logActivity('sentinel', item.plan?.text ? 'Repair plan drafted for a failing run' : 'Repair plan unavailable for a failing run', { runId: item.id });
  return item;
}

export function dismissFailure(id) {
  const d = db();
  const item = d.sentinel.failures.find((f) => f.id === id);
  if (!item) throw new Error('Failure not found');
  item.status = 'dismissed';
  item.settledAt = now();
  persist();
  writeRepairQueue();
  return item;
}

/** Re-run the suite for one queue item (the same full run as "run now"). */
export async function retryFailure(id) {
  const d = db();
  const item = d.sentinel.failures.find((f) => f.id === id);
  if (!item) throw new Error('Failure not found');
  item.status = 'queued';
  persist();
  return runSentinelNow();
}

/* ---------------- change watching ---------------- */

/** Called by the watchers; collects paths and schedules a settled run. */
function noteChange(file) {
  const rel = String(file || '');
  if (!rel || IGNORED.test(rel)) return;
  const settings = sentinelSettings();
  if (settings.enabled === false) return;
  state.lastChangeAt = now();
  state.pending.add(rel.split('\\').join('/'));
  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null;
    settle().catch((err) => {
      state.lastError = err.message;
    });
  }, 1500);
  state.settleTimer.unref?.();
}

/**
 * The settle check: run the suite when changes are waiting, the cooldown has
 * passed and nothing is running. `deps.force` skips the cooldown (operator's
 * "run now" and retries).
 */
export async function settle(deps = {}) {
  if (!state.pending.size || state.busy) return sentinelStatus();
  if (!deps.force && Date.now() < state.cooldownUntil) return sentinelStatus();
  state.pending.clear();
  return runSentinelNow(deps);
}

export function startSentinel() {
  const settings = sentinelSettings();
  if (settings.enabled === false || state.watching) return sentinelStatus();
  for (const entry of WATCH_ROOTS) {
    const target = path.join(ROOT, entry);
    if (!fs.existsSync(target)) continue;
    try {
      const watcher = fs.watch(target, { recursive: fs.statSync(target).isDirectory() }, (_event, file) => {
        noteChange(file ? path.join(entry, file) : entry);
      });
      watcher.on('error', () => {}); // a vanished folder is not worth crashing over
      state.watchers.push(watcher);
    } catch { /* an unwatchable root is skipped */ }
  }
  state.watching = state.watchers.length > 0;
  if (state.watching) logActivity('sentinel', 'Sentinel is watching the project for changes', {});
  return sentinelStatus();
}

export function stopSentinel() {
  for (const watcher of state.watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  state.watchers = [];
  state.watching = false;
  if (state.settleTimer) {
    clearTimeout(state.settleTimer);
    state.settleTimer = null;
  }
  return sentinelStatus();
}

/* ---------------- pushing a repair ---------------- */

/**
 * Commit and push the current tree through the same conservative sync path the
 * Sync page uses, so a verified fix (or any settled state) reaches GitHub.
 */
export async function pushSentinelFix({ message = '' } = {}) {
  const git = await import('./git-sync.js');
  const committed = await git.checkAndSync({ force: true });
  if (committed.status === 'conflict' || committed.status === 'error' || committed.status === 'push-failed') {
    return { ok: false, status: committed.status, message: committed.lastError || `sync stopped at ${committed.status}` };
  }
  const pushed = await git.pushNow();
  return {
    ok: pushed.ok,
    status: pushed.status,
    message: message ? `${pushed.message} (${message})` : pushed.message,
  };
}

/** Used by the tests to inspect and reset the watcher state. */
export { state as __sentinelState, IGNORED as __sentinelIgnored };
