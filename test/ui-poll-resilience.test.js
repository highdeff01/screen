import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const apiSource = source.slice(source.indexOf('async function api('), source.indexOf('\nfunction toast('));
const bootSource = source.slice(source.indexOf('async function boot()'), source.indexOf('\nboot();'));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function apiHarness(fetch) {
  const timers = new Map();
  let nextId = 0;
  const context = {
    fetch, AbortController,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const api = vm.runInNewContext(`${apiSource}\napi`, context);
  return { api, timers };
}

test('API times out and aborts a hung fetch, then cleans up', async () => {
  let signal;
  const { api, timers } = apiHarness((_path, options) => { signal = options.signal; return new Promise(() => {}); });
  const result = api('/api/state');
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 15000);
  timer.fn();
  assert.equal((await result).error, 'Request timed out.');
  assert.equal(signal.aborted, true);
  assert.equal(timers.size, 0);
});

test('API bounds stalled response bodies and cleans up successful and failed requests', async () => {
  const stalled = apiHarness(async () => ({ status: 200, json: () => new Promise(() => {}) }));
  const result = stalled.api('/api/state');
  await flush();
  [...stalled.timers.values()][0].fn();
  assert.equal((await result).ok, false);
  assert.equal(stalled.timers.size, 0);

  let passedOptions;
  const success = apiHarness(async (_path, options) => {
    passedOptions = options;
    return { json: async () => ({ ok: true }) };
  });
  const caller = new AbortController();
  const request = success.api('/api/action', { method: 'POST', body: { a: 1 }, signal: caller.signal });
  assert.equal([...success.timers.values()][0].ms, 300000);
  assert.equal((await request).ok, true);
  assert.equal(passedOptions.body, '{"a":1}');
  assert.equal(success.timers.size, 0);
  caller.abort();
  assert.equal(passedOptions.signal.aborted, false, 'caller abort listener was removed');

  const failure = apiHarness(async () => { throw new Error('network down'); });
  assert.equal((await failure.api('/api/state')).error, 'network down');
  assert.equal(failure.timers.size, 0);
});

test('state polling retries failures without overlapping polls', async () => {
  const scheduled = [];
  const errors = [];
  let calls = 0;
  let finishRefresh;
  const context = {
    ui: { data: { counts: {} } },
    document: { activeElement: null, hidden: false },
    render: () => {}, loadAuth: () => {}, loadHealth: () => {},
    loadCaptures: async () => {}, loadChat: async () => {},
    refresh: () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('render failed'));
      return new Promise((resolve) => { finishRefresh = resolve; });
    },
    console: { error: (...args) => errors.push(args) },
    setTimeout: (fn, ms) => scheduled.push({ fn, ms }),
    setInterval: () => {},
  };
  vm.runInNewContext(`${bootSource}\nboot();`, context);
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 2000);
  scheduled.shift().fn();
  await flush();
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 0, 'no next poll while refresh is pending');
  finishRefresh();
  await flush();
  assert.equal(scheduled.length, 1);
});
