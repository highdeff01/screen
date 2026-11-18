import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-opinion-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const opinions = await load('server/second-opinion.js');
const sentinel = await load('server/sentinel.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const chat = async (messages) => ({ ok: true, content: `As seen through "${messages[0].content.slice(0, 40)}": the real cause is the order of initialization.` });

test('a failing run can be read through several lenses, each kept', async () => {
  // Keep the sentinel from auto-drafting plans (which would touch the network).
  sentinel.sentinelSettings().autoPlan = false;
  const run = await sentinel.runSentinelNow({
    run: async () => ({ ok: false, code: 1, output: '✖ boot fails\nℹ tests 2\nℹ pass 1\nℹ fail 1' }),
  });
  const failure = run.failures.find((f) => f.status !== 'dismissed');
  assert.ok(failure, 'the failed run is queued');

  const first = await opinions.addSecondOpinion('sentinel-failure', failure.id, 'skeptic', { chat });
  assert.equal(first.opinion.lens, 'skeptic');
  assert.match(first.opinion.text, /cause/);
  const second = await opinions.addSecondOpinion('sentinel-failure', failure.id, 'race', { chat });
  assert.equal(second.item.opinions.length, 2, 'opinions accumulate on the item');
  assert.equal(second.item.opinions[0].lens, 'race', 'the newest reading is on top');
});

test('unknown lenses and unknown items are refused', async () => {
  await assert.rejects(() => opinions.addSecondOpinion('sentinel-failure', 'sent_nope', 'skeptic', { chat }), /Failure not found/);
  await assert.rejects(() => opinions.addSecondOpinion('sentinel-failure', 'sent_x', 'telepathy', { chat }), /Unknown lens/);
  await assert.rejects(() => opinions.addSecondOpinion('dream', 'x', 'skeptic', { chat }), /No second opinion/);
});

test('an offline model leaves an error on the opinion, not a crash', async () => {
  sentinel.sentinelSettings().autoPlan = false;
  const run = await sentinel.runSentinelNow({
    run: async () => ({ ok: false, code: 1, output: '✖ still failing\nℹ tests 1\nℹ pass 0\nℹ fail 1' }),
  });
  const failure = run.failures.find((f) => f.status !== 'dismissed');
  const result = await opinions.addSecondOpinion('sentinel-failure', failure.id, 'user', {
    chat: async () => ({ ok: false, error: 'the model is offline' }),
  });
  assert.match(result.opinion.error, /offline/);
  assert.equal(result.opinion.text, undefined);
  assert.equal(opinions.lensList().length >= 4, true);
});
