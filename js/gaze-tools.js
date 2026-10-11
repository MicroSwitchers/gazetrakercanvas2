/* gaze-tools.js — the calibration tools menu: position guide, calibration, accuracy check.
 *
 *   Position  : the tracker's camera picture with a head-and-shoulders outline and a box showing where the eyes should be.
 *               "Mark this position" saves where the examiner sits (the eye box moves to where their eyes were, and their picture
 *               is kept as an onion skin) so the child can be lined up the same way afterwards.
 *   Calibrate : the examiner's 9-dot calibration (js/tet-direct.js).
 *   Check     : the random-dot accuracy check.
 *   Ctrl      : hold Ctrl on its own at any time to see the position guide over the page (even in full-screen Play).
 *
 *   const tools = GazeTools.create({ td: TetDirect.create(), isEnabled: () => true, drawer: document.getElementById('controls-drawer') });
 *   tools.open('position');
 */
(function (root) {
  'use strict';
  const LS = 'gazeTools.v1', MAX_REFS = 8, IMG = 280, DIST_OK = [450, 850];
  const DEFAULTS = { outline: true, box: true, onion: true, style: 'edges', alpha: 70, tolLat: 15, tolDepth: 50, tolRoll: 8, beep: false, checkN: 8, refName: 'Examiner' };
  const DEFAULT_EYES = [[112, 100], [168, 100]];                 // where the eyes should be in the (unmirrored) camera picture when nothing is marked
  const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (_) { return {}; } };
  const lsSet = v => { try { localStorage.setItem(LS, JSON.stringify(v)); return true; } catch (_) { return false; } };
  const $el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const b64 = px => { let s = ''; for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode.apply(null, px.subarray(i, i + 8192)); return btoa(s); };
  const unb64 = s => { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i); return a; };

  /* ---------------------------------------------------------------- camera picture helpers */
  /** Picture with its brightness stretched (the tracker's infrared picture is dark) -> a 280x280 canvas. */
  function livePicture(px, into) {
    const c = into || document.createElement('canvas'); c.width = c.height = IMG;
    const g = c.getContext('2d'), im = g.createImageData(IMG, IMG), d = im.data, hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i++) hist[px[i]]++;
    let acc = 0, p = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= px.length * 0.995) { p = v; break; } }
    const top = Math.max(60, p), lut = new Uint8Array(256); for (let v = 0; v < 256; v++) lut[v] = Math.min(255, 255 * Math.pow(Math.min(1, v / top), 0.75));
    for (let i = 0; i < px.length; i++) { const v = lut[px[i]]; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0); return c;
  }
  /** Outline (edges) or warm "ghost" of a stored picture, for laying over the live one. */
  function onionPicture(px, style) {
    const c = document.createElement('canvas'); c.width = c.height = IMG; const g = c.getContext('2d'), im = g.createImageData(IMG, IMG), d = im.data;
    if (style === 'ghost') {
      for (let i = 0; i < px.length; i++) { const v = Math.min(255, px[i] * 1.8); d[i * 4] = v; d[i * 4 + 1] = v * 0.6; d[i * 4 + 2] = v * 0.1; d[i * 4 + 3] = 255; }
    } else {                                        // edges: box blur, Sobel magnitude, scaled by its 97th percentile
      const bl = new Float32Array(px.length), mag = new Float32Array(px.length);
      for (let y = 1; y < IMG - 1; y++) for (let x = 1; x < IMG - 1; x++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += px[(y + j) * IMG + x + i]; bl[y * IMG + x] = s / 9; }
      for (let y = 2; y < IMG - 2; y++) for (let x = 2; x < IMG - 2; x++) {
        const i = y * IMG + x, gx = -bl[i - 281] - 2 * bl[i - 1] - bl[i + 279] + bl[i - 279] + 2 * bl[i + 1] + bl[i + 281], gy = -bl[i - 281] - 2 * bl[i - 280] - bl[i - 279] + bl[i + 279] + 2 * bl[i + 280] + bl[i + 281];
        mag[i] = Math.hypot(gx, gy);
      }
      const sorted = Float32Array.from(mag).sort(), p97 = sorted[Math.floor(sorted.length * 0.97)] || 1;
      for (let i = 0; i < px.length; i++) { const a = Math.min(1, mag[i] / p97); d[i * 4] = 255; d[i * 4 + 1] = 154; d[i * 4 + 2] = 60; d[i * 4 + 3] = a * a * 255; }
    }
    g.putImageData(im, 0, 0); return c;
  }
  /** Finds the two eyes in the camera picture from the small bright reflections on the eyes. -> [[x,y],[x,y]] (left, right) or null. */
  function findEyes(px) {
    const hist = new Uint32Array(256); let max = 0; for (let i = 0; i < px.length; i++) { hist[px[i]]++; if (px[i] > max) max = px[i]; }
    let acc = 0, p99 = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= px.length * 0.99) { p99 = v; break; } }
    const T = Math.max(90, p99 + 35);                           // eye reflections stand well above the brightest 1% of the scene
    if (max < T) return null;
    const seen = new Uint8Array(px.length), blobs = [];
    for (let i = 0; i < px.length && blobs.length < 60; i++) {
      if (px[i] < T || seen[i]) continue;
      const stack = [i]; seen[i] = 1; let n = 0, sx = 0, sy = 0, x0 = IMG, x1 = 0, y0 = IMG, y1 = 0;
      while (stack.length) {
        const j = stack.pop(), x = j % IMG, y = (j / IMG) | 0; n++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !seen[j - 1] && px[j - 1] >= T) { seen[j - 1] = 1; stack.push(j - 1); } if (x < IMG - 1 && !seen[j + 1] && px[j + 1] >= T) { seen[j + 1] = 1; stack.push(j + 1); }
        if (y > 0 && !seen[j - IMG] && px[j - IMG] >= T) { seen[j - IMG] = 1; stack.push(j - IMG); } if (y < IMG - 1 && !seen[j + IMG] && px[j + IMG] >= T) { seen[j + IMG] = 1; stack.push(j + IMG); }
      }
      if (n >= 2 && n <= 140 && x1 - x0 <= 18 && y1 - y0 <= 18) blobs.push({ x: sx / n, y: sy / n, n });
    }
    const groups = [];                                          // reflections within 16 px of each other belong to the same eye
    for (const b of blobs) { const gr = groups.find(g => g.m.some(o => Math.hypot(o.x - b.x, o.y - b.y) < 16)); if (gr) gr.m.push(b); else groups.push({ m: [b] }); }
    const eyes = groups.map(g => ({ x: g.m.reduce((a, o) => a + o.x, 0) / g.m.length, y: g.m.reduce((a, o) => a + o.y, 0) / g.m.length, w: g.m.reduce((a, o) => a + o.n, 0) }));
    let best = null, bs = -1e9;
    for (let i = 0; i < eyes.length; i++) for (let j = i + 1; j < eyes.length; j++) {
      const a = eyes[i], b = eyes[j], dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx < 18 || dx > 150 || dy > 0.4 * dx) continue;
      const s = a.w + b.w - dy * 0.5 - Math.abs((a.x + b.x) / 2 - IMG / 2) * 0.05; if (s > bs) { bs = s; best = a.x < b.x ? [[a.x, a.y], [b.x, b.y]] : [[b.x, b.y], [a.x, a.y]]; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- the guide drawing (shared by the panel and the Ctrl peek) */
  function drawGuide(c, v) {
    const W = c.width, g = c.getContext('2d'), k = W / IMG, MX = x => (IMG - x) * k, MY = y => y * k;      // the picture is shown mirrored, like a mirror
    g.clearRect(0, 0, W, W); g.fillStyle = '#05080a'; g.fillRect(0, 0, W, W);
    if (v.live) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(v.live, 0, 0, W, W); g.restore(); }
    if (v.onionCanvas && v.opts.onion) { g.save(); g.globalAlpha = v.opts.alpha / 100; g.translate(W, 0); g.scale(-1, 1); g.drawImage(v.onionCanvas, 0, 0, W, W); g.restore(); }
    const tone = v.aligned === true ? '#34d399' : v.aligned === false ? '#fbbf24' : '#ffffff';
    if (v.opts.outline) {                                                                                    // head and shoulders
      const s = W / 100; g.save(); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = Math.max(1.5, W / 220); g.setLineDash([W / 70, W / 100]); g.lineCap = 'round';
      g.beginPath(); g.ellipse(50 * s, 38 * s, 17 * s, 22 * s, 0, 0, 7); g.stroke();
      g.beginPath(); g.moveTo(43 * s, 59 * s); g.lineTo(43 * s, 68 * s); g.moveTo(57 * s, 59 * s); g.lineTo(57 * s, 68 * s); g.stroke();
      g.beginPath(); g.moveTo(43 * s, 68 * s); g.bezierCurveTo(30 * s, 70 * s, 12 * s, 74 * s, 8 * s, 100 * s); g.moveTo(57 * s, 68 * s); g.bezierCurveTo(70 * s, 70 * s, 88 * s, 74 * s, 92 * s, 100 * s); g.stroke(); g.restore();
    }
    if (v.opts.box) {                                                                                        // where the eyes should be
      const [a, b] = v.eyes, ax = MX(a[0]), ay = MY(a[1]), bx = MX(b[0]), by = MY(b[1]), sep = Math.hypot(ax - bx, ay - by), cx = (ax + bx) / 2, cy = (ay + by) / 2, hw = sep * 1.05, hh = sep * 0.55, r = sep * 0.2;
      g.save(); g.strokeStyle = tone; g.lineWidth = Math.max(2, W / 200); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 4;
      g.setLineDash([W / 45, W / 90]); g.beginPath(); g.roundRect(cx - hw, cy - hh, hw * 2, hh * 2, r); g.stroke(); g.setLineDash([]);
      for (const [ex, ey] of [[ax, ay], [bx, by]]) { g.beginPath(); g.arc(ex, ey, sep * 0.15, 0, 7); g.stroke(); g.beginPath(); g.moveTo(ex - sep * 0.24, ey); g.lineTo(ex - sep * 0.08, ey); g.moveTo(ex + sep * 0.08, ey); g.lineTo(ex + sep * 0.24, ey); g.moveTo(ex, ey - sep * 0.24); g.lineTo(ex, ey - sep * 0.08); g.moveTo(ex, ey + sep * 0.08); g.lineTo(ex, ey + sep * 0.24); g.stroke(); }
      g.restore();
    }
    if (v.liveEyes) {                                                                                        // where the eyes are now
      g.save(); g.fillStyle = tone; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 2;
      for (const [x, y] of v.liveEyes) { g.beginPath(); g.arc(MX(x), MY(y), Math.max(4, W / 70), 0, 7); g.stroke(); g.fill(); } g.restore();
    }
  }

  /* ---------------------------------------------------------------- the tools */
  function create(cfg) {
    const td = cfg.td, isEnabled = cfg.isEnabled || (() => true), saved = lsGet();
    const S = { opts: Object.assign({}, DEFAULTS, saved.opts), refs: Array.isArray(saved.refs) ? saved.refs : [], activeId: saved.activeId || null,
                liveC: document.createElement('canvas'), liveEyes: null, liveEyesAt: 0, onionC: null, onionFor: '', tab: 'position', panel: null, peek: null, peekOn: false, ctrlTimer: 0, tick: 0, alignedSince: 0, lastBeep: 0, audio: null };
    const save = () => lsSet({ opts: S.opts, refs: S.refs, activeId: S.activeId });
    const activeRef = () => S.refs.find(r => r.id === S.activeId) || null;
    const tol = () => ({ lat: +S.opts.tolLat, depth: +S.opts.tolDepth, roll: +S.opts.tolRoll });

    // The camera picture is only requested and processed while the panel or the Ctrl guide is showing.
    let imgN = 0, unImg = null;
    const onPicture = px => { livePicture(px, S.liveC); if (++imgN % 3 === 1) { S.liveEyes = findEyes(px); S.liveEyesAt = performance.now(); } };
    const watchCamera = on => { if (on && !unImg) unImg = td.onImage(onPicture); else if (!on && unImg) { unImg(); unImg = null; } };

    /* ---- is the examiner / child lined up? */
    function evaluate() {
      const st = td.state(), live = st.status === 'live', f = st.last, cur = live ? td.pose(10) : null, ref = activeRef(), t = tol();
      const out = { level: 'bad', title: '', detail: '', cur, cmp: null, ref };
      if (!live) { out.title = 'Tracker not connected'; out.detail = 'Connect the tracker in the Eye Tracking settings first.'; return out; }
      if (!cur) { const one = f && (f.l || f.r); out.level = one ? 'warn' : 'bad'; out.title = one ? 'Only one eye found' : 'No eyes found'; out.detail = 'Face the screen with both eyes visible, about 50–80 cm away.'; return out; }
      if (ref) {
        const d = [cur.mid[0] - ref.pose.mid[0], cur.mid[1] - ref.pose.mid[1], cur.mid[2] - ref.pose.mid[2]], lat = Math.hypot(d[0], d[1]), dr = cur.roll != null && ref.pose.roll != null ? cur.roll - ref.pose.roll : null;
        out.cmp = { d, lat, dr, ok: lat <= t.lat && Math.abs(d[2]) <= t.depth && (dr == null || Math.abs(dr) <= t.roll) };
        if (out.cmp.ok) { out.level = 'good'; out.title = 'Lined up'; out.detail = `Matches “${ref.name}”. Hold still.`; return out; }
        const parts = [];
        if (d[2] > t.depth) parts.push(`move closer to the screen (${d[2].toFixed(0)} mm too far)`); else if (d[2] < -t.depth) parts.push(`move back (${(-d[2]).toFixed(0)} mm too close)`);
        if (lat > t.lat) parts.push(`shift the head about ${lat.toFixed(0)} mm — ${Math.abs(d[0]) > Math.abs(d[1]) ? (d[0] > 0 ? 'to their left' : 'to their right') : (d[1] > 0 ? 'down' : 'up')}`);
        if (dr != null && Math.abs(dr) > t.roll) parts.push(`level the head (${Math.abs(dr).toFixed(0)}° tilt difference)`);
        out.level = lat > t.lat * 3 || Math.abs(d[2]) > t.depth * 3 ? 'bad' : 'warn'; out.title = 'Nearly there'; out.detail = parts.join('; ') + '.'; return out;
      }
      const z = cur.mid[2];
      if (z < DIST_OK[0]) { out.level = 'warn'; out.title = 'Too close'; out.detail = `${(z / 10).toFixed(0)} cm from the screen. Move back to at least ${DIST_OK[0] / 10} cm.`; }
      else if (z > DIST_OK[1]) { out.level = 'warn'; out.title = 'Too far'; out.detail = `${(z / 10).toFixed(0)} cm from the screen. Move closer than ${DIST_OK[1] / 10} cm.`; }
      else { out.level = 'good'; out.title = 'Tracking well'; out.detail = 'Mark this position when the examiner is comfortable and centred.'; }
      return out;
    }

    function guideView() {
      const ref = activeRef(), fresh = performance.now() - (td.image() ? td.image().at : -1e9) < 1500, ev = evaluate();
      if (ref && ref.ir) {                                       // onion skin of the marked position (rebuilt only when the choice or style changes)
        const key = ref.id + ':' + S.opts.style; if (S.onionFor !== key) { S.onionC = onionPicture(unb64(ref.ir), S.opts.style); S.onionFor = key; }
      } else { S.onionC = null; S.onionFor = ''; }
      let aligned = null; if (ev.cmp) aligned = ev.cmp.ok; else if (ev.cur) aligned = ev.level === 'good' ? null : false;
      return { v: { live: fresh ? S.liveC : null, onionCanvas: S.onionC, opts: S.opts, eyes: (ref && ref.eyesPx) || DEFAULT_EYES, liveEyes: fresh && performance.now() - S.liveEyesAt < 1500 ? S.liveEyes : null, aligned }, ev, fresh };
    }
    function beepIfAligned(ev) {
      if (ev.cmp && ev.cmp.ok) {
        if (!S.alignedSince) S.alignedSince = performance.now();
        if (S.opts.beep && performance.now() - S.alignedSince > 1200 && performance.now() - S.lastBeep > 4000) {
          S.lastBeep = performance.now();
          try { S.audio = S.audio || new AudioContext(); const o = S.audio.createOscillator(), g = S.audio.createGain(); o.frequency.value = 880; g.gain.value = .08; o.connect(g); g.connect(S.audio.destination); o.start(); o.stop(S.audio.currentTime + .15); } catch (_) { /* no audio */ }
        }
      } else S.alignedSince = 0;
    }

    /* ---- marking positions */
    function mark() {
      const cur = td.pose(20), img = td.image(), P = S.panel;
      const say = t => { if (P) P.markMsg.textContent = t; };
      if (!cur) { say('Both eyes need to be found to mark a position.'); return null; }
      if (!img) { say('No camera picture yet — wait a moment.'); return null; }
      const name = ((P && P.name.value) || S.opts.refName || 'Examiner').trim() || 'Examiner', eyes = findEyes(img.px);
      const ref = { id: String(Date.now()), name, created: new Date().toISOString(), pose: { mid: cur.mid, ipd: cur.ipd, roll: cur.roll }, ir: b64(img.px), eyesPx: eyes, summary: `${(cur.mid[2] / 10).toFixed(0)} cm away, eyes ${cur.ipd.toFixed(0)} mm apart` };
      S.refs.unshift(ref); S.refs = S.refs.slice(0, MAX_REFS); S.activeId = ref.id;
      const stored = save();
      say(`Marked “${name}” (${ref.summary}).` + (eyes ? '' : ' The eyes could not be found in the picture, so the box stays in its standard place.') + (cur.sd > 6 ? ' Your head was moving a little — fine for a rough guide.' : '') + (stored ? '' : ' (Could not save it in this browser.)'));
      renderPanel(); return ref;
    }

    /* ---- panel */
    function buildPanel() {
      const P = { root: $el('aside', 'gt-panel'), tabs: {}, pages: {} };
      P.root.id = 'gt-panel'; P.root.hidden = true; P.root.setAttribute('aria-label', 'Calibration tools');
      const head = $el('header', 'gt-head'), title = $el('div', 'gt-title'); title.append($el('b', '', 'Calibration tools'), $el('span', '', 'Line up, calibrate, check'));
      const close = $el('button', 'gt-x'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.textContent = '×'; close.onclick = () => api.close(); head.append(title, close);
      const nav = $el('nav', 'gt-steps'); nav.setAttribute('role', 'tablist');
      [['position', '1', 'Position'], ['calibrate', '2', 'Calibrate'], ['check', '3', 'Check']].forEach(([id, n, label]) => {
        const b = $el('button', 'gt-step'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.tab = id; b.append($el('i', '', n), $el('span', '', label)); b.onclick = () => api.open(id); P.tabs[id] = b; nav.appendChild(b);
      });
      const body = $el('div', 'gt-body');

      // --- 1. position
      const pos = $el('section', 'gt-page'); P.pages.position = pos;
      const view = $el('div', 'gt-view'); P.canvas = $el('canvas'); P.canvas.width = P.canvas.height = 560; P.viewMsg = $el('div', 'gt-viewmsg'); view.append(P.canvas, P.viewMsg);
      const legend = $el('div', 'gt-legend'); legend.innerHTML = '<span><i class="gt-sw gt-sw-box"></i>where the eyes should be</span><span><i class="gt-sw gt-sw-eye"></i>your eyes now</span><span><i class="gt-sw gt-sw-skin"></i>marked position</span>';
      P.state = $el('div', 'gt-state'); P.stateTitle = $el('b'); P.stateDetail = $el('span'); P.state.append(P.stateTitle, P.stateDetail);
      const ro = $el('div', 'gt-ro'); P.ro = {};
      [['dist', 'Distance'], ['off', 'Side / up'], ['depth', 'Depth'], ['roll', 'Head tilt'], ['ipd', 'Eye spacing']].forEach(([k, l]) => { const d = $el('div'); d.append($el('span', '', l)); P.ro[k] = $el('b', '', '–'); d.appendChild(P.ro[k]); ro.appendChild(d); });
      const markCard = $el('div', 'gt-card'); markCard.append($el('h3', '', 'Mark a position'), $el('p', 'gt-note', 'Sit comfortably with both eyes found, then mark. The eye box moves to where your eyes are, and your picture stays as an outline, so the child can be lined up the same way.'));
      const row = $el('div', 'gt-row'); P.name = $el('input', 'gt-input'); P.name.value = S.opts.refName; P.name.setAttribute('aria-label', 'Name for this position');
      P.mark = $el('button', 'gt-btn primary', 'Mark this position'); P.mark.type = 'button'; P.mark.onclick = mark; P.clear = $el('button', 'gt-btn', 'Clear'); P.clear.type = 'button'; P.clear.onclick = () => { S.activeId = null; save(); renderPanel(); };
      row.append(P.name, P.mark, P.clear); P.markMsg = $el('div', 'gt-note'); P.list = $el('div', 'gt-list');
      markCard.append(row, P.markMsg, P.list);
      const optCard = $el('div', 'gt-card'); optCard.appendChild($el('h3', '', 'On the guide'));
      const chk = (key, label) => { const l = $el('label', 'gt-check'), i = $el('input'); i.type = 'checkbox'; i.checked = !!S.opts[key]; i.onchange = () => { S.opts[key] = i.checked; save(); }; l.append(i, document.createTextNode(' ' + label)); return l; };
      optCard.append(chk('outline', 'Head and shoulders outline'), chk('box', 'Eye box'), chk('onion', 'Marked position (outline of the picture)'), chk('beep', 'Beep when lined up'));
      const style = $el('label', 'gt-field'); style.append($el('span', '', 'Marked picture as'), (() => { const s = $el('select', 'gt-input'); s.innerHTML = '<option value="edges">Outline</option><option value="ghost">Warm ghost</option>'; s.value = S.opts.style; s.onchange = () => { S.opts.style = s.value; save(); }; return s; })());
      const alpha = $el('label', 'gt-field'); alpha.append($el('span', '', 'Marked picture strength'), (() => { const s = $el('input'); s.type = 'range'; s.min = 10; s.max = 100; s.value = S.opts.alpha; s.oninput = () => { S.opts.alpha = +s.value; save(); }; return s; })());
      const tolRow = $el('div', 'gt-tol'); [['tolLat', 'Side / up', 'mm', 2, 60, 1], ['tolDepth', 'Depth', 'mm', 5, 150, 5], ['tolRoll', 'Tilt', '°', 1, 30, 1]].forEach(([k, l, u, mn, mx, st]) => {
        const lab = $el('label', 'gt-field'), i = $el('input', 'gt-input'); i.type = 'number'; i.min = mn; i.max = mx; i.step = st; i.value = S.opts[k]; i.onchange = () => { S.opts[k] = Math.max(mn, Math.min(mx, +i.value || DEFAULTS[k])); i.value = S.opts[k]; save(); }; lab.append($el('span', '', `${l} (${u})`), i); tolRow.appendChild(lab);
      });
      optCard.append(style, alpha, $el('span', 'gt-sub', 'How close counts as lined up'), tolRow);
      const hint = $el('p', 'gt-hint'); hint.innerHTML = '<kbd>Ctrl</kbd> Hold <b>Ctrl</b> any time to see this guide over the page, even in full-screen Play. Let go to hide it.';
      pos.append(view, legend, P.state, ro, markCard, optCard, hint);

      // --- 2. calibrate
      const cal = $el('section', 'gt-page'); P.pages.calibrate = cal;
      const calCard = $el('div', 'gt-card'); calCard.append($el('h3', '', 'Calibrate'), $el('p', 'gt-note', 'You look at 9 dots and the tracker learns where you look; 5 more dots then check it. Do this once, sitting exactly as the child will sit. The calibration is saved in this browser and is used for the child too.'));
      P.calSummary = $el('div', 'gt-summary'); const calRow = $el('div', 'gt-row');
      P.calBtn = $el('button', 'gt-btn primary', 'Calibrate…'); P.calBtn.type = 'button'; P.calBtn.onclick = async () => { const r = await td.calibrate(); if (r) { renderPanel(); } };
      P.calClear = $el('button', 'gt-btn', 'Forget'); P.calClear.type = 'button'; P.calClear.onclick = () => td.clearCalibration(); calRow.append(P.calBtn, P.calClear);
      calCard.append(P.calSummary, calRow); cal.append(calCard);

      // --- 3. check
      const chkp = $el('section', 'gt-page'); P.pages.check = chkp;
      const chkCard = $el('div', 'gt-card'); chkCard.append($el('h3', '', 'Check accuracy'), $el('p', 'gt-note', 'Dots appear in random places and you look at each. The result shows how far the tracker’s idea of where you look is from where the dots really were. Do this after calibrating.'));
      const nSel = $el('select', 'gt-input'); nSel.innerHTML = '<option value="5">5 dots</option><option value="8">8 dots</option><option value="12">12 dots</option>'; nSel.value = String(S.opts.checkN); nSel.onchange = () => { S.opts.checkN = +nSel.value; save(); };
      P.checkBtn = $el('button', 'gt-btn primary', 'Check accuracy…'); P.checkBtn.type = 'button'; P.checkBtn.onclick = async () => { const r = await td.accuracyCheck(S.opts.checkN); if (r) renderPanel(); };
      const chkRow = $el('div', 'gt-row'); chkRow.append(nSel, P.checkBtn); P.checkSummary = $el('div', 'gt-summary');
      chkCard.append(P.checkSummary, chkRow); chkp.append(chkCard);
      const flow = $el('div', 'gt-card'); flow.append($el('h3', '', 'When the child sits down'));
      const ol = $el('ol', 'gt-flow'); ['Seat the child so they are in the same place you were: hold Ctrl and match the eye box and outline.', 'Do not recalibrate — your calibration is used as it is.', 'Switch to Play, turn on the gaze pointer if you want to see where they look.'].forEach(t => ol.appendChild($el('li', '', t))); flow.appendChild(ol); chkp.appendChild(flow);

      body.append(pos, cal, chkp); P.root.append(head, nav, body); document.body.appendChild(P.root); return P;
    }

    function renderList(P) {
      P.list.textContent = '';
      if (!S.refs.length) { P.list.appendChild($el('div', 'gt-note', 'No saved positions yet.')); return; }
      S.refs.forEach(r => {
        const d = $el('div', 'gt-item' + (r.id === S.activeId ? ' on' : '')), t = $el('span'); t.append($el('b', '', r.name), $el('small', '', [r.summary, new Date(r.created).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })].join(' · ')));
        const use = $el('button', 'gt-btn', r.id === S.activeId ? 'In use' : 'Use'); use.type = 'button'; use.disabled = r.id === S.activeId; use.onclick = () => { S.activeId = r.id; save(); renderPanel(); };
        const del = $el('button', 'gt-btn gt-del', 'Delete'); del.type = 'button'; del.onclick = () => { S.refs = S.refs.filter(x => x.id !== r.id); if (S.activeId === r.id) S.activeId = null; save(); renderPanel(); };
        d.append(t, use, del); P.list.appendChild(d);
      });
    }
    function renderPanel() {
      const P = S.panel; if (!P) return; const st = td.state();
      for (const id of Object.keys(P.tabs)) { const on = S.tab === id; P.tabs[id].setAttribute('aria-selected', String(on)); P.pages[id].hidden = !on; }
      P.tabs.position.classList.toggle('done', !!activeRef()); P.tabs.calibrate.classList.toggle('done', st.calibrated); P.tabs.check.classList.toggle('done', !!(st.check && st.calibrated && st.check.calibrated));
      renderList(P);
      P.clear.disabled = !activeRef();
      P.calSummary.textContent = st.calibrated ? `Calibrated ${new Date(st.cal.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${st.cal.grade ? ' · ' + st.cal.grade : ''}${st.cal.errDeg != null ? ` (about ${st.cal.errDeg}° off on the 5 check dots)` : ''}` : 'Not calibrated yet.';
      P.calSummary.className = 'gt-summary' + (st.calibrated ? ' ok' : '');
      P.calClear.hidden = !st.calibrated; P.calBtn.textContent = st.calibrated ? 'Calibrate again…' : 'Calibrate…';
      const ck = st.check; P.checkSummary.textContent = ck ? `Last check ${new Date(ck.when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}: ${ck.meanDeg}° on average (${ck.grade}), worst dot ${ck.worstDeg}°, ${ck.n} dots${ck.calibrated ? '' : ' — before calibrating'}.` : 'Not checked yet.';
      P.checkSummary.className = 'gt-summary' + (ck ? ' ok' : '');
      const ready = st.status === 'live' && !st.busy; P.calBtn.disabled = !ready; P.checkBtn.disabled = !ready;
    }
    function placePanel() {
      const P = S.panel; if (!P) return; const d = cfg.drawer, open = d && d.classList.contains('open') && innerWidth > 760;
      P.root.style.left = open ? Math.round(d.getBoundingClientRect().right + 12) + 'px' : '12px';
    }
    function updateLive() {                                     // runs ~12x a second while the panel or the Ctrl guide is showing
      const { v, ev, fresh } = guideView();
      if (S.panel && !S.panel.root.hidden && S.tab === 'position') {
        const P = S.panel; drawGuide(P.canvas, v); P.viewMsg.textContent = fresh ? '' : (td.state().status === 'live' ? 'Waiting for the camera…' : 'Connect the tracker to see the camera.');
        P.state.className = 'gt-state ' + ev.level; P.stateTitle.textContent = ev.title; P.stateDetail.textContent = ev.detail;
        const cur = ev.cur, cmp = ev.cmp, ref = ev.ref;
        P.ro.dist.textContent = cur ? `${(cur.mid[2] / 10).toFixed(0)} cm` : '–'; P.ro.off.textContent = cmp ? `${cmp.d[0].toFixed(0)} / ${cmp.d[1].toFixed(0)} mm` : '–';
        P.ro.depth.textContent = cmp ? `${cmp.d[2] > 0 ? '+' : ''}${cmp.d[2].toFixed(0)} mm` : '–'; P.ro.roll.textContent = cur ? `${cur.roll.toFixed(0)}°` : '–';
        P.ro.ipd.textContent = cur ? `${cur.ipd.toFixed(0)} mm${ref ? ` (marked ${ref.pose.ipd.toFixed(0)})` : ''}` : '–';
      }
      if (S.peekOn && S.peek) {
        drawGuide(S.peek.canvas, v); S.peek.state.className = 'gt-peek-state ' + ev.level; S.peek.state.textContent = fresh || ev.level === 'good' ? `${ev.title} — ${ev.detail}` : ev.detail || ev.title;
      }
      beepIfAligned(ev);
    }
    const ensureTick = () => { const need = !!((S.panel && !S.panel.root.hidden) || S.peekOn); watchCamera(need); if (need && !S.tick) S.tick = setInterval(updateLive, 80); else if (!need && S.tick) { clearInterval(S.tick); S.tick = 0; } };

    /* ---- Ctrl peek */
    function buildPeek() {
      const root = $el('div', 'gt-peek'); root.hidden = true; root.setAttribute('aria-hidden', 'true'); const card = $el('div', 'gt-peek-card');
      const kicker = $el('div', 'gt-peek-kicker', 'Position guide · release Ctrl to hide'); const canvas = $el('canvas'); canvas.width = canvas.height = 480; const state = $el('div', 'gt-peek-state');
      card.append(kicker, canvas, state); root.appendChild(card); document.body.appendChild(root); return { root, canvas, state };
    }
    function peek(on) {
      if (on === S.peekOn) return; S.peekOn = on;
      if (on) { S.peek = S.peek || buildPeek(); S.peek.root.hidden = false; updateLive(); } else if (S.peek) S.peek.root.hidden = true;
      ensureTick();
    }
    const cancelCtrl = () => { clearTimeout(S.ctrlTimer); S.ctrlTimer = 0; };
    addEventListener('keydown', e => {
      if (e.key === 'Control' && !e.repeat) { cancelCtrl(); if (isEnabled() && !td.state().busy) S.ctrlTimer = setTimeout(() => peek(true), 220); }
      else if (e.key !== 'Control') { cancelCtrl(); peek(false); }          // Ctrl+S, Ctrl+Alt+G … are shortcuts, not a request for the guide
      if (e.key === 'Escape' && S.panel && !S.panel.root.hidden && !td.state().busy) api.close();   // like every other dialog (a running calibration handles its own Esc)
    }, true);
    addEventListener('keyup', e => { if (e.key === 'Control') { cancelCtrl(); peek(false); } }, true);
    addEventListener('blur', () => { cancelCtrl(); peek(false); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelCtrl(); peek(false); } });
    td.onChange(() => renderPanel());
    addEventListener('resize', placePanel);

    const api = {
      open(tab) {
        S.panel = S.panel || buildPanel(); S.tab = tab && S.panel.pages[tab] ? tab : S.tab; S.panel.root.hidden = false; placePanel(); renderPanel(); ensureTick(); updateLive(); return api;
      },
      close() { if (S.panel) S.panel.root.hidden = true; ensureTick(); return api; },
      toggle(tab) { return S.panel && !S.panel.root.hidden ? api.close() : api.open(tab); },
      get isOpen() { return !!(S.panel && !S.panel.root.hidden); },
      mark, evaluate, peek,
      refs: () => S.refs.slice(), activeRef,
      _test: { findEyes, livePicture, onionPicture, drawGuide, S },
    };
    return api;
  }

  root.GazeTools = { create, findEyes };
})(window);
