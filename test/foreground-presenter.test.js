import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-presenter-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const presenter = await load('server/foreground-presenter.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function fixture() {
  const workflow = {
    id: 'wf_presenter_probe',
    name: 'Presenter probe',
    description: 'Move to the center, click it, and verify the result.',
    steps: [
      { id: 'stp_move', type: 'move', name: 'Move to center', params: { x: 960, y: 540 } },
      { id: 'stp_click', type: 'click', name: 'Click center', params: { x: 960, y: 540, foreground: 'Kiro' } },
    ],
  };
  const run = {
    id: 'run_presenter_probe',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: true,
    steps: workflow.steps.map((step) => ({ ...step, status: 'pending', attempts: 0 })),
  };
  return { workflow, run };
}

test('the presenter reports app, AI action, verification and learned position', async () => {
  const { workflow, run } = fixture();
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  await presenter.presenterBeginStep(run, workflow, run.steps[0]);
  assert.equal(run.presenter.ai.status, 'acting');
  assert.equal(run.presenter.ai.action, 'move');
  assert.match(run.presenter.summary.whatDoing, /Move to center/);
  await presenter.presenterAfterStep(run, workflow, run.steps[0], { ok: true });
  assert.equal(run.presenter.ai.status, 'waiting');
  assert.equal(d.positionMemory.length, 1);
  assert.deepEqual(d.positionMemory[0].normalized, { x: 0.5, y: 0.5 });
  await presenter.presenterBeginStep(run, workflow, run.steps[1]);
  await presenter.presenterAfterStep(run, workflow, run.steps[1], { ok: true });
  assert.equal(d.positionMemory.length, 2);
  assert.ok(run.presenter.position.nearest.length >= 1);
  assert.ok(run.presenter.observations.some((entry) => /Step complete/.test(entry.message)));
  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.summary.goalMet, true);
  assert.equal(presenter.activePresenter().runId, run.id);
  store.flush();
});

test('a repair that changes the app updates the presenter, fallbacks and verifier', async () => {
  const workflow = {
    id: 'wf_presenter_app',
    name: 'Open the note app',
    description: 'Open the note app and type a line.',
    steps: [
      { id: 'stp_open', type: 'launchApp', name: 'Open GhostApp', params: { target: 'GhostApp' } },
      { id: 'stp_type', type: 'type', name: 'Type a line', params: { text: 'hello', foreground: 'GhostApp' } },
    ],
  };
  const run = {
    id: 'run_presenter_app',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: true,
    steps: workflow.steps.map((step) => ({ ...step, status: 'pending', attempts: 0 })),
  };
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  const failed = run.steps[0];
  await presenter.presenterBeginStep(run, workflow, failed);
  await presenter.presenterFailStep(run, workflow, failed, 'no window matching GhostApp');
  assert.equal(run.presenter.app.target, 'GhostApp');

  const adopted = await presenter.presenterAdoptApp(run, workflow, {
    steps: [
      { type: 'launchApp', name: 'Open Calculator', params: { target: 'calc.exe' } },
      { type: 'wait', name: 'Wait for Calculator', params: { ms: 900 } },
      { type: 'focusWindow', name: 'Focus Calculator', params: { title: 'Calculator', process: 'calc' } },
    ],
    method: 'launch the app named by the goal (Calculator)',
    step: failed,
  });
  assert.ok(adopted);
  assert.match(run.presenter.app.target, /calc/i);
  assert.equal(run.presenter.app.name, 'Calculator');
  assert.equal(run.presenter.app.repairedFrom, 'GhostApp');
  assert.equal(run.effectiveApp.name, 'Calculator');
  assert.equal(run.effectiveApp.replacedTarget, 'GhostApp');
  assert.ok(run.presenter.fallbacks.every((entry) => !/ghost/i.test(entry.label)));
  assert.ok(run.presenter.timeline.some((entry) => /Calculator/.test(entry.text)));

  const repeat = await presenter.presenterAdoptApp(run, workflow, {
    steps: [{ type: 'focusWindow', params: { title: 'Calculator' } }],
  });
  assert.equal(repeat, null);

  // The later step still carries the old window guard; the presenter must not
  // follow it back to the window that never opened.
  failed.status = 'passed';
  await presenter.presenterAfterStep(run, workflow, failed, { ok: true });
  assert.match(run.presenter.app.target, /calc/i);
  await presenter.presenterBeginStep(run, workflow, run.steps[1]);
  assert.match(run.presenter.app.target, /calc/i);
  assert.doesNotMatch(String(run.presenter.app.detail), /GhostApp/);

  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.verifier.app.name, 'Calculator');
  assert.equal(run.presenter.verifier.app.replacedFrom, 'GhostApp');
  assert.match(run.presenter.verifier.summary, /Calculator/);
  assert.match(run.presenter.verifier.summary, /changed from GhostApp/);
  store.flush();
});

test('the presenter asks for input on a login failure and accepts guidance', async () => {
  const { workflow, run } = fixture();
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  await presenter.presenterBeginStep(run, workflow, run.steps[1]);
  await presenter.presenterFailStep(run, workflow, run.steps[1], 'Login required: user consent is needed.');
  assert.equal(run.presenter.app.status, 'needs_input');
  assert.ok(run.presenter.needsInput);
  const guided = presenter.presenterUserInput(run, workflow, { message: 'Use the saved session.', action: 'pause' });
  assert.equal(guided.userNotes[0].text, 'Use the saved session.');
  assert.equal(run.pauseRequested, true);
  assert.ok(guided.observations.some((entry) => /User guidance/.test(entry.message)));
  store.flush();
});
test('the verifier reports no window title when the run closed its own window', async () => {
  const workflow = {
    id: 'wf_verifier_gone',
    name: 'Close the window',
    description: 'Close the probe window on purpose.',
    steps: [{ id: 'stp_close', type: 'windowAction', name: 'Close the probe', params: { title: 'sightline-window-551032', action: 'close' } }],
  };
  const run = {
    id: 'run_verifier_gone',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: true,
    steps: workflow.steps.map((step) => ({ ...step, status: 'passed', attempts: 1 })),
  };
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  // The window was closed on purpose, so the foreground now belongs to another app.
  run.presenter.app = {
    ...run.presenter.app,
    target: 'sightline-window-551032',
    name: 'powershell',
    title: 'Sightline - screen agent console - Google Chrome',
    process: 'chrome',
    matched: false,
    status: 'finished',
  };
  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.verifier.app.name, 'powershell');
  assert.equal(run.presenter.verifier.app.target, 'sightline-window-551032');
  assert.equal(run.presenter.verifier.app.title, '');
  assert.equal(run.presenter.verifier.app.process, '');
  assert.equal(run.presenter.verifier.status, 'verified');
  store.flush();
});

test('the verifier keeps the window the run actually verified', async () => {
  const workflow = {
    id: 'wf_verifier_seen',
    name: 'Restore Paint',
    description: 'Open Paint and leave it in front.',
    steps: [{ id: 'stp_focus', type: 'focusWindow', name: 'Focus Paint', params: { title: 'Untitled - Paint' } }],
  };
  const run = {
    id: 'run_verifier_seen',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: true,
    steps: workflow.steps.map((step) => ({ ...step, status: 'passed', attempts: 1 })),
  };
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  run.presenter.app = {
    ...run.presenter.app,
    target: 'Untitled - Paint',
    name: 'Paint',
    title: 'Untitled - Paint',
    process: 'mspaint',
    matched: true,
    status: 'finished',
  };
  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.verifier.app.name, 'Paint');
  assert.equal(run.presenter.verifier.app.title, 'Untitled - Paint');
  assert.equal(run.presenter.verifier.app.process, 'mspaint');
  store.flush();
});

test('a VLC goal that was played in Chrome is not approved', async () => {
  const workflow = {
    id: 'wf_vlc_web',
    name: 'VLC download and video playback',
    description: 'Download the VLC installer, then play a sample video in Chrome and verify it plays.',
    steps: [
      { id: 'stp_chrome', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 'stp_play', type: 'mediaHold', name: 'Watch the sample video', params: { title: 'trailer' } },
      { id: 'stp_hold', type: 'screenshot', name: 'Capture playback', params: {} },
    ],
  };
  const run = {
    id: 'run_vlc_web',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: true,
    steps: workflow.steps.map((step) => ({ ...step, status: 'passed', attempts: 1, output: 'Played in Chrome.' })),
  };
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  run.presenter.app = {
    ...run.presenter.app,
    target: 'chrome.exe',
    name: 'Chrome',
    title: 'trailer.mp4 - Google Chrome',
    process: 'chrome',
    matched: true,
    status: 'finished',
  };
  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.summary.goalMet, false);
  assert.equal(run.presenter.verifier.status, 'needs_review');
  assert.equal(run.presenter.verifier.requestedApp, 'VLC');
  assert.equal(run.presenter.verifier.appEvidence.evidenced, false);
  assert.match(run.presenter.verifier.summary, /simulated run/);
  assert.match(run.presenter.verifier.summary, /never actually opened or verified/);
  store.flush();
});

test('a VLC goal that really launched VLC still approves', async () => {
  const workflow = {
    id: 'wf_vlc_app',
    name: 'Play a video in VLC',
    description: 'Open VLC and play the sample video in it.',
    steps: [
      { id: 'stp_launch', type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' } },
      { id: 'stp_play', type: 'mediaHold', name: 'Play the video', params: { title: 'VLC' } },
    ],
  };
  const run = {
    id: 'run_vlc_app',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    dryRun: false,
    steps: workflow.steps.map((step) => ({ ...step, status: 'passed', attempts: 1 })),
  };
  const d = store.db();
  d.workflows = [workflow];
  d.runs = [run];
  d.positionMemory = [];
  await presenter.presenterStart(run, workflow);
  presenter.presenterFinish(run, workflow, { passed: true });
  assert.equal(run.presenter.summary.goalMet, true);
  assert.equal(run.presenter.verifier.status, 'verified');
  store.flush();
});
