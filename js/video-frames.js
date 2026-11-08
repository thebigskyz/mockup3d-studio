// Frame-accurate access to a design video for export, without seeking.
//
// Seeking an <video> element to every export frame is slow (especially in
// Safari with HEVC screen recordings). Instead we read the MP4/MOV container
// with mp4box.js and decode the frames in order with WebCodecs' hardware
// decoder, keeping only a handful in memory at a time.

const AHEAD = 2;      // decoded frames to keep queued ahead of the one shown
const MAX_PENDING = 6; // chunks the decoder may hold before we wait for it

/**
 * Open a video file for sequential frame access.
 * Resolves to a source, or throws if the file/codec isn't supported
 * (callers fall back to seeking the <video> element).
 */
export async function openFrameSource(file) {
  if (typeof window.VideoDecoder !== 'function') throw new Error('WebCodecs not available');
  const { createFile, DataStream } = await import('mp4box');
  const buffer = await file.arrayBuffer();

  const mp4 = createFile();
  const { track, samples } = await new Promise((resolve, reject) => {
    let track = null;
    const samples = [];
    mp4.onError = (e) => reject(new Error(String(e)));
    mp4.onReady = (info) => {
      track = info.videoTracks[0];
      if (!track) return reject(new Error('No video track'));
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();
    };
    mp4.onSamples = (_id, _user, s) => {
      samples.push(...s);
      if (track && samples.length >= track.nb_samples) resolve({ track, samples });
    };
    buffer.fileStart = 0;
    mp4.appendBuffer(buffer);
    mp4.flush();
    setTimeout(() => (track && samples.length ? resolve({ track, samples }) : reject(new Error('Could not read the video'))), 0);
  });

  const config = {
    codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: codecDescription(mp4, track, DataStream),
    hardwareAcceleration: 'prefer-hardware',
  };
  const { supported } = await VideoDecoder.isConfigSupported(config);
  if (!supported) throw new Error(`Can’t decode ${track.codec}`);

  samples.sort((a, b) => a.dts - b.dts); // decode order
  const t0 = Math.min(...samples.map((s) => s.cts));
  const toUs = (v, scale) => Math.round((v * 1e6) / scale);
  const chunks = samples.map((s) => ({
    type: s.is_sync ? 'key' : 'delta',
    timestamp: toUs(s.cts - t0, s.timescale),
    duration: toUs(s.duration, s.timescale),
    data: s.data,
  }));
  const durationUs = Math.max(...chunks.map((c) => c.timestamp + c.duration));

  let decoder = null;
  let queue = [];      // decoded frames (presentation order) not shown yet
  let shown = false;   // has a frame been painted since start()
  let next = 0;        // next chunk to feed
  let flushed = false;
  let lastUs = -1;
  let wake = null;
  let failure = null;
  const stats = { outputs: 0, closed: 0, fed: 0, phase: 'idle' };

  function start() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    for (const f of queue) f.close();
    queue = [];
    shown = false;
    next = 0;
    flushed = false;
    decoder = new VideoDecoder({
      output: (frame) => {
        stats.outputs++;
        queue.push(frame);
        wake?.();
      },
      error: (e) => { failure = e; wake?.(); },
    });
    decoder.addEventListener?.('dequeue', () => wake?.());
    decoder.configure(config);
  }
  start();

  // Wait for the decoder to produce a frame or take more input. The timer is
  // only a safety net (timers are slowed down in background tabs).
  // Each wait owns its timer: an old timer must never cancel a newer wait
  // (that was a deadlock that froze exports at a random frame).
  const waitForDecoder = () => new Promise((resolve) => {
    let timer = 0;
    const finish = () => {
      if (wake === finish) wake = null;
      clearTimeout(timer);
      resolve();
    };
    wake = finish;
    timer = setTimeout(finish, 250);
  });

  // Paint a frame and release it straight away: hardware decoders have a
  // small pool of frame buffers and stall if we hold on to them.
  const show = (frame, paint) => {
    try { paint(frame); } finally { frame.close(); }
    shown = true;
  };

  return {
    width: track.video.width,
    height: track.video.height,
    duration: durationUs / 1e6,

    /**
     * Paint the frame that's on screen at time t (seconds, wrapped to the
     * video length) by calling paint(frame). The frame is only valid during
     * the call.
     */
    async paintAt(t, paint) {
      const len = durationUs / 1e6;
      const us = Math.round((((t % len) + len) % len) * 1e6);
      if (us < lastUs) start(); // looped back to the start
      lastUs = us;
      let lastProgress = performance.now();
      for (;;) {
        if (failure) throw failure;
        // The newest decoded frame that's due is the one to show.
        let due = null;
        while (queue.length && queue[0].timestamp <= us) {
          due?.close();
          due = queue.shift();
        }
        if (due) show(due, paint);
        if (shown && queue.length) return; // the next frame is in the future
        if (!shown && queue.length >= AHEAD) return show(queue.shift(), paint); // before the first frame

        if (next < chunks.length) {
          // Keep feeding while the decoder accepts input: HEVC/H.264
          // decoders often hold several frames back before outputting any.
          let fed = false;
          while (next < chunks.length && queue.length < AHEAD && decoder.decodeQueueSize < MAX_PENDING) {
            decoder.decode(new EncodedVideoChunk(chunks[next++]));
            stats.fed++;
            fed = true;
          }
          const before = queue.length;
          if (!fed || decoder.decodeQueueSize > 0) await waitForDecoder();
          else await Promise.resolve();
          if (fed || queue.length !== before) lastProgress = performance.now();
          else if (performance.now() - lastProgress > 3000) throw new Error('Video decoder stalled');
        } else if (!flushed) {
          flushed = true;
          stats.phase = 'flush';
          await decoder.flush();
          stats.phase = 'flushed';
        } else {
          // End of the video: keep showing the last frame.
          if (queue.length) show(queue.pop(), paint);
          for (const f of queue) f.close();
          queue = [];
          return;
        }
      }
    },

    /** Internal state, for diagnosing stalls. */
    get debug() {
      return { ...stats, queue: queue.length, queueTs: queue.map((f) => f.timestamp), next, chunks: chunks.length, flushed, lastUs, decodeQueueSize: decoder?.decodeQueueSize, decoderState: decoder?.state };
    },

    close() {
      for (const f of queue) f.close();
      queue = [];
      if (decoder && decoder.state !== 'closed') decoder.close();
    },
  };
}

// The avcC / hvcC / vpcC / av1C box contents, which the decoder needs.
function codecDescription(file, track, DataStream) {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // without the box header
    }
  }
  return undefined;
}
