/**
 * Locating a named control by its text.
 *
 * UI Automation is the right way to find a control and the wrong one for a Tk
 * app: the toolkit exposes no element tree, so every named click had to be
 * answered by the vision model, which is slow and roughly one control-glyph
 * off. The desktop's own OCR reads the label instead — measured at 19–46 ms per
 * window, against 0.7–52 s for the model — and the label sits inside the button
 * it names.
 *
 * The box Windows OCR returns is a line box, not a glyph box: it carries the
 * font's ascent and descent slack, so its centre sits about half a line low on
 * a small button and a click aimed at it lands near the button's bottom edge.
 * The label's own ink is the honest anchor, so the caller can pass the dark-pixel
 * centroid measured inside the same box and this module puts the point there.
 *
 * Pure: no capture, no PowerShell, no I/O, so the matching rules are testable
 * without a desktop.
 */

/** Two words on one line sit within this many pixels of the same baseline. */
export const OCR_LINE_TOLERANCE = 10;

/** Split OCR words into text lines by overlapping baselines. */
export function ocrLines(words = [], { minY = 0, tolerance = OCR_LINE_TOLERANCE } = {}) {
  const lines = [];
  for (const word of Array.isArray(words) ? words : []) {
    const text = String(word?.text || '').trim();
    const x = Number(word?.x);
    const y = Number(word?.y);
    const w = Number(word?.w ?? word?.width);
    const h = Number(word?.h ?? word?.height);
    if (!text || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (h <= 0 || w <= 0) continue;
    // Window chrome is not a control: a title bar's "Profile" would otherwise
    // outrank the button of the same name.
    if (y + h / 2 < Number(minY) || y < 0) continue;
    const centre = y + h / 2;
    // Every field travels with the word: the ink centroid measured inside the
    // word's own box is what the anchor is built from.
    const entry = { ...word, text, x, y, w, h };
    const line = lines.find((item) => Math.abs(item.centre - centre) <= tolerance);
    if (line) {
      line.words.push(entry);
      line.centre = (line.centre * (line.words.length - 1) + centre) / line.words.length;
    } else {
      lines.push({ centre, words: [entry] });
    }
  }
  return lines.map((line) => {
    const ordered = line.words.slice().sort((a, b) => a.x - b.x);
    const left = Math.min(...ordered.map((word) => word.x));
    const top = Math.min(...ordered.map((word) => word.y));
    const right = Math.max(...ordered.map((word) => word.x + word.w));
    const bottom = Math.max(...ordered.map((word) => word.y + word.h));
    return { text: ordered.map((word) => word.text).join(' '), words: ordered, left, top, right, bottom };
  });
}

/**
 * How well a line's text answers to a control name, in the same vocabulary the
 * UI Automation search uses: an exact label wins, a longer label that merely
 * contains the name ranks below one that starts with it.
 */
export function ocrLabelScore(lineText, wanted) {
  const text = String(lineText || '').toLowerCase().trim();
  const needle = String(wanted || '').toLowerCase().trim();
  if (!text || !needle) return 0;
  if (text === needle) return 120;
  if (text.startsWith(needle)) return 100;
  if (text.includes(needle)) return 80;
  const tokens = needle.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => text.includes(token)).length;
  if (matched === tokens.length) return 60;
  return matched ? 20 + 10 * matched : 0;
}

/**
 * The line that best names the control. Ties go to the shorter label ("Save"
 * over "Save profile" for a control called "Save") and then to the one higher on
 * screen, which is the stable order for a list of similar rows.
 */
export function matchOcrLine(lines = [], names = []) {
  const wanted = (Array.isArray(names) ? names : [names]).map((name) => String(name || '').trim()).filter(Boolean);
  let best = null;
  for (const line of lines) {
    let score = 0;
    let matched = '';
    for (const name of wanted) {
      const value = ocrLabelScore(line.text, name);
      if (value > score) {
        score = value;
        matched = name;
      }
    }
    if (!score) continue;
    const candidate = { line, score, matched };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.line.text.length < best.line.text.length) ||
      (candidate.score === best.score && candidate.line.text.length === best.line.text.length && candidate.line.top < best.line.top)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Where to click for a line: the label's ink when it was measured, its line box
 * otherwise. The ink carries the same horizontal extent as the text, so mixing
 * the two is not needed; the box is the fallback for a label with no dark pixels
 * of its own (light text on a dark theme).
 */
export function ocrLineAnchor(line, ink = null) {
  if (!line) return null;
  const boxPoint = {
    x: Math.round((line.left + line.right) / 2),
    y: Math.round((line.top + line.bottom) / 2),
  };
  const inkX = Number(ink?.x);
  const inkY = Number(ink?.y);
  if (!Number.isFinite(inkX) || !Number.isFinite(inkY) || Number(ink?.pixels) < 8) return boxPoint;
  // An ink centroid outside the label's own box is a neighbour's pixels (an
  // icon, a border): trust the box instead of jumping.
  const margin = 6;
  if (inkX < line.left - margin || inkX > line.right + margin) return boxPoint;
  if (inkY < line.top - margin || inkY > line.bottom + margin) return boxPoint;
  return { x: Math.round(inkX), y: Math.round(inkY) };
}

/**
 * The ink anchor for a whole line: its words' centroids, weighted by how many
 * dark pixels each one contributed. A word with fewer glyphs ('I') should not
 * pull the anchor as hard as one with more ('Notifications').
 */
export function lineInk(line) {
  const words = (line?.words || []).filter((word) => Number(word?.ink?.pixels) > 0);
  if (!words.length) return null;
  let sumX = 0;
  let sumY = 0;
  let pixels = 0;
  for (const word of words) {
    const weight = Number(word.ink.pixels) || 0;
    sumX += Number(word.ink.x) * weight;
    sumY += Number(word.ink.y) * weight;
    pixels += weight;
  }
  if (!pixels) return null;
  return { x: sumX / pixels, y: sumY / pixels, pixels };
}

/**
 * Turn a capture-relative anchor into an absolute screen point. The capture
 * starts at the window's own corner, and both frames are physical pixels because
 * the capture script is DPI-aware.
 */
export function ocrScreenPoint(anchor, origin = {}) {
  const x = Number(anchor?.x);
  const y = Number(anchor?.y);
  const ox = Number(origin.x) || 0;
  const oy = Number(origin.y) || 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x + ox), y: Math.round(y + oy) };
}

