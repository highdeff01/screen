import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const observer = await load('server/app-observer.js');

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

function makeStep(overrides = {}) {
  return {
    id: 'stp_observe',
    name: 'Fetch the proof',
    type: 'downloadMedia',
    status: 'running',
    params: {},
    startedAt: iso(1000),
    ...overrides,
  };
}

function makeRun(step, overrides = {}) {
  return {
    id: 'run_observe',
    workflowName: 'Observer test',
    status: 'running',
    currentStepId: step.id,
    steps: [step],
    log: [],
    files: [],
    variables: {},
    pendingVerification: [],
    ...overrides,
  };
}

test('the observer names the step that just started', () => {
  const run = makeRun(makeStep());
  const first = observer.observeStep(run);
  assert.match(first.text, /“Fetch the proof” started \(step 1\/1, downloadMedia\)\./);
  assert.equal(first.signature, 'stp_observe:start');
});

test('the same situation is not narrated twice', () => {
  const run = makeRun(makeStep());
  const first = observer.observeStep(run);
  assert.equal(observer.observeStep(run, { previous: first }), null);
});

test('a written file is named with its real size', () => {
  const step = makeStep();
  const run = makeRun(step, { files: [{ path: 'data/media/proof.txt', bytes: 16, filename: 'proof.txt', kind: 'file' }] });
  const first = observer.observeStep(run);
  const next = observer.observeStep(run, { previous: first });
  assert.match(next.text, /“Fetch the proof” wrote data\/media\/proof\.txt \(16 bytes\)\./);
});

test('a step waiting on a window says which window is really in front', () => {
  const step = makeStep({ type: 'focusWindow', params: { title: 'VLC media player' } });
  const run = makeRun(step);
  const first = observer.observeStep(run);
  assert.match(first.text, /Waiting on “VLC media player”\./);
  const monitor = { current: { title: 'Sightline — Google Chrome', process: 'chrome' } };
  const next = observer.observeStep(run, { previous: first, monitor });
  assert.match(next.text, /waiting on “VLC media player”, but the foreground is “Sightline — Google Chrome” \(chrome\)/);
});

test('the observer confirms the window a step expects', () => {
  const step = makeStep({ type: 'focusWindow', name: 'Focus VLC media player', params: { title: 'VLC media player' } });
  const run = makeRun(step);
  const first = observer.observeStep(run);
  const monitor = { current: { title: 'VLC media player — sintel.mp4', process: 'vlc' } };
  const next = observer.observeStep(run, { previous: first, monitor });
  assert.match(next.text, /“VLC media player — sintel\.mp4” is in front, as “Focus VLC media player” expects/);
});

test('a long step reports its elapsed bucket and the last thing the app said', () => {
  const step = makeStep({ name: 'Wait for the page', type: 'waitFor', startedAt: iso(16000) });
  const run = makeRun(step, {
    log: [{ at: iso(15000), level: 'info', message: 'Step Wait for the page (waitFor)', stepId: step.id }],
  });
  const first = observer.observeStep(run);
  const next = observer.observeStep(run, { previous: first });
  assert.match(next.text, /has been running 15s; last log: “Step Wait for the page \(waitFor\)”/);
});

test('the observer does not quote its own lines back as the app', () => {
  const step = makeStep({ name: 'Record', type: 'recordVideo', startedAt: iso(16000) });
  const run = makeRun(step, {
    log: [{ at: iso(100), level: 'info', message: 'Observer: “Record” started (step 1/1, recordVideo).', stepId: step.id }],
  });
  const first = observer.observeStep(run);
  const next = observer.observeStep(run, { previous: first });
  assert.match(next.text, /no log line from it yet/);
});

test('a step that still owes a check says what it is waiting on', () => {
  const step = makeStep({ type: 'recordVideo', name: 'Record' });
  const run = makeRun(step, { pendingVerification: [{ stepId: step.id, checks: ['file'] }] });
  const first = observer.observeStep(run);
  const next = observer.observeStep(run, { previous: first });
  assert.match(next.text, /waiting on file before it counts as done/);
});

test('the closing line gives the duration and the artefact', () => {
  const step = makeStep({ name: 'Record', type: 'recordVideo', status: 'passed', endedAt: iso(0), startedAt: iso(4000) });
  const run = makeRun(step);
  const end = observer.endStepObservation(run, step, { ...step, files: [] });
  assert.ok(end);
  const withFile = observer.endStepObservation(
    { ...run, files: [{ path: 'data/media/clip.mp4', bytes: 2048, filename: 'clip.mp4' }] },
    step
  );
  assert.match(end.text, /“Record” passed after 4s\./);
  assert.match(withFile.text, /passed after 4s, wrote data\/media\/clip\.mp4/);
});

test('nothing is narrated when no step is actually running', () => {
  assert.equal(observer.observeStep({ steps: [{ id: 'a', status: 'pending' }], currentStepId: 'a' }), null);
  assert.equal(observer.observeStep({}), null);
});

test('the observer state is readable without a run', () => {
  const state = observer.observerState();
  assert.equal(state.running, false);
  assert.ok(Array.isArray(state.observations));
  assert.ok(state.intervalMs >= 1000);
});
