// Project files (.m3d): a zip holding project.json plus the designs,
// imported device models and custom HDRI the project uses.

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export const PROJECT_EXT = '.m3d';
const FORMAT = 'mockup-studio-project';
const VERSION = 2; // 2: several devices, each with its own design

export const isProjectFile = (file) => /\.m3d$/i.test(file?.name || '');

const safeName = (name) => (name || 'file').replace(/[\\/:*?"<>|]+/g, '_');
const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * @param p.settings  JSON-able project settings (devices, camera, animation, look, output…)
 * @param p.media     [{ device, name, type, blob }] — each device's design image/video
 * @param p.models    [{ rec, buffer }] — imported device models + their setup
 * @param p.hdri      { name, blob } | null — custom HDRI
 */
export async function packProject({ settings, media = [], models = [], hdri }) {
  const files = {};
  const manifest = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), settings, media: [], models: [] };
  // Already-compressed files (PNG, MP4, GLB, EXR) are stored, not re-compressed.
  for (const m of media) {
    const path = `media/${safeName(m.device)}-${safeName(m.name)}`;
    files[path] = [await u8(m.blob), { level: 0 }];
    manifest.media.push({ path, device: m.device, name: m.name, type: m.type });
  }
  for (const model of models) {
    const path = `models/${safeName(model.rec.id)}.glb`;
    files[path] = [new Uint8Array(model.buffer), { level: 0 }];
    manifest.models.push({ path, rec: model.rec });
  }
  if (hdri) {
    const path = `env/${safeName(hdri.name)}`;
    files[path] = [await u8(hdri.blob), { level: 0 }];
    manifest.hdri = { path, name: hdri.name };
  }
  files['project.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

export async function unpackProject(blob) {
  let files;
  try {
    files = unzipSync(await u8(blob));
  } catch {
    throw new Error('That file isn’t a Mockup3D Studio project.');
  }
  if (!files['project.json']) throw new Error('That file isn’t a Mockup3D Studio project.');
  const manifest = JSON.parse(strFromU8(files['project.json']));
  if (manifest.format !== FORMAT) throw new Error('That file isn’t a Mockup3D Studio project.');
  if (manifest.version > VERSION) throw new Error('This project was saved by a newer version of Mockup3D Studio.');
  const get = (path) => {
    const data = files[path];
    if (!data) throw new Error(`The project is missing ${path}.`);
    return data;
  };
  // Version 1 had a single design and model (for its single device).
  const media = Array.isArray(manifest.media) ? manifest.media : manifest.media ? [{ ...manifest.media, device: null }] : [];
  const models = Array.isArray(manifest.models) ? manifest.models : manifest.model ? [manifest.model] : [];
  return {
    settings: manifest.settings,
    media: media.map((m) => ({ device: m.device, name: m.name, type: m.type, blob: new Blob([get(m.path)], { type: m.type }) })),
    models: models.map((m) => ({ rec: m.rec, buffer: get(m.path).slice().buffer })),
    hdri: manifest.hdri ? { name: manifest.hdri.name, blob: new Blob([get(manifest.hdri.path)]) } : null,
  };
}

// ---------------------------------------------------------------------------
// Saving and opening. Chrome and Edge can write back to the same file; other
// browsers download a copy instead.
// ---------------------------------------------------------------------------
export const canWriteFiles = typeof window.showSaveFilePicker === 'function';
const PICKER_TYPES = [{ description: 'Mockup3D Studio project', accept: { 'application/zip': [PROJECT_EXT] } }];

/** Write `blob` to a file handle (asking for one if needed). Returns the handle, or null if not supported. */
export async function writeProjectFile(blob, suggestedName, handle) {
  if (!canWriteFiles) return null;
  if (!handle) {
    handle = await window.showSaveFilePicker({ suggestedName, types: PICKER_TYPES });
  }
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
  return handle;
}

/** Ask for a project file. Returns { file, handle } or null when not supported. */
export async function pickProjectFile() {
  if (typeof window.showOpenFilePicker !== 'function') return null;
  const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
  return { file: await handle.getFile(), handle };
}
