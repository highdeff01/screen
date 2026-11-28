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
    loadVision: () => { calls.push('vision'); return pending; },
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

test('unavailable desktop control is not presented as live mode', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const header = source.slice(source.indexOf('function renderHeader()'), source.indexOf('/* ------------------------------------------------------------------ views */'));
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', title: '', disabled: false, className: '', classList: { toggle() {} } });
    return elements.get(id);
  };
  const ui = {
    data: {
      settings: { dryRun: false, targetPlatform: 'win32' },
      platform: { backend: 'linux', platform: 'linux', label: 'Linux', available: false, reason: 'Linux needs X11 and xdotool.' },
      counts: {},
    },
  };
  const context = { ui, $: element, document: { querySelectorAll: () => [] } };
  vm.runInNewContext(`${header}\nrenderHeader();`, context);
  assert.equal(element('#mode-label').textContent, 'Simulated · check live');
  assert.equal(element('#mode-pill').disabled, false);
  assert.match(element('#mode-pill').title, /Linux needs X11 and xdotool/);
  assert.match(element('#mode-pill').title, /does not connect another computer/);
  assert.equal(element('#target-os-select').value, 'win32');
  assert.equal(element('#platform-tag').textContent, 'Windows 11 plan · executor offline');
  ui.data.settings.dryRun = true;
  vm.runInNewContext(`${header}\nrenderHeader();`, context);
  assert.equal(element('#mode-label').textContent, 'Simulated · check live');
  assert.equal(element('#mode-pill').disabled, false);
});

test('planning target selection persists without changing executor availability', async () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="target-os-select"/);
  assert.match(html, /value="win32">Plan for Windows 11/);
  assert.match(app, /api\/live\/check/);
  assert.match(app, /or \$\{sim \? 'live' : 'simulated'\}/);
  const start = app.indexOf("document.addEventListener('change'");
  const end = app.indexOf("document.addEventListener('input'", start);
  const handlers = {};
  const calls = [];
  const ui = { data: { platform: { backend: 'linux', available: false }, settings: { targetPlatform: 'win32' } } };
  const context = {
    ui,
    document: { addEventListener: (type, handler) => { handlers[type] = handler; } },
    api: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
    toast: (message) => calls.push(message),
    refresh: async () => calls.push('refresh'),
  };
  vm.runInNewContext(app.slice(start, end), context);
  const select = { dataset: { scope: 'target-os' }, value: 'linux', disabled: false };
  handlers.change({ target: select });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].url, '/api/settings');
  assert.equal(calls[0].options.body.targetPlatform, 'linux');
  assert.equal(ui.data.platform.backend, 'linux');
  assert.equal(ui.data.settings.targetPlatform, 'linux');
  assert.equal(calls.at(-1), 'refresh');
});

test('live requests call the readiness endpoint before refusing an unavailable backend', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const start = source.indexOf('async function queueRun(id, mode)');
  const end = source.indexOf('\n}\n\n/* ------------------------------------------------------------------ events */', start) + 2;
  const calls = [];
  const ui = { data: { platform: { available: false, reason: 'No X11 display.' } }, runStarting: false };
  const context = {
    ui,
    api: async (url) => { calls.push(url); return { ok: true, available: false, reason: 'No X11 display.' }; },
    toast: (message) => calls.push(message),
    render: () => {},
  };
  await vm.runInNewContext(`${source.slice(start, end)}\nqueueRun('wf', 'live');`, context);
  assert.deepEqual(calls, ['/api/live/check', 'Live check failed: No X11 display.']);
});

test('sync settings show opt-in incoming updates and execution warning', () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function sharingPanel()');
  const end = source.indexOf('\nfunction settingsFields(', start);
  const ui = { data: { gitSync: { enabled: false }, settings: { autoPull: false }, share: {} }, settingsDraft: null };
  const context = { ui, esc: (value) => String(value), fmtTime: (value) => value };
  const panel = vm.runInNewContext(`${source.slice(start, end)}\nsharingPanel();`, context);
  assert.match(panel, /not a security sandbox/);
  assert.match(panel, /auto-sync off/);
  assert.match(panel, /data-key="autoPull"\s*\/>/);
  assert.match(panel, /value="10000" selected/);
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

test('a lost console server warns once instead of on every poll', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('async function refresh(options = {})'), source.indexOf('async function loadHealth()'));
  const toasts = [];
  let rendering = 0;
  let reached = 0;
  let offline = true;
  const engine = { textContent: '', previousElementSibling: { className: '' } };
  const ui = { view: 'builder', data: null, rev: null };
  const context = {
    ui,
    api: async () => (offline ? { ok: false, error: 'Failed to fetch' } : { ok: true, rev: 1, counts: {} }),
    toast: (message, kind) => toasts.push({ message, kind }),
    $: (selector) => (selector === '#engine-label' ? engine : null),
    render: () => { rendering += 1; },
    renderHeader: () => { reached += 1; },
    document: { activeElement: null, hidden: false },
  };
  await vm.runInNewContext(`${refresh}\n(async () => { await refresh(); await refresh(); })()`, context);
  assert.deepEqual(toasts.map((entry) => entry.message), ['Failed to fetch']);
  assert.equal(engine.textContent, 'console offline · retrying');
  assert.equal(engine.previousElementSibling.className, 'dot bad');
  assert.equal(rendering, 0, 'the poll does not repaint while the server is away');

  offline = false;
  await vm.runInNewContext('(async () => { await refresh(); })()', context);
  assert.deepEqual(toasts.map((entry) => entry.message), ['Failed to fetch', 'Reconnected to the console server.']);
  assert.equal(reached, 1, 'the rail label is repainted on reconnect');
  assert.equal(rendering, 1);
  assert.equal(ui.offline, false);
});

test('in-memory status of a running job still reaches its view', async () => {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('async function refresh(options = {})'), source.indexOf('async function loadHealth()'));
  const state = {
    ok: true,
    rev: 7,
    counts: {},
    gitSync: { status: 'idle', ahead: 0, behind: 0, lastCheckAt: null },
    sentinel: { busy: false },
    live: { running: false },
    relay: {},
    pipeline: {},
    activity: [],
  };
  const ui = { view: 'sentinel', data: null, rev: null };
  let renders = 0;
  // A fresh sandbox per poll: a re-used one keeps the previous script's
  // top-level declarations, and the second run would redeclare LIVE_FIELDS.
  const poll = () =>
    vm.runInNewContext(`${refresh}\n(async () => { await refresh(); })()`, {
      ui,
      api: async () => state,
      toast: () => {},
      render: () => { renders += 1; },
      renderHeader: () => {},
      $: () => null,
      document: { activeElement: null, hidden: false },
    });

  await poll();
  assert.equal(renders, 1, 'the first poll paints the view');
  await poll();
  assert.equal(renders, 1, 'an unchanged state does not repaint');

  state.sentinel.busy = true;
  await poll();
  assert.equal(renders, 2, 'the suite starting is shown');
  await poll();
  assert.equal(renders, 2);

  ui.view = 'builder';
  await poll();
  assert.equal(renders, 3, 'a new view is painted once');
  await poll();
  assert.equal(renders, 3);

  state.gitSync.status = 'push-failed';
  await poll();
  assert.equal(renders, 4, 'the sync pill follows a push that starts failing');
  state.gitSync.lastCheckAt = '2026-11-25T20:00:00.000Z';
  await poll();
  assert.equal(renders, 4, 'a quiet sync tick does not repaint');

  state.live.running = true;
  await poll();
  assert.equal(renders, 5, 'a live watcher starting or stopping is shown');
  state.activity.push({ id: 'act_1' });
  await poll();
  assert.equal(renders, 5, 'unrelated activity does not repaint');
});
