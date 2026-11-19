/**
 * Which applications serve the goal now, and which are worth setting up later.
 *
 * A single suggestion list mixes two very different actions: reuse something
 * that is already on the desktop, and install something that is not there yet.
 * That mixing hides the next action, so this module splits the list:
 *  - immediate: an app the plan already uses, or one this workstation has
 *    already shown, with the action that reuses it instead of relaunching it;
 *  - long_term: the app the goal names but the desktop has not shown yet, with
 *    the setup step and the reversible uninstall that makes the investment safe.
 *
 * Pure: the caller supplies the plan, prior episodes and anything observed. A
 * suggestion never claims an app is installed; it reports what the evidence
 * says through `availability` and says so when nothing was observed.
 */

import { catalogEntry } from './app-install.js';
import { goalApp } from './strategy.js';

const DISPLAY = {
  notepad: 'Notepad',
  calc: 'Calculator',
  mspaint: 'Paint',
  explorer: 'File Explorer',
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  wt: 'Windows Terminal',
};

const DOCUMENT_FILE = /\.(?:txt|md|markdown|docx?|xlsx?|pptx?|pdf|csv|json|ya?ml|png|jpe?g|gif|webp|mp4|mkv|avi|mov|mp3|wav|zip|rar|7z|exe|msi|log)$/i;
// Sites and console-generated window titles are not applications, even when a
// step or a remembered episode stored their title in an app field.
const SITE_LIKE = new Set(['youtube', 'google', 'gmail', 'github', 'gitlab', 'facebook', 'x', 'twitter', 'reddit', 'wikipedia', 'videolan']);
const GENERATED_TITLE = /^(?:sightline|codebuff|untitled|new tab|about:blank)[\s-]/i;

const KNOWN_DESKTOP_APPS = [
  /^notepad$/i,
  /^calc$/i,
  /^mspaint$/i,
  /^explorer$/i,
  /^chrome$/i,
  /^msedge$/i,
  /^firefox$/i,
];

const norm = (value) => String(value ?? '').trim().toLowerCase().replace(/\.exe$/, '');

const clip = (value, max = 160) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** A plain display name for a process, executable or window owner. */
function displayName(value) {
  const text = String(value || '').trim();
  const leaf = text.split(/[\\/]/).pop() || text;
  const bare = leaf.replace(/\.exe$/i, '');
  return DISPLAY[bare.toLowerCase()] || bare;
}

/**
 * Turn a step value into an app, but only when it really names one. A window
 * title such as “*Zulu marker - Notepad” is reduced to Notepad; a document, a
 * URL or a sentence is not an application and is ignored.
 */
export function appHint(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 60) return null;
  if (/^https?:\/\//i.test(text) || /[\\/]/.test(text)) return null;
  if (GENERATED_TITLE.test(text)) return null;
  const catalog = catalogEntry(text);
  if (catalog) return { name: catalog.name, process: catalog.process };
  const tail = text.match(/\s[-–—]\s([^-–—]{2,40})$/);
  const candidate = (tail ? tail[1] : text).trim();
  // An application name is short: one or two words, not a document, a site or
  // a sentence copied from a window title.
  if (!candidate || candidate.split(/\s+/).length > 2) return null;
  if (DOCUMENT_FILE.test(candidate)) return null;
  if (SITE_LIKE.has(candidate.toLowerCase().replace(/\.(?:com|org|net)$/i, ''))) return null;
  return { name: displayName(candidate), process: candidate };
}

function collect(steps = []) {
  const found = new Map();
  const add = (name, process, source, extra = {}) => {
    const catalog = catalogEntry([name, process]) || null;
    const label = catalog?.name || displayName(name || process);
    const proc = catalog?.process || String(process || name || '').split(/[\\/]/).pop() || '';
    const key = norm(proc || label);
    if (!key) return;
    const record =
      found.get(key) ||
      {
        key,
        name: '',
        process: '',
        sources: new Set(),
        occurrences: 0,
        version: '',
        catalog,
      };
    record.catalog = record.catalog || catalog;
    if (!record.name) record.name = label;
    if (!record.process) record.process = proc;
    record.sources.add(source);
    record.occurrences += 1;
    if (extra.version && !record.version) record.version = String(extra.version).trim();
    found.set(key, record);
  };

  for (const step of steps || []) {
    const params = step?.params || {};
    if (step?.type === 'launchApp' || step?.type === 'installApp') {
      const hint = appHint(params.target || params.app || params.id || '');
      if (hint) add(hint.name, hint.process, 'plan');
    } else if (step?.type === 'openUrl') {
      const hint = appHint(params.app || '') || { name: 'Browser', process: 'browser' };
      add(hint.name, hint.process, 'plan');
    } else if (['focusWindow', 'windowAction', 'clickElement', 'type', 'key', 'playMedia', 'verifyPlayback', 'mediaHold'].includes(step?.type)) {
      const hint = appHint(params.process || params.app || params.window || params.foreground || params.title || '');
      if (hint) add(hint.name, hint.process, 'plan');
    }
    if (step?.appContext?.process) {
      const hint = appHint(step.appContext.process);
      if (hint) add(hint.name, hint.process, 'observed', { version: step.appContext.version });
    }
  }
  return found;
}

function addGoalApp(found, goal = '') {
  const resolved = goalApp(goal);
  if (!resolved) return;
  const key = norm(resolved.process || resolved.name);
  if (!key) return;
  const record =
    found.get(key) ||
    {
      key,
      name: resolved.name,
      process: resolved.process || resolved.name,
      sources: new Set(),
      occurrences: 0,
      version: '',
      catalog: resolved.entry || catalogEntry(goal),
    };
  record.sources.add('goal');
  found.set(key, record);
}

function addObserved(found, values = []) {
  for (const value of values || []) {
    const hint = appHint(typeof value === 'string' ? value : value?.process || value?.name || '');
    if (!hint) continue;
    const key = norm(hint.process || hint.name);
    const record = found.get(key);
    if (record) {
      record.sources.add('available');
      continue;
    }
    found.set(key, {
      key,
      name: hint.name,
      process: hint.process,
      sources: new Set(['available']),
      occurrences: 0,
      version: String(typeof value === 'string' ? '' : value?.version || '').trim(),
      catalog: catalogEntry([hint.name, hint.process]) || null,
    });
  }
}

function addHistory(found, episodes = []) {
  for (const episode of episodes || []) {
    if (episode?.status !== 'passed') continue;
    for (const value of episode.apps || []) {
      const hint = appHint(value);
      if (!hint) continue;
      const key = norm(hint.process || hint.name);
      const record = found.get(key);
      if (record) {
        record.sources.add('history');
        continue;
      }
      found.set(key, {
        key,
        name: hint.name,
        process: hint.process,
        sources: new Set(['history']),
        occurrences: 0,
        version: (episode.appVersions || {})[key] || '',
        catalog: catalogEntry([hint.name, hint.process]) || null,
      });
    }
  }
}

function availabilityOf(record) {
  if (record.sources.has('available')) return 'observed';
  if (record.sources.has('observed')) return 'observed';
  if (KNOWN_DESKTOP_APPS.some((pattern) => pattern.test(record.process) || pattern.test(record.name))) return 'observed';
  if (record.sources.has('plan')) return 'planned';
  if (record.sources.has('history')) return 'observed';
  return 'unverified';
}

function whyFor(record) {
  const reasons = [];
  if (record.sources.has('goal')) reasons.push('the goal names it');
  if (record.sources.has('plan')) reasons.push(`the plan uses it in ${record.occurrences} step(s)`);
  if (record.sources.has('history')) reasons.push('a previous passing run used it');
  if (record.sources.has('observed')) reasons.push('this desktop has already shown it');
  if (record.sources.has('available')) reasons.push('it is already available on this desktop');
  return reasons.length ? reasons.join('; ') : 'it was suggested from the app catalogue';
}

function scoreFor(record, horizon) {
  let score = 0;
  if (record.sources.has('goal')) score += 0.34;
  if (record.sources.has('plan')) score += 0.24 + Math.min(0.1, record.occurrences * 0.02);
  if (record.sources.has('history')) score += 0.18;
  if (record.sources.has('available') || record.sources.has('observed')) score += 0.14;
  if (record.catalog) score += 0.06;
  // A ready app is worth acting on now; an unready one is worth planning for.
  score += horizon === 'immediate' ? 0.05 : 0;
  return Math.round(Math.min(0.99, score) * 1000) / 1000;
}

function entryFor(record, horizon) {
  const catalog = record.catalog || catalogEntry([record.name, record.process]);
  const availability = availabilityOf(record);
  const version = record.version || '';
  const install = catalog?.wingetId ? `winget install --id ${catalog.wingetId} --exact` : '';
  const next =
    horizon === 'immediate'
      ? `Reuse it: with reuseExisting the step is skipped when the window, page or file is already in front, so the run continues at the next step instead of opening a second copy.`
      : install
        ? `Run ${install}, then launch it once and capture the window before trusting the install. Roll back with ${catalog.uninstall || `winget uninstall --id ${catalog.wingetId}`}.`
        : `Install or open it once by hand, capture the window, then let the plan reuse it. No safe unattended installer is known for ${record.name || 'this app'}.`;
  return {
    key: record.key,
    name: record.name || record.process,
    process: record.process,
    horizon,
    availability,
    availabilityNote:
      availability === 'observed'
        ? 'Seen on this desktop or in a previous run.'
        : availability === 'planned'
          ? 'In the plan, but this desktop has not shown it yet.'
          : 'Not observed; treat the install as unproven until a launch verifies it.',
    version,
    wingetId: catalog?.wingetId || '',
    uninstall: catalog?.uninstall || '',
    install,
    effort: availability === 'observed' ? 'none' : install ? 'one command' : 'manual setup',
    score: scoreFor(record, horizon),
    why: whyFor(record),
    next,
  };
}

/**
 * Split the apps a goal needs into what can be done now and what needs setup.
 *
 * @param {object} input
 * @param {string} input.goal current objective
 * @param {Array} [input.steps] planned steps (workflow or run)
 * @param {Array} [input.episodes] prior workflow-memory episodes
 * @param {Array} [input.installed] apps observed or reported on this desktop
 * @param {string} [input.longTermGoal] the longer goal the run should serve
 */
export function suggestGoalApps({ goal = '', steps = [], episodes = [], installed = [], longTermGoal = '' } = {}) {
  const found = collect(steps);
  addGoalApp(found, goal);
  addObserved(found, installed);
  addHistory(found, episodes);
  if (longTermGoal) {
    const longTermApp = goalApp(longTermGoal);
    if (longTermApp) {
      const key = norm(longTermApp.process || longTermApp.name);
      const existing = found.get(key);
      if (existing) existing.sources.add('long-term goal');
      else {
        found.set(key, {
          key,
          name: longTermApp.name,
          process: longTermApp.process || longTermApp.name,
          sources: new Set(['long-term goal']),
          occurrences: 0,
          version: '',
          catalog: longTermApp.entry || catalogEntry(longTermGoal),
        });
      }
    }
  }

  const immediate = [];
  const longTerm = [];
  for (const record of found.values()) {
    const availability = availabilityOf(record);
    // An app is immediate only when the run can act on it without a setup step.
    const ready = availability === 'observed' || record.sources.has('plan');
    const entry = entryFor(record, ready ? 'immediate' : 'long_term');
    if (ready) immediate.push(entry);
    else longTerm.push(entry);
  }
  immediate.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  longTerm.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const notes = [];
  if (immediate.length) {
    notes.push(
      `${immediate.length} app(s) can be reused now (${immediate.slice(0, 3).map((entry) => entry.name).join(', ')}); the preflight skips the launch or page open when they are already in front.`
    );
  }
  if (longTerm.length) {
    notes.push(
      `${longTerm.length} app(s) need setup before they can serve the goal (${longTerm.slice(0, 3).map((entry) => entry.name).join(', ')}).`
    );
  }
  if (!immediate.length && !longTerm.length) {
    notes.push('The goal does not name an app and the plan has not touched one yet; the first run will settle this.');
  }
  if (longTermGoal) notes.push(`Both lists are checked against the longer goal: ${clip(longTermGoal, 140)}`);

  const brief = [
    immediate.length
      ? `IMMEDIATE (reuse now, no setup):\n${immediate
          .slice(0, 4)
          .map((entry) => `- ${entry.name}${entry.version ? ` ${entry.version}` : ''}: ${entry.why}. ${entry.next}`)
          .join('\n')}`
      : 'IMMEDIATE: no app is ready to reuse yet.',
    longTerm.length
      ? `LONG-TERM (needs setup first):\n${longTerm
          .slice(0, 4)
          .map((entry) => `- ${entry.name}: ${entry.why}. ${entry.next}`)
          .join('\n')}`
      : 'LONG-TERM: nothing extra is needed.',
  ].join('\n\n');

  return {
    immediate: immediate.slice(0, 6),
    longTerm: longTerm.slice(0, 6),
    notes: notes.slice(0, 4),
    brief,
  };
}
