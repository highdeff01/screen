/**
 * The stream's push channel: frames, labels and decisions rendered as they
 * happen, plus the ping that keeps the pipe open.
 *
 * Polling `/api/vision` every second was the last place the console still paid
 * for latency it did not have to. The engine already knows the instant a frame
 * was kept and the review agent knows the instant a label landed; this is the
 * fan-out that hands both to a connected browser in the same tick. One write
 * per event, no per-client timers, no buffer per client.
 *
 * Keep-alive is explicit. A browser, a reverse proxy or a laptop that slept can
 * all drop an idle connection silently, and the SSE client then waits forever
 * for an event that will never come. A comment line every `pingMs` makes the
 * connection's liveness visible to both ends without an application message; the
 * client's `onopen`/`onerror` then tells the operator the truth.
 *
 * Slow clients are not dropped for being slow: a frame event is dropped for a
 * client whose socket is backed up (`write` returned false) while pings and
 * decisions keep flowing, because a viewer that missed a frame can ask for the
 * current one and a viewer that missed a decision cannot.
 */
export const PING_MS = 15000;
export const MAX_CLIENTS = 8;

export function createVisionBus({
  pingMs = PING_MS,
  maxClients = MAX_CLIENTS,
  schedule = setInterval,
  cancel = clearInterval,
  clock = () => Date.now(),
} = {}) {
  const clients = new Map();
  let nextId = 0;
  let events = 0;
  let pings = 0;
  let dropped = 0;
  let skipped = 0;
  let timer = null;

  function startPing() {
    if (timer !== null || !clients.size) return;
    timer = schedule(() => {
      if (!clients.size) return;
      pingNow();
    }, pingMs);
    timer?.unref?.();
  }

  function stopPing() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function write(client, chunk) {
    try {
      const flushed = client.res.write(chunk);
      client.slow = flushed === false;
      return true;
    } catch {
      drop(client, 'the connection closed while writing');
      return false;
    }
  }

  function frame(client, type, data) {
    return write(client, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function drop(client, reason = '') {
    if (!client) return false;
    clients.delete(client.id);
    client.reason = reason;
    dropped += 1;
    if (!clients.size) stopPing();
    try {
      client.res.end();
    } catch {
      // Already finished.
    }
    return true;
  }

  /**
   * Attach a response as an SSE client. Returns the client handle so the route
   * can close it when the request is aborted.
   */
  function subscribe(res, { session = 'main', hello = null } = {}) {
    if (clients.size >= maxClients) {
      throw Object.assign(new Error(`The vision stream already has ${clients.size} viewer(s); close one and try again.`), { busy: true });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client = { id: ++nextId, res, session: String(session || 'main'), slow: false, at: clock() };
    clients.set(client.id, client);
    write(client, 'retry: 3000\n\n');
    write(client, `event: ready\ndata: ${JSON.stringify({ client: client.id, session: client.session, pingMs, ...(hello || {}) })}\n\n`);
    res.on?.('close', () => {
      clients.delete(client.id);
      if (!clients.size) stopPing();
    });
    startPing();
    return { id: client.id, session: client.session, close: (reason = 'closed by the console') => drop(client, reason) };
  }

  /** Fan one event out. `frame` events may be skipped for a backed-up viewer. */
  function publish(type, data = {}) {
    events += 1;
    const kind = String(type || 'event');
    for (const client of [...clients.values()]) {
      if (kind === 'frame' && client.slow) {
        skipped += 1;
        continue;
      }
      if (data.session !== undefined && data.session !== client.session) continue;
      frame(client, kind, { ...data, at: data.at || new Date(clock()).toISOString() });
    }
    return clients.size;
  }

  /** One keep-alive comment line, to every viewer, now. */
  function pingNow() {
    pings += 1;
    for (const client of [...clients.values()]) write(client, `: ping ${pings}\n\n`);
    return pings;
  }

  function state() {
    return {
      clients: clients.size,
      sessions: [...new Set([...clients.values()].map((client) => client.session))],
      events,
      pings,
      dropped,
      skipped,
      pingMs,
      maxClients,
      lastAt: clients.size ? new Date(clock()).toISOString() : null,
    };
  }

  function stop() {
    stopPing();
    for (const client of [...clients.values()]) drop(client, 'the console is shutting down');
    return state();
  }

  return { subscribe, publish, pingNow, state, stop };
}

export const visionBus = createVisionBus();
