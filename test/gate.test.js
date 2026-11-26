import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL,
  adaptiveAdvice,
  backupPlan,
  bandOf,
  confidenceOf,
  gateDecision,
  gateSummary,
} from '../server/gate.js';

test('an approval rate is the share of cast ballots, not of every entry', () => {
  assert.equal(confidenceOf([]), null);
  assert.equal(confidenceOf([true, true, false, false]), 0.5);
  assert.equal(confidenceOf([{ ok: true }, { ok: false }]), 0.5);
  assert.equal(confidenceOf([true, true, true, true]), 1);
  // An abstention has no opinion and must not count against the move.
  assert.equal(confidenceOf([true, { ok: null }, null]), 1);
});

test('the bands are 90% to act, 50% to keep trying, and 49% to hold', () => {
  assert.equal(bandOf(0.9).band, 'act');
  assert.equal(bandOf(0.95).band, 'act');
  assert.equal(bandOf(0.89).band, 'replan');
  assert.equal(bandOf(0.5).band, 'replan');
  assert.equal(bandOf(0.49).band, 'hold');
  assert.equal(bandOf(0).band, 'hold');
  assert.equal(bandOf(null).band, 'unknown');
  assert.equal(APPROVAL.act, 0.9);
  assert.equal(APPROVAL.replan, 0.5);
});

test('four of five approvals is the act bar the operator described', () => {
  const quorum = bandOf(0.8, { approvals: 4, total: 5 });
  assert.equal(quorum.band, 'act');
  assert.equal(quorum.quorum, true);
  // Three of five is 60%: above the floor, well below the bar.
  const split = bandOf(0.6, { approvals: 3, total: 5 });
  assert.equal(split.band, 'replan');
  assert.equal(split.quorum, false);
  // A quorum of four needs five ballots to exist at all.
  assert.equal(bandOf(0.8, { approvals: 4, total: 4 }).band, 'replan');
});

test('each decision says why, in the same words the run log will use', () => {
  const act = gateDecision({ confidence: 0.93, label: 'Click “Dan”' });
  assert.equal(act.action, 'act');
  assert.match(act.reason, /93% approval clears the 90% bar/);
  assert.match(act.reason, /Click “Dan”/);

  const replan = gateDecision({ confidence: 0.67, label: 'Type the address' });
  assert.equal(replan.action, 'replan-then-act');
  assert.match(replan.reason, /above the 50% floor but below the 90% bar/);

  const hold = gateDecision({ confidence: 0.41, label: 'Press Enter' });
  assert.equal(hold.action, 'hold');
  assert.match(hold.reason, /at or below the 49% ceiling/);

  const unknown = gateDecision({});
  assert.equal(unknown.action, 'observe');
  assert.match(unknown.reason, /no approval reading/);
});

test('a hold takes a fresh look before it tries anything else', () => {
  const first = backupPlan({ band: 'hold' });
  assert.equal(first.decision, 're-read');
  assert.equal(first.steps[0].kind, 'fresh-look');

  const changed = backupPlan({ band: 'hold', freshLook: { changed: true, changedPct: 22 } });
  assert.equal(changed.decision, 're-read');
  assert.match(changed.steps[0].why, /22%/);
});

test('a backup method is only used while the fresh screenshot still supports it', () => {
  const usable = backupPlan({
    band: 'hold',
    freshLook: { changed: false, applicable: true },
    alternatives: [{ id: 'enter', name: 'Press Enter instead', ok: true }],
  });
  assert.equal(usable.decision, 'alt-method');
  assert.deepEqual(usable.steps.map((step) => step.kind), ['fresh-look', 'alt-method']);

  const gone = backupPlan({
    band: 'hold',
    freshLook: { changed: false, applicable: false },
    alternatives: [{ id: 'enter', name: 'Press Enter instead', ok: true }],
  });
  assert.equal(gone.decision, 'replan');
  assert.deepEqual(gone.steps.map((step) => step.kind), ['fresh-look', 'replan']);
});

test('with nothing left the run stops instead of acting on a weak reading', () => {
  const plan = backupPlan({ band: 'hold', freshLook: { changed: false, applicable: true }, alternatives: [], canReplan: false });
  assert.equal(plan.decision, 'abort');
  assert.equal(plan.steps.at(-1).kind, 'abort');
  assert.match(plan.steps.at(-1).why, /under 50%/);
});

test('a move that may act is not given a backup chain', () => {
  assert.equal(backupPlan({ band: 'act' }).decision, 'act');
  assert.equal(backupPlan({ band: 'replan' }).decision, 'replan-then-act');
  assert.equal(backupPlan({ band: 'unknown' }).decision, 'observe');
});

test('the summary counts what the ladder did', () => {
  const summary = gateSummary([
    { band: 'act', confidence: 0.95 },
    { band: 'act', confidence: 0.91 },
    { band: 'replan', confidence: 0.6 },
    { band: 'hold', confidence: 0.2 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.acted, 2);
  assert.equal(summary.replanned, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.actRate, 50);
  assert.equal(summary.recent.length, 4);
});

test('advice is proposed from evidence and never applied here', () => {
  const held = adaptiveAdvice({ decisions: [{ band: 'hold' }, { band: 'hold' }, { band: 'hold' }] });
  assert.equal(held.length, 1);
  assert.equal(held[0].setting, 'autoApplyMinConfidence');
  assert.match(held[0].why, /3 reading\(s\) were held/);

  const failing = adaptiveAdvice({
    decisions: [{ band: 'act' }, { band: 'act' }, { band: 'act' }, { band: 'act' }],
    outcomes: [
      { band: 'act', ok: false },
      { band: 'act', ok: false },
    ],
  });
  assert.equal(failing[0].value, 0.95);

  assert.deepEqual(adaptiveAdvice({ decisions: [{ band: 'act' }] }), []);
  assert.deepEqual(adaptiveAdvice({ decisions: [] }), []);
});
