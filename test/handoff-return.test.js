import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-handoff-return-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const HANDOFF = {
  enabled: true,
  steps: [{ type: 'clickElement', name: 'Return', params: { window: 'Sightline Profile', name: 'Back' } }],
};

function fakeProbe({ title = 'Sightline Profile', labels = [], calls = [] } = {}) {
  return {
    calls,
    async readScreenContext() {
      calls.push('screen');
      return { foreground: { title, process: 'pythonw', handle: 4242 }, windows: [] };
    },
    async findUiElementByOcr(query) {
      calls.push(query.labelsOnly ? 'labels' : 'label');
      return { found: false, labels, title };
    },
  };
}

test('the start label is the distinctive one, not the window title or a nav word', () => {
  assert.equal(
    engine.pickStartLabel({
      labels: ['Sightline Profile', 'Open Settings to edit your profile.', 'Settings'],
      windowTitle: 'Sightline Profile',
    }),
    'Open Settings to edit your profile.'
  );
  assert.equal(
    engine.pickStartLabel({ labels: ['Notifications', 'Profile', 'Settings'], windowTitle: 'Sightline Profile' }),
    'Notifications'
  );
  assert.equal(
    engine.pickStartLabel({ labels: ['Settings', 'Profile'], windowTitle: 'Sightline Profile' }),
    '',
    'a lone nav word is not distinctive enough to assert a screen with'
  );
  assert.equal(engine.pickStartLabel({ labels: ['Sightline Profile'], windowTitle: 'Sightline Profile' }), '');
  assert.equal(engine.pickStartLabel({ labels: ['  ', '::', 'Settings'], windowTitle: 'Settings' }), '');
});

test('a workflow that will hand back records its start window and one label, once', async () => {
  const calls = [];
  const probe = fakeProbe({
    calls,
    labels: ['Sightline Profile', 'Open Settings to edit your profile.', 'Settings'],
  });
  const start = await engine.recordStartScreen({ id: 'run_start' }, { handoff: HANDOFF }, { probe });

  assert.ok(start, 'the start screen is recorded');
  assert.deepEqual(start.window, { title: 'Sightline Profile', process: 'pythonw', handle: 4242 });
  assert.equal(start.label, 'Open Settings to edit your profile.');
  assert.equal(start.labels, 3);
  assert.equal(typeof start.readMs, 'number');
  assert.deepEqual(calls, ['screen', 'labels'], 'one window read and one OCR pass, and nothing else');
});

test('a workflow without a hand-off pays nothing at run start', async () => {
  const calls = [];
  const probe = fakeProbe({ calls });
  assert.equal(await engine.recordStartScreen({ id: 'run_nohandoff' }, { handoff: { enabled: false, steps: [] } }, { probe }), null);
  assert.equal(
    await engine.recordStartScreen({ id: 'run_nosteps' }, { handoff: { enabled: true, steps: [] } }, { probe }),
    null
  );
  assert.deepEqual(calls, [], 'the screen is not read');
});

test('a probe that cannot read the screen records nothing instead of touching the real desktop', async () => {
  assert.equal(await engine.recordStartScreen({ id: 'run_probe' }, { handoff: HANDOFF }, { probe: {} }), null);
});

function startedRun(overrides = {}) {
  return {
    id: 'run_verify',
    status: 'passed',
    startScreen: {
      at: '2026-11-27T00:00:00.000Z',
      window: { title: 'Sightline Profile', process: 'pythonw', handle: 4242 },
      label: 'Open Settings to edit your profile.',
    },
    ...overrides,
  };
}

function reader({ title = 'Sightline Profile', found = true, text = 'Open Settings to edit your profile.' } = {}) {
  return {
    readScreen: async () => ({ foreground: { title }, windows: [] }),
    findLabel: async () => ({ found, text }),
  };
}

test('the return check passes when the start window shows the start label again', async () => {
  const run = startedRun();
  const check = await engine.verifyHandoffReturn(run, reader());

  assert.ok(check);
  assert.equal(check.ok, true);
  assert.deepEqual(check.expected, { window: 'Sightline Profile', label: 'Open Settings to edit your profile.' });
  assert.equal(check.found.window, 'Sightline Profile');
  assert.match(check.note, /Back on the start screen/);
  assert.equal(run.status, 'passed', 'the check never touches the verdict');
});

test('a different foreground window is a clear failure, and still no verdict change', async () => {
  const run = startedRun();
  const check = await engine.verifyHandoffReturn(run, reader({ title: 'Notepad — notes.txt' }));

  assert.equal(check.ok, false);
  assert.equal(check.found.window, 'Notepad — notes.txt');
  assert.match(check.note, /the foreground is “Notepad — notes\.txt”, not the start window “Sightline Profile”/);
  assert.equal(run.status, 'passed');
});

test('a fuzzy neighbour label is not the start label', async () => {
  const run = startedRun();
  const check = await engine.verifyHandoffReturn(
    run,
    reader({ found: true, text: 'Settings' })
  );

  assert.equal(check.ok, false, '“Settings” alone is not the Home hint');
  assert.equal(check.found.label, '');
  assert.match(check.note, /is not visible in “Sightline Profile” any more/);
  assert.equal(run.status, 'passed');
});

test('the label matcher tolerates OCR noise but not a different screen', () => {
  assert.equal(engine.labelStillVisible('Open Settings to edit your profile.', 'Open Settings to edit your profile.'), true);
  assert.equal(engine.labelStillVisible('Open Settings to edit vour profile.', 'Open Settings to edit your profile.'), true);
  assert.equal(engine.labelStillVisible('Settings', 'Open Settings to edit your profile.'), false);
  assert.equal(engine.labelStillVisible('Notifications', 'Open Settings to edit your profile.'), false);
  assert.equal(engine.labelStillVisible('', 'Open Settings to edit your profile.'), false);
});

test('the right window without the start label is a failure too', async () => {
  const run = startedRun();
  const check = await engine.verifyHandoffReturn(run, reader({ found: false }));

  assert.equal(check.ok, false);
  assert.equal(check.found.label, '');
  assert.match(check.note, /“Open Settings to edit your profile\.” is not visible in “Sightline Profile” any more/);
  assert.equal(run.status, 'passed');
});

test('a run with no recorded start screen or label asserts nothing', async () => {
  let read = 0;
  const options = {
    readScreen: async () => {
      read += 1;
      return { foreground: { title: 'Sightline Profile' } };
    },
    findLabel: async () => {
      read += 1;
      return { found: true, text: 'x' };
    },
  };
  assert.equal(await engine.verifyHandoffReturn({ id: 'r', status: 'passed' }, options), null);
  assert.equal(await engine.verifyHandoffReturn(startedRun({ startScreen: { window: { title: 'X' }, label: '' } }), options), null);
  assert.equal(read, 0, 'nothing is read when there is nothing to assert');
});
