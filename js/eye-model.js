/* eye-model.js — each eye's own gaze, choosing or blending between the eyes, and spotting a steady look.
 * Pure maths (no DOM), so it can be tested on its own. Screen positions are fractions 0..1 of the display; times are milliseconds.
 *
 * Why per eye: when the eyes are not aligned (strabismus, or one eye wandering), the tracker's combined gaze is the average of two
 * different lines of sight and lands between them, on neither. The published approach is to calibrate each eye on its own (the other
 * eye covered), then use whichever eye is actually looking at the target, rather than the average:
 *   - calibrating each eye separately is what lets a deviating eye be measured at all (patent US 11793403 / US 12419513 describe it);
 *   - choosing the eye with the better accuracy, or the one on target, avoids the extra error of averaging (Hooge et al. 2019, Behav Res Methods).
 *
 *   const det = EyeModel.createDetector();           // finds the fields that carry each eye's gaze, from the tracker's own messages
 *   const fus = EyeModel.createFusion({ screenMm, distMm, target });   // 'either eye': slides between the eyes as they take turns
 *   const fix = EyeModel.createFixation();           // is the gaze resting on one spot long enough to count as looking at it?
 */
(function (root) {
  'use strict';
  const rad2deg = 180 / Math.PI;

  /* ---------------------------------------------------------------- 1. where each eye's gaze lives in the tracker's message */
  // Measured on an IR tracker with both eyes in view: 0x05 is the LEFT eye's gaze point on the display and 0x0B the RIGHT's (0..1 of the
  // screen), and 0x20 is exactly their average; the combined gaze the app uses (0x1C) is a filtered version of that average. The two
  // eyes can sit far apart (0.17 of the screen on a person with a wandering eye), so a field is judged by whether the AVERAGE of the
  // pair matches the combined gaze, never by whether each eye does. 0x04 / 0x0A are the same two gaze points as 3-D points in mm.
  const CANDIDATES = [
    { id: 'display-05-0B', L: 0x05, R: 0x0B, dim: 2 },
    { id: 'plane-04-0A', L: 0x04, R: 0x0A, dim: 3 },
  ];
  const AVERAGE_KEY = 0x20;           // the tracker's own average of the two eyes (a second reference, when present)
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** comps (normalised numbers) of a candidate field -> [x, y] on the display, or null when the tracker marks it invalid. */
  function toDisplay(comps, dim, proj) {
    if (!comps || comps.length < dim) return null;
    if (dim === 2) {
      const x = comps[0], y = comps[1];
      if (!finite(x) || !finite(y) || (x === -1 && y === -1) || (x === 0 && y === 0)) return null;
      return [x, y];
    }
    if (!comps.slice(0, 3).every(finite) || comps.slice(0, 3).every(c => c === 0) || !proj) return null;   // a 3-D point on the screen plane (mm)
    const p = proj(comps);
    return p && finite(p[0]) && finite(p[1]) ? p : null;
  }

  /** Projects a point in the tracker's frame (mm) onto the display: [x, y] as 0..1 of its width and height. corners = [topLeft, topRight, bottomLeft]. */
  function planeProjector(corners) {
    const [tl, tr, bl] = corners, u = tr.map((v, i) => v - tl[i]), w = bl.map((v, i) => v - tl[i]);
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], ww = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
    return p => { const d = [p[0] - tl[0], p[1] - tl[1], p[2] - tl[2]]; return [(d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / uu, (d[0] * w[0] + d[1] * w[1] + d[2] * w[2]) / ww]; };
  }

  function createDetector() {
    const acc = CANDIDATES.map(c => ({ c, nB: 0, errB: 0, spread: 0, nS: 0, errS: 0 }));
    let found = null, seen = 0;
    const best = (p, refs) => Math.min(...refs.map(r => dist2(p, r)));
    return {
      /** pt(key) -> normalised comps of that field or null; combined = [x, y] or null; proj for the 3-D candidates. Call with every message. */
      feed(pt, combined, proj, leftTracked, rightTracked) {
        if (found || !combined) return;
        const avg = toDisplay(pt(AVERAGE_KEY), 2), refs = avg ? [combined, avg] : [combined];
        for (const a of acc) {
          const l = leftTracked ? toDisplay(pt(a.c.L), a.c.dim, proj) : null, r = rightTracked ? toDisplay(pt(a.c.R), a.c.dim, proj) : null;
          if (l && r) { a.nB++; a.errB += best([(l[0] + r[0]) / 2, (l[1] + r[1]) / 2], refs); a.spread += dist2(l, r); }
          else if (l || r) { a.nS++; a.errS += best(l || r, refs); }                // one eye only (the other covered): the combined gaze IS that eye
        }
        seen++;
        const ok = acc.filter(a => (a.nB >= 20 && a.errB / a.nB < 0.07 && a.spread / a.nB > 1e-5) || (a.nB < 20 && a.nS >= 40 && a.errS / a.nS < 0.12));   // a copy of the combined gaze would show no spread
        if (ok.length) { ok.sort((p, q) => (p.nB ? p.errB / p.nB : 1) - (q.nB ? q.errB / q.nB : 1)); found = ok[0].c; }
      },
      get found() { return found; },
      get seen() { return seen; },
      /** Both eyes' gaze points on the display, [x, y] or null each. */
      read(pt, proj, leftTracked, rightTracked) {
        if (!found) return null;
        return { L: leftTracked ? toDisplay(pt(found.L), found.dim, proj) : null, R: rightTracked ? toDisplay(pt(found.R), found.dim, proj) : null };
      },
      reset() { found = null; seen = 0; acc.forEach(a => { a.nB = a.errB = a.spread = a.nS = a.errS = 0; }); },
      _acc: acc,
    };
  }

  /* ---------------------------------------------------------------- 2. 'either eye': follow whichever eye is looking, and glide between them */
  /**
   * cfg: screenMm () => [w, h]; distMm () => eye-to-screen distance; target (x, y) => 0..1 how much that spot looks like a target (optional);
   *      quality { L, R } 0..1 how well each eye calibrated (optional).
   * update(t, pL, pR) -> { x, y, eye: 'L' | 'R' | 'both', w } with w the weight on the left eye (1 = left only, 0 = right only).
   */
  function createFusion(cfg) {
    const o = Object.assign({ agreeDeg: 2.0, switchMs: 110, tauMs: 130, window: 320, speed0: 18, sticky: 0.3, targetWeight: 1.0 }, cfg || {});
    const S = { w: 0.5, side: 'L', cand: null, candAt: 0, last: 0, hist: { L: [], R: [] }, x: null, y: null, eye: 'both' };
    const deg = (a, b) => { const mm = o.screenMm ? o.screenMm() : [300, 170], d = (o.distMm ? o.distMm() : 600) || 600; return Math.atan(Math.hypot((a[0] - b[0]) * mm[0], (a[1] - b[1]) * mm[1]) / d) * rad2deg; };
    function push(side, t, p) { const h = S.hist[side]; h.push({ t, p }); while (h.length && t - h[0].t > o.window) h.shift(); }
    function steadiness(side) {                                       // 0..1: a fixating eye is slow and still; one on its way elsewhere, or drifting, is not
      const h = S.hist[side]; if (h.length < 4) return 0.5;           // not enough to say: neutral
      const first = h[0], lastp = h[h.length - 1], dt = Math.max(30, lastp.t - first.t);
      const speed = deg(first.p, lastp.p) / (dt / 1000);
      let path = 0; for (let i = 1; i < h.length; i++) path += deg(h[i - 1].p, h[i].p);
      return 1 / (1 + speed / o.speed0 + (path / (dt / 1000)) / (o.speed0 * 4));
    }
    function score(side, p) {
      let s = 0.55 * steadiness(side);
      s += o.targetWeight * (o.target ? o.target(p[0], p[1]) : 0.5);
      if (o.quality && o.quality[side] != null) s += 0.15 * o.quality[side];
      if (S.side === side) s += o.sticky;                              // stay with the current eye unless the other is clearly better
      return s;
    }
    return {
      update(t, pL, pR) {
        const dt = S.last ? Math.min(100, t - S.last) : 16; S.last = t;
        if (pL) push('L', t, pL); else S.hist.L.length = 0;
        if (pR) push('R', t, pR); else S.hist.R.length = 0;
        let target, fast = false;
        if (pL && pR) {
          if (deg(pL, pR) <= o.agreeDeg) { target = 0.5; S.cand = null; }          // eyes agree: the middle of the two
          else {
            const sL = score('L', pL), sR = score('R', pR), win = sL >= sR ? 'L' : 'R';
            const margin = Math.min(1, Math.abs(sL - sR) / 1.2);                  // 0 = a toss-up, 1 = one eye is clearly the one on target
            const need = Math.max(25, o.switchMs * (1 - margin));                  // clear evidence switches quickly, weak evidence has to persist
            if (win !== S.side) {
              if (S.cand !== win) { S.cand = win; S.candAt = t; }
              else if (t - S.candAt >= need) { S.side = win; S.cand = null; }
            } else S.cand = null;
            target = S.side === 'L' ? 1 : 0;
          }
        } else if (pL || pR) { target = pL ? 1 : 0; S.side = pL ? 'L' : 'R'; S.cand = null; fast = true; }
        else { return { x: null, y: null, eye: null, w: S.w }; }
        const tau = fast ? o.tauMs * 0.6 : o.tauMs;
        S.w += (target - S.w) * (1 - Math.exp(-dt / tau));
        const w = pL && pR ? S.w : (pL ? 1 : 0);
        const x = pL && pR ? w * pL[0] + (1 - w) * pR[0] : (pL || pR)[0], y = pL && pR ? w * pL[1] + (1 - w) * pR[1] : (pL || pR)[1];
        S.x = x; S.y = y; S.eye = pL && pR ? (S.w > 0.8 ? 'L' : S.w < 0.2 ? 'R' : 'both') : (pL ? 'L' : 'R');
        return { x, y, eye: S.eye, w: S.w };
      },
      reset() { S.w = 0.5; S.side = 'L'; S.cand = null; S.last = 0; S.hist.L.length = S.hist.R.length = 0; },
      get state() { return S; },
    };
  }

  /* ---------------------------------------------------------------- 3. has the person looked at it? */
  /** Feed [x, y] samples (null when the eyes are lost). `steady` becomes true once the last `ms` of samples sit within `radius` of their centre. */
  function createFixation(cfg) {
    const o = Object.assign({ ms: 260, radius: 0.03, minSamples: 8, gapMs: 120 }, cfg || {});
    let buf = [];
    return {
      feed(t, p) {
        if (!p) { if (buf.length && t - buf[buf.length - 1].t > o.gapMs) buf = []; return this.state(); }
        if (buf.length && t - buf[buf.length - 1].t > o.gapMs) buf = [];
        buf.push({ t, p }); while (buf.length && t - buf[0].t > o.ms) buf.shift();
        return this.state();
      },
      state() {
        if (buf.length < o.minSamples || buf[buf.length - 1].t - buf[0].t < o.ms * 0.8) return { steady: false, n: buf.length, x: null, y: null };
        let cx = 0, cy = 0; buf.forEach(s => { cx += s.p[0]; cy += s.p[1]; }); cx /= buf.length; cy /= buf.length;
        const spread = Math.max(...buf.map(s => Math.hypot(s.p[0] - cx, s.p[1] - cy)));
        return { steady: spread <= o.radius, n: buf.length, x: cx, y: cy, spread };
      },
      reset() { buf = []; },
    };
  }

  /* ---------------------------------------------------------------- 4. smoothing (One Euro filter) */
  // Each eye's own gaze point is about 3-5x jumpier from sample to sample than the tracker's filtered combined gaze (measured: 0.18-0.31 deg
  // against 0.06 deg), and arrives at only ~33 samples a second. The One Euro filter smooths hard while the eye is still and hardly at all
  // while it is moving, so a fixation is steady and a saccade is not delayed. (Casiez, Roussel and Vogel 2012.)
  function createOneEuro(cfg) {
    const o = Object.assign({ minCutoff: 1.2, beta: 1.5, dCutoff: 1.5 }, cfg || {});    // Hz, Hz per (screen / s), Hz; positions are fractions of the screen
    let xh = null, dxh = 0, tl = 0;
    const alpha = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut) / dt);
    return {
      filter(t, x) {
        if (xh === null) { xh = x; tl = t; dxh = 0; return x; }
        const dt = Math.min(0.2, Math.max(0.004, (t - tl) / 1000)); tl = t;
        dxh += alpha(o.dCutoff, dt) * ((x - xh) / dt - dxh);
        xh += alpha(o.minCutoff + o.beta * Math.abs(dxh), dt) * (x - xh);
        return xh;
      },
      reset() { xh = null; dxh = 0; },
    };
  }
  /** Smooths a stream of [x, y] points (null when the eye is lost; a gap of 200 ms or more starts the filter afresh). */
  function createPointFilter(cfg) {
    const fx = createOneEuro(cfg), fy = createOneEuro(cfg); let last = 0;
    return {
      step(t, p) {
        if (!p) { if (last && t - last > 200) { fx.reset(); fy.reset(); last = 0; } return null; }
        last = t; return [fx.filter(t, p[0]), fy.filter(t, p[1])];
      },
      reset() { fx.reset(); fy.reset(); last = 0; },
    };
  }

  const api = { CANDIDATES, createOneEuro, createPointFilter, createDetector, createFusion, createFixation, planeProjector, toDisplay };
  root.EyeModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
