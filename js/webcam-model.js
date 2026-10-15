/* webcam-model.js — the maths of webcam eye tracking (no DOM): MediaPipe face landmarks + two small eye pictures -> gaze features ->
 * a model fitted to this person -> a point on the screen. Used by js/webcam-gaze.js; js/webcam-worker.js does the per-frame vision.
 *
 * Why it is built this way (research, and a test on real laptop-webcam data):
 *  - Webcam gaze is limited by how little the iris moves in the picture: about 0.002 of the eye-to-eye distance per degree, i.e. a pixel
 *    or two across the whole screen. So no single cue is enough; the best browser trackers combine eye landmarks with the head's pose
 *    and an appearance cue, and fit them to each person with a short calibration (Valliappan et al. 2020, Nature Communications:
 *    personalisation cut error ~4x; WebGazer, Papoutsaki et al. 2016: eye-image patches + ridge regression; WebEyeTrack, Davalos et al.
 *    2025 and EMC-Gaze, Zhang 2026: MediaPipe landmarks + head pose + few-shot per-person fit; raw landmarks without normalisation fail).
 *  - Features here: where each iris sits relative to its eye corners and lids, scaled by the eye-to-eye distance and turned with the
 *    head's roll (so a tilted or nearer face gives the same numbers); MediaPipe's own eye-movement blendshapes; the head's rotation
 *    and position (from MediaPipe's face pose) and their interaction with distance; and a small normalised grey picture of each eye.
 *  - The model is ridge regression on standardised features; how strongly it is regularised is chosen per person by how well it predicts
 *    a calibration dot it was not given (leave-one-dot-out). Kernel / non-linear fits were worse with this few dots.
 *  - Checked on MPIIFaceGaze (Zhang et al. 2017; 15 people, real laptop webcams, everyday use over months) with this exact MediaPipe and
 *    feature code, a simulated 13-dot calibration per recording session, error per single frame (before any smoothing). Settings tuned
 *    on 3 people, then tested on the other 12 (118 sessions): landmarks + head + blendshapes 4.7°, adding the eye pictures 3.6°
 *    (median 3.3°); one eye only 4.8° -> 4.0°. This JavaScript gives the same numbers as the analysis (3.32° vs 3.33°).
 *    9 dots 4.0°, 13 dots 3.6°, 17 dots no better; the same calibration on another day 6.0° (5.6° after the 4-dot shift), so it
 *    should be done at the start of each session.
 *  - Distance to the screen: the iris is ~11.7 mm across in nearly everyone, so its size in pixels with a typical 65° webcam lens gives
 *    the distance to within a few per cent (checked on the same data); MediaPipe's own depth was ~1.5x too small there.
 */
(function (root) {
  'use strict';
  /** The landmarks kept from MediaPipe's 478 (the worker sends these, in this order): both eye outlines, both irises, nose, forehead, chin, cheeks. */
  const KEEP = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398,
    468, 469, 470, 471, 472, 473, 474, 475, 476, 477, 1, 4, 6, 168, 10, 152, 234, 454, 197, 195, 5];
  const IX = {}; KEEP.forEach((k, i) => { IX[k] = i; });
  // MediaPipe's eye blendshapes (indices in its 52), in the order the model uses them
  const BS_EYE = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];          // eyeBlink L R, eyeLookDown L R, eyeLookIn L R, eyeLookOut L R, eyeLookUp L R, eyeSquint L R, eyeWide L R
  const BS_SIDE = { right: [1, 3, 5, 7, 9, 11, 13], left: [0, 2, 4, 6, 8, 10, 12] };   // MediaPipe's "Left" is the person's left eye
  const EYES = { R: { out: 33, inn: 133, up: 159, lo: 145, iris: 468 }, L: { out: 263, inn: 362, up: 386, lo: 374, iris: 473 } };   // R = the person's right eye
  const PATCH = { W: 48, H: 24, ds: 2, crop: [2, 10, 2, 22] };    // the worker cuts 48 x 24 per eye; the model uses the middle 8 x 20 of it at half size
  const IRIS_MM = 11.7, HFOV = 65;

  /* ---------------------------------------------------------------- one frame -> measurements */
  /**
   * face = { lm: Float32Array(KEEP.length * 3), M: Float32Array(16) | null, bs: Float32Array(52) | null, pR, pL: Uint8Array(48 * 24) | null }
   * -> { eyes: { R, L: { ix, iy, up, lo, open, dia } }, head: { yaw, pitch, roll, tx, ty, tz }, bs, patch: { R, L }, iod, eyeR, eyeL (image fractions),
   *      box: [x0, y0, x1, y1], distMm, blink: { both, left, right } }
   */
  function frame(face, W, H) {
    const lm = face.lm, P = k => [lm[IX[k] * 3] * W, lm[IX[k] * 3 + 1] * H];
    const c = {}; for (const k of ['R', 'L']) { const a = P(EYES[k].out), b = P(EYES[k].inn); c[k] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
    const iod = Math.hypot(c.L[0] - c.R[0], c.L[1] - c.R[1]); if (!(iod > 4)) return null;
    const u = [(c.L[0] - c.R[0]) / iod, (c.L[1] - c.R[1]) / iod], v = [-u[1], u[0]];
    const dot = (p, o, a) => ((p[0] - o[0]) * a[0] + (p[1] - o[1]) * a[1]) / iod;
    const eyes = {};
    for (const k of ['R', 'L']) {
      const e = EYES[k]; let ix = 0, iy = 0;
      for (let j = 0; j < 5; j++) { const p = P(e.iris + j); ix += p[0]; iy += p[1]; }
      const iris = [ix / 5, iy / 5], d1 = P(e.iris + 1), d3 = P(e.iris + 3), d2 = P(e.iris + 2), d4 = P(e.iris + 4);
      const up = dot(P(e.up), c[k], v), lo = dot(P(e.lo), c[k], v), w = Math.hypot(P(e.out)[0] - P(e.inn)[0], P(e.out)[1] - P(e.inn)[1]) / iod;
      eyes[k] = { ix: dot(iris, c[k], u), iy: dot(iris, c[k], v), up, lo, open: (lo - up) / Math.max(w, 1e-3), dia: (Math.hypot(d1[0] - d3[0], d1[1] - d3[1]) + Math.hypot(d2[0] - d4[0], d2[1] - d4[1])) / 2 };
    }
    let head = { yaw: 0, pitch: 0, roll: Math.atan2(u[1], u[0]), tx: 0, ty: 0, tz: -50 };
    if (face.M) {                                                  // column-major 4x4: rotation in the top-left 3x3, translation (cm) in 12..14
      const M = face.M, f = [M[8], M[9], M[10]];
      head = { yaw: Math.atan2(f[0], f[2]), pitch: Math.atan2(-f[1], Math.hypot(f[0], f[2])), roll: Math.atan2(M[1], M[0]), tx: M[12], ty: M[13], tz: M[14] };
    }
    const bs = face.bs ? BS_EYE.map(i => face.bs[i] || 0) : new Array(BS_EYE.length).fill(0);
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (let i = 0; i < KEEP.length; i++) { const x = lm[i * 3], y = lm[i * 3 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const f = (W / 2) / Math.tan(HFOV / 2 * Math.PI / 180), dia = (eyes.R.dia + eyes.L.dia) / 2;
    // a closed eye: MediaPipe's blink score, or the lids close together compared with the eye's width
    const shut = k => (face.bs ? bs[k === 'L' ? 0 : 1] > 0.75 : false) || eyes[k].open < 0.12;
    const bl = { L: shut('L'), R: shut('R') };
    return { W, H, eyes, head, bs, iod, eyeR: [c.R[0] / W, c.R[1] / H], eyeL: [c.L[0] / W, c.L[1] / H], box: [x0, y0, x1, y1], distMm: dia > 1 ? f * IRIS_MM / dia : null,
             blink: { both: bl.L || bl.R, left: bl.L, right: bl.R }, patch: { R: face.pR ? prepPatch(face.pR) : null, L: face.pL ? prepPatch(face.pL) : null } };
  }

  /** The worker's 48 x 24 grey eye picture -> the middle 8 x 20 at half size, normalised to mean 0 and spread 1 (so light level does not matter). */
  function prepPatch(px) {
    const [r0, r1, c0, c1] = PATCH.crop, ds = PATCH.ds, w = PATCH.W / ds, out = new Float64Array((r1 - r0) * (c1 - c0));
    let n = 0, s = 0, s2 = 0;
    for (let r = r0; r < r1; r++) for (let cc = c0; cc < c1; cc++) {
      let a = 0; for (let dy = 0; dy < ds; dy++) for (let dx = 0; dx < ds; dx++) a += px[(r * ds + dy) * PATCH.W + cc * ds + dx];
      a /= ds * ds; out[n++] = a; s += a; s2 += a * a;
    }
    const m = s / n, sd = Math.sqrt(Math.max(1e-9, s2 / n - m * m)) + 1e-6;
    for (let i = 0; i < n; i++) out[i] = (out[i] - m) / sd;
    return out;
  }

  /* ---------------------------------------------------------------- measurements -> feature vector */
  let PATCH_W = 0.5;                                               // how much the eye pictures count against the landmark features (tuned; applied after standardising)
  const geoN = mode => (mode === 'both' ? 31 : 24);               // landmark features: 4 eye + 6 head + blendshapes (14 or 7) + 7 terms
  /** The feature vector for an eye mode ('both' | 'left' | 'right'): landmark features, then the eye pictures (if the worker sent them). */
  function vector(fr, mode) {
    const sides = mode === 'left' ? ['L'] : mode === 'right' ? ['R'] : ['R', 'L'], n = sides.length, e = fr.eyes;
    const avg = key => sides.reduce((a, s) => a + e[s][key], 0) / n;
    const ix = avg('ix'), iy = avg('iy'), h = fr.head, z = h.tz / 50;
    const bs = mode === 'both' ? fr.bs : BS_SIDE[mode].map(i => fr.bs[i]);
    const out = [ix, iy, avg('up'), avg('lo'), h.yaw, h.pitch, h.roll, h.tx / 10, h.ty / 10, h.tz / 10, ...bs, ix * z, iy * z, h.yaw * z, h.pitch * z, ix * ix, iy * iy, ix * iy];
    if (sides.every(s => fr.patch[s])) for (const s of sides) { const p = fr.patch[s]; for (let i = 0; i < p.length; i++) out.push(p[i]); }
    return out;
  }

  /* ---------------------------------------------------------------- ridge regression with leave-one-dot-out choice */
  /** Cholesky solve of (A) x = b for symmetric positive definite A (n x n, Float64Array row-major); b has 2 columns. In place on copies. */
  function cholSolve2(A, n, B) {
    const L = new Float64Array(A);
    for (let j = 0; j < n; j++) {
      let s = L[j * n + j]; for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
      if (!(s > 0)) return null; const d = Math.sqrt(s); L[j * n + j] = d;
      for (let i = j + 1; i < n; i++) { let t = L[i * n + j]; for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k]; L[i * n + j] = t / d; }
    }
    const X = new Float64Array(B);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < n; i++) { let t = X[i * 2 + c]; for (let k = 0; k < i; k++) t -= L[i * n + k] * X[k * 2 + c]; X[i * 2 + c] = t / L[i * n + i]; }
      for (let i = n - 1; i >= 0; i--) { let t = X[i * 2 + c]; for (let k = i + 1; k < n; k++) t -= L[k * n + i] * X[k * 2 + c]; X[i * 2 + c] = t / L[i * n + i]; }
    }
    return X;
  }
  /** Sufficient statistics of standardised rows, so a fit and every leave-one-dot-out fit share one pass over the data. */
  function stats(rows, ys, mu, sd) {
    const p = mu.length, G = new Float64Array(p * p), b = new Float64Array(p * 2), z = new Float64Array(p); let sy0 = 0, sy1 = 0;
    for (let r = 0; r < rows.length; r++) {
      const x = rows[r]; for (let i = 0; i < p; i++) z[i] = (x[i] - mu[i]) / sd[i];
      for (let i = 0; i < p; i++) { const zi = z[i]; if (zi === 0) continue; const o = i * p; for (let j = i; j < p; j++) G[o + j] += zi * z[j]; b[i * 2] += zi * ys[r][0]; b[i * 2 + 1] += zi * ys[r][1]; }
      sy0 += ys[r][0]; sy1 += ys[r][1];
    }
    for (let i = 0; i < p; i++) for (let j = i + 1; j < p; j++) G[j * p + i] = G[i * p + j];
    return { G, b, sz: null, n: rows.length, sy: [sy0, sy1] };
  }
  /** Solve ridge from statistics (with the mean of z handled by centring: z is standardised on all calibration rows). */
  function solve(st, sumZ, lam) {
    const p = sumZ.length, n = st.n, A = new Float64Array(p * p), B = new Float64Array(p * 2), ym = [st.sy[0] / n, st.sy[1] / n];
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) A[i * p + j] = st.G[i * p + j] - sumZ[i] * sumZ[j] / n;       // centred Gram matrix
      A[i * p + i] += lam * n;
      B[i * 2] = st.b[i * 2] - sumZ[i] * ym[0]; B[i * 2 + 1] = st.b[i * 2 + 1] - sumZ[i] * ym[1];
    }
    const W = cholSolve2(A, p, B); if (!W) return null;
    let c0 = ym[0], c1 = ym[1]; for (let i = 0; i < p; i++) { c0 -= W[i * 2] * sumZ[i] / n; c1 -= W[i * 2 + 1] * sumZ[i] / n; }
    return { W, c: [c0, c1] };
  }
  const LAMS = [1e-3, 1e-2, 0.1, 1];
  /**
   * Fits the model to calibration dots: pts = [{ target: [x, y], frames: [vector] }]. Chooses the regularisation by leave-one-dot-out.
   * opts.quick: landmark features only and a fixed regularisation (fast; used to confirm the next dots were looked at during calibration).
   */
  function fit(pts, opts) {
    opts = opts || {};
    const nGeo = geoN(opts.mode || 'both'), withPatch = !opts.quick && pts.every(p => p.frames.every(f => f.length > nGeo));
    const rows = [], ys = [], grp = [];
    pts.forEach((p, gi) => p.frames.forEach(f => { rows.push(withPatch ? f : f.slice(0, nGeo)); ys.push(p.target); grp.push(gi); }));
    if (rows.length < 3) return null;
    const p = rows[0].length, mu = new Float64Array(p), sd = new Float64Array(p);
    rows.forEach(r => { for (let i = 0; i < p; i++) mu[i] += r[i]; }); for (let i = 0; i < p; i++) mu[i] /= rows.length;
    rows.forEach(r => { for (let i = 0; i < p; i++) sd[i] += (r[i] - mu[i]) ** 2; }); for (let i = 0; i < p; i++) sd[i] = Math.sqrt(sd[i] / rows.length) || 1;
    for (let i = nGeo; i < p; i++) sd[i] /= PATCH_W;               // the eye pictures: shrunk harder than the landmark features
    const sumZOf = idx => { const s = new Float64Array(p); idx.forEach(r => { const x = rows[r]; for (let i = 0; i < p; i++) s[i] += (x[i] - mu[i]) / sd[i]; }); return s; };
    const all = rows.map((_, i) => i), stAll = stats(rows, ys, mu, sd), sAll = sumZOf(all);
    let lam = opts.lam || (opts.quick ? 0.3 : 0.01), loo = null;     // a quick model from a few dots is held back hard
    if (!opts.quick && !opts.lam && pts.length >= 5) {
      // statistics of each dot, so every leave-one-dot-out fit is "all minus one dot" without another pass
      const per = pts.map((_, gi) => { const idx = all.filter(r => grp[r] === gi); return { idx, st: stats(idx.map(r => rows[r]), idx.map(r => ys[r]), mu, sd), s: sumZOf(idx) }; });
      let best = null;
      for (const L of LAMS) {
        let err = 0, cnt = 0;
        for (let gi = 0; gi < pts.length; gi++) {
          const q = per[gi], st = { G: stAll.G.map((v, i) => v - q.st.G[i]), b: stAll.b.map((v, i) => v - q.st.b[i]), n: stAll.n - q.st.n, sy: [stAll.sy[0] - q.st.sy[0], stAll.sy[1] - q.st.sy[1]] };
          const sz = sAll.map((v, i) => v - q.s[i]), m = solve(st, sz, L); if (!m) { err = Infinity; break; }
          const mdl = { mu, sd, W: m.W, c: m.c, patch: withPatch };
          // error of the dot's average prediction (the app averages frames, so this is what matters)
          let px = 0, py = 0; q.idx.forEach(r => { const o = apply(mdl, rows[r]); px += o[0]; py += o[1]; });
          err += Math.hypot(px / q.idx.length - pts[gi].target[0], py / q.idx.length - pts[gi].target[1]); cnt++;
        }
        const e = err / Math.max(1, cnt); if (!best || e < best.e) best = { e, L };
      }
      lam = best.L; loo = best.e;
    }
    const m = solve(stAll, sAll, lam); if (!m) return null;
    return { mu: Array.from(mu), sd: Array.from(sd), W: Array.from(m.W), c: m.c, lam, loo, patch: withPatch, geoN: nGeo, mode: opts.mode || 'both', shift: [0, 0], n: pts.length };
  }
  function apply(m, x) {
    const p = m.mu.length; let a = m.c[0], b = m.c[1];
    for (let i = 0; i < p; i++) { const z = (x[i] - m.mu[i]) / m.sd[i]; a += z * m.W[i * 2]; b += z * m.W[i * 2 + 1]; }
    return [a + (m.shift ? m.shift[0] : 0), b + (m.shift ? m.shift[1] : 0)];
  }
  /** Gaze on the screen (fractions) for a feature vector, or null; a model fitted without the eye pictures ignores them. */
  function predict(m, x) {
    if (!m || !x) return null;
    if (m.patch) return x.length >= m.mu.length ? apply(m, x) : null;
    return apply(m, x.length > m.geoN ? x.slice(0, m.geoN) : x);
  }

  /* ---------------------------------------------------------------- the check dots: leave it, shift it, or refit with them */
  /**
   * model: the fitted model; pts: the calibration dots ({ target, frames } or stored { target, mean }); chk: check dots { target, frames, distMm }.
   * Each choice is judged by how well it predicts a check dot it was not given; a correction that only fits the noise is not taken.
   * -> { model, kind: 'none' | 'shift' | 'refit', loo (degrees) }
   */
  function refine(model, pts, chk, sm) {
    const deg = (p, t, d) => CalMath.angDeg((p[0] - t[0]) * sm[0], (p[1] - t[1]) * sm[1], d || 600);
    const meanPred = (m, c) => { const ps = c.frames.map(f => predict(m, f)); return [CalMath.mean(ps.map(q => q[0])), CalMath.mean(ps.map(q => q[1]))]; };
    const withShift = (m, d) => Object.assign({}, m, { shift: [(m.shift ? m.shift[0] : 0) + d[0], (m.shift ? m.shift[1] : 0) + d[1]] });
    const shiftFor = (m, list) => { const r = list.map(c => { const p = meanPred(m, c); return [c.target[0] - p[0], c.target[1] - p[1]]; }); return [CalMath.mean(r.map(v => v[0])), CalMath.mean(r.map(v => v[1]))]; };
    // a refit uses each dot's average (the kept calibration is stored that way), so old and new dots count equally
    const avgOf = fs => { const k = fs[0].length, a = new Array(k).fill(0); fs.forEach(f => { for (let i = 0; i < k; i++) a[i] += f[i] / fs.length; }); return a; };
    const asPts = list => list.filter(c => (c.frames && c.frames.length) || c.mean).map(c => ({ target: c.target, frames: [c.mean || avgOf(c.frames)] }));
    const refitWith = list => fit([...asPts(pts), ...asPts(list)], { lam: model.lam, mode: model.mode });
    if (chk.length < 3) return { model, kind: 'none', loo: null };
    const errs = { none: [], shift: [], refit: [] };
    chk.forEach((c, i) => {
      const rest = chk.filter((_, j) => j !== i);
      errs.none.push(deg(meanPred(model, c), c.target, c.distMm));
      errs.shift.push(deg(meanPred(withShift(model, shiftFor(model, rest)), c), c.target, c.distMm));
      const r = refitWith(rest); errs.refit.push(r ? deg(meanPred(r, c), c.target, c.distMm) : 99);
    });
    const m = k => CalMath.mean(errs[k]); let kind = 'none';
    if (m('shift') < m('none') * 0.92) kind = 'shift';
    if (m('refit') < m(kind) * 0.92) kind = 'refit';
    const out = kind === 'none' ? model : kind === 'shift' ? withShift(model, shiftFor(model, chk)) : (refitWith(chk) || model);
    return { model: out, kind, loo: m(kind) };
  }

  /* ---------------------------------------------------------------- what is kept between visits */
  /** The calibration dots as compact averages (enough to refit with later check dots), rounded. */
  function keepSamples(pts) {
    return pts.filter(p => p.frames && p.frames.length).map(p => {
      const n = p.frames.length, k = p.frames[0].length, mean = new Array(k).fill(0);
      p.frames.forEach(f => { for (let i = 0; i < k; i++) mean[i] += f[i] / n; });
      return { target: p.target, mean: mean.map(v => Math.round(v * 1e4) / 1e4), n };
    });
  }
  const restoreSamples = kept => (kept || []).map(p => ({ target: p.target, frames: [p.mean] }));

  /** Where the head was at calibration, to tell later when it has moved away (the "virtual chin rest"). */
  const refOf = fr => ({ yaw: fr.head.yaw, pitch: fr.head.pitch, roll: fr.head.roll, ex: (fr.eyeR[0] + fr.eyeL[0]) / 2, ey: (fr.eyeR[1] + fr.eyeL[1]) / 2, iod: fr.iod, dist: fr.distMm });
  function drift(ref, fr) {
    const dAng = Math.max(Math.abs(fr.head.yaw - ref.yaw), Math.abs(fr.head.pitch - ref.pitch)) * 180 / Math.PI;
    const dPos = Math.hypot((fr.eyeR[0] + fr.eyeL[0]) / 2 - ref.ex, (fr.eyeR[1] + fr.eyeL[1]) / 2 - ref.ey);
    const dDist = ref.dist && fr.distMm ? Math.abs(fr.distMm - ref.dist) / ref.dist : 0;
    return { deg: dAng, pos: dPos, dist: dDist, far: dAng > 10 || dPos > 0.12 || dDist > 0.18 };
  }

  /**
   * Has the gaze landed? During a jump to a new dot the irises move by ~0.002 eye-to-eye distances per degree (measured), then hold still.
   * Steady: the average iris position over the last ~150 ms matches the ~150 ms before it (within ~2° worth: averages, so camera noise
   * does not hide a real stop). Jump: once settled, the last few frames have moved more than ~5° worth from where it settled.
   */
  function createSettle() {
    let buf = [], anchor = null;
    const key = (fr, mode) => { const s = mode === 'left' ? ['L'] : mode === 'right' ? ['R'] : ['R', 'L']; let x = 0, y = 0; s.forEach(k => { x += fr.eyes[k].ix; y += fr.eyes[k].iy; }); return [x / s.length, 2 * y / s.length]; };   // vertical moves half as far
    const avg = list => [CalMath.mean(list.map(b => b.p[0])), CalMath.mean(list.map(b => b.p[1]))];
    return {
      feed(t, fr, mode) {
        const p = key(fr, mode); buf.push({ t, p }); while (buf.length && t - buf[0].t > 320) buf.shift();
        if (buf.length < 6 || t - buf[0].t < 220) return { steady: false, jump: false };
        const mid = buf[0].t + (t - buf[0].t) / 2, a = avg(buf.filter(b => b.t < mid)), b = avg(buf.filter(b => b.t >= mid));
        // a real camera's iris landmarks jitter more than the test photos: scale the limits by the noise actually measured in this window
        const half = buf.length / 2, sd = Math.sqrt(buf.reduce((s, q) => { const c = q.t < mid ? a : b; return s + (q.p[0] - c[0]) ** 2 + (q.p[1] - c[1]) ** 2; }, 0) / buf.length);
        const steady = Math.hypot(a[0] - b[0], a[1] - b[1]) < Math.max(0.0045, Math.min(0.02, 2.5 * sd * Math.SQRT2 / Math.sqrt(half)));
        let jump = false;
        if (anchor) { const r = avg(buf.slice(-3)); jump = Math.hypot(r[0] - anchor[0], r[1] - anchor[1]) > Math.max(0.012, Math.min(0.04, 4 * sd)); }
        if (steady && !anchor) anchor = avg(buf);
        return { steady, jump };
      },
      reset() { buf = []; anchor = null; },
    };
  }

  root.WebcamModel = { KEEP, IX, PATCH, frame, vector, fit, predict, refine, keepSamples, restoreSamples, refOf, drift, createSettle, geoN, _t: { prepPatch, apply, setPatchWeight: w => { PATCH_W = w; } } };
})(typeof window !== 'undefined' ? window : this);
