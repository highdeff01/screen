import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-goal-status-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');
const pipeline = await load('server/pipeline.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    // Windows releases the temp folder's handles a moment after the last write.
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

function workflowWith(steps, { name, description }) {
  return {
    id: `wf_goal_${name.replace(/\W+/g, '_')}`,
    name,
    description,
    status: 'draft',
    failurePolicy: { onFailure: 'stop', maxRetries: 0, captureScreenshot: false },
    steps,
  };
}

function probeFor() {
  // A launched app opens its window, so the launch verification can pass.
  const windowFor = ({ title = '', process = '' } = {}) => {
    const label = title || `${process || 'app'} window`;
    return { state: 'foreground', title: label, process, matches: [{ title: label, process, state: 'foreground' }], foreground: { title: label, process, id: 1 } };
  };
  return {
    captureScreenSignature: async () => ({ at: new Date().toISOString(), hash: 'x', cells: [] }),
    inspectWindowState: async (params = {}) => windowFor(params),
    readFocusedElement: async () => ({ found: false }),
    findUiElement: async () => ({ found: false }),
    executeStep: async (step) => ({ output: `did ${step.name}`, evidence: [] }),
  };
}

function quietSettings() {
  const s = store.db().settings;
  s.visualChecks = false;
  s.autoNotes = false;
  s.autoRecoverFailures = false;
  s.presenceEnabled = false;
}

test('a passing run that never opened the goal app is marked needs_review', async () => {
  quietSettings();
  pipeline.registerHandler('deep-focus', async () => 'started');
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture the video', params: {} },
    ],
    {
      name: 'VLC download and video playback',
      description: 'Download the VLC installer, then play a sample video in Chrome and verify it plays.',
    }
  );
  store.db().workflows = [workflow];
  const run = engine.createRun(workflow, { dryRun: false, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.status, 'needs_review');
  assert.equal(finished.goalUnverified, true);
  assert.match(finished.goalVerdict.reason, /VLC was not opened or verified/);
  assert.equal(finished.presenter.summary.goalMet, false);
  assert.equal(finished.presenter.verifier.status, 'needs_review');
  assert.match(finished.errorSummary, /Goal not verified/);
  assert.ok(pipeline.pipelineStatus().queued.some((job) => job.key === `deep-focus:${run.id}`), 'the unverified goal is queued for focus');
});

test('a passing run that launched the goal app stays passed', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture playback', params: {} },
    ],
    { name: 'Play a video in VLC', description: 'Open VLC and play the sample video in it.' }
  );
  store.db().workflows = [workflow];
  const run = engine.createRun(workflow, { dryRun: false, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.status, 'passed');
  assert.equal(finished.goalUnverified, undefined);
  assert.equal(finished.presenter.summary.goalMet, true);
  assert.equal(finished.presenter.verifier.status, 'verified');
});

test('a goal that names no app keeps the run passed', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture the page', params: {} },
    ],
    { name: 'Open a browser page', description: 'Open example.com and capture the page.' }
  );
  store.db().workflows = [workflow];
  const run = engine.createRun(workflow, { dryRun: false, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.status, 'passed');
  assert.equal(finished.presenter.summary.goalMet, true);
});

test('launching a catalogue app passes the catalogue executable and the media argument', async () => {
  const { buildScript } = await load('server/automation.js');
  const vlcExe = path.win32.join('C:', 'Program Files', 'VideoLAN', 'VLC', 'vlc.exe');
  const video = path.win32.join('C:', 'data', 'media', 'sintel-trailer.mp4');
  const script = buildScript({
    id: 's1',
    type: 'launchApp',
    name: 'Open VLC with the video',
    params: { target: 'VLC', args: [video] },
  });
  assert.ok(script.includes(vlcExe), 'catalogue executable is a launch candidate');
  assert.ok(script.includes(`Start-Process -FilePath $candidate -ArgumentList @('${video}')`), 'media argument reaches the app');
  // The plain path branch must still exist for apps outside the catalogue.
  assert.ok(script.includes('Test-Path -LiteralPath $target'));
});


test('a simulated needs-review run starts no analysis, repair or retry-budget work', async () => {
  quietSettings();
  store.db().settings.autoNotes = true;
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture the video', params: {} },
    ],
    { name: 'VLC playback rehearsal', description: 'Open VLC and play the sample video in it.' }
  );
  store.db().workflows = [workflow];
  store.db().suggestions = [];
  const run = engine.createRun(workflow, { dryRun: true, probe: probeFor() });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(finished.dryRun, true);
  assert.equal(finished.status, 'needs_review');
  // Rehearsing a goal is not a failure: no analysis, no triage, no repair
  // suggestion and no retry-budget failure may be recorded for it.
  assert.ok(!finished.analysis, 'no analysis was generated');
  assert.ok(!finished.triageDone, 'no watchdog triage was claimed');
  assert.ok(!finished.retryBudget, 'no retry budget was recorded');
  assert.ok(!finished.autoProposalId, 'no repair proposal was auto-created');
  assert.ok(!workflow.retryBudget, 'the workflow budget was not touched');
  const churn = store.db().suggestions.filter(
    (entry) => entry.runId === run.id && ['failure', 'retry-budget'].includes(entry.kind)
  );
  assert.deepEqual(churn, [], 'no failure or budget suggestion was raised');
});


test('a run whose playback check fails never passes, even with VLC launched', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open VLC', params: { target: 'VLC' } },
      { id: 's2', type: 'verifyPlayback', name: 'Verify the video plays in VLC', params: { title: 'VLC media player' } },
    ],
    { name: 'VLC playback proof', description: 'Open VLC and verify the sample video plays inside it.' }
  );
  store.db().workflows = [workflow];
  const probe = probeFor();
  probe.executeStep = async (step) => {
    if (step.type === 'verifyPlayback') {
      throw new Error('Playback check failed (98%): the two frames did not show advancing playback.');
    }
    return { output: `did ${step.name}`, evidence: [] };
  };
  const run = engine.createRun(workflow, { dryRun: false, probe });
  const finished = await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.notEqual(finished.status, 'passed');
  assert.equal(finished.steps.find((step) => step.id === 's2').status, 'failed');
  assert.equal(finished.followupFailed || false, false);
});

test('a video that played to its end passes playback verification', async () => {
  const { playbackVerdict, playbackCheckPrompts, playbackHistoryPrompts, playbackHistoryShots } = await load(
    'server/automation.js'
  );
  // A moving wallpaper or clock is not the video: the same screen with an idle
  // player must fail even when the model calls it a pass.
  const desktopMotion = playbackVerdict({
    state: 'not_started',
    playing: true,
    progressed: true,
    started: false,
    finished: false,
    confidence: 0.95,
    pass: true,
    observed: 'VLC shows its traffic-cone logo at 00:00; the wallpaper behind it changed between frames.',
  });
  assert.equal(desktopMotion.pass, false, 'motion outside the player is not playback');
  assert.match(desktopMotion.reason, /never started/);

  // Players drop the picture at the end: a timeline parked at its own full
  // duration is a finished video, not one that never started.
  const parkedAtEnd = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.99,
    pass: false,
    elapsed: 156,
    duration: 156,
    progress: '02:36 / 02:36',
    frames: [
      { readout: '02:36 / 02:36', elapsed: 156, duration: 156 },
      { readout: '02:36 / 02:36', elapsed: 156, duration: 156 },
    ],
    observed: 'VLC holds a black surface with the timeline at 02:36 / 02:36 and the pause button shown.',
  });
  assert.equal(parkedAtEnd.pass, true, 'the readout at full duration beats the model’s not_started label');
  assert.equal(parkedAtEnd.completed, true);
  assert.equal(parkedAtEnd.corroboratedEnd, true);

  // The model reports the readout in `progress` and leaves elapsed/duration
  // null, so that field's text is a readout on its own; `observed` prose is
  // still never parsed.
  const textOnlyReadout = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.95,
    pass: false,
    progress: '02:36 / 02:36',
    frames: [{ readout: '02:36 / 02:36' }, { readout: '02:36 / 02:36' }],
  });
  assert.equal(textOnlyReadout.pass, true, 'the progress text at full duration is a readout');
  assert.equal(textOnlyReadout.completed, true);

  // One transcription is not proof: an end-of-media pass needs both frames to
  // agree with the total, because a dialog covering the player once merged the
  // duration with a volume label into a convincing "02:36 / 02:36".
  const uncorroborated = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.99,
    pass: true,
    progress: '02:36 / 02:36',
  });
  assert.equal(uncorroborated.pass, false, 'a single readout at full duration is not enough');
  assert.equal(uncorroborated.claimedAtDuration, true);
  assert.equal(uncorroborated.corroboratedEnd, false);
  assert.match(uncorroborated.reason, /not confirmed in both frames/);

  const coveredPlayer = playbackVerdict({
    state: 'unknown',
    playing: false,
    progressed: true,
    started: true,
    finished: false,
    confidence: 0.95,
    pass: true,
    progress: '02:36 / 02:36',
    frames: [
      { readout: '00:43 / 02:36', elapsed: 43, duration: 156 },
      { readout: '00:46 / 02:36', elapsed: 46, duration: 156 },
    ],
    observed: 'A Windows Security dialog covers the left of the player; the readout merges with the volume label.',
  });
  assert.equal(coveredPlayer.pass, false, 'frames at 00:43 and 00:46 contradict a merged 02:36 / 02:36');
  assert.match(coveredPlayer.reason, /not confirmed in both frames/);

  // Mid-clip pause: the readouts agree with each other but not with the total.
  const pausedMidClip = playbackVerdict({
    state: 'paused',
    playing: false,
    progressed: false,
    started: true,
    finished: false,
    confidence: 0.96,
    pass: false,
    progress: '01:04 / 02:36',
    frames: [
      { readout: '01:02 / 02:36', elapsed: 62, duration: 156 },
      { readout: '01:04 / 02:36', elapsed: 64, duration: 156 },
    ],
  });
  assert.equal(pausedMidClip.pass, false, 'a paused clip part-way through is not a finished video');
  assert.match(pausedMidClip.reason, /paused part-way/);

  // A stalled player at mid-clip that claims to have finished is contradicted
  // by its own second frame, and a clip that restarted is not a finish either.
  const stalledMidClip = playbackVerdict({
    state: 'ended',
    playing: false,
    progressed: false,
    started: true,
    finished: true,
    confidence: 0.9,
    pass: true,
    progress: '01:04 / 02:36',
    frames: [{ elapsed: 64, duration: 156 }, { elapsed: 64, duration: 156 }],
  });
  assert.equal(stalledMidClip.pass, false, 'a frame 2 that is not at the end contradicts a finish claim');
  assert.match(stalledMidClip.reason, /restarted instead of finishing|not at the end/);

  const restarted = playbackVerdict({
    state: 'ended',
    playing: true,
    progressed: true,
    started: true,
    finished: true,
    confidence: 0.92,
    pass: true,
    progress: '00:01 / 02:36',
    frames: [{ elapsed: 156, duration: 156 }, { elapsed: 1, duration: 156 }],
  });
  assert.equal(restarted.finished, false, 'a clip that looped back to the start did not finish');

  // The media file's real length is an independent total: a 52s clip cannot
  // report 02:36 / 02:36, even when both frames repeat the invented number.
  const endOfShortClip = {
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.95,
    pass: false,
    progress: '02:36 / 02:36',
    frames: [{ readout: '02:36 / 02:36' }, { readout: '02:36 / 02:36' }],
  };
  const wrongTotal = playbackVerdict(endOfShortClip, { expectedDuration: 52.2 });
  assert.equal(wrongTotal.pass, false, 'a total that contradicts the media file cannot pass');
  assert.match(wrongTotal.reason, /does not match the media file/);
  const rightTotal = playbackVerdict(endOfShortClip, { expectedDuration: 156.6 });
  assert.equal(rightTotal.pass, true, 'the same readout passes when it matches the file length');
  assert.equal(rightTotal.durationMatchesMedia, true);

  // A model that quotes the prompt's own example while saying no readout is
  // visible must not be read as evidence.
  const quotedExample = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.95,
    pass: false,
    observed: 'There are no visible elapsed time indicators (like 02:36 / 02:36) in either frame.',
  });
  assert.equal(quotedExample.pass, false, 'an example quoted in prose is not a readout');

  const atStartOfMedia = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.99,
    pass: false,
    progress: '00:00 / 02:36',
  });
  assert.equal(atStartOfMedia.pass, false, 'a timeline at 0:00 of its duration never started');

  const checkPrompts = playbackCheckPrompts({ expected: 'VLC media player' });
  assert.match(checkPrompts.system, /Judge the player window only/);
  assert.match(checkPrompts.system, /time readout/);
  assert.match(checkPrompts.system, /never ended/);
  assert.match(checkPrompts.system, /EACH frame separately/);
  assert.match(checkPrompts.system, /never copy one frame/);
  const historyPrompts = playbackHistoryPrompts({ expected: 'VLC media player' }).system;
  assert.match(historyPrompts, /fell back to its idle\/logo art/);
  assert.match(historyPrompts, /do not fail samePlayer just because the media is no longer visible/);
  assert.match(historyPrompts, /frames/);
  const finished = playbackVerdict({
    state: 'ended',
    playing: false,
    progressed: false,
    started: true,
    finished: true,
    confidence: 0.84,
    pass: true,
    observed: 'VLC shows the last frame with 00:32 / 00:32 in the progress bar.',
  });
  assert.equal(finished.pass, true);
  assert.equal(finished.completed, true);

  const never = playbackVerdict({
    state: 'not_started',
    playing: false,
    progressed: false,
    started: false,
    finished: false,
    confidence: 0.9,
    pass: false,
    observed: 'VLC shows a black window at 00:00 / 00:32 with a large play button.',
  });
  assert.equal(never.pass, false);
  assert.match(never.reason, /never started/);

  const endedWithoutPlayback = playbackVerdict({
    state: 'ended',
    playing: false,
    progressed: false,
    started: false,
    finished: true,
    confidence: 0.9,
    pass: true,
  });
  assert.equal(endedWithoutPlayback.pass, false, 'an ended screen alone is not proof that playback ran');

  assert.match(playbackHistoryPrompts({ expected: 'VLC media player' }).system, /samePlayer/);

  const captures = path.join(process.cwd(), 'data', 'captures');
  fs.mkdirSync(captures, { recursive: true });
  fs.writeFileSync(path.join(captures, 'prior.png'), 'frame');
  const shots = playbackHistoryShots(
    {
      evidence: [
        { kind: 'screenshot', path: 'captures/prior.png', caption: 'earlier', createdAt: '2026-11-18T01:00:00Z' },
        { kind: 'screenshot', path: 'captures/missing.png', createdAt: '2026-11-18T02:00:00Z' },
      ],
    },
    { exclude: ['captures/current.png'], limit: 3 }
  );
  assert.equal(shots.length, 1, 'only screenshots that still exist are offered');
  assert.equal(shots[0].path, 'captures/prior.png');
});

test('a launch raises the real app window and never adopts a setup lookalike', async () => {
  const { buildScript } = await load('server/automation.js');
  const script = buildScript({ id: 's1', type: 'launchApp', name: 'Open VLC', params: { target: 'VLC' } });
  assert.match(script, /Show-SightlineFront \$frontLeaf/);
  assert.match(script, /SetForegroundWindow\(\$front\.MainWindowHandle\)/);
  assert.match(script, /MainWindowTitle -notmatch \$setupPattern/);
});

test('an installer window in front never counts as the app being open', async () => {
  quietSettings();
  const workflow = workflowWith(
    [
      { id: 's1', type: 'launchApp', name: 'Open VLC', params: { target: 'vlc.exe' } },
      { id: 's2', type: 'screenshot', name: 'Capture VLC', params: {} },
    ],
    { name: 'Play a video in VLC', description: 'Open VLC and play the sample video in it.' }
  );
  store.db().workflows = [workflow];
  let launches = 0;
  const probe = probeFor();
  probe.inspectWindowState = async () => ({
    state: 'foreground',
    title: 'VLC media player 3.0.24 Setup',
    process: 'vlc-installer',
    matches: [],
    foreground: { title: 'VLC media player 3.0.24 Setup', process: 'vlc-installer', id: 7 },
  });
  probe.executeStep = async (step) => {
    if (step.type === 'launchApp') launches += 1;
    return { output: `launched ${step.params?.target || 'app'}`, evidence: [] };
  };
  const run = engine.createRun(workflow, { dryRun: false, probe });
  await engine.waitForRun(run.id, { timeoutMs: 30000 });
  assert.equal(launches, 1, 'the launch ran instead of being skipped for an installer window');
});

test('media paths, media length and covered-player scans degrade safely', async () => {
  const { windowsPath, mediaDurationSeconds, coveringWindows } = await load('server/automation.js');
  // VLC opens an idle window and ignores the media when the path uses forward
  // slashes, which then looks like a video that refused to start.
  assert.equal(windowsPath('C:/Users/Dan/clip.mp4'), 'C:\\Users\\Dan\\clip.mp4');
  assert.equal(windowsPath('C:\\Users\\Dan\\clip.mp4'), 'C:\\Users\\Dan\\clip.mp4');
  assert.equal(windowsPath('https://example.com/a.mp4'), 'https://example.com/a.mp4');
  assert.equal(windowsPath('file:///C:/a.mp4'), 'file:///C:/a.mp4');
  assert.equal(windowsPath('relative/clip.mp4'), 'relative/clip.mp4');
  assert.equal(windowsPath(''), '');

  assert.equal(
    await mediaDurationSeconds({ steps: [{ type: 'launchApp', params: { args: ['data/media/missing-clip.mp4'] } }] }),
    null,
    'a missing media file yields no duration instead of an error'
  );
  assert.equal(await mediaDurationSeconds(null), null);
  assert.deepEqual(await coveringWindows(''), [], 'no player title means no window scan');
});

test('a held step reports the wait on the run summary', async () => {
  const summary = engine.summary({
    id: 'run_held',
    workflowId: 'wf_held',
    workflowName: 'Held run',
    status: 'running',
    steps: [],
    presence: { holding: true, reason: 'holding 7s for the user to finish moving', deferredMs: 3000 },
    deferrals: [{ stepId: 's1', waitedMs: 8000, at: '2026-11-18T02:00:00Z' }],
  });
  assert.equal(summary.presence.holding, true);
  assert.match(summary.presence.reason, /holding 7s/);
  assert.equal(summary.deferrals.length, 1);
});

test('a finished run stops showing the presence hold', async () => {
  const run = {
    presence: { holding: true, reason: 'holding 7s for the user to finish moving', deferredMs: 3000, waitMs: 7400 },
  };
  engine.clearPresenceHold(run);
  assert.equal(run.presence.holding, false);
  assert.equal(run.presence.reason, '');
  assert.equal(run.presence.waitMs, 0);
  assert.equal(run.presence.deferredMs, 3000, 'the history of the wait is kept');

  const summary = engine.summary({
    id: 'run_done',
    workflowId: 'wf_done',
    workflowName: 'Done run',
    status: 'passed',
    steps: [],
    presence: run.presence,
  });
  assert.equal(summary.presence.holding, false, 'a finished run does not look like it is waiting');
});

test('the Space key survives shortcut normalization', async () => {
  const { normalizeShortcutKeys } = await load('server/automation.js');
  // `space` used to map to a literal " " that every trim in the parser ate,
  // so a Space keystroke reached SendKeys as an empty key list.
  assert.deepEqual(normalizeShortcutKeys(['space']), [' ']);
  assert.deepEqual(normalizeShortcutKeys(['Space']), [' ']);
  assert.deepEqual(normalizeShortcutKeys([' ']), [' ']);
  assert.deepEqual(normalizeShortcutKeys(['ctrl+space']), ['^ ']);
  assert.deepEqual(normalizeShortcutKeys(['ctrl+a, space']), ['^a', ' ']);
  assert.deepEqual(normalizeShortcutKeys(['']), [], 'blank items are still dropped');
  assert.deepEqual(normalizeShortcutKeys(['enter']), ['{ENTER}']);
});
