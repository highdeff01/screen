/**
 * Putting the caret where the text is meant to go.
 *
 * A type or paste step is only as good as the caret it lands in. SendKeys and
 * ctrl+V go to whatever holds focus, and a chat pane in a web-style app (Kiro,
 * Slack, VS Code) holds no caret until it is clicked — the text went nowhere
 * while the step still reported "Pasted 17 characters from the clipboard".
 *
 * This module decides which control to click and says what it found; the
 * desktop calls are injected, so the decision is testable without a screen.
 *
 * A named field (params.field) is found by its label. Without a name, only a
 * control that is confidently a text field is clicked: an Edit control, or one
 * whose own label names a field. A Document is the editor surface of an IDE or
 * browser, and clicking its middle types into the wrong place, so it never
 * earns a click on its own.
 */

const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// Labels that name a place text is entered, rather than a surface that merely
// accepts text.
const FIELD_LABEL = /(chat|ask|message|prompt|input|compose|reply|comment|search|description|email|subject|query|filter|note)/i;

const EDITABLE_TYPES = /^(Edit|Document|ComboBox)$/i;

/** True when the caret this read reports is in an editable control of the window. */
export function caretIsIn(focused, window = '') {
  if (!focused || focused.found === false || focused.editable !== true) return false;
  const target = norm(window);
  if (!target) return true;
  const seen = norm(focused.window);
  return Boolean(seen) && (seen.includes(target) || target.includes(seen));
}

/**
 * Score one control as the place to put the caret. Null when it cannot hold a
 * caret at all; `confident` is false when clicking it would be a guess.
 */
export function scoreEditable(control = {}, { windowTop = 0, windowHeight = 0 } = {}) {
  const type = String(control.controlType || '').replace(/^ControlType\./, '');
  if (!EDITABLE_TYPES.test(type)) return null;
  if (control.offscreen === true || control.keyboardFocusable === false) return null;
  if (control.readonly === true) return null;
  const width = Number(control.width) || 0;
  const height = Number(control.height) || 0;
  if (width < 40 || height < 12) return null;
  const name = String(control.name || '').trim();
  const labelled = FIELD_LABEL.test(name);
  let score = 0;
  if (labelled) score += 100;
  if (/^Edit$/i.test(type)) score += 30;
  if (/^ComboBox$/i.test(type)) score += 10;
  if (/^Document$/i.test(type)) score -= 20;
  if (name) score += 5;
  if (windowHeight > 0) {
    // Chat boxes sit low in their window; editor surfaces fill it.
    const bottom = (Number(control.y) + height / 2 - windowTop) / windowHeight;
    score += Math.round(Math.max(0, Math.min(1, bottom)) * 15);
  }
  return {
    name,
    controlType: type,
    x: Number(control.x) || 0,
    y: Number(control.y) || 0,
    width,
    height,
    score,
    labelled,
    // An Edit is a text field by construction. A Document or ComboBox is only
    // clicked when its own label says it is where text goes.
    confident: labelled || /^Edit$/i.test(type),
  };
}

/** The best confident place for the caret, or null. */
export function chooseEditable(controls = [], options = {}) {
  const scored = (Array.isArray(controls) ? controls : [])
    .map((control) => scoreEditable(control, options))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.confident ? best : null;
}

/**
 * Put the caret in the field this step means, and report what really happened.
 *
 * deps: readFocused, findControls({window}), findNamed({window,name}),
 * findNamedByOcr({window,name}), clickAt(x,y,name), wait(ms).
 */
export async function placeCaret({ step = {}, window = '', deps = {} } = {}) {
  const readFocused = deps.readFocused;
  if (typeof readFocused !== 'function') return { placed: false, silent: true, reason: 'the caret cannot be read here' };
  const wait = typeof deps.wait === 'function' ? deps.wait : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // A named field is always clicked: the caret may be sitting in an unrelated
  // editable control of the same window (Monaco keeps one for assistive tech),
  // and “some caret is here” is not “the caret is in the field I named”.
  const named = String(step?.params?.field || '').trim();

  let focused = null;
  try {
    focused = await readFocused();
  } catch {
    focused = null;
  }
  if (!named && caretIsIn(focused, window)) {
    return { placed: false, already: true, verified: true, name: focused?.name || '', window: focused?.window || '' };
  }
  let hit = null;
  if (named) {
    try {
      hit = await deps.findNamed?.({ window, name: named });
    } catch {
      hit = null;
    }
    if (!hit?.found && typeof deps.findNamedByOcr === 'function') {
      try {
        hit = await deps.findNamedByOcr({ window, name: named });
      } catch {
        hit = null;
      }
    }
    if (!hit?.found) return { placed: false, field: named, reason: `no control labelled “${named}” was found` };
  } else {
    let read = null;
    try {
      read = await deps.findControls?.({ window });
    } catch {
      read = null;
    }
    const controls = Array.isArray(read?.controls) ? read.controls : [];
    // An app with no UI Automation tree (a Tk window, a game) has nothing to
    // choose from; typing there is the old behaviour and needs no warning.
    if (!controls.length) return { placed: false, silent: true, reason: 'the window exposes no editable controls' };
    hit = chooseEditable(controls, { windowTop: read?.windowTop, windowHeight: read?.windowHeight });
    if (!hit) return { placed: false, reason: 'none of the window’s controls is confidently a text field' };
  }

  if (typeof deps.clickAt !== 'function') return { placed: false, silent: true, reason: 'clicking is unavailable here' };
  try {
    await deps.clickAt(hit.x, hit.y, hit.name || named);
  } catch (err) {
    return { placed: false, field: named, reason: `the click failed: ${err?.message || err}` };
  }
  await wait(220);
  let after = null;
  try {
    after = await readFocused();
  } catch {
    after = null;
  }
  return {
    placed: true,
    verified: caretIsIn(after, window),
    name: hit.name || named || '',
    x: hit.x,
    y: hit.y,
  };
}

/** One line for the step's output: what happened to the caret. */
export function caretNote(result) {
  if (!result || result.silent) return '';
  if (result.already) {
    return result.name ? `The caret was already in “${result.name}”.` : 'The caret was already in an editable field.';
  }
  if (result.placed) {
    return `Clicked into “${result.name || 'the text field'}” before typing${result.verified ? ' and confirmed the caret' : ' (the caret could not be confirmed)'}.`;
  }
  return `No field was clicked (${result.reason}); the text went to the window in front.`;
}
