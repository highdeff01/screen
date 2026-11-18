import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-preflight-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const engine = await load('server/engine.js');
const automation = await load('server/automation.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a launch opens the app instead of adopting a window that is already open', async () => {
  const probe = { inspectWindowState: async () => ({ state: 'foreground', foreground: { title: 'notes.txt - Notepad', process: 'notepad' } }) };
  const reason = await engine.preStepSkip({ type: 'launchApp', params: { target: 'notepad.exe' } }, probe, null);
  assert.equal(reason, '', 'a running app must not stop the launch: the flow asked for a window');
});

test('focusing a different document of the same app is not "already focused"', async () => {
  const probe = { inspectWindowState: async () => ({ state: 'foreground', foreground: { title: 'notes.txt - Notepad', process: 'notepad' } }) };
  const reason = await engine.preStepSkip({ type: 'focusWindow', params: { title: 'Notepad' } }, probe, null);
  assert.equal(reason, '', 'a title that merely contains the guard is not the window the step named');
});

test('a page that is already open is focused instead of opened again', async () => {
  const focused = [];
  const probe = {
    findOpenUrl: async ({ url }) => ({ found: true, url, title: 'VLC: Official site - Google Chrome', process: 'chrome', method: 'address bar' }),
    executeStep: async (step) => {
      focused.push(step.params);
      return { output: 'focused' };
    },
  };
  const reason = await engine.preStepSkip(
    { type: 'openUrl', params: { url: 'https://www.videolan.org/vlc/download-windows.html', newWindow: false } },
    probe,
    { id: 'run_reuse' }
  );
  assert.match(reason, /Already open/);
  assert.match(reason, /focused the existing page/);
  assert.equal(focused[0].process, 'chrome');

  const explicitNewWindow = await engine.preStepSkip(
    { type: 'openUrl', params: { url: 'https://example.com/new', newWindow: true } },
    probe,
    null
  );
  assert.equal(explicitNewWindow, '', 'an explicit new-window step still opens');

  const reuseWins = await engine.preStepSkip(
    { type: 'openUrl', params: { url: 'https://example.com/new', newWindow: true, reuseExisting: true } },
    probe,
    null
  );
  assert.match(reuseWins, /Already open/, 'reuseExisting overrides newWindow');
});

test('a download that already exists is reused, not downloaded again', async () => {
  const run = { id: 'run_download', variables: {} };
  const probe = {
    findExistingDownload: async () => ({ found: true, path: 'data/media/trailer.mp4', filename: 'trailer.mp4', bytes: 2048 }),
  };
  const reason = await engine.preStepSkip(
    { type: 'downloadMedia', params: { url: 'https://media.w3.org/2010/05/sintel/trailer.mp4', kind: 'video' } },
    probe,
    run
  );
  assert.match(reason, /Already saved/);
  assert.equal(run.variables.savedFile, 'data/media/trailer.mp4');
  assert.equal(run.files[0].reused, true);

  const overwrite = await engine.preStepSkip(
    { type: 'downloadMedia', params: { url: 'https://media.w3.org/x.mp4', overwrite: true } },
    probe,
    null
  );
  assert.equal(overwrite, '', 'overwrite still downloads');
});

test('a downloaded installer skips the download click', async () => {
  const probe = {
    findDownloadedFile: async ({ pattern }) => ({
      found: pattern === 'vlc-*.exe',
      name: 'vlc-3.0.21-win64.exe',
      bytes: 42 * 1024 * 1024,
    }),
  };
  const reason = await engine.preStepSkip(
    { type: 'clickElement', params: { name: 'Download VLC', skipIfDownload: 'vlc-*.exe' } },
    probe,
    null
  );
  assert.match(reason, /Already downloaded vlc-3\.0\.21-win64\.exe/);
  assert.match(reason, /skipped the download click/);
});

test('destination matching reads the real media folder', () => {
  fs.mkdirSync(path.join(tempRoot, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'data', 'media', 'movie-2.mkv'), 'x');
  const found = automation.findExistingDownload({ url: 'https://example.com/films/movie.mkv', folder: 'media', kind: 'video' });
  assert.equal(found.found, true);
  assert.equal(found.filename, 'movie-2.mkv');

  const missing = automation.findExistingDownload({ url: 'https://example.com/films/other.mkv', folder: 'media', kind: 'video' });
  assert.equal(missing.found, false);
});

test('a downloaded installer is detected by glob in an explicit folder', () => {
  const folder = path.join(tempRoot, 'Downloads');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'vlc-3.0.21-win64.exe'), 'x');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  const found = automation.findDownloadedFile({ pattern: 'vlc-*.exe', dir: folder });
  assert.equal(found.found, true);
  assert.equal(found.name, 'vlc-3.0.21-win64.exe');
  assert.equal(automation.findDownloadedFile({ pattern: 'vlc-*.msi', dir: folder }).found, false);
});

test('URL tokens include the page words that appear in a window title', () => {
  const tokens = automation.urlTitleTokens('https://www.videolan.org/vlc/download-windows.html');
  assert.ok(tokens.includes('vlc'), 'the path carries the VLC brand word');
  assert.ok(tokens.includes('videolan'));
  assert.ok(!tokens.includes('download'), 'generic words are excluded');
  const video = automation.urlTitleTokens('https://media.w3.org/2010/05/sintel/trailer.mp4');
  assert.ok(video.includes('trailer'));
});

test('the playback check is host-agnostic and accepts a direct video or desktop player', () => {
  const prompts = automation.playbackCheckPrompts({ expected: 'trailer.mp4', gap: 4000 });
  assert.doesNotMatch(prompts.system, /youtube\.com\/watch/i, 'a direct video must not be judged against YouTube');
  assert.match(prompts.system, /VLC/);
  assert.match(prompts.system, /direct video file/);
  assert.match(prompts.user, /trailer\.mp4/);
  assert.match(prompts.user, /4000ms later/);
});
