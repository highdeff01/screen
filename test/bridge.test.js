import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-bridge-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const bridge = await load('server/bridge.js');

const filePath = path.join(tempRoot, 'payload.bin');
const payload = Buffer.from('0123456789abcdefghij', 'utf8');
fs.writeFileSync(filePath, payload);

after(() => {
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function fakeResponse() {
  const res = new EventEmitter();
  res.status = null;
  res.headers = {};
  res.chunks = [];
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers || {};
  };
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(Buffer.from(chunk));
    res.ended = true;
    res.emit('finish');
  };
  return res;
}

async function drain(res, timeout = 4000) {
  if (res.ended) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the bridge stream did not finish')), timeout);
    res.once('finish', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('a bridge carries one real file and refuses anything else', () => {
  const missing = bridge.openBridge({ filePath: path.join(tempRoot, 'nope.bin') });
  assert.equal(missing.ok, false);
  assert.match(missing.why, /Cannot read/);

  const folder = bridge.openBridge({ filePath: tempRoot });
  assert.equal(folder.ok, false);
  assert.match(folder.why, /one file/);

  const opened = bridge.openBridge({ filePath, name: 'payload', contentType: 'application/octet-stream', ttlMs: 60000 });
  assert.equal(opened.ok, true);
  assert.equal(opened.bytes, payload.length);
  assert.equal(opened.name, 'payload');
  assert.match(opened.pullPath, new RegExp(`/api/bridge/pull/${opened.id}\\?token=`));
  assert.equal(bridge.bridgeStatus().open >= 1, true);
});

test('an unknown id, a wrong token, a closed bridge and an expired one are told apart', () => {
  const opened = bridge.openBridge({ filePath, ttlMs: 60000 });
  assert.equal(bridge.bridgeFor('brg_missing', opened.token).status, 404);
  assert.equal(bridge.bridgeFor(opened.id, 'wrong').status, 403);
  assert.equal(bridge.bridgeFor(opened.id, opened.token).ok, true);

  assert.equal(bridge.closeBridge(opened.id).ok, true);
  assert.equal(bridge.bridgeFor(opened.id, opened.token).status, 410);

  const expiring = bridge.openBridge({ filePath, ttlMs: 60000 });
  const entry = bridge.__bridgeState.bridges.get(expiring.id);
  entry.expiresAt = Date.now() - 1;
  const late = bridge.bridgeFor(expiring.id, expiring.token);
  assert.equal(late.ok, false);
  assert.match(late.why, /expired/);
});

test('a range is resolved inside the file, including a suffix range', () => {
  const whole = bridge.parseRange('', payload.length);
  assert.equal(whole.ok, true);
  assert.equal(whole.partial, false);
  assert.equal(whole.start, 0);
  assert.equal(whole.end, payload.length - 1);

  const middle = bridge.parseRange('bytes=2-5', payload.length);
  assert.deepEqual({ start: middle.start, end: middle.end, partial: middle.partial }, { start: 2, end: 5, partial: true });

  const open = bridge.parseRange('bytes=15-', payload.length);
  assert.equal(open.start, 15);
  assert.equal(open.end, payload.length - 1);

  const tail = bridge.parseRange('bytes=-4', payload.length);
  assert.equal(tail.start, payload.length - 4);
  assert.equal(tail.end, payload.length - 1);

  assert.equal(bridge.parseRange('bytes=9-2', payload.length).ok, false);
  assert.equal(bridge.parseRange(`bytes=${payload.length}-`, payload.length).ok, false);
  assert.equal(bridge.parseRange('items=0-2', payload.length).ok, false);
});

test('a pull resumes from the byte it stopped at and counts what it sent', async () => {
  const opened = bridge.openBridge({ filePath, ttlMs: 60000 });
  const first = fakeResponse();
  const served = bridge.streamBridge(opened.id, opened.token, { headers: { range: 'bytes=0-9' } }, first);
  assert.equal(served.ok, true);
  await drain(first);
  assert.equal(first.status, 206);
  assert.equal(first.headers['content-range'], `bytes 0-9/${payload.length}`);
  assert.equal(first.headers['accept-ranges'], 'bytes');
  assert.equal(Buffer.concat(first.chunks).toString(), '0123456789');

  const second = fakeResponse();
  bridge.streamBridge(opened.id, opened.token, { headers: { range: 'bytes=10-' } }, second);
  await drain(second);
  assert.equal(second.status, 206);
  assert.equal(Buffer.concat(second.chunks).toString(), payload.slice(10).toString());

  const status = bridge.bridgeStatus();
  const list = status.list.find((entry) => entry.id === opened.id);
  assert.equal(list.pulls, 2);
  assert.equal(list.bytesSent, payload.length);
  assert.equal(status.served >= 2, true);
  assert.equal(status.refused >= 0, true);
});

test('a refused pull answers with a status and no bytes', () => {
  const opened = bridge.openBridge({ filePath, ttlMs: 60000 });
  const res = fakeResponse();
  const out = bridge.streamBridge(opened.id, 'not-the-token', { headers: {} }, res);
  assert.equal(out.ok, false);
  assert.equal(res.status, 403);
  const body = JSON.parse(Buffer.concat(res.chunks).toString());
  assert.equal(body.ok, false);
  assert.match(body.error, /token is wrong/);
  assert.equal(bridge.bridgeStatus().refused >= 1, true);
});

test('a range outside the file is a 416 that says how big the file is', () => {
  const opened = bridge.openBridge({ filePath, ttlMs: 60000 });
  const res = fakeResponse();
  const out = bridge.streamBridge(opened.id, opened.token, { headers: { range: `bytes=${payload.length + 5}-` } }, res);
  assert.equal(out.ok, false);
  assert.equal(res.status, 416);
  assert.equal(res.headers['content-range'], `bytes */${payload.length}`);
});
