/**
 * Just enough PNG to compare two screens.
 *
 * The vision engine needs pixels, not pictures: to say "the left third changed
 * and nothing else did" it has to look at the frame's actual colours. The
 * captures on this machine are plain 8-bit PNGs, and Node already carries the
 * inflate the format is built on, so decoding them is a hundred lines of
 * arithmetic rather than another dependency.
 *
 * Only what the capture path produces is supported — non-interlaced, 8-bit,
 * grey/RGB/RGBA. Anything else returns null instead of throwing: a frame the
 * engine cannot read is a frame it must not judge, and the caller records the
 * gap rather than inventing a comparison.
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel for the colour types Windows and macOS captures emit. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode an 8-bit, non-interlaced PNG into raw channel bytes.
 * Returns `{ width, height, channels, data }` or null for anything unsupported.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) return null;
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;

  let width = 0;
  let height = 0;
  let channels = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat = [];
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) return null;
    if (type === 'IHDR') {
      if (length < 13) return null;
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8];
      channels = CHANNELS[buffer[start + 9]] || 0;
      interlace = buffer[start + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (!width || !height || !channels || bitDepth !== 8 || interlace !== 0 || !idat.length) return null;

  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const out = Buffer.allocUnsafe(stride * height);
  let previous = Buffer.alloc(stride);
  let row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const filter = raw[at];
    const line = raw.subarray(at + 1, at + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const value = line[i];
      let decoded;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + a; break;
        case 2: decoded = value + b; break;
        case 3: decoded = value + ((a + b) >> 1); break;
        case 4: decoded = value + paeth(a, b, c); break;
        default: return null;
      }
      row[i] = decoded & 0xff;
    }
    row.copy(out, y * stride);
    const swap = previous;
    previous = row;
    row = swap;
  }

  return { width, height, channels, data: out };
}

/**
 * Average a rectangle of the decoded frame into `cols × rows` colour cells —
 * the same compact form `visual.js` already compares and hashes.
 */
export function cellSignature(frame, {
  cols = 32,
  rows = 18,
  left = 0,
  top = 0,
  width = frame.width,
  height = frame.height,
} = {}) {
  const { data, channels, width: frameWidth } = frame;
  const cells = [];
  const blockW = width / cols;
  const blockH = height / rows;
  for (let row = 0; row < rows; row++) {
    const y0 = Math.floor(top + row * blockH);
    const y1 = Math.max(y0 + 1, Math.floor(top + (row + 1) * blockH));
    for (let col = 0; col < cols; col++) {
      const x0 = Math.floor(left + col * blockW);
      const x1 = Math.max(x0 + 1, Math.floor(left + (col + 1) * blockW));
      let r = 0;
      let g = 0;
      let b = 0;
      let samples = 0;
      for (let y = y0; y < Math.min(y1, frame.height); y++) {
        let at = (y * frameWidth + Math.min(x0, frameWidth - 1)) * channels;
        for (let x = x0; x < Math.min(x1, frameWidth); x++, at += channels) {
          if (channels >= 3) {
            r += data[at];
            g += data[at + 1];
            b += data[at + 2];
          } else {
            r += data[at];
            g += data[at];
            b += data[at];
          }
          samples += 1;
        }
      }
      if (!samples) {
        cells.push('000000');
        continue;
      }
      const hex = (value) => Math.round(value / samples).toString(16).padStart(2, '0');
      cells.push(`${hex(r)}${hex(g)}${hex(b)}`);
    }
  }
  return { width: cols, height: rows, cells };
}
