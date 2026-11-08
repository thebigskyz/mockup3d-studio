// Service worker: makes Mockup3D Studio installable and lets it work offline.
//
// - The app's own files are fetched from the network first, so a new version
//   shows up on the next launch without a version number to bump. The copy
//   saved here is used when offline, or when the network is slow.
// - Libraries and fonts from CDNs are pinned to exact versions, so they're
//   served from the saved copy without asking the network again.
//
// Everything in APP_FILES and CDN_FILES is saved on install, so the app works
// offline after the first visit, including the parts that load only when
// needed (MP4 export, projects). Add new files here.

const CACHE = 'mockup-studio-v1';

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/main.js',
  'js/custom-devices.js',
  'js/devices.js',
  'js/easing.js',
  'js/environments.js',
  'js/exporter.js',
  'js/glass.js',
  'js/media.js',
  'js/project.js',
  'js/pwa.js',
  'js/update-check.js',
  'js/scene.js',
  'js/store.js',
  'js/templates.js',
  'js/timeline-ui.js',
  'js/timeline.js',
  'js/video-export.js',
  'js/video-frames.js',
  'models/iphone-18-pro.glb',
  'models/ipad-pro-11.glb',
  'env/studio-panels.exr',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

const THREE = 'https://cdn.jsdelivr.net/npm/three@0.170.0/';
const CDN_FILES = [
  `${THREE}build/three.module.js`,
  `${THREE}examples/jsm/environments/RoomEnvironment.js`,
  `${THREE}examples/jsm/loaders/GLTFLoader.js`,
  `${THREE}examples/jsm/loaders/EXRLoader.js`,
  `${THREE}examples/jsm/loaders/RGBELoader.js`,
  `${THREE}examples/jsm/utils/BufferGeometryUtils.js`,
  `${THREE}examples/jsm/libs/fflate.module.js`,
  // Decoders for compressed imported models (Draco, Meshopt, KTX2 / Basis).
  `${THREE}examples/jsm/loaders/DRACOLoader.js`,
  `${THREE}examples/jsm/loaders/KTX2Loader.js`,
  `${THREE}examples/jsm/libs/meshopt_decoder.module.js`,
  `${THREE}examples/jsm/utils/WorkerPool.js`,
  `${THREE}examples/jsm/libs/zstddec.module.js`,
  `${THREE}examples/jsm/libs/ktx-parse.module.js`,
  `${THREE}examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js`,
  `${THREE}examples/jsm/libs/draco/gltf/draco_decoder.wasm`,
  `${THREE}examples/jsm/libs/basis/basis_transcoder.js`,
  `${THREE}examples/jsm/libs/basis/basis_transcoder.wasm`,
  'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js',
  'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/+esm',
  'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
];

// Hosts whose URLs never change content (pinned versions, hashed font files).
const IMMUTABLE_HOSTS = ['cdn.jsdelivr.net', 'fonts.gstatic.com'];

// How long to wait for the network before falling back to the saved copy.
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one, so a single failure doesn't stop the rest being saved.
    await Promise.all([...APP_FILES, ...CDN_FILES].map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch((err) => console.warn('Not saved for offline:', url, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    // Which version this folder is on (from serve.py): never a saved copy,
    // so the update check (js/update-check.js) only compares the real thing.
    if (url.pathname.endsWith('/version.json')) return;
    event.respondWith(networkFirst(event, req));
  } else if (IMMUTABLE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req));
  } else if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

async function put(req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const cache = await caches.open(CACHE);
    await cache.put(req, res);
  }
}

// The saved copy of an app file. Page loads may ask for "./?x" or
// "index.html" interchangeably, so fall back to the app's start page.
async function cached(req) {
  const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
  if (hit || req.mode !== 'navigate') return hit;
  return (await caches.match('./')) || caches.match('index.html');
}

// Fetch from the network and save the response once it arrives. The save is
// registered with the event straight away: once the page has its response,
// the worker may be stopped unless it's still waiting on something.
function fetchAndSave(event, req) {
  const network = fetch(req);
  event.waitUntil(network.then((res) => put(req, res.clone())).catch(() => {}));
  return network;
}

async function networkFirst(event, req) {
  const network = fetchAndSave(event, req);
  network.catch(() => {}); // handled below
  const saved = await cached(req);
  if (!saved) return network;
  // Use the network if it answers in time; otherwise the saved copy (the
  // network response still updates the cache when it arrives).
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT));
  try {
    return (await Promise.race([network, timeout])) || saved;
  } catch {
    return saved; // offline
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  await put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(event, req) {
  const network = fetchAndSave(event, req);
  const hit = await caches.match(req);
  if (hit) {
    network.catch(() => {});
    return hit;
  }
  return network;
}
