import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildShareLink, downgradeLiveRun, lanAddress, startShare, stopShare } from '../server/share.js';

test('the share link carries the token and the right host', () => {
  assert.equal(
    buildShareLink({ token: 'abc123', port: 4318, host: '192.168.1.112' }),
    'http://192.168.1.112:4318/?token=abc123'
  );
  assert.equal(
    buildShareLink({ token: 'abc123', port: 4318, publicUrl: 'https://example.trycloudflare.com' }),
    'https://example.trycloudflare.com/?token=abc123'
  );
  assert.equal(buildShareLink({ token: '' }), '');
});

test('the LAN address skips loopback and internal interfaces', () => {
  assert.equal(lanAddress({}), '127.0.0.1');
  assert.equal(
    lanAddress({
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '10.0.0.5' },
      ],
    }),
    '10.0.0.5'
  );
});

test('a shared visitor can never ask for a live run', () => {
  const downgraded = JSON.parse(downgradeLiveRun('/api/workflows/wf_1/runs', '{"mode":"live","trigger":"manual"}'));
  assert.equal(downgraded.mode, 'dry');
  assert.equal(downgraded.sharedDowngrade, true);

  const dry = '{"mode":"dry"}';
  assert.equal(downgradeLiveRun('/api/workflows/wf_1/runs', dry), dry);

  // Other routes are unchanged; invalid bodies must not pass through.
  assert.equal(downgradeLiveRun('/api/workflows', '{"mode":"live"}'), '{"mode":"live"}');
  assert.throws(() => downgradeLiveRun('/api/workflows/wf_1/runs', 'not json'));
  assert.equal(JSON.parse(downgradeLiveRun('/api/missions', '')).mode, 'dry');
  assert.equal(JSON.parse(downgradeLiveRun('/api/missions', '{}')).mode, 'dry');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

function request(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('share proxy only forwards safe reads and dry executions', async (t) => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const targetPort = await listen(upstream);
  t.after(() => close(upstream));

  // Reserve an OS-assigned port for startShare, which does not accept port 0.
  const reservation = http.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const share = await startShare({ port, targetPort, tunnel: false });
  assert.equal(share.active, true, share.lastError);
  t.after(() => stopShare());
  const token = share.token;
  const auth = { cookie: `sightline_share=${token}` };

  assert.equal((await request(port, '/api/state')).status, 401);
  assert.equal(received.length, 0);
  const get = await request(port, '/api/state?view=all', { headers: auth });
  assert.equal(get.status, 200);
  assert.equal(received[0].path, '/api/state?view=all');
  assert.equal(received[0].headers.host, `127.0.0.1:${port}`);
  assert.equal(received[0].headers['x-sightline-shared'], '1');
  assert.equal((await request(port, '/', { method: 'HEAD', headers: auth })).status, 200);
  const tokenGet = await request(port, `/?token=${token}`);
  assert.equal(tokenGet.status, 200);
  assert.match(tokenGet.headers['set-cookie'][0], /^sightline_share=/);

  const blocked = [
    ['POST', '/api/control'], ['POST', '/api/shortcuts/habits/h/replay'],
    ['POST', '/api/missions/m/resume'], ['POST', '/api/workflows/w/runs/r/retry'],
    ['POST', '/api/tools/t/run'], ['POST', '/api/files/write'],
    ['POST', '/api/commands/c1/run'], ['DELETE', '/api/commands/c1'],
    ['POST', '/api/git/pull'], ['POST', '/api/git/conflicts/ai'],
    ['POST', '/api/git/prs/fetch'], ['POST', '/api/git/merge'], ['PATCH', '/api/handoff'],
    ['PATCH', '/api/settings'], ['PUT', '/api/missions'], ['DELETE', '/api/missions/m'],
    ['OPTIONS', '/api/state'], ['GET', '/api/admin'], ['GET', '/api/tools'],
    ['HEAD', '/api/element-links'], ['GET', '/api/python/file/download'],
    ['GET', '/api/share'], ['GET', '/api/ambient/refresh'], ['HEAD', '/api/ambient/refresh'],
  ];
  for (const [method, path] of blocked) {
    const before = received.length;
    const result = await request(port, path, { method, headers: auth, body: method === 'POST' ? '{}' : undefined });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(received.length, before, `${method} ${path} reached upstream`);
  }

  // A keep-alive client gets the 403 itself, not a reset from an unread body.
  const keepAlive = new http.Agent({ keepAlive: true });
  const viaAgent = (path, method) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: auth, agent: keepAlive }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(await viaAgent('/api/git/pull', 'POST'), 403);
  assert.equal(await viaAgent('/api/commands/c1/run', 'POST'), 403);
  keepAlive.destroy();

  // Git, note and command mutations name the reason, not just the method gate.
  const commandRun = await request(port, '/api/commands/c1/run', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(commandRun.status, 403);
  assert.match(JSON.parse(commandRun.body).error, /own machine/);
  const gitMerge = await request(port, '/api/git/merge', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(gitMerge.status, 403);
  assert.match(JSON.parse(gitMerge.body).error, /own machine/);

  for (const path of ['/api/workflows/wf_1/runs', '/api/missions']) {
    for (const body of ['{"mode":"live","goal":"test"}', '{}', '', '{"mode":"dry"}', '{"mode":"other"}']) {
      const before = received.length;
      const result = await request(port, path, {
        method: 'POST', body, headers: { ...auth, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      });
      assert.equal(result.status, 200, `${path} ${body}`);
      assert.equal(received.length, before + 1);
      const forwarded = received.at(-1);
      assert.equal(JSON.parse(forwarded.body).mode, 'dry');
      assert.equal(forwarded.headers.host, `127.0.0.1:${port}`);
      assert.equal(forwarded.headers.origin, `http://127.0.0.1:${port}`);
      assert.equal(Number(forwarded.headers['content-length']), Buffer.byteLength(forwarded.body));
      if (body.includes('goal')) assert.equal(JSON.parse(forwarded.body).goal, 'test');
    }
    for (const body of ['not json', '{', 'null', '[]', '"live"', '3', 'true', ' ']) {
      const before = received.length;
      const result = await request(port, path, { method: 'POST', body, headers: auth });
      assert.equal(result.status, 400, `${path} ${body}`);
      assert.equal(received.length, before, `${path} ${body} reached upstream`);
    }
  }
});
