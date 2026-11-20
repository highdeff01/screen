/**
 * One way out to the network, with the rules written down.
 *
 * Anything that fetches on the console's behalf — a live source, an agent
 * gathering facts, a bridge pulling an upstream file — goes through here so the
 * limits are in one place:
 *
 *   - only http(s), and only hosts the operator allows once an allowlist exists
 *   - loopback and private ranges stay closed unless explicitly permitted
 *   - a byte ceiling, enforced while reading rather than after buffering
 *   - a content-type allowlist, so a "page" cannot arrive as an executable
 *   - a requests-per-minute ceiling per process
 *   - an optional gate that can read the payload and refuse it before the caller
 *     ever sees it (this is where an AI filter is plugged in)
 *   - an audit line for every attempt, allowed or refused
 *
 * It deliberately does not hide where a request comes from and does not bypass
 * another site's authentication, paywall or regional blocks: it is a filter in
 * front of an ordinary fetch, not a way around one.
 */

const AUDIT_KEEP = 60;

const state = {
  policy: {
    allowHosts: [],
    allowLocal: false,
    maxBytes: 8 * 1024 * 1024,
    types: ['application/json', 'text/html', 'text/plain', 'application/xml', 'text/xml'],
    perMinute: 90,
    aiGate: false,
    userAgent: 'Sightline/1.0 (+local console)',
  },
  window: [],
  audit: [],
  stats: { allowed: 0, blocked: 0, bytes: 0 },
};

function normalisePolicy(patch = {}) {
  const next = { ...state.policy };
  if (patch.allowHosts !== undefined) {
    next.allowHosts = (Array.isArray(patch.allowHosts) ? patch.allowHosts : String(patch.allowHosts || '').split(/[,\s]+/))
      .map((host) => String(host || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 200);
  }
  if (patch.allowLocal !== undefined) next.allowLocal = Boolean(patch.allowLocal);
  if (patch.maxBytes !== undefined) next.maxBytes = Math.max(1024, Math.min(512 * 1024 * 1024, Number(patch.maxBytes) || 8 * 1024 * 1024));
  if (patch.types !== undefined) {
    next.types = (Array.isArray(patch.types) ? patch.types : String(patch.types || '').split(','))
      .map((type) => String(type || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 40);
  }
  if (patch.perMinute !== undefined) next.perMinute = Math.max(1, Math.min(6000, Number(patch.perMinute) || 90));
  if (patch.aiGate !== undefined) next.aiGate = Boolean(patch.aiGate);
  return next;
}

export function setPolicy(patch = {}) {
  state.policy = normalisePolicy(patch);
  return egressStatus();
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

function hostAllowed(hostname, policy) {
  const host = String(hostname || '').toLowerCase();
  const list = policy.allowHosts || [];
  if (!list.length) return true;
  return list.some((pattern) => {
    if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

/** Decide whether a URL may be requested at all, before any socket is opened. */
export function checkUrl(rawUrl, policy = state.policy) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, host: '', why: 'That is not a valid URL.' };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, host: url.hostname, why: `Only http and https are allowed, not ${url.protocol}` };
  }
  if (isPrivateHost(url.hostname) && !policy.allowLocal) {
    return { ok: false, host: url.hostname, why: 'Loopback and private network addresses need allowLocal turned on.' };
  }
  if (!hostAllowed(url.hostname, policy)) {
    return { ok: false, host: url.hostname, why: `${url.hostname} is not on the allowed host list.` };
  }
  return { ok: true, host: url.hostname, why: '' };
}

function rateLimited(policy, at = Date.now()) {
  state.window = state.window.filter((stamp) => at - stamp < 60000);
  if (state.window.length >= policy.perMinute) return true;
  state.window.push(at);
  return false;
}

function typeAllowed(contentType, policy) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!type) return true;
  return (policy.types || []).some((allowed) => (allowed.endsWith('/') ? type.startsWith(allowed) : type === allowed || type.startsWith(`${allowed}+`)));
}

function audit(entry) {
  state.audit.unshift(entry);
  state.audit = state.audit.slice(0, AUDIT_KEEP);
}

export function auditLog(limit = 30) {
  return state.audit.slice(0, Math.max(1, Math.min(AUDIT_KEEP, Number(limit) || 30)));
}

export function egressStatus() {
  return {
    policy: { ...state.policy, allowHosts: [...state.policy.allowHosts], types: [...state.policy.types] },
    stats: { ...state.stats },
    recent: state.audit.slice(0, 12),
  };
}

/**
 * Fetch through the policy. Never throws for a refusal: the caller gets
 * `{ok:false, why}` plus an audit line, because "the filter said no" is a normal
 * answer for an agent to receive and report.
 */
export async function fetchFiltered(rawUrl, {
  headers = {},
  policy = state.policy,
  gate = null,
  fetchImpl = null,
  timeoutMs = 20000,
  maxBytes = null,
} = {}) {
  const started = Date.now();
  const verdict = checkUrl(rawUrl, policy);
  const host = verdict.host;
  if (!verdict.ok) {
    state.stats.blocked += 1;
    audit({ at: new Date().toISOString(), url: String(rawUrl).slice(0, 300), host, ok: false, status: 0, bytes: 0, ms: 0, why: verdict.why });
    return { ok: false, why: verdict.why, host, status: 0 };
  }
  if (rateLimited(policy)) {
    state.stats.blocked += 1;
    const why = `More than ${policy.perMinute} request(s) in a minute; the next one waits.`;
    audit({ at: new Date().toISOString(), url: String(rawUrl).slice(0, 300), host, ok: false, status: 0, bytes: 0, ms: 0, why });
    return { ok: false, why, host, status: 0 };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 20000));
  const limit = Math.max(1024, Number(maxBytes) || policy.maxBytes);
  try {
    const res = await doFetch(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': policy.userAgent, accept: '*/*', ...headers },
    });
    const contentType = String(res.headers?.get?.('content-type') || '');
    const finalUrl = res.url || String(rawUrl);
    const finalCheck = checkUrl(finalUrl, policy);
    if (!finalCheck.ok) {
      state.stats.blocked += 1;
      const why = `The request was redirected somewhere it may not go: ${finalCheck.why}`;
      audit({ at: new Date().toISOString(), url: finalUrl.slice(0, 300), host: finalCheck.host, ok: false, status: res.status || 0, bytes: 0, ms: Date.now() - started, why });
      return { ok: false, why, host: finalCheck.host, status: res.status || 0 };
    }
    if (!typeAllowed(contentType, policy)) {
      state.stats.blocked += 1;
      const why = `Content type ${contentType || 'unknown'} is not on the allowed list.`;
      audit({ at: new Date().toISOString(), url: finalUrl.slice(0, 300), host: finalCheck.host, ok: false, status: res.status || 0, bytes: 0, ms: Date.now() - started, why });
      return { ok: false, why, host: finalCheck.host, status: res.status || 0, contentType };
    }

    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    const reader = res.body?.getReader?.();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > limit) {
          tooBig = true;
          try {
            await reader.cancel();
          } catch {
            // The stream may already be closed.
          }
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
    if (tooBig) {
      state.stats.blocked += 1;
      const why = `The response is larger than the ${limit}-byte ceiling; the rest was not read.`;
      audit({ at: new Date().toISOString(), url: finalUrl.slice(0, 300), host: finalCheck.host, ok: false, status: res.status || 0, bytes, ms: Date.now() - started, why });
      return { ok: false, why, host: finalCheck.host, status: res.status || 0, contentType, bytes };
    }

    const body = Buffer.concat(chunks);
    const text = body.toString('utf8');

    if ((policy.aiGate || gate) && typeof gate === 'function') {
      const decision = await gate({ url: finalUrl, contentType, text, bytes: body.length });
      if (decision && decision.allow === false) {
        state.stats.blocked += 1;
        const why = decision.reason || 'The gate refused this content.';
        audit({ at: new Date().toISOString(), url: finalUrl.slice(0, 300), host: finalCheck.host, ok: false, status: res.status || 0, bytes: body.length, ms: Date.now() - started, why });
        return { ok: false, why, host: finalCheck.host, status: res.status || 0, contentType, bytes: body.length };
      }
    }

    state.stats.allowed += 1;
    state.stats.bytes += body.length;
    audit({ at: new Date().toISOString(), url: finalUrl.slice(0, 300), host: finalCheck.host, ok: true, status: res.status || 200, bytes: body.length, ms: Date.now() - started, why: '' });
    return {
      ok: true,
      status: res.status || 200,
      contentType,
      bytes: body.length,
      text,
      body,
      url: finalUrl,
      headers: {
        etag: String(res.headers?.get?.('etag') || ''),
        lastModified: String(res.headers?.get?.('last-modified') || ''),
      },
    };
  } catch (err) {
    state.stats.blocked += 1;
    const why = err?.name === 'AbortError' ? `No answer within ${timeoutMs}ms.` : err.message;
    audit({ at: new Date().toISOString(), url: String(rawUrl).slice(0, 300), host, ok: false, status: 0, bytes: 0, ms: Date.now() - started, why });
    return { ok: false, why, host, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export { state as __egressState, isPrivateHost, hostAllowed, typeAllowed };
