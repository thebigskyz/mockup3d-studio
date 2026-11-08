// Animation model: keyframed device and camera poses, one track each, with
// an easing per segment.
// No DOM here, so it can be tested on its own.

import { ease } from './easing.js';

export const CAMERA = 'camera'; // id of the camera's track

/**
 * A device pose: rotation in degrees, position in scene units (x, y, depth;
 * one unit is the radius of the largest device in the scene) and scale.
 */
export const DEFAULT_POSE = Object.freeze({ rot: [0, 0, 0], pos: [0, 0, 0], scale: 1 });
/**
 * The scene camera: field of view (degrees), zoom, pan (scene units, across
 * and up the screen) and orbit (degrees: around the scene, elevation above
 * it, and roll of the frame).
 */
export const DEFAULT_CAMERA = Object.freeze({ fov: 30, zoom: 1, pan: [0, 0], orbit: [0, 0, 0] });

const nums = (a, n, fill = 0) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number.isFinite(a?.[i]) ? a[i] : fill);
  return out;
};

/** A complete, independent device pose (missing values filled in). */
export function devicePose(p = DEFAULT_POSE) {
  return { rot: nums(p?.rot, 3), pos: nums(p?.pos, 3), scale: p?.scale > 0 ? p.scale : 1 };
}

/** A complete, independent camera pose. */
export function cameraPose(c = DEFAULT_CAMERA) {
  return { fov: Number.isFinite(c?.fov) ? c.fov : 30, zoom: c?.zoom > 0 ? c.zoom : 1, pan: nums(c?.pan, 2), orbit: nums(c?.orbit, 3) };
}

/** Copy of any pose (numbers and arrays of numbers). */
export function clonePose(p) {
  const o = {};
  for (const [k, v] of Object.entries(p)) o[k] = Array.isArray(v) ? [...v] : v;
  return o;
}

const lerp = (a, b, k) => a + (b - a) * k;
// Zoom and scale feel even when interpolated geometrically.
const GEOMETRIC = new Set(['zoom', 'scale']);

export function lerpPose(a, b, k) {
  const o = {};
  for (const key of Object.keys(a)) {
    const x = a[key];
    const y = b[key] ?? x;
    if (Array.isArray(x)) o[key] = x.map((v, i) => lerp(v, y[i] ?? v, k));
    else if (GEOMETRIC.has(key) && x > 0 && y > 0) o[key] = x * Math.pow(y / x, k);
    else o[key] = lerp(x, y, k);
  }
  return o;
}

/** Shared timing plus one keyframe list per track (device ids and 'camera'). */
export function createAnim() {
  return { duration: 4, fps: 30, loop: true, tracks: {} };
}

/**
 * One track of an animation, shaped like an animation with a single list of
 * keyframes, so the keyframe functions below work on any track.
 */
export function trackView(anim, id) {
  return {
    id,
    get duration() { return anim.duration; },
    get fps() { return anim.fps; },
    get loop() { return anim.loop; },
    get keyframes() { return anim.tracks[id] || (anim.tracks[id] = []); },
    set keyframes(v) { anim.tracks[id] = v; },
  };
}

/** Restore an animation saved to storage, filling in anything missing. */
export function reviveAnim(saved) {
  const a = createAnim();
  if (!saved || typeof saved !== 'object') return a;
  a.duration = clampDuration(saved.duration ?? a.duration);
  a.fps = clampFps(saved.fps ?? a.fps);
  a.loop = saved.loop ?? true;
  for (const [id, keys] of Object.entries(saved.tracks || {})) {
    if (!Array.isArray(keys)) continue;
    const norm = id === CAMERA ? cameraPose : devicePose;
    a.tracks[id] = keys
      .filter((k) => k && isFinite(k.t))
      .map((k) => ({ id: newId(), t: k.t, pose: norm(k.pose), ease: k.ease || 'easeInOut' }))
      .sort((x, y) => x.t - y.t);
  }
  return a;
}

/**
 * Older versions had one device and one list of keyframes whose poses held
 * the camera's zoom and lens too. Split them into a device track and (only
 * if those values change) a camera track. Positions were in device radii,
 * which is what a scene unit is with one device.
 */
export function migrateLegacyAnim(saved, deviceId) {
  const keys = (saved?.keyframes || []).filter((k) => k && isFinite(k.t) && k.pose);
  const anim = { duration: saved?.duration, fps: saved?.fps, loop: saved?.loop, tracks: {} };
  if (keys.length) {
    anim.tracks[deviceId] = keys.map((k) => ({ t: k.t, ease: k.ease, pose: devicePose({ rot: k.pose.rot, pos: k.pose.pos }) }));
  }
  const cams = keys.map((k) => cameraPose(k.pose));
  const varies = cams.some((c) => Math.abs(c.zoom - cams[0].zoom) > 1e-6 || Math.abs(c.fov - cams[0].fov) > 1e-6);
  if (varies) anim.tracks[CAMERA] = keys.map((k, i) => ({ t: k.t, ease: k.ease, pose: cams[i] }));
  return { anim, camera: cams[0] || null };
}

export const clampDuration = (d) => Math.min(60, Math.max(0.5, Number(d) || 4));

/** Common frame rates offered in the menu; any whole number 1–240 is allowed. */
export const FPS_PRESETS = [12, 15, 24, 25, 30, 48, 50, 60, 120];
export const clampFps = (f) => Math.min(240, Math.max(1, Math.round(Number(f) || 30)));

let idCounter = 0;
const newId = () => `k${++idCounter}`;

export function sortKeys(anim) {
  anim.keyframes.sort((a, b) => a.t - b.t);
}

export const hasKeys = (anim) => anim.keyframes.length > 0;
export const isAnimated = (anim) => anim.keyframes.length > 1;
/** Whether any track has keyframes / any track moves. */
export const anyKeys = (anim) => Object.values(anim.tracks).some((k) => k.length > 0);
export const anyAnimated = (anim) => Object.values(anim.tracks).some((k) => k.length > 1);
/** Every track's keyframes in one list (for jumping between keyframes). */
export const allKeysView = (anim) => ({
  duration: anim.duration,
  fps: anim.fps,
  keyframes: Object.values(anim.tracks).flat().sort((a, b) => a.t - b.t),
});

/** Pose at time t, or null if there are no keyframes. */
export function evaluate(anim, t) {
  const k = anim.keyframes;
  if (!k.length) return null;
  if (t <= k[0].t) return clonePose(k[0].pose);
  const last = k[k.length - 1];
  if (t >= last.t) return clonePose(last.pose);
  let i = 0;
  while (i < k.length - 2 && t >= k[i + 1].t) i++;
  const a = k[i];
  const b = k[i + 1];
  const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  return lerpPose(a.pose, b.pose, ease(a.ease, u));
}

/** Keyframe within half a frame of t, if any. */
export function keyAt(anim, t) {
  const eps = 0.5 / anim.fps;
  return anim.keyframes.find((k) => Math.abs(k.t - t) < eps) || null;
}

export function snapTime(anim, t) {
  const f = Math.round(t * anim.fps) / anim.fps;
  return Math.min(anim.duration, Math.max(0, f));
}

/** Add a keyframe at t, or update the one already there. */
export function setKey(anim, t, pose, easeName) {
  t = snapTime(anim, t);
  let k = keyAt(anim, t);
  if (k) {
    k.pose = clonePose(pose);
    if (easeName) k.ease = easeName;
  } else {
    // New keys inherit the easing of the segment they split.
    const before = [...anim.keyframes].reverse().find((x) => x.t < t);
    k = { id: newId(), t, pose: clonePose(pose), ease: easeName || before?.ease || 'easeInOut' };
    anim.keyframes.push(k);
    sortKeys(anim);
  }
  return k;
}

export function duplicateKey(anim, id) {
  const src = anim.keyframes.find((k) => k.id === id);
  if (!src) return null;
  const k = { id: newId(), t: src.t, pose: clonePose(src.pose), ease: src.ease };
  anim.keyframes.push(k);
  sortKeys(anim);
  return k;
}

export function removeKey(anim, id) {
  anim.keyframes = anim.keyframes.filter((k) => k.id !== id);
}

/** Move a key in time. Another key already on that frame is replaced. */
export function moveKey(anim, id, t) {
  const k = anim.keyframes.find((x) => x.id === id);
  if (!k) return;
  k.t = snapTime(anim, t);
  sortKeys(anim);
}

/** Drop other keys that share a frame with `id` (after a drag ends). */
export function resolveOverlaps(anim, id) {
  const k = anim.keyframes.find((x) => x.id === id);
  if (!k) return;
  const eps = 0.5 / anim.fps;
  anim.keyframes = anim.keyframes.filter((x) => x === k || Math.abs(x.t - k.t) >= eps);
}

/**
 * Change the duration. Keyframes keep their times; any past the new end are
 * kept (not deleted) and come back if the timeline is lengthened again.
 */
export function setDuration(anim, d) {
  anim.duration = clampDuration(d);
}

export function prevKeyTime(anim, t) {
  const eps = 0.5 / anim.fps;
  const k = [...anim.keyframes].reverse().find((x) => x.t < t - eps);
  return k ? k.t : 0;
}
export function nextKeyTime(anim, t) {
  const eps = 0.5 / anim.fps;
  const k = anim.keyframes.find((x) => x.t > t + eps);
  return k ? k.t : anim.duration;
}

// ---------------------------------------------------------------------------
// Motion presets. Times are fractions of the duration; poses are partial and
// relative to the device's own position and size.
// ---------------------------------------------------------------------------
// `zoom` in a preset scales the device; `pos` is added to its position.
const P = (rot, extra = {}) => ({ rot, ...extra });

export const MOTION_PRESETS = [
  {
    id: 'turntable',
    label: 'Turntable',
    loop: true,
    keys: [
      { t: 0, pose: P([6, 0, 0]), ease: 'linear' },
      { t: 1, pose: P([6, 360, 0]) },
    ],
  },
  {
    id: 'hero',
    label: 'Hero reveal',
    loop: false,
    keys: [
      { t: 0, pose: P([4, 160, 0], { zoom: 0.8 }), ease: 'easeInOut' },
      { t: 0.7, pose: P([10, -28, -6], { zoom: 1 }), ease: 'linear' },
      { t: 1, pose: P([10, -28, -6], { zoom: 1.03 }) },
    ],
  },
  {
    id: 'float',
    label: 'Float',
    loop: true,
    keys: [
      { t: 0, pose: P([8, -22, -4], { pos: [0, 0] }), ease: 'smooth' },
      { t: 0.5, pose: P([2, -14, 2], { pos: [0, 0.05] }), ease: 'smooth' },
      { t: 1, pose: P([8, -22, -4], { pos: [0, 0] }) },
    ],
  },
  {
    id: 'swing',
    label: 'Swing',
    loop: true,
    keys: [
      { t: 0, pose: P([4, -32, 0]), ease: 'smooth' },
      { t: 0.5, pose: P([4, 32, 0]), ease: 'smooth' },
      { t: 1, pose: P([4, -32, 0]) },
    ],
  },
  {
    id: 'push',
    label: 'Push in',
    loop: false,
    keys: [
      { t: 0, pose: P([0, -10, 0], { zoom: 0.7 }), ease: 'easeInOut' },
      { t: 1, pose: P([8, -26, -5], { zoom: 1.3 }) },
    ],
  },
  {
    id: 'drop',
    label: 'Drop in',
    loop: false,
    keys: [
      { t: 0, pose: P([-40, 0, 0], { pos: [0, 2.4] }), ease: 'backOut' },
      { t: 0.55, pose: P([8, -22, -4], { pos: [0, 0] }), ease: 'smooth' },
      { t: 1, pose: P([4, -16, -2], { pos: [0, 0.02] }) },
    ],
  },
  {
    id: 'slide',
    label: 'Slide in',
    loop: false,
    keys: [
      { t: 0, pose: P([0, 45, 0], { pos: [-2.6, 0] }), ease: 'easeOut' },
      { t: 0.6, pose: P([6, -18, -3], { pos: [0, 0] }), ease: 'smooth' },
      { t: 1, pose: P([6, -24, -4], { pos: [0, 0] }) },
    ],
  },
  {
    id: 'tabletop',
    label: 'Tabletop',
    loop: false,
    keys: [
      { t: 0, pose: P([-62, -20, 34], { zoom: 0.95 }), ease: 'easeInOut' },
      { t: 1, pose: P([-58, 18, -24], { zoom: 1.1 }) },
    ],
  },
  {
    id: 'flip',
    label: 'Flip',
    loop: false,
    keys: [
      { t: 0, pose: P([0, 180, 0]), ease: 'spring' },
      { t: 0.65, pose: P([0, 0, 0]), ease: 'linear' },
      { t: 1, pose: P([0, 0, 0]) },
    ],
  },
];

/**
 * Replace a device track's keyframes with a motion preset. Rotations come
 * from the preset; its movement is added to the device's own position and
 * its zoom scales the device. `start` / `span` (seconds) place the motion
 * within the timeline, e.g. to stagger several devices. `reach` scales the
 * movement (e.g. with the camera zoomed out, so off-screen starts stay off-screen).
 */
export function applyPreset(track, presetId, basePose, { start = 0, span = track.duration, reach = 1 } = {}) {
  const preset = MOTION_PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  const base = devicePose(basePose);
  track.keyframes = preset.keys.map((k) => ({
    id: newId(),
    t: Math.round((start + k.t * span) * track.fps) / track.fps,
    pose: devicePose({
      rot: k.pose.rot,
      pos: [base.pos[0] + (k.pose.pos?.[0] || 0) * reach, base.pos[1] + (k.pose.pos?.[1] || 0) * reach, base.pos[2]],
      scale: base.scale * (k.pose.zoom ?? 1),
    }),
    ease: k.ease || 'easeInOut',
  }));
  return preset;
}
