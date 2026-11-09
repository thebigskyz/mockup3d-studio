import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { glassEnv } from './glass.js';

const DEG = Math.PI / 180;

/**
 * Renderer, camera, lights and the devices. Each device has a slot:
 *   scene > pivot (pose: rotation, position, scale) > orient (portrait/landscape) > device model
 * Positions are in scene units (metres per unit set by setUnit, normally the
 * size of the scene's largest device), so layouts and motion look the same
 * whatever models are used. Without a set unit it follows the largest device.
 */
export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,                 // transparent background for PNG export
    preserveDrawingBuffer: true, // lets us read the canvas after rendering
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  let reflectionZoom = 1; // glass reflection magnification on top of the lens compensation
  let hdri = null;        // equirect texture of the current HDRI (null = built-in studio)
  let envRT = null;       // prefiltered (PMREM) environment used for lighting
  let procRT = null;      // adjusted copy of the environment (tint, highlights, contrast)
  let bgSource = null;    // what the "HDRI" background shows
  let tint = new THREE.Color(1, 1, 1);
  let adjust = { contrast: 1, highlights: 0 };
  let lightLevel = 1;

  // ---- full-screen passes (they stay in linear HDR) ---------------------
  const passScene = new THREE.Scene();
  const passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const passQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  passScene.add(passQuad);
  const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  // Colour temperature, then "Highlights" and "Contrast", both relative to
  // the environment's own average brightness so they act alike on any HDRI.
  const adjustMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null }, tint: { value: new THREE.Color() },
      avg: { value: 0.25 }, contrast: { value: 1 }, highlights: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: `
      uniform sampler2D map; uniform vec3 tint; uniform float avg, contrast, highlights;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(map, vUv).rgb * tint;
        float L = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6);
        float n = L / avg;
        // Highlights: squeeze everything brighter than 2x the average
        // (windows, softboxes) towards it. These few bright spots give the
        // white glare and most of the light.
        const float knee = 2.0;
        if (n > knee) n = knee + (n - knee) / (1.0 + highlights * (n - knee));
        // Contrast around the average: < 1 softer, > 1 punchier.
        n = pow(n, contrast);
        gl_FragColor = vec4(c * (n * avg / L), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  // Cube map -> equirect, so the built-in studio can be adjusted the same way.
  const equirectMat = new THREE.ShaderMaterial({
    uniforms: { cube: { value: null } },
    vertexShader: VERT,
    fragmentShader: `
      uniform samplerCube cube; varying vec2 vUv;
      void main() {
        float phi = (vUv.x - 0.5) * 6.28318530718;
        float theta = (vUv.y - 0.5) * 3.14159265359;
        vec3 dir = vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));
        gl_FragColor = vec4(textureCube(cube, dir).rgb, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });

  function runPass(material, target) {
    passQuad.material = material;
    const prev = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target);
    renderer.render(passScene, passCam);
    renderer.setRenderTarget(prev);
    renderer.toneMapping = prevTone;
  }

  function equirectTarget(width, height, type = THREE.HalfFloatType) {
    const rt = new THREE.WebGLRenderTarget(width, height, {
      type, depthBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    rt.texture.mapping = THREE.EquirectangularReflectionMapping;
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return rt;
  }

  // The built-in studio, rendered once into an equirect image.
  let studio = null;
  function studioEquirect() {
    if (studio) return studio.texture;
    const room = new RoomEnvironment();
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(0.1, 100, cubeRT);
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    cubeCam.update(renderer, room);
    renderer.toneMapping = prevTone;
    const rt = equirectTarget(1024, 512, THREE.FloatType);
    equirectMat.uniforms.cube.value = cubeRT.texture;
    runPass(equirectMat, rt);
    cubeRT.dispose();
    room.dispose();
    studio = { texture: rt.texture, avg: averageOfTarget(rt) };
    return studio.texture;
  }

  // Log-average brightness ("typical" brightness, not skewed by hot spots).
  const avgCache = new WeakMap();
  function logAverage(get, count) {
    let sum = 0;
    for (let i = 0; i < count; i++) sum += Math.log(get(i) + 1e-4);
    return Math.max(1e-3, Math.exp(sum / count));
  }
  function averageOfData(tex) {
    if (avgCache.has(tex)) return avgCache.get(tex);
    const { data, width, height } = tex.image;
    const half = data instanceof Uint16Array;
    const f = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
    const stride = 8;
    const pts = [];
    for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) pts.push((y * width + x) * 4);
    const avg = logAverage((i) => {
      const k = pts[i];
      return 0.2126 * f(data[k]) + 0.7152 * f(data[k + 1]) + 0.0722 * f(data[k + 2]);
    }, pts.length);
    avgCache.set(tex, avg);
    return avg;
  }
  function averageOfTarget(rt) {
    const buf = new Float32Array(rt.width * rt.height * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    const n = rt.width * rt.height;
    return logAverage((i) => 0.2126 * buf[i * 4] + 0.7152 * buf[i * 4 + 1] + 0.0722 * buf[i * 4 + 2], n);
  }

  const isNeutral = () =>
    Math.abs(tint.r - 1) + Math.abs(tint.g - 1) + Math.abs(tint.b - 1) < 0.003
    && Math.abs(adjust.contrast - 1) < 1e-3 && adjust.highlights < 1e-3;

  function adjusted(base, avg) {
    if (isNeutral()) return base;
    const { width, height } = base.image;
    // A new target every time: three.js caches the background's cube
    // conversion per texture, so reusing one would keep the old look.
    procRT?.dispose();
    procRT = equirectTarget(width, height);
    const u = adjustMat.uniforms;
    u.map.value = base;
    u.tint.value.copy(tint);
    u.avg.value = avg;
    u.contrast.value = adjust.contrast;
    u.highlights.value = adjust.highlights;
    runPass(adjustMat, procRT);
    return procRT.texture;
  }

  function rebuildEnvironment() {
    envRT?.dispose();
    const base = hdri || studioEquirect();
    const avg = hdri ? averageOfData(hdri) : studio.avg;
    const src = adjusted(base, avg);
    envRT = pmrem.fromEquirectangular(src);
    bgSource = src;
    glassEnv.map.value = src; // the glass reflects the full-resolution image
    scene.environment = envRT.texture;
    key.color.copy(tint);
    rim.color.copy(tint);
    setLight(lightLevel);
    applyBackground(container.clientWidth, container.clientHeight);
  }

  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(-1.5, 2.5, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(2, 1, -2);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);

  // ---- device slots -----------------------------------------------------
  const slots = new Map(); // id -> { pivot, orient, root, radius, pose, outline }
  let unit = 0.1;          // metres per scene unit
  let cam = { fov: 30, zoom: 1, pan: [0, 0], orbit: [0, 0, 0] };
  let selectedIds = new Set();
  let outlineOn = false;

  const outlineMat = new THREE.LineBasicMaterial({ color: 0x4b8dff, transparent: true, opacity: 0.85, depthTest: false });

  function addSlot(id) {
    if (slots.has(id)) return;
    const pivot = new THREE.Group();
    pivot.rotation.order = 'XYZ';
    const orient = new THREE.Group();
    pivot.add(orient);
    scene.add(pivot);
    slots.set(id, { pivot, orient, root: null, radius: 0, pose: { rot: [0, 0, 0], pos: [0, 0, 0], scale: 1 }, outline: null, cast: true });
  }

  function removeSlot(id) {
    const s = slots.get(id);
    if (!s) return;
    scene.remove(s.pivot);
    s.outline?.geometry.dispose();
    slots.delete(id);
    updateUnit();
  }

  /** Put a loaded model in a slot (replacing the previous one). */
  function setSlotModel(id, root, radius) {
    const s = slots.get(id);
    if (!s) return;
    if (s.root) s.orient.remove(s.root);
    if (s.outline) {
      s.orient.remove(s.outline);
      s.outline.geometry.dispose();
      s.outline = null;
    }
    s.root = root;
    s.radius = radius;
    if (root) {
      // Selection outline: the model's box, turning with it. Never exported.
      const parent = root.parent;
      parent?.remove(root);
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      s.size = box.getSize(new THREE.Vector3());
      const size = s.size.clone().multiplyScalar(1.04).addScalar(radius * 0.02);
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z));
      const outline = new THREE.LineSegments(geo, outlineMat);
      outline.position.copy(box.getCenter(new THREE.Vector3()));
      outline.renderOrder = 999;
      outline.raycast = () => {};
      s.outline = outline;
      s.orient.add(root, outline);
      castShadows(root, s.cast);
    }
    updateOutlines();
    updateUnit();
  }

  /** Whether a device casts a shadow (Inspector › Shadow). */
  function setSlotShadow(id, on) {
    const s = slots.get(id);
    if (!s) return;
    s.cast = on;
    if (s.root) castShadows(s.root, on);
  }

  function setSlotLandscape(id, on) {
    const s = slots.get(id);
    if (!s) return;
    s.landscape = on;
    s.orient.rotation.z = on ? Math.PI / 2 : 0;
  }

  /** A device's width and height facing the camera, in scene units at scale 1. */
  function slotSize(id) {
    const s = slots.get(id);
    if (!s?.size) return null;
    const w = s.size.x / unit;
    const h = s.size.y / unit;
    const d = s.size.z / unit; // thickness
    return s.landscape ? { w: h, h: w, d } : { w, h, d };
  }

  function place(s) {
    const p = s.pose;
    s.pivot.rotation.set(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG);
    s.pivot.position.set(p.pos[0] * unit, p.pos[1] * unit, (p.pos[2] || 0) * unit);
    s.pivot.scale.setScalar(p.scale ?? 1);
  }

  function setSlotPose(id, pose) {
    const s = slots.get(id);
    if (!s) return;
    s.pose = { rot: [...pose.rot], pos: [...pose.pos], scale: pose.scale ?? 1 };
    place(s);
  }

  let fixedUnit = null;
  const maxRadius = () => {
    let r = 0;
    for (const s of slots.values()) if (s.root) r = Math.max(r, s.radius);
    return r;
  };
  function updateUnit() {
    const r = fixedUnit || maxRadius();
    if (!r) return;
    unit = r;
    for (const s of slots.values()) place(s);
    frame();
  }

  /** Fix the scene unit (metres), or null to follow the largest device. */
  function setUnit(u) {
    fixedUnit = u > 0 ? u : null;
    updateUnit();
  }

  /** Outline these devices (one id or several). */
  function setSelected(ids) {
    selectedIds = new Set(Array.isArray(ids) ? ids : [ids]);
    updateOutlines();
  }
  /** Show or hide the selection outline (hidden while nothing is selected). */
  function setOutlineEnabled(on) {
    outlineOn = on;
    updateOutlines();
  }
  function updateOutlines() {
    for (const [id, s] of slots) if (s.outline) s.outline.visible = outlineOn && selectedIds.has(id);
  }

  /**
   * Where a device appears on the canvas: the extent of its visible geometry
   * in normalised device coordinates (-1..1 across the frame), or null.
   */
  const ndcPoint = new THREE.Vector3();
  function slotBoundsNdc(id) {
    const s = slots.get(id);
    if (!s?.root) return null;
    scene.updateMatrixWorld(true);
    const shown = (o) => { for (; o && o !== s.pivot; o = o.parent) if (!o.visible) return false; return true; };
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    s.root.traverse((o) => {
      if (!o.isMesh || !shown(o)) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        ndcPoint.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).project(camera);
        if (ndcPoint.x < b.minX) b.minX = ndcPoint.x;
        if (ndcPoint.x > b.maxX) b.maxX = ndcPoint.x;
        if (ndcPoint.y < b.minY) b.minY = ndcPoint.y;
        if (ndcPoint.y > b.maxY) b.maxY = ndcPoint.y;
      }
    });
    return Number.isFinite(b.minX) ? b : null;
  }

  /** The device under a point (normalised device coordinates), or null. */
  const pickRay = new THREE.Raycaster();
  function pickSlot(ndc) {
    scene.updateMatrixWorld(true);
    pickRay.setFromCamera(ndc, camera);
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    let best = null;
    for (const [id, s] of slots) {
      if (!s.root) continue;
      const hit = pickRay.intersectObject(s.root, true).find((h) => {
        if (!shown(h.object)) return false;
        const m = Array.isArray(h.object.material) ? h.object.material[h.face?.materialIndex ?? 0] : h.object.material;
        return m && m.visible !== false;
      });
      if (hit && (!best || hit.distance < best.distance)) best = { id, distance: hit.distance };
    }
    return best?.id ?? null;
  }

  /**
   * Camera zoom and pan that fit every device in view (at their current
   * poses, with a small margin), keeping the current lens.
   */
  function fitAll() {
    scene.updateMatrixWorld(true); // poses may have changed since the last frame
    // Measure in the camera's own frame (across, up, towards it), so this
    // works whichever way the camera is orbited.
    const toCam = orbitQuat().invert();
    const box = new THREE.Box3();
    const world = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (const s of slots.values()) {
      if (!s.root) continue;
      world.setFromObject(s.root);
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? world.max.x : world.min.x, i & 2 ? world.max.y : world.min.y, i & 4 ? world.max.z : world.min.z);
        box.expandByPoint(corner.applyQuaternion(toCam));
      }
    }
    if (box.isEmpty()) return { zoom: 1, pan: [0, 0] };
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const vfov = cam.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const need = Math.max((size.x / 2) / Math.tan(hfov / 2), (size.y / 2) / Math.tan(vfov / 2)) * 1.1 + box.max.z;
    const base = (unit * 1.08) / Math.sin(Math.min(vfov, hfov) / 2);
    return { zoom: base / Math.max(need, unit * 0.05), pan: [c.x / unit, c.y / unit] };
  }

  /** Where a scene-unit point (x, y, depth) appears, in normalised device coordinates. */
  function project(p) {
    const v = new THREE.Vector3(p[0] * unit, p[1] * unit, (p[2] || 0) * unit).project(camera);
    return [v.x, v.y];
  }
  /**
   * A position (scene units) moved across the screen by (dx, dy) in
   * normalised device coordinates, staying the same distance from the
   * camera, so it follows the pointer whichever way the camera faces.
   */
  function screenMove(pos, dx, dy) {
    camera.updateMatrixWorld();
    const p = new THREE.Vector3(pos[0], pos[1], pos[2] || 0).multiplyScalar(unit);
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const d = Math.max(p.clone().sub(camera.position).dot(dir), camera.near);
    const h = (2 * d * Math.tan((camera.fov * DEG) / 2)) / camera.zoom;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    p.addScaledVector(right, (dx * h * camera.aspect) / 2).addScaledVector(up, (dy * h) / 2).divideScalar(unit);
    return [p.x, p.y, p.z];
  }
  /** Unit vector from the scene towards the camera. */
  function towardsCamera() {
    camera.updateMatrixWorld();
    return camera.getWorldDirection(new THREE.Vector3()).negate();
  }

  // ---- background -------------------------------------------------------
  let bg = { mode: 'transparent', c1: '#101014', c2: '#3a2a5a', angle: 135, blur: 0 };
  let bgTexture = null;

  function gradientTexture(w, h) {
    const scale = 512 / Math.max(w, h);
    const cw = Math.max(2, Math.round(w * scale));
    const ch = Math.max(2, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const g = c.getContext('2d');
    const a = (bg.angle - 90) * DEG; // CSS-style: 0deg = to top, 90deg = to right
    const len = (Math.abs(cw * Math.cos(a)) + Math.abs(ch * Math.sin(a))) / 2;
    const cx = cw / 2;
    const cy = ch / 2;
    const grad = g.createLinearGradient(cx - Math.cos(a) * len, cy - Math.sin(a) * len, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    grad.addColorStop(0, bg.c1);
    grad.addColorStop(1, bg.c2);
    g.fillStyle = grad;
    g.fillRect(0, 0, cw, ch);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function applyBackground(w, h) {
    bgTexture?.dispose();
    bgTexture = null;
    if (bg.mode === 'solid') {
      scene.background = new THREE.Color(bg.c1);
    } else if (bg.mode === 'gradient') {
      bgTexture = gradientTexture(w, h);
      scene.background = bgTexture;
    } else if (bg.mode === 'hdri') {
      // Blurriness 0 samples the full-resolution image; anything above uses
      // the lower-resolution prefiltered copy.
      scene.background = bg.blur > 0.001 ? envRT.texture : bgSource;
      scene.backgroundBlurriness = bg.blur > 0.001 ? bg.blur : 0;
    } else {
      scene.background = null;
    }
  }

  function setBackground(next) {
    bg = { ...bg, ...next };
    applyBackground(container.clientWidth, container.clientHeight);
  }

  // ---- camera / pose ----------------------------------------------------
  // When the viewer canvas is zoomed, render at a matching resolution so it
  // stays sharp (capped to keep the canvas a sensible size).
  let displayScale = 1;
  function pixelRatioFor(w, h) {
    const want = Math.min(window.devicePixelRatio, 2) * displayScale;
    return Math.max(0.25, Math.min(want, 4096 / Math.max(w, h)));
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(pixelRatioFor(w, h));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (bg.mode === 'gradient') applyBackground(w, h);
    frame();
  }

  // Place the camera so one scene unit (the largest device) fills the view
  // at zoom 1, whatever the lens; pan moves it sideways.
  // The camera's turn: orbit around the vertical axis, then elevation (up
  // is positive: it looks down), then roll around its own view.
  function orbitQuat() {
    const [orbit, elevation, roll] = cam.orbit || [0, 0, 0];
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(-elevation * DEG, orbit * DEG, roll * DEG, 'YXZ'));
  }
  function frame() {
    camera.fov = cam.fov;
    const vfov = cam.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const fit = Math.min(vfov, hfov);
    const dist = (unit * 1.08) / Math.sin(fit / 2) / cam.zoom;
    // Pan slides the camera across its own view; the orbit swings it around
    // the scene's centre. With no orbit this is a camera straight down -z.
    const q = orbitQuat();
    aim.target.set(cam.pan[0] * unit, cam.pan[1] * unit, 0).applyQuaternion(q);
    aim.back.set(0, 0, 1).applyQuaternion(q);
    aim.dist = dist;
    camera.quaternion.copy(q);
    placeCamera();
    camera.near = Math.max(camera.position.distanceTo(aim.target) / 100, 0.001);
    camera.far = dist + unit * 40;
    camera.updateProjectionMatrix();
    updateReflectionSpread(fit);
  }

  // Zoom moves the camera towards the pan point, but never into the
  // devices: once it would reach the nearest one it stops just in front of
  // it and magnifies the lens instead, so zooming in keeps going and the
  // framing at the pan point is the same either way. Run before each render,
  // as devices move.
  const aim = { target: new THREE.Vector3(), back: new THREE.Vector3(0, 0, 1), dist: 1 };
  const aimCentre = new THREE.Vector3();
  const aimScale = new THREE.Vector3();
  function placeCamera() {
    let front = -Infinity; // how far the nearest device reaches towards the camera
    for (const s of slots.values()) {
      if (!s.root) continue;
      s.pivot.updateMatrixWorld(true);
      s.pivot.getWorldPosition(aimCentre);
      s.pivot.getWorldScale(aimScale);
      const r = s.radius * Math.max(aimScale.x, aimScale.y, aimScale.z);
      front = Math.max(front, aimCentre.sub(aim.target).dot(aim.back) + r);
    }
    const dist = Math.max(aim.dist, front + unit * 0.3);
    const zoom = dist / aim.dist;
    camera.position.copy(aim.target).addScaledVector(aim.back, dist);
    if (Math.abs(zoom - camera.zoom) > 1e-9) {
      camera.zoom = zoom;
      camera.updateProjectionMatrix();
    }
  }

  // The glass reflection is kept looking as it does with the default lens
  // (30° field of view) at zoom 1, whatever the focal length and zoom: half
  // the angle the devices fill is compared with that view's.
  function updateReflectionSpread(fit) {
    const vfov0 = 30 * DEG;
    const fit0 = Math.min(vfov0, 2 * Math.atan(Math.tan(vfov0 / 2) * camera.aspect));
    const half = Math.asin(Math.min(0.99, Math.sin(fit / 2) * cam.zoom));
    const half0 = fit0 / 2;
    glassEnv.spread.value = Math.tan(half0) / Math.tan(half) / reflectionZoom;
  }
  function setReflectionZoom(z) {
    reflectionZoom = Math.max(0.05, z);
    frame();
  }

  function setDisplayScale(k) {
    if (Math.abs(k - displayScale) < 1e-3) return;
    displayScale = k;
    resize();
  }

  function setCamera(c) {
    cam = { fov: c.fov, zoom: c.zoom, pan: [...c.pan], orbit: [...(c.orbit || [0, 0, 0])] };
    frame();
  }

  // ---- shadows ----------------------------------------------------------
  // A light that only casts shadows (it adds no light of its own) and an
  // invisible "shadow catcher" that shows nothing but the shadow: a floor
  // under the devices or a backdrop behind them, facing the camera. The
  // catcher draws semi-transparent black, so a transparent PNG keeps the
  // shadow and it lands on any background.
  const shadowLight = new THREE.DirectionalLight(0xffffff, 0);
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.set(2048, 2048);
  shadowLight.shadow.bias = -0.0005;
  shadowLight.visible = false;
  scene.add(shadowLight, shadowLight.target);
  // The backdrop's light shines from (near) the camera itself, so with no
  // offset each shadow lines up exactly behind its device, perspective and
  // all; a parallel light would peek out at the sides.
  const spot = new THREE.SpotLight(0xffffff, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0005;
  spot.visible = false;
  scene.add(spot, spot.target);
  const catcherMat = new THREE.ShadowMaterial({ opacity: 0.3, depthWrite: false });
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), catcherMat);
  catcher.receiveShadow = true;
  catcher.visible = false;
  catcher.renderOrder = -1; // behind the devices' see-through glass
  catcher.raycast = () => {};
  scene.add(catcher);
  /**
   * mode: 'off' | 'floor' | 'backdrop'; colour (hex); strength 0–1; softness 0–1;
   * distance: gap from the devices to the floor / backdrop (scene units);
   * offset 0–1: how far the shadow is pushed away from the devices (0 =
   * straight behind / under them); angle: which way, as seen through the
   * camera, degrees (0 = the light is above, negative = from the left).
   */
  let shadow = { mode: 'off', color: '#000000', strength: 0.3, softness: 0.5, distance: 0.4, offset: 0.5, angle: -35 };
  function setShadow(next) {
    shadow = { ...shadow, ...next };
    const on = shadow.mode === 'floor' || shadow.mode === 'backdrop';
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    shadowLight.visible = on && shadow.mode === 'floor';
    spot.visible = on && shadow.mode === 'backdrop';
    catcher.visible = on;
    catcherMat.opacity = Math.min(1, Math.max(0, shadow.strength));
    catcherMat.color.set(shadow.color || '#000000');
    for (const l of [shadowLight, spot]) l.shadow.blurSamples = Math.round(8 + shadow.softness * 24);
  }
  /** How far Softness spreads the shadow's edge, in metres. */
  const blurWidth = () => shadow.softness * shadow.softness * 1.4 * unit;
  /**
   * Blur the shadow by blurWidth() however big the shadow map's view is
   * (`span`, metres across). The blur is counted in map pixels, so a wide
   * blur uses a coarser map rather than a radius too wide to sample
   * smoothly; a sharp shadow keeps the full map.
   */
  function fitBlur(light, span) {
    const MAX_RADIUS = 24;
    const blur = blurWidth();
    let size = 2048;
    while (size > 256 && (blur * size) / span > MAX_RADIUS) size /= 2;
    if (light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.set(size, size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
      light.shadow.mapPass?.dispose();
      light.shadow.mapPass = null;
    }
    light.shadow.radius = Math.max(1.5, Math.min(MAX_RADIUS, (blur * size) / span));
  }
  const shadowBox = new THREE.Box3();
  const slotBox = new THREE.Box3();
  const lightView = new THREE.OrthographicCamera(); // stands in for the shadow camera while fitting it
  const tmpV = new THREE.Vector3();
  /** Fit the catcher and the shadow's light to where the devices are now. */
  function updateShadow() {
    if (!catcher.visible) return;
    scene.updateMatrixWorld(true);
    shadowBox.makeEmpty();
    for (const s of slots.values()) if (s.root) shadowBox.expandByObject(s.root);
    if (shadowBox.isEmpty()) return;
    const sphere = shadowBox.getBoundingSphere(new THREE.Sphere());
    const c = sphere.center;
    const gap = shadow.distance * unit;
    const span = sphere.radius + gap + unit;
    camera.updateMatrixWorld();
    const toCam = camera.getWorldDirection(new THREE.Vector3()).negate();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const a = shadow.angle * DEG;
    let light;
    if (shadow.mode === 'floor') {
      // Flat under the lowest device; lit mostly from overhead, a little
      // from the camera's side, turned by the angle.
      catcher.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
      catcher.position.set(c.x, shadowBox.min.y - gap, c.z);
      const towards = tmpV.copy(toCam).setY(0);
      if (towards.lengthSq() < 1e-6) towards.copy(up).setY(0); // looking straight down
      towards.normalize();
      const flatRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), towards).normalize();
      light = new THREE.Vector3(0, 1, 0)
        .addScaledVector(flatRight, Math.sin(a) * shadow.offset)
        .addScaledVector(towards, Math.cos(a) * shadow.offset);
    } else {
      // Facing the camera, just behind the farthest device; lit from the
      // camera's side, offset towards the angle.
      catcher.quaternion.copy(camera.quaternion);
      let back = Infinity;
      for (let i = 0; i < 8; i++) {
        tmpV.set(i & 1 ? shadowBox.max.x : shadowBox.min.x, i & 2 ? shadowBox.max.y : shadowBox.min.y, i & 4 ? shadowBox.max.z : shadowBox.min.z);
        back = Math.min(back, tmpV.sub(c).dot(toCam));
      }
      catcher.position.copy(c).addScaledVector(toCam, back - gap);
      catcher.scale.set(span * 8, span * 8, 1);
      // The light: at the camera, moved across the view by the offset (the
      // same angle off the view as a parallel light's offset would be).
      const d = camera.position.distanceTo(c);
      spot.position.copy(camera.position)
        .addScaledVector(right, Math.sin(a) * shadow.offset * d)
        .addScaledVector(up, Math.cos(a) * shadow.offset * d);
      spot.target.position.copy(c);
      const ld = spot.position.distanceTo(c);
      // Cone just wide enough for the devices plus room for the blur, so
      // the shadow map's pixels are spent on them (sharp edges stay clean).
      const r = sphere.radius * 1.08 + blurWidth() * 1.6 + unit * 0.05;
      spot.angle = Math.min(Math.PI / 2.2, Math.asin(Math.min(0.99, r / ld)));
      spot.distance = 0;
      const sc = spot.shadow.camera;
      sc.near = Math.max(0.0005, ld - sphere.radius * 1.5);
      sc.far = ld + sphere.radius + gap + span * 2;
      sc.updateProjectionMatrix();
      fitBlur(spot, 2 * ld * Math.tan(spot.angle));
      spot.target.updateMatrixWorld();
      spot.updateMatrixWorld();
      catcher.updateMatrixWorld();
      return;
    }
    catcher.scale.set(span * 8, span * 8, 1);
    light.normalize();
    shadowLight.target.position.copy(c);
    shadowLight.position.copy(c).addScaledVector(light, span * 3);
    // Fit the shadow map tightly around the devices as the light sees them,
    // so its pixels are spent on them (a loose fit makes sharp shadows
    // jagged). Its depth reaches past the floor / backdrop.
    const sc = shadowLight.shadow.camera;
    sc.up.set(0, Math.abs(light.y) > 0.99 ? 0 : 1, Math.abs(light.y) > 0.99 ? 1 : 0);
    lightView.up.copy(sc.up);
    lightView.position.copy(shadowLight.position);
    lightView.lookAt(c);
    lightView.updateMatrixWorld(true);
    const toLight = lightView.matrixWorld.clone().invert();
    const lb = new THREE.Box3();
    // Only the devices that cast a shadow (all of them if none does).
    const casters = [...slots.values()].filter((s) => s.root && s.cast);
    for (const s of casters.length ? casters : slots.values()) {
      if (!s.root) continue;
      slotBox.setFromObject(s.root);
      for (let i = 0; i < 8; i++) {
        tmpV.set(i & 1 ? slotBox.max.x : slotBox.min.x, i & 2 ? slotBox.max.y : slotBox.min.y, i & 4 ? slotBox.max.z : slotBox.min.z);
        lb.expandByPoint(tmpV.applyMatrix4(toLight));
      }
    }
    // Room around the edges for the blur, so soft shadows aren't cut off.
    const pad = Math.max(lb.max.x - lb.min.x, lb.max.y - lb.min.y) * 0.06 + blurWidth() * 1.6 + unit * 0.05;
    sc.left = lb.min.x - pad;
    sc.right = lb.max.x + pad;
    sc.bottom = lb.min.y - pad;
    sc.top = lb.max.y + pad;
    sc.near = Math.max(0.0001, -lb.max.z - pad);
    // Far enough that the floor, sloping away under a tilted light, doesn't
    // cross the far plane in shot (it shows as a thin line with a coarse map).
    sc.far = -lb.min.z + span * 40;
    sc.updateProjectionMatrix();
    fitBlur(shadowLight, Math.max(sc.right - sc.left, sc.top - sc.bottom));
    shadowLight.target.updateMatrixWorld();
    shadowLight.updateMatrixWorld();
    catcher.updateMatrixWorld();
  }
  /** A device casts a shadow (not its see-through glass), or none (`on` false). */
  function castShadows(root, on = true) {
    root.traverse((o) => { if (o.isMesh) o.castShadow = on && !(o.material?.isShaderMaterial); });
  }

  function setLight(intensity) {
    lightLevel = intensity;
    // Only the device's lighting: the HDRI background keeps its own brightness.
    scene.environmentIntensity = intensity;
    glassEnv.level.value = intensity;
    // An HDRI carries its own lighting; keep the extra key/rim lights subtle.
    const k = hdri ? 0.35 : 1;
    key.intensity = 1.2 * intensity * k;
    rim.intensity = 0.6 * intensity * k;
  }

  /** Light the scene with an equirect HDRI texture, or null for the built-in studio. */
  function setEnvironment(texture) {
    hdri = texture || null;
    if (hdri) hdri.anisotropy = renderer.capabilities.getMaxAnisotropy();
    rebuildEnvironment();
  }

  /** Highlights (0–1: tame the brightest spots) and contrast (1 = unchanged). */
  function setEnvAdjust(next) {
    const merged = { ...adjust, ...next };
    if (merged.contrast === adjust.contrast && merged.highlights === adjust.highlights) return;
    adjust = merged;
    rebuildEnvironment();
  }

  /** Tint the environment (lighting, reflections, HDRI background) by an [r, g, b] multiplier. */
  function setEnvTint(rgb) {
    const next = new THREE.Color(rgb[0], rgb[1], rgb[2]);
    if (next.equals(tint)) return;
    tint = next;
    rebuildEnvironment();
  }

  /** Spin the environment (lighting, reflections and HDRI background) around the vertical axis. */
  function setEnvRotation(deg) {
    scene.environmentRotation.set(0, deg * DEG, 0);
    scene.backgroundRotation.set(0, deg * DEG, 0);
    // three.js applies the inverse rotation when it samples an environment.
    glassEnv.rotation.value.setFromMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, -deg * DEG, 0)));
  }

  /**
   * Temporarily render at an exact pixel size (for export). `fn` is called
   * with a render() function and may be async; the view is restored after.
   */
  /**
   * Render at an exact pixel size for export. With `supersample` > 1 the
   * scene is drawn that many times larger and scaled down with a high-quality
   * filter, which smooths edges far more than the GPU's own anti-aliasing.
   * `fn` gets a render() function that returns a canvas of exactly w × h.
   */
  async function withRenderSize(w, h, fn, { supersample = 1, dither = false } = {}) {
    const prevRatio = renderer.getPixelRatio();
    const gl = renderer.getContext();
    const maxSide = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 8192);
    // Safari caps a canvas at 4096 × 4096 worth of pixels and kills the tab if
    // it runs out of memory, so stay within that (the GPU's own anti-aliasing
    // multiplies the memory again).
    const MAX_PIXELS = 4096 * 4096;
    let ss = Math.max(1, Math.floor(supersample));
    while (ss > 1 && (Math.max(w, h) * ss > maxSide || w * h * ss * ss > MAX_PIXELS)) ss--;

    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const g = out.getContext('2d');
    const render = () => {
      placeCamera();
      updateShadow();
      fitClipPlanes();
      renderer.render(scene, camera);
      if (ss === 1 && !dither) return renderer.domElement;
      if (ss === 1) {
        g.clearRect(0, 0, w, h);
        g.drawImage(renderer.domElement, 0, 0);
      } else {
        downsample(renderer.domElement, g, w, h, ss);
      }
      if (dither) addDither(g, w, h, dither === true ? undefined : dither);
      return out;
    };

    paused = true;
    const outlines = outlineOn;
    try {
      setOutlineEnabled(false);
      renderer.setPixelRatio(1);
      renderer.setSize(w * ss, h * ss, false);
      camera.aspect = w / h;
      if (bg.mode === 'gradient') applyBackground(w, h);
      frame();
      return await fn(render, ss);
    } finally {
      setOutlineEnabled(outlines);
      renderer.setPixelRatio(prevRatio);
      paused = false;
      resize();
    }
  }

  // Scale a big render down by `ss`, halving at most 2× per step so every
  // source pixel contributes (a single big jump would skip pixels).
  let tmpA = null;
  let tmpB = null;
  function downsample(src, g, w, h, ss) {
    let cur = src;
    let cw = src.width;
    let ch = src.height;
    let flip = false;
    while (cw / 2 >= w * 1.0001 && cw / 2 > w) {
      const nw = Math.max(w, Math.round(cw / 2));
      const nh = Math.max(h, Math.round(ch / 2));
      const t = flip ? (tmpB ||= document.createElement('canvas')) : (tmpA ||= document.createElement('canvas'));
      flip = !flip;
      if (t.width !== nw || t.height !== nh) { t.width = nw; t.height = nh; }
      const tg = t.getContext('2d');
      tg.clearRect(0, 0, nw, nh);
      tg.imageSmoothingEnabled = true;
      tg.imageSmoothingQuality = 'high';
      tg.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      cur = t;
      cw = nw;
      ch = nh;
    }
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, w, h);
  }

  // Faint grain (about ±1–3 of 255 levels) that stops video compression from
  // turning smooth gradients into visible bands. Applied after scaling down,
  // so it isn't averaged away.
  // Two grey tiles: one is added ("lighter") and one subtracted
  // ("difference"), so each pixel moves up or down evenly, even in dark
  // areas. `block` is the grain size in pixels and `amp` the strength in
  // 0–255 levels; coarser, stronger grain survives weaker encoders. Only used
  // for video, which has no transparency.
  const noiseCache = new Map();
  function addDither(g, w, h, { block = 1, amp = 3 } = {}) {
    const key = `${block}:${amp}`;
    let noise = noiseCache.get(key);
    if (!noise) {
      const N = 256;
      const cells = Math.ceil(N / block);
      const tile = (fill) => {
        const small = document.createElement('canvas');
        small.width = small.height = cells;
        const sg = small.getContext('2d');
        const img = sg.createImageData(cells, cells);
        for (let i = 0; i < cells * cells; i++) {
          const v = fill(i);
          img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
          img.data[i * 4 + 3] = 255;
        }
        sg.putImageData(img, 0, 0);
        const big = document.createElement('canvas');
        big.width = big.height = cells * block;
        const bg2 = big.getContext('2d');
        bg2.imageSmoothingEnabled = false;
        bg2.drawImage(small, 0, 0, big.width, big.height);
        return g.createPattern(big, 'repeat');
      };
      const values = Array.from({ length: cells * cells }, () => Math.round((Math.random() + Math.random() - 1) * amp));
      noise = { plus: tile((i) => Math.max(0, values[i])), minus: tile((i) => Math.max(0, -values[i])) };
      noiseCache.set(key, noise);
    }
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = noise.plus;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'difference';
    g.fillStyle = noise.minus;
    g.fillRect(0, 0, w, h);
    g.restore();
  }

  let paused = false;
  const beforeRender = [];
  function loop(now) {
    for (const f of beforeRender) f(now);
    if (!paused) {
      placeCamera();
      updateShadow();
      fitClipPlanes();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }

  // Keep the camera's clipping range tight around the devices. The depth
  // buffer's precision depends on it, and the screen, Dynamic Island and
  // glass sit fractions of a millimetre apart: with a long focal length (the
  // camera far away) a loose range made them flicker through each other in
  // blocks. The background isn't geometry, so nothing else needs the range.
  const clipCentre = new THREE.Vector3();
  const clipScale = new THREE.Vector3();
  function fitClipPlanes() {
    camera.updateMatrixWorld();
    const dir = camera.getWorldDirection(new THREE.Vector3());
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of slots.values()) {
      if (!s.root) continue;
      s.pivot.updateMatrixWorld(true);
      s.pivot.getWorldPosition(clipCentre);
      s.pivot.getWorldScale(clipScale);
      const r = s.radius * Math.max(clipScale.x, clipScale.y, clipScale.z) * 1.3; // margin: imported models may sit off-centre
      const d = clipCentre.sub(camera.position).dot(dir);
      lo = Math.min(lo, d - r);
      hi = Math.max(hi, d + r);
    }
    if (!Number.isFinite(lo)) return;
    // Keep the shadow's floor or backdrop in view (it's behind or under the
    // devices).
    if (catcher.visible) hi += (shadow.distance + 4) * unit;
    const near = Math.max(lo, hi * 1e-3, 1e-4);
    const far = Math.max(hi, near * 1.01);
    if (Math.abs(near - camera.near) > 1e-9 || Math.abs(far - camera.far) > 1e-9) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  rebuildEnvironment(); // start with the built-in studio
  new ResizeObserver(resize).observe(container);
  resize();
  requestAnimationFrame(loop);

  return {
    renderer, scene, camera,
    addSlot, removeSlot, setSlotModel, slotBoundsNdc, setSlotLandscape, setSlotShadow, slotSize, setSlotPose, setSelected, setOutlineEnabled, pickSlot, fitAll, project, screenMove, towardsCamera,
    get unit() { return unit; },
    get maxRadius() { return maxRadius(); },
    setUnit,
    frame, resize, setShadow, setCamera, setReflectionZoom, setLight, setBackground, setEnvironment, setEnvTint, setEnvAdjust, setEnvRotation, withRenderSize, setDisplayScale,
    onBeforeRender(f) { beforeRender.push(f); },
    get background() { return { ...bg }; },
  };
}
