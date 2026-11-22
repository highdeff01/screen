/**
 * Link-triggered jobs: instructions on disk, started by a loopback request.
 *
 * A job is a file in data/runner/inbox named after its id. The file carries the
 * whole instruction (workflow, mode, goal, who queued it) and a sha256 over
 * those fields, so a start request that only names the id is enough and the
 * runner can tell whether the file was edited after it was written.
 *
 * The start route needs the local token in data/runner/token. The token is not
 * an account: it separates "this machine asked" from "a page in a browser asked".
 *
 * Approval is separate from the token. A job runs without a prompt only when
 * the operator turned on linkAutoApprove AND the job is from this console AND
 * its sha256 and the workflow's steps still match AND the workflow has no shell
 * steps. Anything else waits for the operator, who approves the exact sha256
 * they were shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA, db, now, persist } from './store.js';

export const RUNNER_DIR = path.join(DATA, 'runner');
export const INBOX_DIR = path.join(RUNNER_DIR, 'inbox');
const TOKEN_FILE = path.join(RUNNER_DIR, 'token');

/** Steps that turn a queued instruction into arbitrary code execution. */
export const SHELL_STEP_TYPES = new Set(['runTool']);

const JOB_MODES = ['simulate', 'live'];
const JOB_FIELDS = ['id', 'workflowId', 'mode', 'source', 'goal', 'createdAt', 'stepsHash'];
const MUTABLE = ['status', 'approvedAt', 'approvedSha256', 'startedAt', 'runId', 'via', 'note'];

function ensureDirs() {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/** The steps as they stood when the job was queued, so an edit voids approval. */
export function stepsHash(steps) {
  return sha256(canonical(Array.isArray(steps) ? steps : []));
}

export function jobDigest(job) {
  const fields = {};
  for (const key of JOB_FIELDS) fields[key] = job[key] ?? null;
  return sha256(canonical(fields));
}

/** A job id is a file name in inbox/, never a path. */
export function safeJobId(id) {
  const value = String(id || '');
  return /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/.test(value) ? value : '';
}

function jobFile(id) {
  const safe = safeJobId(id);
  return safe ? path.join(INBOX_DIR, `${safe}.json`) : '';
}

function settleSettings() {
  const settings = db().settings;
  if (!settings.runnerSourceId) {
    settings.runnerSourceId = `console-${randomBytes(4).toString('hex')}`;
    persist();
  }
  return settings;
}

/** Who queued this console's jobs. A knob a second console would have to match. */
export function runnerSourceId() {
  return settleSettings().runnerSourceId;
}

export function runnerToken() {
  ensureDirs();
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

export function rotateRunnerToken() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {}
  return runnerToken();
}

/**
 * Compare without leaking length or content: both sides are hashed first, so
 * timingSafeEqual always sees equal-length buffers.
 */
export function verifyRunnerToken(presented) {
  const candidate = String(presented || '').trim();
  if (!candidate) return false;
  let token = '';
  try {
    token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return false;
  }
  if (!token) return false;
  const a = Buffer.from(sha256(candidate), 'hex');
  const b = Buffer.from(sha256(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJob(job) {
  ensureDirs();
  const file = jobFile(job.id);
  if (!file) throw new Error('Invalid job id');
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`);
  fs.renameSync(temp, file);
  return job;
}

/**
 * Queue a workflow from the library. Nothing here runs it: the file is the
 * instruction, and the start route is the only way it executes.
 */
export function queueJob({ workflowId, mode = 'simulate', goal = '' } = {}) {
  const wf = db().workflows.find((w) => w.id === String(workflowId || ''));
  if (!wf) throw new Error('Workflow not found');
  if (wf.status === 'archived') throw new Error('Archived workflows cannot be queued');
  if (!wf.steps?.length) throw new Error('This workflow has no steps yet');
  if (!JOB_MODES.includes(mode)) throw new Error('mode must be simulate or live');
  ensureDirs();
  const job = {
    id: `job-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    workflowId: wf.id,
    workflowName: wf.name,
    mode,
    source: runnerSourceId(),
    goal: String(goal || '').slice(0, 500),
    createdAt: now(),
    stepsHash: stepsHash(wf.steps),
    status: 'pending',
    approvedAt: null,
    approvedSha256: null,
    startedAt: null,
    runId: null,
  };
  job.sha256 = jobDigest(job);
  return writeJob(job);
}

/** Read one job and say whether the file still matches its own sha256. */
export function readJob(id) {
  const file = jobFile(id);
  if (!file) return null;
  let job;
  try {
    job = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const expected = jobDigest(job);
  return { ...job, digestOk: expected === job.sha256, expectedSha256: expected };
}

export function listJobs(limit = 20) {
  ensureDirs();
  let names = [];
  try {
    names = fs.readdirSync(INBOX_DIR).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    const job = readJob(name.slice(0, -'.json'.length));
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
  return jobs.slice(0, cap);
}

/**
 * Whether a job may start, and why not. `auto` says the scoped auto-approve
 * covered it; an operator approval always wins and is never called auto.
 */
export function jobDecision(job, { autoApprove = false } = {}) {
  if (!job) return { ok: false, why: 'Job not found' };
  if (!job.digestOk) return { ok: false, why: 'The job file does not match its sha256.', needsApproval: true };
  if (!job.source || job.source !== runnerSourceId()) {
    return { ok: false, why: 'This job was queued by a different console.', needsApproval: true };
  }
  if (job.status !== 'pending') return { ok: false, why: `This job is already ${job.status}.` };
  const wf = db().workflows.find((w) => w.id === job.workflowId);
  if (!wf) return { ok: false, why: 'The workflow for this job no longer exists.', needsApproval: true };
  if (wf.status === 'archived') return { ok: false, why: 'Archived workflows cannot run.' };
  if (!wf.steps?.length) return { ok: false, why: 'This workflow has no steps.', needsApproval: true };
  if (stepsHash(wf.steps) !== job.stepsHash) {
    return { ok: false, why: 'The workflow changed after this job was queued; queue it again.', needsApproval: true };
  }
  if (job.approvedSha256 && job.approvedSha256 === job.sha256) {
    return { ok: true, workflow: wf, auto: false };
  }
  if (!autoApprove) {
    return { ok: false, why: 'This job needs approval in the console.', needsApproval: true };
  }
  if (wf.steps.some((step) => SHELL_STEP_TYPES.has(step.type))) {
    return {
      ok: false,
      why: 'Auto-approve does not cover shell steps; approve this job in the console.',
      needsApproval: true,
    };
  }
  return { ok: true, workflow: wf, auto: true };
}

/** Record operator approval against the sha256 that was on screen. */
export function approveJob(id) {
  const job = readJob(id);
  if (!job) return { ok: false, why: 'Job not found' };
  if (!job.digestOk) return { ok: false, why: 'The job file does not match its sha256.' };
  if (job.status !== 'pending') return { ok: false, why: `This job is already ${job.status}.` };
  const next = markJob(id, { approvedAt: now(), approvedSha256: job.sha256 });
  return { ok: true, job: next };
}

/** Status and run id are outside the digest: starting a job does not void it. */
export function markJob(id, patch = {}) {
  const current = readJob(id);
  if (!current) return null;
  const { digestOk, expectedSha256, ...job } = current;
  for (const key of MUTABLE) {
    if (patch[key] !== undefined) job[key] = patch[key];
  }
  return writeJob(job);
}
