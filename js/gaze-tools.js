/* gaze-tools.js — the eye tracker set-up menu: where to sit, which eye(s) to follow, calibrate.
 *
 *   Position  : the tracker's camera picture with a head-and-shoulders outline showing where the head should be.
 *   Eyes      : follow both eyes, the left only, the right only, or whichever eye is looking ("either").
 *   Calibrate : dots that move on once they have been looked at, then four check dots that show the miss and refine the result (js/tet-direct.js).
 *   Ctrl      : hold Ctrl on its own at any time to see the position guide over the page (even in full-screen Play).
 *
 *   const tools = GazeTools.create({ td: TetDirect.create(), isEnabled: () => true, drawer: document.getElementById('controls-drawer') });
 *   tools.open();
 *
 * The same menu serves the webcam (js/webcam-gaze.js). A tracker that brings its own position guide sets td.guide
 * ({ draw(canvas, ev), evaluate() -> { level, title, detail }, mark(), reset(), marked() }), td.eyeModes (the choices it offers)
 * and td.calNote(mode) (one line about what calibrating takes).
 */
(function (root) {
  'use strict';
  const LS = 'gazeTools.v2', IMG = 280, DIST_OK = [450, 850], DEFAULT_EYES = [[112, 100], [168, 100]];   // where the eyes sit in the (unmirrored) camera picture when nothing is marked
  const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (_) { return {}; } };
  const lsSet = v => { try { localStorage.setItem(LS, JSON.stringify(v)); return true; } catch (_) { return false; } };
  const $el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const MODE_TEXT = {
    both: ['Both eyes', 'The usual way: the average of the two eyes.'],
    left: ['Left eye only', 'For when only the left eye is looking, or the right is covered.'],
    right: ['Right eye only', 'For when only the right eye is looking, or the left is covered.'],
    either: ['Either eye (taking turns)', 'Each eye is calibrated on its own. The gaze follows whichever eye is looking at the target and glides to the other when it takes over.'],
  };

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

  /* ---------------------------------------------------------------- the guide: camera picture (mirrored, like a mirror) and one clean head-and-shoulders outline */
  /** v: { live: canvas | null, eyes: [[x,y],[x,y]] where the eyes should be (unmirrored picture pixels), tone: colour of the outline } */
  function drawGuide(c, v) {
    const W = c.width, g = c.getContext('2d'), k = W / IMG;
    g.clearRect(0, 0, W, W); g.fillStyle = '#05080a'; g.fillRect(0, 0, W, W);
    if (v.live) { g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(v.live, 0, 0, W, W); g.restore(); }
    const [a, b] = v.eyes, ex = W - ((a[0] + b[0]) / 2) * k, ey = ((a[1] + b[1]) / 2) * k;       // eye level of the outline, in the mirrored picture
    const eyeGap = Math.abs(b[0] - a[0]) * k, s = Math.max(0.8, Math.min(1.4, eyeGap / (56 * k))), U = W * s;
    const rx = 0.165 * U, ry = 0.215 * U, cy = ey + 0.035 * U, nx = 0.085 * U, th = Math.acos(nx / rx);   // head ellipse, neck width
    g.save(); g.lineJoin = g.lineCap = 'round'; g.lineWidth = Math.max(3, W / 150); g.strokeStyle = v.tone || '#ffffff'; g.fillStyle = 'rgb(255 255 255 / 7%)'; g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 6;
    g.beginPath();
    g.moveTo(ex - 0.50 * U, W + 6);                                                              // left shoulder, off the bottom of the picture
    g.bezierCurveTo(ex - 0.47 * U, cy + 0.42 * U, ex - 0.22 * U, cy + 0.36 * U, ex - nx, cy + ry * Math.sin(th) + 0.06 * U);   // up to the neck
    g.lineTo(ex - nx, cy + ry * Math.sin(th));                                                   // neck
    g.ellipse(ex, cy, rx, ry, 0, Math.PI - th, 2 * Math.PI + th, false);                         // jaw, around the head, and down to the other side
    g.lineTo(ex + nx, cy + ry * Math.sin(th) + 0.06 * U);
    g.bezierCurveTo(ex + 0.22 * U, cy + 0.36 * U, ex + 0.47 * U, cy + 0.42 * U, ex + 0.50 * U, W + 6);
    g.fill(); g.stroke(); g.restore();
  }

  /* ---------------------------------------------------------------- the menu */
  function create(cfg) {
    const td = cfg.td, isEnabled = cfg.isEnabled || (() => true), saved = lsGet();
    const S = { ref: saved.ref && saved.ref.eyes ? saved.ref : null, liveC: document.createElement('canvas'), liveEyes: null, liveEyesAt: 0, panel: null, peek: null, peekOn: false, ctrlTimer: 0, tick: 0 };
    const save = () => lsSet({ ref: S.ref });
    const targetEyes = () => (S.ref && S.ref.eyes) || DEFAULT_EYES;

    // The camera picture is only requested and processed while the menu or the Ctrl guide is showing.
    let imgN = 0, unImg = null;
    const onPicture = px => { livePicture(px, S.liveC); if (++imgN % 3 === 1) { S.liveEyes = findEyes(px); S.liveEyesAt = performance.now(); } };
    const G = td.guide || null;                                 // a tracker with its own position guide (the webcam)
    const watchCamera = on => { if (G) { if (G.watch) G.watch(on); return; } if (on && !unImg) unImg = td.onImage(onPicture); else if (!on && unImg) { unImg(); unImg = null; } };

    /** Is the head where the outline is? One plain sentence. */
    function evaluate() {
      if (G) return G.evaluate();
      const st = td.state(), live = st.status === 'live', fresh = performance.now() - (td.image() ? td.image().at : -1e9) < 1500;
      if (!live) return { level: 'bad', title: 'Tracker not connected', detail: 'Connect the tracker in the Eye Tracking settings first.' };
      const eyes = fresh && performance.now() - S.liveEyesAt < 1500 ? S.liveEyes : null, cur = td.pose(10);
      if (!eyes && !cur) return { level: 'bad', title: 'No eyes found', detail: 'Face the screen with both eyes visible, about 50–80 cm away.' };
      const parts = [];
      if (cur) { const z = cur.mid[2]; if (z < DIST_OK[0]) parts.push(`move back (${(z / 10).toFixed(0)} cm is too close)`); else if (z > DIST_OK[1]) parts.push(`move closer (${(z / 10).toFixed(0)} cm is too far)`); }
      if (eyes) {
        const t = targetEyes(), mx = (eyes[0][0] + eyes[1][0]) / 2, my = (eyes[0][1] + eyes[1][1]) / 2, tx = (t[0][0] + t[1][0]) / 2, ty = (t[0][1] + t[1][1]) / 2, tol = 26;
        const dxm = (IMG - mx) - (IMG - tx);                                                    // in the mirrored picture; a mirror moves the same way you do
        if (Math.abs(dxm) > tol) parts.push(dxm < 0 ? 'move a little to the right' : 'move a little to the left');
        if (Math.abs(my - ty) > tol) parts.push(my < ty ? 'sit a little lower' : 'sit a little higher');
      }
      if (!parts.length) return { level: 'good', title: 'Lined up', detail: 'The head is inside the outline. Hold still.' };
      return { level: parts.length > 1 ? 'bad' : 'warn', title: 'Nearly there', detail: parts.join('; ').replace(/^./, c => c.toUpperCase()) + '.' };
    }
    const toneOf = lvl => (lvl === 'good' ? '#34d399' : lvl === 'warn' ? '#fbbf24' : '#ffffff');
    function view() {
      const ev = evaluate();
      if (G) return { v: null, ev, fresh: !!ev.fresh };
      const fresh = performance.now() - (td.image() ? td.image().at : -1e9) < 1500; return { v: { live: fresh ? S.liveC : null, eyes: targetEyes(), tone: toneOf(ev.level) }, ev, fresh };
    }
    const paint = (canvas, v, ev) => (G ? G.draw(canvas, ev) : drawGuide(canvas, v));

    /* ---- marking where the outline should be */
    function mark() {
      if (G) { const t = G.mark(); if (S.panel) S.panel.markMsg.textContent = t || ''; renderPanel(); return; }
      const img = td.image(), P = S.panel, say = t => { if (P) P.markMsg.textContent = t; };
      if (!img) { say('No camera picture yet — wait a moment.'); return; }
      const eyes = findEyes(img.px); if (!eyes) { say('Both eyes need to be found to set the outline.'); return; }
      S.ref = { eyes, at: new Date().toISOString() }; save(); say('The outline is now where the head is.'); renderPanel();
    }
    const reset = () => { if (G) G.reset(); else { S.ref = null; save(); } if (S.panel) S.panel.markMsg.textContent = ''; renderPanel(); };

    /* ---- the panel */
    function buildPanel() {
      const P = { root: $el('aside', 'gt-panel') };
      P.root.id = 'gt-panel'; P.root.hidden = true; P.root.setAttribute('aria-label', 'Eye tracker set-up');
      const head = $el('header', 'gt-head'), title = $el('div', 'gt-title'); title.append($el('b', '', 'Set up the eye tracker'), $el('span', '', 'Position, which eyes, calibrate'));
      const close = $el('button', 'gt-x'); close.type = 'button'; close.setAttribute('aria-label', 'Close'); close.textContent = '×'; close.onclick = () => api.close(); head.append(title, close);
      const body = $el('div', 'gt-body'), page = $el('div', 'gt-page');

      // 1. position
      const pos = $el('section', 'gt-card'); pos.append($el('h3', '', '1. Position'));
      const viewBox = $el('div', 'gt-view'); P.canvas = $el('canvas'); P.canvas.width = P.canvas.height = 420; P.viewMsg = $el('div', 'gt-viewmsg'); viewBox.append(P.canvas, P.viewMsg);
      P.state = $el('div', 'gt-state'); P.stateTitle = $el('b'); P.stateDetail = $el('span'); P.state.append(P.stateTitle, P.stateDetail);
      const prow = $el('div', 'gt-row'); P.mark = $el('button', 'gt-btn', 'Put the outline here'); P.mark.type = 'button'; P.mark.onclick = mark;
      P.reset = $el('button', 'gt-btn', 'Centre it'); P.reset.type = 'button'; P.reset.onclick = reset; prow.append(P.mark, P.reset); P.markMsg = $el('p', 'gt-note');
      const hint = $el('p', 'gt-hint'); hint.innerHTML = '<kbd>Ctrl</kbd> Hold <b>Ctrl</b> any time to see this over the page, even in full-screen Play.';
      pos.append(viewBox, P.state, prow, P.markMsg, hint);

      // 2. which eyes
      const eyes = $el('section', 'gt-card'); eyes.append($el('h3', '', '2. Which eyes?'));
      P.mode = $el('select', 'gt-input'); P.mode.setAttribute('aria-label', 'Which eyes the gaze follows');
      (td.eyeModes || Object.keys(MODE_TEXT)).forEach(k => { const o = $el('option', '', MODE_TEXT[k][0]); o.value = k; P.mode.appendChild(o); });
      P.mode.onchange = () => { td.setEyeMode(P.mode.value); renderPanel(); };
      P.modeNote = $el('p', 'gt-note'); P.eyeData = $el('p', 'gt-note');
      eyes.append(P.mode, P.modeNote, P.eyeData);

      // 3. calibrate
      const cal = $el('section', 'gt-card'); cal.append($el('h3', '', '3. Calibrate'));
      P.calSummary = $el('div', 'gt-summary'); P.calNote = $el('p', 'gt-note');
      const crow = $el('div', 'gt-row'); P.calBtn = $el('button', 'gt-btn primary', 'Calibrate'); P.calBtn.type = 'button'; P.calBtn.onclick = async () => { await td.calibrate(); renderPanel(); };
      P.chkBtn = $el('button', 'gt-btn', 'Check accuracy'); P.chkBtn.type = 'button'; P.chkBtn.onclick = async () => { await td.recheck(); renderPanel(); };
      P.clr = $el('button', 'gt-btn', 'Forget'); P.clr.type = 'button'; P.clr.onclick = () => td.clearCalibration(); crow.append(P.calBtn, P.chkBtn, P.clr);
      cal.append(P.calSummary, crow, P.calNote);

      page.append(pos, eyes, cal); body.appendChild(page); P.root.append(head, body); document.body.appendChild(P.root); return P;
    }
    function renderPanel() {
      const P = S.panel; if (!P) return; const st = td.state(), mode = st.eyeMode, cal = st.cal;
      P.mode.value = mode; P.modeNote.textContent = MODE_TEXT[mode][1];
      P.eyeData.textContent = mode === 'both' ? '' : st.perEye ? 'This tracker is giving separate left and right gaze: ready.' : 'Learning this tracker’s separate left and right gaze. Look at the screen with both eyes open for a few seconds. Until then it follows both eyes.';
      P.eyeData.hidden = mode === 'both' || !!G;
      P.reset.hidden = G ? !G.marked() : !S.ref;
      const sm = st.calibrated && cal;
      let line = 'Not calibrated for this setting yet.';
      if (sm) {
        const when = new Date(cal.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
        const pe = cal.perEye || {}, per = mode === 'either' ? ` (left ${pe.L ? pe.L.score : '–'}, right ${pe.R ? pe.R.score : '–'})` : '';
        line = `Calibrated ${when}. Accuracy ${cal.score != null ? cal.score + ' / 100' : ''}${cal.errDeg != null ? ' · about ' + cal.errDeg + '°' : ''}${cal.grade ? ' · ' + cal.grade : ''}${per}`;
      } else if (st.anyCalibration) line = 'Calibrated for another eye setting. Calibrate again for this one.';
      P.calSummary.textContent = line; P.calSummary.className = 'gt-summary' + (sm ? ' ok' : '');
      P.calBtn.textContent = sm ? 'Calibrate again' : 'Calibrate';
      const ready = st.status === 'live' && !st.busy; P.calBtn.disabled = !ready; P.chkBtn.disabled = !ready || !sm; P.chkBtn.hidden = !sm; P.clr.hidden = !st.anyCalibration;
      P.calNote.textContent = td.calNote ? td.calNote(mode) : mode === 'left' || mode === 'right' ? `Cover the ${mode === 'left' ? 'right' : 'left'} eye while calibrating.` : mode === 'either' ? 'Takes two short rounds: cover one eye for each, then both open.' : 'About a minute: 9 dots, then 4 check dots.';
    }
    function placePanel() {
      const P = S.panel; if (!P) return; const d = cfg.drawer, open = d && d.classList.contains('open') && innerWidth > 760;
      P.root.style.left = open ? Math.round(d.getBoundingClientRect().right + 12) + 'px' : '12px';
    }
    function updateLive() {                                     // runs ~12x a second while the menu or the Ctrl guide is showing
      const { v, ev, fresh } = view();
      if (S.panel && !S.panel.root.hidden) {
        const P = S.panel; paint(P.canvas, v, ev); P.viewMsg.textContent = fresh ? '' : (td.state().status === 'live' ? 'Waiting for the camera…' : G ? 'Start the camera to see the picture.' : 'Connect the tracker to see the camera.');
        P.state.className = 'gt-state ' + ev.level; P.stateTitle.textContent = ev.title; P.stateDetail.textContent = ev.detail;
      }
      if (S.peekOn && S.peek) { paint(S.peek.canvas, v, ev); S.peek.state.className = 'gt-peek-state ' + ev.level; S.peek.state.textContent = `${ev.title} — ${ev.detail}`; }
    }
    const ensureTick = () => { const need = !!((S.panel && !S.panel.root.hidden) || S.peekOn); watchCamera(need); if (need && !S.tick) S.tick = setInterval(updateLive, 80); else if (!need && S.tick) { clearInterval(S.tick); S.tick = 0; } };

    /* ---- Ctrl peek */
    function buildPeek() {
      const rootEl = $el('div', 'gt-peek'); rootEl.hidden = true; rootEl.setAttribute('aria-hidden', 'true'); const card = $el('div', 'gt-peek-card');
      const kicker = $el('div', 'gt-peek-kicker', 'Position guide · release Ctrl to hide'); const canvas = $el('canvas'); canvas.width = canvas.height = 480; const state = $el('div', 'gt-peek-state');
      card.append(kicker, canvas, state); rootEl.appendChild(card); document.body.appendChild(rootEl); return { root: rootEl, canvas, state };
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
      if (e.key === 'Escape' && S.panel && !S.panel.root.hidden && !td.state().busy) api.close();
    }, true);
    addEventListener('keyup', e => { if (e.key === 'Control') { cancelCtrl(); peek(false); } }, true);
    addEventListener('blur', () => { cancelCtrl(); peek(false); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelCtrl(); peek(false); } });
    td.onChange(() => renderPanel());
    addEventListener('resize', placePanel);

    const api = {
      open() { S.panel = S.panel || buildPanel(); S.panel.root.hidden = false; placePanel(); renderPanel(); ensureTick(); updateLive(); return api; },
      close() { if (S.panel) S.panel.root.hidden = true; ensureTick(); return api; },
      toggle() { return S.panel && !S.panel.root.hidden ? api.close() : api.open(); },
      get isOpen() { return !!(S.panel && !S.panel.root.hidden); },
      mark, reset, evaluate, peek,
      _test: { findEyes, livePicture, drawGuide, S },
    };
    return api;
  }

  root.GazeTools = { create, findEyes, livePicture, drawGuide };
})(window);
