/**
 * Pipeline — parallel workers feeding one queue.
 *
 * Work arrives as jobs: draft a repair plan, review a relay exchange, re-run a
 * suite. The pipeline runs up to N jobs at once (a worker each), refuses to take
 * the same job twice while it is waiting (dedupe by key), prefers high
 * priorities, and after every job appends a checkpoint — the backwards-flow
 * record of what actually happened, newest first, so any surface can see the
 * stream instead of trusting the intention.
 *
 * Handlers are registered by the composition root (index.js), which keeps this
 * module free of imports from the features it serves. The model and the outside
 * world are only ever touched through the handlers.
 */
import { db, logActivity, now, persist, uid } from './store.js';

const DONE_LIMIT = 60;
const CHECKPOINT_LIMIT = 80;

function pipeline() {
  const d = db();
  if (!d.pipeline || typeof d.pipeline !== 'object') d.pipeline = { queue: [], done: [], checkpoints: [] };
  for (const key of ['queue', 'done', 'checkpoints']) {
    if (!Array.isArray(d.pipeline[key])) d.pipeline[key] = [];
  }
  return d.pipeline;
}

const state = {
  timer: null,
  handlers: new Map(),
  running: new Map(), // jobId -> promise
};

export function pipelineSettings() {
  const d = db();
  if (!d.settings.pipeline || typeof d.settings.pipeline !== 'object') d.settings.pipeline = {};
  const s = d.settings.pipeline;
  if (!Number(s.workers)) s.workers = 2;
  s.workers = Math.max(1, Math.min(8, Math.round(s.workers)));
  return s;
}

export function registerHandler(kind, fn) {
  if (typeof fn !== 'function') throw new Error('A handler needs to be a function.');
  state.handlers.set(kind, fn);
}

export function pipelineStatus() {
  const p = pipeline();
  const s = pipelineSettings();
  return {
    workers: s.workers,
    running: [...state.running.keys()],
    handlers: [...state.handlers.keys()],
    queued: p.queue.map(({ id, kind, key, priority, enqueuedAt, attempts }) => ({ id, kind, key, priority, enqueuedAt, attempts })),
    done: p.done.slice(0, 12),
    checkpoints: p.checkpoints.slice(0, 20),
    busy: state.running.size,
  };
}

/**
 * Add a job. `key` deduplicates: an identical pending job is not queued twice;
 * a re-enqueued job after a failure is a retry and raises its priority.
 */
export function enqueue({ kind = '', payload = {}, key = null, priority = 0 } = {}) {
  if (!state.handlers.has(kind)) throw new Error(`No handler for ${kind}`);
  const p = pipeline();
  const jobKey = key || `${kind}:${JSON.stringify(payload).slice(0, 200)}`;
  const existing = p.queue.find((job) => job.key === jobKey);
  if (existing) {
    existing.priority = Math.max(existing.priority, Number(priority) || 0);
    existing.enqueuedAt = now();
    persist();
    return existing;
  }
  const job = {
    id: uid('job'),
    kind,
    payload,
    key: jobKey,
    priority: Number(priority) || 0,
    attempts: 0,
    enqueuedAt: now(),
  };
  p.queue.push(job);
  persist();
  logActivity('pipeline', `Queued ${kind} job`, { jobId: job.id, key: jobKey });
  return job;
}

/** Run one job to completion and record the outcome as a checkpoint. */
async function execute(job) {
  const p = pipeline();
  job.attempts += 1;
  const startedAt = now();
  const startedMs = Date.now();
  try {
    const handler = state.handlers.get(job.kind);
    const result = await handler(job.payload);
    const record = {
      id: job.id,
      kind: job.kind,
      key: job.key,
      attempts: job.attempts,
      ok: true,
      result: typeof result === 'string' ? result.slice(0, 400) : result,
      startedAt,
      ms: Date.now() - startedMs,
    };
    p.done.unshift(record);
    p.checkpoints.unshift({ at: now(), jobId: job.id, kind: job.kind, ok: true, summary: describe(record) });
    return record;
  } catch (err) {
    const record = {
      id: job.id,
      kind: job.kind,
      key: job.key,
      attempts: job.attempts,
      ok: false,
      error: String(err.message || err).slice(0, 400),
      startedAt,
      ms: Date.now() - startedMs,
    };
    p.done.unshift(record);
    p.checkpoints.unshift({ at: now(), jobId: job.id, kind: job.kind, ok: false, summary: describe(record) });
    return record;
  } finally {
    while (p.done.length > DONE_LIMIT) p.done.pop();
    while (p.checkpoints.length > CHECKPOINT_LIMIT) p.checkpoints.pop();
    p.queue = p.queue.filter((entry) => entry.id !== job.id);
    state.running.delete(job.id);
    persist();
  }
}

function describe(record) {
  if (record.ok) return `${record.kind} finished${record.ms ? ` in ${record.ms}ms` : ''}`;
  return `${record.kind} failed: ${record.error}`;
}

/**
 * One scheduler pass: fill the worker slots from the queue, highest priority
 * first, oldest first within a priority. Returns immediately; the jobs settle
 * on their own and the next pass picks up freed slots.
 */
export function tick() {
  const s = pipelineSettings();
  const p = pipeline();
  const queue = [...p.queue].sort((a, b) => b.priority - a.priority || String(a.enqueuedAt).localeCompare(String(b.enqueuedAt)));
  for (const job of queue) {
    if (state.running.size >= s.workers) break;
    if (state.running.has(job.id)) continue;
    state.running.set(job.id, execute(job).catch(() => {}));
  }
  return pipelineStatus();
}

export function startPipeline({ intervalMs } = {}) {
  const fromSettings = Number(db().settings.pipelineIntervalMs);
  const every = Math.max(500, Number(intervalMs) || fromSettings || 1500);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.warn(`[pipeline] tick failed: ${err.message}`);
    }
  }, every);
  state.timer.unref?.();
  return pipelineStatus();
}

/** Wait until every job in the queue has settled (tests and "run now"). */
export async function drain() {
  const p = pipeline();
  // The scheduler only starts work when a slot is free, so keep ticking until
  // both the queue and the running set are empty. A job that fails is removed
  // from the queue, so the loop always shrinks.
  for (;;) {
    if (!p.queue.length && !state.running.size) break;
    tick();
    if (state.running.size) await Promise.all([...state.running.values()]);
  }
  return pipelineStatus();
}

export function runNow() {
  tick();
  return pipelineStatus();
}

export function stopPipeline() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return pipelineStatus();
}

/** Used by the tests to reset the worker bookkeeping between cases. */
export function __resetPipeline() {
  stopPipeline();
  state.running.clear();
  state.handlers.clear();
  const d = db();
  d.pipeline = { queue: [], done: [], checkpoints: [] };
  persist();
}
