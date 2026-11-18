/**
 * Did the run actually work in the app the goal names?
 *
 * A workflow can pass every step while the requested program is never opened:
 * the plan downloads a VLC installer, plays a sample video in Chrome, and the
 * presenter then reports the VLC goal as met. This module collects the evidence
 * a step left behind (launch/test targets, focused or asserted window titles,
 * install results, media windows) and answers that one question, so approval is
 * based on the app the goal names rather than on the run's status alone.
 *
 * Pure: the caller supplies the goal app (from `goalApp`) and the run.
 */

const OPEN_TYPES = new Set(['launchApp', 'testApp', 'focusWindow', 'clickElement', 'verifyScreen', 'verifyPlayback', 'mediaHold', 'playMedia', 'windowAction', 'dragCopy']);
const INSTALL_TYPES = new Set(['installApp']);
// Input steps only count through what they verified: an unguarded type proves
// nothing about which app received the text, but a guarded one does.
const INPUT_TYPES = new Set(['type', 'key', 'clipboard']);

/** Names, executables and process names worth matching in step text. */
export function appTokens(app) {
  if (!app) return [];
  const values = [app.name, app.process, app.target, app.exe, app.entry?.name, app.entry?.process].filter(Boolean);
  const tokens = new Set();
  for (const value of values) {
    const text = String(value).trim().toLowerCase();
    if (!text) continue;
    const base = text.split(/[\\/]/).pop() || text;
    tokens.add(text);
    tokens.add(base);
    tokens.add(base.replace(/\.exe$/, ''));
  }
  return [...tokens].filter((token) => token.length >= 2);
}

const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word match so "VLC" does not match inside another word. */
export function mentionsApp(text, app) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return false;
  return appTokens(app).some((token) => new RegExp(`(^|[^a-z0-9])${escape(token)}([^a-z0-9]|$)`, 'i').test(haystack));
}

/** Whether the goal asks for the app to be opened/used, not merely installed. */
export function goalNeedsOpen(goal = '') {
  return /\b(?:open|launch|start|run|play|watch|use|show)\b/i.test(String(goal || ''));
}

function evidenceTexts(step) {
  const params = step?.params || {};
  const type = String(step?.type || '');
  const texts = [];
  const push = (field, value) => {
    const text = String(value || '').trim();
    if (text) texts.push({ field, text });
  };
  if (INPUT_TYPES.has(type)) {
    // A passed guard (`foreground: Notepad`) means the executor checked it.
    push('params.foreground', params.foreground);
    push('params.process', params.process);
    push('params.app', params.app);
    push('verification.detail', step?.verification?.detail);
    push('verification.corroborated', step?.verification?.corroborated);
    push('review.observed', step?.review?.observed);
    push('appContext.process', step?.appContext?.process);
    push('appContext.title', step?.appContext?.title);
  }
  if (OPEN_TYPES.has(type) || INSTALL_TYPES.has(type)) {
    push('params.title', params.title);
    push('params.windowName', params.windowName);
    push('params.windowTitle', params.windowTitle);
    push('params.window', params.window);
    push('params.foreground', params.foreground);
    push('params.process', params.process);
    push('params.target', params.target);
    push('params.value', params.value);
    push('params.app', params.app);
    push('params.name', params.name);
    push('verification.detail', step?.verification?.detail);
    push('verification.corroborated', step?.verification?.corroborated);
    push('review.observed', step?.review?.observed);
    push('appContext.process', step?.appContext?.process);
    push('appContext.title', step?.appContext?.title);
    push('output', step?.output);
  }
  return texts;
}

/**
 * @returns {{
 *   app: string,
 *   evidenced: boolean,
 *   needsOpen: boolean,
 *   opens: Array<{stepId: string, name: string, type: string, field: string, text: string}>,
 *   installs: Array<{stepId: string, name: string, type: string, field: string, text: string}>,
 *   observed: string,
 *   reason: string
 * }}
 */
export function goalAppEvidence({ run = {}, workflow = null, goal = '', app = null, foreground = null } = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const opens = [];
  const weak = [];
  const installs = [];
  // Titles and narration only describe what a step aimed at, so they are weak
  // evidence; process/executable/app fields and verification details are strong.
  const titleFields = new Set([
    'params.title',
    'params.windowName',
    'params.windowTitle',
    'params.window',
    'params.foreground',
    'params.value',
    'params.name',
    'output',
  ]);
  for (const step of steps) {
    if (!['passed', 'skipped'].includes(String(step?.status || ''))) continue;
    const type = String(step?.type || '');
    if (!OPEN_TYPES.has(type) && !INSTALL_TYPES.has(type) && !INPUT_TYPES.has(type)) continue;
    for (const entry of evidenceTexts(step)) {
      if (!mentionsApp(entry.text, app)) continue;
      const hit = { stepId: step.id || '', name: step.name || '', type, field: entry.field, text: entry.text.slice(0, 160) };
      if (INSTALL_TYPES.has(type)) installs.push(hit);
      // A window title alone is not proof of the app: a Chrome tab titled "VLC"
      // is still Chrome. Titles only count when the run's own foreground agrees,
      // except a guarded input step whose foreground was enforced at execution.
      else if (titleFields.has(entry.field) && !(INPUT_TYPES.has(type) && entry.field === 'params.foreground')) weak.push(hit);
      else opens.push(hit);
    }
  }
  const runApp = run?.effectiveApp || {};
  if (mentionsApp(runApp.target || runApp.name || '', app) && runApp.target) {
    opens.push({ stepId: '', name: 'Run target', type: 'effectiveApp', field: 'target', text: String(runApp.target).slice(0, 160) });
  }
  const observed = String(foreground?.process || run?.presenter?.app?.process || '').trim();
  const observedTitle = String(foreground?.title || run?.presenter?.app?.title || '').trim();
  // Simulated runs read no desktop, so only an explicit app target counts there.
  // When the foreground process is known, it decides: a Chrome window whose
  // title mentions VLC is still Chrome.
  const foregroundConfirms =
    !run?.dryRun && Boolean(foreground) && (observed ? mentionsApp(observed, app) : mentionsApp(observedTitle, app));
  const corroborated = foregroundConfirms ? weak : [];
  opens.push(...corroborated);
  const needsOpen = goalNeedsOpen(goal);
  // A simulated run reads no desktop and performs no input, so its steps are a
  // plan, not proof: the goal app is never evidenced there.
  const simulated = Boolean(run?.dryRun);
  const evidenced = simulated ? false : needsOpen ? opens.length > 0 : opens.length > 0 || installs.length > 0;
  let reason = '';
  if (simulated) {
    reason = `this was a simulated run, so ${app?.name || 'the requested app'} was never actually opened or verified`;
  } else if (!evidenced) {
    reason = needsOpen
      ? `${app?.name || 'The requested app'} was not opened or verified in this run`
      : `${app?.name || 'The requested app'} was not installed or opened in this run`;
    if (weak.length && observed) reason += `; the only match was a window titled “${weak[0].text}” while ${observed} was in front`;
    else if (observed) reason += `; the steps ran in ${observed}`;
  }
  return { app: String(app?.name || ''), evidenced, needsOpen, opens, installs, weak, observed, reason };
}
