// Viewer: drag to rotate, scroll to zoom the canvas, Space-drag to pan

import * as THREE from 'three';
import { devicePose, cameraPose } from '../timeline.js';
import { applyCamera, applyPose, commitCamera, commitPose, liveCam, play, playing, stopAngleAnim } from './animation.js';
import { ctx } from './ctx.js';
import { exporting } from './export.js';
import { save } from './history.js';
import { instOf, sel } from './instances.js';
import { handlePick, pickMode } from './models.js';
import { syncCameraUI } from './params.js';
import { deselect, deselected, selectSceneDevice, toggleSelected } from './scene-list.js';
import { frameRatio, state } from './state.js';
import { setStatus } from './status.js';
import { outputSize, syncControls, syncExportSize } from './ui-sync.js';
import { $, clamp } from './util.js';

export const vp = $('viewport');
export let drag = null;
let panDrag = null;
let orbitDrag = null; // Option-drag: turning the camera
const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
// Space: hold and drag to pan the canvas; a quick tap still plays / pauses.
export const space = { held: false, panned: false };

/** Normalised device coordinates of a point in the viewer. */
export function ndcAt(clientX, clientY) {
  const r = $('stage').getBoundingClientRect();
  return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
}
/** The device under a point in the viewer, or null. */
export const deviceAt = (clientX, clientY) => ctx.pickSlot(ndcAt(clientX, clientY));

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
    stopAngleAnim();
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
  stopAngleAnim(); // cancel a running angle-preset animation
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

export function setZoomPercent(pct) {
  if (!(pct > 0)) return;
  zoomCanvasTo(pct / percentPerZ());
}

export function fitCanvas() {
  canvasView.z = 1;
  canvasView.pan = [0, 0];
  applyCanvasView();
}

/** ⌘+ / ⌘−: step through the zoom presets. */
export function stepZoom(dir) {
  const cur = zoomPercent();
  const next = dir > 0
    ? ZOOM_STEPS.find((p) => p > cur + 0.5) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
    : [...ZOOM_STEPS].reverse().find((p) => p < cur - 0.5) ?? ZOOM_STEPS[0];
  setZoomPercent(next);
}

export function buildZoomControl() {
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
export function layoutFrame() {
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
