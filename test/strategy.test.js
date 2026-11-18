import test from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogNames,
  continuationIdeas,
  goalApp,
  goalPhases,
  installMethodIdeas,
  strategyBrief,
  wantsInstall,
} from '../server/strategy.js';

test('goal phases are read from the words the user used', () => {
  const phases = goalPhases('install VLC, then play a video and confirm it works');
  const keys = phases.map((phase) => phase.key);
  assert.deepEqual(keys, ['install', 'play', 'verify']);
  assert.equal(goalPhases('open calculator')[0].key, 'launch');
  assert.equal(goalPhases('do the thing')[0].key, 'act');
});

test('the goal app resolves through the install catalogue', () => {
  const app = goalApp('install VLC and play a sample video');
  assert.equal(app.name, 'VLC');
  assert.equal(app.wingetId, 'VideoLAN.VLC');
  assert.match(app.exe, /VideoLAN/);
  assert.equal(goalApp('open notepad').target, 'notepad.exe');
  assert.equal(goalApp('open a spreadsheet'), null);
});

test('install methods are ordered with the trade-off that decides them', () => {
  const methods = installMethodIdeas(goalApp('install VLC'), 'install VLC');
  assert.match(methods[0].method, /winget install --id VideoLAN\.VLC/);
  assert.match(methods[0].why, /rollback|verification/i);
  assert.match(methods[1].method, /videolan\.org/);
  assert.ok(methods.every((entry) => entry.why && entry.risk));
  assert.ok(methods.some((entry) => /Microsoft Store/.test(entry.method)));
  assert.ok(wantsInstall('install vlc'));
  assert.equal(wantsInstall('play vlc'), false);
});

test('continuations continue past the first success', () => {
  const ideas = continuationIdeas({ goal: 'install VLC and play a video', phases: goalPhases('install VLC and play a video') });
  assert.ok(ideas.length >= 2);
  assert.ok(ideas.some((idea) => /uninstall/i.test(idea)));
  assert.ok(ideas.some((idea) => /playback|advanced|frame/i.test(idea)));
});

test('the brief carries objective, order, attempts, lessons, continuations and guardrails', () => {
  const brief = strategyBrief({
    goal: 'install VLC and play a sample video',
    lessons: ['Use the Button control type on the VLC page.'],
    attempts: ['Download the VLC installer (clickElement): No window matching title "VLC"'],
    longTermGoal: 'Keep this workstation able to play any media file',
  });
  assert.match(brief.text, /OBJECTIVE: install VLC/);
  assert.match(brief.text, /LONG-TERM GOAL: Keep this workstation/);
  assert.match(brief.text, /PHASES \(in order\): install the program -> play or exercise the media/);
  assert.match(brief.text, /APP: VLC \(winget VideoLAN\.VLC\)/);
  assert.match(brief.text, /INSTALL METHODS \(try in this order/);
  assert.match(brief.text, /ALREADY TRIED/);
  assert.match(brief.text, /LESSONS FROM THIS WORKSTATION/);
  assert.match(brief.text, /CONTINUE WITH:/);
  assert.match(brief.text, /GUARDRAILS: only install or change what the goal names/);
  assert.equal(brief.phases[0].key, 'install');
  assert.ok(brief.methods.length >= 2);
  assert.ok(brief.continuations.length >= 1);
});

test('a goal without an install phase gets no install methods', () => {
  const brief = strategyBrief({ goal: 'open calculator and take a screenshot' });
  assert.deepEqual(brief.methods, []);
  assert.match(brief.text, /PHASES/);
  assert.ok(catalogNames().includes('VLC'));
});
