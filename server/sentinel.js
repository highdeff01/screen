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
import { db, logActivity, now, persist, ROOT, uid } from './store.js';
import { addNote } from './handoff.js';

const MUST_CHECK_DIR = 'must-check';
const OUTPUT_LIMIT = 8000;
const RUN_LIMIT = 30;
const FAILURE_LIMIT = 20;
const REPORT_LIMIT = 40;

/** Folders and files worth watching; data/ holds machine state and is skipped. */
const WATCH_ROOTS = ['public', 'server', 'test', 'bin', 'examples', 'package.json'];
const IGNORED = /(^|[\\/])(node_modules|\.git|\.freebuff|data|must-check)([\\/]|$)|\.log$|\.pid$|~$|(^|[\\/])tmp-|-tmp/;

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
    const value = match && String(match.match(new RegExp(`ℹ ${label}\\s+(\\d+)`)) || [])[1];
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

function runCommand(command, { timeoutMs = 600000, showWindow = false } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      { cwd: ROOT, shell: true, timeout: Math.max(5000, timeoutMs), windowsHide: !showWindow, maxBuffer: 32 * 1024 * 1024 },
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

/** One test run. `deps.run` replaces the process spawn for tests. */
export async function runSentinelNow(deps = {}) {
  const settings = sentinelSettings();
  if (state.busy) return sentinelStatus();
  state.busy = true;
  state.lastRunAt = now();
  try {
    const result = deps.run
      ? await deps.run(settings.testCommand)
      : await runCommand(settings.testCommand, { timeoutMs: settings.timeoutMs, showWindow: settings.showWindow });
    const parsed = parseTestOutput(result.output || '');
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
      output: (result.output || '').slice(-OUTPUT_LIMIT),
      durationMs: Number(result.durationMs) || null,
    };
    const d = db();
    d.sentinel.runs.push(run);
    if (d.sentinel.runs.length > RUN_LIMIT) d.sentinel.runs.splice(0, d.sentinel.runs.length - RUN_LIMIT);
    state.lastRun = { ...run, output: run.output.slice(-600) };
    state.lastError = run.ok ? '' : `${run.fail ?? '?'} failing test(s)`;
    persist();
    logActivity('sentinel', run.ok ? 'Auto-test run passed' : `Auto-test run failed (${run.failingTests.length || run.fail} failing)`, {
      runId: run.id,
    });
    if (!run.ok) queueFailure(run, settings);
    state.cooldownUntil = Date.now() + Math.max(5000, Number(settings.cooldownMs) || 60000);
    return sentinelStatus();
  } catch (err) {
    state.lastError = err.message;
    return sentinelStatus();
  } finally {
    state.busy = false;
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
  addNote({
    by: 'sentinel',
    tags: ['must-check', 'auto-test'],
    text: `Auto-test failed: ${(run.failingTests || []).slice(0, 3).join('; ') || `${run.fail} failing`}. Queued for repair${report ? `; report in ${report}` : ''}.`,
  });
  persist();
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
      ...(failure.tests?.length ? failure.tests.map((t) => `  - ✖ ${t}`) : []),
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
