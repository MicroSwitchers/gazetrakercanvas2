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
 * Hotkeys (examiner): Ctrl+Alt+G show/hide the gaze dot + status, Ctrl+Alt+D dwell on/off, Ctrl+Alt+ArrowUp/Down dwell time ±100 ms.
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
    overlay: false,          // gaze dot + status pill visible (toggle with Ctrl+Alt+G)
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

    const st = {
      es: null, status: 'idle', detail: '', hello: null, lastAt: 0, last: null, sx: null, sy: null, onPage: false,
      cur: null, curSince: 0, lostSince: 0, fired: false, lastFiredObj: null, lastFiredLeave: 0, lastFireAt: 0,
      dwellOn: true, diagAt: -1e9, started: false,
    };
    let ui = null, pillUntil = 0, timer = 0;

    const persist = () => { if (!o.persist) return; try { localStorage.setItem(o.storageKey, JSON.stringify({ dwellMs: o.dwellMs, tolerancePx: o.tolerancePx, overlay: o.overlay, server: o.server })); } catch (_) { /* private mode */ } };
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

    /* ---- examiner overlay (hidden by default; the child should not see a cursor) ---- */
    function ensureUI() {
      if (ui) return ui; const d = document.createElement('div'); d.setAttribute('aria-hidden', 'true');
      d.innerHTML = '<div data-k="dot" style="position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #ffd24a;background:rgba(255,210,74,.25);pointer-events:none;display:none;z-index:2147483000"></div>' +
        '<div data-k="ring" style="position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;pointer-events:none;display:none;z-index:2147482999"></div>' +
        '<div data-k="pill" style="position:fixed;left:10px;bottom:10px;padding:5px 12px;border-radius:99px;background:rgba(0,0,0,.72);color:#fff;font:12px system-ui,sans-serif;pointer-events:none;display:none;z-index:2147483001;max-width:70vw"></div>';
      document.body.appendChild(d); ui = { dot: d.querySelector('[data-k=dot]'), ring: d.querySelector('[data-k=ring]'), pill: d.querySelector('[data-k=pill]') }; return ui;
    }
    function flashRing() { if (!o.overlay) return; const u = ensureUI(); u.ring.style.background = 'rgba(75,227,138,.55)'; u.ring.style.display = 'block'; setTimeout(() => { u.ring.style.display = 'none'; }, 300); }
    function draw() {
      const now = performance.now(), pillOn = o.overlay || now < pillUntil;
      if (!ui && !pillOn && !o.overlay) return; const u = ensureUI();
      const colour = { live: '#4be38a', connecting: '#ffd24a', off: '#ff9a3c', blocked: '#ff6b6b', unreachable: '#ff6b6b', idle: '#8b97a8' }[st.status] || '#8b97a8';
      u.pill.style.display = pillOn ? 'block' : 'none';
      u.pill.innerHTML = '<span style="color:' + colour + '">●</span> gaze: ' + (st.status === 'live' ? 'live' : st.status) + (st.detail ? ' · ' + st.detail : '') + (o.overlay ? ' · dwell ' + (st.dwellOn ? o.dwellMs + ' ms' : 'off') : '');
      const showDot = o.overlay && st.status === 'live' && st.onPage && now - st.lastAt < o.staleMs;
      u.dot.style.display = showDot ? 'block' : 'none'; if (showDot) { u.dot.style.left = st.sx + 'px'; u.dot.style.top = st.sy + 'px'; }
      if (showDot && st.cur && st.dwellOn && !st.fired) {
        const f = Math.min(1, (now - st.curSince) / o.dwellMs);
        u.ring.style.display = 'block'; u.ring.style.left = st.sx + 'px'; u.ring.style.top = st.sy + 'px';
        u.ring.style.background = 'conic-gradient(rgba(75,227,138,.85) ' + f * 360 + 'deg, rgba(255,255,255,.15) 0)'; u.ring.style.webkitMask = u.ring.style.mask = 'radial-gradient(circle, transparent 58%, #000 60%)';
      } else if (!st.fired) u.ring.style.display = 'none';
    }
    function keys(e) {
      if (!o.hotkeys || !e.ctrlKey || !e.altKey) return;
      if (e.code === 'KeyG') { o.overlay = !o.overlay; pillUntil = performance.now() + 3000; persist(); draw(); }
      else if (e.code === 'KeyD') { st.dwellOn = !st.dwellOn; pillUntil = performance.now() + 3000; draw(); }
      else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') { o.dwellMs = Math.max(200, Math.min(5000, o.dwellMs + (e.code === 'ArrowUp' ? 100 : -100))); pillUntil = performance.now() + 3000; persist(); draw(); }
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
      stop() { if (st.es) st.es.close(); st.es = null; clearInterval(timer); root.removeEventListener('keydown', keys, true); st.started = false; setStatus('idle', ''); if (ui) { ui.dot.style.display = ui.pill.style.display = ui.ring.style.display = 'none'; } return api; },
      setOptions(p) { Object.assign(o, p); persist(); return api; },
      setDwellEnabled(b) { st.dwellOn = !!b; return api; },
      status() { return { status: st.status, detail: st.detail, hello: st.hello, x: st.sx, y: st.sy, target: st.cur, dwellOn: st.dwellOn }; },
    };
    return api;
  }

  root.GazeBridge = { create, version: VERSION };
})(typeof window !== 'undefined' ? window : this);
