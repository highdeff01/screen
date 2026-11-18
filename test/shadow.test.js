import test from 'node:test';
import assert from 'node:assert/strict';

const { shadowTestPlan } = await import('../server/shadow-test.js');

test('shadow test accepts a produced answer before it is written', () => {
  const result = shadowTestPlan({
    steps: [
      { type: 'clipboard', name: 'Read answer', params: { action: 'read', outputVar: 'answer' } },
      { type: 'writeTextFile', name: 'Save answer', params: { path: 'answer.txt', textVar: 'answer' } },
      { type: 'launchApp', name: 'Open answer', params: { target: 'answer.txt' } },
      { type: 'waitFor', name: 'Wait for answer', params: { kind: 'window', value: 'answer.txt' } },
    ],
    preflight: [{ check: 'copy-before-write', ok: true }],
    confidence: 0.91,
    screenshots: [{ path: 'captures/ok.png' }],
    backups: [{ phase: 'file.write' }],
    lint: { issues: [] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
  assert.equal(result.noDesktopInput, true);
  assert.equal(result.checks.find((check) => check.key === 'parameters').ok, true);
});

test('shadow test rejects an early write and exposes the failing step', () => {
  const result = shadowTestPlan({
    steps: [{ type: 'writeTextFile', name: 'Save too early', params: { path: 'answer.txt', textVar: 'answer' } }],
    confidence: 0.9,
    preflight: [{ check: 'copy-before-write', ok: false }],
    screenshots: [{ path: 'captures/ok.png' }],
    backups: [{ phase: 'file.write' }],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0].reason, /before it is produced/);
  assert.equal(result.checks.find((check) => check.key === 'preflight').ok, false);
});

test('missing evidence is a warning, not a plan failure', () => {
  const result = shadowTestPlan({
    steps: [{ type: 'launchApp', name: 'Open app', params: { target: 'notepad.exe' } }],
    confidence: 0.8,
    preflight: [],
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.some((warning) => /Screenshot/.test(warning)), true);
});