/**
 * The open-source Respan Gateway (https://github.com/respanai/respan-gateway) in
 * front of this console's model calls. The gateway ships as a Python package, so
 * this module writes its config from the console's own model settings, keeps a
 * loopback `python -m respan_gateway` child alive, and tells the chat client
 * where to send requests. Provider keys stay in `env:NAME` references, never in
 * the generated file.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, ROOT, db } from './store.js';

export const GATEWAY_DOCS = 'https://github.com/respanai/respan-gateway';
const CONFIG_FILE = path.join(DATA, 'gateway.toml');
const LOG_FILE = path.join(DATA, 'gateway.log');
const READY_TIMEOUT_MS = 25000;
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4319;

let child = null;
let starting = null;
let state = { status: 'idle', url: '', port: 0, error: '', pid: null, startedAt: null, signature: '' };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the gateway should serve, read from the console's own model settings. */
export function gatewaySettings(settings = db().settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const port = Math.round(Number(s.gatewayPort));
  return {
    enabled: Boolean(s.gatewayEnabled),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 0,
    keyEnv: String(s.gatewayKeyEnv || '').trim(),
    apiStyle: s.apiStyle === 'openai' ? 'openai' : 'ollama',
    baseUrl: String(s.baseUrl || '').trim().replace(/\/+$/, ''),
    models: [...new Set([s.model, s.replanModel].map((m) => String(m || '').trim()).filter(Boolean))],
  };
}

// A TOML basic string: JSON escaping matches what the format accepts here.
function quote(value) {
  return JSON.stringify(String(value));
}

/**
 * The gateway config for one start: a loopback listener, the console's provider
 * as `providers.app`, and one route per configured model so a request for the
 * console's model name survives a provider's own naming.
 */
export function gatewayConfigToml(settings = db().settings, options = {}) {
  const s = gatewaySettings(settings);
  const port = Number(options.port) || s.port || DEFAULT_PORT;
  // A provider's base_url is its OpenAI-compatible root, version included.
  const base = !s.baseUrl ? '' : s.baseUrl.endsWith('/v1') ? s.baseUrl : `${s.baseUrl}/v1`;
  const lines = [
    '# Written by Sightline from its model settings on every gateway start; manual edits are overwritten.',
    `listen = ${quote(`${HOST}:${port}`)}`,
    'log    = "off"',
    'ui     = true',
    '',
    '[providers.app]',
    s.apiStyle === 'openai' ? 'formats  = ["openai-chat"]' : 'vendor   = "ollama"',
  ];
  if (base) lines.push(`base_url = ${quote(base)}`);
  if (s.keyEnv) lines.push(`key      = ${quote(`env:${s.keyEnv}`)}`);
  for (const model of s.models) {
    lines.push('', `[routes.${quote(model)}]`, `to    = ${quote(`app/${model}`)}`, 'tries = 2');
  }
  return `${lines.join('\n')}\n`;
}

function signature(s) {
  return JSON.stringify([s.apiStyle, s.baseUrl, s.models, s.keyEnv, s.port]);
}

// The project's own directory, so the venv is found whatever the process cwd is.
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** An override, else the project venv's interpreter, else PATH. */
function pythonPath() {
  const override = String(process.env.SIGHTLINE_GATEWAY_PYTHON || '').trim();
  if (override) return override;
  const venv = path.join(PROJECT, '.venv', process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'));
  return fs.existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function answers(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/v1/models`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Start the gateway on loopback and wait until it serves /v1/models. */
export async function startGateway(settings = db().settings) {
  if (starting) return starting;
  if (state.status === 'running' && child) return gatewayStatus(settings);
  starting = (async () => {
    const s = gatewaySettings(settings);
    const port = s.port || (await freePort());
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, gatewayConfigToml(settings, { port }));
    } catch (err) {
      state = { ...state, status: 'error', url: '', error: `config: ${err.message}` };
      return gatewayStatus(settings);
    }
    const url = `http://${HOST}:${port}`;
    state = { status: 'starting', url, port, error: '', pid: null, startedAt: null, signature: signature(s) };

    let log = null;
    let proc = null;
    try {
      log = fs.openSync(LOG_FILE, 'a');
      proc = spawn(pythonPath(), ['-m', 'respan_gateway', 'serve', '-c', CONFIG_FILE], {
        cwd: ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', log, log],
        windowsHide: true,
      });
    } catch (err) {
      state = { ...state, status: 'error', url: '', error: `python: ${err.message}` };
      return gatewayStatus(settings);
    } finally {
      if (log !== null) fs.closeSync(log);
    }

    child = proc;
    let exited = null;
    proc.once('error', (err) => {
      exited = `python: ${err.message}`;
    });
    proc.once('exit', (code, signal) => {
      exited = exited || `exited (${code ?? signal})`;
      if (state.pid === proc.pid) {
        state = { ...state, status: 'stopped', url: '', pid: null };
        child = null;
      }
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && !exited) {
      if (await answers(url)) {
        state = { status: 'running', url, port, error: '', pid: proc.pid, startedAt: new Date().toISOString(), signature: signature(s) };
        return gatewayStatus(settings);
      }
      await delay(300);
    }

    const reason = exited || `no answer on ${url}/v1/models`;
    try {
      proc.kill();
    } catch {}
    child = null;
    state = { status: 'error', url: '', port, error: `gateway ${reason}; see ${LOG_FILE}`, pid: null, startedAt: null, signature: '' };
    return gatewayStatus(settings);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export function stopGateway() {
  if (child) {
    try {
      child.kill();
    } catch {}
    child = null;
  }
  state = { status: 'idle', url: '', port: 0, error: '', pid: null, startedAt: null, signature: '' };
  return gatewayStatus();
}

/**
 * The chat route: null when the gateway is off, `{ ok, url }` when it is up.
 * Restarts a running gateway whose config no longer matches the settings.
 */
export async function ensureGateway(settings = db().settings) {
  const s = gatewaySettings(settings);
  if (!s.enabled) return null;
  if (state.status === 'running' && child) {
    if (state.signature === signature(s)) return { ok: true, url: state.url };
    stopGateway();
  }
  await startGateway(settings);
  return state.status === 'running'
    ? { ok: true, url: state.url }
    : { ok: false, error: state.error || 'The Respan Gateway is not running' };
}

export function gatewayStatus(settings = db().settings) {
  const s = gatewaySettings(settings);
  return {
    enabled: s.enabled,
    status: state.status,
    running: state.status === 'running',
    url: state.url,
    chatUrl: state.url ? `${state.url}/v1/chat/completions` : '',
    port: state.port || s.port,
    models: s.models,
    python: pythonPath(),
    configPath: CONFIG_FILE,
    logPath: LOG_FILE,
    error: state.error,
    startedAt: state.startedAt,
    docs: GATEWAY_DOCS,
  };
}