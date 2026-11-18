import test from 'node:test';
import assert from 'node:assert/strict';
import { goalApp } from '../server/strategy.js';
import { appTokens, mentionsApp, goalNeedsOpen, goalAppEvidence } from '../server/goal-evidence.js';

const vlc = goalApp('open VLC and play the video in it');

function step(overrides) {
  return { id: 'stp', name: 'step', status: 'passed', params: {}, ...overrides };
}

test('the catalogue resolves VLC as the goal app', () => {
  assert.equal(vlc.name, 'VLC');
  assert.ok(appTokens(vlc).includes('vlc'));
});

test('the app name matches whole words only', () => {
  assert.equal(mentionsApp('VLC media player', vlc), true);
  assert.equal(mentionsApp('C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', vlc), true);
  assert.equal(mentionsApp('Chrome :: trailer.mp4 - video', vlc), false);
});

test('playing the video in Chrome is not VLC evidence', () => {
  const run = {
    steps: [
      step({ id: 'a', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } }),
      step({ id: 'b', type: 'openUrl', name: 'Open the sample video', params: { url: 'https://media.w3.org/trailer.mp4' } }),
      step({ id: 'c', type: 'mediaHold', name: 'Watch the video', params: { title: 'trailer' }, output: 'Playback ended after 52s.' }),
      step({ id: 'd', type: 'screenshot', name: 'Capture the video', params: {} }),
    ],
  };
  const evidence = goalAppEvidence({ run, goal: 'open VLC and play the video in it', app: vlc, foreground: { process: 'chrome' } });
  assert.equal(evidence.evidenced, false);
  assert.equal(evidence.opens.length, 0);
  assert.match(evidence.reason, /VLC was not opened or verified/);
  assert.match(evidence.reason, /ran in chrome/);
});

test('a launch or a focused window of the app is evidence', () => {
  const launched = goalAppEvidence({
    run: { steps: [step({ type: 'launchApp', params: { target: 'vlc.exe' } })] },
    goal: 'open VLC and play the video in it',
    app: vlc,
  });
  assert.equal(launched.evidenced, true);
  assert.equal(launched.opens[0].field, 'params.target');

  // A focused window title is only corroboration: a Chrome tab can be titled "VLC".
  const titleOnly = goalAppEvidence({
    run: { dryRun: true, steps: [step({ type: 'focusWindow', params: { title: 'VLC media player' } })] },
    goal: 'open VLC and play the video in it',
    app: vlc,
  });
  assert.equal(titleOnly.evidenced, false);
  assert.equal(titleOnly.weak.length, 1);

  const focusedInFront = goalAppEvidence({
    run: { steps: [step({ type: 'focusWindow', params: { title: 'VLC media player' } })] },
    goal: 'open VLC and play the video in it',
    app: vlc,
    foreground: { process: 'vlc', title: 'VLC media player' },
  });
  assert.equal(focusedInFront.evidenced, true);
});

test('a Chrome tab titled VLC while Chrome is in front is not VLC evidence', () => {
  const evidence = goalAppEvidence({
    run: {
      dryRun: false,
      steps: [
        step({ type: 'focusWindow', name: 'Focus the VLC download page', params: { title: 'VLC' } }),
        step({ type: 'clickElement', name: 'Download VLC', params: { window: 'VLC', name: 'Download VLC' } }),
      ],
    },
    goal: 'download VLC and play a sample video',
    app: vlc,
    foreground: { process: 'chrome', title: 'VLC Windows installer - Google Search' },
  });
  assert.equal(evidence.evidenced, false);
  assert.match(evidence.reason, /only match was a window titled “VLC” while chrome was in front/);
});

test('a window the run verified is evidence even without a launch step', () => {
  const evidence = goalAppEvidence({
    run: {
      steps: [
        step({ type: 'clickElement', params: { window: 'VLC media player', name: 'Play' }, verification: { detail: 'window foreground: vlc :: VLC media player' } }),
      ],
    },
    goal: 'use VLC',
    app: vlc,
  });
  assert.equal(evidence.evidenced, true);
});

test('an install counts for an install goal but not for one that must open the app', () => {
  const install = step({ type: 'installApp', params: { app: 'VLC' }, status: 'passed' });
  const installOnly = goalAppEvidence({ run: { steps: [install] }, goal: 'install VLC', app: vlc });
  assert.equal(installOnly.needsOpen, false);
  assert.equal(installOnly.evidenced, true);

  const openGoal = goalAppEvidence({ run: { steps: [install] }, goal: 'install then open VLC', app: vlc });
  assert.equal(openGoal.needsOpen, true);
  assert.equal(openGoal.evidenced, false);
  assert.match(openGoal.reason, /not opened or verified/);
});

test('failed steps do not count as evidence', () => {
  const evidence = goalAppEvidence({
    run: { steps: [step({ type: 'launchApp', params: { target: 'vlc.exe' }, status: 'failed' })] },
    goal: 'open VLC',
    app: vlc,
  });
  assert.equal(evidence.evidenced, false);
});

test('the run target is evidence when the engine retargeted a repair', () => {
  const evidence = goalAppEvidence({
    run: { steps: [], effectiveApp: { target: 'vlc.exe' } },
    goal: 'open VLC',
    app: vlc,
  });
  assert.equal(evidence.evidenced, true);
  assert.equal(evidence.opens[0].type, 'effectiveApp');
});

test('open wording is detected from the goal', () => {
  assert.equal(goalNeedsOpen('download and install VLC'), false);
  assert.equal(goalNeedsOpen('play a video in VLC'), true);
});
