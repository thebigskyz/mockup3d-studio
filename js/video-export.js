// MP4 (H.264) export, rendered offline frame by frame with WebCodecs, so
// every frame is exact no matter how fast the machine is.

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// High profile at decreasing levels, then Main and Baseline as fallbacks.
const CODECS = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002A', 'avc1.4D0034', 'avc1.42003E'];

export function mp4Supported() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

async function pickConfig(width, height, fps, bitrate) {
  // "quality" mode gives better pictures, but Safari's encoder then holds
  // frames back to look ahead, which stalled the export (we wait for it to
  // catch up before sending more), so WebKit uses "realtime".
  const ua = navigator.userAgent;
  const webkit = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg/.test(ua);
  const modes = webkit ? ['realtime', undefined] : ['quality', 'realtime', undefined];
  // Prefer a fixed quality level (quantizer): with a bitrate target the
  // encoder spends almost nothing on still areas like a gradient, which then
  // bands. Fall back to a bitrate where that isn't supported.
  for (const rate of ['quantizer', 'variable']) {
    for (const latencyMode of modes) {
      for (const codec of CODECS) {
        const config = { codec, width, height, bitrateMode: rate, framerate: fps, avc: { format: 'avc' } };
        if (rate !== 'quantizer') config.bitrate = bitrate;
        if (latencyMode) config.latencyMode = latencyMode;
        try {
          const { supported } = await VideoEncoder.isConfigSupported(config);
          if (supported) return config;
        } catch {
          /* try the next one */
        }
      }
    }
  }
  throw new Error(`This browser can't encode H.264 at ${width} × ${height}. Try a smaller size.`);
}

/**
 * Dithering: faint noise added to each frame so smooth gradients don't band.
 * `block` is the grain size in pixels, `amp` its strength in 0–255 levels.
 * - light: single-pixel grain, mostly ±1 level: barely visible.
 * - medium: single-pixel grain, up to ±3 levels.
 * - strong: coarser 2-pixel grain, up to ±4 levels. It survives encoders
 *   that smooth fine detail away (Safari's), so it's the safest there.
 */
const DITHER = {
  light: { block: 1, amp: 1.5 },
  medium: { block: 1, amp: 3 },
  strong: { block: 2, amp: 4 },
};
function grainFor(grain) {
  return DITHER[grain] || false;
}

/**
 * @param ctx          scene from createScene()
 * @param opts.width / height / fps / duration / quality ('standard' | 'high')
 * @param opts.grain  dithering (anti-banding noise): 'off' | 'light' | 'medium' | 'strong'
 * @param opts.renderFrame async (t, render) => canvas — pose the scene for time t, then return render()
 * @param opts.supersample render this many times larger, then scale down (smoother edges)
 * @param opts.onProgress (done, total) => void
 * @param opts.signal  AbortSignal to cancel
 * @returns Blob (video/mp4)
 */
export async function renderMP4(ctx, { width, height, fps, duration, quality = 'standard', grain = 'light', supersample = 2, renderFrame, onProgress, signal }) {
  if (!mp4Supported()) {
    throw new Error('MP4 export needs WebCodecs (Chrome, Edge or Safari 16.4+).');
  }
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

  width = even(width);
  height = even(height);
  // Generous bitrates: smooth gradients band badly when starved of bits.
  // Quality level for constant-quality encoding (H.264 QP, lower = better).
  // Tested on dark gradients: 12 keeps them smooth, 16+ visibly bands.
  const quantizer = quality === 'high' ? 9 : 12;
  // Bitrate fallback where constant quality isn't supported. Generous,
  // because gradients band badly when starved of bits.
  const bitsPerPixel = quality === 'high' ? 1.2 : 0.6;
  const bitrate = Math.round(Math.min(80e6, width * height * fps * bitsPerPixel));
  const config = await pickConfig(width, height, fps, bitrate);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { muxer.addVideoChunk(chunk, meta); if (window.__exportDebug) window.__exportDebug.encoded++; },
    error: (e) => { encodeError = e; },
  });
  encoder.configure(config);

  const total = Math.max(1, Math.round(duration * fps));
  // Where the export is up to, for diagnosing stalls from the console.
  const dbg = (window.__exportDebug = { total, frame: 0, stage: 'start', since: performance.now(), queue: 0, encoded: 0, config: `${config.codec} ${config.latencyMode || 'quality'} ${config.bitrateMode === 'quantizer' ? 'qp' + quantizer : 'vbr'}` });
  const stage = (name) => { dbg.stage = name; dbg.since = performance.now(); dbg.queue = encoder.encodeQueueSize; };
  const frameUs = 1e6 / fps;
  const canvas = ctx.renderer.domElement;

  try {
    await ctx.withRenderSize(width, height, async (render) => {
      for (let i = 0; i < total; i++) {
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        if (encodeError) throw encodeError;

        dbg.frame = i;
        stage('render');
        const src = (await renderFrame(i / fps, render)) || canvas;
        stage('encode');
        const frame = new VideoFrame(src, {
          timestamp: Math.round(i * frameUs),
          duration: Math.round(frameUs),
          alpha: 'discard',
        });
        encoder.encode(frame, config.bitrateMode === 'quantizer'
          ? { keyFrame: i % (fps * 2) === 0, avc: { quantizer } }
          : { keyFrame: i % (fps * 2) === 0 });
        frame.close();

        // Don't let the encoder fall too far behind. If it sits on frames
        // without producing output, make it hand them over (flush) rather
        // than wait forever.
        stage('wait-encoder');
        const waitStart = performance.now();
        const outputsBefore = dbg.encoded;
        while (encoder.encodeQueueSize > 6) {
          if (performance.now() - waitStart > 1000 && dbg.encoded === outputsBefore) {
            stage('force-flush');
            await encoder.flush();
            break;
          }
          await new Promise((r) => setTimeout(r, 4));
        }
        onProgress?.(i + 1, total);
      }
    }, {
      supersample,
      dither: grainFor(grain),
    });
    stage('flush');
    await encoder.flush();
    stage('done');
    if (encodeError) throw encodeError;
    muxer.finalize();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  return new Blob([target.buffer], { type: 'video/mp4' });
}
