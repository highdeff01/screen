import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-link-jobs-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const jobs = await import('../server/runner-jobs.js');

function workflow(id, steps) {
  return {
    id,
    name: `Workflow ${id}`,
    description: '',
    status: 'ready',
    tags: [],
    patternTags: [],
    failurePolicy: {},
    steps,
  };
}

function addWorkflow(wf) {
  store.db().workflows.push(wf);
  store.persist();
  return wf;
}

const noteStep = (id) => ({ id, type: 'note', name: 'Note', params: { text: 'hello' } });

const wfNote = addWorkflow(workflow('wf_link_note', [noteStep('stp_link_note')]));
const wfShell = addWorkflow(
  workflow('wf_link_shell', [noteStep('stp_link_shell'), { id: 'stp_link_tool', type: 'runTool', name: 'Tool', params: { toolName: 'x' } }])
);
const wfEdited = addWorkflow(workflow('wf_link_edited', [noteStep('stp_link_edit')]));

function jobFile(id) {
  return path.join(jobs.INBOX_DIR, `${id}.json`);
}

test('a queued job is a file carrying its source and a sha256 over the instruction', () => {
  const job = jobs.queueJob({ workflowId: wfNote.id, goal: 'say hello' });
  const onDisk = JSON.parse(fs.readFileSync(jobFile(job.id), 'utf8'));
  assert.equal(onDisk.workflowId, wfNote.id);
  assert.equal(onDisk.mode, 'simulate');
  assert.equal(onDisk.source, jobs.runnerSourceId());
  assert.match(onDisk.source, /^console-[0-9a-f]{8}$/);
  assert.match(onDisk.sha256, /^[0-9a-f]{64}$/);
  assert.equal(onDisk.sha256, jobs.jobDigest(onDisk));
  assert.equal(jobs.readJob(job.id).digestOk, true);
  assert.match(jobs.runnerSourceId(), /^console-/);
});

test('editing the instruction file voided its sha256 and refuses to start', () => {
  const job = jobs.queueJob({ workflowId: wfNote.id, goal: 'original' });
  const original = JSON.parse(fs.readFileSync(jobFile(job.id), 'utf8'));
  fs.writeFileSync(jobFile(job.id), JSON.stringify({ ...original, goal: 'something else', sha256: original.sha256 }, null, 2));
  const read = jobs.readJob(job.id);
  assert.equal(read.digestOk, false);
  const decision = jobs.jobDecision(read, { autoApprove: true });
  assert.equal(decision.ok, false);
  assert.match(decision.why, /sha256/i);
});

test('a workflow edited after queuing voids the job, even with auto-approve on', () => {
  const job = jobs.queueJob({ workflowId: wfEdited.id });
  wfEdited.steps.push(noteStep('stp_link_edit_2'));
  store.persist();
  const decision = jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true });
  assert.equal(decision.ok, false);
  assert.match(decision.why, /changed/i);
  assert.equal(decision.needsApproval, true);
  wfEdited.steps.pop();
  store.persist();
  assert.equal(jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true }).ok, true);
});

test('without auto-approve a job waits, and approval is bound to its sha256', () => {
  const job = jobs.queueJob({ workflowId: wfNote.id });
  const waiting = jobs.jobDecision(jobs.readJob(job.id));
  assert.equal(waiting.ok, false);
  assert.equal(waiting.needsApproval, true);
  assert.match(waiting.why, /approval/i);

  const approved = jobs.approveJob(job.id);
  assert.equal(approved.ok, true);
  assert.equal(approved.job.approvedSha256, job.sha256);
  assert.equal(approved.job.status, 'pending');

  const decision = jobs.jobDecision(jobs.readJob(job.id));
  assert.equal(decision.ok, true);
  assert.equal(decision.auto, false, 'operator approval is never reported as auto');
});

test('auto-approve covers a saved workflow without shell steps', () => {
  const job = jobs.queueJob({ workflowId: wfNote.id });
  const decision = jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true });
  assert.equal(decision.ok, true);
  assert.equal(decision.auto, true);
  assert.equal(decision.workflow.id, wfNote.id);
});

test('auto-approve never covers a workflow with a shell step', () => {
  const job = jobs.queueJob({ workflowId: wfShell.id });
  const decision = jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true });
  assert.equal(decision.ok, false);
  assert.equal(decision.needsApproval, true);
  assert.match(decision.why, /shell/i);
  // The operator can still approve the exact file they were shown.
  assert.equal(jobs.approveJob(job.id).ok, true);
  assert.equal(jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true }).ok, true);
});

test('a job queued by another console is refused', () => {
  const job = jobs.queueJob({ workflowId: wfNote.id });
  const onDisk = JSON.parse(fs.readFileSync(jobFile(job.id), 'utf8'));
  const foreign = { ...onDisk, source: 'console-00000000' };
  foreign.sha256 = jobs.jobDigest(foreign);
  fs.writeFileSync(jobFile(job.id), JSON.stringify(foreign, null, 2));
  const decision = jobs.jobDecision(jobs.readJob(job.id), { autoApprove: true });
  assert.equal(decision.ok, false);
  assert.match(decision.why, /different console/i);
});

test('the local token is long, compared exactly, and never a path', () => {
  const token = jobs.runnerToken();
  assert.ok(token.length >= 32);
  assert.equal(jobs.verifyRunnerToken(token), true);
  assert.equal(jobs.verifyRunnerToken(token.slice(0, -1)), false);
  assert.equal(jobs.verifyRunnerToken('not-the-token'), false);
  assert.equal(jobs.verifyRunnerToken(''), false);
  assert.equal(jobs.safeJobId('../../data/db.json'), '');
  assert.equal(jobs.readJob('../../data/db.json'), null);
  assert.equal(jobs.readJob('nope'), null);
});

test('running a job over the loopback link needs the token and the approval scope', { timeout: 40000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'link-jobs-http-'));
  fs.mkdirSync(path.join(cwd, 'data'));
  const seeded = workflow('wf_link_http', [noteStep('stp_link_http')]);
  fs.writeFileSync(
    path.join(cwd, 'data', 'db.json'),
    JSON.stringify({
      settings: {
        agentTickMs: 600000,
        autoRecoverFailures: false,
        continuityAutoContinue: false,
        continuityEnabled: false,
        continuityFrameWatch: false,
        companionEnabled: false,
        localModelAutoStart: false,
        linkAutoApprove: false,
        dryRun: true,
      },
      workflows: [seeded],
    })
  );

  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;

  let output = '';
  const child = spawn(process.execPath, [path.resolve(originalCwd, 'server', 'index.js')], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try {
      ready = (await fetch(`${base}/api/runner/jobs`)).ok;
    } catch {
      await sleep(50);
    }
  }
  assert.ok(ready, output);

  const post = (url, body) =>
    fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

  const queued = await (await post('/api/runner/jobs', { workflowId: seeded.id })).json();
  assert.equal(queued.ok, true);
  assert.match(queued.job.sha256, /^[0-9a-f]{64}$/);
  assert.equal(queued.job.source, (await (await fetch(`${base}/api/runner/jobs`)).json()).source);
  assert.match(queued.link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/api/runner/jobs/`));
  const token = new URL(queued.link).searchParams.get('token');
  assert.ok(token && token.length >= 32);
  assert.equal(fs.readFileSync(path.join(cwd, 'data', 'runner', 'token'), 'utf8').trim(), token);

  const noToken = await fetch(`${base}/api/runner/jobs/${queued.job.id}/start`);
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${base}/api/runner/jobs/${queued.job.id}/start?token=wrong`);
  assert.equal(wrongToken.status, 401);

  const gated = await fetch(queued.link);
  assert.equal(gated.status, 409);
  const gatedBody = await gated.json();
  assert.match(gatedBody.error, /approval/i);
  assert.equal(gatedBody.needsApproval, true);

  const approved = await post(`/api/runner/jobs/${queued.job.id}/approve`, {});
  assert.equal((await approved.json()).ok, true);
  const started = await fetch(queued.link);
  const startedBody = await started.json();
  assert.equal(started.status, 200, JSON.stringify(startedBody));
  assert.equal(startedBody.ok, true);
  assert.equal(startedBody.autoApproved, false);
  assert.equal(startedBody.run.trigger, 'link');
  assert.equal(startedBody.job.status, 'started');
  assert.equal(startedBody.job.via, 'link:approved');
  assert.equal(startedBody.job.runId, startedBody.run.id);

  const again = await fetch(queued.link);
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already/i);

  const patched = await fetch(`${base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ linkAutoApprove: true }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).settings.linkAutoApprove, true);

  const autoQueued = await (await post('/api/runner/jobs', { workflowId: seeded.id })).json();
  const autoStarted = await fetch(autoQueued.link);
  const autoBody = await autoStarted.json();
  assert.equal(autoStarted.status, 200, JSON.stringify(autoBody));
  assert.equal(autoBody.autoApproved, true);
  assert.equal(autoBody.job.via, 'link:auto');
});
