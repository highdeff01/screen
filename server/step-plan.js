/**
 * Step planning from the operator's own words.
 *
 * The planner used to answer every short request with a template or a
 * remembered workflow, so "type hi in notepad" came back as a Kiro → Notepad
 * answer-capture flow and the steps never mentioned the text that was asked
 * for. Two things live here:
 *
 *  - `parseDirective` reads the explicit operations in one short instruction
 *    (open an app, type text, press keys, click a visible control, wait, open a
 *    URL, capture a screen check) instead of guessing a whole workflow.
 *  - `planStepChange` turns that reading into a reviewable change against the
 *    workflow's current steps: it updates an existing step when the same
 *    action is already there, inserts the missing prerequisite (launch/focus)
 *    and re-syncs the steps that follow, so the plan stays internally
 *    consistent. Nothing is written until the operator approves it.
 *
 * The module is pure: no database, no desktop, no clock.
 */

const APP_ALIASES = {
  notepad: { name: 'Notepad', target: 'notepad.exe', process: 'notepad.exe' },
  'notepad++': { name: 'Notepad++', target: 'notepad++.exe', process: 'notepad++.exe' },
  calculator: { name: 'Calculator', target: 'calc.exe', process: 'calc.exe' },
  calc: { name: 'Calculator', target: 'calc.exe', process: 'calc.exe' },
  paint: { name: 'Paint', target: 'mspaint.exe', process: 'mspaint.exe' },
  explorer: { name: 'File Explorer', target: 'explorer.exe', process: 'explorer.exe' },
  'file explorer': { name: 'File Explorer', target: 'explorer.exe', process: 'explorer.exe' },
  chrome: { name: 'Chrome', target: 'chrome.exe', process: 'chrome.exe' },
  'google chrome': { name: 'Chrome', target: 'chrome.exe', process: 'chrome.exe' },
  firefox: { name: 'Firefox', target: 'firefox.exe', process: 'firefox.exe' },
  edge: { name: 'Edge', target: 'msedge.exe', process: 'msedge.exe' },
  word: { name: 'Word', target: 'winword.exe', process: 'winword.exe' },
  excel: { name: 'Excel', target: 'excel.exe', process: 'excel.exe' },
  vscode: { name: 'Visual Studio Code', target: 'code', process: 'Code.exe' },
  'vs code': { name: 'Visual Studio Code', target: 'code', process: 'Code.exe' },
  terminal: { name: 'Terminal', target: 'wt.exe', process: 'WindowsTerminal.exe' },
  kiro: { name: 'Kiro', target: 'Kiro', process: 'Kiro.exe' },
};

const SUPPORTED_VERB =
  /\b(?:open|launch|start|run|type|enter|input|write|say|put|press|send|click|double[- ]?click|wait|sleep|screenshot|capture|verify|go to|navigate to)\b/i;

// A goal that asks for work this parser does not model belongs to the planner,
// not here. Answering half of it would hide the rest.
const UNSUPPORTED_VERB =
  /\b(?:save|install|download|uninstall|play|watch|search|copy|paste|select all|drag|scroll|record|extract|upload|attach|print|close)\b/i;

const VARIABLE_TEXT = {
  answer: 'extractedText',
  response: 'extractedText',
  result: 'extractedText',
  text: 'clipboardText',
  clipboard: 'clipboardText',
  note: 'noteText',
  output: 'savedTextFile',
};

const MUTATING_TYPES = new Set([
  'type',
  'key',
  'click',
  'doubleClick',
  'rightClick',
  'clickElement',
  'drag',
  'dragCopy',
  'scroll',
  'clipboard',
  'playMedia',
]);

function tidy(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value, max = 120) {
  const text = tidy(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appHint(phrase) {
  const key = tidy(phrase).toLowerCase();
  if (!key) return null;
  const known = APP_ALIASES[key];
  if (known) return { ...known, matched: true };
  if (!/^[a-z][\w .+#-]*$/i.test(key)) return null;
  return { name: tidy(phrase).replace(/\b\w/g, (letter) => letter.toUpperCase()), target: tidy(phrase), process: '', matched: false };
}

/** What the instruction explicitly asks for, or null when it is not a directive. */
export function parseDirective(instruction) {
  const text = tidy(instruction);
  if (!text) return null;
  const words = text.split(' ').filter(Boolean);
  // Long descriptions, and goals that mix in work this parser does not model,
  // stay with the workflow planner.
  if (words.length > 26) return null;
  if (UNSUPPORTED_VERB.test(text)) return null;
  if ((text.match(/\b(?:then|after that|afterwards|next)\b/gi) || []).length > 1) return null;

  const openMatch = text.match(
    /\b(?:open|launch|start|run)\s+(?:the\s+)?([a-z][\w .+#-]{1,24}?)(?=\s+(?:and|then|to|for|with|in|into|,|;|$))/i
  );
  const inMatch = text.match(
    /\b(?:in|into|on|inside)\s+(?:the\s+)?([a-z][\w .+#-]{1,24}?)(?=\s*(?:,|;|\.|$))/i
  );
  const app = appHint(openMatch?.[1] || inMatch?.[1] || '');
  const openedApp = Boolean(openMatch);

  let input = null;
  const quoted = text.match(
    /\b(?:type|enter|input|write|say|put)\s+(?:the\s+)?(?:text\s+|words?\s+|message\s+)?["“']([^"”']{1,400})["”']/i
  );
  const loose = text.match(
    /\b(?:type|enter|input|write|say|put)\s+(?:the\s+)?(?:text\s+|words?\s+|message\s+)?(.+?)(?=\s+(?:in|into|on|inside)\s+(?:the\s+)?[a-z][\w .-]{1,24}$|[,.;]|$)/i
  );
  const inputText = tidy(quoted?.[1] || loose?.[1] || '');
  if (inputText) {
    const variable = VARIABLE_TEXT[inputText.toLowerCase().replace(/^the\s+/, '')];
    if (variable) input = { kind: 'var', textVar: variable, reference: inputText };
    else input = { kind: 'text', text: inputText, reference: inputText };
  }

  const shortcutRegex =
    /\b(?:ctrl|control|alt|shift|win|cmd)\s*\+\s*(?:[a-z0-9]|enter|escape|esc|tab|space|backspace|delete|home|end|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2]))\b/gi;
  const keys = [...new Set((text.match(shortcutRegex) || []).map((value) => value.toLowerCase().replace(/\s*\+\s*/g, '+')))];

  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  const waitMatch = text.match(/\b(?:wait|sleep|pause)\s*(?:for\s*)?(\d{1,6})\s*(ms|milliseconds|s|sec|seconds)?/i);
  const clickMatch = text.match(
    /\b(?:click|double[- ]?click)\s+(?:the\s+|a\s+)?["“']?([\w .&+-]{2,40}?)["”']?(?:\s+(?:button|link|menu|tab|field|box|control))?(?=[,.;]|$)/i
  );
  const clickKind = /\bdouble[- ]?click\b/i.test(text) ? 'doubleClick' : 'clickElement';
  const capture = /\b(?:screenshot|capture|screen check|verify|check the screen)\b/i.test(text);
  const asksForInput = /\b(?:type|enter|input|write|say|put)\b/i.test(text);
  const asksForApp = /\b(?:open|launch|start|run)\b/i.test(text);

  const actions = [];
  if (app) actions.push({ kind: 'app', app });
  if (urlMatch) actions.push({ kind: 'url', url: urlMatch[0] });
  if (input) actions.push({ kind: 'input', input });
  if (keys.length) actions.push({ kind: 'keys', keys });
  if (waitMatch) {
    const amount = Number(waitMatch[1]);
    const ms = /^s|sec/i.test(waitMatch[2] || '') ? amount * 1000 : amount;
    if (Number.isFinite(ms) && ms > 0) actions.push({ kind: 'wait', ms });
  }
  if (clickMatch && !asksForInput) actions.push({ kind: 'click', type: clickKind, name: tidy(clickMatch[1]) });
  if (capture) actions.push({ kind: 'capture' });

  if (!actions.length) return null;
  if (!SUPPORTED_VERB.test(text)) return null;
  // "open notepad" alone is still a usable directive; "type hi" without an app
  // is a usable directive too, but the destination is recorded as missing.
  const executors = actions.filter((action) => action.kind !== 'app');
  const confident = Boolean(app || executors.length);
  if (!confident) return null;

  const missing = [];
  if (asksForInput && !app) missing.push('the app or window that should receive the input');
  if (input?.kind === 'var') missing.push(`a step before this one that produces “${input.textVar}”`);
  if (capture && !app && !executors.some((action) => action.kind === 'input')) missing.push('what the screen check should be looking at');

  return {
    instruction: text,
    app,
    openedApp,
    input,
    keys,
    url: urlMatch?.[0] || '',
    waitMs: actions.find((action) => action.kind === 'wait')?.ms || 0,
    click: actions.find((action) => action.kind === 'click') || null,
    capture,
    actions,
    missing,
    // An app plus an action is what makes a directive worth trusting as a whole
    // plan; one action alone is still applied, with its missing part surfaced.
    confidence: app && executors.length ? 0.94 : app ? 0.8 : executors.length ? 0.62 : 0,
    asksForApp,
  };
}

/** Raw steps for a parsed directive. The caller normalizes them. */
export function directiveSteps(parsed) {
  if (!parsed) return [];
  const out = [];
  const label = parsed.app?.name || '';
  if (parsed.app) {
    out.push({ type: 'launchApp', name: `Open ${label}`, params: { target: parsed.app.target } });
    out.push({ type: 'wait', name: 'Wait for the app window', params: { ms: 1200 } });
    out.push({
      type: 'focusWindow',
      name: `Focus ${label}`,
      params: { title: label, ...(parsed.app.process ? { process: parsed.app.process } : {}) },
    });
  }
  if (parsed.url) {
    out.push({ type: 'openUrl', name: 'Open the page', params: { url: parsed.url } });
    out.push({ type: 'wait', name: 'Wait for the page', params: { ms: 2000 } });
  }
  if (parsed.input?.kind === 'text') {
    out.push({
      type: 'type',
      name: `Input “${clip(parsed.input.text, 40)}”`,
      params: { text: parsed.input.text, ...(label ? { foreground: label } : {}) },
    });
  } else if (parsed.input?.kind === 'var') {
    out.push({
      type: 'type',
      name: `Input the ${parsed.input.reference}`,
      params: { textVar: parsed.input.textVar, ...(label ? { foreground: label } : {}) },
    });
  }
  if (parsed.keys?.length) {
    out.push({
      type: 'key',
      name: `Press ${parsed.keys.join(', ')}`,
      params: { keys: parsed.keys, ...(label ? { foreground: label } : {}) },
    });
  }
  if (parsed.click) {
    out.push({
      type: parsed.click.type === 'doubleClick' ? 'doubleClick' : 'clickElement',
      name: `${parsed.click.type === 'doubleClick' ? 'Double-click' : 'Click'} ${parsed.click.name}`,
      params:
        parsed.click.type === 'doubleClick'
          ? { name: parsed.click.name }
          : { name: parsed.click.name, ...(label ? { window: label } : {}) },
    });
  }
  if (parsed.waitMs) out.push({ type: 'wait', name: `Wait ${parsed.waitMs}ms`, params: { ms: parsed.waitMs } });
  if (out.some((step) => MUTATING_TYPES.has(step.type)) || parsed.capture) {
    out.push({
      type: 'screenshot',
      name: 'Screen check',
      params: { caption: `Screen check — after ${label ? `${label} ` : ''}${parsed.input ? 'input' : 'the change'}` },
    });
  }
  return out;
}

function stepAppText(step) {
  const params = step?.params || {};
  return tidy(
    [
      step?.name,
      params.title,
      params.foreground,
      params.window,
      params.target,
      params.app,
      params.process,
    ]
      .filter(Boolean)
      .join(' ')
  ).toLowerCase();
}

function mentionsApp(step, app) {
  if (!app) return true;
  return stepAppText(step).includes(tidy(app.name).toLowerCase());
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function variableReads(step) {
  const params = step?.params || {};
  const reads = [];
  const add = (key) => {
    const name = tidy(params[key]);
    if (name) reads.push(name);
  };
  if (step?.type === 'type') add('textVar');
  else if (['writeNote', 'writeTextFile', 'watchVideo'].includes(step?.type)) add('textVar');
  else if (step?.type === 'clipboard' && ['write', 'paste'].includes(String(params.action || '').toLowerCase())) add('textVar');
  else if (step?.type === 'aiExtract' && params.source === 'text') add('textVar');
  return [...new Set(reads)];
}

function variableWrites(step) {
  const params = step?.params || {};
  const writes = [];
  const add = (fallback) => {
    const name = tidy(params.outputVar ?? fallback);
    if (name) writes.push(name);
  };
  if (step?.type === 'clipboard') add('clipboardText');
  else if (step?.type === 'aiExtract') add('extractedText');
  else if (step?.type === 'dragCopy') add('selectedText');
  else if (step?.type === 'readNote') add('noteText');
  else if (step?.type === 'writeTextFile') add('savedTextFile');
  else if (step?.type === 'copyLink') add('copiedLink');
  return [...new Set(writes)];
}

function screenshotIndex(steps) {
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index].type === 'screenshot') return index;
  }
  return -1;
}

/**
 * Keep the plan coherent after a change: no duplicate steps, every input step
 * guarded by the window it names, a launch before the first focus, a screen
 * checkpoint after the last action, and visible gaps where a value is read but
 * nothing produces it.
 */
export function syncWorkflowSteps(steps, { goal = '' } = {}) {
  const out = (Array.isArray(steps) ? steps : []).map((step) => JSON.parse(JSON.stringify(step || {})));
  const fixes = [];
  const gaps = [];

  // 1. Consecutive exact duplicates add a second action for one instruction.
  for (let index = out.length - 1; index > 0; index--) {
    const previous = out[index - 1];
    if (previous.type === out[index].type && sameValue(previous.params, out[index].params)) {
      fixes.push({ op: 'dedupe', name: out[index].name, reason: `Removed a duplicate of step ${index}.` });
      out.splice(index, 1);
    }
  }

  // 2. Every typing/pasting step must name the window it types into, taken from
  //    the focus step above it. An unguarded input can land in the wrong app.
  for (let index = 0; index < out.length; index++) {
    const step = out[index];
    if (!['type', 'key'].includes(step.type)) continue;
    if (tidy(step.params?.foreground)) continue;
    const focus = [...out.slice(0, index)].reverse().find((entry) => entry.type === 'focusWindow' && tidy(entry.params?.title));
    if (!focus) continue;
    step.params = { ...(step.params || {}), foreground: focus.params.title };
    fixes.push({
      op: 'bind',
      name: step.name,
      reason: `Guarded “${step.name}” with the focused window “${focus.params.title}”.`,
    });
  }

  // 3. A focus or input for an app that was never opened starts the run with
  //    window_not_found. Insert the launch once, before the first such step.
  const firstAppStep = out.find((step) => ['focusWindow', 'type', 'key'].includes(step.type) && tidy(step.params?.title || step.params?.foreground));
  if (firstAppStep) {
    const label = tidy(firstAppStep.params.title || firstAppStep.params.foreground);
    const launched = out.some(
      (step) => step.type === 'launchApp' && stepAppText(step).includes(label.toLowerCase())
    );
    if (!launched && !out.some((step) => step.type === 'launchApp')) {
      const hint = appHint(label);
      if (hint) {
        const index = out.indexOf(firstAppStep);
        const launch = { type: 'launchApp', name: `Open ${hint.name}`, params: { target: hint.target } };
        const wait = { type: 'wait', name: 'Wait for the app window', params: { ms: 1200 } };
        out.splice(index, 0, launch, wait);
        fixes.push({ op: 'add', name: launch.name, reason: `“${hint.name}” was used before anything opened it.` });
      }
    }
  }

  // 4. A passing action with no visible check leaves the run unverified.
  const lastAction = out.map((step) => MUTATING_TYPES.has(step.type)).lastIndexOf(true);
  if (lastAction >= 0 && screenshotIndex(out) < lastAction) {
    out.push({
      type: 'screenshot',
      name: 'Screen check',
      params: { caption: 'Screen check — after the last action' },
    });
    fixes.push({ op: 'checkpoint', name: 'Screen check', reason: 'Added a screenshot check after the last action so the result is visible.' });
  }

  // 5. A value read before anything writes it is a plan gap the operator must
  //    see at approval time, not a failure halfway through the run.
  const produced = new Set();
  out.forEach((step, index) => {
    for (const name of variableReads(step)) {
      if (!produced.has(name)) {
        gaps.push({
          index,
          step: step.name,
          variable: name,
          reason: `Step ${index + 1} reads “${name}”, but no earlier step produces it.`,
        });
      }
    }
    for (const name of variableWrites(step)) produced.add(name);
  });

  return { steps: out, fixes, gaps };
}

function findInputIndex(steps, app) {
  const inputs = steps.map((step, index) => (['type', 'key'].includes(step.type) ? index : -1)).filter((index) => index >= 0);
  if (app) {
    const exact = steps.findIndex((step) => ['type', 'key'].includes(step.type) && mentionsApp(step, app));
    if (exact >= 0) return exact;
  }
  // One input step with no destination is the workflow's only input: update it
  // rather than adding a second typing step that repeats the same action.
  if (inputs.length === 1) {
    const only = steps[inputs[0]];
    const destination = tidy(only.params?.foreground || only.params?.title);
    if (!destination || !app || mentionsApp(only, app)) return inputs[0];
  }
  return app ? -1 : inputs[0] ?? -1;
}

function insertionIndex(steps, app) {
  const focusAt = steps
    .map((step, index) => (step.type === 'focusWindow' && mentionsApp(step, app) ? index : -1))
    .filter((index) => index >= 0)
    .pop();
  if (focusAt != null) {
    let index = focusAt + 1;
    while (steps[index]?.type === 'wait') index++;
    return index;
  }
  const shot = screenshotIndex(steps);
  return shot >= 0 ? shot : steps.length;
}

/**
 * Propose the step change an instruction asks for, against the current steps.
 * Nothing is mutated: the caller stores the result and applies it only after
 * the operator approves it.
 */
export function planStepChange({ instruction, steps = [], goal = '' } = {}) {
  const parsed = parseDirective(instruction);
  if (!parsed) {
    return {
      ok: false,
      reason:
        'That instruction does not name a step this console can build. Say what to open, what to type (for example “type hi in notepad”) or which visible control to click.',
      steps: Array.isArray(steps) ? JSON.parse(JSON.stringify(steps)) : [],
      changes: [],
      fixes: [],
      gaps: [],
      review: null,
      parsed: null,
    };
  }

  const work = (Array.isArray(steps) ? steps : []).map((step) => JSON.parse(JSON.stringify(step || {})));
  const changes = [];
  const label = parsed.app?.name || '';
  const derived = directiveSteps(parsed);

  const note = (entry) => {
    if (entry && !changes.some((item) => item.op === entry.op && item.name === entry.name && item.reason === entry.reason)) {
      changes.push(entry);
    }
  };

  // Launch: one is enough; an existing launch of the same app is kept.
  for (const step of derived.filter((entry) => entry.type === 'launchApp')) {
    const exists = work.some(
      (entry) => entry.type === 'launchApp' && (mentionsApp(entry, parsed.app) || sameValue(entry.params?.target, step.params?.target))
    );
    if (!exists) {
      work.unshift(step);
      note({ op: 'add', name: step.name, after: step.params?.target, reason: `The instruction opens ${label}; no step did that yet.` });
    }
  }

  // Focus + its settle wait, right after the launch.
  const focusStep = derived.find((entry) => entry.type === 'focusWindow');
  if (focusStep) {
    const exists = work.some((entry) => entry.type === 'focusWindow' && mentionsApp(entry, parsed.app));
    if (!exists) {
      const launchAt = work.findIndex((entry) => entry.type === 'launchApp' && mentionsApp(entry, parsed.app));
      let index = work.length;
      if (launchAt >= 0) {
        index = launchAt + 1;
        while (work[index]?.type === 'wait') index++;
      }
      work.splice(index, 0, focusStep);
      note({ op: 'add', name: focusStep.name, reason: `Nothing focused ${label} before the input step.` });
      const hasWait = work.slice(index + 1, index + 3).some((entry) => entry.type === 'wait');
      if (!hasWait) {
        work.splice(index + 1, 0, { type: 'wait', name: 'Wait for the app window', params: { ms: 1200 } });
        note({ op: 'add', name: 'Wait for the app window', reason: `Gave ${label} time to appear before focusing it.` });
      }
    }
  }

  // The input itself: update the step that already types here, or insert one.
  const typeStep = derived.find((entry) => entry.type === 'type');
  if (typeStep) {
    const index = findInputIndex(work, parsed.app);
    if (index >= 0 && work[index].type === 'type') {
      const previous = JSON.parse(JSON.stringify(work[index].params || {}));
      const next = { ...previous, ...typeStep.params };
      if (parsed.input?.kind === 'text') delete next.textVar;
      if (parsed.input?.kind === 'var') delete next.text;
      if (!sameValue(previous, next)) {
        work[index].params = next;
        if (parsed.input?.kind === 'text') work[index].name = typeStep.name;
        note({
          op: 'update',
          stepId: work[index].id || null,
          name: work[index].name,
          before: clip(previous.text || previous.textVar || '', 80),
          after: clip(next.text || next.textVar || '', 80),
          reason: `Updated the existing input step instead of adding a second one.`,
        });
      }
    } else {
      const insertAt = index >= 0 ? index : insertionIndex(work, parsed.app);
      work.splice(insertAt, 0, typeStep);
      note({ op: 'add', name: typeStep.name, after: clip(parsed.input?.text || parsed.input?.textVar, 80), reason: 'No step typed this input yet.' });
    }
  }

  // Keys, clicks and waits: add what is missing, keep what already exists.
  for (const step of derived.filter((entry) => ['key', 'clickElement', 'doubleClick', 'wait', 'openUrl'].includes(entry.type))) {
    const exists = work.some((entry) => {
      if (entry.type !== step.type) return false;
      if (step.type === 'wait') return Number(entry.params?.ms) === Number(step.params?.ms);
      if (step.type === 'openUrl') return sameValue(entry.params?.url, step.params?.url);
      return sameValue(entry.params, step.params);
    });
    if (exists) continue;
    const insertAt = step.type === 'wait' ? work.length : insertionIndex(work, parsed.app);
    work.splice(insertAt, 0, step);
    note({ op: 'add', name: step.name, reason: `The instruction asks for ${step.type === 'key' ? 'a key press' : step.type === 'wait' ? 'a wait' : 'a visible control action'}.` });
  }

  // Screen check: one at the end when the change has an action and no check.
  const wantsCheck = derived.some((entry) => entry.type === 'screenshot');
  if (wantsCheck) {
    const lastAction = work.map((step) => MUTATING_TYPES.has(step.type)).lastIndexOf(true);
    if (lastAction >= 0 && screenshotIndex(work) < lastAction) {
      const check = derived.find((entry) => entry.type === 'screenshot');
      work.push(check);
      note({ op: 'checkpoint', name: check.name, reason: 'Added a screenshot so the change is verified from pixels, not just command logs.' });
    }
  }

  const synced = syncWorkflowSteps(work, { goal });
  for (const fix of synced.fixes) note(fix);
  const gaps = [...synced.gaps, ...parsed.missing.map((reason) => ({ reason }))];
  const stepsChanged = !sameValue(
    (Array.isArray(steps) ? steps : []).map((step) => [step.type, step.params]),
    synced.steps.map((step) => [step.type, step.params])
  );

  const review = {
    instruction: parsed.instruction,
    inputConsidered: [
      {
        field: 'app',
        value: parsed.app?.name || '',
        source: parsed.app ? (parsed.app.matched ? 'instruction' : 'inferred from the instruction') : 'missing',
      },
      {
        field: 'input',
        value: parsed.input?.kind === 'text' ? clip(parsed.input.text, 120) : parsed.input?.textVar || '',
        source: parsed.input ? 'instruction' : 'not requested',
      },
      ...(parsed.keys.length ? [{ field: 'keys', value: parsed.keys.join(', '), source: 'instruction' }] : []),
      ...(parsed.click ? [{ field: 'control', value: parsed.click.name, source: 'instruction' }] : []),
      { field: 'screen check', value: wantsCheck ? 'yes' : 'no', source: wantsCheck ? 'instruction' : 'not requested' },
    ],
    gaps,
    stepsChanged,
    summary: stepsChanged
      ? `${changes.length} change(s) for “${clip(parsed.instruction, 120)}”, ${synced.steps.length} steps after syncing${
          gaps.length ? `, ${gaps.length} input gap(s)` : ''
        }.`
      : `Nothing to change: the workflow already does “${clip(parsed.instruction, 100)}”.`,
  };

  return {
    ok: stepsChanged,
    reason: stepsChanged ? '' : review.summary,
    parsed,
    steps: synced.steps,
    changes,
    fixes: synced.fixes,
    gaps,
    review,
  };
}
