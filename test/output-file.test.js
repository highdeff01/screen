import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-output-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const automation = await load('server/automation.js');
const planner = await load('server/planner.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function plannedSave(intent) {
  const [step] = planner.adaptTemplateSteps(
    [{ type: 'writeTextFile', name: 'Save answer', params: { path: 'kiro-answer.txt', textVar: 'answer' } }],
    intent
  );
  return { ...step, params: { ...step.params, location: 'data' } };
}

test('two planned saves create distinct timestamped files and never overwrite the first', async () => {
  const intent = planner.parseGoalIntent(
    'open kiro and ask what is a cats favorite thing to eat than save answer to notepad on desktop',
    { windows: [{ process: 'Kiro', title: 'Kiro' }, { process: 'Notepad', title: 'Notepad' }], apps: [], processes: [] }
  );
  assert.ok(intent?.question);

  const first = plannedSave(intent);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = plannedSave(intent);

  assert.match(first.params.path, /^cats-answer-\d{17}\.txt$/);
  assert.match(second.params.path, /^cats-answer-\d{17}\.txt$/);
  assert.notEqual(first.params.path, second.params.path);
  assert.equal(first.params.overwrite, false);
  assert.equal(second.params.overwrite, false);

  await automation.executeStep(first, {
    live: true,
    run: { id: 'run_first', variables: { answer: 'first answer' } },
    workflow: { id: 'wf_output' },
  });
  await automation.executeStep(second, {
    live: true,
    run: { id: 'run_second', variables: { answer: 'second answer' } },
    workflow: { id: 'wf_output' },
  });

  const folder = path.join(store.DATA, 'files');
  const firstPath = path.join(folder, first.params.path);
  const secondPath = path.join(folder, second.params.path);
  assert.equal(fs.readFileSync(firstPath, 'utf8').trim(), 'first answer');
  assert.equal(fs.readFileSync(secondPath, 'utf8').trim(), 'second answer');

  await assert.rejects(
    automation.executeStep(first, {
      live: true,
      run: { id: 'run_again', variables: { answer: 'overwritten' } },
      workflow: { id: 'wf_output' },
    }),
    /already exists/
  );
  assert.equal(fs.readFileSync(firstPath, 'utf8').trim(), 'first answer');
});