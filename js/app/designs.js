// Designs (the dropped image / video on each device) — videos follow the timeline

import { isModelFile } from '../custom-devices.js';
import { isHDRFile } from '../environments.js';
import { loadMedia } from '../media.js';
import { isProjectFile } from '../project.js';
import { anyKeys, setDuration } from '../timeline.js';
import { playhead, playing } from './animation.js';
import { ctx } from './ctx.js';
import { useHDRI } from './environment.js';
import { exporting } from './export.js';
import { save } from './history.js';
import { applyDevice, applyScreen, deviceName, instOf, insts, isLandscape, landscape, sel, trashedMedia } from './instances.js';
import { importDevice } from './models.js';
import { markDirty, openProject } from './projects.js';
import { renderSceneList, selectSceneDevice, selectedRecs } from './scene-list.js';
import { anim, recOf, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncControls } from './ui-sync.js';
import { $ } from './util.js';
import { deviceAt, vp } from './viewer.js';

export const video = (id = state.selected) => insts.get(id)?.media?.video || null;
export const videos = () => [...insts.values()].map((it) => it.media?.video).filter(Boolean);

export function syncVideo(force) {
  if (exporting) return;
  for (const v of videos()) {
    if (!v.duration) continue;
    const target = playhead % v.duration;
    if (playing) {
      if (v.paused) v.play().catch(() => {});
      // Correct drift, but not right at the loop point.
      const drift = Math.abs(v.currentTime - target);
      if (force || (drift > 0.12 && drift < v.duration - 0.12)) v.currentTime = target;
    } else {
      if (!v.paused) v.pause();
      if (force && Math.abs(v.currentTime - target) > 1e-3) v.currentTime = target;
    }
  }
}

/** Seek a device's design video to exactly t and upload that frame (for export). */
export function seekVideoExact(t, id = state.selected) {
  const m = insts.get(id)?.media;
  const v = m?.video;
  if (!v || !v.duration) return Promise.resolve();
  const target = Math.min(t % v.duration, v.duration - 0.001);
  return new Promise((resolve) => {
    let timer;
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(timer);
      m.texture.needsUpdate = true;
      resolve();
    };
    if (Math.abs(v.currentTime - target) < 1e-4 && v.readyState >= 2) return done();
    v.addEventListener('seeked', done);
    // Some browsers (Safari) don't always fire "seeked"; a presented frame works too.
    v.requestVideoFrameCallback?.(() => done());
    timer = setTimeout(done, 400);
    v.currentTime = target;
  });
}
export const seekVideosExact = (t) => Promise.all(state.devices.map((d) => seekVideoExact(t, d.id)));

/**
 * Put a design on a device (the selected one unless `target` is given).
 * Project files, HDRIs and models dropped in are opened instead.
 */
export async function useFile(file, { fromProject = false, target = state.selected } = {}) {
  if (!file) return;
  if (isProjectFile(file)) return openProject(file);
  if (isHDRFile(file)) return useHDRI(file);
  if (isModelFile(file)) return importDevice(file);
  if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|webp|gif|heic|mp4|mov|m4v|webm)$/i.test(file.name)) {
    setStatus(`“${file.name}” isn’t an image or video.`, 'err');
    return;
  }
  const rec = recOf(target);
  if (!rec) return;
  setStatus('Importing design…', 'busy');
  let m;
  try {
    m = await loadMedia(file, ctx.renderer);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }
  if (!recOf(target)) return disposeMedia(m); // device deleted meanwhile
  const it = instOf(target);
  disposeMedia(it.media);
  it.media = m;
  m.file = file; // kept so the project can be saved with it

  if (m.video) {
    m.video.pause();
    // With no animation yet, make the timeline as long as the video.
    if (!fromProject && !anyKeys(anim)) setDuration(anim, Math.round(m.video.duration * anim.fps) / anim.fps);
    syncVideo(true);
  }

  // Match the device orientation to the design (a project keeps its own).
  const wantLandscape = m.width > m.height;
  if (!fromProject && wantLandscape !== isLandscape(rec)) rec.orientation = wantLandscape ? 'landscape' : 'portrait';

  applyDevice(target);
  syncClip();
  renderSceneList();
  syncControls();
  timelineUI.render();
  if (fromProject) return;
  save();
  markDirty();
  setStatus(`Imported ${m.name}${state.devices.length > 1 ? ` onto ${deviceName(rec)}` : ''}`);
}

/** Show the selected device's design in the Media Pool. */
export function syncClip() {
  const m = sel().media;
  $('dzEmpty').hidden = !!m;
  $('clip').hidden = !m;
  const n = selectedRecs().length;
  $('dzFor').textContent = n > 1 ? ` · ${n} devices` : state.devices.length > 1 ? ` · ${deviceName(selRec())}` : '';
  const thumb = $('clipThumb');
  if (!m) {
    thumb.innerHTML = '';
    delete thumb.dataset.url;
    return;
  }
  $('mediaName').textContent = m.name;
  const kind = m.video ? `${m.video.duration.toFixed(1)}s video` : 'Still';
  $('mediaInfo').textContent = `${m.width} × ${m.height} · ${kind}`;
  if (thumb.dataset.url === m.url) return;
  thumb.dataset.url = m.url;
  thumb.innerHTML = '';
  thumb.appendChild(mediaThumb(m));
}

export function mediaThumb(m) {
  const el = document.createElement(m.video ? 'video' : 'img');
  el.src = m.url;
  if (m.video) Object.assign(el, { muted: true, loop: true, autoplay: true, playsInline: true });
  return el;
}

export function emptyTrash() {
  for (const m of trashedMedia.values()) disposeMedia(m);
  trashedMedia.clear();
}

export function disposeMedia(m) {
  if (!m) return;
  m.video?.pause();
  m.texture.dispose();
  URL.revokeObjectURL(m.url);
}

export function clearMedia(update = true, id = state.selected) {
  const it = insts.get(id);
  if (!it) return;
  if (update && it.media) markDirty();
  disposeMedia(it.media);
  it.media = null;
  if (update) {
    applyScreen(id);
    syncClip();
    renderSceneList();
    syncControls();
    timelineUI.render();
    setStatus();
  }
}

// Drag and drop anywhere in the window. A design dropped onto a device in
// the viewer goes on that device.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('viewport').classList.add('drop-active');
  $('dropzone').classList.add('drop-active');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    $('viewport').classList.remove('drop-active');
    $('dropzone').classList.remove('drop-active');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('viewport').classList.remove('drop-active');
  $('dropzone').classList.remove('drop-active');
  const file = e.dataTransfer.files[0];
  let target = state.selected;
  const row = e.target.closest?.('.scene-item');
  if (row && recOf(row.dataset.id)) target = row.dataset.id;
  else if (vp.contains(e.target)) target = deviceAt(e.clientX, e.clientY) || target;
  if (target !== state.selected && file && /^(image|video)\//.test(file.type)) selectSceneDevice(target);
  if (target === state.selected) useDesign(file);
  else useFile(file, { target });
});
/** A design for the selection: every selected device gets it. */
export async function useDesign(file) {
  const recs = selectedRecs();
  const isDesign = file && (/^(image|video)\//.test(file.type) || /\.(png|jpe?g|webp|gif|heic|mp4|mov|m4v|webm)$/i.test(file.name));
  if (recs.length < 2 || !isDesign) return useFile(file);
  for (const rec of recs) await useFile(file, { target: rec.id });
  setStatus(`Put ${file.name} on ${recs.length} devices`);
}
$('fileInput').addEventListener('change', (e) => {
  useDesign(e.target.files[0]);
  e.target.value = '';
});
$('clearMedia').addEventListener('click', (e) => {
  e.preventDefault(); // the button sits inside the file-picker label
  e.stopPropagation();
  clearMedia();
});
