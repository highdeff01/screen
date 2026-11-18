import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-companion-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const companion = await load('server/companion.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the companion learns files, apps and questions, then proposes safe next help', async () => {
  const d = store.db();
  d.settings.companionSystemScan = true;
  d.companion = undefined;
  d.workflows = [];
  d.runs = [
    {
      id: 'run_companion_probe',
      workflowId: 'wf_companion',
      workflowName: 'Research notes',
      status: 'passed',
      dryRun: true,
      presenter: { app: { name: 'Notepad', target: 'Notepad', path: 'C:/Windows/notepad.exe' }, summary: { goalMet: true } },
      steps: [
        { id: 's1', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' }, status: 'passed', ms: 40 },
        { id: 's2', type: 'type', name: 'Ask a question', params: { text: 'What is a diamond?' }, status: 'passed', ms: 20 },
        { id: 's3', type: 'writeTextFile', name: 'Save notes', params: { path: 'notes.txt', text: 'draft' }, status: 'passed', ms: 10 },
      ],
    },
  ];
  companion.learnRun(d.runs[0]);
  const c = companion.ensureCompanion();
  assert.ok(c.habits.apps.some((entry) => /notepad/i.test(entry.name)));
  assert.ok(c.habits.files.some((entry) => entry.path === 'notes.txt'));
  assert.ok(c.habits.inputs.some((entry) => entry.kind === 'question'));

  c.system = { at: new Date().toISOString(), diskFreeGb: 5, ramUsedPct: 70, browserMb: 1900, recycleItems: 12 };
  const state = await companion.scanCompanion({ system: false });
  assert.ok(state.summary.apps >= 1);
  assert.ok(state.proposals.some((entry) => entry.kind === 'new-file'));
  assert.ok(state.proposals.some((entry) => entry.kind === 'research'));
  assert.ok(state.proposals.some((entry) => entry.kind === 'cleanup'));
  assert.ok(state.quickHelp.some((entry) => entry.kind === 'research'));
  assert.ok(state.notifications.length >= 1);

  const research = state.proposals.find((entry) => entry.kind === 'research');
  const accepted = companion.companionProposalAction(research.id, 'accept');
  assert.equal(accepted.status, 'accepted');
  assert.equal(companion.companionState().proposals.some((entry) => entry.id === research.id), false);

  const note = companion.addCompanionNote('When the topic exists, create a new file instead of overwriting.');
  assert.ok(note.text);
  assert.ok(companion.companionState().proposals.some((entry) => entry.kind === 'user-note'));
  store.flush();
});

test('quick help can be used and dismissed without removing learned evidence', async () => {
  const state = companion.companionState();
  const item = state.quickHelp[0];
  assert.ok(item);
  const used = companion.companionQuickHelp(item.id);
  assert.equal(used.id, item.id);
  assert.ok(used.uses >= 1);
  assert.equal(companion.companionDismissQuickHelp(item.id).ok, true);
  assert.equal(companion.companionState().quickHelp.some((entry) => entry.id === item.id), false);
  store.flush();
});

test('sensitive questions are skipped and URL credentials are redacted', () => {
  const d = store.db();
  d.companion = undefined;
  d.settings.companionEnabled = true;
  d.settings.companionLearning = true;
  companion.learnRun({
    id: 'run_privacy_probe',
    workflowName: 'Privacy probe',
    status: 'passed',
    steps: [
      { id: 'p1', type: 'type', name: 'Ask about credentials', params: { text: 'what is my password?' }, status: 'passed', ms: 1 },
      {
        id: 'p2',
        type: 'openUrl',
        name: 'Open callback',
        params: { url: 'https://user:pass@example.com/cb?topic=cats&token=abc123&session=xyz#fragment' },
        status: 'passed',
        ms: 1,
      },
    ],
  });
  const c = companion.ensureCompanion();
  assert.equal(c.habits.inputs.length, 0);
  assert.equal(c.habits.urls.length, 1);
  const stored = decodeURIComponent(c.habits.urls[0].url);
  assert.match(stored, /topic=cats/);
  assert.doesNotMatch(stored, /abc123|session=xyz|user:pass|fragment/);
  assert.match(stored, /\[redacted\]/);
  store.flush();
});

test('disabling the system scan clears previously collected system awareness', async () => {
  const d = store.db();
  d.companion = undefined;
  d.settings.companionSystemScan = false;
  d.settings.companionEnabled = true;
  const c = companion.ensureCompanion();
  c.system = { at: new Date().toISOString(), diskFreeGb: 1, ramUsedPct: 99, browserMb: 9000, recycleItems: 5 };
  await companion.scanCompanion({ system: true });
  assert.equal(companion.ensureCompanion().system, null);
  store.flush();
});

test('a continuation marked retrying without a retry run is downgraded to needs attention', async () => {
  const d = store.db();
  d.companion = undefined;
  d.settings.companionSystemScan = false;
  d.settings.companionEnabled = true;
  d.settings.companionLearning = false;
  d.runs = [
    {
      id: 'run_stale_retry',
      workflowId: 'wf_stale',
      workflowName: 'Stale retry',
      status: 'failed',
      recovery: { status: 'retrying', retryRunId: null },
      steps: [],
    },
  ];
  const c = companion.ensureCompanion();
  c.continuations = [{ id: 'cont_stale', runId: 'run_stale_retry', status: 'retrying', retryRunId: null, at: new Date().toISOString() }];
  await companion.scanCompanion({ system: false });
  assert.equal(companion.ensureCompanion().continuations[0].status, 'needs_attention');
  store.flush();
});