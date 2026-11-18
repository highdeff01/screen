import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const automation = await load('server/automation.js');

const probeDir = path.join(root, 'data', 'media');
const probeName = `silent-file-check-${process.pid}.txt`;
const probePath = path.join(probeDir, probeName);

after(() => {
  try {
    fs.rmSync(probePath, { force: true });
  } catch {
    // A missing probe file is the state the tests want anyway.
  }
});

test('a recorded path relative to the project root resolves to the real file', async () => {
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(probePath, 'evidence');
  const recorded = `data/media/${probeName}`;
  assert.equal(automation.resolveCheckFile(recorded), path.resolve(root, recorded));

  const result = await automation.silentCheck('file', { path: recorded });
  assert.equal(result.ok, true);
  assert.match(result.detail, /data[\\/]media[\\/]silent-file-check-[\d]+\.txt \(8 bytes\)$/);
});

test('a bare file name still finds a download in data/media', async () => {
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(probePath, 'evidence');
  // Older runs stored only the file name, which used to be resolved against the
  // process cwd and reported as missing.
  assert.equal(automation.resolveCheckFile(probeName), probePath);
  const result = await automation.silentCheck('file', { path: probeName });
  assert.equal(result.ok, true);
});

test('an absolute path is used as given', () => {
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(probePath, 'evidence');
  assert.equal(automation.resolveCheckFile(probePath), probePath);
});

test('a genuinely missing file is still reported as missing', async () => {
  const missing = 'data/media/definitely-not-here.txt';
  assert.match(automation.resolveCheckFile(missing), /data[\\/]media[\\/]definitely-not-here\.txt$/);
  const result = await automation.silentCheck('file', { path: missing });
  assert.equal(result.ok, false);
  assert.match(result.detail, /is missing/);
});

test('an empty path is a check without a file, not a false pass', async () => {
  assert.equal(automation.resolveCheckFile(''), '');
  const result = await automation.silentCheck('file', {});
  assert.equal(result.ok, false);
  assert.match(result.detail, /no file path recorded/);
});
