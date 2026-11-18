import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(root, 'test', 'tmp-ambient-'));
process.chdir(tempRoot);
const load = (name) => import(pathToFileURL(path.join(root, name)).href);
const store = await load('server/store.js');
const ambient = await load('server/ambient.js');

after(() => {
  try {
    store.flush();
  } finally {
    process.chdir(root);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function reset() {
  const d = store.db();
  d.settings.dryRun = true;
  d.ambient = undefined;
  d.workflows = [];
  return ambient.ensureAmbient();
}

const vlc = { process: 'vlc', title: 'Movie.mkv', supported: true };
const notepad = { process: 'notepad', title: 'Untitled - Notepad', supported: true };

test('ambient starts paused-safe: one disabled movie rule and no wildcard match', () => {
  const a = reset();
  const state = ambient.ambientState();
  assert.equal(state.enabled, true);
  assert.ok(a.rules.length >= 1);
  assert.equal(state.rules[0].enabled, false);
  assert.equal(state.clock.running, false, 'tests never start the frame clock');
  assert.throws(() => ambient.createRule({ name: 'Everything', layout: 'maximize' }), /process or window-title/);
  assert.throws(() => ambient.createRule({ name: 'No keys', kind: 'shortcut', process: 'vlc' }), /needs keys/);
});

test('comfort rule fires on app change, records a simulation, and respects its cooldown', async () => {
  reset();
  const rule = ambient.createRule({ name: 'Cinema', process: 'vlc', layout: 'cinema', cooldownSeconds: 60 });

  const first = await ambient.observeOnce({ window: vlc });
  assert.equal(first.fired.length, 1);
  assert.equal(first.fired[0].simulated, true);
  assert.match(first.fired[0].detail, /Would set cinema/);
  assert.ok(ambient.ambientState().notifications.some((entry) => /Cinema/.test(entry.title)));

  const sameWindow = await ambient.observeOnce({ window: vlc });
  assert.equal(sameWindow.fired.length, 0, 'enter mode does not re-fire on the same window');

  await ambient.observeOnce({ window: notepad });
  const tooSoon = await ambient.observeOnce({ window: vlc });
  assert.equal(tooSoon.fired.length, 0, 'cooldown suppresses a quick return');

  rule.lastFiredAt = new Date(Date.now() - 120000).toISOString();
  const later = await ambient.observeOnce({ window: { ...vlc, title: 'Episode 2.mkv' } });
  assert.equal(later.fired.length, 1);
  assert.equal(rule.fireCount, 2);
});

test('a rule outside its day and time window never matches', async () => {
  reset();
  const date = new Date(2026, 10, 17, 12, 0, 0); // Tuesday noon
  const rule = ambient.createRule({
    name: 'Evening only',
    process: 'vlc',
    layout: 'maximize',
    days: String(date.getDay()),
    from: '18:00',
    to: '23:00',
  });
  assert.equal(ambient.ruleMatches(rule, vlc, date), false);
  rule.schedule.from = '11:00';
  assert.equal(ambient.ruleMatches(rule, vlc, date), true);
  rule.schedule.days = [(date.getDay() + 1) % 7];
  assert.equal(ambient.ruleMatches(rule, vlc, date), false);
});

test('schedules fire once per day at their minute', async () => {
  reset();
  const date = new Date();
  const at = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  ambient.createSchedule({ name: 'Stand up', at, actionKind: 'notify', text: 'Stretch for a minute.' });

  const first = await ambient.checkSchedules(date);
  assert.equal(first.length, 1);
  assert.equal(first[0].simulated, true);

  const again = await ambient.checkSchedules(date);
  assert.equal(again.length, 0, 'the same minute does not fire twice');

  const tomorrow = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  const nextDay = await ambient.checkSchedules(tomorrow);
  assert.equal(nextDay.length, 1, 'a new day fires again');
});

test('habits turn into an approved comfort routine', async () => {
  reset();
  for (let index = 0; index < 5; index += 1) {
    await ambient.observeOnce({ window: vlc });
  }
  const habit = ambient.ambientState().habits.apps.find((entry) => entry.key === 'vlc');
  assert.ok(habit);
  assert.equal(habit.count, 5);

  const learned = ambient.learnAmbient();
  const proposal = learned.proposals.find((entry) => entry.kind === 'comfort');
  assert.ok(proposal, 'a media habit should suggest a cinema rule');

  const accepted = ambient.proposalAction(proposal.id, 'accept');
  assert.ok(accepted.ambient.rules.some((rule) => rule.enabled && /vlc/i.test(rule.match.process) && rule.layout === 'cinema'));
  const afterAccept = ambient.learnAmbient();
  assert.equal(afterAccept.proposals.some((entry) => entry.key === proposal.key), false, 'an accepted routine is not suggested again');
});

test('settings clamp the frame clock, and notifications can be read', () => {
  reset();
  const state = ambient.ambientSettings({ sampleMs: 10, popups: 'off', frameClock: false });
  assert.equal(state.settings.sampleMs, 250);
  assert.equal(state.settings.popups, 'off');

  ambient.createRule({ name: 'Cinema', process: 'vlc', layout: 'cinema' });
  return ambient.observeOnce({ window: vlc }).then(() => {
    const unread = ambient.ambientState().notifications.find((entry) => !entry.read);
    assert.ok(unread);
    ambient.markAmbientNotification(unread.id, true);
    assert.equal(ambient.ambientState().notifications.find((entry) => entry.id === unread.id).read, true);
    ambient.clearAmbientNotifications();
    assert.equal(ambient.ambientState().summary.unread, 0);
  });
});
