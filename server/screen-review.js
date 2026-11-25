/**
 * Automatic screen review during a live run.
 *
 * A step can report success while the screen shows something else: a click
 * landed, a key was sent, but the window is not where the plan thinks it is.
 * The engine already re-reads the screen after every step; this policy decides
 * when a screenshot is captured as evidence so that review is visible in the
 * run instead of living only in the log.
 *
 * Pure and clamped, so a hand-written settings request cannot lift the cap.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'actions',
  maxPerRun: 40,
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

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function normalizeScreenReviewSettings(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled !== false,
    mode: source.mode === 'every' ? 'every' : 'actions',
    maxPerRun: clampInt(source.maxPerRun, 1, 200, DEFAULTS.maxPerRun),
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

export function screenReviewCaption(step) {
  const name = String(step?.name || step?.type || 'step').trim();
  return `Screen check — ${name}`;
}
