import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-setup-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const setup = await import('../server/setup-commands.js');
const { executeStep } = await import('../server/automation.js');

const WINDOWS = process.platform === 'win32';
const NODE = process.execPath;

function nodeEntry(overrides = {}) {
  return {
    label: `Probe ${Math.random().toString(36).slice(2, 8)}`,
    exe: NODE,
    args: ['-e', 'console.log("setup-ok")'],
    ...overrides,
  };
}

function context(stepId) {
  return {
    live: true,
    runId: 'run_setup_test',
    workflow: null,
    run: { evidence: [], steps: [{ id: stepId, evidenceIds: [] }] },
  };
}

test('elevation is refused when an entry is added, in any of its spellings', () => {
  const powerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  assert.throws(
    () => setup.addSetupCommand({ label: 'elevated', exe: nodeEntry().exe, args: ['-e', 'runas /user:admin cmd'] }),
    /elevation/i
  );
  assert.throws(
    () => setup.addSetupCommand({ label: 'verb', exe: powerShell, args: ['-File', 'C:\\setup.ps1', '-Verb', 'RunAs'] }),
    /elevation/i
  );
  assert.throws(() => setup.addSetupCommand({ label: 'gsudo', exe: 'gsudo.exe', args: ['winget', 'upgrade'] }), /elevation/i);
});

test('shell hosts and ambiguous arguments are refused', () => {
  assert.throws(() => setup.addSetupCommand({ label: 'cmd', exe: 'cmd.exe', args: ['/c', 'echo hi'] }), /cmd\.exe/i);
  assert.throws(() => setup.addSetupCommand({ label: 'hta', exe: 'mshta.exe', args: ['x.hta'] }), /script host/i);
  assert.throws(
    () => setup.addSetupCommand({ label: 'ps-command', exe: 'powershell.exe', args: ['-Command', 'Get-Date'] }),
    /-Command/i
  );
  assert.throws(
    () => setup.addSetupCommand({ label: 'ps-no-file', exe: 'powershell.exe', args: ['-NoProfile'] }),
    /-File/i
  );
  assert.throws(() => setup.addSetupCommand({ label: 'relative', exe: 'bin\\setup.exe', args: [] }), /absolute/i);
  assert.throws(() => setup.addSetupCommand({ label: 'quoted', exe: '"C:\\setup.exe"', args: [] }), /quotes/i);
  assert.throws(() => setup.addSetupCommand({ label: 'newline', exe: 'C:\\setup.exe', args: ['a\nb'] }), /line breaks/i);
});

test('a fixed PowerShell -File script is allowed', () => {
  const entry = setup.addSetupCommand({
    label: 'Fixed script',
    exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\setup\\install.ps1'],
    timeoutMs: 300000,
  });
  assert.equal(entry.timeoutMs, 300000);
  assert.equal(setup.findSetupCommand(entry.id).id, entry.id);
  assert.equal(setup.findSetupCommand('fixed script').id, entry.id, 'lookup is case-insensitive by label');
  assert.equal(setup.removeSetupCommand(entry.id).id, entry.id);
});

test('duplicate labels are refused and entries are listable with their refusal state', () => {
  const entry = setup.addSetupCommand(nodeEntry({ label: 'Duplicate probe' }));
  assert.throws(() => setup.addSetupCommand(nodeEntry({ label: 'duplicate probe' })), /already allowlisted/i);
  const listed = setup.listSetupCommands().find((item) => item.id === entry.id);
  assert.ok(listed);
  assert.equal(listed.refusal, '');
  assert.equal(listed.exe, NODE);
  setup.removeSetupCommand(entry.id);
});

test('a run captures stdout and keeps the log as evidence', { skip: !WINDOWS && 'Windows only' }, async () => {
  const entry = setup.addSetupCommand(nodeEntry());
  const result = await setup.runSetupCommand(entry);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'setup-ok');
  assert.match(result.logRel, /^setup-logs\/.+\.log$/);

  const log = fs.readFileSync(path.join(tempRoot, 'data', result.logRel), 'utf8');
  assert.match(log, /setup-ok/);
  assert.match(log, /exit: 0/);
  assert.match(log, /elevation: not requested/);
  assert.ok(log.includes(entry.label), 'the log names the command');
});

test('a failed run still captures stderr and the exit code', { skip: !WINDOWS && 'Windows only' }, async () => {
  const entry = setup.addSetupCommand(nodeEntry({ label: 'Failing probe', args: ['-e', 'console.error("bad-thing"); process.exit(3)'] }));
  const result = await setup.runSetupCommand(entry);
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /bad-thing/);
  const log = fs.readFileSync(path.join(tempRoot, 'data', result.logRel), 'utf8');
  assert.match(log, /bad-thing/);
  assert.match(log, /exit: 3/);
});

test('elevation is refused again at run time, before anything starts', () => {
  const result = setup.runSetupCommand({ label: 'hand edited', exe: 'C:\\Windows\\System32\\runas.exe', args: ['/user:Administrator', 'cmd'] });
  assert.equal(result.ok, false);
  assert.match(result.refused, /elevation/i);
  assert.equal(result.logRel, '');
});

test('a runTool step can name an allowlisted command and its output becomes evidence', { skip: !WINDOWS && 'Windows only' }, async () => {
  const entry = setup.addSetupCommand(nodeEntry({ label: 'runTool probe' }));
  const stepId = 'stp_setup_probe';
  const step = {
    id: stepId,
    type: 'runTool',
    name: 'Run setup',
    params: { setupCommandId: entry.id },
    timeoutMs: 20000,
  };
  const result = await executeStep(step, context(stepId));
  assert.match(result.output, /finished/);
  assert.match(result.output, /exit 0/);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].kind, 'log');
  assert.match(result.evidence[0].path, /^setup-logs\//);
  assert.ok(fs.existsSync(path.join(tempRoot, 'data', result.evidence[0].path)));
});

test('a failing setup step throws but leaves its log attached to the run', { skip: !WINDOWS && 'Windows only' }, async () => {
  const entry = setup.addSetupCommand(nodeEntry({ label: 'failing step', args: ['-e', 'console.error("step-broke"); process.exit(7)'] }));
  const stepId = 'stp_setup_fail';
  const ctx = context(stepId);
  await assert.rejects(
    executeStep({ id: stepId, type: 'runTool', name: 'Fail setup', params: { setupCommand: entry.id }, timeoutMs: 20000 }, ctx),
    /step-broke|exit 7/
  );
  assert.equal(ctx.run.evidence.length, 1);
  assert.equal(ctx.run.evidence[0].kind, 'log');
  assert.equal(ctx.run.evidence[0].stepId, stepId);
  assert.deepEqual(ctx.run.steps[0].evidenceIds, [ctx.run.evidence[0].id]);
  const log = fs.readFileSync(path.join(tempRoot, 'data', ctx.run.evidence[0].path), 'utf8');
  assert.match(log, /step-broke/);
});

test('a dry run simulates the step and runs nothing', { skip: !WINDOWS && 'Windows only' }, async () => {
  const marker = path.join(tempRoot, 'should-not-exist.txt');
  const entry = setup.addSetupCommand(
    nodeEntry({ label: 'simulated probe', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] })
  );
  const stepId = 'stp_setup_sim';
  const ctx = context(stepId);
  ctx.live = false;
  const result = await executeStep({ id: stepId, type: 'runTool', name: 'Simulate setup', params: { setupCommandId: entry.id } }, ctx);
  assert.match(result.output, /Simulated setup command/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(marker), false);
});

test('a step cannot name a command that is not in the allowlist', async () => {
  const stepId = 'stp_setup_unknown';
  await assert.rejects(
    executeStep({ id: stepId, type: 'runTool', name: 'Unknown', params: { setupCommandId: 'sc-not-real' } }, context(stepId)),
    /not allowlisted/i
  );
});
