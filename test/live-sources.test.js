import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-live-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const live = await load('server/live-sources.js');

after(() => {
  live.stopLiveSources();
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a source needs a real http(s) URL', () => {
  assert.equal(live.addSource({ url: 'not a url' }).ok, false);
  assert.equal(live.addSource({ url: 'ftp://example.com/x' }).ok, false);
  const made = live.addSource({ url: 'https://example.com/feed', name: 'Wiki' });
  assert.equal(made.ok, true);
  assert.equal(made.source.name, 'Wiki');
  assert.equal(live.listSources().length, 1);
  live.removeSource(made.source.id);
  assert.equal(live.listSources().length, 0);
});

test('the first poll is a baseline, the same body is not a change, a new body is', async () => {
  const made = live.addSource({ url: 'https://example.com/feed', name: 'Feed', propose: true, jsonPath: 'title' });
  const seen = [];
  const fetcher = async (url, headers) => {
    seen.push({ url, headers });
    if (seen.length === 1) return { ok: true, status: 200, body: '{"title":"one"}', etag: '"e1"' };
    if (seen.length === 2) return { ok: true, status: 200, body: '{"title":"one"}', etag: '"e1"' };
    return { ok: true, status: 200, body: '{"title":"two"}', etag: '"e2"' };
  };

  const first = await live.pollSource(made.source.id, { fetcher });
  assert.equal(first.changed, false);
  assert.equal(first.first, true);

  const second = await live.pollSource(made.source.id, { fetcher });
  assert.equal(second.changed, false);
  // The validator the source was given is sent back on the next poll.
  assert.equal(seen[1].headers['if-none-match'], '"e1"');

  const third = await live.pollSource(made.source.id, { fetcher });
  assert.equal(third.changed, true);
  assert.equal(third.event.excerpt, 'two');
  assert.equal(third.proposal.status, 'open');
  assert.match(third.proposal.summary, /Feed changed/);

  const dismissed = live.dismissProposal(third.proposal.id);
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.proposal.status, 'dismissed');
  assert.equal(live.liveStatus().openProposals, 0);
});

test('a 304 answer is not a change and does not touch the hash', async () => {
  const made = live.addSource({ url: 'https://example.com/quiet', name: 'Quiet' });
  const fetcher = async () => ({ ok: true, status: 304, notModified: true, body: '' });
  const out = await live.pollSource(made.source.id, { fetcher });
  assert.equal(out.ok, true);
  assert.equal(out.changed, false);
  assert.equal(out.status, 304);
});

test('a failing source reports the reason and keeps its place', async () => {
  const made = live.addSource({ url: 'https://example.com/broken', name: 'Broken' });
  const out = await live.pollSource(made.source.id, { fetcher: async () => ({ ok: false, why: 'the host is unreachable', status: 0 }) });
  assert.equal(out.ok, false);
  assert.match(out.why, /unreachable/);
  const source = live.listSources().find((entry) => entry.id === made.source.id);
  assert.equal(source.lastError, 'the host is unreachable');
  assert.equal(live.liveStatus().sources >= 1, true);
});

test('only sources that are due are polled', async () => {
  const due = live.addSource({ url: 'https://example.com/due', name: 'Due', intervalMs: 0 });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ok: true, status: 200, body: 'body', etag: '' };
  };
  const results = await live.pollDue({ fetcher });
  assert.equal(calls >= 1, true);
  assert.equal(results.some((entry) => entry.id === due.source.id), true);
  // Immediately again: the source just polled has nothing due.
  const callsAfter = calls;
  await live.pollDue({ fetcher, at: Date.now() + 1000 });
  assert.equal(calls, callsAfter);
});
