/**
 * Allowlisted setup commands: a narrow, hidden Windows command path.
 *
 * A setup-style script (an installer, `winget upgrade`, a vendor's silent
 * setup) is registered here as a fixed exe plus fixed arguments. A `runTool`
 * step can then name an entry and nothing else: the step cannot supply or
 * change an argument, so plan text never reaches a command line.
 *
 * What the path guarantees:
 *
 *   hidden        execFile with windowsHide, shell: false, no detached console
 *   captured      stdout, stderr, exit code and duration are written to
 *                 data/setup-logs and returned as a log evidence entry
 *   allowlisted   only entries in db().setupCommands run, by id or label
 *   no elevation  runas / sudo / -Verb RunAs are refused when an entry is added
 *                 and again when it runs; there is no way to ask for a UAC
 *                 prompt, so a command that needs admin fails with its own error
 *
 * Shell hosts are refused (cmd.exe re-parses arguments; PowerShell only with a
 * fixed -File script; mshta/wscript/rundll32 are not setup commands).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA, db, logActivity, now, persist, uid } from './store.js';

export const LOGS_DIR = path.join(DATA, 'setup-logs');
export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ARGS = 32;
const MAX_ARG_CHARS = 512;
const MAX_EXE_CHARS = 260;
const MAX_OUTPUT_CHARS = 200000;
const WINDOWS = process.platform === 'win32';

/** Requests for elevation. Nothing here ever prompts for it or works around it. */
const ELEVATION = [
  /\brunas\b/i,
  /-verb\s+runas/i,
  /\bgsudo\b/i,
  /\bsudo\b/i,
  /\belevate(\.exe)?\b/i,
  /\bbypassuac\b/i,
  /\bshellexecute\b/i,
];

const SCRIPT_HOSTS = /^(mshta|wscript|cscript|rundll32|regsvr32|regasm|installutil)(\.exe)?$/i;
const CMD_HOST = /^cmd(\.exe)?$/i;
const POWERSHELL = /^(powershell|pwsh)(\.exe)?$/i;
const CONTROL = /[\0\r\n]/;
const QUOTES = /["'`]/;
const FOLDER = /[\\/]/;

function basenameOf(exe) {
  return path.basename(String(exe || '')).toLowerCase();
}

/**
 * Why this command may not run through the hidden path, or '' when it may.
 * Checked when an entry is added and again immediately before it runs, so an
 * allowlist file edited by hand still cannot smuggle in elevation.
 */
export function commandRefusal(entry = {}) {
  const exe = String(entry.exe || '');
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (!exe.trim()) return 'A setup command needs an executable.';
  if (CONTROL.test(exe) || args.some((arg) => CONTROL.test(arg))) {
    return 'A setup command cannot contain line breaks or NUL characters.';
  }
  const joined = [exe, ...args].join(' ');
  for (const pattern of ELEVATION) {
    if (pattern.test(joined)) {
      return 'This path never requests elevation. Run the setup once yourself if it needs an administrator prompt.';
    }
  }
  const name = basenameOf(exe);
  if (SCRIPT_HOSTS.test(name)) {
    return `${name} is a script host, not a setup command. Register the program it was going to launch instead.`;
  }
  if (CMD_HOST.test(name)) {
    return 'cmd.exe re-parses its arguments; register the program directly so arguments stay literal.';
  }
  if (POWERSHELL.test(name)) {
    const hasFile = args.some((arg) => /^-+file$/i.test(arg) || /^-+f$/i.test(arg));
    const hasCommand = args.some((arg) => /^-+(command|c|encodedcommand|ec|e)$/i.test(arg));
    if (hasCommand) return 'PowerShell runs only a fixed -File script here, never -Command.';
    if (!hasFile) return 'PowerShell needs a fixed -File script in the allowlist entry.';
  }
  return '';
}

/** Validate and normalise one allowlist entry, refusing anything ambiguous. */
export function validateSetupCommand(input = {}) {
  const label = String(input.label || '').trim();
  if (!label) throw new Error('A setup command needs a label.');
  if (label.length > 80) throw new Error('Keep the label to 80 characters or fewer.');

  const exe = String(input.exe || '').trim();
  if (!exe) throw new Error('A setup command needs an executable.');
  if (exe.length > MAX_EXE_CHARS) throw new Error('That executable path is too long.');
  if (QUOTES.test(exe)) throw new Error('Write the executable without quotes; arguments are passed literally.');
  if (FOLDER.test(exe) && !path.isAbsolute(exe)) {
    throw new Error('A path with a folder must be absolute, so the command cannot change with the working directory.');
  }

  const args = Array.isArray(input.args) ? input.args : [];
  if (args.length > MAX_ARGS) throw new Error(`A setup command takes at most ${MAX_ARGS} arguments.`);
  const cleanArgs = args.map((arg) => {
    if (typeof arg !== 'string') throw new Error('Every argument must be a string.');
    if (arg.length > MAX_ARG_CHARS) throw new Error('One argument is too long.');
    return arg;
  });
  if ([exe, ...cleanArgs].join(' ').length > 4096) throw new Error('That command line is too long.');

  let cwd = '';
  if (input.cwd) {
    cwd = path.resolve(String(input.cwd));
    if (!fs.existsSync(cwd)) throw new Error('The working directory does not exist.');
  }

  const requested = Number(input.timeoutMs);
  const timeoutMs = Number.isFinite(requested)
    ? Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(requested)))
    : DEFAULT_TIMEOUT_MS;

  const entry = {
    id: input.id || uid('sc'),
    label,
    exe,
    args: cleanArgs,
    cwd,
    timeoutMs,
    enabled: input.enabled !== false,
    createdAt: input.createdAt || now(),
  };
  const refusal = commandRefusal(entry);
  if (refusal) throw new Error(refusal);
  return entry;
}

function allowlist() {
  const d = db();
  if (!Array.isArray(d.setupCommands)) {
    d.setupCommands = [];
    persist();
  }
  return d.setupCommands;
}

export function listSetupCommands() {
  return allowlist().map((entry) => ({ ...entry, refusal: commandRefusal(entry) }));
}

/** Resolve an entry by id or label; the step names one, it never edits it. */
export function findSetupCommand(ref) {
  const wanted = String(ref || '').trim();
  if (!wanted) return null;
  const entries = allowlist();
  return (
    entries.find((entry) => entry.id === wanted) ||
    entries.find((entry) => String(entry.label).toLowerCase() === wanted.toLowerCase()) ||
    null
  );
}

export function addSetupCommand(input = {}) {
  const entry = validateSetupCommand(input);
  const entries = allowlist();
  if (entries.some((existing) => String(existing.label).toLowerCase() === entry.label.toLowerCase())) {
    throw new Error('A setup command with that label is already allowlisted.');
  }
  entries.push(entry);
  persist();
  logActivity('setup', `Allowlisted setup command "${entry.label}"`, { commandId: entry.id, exe: entry.exe });
  return entry;
}

export function removeSetupCommand(id) {
  const entries = allowlist();
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  const [removed] = entries.splice(index, 1);
  persist();
  logActivity('setup', `Removed setup command "${removed.label}" from the allowlist`, { commandId: removed.id });
  return removed;
}

function writeLog({ entry, started, ms, code, timedOut, stdout, stderr }) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `${stamp}-${entry.id}.log`;
    const body = [
      'Sightline setup command',
      `label: ${entry.label}`,
      `exe: ${entry.exe}`,
      `args: ${JSON.stringify(entry.args || [])}`,
      `cwd: ${entry.cwd || DATA}`,
      `started: ${new Date(started).toISOString()}`,
      `duration: ${ms}ms`,
      `exit: ${timedOut ? `timed out after ${ms}ms` : code}`,
      'elevation: not requested (this path cannot ask for it)',
      '',
      '--- stdout ---',
      String(stdout || '').slice(0, MAX_OUTPUT_CHARS) || '(empty)',
      '',
      '--- stderr ---',
      String(stderr || '').slice(0, MAX_OUTPUT_CHARS) || '(empty)',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(LOGS_DIR, file), body);
    return `setup-logs/${file}`;
  } catch {
    return '';
  }
}

/**
 * Run one allowlisted command, hidden, with its output captured to a log.
 * Never throws for an ordinary failure: the caller decides what a non-zero
 * exit means for the step, and the log is still evidence either way.
 */
export function runSetupCommand(entry = {}, { timeoutMs } = {}) {
  const started = Date.now();
  if (!WINDOWS) {
    return {
      ok: false,
      code: null,
      refused: 'Setup commands run on Windows only.',
      stdout: '',
      stderr: '',
      ms: 0,
      logRel: '',
    };
  }
  const refusal = commandRefusal(entry);
  if (refusal) {
    return { ok: false, code: null, refused: refusal, stdout: '', stderr: '', ms: 0, logRel: '' };
  }
  const requested = Number(timeoutMs);
  const timeout = Number.isFinite(requested)
    ? Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(requested)))
    : Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(entry.timeoutMs) || DEFAULT_TIMEOUT_MS));

  return new Promise((resolve) => {
    execFile(
      entry.exe,
      Array.isArray(entry.args) ? entry.args : [],
      {
        cwd: entry.cwd || DATA,
        timeout,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: { ...process.env, CB_DATA: DATA },
      },
      (error, stdout, stderr) => {
        const ms = Date.now() - started;
        const timedOut = Boolean(error?.killed);
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        const cleanOut = String(stdout || '').trim();
        const cleanErr = String(stderr || '').trim() || (error && !cleanOut ? String(error.message || '') : '');
        const logRel = writeLog({ entry, started, ms, code, timedOut, stdout: cleanOut, stderr: cleanErr });
        resolve({ ok: !error, code, timedOut, stdout: cleanOut, stderr: cleanErr, ms, logRel });
      }
    );
  });
}

/** The one-line summary a run step shows for a captured setup command. */
export function setupSummary(entry, result) {
  if (result?.refused) return `Setup command "${entry.label}" was refused: ${result.refused}`;
  const status = result?.timedOut ? 'timed out' : `exit ${result?.code}`;
  const output = String(result?.stdout || '').replace(/\s+/g, ' ').trim();
  return `Setup command "${entry.label}" ${result?.ok ? 'finished' : 'failed'} (${status}, ${result?.ms || 0}ms)${
    output ? `: ${output.slice(0, 240)}` : ''
  }`;
}
