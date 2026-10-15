/* webcam-worker.js — runs MediaPipe Face Landmarker (vendor/mediapipe) off the page's main thread, so the canvas and clicks stay smooth.
 * Started by js/webcam-gaze.js as a module worker. Messages in:  { init: { base, keep, delegate? } }   then   { frame: ImageBitmap, ts }
 *                                                   out: { ready, delegate } | { error }   then   { ts, face: { lm, M, bs, pR, pL } | null, ms }   (and { delegate: 'CPU' } if it switches)
 * lm: the landmarks the gaze model uses (WebcamModel.KEEP order) as [x, y, z] (fractions of the image), M: the 4x4 face pose (column-major,
 * centimetres, camera space), bs: the 52 blendshape scores.
 */
let fl = null, keep = null;

// MediaPipe loads its wasm runtime with importScripts, which a module worker does not have; it then asks self.import, else import(), and
// import() would keep the runtime's ModuleFactory to itself. Running the runtime as a plain script makes ModuleFactory global, as it expects.
self.import = async url => { const r = await fetch(url); if (!r.ok) throw new Error('cannot load ' + url); (0, eval)(await r.text() + '\n//# sourceURL=' + url); };

let delegate = null, make = null, times = [], switching = false;
async function init(base, want) {
  const { FaceLandmarker, FilesetResolver } = await import(base + 'vision_bundle.mjs');
  const fileset = await FilesetResolver.forVisionTasks(base + 'wasm');
  const opts = d => ({ baseOptions: { modelAssetPath: base + 'face_landmarker.task', delegate: d }, runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
  make = d => FaceLandmarker.createFromOptions(fileset, opts(d));
  delegate = want === 'CPU' ? 'CPU' : 'GPU';
  try { fl = await make(delegate); }
  catch (_) { delegate = 'CPU'; fl = await make('CPU'); }        // no WebGL in this worker: the CPU is fine at webcam rates
  return delegate;
}
/** The graphics card is normally fastest; if this one is slow (software graphics, an old laptop), the CPU takes over. */
async function maybeSwitch(ms) {
  if (delegate !== 'GPU' || switching) return;
  times.push(ms); if (times.length < 40) return;                // the first frames include warming up
  const recent = times.slice(10).sort((a, b) => a - b), med = recent[recent.length >> 1]; times = [];
  if (med < 45) { delegate = 'GPU-ok'; return; }
  switching = true;
  try { const cpu = await make('CPU'); const old = fl; fl = cpu; delegate = 'CPU'; try { old.close(); } catch (_) { /* ignore */ } self.postMessage({ delegate: 'CPU', switched: med }); }
  catch (_) { delegate = 'GPU-ok'; }
  switching = false;
}

/* Each eye cut out as a 48 x 24 grey picture, turned with the head's roll and scaled to the eye's width (1.5 eye widths across,
   0.75 high), exactly as in the evaluation that chose the features. */
const PW = 48, PH = 24, I = { rOut: 0, rIn: 8, lOut: 24, lIn: 16 };     // positions of landmarks 33, 133, 263, 362 in the kept list
let pc = null, pg = null;
function patch(bmp, lm, iOut, iIn, axis) {
  const W = bmp.width, H = bmp.height, a = [lm[iOut * 3] * W, lm[iOut * 3 + 1] * H], b = [lm[iIn * 3] * W, lm[iIn * 3 + 1] * H];
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], w = Math.hypot(a[0] - b[0], a[1] - b[1]); if (!(w > 3)) return null;
  if (!pc) { pc = new OffscreenCanvas(PW, PH); pg = pc.getContext('2d', { willReadFrequently: true }); }
  const u = axis, v = [-u[1], u[0]], sx = PW / (w * 1.5), sy = PH / (w * 0.75);
  pg.setTransform(1, 0, 0, 1, 0, 0); pg.fillStyle = '#000'; pg.fillRect(0, 0, PW, PH);
  pg.setTransform(u[0] * sx, v[0] * sy, u[1] * sx, v[1] * sy, -(c[0] * u[0] + c[1] * u[1]) * sx + PW / 2, -(c[0] * v[0] + c[1] * v[1]) * sy + PH / 2);
  pg.imageSmoothingQuality = 'high'; pg.drawImage(bmp, 0, 0);
  const d = pg.getImageData(0, 0, PW, PH).data, out = new Uint8Array(PW * PH);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return out;
}

let lastTs = 0;
self.onmessage = async e => {
  const m = e.data;
  if (m.init) {
    keep = m.init.keep;
    try { const d = await init(m.init.base, m.init.delegate); self.postMessage({ ready: true, delegate: d }); }
    catch (err) { self.postMessage({ error: String((err && err.message) || err) }); }
    return;
  }
  if (!m.frame) return;
  const bmp = m.frame;
  try {
    if (!fl) { self.postMessage({ ts: m.ts, face: null, ms: 0 }); return; }
    const t0 = performance.now(), ts = Math.max(m.ts, lastTs + 1); lastTs = ts;             // VIDEO mode needs rising timestamps
    const r = fl.detectForVideo(bmp, ts);
    let face = null;
    if (r.faceLandmarks && r.faceLandmarks.length) {
      const lm = r.faceLandmarks[0], out = new Float32Array(keep.length * 3);
      keep.forEach((k, i) => { const p = lm[k]; out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z; });
      const M = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0] ? Float32Array.from(r.facialTransformationMatrixes[0].data) : null;
      const bs = r.faceBlendshapes && r.faceBlendshapes[0] ? Float32Array.from(r.faceBlendshapes[0].categories, c => c.score) : null;
      // the axis from the right eye's centre to the left's (the head's roll), and both eye pictures
      const W = bmp.width, H = bmp.height, cx = (i, j) => [(out[i * 3] + out[j * 3]) / 2 * W, (out[i * 3 + 1] + out[j * 3 + 1]) / 2 * H];
      const cR = cx(I.rOut, I.rIn), cL = cx(I.lOut, I.lIn), n = Math.hypot(cL[0] - cR[0], cL[1] - cR[1]) || 1, axis = [(cL[0] - cR[0]) / n, (cL[1] - cR[1]) / n];
      let pR = null, pL = null; try { pR = patch(bmp, out, I.rOut, I.rIn, axis); pL = patch(bmp, out, I.lOut, I.lIn, axis); } catch (_) { /* no OffscreenCanvas: landmarks only */ }
      face = { lm: out, M, bs, pR, pL };
    }
    const ms = performance.now() - t0;
    self.postMessage({ ts: m.ts, face, ms, W: bmp.width, H: bmp.height });
    maybeSwitch(ms);
  } catch (err) {
    self.postMessage({ ts: m.ts, face: null, error: String((err && err.message) || err) });
  } finally { bmp.close(); }
};
