import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogEntry,
  discoverInstallerUrls,
  extractInstallerLinks,
  installAttemptSummary,
  installHealth,
  isInstalledAppWindow,
  windowLooksLikeSetup,
  installMethodsFor,
  installNoteBody,
  parseVerification,
  reviewInstaller,
  silentArgsFor,
  verificationChecksFor,
  verificationScript,
} from '../server/app-install.js';

test('catalog resolves the apps a goal names', () => {
  assert.equal(catalogEntry('download and play vlc')?.wingetId, 'VideoLAN.VLC');
  assert.equal(catalogEntry('install 7 zip please')?.name, '7-Zip');
  assert.equal(catalogEntry('install notepad++')?.wingetId, 'Notepad++.Notepad++');
  assert.equal(catalogEntry('open notepad'), null);
});

test('winget is tried before a discovered official installer', () => {
  const entry = catalogEntry('vlc');
  const methods = installMethodsFor(
    { app: 'VLC' },
    { entry, discovered: ['https://get.videolan.org/vlc/last/win64/vlc-win64.exe'] }
  );
  assert.equal(methods.length, 2);
  assert.equal(methods[0].kind, 'winget');
  assert.equal(methods[0].id, 'VideoLAN.VLC');
  assert.equal(methods[1].kind, 'direct');
  assert.equal(methods[1].url, 'https://get.videolan.org/vlc/last/win64/vlc-win64.exe');
  assert.match(methods[1].args, /\/S/);
  assert.equal(methods[1].safe, true);
});

test('an explicit URL comes before discovery and msi gets quiet switches', () => {
  const entry = catalogEntry('7-zip');
  const methods = installMethodsFor(
    { app: '7-Zip', url: 'https://www.7-zip.org/a/7z2408-x64.msi' },
    { entry, discovered: ['https://www.7-zip.org/a/7z2408-x64.exe'] }
  );
  assert.equal(methods[1].url, 'https://www.7-zip.org/a/7z2408-x64.msi');
  assert.equal(methods[1].args, '/qn /norestart');
  assert.equal(methods[2].url, 'https://www.7-zip.org/a/7z2408-x64.exe');
});

test('silent switches follow the file type and the catalogue', () => {
  assert.equal(silentArgsFor('https://example.com/app.msi'), '/qn /norestart');
  assert.equal(silentArgsFor('https://example.com/app.exe', { silentArgs: '/VERYSILENT' }), '/VERYSILENT');
  assert.equal(silentArgsFor('https://example.com/app.exe'), '/S');
  assert.equal(silentArgsFor('https://example.com/app.exe', null, '/S'), '/S');
});

test('the safety review refuses weak or risky installers', () => {
  assert.equal(reviewInstaller({ url: 'http://get.videolan.org/vlc.exe' }).safe, false);
  assert.equal(reviewInstaller({ url: 'https://get.videolan.org/vlc.zip' }).safe, false);
  assert.equal(reviewInstaller({ url: 'https://bit.ly/vlc-setup.exe' }).safe, false);
  assert.equal(reviewInstaller({ url: 'https://unknown.example.com/setup.exe' }).safe, false);
  assert.equal(reviewInstaller({ url: 'https://unknown.example.com/setup.exe', allowUnknownSource: true }).safe, true);
  assert.equal(reviewInstaller({ url: 'https://get.videolan.org/vlc-win64.exe', args: '/S' }).safe, true);
  assert.equal(
    reviewInstaller({ url: 'https://get.videolan.org/vlc-win64.exe', args: '/S; Remove-Item C:\\Users' }).safe,
    false
  );
  assert.equal(reviewInstaller({ url: 'https://get.videolan.org/vlc-win64.exe', args: '/D=C:\\VLC' }).safe, true);
  assert.equal(
    reviewInstaller({ url: 'https://www.google.com/chrome.exe', args: '/silent /install' }).safe,
    true
  );
  assert.equal(
    reviewInstaller({ url: 'https://get.videolan.org/vlc-win64.exe', args: '-enc SQBFAFgA' }).safe,
    false
  );
});

test('installer links prefer 64-bit builds and ignore other files', () => {
  const html = `
    <a href="vlc-3.0.24-win32.exe">32-bit</a>
    <a href="vlc-3.0.24-win64.exe">64-bit</a>
    <a href="/downloads/notes.txt">notes</a>
    <a href="https://get.videolan.org/vlc/last/win64/vlc-win64.exe">latest</a>
    <a href="vlc-3.0.24-win64.zip">zip</a>`;
  const links = extractInstallerLinks(html, 'https://www.videolan.org/vlc/download-windows.html');
  assert.equal(links.length, 3);
  assert.ok(links[0].includes('win64'));
  assert.ok(links.every((link) => /^https:\/\//.test(link)));
  assert.ok(!links.some((link) => link.includes('.zip')));
});

test('discovery searches the vendor page and tolerates a failure', async () => {
  const html = '<a href="https://get.videolan.org/vlc/last/win64/vlc-win64.exe">Download</a>';
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, text: async () => html };
  };
  const entry = catalogEntry('vlc');
  const urls = await discoverInstallerUrls(entry, { fetchImpl });
  assert.deepEqual(calls, ['https://www.videolan.org/vlc/download-windows.html']);
  assert.deepEqual(urls, ['https://get.videolan.org/vlc/last/win64/vlc-win64.exe']);

  const failing = await discoverInstallerUrls(entry, {
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(failing, []);
});

test('verification script checks the executable, the uninstall entry and a rollback', () => {
  const checks = verificationChecksFor(catalogEntry('vlc'));
  const script = verificationScript(checks, { uninstallCommand: 'winget uninstall --id VideoLAN.VLC --exact' });
  assert.match(script, /VideoLAN\\VLC\\vlc\.exe/);
  assert.match(script, /VLC media player/);
  assert.match(script, /Get-Process -Name 'vlc'/);
  assert.match(script, /UninstallString/);
  assert.match(script, /winget uninstall --id VideoLAN\.VLC --exact/);
  assert.match(script, /ConvertTo-Json -Compress/);
});

test('verification output is parsed from the last JSON line', () => {
  const parsed = parseVerification(
    'some warning\n{"ok":true,"exe":"C:\\\\Program Files\\\\VideoLAN\\\\VLC\\\\vlc.exe","version":"3.0.24","displayName":"VLC media player","installLocation":"","uninstall":"MsiExec.exe /X{1}"}\n'
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, '3.0.24');
  assert.equal(parsed.uninstall, 'MsiExec.exe /X{1}');
  assert.equal(parseVerification('nothing useful').ok, false);
});

test('attempt summary and install note keep the rollback path', () => {
  const attempts = [
    { method: 'winget install VideoLAN.VLC', ok: false, reason: 'winget is not installed' },
    { method: 'install vlc-win64.exe', ok: true },
  ];
  assert.match(installAttemptSummary(attempts), /winget .*failed/);
  assert.match(installAttemptSummary(attempts), /install vlc-win64\.exe: ok/);
  const note = installNoteBody({
    app: 'VLC',
    method: 'install vlc-win64.exe',
    verification: { displayName: 'VLC media player', version: '3.0.24', exe: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', uninstall: 'MsiExec.exe /X{1}' },
    attempts,
  });
  assert.match(note, /Installed: VLC/);
  assert.match(note, /Version: 3\.0\.24 \(VLC media player\)/);
  assert.match(note, /Rollback: MsiExec\.exe/);
  assert.match(note, /winget install VideoLAN\.VLC: failed/);
});

test('installer and browser windows never count as the installed app', () => {
  const entry = catalogEntry('vlc');
  assert.equal(isInstalledAppWindow({ title: 'VLC media player 3.0.24 Setup', process: 'vlc-3.0.24-win64', entry }), false);
  assert.equal(isInstalledAppWindow({ title: 'VLC media player - VideoLAN - Google Chrome', process: 'chrome', entry }), false);
  assert.equal(
    isInstalledAppWindow({ title: 'Durian Open Movie Team - Sintel Trailer - VLC media player', process: 'vlc', entry }),
    true
  );
  assert.equal(windowLooksLikeSetup('Installing VLC media player'), true);
  assert.equal(windowLooksLikeSetup('Sintel Trailer - VLC media player'), false);
});

test('install health skips a healthy install and repairs a failing one', () => {
  const entry = catalogEntry('vlc');
  const healthy = installHealth({
    entry,
    app: 'VLC',
    goal: 'open VLC and play the sample video',
    runs: [{ id: 'r1', status: 'passed', workflowName: 'VLC playback', workflowGoal: 'open VLC and play the video' }],
  });
  assert.equal(healthy.needsRepair, false);
  assert.equal(healthy.plan, 'skip');

  const failing = installHealth({
    entry,
    app: 'VLC',
    runs: [
      {
        id: 'r2',
        status: 'failed',
        workflowName: 'VLC playback',
        workflowGoal: 'open VLC and play the video',
        errorCategory: 'window_not_found',
        endedAt: '2026-11-17T10:00:00Z',
        steps: [
          {
            type: 'launchApp',
            status: 'failed',
            params: { target: 'VLC' },
            error: '“Open VLC” reported success, but no VLC window appeared.',
          },
        ],
      },
    ],
  });
  assert.equal(failing.needsRepair, true);
  assert.equal(failing.plan, 'reinstall');
  assert.match(failing.reason, /no VLC window appeared/);
});

test('a failed launch of another app never triggers a reinstall', () => {
  const health = installHealth({
    entry: catalogEntry('vlc'),
    app: 'VLC',
    runs: [
      {
        id: 'r3',
        status: 'failed',
        workflowGoal: 'open VLC and play the video',
        workflowName: 'VLC playback',
        endedAt: '2026-11-18T01:00:00Z',
        steps: [
          {
            type: 'launchApp',
            status: 'failed',
            params: { target: 'Google Search - Google Chrome' },
            error: '“Open Google Search - Google Chrome” reported focusing Google Search - Google Chrome, but it is still closed.',
          },
        ],
      },
    ],
  });
  assert.equal(health.needsRepair, false, 'the failed step was about Chrome, not VLC');
  assert.equal(health.plan, 'skip');
});

test('a newer run where the app launched supersedes older failures', () => {
  const health = installHealth({
    entry: catalogEntry('vlc'),
    app: 'VLC',
    runs: [
      {
        id: 'new',
        status: 'failed',
        workflowGoal: 'open VLC and play the video',
        endedAt: '2026-11-18T02:00:00Z',
        steps: [
          { type: 'launchApp', status: 'passed', params: { target: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe' } },
          { type: 'verifyPlayback', status: 'failed', params: { title: 'VLC media player' }, error: 'the video never started' },
        ],
      },
      {
        id: 'old',
        status: 'failed',
        workflowGoal: 'open VLC and play the video',
        errorCategory: 'window_not_found',
        endedAt: '2026-11-17T10:00:00Z',
        steps: [
          { type: 'launchApp', status: 'failed', params: { target: 'VLC' }, error: 'no VLC window appeared' },
        ],
      },
    ],
  });
  assert.equal(health.needsRepair, false, 'the latest run proves the app launches');
  assert.equal(health.plan, 'skip');
});

test('an explicit reinstall request repairs a present app instead of skipping it', () => {
  const health = installHealth({
    entry: catalogEntry('vlc'),
    app: 'VLC',
    goal: 'reinstall VLC, then open it and play the video',
  });
  assert.equal(health.requested, true);
  assert.equal(health.needsRepair, true);
  assert.equal(health.plan, 'reinstall');
  assert.match(health.reason, /reinstall|repair/i);
});
