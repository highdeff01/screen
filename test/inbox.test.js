import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-inbox-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const inbox = await load('server/inbox.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('a request needs a question and is listed open, newest first', () => {
  assert.throws(() => inbox.ask({ question: '   ' }), /needs a question/);
  const first = inbox.ask({ question: 'May I delete the stale capture folder?', from: 'cleanup-agent', choices: ['yes', 'no'] });
  const second = inbox.ask({ question: 'Which branch should I push to?', from: 'relay' });
  const open = inbox.listInbox({ status: 'open' });
  assert.equal(open[0].id, second.id);
  assert.equal(open[1].id, first.id);
  assert.deepEqual(first.choices, ['yes', 'no']);
});

test('answering settles the request and the asker reads the answer back', async () => {
  const before = inbox.listInbox({ status: 'open' }).length;
  const item = inbox.ask({ question: 'Keep the temp branch?', from: 'merger' });
  assert.throws(() => inbox.answerRequest(item.id, { answer: '  ' }), /needs some text/);
  assert.throws(() => inbox.answerRequest('nope', { answer: 'x' }), /Request not found/);
  const answered = inbox.answerRequest(item.id, { answer: 'yes, keep it', by: 'Dan' });
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answeredBy, 'Dan');
  assert.equal(inbox.listInbox({ status: 'open' }).length, before, 'answered requests leave the open list');
  // The waiting side sees the answer without polling forever.
  const waited = await inbox.waitRequest(item.id, { timeoutMs: 2000 });
  assert.equal(waited.item.answer, 'yes, keep it');
  assert.throws(() => inbox.answerRequest(item.id, { answer: 'again' }), /already answered/);
});

test('cancelling a request resolves the wait without an answer', async () => {
  const item = inbox.ask({ question: 'Never mind', from: 'ghost' });
  const cancelled = inbox.cancelRequest(item.id);
  assert.equal(cancelled.status, 'cancelled');
  const waited = await inbox.waitRequest(item.id, { timeoutMs: 1000 });
  assert.equal(waited.item.status, 'cancelled');
});

test('a wait times out politely while the question is still open', async () => {
  const item = inbox.ask({ question: 'Still thinking', from: 'agent' });
  const waited = await inbox.waitRequest(item.id, { timeoutMs: 1000 });
  assert.equal(waited.item.status, 'open', 'the request is untouched by the timeout');
  inbox.cancelRequest(item.id);
});
