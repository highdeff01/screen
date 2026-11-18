/**
 * The action firewall — every step passes the gate before it acts.
 *
 * A step is checked against ordered rules and receives a verdict:
 *
 *   allow    run as planned
 *   deny     do not run; the reason is recorded on the step and the run
 *   review   do not run yet; the step is offered to the operator (and the
 *            relay review queue) as a decision instead of an action
 *
 * The defaults encode the lessons already learned the hard way: nothing acts
 * destructively, nothing closes a window that holds unsaved work, nothing
 * types without a proven destination, nothing installs software silently.
 * The operator can add rules (a regex plus a verdict), switch between enforce
 * (decisions are applied) and log (decisions are recorded but steps still run),
 * and test rules against a synthetic step without running anything.
 *
 * The firewall never sees secrets and never edits anything itself; it is a
 * checkpoint the engine calls with what it was about to do.
 */
import { db, logActivity, now, persist, uid } from './store.js';

const DEFAULT_RULES = [
  {
    id: 'fw_destructive',
    name: 'Nothing destructive',
    verdict: 'deny',
    reason: 'the action matches a destructive pattern (delete/format/shutdown/force-kill); the firewall refuses it',
    match: { types: ['runTool', 'writeTextFile'], paramPattern: '(?i)(\\bdel\\b|\\brm\\b|delete|format |shutdown|taskkill|/f\\b|force.*delete)' },
  },
  {
    id: 'fw_unsaved_close',
    name: 'Never close a window with unsaved work',
    verdict: 'deny',
    reason: 'the target window shows unsaved changes; closing it would destroy the operator’s work',
    match: { types: ['windowAction', 'closeWindow'], paramPattern: '(?i)close' },
    needsUnsaved: true,
  },
  {
    id: 'fw_no_destination',
    name: 'Typing needs a proven destination',
    verdict: 'deny',
    reason: 'the input step has no window to type into; typing anywhere is how text ended up in the wrong document',
    match: { types: ['type', 'key', 'clipboard'] },
    needsDestination: true,
  },
  {
    id: 'fw_install_review',
    name: 'Installs are reviewed',
    verdict: 'review',
    reason: 'installing software changes the machine; an operator or agent looks first',
    match: { types: ['installApp'] },
  },
];

function firewall() {
  const d = db();
  if (!d.firewall || typeof d.firewall !== 'object') d.firewall = { mode: 'enforce', rules: null };
  if (!Array.isArray(d.firewall.rules)) d.firewall.rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  d.firewall.mode = d.firewall.mode === 'log' ? 'log' : 'enforce';
  return d.firewall;
}

export function firewallStatus() {
  const fw = firewall();
  return { mode: fw.mode, rules: fw.rules };
}

export function setFirewallMode(mode) {
  const fw = firewall();
  fw.mode = mode === 'log' ? 'log' : 'enforce';
  persist();
  logActivity('firewall', `Firewall mode: ${fw.mode}`, {});
  return firewallStatus();
}

export function addFirewallRule({ name = '', verdict = 'review', pattern = '', types = [], reason = '' } = {}) {
  const label = String(name || '').trim().slice(0, 60);
  const body = String(pattern || '').trim();
  const where = (Array.isArray(types) ? types : String(types || '').split(',')).map((type) => String(type).trim()).filter(Boolean);
  if (!label) throw new Error('A rule needs a name.');
  if (!['deny', 'review', 'allow'].includes(verdict)) throw new Error('A verdict is allow, review or deny.');
  if (!body) throw new Error('A rule needs a pattern to match against step params.');
  try {
    new RegExp(body); // eslint-disable-line no-new
  } catch (err) {
    throw new Error(`That pattern is not a valid regular expression: ${err.message}`);
  }
  const rule = { id: uid('fw'), name: label, verdict, reason: String(reason || '').slice(0, 300), match: { types: where, paramPattern: body } };
  firewall().rules.push(rule);
  persist();
  logActivity('firewall', `Firewall rule “${label}” added (${verdict})`, {});
  return rule;
}

export function removeFirewallRule(id) {
  const fw = firewall();
  const index = fw.rules.findIndex((rule) => rule.id === id);
  if (index === -1) throw new Error('Rule not found');
  const [removed] = fw.rules.splice(index, 1);
  persist();
  return removed;
}

/** Rebuild the defaults (after a bad custom rule made a mess). */
export function resetFirewallRules() {
  const fw = firewall();
  fw.rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  persist();
  return firewallStatus();
}

/** Does the window show unsaved work? Uses the title markers editors use. */
const UNSAVED = /^[*•]\s|— \*|\*[^*]* - /;

/**
 * Rules are written with the PCRE habit operators and small models share, so a
 * leading inline (?i)/(?m)/(?s) becomes a JS flag instead of throwing at match
 * time. A pattern that still cannot compile matches: a broken safety rule must
 * block its step, never crash the run that asked.
 */
function compileRulePattern(pattern) {
  let source = String(pattern || '');
  let flags = '';
  const inline = source.match(/^\(\?([a-z]+)\)/i);
  if (inline) {
    const letters = inline[1].toLowerCase();
    if (letters.includes('i')) flags += 'i';
    if (letters.includes('m')) flags += 'm';
    if (letters.includes('s')) flags += 's';
    source = source.slice(inline[0].length);
  }
  return new RegExp(source, flags);
}

function rulePatternMatches(pattern, text) {
  try {
    return compileRulePattern(pattern).test(text);
  } catch {
    return true;
  }
}

function ruleMatches(rule, step, run) {
  const match = rule.match || {};
  if (match.types?.length && !match.types.includes(step.type)) return false;
  if (match.paramPattern) {
    let text = '';
    try {
      text = JSON.stringify(step.params || {});
    } catch {
      text = String(step.params || '');
    }
    if (!rulePatternMatches(match.paramPattern, text)) return false;
  }
  if (rule.needsUnsaved) {
    // The rule only bites when there is something to protect.
    const title = String(run?.lastWindow?.title || step.params?.title || step.params?.foreground || '');
    if (!UNSAVED.test(title)) return false;
  }
  if (rule.needsDestination) {
    const destination = String(step.params?.foreground || step.params?.window || '').trim() || String(run?.lastWindow?.title || '').trim();
    if (destination) return false; // there IS a destination; the typing guard owns it
    return true;
  }
  return true;
}

/**
 * The gate the engine calls. `run` carries context (lastWindow, status) so
 * context rules (unsaved work, destination) can decide.
 */
export function firewallCheck(step, run = null) {
  const fw = firewall();
  const rules = fw.rules || [];
  for (const rule of rules) {
    if (rule.verdict === 'allow') continue;
    if (!ruleMatches(rule, step, run)) continue;
    const verdict = {
      verdict: rule.verdict,
      ruleId: rule.id,
      ruleName: rule.name,
      reason: rule.reason || `matched firewall rule “${rule.name}”`,
      mode: fw.mode,
    };
    if (fw.mode === 'log') return { ...verdict, verdict: 'allow', loggedVerdict: rule.verdict };
    return verdict;
  }
  return { verdict: 'allow', ruleId: null, ruleName: null, reason: '', mode: fw.mode };
}

/** Test rules against a synthetic step without running anything. */
export function firewallTest(step, run = null) {
  return firewallCheck(step, run);
}
