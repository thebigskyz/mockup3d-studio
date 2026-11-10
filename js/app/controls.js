// Controls: wiring up the Media Pool, Inspector and bottom panel.

import { FINISHES } from '../devices.js';
import { CAMERA, devicePose, cameraPose, anyKeys } from '../timeline.js';
import { alignDevice, animateTo, commitCamera, liveCam, refreshPose, resetAutoKeyWarning, toggleKeyAtPlayhead } from './animation.js';
import { ctx } from './ctx.js';
import { applyBackground } from './environment.js';
import { doExport } from './export.js';
import { save, saveSoon } from './history.js';
import { applyDevice, finishOf, instOf, insts } from './instances.js';
import { buildModelSetup, importDevice, renderDeviceList } from './models.js';
import { PARAMS, applyShadow, makeHot, setParam } from './params.js';
import { buildAnglePresets, buildMotionPresets } from './presets.js';
import { addDevice, renderSceneList, selectAll, targets } from './scene-list.js';
import { CANVAS_MAX, CANVAS_MIN, DEFAULT_SHADOW, anim, out, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncTransport } from './transport.js';
import { outputSize, syncCanvasLabel, syncControls } from './ui-sync.js';
import { $, clamp } from './util.js';
import { layoutFrame } from './viewer.js';

export function buildControls() {
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

  buildAnglePresets();

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
    resetAutoKeyWarning();
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
      setStatus('MP4 can’t be transparent. For a transparent animation, choose PNG seq next to Export.', 'busy');
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

function setFinish(id) {
  for (const rec of targets()) {
    rec.finish = id;
    insts.get(rec.id)?.device?.setFinish(finishOf(rec));
  }
  save();
  renderSceneList();
  syncControls();
}

/** Camera → Frame all: zoom and pan so every device is in view. */
export function frameAll() {
  const fit = ctx.fitAll();
  commitCamera({ ...liveCam, zoom: fit.zoom, pan: fit.pan });
  save();
  setStatus('Framed all devices');
}
