/**
 * Pages that keep changing, watched on a schedule instead of re-fetched blindly.
 *
 * A source is a URL, how often to look, and optionally where in the JSON the
 * interesting part lives. Each poll sends the validator it was given
 * (If-None-Match / If-Modified-Since), hashes what comes back, and only reports a
 * change when the hash actually differs — so "new update" means something
 * changed, not that a timer fired.
 *
 * A source marked `propose` turns a change into a proposal: a described next
 * action, open for a person to accept or dismiss. Nothing here acts on a change
 * by itself.
 *
 * Every fetch goes through the egress filter, so the host allowlist, byte
 * ceiling and content-type rules apply to sources exactly as they do elsewhere.
 */
import { createHash } from 'node:crypto';
import { now, uid } from './store.js';
import { fetchFiltered } from './egress.js';

const state = {
  sources: [],
  events: [],
  proposals: [],
  listeners: new Set(),
  timer: null,
  intervalMs: 60000,
  polls: 0,
  changes: 0,
  lastPollAt: null,
  lastError: '',
};

function excerptOf(text, jsonPath) {
  if (!jsonPath) return String(text || '').slice(0, 600);
  try {
    let value = JSON.parse(text);
    for (const key of String(jsonPath).split('.').filter(Boolean)) {
      if (value === null || value === undefined) break;
      value = Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : value[key];
    }
    if (value === undefined) return '';
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 600);
  } catch {
    return String(text || '').slice(0, 600);
  }
}

/** Add a source. The URL is not fetched until the first poll. */
export function addSource({ url, name = '', intervalMs = 0, jsonPath = '', propose = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, why: 'A source needs a valid http(s) URL.' };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, why: 'Only http and https sources are supported.' };
  const source = {
    id: uid('src'),
    name: String(name || parsed.hostname).slice(0, 80),
    url: parsed.toString(),
    intervalMs: Math.max(0, Math.min(86400000, Number(intervalMs) || 0)),
    jsonPath: String(jsonPath || '').slice(0, 200),
    propose: Boolean(propose),
    etag: '',
    lastModified: '',
    lastHash: '',
    lastAt: null,
    lastStatus: null,
    lastError: '',
    changes: 0,
    createdAt: now(),
  };
  state.sources.push(source);
  return { ok: true, source };
}

export function listSources() {
  return state.sources.map((source) => ({ ...source }));
}

export function removeSource(id) {
  const before = state.sources.length;
  state.sources = state.sources.filter((source) => source.id !== id);
  return { ok: state.sources.length !== before, removed: before - state.sources.length };
}

export function sourceEvents(limit = 20) {
  return state.events.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function listProposals() {
  return state.proposals.slice(0, 30);
}

export function dismissProposal(id) {
  const proposal = state.proposals.find((entry) => entry.id === id);
  if (!proposal) return { ok: false, why: 'No such proposal.' };
  proposal.status = 'dismissed';
  proposal.decidedAt = now();
  return { ok: true, proposal };
}

function emit(event) {
  state.events.unshift(event);
  state.events = state.events.slice(0, 60);
  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

/** Server-sent events for the console UI; returns an unsubscribe function. */
export function subscribe(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** The production fetcher: the filtered egress path, with validators. */
async function egressFetcher(url, headers) {
  const result = await fetchFiltered(url, { headers });
  if (!result.ok) return result;
  return {
    ok: true,
    status: result.status,
    notModified: result.status === 304,
    body: result.text,
    etag: result.headers?.etag || '',
    lastModified: result.headers?.lastModified || '',
    contentType: result.contentType,
  };
}

/**
 * One poll. `fetcher` replaces the network in tests; it receives the URL and the
 * validator headers and answers `{ok, status, notModified, body, etag,
 * lastModified}`.
 */
export async function pollSource(id, { fetcher = egressFetcher } = {}) {
  const source = state.sources.find((entry) => entry.id === id);
  if (!source) return { ok: false, why: 'No such source.' };
  const headers = {};
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.lastModified) headers['if-modified-since'] = source.lastModified;

  let result;
  try {
    result = await fetcher(source.url, headers);
  } catch (err) {
    result = { ok: false, why: err.message };
  }
  state.polls += 1;
  state.lastPollAt = now();
  source.lastAt = now();
  if (!result?.ok) {
    source.lastError = result?.why || 'The source could not be read.';
    source.lastStatus = result?.status ?? null;
    state.lastError = source.lastError;
    return { ok: false, why: source.lastError, changed: false };
  }
  source.lastStatus = result.status ?? 200;
  source.lastError = '';
  if (result.etag) source.etag = result.etag;
  if (result.lastModified) source.lastModified = result.lastModified;
  if (result.notModified) return { ok: true, changed: false, status: 304 };

  const text = String(result.body || '');
  const hash = createHash('sha256').update(text).digest('hex');
  if (hash === source.lastHash) return { ok: true, changed: false, status: source.lastStatus };
  const first = !source.lastHash;
  source.lastHash = hash;
  if (first) return { ok: true, changed: false, first: true, status: source.lastStatus };

  source.changes += 1;
  state.changes += 1;
  const event = {
    id: uid('evt'),
    sourceId: source.id,
    sourceName: source.name,
    url: source.url,
    at: now(),
    hash,
    bytes: text.length,
    excerpt: excerptOf(text, source.jsonPath),
  };
  emit(event);

  let proposal = null;
  if (source.propose) {
    proposal = {
      id: uid('prp'),
      at: now(),
      sourceId: source.id,
      sourceName: source.name,
      url: source.url,
      status: 'open',
      summary: `${source.name} changed: ${event.excerpt.slice(0, 200) || 'no readable excerpt'}`,
      excerpt: event.excerpt,
    };
    state.proposals.unshift(proposal);
    state.proposals = state.proposals.slice(0, 30);
  }
  return { ok: true, changed: true, event, proposal };
}

/** Poll every source that is due. Returns what each one said. */
export async function pollDue({ fetcher, at = Date.now() } = {}) {
  const results = [];
  for (const source of [...state.sources]) {
    const interval = source.intervalMs || state.intervalMs;
    const last = source.lastAt ? new Date(source.lastAt).getTime() : 0;
    if (last && at - last < interval) continue;
    results.push({ id: source.id, name: source.name, ...(await pollSource(source.id, { fetcher })) });
  }
  return results;
}

export function startLiveSources({ intervalMs = 60000, fetcher } = {}) {
  state.intervalMs = Math.max(10000, Number(intervalMs) || 60000);
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    pollDue({ fetcher }).catch((err) => {
      state.lastError = err.message;
    });
  }, Math.min(state.intervalMs, 60000));
  state.timer.unref?.();
  return liveStatus();
}

export function stopLiveSources() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  return liveStatus();
}

export function liveStatus() {
  return {
    running: Boolean(state.timer),
    intervalMs: state.intervalMs,
    sources: state.sources.length,
    polls: state.polls,
    changes: state.changes,
    lastPollAt: state.lastPollAt,
    lastError: state.lastError,
    list: listSources(),
    events: sourceEvents(8),
    proposals: listProposals().slice(0, 8),
    openProposals: state.proposals.filter((proposal) => proposal.status === 'open').length,
  };
}

export { state as __liveState };
