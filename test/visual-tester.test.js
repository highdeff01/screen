import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-visual-tester-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const tester = await load('server/visual-tester.js');

after(() => {
  delete process.env.SIGHTLINE_VISUAL_TESTER_URL;
  delete process.env.SIGHTLINE_VISUAL_TESTER_TOKEN;
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  delete process.env.SIGHTLINE_VISUAL_TESTER_URL;
  delete process.env.SIGHTLINE_VISUAL_TESTER_TOKEN;
  const d = store.db();
  d.settings.visualTesterUrl = '';
  d.settings.visualTesterEnabled = true;
  store.persist();
});

test('status reports an unconfigured tester honestly', () => {
  const status = tester.visualTesterStatus();
  assert.equal(status.configured, false);
  assert.match(status.message, /No visual tester connected/);
});

test('status validates the URL and honours a settings-configured endpoint', () => {
  const d = store.db();
  d.settings.visualTesterUrl = 'not a url';
  store.persist();
  assert.equal(tester.visualTesterStatus().configured, false);
  assert.match(tester.visualTesterStatus().message, /must be http/);
  d.settings.visualTesterUrl = 'http://127.0.0.1:9/vtest';
  store.persist();
  const status = tester.visualTesterStatus();
  assert.equal(status.configured, true);
  assert.equal(status.enabled, true);
});

test('testScreenshot refuses to run without configuration, then posts the protocol payload', async () => {
  await assert.rejects(() => tester.testScreenshot({ imagePath: 'x.png' }), /No visual tester connected/);
  const d = store.db();
  d.settings.visualTesterUrl = 'http://127.0.0.1:9/vtest';
  store.persist();
  await assert.rejects(() => tester.testScreenshot({}), /Pick a screenshot/);

  // Point the tester at a local server that echoes the protocol contract.
  // readImage resolves inside the data folder, so the fixture lives there.
  const dir = path.join(tempRoot, 'data', 'captures');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' + '01f15c4890000000a49444154789c6300010000050001' + '0d0a2db4', 'hex');
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, png);
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, confidence: 0.9, summary: 'the editor is in front', findings: [{ element: 'editor', verdict: 'present' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    d.settings.visualTesterUrl = `http://127.0.0.1:${port}/vtest`;
    d.settings.visualTesterToken = 'secret-token';
    store.persist();

    const result = await tester.testScreenshot({
      imagePath: file,
      caption: 'probe capture',
      goal: 'prove the editor',
      workflow: { id: 'wf1', name: 'Probe', description: '', steps: [{ type: 'type', name: 'Type', params: {} }] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.confidence, 0.9);
    assert.match(result.summary, /editor/);
    assert.equal(received.protocol, tester.visualTesterStatus().protocol);
    assert.equal(received.screenshot.mime, 'image/png');
    assert.equal(received.workflow.name, 'Probe');
  } finally {
    server.close();
  }
});

test('rememberVisualTest keeps the newest tests on the proposal', () => {
  const proposal = { visualTests: [] };
  tester.rememberVisualTest(proposal, { ok: true, at: 't1', summary: 'one' });
  tester.rememberVisualTest(proposal, { ok: false, at: 't2', summary: 'two' });
  assert.equal(proposal.visualTests.length, 2);
  assert.equal(proposal.visualTests[0].summary, 'two', 'newest first');
  tester.rememberVisualTest(null, {}); // no proposal: harmless no-op
  assert.equal(proposal.visualTests.length, 2);
});
