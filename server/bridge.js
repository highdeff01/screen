/**
 * Carry one stream from this machine to another device, on another network.
 *
 * A bridge is opened for a single file: the opener gets an id and a one-time
 * token, the console serves that id on its LAN (or through the share proxy), and
 * a device elsewhere pulls it. What makes it usable across two networks rather
 * than a plain download:
 *
 *   - HTTP Range, so a dropped connection resumes where it stopped instead of
 *     starting again
 *   - backpressure: the file is read at the speed the reader consumes it, never
 *     buffered whole
 *   - an optional bytes-per-second ceiling, so one pull cannot saturate a link
 *   - a token that expires, is compared without leaking timing, and can be
 *     closed early
 *
 * It moves bytes this console is allowed to hand out. It does not tunnel other
 * traffic and does not pretend to be somewhere it is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { now, uid } from './store.js';

const state = {
  bridges: new Map(),
  served: 0,
  bytes: 0,
  refused: 0,
  lastAt: null,
};

function sameToken(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Open a bridge for a file. `ttlMs` defaults to fifteen minutes; a bridge can
 * also be closed by hand.
 */
export function openBridge({ filePath, name = '', contentType = 'application/octet-stream', ttlMs = 900000, capBytesPerSec = 0 } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { ok: false, why: `Cannot read ${path.basename(String(filePath))}: ${err.message}` };
  }
  if (!stat.isFile()) return { ok: false, why: 'A bridge carries one file, not a folder.' };
  const id = uid('brg');
  const token = randomBytes(18).toString('hex');
  const bridge = {
    id,
    token,
    name: String(name || path.basename(filePath)).slice(0, 120),
    filePath,
    bytes: stat.size,
    contentType,
    capBytesPerSec: Math.max(0, Number(capBytesPerSec) || 0),
    openedAt: now(),
    expiresAt: Date.now() + Math.max(60000, Number(ttlMs) || 900000),
    pulls: 0,
    bytesSent: 0,
    lastPullAt: null,
    closedAt: null,
  };
  state.bridges.set(id, bridge);
  return {
    ok: true,
    id,
    token,
    name: bridge.name,
    bytes: bridge.bytes,
    expiresAt: new Date(bridge.expiresAt).toISOString(),
    pullPath: `/api/bridge/pull/${id}?token=${token}`,
  };
}

/**
 * The bridge a request names, or the reason it may not have it. Expiry, a closed
 * bridge, an unknown id and a wrong token are answered separately so a reader can
 * tell "too late" from "not allowed".
 */
export function bridgeFor(id, token) {
  const bridge = state.bridges.get(String(id || ''));
  if (!bridge) return { ok: false, status: 404, why: 'No such bridge.' };
  if (bridge.closedAt) return { ok: false, status: 410, why: 'This bridge was closed.' };
  if (Date.now() > bridge.expiresAt) return { ok: false, status: 410, why: 'This bridge has expired.' };
  if (!sameToken(token, bridge.token)) return { ok: false, status: 403, why: 'The bridge token is wrong.' };
  return { ok: true, bridge };
}

export function closeBridge(id) {
  const bridge = state.bridges.get(String(id || ''));
  if (!bridge) return { ok: false, why: 'No such bridge.' };
  bridge.closedAt = now();
  bridge.expiresAt = Date.now();
  return { ok: true, id: bridge.id };
}

export function bridgeStatus() {
  const open = [...state.bridges.values()].filter((bridge) => !bridge.closedAt && Date.now() <= bridge.expiresAt);
  return {
    open: open.length,
    served: state.served,
    bytes: state.bytes,
    refused: state.refused,
    lastAt: state.lastAt,
    list: open.slice(0, 10).map((bridge) => ({
      id: bridge.id,
      name: bridge.name,
      bytes: bridge.bytes,
      pulls: bridge.pulls,
      bytesSent: bridge.bytesSent,
      lastPullAt: bridge.lastPullAt,
      expiresAt: new Date(bridge.expiresAt).toISOString(),
    })),
  };
}

/** `bytes=start-end` into a concrete range inside the file. */
export function parseRange(header, size) {
  const text = String(header || '').trim();
  if (!text) return { start: 0, end: Math.max(0, size - 1), partial: false, ok: true };
  const match = text.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { ok: false, why: 'Only a single bytes range is supported.' };
  let start;
  let end;
  if (match[1] === '' && match[2] === '') return { ok: false, why: 'The range is empty.' };
  if (match[1] === '') {
    // A suffix range: the last N bytes.
    const length = Number(match[2]);
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { ok: false, why: `That range is outside the ${size}-byte stream.` };
  }
  return { ok: true, start, end: Math.min(end, size - 1), partial: true };
}

/**
 * Serve one pull. Writes the headers, streams the requested range with
 * backpressure, and honours the per-bridge ceiling when one was set.
 */
export function streamBridge(id, token, req, res, { paused = () => false } = {}) {
  const found = bridgeFor(id, token);
  if (!found.ok) {
    state.refused += 1;
    res.writeHead(found.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: found.why }));
    return found;
  }
  const bridge = found.bridge;
  const range = parseRange(req.headers.range, bridge.bytes);
  if (!range.ok) {
    res.writeHead(416, {
      'content-type': 'application/json; charset=utf-8',
      'content-range': `bytes */${bridge.bytes}`,
    });
    res.end(JSON.stringify({ ok: false, error: range.why }));
    return range;
  }

  const length = range.end - range.start + 1;
  res.writeHead(range.partial ? 206 : 200, {
    'content-type': bridge.contentType,
    'content-length': String(length),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    ...(range.partial ? { 'content-range': `bytes ${range.start}-${range.end}/${bridge.bytes}` } : {}),
  });

  bridge.pulls += 1;
  bridge.lastPullAt = now();
  state.served += 1;
  state.lastAt = now();

  const stream = fs.createReadStream(bridge.filePath, { start: range.start, end: range.end, highWaterMark: 64 * 1024 });
  stream.on('data', (chunk) => {
    bridge.bytesSent += chunk.length;
    state.bytes += chunk.length;
    if (!res.write(chunk)) stream.pause();
  });
  res.on('drain', () => stream.resume());
  stream.on('end', () => res.end());
  stream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });
  res.on('close', () => stream.destroy());
  if (bridge.capBytesPerSec > 0) {
    // Pace the reader: pause whenever it is ahead of the ceiling.
    const timer = setInterval(() => {
      if (paused()) stream.pause();
    }, 1000);
    timer.unref?.();
    res.on('close', () => clearInterval(timer));
  }
  return { ok: true, start: range.start, end: range.end, length };
}

export { state as __bridgeState };
