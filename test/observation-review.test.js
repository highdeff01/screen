import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservationProfile, prepareObservationReview } from '../server/observation-review.js';
import { analyzeRun, simulationSummary } from '../server/screenshot-sim.js';

const codes = (list) => list.map((entry) => entry.code);

test('empty input makes gaps explicit without asserting success', () => {
  const profile = buildObservationProfile();
  assert.deepEqual(profile.observations, { monitor: [], steps: [] });
  assert.deepEqual(codes(profile.missingEvidence), ['monitor_events', 'simulation']);
  assert.ok(codes(profile.uncertainty).includes('semantic_content'));
  assert.ok(codes(profile.proposedNextSteps).includes('collect_step_evidence'));
  assert.equal(prepareObservationReview().proposalReview, null);
});

test('preserves provenance and distinguishes pixel evidence from semantics', () => {
  const monitor = { running: true, lastEventAt: '2026-01-01', events: [
    { at: '2026-01-01', title: 'Save As', process: 'notepad', capture: null, suggestions: [{ type: 'click', params: { x: 1 } }] },
  ] };
  const simulation = { id: 'sim-1', runId: 'run-1', workflowId: 'wf-1', status: 'completed', method: 'screenshots', mode: 'live', breakdown: [
    { seq: 1, stepId: 's1', name: 'Save', type: 'key', status: 'passed', expectedChange: true, verdict: 'confirmed', source: 'evidence', proxy: false, changedPct: 25, before: 'before.png', after: 'after.png', suggestion: 'Execute something' },
    { seq: 2, stepId: 's2', status: 'failed', verdict: 'failed_with_change', source: 'nearest', proxy: true, changedPct: 3, after: 'later.png' },
    { seq: 3, verdict: 'missing_baseline' }, { seq: 4, verdict: 'unreadable', frame: 'bad.png' },
  ] };
  const before = structuredClone({ monitor, simulation });
  const profile = buildObservationProfile({ monitor, simulation });
  assert.deepEqual({ monitor, simulation }, before);
  assert.equal(profile.provenance.simulation.runId, 'run-1');
  assert.equal(profile.observations.steps[0].verdict, 'confirmed');
  assert.equal(profile.observations.steps[0].changedPct, 25);
  assert.equal(profile.observations.steps[3].after, 'bad.png');
  assert.ok(codes(profile.missingEvidence).includes('missing_baseline'));
  assert.ok(codes(profile.missingEvidence).includes('unreadable'));
  assert.ok(codes(profile.uncertainty).includes('proxy_frame'));
  assert.ok(codes(profile.uncertainty).includes('not_correlated'));
  assert.ok(codes(profile.proposedNextSteps).includes('inspect_disagreement'));
  assert.ok(!JSON.stringify(profile).includes('Execute something'));
  assert.ok(!JSON.stringify(profile).includes('"type":"click"'));
});

test('handles actual simulated analyzeRun and shortened simulationSummary output', () => {
  const result = analyzeRun({ id: 'r', workflowId: 'w', dryRun: true, steps: [
    { id: 's', name: 'Open', type: 'openUrl', status: 'passed' },
  ] });
  const profile = buildObservationProfile({ simulation: result });
  assert.equal(profile.observations.steps[0].verdict, 'simulated');
  assert.ok(codes(profile.missingEvidence).includes('simulated'));
  const summary = simulationSummary({ ...result, status: 'completed' });
  const summarized = buildObservationProfile({ simulation: summary });
  assert.equal(summarized.observations.steps[0].stepId, null);
  assert.equal(summarized.observations.steps[0].frameSource, null);
});

test('pending simulations, malformed fields and unknown verdicts remain uncertain', () => {
  const pending = buildObservationProfile({ simulation: { status: 'running', breakdown: [{ verdict: 'confirmed' }] } });
  assert.equal(pending.observations.steps.length, 0);
  assert.ok(codes(pending.missingEvidence).includes('simulation_incomplete'));
  const profile = buildObservationProfile({ monitor: { events: [null, 7, { title: { nested: true } }] }, simulation: { breakdown: [null, { verdict: 'great', changedPct: Infinity, source: 'nearest' }] } });
  assert.equal(profile.observations.monitor[0].title, null);
  assert.equal(profile.observations.steps[0].verdict, 'unknown');
  assert.equal(profile.observations.steps[0].changedPct, null);
  assert.equal(profile.observations.steps[0].proxy, true);
  assert.ok(codes(profile.uncertainty).includes('unknown_verdict'));
});

test('bounded arrays and strings disclose truncation', () => {
  const profile = buildObservationProfile({
    monitor: { events: Array.from({ length: 30 }, () => ({ title: 'x'.repeat(10000) })) },
    simulation: { breakdown: Array.from({ length: 70 }, () => ({ verdict: 'missing', name: 'y'.repeat(10000) })) },
  });
  assert.equal(profile.observations.monitor.length, 20);
  assert.equal(profile.observations.steps.length, 50);
  assert.equal(profile.observations.monitor[0].title.length, 200);
  assert.equal(profile.observations.steps[0].name.length, 200);
  assert.deepEqual(profile.truncation, { monitorEventsOmitted: 10, simulationStepsOmitted: 20 });
  assert.ok(codes(profile.uncertainty).includes('truncated'));
});

test('proposal review uses static shadow checks without mutations or execution', () => {
  const proposal = { id: 'p', steps: [{ type: 'openUrl', name: 'Open', params: {} }], preflight: [], confidence: 0.9, lint: { issues: [] }, research: { screenshots: ['a.png'] } };
  const before = structuredClone(proposal);
  const result = prepareObservationReview({ proposal });
  assert.deepEqual(proposal, before);
  assert.equal(result.proposalReview.kind, 'bounded-static-shadow-test');
  assert.equal(result.proposalReview.staticTest.noDesktopInput, true);
  assert.equal(result.proposalReview.staticTest.ok, false);
  assert.match(result.proposalReview.staticTest.failures[0].reason, /missing url/);
  assert.equal(result.proposalReview.proposalId, 'p');
});

test('proposal truncation is explicit and check does not inspect omitted steps', () => {
  const proposal = { steps: [...Array.from({ length: 50 }, () => ({ type: 'screenshot' })), { type: 'openUrl' }], preflight: Array.from({ length: 51 }, () => ({ ok: true })), lint: { issues: Array.from({ length: 51 }, () => ({ severity: 'warning' })) } };
  const { proposalReview } = prepareObservationReview({ proposal });
  assert.deepEqual(proposalReview.truncation, { stepsOmitted: 1, preflightOmitted: 1, lintIssuesOmitted: 1 });
  assert.equal(proposalReview.staticTest.ok, true);
  assert.match(proposalReview.limitations, /truncated/);
});
