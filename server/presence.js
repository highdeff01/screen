/**
 * User presence and step completion.
 *
 * Two different questions, both missing before: is the person at the keyboard
 * right now (so a focus-stealing step should wait until they stop moving), and
 * has a step really finished (a video that is playing is a success, but not the
 * end of the test; an installer that exited is not proof the app works).
 *
 * The functions are pure so the policy can be tested without a desktop: the
 * runner supplies an idle time and a foreground window, and gets back a
 * decision (proceed, wait, or continue silently) plus what the step still owes
 * before it counts as complete.
 */

const FOCUS_STEALING = new Set([
  'launchApp',
  'openUrl',
  'focusWindow',
  'windowAction',
  'clickElement',
  'click',
  'doubleClick',
  'rightClick',
  'move',
  'drag',
  'dragCopy',
  'scroll',
  'type',
  'key',
  'clipboard',
  'playMedia',
  'mediaHold',
  'recordVideo',
  'testApp',
  'downloadMedia',
  'copyLink',
  'installApp',
]);

const NEEDS_FULL_RUN = new Set(['playMedia', 'mediaHold', 'watchVideo', 'recordVideo', 'downloadMedia', 'installApp']);

// Steps that finish in one short action and leave the desktop as they found it.
// When the user is only nudging the pointer, these are cheaper to run than to
// hold: the whole step is done before the person next reaches for the mouse.
const QUICK_STEPS = new Set([
  'move',
  'scroll',
  'key',
  'clipboard',
  'copyLink',
  'click',
  'clickElement',
  'doubleClick',
  'rightClick',
  'drag',
  'dragCopy',
  'focusWindow',
]);

/** One short action (a click, a shortcut, a small edit) rather than a long one. */
export function isQuickStep(step) {
  const type = String(step?.type || '');
  if (QUICK_STEPS.has(type)) return true;
  // A short piece of text is one action too; a document-sized edit is not.
  if (type === 'type') {
    const text = String(step?.params?.text ?? '');
    return text.length > 0 && text.length <= 120;
  }
  return false;
}

const clip = (value, max = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

/** True when running this step would take the foreground away from the user. */
export function isFocusStealing(step) {
  const type = String(step?.type || '');
  // A playback check that names its player brings that window to the front so
  // the frames can prove anything; it is focus-stealing exactly then.
  if (type === 'verifyPlayback') return Boolean(step?.params?.title || step?.params?.expected);
  return FOCUS_STEALING.has(type);
}

/** Read-only checks that can run while the user keeps working. */
export function silentChecksFor(step) {
  switch (step?.type) {
    case 'launchApp':
    case 'focusWindow':
    case 'waitFor':
    case 'expect':
      return ['window'];
    case 'installApp':
      return ['registry', 'exe'];
    case 'downloadMedia':
    case 'writeTextFile':
    case 'recordVideo':
    case 'saveImage':
      return ['file'];
    case 'clipboard':
    case 'dragCopy':
    case 'copyLink':
      return ['clipboard'];
    case 'playMedia':
    case 'mediaHold':
    case 'verifyPlayback':
      return ['window', 'screen'];
    default:
      return [];
  }
}

/**
 * Classify what the user is doing from the idle time and the foreground window.
 * `holdMs` is how long the desktop must be quiet before the agent takes focus
 * back (ten seconds by default, learned per workstation).
 */
export function classifyPresence({ idleMs = 0, foreground = null, target = '', holdMs = 10000 } = {}) {
  const idle = Math.max(0, Number(idleMs) || 0);
  const hold = Math.max(1000, Number(holdMs) || 10000);
  const title = String(foreground?.title || '').trim();
  const processName = String(foreground?.process || '').trim();
  const wanted = String(target || '').trim();
  const watching = Boolean(
    wanted &&
      (title.toLowerCase().includes(wanted.toLowerCase()) || processName.toLowerCase().includes(wanted.replace(/\.exe$/i, '').toLowerCase()))
  );
  const state = idle >= hold ? 'idle' : idle <= 1200 ? 'typing' : 'moving';
  return {
    idleMs: idle,
    state,
    watching,
    foreground: title ? { title, process: processName } : null,
    note:
      state === 'typing'
        ? 'The user is using the desktop right now.'
        : state === 'moving'
          ? `The user moved the pointer ${Math.round(idle / 1000)}s ago; the desktop is settling.`
          : `The desktop has been quiet for ${Math.round(idle / 1000)}s.`,
  };
}

/**
 * Was the last input this run's own action?
 *
 * A run's clicks and keystrokes reset the same idle timer the operator does, so
 * a hold that reads them as the operator waits on the run itself — the console
 * sitting still between two of its own steps. Input no later than the moment
 * the run's own action ended is the run's; anything after it is someone else.
 */
export function isOwnInput({ idleMs = 0, lastActionEndAt = 0, at = Date.now() } = {}) {
  const end = Number(lastActionEndAt) || 0;
  if (!end) return false;
  const inputAt = Number(at) - Math.max(0, Number(idleMs) || 0);
  return inputAt <= end + 750;
}

/**
 * Decide whether a step may take focus now, should wait for the user to settle,
 * or should run as a silent (non-focusing) continuation instead.
 */
export function holdDecision({
  step = null,
  presence = null,
  target = '',
  holdMs = 10000,
  maxDeferMs = 60000,
  deferredMs = 0,
  silentAvailable = false,
  quick = false,
  steering = false,
} = {}) {
  const out = { action: 'proceed', waitMs: 0, reason: '', silent: false, fastPath: false };
  if (!step || !isFocusStealing(step)) return { ...out, reason: 'the step does not take focus' };
  if (!presence) return out;
  if (presence.watching) return { ...out, reason: 'the step already targets the window in front' };
  if (presence.state === 'idle') return { ...out, reason: 'the user is away from the desktop' };
  // The user is working in the window this run opened: they are steering the
  // same task, so the step continues there instead of pulling focus elsewhere.
  // Active typing is the exception — their edit is not ours to interrupt.
  if (steering && presence.state !== 'typing') {
    return {
      ...out,
      fastPath: true,
      reason: 'the user is working in the window this run opened; continuing there instead of holding',
    };
  }
  // The user only moved the pointer (not typing, not in our window): a single
  // quick action finishes before they act again, so run it rather than hold.
  if (quick && presence.state === 'moving') {
    return {
      ...out,
      fastPath: true,
      reason: 'the user only nudged the pointer and this step is one quick action; continuing instead of holding',
    };
  }

  const remaining = Math.max(0, holdMs - Number(presence.idleMs || 0));
  if (Number(deferredMs || 0) + remaining <= Math.max(1000, Number(maxDeferMs) || 60000)) {
    return {
      action: 'wait',
      waitMs: Math.max(600, Math.min(remaining + 400, 15000)),
      reason: `holding ${Math.round(remaining / 1000)}s for the user to finish moving`,
      silent: false,
      fastPath: false,
    };
  }
  if (silentAvailable) {
    return {
      action: 'silent',
      waitMs: 0,
      reason: 'the user is still active; continuing with read-only checks and deferring anything that needs focus',
      silent: true,
      fastPath: false,
    };
  }
  return {
    action: 'proceed',
    waitMs: 0,
    reason: 'the maximum hold has passed; continuing without waiting further',
    fastPath: false,
  };
}

/**
 * Learn a workstation's hold time from deferrals: how long the desktop stayed
 * busy after the agent asked for focus. A median keeps one long deferral from
 * making every run sluggish.
 */
export function learnHold(habits = null, samples = []) {
  const history = Array.isArray(habits?.samples) ? habits.samples : [];
  const added = (samples || [])
    .map((sample) => Number(sample?.waitedMs ?? sample?.deferredMs ?? sample))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 300000);
  const all = [...history.map((entry) => Number(entry.waitMs ?? entry)), ...added].filter((value) =>
    Number.isFinite(value)
  );
  if (!all.length) return { samples: history, holdMs: Number(habits?.holdMs) || 10000, count: 0, medianMs: 0 };
  const sorted = [...all].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // One short wait is not a habit; keep the default until three samples agree.
  const holdMs =
    all.length < 3
      ? Math.max(1000, Number(habits?.holdMs) || 10000)
      : Math.max(4000, Math.min(20000, Math.round(median + 2000)));
  return {
    samples: [...history, ...added.map((waitMs) => ({ waitMs, at: new Date().toISOString() }))].slice(-50),
    holdMs,
    count: all.length,
    medianMs: median,
  };
}

/** Whether a step has really finished, and what it still owes. */
export function completionFor(step, result = {}) {
  const type = String(step?.type || '');
  const skipped = Boolean(result?.skipped);
  if (skipped) return { status: 'skipped', pending: [], reason: 'the step was skipped because its state already existed' };
  if (NEEDS_FULL_RUN.has(type)) {
    switch (type) {
      case 'playMedia':
        return {
          status: 'awaiting',
          pending: ['verifyPlayback'],
          reason: 'the player started; playback still has to be proven to advance',
        };
      case 'mediaHold':
      case 'watchVideo':
        return { status: 'awaiting', pending: ['playbackEnd'], reason: 'the media was started; the end of the media is the real finish line' };
      case 'installApp':
        return result?.verified === false
          ? { status: 'awaiting', pending: ['launchApp'], reason: 'the installer ran; the app still has to launch and prove it works' }
          : { status: 'verified', pending: [], reason: 'the install was verified from the registry/executable' };
      case 'downloadMedia':
        return { status: 'awaiting', pending: ['file'], reason: 'the download finished; the file still has to be usable' };
      case 'recordVideo':
        return { status: 'awaiting', pending: ['file'], reason: 'the recording stopped; the video file still has to be checked' };
      default:
        return { status: 'verified', pending: [], reason: '' };
    }
  }
  if (type === 'launchApp') {
    return { status: 'awaiting', pending: ['window'], reason: 'the launch returned; the window still has to be confirmed' };
  }
  return { status: 'verified', pending: [], reason: '' };
}

/** Human summary of a pending list, used in logs and the console. */
export function pendingSummary(pending = []) {
  return (pending || []).map((item) => clip(item, 40)).join(', ');
}

/**
 * Choose how to keep working around the user: silently (read-only), in a
 * minimized window, or by turning the remaining run into a simulation preview.
 */
export function continuationMode({ presence = null, step = null, allowSilent = true, allowMinimize = true, userWatching = false } = {}) {
  if (!presence) return { mode: 'normal', reason: 'no presence reading' };
  if (presence.state === 'idle') return { mode: 'normal', reason: 'the user is away, so focus is free' };
  if (presence.watching || userWatching) {
    return { mode: 'normal', reason: 'the user is watching the window the run needs; keep it in front' };
  }
  if (allowSilent && step && silentChecksFor(step).length) {
    return { mode: 'silent', reason: 'run read-only checks now and defer anything that needs focus' };
  }
  if (allowMinimize) return { mode: 'minimize', reason: 'keep the target window minimized behind the user and verify later' };
  return { mode: 'preview', reason: 'the user is active; continue as a simulation preview instead of taking focus' };
}
