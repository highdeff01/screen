import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-conditions-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const { stepConditionMet } = await import('../server/engine.js');

const mission = (goal, newChat = null) => {
  const d = store.db();
  d.missions = [{ id: 'msn_condition', goal, conditions: { newChat } }];
};

const condition = (missionId = 'msn_condition') => stepConditionMet({ condition: 'newChat' }, { missionId });

after(() => {
  store.flush();
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('auto starts a new chat when the old chat may be busy or off-topic', () => {
  mission('Ask Kiro about a ruby and save the answer.');
  assert.equal(condition(), true);
});

test('auto starts a new chat for an explicit new-topic goal', () => {
  mission('Start a new chat in Kiro about a ruby. This is a different topic.');
  assert.equal(condition(), true);
});

test('auto reuses only when the goal explicitly keeps the current chat', () => {
  mission('Ask Kiro about a diamond. Keep using the current Kiro chat.');
  assert.equal(condition(), false);
});

test('explicit mission modes override the goal text', () => {
  mission('Keep using the current chat.', true);
  assert.equal(condition(), true);
  mission('Start a new chat about a ruby.', false);
  assert.equal(condition(), false);
});

test('steps without the new-chat condition always run', () => {
  mission('Ask Kiro about a ruby.');
  assert.equal(stepConditionMet({ condition: null }, { missionId: 'msn_condition' }), true);
});
