/**
 * Named working environments, one per destination a person works against.
 *
 * Each environment gets its own folder under data/envs/<id>, its own allowed
 * hosts (so "this destination may reach these sites" is a property of the
 * destination, not of the whole console), its own media player command, and an
 * optional scoped login token that other tools on the machine can present.
 *
 * Identity here is application-level and belongs to this project. It does not
 * create Windows users and does not take a password for one: that needs
 * administrator rights and would be a system change, not a project one.
 *
 * Removing an environment moves its folder to data/envs/_removed instead of
 * deleting it, so a mistaken removal never destroys saved files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DATA, now, uid } from './store.js';

const ENVS = path.join(DATA, 'envs');
const REMOVED = path.join(DATA, 'envs', '_removed');

function envDir(id) {
  return path.join(ENVS, id);
}

function configPath(id) {
  return path.join(envDir(id), 'config.json');
}

function readConfig(id) {
  try {
    return JSON.parse(fs.readFileSync(configPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(id, config) {
  fs.mkdirSync(envDir(id), { recursive: true });
  fs.writeFileSync(configPath(id), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Folders an environment owns and creates on first use. */
const FOLDERS = ['files', 'notes', 'captures'];

export function listEnvs() {
  let entries = [];
  try {
    entries = fs.readdirSync(ENVS, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => readConfig(entry.name))
    .filter(Boolean)
    .map((config) => ({
      id: config.id,
      name: config.name,
      path: config.path,
      allowHosts: config.allowHosts || [],
      mediaPlayer: config.mediaPlayer || '',
      loginLabel: config.loginLabel || '',
      hasLogin: Boolean(config.tokenHash),
      createdAt: config.createdAt,
      lastUsedAt: config.lastUsedAt || null,
    }));
}

export function getEnv(id) {
  return readConfig(String(id || ''));
}

/** Create an environment and its folders. */
export function createEnv({ name = '', allowHosts = [], mediaPlayer = '' } = {}) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) return { ok: false, why: 'An environment needs a name.' };
  if (listEnvs().some((env) => env.name.toLowerCase() === clean.toLowerCase())) {
    return { ok: false, why: `An environment called ${clean} already exists.` };
  }
  const id = uid('env');
  const dir = envDir(id);
  for (const folder of FOLDERS) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  const config = {
    id,
    name: clean,
    path: dir,
    allowHosts: (Array.isArray(allowHosts) ? allowHosts : [])
      .map((host) => String(host || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50),
    mediaPlayer: String(mediaPlayer || '').slice(0, 300),
    loginLabel: '',
    tokenHash: '',
    createdAt: now(),
    lastUsedAt: null,
  };
  writeConfig(id, config);
  return { ok: true, env: publicEnv(config) };
}

function publicEnv(config) {
  return {
    id: config.id,
    name: config.name,
    path: config.path,
    allowHosts: config.allowHosts || [],
    mediaPlayer: config.mediaPlayer || '',
    loginLabel: config.loginLabel || '',
    hasLogin: Boolean(config.tokenHash),
    createdAt: config.createdAt,
    lastUsedAt: config.lastUsedAt || null,
  };
}

/** Change what a destination may reach, open media with, or be called. */
export function setEnvPolicy(id, patch = {}) {
  const config = readConfig(String(id || ''));
  if (!config) return { ok: false, why: 'No such environment.' };
  if (patch.allowHosts !== undefined) {
    config.allowHosts = (Array.isArray(patch.allowHosts) ? patch.allowHosts : String(patch.allowHosts || '').split(/[,\s]+/))
      .map((host) => String(host || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (patch.mediaPlayer !== undefined) config.mediaPlayer = String(patch.mediaPlayer || '').slice(0, 300);
  if (patch.loginLabel !== undefined) config.loginLabel = String(patch.loginLabel || '').slice(0, 80);
  writeConfig(config.id, config);
  return { ok: true, env: publicEnv(config) };
}

/**
 * Issue a scoped token for this environment. The token is returned once; only
 * its hash is kept, so it cannot be read back out of the project folder.
 */
export function envLogin(id, { label = '' } = {}) {
  const config = readConfig(String(id || ''));
  if (!config) return { ok: false, why: 'No such environment.' };
  const token = randomBytes(18).toString('hex');
  config.tokenHash = hashToken(token);
  config.loginLabel = String(label || config.loginLabel || 'scoped access').slice(0, 80);
  writeConfig(config.id, config);
  return { ok: true, token, env: publicEnv(config) };
}

export function verifyEnvToken(id, token) {
  const config = readConfig(String(id || ''));
  if (!config || !config.tokenHash) return { ok: false, why: 'This environment has no login yet.' };
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(config.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, why: 'That token is not valid for this environment.' };
  config.lastUsedAt = now();
  writeConfig(config.id, config);
  return { ok: true, env: publicEnv(config) };
}

/** Where a file would go inside an environment, refusing to escape it. */
export function envPath(id, relative = '') {
  const config = readConfig(String(id || ''));
  if (!config) return { ok: false, why: 'No such environment.' };
  const base = config.path;
  const target = path.resolve(base, String(relative || ''));
  const inside = target === base || target.startsWith(`${base}${path.sep}`);
  if (!inside) return { ok: false, why: 'That path leaves the environment folder.' };
  return { ok: true, path: target, base };
}

/**
 * Retire an environment. Its folder is moved under data/envs/_removed, not
 * deleted; the returned path says where it went.
 */
export function removeEnv(id) {
  const config = readConfig(String(id || ''));
  if (!config) return { ok: false, why: 'No such environment.' };
  fs.mkdirSync(REMOVED, { recursive: true });
  const target = path.join(REMOVED, `${config.id}-${Date.now()}`);
  try {
    fs.renameSync(envDir(config.id), target);
  } catch (err) {
    return { ok: false, why: `Could not move the folder: ${err.message}` };
  }
  return { ok: true, id: config.id, movedTo: target };
}

export function envStatus() {
  const envs = listEnvs();
  return {
    count: envs.length,
    envs,
    root: ENVS,
    // Stated plainly so nobody expects Windows accounts to appear.
    note: 'Environments are folders and scoped tokens inside this project; they do not create Windows user accounts.',
  };
}
