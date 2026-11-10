// Projects (.m3d files)

import { getModelBuffer, storeModel } from '../custom-devices.js';
import { download } from '../exporter.js';
import { packProject, unpackProject, writeProjectFile, pickProjectFile, canWriteFiles, PROJECT_EXT } from '../project.js';
import { createAnim } from '../timeline.js';
import { play, playing, setTime } from './animation.js';
import { clearMedia, emptyTrash, syncClip, useFile } from './designs.js';
import { customHdri, setCustomHdri, setEnv, useHDRI } from './environment.js';
import { exporting } from './export.js';
import { NOT_UNDOABLE, history, restore, restoring, save, saveTimer, snapshot, syncUndoButtons } from './history.js';
import { customRec, insts, loadModel } from './instances.js';
import { renderDeviceList, setPickMode } from './models.js';
import { renderSceneList } from './scene-list.js';
import { DEFAULT_ENV, freshDefaults, recOf, state } from './state.js';
import { setStatus } from './status.js';
import { $ } from './util.js';

// The open project file (if any) and whether it has unsaved changes.
export const project = { name: 'Untitled', handle: null, dirty: false };
export function markDirty() {
  if (restoring || project.dirty) return;
  project.dirty = true;
  syncProjectUI();
}

function syncProjectUI() {
  $('projectName').textContent = project.name;
  $('dirtyDot').hidden = !project.dirty;
  $('projectBtn').title = `${project.name}${project.dirty ? ' — unsaved changes' : ''}`;
  document.title = `${project.dirty ? '• ' : ''}${project.name} — Mockup3D Studio`;
}

/** Everything a project file needs to recreate the current mockup. */
export async function collectProject() {
  if (saveTimer) save();
  const models = [];
  for (const id of new Set(state.devices.map((d) => d.model))) {
    const rec = customRec(id);
    const buffer = rec && await getModelBuffer(rec.id);
    if (buffer) models.push({ rec, buffer });
  }
  const media = [];
  for (const d of state.devices) {
    const m = insts.get(d.id)?.media;
    if (m?.file) media.push({ device: d.id, name: m.name, type: m.file.type, blob: m.file });
  }
  return {
    settings: JSON.parse(snapshot()),
    media,
    models,
    hdri: state.env === 'custom' && customHdri ? customHdri : null,
  };
}

let busyProject = false;
export async function saveProject({ saveAs = false } = {}) {
  if (busyProject || exporting) return;
  busyProject = true;
  setStatus('Saving project…', 'busy');
  try {
    const blob = await packProject(await collectProject());
    const fileName = `${project.name}${PROJECT_EXT}`;
    let saved = false;
    if (canWriteFiles) {
      try {
        const handle = await writeProjectFile(blob, fileName, saveAs ? null : project.handle);
        project.handle = handle;
        project.name = handle.name.replace(/\.m3d$/i, '');
        saved = true;
      } catch (err) {
        if (err.name === 'AbortError') {
          setStatus('Save cancelled');
          return;
        }
        console.warn('Writing the file failed; downloading instead.', err);
      }
    }
    if (!saved) download(blob, fileName); // browsers that can't write files directly
    project.dirty = false;
    syncProjectUI();
    setStatus(`${saved ? 'Saved' : 'Downloaded'} ${project.name}${PROJECT_EXT} · ${(blob.size / 1e6).toFixed(1)} MB`);
  } catch (err) {
    console.error(err);
    setStatus(`Couldn’t save the project: ${err.message}`, 'err');
  } finally {
    busyProject = false;
  }
}

const confirmDiscard = () => !project.dirty
  || window.confirm(`“${project.name}” has unsaved changes. Discard them?`);

export async function openProjectDialog() {
  if (!confirmDiscard()) return;
  try {
    const picked = await pickProjectFile();
    if (picked) return openProject(picked.file, picked.handle, { confirmed: true });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
  }
  $('projectInput').click(); // browsers without the file picker API
}

export async function openProject(file, handle = null, { confirmed = false } = {}) {
  if (!confirmed && !confirmDiscard()) return;
  setStatus(`Opening ${file.name}…`, 'busy');
  let p;
  try {
    p = await unpackProject(file);
  } catch (err) {
    setStatus(err.message, 'err');
    return;
  }
  if (playing) play(false);
  setPickMode(null);

  // Imported device models: add them (or update their setup) under their saved ids.
  for (const model of p.models) {
    const existing = customRec(model.rec.id);
    if (!existing) {
      await storeModel(model.rec.id, model.buffer);
      state.customDevices.push(model.rec);
    } else {
      Object.assign(existing, model.rec);
    }
  }
  if (p.models.length) renderDeviceList();

  // Designs go back on after the devices exist.
  for (const it of insts.values()) clearMedia(false, it.id);
  emptyTrash();
  restore(JSON.stringify(p.settings));
  // restore() only reloads models that changed; imported ones may have a new setup.
  const imported = new Set(p.models.map((m) => m.rec.id));
  await Promise.all(state.devices.filter((d) => imported.has(d.model)).map((d) => loadModel(d.id)));

  if (p.hdri) {
    await useHDRI(new File([p.hdri.blob], p.hdri.name));
  } else if (state.env === 'custom') {
    state.env = DEFAULT_ENV;
    setEnv(state.env);
  }

  for (const m of p.media) {
    // Version 1 projects had one design, for their one device.
    const target = recOf(m.device) ? m.device : state.devices[0].id;
    await useFile(new File([m.blob], m.name, { type: m.type }), { fromProject: true, target });
  }
  syncClip();
  renderSceneList();

  history.undo = [];
  history.redo = [];
  history.last = snapshot();
  syncUndoButtons();
  setTime(0);
  save();
  project.name = file.name.replace(/\.m3d$/i, '');
  project.handle = handle;
  project.dirty = false;
  syncProjectUI();
  setStatus(`Opened ${file.name}`);
}

export function newProject() {
  if (!confirmDiscard()) return;
  if (playing) play(false);
  const s = freshDefaults();
  for (const k of NOT_UNDOABLE) delete s[k];
  const a = createAnim();
  for (const it of insts.values()) clearMedia(false, it.id);
  emptyTrash();
  state.selected = s.devices[0].id;
  restore(JSON.stringify({ s, a: { duration: a.duration, fps: a.fps, loop: a.loop, tracks: {} } }));
  if (state.env !== DEFAULT_ENV) setEnv(DEFAULT_ENV);
  setCustomHdri(null);
  syncClip();
  renderSceneList();
  history.undo = [];
  history.redo = [];
  history.last = snapshot();
  syncUndoButtons();
  setTime(0);
  save();
  Object.assign(project, { name: 'Untitled', handle: null, dirty: false });
  syncProjectUI();
  setStatus('New project');
}

export function buildProjectMenu() {
  const menu = $('projectMenu');
  $('projectBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.project')) menu.hidden = true;
  });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    menu.hidden = true;
    ({ new: newProject, open: openProjectDialog, save: () => saveProject(), saveas: () => saveProject({ saveAs: true }) })[b.dataset.act]();
  });
  $('projectInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) openProject(f, null, { confirmed: true });
  });
  // The design image/video only lives in memory, so warn before losing it.
  window.addEventListener('beforeunload', (e) => {
    if (project.dirty && [...insts.values()].some((it) => it.media)) e.preventDefault();
  });
  syncProjectUI();
}
