// Keyboard shortcuts

import { CAMERA, devicePose, cameraPose, hasKeys, allKeysView, removeKey, prevKeyTime, nextKeyTime, snapTime } from '../timeline.js';
import { animateTo, liveCam, play, playhead, playing, refreshPose, setTime, toggleKeyAtPlayhead, trackOf } from './animation.js';
import { doExport, exportAbort, exporting } from './export.js';
import { redo, save, undo } from './history.js';
import { instOf } from './instances.js';
import { pickMode, setPickMode } from './models.js';
import { openProjectDialog, saveProject } from './projects.js';
import { deleteDevices, deselect, deselected, selectAll, selectSceneDevice, targets } from './scene-list.js';
import { anim, recOf, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncTransport } from './transport.js';
import { fitCanvas, setZoomPercent, space, stepZoom, vp } from './viewer.js';

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
