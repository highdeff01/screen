/**
 * Pure predicates used by the run loop to check that a step really did what it
 * reported, and to resume a retry at the step that failed instead of starting over.
 */

const MUTATING_STEPS = new Set(['type', 'click', 'doubleClick', 'rightClick', 'drag', 'playMedia']);

// Select-all and copy are legitimate no-op-looking keys: the screen does not have
// to change for them to have worked.
const COPY_OR_SELECT = /^(?:(?:ctrl|control)\s*\+\s*[ac]|\^[ac])$/i;

/** True when this step must visibly change the screen to count as performed. */
export function expectsScreenChange(step) {
  if (!step) return false;
  if (MUTATING_STEPS.has(step.type)) {
    if (step.type === 'type') {
      const text = String(step.params?.text ?? '').trim();
      const variable = String(step.params?.textVar ?? '').trim();
      if (!text && !variable) return false;
    }
    return true;
  }
  if (step.type === 'key') {
    const keys = (Array.isArray(step.params?.keys) ? step.params.keys : [step.params?.keys])
      .map((key) => String(key ?? '').trim())
      .filter(Boolean);
    if (!keys.length) return false;
    return keys.some((key) => !COPY_OR_SELECT.test(key));
  }
  return false;
}

/**
 * Windows a step claims to open. A document passed to launchApp is not checked
 * here: its proof is the file on disk, not a process name.
 */
export function windowChecksFor(step) {
  const params = step?.params || {};
  if (step?.type === 'launchApp') {
    const target = String(params.target || '').trim();
    if (!target || /[\\/]/.test(target)) return [];
    // "Google Chrome" is a display name and a window-title match, not a process.
    if (/\s/.test(target) && !/\.\w+$/.test(target)) return [{ title: target, label: target }];
    const leaf = target.replace(/\.exe$/i, '').trim();
    if (!leaf) return [];
    return [{ process: leaf, label: leaf }];
  }
  if (step?.type === 'openUrl') {
    return ['chrome', 'msedge', 'firefox'].map((process) => ({ process, label: process }));
  }
  return [];
}

/** Steps from the failed step onward, so a retry resumes instead of restarting. */
export function resumeSteps(steps, failedStepId) {
  const list = Array.isArray(steps) ? steps : [];
  const index = list.findIndex((step) => step?.id === failedStepId);
  return index > 0 ? list.slice(index) : list;
}

const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Reasons a step can still be trusted when the screen did not visibly change:
 * a follow-up check passed, the field already holds the text, or the clicked
 * control is already the focused one. An empty string means nothing confirms it.
 */
/** Window to search for visible text: an explicit guard, else the current foreground. */
export function lookupWindowFor({ step, focused = null } = {}) {
  const guard = String(step?.params?.foreground || '').trim();
  if (guard) return guard;
  return String(focused?.window || '').trim();
}

export function corroboratesNoChange({ step, checks = [], focused = null, textFound = false } = {}) {
  if (Array.isArray(checks) && checks.length) return 'a follow-up check passed';
  const params = step?.params || {};
  const text = norm(params.text);
  if (step?.type === 'type' && text) {
    if (textFound) return 'the text is already present in the window';
    if (norm(focused?.value).includes(text)) return 'the field already contains the text';
    return '';
  }
  if (step?.type === 'click') {
    const label = norm(params.name ?? params.text ?? params.value);
    const focusedName = norm(focused?.name);
    if (label && focusedName && focusedName.includes(label)) return 'the control is already focused or selected';
  }
  return '';
}

/** The run's screen-change policy: only fail when nothing corroborated the step. */
export function screenChangeVerdict({ step, changedPct = 0, confirmedBy = '' } = {}) {
  if (!expectsScreenChange(step)) return { ok: true };
  if (Number(changedPct) >= 1) return { ok: true };
  if (confirmedBy) return { ok: true, corroborated: confirmedBy };
  return {
    ok: false,
    message: `“${step?.name || step?.type}” reported success, but nothing on screen changed and no check confirmed it.`,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function planStepSignature(step) {
  return stableJson([step?.id ?? null, step?.type ?? null, step?.params ?? null, step?.condition ?? null, step?.optional ?? null]);
}

/**
 * Resume a plan at the step that failed, but only while the steps before it are
 * unchanged. A repair that added or altered earlier steps is kept intact: the
 * caller replays that plan in full instead of slicing the repair away.
 * Returns null when resuming is not safe.
 */
export function resumePlan(snapshotSteps, originalSteps, failedStepId) {
  const snapshot = Array.isArray(snapshotSteps) ? snapshotSteps : [];
  const original = Array.isArray(originalSteps) ? originalSteps : [];
  const snapshotIndex = snapshot.findIndex((step) => step?.id === failedStepId);
  const originalIndex = original.findIndex((step) => step?.id === failedStepId);
  if (snapshotIndex <= 0 || originalIndex <= 0) return null;
  if (snapshotIndex !== originalIndex) return null;
  const prefixChanged = original
    .slice(0, originalIndex)
    .some((step, index) => planStepSignature(step) !== planStepSignature(snapshot[index]));
  if (prefixChanged) return null;
  return { steps: snapshot.slice(snapshotIndex), skipped: snapshotIndex };
}

/**
 * Recovery retries may only slice a snapshot that is the exact plan that ran.
 * Any added, removed or replaced step is part of the repair (often a launch,
 * wait or refocus inserted before the failure), so the snapshot replays whole.
 */
export function resumeRecoveryPlan(snapshotSteps, ranSteps, failedStepId) {
  const snapshot = Array.isArray(snapshotSteps) ? snapshotSteps : [];
  const ran = Array.isArray(ranSteps) ? ranSteps : [];
  if (snapshot.length !== ran.length) return null;
  return resumePlan(snapshot, ran, failedStepId);
}
