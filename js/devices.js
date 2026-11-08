import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createGlassMaterial } from './glass.js';

export const DEVICES = [
  { id: 'iphone-18-pro', label: 'iPhone 18 Pro', kind: 'phone', island: true, px: [1206, 2622], size: '6.3″' },
  { id: 'ipad-pro-11', label: 'iPad Pro 11″', kind: 'tablet', island: false, px: [1668, 2420], size: '11″' },
];

// frame = sides, back = back panel / camera plateau, accent = trims and lens rings.
export const FINISHES = [
  { id: 'black', label: 'Black', frame: '#2c2c2f', back: '#333337', accent: '#18181a' },
  { id: 'silver', label: 'Silver', frame: '#d6d7da', back: '#e3e4e7', accent: '#9fa0a4' },
  { id: 'grey', label: 'Grey', frame: '#6e6f74', back: '#7b7c81', accent: '#45464a' },
];

const loader = new GLTFLoader();
const WHITE = new THREE.Color(1, 1, 1);
const cache = new Map();

// Blender keeps names unique by adding ".001" etc.; ignore that suffix.
const baseName = (name) => (name || '').replace(/\.\d+$/, '');

/**
 * A loaded device: the model plus handles on the parts the app changes.
 */
export async function loadDevice(id) {
  if (!cache.has(id)) {
    cache.set(id, loader.loadAsync(`models/${id}.glb`));
  }
  const gltf = await cache.get(id);
  const root = gltf.scene.clone(true);

  const info = findExtras(gltf.scene);
  const parts = { screen: [], glass: [], island: [], frame: [], back: [], accent: [], backGlass: [], logo: [] };

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const name = baseName(obj.material?.name);
    const role = {
      Screen: 'screen', Glass: 'glass', IslandBlack: 'island',
      Frame: 'frame', BackPanel: 'back', FrameAccent: 'accent',
      BackGlass: 'backGlass', Logo: 'logo',
    }[name];
    if (!role) return;
    if (role !== 'screen') obj.material = obj.material.clone(); // per-instance colours
    parts[role].push(obj);
  });

  // Screen: unlit so the design keeps its exact colours.
  const screenMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  for (const m of parts.screen) m.material = screenMaterial;

  // Glass: a sharp reflection of the environment; "Glare" is how reflective
  // it is straight on (see glass.js).
  const glassMaterial = createGlassMaterial();
  for (const m of parts.glass) m.material = glassMaterial;

  const box = new THREE.Box3().setFromObject(root);
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  return {
    id,
    root,
    info,
    radius: sphere.radius,
    screenMaterial,
    glassMaterial,

    setFinish(finish) {
      for (const m of parts.frame) m.material.color.set(finish.frame);
      for (const m of parts.back) m.material.color.set(finish.back);
      for (const m of parts.accent) m.material.color.set(finish.accent);
      // MagSafe panel: frosted glass, a little lighter than the back.
      // Logo: polished, in the back's colour.
      for (const m of parts.backGlass) m.material.color.set(finish.back).lerp(WHITE, 0.04);
      for (const m of parts.logo) m.material.color.set(finish.back);
    },
    setLogo(on) {
      for (const m of parts.logo) m.visible = on;
    },
    hasLogo: parts.logo.length > 0,
    setGlare(v) {
      glassMaterial.uniforms.reflectance.value = v;
      for (const m of parts.glass) m.visible = v > 0;
    },
    setIsland(on) {
      for (const m of parts.island) m.visible = on;
    },
    hasIsland: parts.island.length > 0,
  };
}

function findExtras(scene) {
  let info = null;
  scene.traverse((o) => {
    if (!info && o.userData && o.userData.screenW) info = o.userData;
  });
  return info;
}

/**
 * Fit a texture "cover"-style onto the screen, rotating it for landscape.
 * Screen UVs run 0..1 across the portrait display, with v = 0 at the top.
 */
export function fitTexture(texture, imgW, imgH, info, landscape) {
  let W = info.screenW;
  let H = info.screenH;
  if (landscape) [W, H] = [H, W];
  const s = Math.max(W / imgW, H / imgH);
  texture.center.set(0.5, 0.5);
  texture.offset.set(0, 0);
  texture.repeat.set(W / (s * imgW), H / (s * imgH));
  texture.rotation = landscape ? Math.PI / 2 : 0;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
}
