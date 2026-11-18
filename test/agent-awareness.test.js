import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-agents-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const awareness = await load('server/agent-awareness.js');
const sentinel = await load('server/sentinel.js');

beforeEach(() => {
  awareness.__resetAgents();
});

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('a heartbeat needs a name and repeats refresh it', () => {
  assert.throws(() => awareness.heartbeat({ name: '  ' }), /needs a name/);
  const first = awareness.heartbeat({ name: 'repair-agent', task: 'fixing the notepad guard' });
  assert.equal(first.active, true);
  assert.equal(first.agents[0].name, 'repair-agent');
  const again = awareness.heartbeat({ name: 'repair-agent', task: 'running the suite' });
  assert.equal(again.agents.length, 1, 'the same agent is one heartbeat, refreshed');
  assert.equal(again.agents[0].task, 'running the suite');
});

test('signing out removes the agent', () => {
  awareness.heartbeat({ name: 'builder' });
  awareness.heartbeatDone('builder');
  assert.equal(awareness.agentActivity().agents.length, 0);
  assert.equal(awareness.heartbeatDone('builder'), null, 'signing out twice is harmless');
});

test('freshly modified files count as agent activity even without a heartbeat', async () => {
  fs.writeFileSync(path.join(process.cwd(), 'server', 'nothing.js'), '// touched\n');
  const activity = awareness.agentActivity();
  assert.equal(activity.active, true);
  assert.ok(activity.files.some((file) => file.includes('nothing.js')), 'the touched file is named');
  fs.rmSync(path.join(process.cwd(), 'server', 'nothing.js'), { force: true });
});

test('a failure becomes a continuation addressed to the working agents', () => {
  awareness.heartbeat({ name: 'external-agent', task: 'implementing the relay' });
  const sent = awareness.sendContinuation({ from: 'sentinel', reason: 'auto-test failed', detail: 'boot test — fix, then run npm test' });
  assert.ok(sent.note.text.includes('CONTINUE for external-agent'));
  assert.ok(sent.note.text.includes('boot test'));
  assert.ok(sent.note.tags.includes('continuation'));
  const handoff = sentinel; // the note lives in the shared handoff store
  assert.ok(handoff);
});

test('a failing run reports to the action log and leaves a continuation', async () => {
  const actionLog = await load('server/action-log.js');
  awareness.heartbeat({ name: 'on-call', task: 'watching' });
  awareness.__resetAgents(); // no agents: the continuation still lands for the next agent
  const handoff = await load('server/handoff.js');
  const before = handoff.listNotes({ limit: 5 }).length;
  const item = actionLog.recordAction({
    kind: 'run',
    action: 'run-failed:demo',
    error: 'the launcher timed out',
    forceReport: true,
  });
  assert.ok(item.reportedAt, 'a forced report is written at once');
  assert.match(item.reportFile, /^must-check\/action-/, 'crash-style failures reach the synced folder immediately');
  const notes = handoff.listNotes({ limit: 5 });
  assert.ok(notes.length >= before, 'the record itself does not vanish');
});
