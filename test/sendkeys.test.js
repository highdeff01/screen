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

test('focusing a window checks its title, not only its app', () => {
  const script = automation.buildScript({ type: 'focusWindow', name: 'Focus Notepad', params: { title: 'Notepad' } });

  assert.match(script, /\$fgProc\.MainWindowTitle -like \$pattern/, 'another document of the same app is not already focused');
});

test('shortcut scripts guard the foreground and send a normalized Windows chord', () => {
  const script = automation.buildScript({
    type: 'key',
    name: 'Open a new tab',
    params: { keys: 'ctrl+shift+t', foreground: 'Chrome' },
  });
  assert.match(script, /\$expected = 'Chrome'/);
  assert.match(script, /Refusing to send keys/);
  assert.match(script, /\[System\.Windows\.Forms\.SendKeys\]::SendWait\('\^\+t'\)/);
});

test('typed text reaches the app as characters, not as a SendKeys burst', () => {
  const text = 'Literal {text} with café and $HOME';
  const script = automation.buildScript({ type: 'type', name: 'Type a note', params: { text, foreground: 'Notepad' } });
  // SendKeys lost characters and the shift when the app was busy, so the prose
  // half is injected as Unicode and only real key phrases still use SendKeys.
  assert.match(script, /\[SightlineInput\]::TypeUnicode\(/);
  assert.equal(/\[System\.Windows\.Forms\.SendKeys\]::SendWait\(\$text\)/.test(script), false);
  assert.ok(script.includes(Buffer.from(text, 'utf8').toString('base64')));
  assert.equal(script.includes(text), false);
});

test('a type step types line breaks as characters instead of pressing keys', () => {
  // A SendKeys press mid-text corrupted the characters typed after it, so a
  // newline travels as a carriage return inside the same typed run.
  assert.deepEqual(automation.typingSegments('Sightline screen agent{ENTER}Automated typing check.'), [
    { kind: 'text', value: 'Sightline screen agent\rAutomated typing check.' },
  ]);
  assert.deepEqual(automation.typingSegments('a\nb'), [{ kind: 'text', value: 'a\rb' }]);
  assert.deepEqual(automation.typingSegments('a{ESC}b'), [
    { kind: 'text', value: 'a' },
    { kind: 'keys', value: '{ESC}' },
    { kind: 'text', value: 'b' },
  ]);
  const script = automation.buildScript({ type: 'type', name: 'Type', params: { text: 'a\nb' } });
  assert.equal(/SendKeys\]\.SendWait\('\{ENTER\}'\)/.test(script), false);
  assert.match(script, /\[SightlineInput\]::TypeUnicode\(/);
});

test('window actions use guarded native Win32 window controls', () => {
  const script = automation.buildScript({
    type: 'windowAction',
    name: 'Restore Notepad',
    params: { title: 'Notepad', process: 'notepad', action: 'restore' },
  });
  assert.match(script, /\$title = 'Notepad'/);
  assert.match(script, /\$process = 'notepad'/);
  assert.match(script, /\[SightlineInput\]::ShowWindow\(\$h, 9\)/);
  assert.match(script, /\[SightlineInput\]::SetForegroundWindow\(\$h\)/);
  assert.match(script, /No window matched title/);
});

test('known key phrases are never double-escaped', () => {
  assert.equal(decoded('{ESC}'), '{ESC}');
  assert.equal(decoded('{BACKSPACE} {F5} {DOWN}'), '{BACKSPACE} {F5} {DOWN}');
});
