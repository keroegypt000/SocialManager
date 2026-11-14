// Turns a fragmented MP4 (what the browser's MediaRecorder writes) into a normal
// "fast start" MP4, without re-encoding anything.
//
// Why: a fragmented MP4 says its length is 0 seconds in the header (mvhd) and keeps
// no sample tables in `moov`. Browsers play it anyway, but Facebook's processing
// trusts the header: Stories and Reels made from such files showed only a frozen,
// blurry first frame, or played a split second and closed.
//
// The new file has: moov first (fast start), real durations in mvhd/tkhd/mdhd,
// full sample tables (stts, stss, ctts, stsc, stsz, stco) and one mdat. Video frames
// get evenly spaced timestamps (constant frame rate) with the same total length.
(() => {
  const enc = new TextEncoder();

  function readBoxes(dv, start, end) {
    const out = [];
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o);
      const type = String.fromCharCode(dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6), dv.getUint8(o + 7));
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
      if (size === 0) size = end - o;
      if (size < hdr || o + size > end) break;
      out.push({ type, start: o, body: o + hdr, end: o + size });
      o += size;
    }
    return out;
  }

  // ---- writing ----
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
  const concat = (parts) => {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const box = (type, ...parts) => {
    const body = concat(parts);
    return concat([u32(body.length + 8), enc.encode(type), body]);
  };
  const full = (type, version, flags, ...parts) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
  const u32list = (arr) => {
    const b = new Uint8Array(arr.length * 4);
    const dv = new DataView(b.buffer);
    arr.forEach((n, i) => dv.setUint32(i * 4, n >>> 0));
    return b;
  };

  function parse(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const top = readBoxes(dv, 0, buf.byteLength);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) throw new Error('mp4: no moov');
    const kids = (b) => readBoxes(dv, b.body, b.end);
    const child = (b, t) => b && kids(b).find((x) => x.type === t);
    const mvex = child(moov, 'mvex');
    if (!mvex) return null; // already a normal MP4

    const trex = {};
    for (const t of kids(mvex).filter((b) => b.type === 'trex')) {
      trex[dv.getUint32(t.body + 4)] = { dur: dv.getUint32(t.body + 12), size: dv.getUint32(t.body + 16), flags: dv.getUint32(t.body + 20) };
    }
    const tracks = {};
    const order = [];
    for (const trak of kids(moov).filter((b) => b.type === 'trak')) {
      const tkhd = child(trak, 'tkhd');
      const id = dv.getUint32(tkhd.body + (u8[tkhd.body] ? 20 : 12));
      const mdia = child(trak, 'mdia');
      const mdhd = child(mdia, 'mdhd');
      const timescale = dv.getUint32(mdhd.body + (u8[mdhd.body] ? 20 : 12));
      const hdlr = child(mdia, 'hdlr');
      const handler = String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12));
      tracks[id] = { id, trak, timescale, handler, samples: [] };
      order.push(id);
    }

    for (const moof of top.filter((b) => b.type === 'moof')) {
      for (const traf of kids(moof).filter((b) => b.type === 'traf')) {
        const tfhd = child(traf, 'tfhd');
        const tf = dv.getUint32(tfhd.body) & 0xffffff;
        const id = dv.getUint32(tfhd.body + 4);
        const tr = tracks[id];
        if (!tr) continue;
        const d = trex[id] || { dur: 0, size: 0, flags: 0 };
        let p = tfhd.body + 8;
        let base = moof.start; // default-base-is-moof, and the spec default for the first traf
        if (tf & 1) { base = Number(dv.getBigUint64(p)); p += 8; }
        if (tf & 2) p += 4;
        let defDur = d.dur, defSize = d.size, defFlags = d.flags;
        if (tf & 8) { defDur = dv.getUint32(p); p += 4; }
        if (tf & 0x10) { defSize = dv.getUint32(p); p += 4; }
        if (tf & 0x20) { defFlags = dv.getUint32(p); p += 4; }
        for (const trun of kids(traf).filter((b) => b.type === 'trun')) {
          const ver = u8[trun.body];
          const fl = dv.getUint32(trun.body) & 0xffffff;
          const n = dv.getUint32(trun.body + 4);
          let q = trun.body + 8;
          let off = base;
          if (fl & 1) { off = base + dv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (fl & 4) { firstFlags = dv.getUint32(q); q += 4; }
          for (let i = 0; i < n; i++) {
            let dur = defDur, size = defSize, flags = defFlags, cto = 0;
            if (fl & 0x100) { dur = dv.getUint32(q); q += 4; }
            if (fl & 0x200) { size = dv.getUint32(q); q += 4; }
            if (fl & 0x400) { flags = dv.getUint32(q); q += 4; } else if (i === 0 && firstFlags !== null) flags = firstFlags;
            if (fl & 0x800) { cto = ver ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
            if (off + size > buf.byteLength) throw new Error('mp4: sample outside the file');
            tr.samples.push({ off, size, dur, sync: !((flags >> 16) & 1), cto });
            off += size;
          }
        }
      }
    }
    return { dv, u8, top, moov, kids, child, tracks, order };
  }

  function rebuild(buf) {
    const P = parse(buf);
    if (!P) return null;
    const { u8, dv, moov, kids, child, tracks, order } = P;
    const mvhd = child(moov, 'mvhd');
    const movieTs = dv.getUint32(mvhd.body + (u8[mvhd.body] ? 20 : 12));
    const list = order.map((id) => tracks[id]).filter((t) => t.samples.length);
    if (!list.length) throw new Error('mp4: no samples');

    for (const t of list) {
      t.total = t.samples.reduce((s, x) => s + x.dur, 0);
      if (t.handler === 'vide') {
        // Constant frame rate: spread the real total evenly over the frames.
        const n = t.samples.length;
        let acc = 0;
        t.samples.forEach((s, i) => { const next = Math.round((t.total * (i + 1)) / n); s.dur = next - acc; acc = next; });
      }
    }
    // Interleave the tracks in roughly half-second chunks (good for streaming).
    const chunks = [];
    const pos = list.map(() => ({ i: 0, t: 0 }));
    for (;;) {
      let best = -1;
      for (let k = 0; k < list.length; k++) {
        if (pos[k].i >= list[k].samples.length) continue;
        if (best < 0 || pos[k].t / list[k].timescale < pos[best].t / list[best].timescale) best = k;
      }
      if (best < 0) break;
      const tr = list[best];
      const p = pos[best];
      const limit = p.t + tr.timescale / 2;
      const idx = [];
      while (p.i < tr.samples.length && (idx.length === 0 || p.t < limit)) {
        idx.push(p.i);
        p.t += tr.samples[p.i].dur;
        p.i++;
      }
      chunks.push({ k: best, idx });
    }

    const buildMoov = (chunkOffsets) => {
      let maxDur = 0;
      const traks = list.map((tr, k) => {
        const mine = chunks.map((c, ci) => ({ c, ci })).filter((x) => x.c.k === k);
        const s = tr.samples;
        // stts (run-length of durations)
        const stts = [];
        for (const x of s) {
          const last = stts[stts.length - 1];
          if (last && last[1] === x.dur) last[0]++; else stts.push([1, x.dur]);
        }
        const hasCto = s.some((x) => x.cto);
        const ctts = [];
        if (hasCto) for (const x of s) {
          const last = ctts[ctts.length - 1];
          if (last && last[1] === x.cto) last[0]++; else ctts.push([1, x.cto]);
        }
        const stsc = [];
        mine.forEach((m, i) => {
          const last = stsc[stsc.length - 1];
          if (!last || last[1] !== m.c.idx.length) stsc.push([i + 1, m.c.idx.length, 1]);
        });
        const syncs = s.map((x, i) => (x.sync ? i + 1 : 0)).filter(Boolean);
        const mediaDur = s.reduce((a, x) => a + x.dur, 0);
        const movieDur = Math.round((mediaDur * movieTs) / tr.timescale);
        maxDur = Math.max(maxDur, movieDur);

        const oldStbl = child(child(child(child(tr.trak, 'mdia'), 'minf'), 'stbl'), 'stsd');
        const stbl = box('stbl',
          u8.slice(oldStbl.start, oldStbl.end),
          full('stts', 0, 0, u32(stts.length), u32list(stts.flat())),
          ...(hasCto ? [full('ctts', 1, 0, u32(ctts.length), u32list(ctts.flat()))] : []),
          ...(tr.handler === 'vide' && syncs.length < s.length ? [full('stss', 0, 0, u32(syncs.length), u32list(syncs))] : []),
          full('stsc', 0, 0, u32(stsc.length), u32list(stsc.flat())),
          full('stsz', 0, 0, u32(0), u32(s.length), u32list(s.map((x) => x.size))),
          full('stco', 0, 0, u32(mine.length), u32list(mine.map((m) => chunkOffsets[m.ci]))),
        );
        const mdia = child(tr.trak, 'mdia');
        const minf = child(mdia, 'minf');
        const newMinf = box('minf', ...kids(minf).filter((b) => b.type !== 'stbl').map((b) => u8.slice(b.start, b.end)), stbl);
        const mdhd = u8.slice(child(mdia, 'mdhd').start, child(mdia, 'mdhd').end);
        setDuration(mdhd, 'mdhd', mediaDur);
        const newMdia = box('mdia', mdhd, u8.slice(child(mdia, 'hdlr').start, child(mdia, 'hdlr').end), newMinf);
        const tkhd = u8.slice(child(tr.trak, 'tkhd').start, child(tr.trak, 'tkhd').end);
        setDuration(tkhd, 'tkhd', movieDur);
        return box('trak', tkhd, newMdia);
      });
      const mv = u8.slice(mvhd.start, mvhd.end);
      setDuration(mv, 'mvhd', maxDur);
      return box('moov', mv, ...traks);
    };

    // ftyp + moov first, then one mdat with the chunks in order.
    const ftyp = box('ftyp', enc.encode('isom'), u32(512), enc.encode('isomiso2avc1mp41'));
    const chunkSizes = chunks.map((c) => c.idx.reduce((s, i) => s + list[c.k].samples[i].size, 0));
    const mdatSize = 8 + chunkSizes.reduce((a, b) => a + b, 0);
    const dummy = buildMoov(chunks.map(() => 0));
    let off = ftyp.length + dummy.length + 8;
    const offsets = chunkSizes.map((n) => { const o = off; off += n; return o; });
    const newMoov = buildMoov(offsets);
    if (newMoov.length !== dummy.length) throw new Error('mp4: moov size changed');
    if (mdatSize > 0xffffffff) throw new Error('mp4: too big');

    const out = new Uint8Array(ftyp.length + newMoov.length + mdatSize);
    out.set(ftyp, 0);
    out.set(newMoov, ftyp.length);
    let w = ftyp.length + newMoov.length;
    new DataView(out.buffer).setUint32(w, mdatSize);
    out.set(enc.encode('mdat'), w + 4);
    w += 8;
    for (const c of chunks) for (const i of c.idx) {
      const s = list[c.k].samples[i];
      out.set(u8.subarray(s.off, s.off + s.size), w);
      w += s.size;
    }
    const video = list.find((t) => t.handler === 'vide');
    return {
      bytes: out,
      seconds: Math.max(...list.map((t) => t.samples.reduce((a, x) => a + x.dur, 0) / t.timescale)),
      frames: video?.samples.length || 0,
      keyframes: video ? video.samples.filter((x) => x.sync).length : 0,
    };
  }

  // Duration field of mvhd / tkhd / mdhd (version 0 or 1), in a copied box.
  function setDuration(b, type, value) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const v = b[8];
    const at = type === 'tkhd' ? (v ? 8 + 4 + 24 : 8 + 4 + 16) : (v ? 8 + 4 + 20 : 8 + 4 + 12);
    if (v) dv.setBigUint64(at, BigInt(value)); else dv.setUint32(at, value);
  }

  // File in, File out. Returns the same file when it's already a normal MP4
  // (or not an MP4 at all).
  window.fixMp4 = async function fixMp4(file) {
    if (!/mp4|quicktime/i.test(file.type) && !/\.(mp4|mov)$/i.test(file.name)) return { file, fixed: false };
    const r = rebuild(await file.arrayBuffer());
    if (!r) return { file, fixed: false };
    return {
      file: new File([r.bytes], file.name.replace(/\.\w+$/, '') + '.mp4', { type: 'video/mp4' }),
      fixed: true, seconds: r.seconds, frames: r.frames, keyframes: r.keyframes,
    };
  };
  window.__mp4fixTest = { rebuild, parse };
})();
