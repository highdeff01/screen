import test from 'node:test';
import assert from 'node:assert/strict';

const { buildVector, buildSemanticVector, classifyDeck, cosine, deckQuality, lineageOf, presentationGraph, presentationSummary, searchPresentations } = await import('../server/presentation-index.js');
const { proposalImplementation } = await import('../server/presentation-watch.js');

const deck = {
  id: 'deck_test',
  workflowId: 'wf_test',
  workflowName: 'Save an answer',
  missionId: 'msn_test',
  focus: 'problem',
  title: 'Why the save flow is blocked',
  subtitle: 'Missing Save control',
  theme: 'amber',
  model: 'test',
  createdAt: '2026-11-16T09:00:00.000Z',
  durationSeconds: 20,
  slides: [{ kicker: 'Audit', title: 'Blocked', bullets: ['Save is missing'], note: 'Capture', image: null }],
  audit: {
    verdict: 'blocked',
    confidence: 42,
    summary: 'Save control is missing.',
    blockers: [{ label: 'Missing Save', detail: 'Not visible' }],
    warnings: [],
    suggestions: [{ title: 'Wait for Save', detail: 'Add a wait', priority: 'high' }],
    patterns: [],
    agents: [],
    elements: [{ stepName: 'Save', expected: 'Save', status: 'missing' }],
    visual: { available: true, summary: 'Save not found' },
  },
  rechecks: [{ id: 'rch_test', at: '2026-11-16T10:00:00.000Z', comparison: { summary: 'still blocked' } }],
  review: { status: 'needs_review', comment: '', at: null },
  control: { paused: true, reason: 'Too many failures' },
  attempts: { consecutive: 3, total: 4, maxFailedAttempts: 3 },
};

test('deck vectors are stable and similar text sorts closer', () => {
  const a = buildVector('save answer notepad desktop');
  const b = buildVector('save answer notepad desktop');
  const c = buildVector('play a video on youtube');
  assert.deepEqual(a, b);
  assert.ok(cosine(a, b) > cosine(a, c));
});

test('deck classification reflects blockers, visual evidence and retries', () => {
  const classes = classifyDeck(deck);
  assert.ok(classes.includes('troubleshooting'));
  assert.ok(classes.includes('visual-verification'));
  assert.ok(classes.includes('blocked'));
  assert.ok(classes.includes('retested'));
});

test('compact summaries omit the audit and recheck payloads', () => {
  const summary = presentationSummary(deck);
  assert.equal(summary.auditLoaded, false);
  assert.equal(summary.audit, undefined);
  assert.equal(summary.rechecks, undefined);
  assert.equal(summary.slides.length, 1);
  assert.equal(summary.auditSummary.verdict, 'blocked');
  assert.equal(summary.attempts.consecutive, 3);
  assert.ok(summary.profile.vector.length > 0);
});

test('local semantic vectors connect repair language without a model', () => {
  const repair = buildSemanticVector('fix the blocked save failure');
  const diagnose = buildSemanticVector('troubleshoot a broken save blocker');
  const unrelated = buildSemanticVector('play a music video on youtube');
  assert.ok(cosine(repair, diagnose) > cosine(repair, unrelated));
  assert.equal(buildSemanticVector('same words').length, 64);
});

test('deck quality scores evidence, verdict, freshness and re-tests', () => {
  const quality = deckQuality(deck);
  assert.ok(quality.score >= 0 && quality.score <= 100);
  assert.ok(['A', 'B', 'C', 'D'].includes(quality.grade));
  assert.equal(quality.factors.evidence, 0);
  assert.ok(quality.reasons.some((reason) => reason.includes('blocked')));
});

test('zero-confidence visual findings do not collapse the quality score', () => {
  const visualZero = {
    ...deck,
    audit: {
      ...deck.audit,
      visual: {
        available: true,
        findings: [
          { index: 0, status: 'present', confidence: 0 },
          { index: 1, status: 'unclear', confidence: 0 },
        ],
      },
    },
  };
  const quality = deckQuality(visualZero);
  assert.equal(quality.factors.visual, 60);
  assert.ok(Number.isFinite(quality.score));
  assert.ok(quality.score > 0);
});

test('visual confidence is normalized whether the model reports 0-1 or 0-100', () => {
  const normalized = {
    ...deck,
    audit: {
      ...deck.audit,
      visual: { available: true, findings: [{ confidence: 1 }, { confidence: 0.5 }] },
    },
  };
  assert.equal(deckQuality(normalized).factors.visual, 75);
  const percentage = {
    ...deck,
    audit: {
      ...deck.audit,
      visual: { available: true, findings: [{ confidence: 80 }, { confidence: 60 }] },
    },
  };
  assert.equal(deckQuality(percentage).factors.visual, 70);
});

test('lineage and graph expose roots, parents and proposal nodes', () => {
  const child = { ...deck, id: 'deck_child', lineage: { rootDeckId: 'deck_test', parentDeckId: 'deck_test', depth: 1, events: [] } };
  assert.equal(lineageOf(child).parentDeckId, 'deck_test');
  assert.equal(lineageOf(child).rootDeckId, 'deck_test');
  const graph = presentationGraph({ workflowId: 'missing-workflow' });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
});

test('search returns compact summaries with similarity scores', () => {
  const results = searchPresentations({ query: 'save answer notepad', limit: 4 });
  assert.ok(Array.isArray(results));
  for (const item of results) {
    assert.equal(item.auditLoaded, false);
    assert.equal(item.audit, undefined);
    assert.equal(typeof item.similarity, 'number');
  }
});

test('the deck watcher verifies whether an approved proposal was implemented', () => {
  const workflow = { steps: [{ type: 'launchApp', name: 'Open', params: { target: 'app.exe' } }] };
  const pending = { status: 'pending', steps: [{ type: 'launchApp', name: 'Open', params: { target: 'app.exe' } }] };
  assert.equal(proposalImplementation(pending, workflow).implemented, null);
  const approved = { status: 'approved', steps: [...workflow.steps, { type: 'wait', name: 'Wait', params: { ms: 500 } }] };
  const missing = proposalImplementation(approved, workflow);
  assert.equal(missing.implemented, false);
  assert.equal(missing.missingSteps[0].name, 'Wait');
  const applied = proposalImplementation(approved, { steps: approved.steps });
  assert.equal(applied.implemented, true);
});
