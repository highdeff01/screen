import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-egress-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const egress = await load('server/egress.js');

function resetWindow() {
  egress.__egressState.window.length = 0;
}

function bodyOf(text, type = 'application/json') {
  const chunk = Buffer.from(text, 'utf8');
  return {
    status: 200,
    url: '',
    headers: { get: (key) => (String(key).toLowerCase() === 'content-type' ? type : '') },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: chunk })),
          cancel: async () => {},
        };
      },
    },
  };
}

test.after(() => {
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('only http(s) leaves, and private addresses stay closed by default', () => {
  assert.equal(egress.checkUrl('ftp://example.com/x').ok, false);
  assert.equal(egress.checkUrl('not a url').ok, false);
  assert.equal(egress.checkUrl('https://example.com/x').ok, true);

  const loopback = egress.checkUrl('http://127.0.0.1:4317/health');
  assert.equal(loopback.ok, false);
  assert.match(loopback.why, /allowLocal/);
  assert.equal(egress.checkUrl('http://192.168.1.20/x').ok, false);
  assert.equal(egress.checkUrl('http://[::1]/x').ok, false);

  const open = egress.checkUrl('http://127.0.0.1:4317/health', { allowLocal: true, allowHosts: [], types: [], perMinute: 5 });
  assert.equal(open.ok, true);
});

test('an allowlist is exact or a wildcard subdomain', () => {
  const policy = { allowHosts: ['example.com', '*.docs.test'], allowLocal: false, types: [], perMinute: 5 };
  assert.equal(egress.checkUrl('https://example.com/a', policy).ok, true);
  assert.equal(egress.checkUrl('https://api.example.com/a', policy).ok, false);
  assert.equal(egress.checkUrl('https://docs.test/a', policy).ok, true);
  assert.equal(egress.checkUrl('https://a.docs.test/a', policy).ok, true);
  assert.equal(egress.checkUrl('https://evil.test/a', policy).ok, false);
});

test('a fetch that follows the rules comes back with its text and an audit line', async () => {
  resetWindow();
  const policy = { allowHosts: ['example.com'], allowLocal: false, maxBytes: 4096, types: ['application/json'], perMinute: 20, aiGate: false, userAgent: 'test/1' };
  const out = await egress.fetchFiltered('https://example.com/data', {
    policy,
    fetchImpl: async (url) => ({ ...bodyOf('{"ok":true}'), url }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.bytes, 11);
  const last = egress.auditLog(1)[0];
  assert.equal(last.ok, true);
  assert.equal(last.host, 'example.com');
  assert.equal(egress.egressStatus().stats.allowed >= 1, true);
});

test('a payload over the ceiling is cut off and refused instead of buffered', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 1024, types: ['application/json'], perMinute: 20, aiGate: false, userAgent: 'test/1' };
  const big = 'x'.repeat(5000);
  const out = await egress.fetchFiltered('https://example.com/big', {
    policy: { ...policy, maxBytes: 1024 },
    maxBytes: 1024,
    fetchImpl: async (url) => ({ ...bodyOf(big), url }),
  });
  assert.equal(out.ok, false);
  assert.match(out.why, /larger than the 1024-byte ceiling/);
  assert.equal(out.bytes > 1024, true);
});

test('a content type that is not on the list never reaches the caller', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 4096, types: ['text/plain'], perMinute: 20, aiGate: false, userAgent: 'test/1' };
  const out = await egress.fetchFiltered('https://example.com/blob', {
    policy,
    fetchImpl: async (url) => ({ ...bodyOf('MZ', 'application/x-msdownload'), url }),
  });
  assert.equal(out.ok, false);
  assert.match(out.why, /not on the allowed list/);
});

test('a redirect into the private network is refused after the fact', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 4096, types: ['text/plain'], perMinute: 20, aiGate: false, userAgent: 'test/1' };
  const out = await egress.fetchFiltered('https://example.com/away', {
    policy,
    fetchImpl: async () => ({ ...bodyOf('secret', 'text/plain'), url: 'http://192.168.0.9/admin' }),
  });
  assert.equal(out.ok, false);
  assert.match(out.why, /redirected somewhere it may not go/);
});

test('the per-minute ceiling counts refusals rather than hammering the host', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 4096, types: ['text/plain'], perMinute: 2, aiGate: false, userAgent: 'test/1' };
  const fetchImpl = async (url) => ({ ...bodyOf('ok', 'text/plain'), url });
  assert.equal((await egress.fetchFiltered('https://example.com/1', { policy, fetchImpl })).ok, true);
  assert.equal((await egress.fetchFiltered('https://example.com/2', { policy, fetchImpl })).ok, true);
  const third = await egress.fetchFiltered('https://example.com/3', { policy, fetchImpl });
  assert.equal(third.ok, false);
  assert.match(third.why, /More than 2 request/);
  egress.setPolicy({ perMinute: 90, allowHosts: [], types: ['text/plain'] });
  resetWindow();
});

test('a gate can read the payload and refuse it before the caller sees it', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 4096, types: ['text/plain'], perMinute: 20, aiGate: true, userAgent: 'test/1' };
  const seen = [];
  const out = await egress.fetchFiltered('https://example.com/note', {
    policy,
    fetchImpl: async (url) => ({ ...bodyOf('off topic chatter', 'text/plain'), url }),
    gate: async (payload) => {
      seen.push(payload.text);
      return { allow: false, reason: 'Not about this goal.' };
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.why, 'Not about this goal.');
  assert.deepEqual(seen, ['off topic chatter']);
});

test('a failed fetch is reported, not thrown', async () => {
  resetWindow();
  const policy = { allowHosts: [], allowLocal: false, maxBytes: 4096, types: ['text/plain'], perMinute: 20, aiGate: false, userAgent: 'test/1' };
  const out = await egress.fetchFiltered('https://example.com/boom', {
    policy,
    fetchImpl: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.why, /socket hang up/);
});
