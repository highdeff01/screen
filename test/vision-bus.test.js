/**
 * The push channel: SSE framing, session filtering, keep-alive pings and what
 * happens to a viewer whose socket backs up. No browser and no timers — the
 * responses are fakes and the ping is called by hand.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVisionBus } from '../server/vision-bus.js';

function fakeRes() {
  return {
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    write(chunk) {
      if (this.failWrites) throw new Error('socket closed');
      this.chunks.push(String(chunk));
      return !this.backedUp;
    },
    end() {
      this.ended = true;
    },
    on(event, listener) {
      if (event === 'close') this.onClose = listener;
    },
    text() {
      return this.chunks.join('');
    },
  };
}

function bus() {
  const timers = [];
  const instance = createVisionBus({
    pingMs: 1000,
    maxClients: 2,
    schedule: (fn, ms) => {
      const timer = { fn, ms, unref() {}, cleared: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cleared = true;
    },
    clock: () => Date.parse('2026-11-28T10:00:00.000Z'),
  });
  return { instance, timers };
}

test('a subscriber gets SSE headers, a hello, and only its own session events', () => {
  const { instance } = bus();
  const res = fakeRes();
  instance.subscribe(res, { session: 'live', hello: { vision: { running: true } } });
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.match(res.text(), /event: ready/);
  assert.match(res.text(), /"session":"live"/);

  instance.publish('frame', { session: 'main', frame: { seq: 1 } });
  assert.equal(instance.state().clients, 1, 'a client of another session stays connected');
  assert.doesNotMatch(res.text(), /"seq":1/, 'and receives nothing from it');

  instance.publish('frame', { session: 'live', frame: { seq: 2 } });
  assert.match(res.text(), /event: frame/);
  assert.match(res.text(), /"seq":2/);
});

test('a ping keeps the pipe open and is a comment, not an event', () => {
  const { instance, timers } = bus();
  const res = fakeRes();
  instance.subscribe(res, { session: 'main' });
  assert.equal(timers.length, 1, 'one keep-alive timer for the viewers, not one per viewer');
  assert.equal(timers[0].ms, 1000);
  instance.pingNow();
  assert.match(res.text(), /: ping 1/);
  assert.equal(instance.state().pings, 1);

  res.onClose();
  assert.equal(instance.state().clients, 0);
  instance.pingNow();
  assert.doesNotMatch(res.text(), /: ping 2/, 'a closed viewer is not written to');
});

test('a backed-up viewer skips frames but still receives decisions and pings', () => {
  const { instance } = bus();
  const res = fakeRes();
  res.backedUp = true;
  instance.subscribe(res, { session: 'main' });
  const before = res.text();
  instance.publish('frame', { session: 'main', frame: { seq: 9 } });
  assert.equal(res.text(), before, 'the frame was skipped');
  assert.equal(instance.state().skipped, 1);

  instance.publish('replan', { session: 'main', reason: 'no change' });
  assert.match(res.text(), /event: replan/, 'a decision is never dropped');
  instance.pingNow();
  assert.match(res.text(), /: ping 1/);
});

test('a write that throws drops that viewer and leaves the others alone', () => {
  const { instance } = bus();
  const broken = fakeRes();
  const healthy = fakeRes();
  instance.subscribe(broken, { session: 'main' });
  instance.subscribe(healthy, { session: 'main' });
  broken.failWrites = true;
  instance.publish('frame', { session: 'main', frame: { seq: 3 } });
  assert.equal(instance.state().clients, 1);
  assert.equal(broken.ended, true);
  assert.match(healthy.text(), /"seq":3/);
  assert.equal(instance.state().dropped, 1);
});

test('the viewer cap refuses a new connection rather than overloading the console', () => {
  const { instance } = bus();
  instance.subscribe(fakeRes(), { session: 'main' });
  instance.subscribe(fakeRes(), { session: 'main' });
  assert.throws(() => instance.subscribe(fakeRes(), { session: 'main' }), (err) => err.busy === true);
  assert.equal(instance.state().clients, 2);
});

test('stop ends every viewer and clears the keep-alive timer', () => {
  const { instance, timers } = bus();
  const res = fakeRes();
  instance.subscribe(res, { session: 'main' });
  instance.stop();
  assert.equal(res.ended, true);
  assert.equal(instance.state().clients, 0);
  assert.equal(timers[0].cleared, true);
});
