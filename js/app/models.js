// Imported device models

import * as THREE from 'three';
import { importModelFile, deleteModel } from '../custom-devices.js';
import { DEVICES } from '../devices.js';
import { devicePose, hasKeys } from '../timeline.js';
import { trackOf } from './animation.js';
import { ctx } from './ctx.js';
import { save, saveSoon } from './history.js';
import { customRec, loadModel, sel, syncInstances } from './instances.js';
import { markDirty } from './projects.js';
import { renderSceneList, targets } from './scene-list.js';
import { state } from './state.js';
import { setStatus } from './status.js';
import { syncControls } from './ui-sync.js';
import { $, escapeHTML } from './util.js';
import { ndcAt, vp } from './viewer.js';

export let pickMode = null; // 'screen' | 'hide' | null

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

export function renderDeviceList() {
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

export async function importDevice(file) {
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

export function setPickMode(mode) {
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
export async function handlePick(e) {
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

export function buildModelSetup() {
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

export function syncModelSetup() {
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
