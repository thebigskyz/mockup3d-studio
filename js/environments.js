// HDRI environments: built-in list plus loading .exr / .hdr files.

import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export const ENVIRONMENTS = [
  // Rendered by blender/build_hdri.py.
  { id: 'studio-panels', label: 'Studio panels', note: 'Dark studio, big softboxes · 4K', file: 'env/studio-panels.exr' },
];

const cache = new Map();

export const isHDRFile = (file) => /\.(exr|hdr)$/i.test(file?.name || '');

function loaderFor(name) {
  return /\.hdr$/i.test(name) ? new RGBELoader() : new EXRLoader();
}

async function loadURL(url, name) {
  const loader = loaderFor(name).setDataType(THREE.HalfFloatType);
  const tex = await loader.loadAsync(url);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

/** Load a built-in environment's equirect texture (null for the procedural studio). */
export async function loadEnvironment(id) {
  const env = ENVIRONMENTS.find((e) => e.id === id);
  if (!env?.file) return null;
  if (!cache.has(id)) {
    const p = loadURL(env.file, env.file);
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return cache.get(id);
}

/** Load a dropped or chosen .exr / .hdr file. */
export async function loadEnvironmentFile(file) {
  const url = URL.createObjectURL(file);
  try {
    return await loadURL(url, file.name);
  } catch (err) {
    console.error(err);
    throw new Error(`Couldn’t read “${file.name}” as an HDRI.`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Colour temperature
// ---------------------------------------------------------------------------
export const NEUTRAL_KELVIN = 6500;

// Approximate RGB (0..1, sRGB) of a black body at `kelvin` (Tanner Helland's fit).
function kelvinRGB(kelvin) {
  const t = kelvin / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255);
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Linear RGB multiplier that shifts light to `kelvin`, relative to 6500 K
 * (= no change). Lower is warmer/orange, higher is cooler/blue. Brightness
 * is kept roughly constant.
 */
export function kelvinTint(kelvin) {
  const c = kelvinRGB(kelvin).map(toLinear);
  const n = kelvinRGB(NEUTRAL_KELVIN).map(toLinear);
  const rgb = c.map((v, i) => v / n[i]);
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return rgb.map((v) => v / lum);
}
