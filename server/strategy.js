/**
 * Strategy briefs.
 *
 * Before a plan or a repair is written, the console states what the goal really
 * asks for, which method it will try first and why, what the fallback order is,
 * and what would continue the work afterwards. The brief is evidence the model
 * can reuse instead of inventing a fresh approach for every attempt, and it is
 * written as text so the same block can be injected into the planner, the plan
 * repair and the live repair agent.
 *
 * Pure helpers: no desktop, no model, no I/O.
 */

import { INSTALL_CATALOG, catalogEntry } from './app-install.js';

const PHASE_RULES = [
  { key: 'search', label: 'find the right source', match: /\b(?:search|google|look\s*(?:up|around)|find|browse|compare)\b/i },
  { key: 'download', label: 'download the installer or media', match: /\bdownload\b/i },
  { key: 'install', label: 'install the program', match: /\binstall\b/i },
  { key: 'launch', label: 'open the program', match: /\b(?:open|launch|start|run)\b/i },
  { key: 'play', label: 'play or exercise the media', match: /\b(?:play|watch|listen|stream)\b/i },
  { key: 'verify', label: 'prove it works', match: /\b(?:verify|confirm|check|make\s+sure|prove|works?|test)\b/i },
  { key: 'capture', label: 'capture evidence', match: /\b(?:screenshot|capture|record|evidence)\b/i },
  { key: 'note', label: 'save what happened', match: /\b(?:note|save|write|report|document)\b/i },
  { key: 'cleanup', label: 'clean up and close', match: /\b(?:close|clean\s*up|remove|uninstall)\b/i },
];

const APP_ALIASES = [
  { match: /\bchrome\b|google chrome/i, name: 'Chrome', process: 'chrome', target: 'chrome.exe' },
  { match: /\bedge\b|microsoft edge/i, name: 'Edge', process: 'msedge', target: 'msedge.exe' },
  { match: /\bfirefox\b/i, name: 'Firefox', process: 'firefox', target: 'firefox.exe' },
  { match: /\bnotepad\b/i, name: 'Notepad', process: 'Notepad', target: 'notepad.exe' },
  { match: /\bpaint\b|mspaint/i, name: 'Paint', process: 'mspaint', target: 'mspaint.exe' },
  { match: /\bcalculator\b|\bcalc\b/i, name: 'Calculator', process: 'calc', target: 'calc.exe' },
  { match: /\bexplorer\b|file explorer/i, name: 'File Explorer', process: 'explorer', target: 'explorer.exe' },
  { match: /\bterminal\b|\bwt\b/i, name: 'Windows Terminal', process: 'WindowsTerminal', target: 'wt.exe' },
];

/** Phases the goal actually names, in the order a workflow should cover them. */
export function goalPhases(goal = '') {
  const text = String(goal || '');
  const phases = PHASE_RULES.filter((rule) => rule.match.test(text)).map((rule) => ({
    key: rule.key,
    label: rule.label,
  }));
  if (!phases.length) phases.push({ key: 'act', label: 'perform the requested action' });
  return phases;
}

/** The app a goal names, as a catalogue entry or a plain executable hint. */
export function goalApp(goal = '') {
  const text = String(goal || '');
  const entry = catalogEntry(text);
  if (entry) {
    return { name: entry.name, process: entry.process, wingetId: entry.wingetId, exe: entry.exe?.[0] || '', entry };
  }
  const alias = APP_ALIASES.find((item) => item.match.test(text));
  return alias ? { name: alias.name, process: alias.process, wingetId: '', exe: '', target: alias.target, entry: null } : null;
}

/** Ordered install methods for an app, each with the trade-off that decides it. */
export function installMethodIdeas(app = null, goal = '') {
  const entry = app?.entry || catalogEntry(goal) || null;
  const name = app?.name || entry?.name || 'the app';
  const methods = [];
  if (entry?.wingetId) {
    methods.push({
      method: `winget install --id ${entry.wingetId} --exact`,
      why: 'No browser, no guessed download button, exit code plus registry verification, easy rollback with winget uninstall.',
      risk: 'Needs winget on PATH and a network source that is not blocked.',
    });
  }
  if (entry?.pages?.length) {
    methods.push({
      method: `install ${name} from its official page (${entry.pages[0]})`,
      why: `Finds the real ${name} installer link on the vendor page, then verifies the installed executable and uninstall entry.`,
      risk: 'The page layout or version link can change; the discovery step must find a .exe/.msi.',
    });
  }
  if (entry?.exe?.length) {
    methods.push({
      method: `launch ${entry.exe[0]} after install`,
      why: 'A filesystem check plus a visible foreground window is stronger proof than an installer exit code.',
      risk: 'Some installers need a first-run dialog before the main window appears.',
    });
  }
  methods.push({
    method: 'Microsoft Store (ms-windows-store://search/?query=…)',
    why: 'Useful when the vendor installer is blocked and the app is published in the Store.',
    risk: 'Store availability and package identity differ from the desktop build.',
  });
  return methods;
}

/** What a good operator would do after the named phases, not more of the same. */
export function continuationIdeas({ goal = '', phases = [] } = {}) {
  const keys = new Set(phases.map((phase) => phase.key));
  const text = String(goal || '');
  const ideas = [];
  if (keys.has('install') && !keys.has('verify')) {
    ideas.push('Launch the new program, confirm its window is in front and capture it, then save a short install-and-smoke-test note.');
  }
  if (keys.has('download') && !keys.has('launch')) {
    ideas.push('Open the downloaded file with the app it belongs to instead of stopping at the file on disk.');
  }
  if (keys.has('play') && !keys.has('verify')) {
    ideas.push('Check that playback actually advanced (two frames or the player clock), not just that the player opened.');
  }
  if (keys.has('search') && !keys.has('note')) {
    ideas.push('Record which source worked and its exact link, so the next run can go straight to it.');
  }
  if (/\bvlc|media|video|movie\b/i.test(text)) {
    ideas.push('After playback, note the player, the file and the elapsed time, so a later run can resume without re-downloading.');
  }
  if (/\binstall\b/i.test(text)) {
    ideas.push('Keep the uninstall command in the note so the user can reverse the install in one step.');
  }
  if (!ideas.length) ideas.push('Capture the end state and save a note describing what changed, so the next run starts from evidence.');
  return ideas.slice(0, 4);
}

/**
 * A compact brief for the planner or repair agent: objective, method order,
 * continuations, and the guardrails that keep the run aligned with the user's
 * longer-term goal.
 */
export function strategyBrief({
  goal = '',
  app = null,
  lessons = [],
  attempts = [],
  longTermGoal = '',
  limitMethods = 3,
} = {}) {
  const phases = goalPhases(goal);
  const resolved = app || goalApp(goal);
  const wantsInstall = phases.some((phase) => phase.key === 'install');
  const methods = wantsInstall ? installMethodIdeas(resolved, goal).slice(0, limitMethods) : [];
  const continuations = continuationIdeas({ goal, phases });
  const lines = [];
  lines.push(`OBJECTIVE: ${String(goal || 'not recorded').trim()}`);
  if (longTermGoal) lines.push(`LONG-TERM GOAL: ${longTermGoal}`);
  lines.push(`PHASES (in order): ${phases.map((phase) => phase.label).join(' -> ')}`);
  if (resolved) {
    lines.push(
      `APP: ${resolved.name}${resolved.wingetId ? ` (winget ${resolved.wingetId})` : ''}${resolved.exe ? ` — usual path ${resolved.exe}` : ''}`
    );
  }
  if (methods.length) {
    lines.push('INSTALL METHODS (try in this order, stop at the first verified one):');
    methods.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.method} — ${entry.why} Risk: ${entry.risk}`);
    });
  }
  if (attempts.length) {
    lines.push('ALREADY TRIED (do not repeat these unchanged):');
    for (const attempt of attempts.slice(0, 6)) lines.push(`- ${attempt}`);
  }
  if (lessons.length) {
    lines.push('LESSONS FROM THIS WORKSTATION:');
    for (const lesson of lessons.slice(0, 4)) lines.push(`- ${String(lesson).replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  lines.push('CONTINUE WITH:', ...continuations.map((idea) => `- ${idea}`));
  lines.push(
    'ALREADY IN PROGRESS: if a dialog, installer window or the app itself from this goal is already open, continue from it (type into the open field, click its own Save/Next/Finish) instead of restarting that phase; the runner re-reads the foreground window before every step and skips a launch or focus that is already satisfied.'
  );
  lines.push(
    'GUARDRAILS: only install or change what the goal names; never substitute another app; prefer a reversible action; do not disable security tools, change system settings or delete user data to make a step pass; if a method needs an admin prompt or a reboot, record that and continue the safe checks first.'
  );
  return { text: lines.join('\n'), phases, app: resolved, methods, continuations };
}

/** True when the goal asks for software to be installed. */
export function wantsInstall(goal = '') {
  return /\b(?:install|set\s*up|provision)\b/i.test(String(goal || ''));
}

/** The catalogue names, for prompts that want to hint without guessing. */
export function catalogNames() {
  return INSTALL_CATALOG.map((entry) => entry.name);
}
