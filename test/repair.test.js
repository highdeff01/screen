import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-repair-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const repair = await load('server/repair.js');
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

test('clickElement repair candidates try other control types and vision fallback', () => {
  const step = {
    id: 's1',
    type: 'clickElement',
    name: 'Download the VLC installer',
    params: { window: 'VLC', name: 'Download VLC', controlType: 'Link' },
  };
  const candidates = repair.repairCandidates({ step });
  assert.ok(candidates.length >= 4);
  assert.ok(candidates.some((entry) => /vision/i.test(entry.method) && entry.steps[0].params.waitMs >= 4000));
  assert.ok(candidates.some((entry) => entry.steps[0].params.controlType === 'Button'));
  assert.ok(candidates.every((entry) => entry.steps.length >= 1 && entry.replaces));
});

test('a failed playback check resumes from the player that already passed', () => {
  const open = {
    id: 's1',
    type: 'launchApp',
    name: 'Open VLC with the video',
    params: { target: 'VLC', args: ['data/media/sintel-trailer.mp4'] },
    status: 'passed',
  };
  const verify = {
    id: 's2',
    type: 'verifyPlayback',
    name: 'Verify the video plays in VLC',
    params: { title: 'VLC media player' },
    status: 'failed',
  };
  const candidates = repair.repairCandidates({ step: verify, run: { steps: [open, verify] } });
  const resume = candidates.find((entry) => /resume from/i.test(entry.method));
  assert.ok(resume, 'the passed launch is a resume point');
  assert.equal(resume.replaces, false, 'the check itself is retried after the window is restored');
  assert.equal(resume.steps[0].type, 'focusWindow');
  assert.equal(resume.steps[0].params.process, 'vlc');
  assert.match(resume.steps[0].params.title, /VLC/);
  assert.equal(resume.steps[1].type, 'verifyPlayback');

  // A stopped player keeps its play button and drops the picture: pressing play
  // does not always restart it, so the media is reopened through the launch
  // step that already worked.
  const stopped = repair.repairCandidates({
    step: verify,
    run: { steps: [open, verify] },
    error: 'Playback check failed (95%): the playback check reported failure. The player state is unknown (logo shown), with no video content.',
  });
  const reopen = stopped.find((entry) => /reopen the media/i.test(entry.method));
  assert.ok(reopen, 'a player showing no picture gets its media reopened');
  assert.equal(reopen.replaces, false);
  assert.equal(reopen.steps[0].type, 'launchApp');
  assert.equal(reopen.steps[0].params.target, 'VLC');
  assert.equal(reopen.steps[2].type, 'verifyPlayback');
});

test('a player stuck at 0:00 is started with its own play key and re-checked', () => {
  const verify = {
    id: 's2',
    type: 'verifyPlayback',
    name: 'Verify the video plays in VLC',
    params: { title: 'VLC media player' },
    status: 'failed',
  };
  const candidates = repair.repairCandidates({
    step: verify,
    run: { steps: [verify] },
    error: 'Playback check failed: the video never started.',
  });
  const play = candidates.find((entry) => /start playback/i.test(entry.method));
  assert.ok(play, 'a never-started video gets a play repair');
  assert.equal(play.replaces, false);
  assert.equal(play.steps[0].type, 'focusWindow');
  assert.equal(play.steps[1].type, 'key');
  assert.equal(play.steps[1].params.keys, 'space');
  assert.equal(play.steps[1].params.foreground, 'VLC media player');
  assert.equal(play.steps[3].type, 'verifyPlayback');

  const stalled = repair.repairCandidates({
    step: verify,
    run: { steps: [verify] },
    error: 'the two frames did not show advancing playback',
  });
  assert.ok(!stalled.some((entry) => /start playback/i.test(entry.method)), 'a stalled video is not toggled blindly');
});

test('type repair candidates include select-all and clipboard paste', () => {
  const step = { id: 's1', type: 'type', name: 'Ask the question', params: { text: 'what is python' } };
  const candidates = repair.repairCandidates({ step });
  assert.ok(candidates.some((entry) => entry.steps[0].type === 'key' && entry.steps[0].params.keys === 'ctrl+a'));
  const paste = candidates.find((entry) => entry.steps[0].type === 'clipboard');
  assert.ok(paste);
  assert.equal(paste.steps[0].params.action, 'paste');
  assert.equal(paste.steps[0].params.text, 'what is python');
});

test('a blocked Google search falls back to another engine', () => {
  const step = {
    id: 's1',
    type: 'openUrl',
    name: 'Search Google for what is python',
    params: { url: 'https://www.google.com/search?q=what+is+python', app: 'chrome.exe' },
  };
  const candidates = repair.repairCandidates({ step });
  const alternate = candidates.find((entry) => /alternate search engine/i.test(entry.method));
  assert.ok(alternate);
  assert.match(alternate.steps[0].params.url, /duckduckgo\.com/);
  assert.match(alternate.steps[0].params.url, /what(?:\+|%20)is(?:\+|%20)python/);
});

test('a missing launch falls back to focusing an existing window', () => {
  const step = { id: 's1', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } };
  const candidates = repair.repairCandidates({ step });
  const focus = candidates.find((entry) => entry.steps[0].type === 'focusWindow');
  assert.ok(focus);
  assert.equal(focus.steps[0].params.process, 'notepad');
  assert.equal(focus.replaces, true);
});

test('a missing focus falls back to the app named by the goal', () => {
  const step = { id: 's1', type: 'focusWindow', name: 'Focus the probe', params: { title: 'SightlineMissingWindow' } };
  const candidates = repair.repairCandidates({ step, goal: 'If the probe window is missing, open Calculator and verify it.' });
  const fallback = candidates.find((entry) => /Calculator/.test(entry.method));
  assert.ok(fallback);
  assert.equal(fallback.steps[0].type, 'launchApp');
  assert.equal(fallback.steps[0].params.target, 'calc.exe');
  assert.equal(fallback.steps[2].params.title, 'Calculator');
});

test('waitFor repair candidates extend the deadline', () => {
  const step = { id: 's1', type: 'waitFor', name: 'Wait for VLC', params: { kind: 'window', value: 'VLC', timeoutMs: 10000 } };
  const candidates = repair.repairCandidates({ step });
  assert.ok(candidates.some((entry) => Number(entry.steps[0].params.timeoutMs) >= 20000));
});

test('unguarded input steps are not continued after a failure', () => {
  assert.equal(repair.canContinueSafely({ type: 'type', params: { text: 'x' } }), false);
  assert.equal(repair.canContinueSafely({ type: 'click', params: { x: 1, y: 2 } }), false);
  assert.equal(repair.canContinueSafely({ type: 'type', params: { text: 'x', foreground: 'Notepad' } }), true);
  assert.equal(repair.canContinueSafely({ type: 'screenshot', params: {} }), true);
});

test('repair memory does not replay a different window action', () => {
  const db = { repairMemory: [] };
  const failure = { signature: repair.repairSignature({ type: 'windowAction' }, 'no window matched title "Probe"') };
  const restore = { id: 's1', type: 'windowAction', name: 'Restore the probe', params: { title: 'Probe', action: 'restore' } };
  repair.rememberRepairMemory(db, {
    workflowId: 'wf_1',
    step: restore,
    failure,
    method: 'launch a substitute app',
    steps: [{ id: 'alt', type: 'launchApp', name: 'Open Calculator', params: { target: 'calc.exe' } }],
    replaces: true,
  });
  const maximize = { ...restore, params: { title: 'Probe', action: 'maximize' } };
  assert.equal(repair.recallRepairMemory(db, { step: maximize, failure, workflowId: 'wf_1' }).length, 0);
  assert.equal(repair.recallRepairMemory(db, { step: restore, failure, workflowId: 'wf_1' }).length, 1);
});

test('repair memory round-trips and increments reuse', () => {
  const db = { repairMemory: [] };
  const step = { id: 's1', type: 'clickElement', name: 'Download', params: { name: 'Download' } };
  const failure = { signature: repair.repairSignature(step, 'control not found') };
  repair.rememberRepairMemory(db, {
    workflowId: 'wf_1',
    step,
    failure,
    method: 'control type Button',
    steps: [{ id: 'alt', type: 'clickElement', name: 'Download', params: { name: 'Download', controlType: 'Button' } }],
    replaces: true,
  });
  repair.rememberRepairMemory(db, {
    workflowId: 'wf_1',
    step,
    failure,
    method: 'control type Button',
    steps: [{ id: 'alt', type: 'clickElement', name: 'Download', params: { name: 'Download', controlType: 'Button' } }],
    replaces: true,
  });
  assert.equal(db.repairMemory.length, 1);
  assert.equal(db.repairMemory[0].uses, 2);
  const recalled = repair.recallRepairMemory(db, { step, failure, workflowId: 'wf_1' });
  assert.equal(recalled[0].method, 'remembered: control type Button');
  assert.equal(recalled[0].steps[0].params.controlType, 'Button');
});

test('repair advice only includes enabled agents and matches the failure category', () => {
  const db = {
    agents: [
      { name: 'Supervisor', kind: 'supervisor', enabled: true },
      { name: 'Watchdog', kind: 'watchdog', enabled: false },
      { name: 'Observer', kind: 'observer', enabled: true },
    ],
  };
  const advice = repair.repairAdvice(db, {
    step: { name: 'Click', type: 'clickElement' },
    failure: { category: 'window_not_found' },
  });
  assert.deepEqual(advice.map((entry) => entry.name), ['Supervisor', 'Observer']);
  assert.ok(advice.every((entry) => /Reopen or focus/i.test(entry.advice)));
});

test('failure summary names the step number, name and type', () => {
  const run = {
    steps: [
      { id: 'a', name: 'Open Chrome', type: 'launchApp', status: 'passed' },
      { id: 'b', name: 'Download the VLC installer', type: 'clickElement', status: 'failed', error: 'control not found', attempts: 2 },
    ],
  };
  const entries = repair.failedStepEntries(run);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stepNumber, 2);
  const summary = repair.failureSummary(entries);
  assert.match(summary, /Step 2\/2/);
  assert.match(summary, /Download the VLC installer/);
  assert.match(summary, /control not found/);
});

function workflowWith(steps, name) {
  return {
    id: `wf_repair_${name}`,
    name,
    description: name,
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps,
  };
}

function probeFor({ succeed }) {
  return {
    captureScreenSignature: async () => ({ at: new Date().toISOString(), hash: 'x', cells: [] }),
    inspectWindowState: async () => ({ state: 'absent', foreground: null }),
    readFocusedElement: async () => ({ found: false }),
    findUiElement: async () => ({ found: false }),
    executeStep: async (step) => {
      if (!succeed(step)) throw new Error(`synthetic failure for ${step.type}`);
      return { output: `did ${step.name}`, evidence: [] };
    },
  };
}

test('a failed launch is repaired by focusing the existing window and the run passes', async () => {
  store.db().settings.visualChecks = false;
  store.db().settings.autoNotes = false;
  store.db().settings.autoRecoverFailures = false;
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open GhostApp', params: { target: 'GhostApp' }, timeoutMs: 5000 },
      { id: 's2', type: 'wait', name: 'Settle', params: { ms: 10 }, timeoutMs: 1000 },
      { id: 's3', type: 'writeNote', name: 'Record', params: { title: 'Done', text: 'repaired' }, timeoutMs: 1000 },
    ],
    'repair launch'
  );
  const probe = probeFor({
    succeed: (step) => step.type === 'focusWindow' || step.type === 'wait' || step.type === 'writeNote',
  });
  const run = engine.createRun(workflow, { dryRun: false, probe, repair: true });
  // The live path spends a presenter settle window per step plus repair attempts;
  // 15s was tight once the whole suite ran in parallel.
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.status, 'passed');
  assert.equal(finished.steps[0].status, 'passed');
  assert.match(finished.steps[0].repairedBy || '', /focus/i);
  assert.ok(finished.repairCount >= 1);
  assert.equal(finished.errorSummary, null);
});

test('repairs that fail are reported and safe later steps still run', async () => {
  store.db().settings.visualChecks = false;
  store.db().settings.autoNotes = false;
  store.db().settings.autoRecoverFailures = false;
  const workflow = workflowWith(
    [
      // A named window: an unguarded type step is skipped now, and this test needs
      // a step that really attempts the work and fails.
      { id: 's1', type: 'type', name: 'Ask the question', params: { text: 'what is python', foreground: 'Untitled - Notepad' }, timeoutMs: 5000 },
      { id: 's2', type: 'writeNote', name: 'Record', params: { title: 'After failure', text: 'continued' }, timeoutMs: 1000 },
    ],
    'repair continue'
  );
  // The engine now opens the window a typing step names before it types, so the
  // prerequisite steps succeed and only the typing itself is the failure.
  const probe = probeFor({
    succeed: (step) => ['writeNote', 'launchApp', 'wait', 'focusWindow'].includes(step.type),
  });
  const run = engine.createRun(workflow, { dryRun: false, probe, repair: true });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  const failed = finished.steps.filter((step) => step.status === 'failed');
  assert.equal(finished.status, 'failed');
  assert.equal(finished.continuedAfterFailure, true);
  assert.equal(failed.length, 1, 'only the typing step fails; the steps around it do not');
  assert.equal(failed[0].type, 'type');
  assert.equal(finished.steps.find((step) => step.type === 'writeNote')?.status, 'passed');
  assert.equal(finished.failedSteps.length, 1);
  assert.match(finished.errorSummary, /Ask the question/);
  assert.ok((failed[0].repairs || []).length >= 2);
});

test('a failed winget install switches to the vendor installer and verifies the app', () => {
  const step = { id: 's9', type: 'installApp', name: 'Install VLC', params: { id: 'VideoLAN.VLC' } };
  const candidates = repair.repairCandidates({ step, goal: 'install VLC and play a sample video' });
  const fallback = candidates.find((candidate) => /official installer/i.test(candidate.method));
  assert.ok(fallback, 'winget failure needs a vendor-installer fallback');
  assert.equal(fallback.replaces, true);
  assert.equal(fallback.steps[0].type, 'installApp');
  assert.equal(fallback.steps[0].params.discover, true);
  assert.equal(fallback.steps[0].params.id, '');
  assert.equal(fallback.steps[1].type, 'testApp');
  assert.match(fallback.steps[1].params.target, /vlc\.exe$/i);
  assert.match(fallback.steps[1].params.process, /^vlc$/i);
});

test('a failed direct install falls back to winget and keeps the original source for a longer retry', () => {
  const step = {
    id: 's10',
    type: 'installApp',
    name: 'Install VLC from the website',
    params: { url: 'https://get.videolan.org/vlc/last/win64/vlc-win64.exe' },
  };
  const candidates = repair.repairCandidates({ step, goal: 'install VLC' });
  const winget = candidates.find((candidate) => /with winget/i.test(candidate.method));
  assert.ok(winget, 'direct-install failure needs a winget fallback');
  assert.equal(winget.steps[0].params.id, 'VideoLAN.VLC');
  const retry = candidates.find((candidate) => /longer timeout/i.test(candidate.method));
  assert.ok(retry);
  assert.ok(retry.steps[0].params.timeoutMs >= 600000);
});
