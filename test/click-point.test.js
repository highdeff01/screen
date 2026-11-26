import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-click-point-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('where a control was clicked is remembered on the workflow, by step', () => {
  const workflow = { id: 'wf_points', steps: [] };
  const step = {
    id: 'stp_email',
    type: 'clickElement',
    name: 'Click the Email field',
    params: { name: 'Email' },
    output: 'Clicked “Email” via vision (found the field) at 512,480. Nearby: Username.',
  };
  engine.rememberClickPoint(workflow, step);
  assert.deepEqual({ x: workflow.clickPoints.stp_email.x, y: workflow.clickPoints.stp_email.y }, { x: 512, y: 480 });
  assert.equal(workflow.clickPoints.stp_email.name, 'Email');
});

test('a step that is not a click, or that reports no point, teaches nothing', () => {
  const workflow = { id: 'wf_points_b', steps: [] };
  engine.rememberClickPoint(workflow, { id: 'a', type: 'type', params: { text: 'x' }, output: 'typed at 10,10' });
  engine.rememberClickPoint(workflow, { id: 'b', type: 'clickElement', params: { name: 'Save' }, output: 'Clicked via Enter' });
  assert.equal(workflow.clickPoints, undefined, 'nothing was learned, so nothing was written');
});
