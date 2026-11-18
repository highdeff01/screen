import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goalAsksForNewChat,
  planChatReuse,
  questionFromWorkflow,
  questionIsVisible,
} from '../server/deliberation.js';

const workflow = {
  steps: [
    { type: 'focusWindow', name: 'Focus Kiro', params: { title: 'Kiro' } },
    { type: 'clickElement', name: 'New chat', condition: 'newChat', params: { window: 'Kiro', name: 'New session' } },
    { type: 'clickElement', name: 'Click input', params: { window: 'Kiro', name: 'Ask a question' } },
    { type: 'key', name: 'Clear', params: { keys: ['^a'] } },
    { type: 'type', name: 'Ask', params: { text: 'what is a diamond' } },
    { type: 'key', name: 'Send', params: { keys: ['{ENTER}'] } },
    { type: 'wait', name: 'Wait', params: { ms: 1000 } },
    { type: 'clickElement', name: 'Copy', params: { name: 'Copy message' } },
  ],
};

test('finds the question after the new-chat step', () => {
  assert.deepEqual(questionFromWorkflow(workflow, 1), { index: 4, text: 'what is a diamond' });
});

test('matches the visible question exactly and by meaningful tokens', () => {
  assert.equal(questionIsVisible({ found: true, name: 'what is a diamond' }, 'what is a diamond'), true);
  assert.equal(questionIsVisible({ found: true, name: 'Close What Is a Diamond' }, 'what is a diamond'), true);
  assert.equal(questionIsVisible({ found: true, name: 'What Is A Diamond Close What Is A Diamond', controlType: 'ControlType.TabItem' }, 'what is a diamond'), false);
  assert.equal(questionIsVisible({ found: true, name: 'Close What is a ruby', controlType: 'ControlType.Button' }, 'what is a diamond'), false);
  assert.equal(questionIsVisible({ found: true, name: 'what is a ruby' }, 'what is a diamond'), false);
});

test('auto mode reuses a chat that already shows the question and skips duplicate input', () => {
  const plan = planChatReuse({
    workflow,
    newChatIndex: 1,
    questionPresent: true,
    newMode: null,
    explicitNew: false,
  });
  assert.equal(plan.skipNewChat, true);
  assert.deepEqual(plan.skipIndices, [3, 4, 5]);
  assert.match(plan.reason, /already shows/);
});

test('auto mode still opens a new chat when the question is absent', () => {
  const plan = planChatReuse({
    workflow,
    newChatIndex: 1,
    questionPresent: false,
    newMode: null,
    explicitNew: false,
  });
  assert.equal(plan.skipNewChat, false);
  assert.deepEqual(plan.skipIndices, []);
});

test('an explicit new-chat mission overrides visible-chat reuse', () => {
  const plan = planChatReuse({
    workflow,
    newChatIndex: 1,
    questionPresent: true,
    newMode: true,
    explicitNew: true,
  });
  assert.equal(plan.skipNewChat, false);
  assert.deepEqual(plan.skipIndices, []);
});

test('reuse mode skips new chat even when the question is absent but does not skip asking', () => {
  const plan = planChatReuse({
    workflow,
    newChatIndex: 1,
    questionPresent: false,
    newMode: false,
    conditionMet: false,
  });
  assert.equal(plan.skipNewChat, true);
  assert.deepEqual(plan.skipIndices, []);
});

test('goal wording is used to detect an explicit new-chat request', () => {
  assert.equal(goalAsksForNewChat('Start a new chat about a ruby'), true);
  assert.equal(goalAsksForNewChat('Ask Kiro about a diamond in the current chat'), false);
});
