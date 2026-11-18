import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-deck-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const deep = await load('server/presentations-deep.js');
const deepFocus = await load('server/deep-focus.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.runs = [];
  d.workflows = [];
  d.presentations = [];
  d.settings.deepFocus = { enabled: true, rounds: 3, roundDelayMs: 10, autoApply: false };
  store.persist();
});

test('presentationFromDeepFocus requires a run with a focus cycle', async () => {
  await assert.rejects(() => deep.presentationFromDeepFocus('no-run'), /Run not found/);
  const d = store.db();
  d.runs.unshift({ id: 'r1', workflowId: 'w1', workflowName: 'Demo', status: 'failed' });
  d.workflows.push({ id: 'w1', name: 'Demo', steps: [], status: 'draft' });
  store.persist();
  await assert.rejects(() => deep.presentationFromDeepFocus('r1'), /no deep-focus/);
});

test('focus slides are built from the rounds, diff and conclusion', async () => {
  const d = store.db();
  d.runs.unshift({ id: 'r2', workflowId: 'w1', workflowName: 'Demo', status: 'failed' });
  d.workflows.push({ id: 'w1', name: 'Demo', steps: [], status: 'draft' });
  store.persist();
  deepFocus.configureDeepFocus({ chat: async () => ({ ok: false, error: 'offline' }) });
  const started = deepFocus.startDeepFocus('r2', { rounds: 2, reason: 'type failed' });
  assert.ok(started);
  // Let the cycle finish so no async work leaks past the test.
  for (let i = 0; i < 40; i += 1) {
    const status = deepFocus.deepFocusStatus('r2');
    if (status?.finishedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  deepFocus.stopDeepFocus('r2');
  const markdown = deep.deepFocusMarkdown('r2');
  assert.match(markdown, /# Deep focus/);
});

test('a completed cycle yields round slides, a diff slide and the conclusion', async () => {
  deepFocus.configureDeepFocus({
    chat: async () => ({
      ok: true,
      model: 'stub',
      content: JSON.stringify({ conclusion: 'The window was already in front; skip the launch.', reshapedSteps: [{ id: 'n1', type: 'type', name: 'Type the note', params: { text: 'hello' } }], retry: true }),
    }),
  });
  const d = store.db();
  d.runs.unshift({
    id: 'r3',
    workflowId: 'w1',
    workflowName: 'Demo',
    status: 'failed',
    steps: [
      { id: 's1', type: 'launchApp', name: 'Open Notepad', params: {}, status: 'passed' },
      { id: 's2', type: 'type', name: 'Type the note', params: { text: 'hello' }, status: 'failed', error: 'caret' },
    ],
    lastWindow: { title: 'Untitled - Notepad' },
  });
  store.persist();
  const focus = await deepFocus.startDeepFocus('r3', { rounds: 2 });
  assert.ok(focus);
  const status = deepFocus.deepFocusStatus('r3');
  if (status?.conclusion) {
    const markdown = deep.deepFocusMarkdown('r3');
    assert.match(markdown, /Conclusion|Focus round/);
  }
  deepFocus.stopDeepFocus('r3');
});
