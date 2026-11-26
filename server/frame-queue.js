/**
 * The frame queue: capture in the step, judge out of the step.
 *
 * A screen review used to be awaited between two steps: capture the frame,
 * focus the window, ask the vision model, then let the next step start. On a
 * workstation whose model takes a hundred seconds to answer, that put more than
 * a minute of nothing between every action — the pointer sat still and the
 * console looked stuck.
 *
 * The frame itself is cheap and must be taken at the moment the step settled.
 * The judgement is expensive and does not touch the desktop, so it can run
 * while the next step executes. This queue is that split: jobs are judged one
 * at a time in arrival order (the model endpoint is single-threaded), and the
 * run waits for them once, at the end, before it decides its status.
 *
 * A reader that stops answering is a fact about the reader, not about the
 * frames: the first job that reports an unreadable frame marks the queue blind
 * for that run, and the remaining jobs are recorded as not read instead of
 * paying the same timeout again. Nothing is reported as a pass on that account;
 * the run keeps the gap in its record (see `onBlind`).
 */

const queues = new Map();

function queueFor(runId) {
  const key = String(runId || '');
  let queue = queues.get(key);
  if (!queue) {
    queue = {
      chain: Promise.resolve(),
      pending: 0,
      ran: 0,
      jobs: 0,
      blind: false,
      blindReason: '',
      lastError: '',
    };
    queues.set(key, queue);
  }
  return queue;
}

/**
 * Queue one judgement. `run` performs it, `onBlind` records what is being
 * skipped when the reader has already been proven unreadable.
 */
export function enqueueFrameJob(runId, { kind = 'frame', run, onBlind = null } = {}) {
  const queue = queueFor(runId);
  queue.jobs += 1;
  queue.pending += 1;
  queue.chain = queue.chain.then(async () => {
    try {
      if (queue.blind) {
        if (typeof onBlind === 'function') await onBlind(queue.blindReason);
        return;
      }
      if (typeof run === 'function') {
        await run();
        queue.ran += 1;
      }
    } catch (err) {
      queue.lastError = String(err?.message || err).slice(0, 300);
      if (err?.unreadable) markReaderBlind(runId, queue.lastError);
    } finally {
      queue.pending = Math.max(0, queue.pending - 1);
    }
  });
  return queue.chain;
}

/** The reader could not read a frame: stop paying its timeout for this run. */
export function markReaderBlind(runId, reason = '') {
  const queue = queueFor(runId);
  queue.blind = true;
  if (!queue.blindReason) queue.blindReason = String(reason || 'the screen reader did not answer').slice(0, 300);
  return queue.blind;
}

export function readerIsBlind(runId) {
  return Boolean(queues.get(String(runId || ''))?.blind);
}

/** Wait for every judgement queued for this run, in order. */
export async function drainFrameQueue(runId) {
  const queue = queues.get(String(runId || ''));
  if (!queue) return { pending: 0, ran: 0, jobs: 0, blind: false, blindReason: '', lastError: '' };
  try {
    await queue.chain;
  } catch {
    // A job records its own failure; the queue keeps going either way.
  }
  return {
    pending: queue.pending,
    ran: queue.ran,
    jobs: queue.jobs,
    blind: queue.blind,
    blindReason: queue.blindReason,
    lastError: queue.lastError,
  };
}

export function clearFrameQueue(runId) {
  queues.delete(String(runId || ''));
}

export function frameQueueState(runId) {
  const queue = queues.get(String(runId || ''));
  if (!queue) return { pending: 0, ran: 0, jobs: 0, blind: false, blindReason: '', lastError: '' };
  return {
    pending: queue.pending,
    ran: queue.ran,
    jobs: queue.jobs,
    blind: queue.blind,
    blindReason: queue.blindReason,
    lastError: queue.lastError,
  };
}
