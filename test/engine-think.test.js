import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-engine-think-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const dialogObservation = {
  foreground: { title: 'Open Folder', process: 'Kiro', className: '#32770' },
  windows: [
    { title: 'Open Folder', process: 'Kiro', className: '#32770' },
    { title: 'Getting started - Kiro', process: 'Kiro', className: '' },
  ],
  focused: { found: true, name: 'text area', controlType: 'Edit', editable: true, window: 'Open Folder' },
  elements: [{ name: 'Search', controlType: 'Edit', window: 'Getting started - Kiro' }],
};

function resetDb(stepThink) {
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.agentReplans = false;
  d.settings.aiSuggestions = false;
  d.settings.visualChecks = false;
  d.settings.presenterSettleMs = 0;
  d.settings.stepThink = { ...stepThink };
  d.workflows = [];
  d.runs = [];
  d.recoveryPacks = [];
  return d;
}

function workflow(id) {
  return {
    id,
    name: 'Thinking repair',
    description: 'Type into Kiro after answering its folder dialog.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      {
        id: 'stp_type_think',
        type: 'type',
        name: 'Type the prompt',
        params: { text: 'what is a diamond', foreground: 'Getting started - Kiro' },
        timeoutMs: 8000,
      },
    ],
  };
}

// Guard steps the repair chain prepends ("Confirm X stayed in front") are not
// the correction itself; the stub lets them pass so the click is exercised.
const isGuardStep = (step) =>
  ['expect', 'mediaHold'].includes(step.type) || String(step.type || '').startsWith('verify');

function probe({ executeStep }) {
  return {
    executeStep: async (step, ctx) =>
      isGuardStep(step) ? { output: 'confirmed', evidence: [] } : executeStep(step, ctx),
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    readFocusedElement: async () => ({
      found: true,
      name: 'text area',
      controlType: 'Edit',
      editable: true,
      window: 'Getting started - Kiro',
      value: 'what is a diamond',
    }),
    findUiElement: async () => ({ found: true }),
    inspectWindowState: async ({ title } = {}) => ({
      state: 'foreground',
      foreground: { title: title || '' },
    }),
    readScreenContext: async () => dialogObservation,
    readThinkObservation: async () => dialogObservation,
    agentAsk: async () => ({ ok: false, error: 'offline' }),
  };
}

async function settle(runId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = store.db().runs.find((entry) => entry.id === runId);
    if (run && !['queued', 'running'].includes(run.status)) return run;
    await sleep(25);
  }
  return store.db().runs.find((entry) => entry.id === runId);
}

test('a prepared correction is tried first when the step fails, and the retry proves it', async () => {
  const d = resetDb({
    enabled: true,
    modelAssist: false,
    pixels: 0,
    elements: 25,
    intervalMs: 500,
    readOnce: true,
    autoApply: true,
    overseer: true,
    maxAutoApplies: 3,
    maxRejects: 4,
    stepRejectLimit: 2,
  });
  const wf = workflow('wf_engine_think_ok');
  d.workflows = [wf];

  // The first typing attempt fails behind the folder dialog; once the prepared
  // click answers the dialog, the retried step is allowed to succeed.
  let typeAttempts = 0;
  const stub = probe({
    executeStep: async (step) => {
      if (step.type === 'type') {
        typeAttempts += 1;
        if (typeAttempts === 1) {
          await sleep(900);
          throw new Error('the text never appeared in the editor');
        }
        return { output: 'typed', evidence: [] };
      }
      if (step.type === 'clickElement' && /^open$/i.test(step.params?.name || '')) {
        return { output: 'clicked Open', evidence: [] };
      }
      throw new Error(`unexpected repair step ${step.type}: ${step.name}`);
    },
  });

  const run = engine.createRun(wf, { dryRun: false, probe: stub, repair: true, aiReplan: false });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  assert.equal(step.status, 'passed', step.error || 'the correction should let the step pass');
  assert.match(String(step.repairedBy || ''), /^step-think: /);
  assert.match(
    String(step.repairs?.[0]?.method || ''),
    /^step-think: /,
    'the prepared correction is the first repair attempted'
  );
  assert.equal(step.think?.dialog?.kind, 'openFolder');
  assert.ok((step.think?.alternatives || []).length >= 5, 'five alternatives are kept on the step');
  assert.equal(step.think?.overseer?.decision, 'clear the blocker, then continue the step');
  assert.equal(finished.thinkStats?.applies, 1);
  assert.equal(finished.thinkStats?.rejects || 0, 0);
  assert.match(JSON.stringify(finished.log || []), /Step thinking prepared/);
});

test('reject caps stop prepared corrections after they keep failing', async () => {
  const d = resetDb({
    enabled: true,
    modelAssist: false,
    pixels: 0,
    elements: 25,
    intervalMs: 500,
    readOnce: true,
    autoApply: true,
    maxAutoApplies: 1,
    maxRejects: 2,
    stepRejectLimit: 1,
  });
  const wf = workflow('wf_engine_think_capped');
  d.workflows = [wf];

  const stub = probe({
    executeStep: async (step) => {
      if (step.type === 'type') {
        await sleep(700);
        throw new Error('no input appeared');
      }
      throw new Error(`correction ${step.name} did not help`);
    },
  });

  const run = engine.createRun(wf, { dryRun: false, probe: stub, repair: true, aiReplan: false });
  const finished = await settle(run.id);
  const step = finished.steps[0];
  assert.equal(step.status, 'failed');
  const thinkRepairs = (step.repairs || []).filter((entry) => String(entry.method).startsWith('step-think:'));
  assert.equal(thinkRepairs.length, 1, 'the reject cap stops the remaining prepared corrections');
  assert.equal(thinkRepairs[0].ok, false);
  assert.equal(finished.thinkStats?.applies || 0, 0);
  assert.ok((finished.thinkStats?.rejects || 0) >= 1);
  assert.ok((finished.thinkBlockedSteps || []).includes(step.id));
  assert.ok((step.think?.rejects || []).length >= 1, 'the rejected correction is recorded on the step');
  assert.match(JSON.stringify(finished.log || []), /Step thinking stopped|held back/);
});

test('keep-running continues after an unrepaired failure, up to its cap', async () => {
  const d = resetDb({ enabled: true, modelAssist: false, pixels: 0, elements: 0, keepRunning: true, maxStepFailures: 2 });
  const wf = {
    id: 'wf_engine_keep_running',
    name: 'Keep running',
    description: 'Two waits around a failing click.',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [
      { id: 'stp_wait_a', type: 'wait', name: 'Wait briefly', params: { ms: 5 }, timeoutMs: 2000 },
      { id: 'stp_click_fail', type: 'click', name: 'Click nothing useful', params: { foreground: 'Getting started - Kiro' }, timeoutMs: 4000 },
      { id: 'stp_wait_b', type: 'wait', name: 'Wait after the failure', params: { ms: 5 }, timeoutMs: 2000 },
    ],
  };
  d.workflows = [wf];

  const stub = probe({
    executeStep: async (step) => {
      if (step.type === 'click') throw new Error('the click landed nowhere');
      return { output: 'waited', evidence: [] };
    },
  });
  stub.readThinkObservation = async () => null;

  const run = engine.createRun(wf, { dryRun: false, probe: stub, repair: true, aiReplan: false });
  const finished = await settle(run.id);
  assert.equal(finished.steps[1].status, 'failed');
  assert.equal(finished.steps[2].status, 'passed', 'the later independent step still ran');
  assert(Array.isArray(finished.keptRunning) && finished.keptRunning.length === 1);
  assert.equal(finished.status, 'needs_review');
  assert.match(JSON.stringify(finished.log || []), /Keeping the run going/);
});
