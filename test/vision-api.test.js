/**
 * The vision routes, exercised through their own handlers.
 *
 * No server and no desktop: the handlers are called with a fake request and a
 * fake response, which is what the console's router does. What is asserted is
 * the contract the UI and the share links depend on — the GET shape, an isolated
 * session's own directory, the refusal of live control with no goal, and the
 * SSE route's framing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerVisionRoutes } from '../server/vision-api.js';
import { vision } from '../server/vision-engine.js';
import { visionSessions, SESSION_DIR } from '../server/vision-sessions.js';
import { visionBus } from '../server/vision-bus.js';
import { DATA } from '../server/store.js';

const routes = [];
let body = {};
registerVisionRoutes({
  route: (method, pattern, handler) => routes.push({ method, pattern, handler }),
  sendJson: (res, code, payload) => {
    res.code = code;
    res.payload = payload;
  },
  fail: (res, code, message) => {
    res.code = code;
    res.payload = { ok: false, error: message };
  },
  readBody: async () => body,
});

function handlerFor(method, url) {
  for (const entry of routes) {
    if (entry.method !== method) continue;
    if (!entry.pattern.test(url)) continue;
    return entry.handler;
  }
  throw new Error(`No route for ${method} ${url}`);
}

function fakeRes() {
  return {
    chunks: [],
    headers: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    on() {},
    text() {
      return this.chunks.join('');
    },
  };
}

async function call(method, url, payload = null) {
  body = payload || {};
  const res = fakeRes();
  const handler = handlerFor(method, url);
  await handler({ url }, res);
  return res;
}

test('the console stream is described with its sessions, control and push channel', async () => {
  const res = await call('GET', '/api/vision');
  assert.equal(res.code, 200);
  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.vision, 'the engine state is returned');
  assert.ok(res.payload.review, 'the labelling agent state is returned');
  assert.ok(Array.isArray(res.payload.sessions) && res.payload.sessions.some((session) => session.id === 'main'));
  assert.ok(res.payload.stream.pingMs > 0, 'the keep-alive interval is advertised');
  assert.ok(res.payload.control, 'live control state is returned');
});

test('an isolated session is opened in its own directory and closing it cleans up', async () => {
  const open = await call('POST', '/api/vision', { action: 'session-open', session: 'api-test', name: 'API test' });
  assert.equal(open.code, 200);
  assert.equal(open.payload.session.id, 'api-test');
  assert.equal(open.payload.session.isolated, true);
  assert.equal(open.payload.session.dir, `${SESSION_DIR}/api-test`);
  assert.ok(fs.existsSync(path.join(DATA, SESSION_DIR, 'api-test')), 'the session has its own directory');
  assert.ok(
    (open.payload.sessions || []).some((session) => session.id === 'api-test'),
    'the session list includes it'
  );

  const close = await call('POST', '/api/vision', { action: 'session-close', session: 'api-test' });
  assert.equal(close.code, 200);
  assert.equal(visionSessions.get('api-test'), null);
  assert.equal(fs.existsSync(path.join(DATA, SESSION_DIR, 'api-test')), false, 'its frames were removed');
  assert.equal(visionSessions.close('api-test'), false, 'closing twice is harmless');
});

test('live control refuses to start without a goal and leaves the desktop unread', async () => {
  assert.equal(vision.state().running, false, 'the test engine was idle before the request');
  const res = await call('POST', '/api/vision', { action: 'control', session: 'main', goal: '   ' });
  assert.equal(res.code, 400);
  assert.match(res.payload.error, /needs a goal/);
  assert.equal(vision.state().running, false, 'a refused request did not start the stream');
});

test('the stream route answers with server-sent events and a hello', async () => {
  const res = fakeRes();
  await handlerFor('GET', '/api/vision/stream')({ url: '/api/vision/stream?session=main' }, res);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.match(res.text(), /event: ready/);
  assert.match(res.text(), /"session":"main"/);
  assert.equal(visionBus.state().clients, 1);
  visionBus.stop();
  assert.equal(visionBus.state().clients, 0);
});
