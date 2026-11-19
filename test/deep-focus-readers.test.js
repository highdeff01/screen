import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// Exercise the composition root's actual reader wiring without starting the server.
test('configured deep focus reads the current desktop windows each round', async () => {
  const root = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-focus-readers-'));
  process.chdir(tempRoot);
  const load = (name) => import(pathToFileURL(path.join(root, name)).href);
  let store;
  try {
    store = await load('server/store.js');
    const deepFocus = await load('server/deep-focus.js');
    const source = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
    assert.match(source, /import\s*\{[^}]*\breadScreenContext\b[^}]*\}\s*from\s*['"]\.\/automation\.js['"]/);
    const wiring = source.match(/configureDeepFocus\(\{[\s\S]*?\n\s*\}\);/);
    assert.ok(wiring, 'production deep-focus reader configuration exists');

    let reads = 0;
    vm.runInNewContext(wiring[0], {
      configureDeepFocus: deepFocus.configureDeepFocus,
      readForegroundWindow: async () => ({ title: 'Editor' }),
      readFocusedElement: async () => null,
      readScreenContext: async () => ({ windows: Array.from({ length: ++reads }, (_, i) => ({ title: `Window ${i}` })) }),
      chat: async () => ({ ok: false }),
      createSnapshot: async () => ({}),
      applyReshapedToRun: async () => ({}),
    });

    store.db().settings.deepFocus = { enabled: false, rounds: 2, roundDelayMs: 10, autoApply: false };
    store.db().runs.unshift({ id: 'reader-run', workflowName: 'Reader test', status: 'failed', steps: [] });
    deepFocus.startDeepFocus('reader-run', { rounds: 2 });
    for (let i = 0; i < 50 && !deepFocus.deepFocusStatus('reader-run').finishedAt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const focus = deepFocus.deepFocusStatus('reader-run');
    assert.ok(focus.finishedAt, 'focus cycle completes');
    assert.equal(reads, 2);
    assert.deepEqual(focus.rounds.map((round) => round.reflexes.tabCheck.count), [1, 2]);
  } finally {
    store?.flush();
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
