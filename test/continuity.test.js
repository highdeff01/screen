import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-continuity-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const continuity = await load('server/continuity-engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function workflowFixture() {
  return {
    id: 'wf_continuity_probe',
    name: 'Diamond answer',
    description: 'Open Notepad and ask "What is a diamond?" then save the answer to Desktop.',
    status: 'ready',
    target: { title: 'Notepad', process: 'notepad' },
    steps: [
      {
        id: 's1',
        type: 'launchApp',
        name: 'Open Notepad',
        params: { target: 'notepad.exe' },
        status: 'passed',
      },
      {
        id: 's2',
        type: 'type',
        name: 'Ask the question',
        params: { text: 'hard-coded original wording' },
        status: 'failed',
        error: 'Target window lost focus',
      },
      {
        id: 's3',
        type: 'openUrl',
        name: 'Open a reference',
        params: { url: 'https://example.com/diamond' },
        status: 'passed',
      },
      {
        id: 's4',
        type: 'click',
        name: 'Click',
        params: { x: 5000, y: 2400 },
        status: 'passed',
      },
      {
        id: 's5',
        type: 'wait',
        name: 'Wait for the answer',
        params: { ms: 6000 },
        status: 'passed',
      },
      {
        id: 's6',
        type: 'writeTextFile',
        name: 'Save the answer',
        params: { path: 'diamond.txt', text: 'old', overwrite: true },
        status: 'passed',
      },
    ],
  };
}

function runFixture() {
  return {
    id: 'run_continuity_probe',
    workflowId: 'wf_continuity_probe',
    workflowName: 'Diamond answer',
    status: 'failed',
    dryRun: true,
    failureSignature: 'focus: target window lost focus',
    steps: [
      { id: 's1', name: 'Open Notepad', type: 'launchApp', status: 'passed' },
      { id: 's2', name: 'Ask the question', type: 'type', status: 'failed', error: 'Target window lost focus' },
    ],
    evidence: [],
  };
}

test('window reasoning separates background, minimized, hidden and closed', () => {
  const background = continuity.windowReason(
    { state: 'background', foreground: { process: 'Code', title: 'app.js' } },
    { run: runFixture(), workflow: workflowFixture() }
  );
  assert.match(background, /running but Code/);
  assert.match(background, /relaunching would create a second instance/);

  const minimized = continuity.windowReason({ state: 'minimized' }, {});
  assert.match(minimized, /minimized/);
  assert.match(minimized, /restore/i);

  const hidden = continuity.windowReason({ state: 'hidden' }, {});
  assert.match(hidden, /visible window/);

  const closed = continuity.windowReason({ state: 'closed' }, {});
  assert.match(closed, /closed or crashed/);
});

test('instruction wording is not mistaken for replacement input text', () => {
  const d = store.db();
  d.presenter = { screen: { width: 1920, height: 1080 } };
  const workflow = {
    id: 'wf_instruction_text',
    name: 'Kiro question',
    description:
      'Focus Kiro. Reuse the visible Kiro chat when it already shows “what is a diamond”; otherwise start a new chat. Ask the question only when it is not already present, then copy the latest answer.',
    steps: [
      {
        id: 'type_question',
        type: 'type',
        name: 'Ask Kiro the question',
        params: { text: 'what is a diamond' },
        status: 'passed',
      },
    ],
  };
  const review = continuity.analyzeContinuity({
    run: { id: 'run_instruction_text', workflowId: workflow.id, status: 'passed', dryRun: true, steps: [] },
    workflow,
    windowState: { state: 'unknown' },
  });
  assert.equal(review.checks.some((entry) => entry.key === 'text:type_question'), false);
  assert.equal(review.suggestedWorkflow, null);
});

test('the verifier flags stale wording, placeholder links, off-screen coordinates and blind waits', () => {
  const d = store.db();
  d.settings.continuityAiReview = false;
  d.presenter = { screen: { width: 1920, height: 1080 } };
  d.positionMemory = [];
  d.memory.docs = [];
  const review = continuity.analyzeContinuity({
    run: runFixture(),
    workflow: workflowFixture(),
    windowState: { state: 'background', foreground: { process: 'Code', title: 'app.js' } },
  });
  const keys = review.checks.map((entry) => entry.key);
  assert.ok(keys.includes('text:s2'));
  assert.ok(keys.includes('link:s3'));
  assert.ok(keys.includes('coord:s4'));
  assert.ok(keys.includes('blind-wait:s5'));
  assert.ok(keys.includes('overwrite:s6'));
  assert.equal(review.status, 'needs_fix');
  assert.equal(review.continuation.ready, true);
  assert.ok(review.suggestedWorkflow);
  const typed = review.suggestedWorkflow.steps.find((step) => step.id === 's2');
  assert.equal(typed.params.text, 'What is a diamond?');
  assert.ok(review.suggestedWorkflow.changes.some((change) => change.kind === 'text-update'));
});

test('review persists a verdict and a suggestion can become a real draft workflow', async () => {
  const d = store.db();
  d.settings.continuityAiReview = false;
  d.workflows = [workflowFixture()];
  d.runs = [runFixture()];
  d.continuity = undefined;
  continuity.ensureContinuity();

  const review = await continuity.reviewRunContinuity(d.runs[0], { capture: false, inspectWindow: false });
  assert.equal(review.runId, 'run_continuity_probe');
  assert.ok(review.checks.length >= 4);
  const state = continuity.continuityState();
  assert.equal(state.summary.openSuggestions, 1);
  const continuation = state.continuations.find((entry) => entry.runId === 'run_continuity_probe');
  assert.ok(continuation);
  assert.equal(continuation.ready, false, 'a review alone must not look approved');
  assert.equal(continuation.status, 'review');
  assert.match(continuation.blockedReason, /tested recovery candidate/i);
  const suggestion = state.suggestions.find((entry) => entry.status === 'open');
  assert.ok(suggestion);
  assert.ok(suggestion.steps.some((step) => step.params?.text === 'What is a diamond?'));

  const draft = continuity.prepareSuggestedWorkflow(suggestion.id);
  assert.equal(draft.status, 'draft');
  assert.ok(draft.patternTags.includes('continuity'));
  assert.ok(d.workflows.some((entry) => entry.id === draft.id));
  const again = continuity.prepareSuggestedWorkflow(suggestion.id);
  assert.equal(again.id, draft.id);
  assert.equal(continuity.dismissSuggestion(suggestion.id).status, 'dismissed');
  store.flush();
});

test('continuation count and queue are deduplicated and stale entries are downgraded', async () => {
  const d = store.db();
  d.recoveryPacks = [
    ...(d.recoveryPacks || []).filter((pack) => pack.id !== 'rcp_dup_continuation'),
    { id: 'rcp_dup_continuation', candidates: [{ id: 'candidate_tested', test: { ok: true } }] },
    { id: 'rcp_retry_history', retryRunId: 'run_retry_history', candidates: [{ id: 'candidate_old', test: { ok: true } }] },
  ];
  d.runs.push(
    { id: 'run_dup_continuation', workflowId: 'wf_continuity_probe', status: 'failed', dryRun: true, recoveryPackId: 'rcp_dup_continuation' },
    { id: 'run_untested_continuation', workflowId: 'wf_continuity_probe', status: 'failed', dryRun: true },
    { id: 'run_retry_history', workflowId: 'wf_continuity_probe', status: 'failed', dryRun: true, recoveryPackId: 'rcp_retry_history' },
    { id: 'run_passed_continuation', workflowId: 'wf_continuity_probe', status: 'passed', dryRun: true }
  );
  const state = continuity.ensureContinuity();
  state.continuations = [
    { id: 'old-dup', runId: 'run_dup_continuation', status: 'ready', ready: true, at: '2026-01-01T00:00:00.000Z' },
    { id: 'new-dup', runId: 'run_dup_continuation', status: 'ready', ready: true, at: '2026-01-02T00:00:00.000Z' },
    { id: 'untested', runId: 'run_untested_continuation', status: 'ready', ready: true, at: '2026-01-02T12:00:00.000Z' },
    { id: 'retry-history', runId: 'run_retry_history', status: 'ready', ready: true, at: '2026-01-02T18:00:00.000Z' },
    { id: 'passed', runId: 'run_passed_continuation', status: 'ready', ready: true, at: '2026-01-03T00:00:00.000Z' },
    { id: 'missing', runId: 'run_missing_continuation', status: 'ready', ready: true, at: '2026-01-04T00:00:00.000Z' },
  ];
  const view = continuity.continuityState();
  const runIds = view.continuations.map((entry) => entry.runId);
  assert.equal(new Set(runIds).size, runIds.length);
  assert.equal(view.continuations.filter((entry) => entry.runId === 'run_dup_continuation').length, 1);
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_untested_continuation').ready, false);
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_untested_continuation').status, 'review');
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_retry_history').ready, false);
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_retry_history').status, 'review');
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_passed_continuation').ready, false);
  assert.equal(view.continuations.find((entry) => entry.runId === 'run_missing_continuation').ready, false);
  assert.equal(view.summary.readyContinuations, view.continuations.filter((entry) => entry.ready && entry.status === 'ready').length);
  const counts = continuity.continuityCounts(view);
  assert.equal(counts.continuityReady, view.summary.readyContinuations);
  assert.equal(counts.continuityReady, view.continuations.filter((entry) => entry.ready && entry.status === 'ready').length);
  store.flush();
});

test('advance is scoped to the active waitFor trigger, not an earlier passed trigger', () => {
  const workflow = {
    id: 'wf_trigger_scope',
    name: 'Trigger scope',
    steps: [
      { id: 'wait_notepad', type: 'waitFor', name: 'Wait for Notepad', params: { kind: 'window', value: 'Notepad' } },
      { id: 'wait_kiro', type: 'waitFor', name: 'Wait for Kiro', params: { kind: 'window', value: 'Kiro' } },
    ],
  };
  const run = { id: 'run_trigger_scope', workflowId: workflow.id, status: 'running', dryRun: true, steps: [] };
  const review = continuity.analyzeContinuity({
    run,
    workflow,
    windowState: { state: 'background', matches: [{ title: 'basic - Notepad', process: 'Notepad', state: 'background' }] },
  });
  assert.equal(review.triggers.find((entry) => entry.stepId === 'wait_notepad').ready, true);
  assert.equal(review.triggers.find((entry) => entry.stepId === 'wait_kiro').ready, false);

  assert.equal(
    continuity.continuationDecision({
      waiting: true,
      step: workflow.steps[1],
      triggers: review.triggers,
      frameMoved: true,
      windowState: { state: 'background' },
    }),
    'wait'
  );
  assert.equal(
    continuity.continuationDecision({
      waiting: true,
      step: workflow.steps[1],
      triggers: [{ stepId: 'wait_notepad', ready: true }, { stepId: 'wait_kiro', ready: true }],
      windowState: { state: 'background' },
    }),
    'advance'
  );
  assert.equal(
    continuity.continuationDecision({ waiting: true, step: { id: 'wait_blind', type: 'wait' }, frameMoved: true }),
    'advance'
  );
});

test('a static screen cannot hold a wait open: unknown readiness inspects and fixed waits expire', () => {
  const wait = { id: 'wait_2s', type: 'wait', name: 'Wait 2 s', params: { ms: 2000 } };
  assert.equal(continuity.continuationDecision({ waiting: true, step: wait, frameMoved: false, waitedMs: 500 }), 'wait');
  assert.equal(continuity.continuationDecision({ waiting: true, step: wait, frameMoved: false, waitedMs: 2100 }), 'advance');

  const waitFor = {
    id: 'wait_file',
    type: 'waitFor',
    name: 'Wait for report.pdf',
    params: { kind: 'file', value: 'report.pdf', timeoutMs: 4000 },
  };
  const unknown = [{ stepId: 'wait_file', kind: 'file', value: 'report.pdf', ready: null, timeoutMs: 4000 }];
  assert.equal(continuity.continuationDecision({ waiting: true, step: waitFor, triggers: unknown, frameMoved: false }), 'inspect');
  assert.equal(continuity.continuationDecision({ waiting: true, step: waitFor, triggers: unknown, frameMoved: true }), 'inspect');

  const notReady = [{ stepId: 'wait_file', kind: 'file', value: 'report.pdf', ready: false, timeoutMs: 4000 }];
  assert.equal(continuity.continuationDecision({ waiting: true, step: waitFor, triggers: notReady, frameMoved: false, waitedMs: 1000 }), 'wait');
  assert.equal(continuity.continuationDecision({ waiting: true, step: waitFor, triggers: notReady, frameMoved: false, waitedMs: 4500 }), 'inspect');
});

test('non-window waitFor and expect steps with unknown readiness surface as inspect even on a static screen', () => {
  const waitFor = { id: 'wait_file', type: 'waitFor', name: 'Wait for report.pdf' };
  const expect = { id: 'expect_clipboard', type: 'expect', name: 'Check the copied text' };
  const triggers = [
    { stepId: 'wait_file', kind: 'file', value: 'report.pdf', ready: null },
    { stepId: 'expect_clipboard', kind: 'clipboard', value: 'answer' },
  ];
  assert.equal(
    continuity.continuationDecision({ waiting: true, step: waitFor, triggers, frameMoved: false }),
    'inspect'
  );
  assert.equal(
    continuity.continuationDecision({ waiting: true, step: expect, triggers, frameMoved: false }),
    'inspect'
  );
  assert.equal(
    continuity.continuationDecision({ waiting: true, step: waitFor, triggers, frameMoved: true }),
    'inspect'
  );
});

test('the tick path reports unknown readiness and escapes a static wait on elapsed time', async () => {
  const d = store.db();
  d.settings = { ...(d.settings || {}), continuity: true, continuityVisionReadiness: false };
  const startedAt = new Date(Date.now() - 6000).toISOString();
  const step = {
    id: 'wait_tick_file',
    type: 'waitFor',
    name: 'Wait for report.pdf',
    params: { kind: 'file', value: 'report.pdf', timeoutMs: 1000 },
    startedAt,
  };
  const workflow = { id: 'wf_tick_wait', name: 'Tick wait', steps: [step] };
  // only one run may be waiting at a time, so clear the earlier fixtures
  d.runs = (d.runs || []).map((entry) =>
    ['running', 'queued'].includes(entry.status) ? { ...entry, status: 'passed' } : entry
  );
  d.workflows = [...(d.workflows || []), workflow];
  d.runs = [
    ...(d.runs || []).filter((entry) => entry.id !== 'run_tick_wait'),
    {
      id: 'run_tick_wait',
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'running',
      dryRun: true,
      currentStepId: step.id,
      createdAt: startedAt,
      steps: [{ id: step.id, name: step.name, type: 'waitFor', status: 'running', startedAt }],
    },
  ];
  const result = await continuity.tickContinuity({ capture: false });
  assert.equal(result.active.readiness, 'unknown');
  assert.ok(result.active.waitedMs >= 4000, `waitedMs was ${result.active.waitedMs}`);
  assert.equal(result.active.decision, 'inspect');
  store.flush();
});

test('a readiness verdict is keyed on the awaited params and survives new frames', () => {
  const base = {
    runId: 'run',
    step: { id: 's1', params: { kind: 'file', value: 'a.pdf' } },
    framePath: 'captures/x.png',
  };
  const edited = { ...base, step: { id: 's1', params: { kind: 'file', value: 'b.pdf' } } };
  assert.notEqual(continuity.readinessCacheKey(base), continuity.readinessCacheKey(edited));
  assert.equal(continuity.readinessCacheKey(base), continuity.readinessCacheKey({ ...base }));
  // a fresh capture must not restart the 30 s check
  assert.equal(
    continuity.readinessCacheKey(base),
    continuity.readinessCacheKey({ ...base, framePath: 'captures/later-frame.png' })
  );
});

test('a cached confident verdict advances the run on the next tick without blocking the first', async () => {
  const d = store.db();
  d.settings = { ...(d.settings || {}), continuity: true, continuityEnabled: true, continuityVisionReadiness: true };
  const framePath = path.join(store.DATA, 'captures', 'tick-model.png');
  fs.mkdirSync(path.dirname(framePath), { recursive: true });
  fs.writeFileSync(framePath, 'probe');
  const startedAt = new Date(Date.now() - 2000).toISOString();
  const step = {
    id: 'wait_model',
    type: 'waitFor',
    name: 'Wait for report.pdf',
    params: { kind: 'file', value: 'report.pdf', timeoutMs: 60000 },
    startedAt,
  };
  const workflow = { id: 'wf_tick_model', name: 'Tick model', steps: [step] };
  d.runs = (d.runs || []).map((entry) =>
    ['running', 'queued'].includes(entry.status) ? { ...entry, status: 'passed' } : entry
  );
  d.workflows = [...(d.workflows || []), workflow];
  d.runs = [
    ...(d.runs || []).filter((entry) => entry.id !== 'run_tick_model'),
    {
      id: 'run_tick_model',
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: 'running',
      dryRun: true,
      currentStepId: step.id,
      createdAt: startedAt,
      evidence: [{ kind: 'screenshot', path: 'captures/tick-model.png' }],
      steps: [{ id: step.id, name: step.name, type: 'waitFor', status: 'running', startedAt }],
    },
  ];
  const state = continuity.ensureContinuity();
  state.frame = { runId: 'run_tick_model', path: 'captures/tick-model.png' };
  const ask = async () => ({
    content: '{"ready":true,"evidence":"report.pdf is visible in the Save As title","confidence":0.9}',
  });
  const first = await continuity.tickContinuity({ capture: false, readinessAsk: ask });
  assert.equal(first.active.readiness, 'unknown');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = await continuity.tickContinuity({ capture: false, readinessAsk: ask });
  assert.equal(second.active.readiness, 'model_ready');
  assert.equal(second.active.decision, 'advance');
  assert.match(second.active.readinessNote, /report\.pdf/);
  fs.rmSync(framePath, { force: true });
  store.flush();
});

test('a model readiness verdict only advances on a confident true', async () => {
  assert.deepEqual(continuity.parseReadiness('{"ready":true,"evidence":"the Save As dialog is open","confidence":0.9}'), {
    ready: true,
    evidence: 'the Save As dialog is open',
    confidence: 0.9,
  });
  const unsure = await continuity.visionReadiness({
    step: { name: 'Wait for report.pdf', params: { kind: 'file', value: 'report.pdf' } },
    image: 'abc',
    ask: async () => ({ content: '{"ready":true,"evidence":"maybe","confidence":0.2}' }),
  });
  assert.equal(unsure.ready, null);
  const confirmed = await continuity.visionReadiness({
    step: { name: 'Wait for report.pdf', params: { kind: 'file', value: 'report.pdf' } },
    image: 'abc',
    ask: async () => ({ content: '{"ready":true,"evidence":"report.pdf is in the window title","confidence":0.8}' }),
  });
  assert.equal(confirmed.ready, true);
  assert.equal(
    continuity.continuationDecision({ waiting: true, step: { id: 'x', type: 'waitFor' }, triggers: [], knownReady: true }),
    'advance'
  );
});

test('evidence frames resolve under data/ and only waiting runs share a capture lease', () => {
  const framePath = path.join(store.DATA, 'captures', 'continuity-path-probe.png');
  fs.mkdirSync(path.dirname(framePath), { recursive: true });
  fs.writeFileSync(framePath, 'probe');
  assert.equal(continuity.resolveContinuityFramePath('captures/continuity-path-probe.png'), framePath);
  assert.equal(continuity.resolveContinuityFramePath('captures/continuity-path-missing.png'), null);

  const at = Date.parse('2026-01-01T00:00:10.000Z');
  const state = { lastCaptureAt: '2026-01-01T00:00:00.000Z', frame: null };
  const settings = { continuityFrameMs: 5000 };
  assert.equal(continuity.shouldCaptureFrame({ state, settings, waiting: true, at }), true);
  assert.equal(continuity.shouldCaptureFrame({ state, settings, waiting: false, at: at + 1000 }), false);
  state.lastCaptureAt = new Date(at).toISOString();
  assert.equal(continuity.shouldCaptureFrame({ state, settings, waiting: true, at: at + 1000 }), false);
  assert.equal(continuity.shouldCaptureFrame({ state, settings, waiting: true, at: at + 5000 }), true);
  fs.rmSync(framePath, { force: true });
});
