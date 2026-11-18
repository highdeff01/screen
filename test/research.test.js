import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-research-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const research = await import('../server/research.js');
const proposals = await import('../server/proposals.js');

const workflow = {
  id: 'wf_research_kiro',
  name: 'Kiro answer capture',
  description: 'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
  steps: [
    { id: 's1', type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' }, appContext: { process: 'Kiro', version: '1.4.178' } },
    { id: 's2', type: 'type', name: 'Ask the question', params: { text: 'what is a cats favorite thing to eat', foreground: 'Kiro' } },
    { id: 's3', type: 'writeTextFile', name: 'Save answer', params: { location: 'desktop', path: 'cats-answer.txt', textVar: 'answer' } },
  ],
};

const failedRun = {
  id: 'run_research_failed',
  workflowId: workflow.id,
  workflowName: workflow.name,
  status: 'failed',
  dryRun: false,
  createdAt: '2026-11-16T07:00:00.000Z',
  endedAt: '2026-11-16T07:01:00.000Z',
  failureSignature: 'writeTextFile:Save text needs text or a textVar with content.',
  evidence: [
    {
      id: 'ev1',
      kind: 'screenshot',
      caption: 'Notepad before the save',
      path: 'captures/failed-save.png',
      width: 1000,
      height: 500,
      stepId: 's1',
    },
  ],
  steps: [
    { id: 's1', type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' }, status: 'passed', output: 'focused' },
    {
      id: 's2',
      type: 'writeTextFile',
      name: 'Save answer',
      params: { location: 'desktop', path: 'kiro-answer.txt' },
      status: 'failed',
      error: 'Save text needs text or a textVar with content.',
    },
  ],
};

const passedRun = {
  id: 'run_research_passed',
  workflowId: workflow.id,
  workflowName: workflow.name,
  status: 'passed',
  dryRun: false,
  createdAt: '2026-11-16T08:00:00.000Z',
  endedAt: '2026-11-16T08:01:00.000Z',
  evidence: [
    {
      id: 'ev2',
      kind: 'screenshot',
      caption: 'Answer copied',
      path: 'captures/passed-copy.png',
      width: 1000,
      height: 500,
      stepId: 's2',
    },
  ],
  steps: [
    { id: 's1', type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' }, status: 'passed', output: 'focused' },
    { id: 's2', type: 'type', name: 'Ask the question', params: { text: 'what is a cats favorite thing to eat', foreground: 'Kiro' }, status: 'passed', output: 'typed' },
  ],
};

after(() => {
  store.flush();
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('research cross-references conversation, failed attempts, screenshots and workflow history', () => {
  fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, 'data', 'conversation_history.txt'),
    JSON.stringify([
      { role: 'user', content: 'It repeated the write before Kiro answered.' },
      { role: 'assistant', content: 'I will put the copy before the write.' },
    ]),
    'utf8'
  );
  const d = store.db();
  d.workflows = [workflow, { id: 'wf_other', name: 'Other workflow', status: 'draft', steps: [] }];
  d.runs = [passedRun, failedRun];
  d.workflowMemory = [];
  d.captures = [];

  const pack = research.buildWorkflowResearch({ workflow, goal: workflow.description });
  assert.equal(pack.summary.failedAttempts >= 1, true);
  assert.equal(pack.summary.passedAttempts, 1);
  assert.equal(pack.summary.conversationMessages >= 2, true);
  assert.equal(pack.screenshots.some((shot) => shot.path === 'captures/failed-save.png'), true);
  assert.equal(pack.workflowHistory.some((entry) => entry.id === 'wf_other'), true);
  assert.match(pack.promptText, /FAILED \/ ABANDONED ATTEMPTS/);
  assert.match(pack.promptText, /PAST SCREENSHOTS/);
  assert.equal(pack.failedAttempts.some((item) => item.failureSignature.includes('writeTextFile')), true);
});

test('proposal diff separates added and removed steps', () => {
  const before = [
    { type: 'writeTextFile', name: 'Save answer', params: { textVar: 'answer' } },
    { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
  ];
  const after = [
    { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
    { type: 'launchApp', name: 'Open Notepad', params: { target: 'notepad.exe' } },
  ];
  const diff = proposals.diffSteps(before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].type, 'focusWindow');
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].type, 'writeTextFile');
  assert.equal(diff.unchanged, 1);
});
