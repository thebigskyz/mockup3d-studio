// State (persisted per browser): defaults, upgrading older settings, and
// the animation.

import { FINISHES } from '../devices.js';
import { ENVIRONMENTS } from '../environments.js';
import { CAMERA, devicePose, cameraPose, reviveAnim, migrateLegacyAnim } from '../timeline.js';
import { $ } from './util.js';

export const DEFAULT_OUTPUT = {
  format: 'png',
  frame: 'viewport',
  scale: 2,        // PNG in Viewport frame: multiple of the viewer size
  size: 1080,      // otherwise: pixels on the short side
  bg: 'transparent',
  c1: '#0e0f1a',
  c2: '#5b3fd1',
  angle: 145,
  quality: 'standard',
  grain: 'light',   // MP4 dithering (anti-banding noise): 'off' | 'light' | 'medium' | 'strong'
  trim: false,     // crop a transparent PNG to the devices
  focus: 1,        // HDRI background sharpness (1 = sharpest)
  aa: 4,           // export supersampling: 1 = off, 2 = 2×, 4 = 4× (smoothest)
  cw: 1920,        // custom canvas width / height in pixels
  ch: 1080,
};

export const MAX_DEVICES = 12;

/**
 * A device in the scene. Each has its own model, look, design (in memory,
 * see `insts`) and pose; `pose` is used when its track has no keyframes.
 */
const DEVICE_DEFAULTS = { model: 'iphone-18-pro', orientation: 'portrait', finish: 'black', customColor: '#7a5cff', island: true, logo: true, castShadow: true };
// Models no longer bundled, and the one that takes their place in saved
// settings and projects.
const RETIRED_MODELS = { 'iphone-18-pro-max': 'iphone-18-pro', 'ipad-pro-13': 'ipad-pro-11' };
export const newDeviceId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export function makeDevice(fields = {}) {
  const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
  const d = { ...DEVICE_DEFAULTS, ...given, id: given.id || newDeviceId(), pose: devicePose(given.pose) };
  d.model = RETIRED_MODELS[d.model] || d.model;
  d.finish = validFinish(d.finish);
  return d;
}

export const DEFAULT_ENV = 'studio-panels';

/**
 * Shadow under or behind the devices (see setShadow in js/scene.js): mode
 * 'off' | 'floor' | 'backdrop', its colour, strength and softness 0–1, distance from
 * the devices in scene units, offset 0–1 (how far the shadow shifts away
 * from the devices: 0 = straight behind or under them) and the light's
 * angle in degrees as seen through the camera (0 = from above, negative =
 * from the left).
 */
export const DEFAULT_SHADOW = { mode: 'off', color: '#000000', strength: 0.3, softness: 0.5, distance: 0.4, offset: 0.5, angle: -35 };
export const validShadow = (sh) => {
  const v = { ...DEFAULT_SHADOW, ...(sh && typeof sh === 'object' ? sh : {}) };
  if (!['off', 'floor', 'backdrop'].includes(v.mode)) v.mode = 'off';
  if (!/^#[0-9a-f]{6}$/i.test(v.color)) v.color = DEFAULT_SHADOW.color;
  for (const k of ['strength', 'softness', 'distance', 'offset', 'angle']) if (!Number.isFinite(v[k])) v[k] = DEFAULT_SHADOW[k];
  return v;
};

export function freshDefaults() {
  return {
    devices: [makeDevice({ id: 'd1', pose: { rot: [0, -20, 0] } })],
    selected: 'd1',
    camera: cameraPose(),
    // Metres per scene unit (positions, camera distance). Fixed per scene so
    // swapping or deleting a device doesn't rescale the layout; a one-device
    // scene follows its device. null: not known yet (follow the largest).
    unit: null,
    glare: 0.01,
    reflZoom: 0.33,  // glass reflection magnification (1 = as with the default lens)
    light: 0.7,
    viewerBg: 'checker',
    autoKey: true,
    bottomH: 220,
    bottomTab: 'timeline',
    motionTarget: 'one', // motion presets apply to the selected device ('one') or all of them
    mirror: false, // motion presets, angles and templates are flipped left to right
    output: { ...DEFAULT_OUTPUT },
    env: DEFAULT_ENV,
    // The studio look new scenes start with: softboxes turned a little,
    // slightly cool, softer highlights and punchier contrast.
    envRot: 35,
    envTemp: 7000,
    envHighlights: 0.28, // 0–1: how much the HDRI's brightest spots are tamed (shown as 72%)
    envContrast: 1.5,    // lighting contrast, 1 = unchanged
    shadow: { ...DEFAULT_SHADOW },
    customDevices: [], // imported models: { id, label, fix, screen, hidden }
  };
}

export const FRAMES = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1], '4:5': [4, 5] };
export const CANVAS_MIN = 16;
export const CANVAS_MAX = 8192;

/** Aspect ratio of the output frame as [w, h], or null to fill the viewer. */
export function frameRatio() {
  const o = state.output;
  if (o.frame === 'custom') return [o.cw, o.ch];
  return FRAMES[o.frame] || null;
}

// Settings from versions with a single device kept its fields at the top level.
const LEGACY_KEYS = ['device', 'orientation', 'finish', 'customColor', 'island', 'pose', 'rot', 'zoom', 'fov'];

/**
 * Bring saved settings (s) and animation (a) up to date. Older versions had
 * one device, with its zoom and lens in the same keyframes as its angle.
 */
export function upgradeSettings(s = {}, a) {
  s = { ...s };
  if (!Array.isArray(s.devices)) {
    const pose = s.pose || (s.rot ? { rot: s.rot, pos: [0, 0], zoom: s.zoom, fov: s.fov } : { rot: [0, -20, 0] });
    const id = 'd1';
    s.devices = [makeDevice({
      id, model: s.device, orientation: s.orientation, finish: s.finish, customColor: s.customColor, island: s.island,
      pose: { rot: pose.rot, pos: pose.pos },
    })];
    s.selected = id;
    const m = migrateLegacyAnim(a, id);
    s.camera = cameraPose(m.camera || pose);
    a = m.anim;
  }
  for (const k of LEGACY_KEYS) delete s[k];
  // HDRIs that are no longer bundled fall back to the default.
  if (s.env && s.env !== 'custom' && !ENVIRONMENTS.some((e) => e.id === s.env)) {
    s.env = DEFAULT_ENV; // a removed HDRI: its rotation meant nothing for this one
    s.envRot = 0;
  }
  return { s, a };
}

export function sanitizeDevices(list) {
  const out = (Array.isArray(list) ? list : []).filter(Boolean).slice(0, MAX_DEVICES).map((d) => makeDevice(d));
  return out.length ? out : [makeDevice({ id: 'd1' })];
}

export const STORE_KEY = 'device-mockups:v1';
export const state = loadState();
export let anim = state.anim;

// The selected device's fields, as if there were one device (non-enumerable,
// so they're never saved twice).
export const recOf = (id) => state.devices.find((d) => d.id === id) || null;
export const selRec = () => recOf(state.selected) || state.devices[0];
for (const [key, field] of [['device', 'model'], ['orientation', 'orientation'], ['finish', 'finish'], ['customColor', 'customColor'], ['island', 'island'], ['logo', 'logo'], ['castShadow', 'castShadow'], ['pose', 'pose']]) {
  Object.defineProperty(state, key, {
    get: () => selRec()[field],
    set: (v) => { selRec()[field] = v; },
    enumerable: false,
    configurable: true,
  });
}

export function validUnit(u) {
  return Number.isFinite(u) && u > 0 ? u : null;
}

function loadState() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    /* ignore */
  }
  const up = upgradeSettings(saved, saved.anim);
  const s = { ...freshDefaults(), ...up.s };
  s.devices = sanitizeDevices(s.devices);
  if (!s.devices.some((d) => d.id === s.selected)) s.selected = s.devices[0].id;
  s.camera = cameraPose(s.camera);
  s.unit = validUnit(s.unit);
  s.output = { ...DEFAULT_OUTPUT, ...(saved.output || {}) };
  s.shadow = validShadow(s.shadow);
  if (s.bottomTab === 'layouts') s.bottomTab = 'templates'; // Layouts were replaced by Templates
  s.anim = reviveAnim(up.a);
  pruneTracks(s.anim, s.devices);
  return s;
}
/** Finishes that were removed (e.g. Burgundy) fall back to Black. */
function validFinish(id) {
  return id === 'custom' || FINISHES.some((f) => f.id === id) ? id : 'black';
}
/** Drop keyframe tracks of devices that are no longer in the scene. */
export function pruneTracks(a = anim, devices = state.devices) {
  for (const id of Object.keys(a.tracks)) {
    if (id !== CAMERA && !devices.some((d) => d.id === id)) delete a.tracks[id];
  }
}

export const out = () => state.output;
/** Replace the animation (undo / redo, opening a project). */
export function setAnim(a) {
  anim = a;
}
