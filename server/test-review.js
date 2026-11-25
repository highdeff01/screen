/**
 * One test review per run: breakdown, sorted tests, cross-reference, alternate
 * environment replication and immediate vs long-term application suggestions.
 *
 * The console already has the raw pieces — step statuses, screenshot verdicts,
 * workflow memory, the app catalogue. What it did not have is one place that
 * answers "how good is this test, what is new about this attempt, would it
 * survive another machine, and what should I do now versus later".
 *
 * Pure: the caller passes the run, its screenshot simulation (if any), the
 * workflow-memory episodes and a declared alternate environment.
 */

import { expectsScreenChange } from './step-effects.js';
import { goalPhases } from './strategy.js';
import { suggestGoalApps } from './goal-apps.js';
import { replicateRun } from './alt-env.js';
import { crossReference, phaseOf } from './cross-ref.js';

const CHECK_TYPES = new Set(['verifyScreen', 'verifyPlayback', 'mediaHold', 'expect', 'waitFor']);
const SORTS = ['risk', 'phase', 'status', 'seq', 'name'];
const PHASE_ORDER = ['search', 'download', 'install', 'launch', 'play', 'verify', 'capture', 'note', 'cleanup', 'act'];
const STATUS_RANK = { failed: 0, needs_review: 1, running: 2, pending: 3, queued: 3, skipped: 4, passed: 5 };

const clip = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/**
 * What the automatic screen review found for this run.
 *
 * A step whose own status says “passed” while the frame after it said something
 * else is the one finding a review must not leave in a run-card badge: it is
 * carried here step by step, with the frame to open, and it moves the verdict.
 */
function screenReviewFor(run) {
  const reviews = Array.isArray(run?.screenReviews) ? run.screenReviews : [];
  const mismatches = Array.isArray(run?.screenMismatches) ? run.screenMismatches : [];
  const frames = new Map(reviews.map((entry) => [entry.stepId, entry.path || '']));
  return {
    checked: reviews.filter((entry) => entry.status === 'pass').length,
    skipped: reviews.filter((entry) => entry.status === 'skipped').length,
    mismatches: mismatches.length,
    unresolved: Boolean(run?.screenReviewUnresolved),
    items: mismatches.slice(-6).map((entry) => ({
      stepId: entry.stepId || '',
      name: entry.stepName || entry.stepId || 'step',
      attempts: Number(entry.attempts) || 0,
      at: entry.at || '',
      mismatch: clip(entry.mismatch || entry.detail || 'the frame did not match the step', 220),
      frame: frames.get(entry.stepId) || '',
    })),
  };
}

function kindOf(step) {
  if (CHECK_TYPES.has(step?.type)) return 'check';
  if (step?.type === 'screenshot') return 'evidence';
  return 'action';
}

function simulationIndex(simulation) {
  const byStep = new Map();
  const bySeq = new Map();
  for (const entry of simulation?.breakdown || []) {
    if (entry.stepId) byStep.set(entry.stepId, entry);
    if (entry.seq) bySeq.set(Number(entry.seq), entry);
  }
  return (step, seq) => byStep.get(step?.id) || bySeq.get(seq) || null;
}

function riskOf(step, kind, evidence) {
  let risk = 0;
  const reasons = [];
  if (step?.status === 'failed') {
    risk += 90;
    reasons.push('failed');
  } else if (step?.status === 'needs_review') {
    risk += 62;
    reasons.push('needs review');
  } else if (step?.status === 'skipped') {
    risk -= 10;
  }
  const verdict = evidence?.verdict || '';
  if (verdict === 'mismatch' || verdict === 'failed_with_change') {
    risk = Math.max(risk, 84);
    reasons.push(verdict === 'mismatch' ? 'screen did not change as reported' : 'failed although the screen changed');
  } else if (verdict === 'unclear') {
    risk += 38;
    reasons.push('only a proxy frame');
  } else if (verdict === 'missing') {
    risk += 28;
    reasons.push('no screenshot covers it');
  } else if (verdict === 'confirmed') {
    risk -= 12;
  }
  if (expectsScreenChange(step) && kind === 'action') {
    risk += 12;
    reasons.push('changes the screen without a check of its own');
  }
  if (kind === 'check') risk -= 14;
  if (step?.optional) risk -= 18;
  if (!evidence && step?.status === 'passed' && kind === 'action') risk += 6;
  return { risk: Math.max(0, Math.min(100, Math.round(risk))), reasons: reasons.slice(0, 3) };
}

export function sortTests(tests = [], sort = 'risk') {
  const mode = SORTS.includes(sort) ? sort : 'risk';
  const list = [...tests];
  const compare = {
    risk: (a, b) => b.risk - a.risk || a.seq - b.seq,
    phase: (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase) || a.seq - b.seq,
    status: (a, b) => (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4) || b.risk - a.risk,
    seq: (a, b) => a.seq - b.seq,
    name: (a, b) => a.name.localeCompare(b.name) || a.seq - b.seq,
  }[mode];
  return list.sort(compare);
}

/**
 * Build the review for a run.
 *
 * @param {object} input
 * @param {object} input.run stored run
 * @param {object} [input.workflow] workflow record
 * @param {Array} [input.episodes] workflow-memory episodes
 * @param {object} [input.simulation] latest screenshot check for the run
 * @param {string} [input.sort] one of risk|phase|status|seq|name
 * @param {object} [input.env] alternate environment declaration
 * @param {string} [input.longTermGoal]
 * @param {Array} [input.installed]
 */
export function buildTestReview({
  run = null,
  workflow = null,
  episodes = [],
  simulation = null,
  sort = 'risk',
  env = {},
  longTermGoal = '',
  installed = [],
} = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const screen = screenReviewFor(run);
  const findEvidence = simulationIndex(simulation);
  const tests = steps.map((step, index) => {
    const seq = index + 1;
    const evidence = findEvidence(step, seq);
    const kind = kindOf(step);
    const scored = riskOf(step, kind, evidence);
    const screenStep = step.screenReview || null;
    // A frame that disagreed outranks any status the step reported itself.
    if (screenStep?.status === 'mismatch') {
      scored.risk = Math.max(scored.risk, 88);
      scored.reasons = ['screen check did not match', ...scored.reasons].slice(0, 3);
    }
    return {
      seq,
      stepId: step.id || '',
      name: step.name || step.type || `Step ${seq}`,
      type: step.type || '',
      status: step.status || 'pending',
      kind,
      phase: phaseOf(step),
      expectedChange: expectsScreenChange(step),
      evidence: evidence
        ? {
            verdict: evidence.verdict || '',
            changedPct: evidence.changedPct ?? null,
            frames: evidence.frames ?? null,
            note: clip(evidence.note || '', 160),
          }
        : null,
      screen: screenStep
        ? {
            status: screenStep.status || '',
            attempts: Number(screenStep.attempts) || 0,
            mismatch: clip(screenStep.mismatch || '', 200),
          }
        : null,
      risk: scored.risk,
      riskReasons: scored.reasons,
      note: evidence?.suggestion || (step.status === 'failed' ? clip(step.error || 'failed without an error message', 200) : ''),
    };
  });

  const ordered = sortTests(tests, sort);
  const objective = String(workflow?.description || workflow?.name || run?.workflowName || '').trim();
  // Only this workflow's history may claim to be "the steps that worked here";
  // memory from another workflow says nothing about this sequence.
  const scoped = (episodes || []).filter(
    (episode) => episode && (!run?.workflowId || !episode.workflowId || episode.workflowId === run.workflowId)
  );
  const cross = crossReference({ run, episodes: scoped, workflow, goal: objective });
  const apps = suggestGoalApps({
    goal: objective,
    steps: steps.length ? steps : workflow?.steps || [],
    episodes: scoped,
    installed,
    longTermGoal,
  });
  const alt = replicateRun({ run, env });

  const counts = {
    tests: tests.length,
    checks: tests.filter((test) => test.kind === 'check').length,
    actions: tests.filter((test) => test.kind === 'action').length,
    passed: tests.filter((test) => test.status === 'passed').length,
    failed: tests.filter((test) => test.status === 'failed').length,
    pending: tests.filter((test) => ['pending', 'running', 'queued'].includes(test.status)).length,
    skipped: tests.filter((test) => test.status === 'skipped').length,
  };
  const withEvidence = tests.filter((test) => test.evidence && test.evidence.verdict !== 'missing').length;
  const evidencePct = tests.length ? Math.round((withEvidence / tests.length) * 100) : 0;
  const highRisk = tests.filter((test) => test.risk >= 60);
  const phases = goalPhases(objective);
  const phaseRows = [...new Set([...phases.map((phase) => phase.key), ...tests.map((test) => test.phase)])]
    .sort((a, b) => PHASE_ORDER.indexOf(a) - PHASE_ORDER.indexOf(b))
    .map((key) => ({
      key,
      label: phases.find((phase) => phase.key === key)?.label || key,
      tests: tests.filter((test) => test.phase === key).length,
      highRisk: tests.filter((test) => test.phase === key && test.risk >= 60).length,
    }))
    .filter((row) => row.tests > 0);

  let verdict = 'ready';
  if (counts.failed > 0) verdict = 'blocked';
  // An unresolved screen mismatch blocks the review the same way a failed step
  // does: the tests all claim success and the evidence says otherwise.
  else if (screen.unresolved) verdict = 'blocked';
  else if (highRisk.length) verdict = 'needs_review';
  else if (!simulation) verdict = 'needs_evidence';
  else if (evidencePct < 50) verdict = 'needs_evidence';

  const reviewSummary = [];
  reviewSummary.push(
    `${counts.tests} test(s): ${counts.passed} passed, ${counts.failed} failed, ${counts.pending} pending; ${counts.checks} carry their own check.`
  );
  reviewSummary.push(
    simulation
      ? `Screenshot evidence covers ${evidencePct}% of steps (${simulation.summary?.verdict || simulation.status || 'unknown'}).`
      : 'No screenshot check has been run for this run, so pixel agreement is unknown.'
  );
  if (screen.mismatches) {
    reviewSummary.push(
      `Automatic screen check: ${screen.mismatches} mismatch(es)${screen.unresolved ? ' still unresolved — every step reported success, but the frame disagreed even on the re-read' : ' (resolved after the run)'}: ${screen.items
        .map((item) => item.name)
        .slice(0, 3)
        .join(', ')}.`
    );
  }
  if (highRisk.length) {
    reviewSummary.push(
      `${highRisk.length} test(s) need attention first: ${highRisk.slice(0, 3).map((test) => `${test.seq}. ${test.name}`).join(', ')}.`
    );
  }
  if (cross.verdict === 'regressed') reviewSummary.push('Compared with the last passing attempt, a proven step is missing — the run can pass without reaching the goal.');
  if (alt.summary.verdict === 'blocked') reviewSummary.push('The alternate environment blocks part of this test; it is not portable as written.');
  else if (alt.summary.verdict === 'needs_adaptation') reviewSummary.push('The test is mostly portable but needs adaptation before it is repeated elsewhere.');

  const now = [];
  const later = [];
  for (const item of screen.items.slice(0, 2)) {
    now.push(
      `Open the frame for “${item.name}”${item.frame ? ` (${item.frame})` : ''} and decide whether it really showed the result: ${item.mismatch}`
    );
  }
  for (const test of highRisk.slice(0, 3)) {
    now.push(`Fix or verify “${test.name}” (${test.risk}% risk${test.riskReasons.length ? `: ${test.riskReasons.join(', ')}` : ''}).`);
  }
  for (const entry of apps.immediate.slice(0, 2)) now.push(`${entry.name}: ${entry.next}`);
  for (const entry of apps.longTerm.slice(0, 2)) later.push(`${entry.name} is long-term: ${entry.next}`);
  for (const suggestion of alt.suggestions.slice(0, 2)) later.push(suggestion);
  if (cross.newDetails.length) {
    later.push(`Confirm the new detail before it becomes trusted history: ${clip(cross.newDetails[0].detail, 140)}.`);
  }
  if (!simulation) now.push('Run the screenshot check so each step has a verdict instead of only a status.');

  const integration = [
    `API: GET /api/runs/${run?.id || ':id'}/review?sort=${sort} returns this object; POST /api/runs/${run?.id || ':id'}/replicate replays it against a declared environment.`,
    'UI: the run detail card renders the sorted tests, the cross-reference line and both app horizons; the planner prompt can take `apps.brief` and `crossRef.summary` as text.',
    'History: the review is derived from stored records only — no desktop input, no model call — so it can run while the desktop is busy.',
  ];

  return {
    runId: run?.id || null,
    workflowId: run?.workflowId || null,
    workflowName: run?.workflowName || workflow?.name || '',
    goal: objective,
    mode: run?.dryRun ? 'simulated' : 'live',
    sort: SORTS.includes(sort) ? sort : 'risk',
    verdict,
    counts,
    evidence: {
      source: simulation ? `screenshot check ${simulation.id || ''}`.trim() : 'none',
      simulationId: simulation?.id || null,
      simulationStatus: simulation?.status || null,
      coveragePct: evidencePct,
      confirmed: simulation?.summary?.confirmed ?? 0,
      mismatch: simulation?.summary?.mismatch ?? 0,
      missing: simulation?.summary?.missing ?? 0,
    },
    screenReview: screen,
    phases: phaseRows,
    tests: ordered,
    highRisk: highRisk.map((test) => ({ seq: test.seq, name: test.name, risk: test.risk, riskReasons: test.riskReasons })),
    crossRef: cross,
    altEnv: alt,
    apps,
    review: { verdict, summary: reviewSummary.slice(0, 5) },
    suggestions: { now: [...new Set(now)].slice(0, 5), later: [...new Set(later)].slice(0, 5) },
    integration,
  };
}

export { SORTS };
