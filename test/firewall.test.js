import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-firewall-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const firewall = await load('server/firewall.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

beforeEach(() => {
  const d = store.db();
  d.firewall = null; // fresh defaults each test
  store.persist();
});

test('defaults are installed and everything ordinary passes', () => {
  const status = firewall.firewallStatus();
  assert.equal(status.mode, 'enforce');
  assert.ok(status.rules.length >= 4);
  const verdict = firewall.firewallCheck({ type: 'openApp', params: { app: 'notepad' } }, { lastWindow: null });
  assert.equal(verdict.verdict, 'allow');
});

test('destructive commands are denied', () => {
  const verdict = firewall.firewallCheck({ type: 'runTool', params: { command: 'del /f old.log' } }, {});
  assert.equal(verdict.verdict, 'deny');
  assert.ok(/destructive/i.test(verdict.reason));
  const safe = firewall.firewallCheck({ type: 'runTool', params: { command: 'dir' } }, {});
  assert.equal(safe.verdict, 'allow');
});

test('a PCRE-style (?i) rule matches case-insensitively instead of crashing the run', () => {
  const upper = firewall.firewallCheck({ type: 'runTool', params: { command: 'DEL /F old.log' } }, {});
  assert.equal(upper.verdict, 'deny');
  const taskkill = firewall.firewallCheck({ type: 'runTool', params: { command: 'taskkill /PID 12 /F' } }, {});
  assert.equal(taskkill.verdict, 'deny');
});

test('a rule whose pattern cannot compile still blocks its step', () => {
  firewall.firewallStatus(); // installs the defaults on a fresh store
  const d = store.db();
  d.firewall.rules.push({
    id: 'fw_broken',
    name: 'Broken custom rule',
    verdict: 'deny',
    reason: 'its pattern cannot compile',
    match: { types: ['runTool'], paramPattern: '([unclosed' },
  });
  const verdict = firewall.firewallCheck({ type: 'runTool', params: { command: 'dir' } }, {});
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.ruleId, 'fw_broken');
});

test('closing a window with unsaved work is denied, a saved one is not', () => {
  const unsaved = firewall.firewallCheck({ type: 'windowAction', params: { action: 'close' } }, { lastWindow: { title: '*Untitled - Notepad' } });
  assert.equal(unsaved.verdict, 'deny');
  const saved = firewall.firewallCheck({ type: 'windowAction', params: { action: 'close' } }, { lastWindow: { title: 'report.txt - Notepad' } });
  assert.equal(saved.verdict, 'allow');
});

test('typing without a proven destination is denied', () => {
  const blind = firewall.firewallCheck({ type: 'type', params: { text: 'hello' } }, { lastWindow: null });
  assert.equal(blind.verdict, 'deny');
  const aimed = firewall.firewallCheck({ type: 'type', params: { text: 'hello', foreground: 'Untitled - Notepad' } }, { lastWindow: { title: 'Untitled - Notepad' } });
  assert.equal(aimed.verdict, 'allow');
});

test('installs are held for review, never run silently', () => {
  const verdict = firewall.firewallCheck({ type: 'installApp', params: { name: 'tool' } }, {});
  assert.equal(verdict.verdict, 'review');
});

test('custom rules validate the regex and first match wins', () => {
  assert.throws(() => firewall.addFirewallRule({ name: 'bad', pattern: '([unclosed' }), /not a valid regular expression/);
  const rule = firewall.addFirewallRule({ name: 'No git push force', verdict: 'deny', pattern: 'push.*--force', types: ['runTool'] });
  const verdict = firewall.firewallCheck({ type: 'runTool', params: { command: 'git push --force origin main' } }, {});
  assert.equal(verdict.verdict, 'deny');
  assert.equal(verdict.ruleId, rule.id);
  firewall.removeFirewallRule(rule.id);
  const after = firewall.firewallCheck({ type: 'runTool', params: { command: 'git push --force origin main' } }, {});
  assert.equal(after.verdict, 'allow'); // only the custom rule covered force-push
  const destructive = firewall.firewallCheck({ type: 'runTool', params: { command: 'taskkill /PID 12 /F' } }, {});
  assert.equal(destructive.verdict, 'deny'); // the default destructive rule still bites
});

test('log mode records the verdict but lets the step run', () => {
  firewall.setFirewallMode('log');
  const verdict = firewall.firewallCheck({ type: 'runTool', params: { command: 'shutdown /s' } }, {});
  assert.equal(verdict.verdict, 'allow');
  assert.equal(verdict.loggedVerdict, 'deny');
  firewall.setFirewallMode('enforce');
  const enforced = firewall.firewallCheck({ type: 'runTool', params: { command: 'shutdown /s' } }, {});
  assert.equal(enforced.verdict, 'deny');
});

test('reset restores the built-in safeguards', () => {
  firewall.addFirewallRule({ name: 'temp rule', verdict: 'allow', pattern: '.*' });
  firewall.resetFirewallRules();
  assert.ok(firewall.firewallStatus().rules.every((rule) => rule.name !== 'temp rule'));
});
