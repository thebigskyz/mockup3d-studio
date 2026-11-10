// Scene: one instance per device (its loaded model, design and live pose)

import { loadCustomDevice } from '../custom-devices.js';
import { DEVICES, FINISHES, loadDevice, fitTexture } from '../devices.js';
import { placeholderTexture } from '../media.js';
import { devicePose } from '../timeline.js';
import { applyCamera, liveCam } from './animation.js';
import { ctx } from './ctx.js';
import { disposeMedia } from './designs.js';
import { syncModelSetup } from './models.js';
import { renderSceneList, showOutline } from './scene-list.js';
import { recOf, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { syncControls } from './ui-sync.js';
import { $ } from './util.js';

/** device id -> { device (loaded model), model (its id), media, placeholder, token, live (pose on screen) } */
export const insts = new Map();
export const trashedMedia = new Map(); // designs of deleted devices, back if the delete is undone

export function instOf(id) {
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
export const sel = () => instOf(selRec().id);

export const isLandscape = (rec) => rec?.orientation === 'landscape';
export const landscape = () => isLandscape(selRec());
export const customRec = (id = state.device) => state.customDevices.find((d) => d.id === id) || null;
/** Device description for the UI: a built-in, or an imported model. */
export function deviceDesc(id) {
  const b = DEVICES.find((d) => d.id === id);
  if (b) return b;
  const c = customRec(id);
  return c ? { id: c.id, label: c.label, kind: 'custom', island: false, px: null } : null;
}
export const currentDevice = () => deviceDesc(state.device) || DEVICES[0];

/** Name shown for a device in the scene, e.g. "iPhone 18 Pro 2". */
export function deviceName(rec) {
  const label = deviceDesc(rec.model)?.label || 'Device';
  const same = state.devices.filter((d) => (deviceDesc(d.model)?.label || 'Device') === label);
  return same.length > 1 ? `${label} ${same.indexOf(rec) + 1}` : label;
}

export function finishOf(rec) {
  if (rec.finish === 'custom') {
    return { label: 'Custom', frame: rec.customColor, back: rec.customColor, accent: shade(rec.customColor, 0.45) };
  }
  return FINISHES.find((f) => f.id === rec.finish) || FINISHES[0];
}
export const currentFinish = () => finishOf(selRec());

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Match the instances to state.devices: add, remove and (re)load models. */
export function syncInstances() {
  for (const id of [...insts.keys()]) if (!recOf(id)) disposeInst(id);
  const loads = [];
  for (const rec of state.devices) {
    const it = instOf(rec.id);
    if (it.model !== rec.model) loads.push(loadModel(rec.id));
  }
  showOutline();
  return Promise.all(loads);
}

export function disposeInst(id) {
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
export async function loadModel(id) {
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

export function applyScreen(id = state.selected) {
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
export function applyDevice(id) {
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

export function applyAll() {
  for (const rec of state.devices) applyDevice(rec.id);
  ctx.setLight(state.light);
  applyCamera(liveCam);
}
