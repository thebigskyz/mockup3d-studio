// Environment (HDRI lighting) and the export background.

import { ENVIRONMENTS, loadEnvironment, loadEnvironmentFile, kelvinTint } from '../environments.js';
import { ctx } from './ctx.js';
import { save } from './history.js';
import { markDirty } from './projects.js';
import { out, state } from './state.js';
import { setStatus } from './status.js';
import { syncControls } from './ui-sync.js';
import { $ } from './util.js';

export let customHdri = null; // { name, blob } of a loaded .exr / .hdr, for saving
export function setCustomHdri(v) {
  customHdri = v;
}
let envToken = 0;

export function buildEnvList() {
  const list = $('envList');
  const item = (id, ball, name, note) => {
    const b = document.createElement('button');
    b.className = 'env-item';
    b.dataset.v = id;
    b.innerHTML = `<span class="env-ball${ball ? '' : ' add'}" style="${ball || ''}">${ball ? '' : '<svg><use href="#i-upload"/></svg>'}</span>
      <span><div class="env-name">${name}</div><div class="env-note">${note}</div></span>`;
    list.appendChild(b);
    return b;
  };
  const balls = {
    'studio-panels': 'background: radial-gradient(circle at 38% 30%, #ffffff 0 14%, #2a2a2d 30%, #0e0e10)',
  };
  for (const e of ENVIRONMENTS) {
    item(e.id, balls[e.id], e.label, e.note).addEventListener('click', () => setEnv(e.id));
  }
  const custom = item('custom', 'background: radial-gradient(circle at 35% 30%, #e8f0ff, #6d7fa6 45%, #232a3a)', 'Custom HDRI', 'Drop or load .exr / .hdr');
  custom.hidden = true;
  item('load', '', 'Load HDRI…', '.exr or .hdr file').addEventListener('click', () => $('hdriInput').click());
  $('hdriInput').addEventListener('change', (e) => {
    useHDRI(e.target.files[0]);
    e.target.value = '';
  });
}

export async function setEnv(id) {
  const token = ++envToken;
  const el = $('envList').querySelector(`[data-v="${id}"]`);
  el?.classList.add('busy');
  if (ENVIRONMENTS.find((e) => e.id === id)?.file) setStatus('Loading HDRI…', 'busy');
  try {
    const tex = await loadEnvironment(id);
    if (token !== envToken) return;
    ctx.setEnvironment(tex);
    state.env = id;
    save();
    syncControls();
    setStatus();
  } catch (err) {
    console.error(err);
    if (token === envToken) setStatus('Couldn’t load the HDRI.', 'err');
  } finally {
    el?.classList.remove('busy');
  }
}

export async function useHDRI(file) {
  if (!file) return;
  const token = ++envToken;
  setStatus(`Loading ${file.name}…`, 'busy');
  try {
    const tex = await loadEnvironmentFile(file);
    if (token !== envToken) return;
    ctx.setEnvironment(tex);
    state.env = 'custom';
    customHdri = { name: file.name, blob: file };
    markDirty();
    const custom = $('envList').querySelector('[data-v="custom"]');
    custom.hidden = false;
    custom.querySelector('.env-note').textContent = file.name;
    syncControls();
    setStatus(`Environment: ${file.name}`);
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// Re-tinting the HDRI is a quick GPU pass (a few ms), so apply it directly.
export function applyEnvTint() {
  ctx.setEnvTint(kelvinTint(state.envTemp));
}
export function applyEnvAdjust() {
  ctx.setEnvAdjust({ highlights: state.envHighlights, contrast: state.envContrast });
}

export function applyBackground() {
  const o = out();
  // Focus 100% = no blur (full-resolution image); 0% = heavily blurred.
  ctx.setBackground({ mode: o.bg, c1: o.c1, c2: o.c2, angle: o.angle, blur: (1 - o.focus) * 0.6 });
  $('viewport').classList.toggle('has-bg', o.bg !== 'transparent');
}
