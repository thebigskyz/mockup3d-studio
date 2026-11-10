// Mockup3D Studio: starts the app. The parts live in js/app/.

// Only listen for events, so nothing else imports them.
import './app/keyboard.js';
import './app/clipboard.js';
import { ENVIRONMENTS, kelvinTint, NEUTRAL_KELVIN } from './environments.js';
import { packProject } from './project.js';
import { TEMPLATES } from './templates.js';
import { MOTION_PRESETS } from './timeline.js';
import { cameraAt, liveCam, play, playhead, poseAt, refreshPose, setTime, trackOf } from './app/animation.js';
import { buildControls, frameAll } from './app/controls.js';
import { ctx } from './app/ctx.js';
import { useFile } from './app/designs.js';
import { applyBackground, applyEnvAdjust, buildEnvList, setEnv } from './app/environment.js';
import { renderAnimationMP4 } from './app/export.js';
import { history, redo, save, snapshot, syncUndoButtons, undo } from './app/history.js';
import { insts, sel, syncInstances } from './app/instances.js';
import { setParam } from './app/params.js';
import { applyMotion } from './app/presets.js';
import { buildProjectMenu, collectProject, newProject, openProject, project, saveProject } from './app/projects.js';
import { addDevice, deleteDevices, selectAll, selectSceneDevice, setSelection, syncSelection } from './app/scene-list.js';
import { applyTemplate, buildTemplatePresets } from './app/scene-templates.js';
import { DEFAULT_ENV, DEFAULT_SHADOW, anim, state } from './app/state.js';
import { initTimelineUI } from './app/timeline-panel.js';
import { syncControls } from './app/ui-sync.js';
import { $ } from './app/util.js';
import { buildZoomControl, layoutFrame } from './app/viewer.js';

initTimelineUI();
buildControls();
buildEnvList();
buildProjectMenu();
buildZoomControl();
// A custom HDRI isn't saved between visits; fall back to the bundled one.
if (!ENVIRONMENTS.some((e) => e.id === state.env)) state.env = DEFAULT_ENV;
ctx.setEnvRotation(state.envRot);
ctx.setReflectionZoom(state.reflZoom);
ctx.setEnvTint(kelvinTint(state.envTemp));
applyEnvAdjust();
ctx.setShadow(state.shadow);
setEnv(state.env);
applyBackground();
syncControls();
layoutFrame();
buildTemplatePresets();
syncInstances();
syncSelection();
refreshPose();
history.last = snapshot();
// Double-click the temperature slider to go back to the HDRI's own colours.
$('envTemp').addEventListener('dblclick', () => { setParam('envTemp', NEUTRAL_KELVIN); save(); });
$('envHighlights').addEventListener('dblclick', () => { setParam('envHighlights', 1); save(); });
$('envContrast').addEventListener('dblclick', () => { setParam('envContrast', 1); save(); });
$('reflZoom').addEventListener('dblclick', () => { setParam('reflZoom', 1); save(); });
// Double-click a camera angle to straighten it.
for (const id of ['camOrbit', 'camElev', 'camRoll']) $(id).addEventListener('dblclick', () => { setParam(id, 0); save(); });
// Double-click a shadow slider to reset it.
for (const [id, key] of [['shadowStrength', 'strength'], ['shadowSoftness', 'softness'], ['shadowDistance', 'distance'], ['shadowOffset', 'offset'], ['shadowAngle', 'angle']]) {
  $(id).addEventListener('dblclick', () => { setParam(id, DEFAULT_SHADOW[key]); save(); });
}
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
syncUndoButtons();

// Handy for debugging and tests from the console.
window.mockup = {
  ctx, state, insts, useFile, setTime, play, renderAnimationMP4, undo, redo, history, project,
  collectProject, packProject, openProject, saveProject, newProject, addDevice, deleteDevices, selectSceneDevice, setSelection, selectAll,
  applyTemplate: (id) => applyTemplate(TEMPLATES.find((t) => t.id === id)), applyMotion: (id) => applyMotion(MOTION_PRESETS.find((p) => p.id === id)),
  frameAll, trackOf, poseAt, cameraAt,
  get anim() { return anim; },
  get device() { return sel().device; },
  get playhead() { return playhead; },
  get livePose() { return sel().live; },
  get liveCam() { return liveCam; },
};
