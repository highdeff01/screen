import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-live-fallback-'));
process.chdir(tempRoot);
// Force the live backend unavailable (as a hosted preview or headless host is)
// without stubbing: no adb device is attached, so android targeting refuses.
process.env.SIGHTLINE_TARGET = 'android';
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');
const platform = await load('server/platform.js');

after(() => {
  platform.setProbeOverride(null);
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  platform.setProbeOverride(null);
  const d = store.db();
  d.settings.dryRun = false;
  d.settings.autoNotes = false;
  d.settings.autoRecoverFailures = false;
  d.settings.continuityAutoContinue = false;
  d.settings.presenterSettleMs = 0;
  d.runs = [];
  d.workflows = [];
  store.persist();
});

function probeWorkflow() {
  const d = store.db();
  const workflow = {
    id: 'wf_live_fallback',
    name: 'Live fallback probe',
    description: '',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_note', type: 'note', name: 'Say what happened', params: { text: 'hello' }, timeoutMs: 1000 }],
  };
  d.workflows = [workflow];
  store.persist();
  return workflow;
}

test('detection refuses and the real probe confirms: the run continues simulated', async () => {
  platform.setProbeOverride(() => ({ ok: false, detail: 'xdotool: cannot open display' }));
  const workflow = probeWorkflow();
  const run = engine.createRun(workflow, { dryRun: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 20000, intervalMs: 20 });
  assert.equal(finished.status, 'passed', `run finished ${finished.status}: ${(finished.steps?.[0] || {}).error || ''}`);
  assert.equal(finished.dryRun, true, 'the run continues as simulation');
  assert.match(String(finished.liveFallback || ''), /not supported|not implemented|unavailable|probe/i);
  assert.equal(finished.steps[0].status, 'passed');
  assert.ok(
    (finished.log || []).some((line) => /simulated instead/i.test(line.message || '')),
    'the run log names the conversion'
  );
});

test('detection refuses but the machine answers natively: the run continues live — detection was wrong', async () => {
  platform.setProbeOverride(() => ({ ok: true, detail: 'answered' }));
  const workflow = probeWorkflow();
  // A passed live run without a probe needs the step to really execute; on
  // this machine it does (the probe just proved it), and a note step is safe.
  const run = engine.createRun(workflow, { dryRun: false });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });
  assert.equal(finished.dryRun, false, 'the run was never downgraded');
  assert.equal(finished.detectionCorrected, true);
  assert.ok(
    (finished.log || []).some((line) => /initial detection was wrong|answers natively/i.test(line.message || '')),
    'the run log names the correction'
  );
  assert.equal(finished.status, 'passed');
});

test('a run downgraded to simulation by a stale Linux refusal continues live when the machine answers', async () => {
  platform.setProbeOverride(() => ({ ok: true, detail: 'answered' }));
  const workflow = probeWorkflow();
  // Exactly what the API stores when it downgrades a live request: the refusal
  // text, and nothing that proves this machine cannot act.
  const run = engine.createRun(workflow, {
    dryRun: true,
    liveFallback:
      'Live control is not implemented for linux. Set SIGHTLINE_TARGET=android with adb and a device attached, or run the console on Windows, macOS or Linux.',
  });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });
  assert.equal(finished.dryRun, false, 'the downgrade was undone once the machine answered');
  assert.equal(finished.liveFallback, null, 'the stale refusal is cleared');
  assert.equal(finished.detectionCorrected, true);
  assert.ok(
    (finished.log || []).some((line) => /Workaround applied: the run continues live/i.test(line.message || '')),
    'the run log names the workaround'
  );
  assert.equal(finished.status, 'passed');
});

test('a simulated run whose earlier refusal still holds stays simulated and says why', async () => {
  platform.setProbeOverride(() => ({ ok: false, detail: 'xdotool: command not found' }));
  const workflow = probeWorkflow();
  const run = engine.createRun(workflow, {
    dryRun: true,
    liveFallback: 'Linux live control needs xdotool on PATH for input.',
  });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 20000, intervalMs: 20 });
  assert.equal(finished.dryRun, true, 'no live control was claimed');
  assert.equal(finished.status, 'passed');
  assert.match(String(finished.liveFallback || ''), /xdotool/);
  assert.ok(
    (finished.log || []).some((line) => /earlier refusal .* still holds/i.test(line.message || '')),
    'the run log keeps the refusal visible'
  );
});

test('a live step that hits a platform guard mid-run gets one probe-based workaround', async () => {
  const d = store.db();
  platform.setProbeOverride(() => ({ ok: true, detail: 'answered' }));
  const workflow = {
    id: 'wf_guard_workaround',
    name: 'Guard workaround probe',
    description: '',
    status: 'ready',
    failurePolicy: { onFailure: 'stop', maxRetries: 0 },
    steps: [{ id: 'stp_click', type: 'click', name: 'Click the control', params: { x: 10, y: 10, name: 'the control' }, timeoutMs: 3000 }],
  };
  d.workflows = [workflow];
  store.persist();
  // Simulate a probe-backed executor whose FIRST live call is refused with the
  // platform guard text, then works — the engine must retry it live.
  let calls = 0;
  const probe = {
    executeStep: async () => {
      calls += 1;
      if (calls === 1) throw new Error('Linux live control needs an X11 DISPLAY (including XWayland), xdotool on PATH for input.');
      return { output: 'clicked', evidence: [] };
    },
    captureScreenSignature: async () => ({ at: new Date().toISOString(), cells: [] }),
    inspectWindowState: async () => ({ state: 'foreground', foreground: { title: '' } }),
    readFocusedElement: async () => ({ found: true, name: 'the control', window: '' }),
    findUiElement: async () => ({ found: false }),
  };
  const run = engine.createRun(workflow, { dryRun: false, probe });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000, intervalMs: 20 });
  assert.equal(finished.status, 'passed');
  assert.equal(calls, 2, 'the refused attempt was retried once');
  assert.equal(finished.steps[0].status, 'passed');
  assert.ok(
    (finished.log || []).some((line) => /Workaround applied/i.test(line.message || '')),
    'the run log names the workaround'
  );
});
