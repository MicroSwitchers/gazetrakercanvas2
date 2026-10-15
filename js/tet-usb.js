/* tet-usb.js — talks to an IR tracker (USB 2104:0313) straight from the browser with WebUSB.
 * No tracker software and no helper program. Chrome / Edge only (Firefox and Safari have no WebUSB); the page must be https or localhost.
 *
 * This is a JavaScript port of the Gaze Assessment Tools' Python tracker reader. The wire format comes from public reverse-engineering
 * of the vendor protocol, replayed from data/tet-init.bin (the captured start-up sequence).
 *
 *   host->dev : 00000000 | LE u32 body_len | BE u32 words: 0x51, seq, 0, cmd, 0, payload_len | payload
 *   dev->host : 01000000 | LE u32 total_len (incl. the 8-byte prefix) | marker (0x52 response, 0x53 stream, 0x4e notification) ...
 *
 *   const t = TetUSB.create({ displayMm: [293, 165], onGaze: g => {...}, onStatus: (state, text) => {...}, initUrl: 'data/tet-init.bin' });
 *   await t.connect();      // must be called from a click the first time (the browser shows its device chooser)
 *   t.disconnect();
 */
(function (root) {
  'use strict';
  const VID = 0x2104, PID = 0x0313, IFACE = 0, EP_IN = 3, EP_OUT = 5;      // 0x83 / 0x05 in libusb terms
  const M_CMD = 0x51, M_RESP = 0x52, M_STREAM = 0x53;
  const STREAM_GAZE = 0x500, STREAM_IMAGE = 0x50E, IMG_PIXELS = 280 * 280, CMD_STREAM_START = 1220, CMD_SET_DISPLAY = 1440, CMD_UPLOAD_CAL = 1110;
  /* The tracker's own (on-device) calibration. Op codes and payloads from public reverse-engineering notes (calibration, select-eyes, op catalogue),
     every one answered by this tracker in a hardware check. The eye argument is a mask: 1 left, 2 right, 3 both. */
  const CAL = { start: 1010, stop: 1020, addPoint: 1030, clear: 1060, compute: 1070, discard: 1080, retrieve: 1100, apply: 1110, setEye: 3160, getEye: 3170 };
  const OUT_CHUNK = 4095;
  const KEY_MARK = 0x00020BB9, T_U32 = 0x02, T_FIX32 = 0x04, T_FIELD = 0x05;
  const K = { ts: 0x01, gaze: 0x1C, gazeOk: 0x1B, frame: 0x14 };
  const EYES = { left: { status: 0x07, pupil: 0x06, origin: 0x22, originOk: 0x21 }, right: { status: 0x0D, pupil: 0x0C, origin: 0x24, originOk: 0x23 } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const platform = () => (((navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent || '').match(/Windows|Android|CrOS|Linux|Mac/i) || [''])[0].toLowerCase();
  /** What to tell somebody whose browser was refused the tracker, for their computer. */
  function openHelp() {
    const p = platform(), other = ' Also close any other tab or program using the tracker.';
    if (p === 'windows') return 'on Windows the tracker is held by its own driver software (the maker\'s settings app and its background service), and Chrome can only use devices on the WinUSB driver. Quit that app and stop its service, or install WinUSB for the device (for example with Zadig), then unplug and replug it.' + other;
    if (p === 'linux') return 'on Linux the browser needs permission to use the tracker. In a terminal in this folder run:  sudo ./linux/install-udev-rule.sh  then unplug the tracker and plug it back in. Use Google Chrome, Edge or Chromium installed from a .deb (a Snap or Flatpak browser cannot see USB devices).' + other;
    return 'the browser could not take the tracker. Unplug it, plug it back in, and close any program that uses it.' + other;
  }

  /* ------------------------------------------------------------ bytes */
  const u32 = (n, le) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, !!le); return b; };
  const cat = parts => { let n = 0; parts.forEach(p => { n += p.length; }); const o = new Uint8Array(n); let i = 0; parts.forEach(p => { o.set(p, i); i += p.length; }); return o; };
  const beNum = b => { let v = 0; for (let i = 0; i < b.length; i++) v = v * 256 + b[i]; return v; };
  const fromHex = h => { const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

  function buildCommand(seq, cmd, payload) {
    payload = payload || new Uint8Array(0);
    const body = cat([u32(M_CMD), u32(seq), u32(0), u32(cmd), u32(0), u32(payload.length), payload]);
    return cat([u32(0), u32(body.length, true), body]);
  }
  const tlv = (t, v) => cat([Uint8Array.of(t), u32(v.length), v]);
  function streamCommand(seq, streamId, cmd) {
    // payload = 00 00, then TLVs (type u8, len BE u32, value): 0x02 -> stream id, 0x17 -> 0
    return buildCommand(seq, cmd || CMD_STREAM_START, cat([Uint8Array.of(0, 0), tlv(T_U32, u32(streamId)), tlv(0x17, u32(0))]));
  }

  /* ------------------------------------------------------------ display area (command 1440) */
  const FIELD_POINT3D = u32(0x00031F41);
  function fix64(mm) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(Math.round(mm * 1024 * 4294967296)), false); return b; }
  /** Screen corners (top-left, top-right, bottom-left) in the tracker frame, mm (x right, y up, z toward the user). */
  function displayPoints(wMm, hMm, tiltDeg, y0, z0, xOff) {
    tiltDeg = tiltDeg == null ? 20 : tiltDeg; y0 = y0 == null ? 10.267330169677734 : y0; z0 = z0 == null ? -3.100020170211792 : z0; xOff = xOff || 0;
    const c = Math.cos(tiltDeg * Math.PI / 180), s = Math.sin(tiltDeg * Math.PI / 180), l = xOff - wMm / 2, r = xOff + wMm / 2;
    return [[l, y0 + hMm * c, z0 + hMm * s], [r, y0 + hMm * c, z0 + hMm * s], [l, y0, z0]];
  }
  function displayAreaPacket(seq, points) {
    const parts = [Uint8Array.of(0, 0)];
    points.forEach(p => { parts.push(tlv(T_FIELD, FIELD_POINT3D)); p.forEach(v => parts.push(tlv(T_FIX32, fix64(v)))); });
    parts.push(tlv(T_FIELD, Uint8Array.of(0, 1, 1, 0)), tlv(T_U32, u32(0x3039)));
    return buildCommand(seq, CMD_SET_DISPLAY, cat(parts));
  }

  /* ------------------------------------------------------------ parsing / decoding */
  function parseMessage(raw) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw.length >= 32) return { raw, marker: dv.getUint32(8), seq: dv.getUint32(12), status: dv.getUint32(16), id: dv.getUint32(20), error: dv.getUint32(24), plen: dv.getUint32(28), payload: raw.subarray(32) };
    return { raw, marker: raw.length >= 12 ? dv.getUint32(8) : 0, seq: 0, status: 0, id: 0, error: 0, plen: 0, payload: raw.subarray(Math.min(32, raw.length)) };
  }
  function tlvs(buf) {
    const out = []; let i = 0;
    while (i + 5 <= buf.length) {
      const n = new DataView(buf.buffer, buf.byteOffset + i + 1, 4).getUint32(0);
      out.push([buf[i], buf.subarray(i + 5, i + 5 + n)]); i += 5 + n;
    }
    return out;
  }
  const isKeyMark = v => v.length === 4 && new DataView(v.buffer, v.byteOffset, 4).getUint32(0) === KEY_MARK;
  const fixRaw = v => Number(new DataView(v.buffer, v.byteOffset, 8).getBigInt64(0, false));
  /** payload -> Map key -> number | {field, comps:[raw 32.32 ints]} */
  function keyedFields(payload) {
    const out = new Map(), ents = tlvs(payload.subarray(2)); let i = 0;
    while (i < ents.length) {
      const [t, v] = ents[i];
      if (t === T_FIELD && isKeyMark(v) && i + 2 < ents.length) {
        const key = beNum(ents[i + 1][1]), t2 = ents[i + 2][0], v2 = ents[i + 2][1]; i += 3;
        if (t2 === T_FIELD) {
          const comps = [];
          while (i < ents.length && ents[i][0] === T_FIX32 && ents[i][1].length === 8) { comps.push(fixRaw(ents[i][1])); i++; }
          out.set(key, { field: beNum(v2), comps });
        } else out.set(key, beNum(v2));
      } else i++;
    }
    return out;
  }
  const norm = raw => raw / 4294967296 / 1024;               // 32.32 fixed, then x1024 scale
  /** Stream-0x500 message -> { ts_us, frame, valid, x, y (0..1 of the display), eyes:{left,right} } */
  function decodeGaze(msg) {
    const f = keyedFields(msg.payload), g = f.get(K.gaze);
    const d = { ts_us: f.has(K.ts) ? f.get(K.ts) : null, frame: f.has(K.frame) ? f.get(K.frame) : null, valid: f.get(K.gazeOk) === 1, x: null, y: null, eyes: {} };
    if (g && typeof g === 'object' && g.comps.length >= 2) { d.x = norm(g.comps[0]); d.y = norm(g.comps[1]); }
    // any keyed point of the message as plain numbers (mm or display fractions), for the per-eye gaze detector in eye-model.js
    d.pt = key => { const v = f.get(key); return v && typeof v === 'object' && v.comps ? v.comps.map(norm) : null; };
    for (const name of Object.keys(EYES)) {
      const k = EYES[name], o = f.get(k.origin), p = f.get(k.pupil);
      d.eyes[name] = { tracked: f.get(k.status) === 0, pupil_mm: typeof p === 'number' ? p / 65536 : null,
        origin_mm: o && typeof o === 'object' ? o.comps.map(norm) : null, origin_ok: f.get(k.originOk) === 1 };
    }
    return d;
  }

  /**
   * Splits the bytes from the tracker into whole messages; feed() once per USB read. A big reply (the ~650 KB calibration) comes over many
   * reads, and some start with their own 8-byte envelope that is not part of the message: it is dropped when it fits what the message
   * still needs. A message's size is its TTP header's payload length, not the envelope's length field (which for a big reply describes a
   * run of reads). Same rules as the public open-source parsers; checked against reads recorded from this tracker.
   */
  function createParser(onMessage) {
    const isIn = (b, i) => b[i] === 1 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 0;
    const le32 = (b, i) => new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0, true), be32 = (b, i) => new DataView(b.buffer, b.byteOffset + i, 4).getUint32(0);
    let buf = new Uint8Array(0);
    return {
      feed(chunk) {
        if (buf.length >= 32 && chunk.length >= 8 && isIn(chunk, 0)) {
          const need = 32 + be32(buf, 28) - buf.length, el = le32(chunk, 4);
          if (need > 0 && el > 8 && el - 8 <= need) chunk = chunk.subarray(8);
        }
        buf = buf.length ? cat([buf, chunk]) : chunk;
        for (;;) {
          if (buf.length < 8) return;
          if (!isIn(buf, 0) || le32(buf, 4) < 32) { buf = buf.subarray(1); continue; }   // resync
          if (buf.length < 32) return;
          const n = 32 + be32(buf, 28);
          if (n > (1 << 22)) { buf = buf.subarray(1); continue; }
          if (buf.length < n) return;
          const raw = buf.slice(0, n); buf = buf.subarray(n); onMessage(raw);
        }
      },
      reset() { buf = new Uint8Array(0); },
    };
  }
  /** A whole command as USB transfers: longer than 4095 bytes, it goes in 4095-byte pieces, each with its own envelope, exactly like the
   *  captured Windows start-up (data/tet-init.bin); a calibration sent in one piece is refused. */
  function chunkFrame(bytes) {
    if (bytes.length <= OUT_CHUNK) return [bytes];
    const first = bytes.slice(0, OUT_CHUNK); first.set(u32(OUT_CHUNK - 8, true), 4); const out = [first];
    for (let i = OUT_CHUNK; i < bytes.length;) { const part = bytes.subarray(i, i + OUT_CHUNK - 8); out.push(cat([u32(0), u32(part.length, true), part])); i += part.length; }
    return out;
  }

  /** Stream-0x50E message -> the 280x280 8-bit infrared camera picture (Uint8Array view), or null. */
  function imagePixels(payload) {
    for (const [t, v] of tlvs(payload.subarray(2))) {
      if (t === 0x15 && v.length > 4 && new DataView(v.buffer, v.byteOffset, 4).getUint32(0) === v.length - 4) return v.subarray(4);
    }
    return null;
  }

  /* ------------------------------------------------------------ the device */
  function create(opts) {
    const o = Object.assign({ displayMm: null, tiltDeg: 20, onGaze: null, onImage: null, images: false, wantImage: null, onStatus: null, onLive: null, initUrl: 'data/tet-init.bin', stallMs: 2500 }, opts || {});
    let dev = null, streamingLive = false, gen = 0, queue = [], waiter = null, running = false, initRows = null;
    const status = (state, text) => { try { o.onStatus && o.onStatus(state, text); } catch (e) { console.error('[tet] onStatus', e); } };
    const supported = () => !!(root.navigator && navigator.usb);

    async function loadInit() {
      if (initRows) return initRows;
      const r = await fetch(o.initUrl); if (!r.ok) throw new Error('cannot load ' + o.initUrl + ' (' + r.status + ')');
      const b = new Uint8Array(await r.arrayBuffer()), dv = new DataView(b.buffer), n = dv.getUint32(0, true); let p = 4; const rows = [];
      for (let i = 0; i < n; i++) { const len = dv.getUint32(p, true); p += 4; rows.push(b.subarray(p, p + len)); p += len; }
      return (initRows = rows);
    }

    /* message queue fed by the read pump; nextMsg(ms) resolves null on timeout */
    function push(m) { if (waiter) { const w = waiter; waiter = null; clearTimeout(w.t); w.res(m); } else queue.push(m); }
    function nextMsg(ms) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise(res => { waiter = { res, t: setTimeout(() => { waiter = null; res(null); }, ms) }; });
    }
    let readSize = 1 << 17;                                   // bytes asked for per read; smaller if the computer's USB controller turns out not to like big reads
    let parser = createParser(raw => push(parseMessage(raw)));
    const feed = chunk => parser.feed(chunk);
    async function pump(myGen) {
      while (myGen === gen && dev) {
        let r;
        try { r = await dev.transferIn(EP_IN, readSize); } catch (e) { if (myGen === gen) push({ error_: e }); return; }
        if (myGen !== gen) return;
        if (r.status === 'stall') { try { await dev.clearHalt('in', EP_IN); } catch (_) { /* ignore */ } continue; }
        if (r.data && r.data.byteLength) feed(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength).slice());
      }
    }
    const write = bytes => dev.transferOut(EP_OUT, bytes).then(r => { if (r.status !== 'ok') throw new Error('write ' + r.status); });
    async function writeFrame(bytes) { for (const t of chunkFrame(bytes)) await write(t); }
    /* requests while streaming: the stream loop hands replies over by sequence number */
    const pending = new Map(); let reqSeq = 1000;
    function request(cmd, payload, ms, what) {
      if (!dev || !streamingLive) return Promise.reject(new Error('the tracker is not streaming'));
      const s = reqSeq++; if (reqSeq > 0x7fffffff) reqSeq = 1000;
      return new Promise((res, rej) => {
        const t = setTimeout(() => { pending.delete(s); rej(new Error('no answer to ' + (what || 'command ' + cmd))); }, ms || 10000);
        pending.set(s, { res, rej, t, what: what || 'command ' + cmd });
        writeFrame(buildCommand(s, cmd, payload)).catch(e => { if (pending.delete(s)) { clearTimeout(t); rej(e); } });
      });
    }
    const failPending = e => { pending.forEach(p => { clearTimeout(p.t); p.rej(e); }); pending.clear(); };
    async function waitResp(wantSeq, what) {
      const end = performance.now() + 8000;
      for (;;) {
        const m = await nextMsg(Math.max(50, end - performance.now()));
        if (!m) throw new Error('no response to ' + what);
        if (m.error_) throw m.error_;
        if (m.marker === M_RESP && m.seq === wantSeq) return m;
      }
    }
    const ctl = (dir, request, value, data) => {
      const setup = { requestType: 'vendor', recipient: 'interface', request, value, index: IFACE };
      return dir === 'out' ? dev.controlTransferOut(setup, data) : dev.controlTransferIn(setup, data);
    };
    async function controlInit() {                              // vendor handshake that powers the sensor (requests 48, 48, 70, 65)
      await ctl('out', 48, 0, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
      await ctl('in', 48, 0, 512); await ctl('in', 70, 1, 8); await ctl('out', 65, 0, new Uint8Array(0));
    }

    async function pickDevice(fromGesture) {
      const known = (await navigator.usb.getDevices()).find(d => d.vendorId === VID && d.productId === PID);
      if (known) return known;
      if (!fromGesture) return null;
      return navigator.usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
    }
    async function openDevice(d) {
      dev = d; await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(dev.configurations[0].configurationValue);
      await dev.claimInterface(IFACE);
    }
    async function bringUp(myGen) {
      const rows = await loadInit(), dm = o.displayMm; if (!dm) throw new Error('screen size not set');
      queue = []; parser.reset(); pump(myGen);
      await controlInit();
      let i = 0;
      while (i < 200) {
        let raw = rows[i]; const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), cmd = dv.getUint32(20), s = dv.getUint32(12);
        if (cmd === CMD_UPLOAD_CAL) {                            // chunked upload of the generic calibration blob, rows i..199
          for (const piece of rows.slice(i, 200)) await write(piece);
          const r = await waitResp(s, 'calibration upload'); if (r.error) throw new Error('calibration upload refused: ' + r.error.toString(16));
          break;
        }
        if (cmd === CMD_SET_DISPLAY) raw = displayAreaPacket(s, displayPoints(dm[0], dm[1], o.tiltDeg));
        await write(raw); const r = await waitResp(s, 'command ' + cmd);
        if (r.error && cmd === CMD_SET_DISPLAY) throw new Error('display area refused: ' + r.error.toString(16));   // like the Python reader, other replayed commands may answer with an error and still work
        i++;
      }
      await write(streamCommand(100, STREAM_GAZE));
      if (o.images) await write(streamCommand(101, STREAM_IMAGE));       // the camera picture, for the position guide
    }
    async function teardown() {
      gen++; streamingLive = false; const d = dev; dev = null; failPending(new Error('the tracker disconnected'));
      if (waiter) { const w = waiter; waiter = null; clearTimeout(w.t); w.res(null); }
      if (d) { try { await d.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 66, value: 0, index: IFACE }); } catch (_) { /* ignore */ } try { await d.close(); } catch (_) { /* ignore */ } }
    }

    /* connect, stream, and re-open on stalls (the chip only starts streaming on every other open) */
    async function loop(first) {
      let attempt = 0;
      while (running) {
        const myGen = ++gen;
        try {
          status('connecting', attempt ? 'waking the tracker (this can take a couple of tries)…' : 'connecting to the tracker…');
          const d = first || await pickDevice(false); first = null;
          if (!d) throw new Error('tracker not authorised — click “Connect tracker”');
          await openDevice(d);
          await bringUp(myGen);
          let streaming = false, imgN = 0;
          while (running && myGen === gen) {
            const m = await nextMsg(o.stallMs);
            if (!m) throw new Error('the tracker stopped sending data');
            if (m.error_) throw m.error_;
            if (m.marker === M_RESP && pending.has(m.seq)) { const p = pending.get(m.seq); pending.delete(m.seq); clearTimeout(p.t); p.res(m); continue; }
            if (m.marker === M_STREAM && m.id === STREAM_GAZE) {
              if (!streaming) { streaming = true; streamingLive = true; attempt = 0; status('live', 'tracker streaming'); if (o.onLive) Promise.resolve().then(o.onLive).catch(e => console.warn('[tet] onLive', e)); }
              try { o.onGaze && o.onGaze(decodeGaze(m)); } catch (e) { console.error('[tet] onGaze', e); }
            } else if (m.marker === M_STREAM && m.id === STREAM_IMAGE && o.onImage && (++imgN & 1) === 0 && (!o.wantImage || o.wantImage())) {      // every second picture is plenty, and none unless somebody is looking at them
              const px = imagePixels(m.payload);
              if (px && px.length === IMG_PIXELS) { try { o.onImage(px.slice()); } catch (e) { console.error('[tet] onImage', e); } }
            }
          }
        } catch (e) {
          if (!running) break;
          const msg = (e && e.message) || String(e);
          if (/not authorised|screen size/.test(msg)) { status('idle', msg); running = false; break; }
          if (e && (e.name === 'SecurityError' || e.name === 'NotAllowedError')) { status('unreachable', 'the browser did not allow access to the tracker'); running = false; break; }
          if (e && e.name === 'NetworkError' && /claim|open|access/i.test(msg)) {
            status('unreachable', 'could not open the tracker (' + msg + ') — ' + openHelp());
          }
          else status('connecting', (e && e.name && e.name !== 'Error' && !msg.includes(e.name) ? e.name + ': ' : '') + msg + ' — retrying' + (attempt ? ' (try ' + (attempt + 1) + ')' : ''));
          if (e && e.name === 'NetworkError' && attempt >= 1 && readSize > 16384) { readSize = 16384; console.info('[tet] transfer error: asking for smaller reads (16 KB) from now on'); }      // some small computers' USB controllers (e.g. a Raspberry Pi's) fail big reads
          console.warn('[tet] connect attempt ' + (attempt + 1) + ' failed:', e);
          attempt++;
        } finally { await teardown(); }
        if (running) await sleep(1500);
      }
    }

    return {
      supported,
      get running() { return running; },
      setDisplayMm(mm) { o.displayMm = mm; },
      /** Ask the tracker for its camera picture (used by the position guide). It is not requested until this is called, so normal use costs nothing. */
      async enableImages() { if (o.images) return; o.images = true; if (dev && streamingLive) { try { await write(streamCommand(101, STREAM_IMAGE)); } catch (_) { /* the reconnect loop will ask again */ } } },
      /** Start streaming. The first time it must run from a click (the browser asks which device). */
      async connect() {
        if (running) return; if (!supported()) { status('unreachable', 'this browser has no WebUSB — use Chrome or Edge'); return; }
        if (root.location && root.location.protocol === 'file:') { status('unreachable', 'this page was opened as a file — open it from http://localhost (' + (platform() === 'windows' ? 'double-click start.bat' : 'run ./start.sh') + ') so the browser can load the tracker start-up data'); return; }
        if (!o.displayMm) { status('idle', 'enter your screen size first'); return; }
        let d = null;
        try { d = await pickDevice(true); } catch (e) { status('idle', e && e.name === 'NotFoundError' ? 'no tracker chosen' : String((e && e.message) || e)); return; }
        if (running) return; running = true; loop(d);
      },
      /** Resume without a click if this browser already has permission for the tracker. */
      async autoConnect() {
        if (running || !supported() || !o.displayMm) return false;
        const d = await pickDevice(false); if (!d || running) return false;
        running = true; loop(d); return true;
      },
      disconnect() { running = false; teardown(); status('idle', 'tracker disconnected'); },
      options: o,
      get live() { return !!dev && streamingLive; },
      /**
       * The tracker's own calibration, run inside the tracker's 3-D eye model (what the maker's own software does), while it keeps streaming.
       * Each call resolves to the reply payload, or throws (err.code = the tracker's error) when refused or unanswered.
       * Sequence: setEye(mask) → start → clear → addPoint(x, y, mask) per dot (it waits up to ~3 s for usable data, and refuses the dot
       * without it) → compute (fits and applies) → stop → retrieve (the blob to keep). apply(blob) puts a kept one back; the tracker forgets
       * it whenever it restarts, which is every connect.
       */
      device: (() => {
        const Z = () => Uint8Array.of(0, 0), q = v => tlv(T_FIX32, fix64(v));
        async function call(cmd, payload, ms, what) {
          const m = await request(cmd, payload, ms, what);
          if (m.error) { const e = new Error((what || 'command ' + cmd) + ' refused (0x' + m.error.toString(16) + ')'); e.code = m.error; throw e; }
          return m.payload;
        }
        let defaultBlob = null;
        async function capturedBlob() {                          // the calibration the captured start-up uploads (00 00 prefix removed)
          if (defaultBlob) return defaultBlob;
          const rows = await loadInit(), i = rows.findIndex(r => r.length >= 32 && new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(20) === CMD_UPLOAD_CAL);
          if (i < 0) throw new Error('no calibration in the start-up data');
          return (defaultBlob = cat([rows[i].subarray(34), ...rows.slice(i + 1, 200).map(r => r.subarray(8))]));
        }
        return {
          setEye: mask => call(CAL.setEye, cat([Z(), tlv(T_U32, u32(mask))]), 4000, 'select eyes'),
          getEye: async () => { const p = await call(CAL.getEye, new Uint8Array(0), 4000, 'read eyes'); return p.length >= 4 ? beNum(p.subarray(p.length - 4)) : null; },
          start: () => call(CAL.start, Z(), 8000, 'calibration start'),
          stop: () => call(CAL.stop, Z(), 8000, 'calibration stop'),
          clear: () => call(CAL.clear, Z(), 8000, 'calibration clear'),
          addPoint: (x, y, mask) => call(CAL.addPoint, cat([Z(), q(x), q(y), tlv(T_U32, u32(mask))]), 15000, 'calibration dot'),
          discard: (x, y) => call(CAL.discard, cat([Z(), q(x), q(y)]), 8000, 'calibration discard'),
          compute: () => call(CAL.compute, Z(), 120000, 'calibration compute'),
          retrieve: async () => (await call(CAL.retrieve, Z(), 60000, 'calibration download')).slice(2),
          apply: blob => call(CAL.apply, cat([Z(), blob]), 60000, 'calibration upload'),
          /** Back to what every connect starts with: both eyes, the captured start-up calibration. */
          async restoreDefault() { await call(CAL.setEye, cat([Z(), tlv(T_U32, u32(3))]), 4000, 'select eyes'); await call(CAL.apply, cat([Z(), await capturedBlob()]), 60000, 'calibration upload'); },
        };
      })(),
    };
  }

  const api = { create, supported: () => !!(root.navigator && navigator.usb),
    // exposed for tests
    _t: { imagePixels, buildCommand, streamCommand, displayPoints, displayAreaPacket, parseMessage, keyedFields, decodeGaze, fromHex, toHex, createParser, chunkFrame, fix64, tlv, u32, cat } };
  root.TetUSB = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : this);
