import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

test('two processes saving the same file do not take each other\'s temp file', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const target = path.join(dir, 'db.json');
  const script = path.join(dir, 'writer.mjs');
  fs.writeFileSync(script, `
import { writeFileAtomic } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'store.js')).href)};
const [target, writer, rounds, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const body = 'x'.repeat(128 * 1024);
for (let i = 0; i < Number(rounds); i += 1) {
  writeFileAtomic(target, JSON.stringify({ writer: Number(writer), i, body }));
}
`);

  // Both writers enter their save loop at the same instant, so their writes
  // overlap for most of the run.
  const startAt = Date.now() + 1500;
  const run = (writer) => new Promise((resolve) => {
    const child = spawn(process.execPath, [script, target, String(writer), '60', String(startAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  const [first, second] = await Promise.all([run(1), run(2)]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(saved.i, 59, 'the last save of one writer is intact');
  assert.ok([1, 2].includes(saved.writer));
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    'no temp file is left behind'
  );
});
