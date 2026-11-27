#!/usr/bin/env node
/**
 * sightline — command line for this console.
 *
 * Everything the Sync page can do, for a terminal or another agent:
 *
 *   sightline status                 repository state, ahead/behind, conflicts
 *   sightline pull | push | merge    take updates, send yours, combine branches
 *   sightline prs                    open pull requests on the remote
 *   sightline pr 12                  fetch PR 12 into the local branch pr/12
 *   sightline conflicts ours|theirs|ai|commit
 *   sightline notes [list]           handoff notes other agents left
 *   sightline notes add "text" --by me
 *   sightline cmd list
 *   sightline cmd add pull-and-test -- "git pull && npm test"
 *   sightline cmd run pull-and-test [--agent agent_watchdog]
 *   sightline cmd rm pull-and-test
 *
 * The console must be running (npm start); set SIGHTLINE_URL to reach another
 * instance. Exit code is 1 when the action failed, so scripts can gate on it.
 */
const base = (process.env.SIGHTLINE_URL || 'http://127.0.0.1:4317').replace(/\/+$/, '');

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot reach the console at ${base} (${err.message}). Start it with "npm start".`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json) throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  return json;
}

const say = (line = '') => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

function printStatus(info) {
  const g = info.git || {};
  say(`branch     ${info.branch || g.branch || '?'}  →  ${info.remote || 'no remote'}`);
  say(`ahead      ${info.ahead ?? g.ahead ?? 0}`);
  say(`behind     ${info.behind ?? g.behind ?? 0}`);
  say(`state      ${g.status || 'idle'}${g.lastError ? `  (${g.lastError})` : ''}`);
  say(`auto-sync  ${g.enabled ? 'on' : 'off'} · every ${Math.round(Number(g.intervalMs || 0) / 1000)}s · last ${g.lastSyncAt || 'never'}`);
  const conflicts = info.conflicts || [];
  say(`conflicts  ${conflicts.length ? conflicts.join(', ') : 'none'}`);
}

function printNotes(notes) {
  if (!notes.length) return say('No notes yet.');
  for (const note of notes) say(`[${note.at}] ${note.by}: ${note.text}`);
}

function printCommands(commands) {
  if (!commands.length) return say('No custom commands yet.');
  for (const command of commands) {
    const last = command.lastRun ? ` · last ${command.lastRun.ok ? 'ok' : `exit ${command.lastRun.code}`} at ${command.lastRun.at}` : '';
    say(`${command.name.padEnd(22)} ${command.command}${last}`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      flags.rest = argv.slice(index + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value === undefined ? true : value;
      if (value === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        flags[key] = argv[index + 1];
        index += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, action, ...rest] = positional;

  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      say(
        [
          'sightline <command>',
          '',
          '  status                       repository state, ahead/behind and conflicts',
          '  pull                         fast-forward from origin',
          '  push                         push local commits',
          '  merge                        merge origin into this branch',
          '  prs                          list open pull requests',
          '  pr <number>                  fetch a pull request into pr/<number>',
          '  conflicts ours|theirs|ai|commit',
          '  notes [list] | notes add "text" --by name',
          '  cmd list | cmd add <name> -- "command" | cmd run <name> [--agent id] | cmd rm <name>',
          '',
          `Console: ${base} (override with SIGHTLINE_URL)`,
        ].join('\n')
      );
      return;

    case 'status': {
      printStatus(await call('GET', '/api/git'));
      return;
    }

    case 'pull':
    case 'push':
    case 'merge': {
      const result = await call('POST', `/api/git/${command}`, command === 'pull' ? { ffOnly: flags.ff !== false } : {});
      say(result.message || result.error || 'done');
      if (!result.ok) process.exitCode = 1;
      return;
    }

    case 'prs': {
      const result = await call('GET', '/api/git/prs');
      if (!result.ok) return fail(result.message || 'could not list pull requests');
      if (!result.prs?.length) return say('No open pull requests.');
      for (const pr of result.prs) say(`#${String(pr.number).padEnd(4)} ${pr.sha}  ${pr.url}`);
      return;
    }

    case 'pr': {
      const number = Number(action);
      if (!number) return fail('Usage: sightline pr <number>');
      const result = await call('POST', '/api/git/prs/fetch', { number });
      say(result.message || result.error || 'done');
      if (!result.ok) process.exitCode = 1;
      return;
    }

    case 'conflicts': {
      if (action === 'ai') {
        const result = await call('POST', '/api/git/conflicts/ai', {});
        say(result.message || result.error || 'done');
        if (!result.resolved?.length) process.exitCode = 1;
        return;
      }
      if (action === 'commit') {
        const result = await call('POST', '/api/git/conflicts/commit', {});
        say(result.message || result.error || 'done');
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (!['ours', 'theirs'].includes(action)) return fail('Usage: sightline conflicts ours|theirs|ai|commit');
      const result = await call('POST', '/api/git/conflicts/resolve', { side: action });
      say(result.message || result.error || 'done');
      if (!result.ok) process.exitCode = 1;
      return;
    }

    case 'notes': {
      if (!action || action === 'list') {
        const result = await call('GET', '/api/handoff');
        return printNotes(result.notes || []);
      }
      if (action === 'add') {
        const text = (flags.rest?.length ? flags.rest.join(' ') : rest.join(' ')).trim();
        if (!text) return fail('Usage: sightline notes add "text" [--by name]');
        const result = await call('POST', '/api/handoff/notes', { text, by: flags.by || 'cli' });
        if (!result.ok) return fail(result.error || 'could not save the note');
        say(`Note saved (${result.note.id}).`);
        return;
      }
      return fail('Usage: sightline notes [list] | notes add "text"');
    }

    case 'cmd': {
      if (!action || action === 'list') {
        const result = await call('GET', '/api/commands');
        return printCommands(result.commands || []);
      }
      if (action === 'add') {
        const name = rest[0];
        const body = (flags.rest || []).join(' ');
        if (!name || !body) return fail('Usage: sightline cmd add <name> -- "command"');
        const result = await call('POST', '/api/commands', { name, command: body });
        if (!result.ok) return fail(result.error || 'could not save the command');
        say(`Saved “${result.command.name}”.`);
        return;
      }
      if (action === 'run') {
        const name = rest.join(' ');
        if (!name) return fail('Usage: sightline cmd run <name>');
        // --agent runs the command on that agent's behalf, so the console
        // records where the agent's goal stands after it.
        const agentId = typeof flags.agent === 'string' ? flags.agent : '';
        const result = await call('POST', `/api/commands/${encodeURIComponent(name)}/run`, agentId ? { agentId } : {});
        if (result.stdout) say(result.stdout.trimEnd());
        if (result.stderr) process.stderr.write(`${result.stderr.trimEnd()}\n`);
        say(result.ok ? `${result.command?.name || name} → ok` : `${result.command?.name || name} → exit ${result.code}`);
        if (result.goalCheck) say(`goal check: ${result.goalCheck.status} — ${result.goalCheck.note}`);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (action === 'rm') {
        const name = rest.join(' ');
        if (!name) return fail('Usage: sightline cmd rm <name>');
        const result = await call('DELETE', `/api/commands/${encodeURIComponent(name)}`);
        if (!result.ok) return fail(result.error || 'could not remove the command');
        say(`Removed “${result.command?.name || name}”.`);
        return;
      }
      return fail('Usage: sightline cmd list|add|run|rm');
    }

    default:
      return fail(`Unknown command “${command}”. Run "sightline help".`);
  }
}

main().catch((err) => fail(err.message));
