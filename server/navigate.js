/**
 * Where the run is, and what it can do from here.
 *
 * A run used to know only its next step. It could not say where it was, whether
 * the screen was still moving, or which of its prepared moves were worth
 * offering — so a log read like a list of actions with no place in it.
 *
 * This module is the small vocabulary that fixes that, and it is deliberately
 * free of the desktop: it takes the screen read and the frame signature the
 * console already has, and answers
 *
 *   positionOf()   — I am here: the window in front, its handle, and whether it
 *                    is the window this run means to be in
 *   motionOf()     — is it moving or still: two frames, compared
 *   optionsFor()   — my options are: the prepared moves, best first, banded
 *   referenceCompare() — is this still the screen that worked last time
 *   whereToNext()  — from here, to the goal, through those options
 *
 * Everything is pure, so a run's own record can be rebuilt from it later.
 */
import { diffSignatures, signatureHash } from './visual.js';
import { bandOf } from './gate.js';

const CLIP = 160;

function clip(value, max = CLIP) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The window this step or run expects to be working in, if it names one. */
export function expectedWindow(step, run) {
  const params = step?.params || {};
  const title = String(params.foreground || params.window || params.title || '').trim();
  const process = String(params.app || params.process || '').trim();
  const handle = Math.max(0, Number(params.foregroundHandle || params.handle || params.hwnd) || 0);
  if (handle || title || process) return { title, process, handle, source: 'step' };
  const last = run?.lastWindow;
  if (last?.title || last?.hwnd) {
    return {
      title: String(last.title || ''),
      process: String(last.process || ''),
      handle: Number(last.hwnd) || 0,
      source: 'run',
    };
  }
  return { title: '', process: '', handle: 0, source: 'none' };
}

/**
 * I am here. `named` is true when the window in front is the one the step or run
 * expects, false when it is demonstrably another one, and null when nothing was
 * named to compare against.
 */
export function positionOf({ screen = null, signature = null, step = null, run = null } = {}) {
  const foreground = screen?.foreground || {};
  const title = String(foreground.title || '').trim();
  const process = String(foreground.process || '').trim();
  const handle = Math.max(0, Number(foreground.handle || foreground.hwnd) || 0);
  const expected = expectedWindow(step, run);
  let named = null;
  if (expected.handle) named = handle === expected.handle;
  else if (expected.title) named = title.toLowerCase().includes(expected.title.toLowerCase());
  else if (expected.process) {
    named = `${process} ${title}`.toLowerCase().includes(expected.process.toLowerCase());
  }
  return {
    app: process || title || 'desktop',
    process,
    title,
    handle,
    expected,
    named,
    windows: Array.isArray(screen?.windows) ? screen.windows.length : 0,
    focus: screen?.focused || screen?.focus || null,
    hash: signature ? signatureHash(signature) : null,
    at: signature?.at || null,
  };
}

/** One line a log can carry: where the run is, and whether it belongs there. */
export function positionLine(position) {
  if (!position) return 'Where: the desktop could not be read.';
  const window = position.title ? `“${position.title}”` : position.process ? position.app : 'the desktop';
  const app = position.process && position.title ? ` (${position.process})` : '';
  const handle = position.handle ? ` hwnd ${position.handle}` : '';
  const verdict =
    position.named === true
      ? ' — the window this run is working in'
      : position.named === false
        ? ' — not the window this run expects'
        : '';
  return `Where: ${window}${app}${handle}${verdict}`;
}

/** Moving or still. Two frames of the same region are enough; no image is kept. */
export function motionOf(before, after, { stillPct = 1 } = {}) {
  if (!before || !after) return { still: null, moving: null, changedPct: null, meanDelta: null, known: false };
  const delta = diffSignatures(before, after);
  const still = delta.changedPct <= stillPct;
  return { ...delta, still, moving: !still, known: true };
}

/**
 * My options are. Prepared moves are ordered by their own score and labelled
 * with the band the ladder assigns, so a caller never has to compare a 0.7 to a
 * 0.95 by eye.
 */
export function optionsFor({ choices = [], step = null } = {}) {
  return (choices || [])
    .filter((choice) => choice && choice.ok !== false)
    .map((choice) => {
      const confidence = Number.isFinite(Number(choice.confidence)) ? Number(choice.confidence) : null;
      const read = bandOf(confidence);
      return {
        id: choice.id || null,
        name: clip(choice.name || choice.type || 'move'),
        type: choice.type || '',
        confidence,
        band: read.band,
        why: clip(choice.why || choice.modelWhy || ''),
        params: choice.params || {},
      };
    })
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
}

/**
 * Is this still the screen that worked last time? The reference is the small
 * signature a passing step saved, so the comparison costs no upload and no
 * model call — which is the only reason it is worth doing on every step.
 */
export function referenceCompare({ now = null, reference = null, tolerancePct = 3 } = {}) {
  if (!now || !reference) return { known: false, matches: null, changedPct: null, detail: 'no reference was kept for this step' };
  if (Array.isArray(now.cells) && Array.isArray(reference.cells)) {
    const delta = diffSignatures(reference, now);
    const matches = delta.changedPct <= tolerancePct;
    return {
      known: true,
      matches,
      changedPct: delta.changedPct,
      meanDelta: delta.meanDelta,
      detail: matches
        ? `the screen still matches the reference (${delta.changedPct}% changed)`
        : `the screen differs from the reference (${delta.changedPct}% changed)`,
    };
  }
  const left = reference.hash || (reference.cells ? signatureHash(reference) : null);
  const right = now.hash || (now.cells ? signatureHash(now) : null);
  if (!left || !right) return { known: false, matches: null, changedPct: null, detail: 'the reference has no comparable signature' };
  const matches = left === right;
  return {
    known: true,
    matches,
    changedPct: matches ? 0 : null,
    detail: matches ? 'the screen hash matches the reference' : 'the screen hash differs from the reference',
  };
}

/**
 * The record the operator asked for in words: I am here, I want to go there, my
 * options are, and this is the one the ladder allows.
 */
export function whereToNext({ position = null, goal = '', options = [], decision = null } = {}) {
  const best = options[0] || null;
  const allowed = decision?.action === 'act' ? best : decision?.action === 'replan-then-act' ? options.find((entry) => entry.band !== 'hold') || best : null;
  return {
    from: position ? positionLine(position).replace(/^Where: /, '') : 'unknown',
    to: clip(goal, 200),
    options: options.slice(0, 6).map((entry) => ({
      name: entry.name,
      confidence: entry.confidence,
      band: entry.band,
    })),
    band: decision?.band || 'unknown',
    next: allowed ? allowed.name : decision?.action || 'observe',
    reason: decision?.reason || '',
  };
}
