/**
 * A shareable link to this console, for testing from another machine.
 *
 * The console binds to 127.0.0.1 because it can drive the desktop. Sharing
 * therefore goes through a separate, token-gated proxy on its own port, and the
 * proxy is deliberately narrower than the console itself:
 *
 *   - every request needs the token (query string once, then a cookie)
 *   - requests are forwarded to the loopback console, never exposed directly
 *   - tool execution, admin routes, element picking and settings writes are
 *     refused for shared visitors
 *   - a live run asked for by a shared visitor is downgraded to a simulated run:
 *     someone else's browser may test this console, but not type on this desktop
 *
 * If cloudflared is installed, a quick tunnel is started as well and its public
 * URL is preferred; without it the link only works on the local network.
 */
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { commandOnPath } from './platform.js';

const state = {
  server: null,
  tunnel: null,
  token: '',
  port: 4318,
  targetPort: 4317,
  startedAt: null,
  lanUrl: '',
  publicUrl: '',
  visitors: new Set(),
  requests: 0,
  lastError: '',
};

const BLOCKED = [
  { test: /^\/api\/(admin|tools|element-links|python)(\/|$)/i, why: 'operator-only routes are not available through a share link' },
  { test: /^\/api\/share(\/|$)/i, why: 'sharing cannot be managed from a shared session' },
  { test: /^\/api\/settings$/i, method: /^(PATCH|PUT|POST)$/i, why: 'settings are read-only through a share link' },
];

/** First non-loopback IPv4 address, so the link is usable on the LAN. */
export function lanAddress(interfaces = os.networkInterfaces()) {
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

export function buildShareLink({ token, port = state.port, host = lanAddress(), publicUrl = '' } = {}) {
  if (!token) return '';
  if (publicUrl) return `${publicUrl}/?token=${encodeURIComponent(token)}`;
  return `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
}

function cookieToken(req) {
  const header = String(req.headers.cookie || '');
  const match = header.match(/(?:^|;\s*)sightline_share=([a-zA-Z0-9]+)/);
  return match ? match[1] : '';
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function shareStatus({ includeToken = false } = {}) {
  const active = Boolean(state.server);
  return {
    active,
    port: state.port,
    targetPort: state.targetPort,
    startedAt: state.startedAt,
    lanUrl: active ? state.lanUrl : '',
    publicUrl: active ? state.publicUrl : '',
    link: active ? buildShareLink({ token: state.token, port: state.port, publicUrl: state.publicUrl }) : '',
    token: includeToken && active ? state.token : undefined,
    visitors: state.visitors.size,
    requests: state.requests,
    tunnel: state.publicUrl ? 'cloudflared' : '',
    lastError: state.lastError,
  };
}

/** Read a request body as text, with a size cap. */
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large for a shared session.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Shared visitors may run workflows, but never against this desktop. */
export function downgradeLiveRun(pathname, bodyText) {
  if (!/^\/api\/(workflows\/[^/]+\/runs|missions)$/.test(pathname)) return bodyText;
  if (!bodyText) return bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.mode === 'live') {
      parsed.mode = 'dry';
      parsed.sharedDowngrade = true;
      return JSON.stringify(parsed);
    }
  } catch {
    // A body that is not JSON is forwarded untouched.
  }
  return bodyText;
}

function blocked(pathname, method) {
  return BLOCKED.find((rule) => rule.test.test(pathname) && (!rule.method || rule.method.test(method)));
}

function unauthorised(res) {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Sightline · share link</title>
<body style="font-family:system-ui;background:#0b0f14;color:#e6edf3;padding:40px;max-width:640px">
<h1 style="font-size:20px">This console is shared with a token</h1>
<p style="color:#9aa7b4">Open the exact link you were given. It looks like
<code style="background:#121922;padding:2px 6px;border-radius:4px">http://host:port/?token=…</code></p>
<p style="color:#9aa7b4">Requests without a valid token are refused, and live desktop control is never granted to a shared session.</p>
</body>`);
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const provided = url.searchParams.get('token') || cookieToken(req);
  if (!tokenMatches(provided, state.token)) {
    unauthorised(res);
    return;
  }
  state.requests += 1;
  state.visitors.add(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'));

  const rule = blocked(url.pathname, req.method || 'GET');
  if (rule) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: `Blocked on a share link: ${rule.why}.` }));
    return;
  }

  const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const body = downgradeLiveRun(url.pathname, rawBody.toString('utf8'));
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;
  headers['x-sightline-shared'] = '1';
  if (body) headers['content-length'] = Buffer.byteLength(body);

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: state.targetPort,
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (upstreamRes) => {
      const out = { ...upstreamRes.headers };
      if (url.searchParams.get('token')) {
        out['set-cookie'] = [`sightline_share=${state.token}; Path=/; HttpOnly; SameSite=Lax`];
      }
      res.writeHead(upstreamRes.statusCode || 502, out);
      upstreamRes.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: `The console is not answering: ${err.message}` }));
    } else {
      res.end();
    }
  });
  if (body.length) upstream.write(body);
  upstream.end();
}

function startTunnel(port) {
  if (!commandOnPath('cloudflared')) return null;
  try {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const scan = (chunk) => {
      const text = String(chunk);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !state.publicUrl) state.publicUrl = match[0];
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', () => {
      state.publicUrl = '';
      state.tunnel = null;
    });
    return child;
  } catch {
    return null;
  }
}

/** Start the share proxy. Resolves once it is listening. */
export function startShare({ port = 4318, targetPort = 4317, tunnel = true } = {}) {
  if (state.server) return Promise.resolve(shareStatus({ includeToken: true }));
  return new Promise((resolve) => {
    state.port = Math.max(1024, Math.min(65535, Number(port) || 4318));
    state.targetPort = Math.max(1024, Math.min(65535, Number(targetPort) || 4317));
    state.token = randomBytes(18).toString('hex');
    state.startedAt = null;
    state.publicUrl = '';
    state.requests = 0;
    state.visitors.clear();
    state.lastError = '';

    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    });
    server.on('error', (err) => {
      state.lastError = `Could not listen on port ${state.port}: ${err.message}`;
      state.server = null;
      resolve(shareStatus({ includeToken: true }));
    });
    server.listen(state.port, '0.0.0.0', () => {
      state.server = server;
      state.startedAt = new Date().toISOString();
      state.lanUrl = `http://${lanAddress()}:${state.port}`;
      if (tunnel) {
        state.tunnel = startTunnel(state.port);
        if (!state.tunnel) {
          state.lastError = 'cloudflared is not installed, so the link only works on this network.';
        }
      }
      resolve(shareStatus({ includeToken: true }));
    });
  });
}

export function stopShare() {
  if (state.tunnel) {
    try {
      state.tunnel.kill();
    } catch {
      // The tunnel may already be gone.
    }
    state.tunnel = null;
  }
  if (state.server) {
    try {
      state.server.close();
    } catch {
      // Already closed.
    }
    state.server = null;
  }
  state.startedAt = null;
  state.publicUrl = '';
  return shareStatus();
}

export { state as __shareState };
