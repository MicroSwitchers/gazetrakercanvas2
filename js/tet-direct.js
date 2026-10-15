/* tet-direct.js — the "connect straight to the tracker" source for gaze-bridge.js, the camera picture and eye pose for the
 * position guide, and the examiner's calibration.
 *
 * Needs js/tet-usb.js, js/calmath.js and js/eye-model.js. Gives gaze-bridge.js the same messages the Python Gaze Assessment Tools send
 * ({ ok, x, y, rx, ry, l, r, dist, cal } as fractions of the screen), so the rest of the page does not know the difference.
 *
 *   const td = TetDirect.create();
 *   GazeBridge.create({ source: td.source, ... }).start();
 *   td.connect();            // from a click the first time; td.autoConnect() afterwards
 *   td.setEyeMode('both' | 'left' | 'right' | 'either');   // which eye(s) the gaze follows ('either' = whichever eye is looking, sliding between them)
 *   td.calibrate();          // 9 dots that move on when the person has looked at them, then 4 check dots that also refine the result
 *   td.recheck();            // just the 4 check dots (with the same refinement)
 *   td.pose(10)              // smoothed eye position { mid:[x,y,z] mm, ipd, roll, sd } or null
 *   td.image()               // { px: Uint8Array(280*280), at } latest camera picture, or null
 *
 * Eye modes: calibrating one eye at a time (the other covered) is what lets a wandering or deviating eye be measured at all, and 'either'
 * then follows whichever eye is on the target (js/eye-model.js). It needs the tracker's separate left / right gaze, which the module
 * finds by itself (EyeModel.createDetector); when it cannot, the mode quietly falls back to both eyes and says so.
 *
 * How the calibration is done. The tracker computes gaze with a 3-D model of each eye (pupil and corneal reflections), and the right way
 * to calibrate it is inside that model, the way the maker's own software does: "select eyes to detect" (left / right / both), then each dot
 * collected for the chosen eye(s), then the tracker fits and applies its per-eye parameters (the usual screen-based monocular calibration;
 * the tracker's "select eyes" and per-eye dot mask, from public reverse-engineering notes). A model calibrated this way keeps following the eye when the head
 * moves, which a flat correction of the output cannot. So calibrate() runs the tracker's own calibration for the chosen eye(s), keeps the
 * result (IndexedDB, it is ~650 KB) and puts it back into the tracker on every connect, since the tracker forgets it whenever it restarts.
 * The check dots afterwards measure the result and may add a small shift on top. If the tracker refuses (other firmware), the old
 * way is used instead: an affine correction of the tracker's output fitted from the same dots.
 */
(function (root) {
  'use strict';
  const LS_SCREEN = 'tetDirect.screen.v1', LS_CAL = 'tetDirect.cal.v3', LS_CAL_V2 = 'tetDirect.cal.v2', LS_CAL_OLD = 'tetDirect.cal.v1', LS_CHECK = 'tetDirect.check.v1', LS_EYES = 'tetDirect.eyes.v1';
  const MASK = { both: 3, left: 1, right: 2, either: 3 }, SIDE_MASK = { C: 3, L: 1, R: 2 }, IDENT = [1, 0, 0, 0, 1, 0];

  /** The tracker's calibrations, one per eye mode, kept in IndexedDB (too big for localStorage). Every call fails soft. */
  const blobs = (() => {
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('tetDirect', 1); r.onupgradeneeded = () => r.result.createObjectStore('cal'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
      const t = db.transaction('cal', mode), r = fn(t.objectStore('cal'));
      t.oncomplete = () => { db.close(); res(r ? r.result : undefined); }; t.onerror = t.onabort = () => { db.close(); rej(t.error); };
    }));
    const soft = (p, d) => p.catch(e => { console.warn('[tet-direct] calibration store', e); return d; });
    return {
      get: k => soft(run('readonly', s => s.get(k)), null), set: (k, v) => soft(run('readwrite', s => s.put(v, k)).then(() => true), false),
      keys: () => soft(run('readonly', s => s.getAllKeys()), []), clear: () => soft(run('readwrite', s => s.clear()), null),
    };
  })();

  /** Calibrations are kept per eye mode ({ v: 3, modes: { both, left, right, either } }); older saves are split up the same way. */
  function migrate(c) {
    const out = { v: 3, modes: {} }, isAm = a => Array.isArray(a) && a.length === 6 && a.every(Number.isFinite);
    if (!c) return out;
    if (c.v === 3 && c.modes) { Object.keys(c.modes).forEach(k => { if (MASK[k] && c.modes[k]) out.modes[k] = c.modes[k]; }); return out; }
    const base = { created: c.created, screenMm: c.screenMm, fullscreen: c.fullscreen, points: c.points }, pe = c.perEye || {}, p = c.pts || {};
    const stats = s => (s ? { errDeg: s.errDeg, score: s.score, grade: s.grade } : { errDeg: c.errDeg, score: c.score, grade: c.grade });
    if (isAm(c.A)) out.modes.both = Object.assign({}, base, stats(pe.C), { A: c.A, pts: { C: p.C || [] } });
    [['L', 'left'], ['R', 'right']].forEach(([k, name]) => {
      if (isAm(c[k])) out.modes[name] = Object.assign({}, base, stats(pe[k]), { [k]: c[k], [k + 'f']: c[k + 'f'] || null, srcF: { [k]: !!(c.srcF && c.srcF[k]) }, pts: { [k]: p[k] || [] }, perEye: { [k]: pe[k] } });
    });
    if (isAm(c.L) && isAm(c.R)) out.modes.either = Object.assign({}, base, stats(null), { L: c.L, R: c.R, pts: { L: p.L || [], R: p.R || [] }, perEye: { L: pe.L, R: pe.R } });
    return out;
  }
  const CAL9 = [[.5, .5], [.1, .1], [.9, .1], [.1, .9], [.9, .9], [.5, .1], [.5, .9], [.1, .5], [.9, .5]];
  const COLLECT_MS = 900, MIN_SAMPLES = 10, CHECK_N = 4, FEEDBACK_MS = 1300;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } };
  const isA = a => Array.isArray(a) && a.length === 6 && a.every(Number.isFinite);
  const MODES = ['both', 'left', 'right', 'either'];
  const SIDE_NAME = { C: 'both eyes', L: 'left eye', R: 'right eye' };

  function create(opts) {
    opts = Object.assign({ initUrl: 'data/tet-init.bin' }, opts || {});
    const S = { status: 'idle', detail: 'click “Connect tracker”', last: null, cal: migrate(lsGet(LS_CAL) || lsGet(LS_CAL_V2) || lsGet(LS_CAL_OLD)), check: lsGet(LS_CHECK), diagIn: (lsGet(LS_SCREEN) || {}).diagIn || null,
                subs: new Set(), changeFns: new Set(), imgFns: new Set(), collector: null, busy: false, ir: null, irAt: 0, poseBuf: [],
                eyeMode: MODES.includes((lsGet(LS_EYES) || {}).mode) ? lsGet(LS_EYES).mode : 'both', targetFn: null, dotTarget: null, proj: null, projKey: '', lastDist: 600, qual: { L: null, R: null }, foundAnnounced: false,
                // the tracker's own calibration: which kept one is in the tracker now (null = the start-up one, undefined = not known), which modes have one kept
                devApplied: null, devQ: Promise.resolve(), devHold: false, blobKeys: new Set(), blobsKnown: false };
    const det = EyeModel.createDetector(), filtL = EyeModel.createPointFilter(), filtR = EyeModel.createPointFilter();   // each eye's own gaze is jumpy: smoothed before it is used
    const recFor = mode => S.cal.modes[mode] || null;

    const screenMm = () => {
      if (!S.diagIn) return null;
      const w = screen.width || 16, h = screen.height || 9, d = S.diagIn * 25.4, hy = Math.hypot(w, h);
      return [Math.round(d * w / hy), Math.round(d * h / hy)];
    };
    const hasMats = (r, mode) => !!r && (mode === 'both' ? isA(r.A) : mode === 'left' ? isA(r.L) : mode === 'right' ? isA(r.R) : isA(r.L) && isA(r.R));
    /** Calibrated for this mode: the correction is there, and if it sits on top of the tracker's own calibration, that one is kept too. */
    const covers = mode => { const r = recFor(mode); return hasMats(r, mode) && (!r.dev || !S.blobsKnown || S.blobKeys.has(mode)); };
    const effectiveMode = () => (S.eyeMode !== 'both' && !det.found ? 'both' : S.eyeMode);   // no per-eye data yet: follow both eyes rather than nothing
    const fusion = EyeModel.createFusion({ screenMm: () => screenMm() || [300, 170], distMm: () => S.lastDist, target: (x, y) => (S.dotTarget ? Math.exp(-Math.hypot(x - S.dotTarget[0], y - S.dotTarget[1]) / 0.05) : S.targetFn ? S.targetFn(x, y) : 0.5), quality: S.qual });   // during set-up the dot is the target
    const setQuality = () => { const pe = (recFor('either') || {}).perEye || {}; S.qual.L = pe.L ? pe.L.score / 100 : null; S.qual.R = pe.R ? pe.R.score / 100 : null; };
    setQuality();
    const projFor = () => {
      const mm = screenMm(); if (!mm) return null; const key = mm.join('x');
      if (S.projKey !== key) { S.proj = EyeModel.planeProjector(TetUSB._t.displayPoints(mm[0], mm[1], 20)); S.projKey = key; }
      return S.proj;
    };

    const changed = () => S.changeFns.forEach(f => { try { f(state()); } catch (e) { console.error(e); } });
    function state() {
      const r = recFor(S.eyeMode);
      return { status: S.status, detail: S.detail, calibrated: covers(S.eyeMode), anyCalibration: Object.keys(S.cal.modes).length > 0, cal: r, check: S.check, diagIn: S.diagIn, screenMm: screenMm(), last: S.last, busy: S.busy,
               supported: TetUSB.supported(), eyeMode: S.eyeMode, perEye: !!det.found, perEyeId: det.found ? det.found.id : null, inTracker: !!(r && r.dev), trackerHasIt: !!(r && r.dev) && S.devApplied === S.eyeMode };
    }
    function hello() { return { hello: true, screen_mm: screenMm(), calibrated: covers(S.eyeMode), simulated: false, direct: true }; }
    function pushState() {
      S.subs.forEach(s => { if (S.status === 'live') s.onMsg(hello()); else s.setStatus(S.status, S.detail); });
      changed();
    }

    const tracker = TetUSB.create({
      initUrl: opts.initUrl, displayMm: screenMm(), images: false, wantImage: () => S.imgFns.size > 0,
      onStatus: (st, text) => { S.status = st; S.detail = text; if (st !== 'live') { S.ir = null; S.poseBuf.length = 0; fusion.reset(); filtL.reset(); filtR.reset(); } pushState(); },
      onImage: px => { S.ir = px; S.irAt = performance.now(); S.imgFns.forEach(f => { try { f(px); } catch (e) { console.error(e); } }); },
      onLive: () => { S.devApplied = null; return syncDevice(); },          // every connect starts with the start-up calibration: put ours back
      onGaze: g => {
        const now = performance.now(), mode = effectiveMode(), cal = recFor(mode) || {}, x = g.x, y = g.y, okC = !!g.valid && x != null && x >= 0, combined = okC ? [x, y] : null;
        const lOn = !!g.eyes.left.tracked, rOn = !!g.eyes.right.tracked;
        det.feed(g.pt, combined, projFor(), lOn, rOn);
        if (det.found && !S.foundAnnounced) { S.foundAnnounced = true; changed(); }
        const pe = det.read(g.pt, projFor(), lOn, rOn);
        const raw = { C: combined, L: filtL.step(now, pe && pe.L), R: filtR.step(now, pe && pe.R) };
        // With the other eye covered (not found) the tracker's combined gaze IS this one eye, and it has been filtered by the tracker itself: steadier than the eye's raw point
        const filt = { L: combined && lOn && !rOn ? combined : null, R: combined && rOn && !lOn ? combined : null };
        const eye = n => { const e = g.eyes[n]; return e.tracked && e.origin_ok && e.origin_mm && e.origin_mm.length >= 3 ? e.origin_mm : null; };
        const eL = eye('left'), eR = eye('right'), zs = [eL, eR].filter(Boolean).map(e => e[2]);
        const dist = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null; if (dist) S.lastDist = dist;
        let out = null, which = 'both';
        if (mode === 'both') { if (combined) out = CalMath.apply(cal.A, combined[0], combined[1]); }
        else if (mode === 'left' || mode === 'right') {
          const k = mode === 'left' ? 'L' : 'R', useF = !!(cal.srcF && cal.srcF[k] && cal[k + 'f'] && filt[k]);       // the filtered gaze, if calibration found it more accurate for this eye
          const src = useF ? filt[k] : raw[k]; if (src) { out = CalMath.apply(useF ? cal[k + 'f'] : cal[k], src[0], src[1]); which = k; }
        }
        else {
          const pL = raw.L ? CalMath.apply(cal.L, raw.L[0], raw.L[1]) : null, pR = raw.R ? CalMath.apply(cal.R, raw.R[0], raw.R[1]) : null;
          const r = fusion.update(now, pL, pR); if (r.x != null) { out = [r.x, r.y]; which = r.eye; }
        }
        const ok = !!out;
        const msg = { ts: Date.now(), ok, x: ok ? out[0] : null, y: ok ? out[1] : null, rx: combined ? combined[0] : null, ry: combined ? combined[1] : null, raw, filt,
                      l: lOn, r: rOn, dist, cal: covers(S.eyeMode), eL, eR, eye: which, mode };
        const p = CalMath.eyePose(eL, eR);
        if (p && p.both) S.poseBuf.push({ t: now, p });
        while (S.poseBuf.length && now - S.poseBuf[0].t > 1500) S.poseBuf.shift();
        S.last = msg;
        if (S.collector) S.collector(msg);
        S.subs.forEach(s => s.onMsg(msg));
      },
    });

    const D = tracker.device;
    /**
     * Makes the tracker hold the right calibration for the current eye mode: the kept one when this mode was calibrated in the tracker,
     * otherwise the start-up one. Queued, so calls never overlap; skipped while a calibration is running.
     */
    function syncDevice() {
      S.devQ = S.devQ.then(async () => {
        if (!tracker.live || S.devHold || !D) return;
        const r = recFor(S.eyeMode); let want = r && r.dev && S.blobKeys.has(S.eyeMode) ? S.eyeMode : null, blob = null;
        if (S.devApplied === want) return;
        if (want) { blob = await blobs.get(want); if (!blob || !blob.length) { S.blobKeys.delete(want); want = null; } }
        if (S.devApplied === want) return;
        try {
          if (want) { await D.setEye(MASK[want]).catch(e => { if (e.code == null) throw e; }); await D.apply(blob); }      // a refused eye selection (older firmware) is not fatal
          else await D.restoreDefault();
          S.devApplied = want;
        } catch (e) { console.warn('[tet-direct] could not load the calibration into the tracker', e); S.devApplied = undefined; }
        pushState();
      }).catch(e => console.warn('[tet-direct]', e));
      return S.devQ;
    }
    blobs.keys().then(ks => { (ks || []).forEach(k => S.blobKeys.add(k)); S.blobsKnown = true; pushState(); syncDevice(); });

    /** What gaze-bridge.js subscribes to instead of the Python server. */
    const source = {
      subscribe(onMsg, setStatus) { const s = { onMsg, setStatus }; S.subs.add(s); pushState(); return () => S.subs.delete(s); },
    };

    /** Smoothed pose of the last n frames with both eyes tracked, or null when stale / too few. */
    function pose(n) {
      n = n || 10; const now = performance.now(), r = S.poseBuf.filter(e => now - e.t < 600).slice(-n);
      if (r.length < Math.min(n, 5)) return null;
      const m = k => CalMath.mean(r.map(e => e.p.mid[k])), mid = [m(0), m(1), m(2)];
      const sd = Math.sqrt(CalMath.mean(r.map(e => (e.p.mid[0] - mid[0]) ** 2 + (e.p.mid[1] - mid[1]) ** 2)));
      return { mid, ipd: CalMath.mean(r.map(e => e.p.ipd)), roll: CalMath.mean(r.map(e => e.p.roll)), both: true, sd, n: r.length };
    }

    /* ---------------------------------------------------------------- full-screen sessions */
    const clientToFrac = (px, py) => {
      const full = document.fullscreenElement || (innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2);
      if (full) return [px / innerWidth, py / innerHeight];
      const side = (outerWidth - innerWidth) / 2, left = screenX + side, top = screenY + (outerHeight - innerHeight) - side;
      return [(px + left) / screen.width, (py + top) / screen.height];
    };
    const fracToClient = (fx, fy) => {
      const full = document.fullscreenElement || (innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2);
      if (full) return [fx * innerWidth, fy * innerHeight];
      const side = (outerWidth - innerWidth) / 2, left = screenX + side, top = screenY + (outerHeight - innerHeight) - side;
      return [fx * screen.width - left, fy * screen.height - top];
    };
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const CSS = `
.td-ov{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;background:#0b100f;color:var(--md-on-surface,#edf3ee);font-family:Inter,"Segoe UI",system-ui,sans-serif;cursor:none}
.td-ov.td-ask{cursor:default}
.td-card{width:min(460px,calc(100vw - 32px));box-sizing:border-box;padding:26px 26px 22px;border-radius:20px;background:var(--md-surface,#1d2524);border:1px solid var(--md-outline,#3b4942);box-shadow:0 24px 64px rgb(0 0 0 / 45%)}
.td-kicker{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--md-primary,#8ed7bf)}
.td-card h2{margin:0 0 8px;font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--md-on-surface,#edf3ee)}
.td-card p{margin:6px 0;font-size:13.5px;line-height:1.5;color:var(--md-on-surface-muted,#a2b7aa)}
.td-chip{display:flex;align-items:center;gap:9px;margin:14px 0 4px;padding:10px 12px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942);font-size:13px;font-weight:600;color:var(--md-on-surface,#edf3ee)}
.td-chip i{flex:none;width:9px;height:9px;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 3px rgb(251 191 36 / 22%)}
.td-chip.ok i{background:#34d399;box-shadow:0 0 0 3px rgb(52 211 153 / 22%)}
.td-eye{display:inline-block;margin:2px 0 6px;padding:3px 10px;border-radius:999px;background:var(--md-primary-container,#25443b);color:var(--md-on-primary-container,var(--md-on-surface,#edf3ee));font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.td-score{display:flex;align-items:baseline;gap:10px;margin:12px 0 4px}
.td-score b{font-size:40px;font-weight:750;letter-spacing:-.03em;color:var(--md-on-surface,#edf3ee)}
.td-score small{font-size:14px;color:var(--md-on-surface-muted,#a2b7aa)}
.td-score span{font-size:14px;font-weight:650;padding:3px 10px;border-radius:999px;background:var(--md-primary-container,#25443b);color:var(--md-on-primary-container,var(--md-on-surface,#edf3ee))}
.td-score.warn span{background:rgb(251 191 36 / 18%);color:#fbbf24}
.td-rows{display:grid;gap:6px;margin:10px 0 4px}
.td-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:8px 12px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942);font-size:13px}
.td-row b{font-weight:700;color:var(--md-on-surface,#edf3ee)}
.td-map{display:block;width:100%;height:auto;margin:12px 0 4px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942)}
.td-btns{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
.td-btn{flex:1;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid var(--md-outline,#3b4942);background:var(--md-surface-variant,#252f2c);color:var(--md-on-surface,#edf3ee);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.td-btn:hover{border-color:var(--md-primary,#8ed7bf)}
.td-btn:disabled{opacity:.45;cursor:default}
.td-btn.primary{border-color:transparent;background:var(--md-primary,#8ed7bf);color:var(--md-on-primary,#0b2a22);box-shadow:0 4px 14px color-mix(in srgb,var(--md-primary,#8ed7bf) 30%,transparent)}
.td-btn:focus-visible{outline:2px solid var(--md-primary,#8ed7bf);outline-offset:2px}
.td-dot{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;display:none;transition:left .65s cubic-bezier(.25,.8,.25,1),top .65s cubic-bezier(.25,.8,.25,1)}
.td-dot::before{content:"";position:absolute;inset:0;border-radius:50%;background:rgb(45 212 191 / 28%);box-shadow:0 0 0 2px rgb(45 212 191 / 70%)}
.td-dot::after{content:"";position:absolute;inset:14px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px #0b100f}
.td-dot.td-wait::before{animation:td-pulse 1.1s ease-in-out infinite}
.td-dot.td-collect::before{transform:scale(.36);transition:transform ${COLLECT_MS}ms linear;background:rgb(45 212 191 / 55%)}
.td-dot.td-grow::before{transform:scale(1);transition:transform .25s ease-out}
.td-dot.td-done::before{animation:td-pop .35s ease-out forwards;background:rgb(52 211 153 / 55%)}
@keyframes td-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.55}}
@keyframes td-pop{0%{transform:scale(.4);opacity:1}100%{transform:scale(2.2);opacity:0}}
.td-fb{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.td-lab{position:fixed;padding:3px 9px;border-radius:999px;background:rgb(0 0 0 / 70%);color:#fff;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;transform:translate(-50%,0)}
.td-progress{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);font-size:13px;font-weight:600;letter-spacing:.02em;color:rgb(255 255 255 / 55%);white-space:nowrap;text-align:center}
.td-progress:empty{display:none}
@media (prefers-reduced-motion: reduce){.td-dot,.td-dot.td-wait::before{animation:none;transition:none}}`;
    const ensureCss = () => { if (document.getElementById('td-style')) return; const st = document.createElement('style'); st.id = 'td-style'; st.textContent = CSS; document.head.appendChild(st); };
    const toDeg = (dx, dy, sm, dist) => CalMath.angDeg(dx * sm[0], dy * sm[1], dist || 600);
    const screenSize = () => screenMm() || [293, 165];

    /** Runs fn(ui) on a full-screen overlay. Always cleans up. Resolves to fn's result, or null when cancelled. */
    async function runSession(fn) {
      if (S.busy) return null;
      if (S.status !== 'live') { alert('Connect the tracker first — the status must say it is streaming.'); return null; }
      S.busy = true; changed();
      const wasFull = !!document.fullscreenElement; ensureCss();
      const ov = mk('div', 'td-ov'), box = mk('div', 'td-card'), dot = mk('div', 'td-dot'), progress = mk('div', 'td-progress'), fb = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); fb.setAttribute('class', 'td-fb');
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Eye tracker');
      ov.append(box, fb, dot, progress); document.body.appendChild(ov);
      let cancelled = false, wake = null, skip = false, prevPx = null;
      const onKey = e => {
        if (e.key === 'Escape') { cancelled = true; e.preventDefault(); e.stopPropagation(); if (wake) wake(); }
        else if (e.key === ' ' && dot.style.display === 'block') { skip = true; e.preventDefault(); e.stopPropagation(); }
      };
      addEventListener('keydown', onKey, true);
      const check = () => { if (cancelled) throw new Error('cancelled'); };
      const clearFb = () => { fb.textContent = ''; ov.querySelectorAll('.td-lab').forEach(e => e.remove()); };
      const say = (kicker, title, body, buttons) => new Promise(res => {
        box.textContent = ''; box.style.display = ''; clearFb(); ov.classList.toggle('td-ask', !!buttons); dot.style.display = 'none'; progress.textContent = '';
        if (kicker) box.appendChild(mk('div', 'td-kicker', kicker));
        box.appendChild(mk('h2', '', title));
        (body || []).forEach(b => box.appendChild(typeof b === 'string' ? mk('p', '', b) : b));
        if (!buttons) { res(null); return; }
        const row = mk('div', 'td-btns'); buttons.forEach(([label, val, primary, disabled]) => { const b = mk('button', 'td-btn' + (primary ? ' primary' : ''), label); b.type = 'button'; b.disabled = !!disabled; b.onclick = () => res(val); row.appendChild(b); });
        box.appendChild(row); wake = () => res('cancel'); const first = row.querySelector('.primary:not(:disabled)'); if (first) first.focus();
      });
      const medianDist = ms => { const z = ms.map(m => m.dist).filter(v => v != null).sort((a, b) => a - b); return z.length ? z[z.length >> 1] : S.lastDist || 600; };
      const moveDot = (px, py) => {
        box.style.display = 'none'; ov.classList.remove('td-ask');
        if (dot.style.display !== 'block') { Object.assign(dot.style, { display: 'block', transition: 'none', left: (prevPx ? prevPx[0] : innerWidth / 2) + 'px', top: (prevPx ? prevPx[1] : innerHeight / 2) + 'px' }); dot.offsetWidth; dot.style.transition = ''; }
        dot.style.left = px + 'px'; dot.style.top = py + 'px'; prevPx = [px, py];
      };
      const setDot = cls => { dot.classList.remove('td-wait', 'td-collect', 'td-grow', 'td-done'); void dot.offsetWidth; if (cls) dot.classList.add(cls); };

      /**
       * Shows a dot, waits until the person has actually looked at it (steady gaze on it), then collects while the dot shrinks.
       * getRaw(msg) -> the point to collect ([x, y] or null); map(raw) -> where that is on the screen once calibrated (identity while calibrating).
       * Returns { target, raw: [x, y] centre of what was collected, shown: mapped centre, ms, dist, n, skipped }.
       * o.device { add(target), discard(target) }: also has the tracker collect this dot for its own calibration. The dot is sent the moment
       * the gaze has settled on it and must be accepted while the person is still looking; if the gaze leaves first the dot is taken back
       * and asked again, and a dot the tracker refuses (it could not see the eye well enough) is retried, then skipped. A tracker that does not
       * answer at all ends it with { devBroken: error }.
       */
      const grabPoint = async (frac, label, getRaw, map, o) => {
        o = Object.assign({ radius: 0.3, steadyRadius: 0.03 }, o || {});
        const [px, py] = fracToClient(frac[0], frac[1]), target = [frac[0], frac[1]], dev = o.device || null;
        check(); moveDot(px, py); setDot('td-wait'); progress.textContent = label; skip = false; S.dotTarget = target;
        const fx = EyeModel.createFixation({ ms: 260, radius: o.steadyRadius });
        let phase = 'wait', samples = [], altSamples = [], center = null, misses = 0, t0 = performance.now(), startedAt = 0, msgs = [], devP = null, refused = 0;
        const devStart = () => { if (dev) devP = Promise.resolve().then(() => dev.add(target)).then(() => true, e => e); };
        const devTakeBack = () => { if (!dev || !devP) return; const p = devP; devP = null; p.then(r => { if (r === true) return dev.discard(target); }).catch(() => { /* best effort */ }); };
        const lookAgain = () => { phase = 'wait'; fx.reset(); setDot('td-grow'); setTimeout(() => { if (phase === 'wait') setDot('td-wait'); }, 260); };
        S.collector = m => {
          const now = performance.now(), r = getRaw(m), p = r ? map(r) : null;
          if (phase === 'wait') {
            const st = fx.feed(now, p);
            if (st.steady && Math.hypot(st.x - target[0], st.y - target[1]) <= o.radius) { phase = 'collect'; startedAt = now; samples = []; altSamples = []; msgs = []; center = [st.x, st.y]; misses = 0; setDot('td-collect'); devStart(); }
          } else if (phase === 'collect') {
            if (!p || Math.hypot(p[0] - center[0], p[1] - center[1]) > o.steadyRadius * 2.4) { if (++misses >= 4) { devTakeBack(); lookAgain(); } }
            else { misses = 0; samples.push(r); msgs.push(m); if (o.getAlt) { const a = o.getAlt(m); if (a) altSamples.push(a); } }
          }
        };
        try {
          for (;;) {
            await sleep(30); check();
            if (skip) { devTakeBack(); return null; }
            const now = performance.now();
            if (phase === 'wait' && now - t0 > 7000) progress.textContent = label + ' · look at the dot  (the examiner can press Space to skip it)';
            if (phase === 'collect' && now - startedAt >= COLLECT_MS && samples.length >= MIN_SAMPLES) {
              if (!dev) break;
              const p = devP; if (!p) { lookAgain(); continue; }
              const res = await p; check();
              if (skip) { devTakeBack(); return null; }
              if (devP !== p) continue;                          // the gaze left while the tracker was collecting: taken back, look again
              if (res === true) break;
              devP = null;
              if (!res || res.code == null) return { devBroken: res || new Error('no answer') };
              if (++refused >= 3) return null;                   // the tracker could not see the eye well enough at this dot
              progress.textContent = label + ' · the tracker could not see the eye well, keep looking at the dot'; lookAgain();
            }
          }
        } finally { S.collector = null; S.dotTarget = null; }
        const c = CalMath.summarize(samples); setDot('td-done'); progress.textContent = label;
        const raw = [c.x, c.y];
        const ac = altSamples.length >= Math.max(MIN_SAMPLES * 0.6, samples.length * 0.5) ? CalMath.summarize(altSamples) : null;      // the other signal, if it was there for most of the look
        return { target, raw, altC: ac ? [ac.x, ac.y] : null, shown: map(raw), ms: msgs, samples, dist: medianDist(msgs), n: samples.length };
      };

      /** The deviation, drawn where it happened: the dot, where the gaze landed, a line between them and the size of the miss. */
      const showDeviation = async (r, deg) => {
        const [tx, ty] = fracToClient(r.target[0], r.target[1]), [gx, gy] = fracToClient(r.shown[0], r.shown[1]);
        const col = deg > 3.5 ? '#f87171' : deg > 2 ? '#fbbf24' : '#34d399', NS = 'http://www.w3.org/2000/svg';
        const line = document.createElementNS(NS, 'line'); line.setAttribute('x1', tx); line.setAttribute('y1', ty); line.setAttribute('x2', gx); line.setAttribute('y2', gy); line.setAttribute('stroke', col); line.setAttribute('stroke-width', 3); line.setAttribute('stroke-linecap', 'round');
        const gc = document.createElementNS(NS, 'circle'); gc.setAttribute('cx', gx); gc.setAttribute('cy', gy); gc.setAttribute('r', 8); gc.setAttribute('fill', col); gc.setAttribute('stroke', '#0b100f'); gc.setAttribute('stroke-width', 2);
        fb.append(line, gc);
        const lab = mk('div', 'td-lab', deg.toFixed(1) + '° off'); lab.style.left = (tx + gx) / 2 + 'px'; lab.style.top = Math.max(8, Math.min(innerHeight - 36, Math.max(ty, gy) + 16)) + 'px'; ov.appendChild(lab);
        await sleep(FEEDBACK_MS); check(); clearFb();
      };

      /** Four random dots. Shows how far the gaze landed from each, and returns the numbers. */
      const checkDots = async (getRaw, map, label, o) => {
        const aspect = innerWidth / innerHeight, targets = [];
        for (let tries = 0; targets.length < CHECK_N && tries < 400; tries++) {
          const p = [.1 + Math.random() * .8, .12 + Math.random() * .76];
          if (targets.every(q => Math.hypot((p[0] - q[0]) * aspect, p[1] - q[1]) > 0.3 - tries * 0.0005)) targets.push(p);
        }
        const sm = screenSize(), res = [];
        for (let i = 0; i < targets.length; i++) {
          const r = await grabPoint(targets[i], `${label} · check dot ${i + 1} of ${targets.length}`, getRaw, map, Object.assign({ radius: 0.2 }, o));
          if (!r) continue;
          const deg = toDeg(r.shown[0] - r.target[0], r.shown[1] - r.target[1], sm, r.dist);
          if (r.altC && o && o.mapAlt) { r.shownAlt = o.mapAlt(r.altC); r.errAlt = toDeg(r.shownAlt[0] - r.target[0], r.shownAlt[1] - r.target[1], sm, r.dist); }
          res.push(Object.assign(r, { err: deg })); await showDeviation(r, deg);
        }
        return res;
      };
      try {
        if (!wasFull) { try { await document.documentElement.requestFullscreen(); await sleep(500); } catch (_) { /* not allowed: carry on, a little less exact */ } }
        return await fn({ say, grabPoint, checkDots, check, mk, medianDist, fullscreen: () => !!document.fullscreenElement, wasFull, setDot, clearFb });
      } catch (e) {
        if (e.message !== 'cancelled') console.error('[tet-direct]', e);
        return null;
      } finally {
        S.collector = null; removeEventListener('keydown', onKey, true); ov.remove(); S.busy = false;
        if (!wasFull && document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
        changed();
      }
    }

    /* ---------------------------------------------------------------- calibrate (9 dots) and check (4 dots) */
    const eyeFound = side => { const m = S.last; if (!m || !m.raw) return false; return !!m.raw[side]; };
    /** Live "are the eyes found" line. gate: also enables / disables the card's primary button as the eyes come and go. */
    const liveChip = (sides, gate) => {
      const chip = mk('div', 'td-chip'), d = mk('i'), t = mk('span'); chip.append(d, t);
      const names = sides.map(s => SIDE_NAME[s]).join(' and '), needPer = sides.some(s => s !== 'C');
      const ready = () => sides.every(eyeFound) && (!needPer || !!det.found);
      const upd = () => {
        const m = S.last, ok = ready(), N = names[0].toUpperCase() + names.slice(1);
        if (needPer && !det.found) t.textContent = 'Learning this tracker’s left / right data — look at the screen with both eyes open';
        else t.textContent = !m ? 'Waiting for the tracker…' : ok ? `${N} found${m.dist ? ' · about ' + Math.round(m.dist / 10) + ' cm away' : ''}` : `${N} not found — sit in front of the tracker${sides.length === 1 && needPer ? ' with only that eye uncovered' : ''}`;
        chip.classList.toggle('ok', ok);
        if (gate) { const b = chip.parentElement && chip.parentElement.querySelector('.td-btn.primary'); if (b) b.disabled = !ok; }
      };
      const iv = setInterval(upd, 200); upd(); return { chip, stop: () => clearInterval(iv), ready };
    };
    const grade = deg => CalMath.grade(deg);
    const scoreOf = deg => Math.max(0, Math.min(100, Math.round(100 - 14 * deg)));    // 0° = 100, 1° = 86, 2° = 72 (still 'Good'), 3.5° = 51
    const cap = t => t[0].toUpperCase() + t.slice(1);

    const mapA = (A, p) => CalMath.apply(A, p[0], p[1]);
    const shiftA = (A, dx, dy) => [A[0], A[1], A[2] + dx, A[3], A[4], A[5] + dy];
    /**
     * Uses the check dots to improve a calibration: leave it, shift it (the usual cure for a head that has settled somewhere new), or refit it
     * with the check dots added. Each choice is judged by how well it predicts a check dot it was NOT given (leave one out), so a refinement
     * that only fits the noise is not taken. pts, chk: [{ raw, target, dist }].  -> { A, kind: 'none' | 'shift' | 'refit', loo }
     */
    function refine(pts, chk, A0, sm) {
      const dg = (a, b, dist) => toDeg(a[0] - b[0], a[1] - b[1], sm, dist), fit = list => CalMath.fitAffine(list.map(p => p.raw), list.map(p => p.target));
      const shiftFor = list => { const r = list.map(c => { const m = mapA(A0, c.raw); return [c.target[0] - m[0], c.target[1] - m[1]]; }); return [CalMath.mean(r.map(v => v[0])), CalMath.mean(r.map(v => v[1]))]; };
      const full = fit([...pts, ...chk]);
      if (chk.length < 3) return full && isA(full) ? { A: full, kind: 'refit', loo: null } : { A: A0, kind: 'none', loo: null };
      const errs = { none: [], shift: [], refit: [] };
      chk.forEach((c, i) => {
        const rest = chk.filter((_, j) => j !== i); errs.none.push(dg(mapA(A0, c.raw), c.target, c.dist));
        const [dx, dy] = shiftFor(rest); errs.shift.push(dg(mapA(shiftA(A0, dx, dy), c.raw), c.target, c.dist));
        const Ar = fit([...pts, ...rest]); errs.refit.push(isA(Ar) ? dg(mapA(Ar, c.raw), c.target, c.dist) : 99);
      });
      const m = k => CalMath.mean(errs[k]); let kind = 'none';
      if (m('shift') < m('none') * 0.95) kind = 'shift';
      if (m('refit') < m(kind) * 0.95 && isA(full)) kind = 'refit';
      const A = kind === 'none' ? A0 : kind === 'shift' ? shiftA(A0, ...shiftFor(chk)) : full;
      return { A, kind, loo: m(kind) };
    }
    const REFINE_NOTE = { none: 'The check dots showed nothing to correct.', shift: 'The calibration was nudged using the check dots.', refit: 'The calibration was refined using the check dots.' };

    /**
     * One pass for one eye (or both): 9 dots that move on when looked at, then 4 check dots that show the deviation and refine the result.
     * For a single eye with the other covered it also tries the tracker's own filtered gaze, and keeps whichever signal the check dots show to be more accurate.
     */
    async function calibrateSide(u, side, label, single) {
      const sm = screenSize(), getRaw = m => (m.raw ? m.raw[side] : null), getAlt = single ? (m => (m.filt ? m.filt[side] : null)) : null, id = p => p, pts = [];
      for (let i = 0; i < CAL9.length; i++) { const r = await u.grabPoint(CAL9[i], `${label} · dot ${i + 1} of ${CAL9.length}`, getRaw, id, { radius: 0.32, getAlt }); if (r) pts.push({ raw: r.raw, alt: r.altC, target: r.target, dist: r.dist }); }
      if (pts.length < 5) return { fail: `Only ${pts.length} of ${CAL9.length} dots were recorded.` };
      const A0 = CalMath.fitAffine(pts.map(p => p.raw), pts.map(p => p.target)); if (!A0) return { fail: 'The points did not give a usable result.' };
      const altPts = pts.filter(p => p.alt), Af0 = single && altPts.length >= 5 ? CalMath.fitAffine(altPts.map(p => p.alt), altPts.map(p => p.target)) : null;
      const chk = await u.checkDots(getRaw, raw => mapA(A0, raw), label, { getAlt, mapAlt: isA(Af0) ? (alt => mapA(Af0, alt)) : null });
      if (chk.length < 2) return { fail: 'The check dots could not be recorded.' };
      const eRaw = CalMath.mean(chk.map(c => c.err)), withAlt = chk.filter(c => c.errAlt != null);
      const eAlt = isA(Af0) && withAlt.length >= Math.max(2, chk.length - 1) ? CalMath.mean(withAlt.map(c => c.errAlt)) : null;
      const useF = eAlt != null && eAlt < eRaw * 0.85;                           // the filtered gaze has to be clearly better to be chosen
      const rRaw = refine(pts.map(p => ({ raw: p.raw, target: p.target, dist: p.dist })), chk.map(c => ({ raw: c.raw, target: c.target, dist: c.dist })), A0, sm);
      const rAlt = isA(Af0) && withAlt.length >= 2 ? refine(altPts.map(p => ({ raw: p.alt, target: p.target, dist: p.dist })), withAlt.map(c => ({ raw: c.altC, target: c.target, dist: c.dist })), Af0, sm) : null;
      const mean = useF ? eAlt : eRaw, used = useF ? rAlt : rRaw, after = used.loo != null ? Math.min(mean, used.loo) : mean, shownChk = useF ? withAlt.map(c => Object.assign({}, c, { shown: c.shownAlt, err: c.errAlt })) : chk;   // what the person is shown is the signal that will be used
      const all = [...pts, ...chk.map(c => ({ raw: c.raw, alt: c.altC, target: c.target, dist: c.dist }))];
      return { A: rRaw.A, Af: rAlt ? rAlt.A : null, useF, kind: (useF ? rAlt : rRaw).kind, pts: all, chk: shownChk, errDeg: after, errBefore: mean, errRaw: eRaw, errFilt: eAlt, grade: grade(after).label, score: scoreOf(after) };
    }

    /**
     * After the tracker has calibrated itself: what the check dots say about it. The tracker's output is used as it is (identity), or
     * shifted / refitted when the check dots show that helps a dot they were not given (refine). For one eye with the other covered the
     * tracker's own filtered gaze is tried too, as in calibrateSide.  chk: from checkDots with identity maps.
     */
    function fromChecks(chk, single, sm) {
      const eRaw = CalMath.mean(chk.map(c => c.err)), withAlt = single ? chk.filter(c => c.errAlt != null) : [];
      const eAlt = withAlt.length >= Math.max(2, chk.length - 1) ? CalMath.mean(withAlt.map(c => c.errAlt)) : null;
      const useF = eAlt != null && eAlt < eRaw * 0.85;
      const rRaw = refine([], chk.map(c => ({ raw: c.raw, target: c.target, dist: c.dist })), IDENT, sm);
      const rAlt = withAlt.length >= 2 ? refine([], withAlt.map(c => ({ raw: c.altC, target: c.target, dist: c.dist })), IDENT, sm) : null;
      const mean = useF ? eAlt : eRaw, used = useF ? rAlt : rRaw, after = used.loo != null ? Math.min(mean, used.loo) : mean;
      const shownChk = useF ? withAlt.map(c => Object.assign({}, c, { shown: c.shownAlt, err: c.errAlt })) : chk;
      return { A: rRaw.A, Af: rAlt ? rAlt.A : (single ? IDENT : null), useF, kind: used.kind, pts: chk.map(c => ({ raw: c.raw, alt: c.altC, target: c.target, dist: c.dist })), chk: shownChk,
               errDeg: after, errBefore: mean, errRaw: eRaw, errFilt: eAlt, grade: grade(after).label, score: scoreOf(after), dev: true };
    }

    /** The 9 dots, each also collected by the tracker for the eye(s) in mask. -> { n, broken } */
    async function trackerDots(u, side, label, mask) {
      const getRaw = m => (m.raw ? m.raw[side] : null), id = p => p, device = { add: t => D.addPoint(t[0], t[1], mask), discard: t => D.discard(t[0], t[1]) };
      let n = 0;
      for (let i = 0; i < CAL9.length; i++) {
        const r = await u.grabPoint(CAL9[i], `${label} · dot ${i + 1} of ${CAL9.length}`, getRaw, id, { radius: 0.32, device });
        if (r && r.devBroken) return { n, broken: r.devBroken };
        if (r) n++;
      }
      return { n, broken: null };
    }

    const passesFor = mode => (mode === 'both' ? ['C'] : mode === 'left' ? ['L'] : mode === 'right' ? ['R'] : ['L', 'R']);
    const coverText = side => (side === 'C' ? 'Sit where the child will sit, the way they will sit.' : `Cover the ${side === 'L' ? 'right' : 'left'} eye (an eye patch or a hand), so only the ${SIDE_NAME[side]} is looking.`);
    /** The card before a pass. -> 'go' | 'both' (use both eyes instead); throws 'cancelled'. */
    async function passCard(u, mode, side, kicker, text) {
      const lc = liveChip([side], true);
      const go = await u.say(kicker, side === 'C' ? 'Look at each dot' : `${cap(SIDE_NAME[side])} only`, [text, coverText(side), lc.chip, 'The examiner can press Space to skip a dot, or Esc to stop.'],
        [['Start', 'go', true, !lc.ready()], ...(mode !== 'both' ? [['Use both eyes instead', 'both']] : []), ['Cancel', 'cancel']]);
      lc.stop(); u.check();
      if (go === 'both' || go === 'go') return go;
      throw new Error('cancelled');
    }

    /**
     * The calibration done inside the tracker, for the chosen eye mode: "select eyes" (left / right / both), the 9 dots collected for that eye
     * (for 'either', each eye's dots with the other eye covered, collected for that eye only), then the tracker fits its own eye model, and the
     * check dots measure it. -> { results, both, blob } | { switched } | null when the tracker will not do it (the caller then falls back).
     */
    async function calibrateInTracker(u, mode) {
      const sm = screenSize(), passes = passesFor(mode);
      try { await D.setEye(MASK[mode]); } catch (e) { if (e.code == null) return null; }       // refused (older firmware): the dots still name the eye
      try { await D.start(); } catch (e) { console.warn('[tet-direct] the tracker would not start a calibration', e); return null; }
      S.devApplied = undefined;
      await D.clear().catch(() => { /* nothing collected yet */ });
      for (let pi = 0; pi < passes.length; pi++) {
        const side = passes[pi];
        const go = await passCard(u, mode, side, passes.length > 1 ? `Calibration · eye ${pi + 1} of ${passes.length}` : 'Eye gaze · calibration',
          passes.length > 1 ? 'Look at each dot until it shrinks and moves on: 9 dots for this eye. The check dots come after both eyes.' : 'Look at each dot until it shrinks and moves on: 9 dots, then 4 check dots that show how close the tracker is.');
        if (go === 'both') { await D.stop().catch(() => {}); return { switched: true }; }
        const got = await trackerDots(u, side, cap(SIDE_NAME[side]), SIDE_MASK[side]);
        if (got.broken) { console.warn('[tet-direct] the tracker stopped answering during calibration', got.broken); await D.stop().catch(() => {}); return null; }
        if (got.n < 5) {
          const a = await u.say('Eye gaze · calibration', 'That did not work', [`Only ${got.n} of ${CAL9.length} dots were recorded.`, 'The tracker needs to see the eye you are calibrating.'], [['Try again', 'again', true], ['Cancel', 'cancel']]);
          if (a !== 'again') throw new Error('cancelled');
          await D.clear().catch(() => {}); pi = -1; continue;                  // start the dots over (the tracker keeps every dot until cleared)
        }
      }
      await u.say('Eye gaze · calibration', 'Working it out…', ['The tracker is fitting its eye model to the dots. This takes a second or two.']);
      let blob = null;
      try { await D.compute(); }
      catch (e) {
        await D.stop().catch(() => {});
        if (e.code == null) return null;
        const a = await u.say('Eye gaze · calibration', 'That did not work', ['The tracker could not make a calibration from those dots. Make sure it can see the eye, then try again.'], [['Try again', 'again', true], ['Cancel', 'cancel']]);
        if (a !== 'again') throw new Error('cancelled');
        return calibrateInTracker(u, mode);
      }
      await D.stop().catch(() => {});
      try { blob = await D.retrieve(); } catch (e) { console.warn('[tet-direct] could not read the calibration back', e); }
      if (!blob || blob.length < 4096) { console.warn('[tet-direct] no usable calibration came back from the tracker'); return null; }
      // the check dots, on the tracker's new calibration. For 'either' the right eye goes first: the left eye is still covered from its dots.
      const results = {}, order = mode === 'either' ? ['R', 'L'] : passes, single = mode === 'left' || mode === 'right';
      for (let ci = 0; ci < order.length; ci++) {
        const side = order[ci], getRaw = m => (m.raw ? m.raw[side] : null), id = p => p, getAlt = single ? (m => (m.filt ? m.filt[side] : null)) : null;
        if (order.length > 1) await passCard(u, 'both', side, `Check · eye ${ci + 1} of ${order.length}`, 'Four check dots for this eye, to see how close the tracker is now.');
        for (;;) {
          const chk = await u.checkDots(getRaw, id, cap(SIDE_NAME[side]), { getAlt, mapAlt: single ? id : null });
          if (chk.length >= 2) { results[side] = fromChecks(chk, single, sm); break; }
          const a = await u.say('Eye gaze · calibration', 'The check dots could not be recorded', ['The tracker needs to see the eye.'], [['Try again', 'again', true], ['Cancel', 'cancel']]);
          if (a !== 'again') throw new Error('cancelled');
        }
      }
      let both = null;
      if (mode === 'either') both = await bothOpenCheck(u, { L: results.L.A, R: results.R.A, perEye: { L: { score: results.L.score }, R: { score: results.R.score } } });
      return { results, both, blob };
    }

    /** 'Either eye': four dots with both eyes open, following whichever eye looks, with the new per-eye calibrations tried out. */
    async function bothOpenCheck(u, trial) {
      await u.say('Calibration · both eyes open', 'Now with both eyes open', ['Uncover the eye. Look at four more dots the way you normally would; the tracker follows whichever eye is looking.', 'Look at each dot until it moves on.'], [['Start', 'go', true]]);
      u.check(); const saved = S.cal.modes.either; S.cal.modes.either = Object.assign({}, saved, trial); setQuality(); fusion.reset();
      try { return await u.checkDots(m => (m.ok ? [m.x, m.y] : null), p => p, 'Both eyes open'); } finally { if (saved) S.cal.modes.either = saved; else delete S.cal.modes.either; setQuality(); }
    }

    /** The old way, when the tracker will not calibrate itself: an affine correction of its output per eye, from the same dots. */
    async function calibrateSoftware(u, mode) {
      const passes = passesFor(mode), results = {};
      if (S.devApplied !== null) { try { await D.restoreDefault(); S.devApplied = null; } catch (e) { console.warn('[tet-direct] could not reset the tracker calibration', e); } }
      for (let pi = 0; pi < passes.length; pi++) {
        const side = passes[pi];
        const go = await passCard(u, mode, side, passes.length > 1 ? `Calibration · eye ${pi + 1} of ${passes.length}` : 'Eye gaze · calibration', 'Look at each dot until it shrinks and moves on: 9 dots, then 4 check dots that show how close the tracker is.');
        if (go === 'both') return { switched: true };
        const r = await calibrateSide(u, side, cap(SIDE_NAME[side]), mode === 'left' || mode === 'right');
        if (r.fail) { const a = await u.say('Eye gaze · calibration', 'That did not work', [r.fail, 'The tracker needs to see the eye you are calibrating.'], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (a === 'again') { pi--; continue; } throw new Error('cancelled'); }
        results[side] = r;
      }
      const both = mode === 'either' ? await bothOpenCheck(u, { L: results.L.A, R: results.R.A, perEye: { L: { score: results.L.score }, R: { score: results.R.score } } }) : null;
      return { results, both, blob: null };
    }

    const scoreBlock = errDeg => { const g = grade(errDeg), s = mk('div', 'td-score' + (g.level === 'good' ? '' : ' warn')); s.append(mk('b', '', String(scoreOf(errDeg))), mk('small', '', '/ 100'), mk('span', '', g.label)); return s; };
    function drawMap(canvas, res) {
      const W = canvas.width, H = canvas.height, g = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
      const col = (n, d) => css.getPropertyValue(n).trim() || d;
      g.clearRect(0, 0, W, H); g.strokeStyle = col('--md-outline', '#3b4942'); g.lineWidth = 1; g.strokeRect(.5, .5, W - 1, H - 1);
      for (const r of res) {
        const c = r.err > 3.5 ? '#f87171' : r.err > 2 ? '#fbbf24' : '#34d399';
        const tx = r.target[0] * W, ty = r.target[1] * H, gx = r.shown[0] * W, gy = r.shown[1] * H;
        g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.moveTo(tx, ty); g.lineTo(gx, gy); g.stroke();
        g.strokeStyle = col('--md-on-surface-muted', '#a2b7aa'); g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, 7, 0, 7); g.stroke();
        g.fillStyle = c; g.beginPath(); g.arc(gx, gy, 4.5, 0, 7); g.fill();
      }
    }
    const mapCanvas = (res, sm) => { const m = mk('canvas', 'td-map'); m.width = 420; m.height = Math.round(420 * sm[1] / sm[0]); drawMap(m, res); return m; };

    /** The whole set-up for the chosen eye mode: the tracker's own calibration when it will do it, otherwise the correction-only way. */
    function calibrate() {
      return runSession(async u => {
        S.devHold = true;
        try {
          for (;;) {
            const mode = S.eyeMode, sm = screenSize();
            let out = D ? await calibrateInTracker(u, mode) : null;
            if (out && out.switched) { setEyeMode('both'); continue; }
            if (!out) { out = await calibrateSoftware(u, mode); if (out.switched) { setEyeMode('both'); continue; } }
            const { results, both, blob } = out, inTracker = !!blob;
            // the result
            const sides = Object.keys(results), body = [];
            const how = inTracker ? (mode === 'both' ? 'The tracker calibrated its own eye model to you.' : mode === 'either' ? 'The tracker calibrated each eye’s own model separately.' : `The tracker calibrated its own eye model to the ${SIDE_NAME[sides[0]]} only.`) : '';
            if (sides.length === 1) {
              const r = results[sides[0]];
              body.push(scoreBlock(r.errDeg), r.kind === 'none' ? `Average distance between the dots and where the tracker saw the gaze: ${r.errBefore.toFixed(1)}°. Under 2° is good for this kind of work.` : `The check dots were ${r.errBefore.toFixed(1)}° off on average. After the correction below, a dot it was not shown should be about ${r.errDeg.toFixed(1)}° off. Under 2° is good for this kind of work.`,
                mapCanvas(r.chk, sm), (how ? how + ' ' : '') + REFINE_NOTE[r.kind] + (r.useF ? ' It uses the tracker’s own filtered gaze for this eye, which the check dots showed to be steadier.' : ''));
            } else {
              const rows = mk('div', 'td-rows');
              sides.forEach(s => { const r = results[s], row = mk('div', 'td-row'); row.append(mk('span', '', cap(SIDE_NAME[s])), mk('b', '', `${scoreOf(r.errDeg)} / 100 · ${r.errDeg.toFixed(1)}° · ${r.grade}`)); rows.appendChild(row); });
              if (both && both.length) { const bm = CalMath.mean(both.map(c => c.err)), row = mk('div', 'td-row'); row.append(mk('span', '', 'Both eyes open'), mk('b', '', `${scoreOf(bm)} / 100 · ${bm.toFixed(1)}° · ${grade(bm).label}`)); rows.appendChild(row); }
              body.push(rows, (how ? how + ' ' : '') + 'With both open the gaze follows whichever eye is looking at the target, and slides smoothly to the other when it takes over.');
            }
            const fin = await u.say('Eye gaze · result', sides.length === 1 ? 'Calibration done' : 'Both eyes calibrated', body, [['Use this', 'use', true], ['Do it again', 'again'], ['Cancel', 'cancel']]);
            if (fin === 'again') { if (inTracker) S.devApplied = undefined; continue; }
            if (fin !== 'use') throw new Error('cancelled');
            const rec = { v: 3, mode, created: new Date().toISOString(), screenMm: sm, fullscreen: u.fullscreen(), points: CAL9.length, dev: inTracker, perEye: {}, pts: {}, srcF: {} }, errs = [];
            sides.forEach(s => { const r = results[s]; rec[s === 'C' ? 'A' : s] = r.A; rec.pts[s] = r.pts; rec.perEye[s] = { errDeg: +r.errDeg.toFixed(2), score: r.score, grade: r.grade }; if (s !== 'C') { rec[s + 'f'] = r.Af || null; rec.srcF[s] = !!r.useF; } errs.push(r.errDeg); });
            const e = CalMath.mean(errs); rec.errDeg = +e.toFixed(2); rec.grade = grade(e).label; rec.score = scoreOf(e);
            if (inTracker) {
              if (await blobs.set(mode, blob)) { S.blobKeys.add(mode); S.devApplied = mode; }      // it is in the tracker already
              else { rec.dev = false; rec.devLost = true; console.warn('[tet-direct] the tracker calibration could not be kept; it lasts until the tracker restarts'); S.devApplied = mode; }
            }
            S.cal.modes[mode] = rec; lsSet(LS_CAL, S.cal); setQuality(); fusion.reset(); pushState(); return rec;
          }
        } finally {
          S.devHold = false;
          if (S.devApplied === undefined) await D.stop().catch(() => { /* not in a calibration */ });
          syncDevice();                                         // after a cancel or a failure: the kept calibration for this mode (or the start-up one) back in
        }
      });
    }

    /** Just the four check dots with the current calibration; refines it with what they show. */
    function recheck() {
      const mode = S.eyeMode;
      if (!covers(mode)) { alert('Calibrate first — there is no calibration for this eye setting yet.'); return Promise.resolve(null); }
      return runSession(async u => {
        const sm = screenSize(), side = mode === 'both' ? 'C' : mode === 'left' ? 'L' : mode === 'right' ? 'R' : 'E';
        if (recFor(mode).dev) await syncDevice();                // the tracker must be holding this mode's calibration
        for (;;) {
          const cal = recFor(mode), lc = liveChip(side === 'E' ? ['L', 'R'] : [side], true);
          const go = await u.say('Eye gaze · accuracy check', 'Four dots', ['Look at each dot until it moves on. Each time you will see how far the tracker’s idea of your gaze was from the dot, and the calibration is refined from what it learns.', lc.chip, 'Press Esc at any time to stop.'], [['Start', 'go', true], ['Cancel', 'cancel']]);
          lc.stop(); u.check(); if (go !== 'go') throw new Error('cancelled');
          let res, A = null, useF = false, key = null;
          if (side === 'E') res = await u.checkDots(m => (m.ok ? [m.x, m.y] : null), p => p, 'Both eyes');
          else {
            useF = side !== 'C' && !!(cal.srcF && cal.srcF[side] && cal[side + 'f']); key = side === 'C' ? 'A' : useF ? side + 'f' : side; A = cal[key];
            res = await u.checkDots(useF ? (m => (m.filt ? m.filt[side] : null)) : (m => (m.raw ? m.raw[side] : null)), raw => mapA(A, raw), cap(SIDE_NAME[side]));
          }
          if (res.length < 2) { const r = await u.say('Eye gaze · accuracy check', 'Not enough dots recorded', ['The tracker needs to see your eyes.'], [['Try again', 'again', true], ['Close', 'cancel']]); if (r === 'again') continue; throw new Error('cancelled'); }
          const errs = res.map(r => r.err), mean = CalMath.mean(errs);
          let note = '', after = mean, next = Object.assign({}, cal);
          if (A && cal.pts && cal.pts[side]) {
            const old = cal.pts[side].slice(-13).map(p => ({ raw: useF ? p.alt : p.raw, target: p.target, dist: p.dist })).filter(p => p.raw);
            const rf = refine(old, res.map(r => ({ raw: r.raw, target: r.target, dist: r.dist })), A, sm);
            const added = res.map(r => ({ raw: useF ? null : r.raw, alt: useF ? r.raw : null, target: r.target, dist: r.dist }));
            next = Object.assign(next, { [key]: rf.A, pts: Object.assign({}, cal.pts, { [side]: [...cal.pts[side], ...added].slice(-17) }) }); note = ' ' + REFINE_NOTE[rf.kind]; if (rf.kind !== 'none' && rf.loo != null) after = Math.min(mean, rf.loo);
          }
          S.check = { when: new Date().toISOString(), n: res.length, meanDeg: +after.toFixed(2), measuredDeg: +mean.toFixed(2), worstDeg: +Math.max(...errs).toFixed(2), grade: grade(after).label, score: scoreOf(after), calibrated: true, mode };
          S.cal.modes[mode] = Object.assign(next, { errDeg: S.check.meanDeg, grade: S.check.grade, score: S.check.score }); lsSet(LS_CAL, S.cal); lsSet(LS_CHECK, S.check); setQuality(); pushState();
          const advice = after < 1 ? 'The tracker follows you very well.' : after < 2 ? 'Good. Nothing more to do.' : after < 3.5 ? 'Usable as a rough guide. Calibrate again if you want it tighter.' : 'This is rough. Check your position, then calibrate again.';
          const r = await u.say('Eye gaze · accuracy check', 'Result', [scoreBlock(after), after < mean - 0.05 ? `The dots were ${mean.toFixed(1)}° off on average (worst ${Math.max(...errs).toFixed(1)}°). After the correction below, about ${after.toFixed(1)}° is expected.` : `Average distance from the dots: ${mean.toFixed(1)}° (worst ${Math.max(...errs).toFixed(1)}°).`, mapCanvas(res, sm), advice + note], [['Done', 'done', true], ['Check again', 'again']]);
          if (r === 'again') continue; return S.check;
        }
      });
    }

    function setEyeMode(m) {
      if (!MODES.includes(m) || m === S.eyeMode) return; S.eyeMode = m; lsSet(LS_EYES, { mode: m }); fusion.reset(); pushState(); syncDevice();
    }

    return {
      source, state, calibrate, recheck, pose,
      accuracyCheck: recheck,
      supported: TetUSB.supported,
      image() { return S.ir ? { px: S.ir, at: S.irAt } : null; },
      /** Subscribe to camera pictures (asks the tracker for them the first time; unsubscribe when nobody is looking). */
      onImage(fn) { S.imgFns.add(fn); tracker.enableImages(); return () => S.imgFns.delete(fn); },
      onChange(fn) { S.changeFns.add(fn); return () => S.changeFns.delete(fn); },
      connect() { return tracker.connect(); },
      autoConnect() { return tracker.autoConnect(); },
      disconnect() { tracker.disconnect(); },
      get running() { return tracker.running; },
      setScreenInches(d) {
        d = +d; S.diagIn = d > 4 && d < 100 ? d : null; lsSet(LS_SCREEN, { diagIn: S.diagIn });
        tracker.setDisplayMm(screenMm()); changed();
      },
      clearCalibration() {
        S.cal = migrate(null); S.check = null; S.blobKeys.clear(); blobs.clear();
        try { [LS_CAL, LS_CAL_V2, LS_CAL_OLD, LS_CHECK].forEach(k => localStorage.removeItem(k)); } catch (_) { /* ignore */ }
        setQuality(); pushState(); syncDevice();              // the tracker goes back to the start-up calibration
      },
      setEyeMode,
      get eyeMode() { return S.eyeMode; },
      /** (x, y) in screen fractions -> 0..1, how much that spot looks like something to look at. Helps 'either eye' decide which eye is on target. */
      setTargetHint(fn) { S.targetFn = fn || null; },
      /** For tests and the set-up menu: what the tracker module has worked out about per-eye data. */
      eyeData() { return { found: !!det.found, id: det.found ? det.found.id : null, seen: det.seen }; },
      _test: { S, det, fusion, migrate, syncDevice },
    };
  }

  root.TetDirect = { create };
})(window);
