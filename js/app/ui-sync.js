// Syncing the UI to state

import { hasKeys } from '../timeline.js';
import { playhead, trackOf } from './animation.js';
import { undo } from './history.js';
import { currentDevice, currentFinish, landscape, sel } from './instances.js';
import { syncModelSetup } from './models.js';
import { PARAMS, syncCameraUI, syncParam, syncPoseUI, syncShadowHint } from './params.js';
import { targets } from './scene-list.js';
import { FRAMES, anim, out, state } from './state.js';
import { syncTransport } from './transport.js';
import { $, escapeHTML } from './util.js';
import { drag } from './viewer.js';

export function syncControls() {
  const dev = currentDevice();
  const fin = currentFinish();
  const o = out();
  const on = (id, pred) => { for (const b of $(id).children) b.classList.toggle('on', pred(b.dataset.v ?? b.dataset.tab)); };

  on('deviceSeg', (v) => v === state.device);
  syncModelSetup();
  on('orientSeg', (v) => v === state.orientation);
  on('swatches', (v) => v === state.finish);
  on('bgSeg', (v) => v === state.viewerBg);
  on('bottomTabs', (v) => v === state.bottomTab);
  for (const t of document.querySelectorAll('.tab-body')) t.hidden = t.dataset.tab !== state.bottomTab;
  $('bottomHint').textContent = {
    timeline: 'Click a segment to change its easing · drag keyframes to retime',
    motion: 'Hover to preview · click to apply (replaces keyframes)',
    angles: hasKeys(trackOf(state.selected)) && state.autoKey ? 'Click to key this angle at the playhead' : 'Click to animate to an angle',
    templates: 'Replaces the scene: devices, camera, frame and background · your designs are kept · ⌘Z to undo',
  }[state.bottomTab];
  $('mirrorBtn').hidden = state.bottomTab === 'timeline';
  $('mirrorBtn').classList.toggle('on', !!state.mirror);
  $('mirrorBtn').setAttribute('aria-pressed', String(!!state.mirror));
  $('bottomPane').classList.toggle('mirrored', !!state.mirror);
  const many = state.devices.length > 1;
  $('motionTarget').hidden = !many;
  on('motionTarget', (v) => v === (many ? state.motionTarget || 'one' : 'one'));
  $('app').style.setProperty('--bottom-h', `${state.bottomH}px`);

  $('viewport').dataset.bg = state.viewerBg;
  $('finishName').textContent = fin.label;
  $('island').checked = state.island;
  $('islandRow').hidden = !dev.island;
  $('logo').checked = state.logo !== false;
  $('logoRow').hidden = !sel().device?.hasLogo;
  $('autoKey').classList.toggle('on', state.autoKey);

  // Output
  on('formatSeg', (v) => v === o.format);
  on('frameSeg', (v) => v === o.frame);
  on('bgModeSeg', (v) => v === o.bg);
  on('qualitySeg', (v) => v === o.quality);
  on('shadowSeg', (v) => v === state.shadow.mode);
  $('shadowControls').hidden = state.shadow.mode === 'off';
  {
    const recs = targets();
    const casting = recs.filter((r) => r.castShadow !== false).length;
    // Mixed shows half-way; a click then turns it on for them all.
    $('castShadow').checked = casting === recs.length;
    $('castShadow').indeterminate = casting > 0 && casting < recs.length;
    $('castShadowLabel').textContent = recs.length > 1 ? `Cast by the ${recs.length} selected` : state.devices.length > 1 ? 'Cast by this device' : 'Cast by the device';
    $('castShadowRow').hidden = state.devices.length < 2 && casting > 0;
  }
  syncShadowHint();
  on('grainSeg', (v) => v === o.grain);
  on('aaSeg', (v) => +v === o.aa);
  $('bgModeSeg').querySelector('[data-v=transparent]').disabled = o.format === 'mp4';
  const pxMode = o.format === 'png' && o.frame === 'viewport';
  $('sizeSeg').innerHTML = (pxMode ? [[1, '1×'], [2, '2×'], [4, '4×']] : [[720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K']])
    .map(([v, l]) => `<button data-v="${v}" class="${(pxMode ? o.scale : o.size) === v ? 'on' : ''}">${l}</button>`).join('');
  $('bgColors').hidden = o.bg === 'transparent' || o.bg === 'hdri';
  $('bgFocusRow').hidden = o.bg !== 'hdri';
  on('envList', (v) => v === state.env);
  $('bgC2Wrap').hidden = o.bg !== 'gradient';
  $('bgAnglev').hidden = o.bg !== 'gradient';
  $('shadowColor').value = state.shadow.color;
  $('shadowColor').parentElement.style.setProperty('--c', state.shadow.color);
  $('bgC1').value = o.c1;
  $('bgC2').value = o.c2;
  $('bgC1').parentElement.style.setProperty('--c', o.c1);
  $('bgC2').parentElement.style.setProperty('--c', o.c2);
  $('qualityRow').hidden = o.format !== 'mp4';
  $('grainRow').hidden = o.format !== 'mp4';
  $('trimRow').hidden = !(o.format === 'png' && o.bg === 'transparent');
  $('trim').checked = o.trim;
  $('exportLabel').textContent = o.format === 'mp4' ? 'Export MP4' : 'Export PNG';
  $('customRow').hidden = o.frame !== 'custom';
  $('sizeRow').hidden = o.frame === 'custom';
  if (document.activeElement !== $('canvasW')) $('canvasW').value = o.cw;
  if (document.activeElement !== $('canvasH')) $('canvasH').value = o.ch;
  syncCanvasLabel();

  // Preset thumbnails follow the device shape, orientation and finish.
  for (const mini of document.querySelectorAll('.preset .mini')) {
    mini.classList.toggle('tablet', dev.kind === 'tablet');
    mini.classList.toggle('landscape', landscape());
    mini.style.setProperty('--frame', fin.frame);
  }

  const [pw, ph] = dev.px ? (landscape() ? [dev.px[1], dev.px[0]] : dev.px) : [];
  $('crumbs').innerHTML =
    `<span class="crumb strong">${escapeHTML(dev.label)}</span><span class="sep">›</span>` +
    `<span class="crumb">${landscape() ? 'Landscape' : 'Portrait'}</span><span class="sep">›</span>` +
    `<span class="crumb mono">${dev.px ? `${pw} × ${ph}` : 'Imported model'}</span>`;
  const noColour = sel().device?.custom && !sel().device.recolorable;
  $('swatches').style.opacity = noColour ? 0.35 : '';
  $('finishName').textContent = noColour ? 'This model’s colours can’t be changed' : fin.label;

  for (const id of Object.keys(PARAMS)) syncParam(id);
  syncPoseUI();
  syncCameraUI();
  syncTransport();
  syncExportSize();
}

/** Output pixel size for the current settings. */
export function syncCanvasLabel() {
  const o = out();
  $('frameLabel').textContent = o.frame === 'custom' ? `${o.cw} × ${o.ch}` : FRAMES[o.frame] ? o.frame : '';
}

export function outputSize() {
  const o = out();
  const st = $('stage');
  if (o.frame === 'custom') return [o.cw, o.ch];
  const ratio = FRAMES[o.frame];
  if (!ratio) {
    const w = st.clientWidth || 1;
    const h = st.clientHeight || 1;
    if (o.format === 'png') return [Math.round(w * o.scale), Math.round(h * o.scale)];
    const k = o.size / Math.min(w, h);
    return [Math.round(w * k), Math.round(h * k)];
  }
  const [a, b] = ratio;
  const k = o.size / Math.min(a, b);
  return [Math.round(a * k), Math.round(b * k)];
}

export function syncExportSize() {
  const o = out();
  let [w, h] = outputSize();
  if (o.format === 'mp4') {
    w = Math.round(w / 2) * 2;
    h = Math.round(h / 2) * 2;
  }
  const trimmed = o.format === 'png' && o.bg === 'transparent' && o.trim;
  $('exportSize').textContent = `${trimmed ? '≤ ' : ''}${w} × ${h}`;
  $('outFormat').textContent = o.format === 'mp4'
    ? `MP4 · H.264 · ${anim.fps} fps · ${anim.duration.toFixed(1)}s`
    : `PNG · ${o.bg === 'transparent' ? 'RGBA' : 'RGB'}`;
  const dur = $('durationv');
  if (dur && !dur.isEditing) dur.textContent = PARAMS.duration.fmt(anim.duration);
}
