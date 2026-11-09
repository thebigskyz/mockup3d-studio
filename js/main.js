import { createScene } from './scene.js';
import { DEVICES, FINISHES, loadDevice, fitTexture } from './devices.js';
import { loadMedia, placeholderTexture } from './media.js';
import { renderPNG, download } from './exporter.js';
import { renderMP4, mp4Supported } from './video-export.js';
import { openFrameSource } from './video-frames.js';
import { easeCss } from './easing.js';
import {
  DEFAULT_POSE, CAMERA, devicePose, cameraPose, createAnim, reviveAnim, migrateLegacyAnim, trackView,
  evaluate, hasKeys, anyKeys, anyAnimated, allKeysView, keyAt, setKey, removeKey, setDuration,
  prevKeyTime, nextKeyTime, snapTime, MOTION_PRESETS, applyPreset, FPS_PRESETS, clampFps,
} from './timeline.js';
import { createTimelineUI } from './timeline-ui.js';
import { TEMPLATES } from './templates.js';
import { isModelFile, importModelFile, loadCustomDevice, deleteModel, getModelBuffer, storeModel, setRenderer as setModelRenderer } from './custom-devices.js';
import { isProjectFile, packProject, unpackProject, writeProjectFile, pickProjectFile, canWriteFiles, PROJECT_EXT } from './project.js';
import * as THREE from 'three';
import { ENVIRONMENTS, loadEnvironment, loadEnvironmentFile, isHDRFile, kelvinTint, NEUTRAL_KELVIN } from './environments.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------------------
// State (persisted per browser)
// ---------------------------------------------------------------------------
const DEFAULT_OUTPUT = {
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

const MAX_DEVICES = 12;

/**
 * A device in the scene. Each has its own model, look, design (in memory,
 * see `insts`) and pose; `pose` is used when its track has no keyframes.
 */
const DEVICE_DEFAULTS = { model: 'iphone-18-pro', orientation: 'portrait', finish: 'black', customColor: '#7a5cff', island: true, logo: true, castShadow: true };
// Models no longer bundled, and the one that takes their place in saved
// settings and projects.
const RETIRED_MODELS = { 'iphone-18-pro-max': 'iphone-18-pro', 'ipad-pro-13': 'ipad-pro-11' };
const newDeviceId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function makeDevice(fields = {}) {
  const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));
  const d = { ...DEVICE_DEFAULTS, ...given, id: given.id || newDeviceId(), pose: devicePose(given.pose) };
  d.model = RETIRED_MODELS[d.model] || d.model;
  d.finish = validFinish(d.finish);
  return d;
}

const DEFAULT_ENV = 'studio-panels';

/**
 * Shadow under or behind the devices (see setShadow in js/scene.js): mode
 * 'off' | 'floor' | 'backdrop', its colour, strength and softness 0–1, distance from
 * the devices in scene units, offset 0–1 (how far the shadow shifts away
 * from the devices: 0 = straight behind or under them) and the light's
 * angle in degrees as seen through the camera (0 = from above, negative =
 * from the left).
 */
const DEFAULT_SHADOW = { mode: 'off', color: '#000000', strength: 0.3, softness: 0.5, distance: 0.4, offset: 0.5, angle: -35 };
const validShadow = (sh) => {
  const v = { ...DEFAULT_SHADOW, ...(sh && typeof sh === 'object' ? sh : {}) };
  if (!['off', 'floor', 'backdrop'].includes(v.mode)) v.mode = 'off';
  if (!/^#[0-9a-f]{6}$/i.test(v.color)) v.color = DEFAULT_SHADOW.color;
  for (const k of ['strength', 'softness', 'distance', 'offset', 'angle']) if (!Number.isFinite(v[k])) v[k] = DEFAULT_SHADOW[k];
  return v;
};

function freshDefaults() {
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

const ANGLE_PRESETS = [
  { label: 'Front', rot: [0, 0, 0] },
  { label: 'Left', rot: [0, -30, 0] },
  { label: 'Right', rot: [0, 30, 0] },
  { label: 'Hero', rot: [10, -28, -6] },
  { label: 'Lean back', rot: [-28, 0, 0] },
  { label: 'Tabletop', rot: [-62, 0, 28] },
  // Lying flat, top pointing away to the right, seen from 35.3° above (true isometric).
  { label: 'Isometric', rot: [-54.7, 0, -45] },
  { label: 'Float', rot: [18, 22, 10] },
  { label: 'Side', rot: [0, -82, 0] },
  { label: 'Back', rot: [0, 180, 0] },
];

const FRAMES = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1], '4:5': [4, 5] };
const CANVAS_MIN = 16;
const CANVAS_MAX = 8192;

/** Aspect ratio of the output frame as [w, h], or null to fill the viewer. */
function frameRatio() {
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
function upgradeSettings(s = {}, a) {
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

function sanitizeDevices(list) {
  const out = (Array.isArray(list) ? list : []).filter(Boolean).slice(0, MAX_DEVICES).map((d) => makeDevice(d));
  return out.length ? out : [makeDevice({ id: 'd1' })];
}

const STORE_KEY = 'device-mockups:v1';
/** Devices selected besides the main one (state.selected); see setSelection. */
const multi = new Set();
/** Nothing selected (the Inspector still shows the last device); see deselect. */
let deselected = false;
const state = loadState();
let anim = state.anim;

// The selected device's fields, as if there were one device (non-enumerable,
// so they're never saved twice).
const recOf = (id) => state.devices.find((d) => d.id === id) || null;
const selRec = () => recOf(state.selected) || state.devices[0];
for (const [key, field] of [['device', 'model'], ['orientation', 'orientation'], ['finish', 'finish'], ['customColor', 'customColor'], ['island', 'island'], ['logo', 'logo'], ['castShadow', 'castShadow'], ['pose', 'pose']]) {
  Object.defineProperty(state, key, {
    get: () => selRec()[field],
    set: (v) => { selRec()[field] = v; },
    enumerable: false,
    configurable: true,
  });
}

function validUnit(u) {
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
function pruneTracks(a = anim, devices = state.devices) {
  for (const id of Object.keys(a.tracks)) {
    if (id !== CAMERA && !devices.some((d) => d.id === id)) delete a.tracks[id];
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  recordHistory();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, anim: animJSON() }));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

// ---------------------------------------------------------------------------
// Undo / redo. Every saved change is a step; rapid changes (dragging a
// slider, scrubbing a value) are grouped because saving is debounced.
// ---------------------------------------------------------------------------
// View-only settings that shouldn't be undone.
const NOT_UNDOABLE = ['anim', 'selected', 'motionTarget', 'bottomH', 'bottomTab', 'viewerBg', 'autoKey', 'customDevices'];
const HISTORY_LIMIT = 150;
const history = { undo: [], redo: [], last: null };
let restoring = false;

// The open project file (if any) and whether it has unsaved changes.
const project = { name: 'Untitled', handle: null, dirty: false };
let customHdri = null; // { name, blob } of a loaded .exr / .hdr, for saving

/** The animation as plain data (no ids, no empty tracks). */
function animJSON() {
  const tracks = {};
  for (const [id, keys] of Object.entries(anim.tracks)) {
    if (keys.length) tracks[id] = keys.map((k) => ({ t: k.t, pose: k.pose, ease: k.ease }));
  }
  return { duration: anim.duration, fps: anim.fps, loop: anim.loop, tracks };
}

function snapshot() {
  const s = { ...state };
  for (const k of NOT_UNDOABLE) delete s[k];
  return JSON.stringify({ s, a: animJSON() });
}

function recordHistory() {
  if (restoring) return;
  const snap = snapshot();
  if (history.last === null) history.last = snap;
  if (snap === history.last) return;
  history.undo.push(history.last);
  markDirty();
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  history.last = snap;
  syncUndoButtons();
}

const HISTORY_LABELS = {
  pose: 'angle', a: 'animation', model: 'device', orientation: 'orientation', finish: 'finish',
  customColor: 'colour', glare: 'glare', reflZoom: 'reflection zoom', light: 'intensity', island: 'Dynamic Island', logo: 'logo', castShadow: 'device shadow', camera: 'camera',
  env: 'environment', envRot: 'environment rotation', envTemp: 'colour temperature', envHighlights: 'highlights', envContrast: 'contrast', shadow: 'shadow', output: 'output settings',
};

/** Name of what differs between two snapshots, for the status bar. */
function describeChange(fromSnap, toSnap) {
  const a = JSON.parse(fromSnap);
  const b = JSON.parse(toSnap);
  const na = a.s.devices?.length ?? 1;
  const nb = b.s.devices?.length ?? 1;
  // A template changes the devices, camera and output together.
  if (JSON.stringify(a.s.output) !== JSON.stringify(b.s.output) && JSON.stringify(a.s.devices) !== JSON.stringify(b.s.devices)) return 'template';
  if (na !== nb) return nb > na ? 'add device' : 'delete device';
  if (JSON.stringify(a.a) !== JSON.stringify(b.a)) return HISTORY_LABELS.a;
  const key = Object.keys(b.s).find((k) => JSON.stringify(a.s[k]) !== JSON.stringify(b.s[k]));
  if (key === 'devices') {
    const da = a.s.devices || [];
    const db = b.s.devices || [];
    for (let i = 0; i < db.length; i++) {
      const f = Object.keys(db[i]).find((k) => JSON.stringify(da[i][k]) !== JSON.stringify(db[i][k]));
      if (f) return HISTORY_LABELS[f] || 'device';
    }
  }
  return HISTORY_LABELS[key] || 'change';
}

function undo() {
  if (saveTimer) save(); // record a pending change first
  if (!history.undo.length) return setStatus('Nothing to undo');
  const current = history.last;
  const prev = history.undo.pop();
  history.redo.push(current);
  restore(prev);
  setStatus(`Undo ${describeChange(prev, current)}`);
}

function redo() {
  if (saveTimer) save();
  if (!history.redo.length) return setStatus('Nothing to redo');
  const current = history.last;
  const next = history.redo.pop();
  history.undo.push(current);
  restore(next);
  setStatus(`Redo ${describeChange(current, next)}`);
}

/** Apply saved settings (an undo snapshot, or a project's settings). */
function restore(snap) {
  const parsed = JSON.parse(snap);
  const { s, a } = upgradeSettings(parsed.s, parsed.a);
  const prevEnv = state.env;
  restoring = true;
  try {
    Object.assign(state, s);
    state.devices = sanitizeDevices(s.devices);
    if (!recOf(state.selected)) state.selected = state.devices[0].id;
    state.camera = cameraPose(s.camera);
    state.unit = validUnit(s.unit);
    ctx.setUnit(state.unit);
    state.output = { ...DEFAULT_OUTPUT, ...s.output };
    state.shadow = validShadow(s.shadow);
    anim = reviveAnim(a);
    pruneTracks();
    playhead = Math.min(playhead, anim.duration);
    history.last = snap;

    syncInstances();
    // A custom HDRI can't be reloaded from a snapshot; keep whatever is lit.
    if (state.env !== prevEnv && state.env !== 'custom') setEnv(state.env);
    ctx.setEnvRotation(state.envRot);
    ctx.setReflectionZoom(state.reflZoom);
    ctx.setEnvTint(kelvinTint(state.envTemp));
    applyEnvAdjust();
    ctx.setShadow(state.shadow);
    timelineUI.select(null);
    applyAll();
    applyBackground();
    layoutFrame();
    refreshPose();
    syncSelection();
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, anim: animJSON() }));
  } catch (err) {
    console.error(err);
  } finally {
    restoring = false;
  }
  syncUndoButtons();
}

function syncUndoButtons() {
  const u = $('undoBtn');
  const r = $('redoBtn');
  if (!u || !r) return;
  u.disabled = !history.undo.length;
  r.disabled = !history.redo.length;
}

// ---------------------------------------------------------------------------
// Scene: one instance per device (its loaded model, design and live pose)
// ---------------------------------------------------------------------------
const ctx = createScene($('stage'));
setModelRenderer(ctx.renderer);
ctx.setUnit(state.unit);
/** device id -> { device (loaded model), model (its id), media, placeholder, token, live (pose on screen) } */
const insts = new Map();
const trashedMedia = new Map(); // designs of deleted devices, back if the delete is undone

let playhead = 0;
let playing = false;
let liveCam = cameraPose(state.camera); // camera on screen right now
let exporting = false;

function instOf(id) {
  let it = insts.get(id);
  if (!it) {
    it = { id, device: null, model: null, media: trashedMedia.get(id) || null, placeholder: null, token: 0, live: devicePose(recOf(id)?.pose) };
    trashedMedia.delete(id);
    insts.set(id, it);
    ctx.addSlot(id);
  }
  return it;
}
/** The selected device's instance. */
const sel = () => instOf(selRec().id);

const isLandscape = (rec) => rec?.orientation === 'landscape';
const landscape = () => isLandscape(selRec());
const customRec = (id = state.device) => state.customDevices.find((d) => d.id === id) || null;
/** Device description for the UI: a built-in, or an imported model. */
function deviceDesc(id) {
  const b = DEVICES.find((d) => d.id === id);
  if (b) return b;
  const c = customRec(id);
  return c ? { id: c.id, label: c.label, kind: 'custom', island: false, px: null } : null;
}
const currentDevice = () => deviceDesc(state.device) || DEVICES[0];
const out = () => state.output;

/** Name shown for a device in the scene, e.g. "iPhone 18 Pro 2". */
function deviceName(rec) {
  const label = deviceDesc(rec.model)?.label || 'Device';
  const same = state.devices.filter((d) => (deviceDesc(d.model)?.label || 'Device') === label);
  return same.length > 1 ? `${label} ${same.indexOf(rec) + 1}` : label;
}

function finishOf(rec) {
  if (rec.finish === 'custom') {
    return { label: 'Custom', frame: rec.customColor, back: rec.customColor, accent: shade(rec.customColor, 0.45) };
  }
  return FINISHES.find((f) => f.id === rec.finish) || FINISHES[0];
}
const currentFinish = () => finishOf(selRec());

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Match the instances to state.devices: add, remove and (re)load models. */
function syncInstances() {
  for (const id of [...insts.keys()]) if (!recOf(id)) disposeInst(id);
  const loads = [];
  for (const rec of state.devices) {
    const it = instOf(rec.id);
    if (it.model !== rec.model) loads.push(loadModel(rec.id));
  }
  showOutline();
  return Promise.all(loads);
}

function disposeInst(id) {
  const it = insts.get(id);
  if (!it) return;
  it.token++; // ignore a model still loading
  // Keep its design in case the device comes back (undo / redo).
  if (it.media) {
    it.media.video?.pause();
    disposeMedia(trashedMedia.get(id));
    trashedMedia.set(id, it.media);
  }
  it.placeholder?.texture.dispose();
  ctx.removeSlot(id);
  insts.delete(id);
}

let loadingCount = 0;
function setLoading(delta) {
  loadingCount = Math.max(0, loadingCount + delta);
  $('loading').classList.toggle('on', loadingCount > 0);
}

/** Load (or reload) a device's model into its slot. */
async function loadModel(id) {
  const rec = recOf(id);
  if (!rec) return;
  const it = instOf(id);
  const model = rec.model;
  it.model = model;
  const token = ++it.token;
  setLoading(1);
  setStatus('Loading model…', 'busy');
  const crec = customRec(model);
  let d;
  try {
    if (!crec && !DEVICES.some((x) => x.id === model)) throw new Error('unknown device');
    d = crec ? await loadCustomDevice(crec) : await loadDevice(model);
  } catch (err) {
    console.error(err);
    setLoading(-1);
    if (token !== it.token || !recOf(id)) return;
    if (crec || !DEVICES.some((x) => x.id === model)) {
      setStatus(crec ? err.message : 'That device isn’t available any more.', 'err');
      rec.model = DEVICES[0].id;
      syncControls();
      renderSceneList();
      if (model !== DEVICES[0].id) await loadModel(id);
    } else {
      setStatus('Could not load the model. Run the app with python3 serve.py.', 'err');
    }
    return;
  }
  setLoading(-1);
  const wasLoading = $('status').textContent === 'Loading model…';
  if (token !== it.token || !insts.has(id)) return; // removed or changed meanwhile
  it.device = d;
  ctx.setSlotModel(id, d.root, d.radius);
  // Scene unit: a lone device fills the frame whatever its model (as with a
  // single device before). With several, the unit stays put, so swapping a
  // model doesn't move the rest of the composition; scenes saved before the
  // unit was stored take the largest device once every model has loaded.
  if (state.devices.length === 1) state.unit = d.radius;
  else if (state.unit == null && state.devices.every((r) => insts.get(r.id)?.device && insts.get(r.id).model === r.model)) {
    state.unit = ctx.maxRadius;
  }
  ctx.setUnit(state.unit);
  applyDevice(id);
  if (id === state.selected) {
    syncModelSetup();
    syncControls();
  }
  if (!loadingCount && wasLoading) setStatus();
}

function applyScreen(id = state.selected) {
  const it = insts.get(id);
  const rec = recOf(id);
  if (!it?.device || !rec) return;
  const land = isLandscape(rec);
  let m = it.media;
  if (!m) {
    if (!it.placeholder || it.placeholder.landscape !== land) {
      it.placeholder?.texture.dispose();
      it.placeholder = { ...placeholderTexture(ctx.renderer, land), landscape: land };
    }
    m = it.placeholder;
  }
  if (!it.device.info) return; // imported model without a screen picked yet
  fitTexture(m.texture, m.width, m.height, it.device.info, land);
  it.device.screenMaterial.map = m.texture;
  it.device.screenMaterial.needsUpdate = true;
}

/** Apply a device's look, orientation, pose and design. */
function applyDevice(id) {
  const it = insts.get(id);
  const rec = recOf(id);
  if (!it?.device || !rec) return;
  it.device.setFinish(finishOf(rec));
  it.device.setGlare(state.glare);
  it.device.setIsland(rec.island);
  it.device.setLogo?.(rec.logo !== false);
  ctx.setSlotShadow(id, rec.castShadow !== false);
  ctx.setSlotLandscape(id, isLandscape(rec));
  ctx.setSlotPose(id, it.live);
  applyScreen(id);
}

function applyAll() {
  for (const rec of state.devices) applyDevice(rec.id);
  ctx.setLight(state.light);
  applyCamera(liveCam);
}

// ---------------------------------------------------------------------------
// Pose & animation. Each device has a track, and so does the camera.
// ---------------------------------------------------------------------------
const trackOf = (id) => trackView(anim, id);

/** Show a device pose without recording it. */
function applyPose(pose, id = state.selected) {
  const it = instOf(id);
  it.live = devicePose(pose);
  ctx.setSlotPose(id, it.live);
  if (id === state.selected) syncPoseUI();
}

/** Show a camera without recording it. */
function applyCamera(c) {
  liveCam = cameraPose(c);
  ctx.setCamera(liveCam);
  syncCameraUI();
}

/** A device's pose at time t: its animation, or its static pose. */
function poseAt(id, t) {
  const tr = trackOf(id);
  return hasKeys(tr) ? evaluate(tr, t) : devicePose(recOf(id)?.pose);
}
function cameraAt(t) {
  const tr = trackOf(CAMERA);
  return hasKeys(tr) ? evaluate(tr, t) : cameraPose(state.camera);
}

function refreshPose() {
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

function commitPose(pose, id = state.selected) {
  recordOnTrack(id, devicePose(pose));
  applyPose(pose, id);
  syncTransport();
  saveSoon();
}

function commitCamera(c) {
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
function alignDevice(where) {
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

function editPose(fn) {
  const p = devicePose(sel().live);
  fn(p);
  commitPose(p);
}
function editCamera(fn) {
  const c = cameraPose(liveCam);
  fn(c);
  commitCamera(c);
}

function setTime(t, { seekVideo = true } = {}) {
  playhead = clamp(t, 0, anim.duration);
  refreshPose();
  if (seekVideo) syncVideo(true);
  timelineUI.updatePlayhead();
  syncTransport();
}

/** K: add or remove a keyframe at the playhead on a device's (or the camera's) track. */
function toggleKeyAtPlayhead(id = state.selected) {
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

function play(on = !playing) {
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

// ---------------------------------------------------------------------------
// Designs (the dropped image / video on each device) — videos follow the timeline
// ---------------------------------------------------------------------------
const video = (id = state.selected) => insts.get(id)?.media?.video || null;
const videos = () => [...insts.values()].map((it) => it.media?.video).filter(Boolean);

function syncVideo(force) {
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
function seekVideoExact(t, id = state.selected) {
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
const seekVideosExact = (t) => Promise.all(state.devices.map((d) => seekVideoExact(t, d.id)));

/**
 * Put a design on a device (the selected one unless `target` is given).
 * Project files, HDRIs and models dropped in are opened instead.
 */
async function useFile(file, { fromProject = false, target = state.selected } = {}) {
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
function syncClip() {
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

function mediaThumb(m) {
  const el = document.createElement(m.video ? 'video' : 'img');
  el.src = m.url;
  if (m.video) Object.assign(el, { muted: true, loop: true, autoplay: true, playsInline: true });
  return el;
}

function emptyTrash() {
  for (const m of trashedMedia.values()) disposeMedia(m);
  trashedMedia.clear();
}

function disposeMedia(m) {
  if (!m) return;
  m.video?.pause();
  m.texture.dispose();
  URL.revokeObjectURL(m.url);
}

function clearMedia(update = true, id = state.selected) {
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
async function useDesign(file) {
  const recs = selectedRecs();
  const isDesign = file && (/^(image|video)\//.test(file.type) || /\.(png|jpe?g|webp|gif|heic|mp4|mov|m4v|webm)$/i.test(file.name));
  if (recs.length < 2 || !isDesign) return useFile(file);
  for (const rec of recs) await useFile(file, { target: rec.id });
  setStatus(`Put ${file.name} on ${recs.length} devices`);
}
window.addEventListener('paste', (e) => {
  if (isTypingTarget(e.target)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
  if (item) {
    useDesign(item.getAsFile());
    return;
  }
  const clip = parseKeyClipboard(e.clipboardData?.getData('text/plain'));
  if (clip) {
    e.preventDefault();
    pasteKeyframes(clip);
  }
});

// ---------------------------------------------------------------------------
// Copy / paste keyframes (⌘C / ⌘V). The copy goes onto the system clipboard
// as text too, so keyframes can be pasted into another project or tab.
// Device keyframes paste onto the selected device; camera keyframes onto the
// camera.
// ---------------------------------------------------------------------------
const KEY_CLIP = 'mockup-studio/keyframes';
const isTypingTarget = (el) => !!el?.matches?.('input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, [contenteditable]');

/** Keyframes to copy: the selection, or the selected device's keyframe at the playhead. */
function keysToCopy() {
  let track = timelineUI.selectedTrack;
  let ids = timelineUI.selectedIds;
  if (!ids.length) {
    track = state.selected;
    const k = keyAt(trackOf(track), playhead);
    if (k) ids = [k.id];
  }
  const keys = trackOf(track).keyframes.filter((k) => ids.includes(k.id));
  if (!keys.length) return null;
  const t0 = keys[0].t;
  return {
    kind: track === CAMERA ? 'camera' : 'device',
    keys: keys.map((k) => ({ dt: +(k.t - t0).toFixed(6), pose: k.pose, ease: k.ease })),
  };
}

function parseKeyClipboard(text) {
  if (!text || !text.includes(KEY_CLIP)) return null;
  try {
    const data = JSON.parse(text);
    if (data.type !== KEY_CLIP || !Array.isArray(data.keys) || !data.keys.length) return null;
    // Keyframes copied before cameras had their own track hold zoom/fov in the device pose.
    const kind = data.kind === 'camera' ? 'camera' : 'device';
    return { kind, keys: data.keys };
  } catch {
    return null;
  }
}

window.addEventListener('copy', (e) => {
  if (isTypingTarget(e.target) || window.getSelection()?.toString()) return;
  const clip = keysToCopy();
  if (!clip) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', JSON.stringify({ type: KEY_CLIP, ...clip }));
  const n = clip.keys.length;
  setStatus(`Copied ${n} ${clip.kind === 'camera' ? 'camera ' : ''}keyframe${n === 1 ? '' : 's'} — move the playhead and press ⌘V to paste`);
});

/** Paste keyframes starting at the playhead, keeping their spacing. */
function pasteKeyframes({ kind, keys }) {
  if (playing) play(false);
  const id = kind === 'camera' ? CAMERA : state.selected;
  const tr = trackOf(id);
  const norm = kind === 'camera' ? cameraPose : devicePose;
  if (!hasKeys(tr)) {
    if (kind === 'camera') state.camera = cameraPose(liveCam);
    else selRec().pose = devicePose(sel().live);
  }
  const start = playhead;
  const ids = [];
  let clipped = 0;
  for (const k of keys) {
    const t = start + k.dt;
    if (t > anim.duration + 1e-6) { clipped++; continue; }
    ids.push(setKey(tr, t, norm(k.pose), k.ease).id);
  }
  timelineUI.render();
  timelineUI.select(ids, id);
  refreshPose();
  syncTransport();
  save();
  const onto = kind === 'camera' ? ' on the camera' : state.devices.length > 1 ? ` on ${deviceName(selRec())}` : '';
  setStatus(`Pasted ${ids.length} keyframe${ids.length === 1 ? '' : 's'} at ${start.toFixed(2)}s${onto}`
    + (clipped ? ` · ${clipped} didn’t fit before the end of the timeline` : ''));
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

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function timecode(t, fps = anim.fps) {
  const f = Math.floor((t % 1) * fps + 1e-6);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return [h, m, s, f].map((x) => String(x).padStart(2, '0')).join(':');
}

$('playBtn').addEventListener('click', () => play());
$('toStart').addEventListener('click', () => setTime(0));
$('toEnd').addEventListener('click', () => setTime(anim.duration));
$('prevKey').addEventListener('click', () => setTime(prevKeyTime(allKeysView(anim), playhead)));
$('nextKey').addEventListener('click', () => setTime(nextKeyTime(allKeysView(anim), playhead)));
$('loopBtn').addEventListener('click', () => {
  anim.loop = !anim.loop;
  syncTransport();
  save();
});
function setFps(f) {
  anim.fps = clampFps(f);
  setTime(snapTime(anim, playhead));
  timelineUI.render();
  syncControls();
  save();
}
$('fpsSelect').addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    // Swap the menu for a number field until a value is entered.
    e.target.hidden = true;
    const input = $('fpsCustom');
    input.hidden = false;
    input.value = anim.fps;
    input.focus();
    input.select();
    return;
  }
  setFps(+e.target.value);
});
function closeFpsCustom(commit) {
  const input = $('fpsCustom');
  if (input.hidden) return;
  if (commit && +input.value > 0) setFps(+input.value);
  input.hidden = true;
  $('fpsSelect').hidden = false;
  syncTransport();
}
$('fpsCustom').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') closeFpsCustom(true);
  if (e.key === 'Escape') closeFpsCustom(false);
});
$('fpsCustom').addEventListener('blur', () => closeFpsCustom(true));

function syncTransport() {
  $('timeLabel').textContent = timecode(playhead);
  $('playBtn').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('loopBtn').classList.toggle('on', anim.loop);
  // Frame-rate menu: presets, the current custom rate (if any), then Custom…
  const sel = $('fpsSelect');
  const rates = FPS_PRESETS.includes(anim.fps) ? FPS_PRESETS : [...FPS_PRESETS, anim.fps].sort((a, b) => a - b);
  const sig = rates.join(',');
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = rates.map((r) => `<option value="${r}">${r}${FPS_PRESETS.includes(r) ? '' : ' (custom)'}</option>`).join('')
      + '<option value="custom">Custom…</option>';
    sel.dataset.sig = sig;
  }
  sel.value = String(anim.fps);
  const k = keyAt(trackOf(state.selected), playhead);
  const ck = keyAt(trackOf(CAMERA), playhead);
  for (const [id, on] of [['keyBtn', k], ['camKeyBtn', ck]]) {
    $(id).classList.toggle('on', !!on);
    $(id).querySelector('use').setAttribute('href', on ? '#i-key' : '#i-key-o');
  }
  $('keyState').textContent = anyKeys(anim) ? (k ? '◆ Keyframe' : 'Animated') : '';
  timelineUI.updatePlayhead();
}

// FPS readout in the status bar.
let frames = 0;
let fpsT0 = performance.now();
ctx.onBeforeRender((now) => {
  frames++;
  if (now - fpsT0 > 1000) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsT0))} fps`;
    frames = 0;
    fpsT0 = now;
  }
});

// ---------------------------------------------------------------------------
// Viewer: drag to rotate, scroll to zoom the canvas, Space-drag to pan
// ---------------------------------------------------------------------------
const vp = $('viewport');
let drag = null;
let panDrag = null;
let orbitDrag = null; // Option-drag: turning the camera
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
// Space: hold and drag to pan the canvas; a quick tap still plays / pauses.
const space = { held: false, panned: false };

/** Normalised device coordinates of a point in the viewer. */
function ndcAt(clientX, clientY) {
  const r = $('stage').getBoundingClientRect();
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}
/** The device under a point in the viewer, or null. */
const deviceAt = (clientX, clientY) => ctx.pickSlot(ndcAt(clientX, clientY));

vp.addEventListener('pointerdown', (e) => {
  if (exporting || e.target.closest('.progress')) return;
  // Space + drag, or the middle button: pan the canvas.
  if (e.button === 1 || (e.button === 0 && space.held && !pickMode)) {
    e.preventDefault();
    if (space.held) space.panned = true;
    panDrag = { x: e.clientX, y: e.clientY, pan: [...canvasView.pan] };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;
  if (pickMode) {
    handlePick(e);
    return;
  }
  // Option (Alt) + drag: orbit the camera around the scene.
  if (e.altKey) {
    anim2++;
    if (playing) play(false);
    orbitDrag = { x: e.clientX, y: e.clientY, cam: cameraPose(liveCam), moved: false };
    vp.setPointerCapture(e.pointerId);
    vp.classList.add('orbiting');
    return;
  }
  // Clicking a device selects it; dragging then turns it (Shift: moves it).
  // ⌘-click (Ctrl-click) or Shift-click a device to add it to the selection,
  // or take it out, as in the Scene list. Clicking empty space deselects;
  // dragging there turns the selected device. A lone device still turns when
  // dragged from anywhere, selected or not.
  const many = state.devices.length > 1;
  const hit = deviceAt(e.clientX, e.clientY);
  if (hit && many && (e.metaKey || e.ctrlKey)) {
    toggleSelected(hit);
    return;
  }
  // Shift: a click toggles the device in the selection, a drag moves it, so
  // wait to see which (see pointermove and endDrag).
  const pending = hit && many && e.shiftKey ? hit : null;
  if (hit && !pending) selectSceneDevice(hit);
  else if (!hit && many && deselected) return; // nothing selected to turn
  anim2++; // cancel a running angle-preset animation
  if (playing) play(false);
  const live = (pending ? instOf(pending) : sel()).live;
  drag = { x: e.clientX, y: e.clientY, rot: [...live.rot], pos: [...live.pos], move: e.shiftKey, moved: false, empty: !hit, pending };
  vp.setPointerCapture(e.pointerId);
  vp.classList.add(e.shiftKey ? 'moving' : 'dragging');
});
vp.addEventListener('pointermove', (e) => {
  if (panDrag) {
    canvasView.pan = [panDrag.pan[0] + e.clientX - panDrag.x, panDrag.pan[1] + e.clientY - panDrag.y];
    applyCanvasView();
    return;
  }
  if (orbitDrag) {
    const c = cameraPose(orbitDrag.cam);
    const k = 0.35; // degrees per pixel, as when turning a device
    // Turning the camera one way looks like turning the scene the other, so
    // the scene follows the pointer as it does when dragging a device.
    c.orbit[0] = wrapDeg(orbitDrag.cam.orbit[0] - (e.clientX - orbitDrag.x) * k);
    c.orbit[1] = clamp(orbitDrag.cam.orbit[1] + (e.clientY - orbitDrag.y) * k, -90, 90);
    orbitDrag.moved = true;
    applyCamera(c);
    syncCameraUI();
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
  if (!drag.moved) return;
  if (drag.pending) {
    // A Shift-drag: move just this device.
    selectSceneDevice(drag.pending);
    drag.pending = null;
  }
  const p = devicePose(sel().live);
  if (drag.move) {
    // Move across the screen, keeping the device's distance from the camera.
    const r = $('stage').getBoundingClientRect();
    p.pos = ctx.screenMove(drag.pos, (2 * dx) / r.width, (-2 * dy) / r.height);
  } else {
    const k = 0.35;
    p.rot[1] = drag.rot[1] + dx * k;
    p.rot[0] = drag.rot[0] + dy * k;
  }
  applyPose(p);
});
const endDrag = () => {
  if (panDrag) {
    panDrag = null;
    vp.classList.remove('panning');
    return;
  }
  if (orbitDrag) {
    const { moved } = orbitDrag;
    orbitDrag = null;
    vp.classList.remove('orbiting');
    if (moved) {
      commitCamera(liveCam);
      setStatus(`Camera orbit ${Math.round(liveCam.orbit[0])}° · elevation ${Math.round(liveCam.orbit[1])}°`);
    }
    return;
  }
  if (!drag) return;
  const { moved, empty, pending } = drag;
  drag = null;
  vp.classList.remove('dragging', 'moving');
  if (moved) commitPose(sel().live);
  else if (pending) toggleSelected(pending);
  else if (empty) deselect();
};
vp.addEventListener('pointerup', endDrag);
vp.addEventListener('pointercancel', endDrag);
// Scroll (or pinch) zooms the canvas around the pointer. The camera's own
// zoom is the Inspector's Camera → Zoom.
vp.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (exporting) return;
  const speed = e.ctrlKey ? 0.01 : 0.0015; // pinch gestures arrive as ctrl+wheel
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  zoomCanvasTo(canvasView.z * Math.exp(-dy * speed), e.clientX, e.clientY);
}, { passive: false });

$('fitBtn').addEventListener('click', () => fitCanvas());

// ---------------------------------------------------------------------------
// Canvas zoom: scales how the frame is shown (not the export). z is relative
// to "Fit"; the percentage shown is relative to the export's real pixels
// when a fixed frame size is set.
// ---------------------------------------------------------------------------
const canvasView = { z: 1, pan: [0, 0] };
let fitBox = { left: 0, top: 0, w: 1, h: 1 };
const ZOOM_STEPS = [5, 10, 25, 50, 75, 100, 150, 200, 300, 400, 800, 1600];

/** Displayed size relative to the output pixels (Viewport frame: relative to fit). */
function percentPerZ() {
  if (!frameRatio()) return 100;
  const [ow] = outputSize();
  return (fitBox.w / ow) * 100;
}
const zoomPercent = () => canvasView.z * percentPerZ();

function applyCanvasView() {
  const fr = $('frame');
  const { z, pan } = canvasView;
  const identity = Math.abs(z - 1) < 1e-4 && !pan[0] && !pan[1];
  fr.style.transform = identity ? '' : `translate(${pan[0]}px, ${pan[1]}px) scale(${z})`;
  $('frameLabel').style.transform = identity ? '' : `scale(${1 / z})`;
  ctx.setDisplayScale(z);
  $('zoomBtn').textContent = `${Math.round(zoomPercent())}%`;
}

/** Zoom to z (relative to fit), keeping the point under (cx, cy) still. */
function zoomCanvasTo(z, cx, cy) {
  const minZ = 5 / percentPerZ();
  const maxZ = 1600 / percentPerZ();
  z = clamp(z, Math.min(minZ, 1), Math.max(maxZ, 1));
  const r = vp.getBoundingClientRect();
  const px = (cx ?? r.left + r.width / 2) - r.left;
  const py = (cy ?? r.top + r.height / 2) - r.top;
  const fcx = fitBox.left + fitBox.w / 2;
  const fcy = fitBox.top + fitBox.h / 2;
  const k = z / canvasView.z;
  const ccx = fcx + canvasView.pan[0];
  const ccy = fcy + canvasView.pan[1];
  canvasView.pan = [px - (px - ccx) * k - fcx, py - (py - ccy) * k - fcy];
  canvasView.z = z;
  applyCanvasView();
}

function setZoomPercent(pct) {
  if (!(pct > 0)) return;
  zoomCanvasTo(pct / percentPerZ());
}

function fitCanvas() {
  canvasView.z = 1;
  canvasView.pan = [0, 0];
  applyCanvasView();
}

/** ⌘+ / ⌘−: step through the zoom presets. */
function stepZoom(dir) {
  const cur = zoomPercent();
  const next = dir > 0
    ? ZOOM_STEPS.find((p) => p > cur + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    : [...ZOOM_STEPS].reverse().find((p) => p < cur - 0.5) ?? ZOOM_STEPS[0];
  setZoomPercent(next);
}

function buildZoomControl() {
  const menu = $('zoomMenu');
  $('zoomBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) $('zoomCustom').value = Math.round(zoomPercent());
  });
  $('zoomIn').addEventListener('click', () => stepZoom(1));
  $('zoomOut').addEventListener('click', () => stepZoom(-1));
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-z]');
    if (!b) return;
    menu.hidden = true;
    if (b.dataset.z === 'fit') fitCanvas();
    else setZoomPercent(+b.dataset.z);
  });
  const custom = $('zoomCustom');
  custom.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      setZoomPercent(clamp(+custom.value, 5, 1600));
      menu.hidden = true;
    }
    if (e.key === 'Escape') menu.hidden = true;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.zoom-ctl')) menu.hidden = true;
  });
}

for (const b of $('bgSeg').children) {
  b.addEventListener('click', () => {
    state.viewerBg = b.dataset.v;
    save();
    syncControls();
  });
}

/** Size the viewer's frame to the output aspect ratio (or fill the viewer). */
function layoutFrame() {
  const fr = $('frame');
  const W = vp.clientWidth;
  const H = vp.clientHeight;
  const ratio = frameRatio();
  if (!ratio) {
    Object.assign(fr.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
    fitBox = { left: 0, top: 0, w: W, h: H };
    fr.classList.remove('framed');
  } else {
    const a = ratio[0] / ratio[1];
    const pad = 22;
    let w = W - 2 * pad;
    let h = w / a;
    if (h > H - 2 * pad) {
      h = H - 2 * pad;
      w = h * a;
    }
    Object.assign(fr.style, {
      left: `${Math.round((W - w) / 2)}px`, top: `${Math.round((H - h) / 2)}px`,
      width: `${Math.round(w)}px`, height: `${Math.round(h)}px`,
    });
    fitBox = { left: Math.round((W - w) / 2), top: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h) };
    fr.classList.add('framed');
  }
  syncExportSize();
  applyCanvasView();
}
new ResizeObserver(layoutFrame).observe(vp);

// ---------------------------------------------------------------------------
// Parameters (Inspector values: slider + draggable "hot text")
// ---------------------------------------------------------------------------
// Lens as a full-frame-equivalent focal length, for a friendlier readout.
const lensMM = (fovDeg) => 12 / Math.tan((fovDeg * Math.PI) / 360);
const fovFromMM = (mm) => (360 / Math.PI) * Math.atan(12 / mm);

const rotParam = (i) => ({
  get: () => sel().live.rot[i],
  set: (v) => editPose((p) => { p.rot[i] = v; }),
  fmt: (v) => `${Math.round(v)}°`,
  step: 1,
  unbounded: true, // rotations can go past ±180 (e.g. a 360° spin)
  slider: (v) => wrap180(v),
});

const PARAMS = {
  rotX: rotParam(0),
  rotY: rotParam(1),
  rotZ: rotParam(2),
  posX: { get: () => sel().live.pos[0], set: (v) => editPose((p) => { p.pos[0] = v; }), fmt: (v) => v.toFixed(2), step: 0.01, unbounded: true },
  posY: { get: () => sel().live.pos[1], set: (v) => editPose((p) => { p.pos[1] = v; }), fmt: (v) => v.toFixed(2), step: 0.01, unbounded: true },
  posZ: { get: () => sel().live.pos[2], set: (v) => editPose((p) => { p.pos[2] = v; }), fmt: (v) => v.toFixed(2), step: 0.01 },
  scale: {
    get: () => sel().live.scale,
    set: (v) => editPose((p) => { p.scale = v; }),
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
  },
  fov: {
    get: () => liveCam.fov,
    set: (v) => editCamera((c) => { c.fov = v; }),
    fmt: (v) => `${Math.round(lensMM(v))} mm`,
    step: 0.25,
    invert: true, // dragging right = longer lens = smaller field of view
    parse: (s) => fovFromMM(parseFloat(s)),
  },
  zoom: {
    get: () => liveCam.zoom,
    set: (v) => editCamera((c) => { c.zoom = v; }),
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
    // 10% to 1000%; the slider is a log scale, so 100% is in its middle and
    // each half doubles or halves at the same rate.
    min: 0.1,
    max: 10,
    slider: (v) => Math.log2(v),
    fromSlider: (s) => 2 ** s,
  },
  panX: { get: () => liveCam.pan[0], set: (v) => editCamera((c) => { c.pan[0] = v; }), fmt: (v) => v.toFixed(2), step: 0.01, unbounded: true },
  panY: { get: () => liveCam.pan[1], set: (v) => editCamera((c) => { c.pan[1] = v; }), fmt: (v) => v.toFixed(2), step: 0.01, unbounded: true },
  shadowStrength: { get: () => state.shadow.strength, set: (v) => { state.shadow.strength = v; applyShadow(); saveSoon(); }, fmt: (v) => `${Math.round(v * 100)}%`, step: 0.01, parse: (s) => parseFloat(s) / 100 },
  shadowSoftness: { get: () => state.shadow.softness, set: (v) => { state.shadow.softness = v; applyShadow(); saveSoon(); }, fmt: (v) => `${Math.round(v * 100)}%`, step: 0.01, parse: (s) => parseFloat(s) / 100 },
  shadowDistance: { get: () => state.shadow.distance, set: (v) => { state.shadow.distance = v; applyShadow(); saveSoon(); }, fmt: (v) => v.toFixed(2), step: 0.01 },
  shadowOffset: { get: () => state.shadow.offset, set: (v) => { state.shadow.offset = v; applyShadow(); saveSoon(); }, fmt: (v) => `${Math.round(v * 100)}%`, step: 0.01, parse: (s) => parseFloat(s) / 100 },
  shadowAngle: { get: () => state.shadow.angle, set: (v) => { state.shadow.angle = v; applyShadow(); saveSoon(); }, fmt: (v) => `${Math.round(v)}°`, step: 1 },
  camOrbit: { get: () => liveCam.orbit[0], set: (v) => editCamera((c) => { c.orbit[0] = v; }), fmt: (v) => `${Math.round(v)}°`, step: 1, unbounded: true },
  camElev: { get: () => liveCam.orbit[1], set: (v) => editCamera((c) => { c.orbit[1] = v; }), fmt: (v) => `${Math.round(v)}°`, step: 1 },
  camRoll: { get: () => liveCam.orbit[2], set: (v) => editCamera((c) => { c.orbit[2] = v; }), fmt: (v) => `${Math.round(v)}°`, step: 1, unbounded: true },
  glare: {
    get: () => state.glare,
    set: (v) => { state.glare = v; for (const it of insts.values()) it.device?.setGlare(v); saveSoon(); },
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.005,
    parse: (s) => parseFloat(s) / 100,
  },
  reflZoom: {
    get: () => state.reflZoom,
    set: (v) => { state.reflZoom = clamp(v, 0.25, 4); ctx.setReflectionZoom(state.reflZoom); saveSoon(); },
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
  },
  envRot: {
    get: () => state.envRot,
    set: (v) => { state.envRot = Math.round(((v % 360) + 360) % 360); ctx.setEnvRotation(state.envRot); saveSoon(); },
    fmt: (v) => `${Math.round(v)}°`,
    step: 1,
    unbounded: true,
  },
  envTemp: {
    get: () => state.envTemp,
    set: (v) => { state.envTemp = Math.round(v / 50) * 50; applyEnvTint(); saveSoon(); },
    fmt: (v) => `${Math.round(v)} K`,
    step: 25,
  },
  // Shown as how bright the highlights stay (100% = untouched, 0% = fully
  // tamed); stored as how much they're tamed, so saved settings still work.
  envHighlights: {
    get: () => 1 - state.envHighlights,
    set: (v) => { state.envHighlights = clamp(1 - v, 0, 1); applyEnvAdjust(); saveSoon(); },
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
  },
  envContrast: {
    get: () => state.envContrast,
    set: (v) => { state.envContrast = v; applyEnvAdjust(); saveSoon(); },
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
  },
  bgFocus: {
    get: () => out().focus,
    set: (v) => { out().focus = v; applyBackground(); saveSoon(); },
    fmt: (v) => `${Math.round(v * 100)}%`,
    step: 0.01,
    parse: (s) => parseFloat(s) / 100,
  },
  light: { get: () => state.light, set: (v) => { state.light = v; ctx.setLight(v); saveSoon(); }, fmt: (v) => v.toFixed(2), step: 0.01 },
  duration: {
    get: () => anim.duration,
    set: (v) => {
      setDuration(anim, Math.round(v * 100) / 100);
      setTime(Math.min(playhead, anim.duration));
      timelineUI.render();
      syncExportSize();
      saveSoon();
    },
    fmt: (v) => `${v.toFixed(2)}s`,
    step: 0.05,
    min: 0.5,
    max: 60,
  },
  bgAngle: {
    get: () => out().angle,
    set: (v) => { out().angle = Math.round(((v % 360) + 360) % 360); applyBackground(); saveSoon(); },
    fmt: (v) => `${Math.round(v)}°`,
    step: 1,
    unbounded: true,
  },
};

function setParam(id, v) {
  const p = PARAMS[id];
  const input = $(id);
  if (!p.unbounded) {
    const lo = p.min ?? (input ? +input.min : -Infinity);
    const hi = p.max ?? (input ? +input.max : Infinity);
    v = clamp(v, lo, hi);
  }
  p.set(v);
  syncParam(id);
}

function syncParam(id) {
  const p = PARAMS[id];
  const v = p.get();
  const input = $(id);
  if (input) {
    const sv = p.slider ? p.slider(v) : v;
    input.value = sv;
    const pct = ((sv - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', `${clamp(pct, 0, 100)}%`);
  }
  const outEl = $(id + 'v');
  if (outEl && !outEl.isEditing) outEl.textContent = p.fmt(v);
}

function syncPoseUI() {
  for (const id of ['rotX', 'rotY', 'rotZ', 'posX', 'posY', 'posZ', 'scale']) syncParam(id);
  syncAnglePresetsActive();
}
function applyShadow() {
  ctx.setShadow(state.shadow);
  syncShadowHint();
}
/** A floor seen from dead level is edge-on: say how to see its shadow. */
function syncShadowHint() {
  const flat = state.shadow.mode === 'floor' && Math.abs(liveCam.orbit[1]) < 4;
  $('shadowHint').textContent = flat ? 'The camera looks level with the floor, so its shadow is hidden. Raise Camera › Elevation (or Option-drag down) to see it.' : '';
}
function syncCameraUI() {
  syncShadowHint();
  for (const id of ['fov', 'zoom', 'panX', 'panY', 'camOrbit', 'camElev', 'camRoll']) syncParam(id);
  $('viewerInfo').textContent = `Perspective · ${Math.round(lensMM(liveCam.fov))} mm`;
}

/**
 * After Effects-style "hot text": drag left/right to scrub the value
 * (Shift = 10x faster, Alt = 10x finer), click to type a value.
 */
function makeHot(el, id) {
  const p = PARAMS[id];
  let start = null;
  el.classList.add('hot');
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    start = { x: e.clientX, v: p.get(), moved: false };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    if (Math.abs(dx) > 2) start.moved = true;
    if (!start.moved) return;
    el.classList.add('scrubbing');
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    setParam(id, start.v + dx * p.step * mult * (p.invert ? -1 : 1));
  });
  el.addEventListener('pointerup', () => {
    if (!start) return;
    const clicked = !start.moved;
    start = null;
    el.classList.remove('scrubbing');
    if (clicked) editHot(el, id);
  });
}

function editHot(el, id) {
  const p = PARAMS[id];
  const input = document.createElement('input');
  input.className = 'hot-edit';
  input.value = p.fmt(p.get()).replace(/[^\d.\-]/g, '');
  el.isEditing = true;
  el.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (commit) => {
    // Enter removes the input, which fires blur: only finish once.
    if (finished || !input.isConnected) return;
    finished = true;
    const v = p.parse ? p.parse(input.value) : parseFloat(input.value);
    // Put the value label back first: applying the value can update other
    // parts of the UI that look the label up (e.g. the duration readout).
    el.isEditing = false;
    input.replaceWith(el);
    try {
      if (commit && isFinite(v)) setParam(id, v);
    } finally {
      syncParam(id);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => done(true));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function buildControls() {
  // Scene devices + model picker
  $('addDevice').addEventListener('click', () => addDevice());
  renderSceneList();
  renderDeviceList();
  $('modelInput').addEventListener('change', (e) => {
    importDevice(e.target.files[0]);
    e.target.value = '';
  });
  buildModelSetup();

  // Orientation
  for (const b of $('orientSeg').children) {
    b.addEventListener('click', () => {
      for (const rec of targets()) {
        rec.orientation = b.dataset.v;
        applyDevice(rec.id);
      }
      save();
      renderSceneList();
      syncControls();
    });
  }

  // Finishes
  const sw = $('swatches');
  for (const f of FINISHES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = f.label;
    b.dataset.v = f.id;
    b.style.background = `radial-gradient(circle at 35% 30%, ${f.back}, ${f.frame} 60%, ${f.accent})`;
    b.addEventListener('click', () => setFinish(f.id));
    sw.appendChild(b);
  }
  const custom = document.createElement('label');
  custom.className = 'swatch swatch-custom';
  custom.title = 'Custom colour';
  custom.dataset.v = 'custom';
  custom.innerHTML = '<input type="color">';
  const picker = custom.querySelector('input');
  picker.value = state.customColor;
  picker.addEventListener('input', () => {
    for (const rec of targets()) rec.customColor = picker.value;
    setFinish('custom');
  });
  sw.appendChild(custom);

  // Angle presets with a little CSS-3D device showing each angle.
  for (const p of ANGLE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = `<div class="p-stage"><div class="mini"><div class="face front"></div><div class="face back"></div></div></div><span>${p.label}</span>`;
    b.querySelector('.mini').style.transform = cssRotation(p.rot);
    b.addEventListener('click', () => animateTo(p.rot));
    b._rot = p.rot;
    $('presets').appendChild(b);
  }

  buildMotionPresets();

  for (const b of document.querySelectorAll('#alignRow [data-align]')) {
    b.addEventListener('click', () => alignDevice(b.dataset.align));
  }

  $('resetRot').addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle the section
    animateTo([0, 0, 0]);
  });
  $('keyBtn').addEventListener('click', (e) => {
    e.preventDefault(); // don't toggle the section
    toggleKeyAtPlayhead();
  });
  $('camKeyBtn').addEventListener('click', (e) => {
    e.preventDefault();
    toggleKeyAtPlayhead(CAMERA);
  });
  $('fitAllBtn').addEventListener('click', (e) => {
    e.preventDefault();
    frameAll();
  });
  $('autoKey').addEventListener('click', () => {
    state.autoKey = !state.autoKey;
    warnedAutoKey = false;
    syncControls();
    save();
  });
  $('clearAnim').addEventListener('click', () => {
    if (!anyKeys(anim)) return;
    // Keep what's on screen as each device's (and the camera's) static pose.
    for (const rec of state.devices) rec.pose = devicePose(instOf(rec.id).live);
    state.camera = cameraPose(liveCam);
    anim.tracks = {};
    timelineUI.select(null);
    timelineUI.render();
    refreshPose();
    syncTransport();
    save();
    setStatus('Animation cleared');
  });

  // Sliders + scrubbable values
  for (const id of Object.keys(PARAMS)) {
    if ($(id)) $(id).addEventListener('input', (e) => setParam(id, PARAMS[id].fromSlider ? PARAMS[id].fromSlider(+e.target.value) : +e.target.value));
    if ($(id + 'v')) makeHot($(id + 'v'), id);
  }

  $('island').addEventListener('change', (e) => {
    for (const rec of targets()) {
      rec.island = e.target.checked;
      insts.get(rec.id)?.device?.setIsland(rec.island);
    }
    save();
  });
  $('logo').addEventListener('change', (e) => {
    for (const rec of targets()) {
      rec.logo = e.target.checked;
      insts.get(rec.id)?.device?.setLogo?.(rec.logo);
    }
    save();
  });
  $('castShadow').addEventListener('change', (e) => {
    for (const rec of targets()) {
      rec.castShadow = e.target.checked;
      ctx.setSlotShadow(rec.id, rec.castShadow);
    }
    renderSceneList();
    save();
  });
  $('selectAll').addEventListener('click', () => selectAll());

  // Bottom panel tabs + resize
  for (const b of $('bottomTabs').children) {
    b.addEventListener('click', () => {
      state.bottomTab = b.dataset.tab;
      save();
      syncControls();
    });
  }
  $('bottomResize').addEventListener('pointerdown', (e) => {
    const startY = e.clientY;
    const startH = state.bottomH;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      state.bottomH = clamp(startH - (ev.clientY - startY), 150, 480);
      $('app').style.setProperty('--bottom-h', `${state.bottomH}px`);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });

  // Output
  const seg = (id, fn) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      fn(b.dataset.v);
      applyBackground();
      layoutFrame();
      syncControls();
      save();
    });
  };
  seg('formatSeg', (v) => {
    out().format = v;
    if (v === 'mp4' && out().bg === 'transparent') out().bg = 'solid';
  });
  seg('frameSeg', (v) => {
    // Switching to Custom starts from the current output size.
    if (v === 'custom' && out().frame !== 'custom') {
      const [w, h] = outputSize();
      out().cw = clamp(w, CANVAS_MIN, CANVAS_MAX);
      out().ch = clamp(h, CANVAS_MIN, CANVAS_MAX);
    }
    out().frame = v;
  });

  // Custom canvas: type a width / height (arrow keys step by 1, Shift by 10).
  for (const [id, key] of [['canvasW', 'cw'], ['canvasH', 'ch']]) {
    const el = $(id);
    el.addEventListener('input', () => {
      const v = Math.round(+el.value);
      if (!(v >= CANVAS_MIN && v <= CANVAS_MAX)) return; // wait for a valid number
      out()[key] = v;
      layoutFrame();
      syncCanvasLabel();
      saveSoon();
    });
    el.addEventListener('change', () => {
      out()[key] = clamp(Math.round(+el.value) || out()[key], CANVAS_MIN, CANVAS_MAX);
      el.value = out()[key];
      layoutFrame();
      syncCanvasLabel();
      save();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        el.value = clamp(out()[key] + step, CANVAS_MIN, CANVAS_MAX);
        el.dispatchEvent(new Event('input'));
      }
    });
  }
  $('swapDims').addEventListener('click', () => {
    [out().cw, out().ch] = [out().ch, out().cw];
    layoutFrame();
    syncControls();
    save();
  });
  seg('sizeSeg', (v) => {
    if (out().format === 'png' && out().frame === 'viewport') out().scale = +v;
    else out().size = +v;
  });
  seg('bgModeSeg', (v) => {
    if (v === 'transparent' && out().format === 'mp4') {
      setStatus('MP4 can’t be transparent — use PNG for a transparent background.', 'busy');
      return;
    }
    out().bg = v;
  });
  seg('qualitySeg', (v) => { out().quality = v; });
  seg('shadowSeg', (v) => { state.shadow.mode = v; applyShadow(); renderSceneList(); });
  seg('grainSeg', (v) => { out().grain = v; });
  seg('aaSeg', (v) => { out().aa = +v; });
  $('shadowColor').addEventListener('input', (e) => {
    state.shadow.color = e.target.value;
    applyShadow();
    syncControls();
    saveSoon();
  });
  // Double-click the swatch to go back to black.
  $('shadowColor').parentElement.addEventListener('dblclick', (e) => {
    e.preventDefault();
    state.shadow.color = DEFAULT_SHADOW.color;
    applyShadow();
    syncControls();
    save();
  });
  for (const id of ['bgC1', 'bgC2']) {
    $(id).addEventListener('input', (e) => {
      out()[id === 'bgC1' ? 'c1' : 'c2'] = e.target.value;
      applyBackground();
      syncControls();
      saveSoon();
    });
  }
  $('trim').addEventListener('change', (e) => {
    out().trim = e.target.checked;
    save();
    syncControls();
  });

  $('exportBtn').addEventListener('click', doExport);
}

// three.js XYZ Euler (y up) -> CSS transform (y down).
function cssRotation([x, y, z]) {
  return `rotateX(${-x}deg) rotateY(${y}deg) rotateZ(${-z}deg)`;
}
function cssPose(p) {
  return `translate(${p.pos[0] * 18}px, ${-p.pos[1] * 18}px) ${cssRotation(p.rot)} scale(${p.scale})`;
}

/** Motion preset cards: hover to preview the motion on a mini device. */
function buildMotionPresets() {
  let css = '';
  for (const preset of MOTION_PRESETS) {
    const tr = trackView(createAnim(), 'preview');
    applyPreset(tr, preset.id, DEFAULT_POSE);
    const steps = tr.keyframes.map((k) => {
      const pct = (k.t / tr.duration) * 100;
      return `${pct.toFixed(1)}% { transform: ${cssPose(k.pose)}; animation-timing-function: ${easeCss(k.ease)}; }`;
    });
    css += `@keyframes mp-${preset.id} { ${steps.join(' ')} }\n`;

    const b = document.createElement('button');
    b.className = 'preset motion';
    b.innerHTML = `<div class="p-stage"><div class="mini" style="animation-name: mp-${preset.id}"><div class="face front"></div><div class="face back"></div></div></div>
      <span>${preset.label}</span><em>${preset.loop ? 'Loop' : 'One-shot'}</em>`;
    b.addEventListener('click', () => applyMotion(preset));
    $('motionPresets').appendChild(b);
  }
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  for (const b of $('motionTarget').querySelectorAll('button[data-v]')) {
    b.addEventListener('click', () => {
      state.motionTarget = b.dataset.v;
      save();
      syncControls();
    });
  }
}

/**
 * Apply a motion preset to the selected device, or to every device. One-shot
 * motions on several devices start one after another.
 */
function applyMotion(preset) {
  const all = state.motionTarget === 'all' && state.devices.length > 1;
  const targets = all ? state.devices : [selRec()];
  const n = targets.length;
  const stagger = all && !preset.loop;
  const span = stagger ? anim.duration * 0.7 : anim.duration;
  targets.forEach((rec, i) => {
    const start = stagger ? (anim.duration - span) * (i / (n - 1)) : 0;
    applyPreset(trackOf(rec.id), preset.id, instOf(rec.id).live, { start, span, reach: Math.max(1, 1 / liveCam.zoom) });
  });
  anim.loop = preset.loop;
  timelineUI.select(null);
  timelineUI.render();
  setTime(0);
  play(true);
  save();
  const keys = trackOf(targets[0].id).keyframes.length;
  setStatus(all
    ? `${preset.label} applied to ${n} devices${stagger ? ', one after another' : ''}`
    : `${preset.label} applied — ${keys} keyframes over ${anim.duration.toFixed(1)}s`);
}

/** Camera → Frame all: zoom and pan so every device is in view. */
function frameAll() {
  const fit = ctx.fitAll();
  commitCamera({ ...liveCam, zoom: fit.zoom, pan: fit.pan });
  save();
  setStatus('Framed all devices');
}

// ---------------------------------------------------------------------------
// Templates: complete starting scenes (see js/templates.js)
// ---------------------------------------------------------------------------
/**
 * Where a template's camera ends up, in scene units, worked out as
 * applyTemplate and ctx.fitAll do: a set zoom and pan, or framed on the
 * devices' boxes (seen from the camera's angle) and zoomed by `tight`.
 */
function templateCamera(t, aspect, size) {
  const DEG = Math.PI / 180;
  const vfov = t.camera.fov * DEG;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const fitHalf = Math.min(vfov, hfov) / 2;
  const base = 1.08 / Math.sin(fitHalf); // camera distance at zoom 1
  const [orbit, elev, roll] = t.camera.orbit;
  if (t.camera.zoom > 0) return { zoom: t.camera.zoom, pan: t.camera.pan || [0, 0], base, vfov };
  const toCam = new THREE.Quaternion().setFromEuler(new THREE.Euler(-elev * DEG, orbit * DEG, roll * DEG, 'YXZ')).invert();
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const d of t.devices) {
    const [w, h] = size(d);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(d.rot[0] * DEG, d.rot[1] * DEG, d.rot[2] * DEG));
    const sc = d.scale ?? 1;
    for (let i = 0; i < 8; i++) {
      v.set(((i & 1) - 0.5) * w * sc, (((i >> 1) & 1) - 0.5) * h * sc, (((i >> 2) & 1) - 0.5) * 0.11 * sc)
        .applyQuaternion(q).add(new THREE.Vector3(...d.pos)).applyQuaternion(toCam);
      box.expandByPoint(v);
    }
  }
  const c = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const need = Math.max(sz.x / 2 / Math.tan(hfov / 2), sz.y / 2 / Math.tan(vfov / 2)) * 1.1 + box.max.z;
  return { zoom: (base / need) * (t.camera.tight || 1), pan: [c.x, c.y], base, vfov };
}

function buildTemplatePresets() {
  for (const t of TEMPLATES) {
    const b = document.createElement('button');
    b.className = 'preset template';
    b.title = `${t.label}: ${t.devices.length} device${t.devices.length > 1 ? 's' : ''}`;
    const bg = t.bg.mode === 'gradient' ? `linear-gradient(${t.bg.angle}deg, ${t.bg.c1}, ${t.bg.c2})` : t.bg.c1;
    // A preview of the devices as CSS cards, framed as the canvas frames
    // them: the same camera angle, lens, zoom and pan, cropped to the frame.
    const big = t.devices.some((d) => d.model === 'ipad-pro-11');
    const size = (d) => {
      const tab = d.model === 'ipad-pro-11';
      const w = tab ? 1.16 : big ? 0.47 : 0.86;
      const h = tab ? 1.63 : big ? 0.98 : 1.8;
      return d.orientation === 'landscape' ? [h, w] : [w, h];
    };
    const ratio = t.frame.split(':').map(Number);
    const aspect = ratio[0] / ratio[1];
    const fw = Math.round(Math.min(104, 72 * aspect));
    const fh = Math.round(fw / aspect);
    const cam = templateCamera(t, aspect, size);
    const dist = cam.base / cam.zoom; // camera to the pan point, in units
    const k = fh / 2 / (dist * Math.tan(cam.vfov / 2)); // px per unit at that distance
    const cards = t.devices.map((d) => {
      const [w, h] = size(d);
      return `<div class="t-dev ${t.finish}" style="width:${w * k}px;height:${h * k}px;margin:${(-h * k) / 2}px 0 0 ${(-w * k) / 2}px;transform: translate3d(${d.pos[0] * k}px, ${-d.pos[1] * k}px, ${d.pos[2] * k}px) ${cssRotation(d.rot)} scale(${d.scale})"></div>`;
    }).join('');
    // The world as the camera sees it: moved by the pan (across and up the
    // view), after the inverse of the camera's turn (orbit, elevation, roll)
    // in CSS axes (y points down, so X and Z rotations change sign; see
    // cssRotation). The perspective is the camera's distance.
    const [orbit, elev, roll] = t.camera.orbit;
    b.innerHTML = `<div class="t-box"><div class="t-frame" style="width:${fw}px;height:${fh}px;background:${bg};perspective:${(dist * k).toFixed(1)}px">
      <div class="t-world" style="transform: translate(${(-cam.pan[0] * k).toFixed(2)}px, ${(cam.pan[1] * k).toFixed(2)}px) rotateZ(${roll}deg) rotateX(${-elev}deg) rotateY(${-orbit}deg)">${cards}</div></div></div><span>${t.label}</span>`;
    b.addEventListener('click', () => applyTemplate(t));
    $('templatePresets').appendChild(b);
  }
}

/**
 * Replace the scene with a template: its devices, poses, finish, camera,
 * frame, background and shadow. Existing devices are reused in order and keep their
 * designs; any without one show the scene's designs in turn, so a grid of
 * phones fills up from one screenshot. Keyframes are cleared. One undo step.
 */
async function applyTemplate(t) {
  if (playing) play(false);
  setPickMode(null);
  multi.clear();
  const old = state.devices;
  const designs = old.map((d) => insts.get(d.id)?.media?.file).filter(Boolean);
  state.devices = t.devices.slice(0, MAX_DEVICES).map((d, i) => {
    const rec = old[i] || makeDevice({});
    rec.model = d.model;
    rec.orientation = d.orientation || 'portrait';
    rec.finish = t.finish;
    rec.island = true;
    rec.castShadow = d.castShadow !== false;
    rec.pose = devicePose(d);
    return rec;
  });
  state.selected = state.devices[0].id;
  anim.tracks = {};
  timelineUI.select(null);
  setStatus(`Loading ${t.label}…`, 'busy');
  await syncInstances();
  // Positions are in units of the template's largest device.
  state.unit = ctx.maxRadius || state.unit;
  ctx.setUnit(state.unit);
  for (const rec of state.devices) {
    instOf(rec.id).live = devicePose(rec.pose);
    applyDevice(rec.id);
  }
  // Frame and background.
  const o = out();
  if (FRAMES[t.frame]) o.frame = t.frame;
  else {
    const [a, b] = t.frame.split(':').map(Number);
    const short = o.size || 1080;
    o.frame = 'custom';
    o.cw = Math.round(a >= b ? (short * a) / b : short);
    o.ch = Math.round(a >= b ? short : (short * b) / a);
  }
  Object.assign(o, { bg: t.bg.mode, c1: t.bg.c1, c2: t.bg.c2, angle: t.bg.angle });
  // Lighting turned so the studio's softboxes aren't mirrored straight back
  // off screens that face the camera.
  if (Number.isFinite(t.envRot)) setParam('envRot', t.envRot);
  state.shadow = validShadow({ ...DEFAULT_SHADOW, ...(t.shadow || { mode: 'off' }) });
  applyShadow();
  layoutFrame();
  ctx.resize(); // the frame's new shape, before framing the shot
  applyBackground();
  // Camera: the template's angle and lens, then framed on the devices.
  const cam = cameraPose({ fov: t.camera.fov, zoom: 1, pan: [0, 0], orbit: t.camera.orbit });
  applyCamera(cam);
  refreshPose();
  if (t.camera.zoom > 0) {
    // A set framing (e.g. a grid that runs off every edge).
    cam.zoom = t.camera.zoom;
    cam.pan = [...(t.camera.pan || [0, 0])];
  } else {
    const fit = ctx.fitAll();
    cam.zoom = fit.zoom * (t.camera.tight || 1);
    cam.pan = fit.pan;
  }
  state.camera = cameraPose(cam);
  refreshPose();
  // Devices without a design show the scene's designs in turn.
  if (designs.length) {
    let k = 0;
    for (const rec of state.devices) {
      if (!insts.get(rec.id)?.media) await useFile(designs[k++ % designs.length], { fromProject: true, target: rec.id });
    }
  }
  syncSelection();
  renderSceneList();
  timelineUI.render();
  syncTransport();
  syncControls();
  save();
  setStatus(`${t.label} · ${state.devices.length} device${state.devices.length > 1 ? 's' : ''}${designs.length ? '' : ' · drop a design on each'} · ⌘Z to undo`);
}

// ---------------------------------------------------------------------------
// Scene list: the devices in the scene
// ---------------------------------------------------------------------------
function selectSceneDevice(id) {
  if (!recOf(id) || (id === state.selected && !deselected && !multi.size)) return;
  setPickMode(null);
  multi.clear();
  state.selected = id;
  syncSelection();
  saveSoon();
}

// Several devices can be selected at once (⌘-click, Shift-click, ⌘A):
// `state.selected` is the main one (the Inspector and Transform show it) and
// `multi` (declared with the state) holds the others. Model, orientation,
// finish, Dynamic Island, logo, shadow, a new design and Delete then apply to all of
// them. Not saved or undone.
/** The selected devices, in scene order (none while deselected). */
function selectedRecs() {
  if (deselected) return [];
  return state.devices.filter((d) => d.id === state.selected || multi.has(d.id));
}
/** The devices a change applies to: the selection, or the main device. */
const targets = () => (selectedRecs().length ? selectedRecs() : [selRec()]);

/** Select exactly `ids`, with `primary` as the main one. */
function setSelection(ids, primary = ids[0]) {
  const keep = ids.filter((id) => recOf(id));
  if (!keep.length) return;
  setPickMode(null);
  state.selected = keep.includes(primary) ? primary : keep[0];
  multi.clear();
  for (const id of keep) if (id !== state.selected) multi.add(id);
  syncSelection();
  saveSoon();
  if (keep.length > 1) setStatus(`${keep.length} devices selected · Model, Orientation, Finish, Dynamic Island, Logo, Shadow, a new design and Delete change them all`);
}
/** ⌘-click: add a device to the selection, or take it out. */
function toggleSelected(id) {
  const ids = selectedRecs().map((d) => d.id);
  if (ids.includes(id)) {
    if (ids.length > 1) setSelection(ids.filter((x) => x !== id), state.selected === id ? undefined : state.selected);
  } else {
    setSelection([...ids, id], id);
  }
}
/** Shift-click: select every device from the main one to this one. */
function selectRange(id) {
  const all = state.devices.map((d) => d.id);
  const a = all.indexOf(state.selected);
  const b = all.indexOf(id);
  if (deselected || a < 0) return selectSceneDevice(id);
  setSelection(all.slice(Math.min(a, b), Math.max(a, b) + 1), id);
}
function selectAll() {
  if (state.devices.length < 2) return selectSceneDevice(state.selected);
  setSelection(state.devices.map((d) => d.id), state.selected);
}

// Clicking empty canvas (or Esc) deselects: the outline and highlights go,
// though the Inspector keeps showing the last device (\`deselected\`, declared
// with the state). Not saved or undone.
function showOutline() {
  ctx.setOutlineEnabled(!deselected);
  ctx.setSelected([state.selected, ...multi]);
}
function deselect() {
  if (deselected) return;
  deselected = true;
  multi.clear();
  showOutline();
  renderSceneList();
  timelineUI.render();
}

/** Update everything that shows the selected device (and selects it again). */
function syncSelection() {
  deselected = false;
  for (const id of [...multi]) if (!recOf(id) || id === state.selected) multi.delete(id);
  showOutline();
  const picker = document.querySelector('.swatch-custom input');
  if (picker) picker.value = state.customColor;
  renderSceneList();
  syncClip();
  syncModelSetup();
  syncControls();
  timelineUI.render();
}

function renderSceneList() {
  const list = $('sceneList');
  if (!list) return;
  list.innerHTML = '';
  const many = state.devices.length > 1;
  for (const rec of state.devices) {
    const it = insts.get(rec.id);
    const desc = deviceDesc(rec.model) || DEVICES[0];
    const row = document.createElement('div');
    row.className = 'scene-item' + ((rec.id === state.selected || multi.has(rec.id)) && !deselected ? ' on' : '');
    row.dataset.id = rec.id;
    row.title = 'Click to select · ⌘-click or Shift-click to select several · drop a design here to put it on this device';
    const m = it?.media;
    row.innerHTML = `<span class="scene-thumb${isLandscape(rec) ? ' landscape' : ''}" style="--frame:${finishOf(rec).frame}"></span>
      <span class="scene-meta"><span class="dev-name">${escapeHTML(deviceName(rec))}</span><span class="dev-sub">${m ? escapeHTML(m.name) : 'No design'}${state.shadow.mode !== 'off' && rec.castShadow === false ? ' · no shadow' : ''}</span></span>
      <span class="scene-btns">
        <button class="icon-btn sm" data-act="dup" title="Duplicate"${state.devices.length >= MAX_DEVICES ? ' disabled' : ''}><svg><use href="#i-copy"/></svg></button>
        <button class="icon-btn sm" data-act="del" title="Delete from the scene"${many ? '' : ' disabled'}><svg><use href="#i-trash"/></svg></button>
      </span>`;
    if (m) row.querySelector('.scene-thumb').appendChild(mediaThumb(m));
    row.addEventListener('click', (e) => {
      const act = e.target.closest('button[data-act]')?.dataset.act;
      if (act === 'dup') return addDevice({ from: rec.id });
      if (act === 'del') return deleteDevices([rec.id]);
      if (e.metaKey || e.ctrlKey) return toggleSelected(rec.id);
      if (e.shiftKey) return selectRange(rec.id);
      selectSceneDevice(rec.id);
    });
    list.appendChild(row);
  }
  $('addDevice').disabled = state.devices.length >= MAX_DEVICES;
}

/**
 * Add a device to the scene: a copy of `from` (Duplicate, which also copies
 * its design and animation) or a new one like the selected device. It goes
 * where that device is, stacked just in front of it (see `stackedOn`), and the
 * camera stays as it is.
 */
async function addDevice({ from = null } = {}) {
  if (state.devices.length >= MAX_DEVICES) {
    setStatus(`A scene can have up to ${MAX_DEVICES} devices.`, 'busy');
    return;
  }
  if (playing) play(false);
  const src = recOf(from) || selRec();
  const rec = makeDevice({ ...JSON.parse(JSON.stringify(src)), id: newDeviceId() });
  const srcLive = devicePose(instOf(src.id).live);
  rec.pose = devicePose(srcLive);
  state.devices.push(rec);
  const it = instOf(rec.id);
  it.live = devicePose(rec.pose);
  if (from) {
    const tr = trackOf(rec.id);
    for (const k of trackOf(src.id).keyframes) setKey(tr, k.t, devicePose(k.pose), k.ease);
  }
  state.selected = rec.id;
  syncSelection();
  await syncInstances();
  if (!recOf(rec.id)) return;

  // On top of the source device (its keyframes too, for Duplicate).
  if (hasKeys(trackOf(rec.id))) {
    for (const k of trackOf(rec.id).keyframes) k.pose = stackedOn(k.pose, rec.id);
  }
  rec.pose = stackedOn(srcLive, rec.id);
  if (from && src) {
    const sm = instOf(src.id).media;
    if (sm?.file) await useFile(sm.file, { fromProject: true, target: rec.id });
  }
  refreshPose();
  timelineUI.render();
  renderSceneList();
  save();
  setStatus(`Added ${deviceName(rec)} in front of ${deviceName(src)} · Shift-drag to move it, drop a design on it`);
}

/**
 * Pose `p` moved out of its own face by the device's thickness, so a copy
 * sits on the original like a card on a stack: the same spot on the canvas,
 * just in front, with no overlap. (Moves towards whichever side faces the
 * camera, wherever it's orbited to.)
 */
function stackedOn(p, id) {
  const d = ctx.slotSize(id)?.d ?? 0.12;
  const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...p.rot.map((a) => a * Math.PI / 180)));
  if (n.dot(ctx.towardsCamera()) < 0) n.negate();
  const k = d * 1.15 * (p.scale ?? 1);
  return devicePose({ ...p, pos: [p.pos[0] + n.x * k, p.pos[1] + n.y * k, p.pos[2] + n.z * k] });
}

/** Delete devices (one undo step), always keeping at least one. */
function deleteDevices(ids) {
  const recs = ids.map(recOf).filter(Boolean);
  if (recs.length >= state.devices.length) recs.length = state.devices.length - 1;
  if (!recs.length) return;
  if (playing) play(false);
  const name = recs.length === 1 ? deviceName(recs[0]) : `${recs.length} devices`;
  let i = 0;
  for (const rec of recs) {
    i = state.devices.indexOf(rec);
    state.devices.splice(i, 1);
    delete anim.tracks[rec.id];
    multi.delete(rec.id);
    disposeInst(rec.id); // its design is kept in case this is undone
  }
  if (!recOf(state.selected)) state.selected = state.devices[Math.min(i, state.devices.length - 1)].id;
  timelineUI.select(null);
  syncSelection();
  refreshPose();
  save();
  setStatus(`Deleted ${name} · ⌘Z to undo`);
}

// ---------------------------------------------------------------------------
// Projects (.m3d files)
// ---------------------------------------------------------------------------
function markDirty() {
  if (restoring || project.dirty) return;
  project.dirty = true;
  syncProjectUI();
}

function syncProjectUI() {
  $('projectName').textContent = project.name;
  $('dirtyDot').hidden = !project.dirty;
  $('projectBtn').title = `${project.name}${project.dirty ? ' — unsaved changes' : ''}`;
  document.title = `${project.dirty ? '• ' : ''}${project.name} — Mockup3D Studio`;
}

/** Everything a project file needs to recreate the current mockup. */
async function collectProject() {
  if (saveTimer) save();
  const models = [];
  for (const id of new Set(state.devices.map((d) => d.model))) {
    const rec = customRec(id);
    const buffer = rec && await getModelBuffer(rec.id);
    if (buffer) models.push({ rec, buffer });
  }
  const media = [];
  for (const d of state.devices) {
    const m = insts.get(d.id)?.media;
    if (m?.file) media.push({ device: d.id, name: m.name, type: m.file.type, blob: m.file });
  }
  return {
    settings: JSON.parse(snapshot()),
    media,
    models,
    hdri: state.env === 'custom' && customHdri ? customHdri : null,
  };
}

let busyProject = false;
async function saveProject({ saveAs = false } = {}) {
  if (busyProject || exporting) return;
  busyProject = true;
  setStatus('Saving project…', 'busy');
  try {
    const blob = await packProject(await collectProject());
    const fileName = `${project.name}${PROJECT_EXT}`;
    let saved = false;
    if (canWriteFiles) {
      try {
        const handle = await writeProjectFile(blob, fileName, saveAs ? null : project.handle);
        project.handle = handle;
        project.name = handle.name.replace(/\.m3d$/i, '');
        saved = true;
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus('Save cancelled');
          return;
        }
        console.warn('Writing the file failed; downloading instead.', err);
      }
    }
    if (!saved) download(blob, fileName); // browsers that can't write files directly
    project.dirty = false;
    syncProjectUI();
    setStatus(`${saved ? 'Saved' : 'Downloaded'} ${project.name}${PROJECT_EXT} · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn’t save the project: ${err.message}`, 'err');
  } finally {
    busyProject = false;
  }
}

const confirmDiscard = () => !project.dirty
  || window.confirm(`“${project.name}” has unsaved changes. Discard them?`);

async function openProjectDialog() {
  if (!confirmDiscard()) return;
  try {
    const picked = await pickProjectFile();
    if (picked) return openProject(picked.file, picked.handle, { confirmed: true });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
  }
  $('projectInput').click(); // browsers without the file picker API
}

async function openProject(file, handle = null, { confirmed = false } = {}) {
  if (!confirmed && !confirmDiscard()) return;
  setStatus(`Opening ${file.name}…`, 'busy');
  let p;
  try {
    p = await unpackProject(file);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }
  if (playing) play(false);
  setPickMode(null);

  // Imported device models: add them (or update their setup) under their saved ids.
  for (const model of p.models) {
    const existing = customRec(model.rec.id);
    if (!existing) {
      await storeModel(model.rec.id, model.buffer);
      state.customDevices.push(model.rec);
    } else {
      Object.assign(existing, model.rec);
    }
  }
  if (p.models.length) renderDeviceList();

  // Designs go back on after the devices exist.
  for (const it of insts.values()) clearMedia(false, it.id);
  emptyTrash();
  restore(JSON.stringify(p.settings));
  // restore() only reloads models that changed; imported ones may have a new setup.
  const imported = new Set(p.models.map((m) => m.rec.id));
  await Promise.all(state.devices.filter((d) => imported.has(d.model)).map((d) => loadModel(d.id)));

  if (p.hdri) {
    await useHDRI(new File([p.hdri.blob], p.hdri.name));
  } else if (state.env === 'custom') {
    state.env = DEFAULT_ENV;
    setEnv(state.env);
  }

  for (const m of p.media) {
    // Version 1 projects had one design, for their one device.
    const target = recOf(m.device) ? m.device : state.devices[0].id;
    await useFile(new File([m.blob], m.name, { type: m.type }), { fromProject: true, target });
  }
  syncClip();
  renderSceneList();

  history.undo = [];
  history.redo = [];
  history.last = snapshot();
  syncUndoButtons();
  setTime(0);
  save();
  project.name = file.name.replace(/\.m3d$/i, '');
  project.handle = handle;
  project.dirty = false;
  syncProjectUI();
  setStatus(`Opened ${file.name}`);
}

function newProject() {
  if (!confirmDiscard()) return;
  if (playing) play(false);
  const s = freshDefaults();
  for (const k of NOT_UNDOABLE) delete s[k];
  const a = createAnim();
  for (const it of insts.values()) clearMedia(false, it.id);
  emptyTrash();
  state.selected = s.devices[0].id;
  restore(JSON.stringify({ s, a: { duration: a.duration, fps: a.fps, loop: a.loop, tracks: {} } }));
  if (state.env !== DEFAULT_ENV) setEnv(DEFAULT_ENV);
  customHdri = null;
  syncClip();
  renderSceneList();
  history.undo = [];
  history.redo = [];
  history.last = snapshot();
  syncUndoButtons();
  setTime(0);
  save();
  Object.assign(project, { name: 'Untitled', handle: null, dirty: false });
  syncProjectUI();
  setStatus('New project');
}

function buildProjectMenu() {
  const menu = $('projectMenu');
  $('projectBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.project')) menu.hidden = true;
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    menu.hidden = true;
    ({ new: newProject, open: openProjectDialog, save: () => saveProject(), saveas: () => saveProject({ saveAs: true }) })[b.dataset.act]();
  });
  $('projectInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openProject(f, null, { confirmed: true });
  });
  // The design image/video only lives in memory, so warn before losing it.
  window.addEventListener('beforeunload', (e) => {
    if (project.dirty && [...insts.values()].some((it) => it.media)) e.preventDefault();
  });
  syncProjectUI();
}

// ---------------------------------------------------------------------------
// Imported device models
// ---------------------------------------------------------------------------
let pickMode = null; // 'screen' | 'hide' | null

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Choose the model of the selected device. */
/** Model list: switch the selected device(s) to this model. */
function selectDevice(id) {
  setPickMode(null);
  const recs = targets();
  for (const rec of recs) rec.model = id;
  save();
  syncControls();
  renderSceneList();
  Promise.all(recs.map((rec) => loadModel(rec.id))).then(renderSceneList);
}

function renderDeviceList() {
  const list = $('deviceSeg');
  list.innerHTML = '';
  const add = (id, html, onClick) => {
    const b = document.createElement('button');
    b.className = 'device-item';
    b.dataset.v = id;
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    list.appendChild(b);
    return b;
  };
  for (const d of DEVICES) {
    add(d.id, `<svg><use href="#i-${d.kind}"/></svg>
      <span><div class="dev-name">${d.label}</div><div class="dev-sub">${d.size} · ${d.px[0]}×${d.px[1]}</div></span>`, () => selectDevice(d.id));
  }
  for (const c of state.customDevices) {
    const b = add(c.id, `<svg><use href="#i-cube"/></svg>
      <span><div class="dev-name">${escapeHTML(c.label)}</div><div class="dev-sub">Imported${c.screen ? '' : ' · no screen'}</div></span>
      <span class="dev-x" title="Remove model"><svg><use href="#i-x"/></svg></span>`, (e) => {
      if (e.target.closest('.dev-x')) removeDevice(c.id);
      else selectDevice(c.id);
    });
    b.title = c.label;
  }
  const addBtn = add('__add', `<svg><use href="#i-plus"/></svg>
    <span><div class="dev-name">Add device…</div><div class="dev-sub">.glb model</div></span>`, () => $('modelInput').click());
  addBtn.classList.add('add');
  for (const b of list.children) b.classList.toggle('on', b.dataset.v === state.device);
}

async function importDevice(file) {
  if (!file) return;
  setStatus(`Importing ${file.name}…`, 'busy');
  let rec;
  try {
    rec = await importModelFile(file);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }
  state.customDevices.push(rec);
  state.device = rec.id;
  markDirty();
  // Start the new model face-on.
  state.pose = devicePose({ ...state.pose, rot: [0, 0, 0] });
  if (!hasKeys(trackOf(state.selected))) sel().live = devicePose(state.pose);
  save();
  renderDeviceList();
  renderSceneList();
  syncControls();
  await loadModel(state.selected);
  if (!rec.screen) {
    setPickMode('screen');
    setStatus(`Imported ${rec.label}. Click its screen to place your design there.`, 'busy');
  } else {
    setStatus(`Imported ${rec.label} · screen found automatically`);
  }
}

async function removeDevice(id) {
  const rec = customRec(id);
  if (!rec) return;
  if (!window.confirm(`Remove “${rec.label}” from Mockup3D Studio?\n\nThis deletes the imported copy stored in this browser (your original file isn't touched).`)) return;
  state.customDevices = state.customDevices.filter((d) => d.id !== id);
  await deleteModel(id).catch(() => {});
  // Devices in the scene that used it go back to the default model.
  for (const d of state.devices) if (d.model === id) d.model = DEVICES[0].id;
  syncInstances();
  save();
  syncControls();
  renderDeviceList();
  renderSceneList();
  setStatus(`Removed ${rec.label}`);
}

/** Re-apply a changed setup record (screen, hidden parts, rotation). */
function rebuildCustom() {
  save();
  renderDeviceList();
  renderSceneList();
  const model = state.device;
  return Promise.all(state.devices.filter((d) => d.model === model).map((d) => loadModel(d.id)));
}

function setPickMode(mode) {
  pickMode = mode;
  vp.classList.toggle('picking', !!mode);
  $('pickHint').hidden = !mode;
  $('pickHint').textContent = mode === 'screen'
    ? 'Click the screen on the model · Esc to cancel'
    : 'Click parts to hide them · Esc when done';
  $('pickScreen').classList.toggle('on', mode === 'screen');
  $('pickHide').classList.toggle('on', mode === 'hide');
}

const raycaster = new THREE.Raycaster();
async function handlePick(e) {
  const rec = customRec();
  let device = sel().device;
  if (!rec || !device?.custom) return setPickMode(null);
  raycaster.setFromCamera(ndcAt(e.clientX, e.clientY), ctx.camera);
  const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const hit = raycaster.intersectObject(device.root, true).find((h) => {
    if (!shown(h.object)) return false;
    const m = Array.isArray(h.object.material) ? h.object.material[h.face?.materialIndex ?? 0] : h.object.material;
    return m && m.visible !== false;
  });
  if (!hit) {
    setStatus('Missed the model — click directly on it.', 'busy');
    return;
  }
  const ref = device.partRef(hit);
  if (!ref) return;
  if (pickMode === 'screen') {
    if (!ref.screen) rec.screen = ref;
    setPickMode(null);
    await rebuildCustom();
    device = sel().device;
    setStatus(device?.info ? 'Screen set — your design is now on it' : 'That part can’t be used as a screen. Try another.', device?.info ? 'ok' : 'err');
  } else if (pickMode === 'hide') {
    if (ref.screen) {
      setStatus('That’s the screen — pick a different part to hide.', 'busy');
      return;
    }
    rec.hidden.push(ref);
    await rebuildCustom();
    setStatus(`Hidden ${rec.hidden.length} part${rec.hidden.length === 1 ? '' : 's'} · Esc when done`);
  }
}

function buildModelSetup() {
  $('modelName').addEventListener('input', (e) => {
    const rec = customRec();
    if (!rec) return;
    rec.label = e.target.value.trim() || 'Untitled model';
    renderDeviceList();
    syncControls();
    saveSoon();
  });
  $('pickScreen').addEventListener('click', () => setPickMode(pickMode === 'screen' ? null : 'screen'));
  $('pickHide').addEventListener('click', () => setPickMode(pickMode === 'hide' ? null : 'hide'));
  $('showAll').addEventListener('click', () => {
    const rec = customRec();
    if (!rec?.hidden.length) return;
    rec.hidden = [];
    rebuildCustom();
  });
  for (const b of document.querySelectorAll('#modelSetup [data-axis]')) {
    b.addEventListener('click', () => {
      const rec = customRec();
      if (!rec) return;
      const i = +b.dataset.axis;
      rec.fix[i] = (rec.fix[i] + 90) % 360;
      rebuildCustom();
    });
  }
  $('resetFix').addEventListener('click', () => {
    const rec = customRec();
    if (!rec) return;
    rec.fix = [0, 0, 0];
    rebuildCustom();
  });
  $('removeModel').addEventListener('click', () => removeDevice(state.device));
}

function syncModelSetup() {
  const rec = customRec();
  const device = sel().device;
  $('modelSetup').hidden = !rec;
  if (!rec) return;
  if (document.activeElement !== $('modelName')) $('modelName').value = rec.label;
  const ok = !!(device?.custom && device.info);
  const el = $('screenState');
  el.className = 'screen-state ' + (ok ? 'ok' : 'missing');
  el.textContent = ok
    ? `Set · ${(device.info.screenW / device.info.screenH).toFixed(2)}:1`
    : 'Not set — click Pick screen';
  $('showAll').disabled = !rec.hidden.length;
  let hint = '';
  if (ok && !device.facing) hint = 'The screen doesn’t face the camera at the Front angle. Use Rotate until it does, so angles and presets look right.';
  else if (!ok) hint = 'Pick screen, then click the display on the model. If a glass layer covers it, use Hide parts first.';
  else if (rec.hidden.length) hint = `${rec.hidden.length} part${rec.hidden.length === 1 ? '' : 's'} hidden.`;
  $('modelHint').textContent = hint;
}

// ---------------------------------------------------------------------------
// Environment (HDRI lighting)
// ---------------------------------------------------------------------------
let envToken = 0;

function buildEnvList() {
  const list = $('envList');
  const item = (id, ball, name, note) => {
    const b = document.createElement('button');
    b.className = 'env-item';
    b.dataset.v = id;
    b.innerHTML = `<span class="env-ball${ball ? '' : ' add'}" style="${ball || ''}">${ball ? '' : '<svg><use href="#i-upload"/></svg>'}</span>
      <span><div class="env-name">${name}</div><div class="env-note">${note}</div></span>`;
    list.appendChild(b);
    return b;
  };
  const balls = {
    'studio-panels': 'background: radial-gradient(circle at 38% 30%, #ffffff 0 14%, #2a2a2d 30%, #0e0e10)',
  };
  for (const e of ENVIRONMENTS) {
    item(e.id, balls[e.id], e.label, e.note).addEventListener('click', () => setEnv(e.id));
  }
  const custom = item('custom', 'background: radial-gradient(circle at 35% 30%, #e8f0ff, #6d7fa6 45%, #232a3a)', 'Custom HDRI', 'Drop or load .exr / .hdr');
  custom.hidden = true;
  item('load', '', 'Load HDRI…', '.exr or .hdr file').addEventListener('click', () => $('hdriInput').click());
  $('hdriInput').addEventListener('change', (e) => {
    useHDRI(e.target.files[0]);
    e.target.value = '';
  });
}

async function setEnv(id) {
  const token = ++envToken;
  const el = $('envList').querySelector(`[data-v="${id}"]`);
  el?.classList.add('busy');
  if (ENVIRONMENTS.find((e) => e.id === id)?.file) setStatus('Loading HDRI…', 'busy');
  try {
    const tex = await loadEnvironment(id);
    if (token !== envToken) return;
    ctx.setEnvironment(tex);
    state.env = id;
    save();
    syncControls();
    setStatus();
  } catch (err) {
    console.error(err);
    if (token === envToken) setStatus('Couldn’t load the HDRI.', 'err');
  } finally {
    el?.classList.remove('busy');
  }
}

async function useHDRI(file) {
  if (!file) return;
  const token = ++envToken;
  setStatus(`Loading ${file.name}…`, 'busy');
  try {
    const tex = await loadEnvironmentFile(file);
    if (token !== envToken) return;
    ctx.setEnvironment(tex);
    state.env = 'custom';
    customHdri = { name: file.name, blob: file };
    markDirty();
    const custom = $('envList').querySelector('[data-v="custom"]');
    custom.hidden = false;
    custom.querySelector('.env-note').textContent = file.name;
    syncControls();
    setStatus(`Environment: ${file.name}`);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// Re-tinting the HDRI is a quick GPU pass (a few ms), so apply it directly.
function applyEnvTint() {
  ctx.setEnvTint(kelvinTint(state.envTemp));
}
function applyEnvAdjust() {
  ctx.setEnvAdjust({ highlights: state.envHighlights, contrast: state.envContrast });
}

function setFinish(id) {
  for (const rec of targets()) {
    rec.finish = id;
    insts.get(rec.id)?.device?.setFinish(finishOf(rec));
  }
  save();
  renderSceneList();
  syncControls();
}

function applyBackground() {
  const o = out();
  // Focus 100% = no blur (full-resolution image); 0% = heavily blurred.
  ctx.setBackground({ mode: o.bg, c1: o.c1, c2: o.c2, angle: o.angle, blur: (1 - o.focus) * 0.6 });
  $('viewport').classList.toggle('has-bg', o.bg !== 'transparent');
}

// ---------------------------------------------------------------------------
// Syncing the UI to state
// ---------------------------------------------------------------------------
function syncAnglePresetsActive() {
  const close = (a, b) => Math.abs(wrap180(a - b)) < 0.5;
  const rot = sel().live.rot;
  for (const b of $('presets').children) {
    b.classList.toggle('on', b._rot.every((r, i) => close(r, rot[i])));
  }
}

function syncControls() {
  const dev = currentDevice();
  const fin = currentFinish();
  const o = out();
  const on = (id, pred) => { for (const b of $(id).children) b.classList.toggle('on', pred(b.dataset.v ?? b.dataset.tab)); };

  on('deviceSeg', (v) => v === state.device);
  syncModelSetup();
  on('orientSeg', (v) => v === state.orientation);
  on('swatches', (v) => v === state.finish);
  on('bgSeg', (v) => v === state.viewerBg);
  on('bottomTabs', (v) => v === state.bottomTab);
  for (const t of document.querySelectorAll('.tab-body')) t.hidden = t.dataset.tab !== state.bottomTab;
  $('bottomHint').textContent = {
    timeline: 'Click a segment to change its easing · drag keyframes to retime',
    motion: 'Hover to preview · click to apply (replaces keyframes)',
    angles: hasKeys(trackOf(state.selected)) && state.autoKey ? 'Click to key this angle at the playhead' : 'Click to animate to an angle',
    templates: 'Replaces the scene: devices, camera, frame and background · your designs are kept · ⌘Z to undo',
  }[state.bottomTab];
  const many = state.devices.length > 1;
  $('motionTarget').hidden = !many;
  on('motionTarget', (v) => v === (many ? state.motionTarget || 'one' : 'one'));
  $('app').style.setProperty('--bottom-h', `${state.bottomH}px`);

  $('viewport').dataset.bg = state.viewerBg;
  $('finishName').textContent = fin.label;
  $('island').checked = state.island;
  $('islandRow').hidden = !dev.island;
  $('logo').checked = state.logo !== false;
  $('logoRow').hidden = !sel().device?.hasLogo;
  $('autoKey').classList.toggle('on', state.autoKey);

  // Output
  on('formatSeg', (v) => v === o.format);
  on('frameSeg', (v) => v === o.frame);
  on('bgModeSeg', (v) => v === o.bg);
  on('qualitySeg', (v) => v === o.quality);
  on('shadowSeg', (v) => v === state.shadow.mode);
  $('shadowControls').hidden = state.shadow.mode === 'off';
  {
    const recs = targets();
    const casting = recs.filter((r) => r.castShadow !== false).length;
    // Mixed shows half-way; a click then turns it on for them all.
    $('castShadow').checked = casting === recs.length;
    $('castShadow').indeterminate = casting > 0 && casting < recs.length;
    $('castShadowLabel').textContent = recs.length > 1 ? `Cast by the ${recs.length} selected` : state.devices.length > 1 ? 'Cast by this device' : 'Cast by the device';
    $('castShadowRow').hidden = state.devices.length < 2 && casting > 0;
  }
  syncShadowHint();
  on('grainSeg', (v) => v === o.grain);
  on('aaSeg', (v) => +v === o.aa);
  $('bgModeSeg').querySelector('[data-v=transparent]').disabled = o.format === 'mp4';
  const pxMode = o.format === 'png' && o.frame === 'viewport';
  $('sizeSeg').innerHTML = (pxMode ? [[1, '1×'], [2, '2×'], [4, '4×']] : [[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']])
    .map(([v, l]) => `<button data-v="${v}" class="${(pxMode ? o.scale : o.size) === v ? 'on' : ''}">${l}</button>`).join('');
  $('bgColors').hidden = o.bg === 'transparent' || o.bg === 'hdri';
  $('bgFocusRow').hidden = o.bg !== 'hdri';
  on('envList', (v) => v === state.env);
  $('bgC2Wrap').hidden = o.bg !== 'gradient';
  $('bgAnglev').hidden = o.bg !== 'gradient';
  $('shadowColor').value = state.shadow.color;
  $('shadowColor').parentElement.style.setProperty('--c', state.shadow.color);
  $('bgC1').value = o.c1;
  $('bgC2').value = o.c2;
  $('bgC1').parentElement.style.setProperty('--c', o.c1);
  $('bgC2').parentElement.style.setProperty('--c', o.c2);
  $('qualityRow').hidden = o.format !== 'mp4';
  $('grainRow').hidden = o.format !== 'mp4';
  $('trimRow').hidden = !(o.format === 'png' && o.bg === 'transparent');
  $('trim').checked = o.trim;
  $('exportLabel').textContent = o.format === 'mp4' ? 'Export MP4' : 'Export PNG';
  $('customRow').hidden = o.frame !== 'custom';
  $('sizeRow').hidden = o.frame === 'custom';
  if (document.activeElement !== $('canvasW')) $('canvasW').value = o.cw;
  if (document.activeElement !== $('canvasH')) $('canvasH').value = o.ch;
  syncCanvasLabel();

  // Preset thumbnails follow the device shape, orientation and finish.
  for (const mini of document.querySelectorAll('.preset .mini')) {
    mini.classList.toggle('tablet', dev.kind === 'tablet');
    mini.classList.toggle('landscape', landscape());
    mini.style.setProperty('--frame', fin.frame);
  }

  const [pw, ph] = dev.px ? (landscape() ? [dev.px[1], dev.px[0]] : dev.px) : [];
  $('crumbs').innerHTML =
    `<span class="crumb strong">${escapeHTML(dev.label)}</span><span class="sep">›</span>` +
    `<span class="crumb">${landscape() ? 'Landscape' : 'Portrait'}</span><span class="sep">›</span>` +
    `<span class="crumb mono">${dev.px ? `${pw} × ${ph}` : 'Imported model'}</span>`;
  const noColour = sel().device?.custom && !sel().device.recolorable;
  $('swatches').style.opacity = noColour ? 0.35 : '';
  $('finishName').textContent = noColour ? 'This model’s colours can’t be changed' : fin.label;

  for (const id of Object.keys(PARAMS)) syncParam(id);
  syncPoseUI();
  syncCameraUI();
  syncTransport();
  syncExportSize();
}

/** Output pixel size for the current settings. */
function syncCanvasLabel() {
  const o = out();
  $('frameLabel').textContent = o.frame === 'custom' ? `${o.cw} × ${o.ch}` : FRAMES[o.frame] ? o.frame : '';
}

function outputSize() {
  const o = out();
  const st = $('stage');
  if (o.frame === 'custom') return [o.cw, o.ch];
  const ratio = FRAMES[o.frame];
  if (!ratio) {
    const w = st.clientWidth || 1;
    const h = st.clientHeight || 1;
    if (o.format === 'png') return [Math.round(w * o.scale), Math.round(h * o.scale)];
    const k = o.size / Math.min(w, h);
    return [Math.round(w * k), Math.round(h * k)];
  }
  const [a, b] = ratio;
  const k = o.size / Math.min(a, b);
  return [Math.round(a * k), Math.round(b * k)];
}

function syncExportSize() {
  const o = out();
  let [w, h] = outputSize();
  if (o.format === 'mp4') {
    w = Math.round(w / 2) * 2;
    h = Math.round(h / 2) * 2;
  }
  const trimmed = o.format === 'png' && o.bg === 'transparent' && o.trim;
  $('exportSize').textContent = `${trimmed ? '≤ ' : ''}${w} × ${h}`;
  $('outFormat').textContent = o.format === 'mp4'
    ? `MP4 · H.264 · ${anim.fps} fps · ${anim.duration.toFixed(1)}s`
    : `PNG · ${o.bg === 'transparent' ? 'RGBA' : 'RGB'}`;
  const dur = $('durationv');
  if (dur && !dur.isEditing) dur.textContent = PARAMS.duration.fmt(anim.duration);
}

// Smoothly move to an angle preset (keys it if animating with Auto-key).
let anim2 = 0;
function animateTo(target) {
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

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
let exportAbort = null;

async function doExport() {
  if (exporting) return;
  if (out().format === 'mp4') return exportMP4();
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

/** Render the animation to an MP4 blob (also used by tests). */
async function renderAnimationMP4({ onProgress, signal } = {}) {
  const [width, height] = outputSize();
  // One decoder per device with a video; the others are seeked.
  const sources = new Map();
  for (const d of state.devices) {
    if (!video(d.id)) continue;
    const f = await videoFramesForExport(d.id);
    sources.set(d.id, f);
  }
  try {
    return await renderMP4(ctx, {
      width,
      height,
      fps: anim.fps,
      duration: anim.duration,
      quality: out().quality,
      grain: out().grain,
      signal,
      onProgress,
      supersample: out().aa,
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

async function exportMP4() {
  if (!mp4Supported()) {
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
  $('pgInfo').textContent = 'Preparing encoder…';
  setStatus('Rendering MP4…', 'busy');
  const t0 = performance.now();
  try {
    const blob = await renderAnimationMP4({
      signal: exportAbort.signal,
      onProgress: (done, total) => {
        const el = (performance.now() - t0) / 1000;
        const left = (el / done) * (total - done);
        $('pgFill').style.width = `${(done / total) * 100}%`;
        $('pgInfo').textContent = `Frame ${done} / ${total} · ${left < 1 ? 'almost done' : `${Math.ceil(left)}s left`}`;
      },
    });
    download(blob, `mockup-${fileTag()}-${stamp()}.mp4`);
    setStatus(`Exported MP4 · ${(blob.size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
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

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('input:not([type=range]):not([type=checkbox]):not([type=color]), textarea');
  // ⌘Z / ⇧⌘Z (Ctrl on other platforms); ⌘Y also redoes.
  if ((e.metaKey || e.ctrlKey) && !exporting) {
    const key = e.key.toLowerCase();
    if (key === 's') {
      e.preventDefault();
      saveProject({ saveAs: e.shiftKey });
      return;
    }
    if (key === 'o') {
      e.preventDefault();
      openProjectDialog();
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && !typing && !exporting) {
    const key = e.key.toLowerCase();
    if (key === 'a' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      selectAll();
      return;
    }
    // Canvas zoom: ⌘+ / ⌘− / ⌘0 (fit) / ⌘1 (100%) instead of the browser's page zoom.
    if (key === '=' || key === '+' || key === '-' || key === '_' || key === '0' || key === '1') {
      e.preventDefault();
      if (key === '0') fitCanvas();
      else if (key === '1') setZoomPercent(100);
      else stepZoom(key === '-' || key === '_' ? -1 : 1);
      return;
    }
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (key === 'y') {
      e.preventDefault();
      redo();
      return;
    }
  }
  if (typing || e.metaKey || e.ctrlKey) return;
  if (exporting) {
    if (e.key === 'Escape') exportAbort?.abort();
    return;
  }
  if (e.key === 'Escape') {
    if (pickMode) setPickMode(null);
    else deselect();
    return;
  }
  const k = e.key.toLowerCase();
  const frame = 1 / anim.fps;
  if (k === 'e') doExport();
  else if (k === 'r') animateTo([0, 0, 0]);
  else if (k === 'f') fitCanvas();
  else if (k === 'k') toggleKeyAtPlayhead();
  else if (k === 'j') setTime(prevKeyTime(allKeysView(anim), playhead));
  else if (k === 'l') setTime(nextKeyTime(allKeysView(anim), playhead));
  else if ((e.key === 'Tab') && state.devices.length > 1 && !e.altKey) {
    // Tab / Shift-Tab: select the next / previous device.
    e.preventDefault();
    const i = state.devices.indexOf(selRec());
    const n = state.devices.length;
    selectSceneDevice(state.devices[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
  }
  else if (e.key === 'Home') setTime(0);
  else if (e.key === 'End') setTime(anim.duration);
  else if (e.key === ' ') {
    // Play/pause happens on release, so holding Space can pan instead.
    e.preventDefault();
    if (!e.repeat && !space.held) {
      space.held = true;
      space.panned = false;
      vp.classList.add('space-pan');
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    if (playing) play(false);
    const n = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
    setTime(snapTime(anim, playhead + n * frame));
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && timelineUI.selectedIds.length) {
    const track = timelineUI.selectedTrack;
    const tr = trackOf(track);
    for (const id of timelineUI.selectedIds) removeKey(tr, id);
    if (!hasKeys(tr)) {
      if (track === CAMERA) state.camera = cameraPose(liveCam);
      else if (recOf(track)) recOf(track).pose = devicePose(instOf(track).live);
    }
    timelineUI.select(null);
    timelineUI.render();
    refreshPose();
    syncTransport();
    save();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    // No keyframes selected: delete the selected device. Afterwards nothing
    // is selected, so pressing again doesn't delete the next one.
    e.preventDefault();
    if (deselected) return;
    if (state.devices.length < 2) return setStatus('A scene needs at least one device', 'err');
    deleteDevices(targets().map((d) => d.id));
    deselect();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key !== ' ' || !space.held) return;
  e.preventDefault(); // stop Space from also "clicking" a focused button
  space.held = false;
  vp.classList.remove('space-pan');
  if (!space.panned && !exporting) play();
});
window.addEventListener('blur', () => {
  space.held = false;
  vp.classList.remove('space-pan');
});

function setStatus(msg, kind = 'ok') {
  const dev = currentDevice();
  const n = state.devices.length;
  $('status').textContent = msg || (n > 1
    ? ['Ready', `${n} devices`, `${deviceName(selRec())} selected`]
    : ['Ready', dev.label, sel().media?.name]).filter(Boolean).join(' · ');
  $('statusDot').className = 'dot' + (kind === 'ok' ? '' : ' ' + kind);
}

// ---------------------------------------------------------------------------
const timelineUI = createTimelineUI({
  getAnim: () => anim,
  getTime: () => playhead,
  setTime: (t) => {
    if (playing) play(false);
    setTime(t);
  },
  // Camera first, then one track per device with its design underneath.
  getTracks: () => [
    { id: CAMERA, kind: 'camera', label: 'Camera' },
    ...state.devices.map((d) => {
      const m = insts.get(d.id)?.media;
      return {
        id: d.id,
        kind: 'device',
        icon: deviceDesc(d.model)?.kind === 'tablet' ? 'tablet' : 'phone',
        label: deviceName(d),
        selected: d.id === state.selected && !deselected,
        design: { kind: m ? (m.video ? 'video' : 'image') : null, name: m?.name, duration: m?.video?.duration },
      };
    }),
  ],
  selectTrack: (id) => {
    if (id !== CAMERA) selectSceneDevice(id);
  },
  toggleKey: (id) => {
    if (playing) play(false);
    toggleKeyAtPlayhead(id);
  },
  onEdit: () => {
    refreshPose();
    syncTransport();
    saveSoon();
  },
});

buildControls();
buildEnvList();
buildProjectMenu();
buildZoomControl();
// A custom HDRI isn't saved between visits; fall back to the bundled one.
if (!ENVIRONMENTS.some((e) => e.id === state.env)) state.env = DEFAULT_ENV;
ctx.setEnvRotation(state.envRot);
ctx.setReflectionZoom(state.reflZoom);
ctx.setEnvTint(kelvinTint(state.envTemp));
applyEnvAdjust();
ctx.setShadow(state.shadow);
setEnv(state.env);
applyBackground();
syncControls();
layoutFrame();
buildTemplatePresets();
syncInstances();
syncSelection();
refreshPose();
history.last = snapshot();
// Double-click the temperature slider to go back to the HDRI's own colours.
$('envTemp').addEventListener('dblclick', () => { setParam('envTemp', NEUTRAL_KELVIN); save(); });
$('envHighlights').addEventListener('dblclick', () => { setParam('envHighlights', 1); save(); });
$('envContrast').addEventListener('dblclick', () => { setParam('envContrast', 1); save(); });
$('reflZoom').addEventListener('dblclick', () => { setParam('reflZoom', 1); save(); });
// Double-click a camera angle to straighten it.
for (const id of ['camOrbit', 'camElev', 'camRoll']) $(id).addEventListener('dblclick', () => { setParam(id, 0); save(); });
// Double-click a shadow slider to reset it.
for (const [id, key] of [['shadowStrength', 'strength'], ['shadowSoftness', 'softness'], ['shadowDistance', 'distance'], ['shadowOffset', 'offset'], ['shadowAngle', 'angle']]) {
  $(id).addEventListener('dblclick', () => { setParam(id, DEFAULT_SHADOW[key]); save(); });
}
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
syncUndoButtons();

// Handy for debugging and tests from the console.
window.mockup = {
  ctx, state, insts, useFile, setTime, play, renderAnimationMP4, undo, redo, history, project,
  collectProject, packProject, openProject, saveProject, newProject, addDevice, deleteDevices, selectSceneDevice, setSelection, selectAll,
  applyTemplate: (id) => applyTemplate(TEMPLATES.find((t) => t.id === id)), applyMotion: (id) => applyMotion(MOTION_PRESETS.find((p) => p.id === id)),
  frameAll, trackOf, poseAt, cameraAt,
  get anim() { return anim; },
  get device() { return sel().device; },
  get playhead() { return playhead; },
  get livePose() { return sel().live; },
  get liveCam() { return liveCam; },
};
