import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSignatures, signatureHash, shouldAuditVisual, visualChangeMatters } from '../server/visual.js';

test('identical screen signatures report no change', () => {
  const signature = { cells: ['000000', 'ffffff'] };
  const delta = diffSignatures(signature, { cells: ['000000', 'ffffff'] });
  assert.equal(delta.changedPct, 0);
  assert.equal(delta.identical, true);
});

test('a visible cell change is measured as a percentage', () => {
  const delta = diffSignatures({ cells: ['000000', 'ffffff'] }, { cells: ['1e0000', 'ffffff'] });
  assert.equal(delta.changedCells, 1);
  assert.equal(delta.changedPct, 50);
  assert.equal(delta.identical, false);
});

test('small noise below the channel threshold is ignored', () => {
  const delta = diffSignatures({ cells: ['646464'] }, { cells: ['6a6a6a'] });
  assert.equal(delta.changedCells, 0);
  assert.equal(delta.identical, true);
});

test('hashes are stable and change with the grid', () => {
  assert.equal(signatureHash({ cells: ['010203', 'aabbcc'] }), signatureHash({ cells: ['010203', 'aabbcc'] }));
  assert.notEqual(signatureHash({ cells: ['010203'] }), signatureHash({ cells: ['010204'] }));
});

test('copy and focus steps do not trigger false no-change warnings', () => {
  assert.equal(visualChangeMatters({ type: 'clickElement', name: 'Copy message' }), false);
  assert.equal(visualChangeMatters({ type: 'focusWindow', name: 'Focus Kiro' }), false);
  assert.equal(visualChangeMatters({ type: 'clickElement', name: 'Start a new Kiro chat' }), true);
  assert.equal(visualChangeMatters({ type: 'type', name: 'Ask the question' }), true);
});

test('screenshot and note steps are not re-audited with a second capture', () => {
  assert.equal(shouldAuditVisual({ type: 'screenshot' }), false);
  assert.equal(shouldAuditVisual({ type: 'note' }), false);
  assert.equal(shouldAuditVisual({ type: 'clickElement' }), true);
});
