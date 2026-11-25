import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeGoal, decompositionBrief, planCoverage, describeCoverage } from '../server/goal-decompose.js';

const GOAL = 'open chrome go to youtube type diamond lattice';

test('decomposeGoal labels every word and keeps the small words', () => {
  const result = decomposeGoal(GOAL);
  assert.equal(result.words.length, 8);
  assert.ok(result.words.every((entry) => entry.kind && entry.label), 'every word has a kind and a label');
  const to = result.words.find((entry) => entry.lower === 'to');
  assert.equal(to.kind, 'relation');
  assert.equal(to.label, 'destination');
  assert.match(to.stepHint, /where the action goes/i);
  const around = decomposeGoal('click settings at the top around the menu').words.find((entry) => entry.lower === 'around');
  assert.equal(around.label, 'nearby control');
  assert.match(around.stepHint, /next to|neighbours/i);
});

test('decomposeGoal cross-references app, action and next word', () => {
  const result = decomposeGoal(GOAL);
  const chrome = result.words.find((entry) => entry.lower === 'chrome');
  assert.equal(chrome.kind, 'app');
  assert.equal(chrome.app.name, 'Chrome');
  assert.equal(chrome.refs.action, 'open');
  assert.equal(chrome.refs.next, 'go');
  const type = result.words.find((entry) => entry.lower === 'type');
  assert.equal(type.kind, 'action');
  assert.equal(type.label, 'action: type');
});

test('decomposition lists an element and a step candidate for each phrase', () => {
  const result = decomposeGoal(GOAL);
  const labels = result.elements.map((element) => element.label);
  assert.ok(labels.includes('open'));
  assert.ok(labels.includes('type diamond lattice'));
  assert.ok(labels.includes('Chrome'));
  assert.ok(labels.includes('youtube'));
  const typed = result.stepCandidates.find((step) => /diamond lattice/.test(step.label));
  assert.equal(typed.type, 'type');
});

test('decompositionBrief renders words, elements, relations and step candidates', () => {
  const brief = decompositionBrief(GOAL);
  assert.match(brief, /INPUT DECOMPOSITION/);
  assert.match(brief, /diamond lattice/);
  assert.match(brief, /“to” = destination/);
  assert.match(brief, /Step candidates/);
  assert.match(brief, /required/);
});

test('planCoverage accepts a plan that realises every element', () => {
  const steps = [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
    { type: 'wait', name: 'Wait for Chrome', params: { ms: 1500 } },
    { type: 'focusWindow', name: 'Focus Chrome', params: { title: 'Chrome' } },
    { type: 'openUrl', name: 'Open YouTube', params: { url: 'https://www.youtube.com/results?search_query=diamond+lattice' } },
    { type: 'wait', name: 'Wait for results', params: { ms: 2000 } },
    { type: 'type', name: 'Type diamond lattice', params: { text: 'diamond lattice', foreground: 'Chrome' } },
    { type: 'screenshot', name: 'Screen check', params: { caption: 'After input' } },
  ];
  const coverage = planCoverage(GOAL, steps);
  assert.equal(coverage.ok, true, JSON.stringify(coverage.missing));
  assert.equal(coverage.missing.length, 0);
  assert.match(describeCoverage(coverage), /All \d+ goal element/);
});

test('planCoverage reports the missing input and page when the plan only opens Chrome', () => {
  const steps = [
    { type: 'launchApp', name: 'Open Chrome', params: { target: 'chrome.exe' } },
    { type: 'screenshot', name: 'Screen check', params: { caption: 'Chrome open' } },
  ];
  const before = JSON.stringify(steps);
  const coverage = planCoverage(GOAL, steps);
  assert.equal(coverage.ok, false);
  assert.equal(JSON.stringify(steps), before, 'coverage never mutates the plan');
  const labels = coverage.missing.map((entry) => entry.label).join(' | ');
  assert.match(labels, /diamond lattice/i);
  assert.match(labels, /youtube/i);
  assert.ok(coverage.missing.every((entry) => entry.followUp && entry.why));
  assert.match(describeCoverage(coverage), /still have no step/);
});

test('planCoverage requires a verification step when the goal asks for one', () => {
  const goal = 'create an account and verify the email';
  const steps = [
    { type: 'launchApp', name: 'Open Accounts', params: { target: 'Sightline Accounts' } },
    { type: 'type', name: 'Type username', params: { text: 'dana', foreground: 'Sightline Accounts' } },
  ];
  const coverage = planCoverage(goal, steps);
  assert.equal(coverage.ok, false);
  const labels = coverage.missing.map((entry) => entry.label).join(' | ');
  assert.match(labels, /email|code|verification/i);
});
