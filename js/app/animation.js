// Pose & animation. Each device has a track, and so does the camera.

import { CAMERA, devicePose, cameraPose, trackView, evaluate, hasKeys, anyKeys, anyAnimated, keyAt, setKey, removeKey } from '../timeline.js';
import { ctx } from './ctx.js';
import { syncVideo, videos } from './designs.js';
import { exporting } from './export.js';
import { save, saveSoon } from './history.js';
import { deviceName, instOf, sel } from './instances.js';
import { syncCameraUI, syncPoseUI } from './params.js';
import { anim, recOf, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncTransport } from './transport.js';
import { $, clamp, wrap180 } from './util.js';

export let playhead = 0;
export let playing = false;
export let liveCam = cameraPose(state.camera); // camera on screen right now

export const trackOf = (id) => trackView(anim, id);

/** Show a device pose without recording it. */
export function applyPose(pose, id = state.selected) {
  const it = instOf(id);
  it.live = devicePose(pose);
  ctx.setSlotPose(id, it.live);
  if (id === state.selected) syncPoseUI();
}

/** Show a camera without recording it. */
export function applyCamera(c) {
  liveCam = cameraPose(c);
  ctx.setCamera(liveCam);
  syncCameraUI();
}

/** A device's pose at time t: its animation, or its static pose. */
export function poseAt(id, t) {
  const tr = trackOf(id);
  return hasKeys(tr) ? evaluate(tr, t) : devicePose(recOf(id)?.pose);
}
export function cameraAt(t) {
  const tr = trackOf(CAMERA);
  return hasKeys(tr) ? evaluate(tr, t) : cameraPose(state.camera);
}

export function refreshPose() {
  for (const rec of state.devices) applyPose(poseAt(rec.id, playhead), rec.id);
  applyCamera(cameraAt(playhead));
}

/**
 * Record a pose edit. With keyframes on that track and Auto-key on, it keys
 * the playhead; with no keyframes it changes the static pose.
 */
let warnedAutoKey = false;
function recordOnTrack(id, value) {
  const tr = trackOf(id);
  if (hasKeys(tr)) {
    if (state.autoKey) {
      setKey(tr, playhead, value);
      timelineUI.render();
    } else if (!warnedAutoKey) {
      setStatus('Auto-key is off: this change isn’t saved to the animation. Press K to key it.', 'busy');
      warnedAutoKey = true;
    }
  } else if (id === CAMERA) {
    state.camera = cameraPose(value);
  } else {
    recOf(id).pose = devicePose(value);
  }
}

export function commitPose(pose, id = state.selected) {
  recordOnTrack(id, devicePose(pose));
  applyPose(pose, id);
  syncTransport();
  saveSoon();
}

export function commitCamera(c) {
  recordOnTrack(CAMERA, cameraPose(c));
  applyCamera(c);
  syncTransport();
  saveSoon();
}

/**
 * Line the selected device up with the canvas: 'left' | 'hcenter' | 'right'
 * (horizontal) or 'top' | 'vcenter' | 'bottom' (vertical), using where it
 * actually appears (its silhouette), not its pivot. Moves Position X / Y only.
 */
const ALIGN_LABELS = {
  left: 'to the left edge', hcenter: 'to the horizontal centre', right: 'to the right edge',
  top: 'to the top edge', vcenter: 'to the vertical centre', bottom: 'to the bottom edge',
};
export function alignDevice(where) {
  const id = state.selected;
  if (!instOf(id).device) return;
  if (playing) play(false);
  anim2++; // stop a running angle-preset animation
  const p = devicePose(sel().live);
  // Perspective makes a move change the device's on-screen size a little, so
  // measure and correct a few times.
  for (let i = 0; i < 5; i++) {
    const b = ctx.slotBoundsNdc(id);
    if (!b) return;
    let dx = 0;
    let dy = 0;
    if (where === 'left') dx = -1 - b.minX;
    else if (where === 'right') dx = 1 - b.maxX;
    else if (where === 'hcenter') dx = -(b.minX + b.maxX) / 2;
    else if (where === 'top') dy = 1 - b.maxY;
    else if (where === 'bottom') dy = -1 - b.minY;
    else if (where === 'vcenter') dy = -(b.minY + b.maxY) / 2;
    if (Math.abs(dx) + Math.abs(dy) < 1e-5) break;
    p.pos = ctx.screenMove(p.pos, dx, dy);
    applyPose(p, id);
  }
  p.pos = p.pos.map((v) => Math.round(v * 1e4) / 1e4);
  commitPose(p, id);
  setStatus(`Aligned ${deviceName(selRec())} ${ALIGN_LABELS[where]}`);
}

export function editPose(fn) {
  const p = devicePose(sel().live);
  fn(p);
  commitPose(p);
}
export function editCamera(fn) {
  const c = cameraPose(liveCam);
  fn(c);
  commitCamera(c);
}

export function setTime(t, { seekVideo = true } = {}) {
  playhead = clamp(t, 0, anim.duration);
  refreshPose();
  if (seekVideo) syncVideo(true);
  timelineUI.updatePlayhead();
  syncTransport();
}

/** K: add or remove a keyframe at the playhead on a device's (or the camera's) track. */
export function toggleKeyAtPlayhead(id = state.selected) {
  const cam = id === CAMERA;
  const tr = trackOf(id);
  const k = keyAt(tr, playhead);
  const what = cam ? 'Camera keyframe' : 'Keyframe';
  if (k) {
    removeKey(tr, k.id);
    // Last key gone: keep what's on screen as the static pose.
    if (!hasKeys(tr)) {
      if (cam) state.camera = cameraPose(liveCam);
      else recOf(id).pose = devicePose(instOf(id).live);
    }
    setStatus(`${what} removed`);
  } else {
    setKey(tr, playhead, cam ? cameraPose(liveCam) : devicePose(instOf(id).live));
    setStatus(`${what} at ${playhead.toFixed(2)}s${cam || state.devices.length < 2 ? '' : ` · ${deviceName(recOf(id))}`}`);
  }
  timelineUI.render();
  refreshPose();
  syncTransport();
  save();
}

export function play(on = !playing) {
  if (on && !anyAnimated(anim) && !videos().length) {
    setStatus('Nothing to play yet: add keyframes or pick a Motion preset.', 'busy');
    return;
  }
  playing = on;
  if (playing && playhead >= anim.duration - 1e-3) setTime(0);
  lastFrame = performance.now();
  syncVideo(true);
  syncTransport();
}

let lastFrame = performance.now();
ctx.onBeforeRender((now) => {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing && !exporting) {
    playhead += dt;
    if (playhead >= anim.duration) {
      if (anim.loop) {
        playhead %= anim.duration;
        syncVideo(true);
      } else {
        playhead = anim.duration;
        playing = false;
      }
    }
    if (anyKeys(anim)) refreshPose();
    syncVideo(false);
    timelineUI.updatePlayhead();
    syncTransport();
  }
});

// Smoothly move to an angle preset (keys it if animating with Auto-key).
let anim2 = 0;
export function animateTo(target) {
  if (playing) play(false);
  const from = [...sel().live.rot];
  const to = target.map((t, i) => from[i] + wrap180(t - from[i])); // short way round
  const t0 = performance.now();
  const id = ++anim2;
  const step = (now) => {
    if (id !== anim2) return;
    const t = Math.min(1, (now - t0) / 450);
    const e = 1 - Math.pow(1 - t, 3);
    applyPose({ ...sel().live, rot: from.map((f, i) => f + (to[i] - f) * e) });
    if (t < 1) requestAnimationFrame(step);
    else commitPose({ ...sel().live, rot: target.slice() });
  };
  requestAnimationFrame(step);
}

/** Move the playhead without updating anything (see setTime). */
export function setPlayhead(t) {
  playhead = t;
}
/** Stop a running angle-preset animation. */
export function stopAngleAnim() {
  anim2++;
}
export function resetAutoKeyWarning() {
  warnedAutoKey = false;
}
