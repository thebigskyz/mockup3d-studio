// Templates: complete starting scenes (devices, poses, camera, frame and
// background), applied from the Templates tab. No DOM here.
//
// Positions are in scene units: one unit is the radius of the largest device
// in the template (an iPhone 18 Pro is about 0.86 × 1.8 units on its own, or
// 0.47 × 0.98 next to an iPad Pro 11″, which is about 1.16 × 1.63). Rotations
// are degrees, as in the Inspector (Tilt, Turn, Roll). The camera is framed
// on the devices after they're placed; `tight` then zooms in on that (above
// 1 crops the outer devices at the frame edges, as in a busy grid). Or give
// the camera a `zoom` (and `pan`) for a set framing instead.
// `shadow` sets Inspector › Shadow (see DEFAULT_SHADOW in main.js).
// `envRot` (optional) turns the lighting: 180° puts the studio's softboxes
// behind the devices, so screens that face the camera aren't washed out by
// their reflection.

const PHONE = 'iphone-18-pro';
const IPAD = 'ipad-pro-11';

const phone = (rot, pos, scale = 1) => ({ model: PHONE, rot, pos, scale });
const WHITE = { mode: 'solid', c1: '#ffffff', c2: '#ffffff', angle: 180 };

/** Half the frame (across, up) in scene units at the middle of the shot; see frame() in js/scene.js. */
function halfFrame({ fov, zoom, aspect }) {
  const half = (fov * Math.PI) / 360;
  const hh = (1.08 * Math.tan(half)) / Math.sin(half) / zoom;
  return [hh * aspect, hh];
}

/**
 * Of `spots` ([a, b] on the plane the phones lie in), keep those whose phone
 * (`size`: [along a, along b]) shows in the frame, most visible first, at
 * most `count`, so nothing is wasted out of shot. `toPlane(u, v)` takes a
 * point on the frame (scene units from its middle) to that plane.
 */
function keepInShot({ spots, toPlane, frame, size: [sa, sb], count }) {
  const [hw, hh] = halfFrame(frame);
  // Points across the frame, fine enough to catch phones that only clip a corner.
  const pts = [];
  for (let i = 0; i < 80; i++) for (let j = 0; j < 60; j++) pts.push(toPlane(-hw + (2 * hw * (i + 0.5)) / 80, -hh + (2 * hh * (j + 0.5)) / 60));
  return spots
    .map(([a, b]) => ({ a, b, seen: pts.filter(([pa, pb]) => Math.abs(pa - a) <= sa / 2 && Math.abs(pb - b) <= sb / 2).length }))
    .filter((p) => p.seen)
    .sort((p, q) => q.seen - p.seen)
    .slice(0, count);
}

/**
 * Phones lying flat on a brick pattern on the floor (x, depth): rows a phone
 * length apart, every other row shifted half a phone; only those in shot.
 * Measured as the frame sees the floor (near enough, with a long lens).
 */
function brickFloor({ orbit, elevation, step: [along, between], size, count, ...frame }) {
  const o = (orbit * Math.PI) / 180;
  const s = Math.sin((elevation * Math.PI) / 180);
  // Floor (x, depth) → frame (across, up) is m; toPlane is its inverse.
  const m = [Math.cos(o), -Math.sin(o), -Math.sin(o) * s, -Math.cos(o) * s];
  const det = m[0] * m[3] - m[1] * m[2];
  const toPlane = (u, v) => [(m[3] * u - m[1] * v) / det, (-m[2] * u + m[0] * v) / det];
  const spots = [];
  for (let r = -8; r <= 8; r++) for (let c = -8; c <= 8; c++) spots.push([c * along + (r & 1 ? along / 2 : 0), r * between]);
  return keepInShot({ spots, toPlane, frame, size, count }).map((p) => [p.a, 0, p.b]);
}

/**
 * Upright phones in columns (x, y), facing the camera, each column shifted
 * up by its share of a row (`offsets`, repeating); only those in shot. The
 * frame is rolled by `roll` degrees (the camera's roll).
 */
function columns({ roll, step: [across, up], offsets, size, count, ...frame }) {
  const r = (roll * Math.PI) / 180;
  const toPlane = (u, v) => [u * Math.cos(r) - v * Math.sin(r), u * Math.sin(r) + v * Math.cos(r)];
  const spots = [];
  for (let c = -8; c <= 8; c++) {
    const off = offsets[((c % offsets.length) + offsets.length) % offsets.length];
    for (let k = -6; k <= 6; k++) spots.push([c * across, (k + off) * up]);
  }
  return keepInShot({ spots, toPlane, frame, size, count }).map((p) => [p.a, p.b, 0]);
}

export const TEMPLATES = [
  {
    id: 'floating-trio',
    label: 'Floating trio',
    frame: '1:1',
    bg: WHITE,
    finish: 'grey',
    envRot: 180,
    camera: { fov: 26, orbit: [0, 0, 0], zoom: 0.59, pan: [-0.06, 0.06] },
    shadow: { mode: 'backdrop', strength: 0.22, softness: 0.3, distance: 1.2, angle: -35 },
    // The right phone tucks behind the middle one's edge, so the overlap
    // reads as deliberate.
    devices: [
      phone([-38, 12, 30], [-0.89, -0.64, 0.35]),
      phone([-16, -8, 2], [0, 0.25, -0.2]),
      phone([-12, 22, -22], [0.7, 0.5, -0.65]),
    ],
  },
  {
    // Phones lying flat in a brick pattern, seen from above at an angle,
    // with a long lens so it reads as isometric.
    id: 'isometric-grid',
    label: 'Isometric grid',
    frame: '4:3',
    bg: WHITE,
    finish: 'silver',
    // Framed on the pattern's middle at a set zoom (not fitted to the
    // phones, which run off every edge).
    camera: { fov: 14, orbit: [-38, 52, 0], zoom: 0.7, pan: [0, 0] },
    shadow: { mode: 'floor', strength: 0.4, softness: 0.22, distance: 0.12, angle: -30 },
    // Phones on a brick pattern, only those that show in the frame (11 of
    // them, two just clipping corners). Tops point away from the camera, so the screens read the right
    // way up.
    devices: brickFloor({ orbit: -38, elevation: 52, fov: 14, zoom: 0.7, aspect: 4 / 3, count: 12, step: [2.05, 1.15], size: [1.8, 0.86] })
      .map((pos) => phone([-90, 0, -90], pos)),
  },
  {
    // Upright columns at different heights, the whole frame rolled, cropped
    // at the edges.
    id: 'tilted-columns',
    label: 'Tilted columns',
    frame: '4:3',
    bg: WHITE,
    finish: 'black',
    envRot: 180,
    // Framed on the pattern's middle at a set zoom; the phones run off every edge.
    camera: { fov: 22, orbit: [6, -4, 14], zoom: 0.75, pan: [0, 0] },
    // Kept light and close: soft shadows from this many phones overlap and
    // would grey the whole background.
    shadow: { mode: 'backdrop', strength: 0.22, softness: 0.19, distance: 0.2, angle: -40 },
    // Columns at uneven heights, only the phones that show in the frame (11).
    devices: columns({ roll: 14, fov: 22, zoom: 0.75, aspect: 4 / 3, count: 12, step: [1.12, 2.08], offsets: [0, 0.55, 0.2, 0.8, 0.4], size: [0.86, 1.8] })
      .map((pos) => phone([0, 0, 0], pos)),
  },
  {
    // Straight-on grid with a very long lens: flat, like a print layout.
    id: 'flat-grid',
    label: 'Flat grid',
    frame: '16:9',
    bg: WHITE,
    finish: 'black',
    envRot: 180,
    camera: { fov: 8, orbit: [0, 0, 0], tight: 1.7 },
    shadow: { mode: 'backdrop', strength: 0.28, softness: 0.23, distance: 0.3, angle: -40 },
    devices: [
      phone([0, 0, 0], [-1.7, 1.05, 0]),
      phone([0, 0, 0], [-1.7, -1.1, 0]),
      phone([0, 0, 0], [-0.57, 0.1, 0]),
      phone([0, 0, 0], [0.57, 1.4, 0]),
      phone([0, 0, 0], [0.57, -0.75, 0]),
      phone([0, 0, 0], [1.7, 0.35, 0]),
    ],
  },
  {
    // A landscape iPad with an iPhone standing in front of its corner.
    id: 'ipad-iphone',
    label: 'iPad + iPhone',
    frame: '1:1',
    bg: WHITE,
    finish: 'black',
    envRot: 180,
    camera: { fov: 18, orbit: [0, 0, 0], tight: 0.94 },
    shadow: { mode: 'backdrop', strength: 0.25, softness: 0.16, distance: 0.25, angle: -40 },
    devices: [
      { model: IPAD, orientation: 'landscape', rot: [0, 0, 0], pos: [-0.18, 0.1, 0], scale: 1 },
      { model: PHONE, rot: [0, 0, 0], pos: [0.62, -0.2, 0.15], scale: 1 },
    ],
  },
  {
    // An iPad tumbling in mid-air with phones above and below it.
    id: 'tumbling-stack',
    label: 'Tumbling stack',
    frame: '4:5',
    bg: WHITE,
    finish: 'silver',
    camera: { fov: 24, orbit: [0, 10, 0], tight: 1.02 },
    shadow: { mode: 'floor', strength: 0.22, softness: 0.4, distance: 0.6, angle: 0 },
    devices: [
      { model: IPAD, rot: [-18, 14, -34], pos: [0, 0, 0], scale: 1 },
      { model: PHONE, rot: [-48, 12, -32], pos: [0.35, 1.2, 0.45], scale: 1.18 },
      { model: PHONE, rot: [-30, -8, 28], pos: [0.1, 2.1, -0.3], scale: 1.18 },
      { model: PHONE, rot: [22, -12, 38], pos: [-0.25, -1.2, 0.3], scale: 1.18 },
      { model: PHONE, rot: [-72, 0, -14], pos: [0.05, -2.0, 0.1], scale: 1.18 },
    ],
  },
  {
    // Four phones falling in a zig-zag, numbered top to bottom.
    id: 'falling-cascade',
    label: 'Falling cascade',
    frame: '9:16',
    bg: WHITE,
    finish: 'black',
    camera: { fov: 24, orbit: [0, 10, 0], tight: 1.12 },
    shadow: { mode: 'floor', strength: 0.22, softness: 0.4, distance: 0.5, angle: 0 },
    devices: [
      phone([-28, 18, -30], [0.5, 2.45, 0]),
      phone([-36, -14, 32], [-0.45, 0.8, 0.1]),
      phone([-50, 10, -16], [0.35, -0.7, 0.2]),
      phone([-66, 0, -22], [-0.1, -2.1, 0.3]),
    ],
  },
];
