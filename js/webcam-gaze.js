/* webcam-gaze.js — eye gaze from the computer's own webcam, no eye tracker needed.
 *
 * How it works (the research behind each choice is in the header of js/webcam-model.js):
 *   1. Camera frames go to a background worker (js/webcam-worker.js) running Google's MediaPipe Face Landmarker (vendor/mediapipe):
 *      478 points on the face, 5 of them on each iris, and the head's pose. Nothing leaves the computer.
 *   2. js/webcam-model.js turns each frame into gaze features (where each iris sits between its eye corners and lids, how the head
 *      is turned and where it is) and maps them to the screen with a model fitted to this person by the calibration.
 *   3. Calibration: 13 dots that move on only once the eyes have settled on them, then 4 check dots that show the miss and refine it.
 *   4. Live, each estimate is smoothed (strongly while the eyes hold still, lightly when they jump) and sent on in the same form as
 *      the IR tracker's (js/tet-direct.js), so the rest of the page does not know the difference.
 *
 *   const wg = WebcamGaze.create();
 *   GazeBridge.create({ source: wg.source, ... }).start();
 *   wg.connect();            // from a click the first time (the browser asks for the camera); wg.autoConnect() afterwards
 *   wg.calibrate(); wg.recheck(); wg.clearCalibration(); wg.setEyeMode('both' | 'left' | 'right'); wg.setScreenInches(13.3)
 *   wg.guide                 // the position guide used by js/gaze-tools.js
 *   wg.drawEyes(canvas)      // the eyes, cut out of the camera picture (for the "eye camera" corner and the recording)
 */
(function (root) {
  'use strict';
  const LS_SCREEN = 'tetDirect.screen.v1', LS_CAL = 'webcamGaze.cal.v1', LS_CHECK = 'webcamGaze.check.v1', LS_EYES = 'webcamGaze.eyes.v1', LS_REF = 'webcamGaze.ref.v1';
  const MODES = ['both', 'left', 'right'];
  // centre and the four corners first, so the first rough model (after 5 dots) already spans the screen; then the edges and an inner ring
  const CAL13 = [[.5, .5], [.1, .1], [.9, .1], [.9, .9], [.1, .9], [.5, .1], [.9, .5], [.5, .9], [.1, .5], [.3, .3], [.7, .3], [.7, .7], [.3, .7]];
  const SETTLE_MS = 450, COLLECT_MS = 1000, MIN_FRAMES = 12, CHECK_N = 4, FEEDBACK_MS = 1300, STALE_MS = 600, FORCE_MS = 3500;
  const DIST_OK = [40, 85];                                       // cm
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } };
  const SIDE_NAME = { both: 'both eyes', left: 'left eye', right: 'right eye' };
  const supported = () => !!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && root.Worker && root.createImageBitmap);

  function create(opts) {
    opts = Object.assign({ base: new URL('vendor/mediapipe/', document.baseURI).href, worker: new URL('js/webcam-worker.js', document.baseURI).href }, opts || {});
    const savedCal = lsGet(LS_CAL);
    const S = { status: 'idle', detail: 'click “Start camera”', running: false, starting: false, stream: null, video: null, worker: null, ready: false, delegate: null, inflight: false, gen: 0,
                diagIn: (lsGet(LS_SCREEN) || {}).diagIn || null, cal: savedCal && savedCal.modes ? savedCal : { v: 1, modes: {} }, check: lsGet(LS_CHECK),
                eyeMode: MODES.includes((lsGet(LS_EYES) || {}).mode) ? lsGet(LS_EYES).mode : 'both', ref: lsGet(LS_REF),
                subs: new Set(), changeFns: new Set(), frameFns: new Set(), fr: null, frAt: 0, ms: 0, fpsN: 0, fpsT: 0, fps: 0,
                collector: null, busy: false, light: null, lightAt: 0, lightC: null, cropC: null, guideOn: false, lastOut: null, drift: null };
    const filt = EyeModel.createPointFilter({ minCutoff: 0.35, beta: 2.5, dCutoff: 1.2 });       // webcam gaze jitters more than an IR tracker's: heavier smoothing at rest
    const screenMm = () => {
      if (!S.diagIn) return null;
      const w = screen.width || 16, h = screen.height || 9, d = S.diagIn * 25.4, hy = Math.hypot(w, h);
      return [Math.round(d * w / hy), Math.round(d * h / hy)];
    };
    const recFor = m => S.cal.modes[m] || null;
    const covers = m => { const r = recFor(m); return !!(r && r.model); };

    /* ---------------------------------------------------------------- state for the page */
    const changed = () => S.changeFns.forEach(f => { try { f(state()); } catch (e) { console.error(e); } });
    function state() {
      const r = recFor(S.eyeMode);
      return { status: S.status, detail: S.detail, calibrated: covers(S.eyeMode), anyCalibration: Object.keys(S.cal.modes).length > 0, cal: r, check: S.check, diagIn: S.diagIn, screenMm: screenMm(),
               last: S.lastOut, busy: S.busy, supported: supported(), eyeMode: S.eyeMode, perEye: true, running: S.running, fps: S.fps, delegate: S.delegate, drift: S.drift, kind: 'webcam' };
    }
    function hello() { return { hello: true, screen_mm: screenMm(), calibrated: covers(S.eyeMode), simulated: false, webcam: true }; }
    function setStatus(st, text) { S.status = st; S.detail = text; S.subs.forEach(s => { if (st === 'live') s.onMsg(hello()); else s.setStatus(st, text); }); changed(); }
    const source = { subscribe(onMsg, setSt) { const s = { onMsg, setStatus: setSt }; S.subs.add(s); if (S.status === 'live') onMsg(hello()); else setSt(S.status, S.detail); return () => S.subs.delete(s); } };

    /* ---------------------------------------------------------------- camera and the worker */
    function startWorker() {
      if (S.worker) return S.workerReadyP;
      S.worker = new Worker(opts.worker, { type: 'module' });
      S.workerReadyP = new Promise((res, rej) => {
        S.worker.onmessage = e => {
          const m = e.data;
          if (m.ready) { S.ready = true; S.delegate = m.delegate; res(); return; }
          if (m.delegate && m.ts === undefined) { S.delegate = m.delegate; console.info('[webcam] the face finder moved to the CPU (the graphics card was slow:', Math.round(m.switched), 'ms a frame)'); return; }
          if (m.error && !S.ready) { rej(new Error(m.error)); return; }
          onResult(m);
        };
        S.worker.onerror = e => { if (!S.ready) rej(new Error(e.message || 'the face finder could not start')); else console.error('[webcam]', e); };
      });
      S.worker.postMessage({ init: { base: opts.base, keep: WebcamModel.KEEP, delegate: opts.delegate } });
      return S.workerReadyP;
    }
    async function connect() {
      if (S.running || S.starting) return;
      if (!supported()) { setStatus('unreachable', 'this browser cannot use a webcam here — use Chrome, Edge, Firefox or Safari, opened from http://localhost or https'); return; }
      S.starting = true; setStatus('connecting', 'starting the camera…');
      try {
        S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } } });
        if (!S.video) { S.video = document.createElement('video'); S.video.muted = true; S.video.playsInline = true; S.video.setAttribute('aria-hidden', 'true'); }
        S.video.srcObject = S.stream; await S.video.play();
        setStatus('connecting', 'loading the face finder (first time can take a few seconds)…');
        await startWorker();
        S.running = true; S.gen++; filt.reset(); pump(S.gen);
        setStatus('connecting', 'looking for a face…');
      } catch (e) {
        stopCamera();
        const n = e && e.name;
        setStatus('unreachable', n === 'NotAllowedError' ? 'the camera was not allowed — allow it in the browser’s address bar, then click Start camera' : n === 'NotFoundError' ? 'no webcam found on this computer'
          : n === 'NotReadableError' ? 'the webcam is in use by another program (close Zoom, Teams, the Camera app…), then click Start camera' : 'the camera could not start (' + ((e && e.message) || e) + ')');
      } finally { S.starting = false; changed(); }
    }
    async function autoConnect() {
      if (S.running || S.starting || !supported()) return false;
      try { const p = await navigator.permissions.query({ name: 'camera' }); if (p.state !== 'granted') return false; } catch (_) { return false; }
      await connect(); return S.running;
    }
    function stopCamera() {
      S.running = false; S.gen++; S.inflight = false;
      if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
      if (S.video) S.video.srcObject = null;
      S.fr = null; S.lastOut = null;
    }
    function disconnect() { stopCamera(); setStatus('idle', 'camera off'); }

    /** Sends the newest camera frame to the worker whenever it is free: no queue, so the answer is always about now. */
    function pump(gen) {
      if (gen !== S.gen || !S.running) return;
      const v = S.video, next = () => { if (gen !== S.gen) return; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => pump(gen)); else setTimeout(() => pump(gen), 15); };
      if (S.inflight || v.readyState < 2 || !v.videoWidth) { next(); return; }
      S.inflight = true;
      createImageBitmap(v).then(bmp => {
        if (gen !== S.gen) { bmp.close(); S.inflight = false; return; }
        S.worker.postMessage({ frame: bmp, ts: performance.now() }, [bmp]);
      }).catch(() => { S.inflight = false; });
      next();
    }

    /* ---------------------------------------------------------------- every frame */
    function onResult(m) {
      S.inflight = false; const now = performance.now();
      S.ms = S.ms ? S.ms * 0.9 + (m.ms || 0) * 0.1 : (m.ms || 0);
      S.fpsN++; if (now - S.fpsT > 1000) { S.fps = Math.round(S.fpsN * 1000 / (now - S.fpsT)); S.fpsN = 0; S.fpsT = now; }
      const fr = m.face ? WebcamModel.frame(m.face, m.W, m.H) : null;
      if (fr) { fr.t = now; S.fr = fr; S.frAt = now; }
      if (S.status !== 'live' && fr && S.running) setStatus('live', 'webcam gaze');
      if (S.status === 'live' && !fr && now - S.frAt > 2500) { S.detail = 'no face found — face the screen, lit from the front'; S.subs.forEach(s => s.setStatus('connecting', S.detail)); S.status = 'connecting'; changed(); }
      if (S.collector) S.collector(fr, now);
      S.frameFns.forEach(f => { try { f(fr); } catch (e) { console.error(e); } });
      const rec = recFor(S.eyeMode); let out = null, raw = null;
      if (fr && rec && rec.model && !fr.blink[S.eyeMode]) {
        raw = WebcamModel.predict(rec.model, WebcamModel.vector(fr, S.eyeMode));
        out = filt.step(now, raw);          // null (no eye pictures this frame) lets the filter coast
      } else filt.step(now, null);
      S.drift = rec && rec.ref && fr ? WebcamModel.drift(rec.ref, fr) : S.drift;
      const far = !!(S.drift && S.drift.far);
      if (far !== !!S.driftFar && now - (S.driftAt || 0) > 1500) { S.driftFar = far; S.driftAt = now; changed(); }   // "the head has moved since calibrating" in the panel
      const ok = !!out && Number.isFinite(out[0]) && Number.isFinite(out[1]);
      const msg = { ts: Date.now(), ok, x: ok ? out[0] : null, y: ok ? out[1] : null, rx: raw ? raw[0] : null, ry: raw ? raw[1] : null, l: !!fr, r: !!fr, dist: fr ? fr.distMm : null,
                    cal: covers(S.eyeMode), eye: S.eyeMode === 'left' ? 'L' : S.eyeMode === 'right' ? 'R' : 'both', mode: S.eyeMode, blink: fr ? fr.blink.both : null, drift: S.drift };
      S.lastOut = msg;
      if (S.status === 'live') S.subs.forEach(s => s.onMsg(msg));
      if (S.guideOn && now - S.lightAt > 500) measureLight(now);
    }

    /** How bright the face is, and the scene around it (a dark face, or a bright window behind, spoils the landmarks). */
    function measureLight(now) {
      const v = S.video, fr = S.fr; S.lightAt = now; if (!v || !fr || !v.videoWidth) return;
      const c = S.lightC || (S.lightC = document.createElement('canvas')); c.width = 64; c.height = 36;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data, b = fr.box;
      let fs = 0, fn = 0, bs = 0, bn = 0;
      for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2], u = (x + .5) / 64, w = (y + .5) / 36;
        if (u > b[0] && u < b[2] && w > b[1] && w < b[3]) { fs += l; fn++; } else { bs += l; bn++; }
      }
      S.light = { face: fn ? fs / fn : null, back: bn ? bs / bn : null };
    }

    /* ---------------------------------------------------------------- position guide (the set-up menu, and Ctrl over the page) */
    const DEFAULT_EYES = [[118, 112], [162, 112]];                 // eyes in the 280 x 280 centre crop of the camera picture, when nothing is marked
    const cropOf = fr => { const v = S.video, W = (v && v.videoWidth) || (fr && fr.W) || 1280, H = (v && v.videoHeight) || (fr && fr.H) || 720, s = Math.min(W, H); return { x: (W - s) / 2, y: (H - s) / 2, s, W, H }; };
    const eyesInCrop = fr => { const c = cropOf(fr), k = 280 / c.s, P = p => [(p[0] * c.W - c.x) * k, (p[1] * c.H - c.y) * k]; return [P(fr.eyeR), P(fr.eyeL)]; };
    function evaluate() {
      const now = performance.now(), fresh = S.running && now - S.frAt < STALE_MS, fr = fresh ? S.fr : null;
      if (!S.running) return { level: 'bad', title: 'Camera off', detail: 'Click Start camera in the Eye Tracking settings.', fresh: false };
      if (!fr) return { level: 'bad', title: 'No face found', detail: 'Face the screen with the whole face in view, lit from the front.', fresh: S.running };
      const parts = [], cm = fr.distMm / 10;
      if (cm < DIST_OK[0]) parts.push(`move back (about ${Math.round(cm)} cm is too close)`); else if (cm > DIST_OK[1]) parts.push(`move closer (about ${Math.round(cm)} cm is too far)`);
      const t = S.ref && S.ref.eyes ? S.ref.eyes : DEFAULT_EYES, e = eyesInCrop(fr), mx = (e[0][0] + e[1][0]) / 2, my = (e[0][1] + e[1][1]) / 2, tx = (t[0][0] + t[1][0]) / 2, ty = (t[0][1] + t[1][1]) / 2, tol = 28;
      const dxm = tx - mx;                                         // the picture is shown mirrored: a mirror moves the way you do
      if (Math.abs(dxm) > tol) parts.push(dxm < 0 ? 'move a little to the right' : 'move a little to the left');
      if (Math.abs(my - ty) > tol) parts.push(my < ty ? 'sit a little lower' : 'sit a little higher');
      if (Math.abs(fr.head.yaw) > 0.35 || Math.abs(fr.head.pitch) > 0.35) parts.push('face the screen straight on');
      const L = S.light;
      if (L && L.face != null && L.face < 55) parts.push('more light on the face');
      else if (L && L.face != null && L.back != null && L.back - L.face > 55) parts.push('a bright light or window is behind; light the face from the front');
      const rec = recFor(S.eyeMode);
      if (!parts.length && rec && S.drift && S.drift.far) return { level: 'warn', title: 'Moved since calibrating', detail: 'Sit where you sat when calibrating, or calibrate again.', fresh: true };
      if (!parts.length) return { level: 'good', title: 'Lined up', detail: `The face is well placed, about ${Math.round(cm)} cm away. Hold still.`, fresh: true };
      return { level: parts.length > 1 ? 'bad' : 'warn', title: 'Nearly there', detail: parts.join('; ').replace(/^./, c => c.toUpperCase()) + '.', fresh: true };
    }
    const toneOf = lvl => (lvl === 'good' ? '#34d399' : lvl === 'warn' ? '#fbbf24' : '#ffffff');
    const guide = {
      watch(on) { S.guideOn = on; },
      evaluate,
      draw(canvas, ev) {
        const v = S.video, live = S.running && v && v.videoWidth ? (S.cropC || (S.cropC = document.createElement('canvas'))) : null;
        if (live) { const c = cropOf(S.fr); live.width = live.height = 280; live.getContext('2d').drawImage(v, c.x, c.y, c.s, c.s, 0, 0, 280, 280); }
        // the outline's proportions were drawn for the IR tracker camera's narrower picture: spread the eyes it is given so the head fits a webcam face
        const e = S.ref && S.ref.eyes ? S.ref.eyes : DEFAULT_EYES, mx = (e[0][0] + e[1][0]) / 2, my = (e[0][1] + e[1][1]) / 2, k = 1.45;
        GazeTools.drawGuide(canvas, { live, eyes: e.map(p => [mx + (p[0] - mx) * k, my + (p[1] - my) * k]), tone: toneOf((ev || evaluate()).level) });
      },
      mark() {
        const fr = S.running && performance.now() - S.frAt < STALE_MS ? S.fr : null;
        if (!fr) return 'No face found yet.';
        S.ref = { eyes: eyesInCrop(fr), at: new Date().toISOString() }; lsSet(LS_REF, S.ref); return 'The outline is now where the head is.';
      },
      reset() { S.ref = null; try { localStorage.removeItem(LS_REF); } catch (_) { /* ignore */ } },
      marked: () => !!S.ref,
    };

    /** The eyes, cut out of the camera picture and mirrored (like a mirror), into a square canvas: for the "eye camera" corner. */
    function drawEyes(canvas) {
      const v = S.video, fr = S.running && performance.now() - S.frAt < STALE_MS ? S.fr : null; if (!v || !fr || !v.videoWidth) return false;
      const W = v.videoWidth, H = v.videoHeight, cx = (fr.eyeR[0] + fr.eyeL[0]) / 2 * W, cy = (fr.eyeR[1] + fr.eyeL[1]) / 2 * H, iod = Math.hypot((fr.eyeL[0] - fr.eyeR[0]) * W, (fr.eyeL[1] - fr.eyeR[1]) * H);
      const s = iod * 2.4, g = canvas.getContext('2d'); canvas.width = canvas.height = 280;
      g.save(); g.translate(280, 0); g.scale(-1, 1); g.drawImage(v, cx - s / 2, cy - s / 2, s, s, 0, 0, 280, 280); g.restore(); return true;
    }

    /* ---------------------------------------------------------------- full-screen sessions (calibration and the accuracy check) */
    const fullNow = () => document.fullscreenElement || (innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2);
    const fracToClient = (fx, fy) => {
      if (fullNow()) return [fx * innerWidth, fy * innerHeight];
      const side = (outerWidth - innerWidth) / 2, left = screenX + side, top = screenY + (outerHeight - innerHeight) - side;
      return [fx * screen.width - left, fy * screen.height - top];
    };
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const CSS = `
.wg-ov{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;background:#0b100f;color:var(--md-on-surface,#edf3ee);font-family:Inter,"Segoe UI",system-ui,sans-serif;cursor:none}
.wg-ov.wg-ask{cursor:default}
.wg-card{width:min(460px,calc(100vw - 32px));box-sizing:border-box;padding:26px 26px 22px;border-radius:20px;background:var(--md-surface,#1d2524);border:1px solid var(--md-outline,#3b4942);box-shadow:0 24px 64px rgb(0 0 0 / 45%)}
.wg-kicker{margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--md-primary,#8ed7bf)}
.wg-card h2{margin:0 0 8px;font-size:22px;font-weight:700;letter-spacing:-.02em;color:var(--md-on-surface,#edf3ee)}
.wg-card p{margin:6px 0;font-size:13.5px;line-height:1.5;color:var(--md-on-surface-muted,#a2b7aa)}
.wg-chip{display:flex;align-items:center;gap:9px;margin:14px 0 4px;padding:10px 12px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942);font-size:13px;font-weight:600;color:var(--md-on-surface,#edf3ee)}
.wg-chip i{flex:none;width:9px;height:9px;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 3px rgb(251 191 36 / 22%)}
.wg-chip.ok i{background:#34d399;box-shadow:0 0 0 3px rgb(52 211 153 / 22%)}
.wg-score{display:flex;align-items:baseline;gap:10px;margin:12px 0 4px}
.wg-score b{font-size:40px;font-weight:750;letter-spacing:-.03em;color:var(--md-on-surface,#edf3ee)}
.wg-score small{font-size:14px;color:var(--md-on-surface-muted,#a2b7aa)}
.wg-score span{font-size:14px;font-weight:650;padding:3px 10px;border-radius:999px;background:var(--md-primary-container,#25443b);color:var(--md-on-primary-container,var(--md-on-surface,#edf3ee))}
.wg-score.warn span{background:rgb(251 191 36 / 18%);color:#fbbf24}
.wg-map{display:block;width:100%;height:auto;margin:12px 0 4px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942)}
.wg-btns{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}
.wg-btn{flex:1;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid var(--md-outline,#3b4942);background:var(--md-surface-variant,#252f2c);color:var(--md-on-surface,#edf3ee);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.wg-btn:hover{border-color:var(--md-primary,#8ed7bf)}
.wg-btn:disabled{opacity:.45;cursor:default}
.wg-btn.primary{border-color:transparent;background:var(--md-primary,#8ed7bf);color:var(--md-on-primary,#0b2a22)}
.wg-btn:focus-visible{outline:2px solid var(--md-primary,#8ed7bf);outline-offset:2px}
.wg-dot{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;display:none;transition:left .7s cubic-bezier(.25,.8,.25,1),top .7s cubic-bezier(.25,.8,.25,1)}
.wg-dot::before{content:"";position:absolute;inset:0;border-radius:50%;background:rgb(45 212 191 / 28%);box-shadow:0 0 0 2px rgb(45 212 191 / 70%)}
.wg-dot::after{content:"";position:absolute;inset:16px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px #0b100f}
.wg-dot.wg-wait::before{animation:wg-pulse 1.1s ease-in-out infinite}
.wg-dot.wg-collect::before{transform:scale(.36);transition:transform ${COLLECT_MS}ms linear;background:rgb(45 212 191 / 55%)}
.wg-dot.wg-grow::before{transform:scale(1);transition:transform .25s ease-out}
.wg-dot.wg-done::before{animation:wg-pop .35s ease-out forwards;background:rgb(52 211 153 / 55%)}
@keyframes wg-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.55}}
@keyframes wg-pop{0%{transform:scale(.4);opacity:1}100%{transform:scale(2.2);opacity:0}}
.wg-fb{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
.wg-lab{position:fixed;padding:3px 9px;border-radius:999px;background:rgb(0 0 0 / 70%);color:#fff;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;transform:translate(-50%,0)}
.wg-progress{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);font-size:13px;font-weight:600;letter-spacing:.02em;color:rgb(255 255 255 / 55%);white-space:nowrap;text-align:center}
.wg-progress:empty{display:none}
@media (prefers-reduced-motion: reduce){.wg-dot,.wg-dot.wg-wait::before{animation:none;transition:none}}`;
    const ensureCss = () => { if (document.getElementById('wg-style')) return; const st = document.createElement('style'); st.id = 'wg-style'; st.textContent = CSS; document.head.appendChild(st); };
    const toDeg = (dx, dy, sm, distMm) => CalMath.angDeg(dx * sm[0], dy * sm[1], distMm || 600);
    const screenSize = () => screenMm() || [293, 165];
    // webcam-sized grades (an eye tracker manages ~1°; the best webcam trackers ~1.5–3°); the 0–100 score stays on the IR tracker's scale so the two compare
    const grade = deg => (!Number.isFinite(deg) ? { label: 'n/a', level: 'bad' } : deg < 1.5 ? { label: 'Excellent', level: 'good' } : deg < 3 ? { label: 'Good', level: 'good' } : deg < 4.5 ? { label: 'Fair', level: 'warn' } : { label: 'Rough', level: 'warn' });
    const scoreOf = deg => Math.max(0, Math.min(100, Math.round(100 - 14 * deg)));     // the same scale as the IR tracker's: 1° = 86, 2° = 72

    /** Runs fn(ui) on a full-screen overlay. Always cleans up. Resolves to fn's result, or null when cancelled. */
    async function runSession(fn) {
      if (S.busy) return null;
      if (!S.running) { alert('Start the camera first.'); return null; }
      S.busy = true; changed();
      const wasFull = !!document.fullscreenElement; ensureCss();
      const ov = mk('div', 'wg-ov'), box = mk('div', 'wg-card'), dot = mk('div', 'wg-dot'), progress = mk('div', 'wg-progress'), fb = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); fb.setAttribute('class', 'wg-fb');
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Webcam eye tracking');
      ov.append(box, fb, dot, progress); document.body.appendChild(ov);
      let cancelled = false, wake = null, skip = false, prevPx = null;
      const onKey = e => {
        if (e.key === 'Escape') { cancelled = true; e.preventDefault(); e.stopPropagation(); if (wake) wake(); }
        else if (e.key === ' ' && dot.style.display === 'block') { skip = true; e.preventDefault(); e.stopPropagation(); }
      };
      addEventListener('keydown', onKey, true);
      const check = () => { if (cancelled || !S.running) throw new Error('cancelled'); };
      const clearFb = () => { fb.textContent = ''; ov.querySelectorAll('.wg-lab').forEach(e => e.remove()); };
      const say = (kicker, title, body, buttons) => new Promise(res => {
        box.textContent = ''; box.style.display = ''; clearFb(); ov.classList.toggle('wg-ask', !!buttons); dot.style.display = 'none'; progress.textContent = '';
        if (kicker) box.appendChild(mk('div', 'wg-kicker', kicker));
        box.appendChild(mk('h2', '', title));
        (body || []).forEach(b => box.appendChild(typeof b === 'string' ? mk('p', '', b) : b));
        if (!buttons) { res(null); return; }
        const row = mk('div', 'wg-btns'); buttons.forEach(([label, val, primary, disabled]) => { const b = mk('button', 'wg-btn' + (primary ? ' primary' : ''), label); b.type = 'button'; b.disabled = !!disabled; b.onclick = () => res(val); row.appendChild(b); });
        box.appendChild(row); wake = () => res('cancel'); const first = row.querySelector('.primary:not(:disabled)'); if (first) first.focus();
      });
      const moveDot = (px, py) => {
        box.style.display = 'none'; ov.classList.remove('wg-ask');
        if (dot.style.display !== 'block') { Object.assign(dot.style, { display: 'block', transition: 'none', left: (prevPx ? prevPx[0] : innerWidth / 2) + 'px', top: (prevPx ? prevPx[1] : innerHeight / 2) + 'px' }); void dot.offsetWidth; dot.style.transition = ''; }
        dot.style.left = px + 'px'; dot.style.top = py + 'px'; prevPx = [px, py];
      };
      const setDot = cls => { dot.classList.remove('wg-wait', 'wg-collect', 'wg-grow', 'wg-done'); void dot.offsetWidth; if (cls) dot.classList.add(cls); };

      /**
       * One dot. Before there is any calibration the eyes' own features show when the gaze has landed: they move during the jump to the dot,
       * then hold still (WebcamModel.createSettle). Once a first model exists (o.model) the dot also waits until that model puts the gaze near it.
       * Then ~1 s of frames is collected while the eyes stay still (blinks are dropped). -> { target, frames: [features], n, distMm, shown } or null (skipped).
       */
      const grabDot = async (frac, label, o) => {
        o = Object.assign({ radius: 0.3, mode: S.eyeMode }, o || {});
        const [px, py] = fracToClient(frac[0], frac[1]), target = [frac[0], frac[1]];
        check(); moveDot(px, py); setDot('wg-wait'); progress.textContent = label; skip = false;
        const settle = WebcamModel.createSettle(), arrive = performance.now() + 650;          // the dot's slide takes ~0.7 s
        let phase = 'wait', forced = false, frames = [], preds = [], dists = [], t0 = performance.now(), startedAt = 0, misses = 0;
        let lastFrame = t0;
        S.collector = (fr, now) => {
          if (fr) lastFrame = now;
          if (!fr || fr.blink[o.mode]) { if (phase === 'collect' && ++misses > 8) { phase = 'wait'; settle.reset(); setDot('wg-grow'); setTimeout(() => { if (phase === 'wait') setDot('wg-wait'); }, 260); } return; }
          const v = WebcamModel.vector(fr, o.mode), st = settle.feed(now, fr, o.mode);
          if (phase === 'wait') {
            // never get stuck: if the eyes look unsteady for 3.5 s after the dot arrived (a noisy camera or dim light), take the dot anyway
            forced = now > arrive + FORCE_MS;
            if (now < arrive + SETTLE_MS || (!st.steady && !forced)) return;          // the eyes need ~0.2 s to jump to the dot and a moment to settle
            // a first model must agree the gaze is near the dot; but a rough model can be wrong, so eyes held still for ~3 s after the dot arrived are trusted anyway
            if (o.model && !forced && now < arrive + (o.trustAfter || 3500)) { const p = WebcamModel.predict(o.model, v); if (!p || Math.hypot(p[0] - target[0], p[1] - target[1]) > o.radius) return; }
            phase = 'collect'; startedAt = now; frames = []; preds = []; dists = []; misses = 0; setDot('wg-collect');
          } else if (phase === 'collect') {
            if (st.jump && !forced) { phase = 'wait'; settle.reset(); setDot('wg-grow'); setTimeout(() => { if (phase === 'wait') setDot('wg-wait'); }, 260); return; }
            misses = 0; frames.push(v); dists.push(fr.distMm); if (o.model) { const p = WebcamModel.predict(o.model, v); if (p) preds.push(p); }
          }
        };
        try {
          for (;;) {
            await sleep(30); check();
            if (skip) return null;
            const now = performance.now();
            if (phase === 'wait' && now - t0 > 7000) progress.textContent = label + (now - lastFrame > 1500 ? ' · the camera cannot see the face: face the screen, with light on the face' : ' · look at the dot  (the examiner can press Space to skip it)');
            if (phase === 'collect' && now - startedAt >= COLLECT_MS && frames.length >= MIN_FRAMES) break;
          }
        } finally { S.collector = null; }
        setDot('wg-done'); progress.textContent = label;
        const shown = preds.length ? CalMath.summarize(preds) : null;
        return { target, frames, n: frames.length, distMm: CalMath.median(dists), shown: shown ? [shown.x, shown.y] : null };
      };

      /** The deviation, drawn where it happened: the dot, where the gaze landed, a line between them and the size of the miss. */
      const showDeviation = async (r, deg) => {
        const [tx, ty] = fracToClient(r.target[0], r.target[1]), [gx, gy] = fracToClient(r.shown[0], r.shown[1]);
        const col = deg > 4 ? '#f87171' : deg > 2.5 ? '#fbbf24' : '#34d399', NS = 'http://www.w3.org/2000/svg';
        const line = document.createElementNS(NS, 'line'); line.setAttribute('x1', tx); line.setAttribute('y1', ty); line.setAttribute('x2', gx); line.setAttribute('y2', gy); line.setAttribute('stroke', col); line.setAttribute('stroke-width', 3); line.setAttribute('stroke-linecap', 'round');
        const gc = document.createElementNS(NS, 'circle'); gc.setAttribute('cx', gx); gc.setAttribute('cy', gy); gc.setAttribute('r', 8); gc.setAttribute('fill', col); gc.setAttribute('stroke', '#0b100f'); gc.setAttribute('stroke-width', 2);
        fb.append(line, gc);
        const lab = mk('div', 'wg-lab', deg.toFixed(1) + '° off'); lab.style.left = (tx + gx) / 2 + 'px'; lab.style.top = Math.max(8, Math.min(innerHeight - 36, Math.max(ty, gy) + 16)) + 'px'; ov.appendChild(lab);
        await sleep(FEEDBACK_MS); check(); clearFb();
      };

      /** Four random dots measured with model m. -> [{ target, frames, shown, err, distMm }] */
      const checkDots = async (m, label, mode) => {
        const aspect = innerWidth / innerHeight, targets = [];
        for (let tries = 0; targets.length < CHECK_N && tries < 400; tries++) {
          const p = [.12 + Math.random() * .76, .14 + Math.random() * .72];
          if (targets.every(q => Math.hypot((p[0] - q[0]) * aspect, p[1] - q[1]) > 0.3 - tries * 0.0005)) targets.push(p);
        }
        const sm = screenSize(), res = [];
        for (let i = 0; i < targets.length; i++) {
          const r = await grabDot(targets[i], `${label} · check dot ${i + 1} of ${targets.length}`, { model: m, radius: 0.35, mode });
          if (!r || !r.shown) continue;
          r.err = toDeg(r.shown[0] - r.target[0], r.shown[1] - r.target[1], sm, r.distMm);
          res.push(r); await showDeviation(r, r.err);
        }
        return res;
      };
      try {
        if (!wasFull) { try { await document.documentElement.requestFullscreen(); await sleep(500); } catch (_) { /* not allowed: carry on, a little less exact */ } }
        return await fn({ say, grabDot, checkDots, check, mk, fullscreen: () => !!document.fullscreenElement, setDot, clearFb });
      } catch (e) {
        if (e.message !== 'cancelled') console.error('[webcam]', e);
        return null;
      } finally {
        S.collector = null; removeEventListener('keydown', onKey, true); ov.remove(); S.busy = false;
        if (!wasFull && document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
        changed();
      }
    }

    /* ---------------------------------------------------------------- calibrate and check */
    /** Live "is the face ready" line on a card; also enables / disables the card's primary button. */
    const liveChip = gate => {
      const chip = mk('div', 'wg-chip'), d = mk('i'), t = mk('span'); chip.append(d, t);
      const ready = () => { const ev = evaluate(); return ev.level !== 'bad' && ev.title !== 'No face found'; };
      const upd = () => {
        const ev = evaluate(), ok = ev.level === 'good';
        t.textContent = ev.title === 'Lined up' ? ev.detail.replace(' Hold still.', '') : `${ev.title}: ${ev.detail}`;
        chip.classList.toggle('ok', ok);
        if (gate) { const b = chip.parentElement && chip.parentElement.querySelector('.wg-btn.primary'); if (b) b.disabled = !ready(); }
      };
      const was = S.guideOn; S.guideOn = true; const iv = setInterval(upd, 200); upd(); return { chip, stop: () => { clearInterval(iv); S.guideOn = was; }, ready };
    };
    const scoreBlock = errDeg => { const g = grade(errDeg), s = mk('div', 'wg-score' + (g.level === 'good' ? '' : ' warn')); s.append(mk('b', '', String(scoreOf(errDeg))), mk('small', '', '/ 100'), mk('span', '', g.label)); return s; };
    function mapCanvas(res, sm) {
      const m = mk('canvas', 'wg-map'); m.width = 420; m.height = Math.round(420 * sm[1] / sm[0]);
      const W = m.width, H = m.height, g = m.getContext('2d'), css = getComputedStyle(document.documentElement), col = (n, d) => css.getPropertyValue(n).trim() || d;
      g.strokeStyle = col('--md-outline', '#3b4942'); g.lineWidth = 1; g.strokeRect(.5, .5, W - 1, H - 1);
      for (const r of res) {
        const c = r.err > 4 ? '#f87171' : r.err > 2.5 ? '#fbbf24' : '#34d399', tx = r.target[0] * W, ty = r.target[1] * H, gx = r.shown[0] * W, gy = r.shown[1] * H;
        g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.moveTo(tx, ty); g.lineTo(gx, gy); g.stroke();
        g.strokeStyle = col('--md-on-surface-muted', '#a2b7aa'); g.beginPath(); g.arc(tx, ty, 7, 0, 7); g.stroke();
        g.fillStyle = c; g.beginPath(); g.arc(gx, gy, 4.5, 0, 7); g.fill();
      }
      return m;
    }
    const cap = t => t[0].toUpperCase() + t.slice(1);
    const coverText = mode => (mode === 'both' ? 'Sit where the child will sit, the way they will sit, with the face lit from the front.' : `Cover the ${mode === 'left' ? 'right' : 'left'} eye (an eye patch or a hand), so only the ${SIDE_NAME[mode]} is looking.`);

    /**
     * The whole calibration for the current eye mode: 13 dots, a model fitted to them (WebcamModel.fit picks the model by how well it
     * predicts a dot it was not given), 4 check dots that show the miss, then the check dots refine it (WebcamModel.refine), and a score.
     */
    function calibrate() {
      return runSession(async u => {
        for (;;) {
          const mode = S.eyeMode, sm = screenSize(), lc = liveChip(true);
          const go = await u.say('Webcam eye tracking · calibration', mode === 'both' ? 'Look at each dot' : `${cap(SIDE_NAME[mode])} only`,
            ['Look at each dot until it shrinks and moves on: 13 dots, then 4 check dots that show how close the tracking is. Keep the head still and look with the eyes.', coverText(mode), lc.chip, 'The examiner can press Space to skip a dot, or Esc to stop.'],
            [['Start', 'go', true, !lc.ready()], ['Cancel', 'cancel']]);
          lc.stop(); u.check(); if (go !== 'go') throw new Error('cancelled');
          const pts = []; let model = null;
          for (let i = 0; i < CAL13.length; i++) {
            const r = await u.grabDot(CAL13[i], `${cap(SIDE_NAME[mode])} · dot ${i + 1} of ${CAL13.length}`, { model, radius: 0.4, mode });     // a first model is rough: only 'looked roughly that way'
            if (r) pts.push(r);
            if (pts.length >= 5 && (!model || pts.length % 3 === 0)) model = WebcamModel.fit(pts, { quick: true, mode }) || model;     // a first model, to confirm the next dots were looked at
          }
          if (pts.length < 8) { const a = await u.say('Webcam eye tracking', 'That did not work', [`Only ${pts.length} of ${CAL13.length} dots were recorded.`, 'The camera needs to see the face clearly: light it from the front and face the screen.'], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (a === 'again') continue; throw new Error('cancelled'); }
          await u.say('Webcam eye tracking', 'Working it out…', ['Fitting the gaze model to the dots.']); await sleep(30);
          model = WebcamModel.fit(pts, { mode });
          if (!model) { const a = await u.say('Webcam eye tracking', 'That did not work', ['The dots did not give a usable result. Light the face from the front, face the screen, and try again.'], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (a === 'again') continue; throw new Error('cancelled'); }
          const chk = await u.checkDots(model, cap(SIDE_NAME[mode]), mode);
          if (chk.length < 2) { const a = await u.say('Webcam eye tracking', 'The check dots could not be recorded', ['The camera needs to see the face.'], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (a === 'again') continue; throw new Error('cancelled'); }
          const before = CalMath.mean(chk.map(c => c.err)), rf = WebcamModel.refine(model, pts, chk, sm), after = rf.loo != null ? Math.min(before, rf.loo) : before;
          const body = [scoreBlock(after),
            rf.kind === 'none' ? `Average distance between the dots and where the gaze was seen: ${before.toFixed(1)}°. With a webcam, under 3° is good.` : `The check dots were ${before.toFixed(1)}° off on average. After the correction below, a dot it was not shown should be about ${after.toFixed(1)}° off. With a webcam, under 3° is good.`,
            mapCanvas(chk, sm), { none: 'The check dots showed nothing to correct.', shift: 'The calibration was nudged using the check dots.', refit: 'The calibration was refined using the check dots.' }[rf.kind]];
          const fin = await u.say('Webcam eye tracking · result', 'Calibration done', body, [['Use this', 'use', true], ['Do it again', 'again'], ['Cancel', 'cancel']]);
          if (fin === 'again') continue; if (fin !== 'use') throw new Error('cancelled');
          const fr = S.fr, rec = { v: 1, mode, created: new Date().toISOString(), screenMm: sm, fullscreen: u.fullscreen(), points: pts.length, model: rf.model, kind: rf.kind,
            pts: WebcamModel.keepSamples([...pts, ...chk]), ref: fr ? WebcamModel.refOf(fr) : null, errDeg: +after.toFixed(2), score: scoreOf(after), grade: grade(after).label };
          S.cal.modes[mode] = rec; lsSet(LS_CAL, S.cal); filt.reset(); changed(); S.subs.forEach(s => { if (S.status === 'live') s.onMsg(hello()); });
          return rec;
        }
      });
    }

    /** Just the four check dots; refines the calibration with what they show. */
    function recheck() {
      const mode = S.eyeMode;
      if (!covers(mode)) { alert('Calibrate first — there is no webcam calibration for this eye setting yet.'); return Promise.resolve(null); }
      return runSession(async u => {
        const sm = screenSize();
        for (;;) {
          const rec = recFor(mode), lc = liveChip(true);
          const go = await u.say('Webcam eye tracking · accuracy check', 'Four dots', ['Look at each dot until it moves on. Each time you will see how far the gaze was from the dot, and the calibration is refined from what it learns.', lc.chip, 'Press Esc at any time to stop.'], [['Start', 'go', true], ['Cancel', 'cancel']]);
          lc.stop(); u.check(); if (go !== 'go') throw new Error('cancelled');
          const res = await u.checkDots(rec.model, cap(SIDE_NAME[mode]), mode);
          if (res.length < 2) { const r = await u.say('Webcam eye tracking · accuracy check', 'Not enough dots recorded', ['The camera needs to see the face.'], [['Try again', 'again', true], ['Close', 'cancel']]); if (r === 'again') continue; throw new Error('cancelled'); }
          const errs = res.map(r => r.err), mean = CalMath.mean(errs), rf = WebcamModel.refine(rec.model, WebcamModel.restoreSamples(rec.pts), res, sm), after = rf.kind !== 'none' && rf.loo != null ? Math.min(mean, rf.loo) : mean;
          const fr = S.fr;
          S.cal.modes[mode] = Object.assign({}, rec, { model: rf.model, pts: WebcamModel.keepSamples([...WebcamModel.restoreSamples(rec.pts), ...res]), ref: fr ? WebcamModel.refOf(fr) : rec.ref, errDeg: +after.toFixed(2), score: scoreOf(after), grade: grade(after).label });
          S.check = { when: new Date().toISOString(), n: res.length, meanDeg: +after.toFixed(2), measuredDeg: +mean.toFixed(2), worstDeg: +Math.max(...errs).toFixed(2), grade: grade(after).label, score: scoreOf(after), mode };
          lsSet(LS_CAL, S.cal); lsSet(LS_CHECK, S.check); filt.reset(); changed();
          const advice = after < 2 ? 'Very good for a webcam.' : after < 3 ? 'Good for a webcam. Use large targets.' : after < 4.5 ? 'Usable with large, well-spaced targets. Calibrate again if you want it tighter.' : 'This is rough. Check the light and the position, then calibrate again.';
          const r = await u.say('Webcam eye tracking · accuracy check', 'Result', [scoreBlock(after), after < mean - 0.05 ? `The dots were ${mean.toFixed(1)}° off on average (worst ${Math.max(...errs).toFixed(1)}°). After the correction below, about ${after.toFixed(1)}° is expected.` : `Average distance from the dots: ${mean.toFixed(1)}° (worst ${Math.max(...errs).toFixed(1)}°).`, mapCanvas(res, sm), advice], [['Done', 'done', true], ['Check again', 'again']]);
          if (r === 'again') continue; return S.check;
        }
      });
    }

    return {
      source, state, calibrate, recheck, guide, drawEyes,
      accuracyCheck: recheck,
      supported,
      eyeModes: MODES,
      calNote: mode => (mode === 'both' ? 'About a minute: 13 dots, then 4 check dots. Light the face from the front and keep the head still.' : `Cover the ${mode === 'left' ? 'right' : 'left'} eye while calibrating. 13 dots, then 4 check dots.`),
      onChange(fn) { S.changeFns.add(fn); return () => S.changeFns.delete(fn); },
      onFrame(fn) { S.frameFns.add(fn); return () => S.frameFns.delete(fn); },
      onImage() { return () => {}; },                            // the set-up menu uses the guide instead
      image() { return null; },
      pose() { return null; },
      connect, autoConnect, disconnect,
      get running() { return S.running; },
      setScreenInches(d) { d = +d; S.diagIn = d > 4 && d < 100 ? d : null; lsSet(LS_SCREEN, { diagIn: S.diagIn }); changed(); },
      clearCalibration() { S.cal = { v: 1, modes: {} }; S.check = null; try { localStorage.removeItem(LS_CAL); localStorage.removeItem(LS_CHECK); } catch (_) { /* ignore */ } filt.reset(); changed(); },
      setEyeMode(m) { if (!MODES.includes(m) || m === S.eyeMode) return; S.eyeMode = m; lsSet(LS_EYES, { mode: m }); filt.reset(); changed(); },
      get eyeMode() { return S.eyeMode; },
      setTargetHint() { /* only the IR tracker's 'either eye' mode uses this */ },
      // for tests: run without a camera, feeding recorded MediaPipe results ({ face, W, H }) as if they came from the worker
      _test: { S, filt, fake() { S.running = true; S.gen++; S.ready = true; changed(); }, inject: m => onResult(Object.assign({ ms: 0 }, m)) },
    };
  }

  root.WebcamGaze = { create, supported };
})(window);
