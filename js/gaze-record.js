/* gaze-record.js — what the child looked at, drawn over the targets: a heat map, numbered shifts of gaze, the gaze pointer, and a video
 * recording of the canvas with any of those (and the lift / glow effects) added.
 *
 * Every effect can be live (drawn on the page's own canvas, so everyone sees it), in the recording only, or both. This module keeps the
 * gaze history, draws the overlays, and records; index.html decides what is live and hands in the page's view of the canvas.
 *
 *   const rec = GazeRecord.create({
 *     canvas,                       // the page canvas (1920 x 1080 world, drawn at devicePixelRatio, panned / zoomed by the page)
 *     view:      () => ({ zoom, panX, panY }),
 *     settings:  () => ({ heat, numbers, recHeat, recNumbers, recPointer, pointerColor, transparency, dotPx, circleIn }),
 *     fxConfig:  () => ({ lift, glow }),            // effects to ADD in the recording (the page already draws the live ones)
 *     lookedAt:  () => obj | null,
 *     drawFx:    (c, obj, fx, scale, zoom) => {},   // draw obj with lift / glow state fx = { lift: 0..1, glow: 0..1 } onto c (world units)
 *     mmPerPx:   () => number,                      // real millimetres per CSS pixel (for the broad circle's size)
 *     onChange:  () => {},                          // live overlay changed: please redraw the page canvas
 *   });
 *   rec.sample(worldX, worldY, nowMs);              // every gaze sample, in canvas (world) coordinates
 *   rec.drawLive(ctx);                              // from the page's draw(), with the world transform applied
 *   await rec.start(); const { blob, name } = await rec.stop();
 */
(function (root) {
  'use strict';
  const GW = 1920, GH = 1080, HW = 192, HH = 108, CELL = GW / HW;       // heat grid: one cell is 10 world pixels
  const KR = 6, SIGMA = 2.6;                                            // heat spreads about 26 world pixels around the gaze point
  const FIX_RADIUS = 60, FIX_MIN_MS = 200, GAP_MS = 250, MAX_SHOWN = 40;  // a fixation: gaze staying within 60 px for 200 ms
  const OUT_W = 1280, OUT_H = 720, FPS = 30;
  const KERNEL = (() => { const k = [], n = 2 * KR + 1; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const dx = i - KR, dy = j - KR; k.push(Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA))); } return k; })();
  const RAMP = [[0, 40, 80, 255], [.25, 0, 200, 255], [.5, 60, 220, 90], [.72, 255, 220, 0], [.88, 255, 120, 0], [1, 235, 20, 20]];
  const MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

  function ramp(v) {
    for (let i = 1; i < RAMP.length; i++) if (v <= RAMP[i][0]) { const a = RAMP[i - 1], b = RAMP[i], t = (v - a[0]) / (b[0] - a[0]); return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
    return RAMP[RAMP.length - 1].slice(1);
  }
  const hexRgba = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(255,255,255,${a})`; };

  function create(o) {
    const S = { heat: new Float32Array(HW * HH), max: 0, heatCv: null, heatAt: 0, heatDirty: false, fix: [], cur: null, lastT: 0, pos: null, posAt: 0, notifyAt: 0, nFix: 0,
                rc: null, rctx: null, recorder: null, chunks: [], tick: 0, startedAt: 0, mime: '', fx: new Map(), stopRes: null };
    const changed = now => { if (now - S.notifyAt > 100) { S.notifyAt = now; try { o.onChange && o.onChange(); } catch (e) { console.error('[gaze-record]', e); } } };

    /* ---------------------------------------------------------------- history */
    function sample(x, y, now) {
      if (!(x >= 0 && y >= 0 && x <= GW && y <= GH)) { endFixation(); return; }
      const dt = S.lastT && now - S.lastT < GAP_MS ? Math.min(100, now - S.lastT) : 33;
      if (S.lastT && now - S.lastT >= GAP_MS) endFixation();
      S.lastT = now; S.pos = { x, y }; S.posAt = now;
      // heat
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), n = 2 * KR + 1;
      for (let j = 0; j < n; j++) {
        const gy = cy + j - KR; if (gy < 0 || gy >= HH) continue;
        for (let i = 0; i < n; i++) {
          const gx = cx + i - KR; if (gx < 0 || gx >= HW) continue;
          const idx = gy * HW + gx, v = S.heat[idx] + KERNEL[j * n + i] * dt; S.heat[idx] = v; if (v > S.max) S.max = v;
        }
      }
      S.heatDirty = true;
      // shifts of gaze: a fixation is gaze that stays within FIX_RADIUS for FIX_MIN_MS; it is numbered as soon as it qualifies
      let c = S.cur;
      if (c && Math.hypot(x - c.x, y - c.y) <= FIX_RADIUS) {
        c.n++; c.x += (x - c.x) / c.n; c.y += (y - c.y) / c.n; c.t1 = now;
        if (c.fix) { c.fix.x = c.x; c.fix.y = c.y; c.fix.ms = c.t1 - c.t0; }
        else if (c.t1 - c.t0 >= FIX_MIN_MS) { c.fix = { id: ++S.nFix, x: c.x, y: c.y, ms: c.t1 - c.t0 }; S.fix.push(c.fix); }
      } else { S.cur = { x, y, n: 1, t0: now, t1: now, fix: null }; }
      changed(now);
    }
    function endFixation() { S.cur = null; }
    function clear() { S.heat.fill(0); S.max = 0; S.fix = []; S.cur = null; S.nFix = 0; S.heatDirty = true; S.pos = null; changed(0); }

    /* ---------------------------------------------------------------- drawing (c has the world transform: 1 unit = 1 canvas pixel of the 1920 x 1080 page) */
    function heatCanvas(now) {
      if (!S.heatCv) { S.heatCv = document.createElement('canvas'); S.heatCv.width = HW; S.heatCv.height = HH; S.heatAt = -1e9; S.heatDirty = true; }
      if (S.heatDirty && now - S.heatAt > 200) {
        const g = S.heatCv.getContext('2d'), img = g.createImageData(HW, HH), d = img.data, m = S.max || 1;
        for (let i = 0; i < S.heat.length; i++) {
          const v = S.heat[i] / m; if (v < .04) continue;
          const [r, gr, b] = ramp(v), p = i * 4; d[p] = r; d[p + 1] = gr; d[p + 2] = b; d[p + 3] = Math.round(255 * Math.min(.78, .15 + v * .8));
        }
        g.putImageData(img, 0, 0); S.heatAt = now; S.heatDirty = false;
      }
      return S.heatCv;
    }
    function drawHeat(c) {
      if (!S.max) return;
      c.save(); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(heatCanvas(performance.now()), 0, 0, GW, GH); c.restore();
    }
    function drawNumbers(c) {
      const list = S.fix.slice(-MAX_SHOWN); if (!list.length) return;
      c.save(); c.lineJoin = c.lineCap = 'round';
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 7; c.beginPath(); list.forEach((f, i) => (i ? c.lineTo(f.x, f.y) : c.moveTo(f.x, f.y))); c.stroke();
      c.strokeStyle = 'rgba(20,24,28,.75)'; c.lineWidth = 3.5; c.beginPath(); list.forEach((f, i) => (i ? c.lineTo(f.x, f.y) : c.moveTo(f.x, f.y))); c.stroke();
      c.textAlign = 'center'; c.textBaseline = 'middle';
      list.forEach((f, i) => {
        const r = 16 + Math.min(20, Math.sqrt(f.ms / 1000) * 12), last = i === list.length - 1;
        c.beginPath(); c.arc(f.x, f.y, r, 0, Math.PI * 2); c.fillStyle = last ? 'rgba(255,196,0,.95)' : 'rgba(255,255,255,.92)'; c.fill();
        c.lineWidth = 3; c.strokeStyle = 'rgba(20,24,28,.85)'; c.stroke();
        c.fillStyle = '#10151a'; c.font = `700 ${Math.round(r * (f.id > 99 ? .8 : 1.05))}px system-ui, sans-serif`; c.fillText(String(f.id), f.x, f.y + 1);
      });
      c.restore();
    }
    function drawPointer(c, style, s, zoom) {
      if (style === 'off' || !S.pos || performance.now() - S.posAt > 500) return;
      const col = s.pointerColor || '#ffffff', op = Math.min(1, Math.max(.05, 1 - (s.transparency || 0) / 100));
      const d = style === 'circle' ? Math.max(12, (s.circleIn || 1.5) * 25.4 / ((o.mmPerPx && o.mmPerPx()) || 25.4 / 96)) / zoom : (s.dotPx || 22) / zoom;
      c.save(); c.globalAlpha = op; c.beginPath(); c.arc(S.pos.x, S.pos.y, d / 2, 0, Math.PI * 2);
      if (style === 'circle') { c.fillStyle = hexRgba(col, .18); c.fill(); c.lineWidth = 3 / zoom; c.strokeStyle = col; c.stroke(); c.beginPath(); c.arc(S.pos.x, S.pos.y, 3 / zoom, 0, Math.PI * 2); c.fillStyle = col; c.fill(); }
      else { c.fillStyle = col; c.fill(); c.lineWidth = 1.5 / zoom; c.strokeStyle = 'rgba(0,0,0,.45)'; c.stroke(); }
      c.restore();
    }
    /** From the page's draw(): the effects that are switched on live. */
    function drawLive(c) {
      const s = o.settings(); if (s.heat) drawHeat(c); if (s.numbers) drawNumbers(c);
    }

    /* ---------------------------------------------------------------- recording */
    function compose() {
      const v = o.view(), s = o.settings(), cfg = o.fxConfig(), look = o.lookedAt(), W = OUT_W, H = OUT_H, rc = S.rctx, d = o.canvas.width / GW;
      rc.setTransform(1, 0, 0, 1, 0, 0); rc.fillStyle = '#000'; rc.fillRect(0, 0, W, H);
      rc.imageSmoothingEnabled = true; rc.imageSmoothingQuality = 'high';
      try { rc.drawImage(o.canvas, v.panX * d, v.panY * d, GW * v.zoom * d, GH * v.zoom * d, 0, 0, W, H); } catch (_) { /* canvas not ready */ }
      const k = W / GW; rc.setTransform(k, 0, 0, H / GH, 0, 0);
      // lift / glow that are in the recording only
      if (look && (cfg.lift || cfg.glow) && !S.fx.has(look)) S.fx.set(look, { lift: 0, glow: 0 });
      S.fx.forEach((fx, obj) => {
        const on = obj === look, tl = on && cfg.lift ? 1 : 0, tg = on && cfg.glow ? 1 : 0;
        fx.lift += (tl - fx.lift) * .3; fx.glow += (tg - fx.glow) * .3;
        if (Math.abs(tl - fx.lift) < .01) fx.lift = tl; if (Math.abs(tg - fx.glow) < .01) fx.glow = tg;
        if (fx.lift > 0 || fx.glow > 0) { try { rc.save(); o.drawFx(rc, obj, fx, k, v.zoom); rc.restore(); } catch (e) { rc.restore(); console.error('[gaze-record]', e); } }
        else if (!on) S.fx.delete(obj);
      });
      if (s.recHeat && !s.heat) drawHeat(rc);                       // ones that are also live are already in the picture
      if (s.recNumbers && !s.numbers) drawNumbers(rc);
      drawPointer(rc, s.recPointer || 'off', s, v.zoom);
      if (s.camRec && o.camera) { const cv = o.camera(); if (cv) drawCamera(rc, cv, s); }
    }
    /** The tracker's camera picture in a corner of the video (mirrored, like the position guide). Output pixels, not world units. */
    function drawCamera(c, cv, s) {
      const size = Math.round(OUT_W * ({ small: .14, large: .28 }[s.camSize] || .2)), m = Math.round(OUT_W * .015), corner = s.camCorner || 'bottom-left';
      const x = /right/.test(corner) ? OUT_W - m - size : m, y = /top/.test(corner) ? m : OUT_H - m - size;
      c.setTransform(1, 0, 0, 1, 0, 0); c.save(); c.beginPath(); c.roundRect(x, y, size, size, size * .06); c.clip();
      c.translate(x + size, y); c.scale(-1, 1); c.drawImage(cv, 0, 0, size, size); c.restore();
      c.save(); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,.75)'; c.beginPath(); c.roundRect(x, y, size, size, size * .06); c.stroke(); c.restore();
    }
    async function start() {
      if (S.recorder) return false;
      if (!root.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record the canvas — use Chrome or Edge.');
      const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)); if (!mime) throw new Error('This browser has no video format it can record in.');
      S.rc = document.createElement('canvas'); S.rc.width = OUT_W; S.rc.height = OUT_H; S.rctx = S.rc.getContext('2d'); S.fx.clear();
      clear();                                                      // each recording starts with an empty heat map and numbering
      compose();
      const stream = S.rc.captureStream(FPS);
      S.chunks = []; S.mime = mime;
      S.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5e6 });
      S.recorder.ondataavailable = e => { if (e.data && e.data.size) S.chunks.push(e.data); };
      S.recorder.start(1000); S.startedAt = performance.now();
      S.tick = setInterval(compose, 1000 / FPS);
      return true;
    }
    async function stop() {
      const r = S.recorder; if (!r) return null;
      clearInterval(S.tick); S.tick = 0;
      // a very short recording can end before the encoder has produced anything: ask for what is buffered and, if there is still nothing, give it a moment
      if (!S.chunks.length) await new Promise(res => {
        const prev = r.ondataavailable, t = setTimeout(res, 2000);
        r.ondataavailable = e => { prev && prev(e); clearTimeout(t); res(); };
        try { r.requestData(); } catch (_) { clearTimeout(t); res(); }
      });
      return new Promise(res => {
        r.onstop = () => {
          const blob = new Blob(S.chunks, { type: S.mime.split(';')[0] }), ext = /mp4/.test(S.mime) ? 'mp4' : 'webm', d = new Date(), p = n => String(n).padStart(2, '0');
          const name = `gaze-recording-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
          try { r.stream.getTracks().forEach(t => t.stop()); } catch (_) { /* ignore */ }
          S.recorder = null; S.chunks = []; S.rc = S.rctx = null; S.fx.clear();
          res({ blob, name, ms: performance.now() - S.startedAt });
        };
        try { r.requestData(); } catch (_) { /* nothing buffered yet */ }
        try { r.stop(); } catch (e) { r.onstop(); }
      });
    }

    return {
      sample, clear, drawLive, start, stop,
      get recording() { return !!S.recorder; },
      elapsed() { return S.recorder ? performance.now() - S.startedAt : 0; },
      get fixations() { return S.nFix; },
      get hasData() { return S.max > 0; },
      _test: { S, compose },
    };
  }

  root.GazeRecord = { create };
})(typeof window !== 'undefined' ? window : this);
