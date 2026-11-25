import test from 'node:test';
import assert from 'node:assert/strict';
import { videoUnavailable, familiarPage, mediaAlternates, courtesyBrief, topicOf, COURTESY_RULES } from '../server/courtesy.js';

const GOAL = 'open chrome go to youtube play a diamond lattice video';

test('videoUnavailable reads the visible error, not the step name', () => {
  assert.equal(videoUnavailable({ visible: 'This video is unavailable', blockers: [] }), true);
  assert.equal(videoUnavailable({ visible: 'A video player with a paused video', blockers: [] }), false);
  assert.equal(videoUnavailable({ visible: '', blockers: ['private video'] }), true);
  assert.equal(videoUnavailable(null), false);
});

test('mediaAlternates recovers in place: settle, scroll, look right, back, shortcut', () => {
  const alternates = mediaAlternates({
    goal: GOAL,
    reading: { visible: 'This video is unavailable', page: 'YouTube', usable: true },
    title: 'YouTube',
  });
  const kinds = alternates.map((entry) => entry.kind);
  assert.equal(kinds[0], 'settle');
  assert.ok(kinds.includes('scroll'));
  assert.ok(kinds.includes('lookRight'));
  assert.ok(kinds.includes('back'));
  assert.ok(kinds.includes('shortcut'));
  assert.equal(alternates.some((entry) => entry.type === 'openUrl'), false, 'never re-enters the address');
  const back = alternates.find((entry) => entry.kind === 'back');
  assert.equal(back.params.keys, 'alt+left');
  const scroll = alternates.find((entry) => entry.kind === 'scroll');
  assert.ok(scroll.params.amount < 0, 'scrolls down towards the next row');
});

test('a familiar page prefers a new video on the same topic', () => {
  const alternates = mediaAlternates({
    goal: GOAL,
    reading: { visible: 'Results grid with several videos', page: 'YouTube results', usable: true },
    familiar: true,
    title: 'YouTube',
  });
  const sameTopic = alternates.find((entry) => entry.kind === 'sameTopic');
  assert.ok(sameTopic);
  assert.match(sameTopic.name, /different video on the same topic/i);
  assert.match(sameTopic.why, /same topic/i);
  assert.match(sameTopic.why, /prefer a new one/i);
  assert.ok(alternates.some((entry) => entry.kind === 'play'));
  assert.ok(alternates.some((entry) => entry.kind === 'verify'));
});

test('alternates already tried are not offered again', () => {
  const tried = [{ type: 'scroll', params: { amount: -600, foreground: 'YouTube' } }];
  const alternates = mediaAlternates({
    goal: GOAL,
    reading: { visible: 'This video is unavailable', page: 'YouTube', usable: true },
    tried,
    title: 'YouTube',
  });
  assert.equal(alternates.some((entry) => entry.type === 'scroll'), false);
});

test('familiarPage uses memory visits and the live page', () => {
  assert.equal(familiarPage({ visible: 'YouTube results', usable: true }, { visits: 2 }), true);
  assert.equal(familiarPage({ visible: 'Results', page: 'YouTube', usable: true }, null), true);
  assert.equal(familiarPage({ visible: 'This video is unavailable', usable: false }, null), false);
});

test('courtesyBrief carries the rules and the ordered routes for a media goal', () => {
  const brief = courtesyBrief({
    goal: GOAL,
    reading: { visible: 'This video is unavailable', page: 'YouTube', usable: true },
  });
  assert.match(brief, /do not re-enter the URL/i);
  assert.match(brief, /Up next/);
  assert.match(brief, /Media goal detected/);
  assert.match(brief, /unavailable/);
  assert.match(brief, /Alternate routes/);
  assert.match(COURTESY_RULES, /same topic/i);
});

test('topicOf strips the verbs and keeps the subject', () => {
  assert.equal(topicOf('open chrome go to youtube play a diamond lattice video'), 'diamond lattice');
});
