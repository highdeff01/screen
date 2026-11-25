/**
 * Goal decomposition: every word is an element, every element gets a step.
 *
 * A one-line goal like "open chrome go to youtube type diamond lattice" used to
 * reach the planner as a sentence and come back as a plan that only opened
 * Chrome: the verb "type" and its object were read as prose, not as work. This
 * module takes the goal apart the way an operator speaks it — labelling every
 * word, cross-referencing each one to the app, page, field or earlier element it
 * belongs to, and naming the step that realises it — so the plan can be written
 * phrase by phrase and then checked against the same decomposition.
 *
 * Small words are kept, not filtered: "to" is the destination, "in" is the
 * receiving window, "around" is the nearby control, "the" is the element already
 * named, "until" is a condition. They carry the relation between two elements,
 * and dropping one is how a plan loses the page it was supposed to reach.
 *
 * Pure: no database, no desktop, no clock. `planCoverage` only reports; it never
 * adds, rewrites or approves a step.
 */

const ACTION_TYPES = {
  open: 'launchApp',
  launch: 'launchApp',
  start: 'launchApp',
  run: 'launchApp',
  go: 'openUrl',
  navigate: 'openUrl',
  visit: 'openUrl',
  browse: 'openUrl',
  type: 'type',
  enter: 'type',
  input: 'type',
  write: 'type',
  fill: 'type',
  search: 'type',
  click: 'clickElement',
  select: 'clickElement',
  choose: 'clickElement',
  press: 'key',
  hit: 'key',
  play: 'playMedia',
  watch: 'mediaHold',
  pause: 'playMedia',
  wait: 'wait',
  save: 'clickElement',
  submit: 'clickElement',
  sign: 'clickElement',
  login: 'clickElement',
  log: 'clickElement',
  register: 'clickElement',
  create: 'clickElement',
  install: 'clickElement',
  upload: 'clickElement',
  download: 'downloadMedia',
  scroll: 'scroll',
  back: 'key',
  close: 'closeWindow',
  verify: 'verifyScreen',
  check: 'verifyScreen',
  confirm: 'verifyScreen',
  scan: 'clickElement',
  record: 'recordVideo',
};

const SMALL_WORDS = {
  to: { label: 'destination', hint: 'the element after it is where the action goes; open or navigate there before acting' },
  into: { label: 'receiving field', hint: 'the element after it is the field or window that receives the input' },
  in: { label: 'receiving window', hint: 'the element after it is the window, page or field the action happens inside' },
  inside: { label: 'receiving window', hint: 'same as “in”: the following element receives the action' },
  on: { label: 'surface', hint: 'the element after it is the page, tab or control the action happens on' },
  at: { label: 'exact point', hint: 'the element after it is a precise place, coordinate or named spot' },
  around: { label: 'nearby control', hint: 'look at the neighbours of the named anchor: the next control right, below or beside it' },
  near: { label: 'nearby control', hint: 'the matching control is next to the named anchor, not the anchor itself' },
  beside: { label: 'nearby control', hint: 'the matching control sits next to the named anchor' },
  right: { label: 'direction', hint: 'move right of the current anchor (next column, “Up next” panel, sidebar)' },
  below: { label: 'direction', hint: 'move down from the current anchor (next row or list item)' },
  above: { label: 'direction', hint: 'move up from the current anchor' },
  by: { label: 'method', hint: 'the following element is how the action is done (menu, shortcut, button)' },
  with: { label: 'instrument', hint: 'the following element is the text, account or second input used' },
  from: { label: 'source', hint: 'the following element is where the value comes from' },
  for: { label: 'purpose', hint: 'the following element is what the step is for; it shapes the expected result' },
  of: { label: 'owner', hint: 'the following element owns or contains the previous one' },
  the: { label: 'known element', hint: 'refers to the element already named in this clause; do not open a second one' },
  a: { label: 'new element', hint: 'introduces one new element of that kind' },
  an: { label: 'new element', hint: 'introduces one new element of that kind' },
  then: { label: 'order', hint: 'the next element runs after the previous one finished; it is a separate step' },
  and: { label: 'order', hint: 'the next element is part of the same request and still needs its own step' },
  next: { label: 'order', hint: 'the following element is the next step in sequence' },
  after: { label: 'order', hint: 'the following element runs after the previous one' },
  before: { label: 'order', hint: 'the following element runs before the previous one' },
  until: { label: 'condition', hint: 'keep going or wait until this becomes true; use waitFor or mediaHold, not a fixed wait' },
  while: { label: 'condition', hint: 'the state that must hold during the action' },
  if: { label: 'branch', hint: 'a branch: carry both the named case and its fallback in the plan' },
  or: { label: 'fallback', hint: 'an alternative path the plan must carry when the first one is unavailable' },
  all: { label: 'scope', hint: 'apply the step to every matching element' },
  every: { label: 'scope', hint: 'apply the step to every matching element' },
  each: { label: 'scope', hint: 'apply the step to every matching element' },
  any: { label: 'scope', hint: 'the first matching element is enough' },
  again: { label: 'repeat', hint: 'repeat the previous action once the blocking state is cleared' },
  same: { label: 'reuse', hint: 'reuse the element already open instead of opening a new one' },
};

const APPS = [
  ['google chrome', 'Chrome', 'chrome.exe'],
  ['chrome', 'Chrome', 'chrome.exe'],
  ['firefox', 'Firefox', 'firefox.exe'],
  ['edge', 'Edge', 'msedge.exe'],
  ['notepad', 'Notepad', 'notepad.exe'],
  ['calculator', 'Calculator', 'calc.exe'],
  ['calc', 'Calculator', 'calc.exe'],
  ['paint', 'Paint', 'mspaint.exe'],
  ['file explorer', 'File Explorer', 'explorer.exe'],
  ['explorer', 'File Explorer', 'explorer.exe'],
  ['word', 'Word', 'winword.exe'],
  ['excel', 'Excel', 'excel.exe'],
  ['terminal', 'Terminal', 'wt.exe'],
  ['kiro', 'Kiro', 'Kiro.exe'],
  ['sightline accounts', 'Sightline Accounts', ''],
  ['sightline qr', 'Sightline QR', ''],
  ['sightline profile', 'Sightline Profile', ''],
  ['sightline media', 'Sightline Media', ''],
  ['sightline store', 'Sightline Store', ''],
];

const APP_LOOKUP = new Map(APPS.map(([word, name, process]) => [word, { name, process }]));

// Feature nouns the plan has to realise with a step, not just repeat in a name.
const REQUIRED_NOUNS = {
  youtube: { why: 'the goal names YouTube; the plan must reach it (openUrl or search on the site)', test: /youtube/i },
  video: { why: 'the goal names a video; the plan must select one and start playback', test: /video|play|watch|media/i },
  profile: { why: 'the goal fills a profile; the plan must open the profile form', test: /profile/i },
  settings: { why: 'the goal opens settings; the plan must navigate there', test: /settings/i },
  email: { why: 'the goal verifies an email; the plan must read the inbox or code and enter it', test: /email|inbox|code|verif/i },
  code: { why: 'the goal enters a verification code; the plan must type it', test: /code|verif/i },
  qr: { why: 'the goal signs in with a QR code; the plan must show and scan it', test: /qr|scan/i },
  account: { why: 'the goal creates an account; the plan must fill and submit the form', test: /account|sign|register|create/i },
  save: { why: 'the goal saves; the plan must click Save or press the save shortcut', test: /save|ctrl\+s|\^s/i },
  install: { why: 'the goal installs; the plan must click Install or use installApp', test: /install/i },
  search: { why: 'the goal searches; the plan must type the query and submit it', test: /search/i },
  calculator: { why: 'the goal uses the calculator; the plan must enter the expression', test: /calc/i },
};

const FAMILIES = {
  launchApp: ['launchApp', 'openUrl', 'testApp'],
  openUrl: ['openUrl', 'clickElement', 'type', 'key'],
  type: ['type', 'clipboard', 'clickElement', 'key'],
  key: ['key', 'clipboard'],
  clickElement: ['clickElement', 'click', 'doubleClick'],
  playMedia: ['playMedia', 'mediaHold', 'watchVideo', 'verifyPlayback', 'clickElement'],
  wait: ['wait', 'waitFor', 'mediaHold'],
  verifyScreen: ['verifyScreen', 'screenshot', 'verifyPlayback', 'expect', 'waitFor'],
  scroll: ['scroll', 'key', 'clickElement'],
  closeWindow: ['closeWindow', 'windowAction'],
  downloadMedia: ['downloadMedia', 'saveImage', 'installApp'],
  recordVideo: ['recordVideo', 'watchVideo'],
};

const CONNECTORS = new Set(['then', 'and', 'next', 'afterwards', 'after', 'finally']);

function tidy(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function clip(value, max = 120) {
  const text = tidy(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Words with their position in the original text, so quoted text keeps its case. */
export function goalWords(goal) {
  const text = tidy(goal);
  const out = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’._+#@-]*/g;
  let match;
  while ((match = re.exec(text))) {
    out.push({ word: match[0], lower: match[0].toLowerCase(), index: match.index });
  }
  return out;
}

function quotedStrings(goal) {
  const text = String(goal || '');
  const out = [];
  const re = /[“"]([^”"]{1,300})[”"]/g;
  let match;
  while ((match = re.exec(text))) out.push({ text: match[1].trim(), index: match.index });
  return out;
}

function findAppAt(tokens, index) {
  for (const [phrase, app] of APP_LOOKUP) {
    const parts = phrase.split(' ');
    const slice = tokens
      .slice(index, index + parts.length)
      .map((entry) => entry.lower)
      .join(' ');
    if (slice === phrase) return { ...app, length: parts.length };
  }
  return null;
}

function classifyToken(token, app) {
  if (SMALL_WORDS[token.lower]) return 'relation';
  if (ACTION_TYPES[token.lower]) return 'action';
  if (app) return 'app';
  if (/^\d+$/.test(token.lower)) return 'quantity';
  if (/^https?:/.test(token.lower)) return 'url';
  if (token.word.includes('@')) return 'email';
  if (REQUIRED_NOUNS[token.lower]) return 'feature';
  return 'content';
}

/**
 * Label every word and cross-reference it. Each word carries: its kind, the
 * clause it belongs to, the action it serves, the app it belongs to, the next
 * word it points at and the step type that realises it.
 */
export function decomposeGoal(goal) {
  const text = tidy(goal);
  const tokens = goalWords(text);
  const words = [];
  let clause = 1;
  let lastEnd = 0;
  for (const token of tokens) {
    const gap = text.slice(lastEnd, token.index);
    if (/[.;]\s*$/.test(gap) || (CONNECTORS.has(token.lower) && words.length)) clause++;
    lastEnd = token.index + token.word.length;
    const app = findAppAt(tokens, tokens.indexOf(token));
    const kind = classifyToken(token, app);
    words.push({
      at: words.length + 1,
      word: token.word,
      lower: token.lower,
      kind,
      clause,
      app: app ? { name: app.name, process: app.process } : null,
      label: '',
      stepHint: '',
      refs: {},
    });
  }

  // App phrases consume the words they were read from, so "google chrome" is one
  // element and "chrome" is not also planned as a second app.
  for (let index = 0; index < words.length; index++) {
    const entry = words[index];
    if (!entry.app) continue;
    const phrase = APPS.find(([word, name]) => name === entry.app.name && word.split(' ')[0] === entry.lower);
    const length = phrase ? phrase[0].split(' ').length : 1;
    for (let offset = 1; offset < length && words[index + offset]; offset++) {
      words[index + offset].kind = 'app-part';
      words[index + offset].app = entry.app;
    }
    entry.appLength = length;
  }

  const actionIndices = words.filter((entry) => entry.kind === 'action').map((entry) => entry.at - 1);
  for (let index = 0; index < words.length; index++) {
    const entry = words[index];
    if (entry.kind === 'relation') {
      const rule = SMALL_WORDS[entry.lower];
      entry.label = rule.label;
      entry.stepHint = rule.hint;
    } else if (entry.kind === 'action') {
      entry.label = `action: ${ACTION_TYPES[entry.lower]}`;
      entry.stepHint = `realise as ${ACTION_TYPES[entry.lower]}`;
    } else if (entry.kind === 'app') {
      entry.label = `app: ${entry.app.name}`;
      entry.stepHint = `launchApp ${entry.app.name}${entry.app.process ? ` (${entry.app.process})` : ''}, then focusWindow`;
    } else if (entry.kind === 'app-part') {
      entry.label = `app: ${entry.app.name}`;
      entry.stepHint = 'part of the app name above; do not plan it twice';
    } else if (entry.kind === 'quantity') {
      entry.label = 'value';
      entry.stepHint = 'type or wait for this exact value';
    } else if (entry.kind === 'url') {
      entry.label = 'page address';
      entry.stepHint = 'openUrl with this address';
    } else if (entry.kind === 'email') {
      entry.label = 'email address';
      entry.stepHint = 'type this address into the email field';
    } else if (entry.kind === 'feature') {
      const rule = REQUIRED_NOUNS[entry.lower];
      entry.label = `feature: ${entry.lower}`;
      entry.stepHint = rule.why;
    } else {
      entry.label = 'content';
      entry.stepHint = 'carry this word into the nearest step as a label, value or expectation';
    }
    const actionBefore = [...actionIndices].reverse().find((position) => position < index);
    const actionAfter = actionIndices.find((position) => position > index);
    entry.refs = {
      clause: entry.clause,
      action: actionBefore != null ? words[actionBefore].lower : null,
      actionAfter: actionAfter != null ? words[actionAfter].lower : null,
      app: entry.app?.name || null,
      next: words[index + 1]?.lower || null,
      previous: words[index - 1]?.lower || null,
    };
  }

  // Elements: one per action with the words it owns, plus each app, quoted
  // input, URL, condition and required feature noun.
  const elements = [];
  const add = (element) => {
    elements.push({ id: `el${elements.length + 1}`, ...element });
  };
  for (let index = 0; index < words.length; index++) {
    const entry = words[index];
    if (entry.kind !== 'action') continue;
    const verb = ACTION_TYPES[entry.lower];
    const owned = [];
    let cursor = index + 1;
    while (cursor < words.length) {
      const next = words[cursor];
      if (next.kind === 'action' || next.kind === 'relation' || next.kind === 'app') break;
      owned.push(next.word);
      cursor++;
    }
    const app = words.slice(index).find((candidate) => candidate.kind === 'app' && candidate.clause === entry.clause);
    // What the action is aimed at: the first app, feature noun or URL before the
    // next action. “go to youtube” is an openUrl whose target is youtube, not a
    // bare “go” that any step could satisfy.
    let target = null;
    for (let scan = index + 1; scan < words.length && words[scan].kind !== 'action'; scan++) {
      const candidate = words[scan];
      if (candidate.kind === 'app') target = candidate.app.name;
      else if (candidate.kind === 'feature') target = candidate.lower;
      else if (candidate.kind === 'url') target = candidate.word;
      if (target) break;
    }
    add({
      kind: 'action',
      label: `${entry.lower}${owned.length ? ` ${owned.join(' ')}` : ''}`,
      verb,
      object: owned.join(' '),
      target,
      words: [entry.at, ...owned.map((_, offset) => entry.at + offset + 1)],
      app: app?.app?.name || null,
      stepHint: `${verb}${owned.length ? ` for “${clip(owned.join(' '), 60)}”` : target ? ` ${target}` : ''}`,
      required: true,
    });
  }
  for (const entry of words) {
    if (entry.kind === 'app' && !elements.some((element) => element.kind === 'app' && element.label === entry.app.name)) {
      add({
        kind: 'app',
        label: entry.app.name,
        words: [entry.at],
        app: entry.app.name,
        process: entry.app.process,
        stepHint: `launchApp ${entry.app.name}${entry.app.process ? ` (${entry.app.process})` : ''}`,
        required: true,
      });
    }
  }
  for (const quoted of quotedStrings(text)) {
    add({
      kind: 'input',
      label: quoted.text,
      words: [],
      stepHint: `type “${clip(quoted.text, 80)}” exactly, in the named field or window`,
      required: true,
    });
  }
  for (const entry of words) {
    if (entry.kind === 'url') {
      add({ kind: 'url', label: entry.word, words: [entry.at], stepHint: 'openUrl this address', required: true });
    }
    if (entry.kind === 'feature') {
      const rule = REQUIRED_NOUNS[entry.lower];
      if (!elements.some((element) => element.kind === 'feature' && element.label === entry.lower)) {
        add({ kind: 'feature', label: entry.lower, words: [entry.at], stepHint: rule.why, required: true });
      }
    }
    if (entry.kind === 'relation' && ['until', 'while', 'if', 'or'].includes(entry.lower)) {
      add({
        kind: 'condition',
        label: entry.lower,
        words: [entry.at],
        stepHint: SMALL_WORDS[entry.lower].hint,
        required: true,
      });
    }
  }
  for (const element of elements) {
    element.crossRefs = words
      .filter((entry) => entry.app && (element.app ? entry.app.name === element.app : false))
      .map((entry) => entry.at);
  }

  const steps = elements.map((element, index) => ({
    at: index + 1,
    element: element.id,
    label: element.label,
    type: element.kind === 'action' ? element.verb : element.kind === 'app' ? 'launchApp' : element.kind === 'input' ? 'type' : element.kind === 'url' ? 'openUrl' : 'verifyScreen',
    why: element.stepHint,
  }));

  return {
    goal: text,
    words,
    elements,
    stepCandidates: steps,
    clauses: words.reduce((count, entry) => Math.max(count, entry.clause), 0),
    relations: words.filter((entry) => entry.kind === 'relation').map((entry) => ({ word: entry.lower, label: entry.label })),
  };
}

export const DECOMPOSE_RULES =
  'INPUT DECOMPOSITION — read the goal the way the operator speaks it, before writing any step:\n' +
  '1. Break the input into every word and label each one: action, app, page, field, value, quantity, feature, order, condition or relation. Nothing is "just wording".\n' +
  '2. Cross-reference each word to the element it belongs to: which app, which page, which field, which earlier element it continues, which later element it points at.\n' +
  '3. List a step for each phrase, then combine phrases that describe one action. Combining is allowed; dropping an element is not. An element the plan cannot execute yet is still an element: add the step that produces it (open the app, navigate, focus the field).\n' +
  '4. Small words carry the relation and must survive into the plan: "to" = destination, "in/into/inside" = receiving window or field, "on" = the surface, "at" = an exact point, "around/near/beside/right/below" = the nearby control next to the anchor, "the" = the element already named (reuse it, do not open a second), "a/an" = one new element of that kind, "with" = the instrument or second input, "by" = the method, "from" = the source, "for" = purpose, "then/and/next/after" = ordered steps, "until/while" = a wait or condition (waitFor/mediaHold, not a fixed wait), "if/or" = a branch or fallback the plan must carry, "all/every/each/any" = scope, "again" = repeat once the blocker is cleared.\n' +
  '5. Before returning, walk the input again word by word and confirm every labelled element has a step. If one does not, add the step or report it as missing. Never call an element covered because a similar step exists.';

/** The decomposition, rendered for the planning prompt. Deterministic and compact. */
export function decompositionBrief(goal) {
  const decomposed = decomposeGoal(goal);
  if (!decomposed.words.length) return 'INPUT DECOMPOSITION: the goal is empty.';
  const wordLines = decomposed.words.slice(0, 80).map((entry) => {
    const refs = [
      `clause ${entry.refs.clause}`,
      entry.refs.app ? `app ${entry.refs.app}` : '',
      entry.refs.action ? `serves “${entry.refs.action}”` : '',
      entry.refs.next ? `→ ${entry.refs.next}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `  ${entry.at}. “${entry.word}” — ${entry.kind}: ${entry.label}${entry.stepHint ? ` — ${entry.stepHint}` : ''}${refs ? ` [${refs}]` : ''}`;
  });
  const elementLines = decomposed.elements.map(
    (element) => `  ${element.id} ${element.kind}: ${clip(element.label, 90)} — ${element.stepHint}${element.required ? ' [required]' : ''}`
  );
  const stepLines = decomposed.stepCandidates.map((step) => `  ${step.at}. ${step.type} — ${clip(step.label, 90)} (${step.why})`);
  const relationLines = decomposed.relations.length
    ? decomposed.relations.map((entry) => `  “${entry.word}” = ${entry.label}`).join('\n')
    : '  (none)';
  return [
    'INPUT DECOMPOSITION — label every element, cross-reference it, then plan each one:',
    `Goal (${decomposed.words.length} words, ${decomposed.clauses} clause(s)): ${clip(decomposed.goal, 700)}`,
    'Words:',
    ...wordLines,
    'Elements (cross-referenced; required ones must appear as steps):',
    ...elementLines,
    'Step candidates (one per element; combine duplicates, never drop one):',
    ...stepLines,
    'Small-word relations carried into the plan:',
    relationLines,
  ].join('\n');
}

function stepText(step) {
  return `${step?.type || ''} ${step?.name || ''} ${JSON.stringify(step?.params || {})}`.toLowerCase();
}

function escapeText(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function planHas(steps, types, test) {
  return steps.some((step) => types.includes(String(step?.type || '')) && (!test || test.test(stepText(step))));
}

/**
 * Does the plan realise every element of the goal? Read-only: returns what is
 * covered and what is missing, with a follow-up for each gap. It never edits the
 * steps, adds a step or marks a plan approved — review stays with the operator.
 */
export function planCoverage(goal, steps = []) {
  const list = Array.isArray(steps) ? steps : [];
  const decomposed = decomposeGoal(goal);
  const covered = [];
  const missing = [];
  const text = String(goal || '').toLowerCase();

  const record = (element, present, why) => {
    if (present) covered.push(element);
    else missing.push({ element, label: clip(element, 90), why, followUp: `Add the step that realises “${clip(element, 60)}”.` });
  };

  for (const element of decomposed.elements) {
    if (element.kind === 'action') {
      const family = FAMILIES[element.verb] || [element.verb];
      const needle = element.target || element.object || '';
      const test = needle ? new RegExp(escapeText(needle), 'i') : null;
      record(
        element.label,
        planHas(list, family, test),
        `the goal asks to ${element.verb}${needle ? ` ${needle}` : ''}; no ${family.join('/')} step mentions it`
      );
    } else if (element.kind === 'app') {
      const name = String(element.app || '').toLowerCase();
      const present = planHas(
        list,
        ['launchApp', 'focusWindow', 'openUrl', 'testApp'],
        new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      );
      record(element.label, present, `${element.app} is named in the goal but nothing launches, opens or focuses it`);
    } else if (element.kind === 'input') {
      const value = String(element.label || '').toLowerCase();
      record(element.label, list.some((step) => stepText(step).includes(value)), `the goal names the input “${clip(element.label, 60)}” but no step types it`);
    } else if (element.kind === 'url') {
      const url = String(element.label || '').toLowerCase();
      record(element.label, list.some((step) => String(step?.params?.url || '').toLowerCase() === url), `the goal gives the address ${clip(element.label, 80)} but no step opens it`);
    } else if (element.kind === 'feature') {
      const rule = REQUIRED_NOUNS[String(element.label || '').toLowerCase()];
      record(element.label, Boolean(rule && planHas(list, ['type', 'clickElement', 'click', 'key', 'verifyScreen', 'screenshot', 'installApp', 'playMedia', 'mediaHold', 'watchVideo', 'openUrl', 'scroll'], rule.test)), rule?.why || 'the goal names this feature but the plan never realises it');
    }
  }

  // Whole-goal phrases the element list cannot see: a video must actually play,
  // a profile must actually be saved, a sign-in must actually be verified.
  if (/\b(?:play|watch)\b/i.test(text) && !planHas(list, ['playMedia', 'mediaHold', 'watchVideo', 'verifyPlayback'])) {
    missing.push({ element: 'playback', label: 'playback', why: 'the goal asks for playback but no play/watch/media step exists', followUp: 'Add playMedia or watchVideo after the video is open.' });
  }
  if (/\b(?:save|submit)\b/i.test(text) && !planHas(list, ['clickElement', 'click', 'key', 'type'], /\b(?:save|submit|enter|ctrl\+s)\b/i)) {
    missing.push({ element: 'save', label: 'save', why: 'the goal saves but no step clicks Save or submits the form', followUp: 'Add the Save/Submit step (or the save shortcut) after the form is filled.' });
  }
  if (/\b(?:verify|confirm|check)\b/i.test(text) && !planHas(list, ['verifyScreen', 'screenshot', 'verifyPlayback', 'expect', 'waitFor'])) {
    missing.push({ element: 'verification', label: 'verification', why: 'the goal asks to verify, but no screen check or assertion exists', followUp: 'Add verifyScreen or waitFor so the result is judged from pixels or state.' });
  }
  if (/\b(?:wait|until|finish)\b/i.test(text) && !planHas(list, ['wait', 'waitFor', 'mediaHold'])) {
    missing.push({ element: 'wait', label: 'wait', why: 'the goal waits for a result but no wait or waitFor step exists', followUp: 'Add waitFor for the state, not a fixed sleep.' });
  }

  const unique = [];
  const seen = new Set();
  for (const entry of missing) {
    const key = String(entry.element || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  const total = covered.length + unique.length;
  return {
    ok: unique.length === 0,
    ratio: total ? Math.round((covered.length / total) * 100) / 100 : 1,
    covered,
    missing: unique,
    words: decomposed.words.length,
    elements: decomposed.elements.length,
  };
}

/** One line for the plan note: what the plan still does not realise. */
export function describeCoverage(coverage) {
  if (!coverage) return '';
  if (coverage.ok) return `All ${coverage.elements} goal element(s) have a step (${coverage.ratio * 100}% coverage).`;
  return `${coverage.missing.length} goal element(s) still have no step: ${coverage.missing
    .slice(0, 6)
    .map((entry) => entry.label)
    .join('; ')}.`;
}

export const __goalDecompose = { ACTION_TYPES, SMALL_WORDS, APPS, REQUIRED_NOUNS, FAMILIES };
