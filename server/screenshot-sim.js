/**
 * Background screenshot simulation.
 *
 * A run reports its outcome from its own step boundary checks. This module
 * re-judges the same run from the evidence on disk instead: it finds the
 * before/after frames for every step, decodes them, and asks whether the screen
 * really changed when the step said it did. Nothing is clicked, focused or
 * captured, so it is safe to run while the desktop is busy.
 *
 * Frames come from two places:
 *  - the run's own evidence (failure captures, screenshot steps), and
 *  - the live monitor's capture folder, matched to a step by timestamp.
 *
 * The output is a per-step breakdown plus integration suggestions (where to add
 * a verifyScreen, a wait, or evidence capture) so a failing run can be repaired
 * from facts instead of from step names.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CAPTURES, DATA, db, logActivity, now, persist, resolveInside, uid } from './store.js';
import { diffSignatures } from './visual.js';
import { expectsScreenChange } from './step-effects.js';
import { visualTesterStatus } from './visual-tester.js';

const GRID_W = 32;
const GRID_H = 18;
const MAX_FRAMES = 40;
const MAX_SIMULATIONS = 16;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IMAGE_PATH = /\.(?:png|jpe?g|webp)$/i;

const frameCache = new Map();

const clip = (value, max = 300) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
};

const toMs = (value) => {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

/* ----------------------------------------------------------------- PNG read */

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG into raw scanlines. */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) throw new Error('Not a PNG file.');
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file.');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error('Truncated PNG chunk.');
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw new Error('PNG has no usable header.');
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}.`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported.');
  if (colorType !== 2 && colorType !== 6) throw new Error(`Unsupported PNG color type ${colorType}.`);
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < stride * height) throw new Error('PNG pixel data is short.');
  const pixels = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const source = raw.subarray(pos, pos + stride);
    pos += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bpp ? previous[x - bpp] : 0;
      let value = source[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value = (value + left) & 255;
          break;
        case 2:
          value = (value + up) & 255;
          break;
        case 3:
          value = (value + ((left + up) >> 1)) & 255;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const pa = Math.abs(estimate - left);
          const pb = Math.abs(estimate - up);
          const pc = Math.abs(estimate - upLeft);
          value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
          break;
        }
        default:
          throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      row[x] = value;
    }
  }
  return { width, height, bpp, pixels, stride };
}

/**
 * Downsample a decoded PNG to a signature grid that diffSignatures() can
 * compare: one average colour per cell plus how flat the frame looks.
 */
export function signatureOfImage(decoded) {
  const { width, height, bpp, pixels, stride } = decoded;
  const cells = [];
  let lumaSum = 0;
  let lumaSumSq = 0;
  let samples = 0;
  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * width) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID_W));
      const y0 = Math.floor((gy * height) / GRID_H);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID_H));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let y = y0; y < Math.min(y1, height); y += stepY) {
        for (let x = x0; x < Math.min(x1, width); x += stepX) {
          const index = y * stride + x * bpp;
          const pr = pixels[index];
          const pg = pixels[index + 1];
          const pb = pixels[index + 2];
          r += pr;
          g += pg;
          b += pb;
          const luma = 0.299 * pr + 0.587 * pg + 0.114 * pb;
          lumaSum += luma;
          lumaSumSq += luma * luma;
          samples++;
          count++;
        }
      }
      if (!count) count = 1;
      const hex = (value) => Math.round(value / count).toString(16).padStart(2, '0').slice(-2);
      cells.push(`${hex(r)}${hex(g)}${hex(b)}`);
    }
  }
  const mean = samples ? Math.round((lumaSum / samples) * 10) / 10 : 0;
  const variance = samples ? Math.max(0, lumaSumSq / samples - (lumaSum / samples) ** 2) : 0;
  return {
    width,
    height,
    cells,
    mean,
    flatness: Math.round(variance * 10) / 10,
    blank: variance < 1.5,
  };
}

export function signatureOfFile(filePath) {
  const stat = fs.statSync(filePath);
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = frameCache.get(key);
  if (cached) return cached;
  const signature = signatureOfImage(decodePng(fs.readFileSync(filePath)));
  const record = { ...signature, path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs };
  frameCache.set(key, record);
  if (frameCache.size > 300) frameCache.delete(frameCache.keys().next().value);
  return record;
}

/* -------------------------------------------------------------- frame picking */

function evidenceFor(run, step) {
  const ids = new Set(step.evidenceIds || []);
  return (run.evidence || []).filter(
    (entry) =>
      entry &&
      entry.path &&
      IMAGE_PATH.test(entry.path) &&
      !entry.simulated &&
      ((entry.stepId && entry.stepId === step.id) || ids.has(entry.id))
  );
}

function captureIndex(resolve) {
  let dir;
  try {
    dir = resolve(CAPTURES);
  } catch {
    return [];
  }
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /\.png$/i.test(name) && !/-vision\./i.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          return { path: file, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

function lastBefore(frames, at) {
  let candidate = null;
  for (const frame of frames) {
    if (frame.mtimeMs <= at) candidate = frame;
    else break;
  }
  return candidate;
}

function framesForStep(run, step, frames, resolve) {
  const explicit = evidenceFor(run, step)
    .map((entry) => {
      const file = resolve(entry.path);
      if (!file || !fs.existsSync(file)) return null;
      const stat = fs.statSync(file);
      return { path: file, mtimeMs: stat.mtimeMs, source: 'evidence' };
    })
    .filter(Boolean);
  const startedAt = toMs(step.startedAt);
  const endedAt = toMs(step.endedAt) || startedAt;
  const windowFrames =
    startedAt && endedAt
      ? frames.filter((frame) => frame.mtimeMs >= startedAt - 100 && frame.mtimeMs <= endedAt + 200)
      : [];
  const owned = explicit.length ? explicit : windowFrames;
  const before = startedAt ? frames.filter((frame) => frame.mtimeMs < startedAt - 300).slice(-1)[0] || null : null;
  if (owned.length) {
    return {
      frames: owned.slice(-3),
      before,
      source: explicit.length ? 'evidence' : 'live monitor',
    };
  }
  // The monitor only captures when the foreground changes, so a short step can
  // fall between two captures. Use the closest later frame as a proxy and say so.
  const nearest = endedAt ? frames.find((frame) => frame.mtimeMs >= endedAt && frame.mtimeMs - endedAt <= 20000) : null;
  if (nearest) {
    return { frames: [nearest], before, source: 'nearest', proxy: true };
  }
  return { frames: [], before, source: 'none' };
}

/* ----------------------------------------------------------------- analysis */

function suggestionFor(entry) {
  if (entry.verdict === 'mismatch') {
    return `“${entry.name}” reported success but the frames did not change. Add a verifyScreen or an assert after it, or wait for the control to render before acting.`;
  }
  if (entry.verdict === 'unclear') {
    return `“${entry.name}” only has a proxy frame after it (the monitor skipped the step). Add a screenshot step here or shorten the step so the change can be judged directly.`;
  }
  if (entry.verdict === 'missing') {
    return `No screenshot covers “${entry.name}”. Add a screenshot step after it (or keep the live monitor running) so the step can be judged from pixels.`;
  }
  if (entry.verdict === 'failed_with_change') {
    return `“${entry.name}” failed even though the screen changed: the failure is probably in the assertion, a late check or the following step. Re-read the error before editing this step.`;
  }
  if (entry.verdict === 'unreadable') {
    return `A frame for “${entry.name}” could not be decoded. Re-capture it as a plain PNG; the vision view (${clip(entry.frame, 80)}) cannot be diffed.`;
  }
  return '';
}

/**
 * Judge a run from its screenshots.
 *
 * `resolve` maps a stored path to an absolute path (tests point it at a temp
 * folder). The run object only needs steps with startedAt/endedAt/status and
 * an evidence list; a stored run works as-is.
 */
export function analyzeRun(run, { resolve = (target) => resolveInside(DATA, target), frames = null } = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const pool = frames || captureIndex(resolve);
  const breakdown = [];
  let previousFrame = null;
  let confirmed = 0;
  let mismatch = 0;
  let unclear = 0;
  let missing = 0;
  let failedWithChange = 0;
  let observed = 0;
  let compared = 0;
  const usedFrames = new Set();

  steps.forEach((step, index) => {
    const picked = framesForStep(run, step, pool, resolve);
    let after = null;
    let decodeError = null;
    for (const candidate of [...picked.frames].reverse()) {
      try {
        after = signatureOfFile(candidate.path);
        usedFrames.add(candidate.path);
        break;
      } catch (err) {
        decodeError = err;
      }
    }
    if (!after && decodeError) {
      const entry = {
        seq: index + 1,
        stepId: step.id,
        name: step.name,
        type: step.type,
        status: step.status,
        expectedChange: expectsScreenChange(step),
        verdict: 'unreadable',
        frame: picked.frames.at(-1)?.path || null,
        note: clip(decodeError.message || decodeError, 160),
      };
      entry.suggestion = suggestionFor(entry);
      breakdown.push(entry);
      return;
    }
    if (!after) {
      const entry = {
        seq: index + 1,
        stepId: step.id,
        name: step.name,
        type: step.type,
        status: step.status,
        expectedChange: expectsScreenChange(step),
        verdict: run?.dryRun ? 'simulated' : 'missing',
        frames: 0,
        source: picked.source,
        note: run?.dryRun ? 'Simulated runs record labelled placeholders, not pixels.' : 'No capture covers this step.',
      };
      entry.suggestion = suggestionFor(entry);
      breakdown.push(entry);
      if (!run?.dryRun) missing++;
      return;
    }
    let before = previousFrame;
    if (picked.before) {
      try {
        before = signatureOfFile(picked.before.path);
      } catch {
        before = previousFrame;
      }
    }
    const expected = expectsScreenChange(step);
    const proxy = Boolean(picked.proxy);
    let delta = null;
    if (before && before.path !== after.path) {
      delta = diffSignatures(before, after);
      compared++;
    }
    let verdict;
    if (!delta) verdict = expected ? 'missing_baseline' : 'observed';
    else if (expected) {
      if (delta.changedPct >= 1) verdict = step.status === 'failed' ? 'failed_with_change' : 'confirmed';
      else if (proxy) verdict = step.status === 'passed' ? 'unclear' : 'no_change';
      else verdict = step.status === 'passed' ? 'mismatch' : 'no_change';
    } else verdict = 'observed';

    if (verdict === 'confirmed') confirmed++;
    else if (verdict === 'mismatch') mismatch++;
    else if (verdict === 'unclear') unclear++;
    else if (verdict === 'failed_with_change') failedWithChange++;
    else observed++;

    const entry = {
      seq: index + 1,
      stepId: step.id,
      name: step.name,
      type: step.type,
      status: step.status,
      expectedChange: expected,
      verdict,
      frames: picked.frames.length,
      source: picked.source,
      proxy,
      changedPct: delta?.changedPct ?? null,
      meanDelta: delta?.meanDelta ?? null,
      before: before?.path || null,
      after: after.path,
      afterMean: after.mean,
      afterBlank: after.blank,
      note: delta
        ? `${delta.changedPct}% of cells changed${delta.changedPct < 1 ? ' (visually identical)' : ''}${proxy ? ' · proxy frame after the step, not during it' : ''}`
        : 'no earlier frame to compare against',
    };
    entry.suggestion = suggestionFor(entry);
    breakdown.push(entry);
    previousFrame = after;
  });

  const judged = breakdown.filter((entry) => !['simulated'].includes(entry.verdict)).length;
  const withFrames = breakdown.filter((entry) => entry.after).length;
  const suggestions = [];
  const uncovered = breakdown.filter((entry) => entry.verdict === 'missing');
  if (uncovered.length) {
    const names = uncovered.slice(0, 3).map((entry) => entry.name);
    suggestions.push(
      `${uncovered.length} step(s) have no capture (${names.join(', ')}${uncovered.length > 3 ? '…' : ''}). Add a screenshot step after them, or keep the live monitor running so the next run can be judged from pixels.`
    );
  }
  for (const entry of breakdown) {
    if (entry.verdict !== 'missing' && entry.suggestion) suggestions.push(entry.suggestion);
  }
  if (!withFrames && steps.length) {
    suggestions.push(
      'This run has no usable screenshots. Turn on the live monitor (it captures each foreground change) or add screenshot steps, then simulate again.'
    );
  }
  if (mismatch === 0 && confirmed > 0 && failedWithChange === 0) {
    suggestions.push(
      `Pixel evidence agrees with the run: ${confirmed} step(s) visibly changed the screen as recorded. The next integration step is to add explicit assertions only where the goal depends on content, not just change.`
    );
  }
  if (run?.dryRun) {
    suggestions.push('Simulated runs cannot be judged from pixels; replay this workflow in live mode once to build a real evidence set.');
  }

  return {
    runId: run?.id || null,
    workflowId: run?.workflowId || null,
    workflowName: run?.workflowName || '',
    mode: run?.dryRun ? 'simulated' : 'live',
    method: 'screenshots',
    framesAvailable: pool.length,
    framesUsed: usedFrames.size,
    coverage: { steps: steps.length, judged, withFrames, pct: steps.length ? Math.round((withFrames / steps.length) * 100) : 0 },
    summary: {
      confirmed,
      mismatch,
      unclear,
      missing,
      failedWithChange,
      observed,
      compared,
      verdict: mismatch > 0 ? 'disagrees' : failedWithChange > 0 ? 'needs_review' : withFrames ? 'agrees' : 'no_evidence',
    },
    breakdown,
    suggestions: [...new Set(suggestions)].slice(0, 10),
  };
}

/* ------------------------------------------------------------- simulation job */

export function listSimulations(runId = null, limit = 8) {
  const all = Array.isArray(db().simulations) ? db().simulations : [];
  return all
    .filter((item) => !runId || item.runId === runId)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}

export function findSimulation(id) {
  return listSimulations(null, 200).find((item) => item.id === id) || null;
}

function storeSimulation(record) {
  const d = db();
  if (!Array.isArray(d.simulations)) d.simulations = [];
  const index = d.simulations.findIndex((item) => item.id === record.id);
  if (index >= 0) d.simulations[index] = record;
  else d.simulations.unshift(record);
  d.simulations = d.simulations.slice(0, MAX_SIMULATIONS);
  persist();
}

function runSimulationJob(id) {
  const record = findSimulation(id);
  if (!record) return;
  try {
    const run = db().runs.find((entry) => entry.id === record.runId);
    if (!run) throw new Error('Run not found');
    const analysis = analyzeRun(run);
    Object.assign(record, {
      status: 'completed',
      completedAt: now(),
      ...analysis,
    });
    logActivity('simulation', `Screenshot check on "${run.workflowName}": ${analysis.summary.verdict}`, {
      runId: run.id,
      simulationId: id,
    });
  } catch (err) {
    record.status = 'failed';
    record.error = clip(err.message || err, 300);
    record.completedAt = now();
  }
  storeSimulation(record);
}

/** Queue a screenshot simulation; the caller returns immediately. */
export function startSimulation(runId) {
  const run = db().runs.find((entry) => entry.id === runId);
  if (!run) throw new Error('Run not found');
  const record = {
    id: uid('sim'),
    runId: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    status: 'running',
    method: 'screenshots',
    vision: { configured: visualTesterStatus().configured, used: false },
    startedAt: now(),
    completedAt: null,
  };
  storeSimulation(record);
  setTimeout(() => runSimulationJob(record.id), 25).unref?.();
  return record;
}

export function simulationSummary(record) {
  if (!record) return null;
  return {
    id: record.id,
    runId: record.runId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    status: record.status,
    method: record.method,
    startedAt: record.startedAt,
    completedAt: record.completedAt || null,
    error: record.error || null,
    mode: record.mode || null,
    coverage: record.coverage || null,
    summary: record.summary || null,
    suggestions: (record.suggestions || []).slice(0, 6),
    breakdown: (record.breakdown || []).map((entry) => ({
      seq: entry.seq,
      name: entry.name,
      type: entry.type,
      status: entry.status,
      verdict: entry.verdict,
      changedPct: entry.changedPct ?? null,
      frames: entry.frames ?? null,
      note: clip(entry.note || '', 200),
      suggestion: entry.suggestion || '',
    })),
  };
}
