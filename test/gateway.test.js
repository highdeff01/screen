import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-gateway-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const gateway = await load('server/gateway.js');
const llm = await load('server/llm.js');

function completion(content) {
  return {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'qwen3.5:2b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

// A stand-in for the console's Ollama provider: no keys, no network, and it
// records what the gateway forwards so routing is provable.
function providerFixture() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.5:2b', object: 'model', owned_by: 'ollama' }] }));
      }
      // The gateway's ollama provider speaks Ollama's OpenAI-compatible surface.
      if (req.url === '/v1/chat/completions') {
        seen.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(completion('fixture pong')));
      }
      // A direct (gateway-off) call still uses the console's own Ollama route.
      if (req.url === '/api/chat') {
        seen.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ model: 'qwen3.5:2b', message: { role: 'assistant', content: 'fixture pong' }, done: true }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return { server, seen };
}

let fixture = null;
let fixturePort = 0;
let gatewayRuntimeAvailable = false;
try {
  execFileSync(gateway.gatewayStatus().python, ['-c', 'import respan_gateway'], { stdio: 'ignore' });
  gatewayRuntimeAvailable = true;
} catch {}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function settings(overrides = {}) {
  const s = store.db().settings;
  Object.assign(s, {
    apiStyle: 'ollama',
    chatPath: '/api/chat',
    baseUrl: `http://127.0.0.1:${fixturePort}`,
    // A dead direct endpoint: only the gateway can make the routed call succeed.
    endpoint: 'http://127.0.0.1:9/api/chat',
    model: 'qwen3.5:2b',
    replanModel: '',
    gatewayEnabled: false,
    gatewayPort: 0,
    gatewayKeyEnv: '',
    ...overrides,
  });
  return s;
}

after(async () => {
  gateway.stopGateway();
  if (fixture) await close(fixture.server);
  store.flush();
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('the generated config serves the console provider on loopback with a route per model', () => {
  const toml = gateway.gatewayConfigToml(
    { apiStyle: 'ollama', baseUrl: 'http://127.0.0.1:5555', model: 'qwen3.5:2b', replanModel: 'qwen3.5:2b' },
    { port: 4319 }
  );
  assert.match(toml, /listen = "127\.0\.0\.1:4319"/);
  assert.match(toml, /\[providers\.app\]\nvendor   = "ollama"/);
  assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:5555\/v1"/);
  assert.match(toml, /\[routes\."qwen3\.5:2b"\]\nto    = "app\/qwen3\.5:2b"/);
  assert.equal((toml.match(/\[routes\./g) || []).length, 1, 'one route for the one configured model');
});

test('an OpenAI-style provider is declared as openai-chat and its key stays an env reference', () => {
  const toml = gateway.gatewayConfigToml(
    { apiStyle: 'openai', baseUrl: 'https://api.example.test', model: 'gpt-test', gatewayKeyEnv: 'OPENAI_API_KEY' },
    { port: 4319 }
  );
  assert.match(toml, /formats  = \["openai-chat"\]/);
  assert.match(toml, /base_url = "https:\/\/api\.example\.test\/v1"/);
  assert.match(toml, /key      = "env:OPENAI_API_KEY"/);
  assert.doesNotMatch(toml, /sk-/);
});

test('the gateway stays off until it is enabled in settings', async () => {
  fixture = providerFixture();
  fixturePort = await listen(fixture.server);
  settings({ gatewayEnabled: false });
  assert.equal(gateway.gatewayStatus().running, false);
  assert.equal(await gateway.ensureGateway(), null);
});

test('chat() reaches the console provider through the local gateway', { skip: !gatewayRuntimeAvailable && 'Respan Gateway Python package is not installed' }, async () => {
  settings({ gatewayEnabled: true });
  fixture.seen.length = 0;
  const reply = await llm.chat([{ role: 'user', content: 'ping' }], { timeoutMs: 60000 });
  const status = gateway.gatewayStatus();
  assert.equal(reply.ok, true, reply.error || status.error);
  assert.equal(reply.content, 'fixture pong');
  assert.equal(status.running, true);
  assert.match(status.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(status.chatUrl, /\/v1\/chat\/completions$/);
  assert.ok(fixture.seen.length >= 1, 'the provider saw the forwarded call');
  assert.equal(fixture.seen[0].model, 'qwen3.5:2b');
  const usage = store.db().usage[0];
  assert.equal(usage.via, 'gateway');
});

test('chat() still calls the provider directly when the gateway is disabled', async () => {
  settings({ gatewayEnabled: false, endpoint: `http://127.0.0.1:${fixturePort}/api/chat` });
  fixture.seen.length = 0;
  const reply = await llm.chat([{ role: 'user', content: 'ping again' }], { timeoutMs: 60000 });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.content, 'fixture pong');
  assert.equal(fixture.seen.length, 1);
  assert.equal(fixture.seen[0].stream, false);
  assert.notEqual(store.db().usage[0].via, 'gateway');
});
