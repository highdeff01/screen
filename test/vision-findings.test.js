/**
 * What the reviewer found, as prompt text.
 *
 * The helpers are pure: a fixture reading stands in for the reviewer and the
 * engine's tracked elements, so these tests never load the vision engine (which
 * clears its frame directory when it loads) and never wait for a frame.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDINGS_MAX_AGE_MS,
  currentFindings,
  findingsBrief,
  reviewerFindings,
  setFindingsSource,
} from '../server/vision-findings.js';

function reading(extra = {}) {
  return {
    seq: 7,
    at: new Date(10_000).toISOString(),
    summary: 'An Export dialog is open with a Save button.',
    next: 'click Save',
    labels: ['Save', 'Cancel'],
    tracked: true,
    ms: 120,
    ...extra,
  };
}

const elements = [
  { label: 'Save', x: 0.7, y: 0.1, w: 0.1, h: 0.04, seen: 3 },
  { label: 'Cancel', x: 0.82, y: 0.1, w: 0.1, h: 0.04, seen: 1 },
];

test('tracked elements become labels with the centre a step can click', () => {
  const findings = reviewerFindings({ review: reading(), elements, nowMs: 12_000 });
  assert.equal(findings.seq, 7);
  assert.equal(findings.ageMs, 2000);
  assert.equal(findings.summary, 'An Export dialog is open with a Save button.');
  assert.equal(findings.next, 'click Save');
  assert.deepEqual(findings.labels.map((label) => label.text), ['Save', 'Cancel']);
  assert.deepEqual(findings.labels[0].at, { x: 0.75, y: 0.12 });
  assert.equal(findings.labels[0].seen, 3);
});

test('labels are de-duplicated, capped and read from the engine, not the echo', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ label: `Control ${index}`, x: 0, y: 0, w: 0.1, h: 0.1 }));
  const findings = reviewerFindings({
    review: reading(),
    elements: [...many, { label: 'Control 0', x: 0.9, y: 0.9, w: 0.1, h: 0.1, seen: 5 }],
    nowMs: 12_000,
  });
  assert.equal(findings.labels.length, 12, 'a prompt gets a bounded list');
  assert.equal(findings.labels.filter((label) => label.text === 'Control 0').length, 1, 'the same label is one control');
  assert.equal(findings.labels[0].seen, 1, 'the first occurrence is the one kept');

  // No tracked elements yet: the reading's own label names are still worth
  // quoting, they simply carry no place.
  const summaryOnly = reviewerFindings({ review: reading(), elements: [], nowMs: 12_000 });
  assert.deepEqual(summaryOnly.labels, []);
  assert.equal(summaryOnly.summary, 'An Export dialog is open with a Save button.');
});

test('a reading nothing has happened for is dropped, and an empty one is nothing', () => {
  assert.equal(reviewerFindings({ review: null, elements: [] }), null);
  assert.equal(reviewerFindings({ review: reading({ summary: '' }), elements: [] }), null, 'no summary and no labels is not a reading');

  const old = reviewerFindings({ review: reading(), elements, nowMs: 10_000 + FINDINGS_MAX_AGE_MS + 1 });
  assert.equal(old, null, 'a reading older than the window describes a screen the run has left');

  const edge = reviewerFindings({ review: reading(), elements, nowMs: 10_000 + FINDINGS_MAX_AGE_MS });
  assert.ok(edge, 'exactly at the window is still usable');
  assert.equal(edge.ageMs, FINDINGS_MAX_AGE_MS);

  // A reading with no timestamp cannot be aged, so it is not silently dropped.
  const undated = reviewerFindings({ review: reading({ at: null }), elements });
  assert.equal(undated.ageMs, null);
  assert.equal(undated.labels.length, 2);
});

test('the brief says which frame, how old, what was seen and what the reviewer suggested', () => {
  const findings = reviewerFindings({ review: reading(), elements, nowMs: 14_000 });
  const brief = findingsBrief(findings, { lead: 'Controls the vision reviewer already found' });
  assert.match(brief, /Controls the vision reviewer already found \(frame #7, read 4 s ago\)/);
  assert.match(brief, /“Save” at \(0\.75,0\.12\) seen 3×/);
  assert.match(brief, /“Cancel” at \(0\.87,0\.12\) seen 1×/);
  assert.match(brief, /It read the screen as: An Export dialog is open with a Save button\./);
  assert.match(brief, /Its suggested next action: click Save/);

  assert.equal(findingsBrief(null), '', 'no reading is no section');
  const empty = findingsBrief(reviewerFindings({ review: reading({ summary: '' }), elements: [{ label: '', x: 0, y: 0 }] }));
  assert.equal(empty, '');
});

test('a fresh reading with no labels still says what it saw, without inventing a control', () => {
  const brief = findingsBrief(reviewerFindings({ review: reading(), elements: [], nowMs: 10_500 }));
  assert.match(brief, /has not pinned a control yet/);
  assert.match(brief, /read the screen as: An Export dialog is open/);
  assert.doesNotMatch(brief, / at \(/, 'no label means no coordinate is offered');
});

test('the live reading is asked for through a registered source, never imported', () => {
  setFindingsSource(null);
  assert.equal(currentFindings(), null, 'nothing registered is no reading');

  setFindingsSource((options) => reviewerFindings({ review: reading(), elements, ...options }));
  assert.equal(currentFindings({ nowMs: 11_000 }).labels.length, 2);
  assert.equal(currentFindings({ nowMs: 11_000 + FINDINGS_MAX_AGE_MS + 1000 }), null, 'the source is given the caller’s clock');

  setFindingsSource(() => {
    throw new Error('the reviewer is not running');
  });
  assert.equal(currentFindings(), null, 'a broken reviewer is an absent reading, not a failed run');

  setFindingsSource(null);
});
