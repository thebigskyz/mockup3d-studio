// Transport: play, jump to keyframes, loop, frame rate and timecode.

import { CAMERA, anyKeys, allKeysView, keyAt, prevKeyTime, nextKeyTime, snapTime, FPS_PRESETS, clampFps } from '../timeline.js';
import { play, playhead, playing, setTime, trackOf } from './animation.js';
import { ctx } from './ctx.js';
import { save } from './history.js';
import { anim, state } from './state.js';
import { timelineUI } from './timeline-panel.js';
import { syncControls } from './ui-sync.js';
import { $ } from './util.js';

function timecode(t, fps = anim.fps) {
  const f = Math.floor((t % 1) * fps + 1e-6);
  const s = Math.floor(t) % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return [h, m, s, f].map((x) => String(x).padStart(2, '0')).join(':');
}

$('playBtn').addEventListener('click', () => play());
$('toStart').addEventListener('click', () => setTime(0));
$('toEnd').addEventListener('click', () => setTime(anim.duration));
$('prevKey').addEventListener('click', () => setTime(prevKeyTime(allKeysView(anim), playhead)));
$('nextKey').addEventListener('click', () => setTime(nextKeyTime(allKeysView(anim), playhead)));
$('loopBtn').addEventListener('click', () => {
  anim.loop = !anim.loop;
  syncTransport();
  save();
});
function setFps(f) {
  anim.fps = clampFps(f);
  setTime(snapTime(anim, playhead));
  timelineUI.render();
  syncControls();
  save();
}
$('fpsSelect').addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    // Swap the menu for a number field until a value is entered.
    e.target.hidden = true;
    const input = $('fpsCustom');
    input.hidden = false;
    input.value = anim.fps;
    input.focus();
    input.select();
    return;
  }
  setFps(+e.target.value);
});
function closeFpsCustom(commit) {
  const input = $('fpsCustom');
  if (input.hidden) return;
  if (commit && +input.value > 0) setFps(+input.value);
  input.hidden = true;
  $('fpsSelect').hidden = false;
  syncTransport();
}
$('fpsCustom').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') closeFpsCustom(true);
  if (e.key === 'Escape') closeFpsCustom(false);
});
$('fpsCustom').addEventListener('blur', () => closeFpsCustom(true));

export function syncTransport() {
  $('timeLabel').textContent = timecode(playhead);
  $('playBtn').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('loopBtn').classList.toggle('on', anim.loop);
  // Frame-rate menu: presets, the current custom rate (if any), then Custom…
  const sel = $('fpsSelect');
  const rates = FPS_PRESETS.includes(anim.fps) ? FPS_PRESETS : [...FPS_PRESETS, anim.fps].sort((a, b) => a - b);
  const sig = rates.join(',');
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = rates.map((r) => `<option value="${r}">${r}${FPS_PRESETS.includes(r) ? '' : ' (custom)'}</option>`).join('')
      + '<option value="custom">Custom…</option>';
    sel.dataset.sig = sig;
  }
  sel.value = String(anim.fps);
  const k = keyAt(trackOf(state.selected), playhead);
  const ck = keyAt(trackOf(CAMERA), playhead);
  for (const [id, on] of [['keyBtn', k], ['camKeyBtn', ck]]) {
    $(id).classList.toggle('on', !!on);
    $(id).querySelector('use').setAttribute('href', on ? '#i-key' : '#i-key-o');
  }
  $('keyState').textContent = anyKeys(anim) ? (k ? '◆ Keyframe' : 'Animated') : '';
  timelineUI.updatePlayhead();
}

// FPS readout in the status bar.
let frames = 0;
let fpsT0 = performance.now();
ctx.onBeforeRender((now) => {
  frames++;
  if (now - fpsT0 > 1000) {
    $('fps').textContent = `${Math.round((frames * 1000) / (now - fpsT0))} fps`;
    frames = 0;
    fpsT0 = now;
  }
});
