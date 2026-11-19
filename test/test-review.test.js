import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestGoalApps } from '../server/goal-apps.js';
import { replicateRun } from '../server/alt-env.js';
import { crossReference } from '../server/cross-ref.js';
import { buildTestReview, sortTests } from '../server/test-review.js';

const vlc = (extra = {}) => ({ type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed', ...extra });

test('goal apps split into reusable now and setup later', () => {
  const suggestion = suggestGoalApps({
    goal: 'install 7-Zip and extract the archive',
    steps: [vlc({ appContext: { process: 'vlc', version: '3.0.20' } })],
    episodes: [{ status: 'passed', apps: ['vlc'], appVersions: { vlc: '3.0.20' } }],
  });
  const immediate = suggestion.immediate.map((entry) => entry.name);
  const later = suggestion.longTerm.map((entry) => entry.name);
  assert.ok(immediate.includes('VLC'), 'the app the plan already uses is an immediate reuse');
  assert.ok(later.includes('7-Zip'), 'the goal app that was never observed is long-term');
  assert.match(suggestion.brief, /IMMEDIATE/);
  const seven = suggestion.longTerm.find((entry) => entry.name === '7-Zip');
  assert.ok(seven.install.includes('winget install'), 'a catalogued long-term app carries its install command');
  assert.ok(seven.uninstall.includes('winget uninstall'), 'and its reversible uninstall');
});

test('alternate environment reuses what is open and blocks what is missing', () => {
  const run = {
    id: 'run_1',
    workflowName: 'VLC',
    steps: [
      { type: 'openUrl', name: 'Product page', params: { url: 'https://www.videolan.org/vlc/download-windows.html' }, status: 'passed' },
      { type: 'clickElement', name: 'Download VLC', params: { name: 'Download VLC', skipIfDownload: 'vlc-*.exe' }, status: 'passed' },
      { type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed', appContext: { process: 'vlc', version: '3.0.20' } },
      { type: 'verifyScreen', name: 'Check player', params: { question: 'Is VLC open?' }, status: 'passed' },
    ],
  };
  const result = replicateRun({
    run,
    env: {
      name: 'alt',
      openPages: ['https://videolan.org/vlc/download-windows.html'],
      downloads: ['vlc-3.0.21-win64.exe'],
      appVersions: { vlc: '3.0.21' },
      missingApps: ['obs'],
    },
  });
  assert.equal(result.breakdown[0].replication, 'reused');
  assert.equal(result.breakdown[1].replication, 'reused');
  assert.equal(result.breakdown[2].replication, 'diverged');
  assert.equal(result.summary.blocked, 0);
  assert.equal(result.summary.verdict, 'needs_adaptation');

  const blocked = replicateRun({ run: { steps: [vlc()] }, env: { name: 'alt', missingApps: ['vlc.exe'] } });
  assert.equal(blocked.breakdown[0].replication, 'blocked');
  assert.equal(blocked.summary.verdict, 'blocked');

  const locale = replicateRun({ run: { steps: [{ type: 'clickElement', name: 'Next', params: { name: 'Next' }, status: 'passed' }] }, env: { locale: 'de-DE' } });
  assert.equal(locale.breakdown[0].replication, 'diverged');
});

test('cross-reference repeats proven steps and names what is new', () => {
  const prior = {
    id: 'mem_1',
    runId: 'run_old',
    workflowId: 'wf_1',
    workflowName: 'VLC',
    status: 'passed',
    quality: 0.95,
    mode: 'live',
    createdAt: '2026-11-01T10:00:00.000Z',
    apps: ['vlc'],
    appVersions: { vlc: '3.0.20' },
    hindrances: [],
    steps: [
      { type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed' },
      { type: 'openUrl', name: 'Product page', params: { url: 'https://www.videolan.org/vlc/download-windows.html' }, status: 'passed' },
      { type: 'clickElement', name: 'Download VLC', params: { name: 'Download VLC' }, status: 'passed' },
      { type: 'installApp', name: 'Install VLC', params: { app: 'vlc' }, status: 'passed' },
      { type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed' },
      { type: 'verifyPlayback', name: 'Playback check', params: { title: 'vlc' }, status: 'passed' },
      { type: 'writeNote', name: 'Save note', params: { title: 'vlc' }, status: 'passed' },
    ],
  };
  const run = {
    id: 'run_new',
    workflowId: 'wf_1',
    workflowName: 'VLC',
    steps: [
      { type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed', appContext: { process: 'vlc', version: '3.0.21' } },
      { type: 'openUrl', name: 'Product page', params: { url: 'https://www.videolan.org/vlc/download-windows.html' }, status: 'passed' },
      { type: 'clickElement', name: 'Download VLC', params: { name: 'Download VLC' }, status: 'passed' },
      { type: 'installApp', name: 'Install VLC', params: { app: 'vlc' }, status: 'passed' },
      { type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed' },
      { type: 'verifyPlayback', name: 'Playback check', params: { title: 'vlc' }, status: 'passed' },
      { type: 'screenshot', name: 'Capture end state', params: { caption: 'end' }, status: 'passed' },
    ],
  };

  const cross = crossReference({ run, episodes: [prior], goal: 'install VLC and play a video' });
  assert.equal(cross.verdict, 'new_path', 'a different ending over the same phases is a new route, not a regression');
  assert.equal(cross.counts.repeated, 6);
  assert.equal(cross.counts.diverged, 1, 'the note step became a screenshot at the same position');
  assert.equal(cross.counts.regressions, 1, 'the previously passing note step is missing');
  assert.ok(cross.newDetails.some((entry) => entry.kind === 'version'), 'a changed app version is reported as new detail');
  assert.equal(cross.progress.covered, cross.progress.total);

  // Losing the install phase is a real regression against the same objective.
  const truncated = { ...run, steps: run.steps.slice(0, 4) };
  const regressed = crossReference({ run: truncated, episodes: [prior], goal: 'install VLC and play a video' });
  assert.equal(regressed.verdict, 'regressed');
  assert.ok(regressed.summary.some((line) => /more goal phases/.test(line)));
});

test('test review sorts by risk and keeps immediate before long-term work', () => {
  const run = {
    id: 'run_2',
    workflowId: 'wf_2',
    workflowName: 'VLC',
    steps: [
      { id: 's1', type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' }, status: 'passed', appContext: { process: 'vlc', version: '3.0.20' } },
      { id: 's2', type: 'type', name: 'Search for a video', params: { text: 'cats', foreground: 'Chrome' }, status: 'failed', error: 'foreground window changed' },
      { id: 's3', type: 'verifyScreen', name: 'Check playback', params: { question: 'Is the video playing?' }, status: 'pending' },
    ],
  };
  const simulation = {
    id: 'sim_1',
    status: 'completed',
    summary: { confirmed: 1, mismatch: 1, missing: 0, verdict: 'disagrees' },
    breakdown: [
      { stepId: 's1', seq: 1, name: 'Open VLC', verdict: 'confirmed', changedPct: 12, frames: 1 },
      { stepId: 's2', seq: 2, name: 'Search for a video', verdict: 'mismatch', changedPct: 0, frames: 1 },
      { stepId: 's3', seq: 3, name: 'Check playback', verdict: 'observed', changedPct: null, frames: 1 },
    ],
  };

  const review = buildTestReview({
    run,
    simulation,
    episodes: [{ id: 'mem', workflowId: 'wf_2', status: 'passed', quality: 0.9, createdAt: '2026-11-01T00:00:00.000Z', apps: ['vlc'], steps: [], hindrances: [] }],
    longTermGoal: 'use 7-Zip for archives later',
    sort: 'risk',
  });

  assert.equal(review.verdict, 'blocked');
  assert.equal(review.tests[0].seq, 2, 'the failed, pixel-contradicted step sorts first');
  assert.ok(review.tests[0].risk >= 84);
  assert.equal(review.counts.checks, 1);
  assert.equal(review.evidence.coveragePct, 100);
  assert.ok(review.apps.immediate.some((entry) => entry.name === 'VLC'));
  assert.ok(review.apps.longTerm.some((entry) => entry.name.includes('7-Zip')));
  assert.ok(review.suggestions.now.length > 0);

  const bySeq = sortTests(review.tests, 'seq');
  assert.deepEqual(bySeq.map((entry) => entry.seq), [1, 2, 3]);
  const byPhase = sortTests(review.tests, 'phase');
  assert.equal(byPhase[0].phase, 'launch');
});
