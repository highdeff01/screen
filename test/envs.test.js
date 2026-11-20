import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-envs-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const envs = await load('server/envs.js');

after(() => {
  process.chdir(root);
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('an environment needs a name, gets its own folders and cannot be duplicated', () => {
  assert.equal(envs.createEnv({ name: '   ' }).ok, false);
  const made = envs.createEnv({ name: 'Client A', allowHosts: ['Example.com', ' docs.test '] });
  assert.equal(made.ok, true);
  assert.deepEqual(made.env.allowHosts, ['example.com', 'docs.test']);
  for (const folder of ['files', 'notes', 'captures']) {
    assert.equal(fs.existsSync(path.join(made.env.path, folder)), true);
  }
  const dupe = envs.createEnv({ name: 'client a' });
  assert.equal(dupe.ok, false);
  assert.match(dupe.why, /already exists/);
  assert.equal(envs.envStatus().count, 1);
  assert.match(envs.envStatus().note, /do not create Windows user accounts/);
});

test('a destination keeps its own allowed hosts and media player', () => {
  const made = envs.createEnv({ name: 'Client B' });
  const changed = envs.setEnvPolicy(made.env.id, { allowHosts: 'news.test, video.test', mediaPlayer: 'mpv' });
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.env.allowHosts, ['news.test', 'video.test']);
  assert.equal(changed.env.mediaPlayer, 'mpv');
  assert.equal(envs.setEnvPolicy('env_missing', {}).ok, false);
});

test('a scoped login token is shown once and only its hash is kept', () => {
  const made = envs.createEnv({ name: 'Client C' });
  const login = envs.envLogin(made.env.id, { label: 'tablet' });
  assert.equal(login.ok, true);
  assert.equal(login.token.length >= 24, true);
  assert.equal(login.env.hasLogin, true);
  assert.equal(login.env.loginLabel, 'tablet');

  const config = JSON.parse(fs.readFileSync(path.join(made.env.path, 'config.json'), 'utf8'));
  assert.equal(config.tokenHash.includes(login.token), false);
  assert.equal(config.tokenHash.length, 64);

  assert.equal(envs.verifyEnvToken(made.env.id, login.token).ok, true);
  assert.equal(envs.verifyEnvToken(made.env.id, 'nope').ok, false);
  assert.equal(envs.verifyEnvToken(made.env.id, '').ok, false);
});

test('a path that leaves the environment folder is refused', () => {
  const made = envs.createEnv({ name: 'Client D' });
  const inside = envs.envPath(made.env.id, 'files/note.txt');
  assert.equal(inside.ok, true);
  assert.equal(inside.path.startsWith(made.env.path), true);
  assert.equal(envs.envPath(made.env.id, '../../../outside.txt').ok, false);
  assert.equal(envs.envPath('env_missing', 'files/x').ok, false);
});

test('removing an environment moves its folder instead of deleting it', () => {
  const made = envs.createEnv({ name: 'Client E' });
  fs.writeFileSync(path.join(made.env.path, 'files', 'keep.txt'), 'do not lose me');
  const removed = envs.removeEnv(made.env.id);
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(made.env.path), false);
  assert.equal(fs.readFileSync(path.join(removed.movedTo, 'files', 'keep.txt'), 'utf8'), 'do not lose me');
  assert.equal(envs.listEnvs().some((env) => env.id === made.env.id), false);
  assert.equal(envs.removeEnv(made.env.id).ok, false);
});
