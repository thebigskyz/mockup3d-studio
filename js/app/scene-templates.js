// Templates: complete starting scenes (see js/templates.js)

import * as THREE from 'three';
import { TEMPLATES } from '../templates.js';
import { devicePose, cameraPose, mirrorRot } from '../timeline.js';
import { applyCamera, play, playing, refreshPose } from './animation.js';
import { ctx } from './ctx.js';
import { useFile } from './designs.js';
import { applyBackground } from './environment.js';
import { save, undo } from './history.js';
import { applyDevice, instOf, insts, landscape, syncInstances } from './instances.js';
import { setPickMode } from './models.js';
import { applyShadow, setParam } from './params.js';
import { cssRotation } from './presets.js';
import { multi, renderSceneList, syncSelection } from './scene-list.js';
import { DEFAULT_SHADOW, FRAMES, MAX_DEVICES, anim, makeDevice, out, state, validShadow } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncTransport } from './transport.js';
import { syncControls } from './ui-sync.js';
import { $ } from './util.js';
import { layoutFrame } from './viewer.js';

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

export function buildTemplatePresets() {
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
 * A template flipped left to right: devices swap sides and turn the other
 * way, and so do the camera, the lighting and a gradient background.
 */
function mirrorTemplate(t) {
  return {
    ...t,
    label: `${t.label} (mirrored)`,
    devices: t.devices.map((d) => ({ ...d, rot: mirrorRot(d.rot), pos: [-d.pos[0], d.pos[1], d.pos[2] || 0] })),
    camera: {
      ...t.camera,
      orbit: [-t.camera.orbit[0], t.camera.orbit[1], -t.camera.orbit[2]],
      ...(t.camera.pan ? { pan: [-t.camera.pan[0], t.camera.pan[1]] } : {}),
    },
    bg: { ...t.bg, angle: (360 - (t.bg.angle || 0)) % 360 },
    ...(Number.isFinite(t.envRot) ? { envRot: (360 - t.envRot) % 360 } : {}),
  };
}

/**
 * Replace the scene with a template: its devices, poses, finish, camera,
 * frame, background and shadow. Existing devices are reused in order and keep their
 * designs; any without one show the scene's designs in turn, so a grid of
 * phones fills up from one screenshot. Keyframes are cleared. One undo step.
 */
export async function applyTemplate(t) {
  if (state.mirror) t = mirrorTemplate(t);
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
