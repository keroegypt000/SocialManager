// 🎞️ Video from photos, made in the browser (no server, no subscription):
// photos with gentle zoom + crossfades, optional caption, and background music that is
// GENERATED here with the Web Audio API (no copyrighted tracks), or the user's own file.
// Output: an MP4 (or WebM where MP4 recording isn't supported) handed back as a File.
(function () {
  'use strict';

  const SIZES = { '9:16': [720, 1280], '1:1': [1080, 1080], '16:9': [1280, 720], '4:5': [864, 1080] };
  const FPS = 30;
  const FADE = 0.6; // seconds of crossfade between photos

  // ---------------- music (synthesized) ----------------
  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12); // MIDI -> Hz
  const STYLES = {
    calm: { label: '🌙 هادي', bpm: 72, chords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]], drums: false, arp: true, wave: 'sine' },
    lofi: { label: '☕ لوفاي', bpm: 82, chords: [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71], [57, 60, 64, 67]], drums: 'lofi', arp: false, wave: 'triangle', crackle: true },
    upbeat: { label: '⚡ حماسي', bpm: 124, chords: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]], drums: 'four', arp: true, wave: 'sawtooth', bass: true },
    happy: { label: '🎉 احتفالي', bpm: 116, chords: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], drums: 'pop', arp: true, wave: 'square', bass: true },
    oriental: { label: '🪘 شرقي', bpm: 96, chords: [[62, 66, 69], [62, 66, 69], [55, 58, 62], [62, 66, 69]], drums: 'darbuka', scale: [62, 63, 66, 67, 69, 70, 72, 74], wave: 'triangle', bass: true },
    corporate: { label: '💼 شركات', bpm: 104, chords: [[60, 64, 67, 72], [55, 59, 62, 67], [57, 60, 64, 69], [53, 57, 60, 65]], drums: 'soft', arp: true, wave: 'triangle', bass: true },
  };

  function noiseBuffer(ctx, secs) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * secs), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  // Render `secs` seconds of a style into an AudioBuffer (offline, faster than real time).
  async function renderMusic(styleKey, secs) {
    const st = STYLES[styleKey];
    const sr = 44100;
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * secs), sr);
    const master = ctx.createGain();
    master.gain.value = 0.55;
    // fade in / out
    master.gain.setValueAtTime(0, 0);
    master.gain.linearRampToValueAtTime(0.55, 1.2);
    master.gain.setValueAtTime(0.55, Math.max(1.2, secs - 1.8));
    master.gain.linearRampToValueAtTime(0, secs);
    // soft "room": a feedback delay
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 60 / st.bpm * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const wet = ctx.createGain(); wet.gain.value = 0.25;
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = st.drums === 'lofi' ? 1800 : 5200;
    tone.connect(master); tone.connect(delay);
    master.connect(ctx.destination);
    const noise = noiseBuffer(ctx, 1);

    const beat = 60 / st.bpm;
    const bar = beat * 4;
    const voice = (freq, t, dur, { type = st.wave, vol = 0.08, attack = 0.02, release = 0.3, dest = tone } = {}) => {
      if (t >= secs) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + attack);
      g.gain.setValueAtTime(vol, Math.max(t + attack, t + dur - release));
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g); g.connect(dest);
      o.start(t); o.stop(Math.min(secs, t + dur + 0.05));
    };
    const hit = (t, { freq = 0, len = 0.12, vol = 0.5, filter = 'highpass', cutoff = 7000, pitchDrop = false } = {}) => {
      if (t >= secs) return;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      if (freq) { // tonal hit (kick / doum)
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq * (pitchDrop ? 2.5 : 1), t);
        o.frequency.exponentialRampToValueAtTime(freq, t + 0.08);
        o.connect(g); o.start(t); o.stop(t + len + 0.02);
      } else { // noise hit (hat / snare / tak)
        const s = ctx.createBufferSource();
        s.buffer = noise;
        const f = ctx.createBiquadFilter(); f.type = filter; f.frequency.value = cutoff;
        s.connect(f); f.connect(g); s.start(t); s.stop(t + len + 0.02);
      }
      g.connect(master);
    };

    for (let t = 0, i = 0; t < secs; t += bar, i++) {
      const ch = st.chords[i % st.chords.length];
      // pad
      for (const n of ch) voice(NOTE(n), t, bar + 0.1, { type: st.wave === 'square' ? 'triangle' : st.wave === 'sawtooth' ? 'triangle' : st.wave, vol: 0.045, attack: 0.25, release: 0.6 });
      // bass
      if (st.bass) for (let b = 0; b < 4; b++) voice(NOTE(ch[0] - 24), t + b * beat, beat * 0.9, { type: 'sine', vol: 0.16, attack: 0.01, release: 0.15 });
      // arpeggio / melody
      if (st.scale) {
        for (let s = 0; s < 8; s++) {
          const n = st.scale[(i * 3 + [0, 2, 4, 3, 1, 2, 5, 4][s]) % st.scale.length] + 12;
          voice(NOTE(n), t + s * beat / 2, beat / 2, { type: 'triangle', vol: 0.06, attack: 0.01, release: 0.12 });
        }
      } else if (st.arp) {
        const seq = [...ch, ch[1] + 12, ch[2] + 12, ch[1] + 12, ch[0] + 12];
        for (let s = 0; s < 8; s++) voice(NOTE(seq[s % seq.length] + 12), t + s * beat / 2, beat / 2, { type: st.wave === 'sine' ? 'sine' : 'triangle', vol: 0.045, attack: 0.005, release: 0.15 });
      }
      // drums
      for (let b = 0; b < 4; b++) {
        const tb = t + b * beat;
        if (st.drums === 'four') {
          hit(tb, { freq: 55, len: 0.3, vol: 0.9, pitchDrop: true });
          hit(tb + beat / 2, { len: 0.05, vol: 0.18 });
          if (b % 2) hit(tb, { len: 0.16, vol: 0.35, filter: 'bandpass', cutoff: 1800 });
        } else if (st.drums === 'pop') {
          if (b % 2 === 0) hit(tb, { freq: 60, len: 0.28, vol: 0.85, pitchDrop: true });
          else hit(tb, { len: 0.18, vol: 0.4, filter: 'bandpass', cutoff: 1600 });
          hit(tb + beat / 2, { len: 0.04, vol: 0.15 });
        } else if (st.drums === 'lofi') {
          if (b === 0 || b === 2) hit(tb, { freq: 58, len: 0.25, vol: 0.6, pitchDrop: true });
          if (b === 1 || b === 3) hit(tb, { len: 0.14, vol: 0.22, filter: 'bandpass', cutoff: 1400 });
          hit(tb + beat / 2, { len: 0.03, vol: 0.06 });
        } else if (st.drums === 'soft') {
          if (b === 0 || b === 2) hit(tb, { freq: 62, len: 0.22, vol: 0.55, pitchDrop: true });
          hit(tb + beat / 2, { len: 0.03, vol: 0.08 });
        } else if (st.drums === 'darbuka') {
          // maqsum: doum tak - tak doum - tak -
          const pat = [['d', 0], ['t', 0.5], ['t', 1.5], ['d', 2], ['t', 3]];
          if (b === 0) for (const [k, off] of pat) {
            if (k === 'd') hit(t + off * beat, { freq: 90, len: 0.25, vol: 0.75, pitchDrop: true });
            else hit(t + off * beat, { len: 0.07, vol: 0.32, filter: 'bandpass', cutoff: 3200 });
          }
        }
      }
    }
    if (st.crackle) {
      for (let t = 0; t < secs; t += 0.07 + Math.random() * 0.25) hit(t, { len: 0.01, vol: 0.03 + Math.random() * 0.03 });
    }
    return ctx.startRendering();
  }

  async function decodeFile(file) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { return await ctx.decodeAudioData(await file.arrayBuffer()); } finally { ctx.close(); }
  }

  // ---------------- picture ----------------
  const loadImage = (file) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('مش قادر أقرا الصورة: ' + file.name));
    img.src = URL.createObjectURL(file);
  });

  function drawCover(ctx, img, W, H, zoom, alpha, panDir) {
    const s = Math.max(W / img.width, H / img.height) * zoom;
    const w = img.width * s, h = img.height * s;
    const px = (zoom - 1) * W * 0.5 * panDir;
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, (W - w) / 2 + px, (H - h) / 2, w, h);
    ctx.globalAlpha = 1;
  }

  function drawCaption(ctx, text, W, H) {
    if (!text) return;
    const size = Math.round(W * 0.055);
    ctx.font = `700 ${size}px Cairo, Tahoma, sans-serif`;
    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    const maxW = W * 0.86;
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    const lh = size * 1.45;
    const boxH = shown.length * lh + size * 0.8;
    const y0 = H - boxH - H * 0.08;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const r = size * 0.5, x0 = W * 0.05, bw = W * 0.9;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x0, y0, bw, boxH, r) : ctx.rect(x0, y0, bw, boxH);
    ctx.fill();
    ctx.fillStyle = '#fff';
    shown.forEach((l, i) => ctx.fillText(l, W / 2, y0 + size * 0.4 + lh * (i + 0.75)));
  }

  function drawFrame(ctx, imgs, t, opt) {
    const { W, H, per, motion } = opt;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const i = Math.min(imgs.length - 1, Math.floor(t / per));
    const local = t - i * per;
    const z = (k) => (motion === 'zoom' ? 1 + 0.12 * k : 1.0);
    drawCover(ctx, imgs[i], W, H, z(local / per), 1, i % 2 ? 1 : -1);
    if (i + 1 < imgs.length && local > per - FADE) {
      const a = (local - (per - FADE)) / FADE;
      drawCover(ctx, imgs[i + 1], W, H, z(0), a, (i + 1) % 2 ? 1 : -1);
    }
    drawCaption(ctx, opt.caption, W, H);
  }

  function pickMime() {
    const cands = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return cands.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  // Record the whole thing in real time: canvas stream + music stream -> MediaRecorder.
  async function render({ files, size, per, motion, caption, music, musicFile, volume }, onProgress) {
    const [W, H] = SIZES[size];
    const imgs = [];
    for (const f of files) imgs.push(await loadImage(f));
    const total = imgs.length * per;
    const opt = { W, H, per, motion, caption };

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    drawFrame(ctx, imgs, 0, opt);

    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    let source = null;
    if (music && music !== 'none') {
      let buf = music === 'file' && musicFile ? await decodeFile(musicFile) : await renderMusic(music, total);
      source = ac.createBufferSource();
      source.buffer = buf;
      source.loop = music === 'file';
      const g = ac.createGain();
      g.gain.value = volume;
      if (music === 'file') { // fade out the user's track at the end
        g.gain.setValueAtTime(volume, ac.currentTime + Math.max(0, total - 1.5));
        g.gain.linearRampToValueAtTime(0, ac.currentTime + total);
      }
      source.connect(g); g.connect(dest);
    }

    const stream = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickMime();
    if (!mime) throw new Error('المتصفح ده مش بيعرف يعمل فيديو. استخدم Chrome.');
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });

    if (ac.state === 'suspended') await ac.resume();
    rec.start(500);
    const t0 = ac.currentTime;
    if (source) source.start(t0);
    await new Promise((resolve) => {
      const tick = () => {
        const t = ac.currentTime - t0;
        drawFrame(ctx, imgs, Math.min(t, total - 0.001), opt);
        onProgress?.(Math.min(1, t / total));
        if (t >= total) return resolve();
        // setTimeout keeps going when the tab isn't focused (rAF would pause).
        setTimeout(tick, 1000 / FPS);
      };
      tick();
    });
    rec.stop();
    await done;
    stream.getTracks().forEach((tr) => tr.stop());
    ac.close();
    imgs.forEach((im) => URL.revokeObjectURL(im.src));
    const type = mime.split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    return { file: new File([blob], `photos-video-${Date.now()}.${ext}`, { type }), duration: total, width: W, height: H, type };
  }

  // Short preview of a music style (6 seconds) in the dialog.
  let previewSrc = null;
  async function previewMusic(styleKey) {
    stopPreview();
    const buf = await renderMusic(styleKey, 8);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const s = ac.createBufferSource();
    s.buffer = buf; s.connect(ac.destination); s.start();
    previewSrc = { s, ac };
    s.onended = () => stopPreview();
  }
  function stopPreview() {
    if (previewSrc) { try { previewSrc.s.stop(); } catch { /* */ } previewSrc.ac.close(); previewSrc = null; }
  }

  // ---------------- dialog ----------------
  window.openVideoMaker = function openVideoMaker({ esc, toast, onDone }) {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog vm-dialog';
    dlg.innerHTML = `<form method="dialog" class="dlg-body">
      <div class="dlg-head"><b>🎞️ اعمل فيديو من الصور</b><button class="btn small dlg-close" value="close">✕</button></div>
      <label class="drop" for="vm-files"><input id="vm-files" type="file" accept="image/*" multiple hidden>
        <span id="vm-files-text">📷 اختار من 2 لـ 10 صور (بالترتيب)</span></label>
      <div class="vm-thumbs" id="vm-thumbs"></div>
      <div class="row">
        <div><label>المقاس</label><select name="size">
          <option value="9:16">📱 طولي 9:16 (ريلز / ستوري / حالة)</option><option value="4:5">4:5 (بوست إنستجرام)</option>
          <option value="1:1">⬛ مربع 1:1</option><option value="16:9">🖥️ عرضي 16:9</option></select></div>
        <div><label>كل صورة كام ثانية</label><select name="per">
          <option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option></select></div>
        <div><label>الحركة</label><select name="motion"><option value="zoom">🔍 زووم هادي</option><option value="none">من غير حركة</option></select></div>
      </div>
      <div class="field"><label>كلام على الفيديو (اختياري)</label><input name="caption" maxlength="120" placeholder="مثلاً: خصم 25% لحد آخر الشهر"></div>
      <label>🎵 الموسيقى <span class="muted small">(متولّدة جوه المنصة، من غير حقوق)</span></label>
      <div class="vm-music">
        <label class="vm-opt"><input type="radio" name="music" value="none"> 🔇 من غير صوت</label>
        ${Object.entries(STYLES).map(([k, s], i) => `<label class="vm-opt"><input type="radio" name="music" value="${k}" ${i === 0 ? 'checked' : ''}> ${s.label}
          <button type="button" class="btn small" data-preview="${k}" title="اسمع">▶</button></label>`).join('')}
        <label class="vm-opt"><input type="radio" name="music" value="file"> 📁 ملف من جهازي
          <input type="file" name="musicFile" accept="audio/*" style="max-width:170px"></label>
      </div>
      <div class="row"><div><label>علو الصوت</label><input name="volume" type="range" min="0.1" max="1" step="0.05" value="0.8"></div></div>
      <div class="notice small" style="margin:0">⏱️ عمل الفيديو بياخد قد مدته تقريباً. خلّي الصفحة مفتوحة لحد ما يخلص.</div>
      <div class="progress" id="vm-progress" hidden><div></div><span></span></div>
      <div id="vm-err" class="notice bad" hidden></div>
      <div class="dlg-actions"><button type="button" class="btn primary" data-go disabled>🎬 اعمل الفيديو</button></div>
    </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => { stopPreview(); dlg.remove(); });
    const f = dlg.querySelector('form');
    let files = [];
    const go = dlg.querySelector('[data-go]');
    const err = (m) => { const b = dlg.querySelector('#vm-err'); b.textContent = m || ''; b.hidden = !m; };

    dlg.querySelector('#vm-files').onchange = (e) => {
      files = [...e.target.files].filter((x) => x.type.startsWith('image/')).slice(0, 10);
      dlg.querySelector('#vm-thumbs').innerHTML = files.map((x, i) => `<div class="vm-thumb"><img src="${URL.createObjectURL(x)}" alt=""><span>${i + 1}</span></div>`).join('');
      dlg.querySelector('#vm-files-text').textContent = files.length ? `✅ ${files.length} صور — دوس تاني عشان تغيّرهم` : '📷 اختار من 2 لـ 10 صور';
      go.disabled = files.length < 1;
      const total = files.length * Number(f.elements.per.value);
      go.textContent = files.length ? `🎬 اعمل الفيديو (${total} ثانية)` : '🎬 اعمل الفيديو';
    };
    f.elements.per.onchange = () => dlg.querySelector('#vm-files').onchange({ target: { files } });
    dlg.querySelectorAll('[data-preview]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try { await previewMusic(b.dataset.preview); } catch (e) { toast('مقدرتش أشغّل المعاينة'); }
        b.disabled = false;
      };
    });

    go.onclick = async () => {
      const music = f.elements.music.value;
      const musicFile = f.elements.musicFile.files[0];
      if (music === 'file' && !musicFile) return err('اختار ملف الموسيقى من جهازك');
      if (files.length * Number(f.elements.per.value) < 3) return err('الفيديو لازم يكون 3 ثواني على الأقل: زوّد الصور أو المدة');
      err('');
      stopPreview();
      go.disabled = true;
      const bar = dlg.querySelector('#vm-progress');
      bar.hidden = false;
      const setP = (p) => { bar.querySelector('div').style.width = `${Math.round(p * 100)}%`; bar.querySelector('span').textContent = `بيعمل الفيديو ${Math.round(p * 100)}%`; };
      try {
        const out = await render({
          files, size: f.elements.size.value, per: Number(f.elements.per.value), motion: f.elements.motion.value,
          caption: f.elements.caption.value.trim(), music, musicFile, volume: Number(f.elements.volume.value),
        }, setP);
        dlg.close();
        await onDone(out);
      } catch (e) {
        err(e.message || String(e));
        go.disabled = false;
        bar.hidden = true;
      }
    };
    dlg.showModal();
  };
  window.__videoMakerTest = { renderMusic, render, STYLES };
})();
