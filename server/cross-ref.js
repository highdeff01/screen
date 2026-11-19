/**
 * Cross-referencing a run against the steps that worked before.
 *
 * A run reports what it did; it does not, by itself, say whether that is the
 * same path that worked last time or a new one. This module compares the
 * current step sequence with the best prior episode for the same workflow and
 * with the whole remembered history, and answers three questions:
 *  - which details are new (apps, step types, error shapes, versions),
 *  - which steps repeat a proven sequence and can be trusted,
 *  - where the path diverged or lost a step that used to pass.
 *
 * It also maps the run onto the goal's phases, so "better" means more of the
 * goal completed, not more steps executed.
 *
 * Pure: episodes are the stored workflow-memory records passed by the caller.
 */

import { goalPhases } from './strategy.js';
import { appHint } from './goal-apps.js';

const CHECK_TYPES = new Set(['verifyScreen', 'verifyPlayback', 'mediaHold', 'expect', 'waitFor']);
const PARAM_KEYS = ['target', 'url', 'name', 'title', 'keys', 'text', 'textVar', 'toolId', 'kind', 'value', 'app', 'action', 'foreground'];
const PHASE_ORDER = ['search', 'download', 'install', 'launch', 'play', 'verify', 'capture', 'note', 'cleanup', 'act'];

const clip = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const norm = (value) => String(value ?? '').trim().toLowerCase();

/** The part of a step that makes it the same action as another step. */
export function stepKey(step) {
  if (!step?.type) return '';
  const params = step.params || {};
  const shape = PARAM_KEYS.filter((key) => params[key] != null && String(params[key]).trim() !== '')
    .map((key) => `${key}=${clip(norm(params[key]), 80)}`)
    .join('&');
  return `${step.type}|${norm(step.name)}|${shape}`;
}

/** The value that decides whether an anchor is the same target as before. */
function canonicalParam(key, value) {
  const text = norm(value);
  if (!text) return '';
  if (key === 'url') {
    try {
      const parsed = new URL(text);
      return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return text;
    }
  }
  if (key === 'target' || key === 'app') {
    // A full path and a bare executable name are the same target.
    return (text.split(/[\\/]/).pop() || text).replace(/\.exe$/, '');
  }
  if (key === 'name' || key === 'title') return text.replace(/^\*/, '').trim();
  return text;
}

/**
 * The same action even when its values changed: type, name and the field that
 * identifies what the action was aimed at. A `text` value, a full path or a
 * window handle changes between runs; the action itself does not.
 */
export function stepIdentity(step) {
  if (!step?.type) return '';
  const params = step.params || {};
  const anchor = ['target', 'url', 'toolId', 'name', 'kind', 'value', 'title', 'app']
    .map((key) => {
      const value = canonicalParam(key, params[key]);
      return value ? `${key}=${clip(value, 60)}` : '';
    })
    .filter(Boolean)
    .join('&');
  // The name is a label the planner may rewrite between runs; the action and
  // its target are what decide whether this is the same step as before. A step
  // with no target of its own (a bare wait) falls back to its name, so two
  // unrelated waits do not collapse into one match.
  return `${step.type}|${anchor || norm(step.name)}`;
}

function changedParams(before = {}, after = {}) {
  return PARAM_KEYS.filter((key) => {
    const left = canonicalParam(key, before[key]);
    const right = canonicalParam(key, after[key]);
    return left !== right && (left || right);
  });
}

/** Which goal phase a step advances. */
export function phaseOf(step) {
  const params = step?.params || {};
  const text = `${step?.name || ''} ${params.title || params.name || ''} ${params.url || ''}`.toLowerCase();
  switch (step?.type) {
    case 'installApp':
      return 'install';
    case 'downloadMedia':
      return 'download';
    case 'playMedia':
    case 'mediaHold':
    case 'verifyPlayback':
      return 'play';
    case 'screenshot':
      return 'capture';
    case 'writeNote':
    case 'readNote':
      return 'note';
    case 'verifyScreen':
    case 'expect':
    case 'waitFor':
      return 'verify';
    case 'launchApp':
      return 'launch';
    case 'openUrl':
      return /(?:google|bing|duckduckgo|search)/i.test(params.url || '') ? 'search' : 'launch';
    case 'windowAction':
    case 'closeWindow':
      return /close|quit|exit/i.test(`${params.action || ''} ${text}`) ? 'cleanup' : 'act';
    case 'clickElement':
      return /download|installer|setup/.test(text) ? 'download' : 'act';
    default:
      return 'act';
  }
}

function isCheck(step) {
  return CHECK_TYPES.has(step?.type);
}

function appNames(steps = []) {
  const names = new Set();
  for (const step of steps) {
    const params = step?.params || {};
    for (const value of [step?.appContext?.process, params.app, params.target, params.foreground, params.process]) {
      const hint = appHint(value);
      if (hint) names.add(norm(hint.process || hint.name).replace(/\.exe$/, ''));
    }
  }
  return names;
}

function compareSequence(current, prior) {
  const priorExact = new Map();
  const priorIdentity = new Map();
  (prior || []).forEach((step, index) => {
    const exact = stepKey(step);
    const identity = stepIdentity(step);
    if (exact && !priorExact.has(exact)) priorExact.set(exact, index);
    if (identity && !priorIdentity.has(identity)) priorIdentity.set(identity, index);
  });
  const repeats = [];
  const divergences = [];
  const fresh = [];
  const currentIdentities = new Set();
  current.forEach((step, index) => {
    const exact = stepKey(step);
    const identity = stepIdentity(step);
    if (identity) currentIdentities.add(identity);
    if (exact && priorExact.has(exact)) {
      repeats.push({ seq: index + 1, priorSeq: priorExact.get(exact) + 1, name: step.name || step.type, changedParams: [] });
      return;
    }
    if (identity && priorIdentity.has(identity)) {
      // Same action, different values: a repeat with a note, not a new path.
      const priorIndex = priorIdentity.get(identity);
      repeats.push({
        seq: index + 1,
        priorSeq: priorIndex + 1,
        name: step.name || step.type,
        changedParams: changedParams(prior?.[priorIndex]?.params, step.params),
      });
      return;
    }
    const samePosition = prior?.[index];
    if (samePosition) {
      divergences.push({
        seq: index + 1,
        name: step.name || step.type,
        type: step.type,
        priorSeq: index + 1,
        priorName: samePosition.name || samePosition.type,
        priorType: samePosition.type,
        reason: samePosition.type !== step.type
          ? `was a ${samePosition.type} step, is now a ${step.type} step`
          : 'same position, a different action',
      });
    } else {
      fresh.push({ seq: index + 1, name: step.name || step.type, type: step.type });
    }
  });
  const regressions = [];
  (prior || []).forEach((step, index) => {
    const identity = stepIdentity(step);
    if (identity && !currentIdentities.has(identity)) {
      regressions.push({ priorSeq: index + 1, name: step.name || step.type, type: step.type, status: step.status || '' });
    }
  });
  return { repeats, divergences, fresh, regressions };
}

function progressFor(steps, goal) {
  const phases = goalPhases(goal);
  const extra = [...new Set(steps.map((step) => phaseOf(step)))].filter(
    (key) => !phases.some((phase) => phase.key === key)
  );
  const all = [...phases, ...extra.map((key) => ({ key, label: key }))].sort(
    (a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key)
  );
  const rows = all.map((phase) => {
    const owned = steps.filter((step) => phaseOf(step) === phase.key);
    return {
      key: phase.key,
      label: phase.label,
      steps: owned.length,
      passed: owned.filter((step) => step.status === 'passed').length,
      failed: owned.filter((step) => step.status === 'failed').length,
      done: owned.length > 0 && owned.every((step) => step.status === 'passed' || step.status === 'skipped'),
    };
  });
  const named = rows.filter((row) => phases.some((phase) => phase.key === row.key));
  const covered = named.filter((row) => row.steps > 0).length;
  return {
    phases: rows,
    covered,
    total: named.length,
    pct: named.length ? Math.round((covered / named.length) * 100) : 0,
    remaining: named.filter((row) => row.steps === 0).map((row) => row.label),
    done: named.filter((row) => row.done).map((row) => row.label),
  };
}

function newDetailsFor({ steps, episodes, run }) {
  const priorApps = new Set();
  const priorTypes = new Set();
  const priorHindrances = [];
  const priorVersions = {};
  for (const episode of episodes || []) {
    for (const app of episode.apps || []) priorApps.add(norm(app).replace(/\.exe$/, ''));
    for (const step of episode.steps || []) {
      if (step?.type) priorTypes.add(step.type);
      for (const value of [step?.detail, step?.name]) {
        const text = String(value || '').trim();
        if (text) priorApps.add(norm(text).replace(/\.exe$/, ''));
      }
    }
    for (const hindrance of episode.hindrances || []) priorHindrances.push(norm(hindrance));
    for (const [app, version] of Object.entries(episode.appVersions || {})) {
      if (!priorVersions[norm(app)]) priorVersions[norm(app)] = String(version || '');
    }
  }

  const details = [];
  for (const name of appNames(steps)) {
    if (!priorApps.size || ![...priorApps].some((entry) => entry === name || entry.includes(name) || name.includes(entry))) {
      details.push({ kind: 'app', detail: `app “${name}” is new to this workflow's remembered runs` });
    }
  }
  for (const type of new Set(steps.map((step) => step?.type).filter(Boolean))) {
    if (priorTypes.size && !priorTypes.has(type)) {
      details.push({ kind: 'stepType', detail: `${type} steps have not been used here before` });
    }
  }
  const currentVersions = {};
  for (const step of steps) {
    const process = norm(step?.appContext?.process);
    const version = String(step?.appContext?.version || '').trim();
    if (process && version) currentVersions[process] = version;
  }
  for (const [app, version] of Object.entries(currentVersions)) {
    const prior = priorVersions[app];
    if (prior && prior !== version) {
      details.push({ kind: 'version', detail: `${app} is ${version} here but was ${prior} in the remembered run` });
    }
  }
  const failed = steps.filter((step) => step?.status === 'failed' && step?.error);
  for (const step of failed) {
    const head = norm(step.error).slice(0, 90);
    if (head && !priorHindrances.some((entry) => entry.includes(head.slice(0, 40)))) {
      details.push({
        kind: 'error',
        detail: `new failure in “${clip(step.name || step.type, 60)}”: ${clip(step.error, 110)}`,
      });
    }
  }
  if (run?.errorCategory) details.push({ kind: 'error', detail: `run error category ${run.errorCategory} was not seen before` });
  return details.slice(0, 10);
}

/**
 * Compare a run with the workflow's remembered steps.
 *
 * @param {object} input
 * @param {object} input.run current run
 * @param {Array} [input.episodes] workflow-memory episodes
 * @param {object} [input.workflow] the workflow record, for the goal text
 * @param {string} [input.goal] explicit goal, overrides the workflow text
 */
export function crossReference({ run = null, episodes = [], workflow = null, goal = '' } = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const objective = String(goal || workflow?.description || workflow?.name || run?.workflowName || '').trim();
  const peers = (episodes || [])
    .filter((episode) => episode && (!run?.workflowId || !episode.workflowId || episode.workflowId === run.workflowId))
    .slice()
    .sort(
      (a, b) =>
        Number(b.status === 'passed') - Number(a.status === 'passed') ||
        Number(b.quality || 0) - Number(a.quality || 0) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
  const baseline = peers.find((episode) => episode.status === 'passed') || peers[0] || null;
  const latest = (episodes || []).slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  const comparison = baseline ? compareSequence(steps, baseline.steps || []) : { repeats: [], divergences: [], fresh: [], regressions: [] };
  const newDetails = newDetailsFor({ steps, episodes: peers, run });
  const progress = progressFor(steps, objective);
  const baselineProgress = baseline ? progressFor(baseline.steps || [], objective) : null;

  // A different route is not a regression. It only counts as one when the
  // remembered path reached more of the goal than this run does.
  let verdict = 'first_run';
  if (baseline) {
    if (baselineProgress && baselineProgress.pct > progress.pct) verdict = 'regressed';
    else if (comparison.divergences.length || comparison.fresh.length || comparison.regressions.length) verdict = 'new_path';
    else verdict = 'consistent';
  }

  const summary = [];
  if (baseline) {
    summary.push(
      `${comparison.repeats.length}/${steps.length} step(s) repeat the proven sequence from ${clip(baseline.workflowName || baseline.runId || 'a prior run', 50)}${baseline.mode ? ` (${baseline.mode})` : ''}.`
    );
  } else {
    summary.push('No prior episode matches this workflow yet, so this run is the baseline.');
  }
  const revalued = comparison.repeats.filter((entry) => (entry.changedParams || []).length);
  if (revalued.length) {
    summary.push(
      `${revalued.length} proven action(s) kept their place with new values (${revalued
        .slice(0, 2)
        .map((entry) => `${clip(entry.name, 40)}: ${entry.changedParams.join('/')}`)
        .join(', ')}).`
    );
  }
  if (comparison.divergences.length) {
    const first = comparison.divergences[0];
    summary.push(`${comparison.divergences.length} step(s) diverge, starting at ${first.seq} “${clip(first.name, 50)}” (${first.reason}).`);
  }
  if (comparison.regressions.length) {
    summary.push(
      baselineProgress && baselineProgress.pct > progress.pct
        ? `${comparison.regressions.length} previously passing step(s) are missing, and the remembered path covered more goal phases (${baselineProgress.pct}% vs ${progress.pct}%).`
        : `${comparison.regressions.length} previously used step(s) are not in this run; this is a different route over the same phases, not necessarily a loss.`
    );
  }
  if (newDetails.length) summary.push(`${newDetails.length} new detail(s) were not in the remembered history; check them before trusting the run.`);
  if (progress.remaining.length) summary.push(`Goal phases still uncovered: ${progress.remaining.join(', ')}.`);
  else if (progress.total) summary.push(`All ${progress.total} goal phase(s) are covered (${progress.pct}%).`);

  const nextStep = steps.find((step) => ['pending', 'running', 'failed'].includes(step?.status)) || null;
  return {
    goal: objective,
    verdict,
    baseline: baseline
      ? {
          id: baseline.id,
          runId: baseline.runId,
          workflowName: baseline.workflowName,
          mode: baseline.mode,
          status: baseline.status,
          quality: baseline.quality,
          createdAt: baseline.createdAt,
          steps: (baseline.steps || []).length,
        }
      : null,
    latest: latest ? { id: latest.id, runId: latest.runId, status: latest.status, createdAt: latest.createdAt } : null,
    repeats: comparison.repeats,
    divergences: comparison.divergences,
    fresh: comparison.fresh,
    regressions: comparison.regressions,
    newDetails,
    progress,
    nextStep: nextStep ? { seq: steps.indexOf(nextStep) + 1, name: nextStep.name || nextStep.type, status: nextStep.status, type: nextStep.type } : null,
    summary: summary.slice(0, 5),
    counts: {
      steps: steps.length,
      repeated: comparison.repeats.length,
      revalued: comparison.repeats.filter((entry) => (entry.changedParams || []).length).length,
      diverged: comparison.divergences.length,
      newSteps: comparison.fresh.length,
      regressions: comparison.regressions.length,
      checks: steps.filter(isCheck).length,
    },
  };
}
