import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-engine-screen-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function resetDb() {
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.visualChecks = true;
  d.settings.presenterSettleMs = 0;
  d.workflows = [];
  d.runs = [];
  d.recoveryPacks = [];
  return d;
}

async function settle(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return store.db().runs.find((entry) => entry.id === runId);
}

function probe({ focused, textFound = false, output = 'done' }) {
  return {
    executeStep: async () => ({ output, evidence: [] }),
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    readFocusedElement: async () => focused,
    findUiElement: async () => ({ found: textFound }),
  };
}

test('an unguarded type step with no window named is skipped, never typed anywhere', async () => {
  const d = resetDb();
  const workflow = {
    id: 'wf_engine_screen_no_window',
    name: 'Engine screen no window',
    description: 'Type the same text.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_anywhere', type: 'type', name: 'Type the same text', params: { text: 'same text' }, timeoutMs: 8000 }],
  };
  d.workflows = [workflow];

  const run = engine.createRun(workflow, {
    dryRun: false,
    probe: probe({ focused: { found: true, name: 'Text editor', value: 'same text', window: 'probe.txt - Notepad' }, textFound: true, output: 'typed' }),
  });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  assert.equal(step.status, 'skipped');
  assert.match(step.output, /no window was named or opened/);
  assert.equal(finished.status, 'passed', 'a skipped step is not a failure, it is work the run refused to guess at');
});

test('a type step with a named window that types identical text passes via corroboration', async () => {
  const d = resetDb();
  const workflow = {
    id: 'wf_engine_screen_type',
    name: 'Engine screen type',
    description: 'Type the same text in Notepad.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_same_text', type: 'type', name: 'Type the same text', params: { text: 'same text', foreground: 'probe.txt - Notepad' }, timeoutMs: 8000 },
    ],
  };
  d.workflows = [workflow];

  const run = engine.createRun(workflow, {
    dryRun: false,
    probe: probe({ focused: { found: true, name: 'Text editor', value: 'same text', window: 'probe.txt - Notepad' }, textFound: true, output: 'typed' }),
  });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  // The screen-change corroboration passes, but an unguarded type step cannot
  // prove Notepad received it, so the goal named in the description is withheld.
  assert.equal(finished.status, 'needs_review');
  assert.equal(step.status, 'passed');
  assert.equal(step.verification?.changedPct, 0);
  assert.match(step.verification?.corroborated || '', /already present in the window|field already contains/);
  assert.equal(finished.effectFailures || 0, 0);
});

test('a display-name launch target confirms the process it really focused', async () => {
  const d = resetDb();
  const workflow = {
    id: 'wf_engine_launch_display_name',
    name: 'Engine launch display name',
    description: 'Open Google Chrome.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_open_display', type: 'launchApp', name: 'Open Google Chrome', params: { target: 'Google Chrome' }, timeoutMs: 8000 }],
  };
  d.workflows = [workflow];

  const run = engine.createRun(workflow, {
    dryRun: false,
    probe: {
      executeStep: async () => ({
        output: 'focused existing chrome :: Sightline - screen agent console - Google Chrome',
        evidence: [],
      }),
      captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
      readFocusedElement: async () => ({ found: true, name: 'chrome', value: '', window: 'Sightline - Google Chrome' }),
      findUiElement: async () => ({ found: false }),
      inspectWindowState: async ({ process: proc = '' } = {}) => ({
        state: proc === 'chrome' ? 'foreground' : 'background',
        foreground: { title: 'Sightline - screen agent console - Google Chrome' },
      }),
    },
  });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  assert.equal(finished.status, 'passed');
  assert.equal(step.status, 'passed');
  assert.ok(!step.error);
  assert.match(step.verification?.detail || '', /chrome foreground/);
});

test('a no-op click that changed nothing and has no confirmation still fails', async () => {
  const d = resetDb();
  const workflow = {
    id: 'wf_engine_screen_click',
    name: 'Engine screen click',
    description: 'Click a blank area.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_blank_click', type: 'click', name: 'Click a blank area', params: { x: 300, y: 620 }, timeoutMs: 8000 }],
  };
  d.workflows = [workflow];

  const run = engine.createRun(workflow, {
    dryRun: false,
    probe: probe({ focused: { found: true, name: 'Text editor', value: '', window: 'probe.txt - Notepad' }, textFound: false, output: 'clicked' }),
  });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  assert.equal(finished.status, 'failed');
  assert.equal(step.status, 'failed');
  assert.match(step.error || '', /nothing on screen changed and no check confirmed it/);
  assert.equal(finished.effectFailures, 1);
});
