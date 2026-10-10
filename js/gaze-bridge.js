/* gaze-bridge.js — lets any web page respond to the calibrated gaze served by the Gaze Assessment Tools.
 *
 * Self-contained, no dependencies. Load it in your page, then give it a hit-test function:
 *
 *   const gaze = GazeBridge.create({
 *     server: 'http://localhost:8765',                       // where viewer.py is running
 *     pick:   (clientX, clientY) => objectUnder(clientX, clientY) || null,   // YOUR hit test, in page (client) pixels
 *     onHover: obj => { ... },                               // obj or null, when the looked-at thing changes
 *     onDwell: (obj, info) => { ... },                       // looked at long enough: treat it like a tap
 *     onDwellProgress: (obj, fraction) => { ... },           // optional, 0..1 while dwelling
 *   });
 *   gaze.start();
 *
 * It also fires window events: 'gazebridge:gaze' (every sample) and 'gazebridge:dwell'.
 * Pointer: options pointer ('off' | 'dot' | 'circle'), dotPx, circleInches (real inches), pointerColor, pointerOpacity.
 * Hotkeys (examiner): Ctrl+Alt+G cycle pointer off → dot → circle, Ctrl+Alt+D dwell on/off, Ctrl+Alt+ArrowUp/Down dwell time ±100 ms.
 *
 * Gaze arrives as fractions of the SCREEN (0..1). It is mapped to page pixels exactly when the page is full-screen (F11 / fullscreen API);
 * in a normal window the mapping uses the window position and is approximate.
 */
(function (root) {
  'use strict';
  const VERSION = '1.0';
  const DEFAULTS = {
    server: null,            // default: ?gazeServer=… , saved choice, else http://localhost:8765
    dwellMs: 900,            // look this long at a target to "select" it
    graceMs: 250,            // tracker dropouts / glances shorter than this don't reset the dwell
    rearmMs: 500,            // after a dwell fires, look away this long before it can fire again on the same target
    repeatMs: 0,             // >0: keep firing every N ms while still looking (0 = once per look)
    tolerancePx: 22,         // gaze is only ~1° accurate: also test points this far around the gaze point
    smooth: 0.35,            // 0..1 exponential smoothing of the gaze point (1 = none)
    staleMs: 700,            // no sample for this long = tracker lost
    pointer: null,           // what the child's gaze looks like on screen: 'off' | 'dot' | 'circle' (default 'off', or 'dot' if overlay:true)
    dotPx: 22,               // diameter of the small dot, CSS pixels
    circleInches: 1.5,       // diameter of the broad circle in real inches (uses the screen size the tracker server reports)
    pointerColor: '#ffd24a',
    pointerOpacity: 0.8,     // 0.1 .. 1
    overlay: false,          // legacy: same as pointer:'dot'
    hotkeys: true,
    map: null,               // optional (x, y) => [clientX, clientY] to override the screen→page mapping
    persist: true,           // remember dwellMs / tolerancePx / overlay in localStorage
    storageKey: 'gazeBridge.v1',
  };

  function create(userOpts) {
    const saved = (() => { try { return JSON.parse(localStorage.getItem((userOpts && userOpts.storageKey) || DEFAULTS.storageKey)) || {}; } catch (_) { return {}; } })();
    const o = Object.assign({}, DEFAULTS, saved, userOpts || {});
    if (!o.server) o.server = new URLSearchParams(location.search).get('gazeServer') || saved.server || 'http://localhost:8765';
    o.server = o.server.replace(/\/+$/, '');
    if (!o.pointer) o.pointer = o.overlay ? 'dot' : 'off';

    const st = {
      es: null, status: 'idle', detail: '', hello: null, lastAt: 0, last: null, sx: null, sy: null, onPage: false,
      cur: null, curSince: 0, lostSince: 0, fired: false, lastFiredObj: null, lastFiredLeave: 0, lastFireAt: 0,
      dwellOn: true, diagAt: -1e9, started: false,
    };
    let ui = null, pillUntil = 0, timer = 0;

    const persist = () => { if (!o.persist) return; try { localStorage.setItem(o.storageKey, JSON.stringify({ dwellMs: o.dwellMs, tolerancePx: o.tolerancePx, pointer: o.pointer, dotPx: o.dotPx, circleInches: o.circleInches, pointerColor: o.pointerColor, pointerOpacity: o.pointerOpacity, server: o.server })); } catch (_) { /* private mode */ } };
    const emit = (name, detail) => { try { root.dispatchEvent(new CustomEvent('gazebridge:' + name, { detail })); } catch (_) { /* old browser */ } };

    /* ---- screen fraction -> page (client) pixels ---- */
    function toClient(x, y) {
      if (o.map) return o.map(x, y);
      const full = document.fullscreenElement || (root.innerWidth >= screen.width - 2 && root.innerHeight >= screen.height - 2);
      if (full) return [x * root.innerWidth, y * root.innerHeight];
      const side = (root.outerWidth - root.innerWidth) / 2, left = root.screenX + side, top = root.screenY + (root.outerHeight - root.innerHeight) - side;
      return [x * screen.width - left, y * screen.height - top];
    }

    /* ---- hit test with tolerance: centre first, then vote over rings of points ---- */
    function pick(cx, cy) {
      if (!o.pick) return null;
      const c = o.pick(cx, cy); if (c || !o.tolerancePx) return c || null;
      const votes = new Map();
      for (const r of [o.tolerancePx / 2, o.tolerancePx]) for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, hit = o.pick(cx + r * Math.cos(a), cy + r * Math.sin(a)); if (hit) votes.set(hit, (votes.get(hit) || 0) + 1);
      }
      let best = null, n = 0; votes.forEach((v, k) => { if (v > n) { n = v; best = k; } });
      return n >= 2 ? best : null;
    }

    /* ---- hover / dwell state machine ---- */
    function switchTo(obj, now) {
      if (st.cur && st.fired) { st.lastFiredObj = st.cur; st.lastFiredLeave = now; }
      st.cur = obj; st.curSince = now; st.lostSince = 0;
      st.fired = !!obj && obj === st.lastFiredObj && now - st.lastFiredLeave < o.rearmMs;
      try { o.onHover && o.onHover(obj); } catch (e) { console.error('[gaze] onHover', e); }
      try { o.onDwellProgress && o.onDwellProgress(obj, 0); } catch (e) { console.error('[gaze] onDwellProgress', e); }
    }
    function step(cand, now) {
      if (cand === st.cur) st.lostSince = 0;
      else if (st.cur && !cand) { if (!st.lostSince) st.lostSince = now; if (now - st.lostSince >= o.graceMs) switchTo(null, now); }
      else switchTo(cand, now);
      if (!st.cur || !st.dwellOn) return;
      const ms = now - st.curSince;
      if (!st.fired) {
        try { o.onDwellProgress && o.onDwellProgress(st.cur, Math.min(1, ms / o.dwellMs)); } catch (e) { console.error('[gaze] onDwellProgress', e); }
        if (ms >= o.dwellMs) fire(now, ms);
      } else if (o.repeatMs > 0 && now - st.lastFireAt >= o.repeatMs) fire(now, ms);
    }
    function fire(now, ms) {
      st.fired = true; st.lastFireAt = now;
      const info = { x: st.sx, y: st.sy, ms, dwellMs: o.dwellMs };
      try { o.onDwell && o.onDwell(st.cur, info); } catch (e) { console.error('[gaze] onDwell', e); }
      try { o.onDwellProgress && o.onDwellProgress(st.cur, 0); } catch (e) { console.error('[gaze] onDwellProgress', e); }
      emit('dwell', Object.assign({ target: st.cur }, info)); flashRing();
    }

    /* ---- stream ---- */
    function onSample(m) {
      const now = performance.now(); st.last = m; st.lastAt = now;
      if (m.hello) { st.hello = m; setStatus('live', m.calibrated ? 'calibrated gaze' : 'NOT calibrated — positions may be off'); return; }
      if (!m.ok || m.x == null) { st.onPage = false; step(null, now); draw(); return; }
      const [cx, cy] = toClient(m.x, m.y);
      if (st.sx == null) { st.sx = cx; st.sy = cy; } else { st.sx += (cx - st.sx) * o.smooth; st.sy += (cy - st.sy) * o.smooth; }
      st.onPage = st.sx >= 0 && st.sy >= 0 && st.sx <= root.innerWidth && st.sy <= root.innerHeight;
      step(st.onPage ? pick(st.sx, st.sy) : null, now);
      emit('gaze', { x: st.sx, y: st.sy, screenX: m.x, screenY: m.y, ok: true, target: st.cur });
      draw();
    }
    function setStatus(s, detail) { if (s !== st.status || detail !== st.detail) { st.status = s; st.detail = detail || ''; pillUntil = performance.now() + 5000; draw(); emit('status', { status: s, detail }); } }
    async function diagnose() {                       // EventSource hides why it failed: ask once, politely
      const now = performance.now(); if (now - st.diagAt < 4000) return; st.diagAt = now;
      try {
        const r = await fetch(o.server + '/gaze/latest', { cache: 'no-store' });
        if (r.ok) setStatus('live', 'connected');
        else { const j = await r.json().catch(() => ({})); setStatus(/off/.test(j.error || '') ? 'off' : 'blocked', j.error || 'refused (' + r.status + ')'); }
      } catch (e) {                                   // either nothing is listening, or the browser refused (CORS / mixed content / local-network permission)
        let reachable = false; try { await fetch(o.server + '/gaze/latest', { mode: 'no-cors', cache: 'no-store' }); reachable = true; } catch (_) { /* really unreachable */ }
        if (reachable) setStatus('blocked', 'the tracker server answered but this website is not allowed — in the Gaze tab, allow ' + location.origin);
        else setStatus('unreachable', 'cannot reach ' + o.server + ' — is viewer.py running? (On an https page the browser may be asking permission for local-network access.)');
      }
    }
    function connect() {
      if (st.es) st.es.close();
      let es; try { es = new EventSource(o.server + '/gaze'); } catch (e) { setStatus('unreachable', String(e)); return; }
      st.es = es;
      es.onmessage = e => { try { onSample(JSON.parse(e.data)); } catch (_) { /* ignore a bad frame */ } };
      es.onerror = () => { if (st.status === 'live' || st.status === 'idle') setStatus('connecting', 'waiting for the tracker server…'); diagnose(); };
    }

    /* ---- on-screen pointer: off / small dot / broad circle (hidden by default; the child may not need to see it) ---- */
    const hexRgba = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); return m ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')' : 'rgba(255,210,74,' + a + ')'; };
    // real millimetres per CSS pixel, from the physical screen size the tracker server reports (so "1.5 inch" really is 1.5 inch)
    const mmPerPx = () => { const mm = st.hello && st.hello.screen_mm; return mm && screen.width ? mm[0] / screen.width : 25.4 / 96; };
    const pointerPx = () => (o.pointer === 'circle' ? Math.max(12, o.circleInches * 25.4 / mmPerPx()) : o.dotPx);
    let pillPinned = false;
    function ensureUI() {
      if (ui) return ui; const d = document.createElement('div'); d.setAttribute('aria-hidden', 'true');
      d.innerHTML = '<div data-k="ptr" style="position:fixed;border-radius:50%;pointer-events:none;display:none;z-index:2147483000;box-sizing:border-box"></div>' +
        '<div data-k="ring" style="position:fixed;border-radius:50%;pointer-events:none;display:none;z-index:2147482999"></div>' +
        '<div data-k="pill" style="position:fixed;left:10px;bottom:10px;padding:5px 12px;border-radius:99px;background:rgba(0,0,0,.72);color:#fff;font:12px system-ui,sans-serif;pointer-events:none;display:none;z-index:2147483001;max-width:70vw"></div>';
      document.body.appendChild(d); ui = { ptr: d.querySelector('[data-k=ptr]'), ring: d.querySelector('[data-k=ring]'), pill: d.querySelector('[data-k=pill]') }; return ui;
    }
    function flashRing() {
      if (o.pointer === 'off' || !ui) return; const u = ui, d = pointerPx() + 16;
      Object.assign(u.ring.style, { width: d + 'px', height: d + 'px', margin: (-d / 2) + 'px 0 0 ' + (-d / 2) + 'px', left: st.sx + 'px', top: st.sy + 'px', background: 'rgba(75,227,138,.55)', display: 'block', opacity: Math.max(.35, o.pointerOpacity) });
      setTimeout(() => { u.ring.style.display = 'none'; }, 300);
    }
    function draw() {
      const now = performance.now(), pillOn = pillPinned || now < pillUntil;
      if (!ui && !pillOn && o.pointer === 'off') return; const u = ensureUI();
      const colour = { live: '#4be38a', connecting: '#ffd24a', off: '#ff9a3c', blocked: '#ff6b6b', unreachable: '#ff6b6b', idle: '#8b97a8' }[st.status] || '#8b97a8';
      u.pill.style.display = pillOn ? 'block' : 'none';
      u.pill.innerHTML = '<span style="color:' + colour + '">●</span> gaze: ' + (st.status === 'live' ? 'live' : st.status) + (st.detail ? ' · ' + st.detail : '') + ' · pointer ' + o.pointer + ' · dwell ' + (st.dwellOn ? o.dwellMs + ' ms' : 'off');
      const show = o.pointer !== 'off' && st.status === 'live' && st.onPage && now - st.lastAt < o.staleMs, p = u.ptr.style;
      if (!show) { p.display = 'none'; if (!st.fired) u.ring.style.display = 'none'; return; }
      const d = pointerPx(), c = o.pointerColor;
      Object.assign(p, { display: 'block', width: d + 'px', height: d + 'px', margin: (-d / 2) + 'px 0 0 ' + (-d / 2) + 'px', left: st.sx + 'px', top: st.sy + 'px', opacity: Math.min(1, Math.max(.05, o.pointerOpacity)) });
      if (o.pointer === 'circle') { p.border = '3px solid ' + c; p.background = 'radial-gradient(circle, ' + hexRgba(c, .55) + ' 0, ' + hexRgba(c, .55) + ' 3px, ' + hexRgba(c, .16) + ' 4px)'; }
      else { p.border = '0'; p.background = c; }
      if (st.cur && st.dwellOn && !st.fired) {
        const f = Math.min(1, (now - st.curSince) / o.dwellMs), r = d + 14;
        Object.assign(u.ring.style, { width: r + 'px', height: r + 'px', margin: (-r / 2) + 'px 0 0 ' + (-r / 2) + 'px', left: st.sx + 'px', top: st.sy + 'px', display: 'block', opacity: Math.min(1, Math.max(.35, o.pointerOpacity)),
          background: 'conic-gradient(rgba(75,227,138,.9) ' + f * 360 + 'deg, rgba(255,255,255,.18) 0)', webkitMask: 'radial-gradient(circle, transparent 60%, #000 62%)', mask: 'radial-gradient(circle, transparent 60%, #000 62%)' });
      } else if (!st.fired) u.ring.style.display = 'none';
    }
    function keys(e) {
      if (!o.hotkeys || !e.ctrlKey || !e.altKey) return;
      if (e.code === 'KeyG') { o.pointer = o.pointer === 'off' ? 'dot' : o.pointer === 'dot' ? 'circle' : 'off'; pillUntil = performance.now() + 3000; persist(); emit('option', { pointer: o.pointer }); draw(); }
      else if (e.code === 'KeyD') { st.dwellOn = !st.dwellOn; pillUntil = performance.now() + 3000; draw(); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { o.dwellMs = Math.max(200, Math.min(5000, o.dwellMs + (e.code === 'ArrowUp' ? 100 : -100))); pillUntil = performance.now() + 3000; persist(); emit('option', { dwellMs: o.dwellMs }); draw(); }
      else return; e.preventDefault();
    }

    /* ---- public ---- */
    const api = {
      options: o,
      start() {
        if (st.started) return api; st.started = true; connect();
        timer = setInterval(() => { if (st.status === 'live' && performance.now() - st.lastAt > o.staleMs) { st.onPage = false; step(null, performance.now()); } draw(); }, 100);
        if (o.hotkeys) root.addEventListener('keydown', keys, true);
        return api;
      },
      stop() { if (st.es) st.es.close(); st.es = null; clearInterval(timer); root.removeEventListener('keydown', keys, true); st.started = false; setStatus('idle', ''); if (ui) { ui.ptr.style.display = ui.pill.style.display = ui.ring.style.display = 'none'; } return api; },
      setOptions(p) { Object.assign(o, p); persist(); return api; },
      setDwellEnabled(b) { st.dwellOn = !!b; return api; },
      showStatus(on) { pillPinned = !!on; draw(); return api; },
      status() { return { status: st.status, detail: st.detail, hello: st.hello, x: st.sx, y: st.sy, target: st.cur, dwellOn: st.dwellOn }; },
    };
    return api;
  }

  root.GazeBridge = { create, version: VERSION };
})(typeof window !== 'undefined' ? window : this);
