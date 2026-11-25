/**
 * Courtesy recovery: when the page offers something else, take the something
 * else.
 *
 * A plan that reaches a video page and finds "This video is unavailable" must
 * not stop, and it must not re-enter the URL it already typed: the page it is on
 * already holds the results, the "Up next" panel and the back button. This module
 * turns that state into an ordered set of alternate routes the replan may use —
 * scroll for the next row, look right for "Up next", go back to the results, use
 * the keyboard, or pick another video on the same topic — and it prefers a new
 * video over replaying the old one when the page is already familiar.
 *
 * The alternates are drafts. Nothing here executes, clicks or approves; the
 * runner and the replan still decide.
 */

const UNAVAILABLE =
  /\b(?:unavailable|not available|no longer available|removed|private video|deleted|can't play|cannot play|playback error|an error occurred|video isn't available|content isn't available|age-restricted|blocked in your country|sign in to confirm)\b/i;

const MEDIA_GOAL = /\b(?:play|watch|video|song|music|movie|clip|youtube|listen|stream)\b/i;

const MAX_ALTERNATES = 8;

function text(value, max = 240) {
  const flat = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function keyOf(step) {
  return `${step?.type || ''}|${JSON.stringify(step?.params || {})}`;
}

/** Does this reading say the media cannot be played here? */
export function videoUnavailable(reading) {
  if (!reading) return false;
  const haystack = [reading.visible, reading.page, reading.app, ...(Array.isArray(reading.blockers) ? reading.blockers : [])]
    .filter(Boolean)
    .join(' ');
  return UNAVAILABLE.test(haystack);
}

/** A page the run has already handled: same site, same layout, nothing new. */
export function familiarPage(reading, memory = null) {
  if (memory && typeof memory === 'object') {
    const seen = Number(memory.visits || memory.count || 0);
    if (seen > 0) return true;
  }
  return Boolean(reading && reading.usable && !videoUnavailable(reading) && /youtube|results|watch|video/i.test(`${reading.page} ${reading.visible}`));
}

/**
 * The alternate routes, in the order a person would try them. Each entry is a
 * step the runner already knows how to execute, plus why it is next.
 */
export function mediaAlternates({ goal = '', reading = null, familiar = false, tried = [], title = 'YouTube' } = {}) {
  const unavailable = videoUnavailable(reading);
  const seen = new Set((Array.isArray(tried) ? tried : []).map(keyOf));
  const out = [];
  const push = (entry) => {
    const step = { type: entry.type, name: entry.name, params: entry.params || {} };
    const key = keyOf(step);
    if (seen.has(key) || out.length >= MAX_ALTERNATES) return;
    seen.add(key);
    out.push({ ...step, kind: entry.kind, why: entry.why });
  };

  // Let the player settle first: a slow page can look unavailable for a moment.
  push({
    kind: 'settle',
    type: 'wait',
    name: 'Let the player settle before deciding it is unavailable',
    params: { ms: 2000 },
    why: 'a slow player or a pre-roll can show an error frame before it recovers',
  });

  if (unavailable || !reading) {
    // Stay on the page: the results and the sidebar are already here.
    push({
      kind: 'scroll',
      type: 'scroll',
      name: 'Scroll down to the next row of videos',
      params: { amount: -600, ...(title ? { foreground: title } : {}) },
      why: 'the page already holds more videos; scrolling finds one without retyping the search',
    });
    push({
      kind: 'lookRight',
      type: 'clickElement',
      name: 'Look right and pick a video from “Up next”',
      params: { ...(title ? { window: title } : {}), name: 'Up next' },
      why: 'the “Up next” panel is beside the player and holds the same-topic videos',
    });
    push({
      kind: 'back',
      type: 'key',
      name: 'Go back to the results page',
      params: { keys: 'alt+left', ...(title ? { foreground: title } : {}) },
      why: 'back returns to the list the run came from, without opening the URL again',
    });
    push({
      kind: 'shortcut',
      type: 'key',
      name: 'Use the browser’s own back shortcut',
      params: { keys: 'browserback', ...(title ? { foreground: title } : {}) },
      why: 'a keyboard route works when the back arrow is covered by a banner',
    });
  }

  // Pick another video on the same topic. Familiar pages skip the search field
  // entirely: the list is already on screen, so choose from it.
  const label = text(reading?.page || reading?.visible || '', 80);
  push({
    kind: 'sameTopic',
    type: 'clickElement',
    name: familiar ? 'Pick a different video on the same topic from the visible list' : 'Pick the next matching video from the results',
    params: { ...(title ? { window: title } : {}), name: familiar ? 'Up next' : 'Results' },
    why: familiar
      ? 'the page is familiar, so a new video on the same topic is one click away — prefer a new one over replaying the old one'
      : 'the results list already matches the goal; choose the next entry that does',
  });
  push({
    kind: 'play',
    type: 'clickElement',
    name: 'Start the newly chosen video',
    params: { ...(title ? { window: title } : {}), name: 'Play' },
    why: 'a chosen video still has to be started; the play control is the visible confirmation',
  });
  push({
    kind: 'verify',
    type: 'verifyScreen',
    name: 'Confirm a different video is actually playing',
    params: {
      title: 'A playable video is on screen',
      caption: 'Verified alternate video',
      question:
        'The page must show one main video player that is not the unavailable/error state, with a pause control and a progress time beyond 0:00. Fail if the same unavailable message, a results grid or another app is in front.',
    },
    why: 'an alternate route only counts when the screen shows a playable video',
  });

  // Searching again is the last resort, and only when nothing on the page can be
  // used. It never re-enters the address the run already opened.
  if (!reading || !reading.usable) {
    push({
      kind: 'searchAgain',
      type: 'type',
      name: 'Search the same topic again only if the page has nothing usable',
      params: { text: topicOf(goal), ...(title ? { foreground: title } : {}) },
      why: 'typing a fresh query is the fallback when the page itself has no usable list; the URL is not re-entered',
    });
  }

  return out.slice(0, MAX_ALTERNATES);
}

/** The subject to search for, taken from the goal without the verbs. */
export function topicOf(goal = '') {
  const cleaned = String(goal || '')
    .replace(/\b(?:open|launch|start|run|go|to|navigate|type|enter|input|write|play|watch|search|find|the|a|an|in|on|into|youtube|chrome|video|song|and|then|please|any)\b/gi, ' ')
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text(cleaned || 'the same topic', 120);
}

export const COURTESY_RULES =
  'COURTESY AND RECOVERY — leave the page in a better state than a blind retry would:\n' +
  '- If a video, page or result is unavailable, do not re-enter the URL or repeat the search. The page already holds the results, the sidebar and the back history: scroll for the next row, look right for “Up next”, go back with alt+left or the browser back shortcut, then choose another entry.\n' +
  '- Analyse the page before choosing: read what is actually listed, pick the entry that matches the same topic, and start it.\n' +
  '- When the page is familiar (same site, same layout, already handled this run), prefer a new item on the same topic over replaying the old one; the operator has seen the old one. Only replay it when the goal explicitly says to.\n' +
  '- An alternate route is not a pass: add verifyScreen or verifyPlayback so the run proves a playable video is actually playing.\n' +
  '- When two programs are needed (a form in one, a code or reply in the other), name both windows, wait for the response with waitFor, then return to the first with focusWindow or alt+tab; never type into a window that is not focused.\n' +
  '- Leave the operator’s windows and tabs as you found them; do not close a page you did not open unless the goal says to.';

/** The courtesy block for a revision prompt, with the live reading when there is one. */
export function courtesyBrief({ goal = '', reading = null, familiar = false } = {}) {
  const lines = [COURTESY_RULES];
  if (MEDIA_GOAL.test(String(goal || ''))) {
    lines.push(
      `Media goal detected. ${reading ? `Current page: ${text(reading.page || reading.visible, 200)}.` : 'No live reading was attached.'} ${
        videoUnavailable(reading) ? 'The player reports the media is unavailable: replan through the page, not through the URL.' : ''
      }`
    );
    const alternates = mediaAlternates({ goal, reading, familiar });
    if (alternates.length) {
      lines.push(
        'Alternate routes in the order a person would try them:',
        ...alternates.map((entry, index) => `  ${index + 1}. ${entry.type} “${entry.name}” — ${entry.why}`)
      );
    }
  }
  return lines.join('\n');
}

export const __courtesy = { UNAVAILABLE, MEDIA_GOAL, MAX_ALTERNATES };
