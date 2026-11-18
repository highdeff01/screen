import test from 'node:test';
import assert from 'node:assert/strict';

const { autoMarksForAudit, evaluateFlow, mergeVisualFindings } = await import('../server/presentation-audit.js');

const steps = [
  { id: 's1', type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
  { id: 's2', type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } },
  { id: 's3', type: 'type', name: 'Type the answer', params: { text: 'Cross-checked answer' } },
  { id: 's4', type: 'key', name: 'Save the file', params: { keys: 'ctrl+s', foreground: 'Notepad' } },
  { id: 's5', type: 'clickElement', name: 'Save the file', params: { name: 'Save' } },
  { id: 's6', type: 'waitFor', name: 'Wait for saved state', params: { value: 'Saved' } },
  { id: 's7', type: 'screenshot', name: 'Capture the saved result', params: { caption: 'Saved result' } },
];

const workflow = {
  id: 'wf_test',
  name: 'Save an answer',
  description: 'Open Notepad, save the answer and prove the saved state.',
  steps,
};

const marks = [
  { number: 1, label: 'Notepad', x: 12, y: 14 },
  { number: 2, label: 'Editable text field', x: 30, y: 32 },
  { number: 3, label: 'Keyboard target ctrl+s', x: 52, y: 18 },
  { number: 4, label: 'Save', x: 64, y: 18 },
  { number: 5, label: 'Saved', x: 48, y: 45 },
  { number: 6, label: 'Visible result for evidence', x: 30, y: 55 },
];

function passedRun(overrides = {}) {
  return {
    id: 'run_test',
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'passed',
    dryRun: true,
    createdAt: '2026-11-16T09:00:00.000Z',
    endedAt: '2026-11-16T09:00:10.000Z',
    position: { stepId: 's7', index: 6 },
    steps: steps.map((step) => ({ ...step, status: 'passed' })),
    evidence: [
      {
        id: 'evd_test',
        kind: 'screenshot',
        path: 'captures/saved.png',
        caption: 'Saved result',
        createdAt: '2026-11-16T09:00:09.000Z',
        stepId: 's7',
        width: 1280,
        height: 720,
        marks,
      },
    ],
    ...overrides,
  };
}

test('flow audit observes expected elements and exposes the next step', () => {
  const audit = evaluateFlow({
    workflow,
    runs: [passedRun()],
    agents: [{ id: 'agent_watchdog', name: 'Failure watchdog', role: 'sub-agent', enabled: true, status: 'idle', log: [] }],
    memories: [{ runId: 'run_old', workflowName: 'Save a note', status: 'passed', passed: 6, total: 6, hindrances: [] }],
    nowMs: Date.parse('2026-11-16T10:00:00.000Z'),
  });
  assert.equal(audit.verdict, 'ready');
  assert.equal(audit.current.screenshot.path, 'captures/saved.png');
  assert.equal(audit.elements.filter((element) => element.status === 'observed').length, steps.length);
  assert.equal(audit.current.next, null);
  assert.equal(audit.patterns.length, 1);
  assert.equal(audit.agents[0].enabled, true);
});

test('a failed run blocks the flow and explains what failed', () => {
  const run = passedRun({ status: 'failed' });
  run.steps = steps.map((step, index) =>
    index === 2 ? { ...step, status: 'failed', error: 'Text field not found' } : { ...step, status: index < 2 ? 'passed' : 'skipped' }
  );
  const audit = evaluateFlow({ workflow, runs: [run] });
  assert.equal(audit.verdict, 'blocked');
  assert.equal(audit.blockers.some((blocker) => blocker.code === 'last-run-failed'), true);
  assert.match(audit.reasons.join(' '), /Text field not found/);
});

test('missing screenshot is a blocker rather than an invented observation', () => {
  const run = passedRun({ evidence: [] });
  const audit = evaluateFlow({ workflow, runs: [run] });
  assert.equal(audit.verdict, 'blocked');
  assert.equal(audit.elements.every((element) => element.status === 'missing'), true);
  assert.equal(audit.blockers.some((blocker) => blocker.code === 'missing-element'), true);
  assert.equal(audit.visual.available, false);
});

test('visual findings can confirm an element and remove its unverified status', () => {
  const run = passedRun({ evidence: [] });
  const audit = evaluateFlow({ workflow, runs: [run] });
  const visual = {
    model: 'vision-test',
    summary: 'The Notepad window is visible with the typed answer.',
    elements: steps.map((_, index) => ({
      index,
      status: 'present',
      detail: `Visible target ${index + 1}`,
      confidence: 0.9,
    })),
  };
  const merged = mergeVisualFindings(audit, visual);
  assert.equal(merged.visual.available, true);
  assert.equal(merged.elements.every((element) => element.status === 'present'), true);
  assert.equal(merged.blockers.some((blocker) => blocker.code === 'missing-element'), false);
  assert.equal(merged.verdict, 'ready');
});

test('present visual findings with coordinates become auto-drawn marks', () => {
  const marks = autoMarksForAudit({
    elements: [
      { expected: 'Save', status: 'present', x: 64, y: 18 },
      { expected: 'Notepad', status: 'present', x: 12, y: 14 },
      { expected: 'Missing', status: 'missing', x: 20, y: 20 },
    ],
  });
  assert.equal(marks.length, 2);
  assert.equal(marks[0].label, 'Save');
  assert.equal(marks[0].auto, true);
});

test('a visual missing finding becomes a blocker with an explanation', () => {
  const audit = evaluateFlow({ workflow, runs: [passedRun()] });
  const merged = mergeVisualFindings(audit, {
    summary: 'The Save control is not visible.',
    elements: [{ index: 4, status: 'missing', detail: 'No Save control is visible in the capture.', confidence: 0.88 }],
  });
  assert.equal(merged.verdict, 'blocked');
  assert.equal(merged.blockers.some((blocker) => blocker.code === 'visual-missing-element'), true);
  assert.match(merged.blockers.find((blocker) => blocker.code === 'visual-missing-element').detail, /No Save control/);
});
