import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-sup-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const sup = await load('server/supervisor.js');

after(() => {
  sup.stopSupervisor();
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a heartbeat is written with this process and is readable as status', () => {
  const status = sup.startSupervisor({ intervalMs: 1000, root: tempRoot });
  const beat = JSON.parse(fs.readFileSync(sup.HEARTBEAT, 'utf8'));
  assert.equal(beat.pid, process.pid);
  assert.ok(beat.at);
  assert.equal(status.beats >= 1, true);
  assert.equal(status.degraded, false);
  sup.stopSupervisor();
});

test('the gap since the last beat is reported after a restart', () => {
  const stoppedAt = new Date(Date.now() - 30000).toISOString();
  fs.mkdirSync(path.dirname(sup.HEARTBEAT), { recursive: true });
  fs.writeFileSync(sup.HEARTBEAT, JSON.stringify({ pid: 1, at: stoppedAt }));
  const status = sup.startSupervisor({ intervalMs: 1000, root: tempRoot });
  assert.ok(status.lastGap, 'a gap is reported');
  assert.equal(status.lastGap.since, stoppedAt);
  assert.equal(status.lastGap.samePid, false);
  assert.ok(status.lastGap.gapMs >= 25000);
  sup.stopSupervisor();
});

test('a tracked file that vanished is reported once, not restored', () => {
  fs.writeFileSync(path.join(tempRoot, 'here.txt'), 'still here');
  const before = sup.supervisorStatus().incidents.length;
  sup.supervisorTick({ root: tempRoot, tracked: ['here.txt', 'gone.txt'], scan: true });
  const status = sup.supervisorStatus();
  assert.deepEqual(status.missingFiles, ['gone.txt']);
  assert.equal(status.missingCount, 1);
  assert.equal(status.incidents.length, before + 1);
  assert.equal(status.incidents[0].kind, 'file-missing');
  // The file is not recreated: reporting is the whole job.
  assert.equal(fs.existsSync(path.join(tempRoot, 'gone.txt')), false);
  // A second scan does not repeat the same incident.
  sup.supervisorTick({ root: tempRoot, tracked: ['here.txt', 'gone.txt'], scan: true });
  assert.equal(sup.supervisorStatus().incidents.length, before + 1);
});

test('an incident records the message, the stack and the log tail', () => {
  const entry = sup.recordIncident({ kind: 'uncaught-exception', message: 'boom', stack: 'at x', tail: 'line' });
  assert.equal(entry.kind, 'uncaught-exception');
  assert.equal(entry.message, 'boom');
  assert.equal(entry.pid, process.pid);
  const written = fs.readFileSync(sup.INCIDENTS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(written.at(-1).message, 'boom');
});
