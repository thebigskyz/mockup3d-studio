// Easing curves for timeline segments. Each maps 0..1 -> roughly 0..1
// (Back and Spring overshoot on purpose).

const clamp01 = (t) => Math.min(1, Math.max(0, t));

export const EASINGS = {
  linear: { label: 'Linear', fn: (t) => t, css: 'linear' },
  easeIn: { label: 'Ease in', fn: (t) => t * t * t, css: 'cubic-bezier(.55,0,1,.45)' },
  easeOut: { label: 'Ease out', fn: (t) => 1 - Math.pow(1 - t, 3), css: 'cubic-bezier(0,.55,.45,1)' },
  easeInOut: {
    label: 'Ease in-out',
    fn: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    css: 'cubic-bezier(.65,0,.35,1)',
  },
  smooth: { label: 'Smooth', fn: (t) => -(Math.cos(Math.PI * t) - 1) / 2, css: 'cubic-bezier(.37,0,.63,1)' },
  backOut: {
    label: 'Back',
    fn: (t) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    css: 'cubic-bezier(.34,1.56,.64,1)',
  },
  spring: {
    label: 'Spring',
    fn: (t) => (t >= 1 ? 1 : 1 - Math.exp(-6 * t) * Math.cos(t * Math.PI * 4.5)),
    css: 'cubic-bezier(.34,1.8,.64,1)',
  },
  hold: { label: 'Hold', fn: (t) => (t >= 1 ? 1 : 0), css: 'steps(1, end)' },
};

export const EASING_ORDER = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'smooth', 'backOut', 'spring', 'hold'];

// ---------------------------------------------------------------------------
// Custom curves: stored as a CSS-style "cubic-bezier(x1,y1,x2,y2)" string.
// ---------------------------------------------------------------------------
export const isBezier = (name) => typeof name === 'string' && name.startsWith('cubic-bezier(');

export function parseBezier(name) {
  const m = /cubic-bezier\(([^)]*)\)/.exec(name || '');
  if (!m) return null;
  const p = m[1].split(',').map(Number);
  return p.length === 4 && p.every(Number.isFinite) ? p : null;
}

export function bezierName(p) {
  return `cubic-bezier(${p.map((v) => +v.toFixed(3)).join(', ')})`;
}

/** Bezier handles for any easing (presets use their CSS approximation), or null for Hold. */
export function bezierOf(name) {
  if (isBezier(name)) return parseBezier(name);
  const css = EASINGS[name]?.css;
  if (css === 'linear') return [0, 0, 1, 1];
  return parseBezier(css);
}

// y(x) on one cubic segment from p0 to p3 (control points p1, p2), whose
// x runs from p0's to p3's: solve x(t) = x with Newton's method, then
// bisection. A CSS cubic-bezier is the segment from (0,0) to (1,1).
function cubicFn([x0, y0], [x1, y1], [x2, y2], [x3, y3]) {
  const cx = 3 * (x1 - x0), bx = 3 * (x2 - x1) - cx, ax = x3 - x0 - cx - bx;
  const cy = 3 * (y1 - y0), by = 3 * (y2 - y1) - cy, ay = y3 - y0 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t + x0;
  const sy = (t) => ((ay * t + by) * t + cy) * t + y0;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const span = x3 - x0 || 1;
  return (x) => {
    let t = (x - x0) / span;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = (x - x0) / span;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}
const bezierFn = ([x1, y1, x2, y2]) => cubicFn([0, 0], [x1, y1], [x2, y2], [1, 1]);

// ---------------------------------------------------------------------------
// Curves with more points: "curve(...)", cubic segments joined end to end
// from (0,0) to (1,1). The numbers are each segment's two handles (x, y,
// x, y), with the point where it meets the next segment (x, y) in between.
// In code a curve is a list of points: { x, y, in: [x, y], out: [x, y] }
// (the first has no `in`, the last no `out`). Two points is a plain
// cubic-bezier, which is how it's saved.
// ---------------------------------------------------------------------------
export const isCurve = (name) => typeof name === 'string' && name.startsWith('curve(');

function parseCurve(name) {
  const m = /curve\(([^)]*)\)/.exec(name || '');
  if (!m) return null;
  const v = m[1].split(',').map(Number);
  if (!v.every(Number.isFinite) || v.length < 10 || (v.length + 2) % 6) return null;
  const pts = [{ x: 0, y: 0, out: [v[0], v[1]] }];
  let i = 2;
  for (;;) {
    const inH = [v[i], v[i + 1]];
    if (i + 2 === v.length) {
      pts.push({ x: 1, y: 1, in: inH });
      return pts;
    }
    pts.push({ x: v[i + 2], y: v[i + 3], in: inH, out: [v[i + 4], v[i + 5]] });
    i += 6;
  }
}

/** The easing name for a list of points (see above). */
export function curveName(pts) {
  if (pts.length === 2) return bezierName([...pts[0].out, ...pts[1].in]);
  const n = [...pts[0].out];
  for (let i = 1; i < pts.length - 1; i++) n.push(...pts[i].in, pts[i].x, pts[i].y, ...pts[i].out);
  n.push(...pts[pts.length - 1].in);
  return `curve(${n.map((v) => +v.toFixed(4)).join(', ')})`;
}

const twoPoints = ([x1, y1, x2, y2]) => [{ x: 0, y: 0, out: [x1, y1] }, { x: 1, y: 1, in: [x2, y2] }];

/**
 * Points of a preset drawn by a formula (Spring): one where it turns
 * (each peak and dip) and more where it bends a lot, with handles along its
 * slope, so editing it keeps its shape.
 */
function fitPoints(fn) {
  const N = 2000;
  const slope = (t) => {
    const h = 1e-4;
    const a = Math.max(0, t - h), b = Math.min(1 - 1e-9, t + h);
    return (fn(b) - fn(a)) / (b - a);
  };
  const xs = [0];
  for (let i = 1; i < N; i++) {
    const a = fn((i - 1) / N), b = fn(i / N), c = fn((i + 1) / N);
    if ((b - a) * (c - b) < 0) xs.push(i / N);
  }
  xs.push(1);
  const at = (x) => ({ x, y: x >= 1 ? 1 : fn(x), d: x >= 1 ? slope(1 - 1e-3) : slope(x) });
  // A segment between two points, along their slopes: try handle lengths
  // and keep the closest fit.
  const fitSeg = (a, b) => {
    const w = b.x - a.x;
    let best = null;
    for (let i = 1; i <= 12; i++) {
      for (let j = 1; j <= 12; j++) {
        const ha = (w * i) / 13, hb = (w * j) / 13;
        const c1 = [a.x + ha, a.y + a.d * ha], c2 = [b.x - hb, b.y - b.d * hb];
        const f = cubicFn([a.x, a.y], c1, c2, [b.x, b.y]);
        let e = 0;
        for (let k = 1; k < 16; k++) {
          const x = a.x + (w * k) / 16;
          e = Math.max(e, Math.abs(f(x) - fn(x)));
        }
        if (!best || e < best.e) best = { e, c1, c2 };
      }
    }
    return best;
  };
  let pts = xs.map(at);
  for (let pass = 0; pass < 4 && pts.length < 16; pass++) {
    const next = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (fitSeg(pts[i - 1], pts[i]).e > 0.006) next.push(at((pts[i - 1].x + pts[i].x) / 2));
      next.push(pts[i]);
    }
    if (next.length === pts.length) break;
    pts = next;
  }
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  for (let i = 1; i < pts.length; i++) {
    const { c1, c2 } = fitSeg(pts[i - 1], pts[i]);
    out[i - 1].out = c1;
    out[i].in = c2;
  }
  return out;
}

const fitted = new Map();
const clonePts = (pts) => pts.map((p) => ({ ...p, in: p.in && [...p.in], out: p.out && [...p.out] }));

/**
 * Editable points for any easing: a curve's own, a preset's (Spring is
 * fitted point by point; the rest use their CSS cubic-bezier), or a
 * sensible start for Hold. Always a fresh copy.
 */
export function pointsOf(name) {
  if (isCurve(name)) {
    const pts = parseCurve(name);
    if (pts) return pts;
  }
  if (name === 'spring') {
    if (!fitted.has(name)) fitted.set(name, fitPoints(EASINGS[name].fn));
    return clonePts(fitted.get(name));
  }
  if (name === 'linear') return twoPoints([1 / 3, 1 / 3, 2 / 3, 2 / 3]);
  return twoPoints(bezierOf(name) || [0.25, 0.1, 0.25, 1]);
}

/** y(x) for a list of points. */
function pointsFn(pts) {
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    segs.push({ x0: a.x, x1: b.x, f: cubicFn([a.x, a.y], a.out, b.in, [b.x, b.y]) });
  }
  return (x) => {
    const s = segs.find((g) => x <= g.x1) || segs[segs.length - 1];
    return s.f(x);
  };
}

const curveCache = new Map();
function customFn(name) {
  if (!curveCache.has(name)) {
    if (curveCache.size > 300) curveCache.clear(); // dragging makes many one-off curves
    const p = isCurve(name) ? parseCurve(name) : null;
    const b = p ? null : parseBezier(name);
    curveCache.set(name, p ? pointsFn(p) : b ? bezierFn(b) : (t) => t);
  }
  return curveCache.get(name);
}

export const easeLabel = (name) => EASINGS[name]?.label || (isBezier(name) || isCurve(name) ? 'Custom' : 'Linear');
export const easeCss = (name) => {
  if (EASINGS[name]) return EASINGS[name].css;
  if (isBezier(name)) return name;
  if (!isCurve(name)) return 'linear';
  // CSS can't draw a curve with more points: follow it with linear() steps.
  const v = [];
  for (let i = 0; i <= 40; i++) v.push(+ease(name, i / 40).toFixed(4));
  return `linear(${v.join(', ')})`;
};

export function ease(name, t) {
  t = clamp01(t);
  if (isBezier(name) || isCurve(name)) return t <= 0 ? 0 : t >= 1 ? 1 : customFn(name)(t);
  return (EASINGS[name] || EASINGS.linear).fn(t);
}

/** Small SVG of the curve, for menus and segment labels. */
export function curveSVG(name, w = 40, h = 28) {
  const pad = 4;
  const lo = -0.25;
  const hi = 1.35;
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo));
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    pts.push(`${(pad + (w - 2 * pad) * t).toFixed(1)},${y(ease(name, t)).toFixed(1)}`);
  }
  return `<svg class="curve" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <line x1="${pad}" x2="${w - pad}" y1="${y(0)}" y2="${y(0)}" class="curve-base"/>
    <line x1="${pad}" x2="${w - pad}" y1="${y(1)}" y2="${y(1)}" class="curve-base"/>
    <polyline points="${pts.join(' ')}" class="curve-line"/>
  </svg>`;
}
