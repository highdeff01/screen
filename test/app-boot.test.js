import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual browser boot and state-refresh functions with stalled
// optional endpoints, without requiring a browser or a running server.
test('boot renders state without waiting for optional startup requests', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('async function refresh(options = {})'), source.indexOf('async function loadHealth()'));
  const boot = source.slice(source.indexOf('async function boot()'), source.indexOf('\nboot();'));
  assert.match(refresh, /^async function refresh/);
  assert.match(boot, /^async function boot/);
  const pending = new Promise(() => {});
  const calls = [];
  const ui = { view: 'builder', data: null, rev: null };
  const context = {
    ui,
    api: async (path) => { calls.push(path); return { ok: true, rev: 1, counts: {} }; },
    loadAuth: () => { calls.push('auth'); return pending; },
    loadCaptures: () => { calls.push('captures'); return pending; },
    loadHealth: () => { calls.push('health'); return pending; },
    loadChat: () => { calls.push('chat'); return pending; },
    render: () => calls.push(ui.data ? 'render-state' : 'render-loading'),
    document: { activeElement: null, hidden: false },
    setTimeout: () => calls.push('poll-scheduled'),
    setInterval: () => {},
    toast: () => {},
  };
  vm.runInNewContext(`${refresh}\n${boot}\nboot();`, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.includes('render-loading'));
  assert.ok(calls.includes('/api/state'));
  assert.ok(calls.includes('render-state'));
  assert.ok(calls.includes('poll-scheduled'));
  assert.deepEqual(calls.filter((call) => ['auth', 'captures', 'health', 'chat'].includes(call)).sort(), ['auth', 'captures', 'chat', 'health']);
});

test('window actions and drag-copy have editor metadata', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const definitions = source.slice(source.indexOf('const TYPE_META ='), source.indexOf('function stepSummary('));
  const context = {};
  vm.runInNewContext(`${definitions}\nglobalThis.editor = { TYPE_META, FIELDS, DEFAULTS };`, context);
  const editor = context.editor;
  for (const type of ['windowAction', 'dragCopy']) {
    assert.ok(editor.TYPE_META[type]);
    assert.ok(editor.FIELDS[type]?.length);
    assert.ok(editor.DEFAULTS[type]);
  }
  assert.ok(editor.FIELDS.windowAction.some((field) => field.key === 'action'));
  assert.ok(editor.FIELDS.dragCopy.some((field) => field.key === 'outputVar'));
});

test('header renders and clears the relay review badge', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const header = source.slice(source.indexOf('function renderHeader()'), source.indexOf('/* ------------------------------------------------------------------ views */'));
  assert.match(header, /^function renderHeader/);
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', className: '', classList: { toggle() {} } });
    return elements.get(id);
  };
  const ui = {
    data: { settings: { dryRun: true }, counts: { activeRuns: 2 }, relay: { openReviews: 3 } },
    view: 'relay',
    auth: { authenticated: true, username: 'operator' },
  };
  const context = { ui, $: element, document: { querySelectorAll: () => [] } };
  vm.runInNewContext(`${header}\nrenderHeader();`, context);
  assert.equal(element('#badge-relay').textContent, '3');
  assert.equal(element('#admin-btn').textContent, 'Admin · operator');
  assert.equal(element('#engine-label').textContent, '2 run active');
  ui.data.relay.openReviews = 0;
  vm.runInNewContext('renderHeader();', context);
  assert.equal(element('#badge-relay').textContent, '');
  delete ui.data.relay;
  vm.runInNewContext('renderHeader();', context);
  assert.equal(element('#badge-relay').textContent, '');
});
