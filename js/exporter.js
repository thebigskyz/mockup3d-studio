/**
 * Render the current frame at width x height and return it as a PNG blob.
 * With a transparent background, `trim` crops away the empty space.
 */
export async function renderPNG(ctx, { width, height, trim = false, supersample = 2 }) {
  const maxSide = ctx.renderer.capabilities.maxTextureSize || 8192;
  const k = Math.min(1, maxSide / Math.max(width, height));
  width = Math.round(width * k);
  height = Math.round(height * k);

  let blob = await ctx.withRenderSize(width, height, async (render) => {
    const canvas = render();
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }, { supersample });
  if (!blob) throw new Error('Export failed: the image was too large for this browser.');
  if (trim) blob = await trimTransparent(blob);
  return blob;
}

/** Crop to the non-transparent pixels, plus a small margin. */
export async function trimTransparent(blob, marginRatio = 0.03) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);

  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > 2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return blob; // nothing drawn

  const m = Math.round(Math.max(maxX - minX, maxY - minY) * marginRatio);
  const x0 = Math.max(0, minX - m);
  const y0 = Math.max(0, minY - m);
  const x1 = Math.min(width, maxX + 1 + m);
  const y1 = Math.min(height, maxY + 1 + m);

  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
