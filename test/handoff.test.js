import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-handoff-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const handoff = await load('server/handoff.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('a note needs text and is listed newest first', () => {
  assert.throws(() => handoff.addNote({ text: '   ' }), /needs some text/);
  const first = handoff.addNote({ text: 'VLC needs the window guard', by: 'cli', tags: 'vlc, guard' });
  const second = handoff.addNote({ text: 'Do not re-run the download probe', by: 'agent' });
  assert.equal(first.by, 'cli');
  assert.deepEqual(first.tags, ['vlc', 'guard']);
  const notes = handoff.listNotes({ limit: 10 });
  assert.equal(notes[0].id, second.id);
  assert.equal(notes[1].id, first.id);
});

test('a command is saved once per name and can be edited in place', () => {
  const saved = handoff.saveCommand({ name: 'probe', command: 'node -e "1"' });
  const again = handoff.saveCommand({ name: 'probe', command: 'node -e "2"' });
  assert.equal(again.id, saved.id, 'the same name updates the existing command');
  const listed = handoff.listCommands();
  assert.equal(listed.filter((command) => command.name === 'probe').length, 1);
  assert.equal(listed.find((command) => command.name === 'probe').command, 'node -e "2"');
});

test('a command needs both a name and something to run', () => {
  assert.throws(() => handoff.saveCommand({ name: '', command: 'echo hi' }), /needs a name/);
  assert.throws(() => handoff.saveCommand({ name: 'empty', command: '  ' }), /something to run/);
});

test('running a command records its output for the next agent', async () => {
  handoff.saveCommand({ name: 'say-hi', command: 'node -e "console.log(\'handoff ok\')"' });
  const result = await handoff.runCommand('say-hi', { timeoutMs: 30000 });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /handoff ok/);
  const stored = handoff.listCommands().find((command) => command.name === 'say-hi');
  assert.equal(stored.lastRun.ok, true);
  assert.match(stored.lastRun.stdout, /handoff ok/);
});

test('a failing command reports its exit code instead of throwing', async () => {
  handoff.saveCommand({ name: 'fail-on-purpose', command: 'node -e "process.exit(3)"' });
  const result = await handoff.runCommand('fail-on-purpose', { timeoutMs: 30000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
});

test('removing a command forgets it', () => {
  handoff.saveCommand({ name: 'temporary', command: 'node -e "1"' });
  const removed = handoff.deleteCommand('temporary');
  assert.equal(removed.name, 'temporary');
  assert.ok(!handoff.listCommands().some((command) => command.name === 'temporary'));
  assert.throws(() => handoff.deleteCommand('temporary'), /not found/);
});
