/* tet-direct.js — the "connect straight to the tracker" source for gaze-bridge.js, the camera picture and eye pose for the
 * position guide, and the examiner's calibration and accuracy check.
 *
 * Needs js/tet-usb.js and js/calmath.js. Gives gaze-bridge.js the same messages the Python Gaze Assessment Tools send
 * ({ ok, x, y, rx, ry, l, r, dist, cal } as fractions of the screen), so the rest of the page does not know the difference.
 *
 *   const td = TetDirect.create();
 *   GazeBridge.create({ source: td.source, ... }).start();
 *   td.connect();            // from a click the first time; td.autoConnect() afterwards
 *   td.calibrate();          // the examiner looks at 9 dots, then 5 check dots; the result is saved in this browser
 *   td.accuracyCheck(8);     // N dots in random places: how closely does the tracker follow the examiner?
 *   td.pose(10)              // smoothed eye position { mid:[x,y,z] mm, ipd, roll, sd } or null
 *   td.image()               // { px: Uint8Array(280*280), at } latest camera picture, or null
 */
(function (root) {
  'use strict';
  const LS_SCREEN = 'tetDirect.screen.v1', LS_CAL = 'tetDirect.cal.v1', LS_CHECK = 'tetDirect.check.v1';
  const CAL9 = [[.5, .5], [.1, .1], [.9, .1], [.1, .9], [.9, .9], [.5, .1], [.5, .9], [.1, .5], [.9, .5]];
  const VAL5 = [[.3, .3], [.7, .3], [.5, .5], [.3, .7], [.7, .7]];
  const SETTLE_MS = 600, COLLECT_MS = 1100, MIN_SAMPLES = 8;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } };

  function create(opts) {
    opts = Object.assign({ initUrl: 'data/tet-init.bin' }, opts || {});
    const S = { status: 'idle', detail: 'click “Connect tracker”', last: null, cal: lsGet(LS_CAL), check: lsGet(LS_CHECK), diagIn: (lsGet(LS_SCREEN) || {}).diagIn || null,
                subs: new Set(), changeFns: new Set(), imgFns: new Set(), collector: null, busy: false, ir: null, irAt: 0, poseBuf: [] };
    if (S.cal && !(Array.isArray(S.cal.A) && S.cal.A.length === 6)) S.cal = null;

    const screenMm = () => {
      if (!S.diagIn) return null;
      const w = screen.width || 16, h = screen.height || 9, d = S.diagIn * 25.4, hy = Math.hypot(w, h);
      return [Math.round(d * w / hy), Math.round(d * h / hy)];
    };
    const changed = () => S.changeFns.forEach(f => { try { f(state()); } catch (e) { console.error(e); } });
    function state() {
      return { status: S.status, detail: S.detail, calibrated: !!S.cal, cal: S.cal, check: S.check, diagIn: S.diagIn, screenMm: screenMm(), last: S.last, busy: S.busy, supported: TetUSB.supported() };
    }
    function hello() { return { hello: true, screen_mm: screenMm(), calibrated: !!S.cal, simulated: false, direct: true }; }
    function pushState() {
      S.subs.forEach(s => { if (S.status === 'live') s.onMsg(hello()); else s.setStatus(S.status, S.detail); });
      changed();
    }

    const tracker = TetUSB.create({
      initUrl: opts.initUrl, displayMm: screenMm(), images: false, wantImage: () => S.imgFns.size > 0,
      onStatus: (st, text) => { S.status = st; S.detail = text; if (st !== 'live') { S.ir = null; S.poseBuf.length = 0; } pushState(); },
      onImage: px => { S.ir = px; S.irAt = performance.now(); S.imgFns.forEach(f => { try { f(px); } catch (e) { console.error(e); } }); },
      onGaze: g => {
        const x = g.x, y = g.y, ok = !!g.valid && x != null && x >= 0, A = S.cal && S.cal.A, now = performance.now();
        const eye = n => { const e = g.eyes[n]; return e.tracked && e.origin_ok && e.origin_mm && e.origin_mm.length >= 3 ? e.origin_mm : null; };
        const eL = eye('left'), eR = eye('right'), zs = [eL, eR].filter(Boolean).map(e => e[2]);
        const msg = { ts: Date.now(), ok, x: null, y: null, rx: ok ? x : null, ry: ok ? y : null, l: g.eyes.left.tracked, r: g.eyes.right.tracked,
                      dist: zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null, cal: !!A, eL, eR };
        if (ok) { msg.x = A ? A[0] * x + A[1] * y + A[2] : x; msg.y = A ? A[3] * x + A[4] * y + A[5] : y; }
        const p = CalMath.eyePose(eL, eR);
        if (p && p.both) S.poseBuf.push({ t: now, p });
        while (S.poseBuf.length && now - S.poseBuf[0].t > 1500) S.poseBuf.shift();
        S.last = msg;
        if (S.collector) S.collector(msg);
        S.subs.forEach(s => s.onMsg(msg));
      },
    });

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

    /* ---------------------------------------------------------------- full-screen sessions (calibration, accuracy check) */
    const clientToFrac = (px, py) => {
      const full = document.fullscreenElement || (innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2);
      if (full) return [px / innerWidth, py / innerHeight];
      const side = (outerWidth - innerWidth) / 2, left = screenX + side, top = screenY + (outerHeight - innerHeight) - side;
      return [(px + left) / screen.width, (py + top) / screen.height];
    };
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    // styling follows the page's own theme variables (falls back to the app's dark theme)
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
.td-score{display:flex;align-items:baseline;gap:10px;margin:12px 0 4px}
.td-score b{font-size:34px;font-weight:750;letter-spacing:-.03em;color:var(--md-on-surface,#edf3ee)}
.td-score span{font-size:14px;font-weight:650;padding:3px 10px;border-radius:999px;background:var(--md-primary-container,#25443b);color:var(--md-on-primary-container,var(--md-on-surface,#edf3ee))}
.td-score.warn span{background:rgb(251 191 36 / 18%);color:#fbbf24}
.td-stats{display:flex;gap:18px;margin:2px 0 4px;font-size:12px;color:var(--md-on-surface-muted,#a2b7aa)}
.td-stats b{display:block;font-size:15px;font-weight:650;color:var(--md-on-surface,#edf3ee)}
.td-map{display:block;width:100%;height:auto;margin:12px 0 4px;border-radius:10px;background:var(--md-surface-variant,#252f2c);border:1px solid var(--md-outline,#3b4942)}
.td-btns{display:flex;gap:8px;margin-top:20px}
.td-btn{flex:1;min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid var(--md-outline,#3b4942);background:var(--md-surface-variant,#252f2c);color:var(--md-on-surface,#edf3ee);font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.td-btn:hover{border-color:var(--md-primary,#8ed7bf)}
.td-btn.primary{border-color:transparent;background:var(--md-primary,#8ed7bf);color:var(--md-on-primary,#0b2a22);box-shadow:0 4px 14px color-mix(in srgb,var(--md-primary,#8ed7bf) 30%,transparent)}
.td-btn:focus-visible{outline:2px solid var(--md-primary,#8ed7bf);outline-offset:2px}
.td-dot{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#fff;box-shadow:0 0 0 7px rgb(45 212 191 / 35%);display:none}
.td-dot::after{content:"";position:absolute;inset:12px;border-radius:50%;background:#0b100f}
.td-progress{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);font-size:12px;font-weight:600;letter-spacing:.02em;color:rgb(255 255 255 / 50%);white-space:nowrap}
.td-progress:empty{display:none}`;
    const ensureCss = () => { if (document.getElementById('td-style')) return; const st = document.createElement('style'); st.id = 'td-style'; st.textContent = CSS; document.head.appendChild(st); };

    /** Runs fn(ui) on a full-screen overlay; ui has say / grabPoint / check. Always cleans up. Resolves to fn's result, or null when cancelled. */
    async function runSession(fn) {
      if (S.busy) return null;
      if (S.status !== 'live') { alert('Connect the tracker first — the status must say it is streaming.'); return null; }
      S.busy = true; changed();
      const wasFull = !!document.fullscreenElement;
      ensureCss();
      const ov = mk('div', 'td-ov'), box = mk('div', 'td-card'), dot = mk('div', 'td-dot'), progress = mk('div', 'td-progress');
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Eye tracker');
      ov.append(box, dot, progress); document.body.appendChild(ov);
      let cancelled = false, wake = null;
      const onKey = e => { if (e.key === 'Escape') { cancelled = true; e.preventDefault(); e.stopPropagation(); if (wake) wake(); } };
      addEventListener('keydown', onKey, true);
      const check = () => { if (cancelled) throw new Error('cancelled'); };
      // one card: small heading, title, paragraphs / elements, and a row of buttons ([label, value, primary])
      const say = (kicker, title, body, buttons) => new Promise(res => {
        box.textContent = ''; box.style.display = ''; ov.classList.toggle('td-ask', !!buttons); dot.style.display = 'none'; progress.textContent = '';
        if (kicker) box.appendChild(mk('div', 'td-kicker', kicker));
        box.appendChild(mk('h2', '', title));
        (body || []).forEach(b => box.appendChild(typeof b === 'string' ? mk('p', '', b) : b));
        if (!buttons) { res(null); return; }
        const row = mk('div', 'td-btns'); buttons.forEach(([label, val, primary]) => { const b = mk('button', 'td-btn' + (primary ? ' primary' : ''), label); b.type = 'button'; b.onclick = () => res(val); row.appendChild(b); });
        box.appendChild(row); wake = () => res('cancel'); const first = row.querySelector('.primary'); if (first) first.focus();
      });
      const collect = ms => new Promise(res => { const out = []; S.collector = m => { if (m.ok && (m.l || m.r)) out.push(m); }; setTimeout(() => { S.collector = null; res(out); }, ms); });
      const showDot = (px, py, label) => {
        box.textContent = ''; box.style.display = 'none'; progress.textContent = label || ''; Object.assign(dot.style, { display: 'block', left: px + 'px', top: py + 'px' });
        dot.animate([{ transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 450, easing: 'ease-out' });
      };
      const medianDist = ms => { const z = ms.map(m => m.dist).filter(v => v != null).sort((a, b) => a - b); return z.length ? z[z.length >> 1] : 600; };
      /** Shows a dot at a viewport fraction, collects the examiner's gaze; null if the eyes could not be seen (the point is skipped, never an error). */
      const grabPoint = async (frac, label) => {
        const px = frac[0] * innerWidth, py = frac[1] * innerHeight, target = clientToFrac(px, py);
        for (let tries = 0; tries < 2; tries++) {
          check(); showDot(px, py, label); await sleep(SETTLE_MS); check();
          const ms = await collect(COLLECT_MS); check();
          if (ms.length >= MIN_SAMPLES) return { target, ms, dist: medianDist(ms) };
          if (tries === 0) { await say('', 'Look at the dot', ['The tracker lost your eyes for a moment. It will show the dot again.']); await sleep(1100); }
        }
        return null;
      };
      const liveChip = () => {
        const chip = mk('div', 'td-chip'), d = mk('i'), t = mk('span'); chip.append(d, t);
        const upd = () => { const m = S.last; t.textContent = !m ? 'Waiting for the tracker…' : (m.l && m.r) ? `Both eyes found${m.dist ? ' · about ' + Math.round(m.dist / 10) + ' cm away' : ''}` : (m.l || m.r) ? 'One eye found — move a little so both are visible' : 'No eyes found — sit in front of the tracker'; chip.classList.toggle('ok', !!(m && m.l && m.r)); };
        const iv = setInterval(upd, 200); upd(); return { chip, stop: () => clearInterval(iv) };
      };
      try {
        if (!wasFull) { try { await document.documentElement.requestFullscreen(); await sleep(500); } catch (_) { /* not allowed: carry on, a little less exact */ } }
        return await fn({ say, grabPoint, check, mk, liveChip, fullscreen: () => !!document.fullscreenElement, wasFull });
      } catch (e) {
        if (e.message !== 'cancelled') console.error('[tet-direct]', e);
        return null;
      } finally {
        S.collector = null; removeEventListener('keydown', onKey, true); ov.remove(); S.busy = false;
        if (!wasFull && document.fullscreenElement) { try { await document.exitFullscreen(); } catch (_) { /* ignore */ } }
        changed();
      }
    }
    const centre = (ms, fx) => CalMath.summarize(ms.map(fx));
    const screenSize = () => screenMm() || [293, 165];

    function calibrate() {
      return runSession(async u => {
        for (;;) {
          const lc = u.liveChip();
          const go = await u.say('Eye gaze · calibration', 'Look at each dot', ['Sit where the child will sit, the way they will sit. Look at the centre of each dot until it moves: 9 dots, then 5 check dots. About 30 seconds.', lc.chip, 'Press Esc at any time to stop.'], [['Start', 'go', true], ['Cancel', 'cancel']]);
          lc.stop(); u.check(); if (go !== 'go') throw new Error('cancelled');
          // --- 9 dots
          const pts = [];
          for (let i = 0; i < CAL9.length; i++) { const p = await u.grabPoint(CAL9[i], `Calibrating · dot ${i + 1} of ${CAL9.length}`); if (p) { const c = centre(p.ms, m => [m.rx, m.ry]); if (c) pts.push({ target: p.target, raw: [c.x, c.y], dist: p.dist }); } }
          if (pts.length < 4) { const r = await u.say('Eye gaze · calibration', 'Not enough dots recorded', [`Only ${pts.length} of 9 dots could be recorded. The tracker needs to see your eyes.`], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (r === 'again') continue; throw new Error('cancelled'); }
          const A = CalMath.fitAffine(pts.map(p => p.raw), pts.map(p => p.target));
          if (!A) { const r = await u.say('Eye gaze · calibration', 'That did not work', ['The points did not give a usable result.'], [['Try again', 'again', true], ['Cancel', 'cancel']]); if (r === 'again') continue; throw new Error('cancelled'); }
          // --- 5 check dots, with the new calibration applied
          const sm = screenSize(), errs = [];
          for (let k = 0; k < VAL5.length; k++) {
            const p = await u.grabPoint(VAL5[k], `Checking · dot ${k + 1} of ${VAL5.length}`); if (!p) continue;
            const c = centre(p.ms, m => CalMath.apply(A, m.rx, m.ry)); if (!c) continue;
            errs.push(CalMath.angDeg((c.x - p.target[0]) * sm[0], (c.y - p.target[1]) * sm[1], p.dist));
          }
          const meanErr = errs.length ? CalMath.mean(errs) : NaN, g = CalMath.grade(meanErr);
          const score = u.mk('div', 'td-score' + (g.level === 'good' ? '' : ' warn'));
          if (Number.isFinite(meanErr)) score.append(u.mk('b', '', meanErr.toFixed(1) + '°'), u.mk('span', '', g.label));
          const body = Number.isFinite(meanErr) ? [score, 'Average distance between the check dots and where the tracker saw you look. Under 2° is good for this kind of work.']
                                                 : ['The check dots could not be recorded, so the accuracy is unknown.'];
          body.push('A rough guide: the child’s eyes will differ a little from yours.');
          if (pts.length < CAL9.length) body.push(`${CAL9.length - pts.length} calibration dot(s) were skipped.`);
          if (!(u.wasFull || u.fullscreen())) body.push('Not full-screen: use full-screen (F11) when you play so the gaze lines up.');
          const r = await u.say('Eye gaze · result', Number.isFinite(meanErr) ? 'Calibration done' : 'Calibration done (not checked)', body, [['Use this', 'use', true], ['Do it again', 'again'], ['Cancel', 'cancel']]);
          if (r === 'again') continue; if (r !== 'use') throw new Error('cancelled');
          S.cal = { A, created: new Date().toISOString(), errDeg: Number.isFinite(meanErr) ? +meanErr.toFixed(2) : null, grade: g.label, points: pts.length, fullscreen: u.fullscreen(), screenMm: sm };
          lsSet(LS_CAL, S.cal); pushState(); return S.cal;
        }
      });
    }

    /** N dots in random places. The examiner looks at each; the result says how closely the (calibrated) gaze matched, with a map. */
    function randomTargets(n) {
      const aspect = innerWidth / innerHeight, out = [];
      for (let tries = 0; out.length < n && tries < 400; tries++) {
        const p = [.08 + Math.random() * .84, .1 + Math.random() * .8];
        if (out.every(q => Math.hypot((p[0] - q[0]) * aspect, p[1] - q[1]) > 0.22 - tries * 0.0003)) out.push(p);
      }
      while (out.length < n) out.push([.1 + Math.random() * .8, .1 + Math.random() * .8]);
      return out;
    }
    function drawMap(canvas, res) {
      const W = canvas.width, H = canvas.height, g = canvas.getContext('2d'), css = getComputedStyle(document.documentElement);
      const col = (n, d) => css.getPropertyValue(n).trim() || d;
      g.clearRect(0, 0, W, H); g.strokeStyle = col('--md-outline', '#3b4942'); g.lineWidth = 1; g.strokeRect(.5, .5, W - 1, H - 1);
      for (const r of res) {
        const c = r.err > 3.5 ? '#f87171' : r.err > 2 ? '#fbbf24' : '#34d399';
        const tx = r.target[0] * W, ty = r.target[1] * H, gx = r.gaze[0] * W, gy = r.gaze[1] * H;
        g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.moveTo(tx, ty); g.lineTo(gx, gy); g.stroke();
        g.strokeStyle = col('--md-on-surface-muted', '#a2b7aa'); g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, 7, 0, 7); g.stroke();
        g.fillStyle = c; g.beginPath(); g.arc(gx, gy, 4.5, 0, 7); g.fill();
      }
    }
    function accuracyCheck(n) {
      n = Math.max(3, Math.min(20, +n || 8));
      return runSession(async u => {
        for (;;) {
          const lc = u.liveChip();
          const go = await u.say('Eye gaze · accuracy check', 'Look at each dot', [`${n} dots appear one after another in random places. Look at the centre of each one. This shows how closely the tracker follows you with the saved calibration.`, lc.chip,
            S.cal ? 'Press Esc at any time to stop.' : 'You have not calibrated yet, so this will show the raw, uncorrected gaze.'], [['Start', 'go', true], ['Cancel', 'cancel']]);
          lc.stop(); u.check(); if (go !== 'go') throw new Error('cancelled');
          const targets = randomTargets(n), res = [], sm = screenSize();
          for (let i = 0; i < targets.length; i++) {
            const p = await u.grabPoint(targets[i], `Accuracy check · dot ${i + 1} of ${targets.length}`); if (!p) continue;
            const c = centre(p.ms, m => [m.x, m.y]); if (!c) continue;
            res.push({ target: p.target, gaze: [c.x, c.y], err: CalMath.angDeg((c.x - p.target[0]) * sm[0], (c.y - p.target[1]) * sm[1], p.dist) });
          }
          if (res.length < 3) { const r = await u.say('Eye gaze · accuracy check', 'Not enough dots recorded', [`Only ${res.length} of ${n} dots could be recorded. The tracker needs to see your eyes.`], [['Try again', 'again', true], ['Close', 'cancel']]); if (r === 'again') continue; throw new Error('cancelled'); }
          const errs = res.map(r => r.err).sort((a, b) => a - b), mean = CalMath.mean(errs), median = CalMath.median(errs), worst = errs[errs.length - 1], g = CalMath.grade(mean);
          const score = u.mk('div', 'td-score' + (g.level === 'good' ? '' : ' warn')); score.append(u.mk('b', '', mean.toFixed(1) + '°'), u.mk('span', '', g.label));
          const stats = u.mk('div', 'td-stats'); [['Median', median.toFixed(1) + '°'], ['Worst dot', worst.toFixed(1) + '°'], ['Dots', res.length + ' of ' + n]].forEach(([k, v]) => { const d = u.mk('div', '', k); d.prepend(u.mk('b', '', v)); stats.appendChild(d); });
          const map = u.mk('canvas', 'td-map'); map.width = 420; map.height = Math.round(420 * sm[1] / sm[0]); drawMap(map, res);
          const advice = mean < 2 ? 'The tracker follows you well. Calibration is fine to use.' : mean < 3.5 ? 'Usable as a rough guide. Calibrate again if you want it tighter.' : 'This is rough. Check your position, then calibrate again.';
          S.check = { when: new Date().toISOString(), n: res.length, meanDeg: +mean.toFixed(2), medianDeg: +median.toFixed(2), worstDeg: +worst.toFixed(2), grade: g.label, calibrated: !!S.cal };
          lsSet(LS_CHECK, S.check); pushState();
          const r = await u.say('Eye gaze · accuracy check', 'Result', [score, stats, map, 'Rings are where the dots were; the coloured dots are where the tracker saw you look. ' + advice], [['Done', 'done', true], ['Check again', 'again']]);
          if (r === 'again') continue; return S.check;
        }
      });
    }

    return {
      source, state, calibrate, accuracyCheck, pose,
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
      clearCalibration() { S.cal = null; try { localStorage.removeItem(LS_CAL); } catch (_) { /* ignore */ } pushState(); },
    };
  }

  root.TetDirect = { create };
})(window);
