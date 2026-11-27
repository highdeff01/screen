import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-handoff-suggestion-'));
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

const CLICK = {
  id: 'stp_click',
  type: 'clickElement',
  name: 'Click Settings',
  status: 'passed',
  params: { window: 'Sightline Profile', name: 'Settings', skipIfVisible: 'Notifications' },
  visual: { changedPct: 8.4 },
  position: { title: 'Sightline Profile' },
};

function runWith(steps, extra = {}) {
  return {
    id: 'run_draft',
    workflowId: 'wf_draft',
    workflowName: 'Draft a hand-off',
    status: 'passed',
    dryRun: false,
    shadow: false,
    steps,
    ...extra,
  };
}

const NO_HANDOFF = { handoff: { enabled: false, steps: [] } };

test('a screen-changing click is reversed into a draft using the end screen’s back control', async () => {
  const asked = [];
  const draft = await engine.deriveHandoffSuggestion(runWith([CLICK]), NO_HANDOFF, {
    findControl: async (query) => {
      asked.push(query);
      return { found: true, text: 'Back', x: 40, y: 60, method: 'OCR' };
    },
  });

  assert.ok(draft, 'a draft is produced');
  assert.equal(draft.complete, true);
  assert.equal(draft.stepId, 'stp_click');
  assert.equal(draft.stepName, 'Click Settings');
  assert.equal(draft.window, 'Sightline Profile');
  assert.equal(draft.marker, 'Notifications');
  assert.deepEqual(draft.control, { name: 'Back', x: 40, y: 60, method: 'OCR' });
  assert.deepEqual(
    draft.steps.map((step) => step.type),
    ['clickElement'],
    'the draft is the reverse click only'
  );
  assert.deepEqual(draft.steps[0].params, { window: 'Sightline Profile', name: 'Back' });
  assert.match(draft.steps[0].name, /Reverse “Click Settings”/);
  assert.equal(asked.length, 1, 'one read of the end screen');
  assert.equal(asked[0].window, 'Sightline Profile');
  assert.ok(asked[0].names.includes('Back'), 'the read asks for back affordances');
  assert.match(draft.reason, /shows “Back”/);
});

test('no back control on the end screen means no drafted steps, and the reason says why', async () => {
  const draft = await engine.deriveHandoffSuggestion(runWith([CLICK]), NO_HANDOFF, {
    findControl: async () => ({ found: false, reason: 'no line matched' }),
  });

  assert.ok(draft, 'the finding is still recorded');
  assert.equal(draft.complete, false);
  assert.deepEqual(draft.steps, [], 'nothing is invented to stand in for a route');
  assert.equal(draft.control, null);
  assert.match(draft.reason, /No Back or Home control was found in “Sightline Profile”/);
});

test('a declared hand-off is never second-guessed with a draft', async () => {
  const declared = {
    enabled: true,
    steps: [{ type: 'clickElement', name: 'Return', params: { window: 'Sightline Profile', name: 'Home' } }],
  };
  let reads = 0;
  const draft = await engine.deriveHandoffSuggestion(runWith([CLICK]), { handoff: declared }, {
    findControl: async () => {
      reads += 1;
      return { found: true, text: 'Back' };
    },
  });

  assert.equal(draft, null);
  assert.equal(reads, 0, 'the end screen is not even read');
});

test('simulated, shadow, unfinished and cancelled runs get no draft', async () => {
  const read = async () => ({ found: true, text: 'Back' });
  for (const extra of [{ dryRun: true }, { shadow: true }, { status: 'running' }, { status: 'cancelled' }, { status: 'queued' }]) {
    assert.equal(
      await engine.deriveHandoffSuggestion(runWith([CLICK], extra), NO_HANDOFF, { findControl: read }),
      null,
      `no draft for ${JSON.stringify(extra)}`
    );
  }
});

test('only a click that really moved the screen is reversed', async () => {
  const read = async () => ({ found: true, text: 'Back' });
  const cases = {
    'no screen change and no declared destination': { ...CLICK, params: { window: 'Sightline Profile', name: 'Settings' }, visual: { changedPct: 0.2 } },
    'a skipped click': { ...CLICK, status: 'skipped' },
    'a failed click': { ...CLICK, status: 'failed' },
    'a coordinate click with no control name': { ...CLICK, type: 'click', params: { x: 210, y: 315 } },
    'a step that is not a click': { ...CLICK, type: 'note' },
  };
  for (const [label, step] of Object.entries(cases)) {
    assert.equal(
      await engine.deriveHandoffSuggestion(runWith([step]), NO_HANDOFF, { findControl: read }),
      null,
      label
    );
  }
});

test('the draft reverses the last screen-changing click, not an earlier one', async () => {
  const first = { ...CLICK, id: 'stp_first', name: 'Click Profile', params: { window: 'Sightline Profile', name: 'Profile' } };
  const seen = [];
  const draft = await engine.deriveHandoffSuggestion(runWith([first, CLICK]), NO_HANDOFF, {
    findControl: async (query) => {
      seen.push(query.window);
      return { found: true, text: 'Back' };
    },
  });

  assert.equal(draft.stepId, 'stp_click');
  assert.match(draft.steps[0].name, /Click Settings/);
  assert.equal(seen.length, 1);
});
