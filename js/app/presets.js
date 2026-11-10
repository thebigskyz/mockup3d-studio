// Angle and motion presets in the bottom panel.

import { easeCss } from '../easing.js';
import { DEFAULT_POSE, createAnim, trackView, MOTION_PRESETS, applyPreset, mirrorRot } from '../timeline.js';
import { animateTo, liveCam, play, setTime, trackOf } from './animation.js';
import { save } from './history.js';
import { instOf, sel } from './instances.js';
import { anim, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncControls } from './ui-sync.js';
import { $, wrap180 } from './util.js';

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

// three.js XYZ Euler (y up) -> CSS transform (y down).
export function cssRotation([x, y, z]) {
  return `rotateX(${-x}deg) rotateY(${y}deg) rotateZ(${-z}deg)`;
}
function cssPose(p) {
  return `translate(${p.pos[0] * 18}px, ${-p.pos[1] * 18}px) ${cssRotation(p.rot)} scale(${p.scale})`;
}

/** Angle presets, each with a little CSS-3D device showing its angle. */
export function buildAnglePresets() {
  // Angle presets with a little CSS-3D device showing each angle.
  for (const p of ANGLE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = `<div class="p-stage"><div class="mini"><div class="face front"></div><div class="face back"></div></div></div><span>${p.label}</span>`;
    b.querySelector('.mini').style.transform = cssRotation(p.rot);
    b.addEventListener('click', () => animateTo(state.mirror ? mirrorRot(p.rot) : p.rot));
    b._rot = p.rot;
    $('presets').appendChild(b);
  }
}

/** Motion preset cards: hover to preview the motion on a mini device. */
export function buildMotionPresets() {
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

  $('mirrorBtn').addEventListener('click', () => {
    state.mirror = !state.mirror;
    save();
    syncControls();
    syncAnglePresetsActive();
    setStatus(state.mirror ? 'Mirrored: presets, angles and templates are flipped left to right' : 'Mirror off');
  });

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
export function applyMotion(preset) {
  const all = state.motionTarget === 'all' && state.devices.length > 1;
  const targets = all ? state.devices : [selRec()];
  const n = targets.length;
  const stagger = all && !preset.loop;
  const span = stagger ? anim.duration * 0.7 : anim.duration;
  targets.forEach((rec, i) => {
    const start = stagger ? (anim.duration - span) * (i / (n - 1)) : 0;
    applyPreset(trackOf(rec.id), preset.id, instOf(rec.id).live, { start, span, reach: Math.max(1, 1 / liveCam.zoom), mirror: state.mirror });
  });
  anim.loop = preset.loop;
  timelineUI.select(null);
  timelineUI.render();
  setTime(0);
  play(true);
  save();
  const keys = trackOf(targets[0].id).keyframes.length;
  const label = state.mirror ? `${preset.label} (mirrored)` : preset.label;
  setStatus(all
    ? `${label} applied to ${n} devices${stagger ? ', one after another' : ''}`
    : `${label} applied — ${keys} keyframes over ${anim.duration.toFixed(1)}s`);
}

export function syncAnglePresetsActive() {
  const close = (a, b) => Math.abs(wrap180(a - b)) < 0.5;
  const rot = sel().live.rot;
  for (const b of $('presets').children) {
    const want = state.mirror ? mirrorRot(b._rot) : b._rot;
    b.classList.toggle('on', want.every((r, i) => close(r, rot[i])));
  }
}
