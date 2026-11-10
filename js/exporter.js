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

/**
 * Render an animation as numbered PNGs (transparency kept), zipped into a
 * folder: `name/name_0000.png`, `name/name_0001.png` … Video editors (After
 * Effects, Premiere, DaVinci Resolve, Final Cut via Motion) import a
 * numbered sequence like this as one clip.
 *
 * @param opts.renderFrame async (t, render) => canvas, as for renderMP4
 * @returns Blob (application/zip)
 */
export async function renderPNGSequence(ctx, { width, height, fps, duration, supersample = 2, renderFrame, onProgress, signal, name = 'frames' }) {
  const { Zip, ZipPassThrough } = await import('fflate');
  const total = Math.max(1, Math.round(duration * fps));
  const digits = Math.max(4, String(total - 1).length);
  // Stream the zip into chunks (PNGs are already compressed, so they're
  // stored as they are) rather than holding every frame twice.
  const chunks = [];
  let zipError = null;
  const zip = new Zip((err, data) => {
    if (err) zipError = err;
    else chunks.push(data);
  });
  await ctx.withRenderSize(width, height, async (render) => {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const canvas = await renderFrame(i / fps, render);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Export failed: the frames were too large for this browser. Try a smaller size.');
      const file = new ZipPassThrough(`${name}/${name}_${String(i).padStart(digits, '0')}.png`);
      zip.add(file);
      file.push(new Uint8Array(await blob.arrayBuffer()), true);
      if (zipError) throw zipError;
      onProgress?.(i + 1, total);
    }
  }, { supersample });
  zip.end();
  if (zipError) throw zipError;
  return new Blob(chunks, { type: 'application/zip' });
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
