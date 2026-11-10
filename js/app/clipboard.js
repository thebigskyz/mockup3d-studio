// Copy / paste keyframes (⌘C / ⌘V), and pasting a design (⌘V with an image).
//
// The copy goes onto the system clipboard
// as text too, so keyframes can be pasted into another project or tab.
// Device keyframes paste onto the selected device; camera keyframes onto the
// camera.

import { CAMERA, devicePose, cameraPose, hasKeys, keyAt, setKey } from '../timeline.js';
import { liveCam, play, playhead, playing, refreshPose, trackOf } from './animation.js';
import { useDesign } from './designs.js';
import { save } from './history.js';
import { deviceName, sel } from './instances.js';
import { anim, selRec, state } from './state.js';
import { setStatus } from './status.js';
import { timelineUI } from './timeline-panel.js';
import { syncTransport } from './transport.js';
import { $, isTypingTarget } from './util.js';

const KEY_CLIP = 'mockup-studio/keyframes';

/** Keyframes to copy: the selection, or the selected device's keyframe at the playhead. */
function keysToCopy() {
  let track = timelineUI.selectedTrack;
  let ids = timelineUI.selectedIds;
  if (!ids.length) {
    track = state.selected;
    const k = keyAt(trackOf(track), playhead);
    if (k) ids = [k.id];
  }
  const keys = trackOf(track).keyframes.filter((k) => ids.includes(k.id));
  if (!keys.length) return null;
  const t0 = keys[0].t;
  return {
    kind: track === CAMERA ? 'camera' : 'device',
    keys: keys.map((k) => ({ dt: +(k.t - t0).toFixed(6), pose: k.pose, ease: k.ease })),
  };
}

function parseKeyClipboard(text) {
  if (!text || !text.includes(KEY_CLIP)) return null;
  try {
    const data = JSON.parse(text);
    if (data.type !== KEY_CLIP || !Array.isArray(data.keys) || !data.keys.length) return null;
    // Keyframes copied before cameras had their own track hold zoom/fov in the device pose.
    const kind = data.kind === 'camera' ? 'camera' : 'device';
    return { kind, keys: data.keys };
  } catch {
    return null;
  }
}

window.addEventListener('copy', (e) => {
  if (isTypingTarget(e.target) || window.getSelection()?.toString()) return;
  const clip = keysToCopy();
  if (!clip) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', JSON.stringify({ type: KEY_CLIP, ...clip }));
  const n = clip.keys.length;
  setStatus(`Copied ${n} ${clip.kind === 'camera' ? 'camera ' : ''}keyframe${n === 1 ? '' : 's'} — move the playhead and press ⌘V to paste`);
});

/** Paste keyframes starting at the playhead, keeping their spacing. */
function pasteKeyframes({ kind, keys }) {
  if (playing) play(false);
  const id = kind === 'camera' ? CAMERA : state.selected;
  const tr = trackOf(id);
  const norm = kind === 'camera' ? cameraPose : devicePose;
  if (!hasKeys(tr)) {
    if (kind === 'camera') state.camera = cameraPose(liveCam);
    else selRec().pose = devicePose(sel().live);
  }
  const start = playhead;
  const ids = [];
  let clipped = 0;
  for (const k of keys) {
    const t = start + k.dt;
    if (t > anim.duration + 1e-6) { clipped++; continue; }
    ids.push(setKey(tr, t, norm(k.pose), k.ease).id);
  }
  timelineUI.render();
  timelineUI.select(ids, id);
  refreshPose();
  syncTransport();
  save();
  const onto = kind === 'camera' ? ' on the camera' : state.devices.length > 1 ? ` on ${deviceName(selRec())}` : '';
  setStatus(`Pasted ${ids.length} keyframe${ids.length === 1 ? '' : 's'} at ${start.toFixed(2)}s${onto}`
    + (clipped ? ` · ${clipped} didn’t fit before the end of the timeline` : ''));
}
window.addEventListener('paste', (e) => {
  if (isTypingTarget(e.target)) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
  if (item) {
    useDesign(item.getAsFile());
    return;
  }
  const clip = parseKeyClipboard(e.clipboardData?.getData('text/plain'));
  if (clip) {
    e.preventDefault();
    pasteKeyframes(clip);
  }
});
