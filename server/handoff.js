/**
 * Handoff between people, apps and AI agents sharing this folder.
 *
 * Two small stores, both kept in the console database so every surface sees the
 * same thing:
 *
 *   - notes: short messages one agent leaves for the next one ("the VLC check
 *     needs the window guard", "do not re-run the download probe"). The CLI
 *     writes them from a terminal; the Sync page shows them.
 *   - commands: named shell commands for actions the console has no step for.
 *     They live with the operator, never in the workflow file, and every run is
 *     recorded with its output so a later agent can see what happened.
 *
 * Running a command is arbitrary code on the machine that owns this console, so
 * it is opt-in per command, never automatic, and bounded by a timeout.
 */
import { spawn } from 'node:child_process';
import { db, logActivity, now, persist, ROOT, uid } from './store.js';

const NOTE_LIMIT = 300;
const OUTPUT_LIMIT = 4000;

function notes() {
  const d = db();
  if (!Array.isArray(d.aiNotes)) d.aiNotes = [];
  return d.aiNotes;
}

export function listNotes({ limit = 50, since = null } = {}) {
  return notes()
    .filter((note) => !since || String(note.at) > String(since))
    .slice(-Math.max(1, Math.min(NOTE_LIMIT, Number(limit) || 50)))
    .reverse();
}

export function addNote({ text = '', by = 'agent', tags = [] } = {}) {
  const body = String(text || '').trim().slice(0, 4000);
  if (!body) throw new Error('A note needs some text.');
  const note = {
    id: uid('note'),
    at: now(),
    by: String(by || 'agent').slice(0, 60),
    text: body,
    tags: (Array.isArray(tags) ? tags : String(tags || '').split(','))
      .map((tag) => String(tag).trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 8),
  };
  const list = notes();
  list.push(note);
  if (list.length > NOTE_LIMIT) list.splice(0, list.length - NOTE_LIMIT);
  persist();
  logActivity('handoff', `${note.by} left a note for the next agent`, { noteId: note.id });
  return note;
}

function commands() {
  const d = db();
  if (!Array.isArray(d.commands)) d.commands = [];
  return d.commands;
}

export function listCommands() {
  return commands().map(({ id, name, command, description, createdAt, lastRun }) => ({
    id,
    name,
    command,
    description,
    createdAt,
    lastRun: lastRun || null,
  }));
}

export function saveCommand({ id = '', name = '', command = '', description = '' } = {}) {
  const label = String(name || '').trim().slice(0, 60);
  const body = String(command || '').trim().slice(0, 2000);
  if (!label) throw new Error('A command needs a name.');
  if (!body) throw new Error('A command needs something to run.');
  const list = commands();
  const existing = id ? list.find((entry) => entry.id === id) : list.find((entry) => entry.name === label);
  if (existing) {
    existing.name = label;
    existing.command = body;
    existing.description = String(description || '').slice(0, 400);
    existing.updatedAt = now();
    persist();
    return { ...existing };
  }
  const record = {
    id: uid('cmd'),
    name: label,
    command: body,
    description: String(description || '').slice(0, 400),
    createdAt: now(),
  };
  list.push(record);
  if (list.length > 60) list.splice(0, list.length - 60);
  persist();
  logActivity('handoff', `Custom command “${label}” saved`);
  return { ...record };
}

export function deleteCommand(id) {
  const list = commands();
  const index = list.findIndex((entry) => entry.id === id || entry.name === id);
  if (index === -1) throw new Error('Command not found');
  const [removed] = list.splice(index, 1);
  persist();
  return removed;
}

/** Run one saved command and keep its output so the next agent can read it. */
export async function runCommand(id, { timeoutMs = 120000 } = {}) {
  const record = commands().find((entry) => entry.id === id || entry.name === id);
  if (!record) throw new Error('Command not found');
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(record.command, {
      cwd: ROOT,
      shell: true,
      windowsHide: true,
      timeout: Math.max(1000, Math.min(600000, Number(timeoutMs) || 120000)),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-OUTPUT_LIMIT);
    });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
  record.lastRun = {
    at: now(),
    ok: result.ok,
    code: result.code,
    ms: Date.now() - startedAt,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
  persist();
  logActivity('handoff', `Ran custom command “${record.name}” (${result.ok ? 'ok' : `exit ${result.code}`})`, {
    commandId: record.id,
  });
  return { command: { ...record }, ...result };
}
