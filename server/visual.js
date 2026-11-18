/**
 * Lightweight screen-state signatures used for per-step visual audits.
 * Signatures are small RGB grids, not full screenshots, so they can be
 * compared cheaply and retained in workflow memory without another image file.
 */

export function signatureHash(signature) {
  const cells = Array.isArray(signature?.cells) ? signature.cells : [];
  let hash = 2166136261;
  for (const cell of cells) {
    const value = String(cell);
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function diffSignatures(before, after) {
  const left = Array.isArray(before?.cells) ? before.cells : [];
  const right = Array.isArray(after?.cells) ? after.cells : [];
  const total = Math.max(left.length, right.length);
  if (!total) return { changedCells: 0, total: 0, changedPct: 0, meanDelta: 0, identical: true };
  let changedCells = 0;
  let deltaTotal = 0;
  for (let index = 0; index < total; index++) {
    const a = String(left[index] || '000000');
    const b = String(right[index] || '000000');
    let delta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const av = parseInt(a.slice(channel * 2, channel * 2 + 2), 16) || 0;
      const bv = parseInt(b.slice(channel * 2, channel * 2 + 2), 16) || 0;
      delta += Math.abs(av - bv);
    }
    const mean = delta / 3;
    deltaTotal += mean;
    if (mean >= 10) changedCells++;
  }
  return {
    changedCells,
    total,
    changedPct: Math.round((changedCells / total) * 1000) / 10,
    meanDelta: Math.round((deltaTotal / total) * 10) / 10,
    identical: changedCells === 0,
  };
}

export function shouldAuditVisual(step) {
  const type = String(step?.type || '');
  if (['screenshot', 'note', 'writeNote', 'readNote', 'move'].includes(type)) return false;
  if (type === 'clipboard' && !['paste', 'write', 'clear'].includes(String(step?.params?.action || '').toLowerCase())) return false;
  return true;
}

export function visualChangeMatters(step) {
  const type = String(step?.type || '');
  const name = String(step?.name || '');
  if (step?.params?.visualChange === 'none') return false;
  if (step?.params?.visualChange === 'required') return true;
  if (/copy|clipboard|select|clear|focus|assert|save note|read note/i.test(name)) return false;
  if (['clickElement', 'click', 'doubleClick', 'rightClick', 'type', 'launchApp', 'openUrl', 'installApp'].includes(type)) return true;
  return false;
}

export function summarizeVisual(step) {
  const visual = step?.visual;
  if (!visual) return null;
  return {
    changedPct: Number(visual.changedPct) || 0,
    meanDelta: Number(visual.meanDelta) || 0,
    noVisibleChange: Boolean(visual.noVisibleChange),
    beforeHash: visual.beforeHash || null,
    afterHash: visual.afterHash || null,
  };
}
