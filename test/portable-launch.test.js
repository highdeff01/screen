import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portableLaunch } from '../server/portable.js';

test('Linux launches executables on PATH and reports a missing desktop opener', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-launch-'));
  const previous = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, SIGHTLINE_TARGET: process.env.SIGHTLINE_TARGET };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const name of ['xdotool', 'scrot', 'sample-app']) {
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  process.env.PATH = dir;
  process.env.DISPLAY = ':99';
  delete process.env.SIGHTLINE_TARGET;

  const result = await portableLaunch({ target: 'sample-app' });
  assert.match(result.detail, /Started sample-app/);
  await assert.rejects(portableLaunch({ target: 'https://example.test/' }), /Could not start "xdg-open"/);
});
