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

// y(x) for a CSS cubic-bezier: solve x(t) = x with Newton's method, then bisection.
function bezierFn([x1, y1, x2, y2]) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
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

const bezierCache = new Map();
function customFn(name) {
  if (!bezierCache.has(name)) {
    if (bezierCache.size > 300) bezierCache.clear(); // dragging makes many one-off curves
    const p = parseBezier(name);
    bezierCache.set(name, p ? bezierFn(p) : (t) => t);
  }
  return bezierCache.get(name);
}

export const easeLabel = (name) => EASINGS[name]?.label || (isBezier(name) ? 'Custom' : 'Linear');
export const easeCss = (name) => EASINGS[name]?.css || (isBezier(name) ? name : 'linear');

export function ease(name, t) {
  t = clamp01(t);
  if (isBezier(name)) return t <= 0 ? 0 : t >= 1 ? 1 : customFn(name)(t);
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
