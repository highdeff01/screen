/**
 * Agent awareness — the app knowing when AIs are actually working on it.
 *
 * An AI working on this app (this console's own repair agents, an external
 * coding agent, another instance) announces itself with a heartbeat: name,
 * what it is doing, and it says when it is done. On top of the announcements
 * the app reads the physical signs — very recent commits, files modified
 * seconds ago — so an agent that never announces is still seen.
 *
 * Awareness drives safeguards, not blocks:
 *
 *   - while agents are actively editing, the Sentinel stretches its cooldown so
 *     auto-tests do not fire on half-written files
 *   - a failed test run or a crashed live attempt becomes a *continuation*
 *     message addressed to the working agents (handoff notes, tagged), so the
 *     next thing they read tells them to continue and what broke — errors and
 *     logs travel with it
 *
 * This module never edits anything; it only knows and tells.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db, logActivity, now, persist, ROOT } from './store.js';
import { addNote } from './handoff.js';

const HEARTBEAT_TTL_MS = 10 * 60 * 1000;
const COMMIT_FRESH_MS = 3 * 60 * 1000;
const FILE_FRESH_MS = 90 * 1000;
const WATCHED = ['public', 'server', 'test', 'bin', 'examples', 'must-check', 'docs', 'package.json'];
const IGNORED = /(^|[\\/])(node_modules|\.git|\.freebuff|data)([\\/]|$)|\.log$|\.pid$|(^|[\\/])tmp-/;

function heartbeats() {
  const d = db();
  if (!Array.isArray(d.agentHeartbeats)) d.agentHeartbeats = [];
  return d.agentHeartbeats;
}

/** An agent announces itself (and refreshes that announcement by repeating). */
export function heartbeat({ name = '', task = '' } = {}) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) throw new Error('A heartbeat needs a name.');
  const list = heartbeats();
  const existing = list.find((entry) => entry.name === label);
  if (existing) {
    existing.task = String(task || existing.task || '').slice(0, 300);
    existing.at = now();
  } else {
    list.push({ name: label, task: String(task || '').slice(0, 300), at: now() });
    logActivity('agents', `${label} is working on the app`, {});
  }
  while (list.length > 20) {
    const oldest = list.reduce((a, b) => (new Date(a.at) < new Date(b.at) ? a : b));
    list.splice(list.indexOf(oldest), 1);
  }
  persist();
  return agentActivity();
}

export function heartbeatDone(name) {
  const list = heartbeats();
  const index = list.findIndex((entry) => entry.name === name);
  if (index !== -1) {
    const [left] = list.splice(index, 1);
    persist();
    logActivity('agents', `${left.name} finished and reported out`, {});
    return left;
  }
  return null;
}

/** A fresh commit is the strongest sign an agent just did something. */
function recentCommitAgeMs() {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      const seconds = Number(String(stdout).trim());
      if (!Number.isFinite(seconds)) return resolve(null);
      resolve(Math.max(0, Date.now() - seconds * 1000));
    });
  });
}

/** Recently touched source files — the physical footprint of an editing agent. */
function freshFiles() {
  const cutoff = Date.now() - FILE_FRESH_MS;
  const found = [];
  for (const entry of WATCHED) {
    const target = path.join(ROOT, entry);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      if (stat.mtimeMs >= cutoff) found.push(entry);
      continue;
    }
    let stack = [target];
    while (stack.length && found.length < 12) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of entries) {
        if (found.length >= 12) break;
        const full = path.join(dir, item.name);
        const rel = path.relative(ROOT, full);
        if (IGNORED.test(rel)) continue;
        if (item.isDirectory()) stack.push(full);
        else {
          try {
            if (fs.statSync(full).mtimeMs >= cutoff) found.push(rel.split(path.sep).join('/'));
          } catch { /* vanished mid-walk */ }
        }
      }
    }
  }
  return found;
}

/** Everything the app knows about who is working on it right now. */
export function agentActivity() {
  const d = db();
  const cutoff = Date.now() - HEARTBEAT_TTL_MS;
  const agents = heartbeats().filter((entry) => new Date(entry.at).getTime() >= cutoff);
  const signals = [];
  if (agents.length) {
    signals.push(`${agents.length} announced agent(s): ${agents.map((a) => a.name).join(', ')}`);
  }
  const commitAge = d.__lastCommitAgeMs;
  if (Number.isFinite(commitAge) && commitAge <= COMMIT_FRESH_MS) {
    signals.push(`a commit landed ${Math.round(commitAge / 1000)}s ago`);
  }
  const files = freshFiles();
  if (files.length) {
    signals.push(`${files.length} file(s) modified in the last ${FILE_FRESH_MS / 1000}s`);
  }
  return {
    active: agents.length > 0 || signals.length > 0,
    agents: agents.map(({ name, task, at }) => ({ name, task, at })),
    signals,
    files,
  };
}

/** Refreshed by the background loop so activity() does not spawn git per call. */
export async function refreshSignals() {
  const age = await recentCommitAgeMs();
  if (age !== null) {
    db().__lastCommitAgeMs = age;
    persist();
  }
}

/**
 * A failure that should reach the working agents as an instruction to
 * continue, not just as a record. Addressed notes mean the next thing each
 * agent reads tells it what broke and what to pick up.
 */
export function sendContinuation({ reason = '', detail = '', from = 'app', tags = [] } = {}) {
  const activity = agentActivity();
  const names = activity.agents.map((agent) => agent.name);
  const text = `CONTINUE for ${names.length ? names.join(', ') : 'the next agent'}: ${reason}${detail ? ` — ${detail}` : ''}`;
  const note = addNote({ by: from, tags: ['continuation', 'must-check', ...tags], text: text.slice(0, 2000) });
  if (names.length) logActivity('agents', `Continuation sent to ${names.join(', ')}`, { noteId: note.id });
  return { note, agents: names };
}

export function startAgentWatch({ intervalMs } = {}) {
  refreshSignals();
  const every = Math.max(15000, Number(intervalMs) || 60000);
  const timer = setInterval(() => {
    refreshSignals().catch(() => {});
  }, every);
  timer.unref?.();
  return timer;
}

/** Used by the tests to reset announcements. */
export function __resetAgents() {
  db().agentHeartbeats = [];
  delete db().__lastCommitAgeMs;
  persist();
}
