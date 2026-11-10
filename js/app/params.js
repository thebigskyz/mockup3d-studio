// Parameters (Inspector values: slider + draggable "hot text")

import { setDuration } from '../timeline.js';
import { editCamera, editPose, liveCam, playhead, setTime } from './animation.js';
import { ctx } from './ctx.js';
import { applyBackground, applyEnvAdjust, applyEnvTint } from './environment.js';
import { saveSoon } from './history.js';
import { insts, sel } from './instances.js';
import { syncAnglePresetsActive } from './presets.js';
import { anim, out, state } from './state.js';
import { timelineUI } from './timeline-panel.js';
import { syncExportSize } from './ui-sync.js';
import { $, clamp, wrap180 } from './util.js';
import { drag } from './viewer.js';

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

export const PARAMS = {
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

export function setParam(id, v) {
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

export function syncParam(id) {
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

export function syncPoseUI() {
  for (const id of ['rotX', 'rotY', 'rotZ', 'posX', 'posY', 'posZ', 'scale']) syncParam(id);
  syncAnglePresetsActive();
}
export function applyShadow() {
  ctx.setShadow(state.shadow);
  syncShadowHint();
}
/** A floor seen from dead level is edge-on: say how to see its shadow. */
export function syncShadowHint() {
  const flat = state.shadow.mode === 'floor' && Math.abs(liveCam.orbit[1]) < 4;
  $('shadowHint').textContent = flat ? 'The camera looks level with the floor, so its shadow is hidden. Raise Camera › Elevation (or Option-drag down) to see it.' : '';
}
export function syncCameraUI() {
  syncShadowHint();
  for (const id of ['fov', 'zoom', 'panX', 'panY', 'camOrbit', 'camElev', 'camRoll']) syncParam(id);
  $('viewerInfo').textContent = `Perspective · ${Math.round(lensMM(liveCam.fov))} mm`;
}

/**
 * After Effects-style "hot text": drag left/right to scrub the value
 * (Shift = 10x faster, Alt = 10x finer), click to type a value.
 */
export function makeHot(el, id) {
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
