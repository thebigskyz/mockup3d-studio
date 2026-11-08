// Imported device models (.glb). The file is kept in IndexedDB; the setup
// (which part is the screen, hidden parts, orientation) is a small record
// saved with the app's settings.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { idbGet, idbPut, idbDelete } from './store.js';
import { createGlassMaterial } from './glass.js';

const DEG = Math.PI / 180;
const loader = new GLTFLoader();
const sceneCache = new Map(); // id -> Promise<THREE.Object3D>
const baseName = (name) => (name || '').replace(/\.\d+$/, '');
const SCREEN_NAME = /screen|display|lcd|oled|retina/i;

export const isModelFile = (file) => /\.(glb|gltf)$/i.test(file?.name || '');

// Many .glb files online are compressed: Draco or Meshopt geometry, KTX2
// (Basis) textures. Their decoders load the first time an imported model is
// opened, so they cost nothing otherwise.
const LIBS = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/';
let renderer = null;
let decoders = null;

/** The app's renderer: KTX2 textures need to know which GPU formats it supports. */
export function setRenderer(r) {
  renderer = r;
}

function withDecoders() {
  decoders ||= (async () => {
    const [{ DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
      import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/KTX2Loader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]);
    loader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${LIBS}draco/gltf/`));
    loader.setMeshoptDecoder(MeshoptDecoder);
    if (renderer) loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(`${LIBS}basis/`).detectSupport(renderer));
  })();
  decoders.catch(() => { decoders = null; }); // offline: try again next time
  return decoders;
}

async function parse(buffer) {
  // Without the decoders (e.g. offline the first time), uncompressed models still load.
  await withDecoders().catch((err) => console.warn('Model decoders unavailable:', err));
  return new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
}

/**
 * Import a .glb (or self-contained .gltf) file. Stores it and returns a new
 * device record; the screen is filled in if a part is named like one.
 */
export async function importModelFile(file) {
  const buffer = await file.arrayBuffer();
  let gltf;
  try {
    gltf = await parse(buffer);
  } catch (err) {
    console.error(err);
    throw new Error(/\.gltf$/i.test(file.name)
      ? `Couldn’t read “${file.name}”. Export it as a single .glb file (with textures embedded).`
      : `Couldn’t read “${file.name}” as a 3D model.`);
  }
  const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await idbPut(id, buffer);
  sceneCache.set(id, Promise.resolve(gltf.scene));
  return {
    id,
    label: file.name.replace(/\.(glb|gltf)$/i, ''),
    fix: [0, 0, 0],
    screen: findScreen(gltf.scene),
    hidden: [],
  };
}

/** The stored .glb bytes of an imported model (for saving into a project). */
export const getModelBuffer = (id) => idbGet(id);

/** Store a model that came from a project file under its saved id. */
export async function storeModel(id, buffer) {
  sceneCache.delete(id);
  await idbPut(id, buffer);
}

export async function deleteModel(id) {
  sceneCache.delete(id);
  await idbDelete(id);
}

/** A part reference: path of child indices from the model root, plus a material group. */
function pathOf(obj, model) {
  const path = [];
  for (let o = obj; o && o !== model; o = o.parent) {
    if (!o.parent) return null;
    path.unshift(o.parent.children.indexOf(o));
  }
  return path;
}
function byPath(model, path) {
  let o = model;
  for (const i of path || []) {
    o = o?.children[i];
  }
  return o || null;
}

/** Look for a part named like a screen (by material, then by object name); biggest wins. */
function findScreen(model) {
  let best = null;
  let bestArea = 0;
  model.updateMatrixWorld(true);
  model.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((m, gi) => {
      const named = SCREEN_NAME.test(baseName(m?.name)) || (mats.length === 1 && SCREEN_NAME.test(obj.name));
      if (!named) return;
      const box = new THREE.Box3().setFromObject(obj);
      const s = box.getSize(new THREE.Vector3());
      const area = Math.max(s.x * s.y, s.y * s.z, s.x * s.z);
      if (area > bestArea) {
        bestArea = area;
        best = { mesh: pathOf(obj, model), group: Array.isArray(obj.material) ? gi : null };
      }
    });
  });
  return best;
}

/** Load a custom device record into a scene-ready device object. */
export async function loadCustomDevice(rec) {
  if (!sceneCache.has(rec.id)) {
    const p = idbGet(rec.id).then((buf) => {
      if (!buf) throw new Error('This imported model is no longer stored in the browser. Import it again.');
      return parse(buf).then((g) => g.scene);
    });
    sceneCache.set(rec.id, p);
    p.catch(() => sceneCache.delete(rec.id));
  }
  return buildDevice(await sceneCache.get(rec.id), rec);
}

function buildDevice(source, rec) {
  const model = source.clone(true);
  // Materials are shared with the cached source; clone so changes stay local.
  model.traverse((o) => {
    if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
  });

  // Orientation fix, then centre the model on the origin.
  const fix = new THREE.Group();
  fix.rotation.set(rec.fix[0] * DEG, rec.fix[1] * DEG, rec.fix[2] * DEG);
  fix.add(model);
  const root = new THREE.Group();
  root.add(fix);
  root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(fix).getCenter(new THREE.Vector3());
  fix.position.sub(center);
  root.updateMatrixWorld(true);

  const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
  const hidePart = ({ mesh, group }) => {
    const obj = byPath(model, mesh);
    if (!obj?.isMesh) return;
    if (group == null || !Array.isArray(obj.material)) obj.visible = false;
    else obj.material[group] = hiddenMat;
  };
  for (const h of rec.hidden || []) hidePart(h);

  // Screen: copy its triangles into a new mesh with UVs projected flat onto
  // the screen, then hide the original part.
  const screenMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  // Glass over the screen, as on the built-in models: Glare and the HDRI
  // reflection (see glass.js).
  const glassMaterial = createGlassMaterial();
  let glass = null;
  let info = null;
  let facing = true;
  const target = rec.screen && byPath(model, rec.screen.mesh);
  if (target?.isMesh) {
    const res = extractScreen(target, rec.screen.group, rec.screen.seed, root, screenMaterial);
    if (res) {
      root.add(res.mesh);
      info = res.info;
      facing = res.facing;
      // Just the flat area of a bigger part: the rest of the part stays,
      // and the screen sits a little above it.
      if (!res.partial) hidePart(rec.screen);
      glass = new THREE.Mesh(res.mesh.geometry.clone().translate(...res.lift.toArray()), glassMaterial);
      glass.userData.generatedScreen = true;
      glass.renderOrder = 1;
      root.add(glass);
    }
  }

  // Recolourable parts, if the model follows the built-in naming.
  const parts = { frame: [], back: [], accent: [] };
  model.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    const role = { Frame: 'frame', BackPanel: 'back', FrameAccent: 'accent' }[baseName(o.material.name)];
    if (role) parts[role].push(o);
  });

  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());

  return {
    id: rec.id,
    root,
    model,
    info,
    facing,
    radius: sphere.radius || 0.1,
    screenMaterial,
    glassMaterial,
    custom: true,
    recolorable: parts.frame.length + parts.back.length + parts.accent.length > 0,
    setFinish(f) {
      for (const m of parts.frame) m.material.color.set(f.frame);
      for (const m of parts.back) m.material.color.set(f.back);
      for (const m of parts.accent) m.material.color.set(f.accent);
    },
    setGlare(v) {
      glassMaterial.uniforms.reflectance.value = v;
      if (glass) glass.visible = v > 0;
    },
    setIsland() {},
    hasIsland: false,
    /** Turn a raycast hit into a stored part reference (null if it's not part of the model). */
    partRef(hit) {
      if (hit.object.userData.generatedScreen) return { screen: true };
      const path = pathOf(hit.object, model);
      if (!path) return null;
      const group = Array.isArray(hit.object.material) ? hit.face?.materialIndex ?? null : null;
      // The clicked triangle: if the part is more than a screen (a phone
      // modelled in one piece), the screen is the flat area around it.
      return { mesh: path, group, seed: hit.faceIndex ?? null };
    },
  };
}

/**
 * Copy the screen's triangles (a whole mesh, or one material group) into a
 * new mesh in device space, with UVs spanning 0..1 across its flat extent
 * (u left→right, v top→bottom as seen from the front).
 *
 * `seed` is the triangle that was clicked to pick the screen. When the part
 * is much more than a screen (a phone modelled as one piece, one material),
 * only the flat area connected to that triangle is used: `partial` is then
 * true and the original part should stay visible.
 */
function extractScreen(mesh, group, seed, root, material) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return null;
  const index = geo.index;
  let start = 0;
  let count = index ? index.count : pos.count;
  if (group != null && geo.groups.length) {
    const g = geo.groups.find((x) => x.materialIndex === group);
    if (!g) return null;
    start = g.start;
    count = Math.min(g.count, (index ? index.count : pos.count) - g.start);
  }
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);

  // Every triangle of the part, in device space.
  const tris = Math.floor(count / 3);
  const all = new Float32Array(tris * 9);
  const v = new THREE.Vector3();
  for (let i = 0; i < tris * 3; i++) {
    const vi = index ? index.getX(start + i) : start + i;
    v.fromBufferAttribute(pos, vi).applyMatrix4(toRoot);
    all[i * 3] = v.x;
    all[i * 3 + 1] = v.y;
    all[i * 3 + 2] = v.z;
  }
  if (!tris) return null;

  let keep = null; // triangle numbers to use (null = all)
  const local = seed == null ? -1 : seed - start / 3;
  if (local >= 0 && local < tris) {
    const region = flatRegion(all, tris, local);
    if (region.length < tris * 0.9) keep = region;
  }
  const verts = keep ? new Float32Array(keep.length * 9) : all;
  if (keep) keep.forEach((t, k) => verts.set(all.subarray(t * 9, t * 9 + 9), k * 9));

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  out.computeBoundingBox();
  const bb = out.boundingBox;
  const size = bb.getSize(new THREE.Vector3());

  // The screen's normal is its thinnest axis; project onto the other two.
  const axes = ['x', 'y', 'z'];
  const n = axes.reduce((a, b) => (size[b] < size[a] ? b : a), 'z');
  const uAxis = n === 'x' ? 'z' : 'x';
  const vAxis = n === 'y' ? 'z' : 'y';
  // Which way does it face? (average triangle normal along the thin axis)
  out.computeVertexNormals();
  const normals = out.attributes.normal;
  let sum = 0;
  for (let i = 0; i < normals.count; i++) sum += normals.array[i * 3 + axes.indexOf(n)];
  const sign = sum >= 0 ? 1 : -1;

  // Lift it a hair off the original surface (more when the original stays
  // visible underneath, so the two never flicker through each other).
  const big = Math.max(size.x, size.y, size.z);
  const lift = new THREE.Vector3();
  lift[n] = sign * big * (keep ? 0.002 : 0.0005);

  const w = size[uAxis] || 1;
  const h = size[vAxis] || 1;
  const p = out.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let u = (v[uAxis] - bb.min[uAxis]) / w;
    // Mirror u for a screen seen from the negative side, so the design isn't flipped.
    if ((n === 'z' && sign < 0) || (n === 'x' && sign > 0) || (n === 'y' && sign > 0)) u = 1 - u;
    const vv = vAxis === 'y' ? (bb.max.y - v.y) / h : (v[vAxis] - bb.min[vAxis]) / h;
    uv[i * 2] = u;
    uv[i * 2 + 1] = vv;
    v.add(lift);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const screen = new THREE.Mesh(out, material);
  screen.userData.generatedScreen = true;
  return {
    mesh: screen,
    info: { screenW: w, screenH: h },
    facing: n === 'z' && sign > 0, // true when the screen faces the camera at the Front angle
    partial: !!keep,
    // How far to lift a glass layer above the screen.
    lift: lift.clone().multiplyScalar(keep ? 0.25 : 1),
  };
}

// A screen is flat: grow from the clicked triangle across neighbours that
// face (nearly) the same way, stopping at bevels and at the rounded frame.
const MAX_TILT = Math.cos(30 * DEG); // from the clicked triangle
const MAX_STEP = Math.cos(15 * DEG); // between neighbours

/** Triangle numbers of the flat area connected to triangle `seed`. */
function flatRegion(all, tris, seed) {
  // Normals.
  const normals = new Float32Array(tris * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromArray(all, t * 9);
    b.fromArray(all, t * 9 + 3);
    c.fromArray(all, t * 9 + 6);
    b.sub(a);
    c.sub(a);
    b.cross(c);
    const len = b.length();
    if (len > 0) b.divideScalar(len);
    normals.set([b.x, b.y, b.z], t * 3);
  }
  // Neighbours share an edge. Vertices are matched by position (models
  // often duplicate vertices along UV seams and hard edges).
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of all) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  const q = 1e5 / ((hi - lo) || 1);
  const key = (i) => `${Math.round(all[i] * q)},${Math.round(all[i + 1] * q)},${Math.round(all[i + 2] * q)}`;
  const ids = new Map();
  const vid = new Int32Array(tris * 3);
  for (let i = 0; i < tris * 3; i++) {
    const k = key(i * 3);
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    vid[i] = id;
  }
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    for (let e = 0; e < 3; e++) {
      const p = vid[t * 3 + e];
      const r = vid[t * 3 + ((e + 1) % 3)];
      const k = p < r ? `${p}_${r}` : `${r}_${p}`;
      const list = edges.get(k);
      if (list) list.push(t);
      else edges.set(k, [t]);
    }
  }
  const dot = (s, t) => normals[s * 3] * normals[t * 3] + normals[s * 3 + 1] * normals[t * 3 + 1] + normals[s * 3 + 2] * normals[t * 3 + 2];
  const flat = (t) => normals[t * 3] || normals[t * 3 + 1] || normals[t * 3 + 2]; // not degenerate

  const seen = new Uint8Array(tris);
  const region = [seed];
  seen[seed] = 1;
  for (let i = 0; i < region.length; i++) {
    const t = region[i];
    for (let e = 0; e < 3; e++) {
      const p = vid[t * 3 + e];
      const r = vid[t * 3 + ((e + 1) % 3)];
      for (const nb of edges.get(p < r ? `${p}_${r}` : `${r}_${p}`)) {
        if (seen[nb]) continue;
        // Degenerate slivers join their neighbours without judging the angle.
        if (flat(nb) && flat(t) && (dot(nb, seed) < MAX_TILT || dot(nb, t) < MAX_STEP)) continue;
        seen[nb] = 1;
        region.push(nb);
      }
    }
  }
  return region;
}
