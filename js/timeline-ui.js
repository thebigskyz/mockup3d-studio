// Timeline panel: ruler, playhead, and a keyframe track for the camera and
// for each device (with the device's design underneath).

import { EASINGS, EASING_ORDER, curveSVG, ease, easeLabel, bezierOf, bezierName } from './easing.js';
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

  // ---- easing editor (curve with two draggable handles + presets) --------
  let popIndex = -1;
  let popTrack = null;
  let popAnim = 0;
  const U = 150;      // pixels per unit on the graph
  const P = 18;       // padding
  const Y_TOP = 1.3;  // visible value range: -0.3 .. 1.3
  const Y_BOT = -0.3;
  const GW = U + 2 * P;
  const GH = (Y_TOP - Y_BOT) * U + 2 * P;
  const gx = (x) => P + x * U;
  const gy = (y) => P + (Y_TOP - y) * U;

  function openPop(seg, trackId, i) {
    const key = view(trackId).keyframes[i];
    if (!key) return;
    popIndex = i;
    popTrack = trackId;
    pop.innerHTML = `
      <div class="ep-editor">
        <div class="ep-title">Easing curve <span class="ep-name" data-name></span></div>
        <svg class="ep-graph" viewBox="0 0 ${GW} ${GH}" style="width:${GW}px;height:${GH}px">
          <rect class="ep-area" x="${gx(0)}" y="${gy(1)}" width="${U}" height="${U}" rx="3"/>
          ${[0.25, 0.5, 0.75].map((v) => `<line class="ep-grid" x1="${gx(v)}" x2="${gx(v)}" y1="${gy(1)}" y2="${gy(0)}"/><line class="ep-grid" x1="${gx(0)}" x2="${gx(1)}" y1="${gy(v)}" y2="${gy(v)}"/>`).join('')}
          <line class="ep-diag" x1="${gx(0)}" y1="${gy(0)}" x2="${gx(1)}" y2="${gy(1)}"/>
          <line class="ep-arm" data-arm="1"/><line class="ep-arm" data-arm="2"/>
          <path class="ep-curve" data-curve/>
          <circle class="ep-end" cx="${gx(0)}" cy="${gy(0)}" r="3.5"/><circle class="ep-end" cx="${gx(1)}" cy="${gy(1)}" r="3.5"/>
          <circle class="ep-dot" data-dot r="4"/>
          <circle class="ep-handle" data-h="1" r="7"/><circle class="ep-handle" data-h="2" r="7"/>
          <text class="ep-axis" x="${gx(0)}" y="${GH - 4}">time →</text>
          <text class="ep-axis" x="${gx(0) - 4}" y="${gy(1) - 6}">value</text>
        </svg>
        <div class="ep-fields">
          ${['x1', 'y1', 'x2', 'y2'].map((n, j) => `<label><span>${n}</span><input type="number" step="0.01" data-f="${j}"></label>`).join('')}
        </div>
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

    // Drag a handle: x is time (kept within 0..1), y is value (can overshoot).
    const svg = pop.querySelector('.ep-graph');
    for (const h of pop.querySelectorAll('.ep-handle')) {
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        const which = +h.dataset.h;
        const move = (ev) => {
          const r = svg.getBoundingClientRect();
          const sx = GW / r.width;
          const x = Math.min(1, Math.max(0, ((ev.clientX - r.left) * sx - P) / U));
          const y = Math.min(Y_TOP, Math.max(Y_BOT, Y_TOP - ((ev.clientY - r.top) * sx - P) / U));
          const p = handlesFor(key);
          if (which === 1) { p[0] = x; p[1] = y; } else { p[2] = x; p[3] = y; }
          setCurve(key, p);
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.removeEventListener('pointerup', up);
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
      });
    }
    for (const input of pop.querySelectorAll('[data-f]')) {
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (!Number.isFinite(v)) return;
        const j = +input.dataset.f;
        const p = handlesFor(key);
        p[j] = j % 2 === 0 ? Math.min(1, Math.max(0, v)) : Math.min(3, Math.max(-2, v));
        setCurve(key, p, { keepFields: true });
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
      dot.setAttribute('cy', gy(Math.min(Y_TOP, Math.max(Y_BOT, v))));
      pop.querySelector('[data-ball]').style.left = `${Math.min(110, Math.max(-10, v * 100))}%`;
      popAnim = requestAnimationFrame(tick);
    };
    popAnim = requestAnimationFrame(tick);
  }

  // Handles to show for an easing: its own, or a sensible start for Hold.
  const handlesFor = (key) => bezierOf(key.ease) || [0.25, 0.1, 0.25, 1];

  function setCurve(key, p, { keepFields = false } = {}) {
    key.ease = bezierName(p);
    syncEditor(key, keepFields);
    render();
    opts.onEdit('ease');
  }

  function syncEditor(key, keepFields = false) {
    const p = handlesFor(key);
    const N = 64;
    let d = '';
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const v = Math.min(Y_TOP + 0.2, Math.max(Y_BOT - 0.2, ease(key.ease, t)));
      d += `${i ? 'L' : 'M'}${gx(t).toFixed(1)},${gy(v).toFixed(1)}`;
    }
    pop.querySelector('[data-curve]').setAttribute('d', d);
    const clampY = (y) => Math.min(Y_TOP, Math.max(Y_BOT, y));
    const h1 = [gx(p[0]), gy(clampY(p[1]))];
    const h2 = [gx(p[2]), gy(clampY(p[3]))];
    const set = (el, attrs) => { for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); };
    set(pop.querySelector('[data-h="1"]'), { cx: h1[0], cy: h1[1] });
    set(pop.querySelector('[data-h="2"]'), { cx: h2[0], cy: h2[1] });
    set(pop.querySelector('[data-arm="1"]'), { x1: gx(0), y1: gy(0), x2: h1[0], y2: h1[1] });
    set(pop.querySelector('[data-arm="2"]'), { x1: gx(1), y1: gy(1), x2: h2[0], y2: h2[1] });
    pop.querySelector('[data-name]').textContent = easeLabel(key.ease);
    if (!keepFields) {
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
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.tl-seg')) closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePop();
  });

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
