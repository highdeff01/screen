/**
 * The console's client for the Sightline bench — the standalone tester that
 * watches repos, auto-tests every detected change, reviews cross-app
 * proposals and asks the operator questions through popups.
 *
 * This module never tests anything itself; it talks to the bench's HTTP API
 * on 127.0.0.1:4319 and keeps a cached picture for the UI:
 *   - health and latency of the link
 *   - the bench's watched targets and their last verdicts
 *   - open popups, so "what I'm trying to do next" appears on this screen
 *   - recent runs and failing tests
 *
 * The bench being offline is normal and quiet — the console says so in the
 * state instead of erroring, and the poll keeps trying.
 */
import { db, now } from './store.js';

const BASE = () => String(db().settings.benchUrl || 'http://127.0.0.1:4319').replace(/\/+$/, '');

const state = {
  timer: null,
  busy: false,
  online: null,
  lastCheckAt: null,
  lastOkAt: null,
  lastError: '',
  latencyMs: null,
  targets: [],
  runs: [],
  popups: [],
  checks: 0,
  failures: 0,
};

export function benchStatus() {
  return {
    url: BASE(),
    online: state.online,
    running: Boolean(state.timer),
    lastCheckAt: state.lastCheckAt,
    lastOkAt: state.lastOkAt,
    lastError: state.lastError,
    latencyMs: state.latencyMs,
    targets: state.targets,
    runs: state.runs,
    popups: state.popups,
    openPopups: state.popups.length,
    checks: state.checks,
    failures: state.failures,
  };
}

/** One HTTP call to the bench. Never throws; offline is a result, not a crash. */
export async function benchCall(path, { method = 'GET', body = null, timeoutMs = 8000, fetchFn = null } = {}) {
  const doFetch = fetchFn || fetch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(`${BASE()}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
    const parsed = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body: parsed };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.name === 'AbortError' ? `The bench did not answer within ${timeoutMs / 1000}s.` : String(err.message || err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One poll: health, targets with verdicts, and open popups. */
export async function pollBench({ fetchFn = null } = {}) {
  state.lastCheckAt = now();
  state.checks += 1;
  const started = Date.now();
  const health = await benchCall('/api/health', { fetchFn });
  state.latencyMs = Date.now() - started;
  if (!health.ok) {
    state.online = false;
    state.failures += 1;
    state.lastError = health.error || `The bench answered ${health.status}.`;
    state.popups = [];
    return benchStatus();
  }
  state.online = true;
  state.lastOkAt = state.lastCheckAt;
  state.lastError = '';
  const [status, popups] = await Promise.all([
    benchCall('/api/status', { fetchFn }),
    benchCall('/api/popup', { fetchFn }),
  ]);
  state.targets = status.body?.targets || [];
  state.runs = status.body?.runs || [];
  state.popups = popups.body?.popups || [];
  return benchStatus();
}

/** The poll loop. */
export function startBenchWatch({ intervalMs } = {}) {
  const configured = Math.max(5000, Number(intervalMs) || Number(db().settings.benchWatchMs) || 15000);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (state.busy) return;
    state.busy = true;
    pollBench()
      .catch((err) => {
        state.online = false;
        state.lastError = String(err.message || err);
      })
      .finally(() => {
        state.busy = false;
      });
  }, configured);
  state.timer.unref?.();
  return benchStatus();
}

export function stopBenchWatch() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return benchStatus();
}

/** Answer a bench popup from this screen; the decision flows to the bench. */
export async function answerBenchPopup(id, decision, { fetchFn = null, by = 'operator' } = {}) {
  const result = await benchCall(`/api/popup/${id}/resolve`, { method: 'POST', body: { decision, by }, fetchFn });
  await pollBench({ fetchFn });
  return result;
}

/** Ask the bench to test a target right now. */
export async function testBenchTarget(targetId, { fetchFn = null } = {}) {
  const result = await benchCall(`/api/test/${targetId}`, { method: 'POST', fetchFn, timeoutMs: 600000 });
  await pollBench({ fetchFn });
  return result;
}

/** Watch a new repository on the bench (kind and command are inferred there). */
export async function addBenchTarget(options = {}, { fetchFn = null } = {}) {
  const { path, branch, testCommand, name } = options;
  const result = await benchCall('/api/targets', { method: 'POST', body: { path, branch, testCommand, name }, fetchFn });
  await pollBench({ fetchFn });
  return result;
}

export { state as __benchState };
