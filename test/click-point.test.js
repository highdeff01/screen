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

test('every successful click teaches its point, including a vision-fallback click', () => {
  const workflow = { id: 'wf_points_c', steps: [] };
  const steps = [
    // A plain coordinate click: its output is only the word "clicked".
    { id: 'a', type: 'click', params: { x: 100, y: 200 }, output: 'clicked' },
    // A click found by the vision fallback, which reports its point in prose.
    { id: 'b', type: 'clickElement', params: { name: 'Dan' }, output: 'Clicked “Dan” via vision 81% at 640,300.' },
    // A click whose point is carried structurally, with no coordinates in text.
    {
      id: 'c',
      type: 'clickElement',
      params: { name: 'Address bar' },
      clickPoint: { x: 900, y: 120, method: 'vision 74%', name: 'Address bar', window: 'Chrome' },
      output: 'Clicked “Address bar” via vision 74%.',
    },
  ];
  for (const step of steps) engine.rememberClickPoint(workflow, step);
  assert.deepEqual(Object.keys(workflow.clickPoints).sort(), ['a', 'b', 'c'], 'three clicks leave three points');
  assert.deepEqual([workflow.clickPoints.a.x, workflow.clickPoints.a.y], [100, 200]);
  assert.equal(workflow.clickPoints.a.method, 'coordinates');
  assert.deepEqual([workflow.clickPoints.b.x, workflow.clickPoints.b.y], [640, 300]);
  assert.equal(workflow.clickPoints.c.method, 'vision 74%');
  assert.equal(workflow.clickPoints.c.name, 'Address bar');
});

test('a right click or a play-control click also teaches where it landed', () => {
  const workflow = { id: 'wf_points_d', steps: [] };
  engine.rememberClickPoint(workflow, { id: 'r', type: 'rightClick', params: { x: 30, y: 40 }, output: 'clicked' });
  engine.rememberClickPoint(workflow, {
    id: 'p',
    type: 'playMedia',
    params: { title: 'YouTube', x: 1, y: 1 },
    output: 'Paused player detected; clicked the play control inside the player at 700,420.',
  });
  assert.deepEqual([workflow.clickPoints.r.x, workflow.clickPoints.r.y], [30, 40]);
  assert.deepEqual([workflow.clickPoints.p.x, workflow.clickPoints.p.y], [700, 420], 'the play control, not the stale stored point');
});

test('a run working from a snapshot still teaches the saved workflow', () => {
  const saved = { id: 'wf_points_saved', steps: [] };
  store.db().workflows.push(saved);
  const snapshot = JSON.parse(JSON.stringify(saved));
  engine.rememberClickPoint(snapshot, { id: 's', type: 'click', params: { x: 5, y: 6 }, output: 'clicked' });
  assert.equal(saved.clickPoints.s.x, 5, 'the stored workflow keeps the point for the next run');
  assert.equal(snapshot.clickPoints.s.y, 6, 'and this run can aim with it too');
});

test('a learned point carries the window rect it was recorded in', () => {
  const workflow = { id: 'wf_points_rect', steps: [] };
  engine.rememberClickPoint(
    workflow,
    { id: 'r', type: 'click', params: { x: 5, y: 6 }, output: 'clicked' },
    { windowRect: { left: 117, top: 117, width: 1164, height: 839 } }
  );
  assert.deepEqual(workflow.clickPoints.r.window, { left: 117, top: 117, width: 1164, height: 839 });
  assert.deepEqual([workflow.clickPoints.r.x, workflow.clickPoints.r.y], [5, 6], 'the point itself is unchanged');
});

test('a point learned without a readable window keeps no rect, so it is not trusted', () => {
  const workflow = { id: 'wf_points_no_rect', steps: [] };
  engine.rememberClickPoint(workflow, { id: 'n', type: 'click', params: { x: 5, y: 6 }, output: 'clicked' });
  assert.equal(workflow.clickPoints.n.window, undefined);
  assert.equal(workflow.clickPoints.n.x, 5);
});
