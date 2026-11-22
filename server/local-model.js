/**
 * Local backup models: GGUF in llama.cpp, or a local Ollama.
 *
 * The console's configured endpoint is a remote Ollama; when it is unreachable
 * every planning call dies with it. This module gives the console a second
 * engine on the same machine:
 *
 *   llama.cpp   a GGUF file in data/models, served by llama-server (no Ollama)
 *   Ollama      a local daemon, if one is installed, with its own model names
 *
 * Nothing here downloads or starts anything by itself. The routes in index.js
 * call these functions, and the user's click is the consent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, db, now, persist, recordUsage } from './store.js';
import { commandOnPath, IS_WINDOWS } from './platform.js';

export const MODELS_DIR = path.join(DATA, 'models');
export const RUNTIME_DIR = path.join(DATA, 'llama');
export const DEFAULT_PORT = 8399;

/**
 * Small instruct models that fit a laptop and answer in a couple of seconds on
 * CPU. The 0.5B is the backup; the others are opt-in upgrades.
 */
export const MODEL_CATALOG = [
  {
    id: 'qwen2.5-0.5b-instruct-q4_k_m',
    label: 'Qwen2.5 0.5B Instruct (Q4_K_M)',
    purpose: 'backup',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    bytes: 397_000_000,
    license: 'Apache-2.0',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    note: 'Fastest useful fallback; plans short workflows well, weak at long reasoning.',
  },
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    purpose: 'better',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    bytes: 1_120_000_000,
    license: 'Apache-2.0',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    note: 'Noticeably better plans; still runs on CPU.',
  },
  {
    id: 'smollm2-360m-instruct-q4_k_m',
    label: 'SmolLM2 360M Instruct (Q4_K_M)',
    purpose: 'tiny',
    file: 'smollm2-360m-instruct-q4_k_m.gguf',
    bytes: 230_000_000,
    license: 'Apache-2.0',
    url: 'https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q4_k_m.gguf',
    note: 'Smallest download; use only when bandwidth matters.',
  },
];

const LLAMA_RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';

export function catalogEntry(id) {
  return MODEL_CATALOG.find((entry) => entry.id === id || entry.file === id) || null;
}

/** A model file is a plain name in models/ — never a path from a request. */
export function safeModelFile(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base !== String(name || '').trim()) return '';
  if (!/\.gguf$/i.test(base)) return '';
  return base;
}

export function modelPath(name) {
  const file = safeModelFile(name);
  return file ? path.join(MODELS_DIR, file) : '';
}

export function ensureModelsDir() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  return MODELS_DIR;
}

/** GGUF files already on disk. */
export function installedModels() {
  try {
    return fs
      .readdirSync(MODELS_DIR)
      .filter((name) => /\.gguf$/i.test(name))
      .map((file) => {
        const full = path.join(MODELS_DIR, file);
        let bytes = 0;
        try {
          bytes = fs.statSync(full).size;
        } catch {}
        const known = MODEL_CATALOG.find((entry) => entry.file === file);
        return { file, path: full, bytes, label: known?.label || file.replace(/\.gguf$/i, '') };
      })
      .sort((a, b) => a.file.localeCompare(b.file));
  } catch {
    return [];
  }
}

/** Ollama is optional: a local install is used when it is the chosen runtime. */
export function ollamaPath({ env = process.env, exists = fs.existsSync } = {}) {
  if (commandOnPath('ollama', env)) return 'ollama';
  const candidates = IS_WINDOWS
    ? [
        path.join(env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
        path.join(env.ProgramFiles || '', 'Ollama', 'ollama.exe'),
      ]
    : ['/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama'];
  return candidates.find((candidate) => candidate && exists(candidate)) || '';
}

/** The llama-server binary, from data/llama (installed by this module) or PATH. */
export function llamaServerPath({ env = process.env, exists = fs.existsSync, readdir = fs.readdirSync } = {}) {
  const exe = IS_WINDOWS ? 'llama-server.exe' : 'llama-server';
  const candidates = [path.join(RUNTIME_DIR, exe), path.join(RUNTIME_DIR, 'bin', exe)];
  const local = candidates.find((candidate) => exists(candidate));
  if (local) return local;
  // Release archives sometimes unpack into their own folder; look one level in.
  try {
    for (const entry of readdir(RUNTIME_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(RUNTIME_DIR, entry.name, exe);
      if (exists(nested)) return nested;
      const nestedBin = path.join(RUNTIME_DIR, entry.name, 'bin', exe);
      if (exists(nestedBin)) return nestedBin;
    }
  } catch {}
  return commandOnPath('llama-server', env) ? 'llama-server' : '';
}

/** Args for llama-server: one model, loopback only, no bundled web UI. */
export function llamaServerArgs({ modelPath: file = '', port = DEFAULT_PORT, ctx = 4096 } = {}) {
  if (!file) throw new Error('llama-server needs a model file');
  return [
    '-m',
    String(file),
    '--host',
    '127.0.0.1',
    '--port',
    String(Number(port) || DEFAULT_PORT),
    '-c',
    String(Math.max(512, Math.min(32768, Number(ctx) || 4096))),
    '--parallel',
    '1',
  ];
}

/** Pick the right prebuilt llama.cpp asset for this OS/arch. */
export function releaseAssetFor(assets = [], { platform = process.platform, arch = process.arch } = {}) {
  const list = (assets || []).filter((asset) => asset?.name && asset?.browser_download_url);
  if (platform === 'win32') {
    const wanted = arch === 'arm64' ? /bin-win-arm64.*\.zip$/i : /bin-win-cpu-x64.*\.zip$/i;
    return list.find((asset) => wanted.test(asset.name)) || list.find((asset) => /bin-win-.*\.zip$/i.test(asset.name)) || null;
  }
  if (platform === 'darwin') {
    const wanted = /bin-macos-arm64.*\.(zip|tar\.gz)$/i;
    return list.find((asset) => wanted.test(asset.name)) || list.find((asset) => /bin-macos.*\.(zip|tar\.gz)$/i.test(asset.name)) || null;
  }
  return list.find((asset) => /bin-ubuntu-x64.*\.(zip|tar\.gz)$/i.test(asset.name)) || null;
}

// ---------------------------------------------------------------- downloads

const download = {
  id: '',
  file: '',
  received: 0,
  total: 0,
  at: null,
  doneAt: null,
  error: '',
  cancelled: false,
};

export function downloadStatus() {
  return { ...download };
}

export function cancelDownload() {
  if (download.id && !download.doneAt && !download.error) download.cancelled = true;
  return downloadStatus();
}

/**
 * Stream one catalog model into data/models. Resumable at the file level: a
 * partial `.part` is discarded rather than trusted, because a truncated GGUF
 * loads as a corrupt model instead of failing loudly.
 */
export async function downloadModel(id, deps = {}) {
  const entry = catalogEntry(id);
  if (!entry) throw new Error(`Unknown model: ${id}`);
  if (download.id && !download.doneAt && !download.error) {
    throw new Error(`Already downloading ${download.id}`);
  }
  ensureModelsDir();
  const target = path.join(MODELS_DIR, entry.file);
  const part = `${target}.part`;
  const fetchImpl = deps.fetch || fetch;

  Object.assign(download, {
    id: entry.id,
    file: entry.file,
    received: 0,
    total: Number(entry.bytes) || 0,
    at: now(),
    doneAt: null,
    error: '',
    cancelled: false,
  });
  persist();

  try {
    const res = await fetchImpl(entry.url, { headers: { accept: '*/*' } });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || Number(entry.bytes) || 0;
    download.total = total;
    const out = fs.createWriteStream(part);
    const reader = res.body.getReader();
    for (;;) {
      if (download.cancelled) throw new Error('Download cancelled');
      const { value, done } = await reader.read();
      if (done) break;
      download.received += value.byteLength;
      if (!out.write(Buffer.from(value))) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(part, target);
    download.doneAt = now();
    const settings = db().settings;
    if (!settings.localModelFile) settings.localModelFile = entry.file;
    persist();
    return { ok: true, model: { ...entry, path: target, bytes: download.received } };
  } catch (err) {
    download.error = err.message;
    try {
      fs.rmSync(part, { force: true });
    } catch {}
    persist();
    throw err;
  }
}

// ---------------------------------------------------------------- runtimes

const serverState = { child: null, pid: null, port: 0, file: '', startedAt: null, log: [] };

function note(line) {
  serverState.log.push({ at: now(), line: String(line).slice(0, 500) });
  if (serverState.log.length > 120) serverState.log.splice(0, serverState.log.length - 120);
}

export function llamaServerStatus() {
  const running = Boolean(serverState.child && serverState.child.exitCode === null && !serverState.child.killed);
  return {
    running,
    pid: serverState.pid,
    port: serverState.port,
    file: serverState.file,
    startedAt: serverState.startedAt,
    url: running ? `http://127.0.0.1:${serverState.port}/v1` : '',
    log: serverState.log.slice(-12),
  };
}

export async function startLlamaServer({ file = '', port = DEFAULT_PORT, ctx = 4096 } = {}, deps = {}) {
  const bin = deps.bin || llamaServerPath();
  if (!bin) throw new Error('llama-server is not installed. Install the llama.cpp runtime first.');
  const chosen = safeModelFile(file) || safeModelFile(db().settings.localModelFile) || installedModels()[0]?.file || '';
  const full = modelPath(chosen);
  if (!full || !fs.existsSync(full)) throw new Error('No GGUF model is downloaded yet.');
  if (llamaServerStatus().running) {
    if (llamaServerStatus().file === chosen && llamaServerStatus().port === Number(port)) return llamaServerStatus();
    await stopLlamaServer();
  }
  ensureModelsDir();
  const child = spawn(bin, llamaServerArgs({ modelPath: full, port, ctx }), {
    cwd: RUNTIME_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverState.child = child;
  serverState.pid = child.pid;
  serverState.port = Number(port) || DEFAULT_PORT;
  serverState.file = chosen;
  serverState.startedAt = now();
  child.stdout?.on('data', (chunk) => note(chunk.toString().trim().split(/\r?\n/).pop() || ''));
  child.stderr?.on('data', (chunk) => note(chunk.toString().trim().split(/\r?\n/).pop() || ''));
  child.on('exit', (code) => {
    note(`llama-server exited (${code})`);
    serverState.child = null;
    serverState.pid = null;
  });

  const ready = await waitForModels(serverState.port, deps);
  if (!ready.ok) {
    await stopLlamaServer();
    throw new Error(`llama-server did not answer: ${ready.error}`);
  }
  return llamaServerStatus();
}

export async function stopLlamaServer() {
  const child = serverState.child;
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  serverState.child = null;
  serverState.pid = null;
  serverState.port = 0;
  serverState.file = '';
  serverState.startedAt = null;
  return llamaServerStatus();
}

async function waitForModels(port, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const deadline = Date.now() + (Number(deps.readyTimeoutMs) || 90000);
  let lastError = 'no answer';
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { ok: true };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------- installers

/**
 * Download the llama.cpp prebuilt release and unpack it into data/llama.
 * CPU build on purpose: a GPU binary that cannot find a driver fails at load
 * time, and this is a backup engine, not the fast path.
 */
export async function installLlamaCpp(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const platform = deps.platform || process.platform;
  const arch = deps.arch || process.arch;
  const headers = { accept: 'application/vnd.github+json' };
  // `latest` can point at a marker release with no binaries, so recent releases
  // are searched too; the newest one that actually ships an asset wins.
  const releases = [];
  try {
    releases.push(await (await fetchImpl(LLAMA_RELEASE_API, { headers })).json());
  } catch {}
  if (!releases.some((entry) => releaseAssetFor(entry?.assets, { platform, arch }))) {
    try {
      const list = await (await fetchImpl(`${LLAMA_RELEASE_API.replace('/latest', '')}?per_page=20`, { headers })).json();
      if (Array.isArray(list)) releases.push(...list);
    } catch {}
  }
  const match = releases
    .map((entry) => ({ release: entry, asset: releaseAssetFor(entry?.assets, { platform, arch }) }))
    .find((entry) => entry.asset);
  if (!match) throw new Error('No llama.cpp prebuilt asset for this platform in the recent releases.');
  const { release, asset } = match;
  ensureModelsDir();
  const zipPath = path.join(RUNTIME_DIR, path.basename(asset.name));
  const res = await fetchImpl(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`Runtime download failed: HTTP ${res.status}`);
  const out = fs.createWriteStream(zipPath);
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!out.write(Buffer.from(value))) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  if (/\.zip$/i.test(zipPath)) {
    if (IS_WINDOWS) {
      await runCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${RUNTIME_DIR.replace(/'/g, "''")}' -Force`,
      ]);
    } else {
      await runCommand('unzip', ['-o', zipPath, '-d', RUNTIME_DIR]);
    }
  } else {
    await runCommand('tar', ['-xzf', zipPath, '-C', RUNTIME_DIR]);
  }
  try {
    fs.rmSync(zipPath, { force: true });
  } catch {}
  const bin = llamaServerPath();
  if (!bin) throw new Error('The runtime unpacked but llama-server was not found.');
  return { ok: true, path: bin, asset: asset.name, release: release.tag_name || '' };
}

/**
 * Ollama is optional and installed by its own installer. On Windows a winget
 * package exists; elsewhere the official script is the documented route.
 * Nothing is run with elevation from here.
 */
export async function installOllama(deps = {}) {
  if (ollamaPath()) return { ok: true, already: true, path: ollamaPath() };
  if (IS_WINDOWS) {
    if (!commandOnPath('winget')) {
      throw new Error('winget is not available. Install Ollama from https://ollama.com/download/windows, then reload this page.');
    }
    const result = await (deps.run || runCommand)('winget', [
      'install',
      '--id',
      'Ollama.Ollama',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ]);
    if (!result.ok) throw new Error(`winget failed: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
    return { ok: true, path: ollamaPath(), detail: (result.stdout || '').slice(-400) };
  }
  throw new Error('Install Ollama with the official script from https://ollama.com/download, then reload.');
}

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- status

export function localModelStatus(deps = {}) {
  const settings = db().settings;
  const ollama = (deps.ollamaPath || ollamaPath)();
  const llama = (deps.llamaServerPath || llamaServerPath)();
  const models = (deps.installedModels || installedModels)();
  const chosen = safeModelFile(settings.localModelFile) || models[0]?.file || '';
  return {
    enabled: settings.localModelEnabled !== false,
    provider: settings.localModelProvider === 'ollama' ? 'ollama' : 'llamacpp',
    port: Number(settings.localModelPort) || DEFAULT_PORT,
    file: chosen,
    modelsDir: MODELS_DIR,
    runtimeDir: RUNTIME_DIR,
    ollama: { found: Boolean(ollama), path: ollama },
    llama: { found: Boolean(llama), path: llama },
    models,
    catalog: MODEL_CATALOG.map(({ id, label, file, bytes, license, purpose, note }) => ({ id, label, file, bytes, license, purpose, note })),
    download: downloadStatus(),
    server: llamaServerStatus(),
    ready: Boolean((llama && chosen) || ollama),
  };
}

// ---------------------------------------------------------------- chat

/**
 * Ask the local engine. OpenAI-compatible on both runtimes, so one request
 * shape covers llama-server and Ollama's /v1 endpoint.
 *
 * Images are dropped: a plain GGUF has no vision projector, and pretending to
 * look would turn a clear failure into a confident wrong answer.
 */
export async function localChat(messages, options = {}, deps = {}) {
  const settings = db().settings;
  if (settings.localModelEnabled === false) return { ok: false, error: 'The local backup model is disabled.' };
  // A plain GGUF has no vision projector. Answering a screen check blind would
  // turn a clear failure into a confident wrong verdict, so refuse instead.
  if (options.images?.length) {
    return {
      ok: false,
      error: 'The local backup model has no vision support; screen checks stay on the configured endpoint.',
    };
  }
  const timeoutMs = Number(options.timeoutMs) || 120000;
  const fetchImpl = deps.fetch || fetch;
  const wanted = settings.localModelProvider === 'ollama' ? 'ollama' : 'llamacpp';
  let base = '';
  let model = '';

  try {
    const hasOllama = deps.hasOllama ? deps.hasOllama() : Boolean(ollamaPath());
    const hasLlama = deps.hasLlama ? deps.hasLlama() : Boolean(llamaServerPath());
    if (wanted === 'ollama') {
      if (!hasOllama) return { ok: false, error: 'Ollama is not installed.' };
      base = 'http://127.0.0.1:11434/v1';
      model = String(settings.localModelName || 'qwen2.5:0.5b');
    } else {
      if (!hasLlama) return { ok: false, error: 'llama-server is not installed.' };
      const status = llamaServerStatus();
      if (!status.running) {
        if (settings.localModelAutoStart === false) return { ok: false, error: 'The local model server is stopped.' };
        await startLlamaServer({
          file: settings.localModelFile,
          port: Number(settings.localModelPort) || DEFAULT_PORT,
        });
      }
      const live = llamaServerStatus();
      base = `http://127.0.0.1:${live.port}/v1`;
      model = live.file || 'local-gguf';
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const bodyMessages = (messages || []).map((message) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
  }));
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: bodyMessages,
        temperature: options.temperature ?? 0.3,
        max_tokens: Math.max(256, Math.min(8192, Number(options.maxTokens) || 2048)),
        stream: false,
        ...(options.format === 'json' ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Local model ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!content) throw new Error('Local model returned nothing');
    const ms = Date.now() - started;
    try {
      options.onToken?.(content, { content });
    } catch {}
    recordUsage({
      kind: options.kind || 'chat',
      model: `local:${model}`,
      ok: true,
      via: 'local',
      ms,
      prompt: String(bodyMessages[bodyMessages.length - 1]?.content || '').slice(0, 160),
      reply: content.slice(0, 200),
    });
    return { ok: true, content, ms, model: `local:${model}`, via: 'local' };
  } catch (err) {
    const ms = Date.now() - started;
    const error = err.name === 'AbortError' ? 'Local model timed out' : err.message;
    recordUsage({
      kind: options.kind || 'chat',
      model: `local:${model || 'unknown'}`,
      ok: false,
      via: 'local',
      ms,
      error: String(error).slice(0, 300),
    });
    return { ok: false, error, ms, model: `local:${model || 'unknown'}` };
  } finally {
    clearTimeout(timer);
  }
}

export { serverState as __llamaState };
