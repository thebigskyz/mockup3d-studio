// Timeline panel: ruler, playhead, and a keyframe track for the camera and
// for each device (with the device's design underneath).

import { EASINGS, EASING_ORDER, curveSVG, ease, easeLabel, pointsOf, curveName } from './easing.js';
import { moveKey, duplicateKey, resolveOverlaps, snapTime, trackView, keyAt } from './timeline.js';

const $ = (id) => document.getElementById(id);
const PAD = 14; // px of breathing room at each end of the timeline

/**
 * @param opts.getAnim     () => anim (shared timing + tracks)
 * @param opts.getTime     () => playhead seconds
 * @param opts.setTime     (t) => void
 * @param opts.getTracks   () => [{ id, kind: 'camera'|'device', label, icon?, selected?, design? }]
 *                         design: { kind: 'video'|'image'|null, name, duration }
 * @param opts.selectTrack (id) => void   a track's header or row was clicked
 * @param opts.toggleKey   (id) => void   a track's key button was clicked
 * @param opts.onEdit      (what) => void keyframes changed
 */
export function createTimelineUI(opts) {
  const main = $('tlMain');
  const ruler = $('tlRuler');
  const heads = $('tlHeads');
  const tracksEl = $('tlTracks');
  const playhead = $('tlPlayhead');
  const pop = $('easePop');
  let sel = new Set(); // selected keyframe ids (all on one track)
  let selTrack = null;

  const view = (id) => trackView(opts.getAnim(), id);
  const width = () => tracksEl.clientWidth || main.clientWidth;
  const x = (t) => PAD + (t / opts.getAnim().duration) * (width() - 2 * PAD);
  const tAt = (clientX) => {
    const r = main.getBoundingClientRect();
    const u = (clientX - r.left - PAD) / (width() - 2 * PAD);
    return u * opts.getAnim().duration;
  };

  // ---- rendering ----------------------------------------------------------
  function render() {
    const tracks = opts.getTracks();
    renderRuler();
    renderHeads(tracks);
    renderTracks(tracks);
    updatePlayhead();
  }

  function renderRuler() {
    const anim = opts.getAnim();
    const w = width() - 2 * PAD;
    const pps = w / anim.duration;
    const steps = [1 / anim.fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30];
    const major = steps.find((s) => s * pps >= 70) || 30;
    const minor = steps.slice().reverse().find((s) => s < major && s * pps >= 9) || major;
    let html = '';
    for (let t = 0; t <= anim.duration + 1e-6; t += minor) {
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += `<i class="${isMajor ? 'major' : ''}" style="left:${x(t)}px"></i>`;
      if (isMajor) html += `<b style="left:${x(t)}px">${label(t)}</b>`;
    }
    html += `<div class="tl-endmark" style="left:${x(anim.duration)}px"></div>`;
    ruler.innerHTML = html;
  }

  const label = (t) => (t % 1 === 0 ? `${t}s` : `${+t.toFixed(2)}s`);

  function renderHeads(tracks) {
    heads.innerHTML = tracks.map((tr) => {
      const icon = tr.kind === 'camera' ? 'camera' : tr.icon || 'phone';
      const sub = tr.kind === 'device' ? `<em>${tr.design?.kind ? escapeHTML(tr.design.name || '') : 'No design'}</em>` : '';
      const tip = tr.kind === 'camera' ? 'Camera: zoom, focal length and pan' : `${tr.label} — click to select`;
      return `<div class="tl-head ${tr.kind}${tr.selected ? ' sel' : ''}" data-track="${tr.id}" title="${escapeHTML(tip)}">
        <svg><use href="#i-${icon}"/></svg><span><b>${escapeHTML(tr.label)}</b>${sub}</span>
        <button class="icon-btn sm key-btn" data-key="${tr.id}" title="Add / remove ${tr.kind === 'camera' ? 'camera ' : ''}keyframe at playhead${tr.kind === 'camera' ? '' : ' (K)'}"><svg><use href="#i-key-o"/></svg></button>
      </div>`;
    }).join('');
  }

  function renderTracks(tracks) {
    const single = tracks.filter((t) => t.kind === 'device').length === 1;
    tracksEl.innerHTML = tracks.map((tr) => `<div class="tl-row ${tr.kind}${tr.selected ? ' sel' : ''}" data-track="${tr.id}">
        <div class="tl-track" data-track="${tr.id}">${keysHTML(tr, single)}</div>
        ${tr.kind === 'device' ? `<div class="tl-design">${designHTML(tr.design)}</div>` : ''}
      </div>`).join('');
  }

  function keysHTML(tr, single) {
    const anim = opts.getAnim();
    const k = view(tr.id).keyframes;
    let html = `<div class="tl-rail" style="left:${PAD}px;right:${PAD}px"></div>`;
    for (let i = 0; i < k.length - 1; i++) {
      const a = k[i];
      const b = k[i + 1];
      const left = x(a.t);
      const w = x(b.t) - left;
      const name = easeLabel(a.ease);
      const editing = tr.id === popTrack && i === popIndex;
      html += `<button class="tl-seg${editing ? ' editing' : ''}" data-track="${tr.id}" data-i="${i}" style="left:${left}px;width:${w}px" title="${name} — click to edit the easing curve">
        ${w > 46 ? curveSVG(a.ease, 26, 14) : ''}${w > 110 ? `<span>${name}</span>` : ''}</button>`;
    }
    const visible = k.filter((key) => key.t <= anim.duration + 1e-6);
    const hidden = k.length - visible.length;
    for (const key of visible) {
      const on = tr.id === selTrack && sel.has(key.id);
      html += `<div class="tl-key${on ? ' sel' : ''}" data-track="${tr.id}" data-id="${key.id}" style="left:${x(key.t)}px" title="${key.t.toFixed(2)}s — Shift-click to select several, drag to move, Alt-drag to duplicate, ⌘C / ⌘V to copy and paste, Delete to remove"></div>`;
    }
    if (hidden) {
      html += `<div class="tl-more" title="${hidden} keyframe${hidden === 1 ? '' : 's'} after the end of the timeline — lengthen it to see ${hidden === 1 ? 'it' : 'them'}">+${hidden} ▸</div>`;
    }
    if (!k.length) {
      const msg = tr.kind === 'camera'
        ? 'Camera isn’t animated — key it from Inspector › Camera'
        : single ? 'No keyframes — pick a Motion preset, or press <kbd>K</kbd> to key the current angle' : 'No keyframes';
      html += `<div class="tl-empty">${msg}</div>`;
    }
    return html;
  }

  function designHTML(d) {
    const anim = opts.getAnim();
    if (!d?.kind) return '';
    if (d.kind === 'image' || !(d.duration > 0)) return clip(0, anim.duration, d.name, 'still');
    let html = '';
    for (let t = 0, n = 0; t < anim.duration - 1e-6 && n < 200; t += d.duration, n++) {
      html += clip(t, Math.min(anim.duration, t + d.duration), n ? `${d.name} (loop)` : d.name, n ? 'loop' : '');
    }
    return html;
  }

  const clip = (t0, t1, name, cls) =>
    `<div class="tl-clip ${cls}" style="left:${x(t0)}px;width:${Math.max(2, x(t1) - x(t0) - 1)}px"><span>${escapeHTML(name || '')}</span></div>`;

  function updatePlayhead() {
    const t = opts.getTime();
    playhead.style.left = `${x(t)}px`;
    // Key buttons light up where a track has a keyframe.
    for (const b of heads.querySelectorAll('[data-key]')) {
      const on = !!keyAt(view(b.dataset.key), t);
      if (b.classList.contains('on') === on) continue;
      b.classList.toggle('on', on);
      b.querySelector('use').setAttribute('href', on ? '#i-key' : '#i-key-o');
    }
  }

  // ---- interaction --------------------------------------------------------
  // Track headers: click to select the device, key button to key it.
  heads.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]');
    if (key) return opts.toggleKey(key.dataset.key);
    const head = e.target.closest('.tl-head');
    if (head) opts.selectTrack(head.dataset.track);
  });
  // Headers scroll with the tracks.
  tracksEl.addEventListener('scroll', () => { heads.scrollTop = tracksEl.scrollTop; });
  heads.addEventListener('wheel', (e) => {
    tracksEl.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  // Scrub by dragging on the ruler or on empty track space.
  main.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.tl-key, .tl-seg')) return;
    // Clicking a device's row selects that device.
    const row = e.target.closest('.tl-row');
    if (row) opts.selectTrack(row.dataset.track);
    closePop();
    main.setPointerCapture(e.pointerId);
    const scrub = (ev) => opts.setTime(snapTime(opts.getAnim(), tAt(ev.clientX)));
    scrub(e);
    const move = (ev) => scrub(ev);
    const up = () => {
      main.removeEventListener('pointermove', move);
      main.removeEventListener('pointerup', up);
    };
    main.addEventListener('pointermove', move);
    main.addEventListener('pointerup', up);
  });

  // Keyframes: click to select + jump, Shift/⌘-click to add to the selection,
  // drag to move the selection, Alt-drag to duplicate it.
  tracksEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.tl-key');
    if (e.button !== 0) return;
    if (!el) {
      // Empty track space: clear the selection (the scrub handler moves the playhead).
      if (!e.target.closest('.tl-seg') && sel.size) select(null);
      return;
    }
    e.stopPropagation();
    closePop();
    const trackId = el.dataset.track;
    const tr = view(trackId);
    const key = tr.keyframes.find((k) => k.id === el.dataset.id);
    if (!key) return;
    opts.selectTrack(trackId);
    const additive = (e.shiftKey || e.metaKey || e.ctrlKey) && selTrack === trackId;
    if (additive) {
      const next = new Set(sel);
      if (next.has(key.id)) next.delete(key.id);
      else next.add(key.id);
      select([...next], trackId);
      return;
    }
    const wasSelected = selTrack === trackId && sel.has(key.id);
    if (!wasSelected) select([key.id], trackId);

    const startX = e.clientX;
    let moving = tr.keyframes.filter((k) => sel.has(k.id));
    let starts = moving.map((k) => k.t);
    let moved = false;
    tracksEl.setPointerCapture(e.pointerId);

    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      if (!moved && ev.altKey) {
        // Alt-drag: leave the originals and drag copies.
        moving = moving.map((k) => duplicateKey(tr, k.id));
        starts = moving.map((k) => k.t);
        select(moving.map((k) => k.id), trackId);
      }
      moved = true;
      const anim = opts.getAnim();
      const pxPerSec = (width() - 2 * PAD) / anim.duration;
      // Keep the whole group inside the timeline.
      let dt = (ev.clientX - startX) / pxPerSec;
      dt = Math.max(-Math.min(...starts), Math.min(anim.duration - Math.max(...starts), dt));
      moving.forEach((k, i) => moveKey(tr, k.id, starts[i] + dt));
      opts.setTime(key.t);
      render();
      opts.onEdit('move');
    };
    const up = () => {
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      if (moved) {
        for (const k of moving) resolveOverlaps(tr, k.id);
        render();
        opts.onEdit('move');
      } else {
        if (wasSelected && sel.size > 1) select([key.id], trackId); // plain click narrows to one
        opts.setTime(key.t);
      }
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
  });

  // Segments: click to choose an easing.
  tracksEl.addEventListener('click', (e) => {
    const seg = e.target.closest('.tl-seg');
    if (!seg) return;
    e.stopPropagation();
    openPop(seg, seg.dataset.track, +seg.dataset.i);
  });

  // ---- easing editor (a curve of points with handles + presets) ----------
  // Works like Figma's vector editing: click the line to add a point (and
  // drag to place it), click a point to select it and show its handles,
  // Delete or Backspace removes the selected point. A point's two handles
  // stay in line (a smooth curve) unless you Alt-drag one. Up to three
  // points between the two ends.
  let popIndex = -1;
  let popTrack = null;
  let popAnim = 0;
  let selPt = -1; // the point whose handles show (-1: none)
  const U = 200;      // pixels per unit on the graph
  const P = 18;       // padding
  const Y_TOP = 1.3;  // visible value range: -0.3 .. 1.3
  const Y_BOT = -0.3;
  const GW = U + 2 * P;
  const GH = (Y_TOP - Y_BOT) * U + 2 * P;
  const gx = (x) => P + x * U;
  const gy = (y) => P + (Y_TOP - y) * U;
  const clampY = (y) => Math.min(Y_TOP, Math.max(Y_BOT, y));
  const MIN_GAP = 0.01; // points stay at least this far apart in time
  const MAX_INNER = 3;  // points allowed between the two ends

  function openPop(seg, trackId, i) {
    const key = view(trackId).keyframes[i];
    if (!key) return;
    popIndex = i;
    popTrack = trackId;
    selPt = -1;
    pop.innerHTML = `
      <div class="ep-editor">
        <div class="ep-title">Easing curve <span class="ep-name" data-name></span></div>
        <svg class="ep-graph" viewBox="0 0 ${GW} ${GH}" style="width:${GW}px;height:${GH}px">
          <rect class="ep-area" x="${gx(0)}" y="${gy(1)}" width="${U}" height="${U}" rx="3"/>
          ${[0.25, 0.5, 0.75].map((v) => `<line class="ep-grid" x1="${gx(v)}" x2="${gx(v)}" y1="${gy(1)}" y2="${gy(0)}"/><line class="ep-grid" x1="${gx(0)}" x2="${gx(1)}" y1="${gy(v)}" y2="${gy(v)}"/>`).join('')}
          <line class="ep-diag" x1="${gx(0)}" y1="${gy(0)}" x2="${gx(1)}" y2="${gy(1)}"/>
          <path class="ep-curve" data-curve/>
          <path class="ep-hit" data-hit/>
          <g data-points></g>
          <circle class="ep-ghost" data-ghost r="4.5" visibility="hidden"/>
          <circle class="ep-dot" data-dot r="4"/>
          <text class="ep-axis" x="${gx(0)}" y="${GH - 4}">time →</text>
          <text class="ep-axis" x="${gx(0) - 4}" y="${gy(1) - 6}">value</text>
        </svg>
        <div class="ep-fields">
          ${['x1', 'y1', 'x2', 'y2'].map((n, j) => `<label><span>${n}</span><input type="number" step="0.01" data-f="${j}"></label>`).join('')}
        </div>
        <div class="ep-hint"></div>
        <div class="ep-preview"><i data-ball></i></div>
      </div>
      <div class="ep-presets">
        <div class="ep-title">Presets</div>
        ${EASING_ORDER.map((name) => `<button data-e="${name}">${curveSVG(name)}<span>${EASINGS[name].label}</span></button>`).join('')}
      </div>`;
    pop.hidden = false;
    position(seg);
    syncEditor(key);
    render();

    const svg = pop.querySelector('.ep-graph');
    const toUnit = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = GW / r.width;
      return [((ev.clientX - r.left) * sx - P) / U, Y_TOP - ((ev.clientY - r.top) * sx - P) / U];
    };

    // Press on a point or handle to drag it, or on the line to add a point
    // there and drag it. Pressing empty space deselects.
    // x is time, y is value (it can overshoot).
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let el = e.target.closest('[data-n]');
      if (!el && e.target.closest('[data-hit]')) {
        const pts = pointsOf(key.ease);
        const [x] = toUnit(e);
        const n = pts.length - 2 < MAX_INNER && x > MIN_GAP && x < 1 - MIN_GAP ? addPoint(pts, x) : -1;
        if (n < 0) return;
        selPt = n;
        setCurve(key, pts);
        el = pop.querySelector(`.ep-point[data-n="${n}"]`);
      }
      if (!el) {
        if (selPt !== -1) { selPt = -1; syncEditor(key); }
        return;
      }
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      hideGhost();
      const n = +el.dataset.n;
      const side = el.dataset.side; // 'in' / 'out' for a handle, none for the point
      if (!side && selPt !== n) {
        selPt = n;
        syncEditor(key);
      }
      const isEnd = n === 0 || n === pointsOf(key.ease).length - 1;
      const move = (ev) => {
        if (!side && isEnd) return; // the ends stay at 0 and 1
        const [x, y] = toUnit(ev);
        const pts = pointsOf(key.ease);
        if (side) moveHandle(pts, n, side, x, clampY(y), !ev.altKey);
        else movePoint(pts, n, x, clampY(y));
        setCurve(key, pts);
      };
      const up = () => {
        svg.removeEventListener('pointermove', move);
        svg.removeEventListener('pointerup', up);
      };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerup', up);
    });

    // Hovering the line shows where a click would add a point.
    const ghost = pop.querySelector('[data-ghost]');
    const hideGhost = () => ghost.setAttribute('visibility', 'hidden');
    svg.addEventListener('pointermove', (e) => {
      if (svg.hasPointerCapture(e.pointerId) || !e.target.closest('[data-hit]')) return hideGhost();
      const [x] = toUnit(e);
      const full = pointsOf(key.ease).length - 2 >= MAX_INNER;
      if (full || x <= MIN_GAP || x >= 1 - MIN_GAP) return hideGhost();
      ghost.setAttribute('cx', gx(x));
      ghost.setAttribute('cy', gy(clampY(ease(key.ease, x))));
      ghost.setAttribute('visibility', 'visible');
    });
    svg.addEventListener('pointerleave', hideGhost);

    for (const input of pop.querySelectorAll('[data-f]')) {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        const j = +input.dataset.f;
        const pts = pointsOf(key.ease);
        if (pts.length !== 2) return;
        const h = j < 2 ? pts[0].out : pts[1].in;
        h[j % 2] = j % 2 === 0 ? Math.min(1, Math.max(0, v)) : Math.min(3, Math.max(-2, v));
        setCurve(key, pts, { keepFields: true });
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // typing here shouldn't trigger app shortcuts
        if (e.key === 'Enter' || e.key === 'Escape') input.blur();
      });
    }
    pop.onclick = (ev) => {
      const b = ev.target.closest('button[data-e]');
      if (!b) return;
      key.ease = b.dataset.e;
      selPt = -1;
      syncEditor(key);
      render();
      opts.onEdit('ease');
    };

    // Preview: a dot runs along the curve and a ball across the strip.
    cancelAnimationFrame(popAnim);
    const t0 = performance.now();
    const tick = (now) => {
      if (pop.hidden) return;
      const cycle = ((now - t0) / 1000) % 1.6;
      const t = Math.min(1, cycle / 1.2);
      const v = ease(key.ease, t);
      const dot = pop.querySelector('[data-dot]');
      dot.setAttribute('cx', gx(t));
      dot.setAttribute('cy', gy(clampY(v)));
      pop.querySelector('[data-ball]').style.left = `${Math.min(110, Math.max(-10, v * 100))}%`;
      popAnim = requestAnimationFrame(tick);
    };
    popAnim = requestAnimationFrame(tick);
  }

  // Keep every handle within its own segment's time span, so the curve
  // never runs backwards in time.
  function tidy(pts) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.in) p.in[0] = Math.min(p.x, Math.max(pts[i - 1].x, p.in[0]));
      if (p.out) p.out[0] = Math.max(p.x, Math.min(pts[i + 1].x, p.out[0]));
    }
  }

  function moveHandle(pts, n, side, x, y, smooth) {
    const p = pts[n];
    const h = p[side];
    if (!h) return;
    h[0] = x;
    h[1] = y;
    tidy(pts);
    // Keep the other handle in line, at its own length.
    const other = side === 'in' ? 'out' : 'in';
    if (smooth && p[other]) {
      const dx = p.x - h[0], dy = p.y - h[1];
      const len = Math.hypot(dx, dy);
      const keep = Math.hypot(p[other][0] - p.x, p[other][1] - p.y);
      if (len > 1e-6) p[other] = [p.x + (dx / len) * keep, p.y + (dy / len) * keep];
      tidy(pts);
    }
  }

  function movePoint(pts, n, x, y) {
    const p = pts[n];
    if (n === 0 || n === pts.length - 1) return; // the ends stay at 0 and 1
    x = Math.min(pts[n + 1].x - MIN_GAP, Math.max(pts[n - 1].x + MIN_GAP, x));
    const dx = x - p.x, dy = y - p.y;
    p.x = x;
    p.y = y;
    for (const h of [p.in, p.out]) { h[0] += dx; h[1] += dy; }
    tidy(pts);
  }

  // Split the segment under time x into two at that point, with handles
  // that keep the curve's shape (de Casteljau).
  function addPoint(pts, x) {
    const i = pts.findIndex((p) => p.x >= x);
    const a = pts[i - 1], b = pts[i];
    if (x - a.x < MIN_GAP || b.x - x < MIN_GAP) return -1;
    const P0 = [a.x, a.y], P1 = a.out, P2 = b.in, P3 = [b.x, b.y];
    const at = (u) => {
      const m = 1 - u;
      return m * m * m * P0[0] + 3 * m * m * u * P1[0] + 3 * m * u * u * P2[0] + u * u * u * P3[0];
    };
    let lo = 0, hi = 1, u = 0.5;
    for (let k = 0; k < 40; k++) {
      u = (lo + hi) / 2;
      if (at(u) < x) lo = u;
      else hi = u;
    }
    const lerp = (p, q) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
    const q0 = lerp(P0, P1), q1 = lerp(P1, P2), q2 = lerp(P2, P3);
    const r0 = lerp(q0, q1), r1 = lerp(q1, q2);
    const s = lerp(r0, r1);
    a.out = q0;
    b.in = q2;
    pts.splice(i, 0, { x: s[0], y: s[1], in: r0, out: r1 });
    return i;
  }

  function setCurve(key, pts, { keepFields = false } = {}) {
    key.ease = curveName(pts);
    syncEditor(key, keepFields);
    render();
    opts.onEdit('ease');
  }

  function syncEditor(key, keepFields = false) {
    const pts = pointsOf(key.ease);
    const N = 96;
    let d = '';
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const v = Math.min(Y_TOP + 0.2, Math.max(Y_BOT - 0.2, ease(key.ease, t)));
      d += `${i ? 'L' : 'M'}${gx(t).toFixed(1)},${gy(v).toFixed(1)}`;
    }
    pop.querySelector('[data-curve]').setAttribute('d', d);
    pop.querySelector('[data-hit]').setAttribute('d', d);

    // Arms and handles first, so the points sit on top.
    const last = pts.length - 1;
    const two = pts.length === 2;
    if (selPt > last) selPt = -1;
    let arms = '', handles = '', dots = '';
    pts.forEach((p, n) => {
      const px = gx(p.x), py = gy(clampY(p.y));
      if (two || n === selPt) {
        for (const side of ['in', 'out']) {
          const h = p[side];
          if (!h) continue;
          const hx = gx(h[0]).toFixed(1), hy = gy(clampY(h[1])).toFixed(1);
          arms += `<line class="ep-arm" x1="${px}" y1="${py}" x2="${hx}" y2="${hy}"/>`;
          handles += `<circle class="ep-handle${two ? '' : ' small'}" data-n="${n}" data-side="${side}" cx="${hx}" cy="${hy}" r="${two ? 7 : 5.5}"/>`;
        }
      }
      // The ends can be clicked to show their handle, but stay where they are.
      dots += n === 0 || n === last
        ? `<circle class="ep-end${two ? '' : ' pick'}${n === selPt ? ' on' : ''}" data-n="${n}" cx="${px}" cy="${py}" r="${two ? 3.5 : 4.5}"/>`
        : `<rect class="ep-point${n === selPt ? ' on' : ''}" data-n="${n}" x="${px - 4.5}" y="${py - 4.5}" width="9" height="9" rx="1.5"><title>Click to select · drag to move · Delete to remove</title></rect>`;
    });
    pop.querySelector('[data-points]').innerHTML = arms + handles + dots;

    pop.querySelector('[data-name]').textContent = easeLabel(key.ease);
    pop.querySelector('.ep-fields').hidden = !two;
    const full = last - 1 >= MAX_INNER;
    pop.querySelector('.ep-hint').textContent = two
      ? 'Click the line to add a point.'
      : `${full ? `Up to ${MAX_INNER} points: delete one to add another.` : 'Click the line to add a point.'} Select a point and press Delete to remove it.`;
    pop.querySelector('[data-hit]').classList.toggle('full', full);
    if (two && !keepFields) {
      const p = [...pts[0].out, ...pts[1].in];
      pop.querySelectorAll('[data-f]').forEach((input, j) => { input.value = +p[j].toFixed(2); });
    }
    for (const b of pop.querySelectorAll('button[data-e]')) b.classList.toggle('on', b.dataset.e === key.ease);
  }

  function position(seg) {
    const r = seg.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
    const top = r.top - ph - 8 > 8 ? r.top - ph - 8 : Math.max(8, Math.min(window.innerHeight - ph - 8, r.bottom + 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function closePop() {
    if (pop.hidden) return;
    pop.hidden = true;
    popIndex = -1;
    popTrack = null;
    cancelAnimationFrame(popAnim);
    render();
  }
  document.addEventListener('pointerdown', (e) => {
    // The path, not the target: clicking a point redraws the graph, which
    // takes the clicked element out of the popup.
    if (!pop.hidden && !e.composedPath().includes(pop) && !e.target.closest('.tl-seg')) closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop();
  });
  // While the easing editor is open, Delete / Backspace remove its selected
  // point and nothing else: they mustn't reach the timeline or the scene
  // (which would delete keyframes or the device).
  window.addEventListener('keydown', (e) => {
    if (pop.hidden || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
    if (e.target.closest?.('input, textarea')) return; // editing a number
    e.preventDefault();
    e.stopImmediatePropagation();
    const key = popTrack && view(popTrack).keyframes[popIndex];
    if (!key) return;
    const pts = pointsOf(key.ease);
    if (selPt <= 0 || selPt >= pts.length - 1) return; // the ends stay
    pts.splice(selPt, 1);
    selPt = -1;
    setCurve(key, pts);
  }, true);

  /**
   * Select keyframes by id (an id, an array of ids, or null for none) on one
   * track (found from the ids if not given).
   */
  function select(ids, trackId) {
    const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
    const tracks = opts.getAnim().tracks;
    if (!trackId) trackId = Object.keys(tracks).find((id) => tracks[id].some((k) => list.includes(k.id))) || null;
    const valid = new Set(trackId ? view(trackId).keyframes.map((k) => k.id) : []);
    sel = new Set(list.filter((id) => valid.has(id)));
    selTrack = sel.size ? trackId : null;
    for (const el of tracksEl.querySelectorAll('.tl-key')) {
      el.classList.toggle('sel', el.dataset.track === selTrack && sel.has(el.dataset.id));
    }
  }

  new ResizeObserver(render).observe(main);

  return {
    render,
    updatePlayhead,
    select,
    /** Selected keyframe ids, in time order. */
    get selectedIds() {
      return selTrack ? view(selTrack).keyframes.filter((k) => sel.has(k.id)).map((k) => k.id) : [];
    },
    /** The track the selected keyframes are on (null if none). */
    get selectedTrack() {
      return selTrack;
    },
  };
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
