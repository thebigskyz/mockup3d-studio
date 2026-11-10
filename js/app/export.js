// Export: a PNG, an MP4, or a PNG sequence (every frame, transparency kept).

import * as THREE from 'three';
import { renderPNG, renderPNGSequence, download } from '../exporter.js';
import { renderMP4, mp4Supported } from '../video-export.js';
import { openFrameSource } from '../video-frames.js';
import { cameraAt, play, playhead, playing, poseAt, setTime } from './animation.js';
import { ctx } from './ctx.js';
import { seekVideoExact, seekVideosExact, video, videos } from './designs.js';
import { insts } from './instances.js';
import { anim, out, state } from './state.js';
import { setStatus } from './status.js';
import { outputSize } from './ui-sync.js';
import { $ } from './util.js';

export let exportAbort = null;
export let exporting = false;

export async function doExport() {
  if (exporting) return;
  const f = out().format;
  if (f === 'mp4' || f === 'pngseq') return exportAnimation(f);
  return exportPNG();
}

async function exportPNG() {
  const btn = $('exportBtn');
  btn.disabled = true;
  exporting = true;
  setStatus('Rendering PNG…', 'busy');
  try {
    const [width, height] = outputSize();
    await seekVideosExact(playhead);
    const blob = await renderPNG(ctx, { width, height, trim: out().bg === 'transparent' && out().trim, supersample: out().aa });
    download(blob, `mockup-${fileTag()}-${stamp()}.png`);
    const bmp = await createImageBitmap(blob);
    setStatus(`Exported ${bmp.width} × ${bmp.height} PNG`);
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'err');
  } finally {
    exporting = false;
    btn.disabled = false;
  }
}

/**
 * While exporting, feed a device's screen from frames decoded in order (fast
 * and exact) instead of seeking the <video>. Returns null if the file can't be
 * decoded that way, in which case seeking is used.
 */
async function videoFramesForExport(id) {
  const it = insts.get(id);
  const media = it?.media;
  if (!media?.video || !media.file || !it.device) return null;
  let source;
  try {
    source = await openFrameSource(media.file);
  } catch (err) {
    console.info('Falling back to seeking the design video:', err.message);
    return null;
  }
  // Draw frames into a canvas texture with the same fit as the live video.
  // Big recordings are scaled down: the screen is never that many pixels.
  const k = Math.min(1, 2048 / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * k);
  canvas.height = Math.round(source.height * k);
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  const live = media.texture;
  tex.colorSpace = live.colorSpace;
  tex.flipY = live.flipY;
  tex.center.copy(live.center);
  tex.offset.copy(live.offset);
  tex.repeat.copy(live.repeat);
  tex.rotation = live.rotation;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const material = it.device.screenMaterial;
  const prevMap = material.map;
  material.map = tex;
  material.needsUpdate = true;
  // Unload the preview <video> meanwhile, so it isn't competing for the
  // hardware decoder; it's reloaded afterwards.
  const v = media.video;
  const resumeAt = v.currentTime;
  v.pause();
  v.removeAttribute('src');
  v.load();
  let closed = false;
  return {
    id,
    async show(t) {
      await source.paintAt(t, (frame) => g.drawImage(frame, 0, 0, canvas.width, canvas.height));
      tex.needsUpdate = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      source.close();
      material.map = prevMap;
      material.needsUpdate = true;
      tex.dispose();
      v.src = media.url;
      await new Promise((r) => { v.onloadeddata = r; v.onerror = r; });
      v.currentTime = resumeAt;
    },
  };
}

/**
 * Render the animation with `encode` (renderMP4 or renderPNGSequence): each
 * frame poses every device and the camera, and shows each design video at
 * that time.
 */
async function renderAnimation(encode, opts) {
  const [width, height] = outputSize();
  // One decoder per device with a video; the others are seeked.
  const sources = new Map();
  for (const d of state.devices) {
    if (!video(d.id)) continue;
    const f = await videoFramesForExport(d.id);
    sources.set(d.id, f);
  }
  try {
    return await encode(ctx, {
      width,
      height,
      fps: anim.fps,
      duration: anim.duration,
      supersample: out().aa,
      ...opts,
      renderFrame: async (t, render) => {
        for (const d of state.devices) ctx.setSlotPose(d.id, poseAt(d.id, t));
        ctx.setCamera(cameraAt(t));
        for (const [id, frames] of sources) {
          if (frames) {
            try {
              await frames.show(t);
              continue;
            } catch (err) {
              // Decoder trouble mid-export: carry on by seeking the video instead.
              console.warn('Video decoding failed; seeking instead.', err);
              await frames.close();
              sources.set(id, null);
            }
          }
          await seekVideoExact(t, id);
        }
        return render();
      },
    });
  } finally {
    for (const f of sources.values()) await f?.close();
  }
}

/** Render the animation to an MP4 blob (also used by tests). */
export const renderAnimationMP4 = ({ onProgress, signal } = {}) =>
  renderAnimation(renderMP4, { quality: out().quality, grain: out().grain, onProgress, signal });

/** Render the animation to a zip of numbered PNGs (also used by tests). */
export const renderAnimationPNGs = ({ onProgress, signal, name = 'frames' } = {}) =>
  renderAnimation(renderPNGSequence, { onProgress, signal, name });

/** Export the animation as an MP4 ('mp4') or a zipped PNG sequence ('pngseq'). */
async function exportAnimation(kind) {
  const mp4 = kind === 'mp4';
  if (mp4 && !mp4Supported()) {
    setStatus('MP4 export needs WebCodecs (Chrome, Edge or Safari 16.4+).', 'err');
    return;
  }
  const wasPlaying = playing;
  if (playing) play(false);
  exporting = true;
  for (const v of videos()) v.pause();
  exportAbort = new AbortController();
  $('progress').hidden = false;
  $('exportBtn').disabled = true;
  $('pgFill').style.width = '0%';
  $('pgTitle').textContent = mp4 ? 'Rendering MP4' : 'Rendering PNG sequence';
  $('pgInfo').textContent = mp4 ? 'Preparing encoder…' : 'Preparing…';
  setStatus(mp4 ? 'Rendering MP4…' : 'Rendering PNG sequence…', 'busy');
  const name = `mockup-${fileTag()}-${stamp()}`;
  const t0 = performance.now();
  try {
    const opts = {
      signal: exportAbort.signal,
      name,
      onProgress: (done, total) => {
        const el = (performance.now() - t0) / 1000;
        const left = (el / done) * (total - done);
        $('pgFill').style.width = `${(done / total) * 100}%`;
        $('pgInfo').textContent = `Frame ${done} / ${total} · ${left < 1 ? 'almost done' : `${Math.ceil(left)}s left`}`;
      },
    };
    const blob = mp4 ? await renderAnimationMP4(opts) : await renderAnimationPNGs(opts);
    download(blob, `${name}.${mp4 ? 'mp4' : 'zip'}`);
    const took = `${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    const frames = Math.max(1, Math.round(anim.duration * anim.fps));
    setStatus(mp4 ? `Exported MP4 · ${took}` : `Exported ${frames} PNG frames (zip) · ${took}`);
  } catch (err) {
    if (err.name === 'AbortError') setStatus('Export cancelled');
    else {
      console.error(err);
      setStatus(err.message, 'err');
    }
  } finally {
    exporting = false;
    exportAbort = null;
    $('progress').hidden = true;
    $('exportBtn').disabled = false;
    setTime(playhead);
    if (wasPlaying) play(true);
  }
}
$('pgCancel').addEventListener('click', () => exportAbort?.abort());

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const fileTag = () => (state.devices.length > 1 ? `${state.devices.length}-devices` : state.device);
