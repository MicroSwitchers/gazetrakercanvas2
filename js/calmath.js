/* Pure calibration math (no DOM). Gaze coordinates are normalised display units: x,y in 0..1 of the screen. */
const CalMath = (() => {
  const median = a => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = a => a.reduce((p, q) => p + q, 0) / a.length;
  const rad2deg = 180 / Math.PI;

  function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }
  function solve3(M, v) {
    const D = det3(M); if (!Number.isFinite(D) || Math.abs(D) < 1e-9) return null;
    return [0, 1, 2].map(c => det3(M.map((r, i) => r.map((x, j) => (j === c ? v[i] : x)))) / D);
  }
  /** Least-squares affine map raw->target. Returns [a,b,c,d,e,f]: x' = a x + b y + c, y' = d x + e y + f; null if degenerate. */
  function fitAffine(meas, targets) {
    if (meas.length < 3 || meas.length !== targets.length) return null;
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    meas.forEach(([x, y], i) => { const r = [x, y, 1]; for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; bx[a] += r[a] * targets[i][0]; by[a] += r[a] * targets[i][1]; } });
    const px = solve3(M, bx), py = solve3(M, by);
    return px && py ? [...px, ...py] : null;
  }
  const apply = (A, x, y) => (A ? [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]] : [x, y]);

  /** Angle in degrees subtended by an on-screen offset (mm) seen from distMm. */
  const angDeg = (dxMm, dyMm, distMm) => Math.atan(Math.hypot(dxMm, dyMm) / distMm) * rad2deg;

  /** Robust centre of a cloud of samples [[x,y]..]: drops points farther than 3x the median distance, then averages. */
  function summarize(samples) {
    if (!samples.length) return null;
    let cx = median(samples.map(s => s[0])), cy = median(samples.map(s => s[1]));
    const d = samples.map(s => Math.hypot(s[0] - cx, s[1] - cy)), lim = Math.max(3 * median(d), 1e-4);
    const kept = samples.filter((s, i) => d[i] <= lim);
    return { x: mean(kept.map(s => s[0])), y: mean(kept.map(s => s[1])), n: kept.length, dropped: samples.length - kept.length, kept };
  }

  /** Precision as RMS of successive-sample angular distances (the usual eye-tracker 'RMS-S2S'), in degrees. */
  function rmsS2S(samples, screenMm, distMm) {
    if (samples.length < 3) return NaN;
    let acc = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = angDeg((samples[i][0] - samples[i - 1][0]) * screenMm[0], (samples[i][1] - samples[i - 1][1]) * screenMm[1], distMm);
      acc += a * a;
    }
    return Math.sqrt(acc / (samples.length - 1));
  }

  /** Forgiving heuristic labels for rough, functional (non-clinical) use; not a published standard. */
  function grade(accDeg) {
    if (!Number.isFinite(accDeg)) return { label: 'n/a', level: 'bad' };
    if (accDeg < 1.0) return { label: 'Excellent', level: 'good' };
    if (accDeg < 2.0) return { label: 'Good', level: 'good' };
    if (accDeg < 3.5) return { label: 'Fair', level: 'warn' };
    return { label: 'Rough', level: 'warn' };
  }

  /** Eye midpoint / inter-eye distance / roll from per-eye origins ([x,y,z] mm or null). */
  function eyePose(eL, eR) {
    if (!eL && !eR) return null;
    if (eL && eR) {
      return { mid: [(eL[0] + eR[0]) / 2, (eL[1] + eR[1]) / 2, (eL[2] + eR[2]) / 2], ipd: Math.hypot(eR[0] - eL[0], eR[1] - eL[1], eR[2] - eL[2]),
               roll: Math.atan2(eR[1] - eL[1], eR[0] - eL[0]) * rad2deg, both: true };
    }
    return { mid: eL || eR, ipd: null, roll: null, both: false };
  }

  return { median, mean, fitAffine, apply, angDeg, summarize, rmsS2S, grade, eyePose };
})();
if (typeof module !== 'undefined') module.exports = CalMath;
