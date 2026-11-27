import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const root = process.cwd();
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function renderPanel(workflow, { draft = null, tools = [] } = {}) {
  const start = source.indexOf('function blankHandoffDraft(');
  const end = source.indexOf('function renderWorkflowLint(');
  assert.ok(start > 0 && end > start, 'the hand-off editor lives between blankHandoffDraft and renderWorkflowLint');
  const ui = {
    handoffDraft: draft,
    data: {
      tools,
      stepTypes: [
        { type: 'focusWindow', label: 'Focus window' },
        { type: 'clickElement', label: 'Click control' },
      ],
    },
  };
  const context = {
    ui,
    wf: workflow,
    esc: (value) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    TYPE_META: {
      focusWindow: { label: 'Focus window' },
      clickElement: { label: 'Click control' },
    },
    FIELDS: {
      focusWindow: [{ key: 'title', label: 'Window title contains', type: 'text' }],
      clickElement: [{ key: 'window', label: 'Window', type: 'text' }, { key: 'name', label: 'Control label', type: 'text' }],
    },
    DEFAULTS: {
      focusWindow: { title: '', process: '' },
      clickElement: { window: '', name: '' },
    },
    stepSummary: (step) => `${step.type} summary`,
  };
  return vm.runInNewContext(`${source.slice(start, end)}\nrenderHandoffPanel(wf);`, context);
}

test('the builder hand-off panel lists the declared steps with their order controls', () => {
  const panel = renderPanel({
    id: 'wf_editor',
    handoff: {
      enabled: true,
      steps: [
        { id: 'h1', type: 'clickElement', name: 'Click Back', params: { window: 'Profile', name: 'Back' } },
        { id: 'h2', type: 'focusWindow', name: 'Back on Profile', params: { title: 'Profile' } },
      ],
    },
  });
  assert.match(panel, /Hand-off · 2 steps/);
  assert.match(panel, /Click Back/);
  assert.match(panel, /Back on Profile/);
  assert.match(panel, /class="badge okbadge">on</);
  assert.match(panel, /data-act="handoff-toggle"[^>]*checked/);
  assert.match(panel, /data-act="handoff-edit" data-id="wf_editor" data-index="1"/);
  assert.match(panel, /data-act="handoff-move" data-id="wf_editor" data-index="0" data-dir="up" title="Run earlier" disabled/);
  assert.match(panel, /data-act="handoff-remove" data-id="wf_editor" data-index="1"/);
  assert.doesNotMatch(panel, /data-scope="handoff"/, 'no editor is open until a step is added or edited');
});

test('an empty hand-off says so and still offers the editor', () => {
  const panel = renderPanel({ id: 'wf_editor', handoff: { enabled: false, steps: [] } });
  assert.match(panel, /Hand-off · 0 steps/);
  assert.match(panel, /No hand-off steps yet/);
  assert.match(panel, /data-act="handoff-add" data-id="wf_editor"/);
  assert.match(panel, /class="badge ">off</);
});

test('the editor renders the chosen step type fields and refuses to open for another workflow', () => {
  const draft = {
    workflowId: 'wf_editor',
    index: 0,
    id: 'h1',
    type: 'clickElement',
    name: 'Click Back',
    params: { window: 'Profile', name: 'Back' },
    timeoutMs: 20000,
  };
  const panel = renderPanel(
    { id: 'wf_editor', handoff: { enabled: true, steps: [{ ...draft }] } },
    { draft }
  );
  assert.match(panel, /Editing hand-off step 1/);
  assert.match(panel, /value="Click Back" data-scope="handoff" data-key="name"/);
  assert.match(panel, /data-scope="handoff" data-key="window"/);
  assert.match(panel, /data-scope="handofftype"/);
  assert.match(panel, /data-act="handoff-save" data-id="wf_editor"/);
  assert.match(panel, /data-act="handoff-add"[^>]*disabled/);

  const other = renderPanel(
    { id: 'wf_other', handoff: { enabled: false, steps: [] } },
    { draft }
  );
  assert.doesNotMatch(other, /data-scope="handoff"/, 'a draft belongs to the workflow it was opened on');
});

const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-handoff-editor-'));
const dataDir = path.join(tempRoot, 'data');
const workflowId = 'wf_handoff_editor';

function seedDb() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'db.json'),
    JSON.stringify({
      settings: {
        autoRecoverFailures: false,
        continuityAutoContinue: false,
        continuityEnabled: false,
        continuityFrameWatch: false,
        companionEnabled: false,
        agentTickMs: 600000,
        autoNotes: false,
        autoSync: false,
      },
      workflows: [
        {
          id: workflowId,
          name: 'Hand-off editor probe',
          description: 'Edit the hand-off without running anything.',
          status: 'ready',
          failurePolicy: { onFailure: 'stop', maxRetries: 0 },
          steps: [{ id: 'stp_note', type: 'note', name: 'Record the result', params: { text: 'done' } }],
          handoff: { enabled: false, steps: [] },
        },
      ],
      runs: [],
    })
  );
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(base, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited before health check (${child.exitCode}).\n${output()}`);
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      // The listener is not ready yet.
    }
    await sleep(100);
  }
  throw new Error(`Server did not become healthy at ${base}.\n${output()}`);
}

async function patchWorkflow(base, body) {
  const res = await fetch(`${base}/api/workflows/${workflowId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function storedHandoff(base) {
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const state = await res.json();
  return state.workflows.find((entry) => entry.id === workflowId).handoff;
}

test('the hand-off editor saves the whole list through the workflow PATCH', { timeout: 30000 }, async () => {
  seedDb();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: tempRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(base, child, () => output);

    const saved = await patchWorkflow(base, {
      handoff: {
        enabled: true,
        steps: [
          {
            id: 'handoff_back',
            type: 'clickElement',
            name: 'Click Back',
            params: { window: 'Profile', name: 'Back' },
            timeoutMs: 900,
            optional: false,
          },
          {
            id: 'handoff_focus',
            type: 'focusWindow',
            name: 'Back on Profile',
            params: { title: 'Profile' },
            timeoutMs: 99999,
          },
          { id: 'handoff_empty', name: 'No type at all', params: {} },
        ],
      },
    });
    assert.equal(saved.status, 200);
    let handoff = await storedHandoff(base);
    assert.equal(handoff.enabled, true);
    assert.deepEqual(
      handoff.steps.map((step) => step.id),
      ['handoff_back', 'handoff_focus'],
      'a step with no type is dropped rather than saved as dead weight'
    );
    assert.deepEqual(handoff.steps.map((step) => step.name), ['Click Back', 'Back on Profile']);
    assert.equal(handoff.steps[0].params.window, 'Profile');
    assert.equal(handoff.steps[0].optional, true, 'hand-off steps are always optional');
    assert.equal(handoff.steps[0].timeoutMs, 1000, 'the timeout has a floor');
    assert.equal(handoff.steps[1].timeoutMs, 60000, 'the timeout has a ceiling');

    const reordered = await patchWorkflow(base, {
      handoff: { enabled: true, steps: [handoff.steps[1], handoff.steps[0]] },
    });
    assert.equal(reordered.status, 200);
    handoff = await storedHandoff(base);
    assert.deepEqual(
      handoff.steps.map((step) => step.id),
      ['handoff_focus', 'handoff_back'],
      'the order the editor shows is the order that is saved'
    );

    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `handoff_${index}`,
      type: 'wait',
      name: `Wait ${index}`,
      params: { ms: 500 },
    }));
    await patchWorkflow(base, { handoff: { enabled: true, steps: many } });
    handoff = await storedHandoff(base);
    assert.equal(handoff.steps.length, 10, 'a hand-off keeps at most ten steps');

    await patchWorkflow(base, { handoff: { enabled: false, steps: [] } });
    handoff = await storedHandoff(base);
    assert.equal(handoff.enabled, false);
    assert.deepEqual(handoff.steps, []);
    const stateRuns = await (await fetch(`${base}/api/state`)).json();
    assert.equal(stateRuns.runs.length, 0, 'editing the hand-off queues no run');
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), sleep(3000)]);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Windows can briefly hold the server's temp database open.
    }
  }
});
