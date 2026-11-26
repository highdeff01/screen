/**
 * Where a point the vision model reported really is on the desktop.
 *
 * The model answers in the pixels of the image it was given, and that image is
 * a downscaled crop of the virtual desktop. Two offsets decide the answer: the
 * crop's own place inside the desktop, and the desktop's origin — which is
 * negative whenever a monitor sits to the left of the main one. Adding the crop
 * but not the origin put every located point 1366px to the right on a machine
 * with a left-hand display, so clicks and aims landed on another monitor.
 *
 * A point outside the captured region is not a control this step can click, so
 * it is refused rather than clamped to the edge.
 */
export function mapVisionPoint({ view = {}, x, y } = {}) {
  const width = Number(view.width) || 0;
  const height = Number(view.height) || 0;
  if (!width || !height) return null;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const originX = Number(view.originX) || 0;
  const originY = Number(view.originY) || 0;
  const left = originX + (Number(view.cropX) || 0);
  const top = originY + (Number(view.cropY) || 0);
  const cropWidth = Number(view.cropWidth) || width;
  const cropHeight = Number(view.cropHeight) || height;
  const screenX = Math.round(left + (px * cropWidth) / width);
  const screenY = Math.round(top + (py * cropHeight) / height);
  if (screenX < left || screenY < top) return null;
  if (screenX > left + cropWidth || screenY > top + cropHeight) return null;
  return { x: screenX, y: screenY };
}
