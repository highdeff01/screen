import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sightline-local-model-'));
process.chdir(tempRoot);

const store = await import('../server/store.js');
const local = await import('../server/local-model.js');

test('the catalog only offers GGUF files over https with a license', () => {
  assert.ok(local.MODEL_CATALOG.length >= 2);
  for (const entry of local.MODEL_CATALOG) {
    assert.match(entry.url, /^https:\/\//, entry.id);
    assert.match(entry.file, /\.gguf$/, entry.id);
    assert.ok(entry.bytes > 50_000_000, `${entry.id} has a plausible size`);
    assert.match(entry.license, /\S/, `${entry.id} records a license`);
  }
  assert.equal(local.MODEL_CATALOG.filter((entry) => entry.purpose === 'backup').length, 1);
});

test('a model name is a plain file in models/, never a path', () => {
  assert.equal(local.safeModelFile('qwen2.5-0.5b-instruct-q4_k_m.gguf'), 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
  assert.equal(local.safeModelFile('..\\..\\windows\\evil.gguf'), '');
  assert.equal(local.safeModelFile('sub/evil.gguf'), '');
  assert.equal(local.safeModelFile('model.bin'), '');
  assert.equal(local.safeModelFile(''), '');
});

test('llama-server is bound to loopback with the chosen model and port', () => {
  const args = local.llamaServerArgs({ modelPath: 'C:/models/x.gguf', port: 8399 });
  assert.equal(args[0], '-m');
  assert.equal(args[1], 'C:/models/x.gguf');
  assert.ok(args.includes('--host'));
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('--port') + 1], '8399');
  assert.throws(() => local.llamaServerArgs({}), /model file/);
});

test('the release asset matches the platform build', () => {
  const assets = [
    { name: 'llama-b6000-bin-win-cuda-cu12.4-x64.zip', browser_download_url: 'https://example/cuda.zip' },
    { name: 'llama-b6000-bin-win-cpu-x64.zip', browser_download_url: 'https://example/cpu.zip' },
    { name: 'llama-b6000-bin-ubuntu-x64.zip', browser_download_url: 'https://example/linux.zip' },
  ];
  assert.match(local.releaseAssetFor(assets, { platform: 'win32', arch: 'x64' }).name, /win-cpu-x64/);
  assert.match(local.releaseAssetFor(assets, { platform: 'linux', arch: 'x64' }).name, /ubuntu-x64/);
  assert.equal(local.releaseAssetFor([], { platform: 'win32' }), null);
});

test('status reports what is installed without touching the network', () => {
  const status = local.localModelStatus({
    ollamaPath: () => '',
    llamaServerPath: () => 'C:/llama/llama-server.exe',
    installedModels: () => [{ file: 'x.gguf', bytes: 10, path: 'x' }],
  });
  assert.equal(status.ollama.found, false);
  assert.equal(status.llama.found, true);
  assert.equal(status.models.length, 1);
  assert.equal(status.ready, true, 'a runtime and a model are enough');
  assert.equal(status.provider, 'llamacpp');
});

test('the local chat answers through Ollama on the OpenAI route', async () => {
  const settings = store.db().settings;
  settings.localModelEnabled = true;
  settings.localModelProvider = 'ollama';
  settings.localModelName = 'qwen2.5:0.5b';
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '  hello from the backup  ' } }] }),
    };
  };
  const tokens = [];
  const result = await local.localChat(
    [{ role: 'user', content: 'hi' }],
    { onToken: (piece) => tokens.push(piece) },
    { fetch: fakeFetch, hasOllama: () => true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.content, 'hello from the backup');
  assert.equal(result.via, 'local');
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(seen[0].body.model, 'qwen2.5:0.5b');
  assert.deepEqual(tokens, ['hello from the backup']);
});

test('a missing runtime and a disabled switch are reported, not guessed', async () => {
  const settings = store.db().settings;
  settings.localModelProvider = 'llamacpp';
  settings.localModelEnabled = false;
  const disabled = await local.localChat([{ role: 'user', content: 'hi' }], {}, { hasLlama: () => true });
  assert.equal(disabled.ok, false);
  assert.match(disabled.error, /disabled/);

  settings.localModelEnabled = true;
  const missing = await local.localChat([{ role: 'user', content: 'hi' }], {}, { hasLlama: () => false });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /not installed/);
});

test('an image check is refused instead of answered blind', async () => {
  const settings = store.db().settings;
  settings.localModelEnabled = true;
  settings.localModelProvider = 'ollama';
  let called = false;
  const result = await local.localChat(
    [{ role: 'user', content: 'does this screen match?' }],
    { images: ['base64pixels'] },
    { fetch: async () => { called = true; }, hasOllama: () => true }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /no vision/i);
  assert.equal(called, false, 'no request is sent for an image check');
});

test('an error from the local server is surfaced with its status', async () => {
  const settings = store.db().settings;
  settings.localModelEnabled = true;
  settings.localModelProvider = 'ollama';
  const fakeFetch = async () => ({
    ok: false,
    status: 404,
    text: async () => 'model not found',
  });
  const result = await local.localChat([{ role: 'user', content: 'hi' }], {}, { fetch: fakeFetch, hasOllama: () => true });
  assert.equal(result.ok, false);
  assert.match(result.error, /404/);
});

test.after(() => {
  store.flush();
  process.chdir(originalCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
