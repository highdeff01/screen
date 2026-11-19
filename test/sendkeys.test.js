import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-sendkeys-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const automation = await load('server/automation.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const decoded = (text) => Buffer.from(automation.sendKeysText(text), 'base64').toString('utf8');

test('an intentional {ENTER} placeholder is expanded, not typed literally', () => {
  assert.equal(decoded('*Sightline screen agent{ENTER}Automa'), '*Sightline screen agent{ENTER}Automa');
  assert.equal(decoded('{enter}{tab}done'), '{ENTER}{TAB}done');
});

test('real newlines and tabs become key presses', () => {
  assert.equal(decoded('line1\nline2'), 'line1{ENTER}line2');
  assert.equal(decoded('a\tb'), 'a{TAB}b');
});

test('literal prose with braces and modifiers stays literal', () => {
  // SendKeys escapes special characters by wrapping them: { yields {{}, } yields {}}.
  assert.equal(decoded('literal {weird} 50% ^up'), 'literal {{}weird{}} 50{%} {^}up');
  assert.equal(decoded('a+b(c)'), 'a{+}b{(}c{)}');
});

test('known key phrases are never double-escaped', () => {
  assert.equal(decoded('{ESC}'), '{ESC}');
  assert.equal(decoded('{BACKSPACE} {F5} {DOWN}'), '{BACKSPACE} {F5} {DOWN}');
});
