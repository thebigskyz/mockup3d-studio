// Scene list: the devices in the scene

import * as THREE from 'three';
import { DEVICES } from '../devices.js';
import { devicePose, hasKeys, setKey } from '../timeline.js';
import { play, playing, refreshPose, trackOf } from './animation.js';
import { ctx } from './ctx.js';
import { mediaThumb, syncClip, useFile } from './designs.js';
import { save, saveSoon, undo } from './history.js';
import { deviceDesc, deviceName, disposeInst, finishOf, instOf, insts, isLandscape, landscape, syncInstances } from './instances.js';
import { setPickMode, syncModelSetup } from './models.js';
import { MAX_DEVICES, anim, makeDevice, newDeviceId, recOf, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncControls } from './ui-sync.js';
import { $, escapeHTML } from './util.js';
import { drag } from './viewer.js';

export function selectSceneDevice(id) {
  if (!recOf(id) || (id === state.selected && !deselected && !multi.size)) return;
  setPickMode(null);
  multi.clear();
  state.selected = id;
  syncSelection();
  saveSoon();
}

/** Devices selected besides the main one (state.selected); see setSelection. */
export const multi = new Set();
/** Nothing selected (the Inspector still shows the last device); see deselect. */
export let deselected = false;
// Several devices can be selected at once (⌘-click, Shift-click, ⌘A):
// `state.selected` is the main one (the Inspector and Transform show it) and
// `multi` (declared with the state) holds the others. Model, orientation,
// finish, Dynamic Island, logo, shadow, a new design and Delete then apply to all of
// them. Not saved or undone.
/** The selected devices, in scene order (none while deselected). */
export function selectedRecs() {
  if (deselected) return [];
  return state.devices.filter((d) => d.id === state.selected || multi.has(d.id));
}
/** The devices a change applies to: the selection, or the main device. */
export const targets = () => (selectedRecs().length ? selectedRecs() : [selRec()]);

/** Select exactly `ids`, with `primary` as the main one. */
export function setSelection(ids, primary = ids[0]) {
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
export function toggleSelected(id) {
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
export function selectAll() {
  if (state.devices.length < 2) return selectSceneDevice(state.selected);
  setSelection(state.devices.map((d) => d.id), state.selected);
}

// Clicking empty canvas (or Esc) deselects: the outline and highlights go,
// though the Inspector keeps showing the last device (\`deselected\`, declared
// with the state). Not saved or undone.
export function showOutline() {
  ctx.setOutlineEnabled(!deselected);
  ctx.setSelected([state.selected, ...multi]);
}
export function deselect() {
  if (deselected) return;
  deselected = true;
  multi.clear();
  showOutline();
  renderSceneList();
  timelineUI.render();
}

/** Update everything that shows the selected device (and selects it again). */
export function syncSelection() {
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

export function renderSceneList() {
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
export async function addDevice({ from = null } = {}) {
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
export function deleteDevices(ids) {
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
