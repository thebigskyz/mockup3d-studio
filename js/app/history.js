// Saving settings, and undo / redo.

import { kelvinTint } from '../environments.js';
import { cameraPose, reviveAnim } from '../timeline.js';
import { playhead, refreshPose, setPlayhead } from './animation.js';
import { ctx } from './ctx.js';
import { applyBackground, applyEnvAdjust, setEnv } from './environment.js';
import { applyAll, syncInstances } from './instances.js';
import { markDirty } from './projects.js';
import { syncSelection } from './scene-list.js';
import { DEFAULT_OUTPUT, STORE_KEY, anim, pruneTracks, recOf, sanitizeDevices, setAnim, state, upgradeSettings, validShadow, validUnit } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { $ } from './util.js';
import { layoutFrame } from './viewer.js';

export function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  recordHistory();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, anim: animJSON() }));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}
export let saveTimer = null;
export function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

// ---------------------------------------------------------------------------
// Undo / redo. Every saved change is a step; rapid changes (dragging a
// slider, scrubbing a value) are grouped because saving is debounced.
// ---------------------------------------------------------------------------
// View-only settings that shouldn't be undone.
export const NOT_UNDOABLE = ['anim', 'selected', 'motionTarget', 'mirror', 'bottomH', 'bottomTab', 'viewerBg', 'autoKey', 'customDevices'];
const HISTORY_LIMIT = 150;
export const history = { undo: [], redo: [], last: null };
export let restoring = false;

/** The animation as plain data (no ids, no empty tracks). */
function animJSON() {
  const tracks = {};
  for (const [id, keys] of Object.entries(anim.tracks)) {
    if (keys.length) tracks[id] = keys.map((k) => ({ t: k.t, pose: k.pose, ease: k.ease }));
  }
  return { duration: anim.duration, fps: anim.fps, loop: anim.loop, tracks };
}

export function snapshot() {
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

export function undo() {
  if (saveTimer) save(); // record a pending change first
  if (!history.undo.length) return setStatus('Nothing to undo');
  const current = history.last;
  const prev = history.undo.pop();
  history.redo.push(current);
  restore(prev);
  setStatus(`Undo ${describeChange(prev, current)}`);
}

export function redo() {
  if (saveTimer) save();
  if (!history.redo.length) return setStatus('Nothing to redo');
  const current = history.last;
  const next = history.redo.pop();
  history.undo.push(current);
  restore(next);
  setStatus(`Redo ${describeChange(current, next)}`);
}

/** Apply saved settings (an undo snapshot, or a project's settings). */
export function restore(snap) {
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
    setAnim(reviveAnim(a));
    pruneTracks();
    setPlayhead(Math.min(playhead, anim.duration));
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

export function syncUndoButtons() {
  const u = $('undoBtn');
  const r = $('redoBtn');
  if (!u || !r) return;
  u.disabled = !history.undo.length;
  r.disabled = !history.redo.length;
}
