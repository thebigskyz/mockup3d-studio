// Mockup3D Studio for Figma: the part that runs inside Figma.
//
// It watches the selection, exports the selected frame as a PNG for the
// panel (ui.html) to put on a 3D device, and places the rendered mockup on
// the canvas. A mockup is a rectangle with the render as its image fill. It
// remembers its frame and settings (plugin data), so it can be edited again
// or updated after the frame changes.
//
// Figma's plugin sandbox is strict about newer syntax, so this file avoids
// optional chaining (?.), ?? and object spread.

const KEY = 'mockup';
const DEFAULTS_KEY = 'defaults';
const SCREEN_PX = 2622; // export frames at about the iPhone screen's resolution
const MAX_EXPORT = 4096;
const SOURCE_TYPES = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'RECTANGLE'];
const RELAUNCH = { edit: 'Change the device, angle or finish', update: 'Render it again from its frame' };

// ---------------------------------------------------------------------------
// Mockups and their frames
// ---------------------------------------------------------------------------
function readMockup(node) {
  if (!node || typeof node.getPluginData !== 'function') return null;
  const raw = node.getPluginData(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeMockup(node, data) {
  node.setPluginData(KEY, JSON.stringify(data));
  node.setRelaunchData(RELAUNCH);
}

const isSource = (node) => SOURCE_TYPES.indexOf(node.type) >= 0 && !readMockup(node);

/** A short fingerprint of the exported frame, to tell whether it changed. */
function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + bytes.length;
}

/** The frame as a PNG, at about the device screen's resolution. */
async function exportSource(node) {
  const long = Math.max(node.width, node.height, 1);
  const scale = Math.max(0.25, Math.min(4, SCREEN_PX / long, MAX_EXPORT / long));
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
  return { id: node.id, name: node.name, w: node.width, h: node.height, bytes: bytes, hash: hashBytes(bytes) };
}

function pageMockups() {
  const page = figma.currentPage;
  try {
    return page.findAllWithCriteria({ pluginData: { keys: [KEY] } });
  } catch (e) {
    return page.findAll((n) => !!readMockup(n));
  }
}

function boxOf(node) {
  const b = node.absoluteBoundingBox;
  return b || { x: node.x, y: node.y, width: node.width, height: node.height };
}

/**
 * Put a render on `node` at its size in Figma (pixels / density). A mockup
 * being replaced keeps its left edge and vertical centre, so it grows away
 * from its frame (which is usually to its left).
 */
function setImage(node, render, density, keepPlace) {
  const w = render.width / density;
  const h = render.height / density;
  const cy = node.y + node.height / 2;
  node.resize(w, h);
  if (keepPlace) node.y = Math.round(cy - h / 2);
  const image = figma.createImage(render.bytes);
  node.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
}

// ---------------------------------------------------------------------------
// The panel: rendering happens there (it has WebGL)
// ---------------------------------------------------------------------------
let uiReady = false;
const readyWaiters = [];
const jobs = new Map();
let jobCount = 0;
let lastExport = null; // the export last sent to the panel

const post = (msg) => figma.ui.postMessage(msg);
const whenReady = () => (uiReady ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve)));

/** Ask the panel to render `source` with `settings`; resolves to { bytes, width, height }. */
async function renderInPanel(source, settings) {
  await whenReady();
  return new Promise((resolve, reject) => {
    const job = ++jobCount;
    jobs.set(job, { resolve: resolve, reject: reject });
    post({ type: 'render', job: job, source: { id: source.id, name: source.name, w: source.w, h: source.h, bytes: source.bytes }, settings: settings });
  });
}

// ---------------------------------------------------------------------------
// Selection: a frame to mock up, or a mockup to edit
// ---------------------------------------------------------------------------
let selToken = 0;
let selTimer = null;

function selectionChanged() {
  clearTimeout(selTimer);
  selTimer = setTimeout(sendSelection, 120); // wait for the selection to settle
}

async function sendSelection() {
  const token = ++selToken;
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    post({ type: 'source', none: true, kind: sel.length ? 'many' : 'none', reason: sel.length ? 'Select just one frame' : 'Select a frame to mock up' });
    return;
  }
  const node = sel[0];
  const data = readMockup(node);
  let source = node;
  if (data) {
    source = await figma.getNodeByIdAsync(data.source);
    if (!source || source.removed) {
      post({ type: 'source', none: true, reason: 'This mockup’s frame was deleted, so it can’t be edited' });
      return;
    }
  } else if (!isSource(node)) {
    post({ type: 'source', none: true, kind: 'type', reason: 'Select a frame, component or group' });
    return;
  }
  post({ type: 'source', loading: true, name: source.name });
  let exp;
  try {
    exp = await exportSource(source);
  } catch (e) {
    if (token === selToken) post({ type: 'source', none: true, reason: 'Couldn’t export “' + source.name + '”: ' + e.message });
    return;
  }
  if (token !== selToken) return; // the selection changed meanwhile
  lastExport = exp;
  post({
    type: 'source',
    source: { id: exp.id, name: exp.name, w: exp.w, h: exp.h, bytes: exp.bytes },
    mockup: data ? node.id : null,
    settings: data ? data.settings : null,
  });
}

// ---------------------------------------------------------------------------
// Placing and updating mockups
// ---------------------------------------------------------------------------
async function place(msg) {
  const source = await figma.getNodeByIdAsync(msg.sourceId);
  const density = msg.density || msg.settings.density || 2;
  let node = msg.mockupId ? await figma.getNodeByIdAsync(msg.mockupId) : null;
  const replacing = !!(node && !node.removed);
  if (!replacing) {
    node = figma.createRectangle();
    figma.currentPage.appendChild(node);
    node.name = 'Mockup – ' + (source ? source.name : 'frame');
    setImage(node, msg, density, false);
    // To the right of the frame, centred on it.
    if (source) {
      const b = boxOf(source);
      node.x = Math.round(b.x + b.width + 80);
      node.y = Math.round(b.y + (b.height - node.height) / 2);
    }
  } else {
    setImage(node, msg, density, true);
  }
  const hash = lastExport && lastExport.id === msg.sourceId ? lastExport.hash : null;
  writeMockup(node, { v: 1, source: msg.sourceId, hash: hash, settings: msg.settings });
  if (!replacing) {
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView(source ? [source, node] : [node]);
  }
  figma.notify(replacing ? 'Mockup updated' : 'Mockup added · select it later to edit it');
}

/** Render mockups again from their frames (only those whose frame changed). */
async function updateMockups(nodes) {
  let updated = 0;
  let same = 0;
  let missing = 0;
  let failed = 0;
  const list = nodes.filter((n) => readMockup(n));
  if (!list.length) {
    figma.notify('No mockups to update', { error: true });
    return;
  }
  post({ type: 'progress', text: 'Checking ' + list.length + ' mockup' + (list.length === 1 ? '' : 's') + '…' });
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    const data = readMockup(node);
    const source = await figma.getNodeByIdAsync(data.source);
    if (!source || source.removed) {
      missing++;
      continue;
    }
    try {
      const exp = await exportSource(source);
      if (exp.hash === data.hash) {
        same++;
        continue;
      }
      post({ type: 'progress', text: 'Updating ' + (i + 1) + ' of ' + list.length + ': ' + node.name });
      const render = await renderInPanel(exp, data.settings);
      setImage(node, render, render.density || data.settings.density || 2, true);
      writeMockup(node, { v: 1, source: data.source, hash: exp.hash, settings: data.settings });
      updated++;
    } catch (e) {
      console.error(e);
      failed++;
    }
  }
  post({ type: 'progress', text: null });
  const parts = [];
  if (updated) parts.push('Updated ' + updated);
  if (same) parts.push(same + ' already up to date');
  if (missing) parts.push(missing + ' with a deleted frame');
  if (failed) parts.push(failed + ' failed');
  figma.notify(parts.join(' · '), { error: failed > 0 });
}

// ---------------------------------------------------------------------------
// Messages from the panel
// ---------------------------------------------------------------------------
let defaults = Promise.resolve(null); // last used settings, from clientStorage

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'hello') {
    // The panel is listening (its renderer is still loading).
    post({ type: 'init', settings: await defaults });
  } else if (msg.type === 'ready') {
    uiReady = true;
    readyWaiters.splice(0).forEach((resolve) => resolve());
  } else if (msg.type === 'rendered' || msg.type === 'render-error') {
    const job = jobs.get(msg.job);
    if (!job) return;
    jobs.delete(msg.job);
    if (msg.type === 'rendered') job.resolve(msg);
    else job.reject(new Error(msg.message));
  } else if (msg.type === 'place') {
    try {
      await place(msg);
    } catch (e) {
      figma.notify('Couldn’t place the mockup: ' + e.message, { error: true });
    }
    post({ type: 'placed' });
  } else if (msg.type === 'settings') {
    await figma.clientStorage.setAsync(DEFAULTS_KEY, msg.settings);
  } else if (msg.type === 'update-all') {
    await updateMockups(pageMockups());
    sendSelection();
  } else if (msg.type === 'open') {
    // The web app, in the browser (the panel can't open windows itself).
    if (/^https?:\/\//.test(msg.url)) figma.openExternal(msg.url);
  } else if (msg.type === 'notify') {
    figma.notify(msg.text, { error: !!msg.error });
  }
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  const command = figma.command || 'open';
  defaults = figma.clientStorage.getAsync(DEFAULTS_KEY).catch(() => null);
  figma.showUI(__html__, { width: 320, height: 736, themeColors: true, title: 'Mockup3D Studio' });

  if (command === 'update' || command === 'update-all') {
    // From the Update button on a mockup, or the menu: update and close.
    const nodes = command === 'update' ? figma.currentPage.selection.slice() : pageMockups();
    await updateMockups(nodes);
    figma.closePlugin();
    return;
  }
  figma.on('selectionchange', selectionChanged);
  await whenReady();
  sendSelection();
}

start();
