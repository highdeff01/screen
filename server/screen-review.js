/**
 * Automatic screen review during a live run.
 *
 * A step can report success while the screen shows something else: a click
 * landed, a key was sent, but the window is not where the plan thinks it is.
 * The engine re-reads the screen after every step; this policy turns that read
 * into a real check. It builds the question the frame has to answer (for a
 * typing step, that the text is actually there), and turns one reading into a
 * pass, a mismatch, or an unreadable frame — so the review can retry instead of
 * only filing a screenshot.
 *
 * Pure and clamped, so a hand-written settings request cannot lift the cap.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'actions',
  maxPerRun: 40,
  // One re-read: a slow app often catches up between the action and the frame.
  retries: 1,
  retryDelayMs: 1200,
  minConfidence: 0.6,
});

// Steps that change the screen. A wait or an assertion is already its own check.
const ACTION_TYPES = new Set([
  'launchApp',
  'openUrl',
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
  'windowAction',
  'closeWindow',
  'installApp',
  'testApp',
]);

const MAX_EXPECTED_TEXT = 160;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(min, Math.min(max, number)) * 100) / 100;
}

export function normalizeScreenReviewSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled !== false,
    mode: source.mode === 'every' ? 'every' : 'actions',
    maxPerRun: clampInt(source.maxPerRun, 1, 200, DEFAULTS.maxPerRun),
    retries: clampInt(source.retries, 0, 3, DEFAULTS.retries),
    retryDelayMs: clampInt(source.retryDelayMs, 0, 10000, DEFAULTS.retryDelayMs),
    minConfidence: clampNumber(source.minConfidence, 0.3, 1, DEFAULTS.minConfidence),
  };
}

export function isActionStep(step) {
  return Boolean(step && ACTION_TYPES.has(step.type));
}

/** Should this step get an automatic screenshot after it settles? */
export function shouldReviewStep(step, captured = 0, settings = DEFAULTS) {
  const cfg = normalizeScreenReviewSettings(settings);
  if (!cfg.enabled) return false;
  if (!step) return false;
  if (step.type === 'screenshot') return false;
  if (Number(captured) >= cfg.maxPerRun) return false;
  if (cfg.mode === 'every') return true;
  return isActionStep(step);
}

/** Reads allowed for one step: the first one plus the configured retries. */
export function screenReviewAttempts(settings = DEFAULTS) {
  return normalizeScreenReviewSettings(settings).retries + 1;
}

export function screenReviewCaption(step) {
  const name = String(step?.name || step?.type || 'step').trim();
  return `Screen check — ${name}`;
}

function quoted(value) {
  return `“${String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_EXPECTED_TEXT)}”`;
}

function inputText(params, variables) {
  const direct = String(params?.text ?? '').trim();
  if (direct) return direct.slice(0, MAX_EXPECTED_TEXT);
  const name = String(params?.textVar ?? '').trim();
  if (!name) return '';
  return String(variables?.[name] ?? '').trim().slice(0, MAX_EXPECTED_TEXT);
}

function keysLabel(params) {
  const list = Array.isArray(params?.keys) ? params.keys : [params?.keys];
  return list
    .map((key) => String(key ?? '').trim())
    .filter(Boolean)
    .join(' + ');
}

/**
 * What the frame after this step must show, in the words the existing
 * verifyScreen check already understands. `expectedText` is what the free,
 * deterministic window read can confirm; the question is what the model is
 * asked about the cropped pixels. Both judge the same moment.
 */
export function screenReviewCheck(step, { variables = {} } = {}) {
  const params = step?.params || {};
  const type = String(step?.type || '');
  const caption = screenReviewCaption(step);
  const text = inputText(params, variables);
  const target = String(params.target || params.app || params.window || params.title || params.url || '').trim();
  const control = String(params.name || params.label || params.control || '').trim();
  const keys = keysLabel(params);
  const point = params.x !== undefined && params.y !== undefined ? `${params.x}, ${params.y}` : '';
  const action = String(params.action || '').trim();
  if (type === 'type') {
    return {
      caption,
      question: text
        ? `Does the screen show the text ${quoted(text)} inside the window that received it, in the expected app?`
        : `Did the text intended for ${target ? quoted(target) : 'this step'} actually appear on screen?`,
      expectedText: text,
    };
  }
  if (type === 'clipboard') {
    return {
      caption,
      question: text
        ? `Did the clipboard text ${quoted(text)} appear where it was pasted?`
        : 'Did the clipboard content appear where it was pasted?',
      expectedText: text,
    };
  }
  if (type === 'key') {
    return {
      caption,
      question: keys
        ? `Did the keystroke ${quoted(keys)} take effect on screen, with no error dialog?`
        : 'Did the key press take effect on screen, with no error dialog?',
      expectedText: '',
    };
  }
  if (['click', 'doubleClick', 'rightClick', 'clickElement'].includes(type)) {
    const subject = control || point;
    return {
      caption,
      question: subject
        ? `Did the click on ${quoted(subject)} land, and is the screen it was meant to open or change now visible?`
        : 'Did the click land, and did the screen change the way the step intended?',
      expectedText: '',
    };
  }
  if (type === 'drag' || type === 'dragCopy') {
    return {
      caption,
      question: 'Did the drag move or select what it was meant to?',
      expectedText: '',
    };
  }
  if (type === 'scroll') {
    return {
      caption,
      question: 'Did the view scroll as intended?',
      expectedText: '',
    };
  }
  if (type === 'launchApp' || type === 'installApp' || type === 'testApp') {
    return {
      caption,
      question: target
        ? `Is ${quoted(target)} open and visible on screen, with no installer, error or sign-in dialog in front?`
        : 'Is the app the step launched open and visible on screen?',
      expectedText: '',
    };
  }
  if (type === 'openUrl') {
    return {
      caption,
      question: target
        ? `Is the page ${quoted(target)} open in a browser and showing its content?`
        : 'Is the requested page open in a browser and showing its content?',
      expectedText: '',
    };
  }
  if (type === 'windowAction') {
    return {
      caption,
      question: `Did the window action${action ? ` (${action})` : ''} on ${target ? quoted(target) : 'the run window'} take effect?`,
      expectedText: '',
    };
  }
  if (type === 'closeWindow') {
    return {
      caption,
      question: target ? `Is ${quoted(target)} gone from the screen?` : 'Is the guarded window gone from the screen?',
      expectedText: '',
      absentText: target,
    };
  }
  if (type === 'playMedia') {
    return {
      caption,
      question: 'Is the media playing: moving picture, no large play overlay?',
      expectedText: '',
    };
  }
  return {
    caption,
    question: `Does the screen show the result of ${quoted(step?.name || type || 'the step')}, with no error or blocking dialog?`,
    expectedText: '',
  };
}

function mismatchFrom(message) {
  // The check reports “Screen check failed (vision %) | <what is wrong>: <why>
  // · window facts … [path]”. The review keeps what is wrong, not the log tail.
  let text = String(message || '').trim();
  if (text.includes('|')) text = text.slice(text.indexOf('|') + 1);
  else text = text.replace(/^Screen check[^:]*:\s*/i, '');
  text = text.split(' · ')[0];
  const colon = text.indexOf(': ');
  if (colon > 0) text = text.slice(0, colon);
  return text.replace(/\s*\[\S+\]\s*$/, '').trim().slice(0, 400);
}

/**
 * One reading, as the run records it. `skipped` is the honest "could not read"
 * answer: an offline model or unscoped frame is not a mismatch, so it never
 * fails a run that nothing actually contradicted.
 */
export function reviewOutcome({ skipped = false, error = null, output = '' } = {}) {
  if (skipped) {
    return {
      status: 'skipped',
      verdict: 'unverified',
      detail: String(output || 'The screen check could not read the screen.').slice(0, 600),
      mismatch: '',
    };
  }
  if (error?.unreadable) {
    // The check itself could not read the frame (model offline, nothing
    // conclusive to read): still not a contradiction, so still unverified.
    return {
      status: 'skipped',
      verdict: 'unverified',
      detail: String(error?.message || error || 'The screen check could not read the screen.').slice(0, 600),
      mismatch: '',
    };
  }
  if (error) {
    const message = String(error?.message || error).trim() || 'the screen did not match';
    return {
      status: 'mismatch',
      verdict: 'mismatch',
      detail: message.slice(0, 600),
      mismatch: mismatchFrom(message) || 'the screen did not match',
    };
  }
  return {
    status: 'pass',
    verdict: 'pass',
    detail: String(output || 'The screen matched the step.').slice(0, 600),
    mismatch: '',
  };
}
