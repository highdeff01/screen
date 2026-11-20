/**
 * Replicating a run in an alternate environment.
 *
 * A run is a claim about one desktop at one moment: one app version, one
 * locale, a particular set of open windows and downloads. Before the same test
 * is repeated on another machine, in a fresh profile or in a simulated replay,
 * it is worth knowing which steps depend on this environment and which travel
 * unchanged.
 *
 * This is a static replication: each step's requirements are matched against a
 * declared environment and the step is reported as
 *  - holds:      environment-independent, or satisfied by the new environment;
 *  - reused:     the new environment already satisfies it (page open, download
 *                present), so the preflight would skip the action;
 *  - diverged:   replayable, but behaviour or matching changes (app version,
 *                locale, simulated evidence);
 *  - conditional: replayable only when the runtime state is known;
 *  - blocked:    cannot run in that environment at all.
 *
 * Nothing is executed and no desktop is read.
 */

import { expectsScreenChange } from './step-effects.js';

const INPUT_TYPES = new Set(['type', 'key', 'clipboard', 'click', 'doubleClick', 'rightClick', 'drag', 'dragCopy', 'scroll', 'playMedia']);
const CHECK_TYPES = new Set(['verifyScreen', 'verifyPlayback', 'mediaHold', 'expect', 'waitFor']);
const ENV_FREE_TYPES = new Set(['screenshot', 'wait', 'writeNote', 'readNote', 'aiExtract', 'copyLink', 'closeWindow', 'windowAction']);

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\.exe$/, '');

const clip = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** Glob-ish match for declared downloads (`vlc-*.exe`, `*.msi`). */
export function matchesDownload(pattern, name) {
  const source = String(pattern || '').trim();
  const target = String(name || '').trim();
  if (!source || !target) return false;
  const escaped = source.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(target);
}

export function normalizeEnv(env = {}) {
  const versions = {};
  for (const [key, value] of Object.entries(env.appVersions || {})) {
    const name = norm(key);
    const version = String(value ?? '').trim();
    if (name && version) versions[name] = version;
  }
  const list = (value) =>
    (Array.isArray(value) ? value : value ? [value] : [])
      .map((entry) => (typeof entry === 'string' ? entry : entry?.path || entry?.name || ''))
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  return {
    name: clip(env.name || 'alternate', 60),
    dryRun: Boolean(env.dryRun),
    locale: String(env.locale || 'en-US').trim(),
    monitor: env.monitor !== false,
    vision: env.vision !== false,
    appVersions: versions,
    openPages: list(env.openPages),
    downloads: list(env.downloads),
    missingApps: list(env.missingApps).map(norm).filter(Boolean),
  };
}

function urlTokens(url) {
  try {
    const parsed = new URL(String(url));
    return [parsed.hostname.replace(/^www\./, ''), ...parsed.pathname.split(/[^a-z0-9]+/i)]
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 2);
  } catch {
    return [];
  }
}

function pageOpen(url, env) {
  const tokens = urlTokens(url);
  if (!tokens.length) return '';
  return (
    env.openPages.find((page) => {
      const pageTokens = urlTokens(page);
      return tokens.every((token) => pageTokens.includes(token));
    }) || ''
  );
}

function appOf(step) {
  const params = step?.params || {};
  return {
    name: String(params.app || params.target || params.foreground || params.window || params.title || '').trim(),
    process: String(step?.appContext?.process || params.process || '').trim(),
    version: String(step?.appContext?.version || '').trim(),
  };
}

function versionOf(app, env) {
  for (const key of [app.process, app.name]) {
    const name = norm(key);
    if (name && env.appVersions[name]) return env.appVersions[name];
  }
  return '';
}

function isMissing(app, env) {
  return [app.process, app.name]
    .map(norm)
    .filter(Boolean)
    .some((key) => env.missingApps.some((missing) => missing === key || key.includes(missing)));
}

function downloadFor(step, env) {
  const params = step?.params || {};
  const declared = String(params.skipIfDownload || params.expectFile || '').trim();
  if (declared) {
    const hit = env.downloads.find((name) => matchesDownload(declared, name) || matchesDownload(`*${declared}`, name));
    if (hit) return hit;
  }
  return '';
}

function judge(step, env) {
  const params = step?.params || {};
  const app = appOf(step);
  if (isMissing(app, env)) {
    return {
      replication: 'blocked',
      reason: `${app.name || 'the app'} is declared missing in “${env.name}”.`,
      advice: `Install ${app.name || 'the app'} there first, or gate the step on a waitFor process check so the replication stops at a readable point.`,
    };
  }

  if (step?.type === 'openUrl') {
    const already = pageOpen(params.url, env);
    if (already) {
      return {
        replication: 'reused',
        reason: `“${env.name}” already has ${clip(already, 80)} open; reuseExisting would skip this step.`,
        advice: 'Keep reuseExisting on the openUrl step so the replication continues instead of opening a second tab.',
      };
    }
    if (env.dryRun) return { replication: 'blocked', reason: 'The declared environment has no desktop, so no browser can be opened.', advice: 'Replicate in a live environment or label the page as already open.' };
    return { replication: 'holds', reason: 'The page will be opened as planned.', advice: '' };
  }

  if (step?.type === 'launchApp') {
    const target = String(params.target || '').trim();
    const declared = versionOf(app, env);
    if (declared && app.version && norm(declared) !== norm(app.version)) {
      return {
        replication: 'diverged',
        reason: `Recorded on version ${app.version}; “${env.name}” declares ${declared}.`,
        advice: 'Pin the same version, or add a verification that reads the version dialog so a changed build is reported instead of silently passing.',
      };
    }
    if (env.dryRun) return { replication: 'blocked', reason: 'The declared environment has no desktop, so the launch cannot be performed.', advice: 'Replicate in a live environment for launch and input steps.' };
    return { replication: 'holds', reason: `${target || app.name || 'the app'} can be launched there.`, advice: '' };
  }

  const downloaded = downloadFor(step, env);
  if (downloaded) {
    return {
      replication: 'reused',
      reason: `“${env.name}” already has ${clip(downloaded, 60)}; skipIfDownload would skip this click.`,
      advice: 'Keep skipIfDownload on the download click so a fresh install does not re-download.',
    };
  }

  if (step?.type === 'verifyScreen' && !env.vision) {
    return {
      replication: 'blocked',
      reason: 'Vision is disabled in the declared environment, so the screen question cannot be answered.',
      advice: 'Add a UI-automation assertion (expect/waitFor) as the portable check and keep verifyScreen as a local extra.',
    };
  }

  if (env.locale && !/^en([-_]|$)/i.test(env.locale) && ['focusWindow', 'clickElement', 'verifyScreen', 'windowAction'].includes(step?.type)) {
    return {
      replication: 'diverged',
      reason: `Window and control labels are localized; “${env.name}” runs ${env.locale}.`,
      advice: 'Match the control by automation id/class or by process rather than its translated name, so the same step works in both locales.',
    };
  }

  if (env.dryRun && (INPUT_TYPES.has(step?.type) || expectsScreenChange(step))) {
    return {
      replication: 'blocked',
      reason: 'The declared environment is simulated, so this input produces labelled placeholders, not real screen changes.',
      advice: 'Replicate the input steps in a live environment; simulated replays can only confirm the plan shape.',
    };
  }

  if (ENV_FREE_TYPES.has(step?.type)) {
    return { replication: 'holds', reason: 'This step does not depend on the environment.', advice: '' };
  }

  if (CHECK_TYPES.has(step?.type)) {
    return {
      replication: 'conditional',
      reason: 'The check re-reads whatever state the alternate environment actually reaches.',
      advice: 'Capture a screenshot after the check so a replication mismatch has evidence instead of only a message.',
    };
  }

  if (INPUT_TYPES.has(step?.type)) {
    return {
      replication: 'conditional',
      reason: 'The input needs the same window in front; the foreground guard still applies there.',
      advice: 'Keep the foreground guard on the step; it is what keeps the replication from typing into the wrong window.',
    };
  }

  return { replication: 'holds', reason: 'No environment dependency was detected.', advice: '' };
}

/**
 * Compare a recorded run with a declared alternate environment.
 *
 * @param {object} input
 * @param {object} input.run a stored or synthetic run with steps
 * @param {object} [input.env] declared environment (see normalizeEnv)
 */
export function replicateRun({ run = null, env = {} } = {}) {
  const target = normalizeEnv(env);
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const breakdown = steps.map((step, index) => {
    const result = judge(step, target);
    return {
      seq: index + 1,
      stepId: step.id || '',
      name: step.name || step.type || '',
      type: step.type || '',
      status: step.status || 'pending',
      expectedChange: expectsScreenChange(step),
      replication: result.replication,
      reason: result.reason,
      advice: result.advice,
    };
  });

  const count = (verdict) => breakdown.filter((entry) => entry.replication === verdict).length;
  const holds = count('holds');
  const reused = count('reused');
  const diverged = count('diverged');
  const conditional = count('conditional');
  const blocked = count('blocked');
  const portable = breakdown.length ? Math.round(((holds + reused) / breakdown.length) * 100) : 0;
  const verdict = blocked > 0 ? 'blocked' : diverged > 0 ? 'needs_adaptation' : breakdown.length ? 'portable' : 'no_steps';
  const suggestions = [...new Set(breakdown.map((entry) => entry.advice).filter(Boolean))].slice(0, 6);
  if (!breakdown.length) suggestions.push('This run has no steps to replicate.');
  if (blocked > 0) suggestions.push('Clear the blocked steps before trusting a replication; a blocked input cannot be reported as a pass.');

  return {
    runId: run?.id || null,
    workflowId: run?.workflowId || null,
    workflowName: run?.workflowName || '',
    env: {
      name: target.name,
      locale: target.locale,
      dryRun: target.dryRun,
      monitor: target.monitor,
      vision: target.vision,
      apps: Object.keys(target.appVersions).length,
      openPages: target.openPages.length,
      downloads: target.downloads.length,
      missingApps: target.missingApps.length,
    },
    summary: { steps: breakdown.length, holds, reused, diverged, conditional, blocked, portable, verdict },
    breakdown,
    suggestions,
  };
}
