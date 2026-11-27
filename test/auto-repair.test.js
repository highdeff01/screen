import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-auto-repair-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const repair = await load('server/auto-repair.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function reset(overrides = {}) {
  const d = store.db();
  d.workflows = [];
  d.runs = [];
  d.settings.autoRepair = { ...repair.AUTO_REPAIR_DEFAULTS, ...overrides };
  return d;
}

function workflow(id = 'wf_auto') {
  const wf = { id, name: 'Automatic repair proof', steps: [{ id: 'stp_1', type: 'note', name: 'Start', params: { text: 'one' } }], updatedAt: null };
  store.db().workflows.push(wf);
  return wf;
}

function run(overrides = {}) {
  const entry = {
    id: 'run_auto',
    workflowId: 'wf_auto',
    workflowName: 'Automatic repair proof',
    status: 'failed',
    dryRun: false,
    retryDepth: 0,
    steps: [],
    log: [],
    analysis: null,
    closeout: null,
    ...overrides,
  };
  store.db().runs.push(entry);
  return entry;
}

test('settings default to off and every bound holds', () => {
  const d = reset();
  assert.deepEqual(repair.autoRepairSettings(), repair.AUTO_REPAIR_DEFAULTS);
  const normalized = repair.normalizeAutoRepair({
    appendFixes: 1,
    analyzeIncomplete: 'yes',
    applyReshaped: true,
    monitorReplan: 'on',
    monitorIntervalMs: 5,
    monitorMaxReads: 9000,
    maxFocusLevel: 99,
  });
  assert.equal(normalized.appendFixes, false, 'only a real true turns a flag on');
  assert.equal(normalized.analyzeIncomplete, false);
  assert.equal(normalized.applyReshaped, true);
  assert.equal(normalized.monitorReplan, false);
  assert.equal(normalized.monitorIntervalMs, 500);
  assert.equal(normalized.monitorMaxReads, 200);
  assert.equal(normalized.maxFocusLevel, 5);
  assert.equal(d.settings.autoRepair.maxFocusLevel, 5);
});

test('focus level climbs with retries and importance, capped at five', () => {
  reset();
  assert.equal(repair.focusLevelFor({ run: { retryDepth: 0 }, importance: 0 }), 1);
  assert.equal(repair.focusLevelFor({ run: { retryDepth: 1 }, importance: 0 }), 2);
  assert.equal(repair.focusLevelFor({ run: { retryDepth: 0 }, importance: 2 }), 3, 'important steps start higher');
  assert.equal(repair.focusLevelFor({ run: { retryDepth: 4 }, importance: 2 }), 5, 'never above five');
  assert.equal(repair.focusLevelFor({ run: { retryDepth: 9 }, importance: 0, max: 3 }), 3, 'the setting lowers the ceiling');
});

test('importance is higher for input steps and an unproved goal', () => {
  reset();
  assert.equal(repair.importanceOf({ type: 'type' }, {}), 2);
  assert.equal(repair.importanceOf({ type: 'clickElement' }, {}), 2);
  assert.equal(repair.importanceOf({ type: 'waitFor' }, {}), 1);
  assert.equal(repair.importanceOf({ type: 'note' }, {}), 0);
  assert.equal(repair.importanceOf({ type: 'note' }, { goalUnverified: true }), 2);
  assert.equal(repair.importanceOf(null, { goalUnverified: true }), 2);
});

test('only steps with nothing detected count as incomplete', () => {
  const entry = run({
    steps: [
      { id: 'a', type: 'clickElement', name: 'Open Settings', status: 'failed', error: 'Element “Settings” was not found in “Sightline Profile”.' },
      { id: 'b', type: 'type', name: 'Type a note', status: 'failed', error: 'The foreground window changed.' },
      { id: 'c', type: 'note', name: 'Recorded', status: 'passed' },
    ],
    unverifiedSteps: [{ stepId: 'd', name: 'Save', reason: 'no file arrived' }],
  });
  const gaps = repair.incompleteStepEntries(entry);
  assert.deepEqual(gaps.map((gap) => gap.id), ['a', 'd']);
  assert.match(gaps[0].reason, /not found/);
});

test('a goal never proved is an incomplete step of its own', () => {
  const entry = run({ goalUnverified: true, goalVerdict: { reason: 'the document was never saved' } });
  const gaps = repair.incompleteStepEntries(entry);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].name, 'Goal proof');
  assert.match(gaps[0].reason, /never saved/);
});

test('suggested steps are applied once, with the same filter as the button', () => {
  reset();
  const wf = workflow();
  const entry = run({
    steps: [{ id: 'a', type: 'clickElement', name: 'Open', status: 'failed', error: 'not found' }],
    analysis: {
      suggestedSteps: [
        { type: 'wait', name: 'Wait for nothing in particular', params: { ms: 900 } },
        { type: 'focusWindow', name: 'Focus the app', params: { title: 'Sightline Profile' } },
        { type: 'writeTextFile', name: 'Empty file', params: {} },
      ],
    },
  });
  const applied = repair.applyAnalysisSteps(entry);
  assert.equal(applied.appended, 1, 'a blind wait and an empty file write are refused');
  assert.equal(wf.steps.length, 2);
  assert.equal(wf.steps[1].type, 'focusWindow');
  assert.ok(entry.analysis.appliedAt);
  assert.throws(() => repair.applyAnalysisSteps(run({ workflowId: 'wf_missing' })), /Workflow not found/);
});

test('auto repair does nothing while the checkboxes are off', async () => {
  reset();
  const entry = run();
  const result = await repair.afterRunAutoRepair(entry, { analyze: async () => assert.fail('must not call the model') });
  assert.deepEqual(result, { skipped: 'auto repair is off' });
});

test('the append checkbox writes the closeout follow-up into the workflow', async () => {
  reset({ appendFixes: true });
  const wf = workflow();
  const entry = run({
    closeout: {
      action: 'save-close',
      appended: false,
      followUpSteps: [
        { type: 'key', name: 'Save the document', params: { keys: 'ctrl+s' } },
        { type: 'closeWindow', name: 'Close the window', params: { title: 'Untitled' } },
      ],
    },
  });
  const record = await repair.afterRunAutoRepair(entry);
  assert.equal(record.appended, 2);
  assert.equal(wf.steps.length, 3);
  assert.equal(entry.closeout.appended, true);
  assert.ok(record.notes.some((note) => /follow-up/i.test(note)));
  const again = await repair.afterRunAutoRepair(entry);
  assert.equal(again.doneAt, record.doneAt, 'the pass runs once per run');
  assert.equal(wf.steps.length, 3);
});

test('the analyse checkbox appends steps for a step where nothing was detected', async () => {
  reset({ analyzeIncomplete: true });
  const wf = workflow();
  const entry = run({
    steps: [{ id: 'a', type: 'clickElement', name: 'Open Settings', status: 'failed', error: 'No matching element was found.' }],
  });
  let asked = 0;
  const record = await repair.afterRunAutoRepair(entry, {
    analyze: async () => {
      asked += 1;
      return { summary: 'The menu moved', suggestedSteps: [{ type: 'key', name: 'Open the menu', params: { keys: 'alt+f' } }] };
    },
  });
  assert.equal(asked, 1);
  assert.equal(record.analyzed, true);
  assert.equal(wf.steps.length, 2);
  assert.equal(wf.steps[1].type, 'key');
  assert.equal(record.appended, 1);
});

test('an analysis that yields nothing usable is recorded, not thrown', async () => {
  reset({ analyzeIncomplete: true });
  const entry = run({ steps: [{ id: 'a', type: 'clickElement', name: 'Open', status: 'failed', error: 'element not found' }] });
  const record = await repair.afterRunAutoRepair(entry, { analyze: async () => ({ suggestedSteps: [] }) });
  assert.equal(record.analyzed, true);
  assert.match(record.notes.join(' '), /nothing usable/i);
});

test('a dry run is never auto-repaired', async () => {
  reset({ appendFixes: true, analyzeIncomplete: true });
  const entry = run({ dryRun: true });
  assert.deepEqual(await repair.afterRunAutoRepair(entry), { skipped: 'not a live run' });
});

test('reordering only permutes pending steps after the running one', () => {
  const entry = run({
    currentStepId: 'b',
    steps: [
      { id: 'a', type: 'note', name: 'Done', status: 'passed' },
      { id: 'b', type: 'note', name: 'Running', status: 'running' },
      { id: 'c', type: 'note', name: 'Next', status: 'pending' },
      { id: 'd', type: 'note', name: 'Later', status: 'pending' },
      { id: 'e', type: 'note', name: 'Last', status: 'passed' },
    ],
  });
  const record = repair.reorderPending(entry, ['d']);
  assert.ok(record);
  assert.deepEqual(entry.steps.map((step) => step.id), ['a', 'b', 'd', 'c', 'e']);
  assert.equal(entry.steps[1].status, 'running', 'the running step is untouched');
  assert.equal(entry.steps[4].status, 'passed', 'a finished tail step keeps its slot');
  assert.equal(repair.reorderPending(entry, ['d']), null, 'an order already in place is not re-applied');
});

test('the monitor moves a visible later step ahead of a missing one', () => {
  const entry = run({
    status: 'running',
    currentStepId: 'a',
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Continue', params: { name: 'Continue' }, status: 'pending' },
      { id: 'c', type: 'clickElement', name: 'Notifications', params: { name: 'Notifications' }, status: 'pending' },
    ],
  });
  const decision = repair.chooseReorder(entry, ['Profile', 'Notifications']);
  assert.equal(decision.ids[0], 'c');
  assert.equal(repair.chooseReorder(entry, ['Continue']), null, 'no move when the next step is already possible');
});

test('the monitor never rewrites a plan before a step is running', () => {
  const entry = run({
    status: 'running',
    currentStepId: null,
    steps: [
      { id: 'a', type: 'focusWindow', name: 'Focus the app', params: { title: 'Sightline Profile' }, status: 'pending' },
      { id: 'b', type: 'clickElement', name: 'Notifications', params: { name: 'Notifications' }, status: 'pending' },
    ],
  });
  assert.equal(repair.chooseReorder(entry, ['Notifications']), null, 'the leading focus step is never moved');
});

test('the monitor never crosses a focus/launch step or a skip rule', () => {
  const entry = run({
    status: 'running',
    currentStepId: 'a',
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Continue', params: { name: 'Continue' }, status: 'pending' },
      { id: 'c', type: 'focusWindow', name: 'Focus', params: { title: 'Sightline Profile' }, status: 'pending' },
      { id: 'd', type: 'clickElement', name: 'Notifications', params: { name: 'Notifications' }, status: 'pending' },
    ],
  });
  assert.equal(repair.chooseReorder(entry, ['Notifications']), null, 'a step after a focus guard stays after it');
  const skipEntry = run({
    id: 'run_skip',
    status: 'running',
    currentStepId: 'a',
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Continue', params: { name: 'Continue' }, status: 'pending' },
      { id: 'c', type: 'clickElement', name: 'Settings', params: { name: 'Settings' }, skipIfVisible: 'Notifications', status: 'pending' },
    ],
  });
  assert.equal(repair.chooseReorder(skipEntry, ['Settings']), null, 'a step with its own skip rule is left alone');
});

test('the monitor stops after two moves in one run', () => {
  const entry = run({
    status: 'running',
    currentStepId: 'a',
    reorders: [{ at: 'now' }, { at: 'now' }],
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Continue', params: { name: 'Continue' }, status: 'pending' },
      { id: 'c', type: 'clickElement', name: 'Notifications', params: { name: 'Notifications' }, status: 'pending' },
    ],
  });
  assert.equal(repair.chooseReorder(entry, ['Notifications']), null);
});

test('monitor ticks obey the checkbox, the read budget and the live-run rule', async () => {
  const d = reset({ monitorReplan: false });
  d.runs.push(run({ id: 'run_off', status: 'running' }));
  assert.deepEqual(await repair.monitorTick({ read: async () => ['Notifications'] }), { skipped: 'monitor is off' });

  d.settings.autoRepair.monitorReplan = true;
  d.runs = d.runs.filter((entry) => entry.id !== 'run_off');
  const entry = run({
    id: 'run_on',
    status: 'running',
    currentStepId: 'a',
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Continue', params: { name: 'Continue' }, status: 'pending' },
      { id: 'c', type: 'clickElement', name: 'Notifications', params: { name: 'Notifications' }, status: 'pending' },
    ],
  });
  d.settings.autoRepair.monitorMaxReads = 1;
  const first = await repair.monitorTick({ read: async () => ['Notifications'] });
  assert.equal(first.results[0].reordered, true);
  assert.equal(entry.monitor.reads, 1);
  assert.equal(entry.monitor.reorders, 1);
  assert.equal(entry.steps.map((step) => step.id).join(','), 'a,c,b');
  const second = await repair.monitorTick({ read: async () => ['Notifications'] });
  assert.equal(second.results[0].skipped, 'read budget spent');
  assert.equal(entry.monitor.reads, 1);
});

test('the monitor does not read the screen when no reorder is possible', async () => {
  const d = reset({ monitorReplan: true });
  const entry = run({
    id: 'run_quiet',
    status: 'running',
    currentStepId: 'a',
    steps: [
      { id: 'a', type: 'note', name: 'Working', status: 'running' },
      { id: 'b', type: 'clickElement', name: 'Settings', params: { name: 'Settings' }, skipIfVisible: 'Notifications', status: 'pending' },
    ],
  });
  let reads = 0;
  const result = await repair.monitorTick({ read: async () => { reads += 1; return ['Settings']; } });
  assert.equal(result.results[0].skipped, 'no reorder is possible');
  assert.equal(reads, 0, 'no OCR read is spent on a run that cannot be reordered');
  assert.equal(entry.monitor, undefined);
  assert.equal(d.settings.autoRepair.monitorReplan, true);
});
