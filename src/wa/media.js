// Images and videos for WhatsApp statuses, prepared without Baileys' temp-file path:
// read straight from our storage (KV), encrypt as a stream (AES-256-CBC + HMAC, the
// WhatsApp media format) and upload to WhatsApp's media servers. The bytes are
// encrypted twice (same key, same result): once to get the hash WhatsApp needs in the
// upload URL, once while uploading, so a big video never has to fit in memory.
import { createCipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { getMediaKeys, encodeBase64EncodedStringForUpload } from 'baileys';
import { openVideo, imageBytes } from '../media.js';

const MAX_VIDEO = 64 * 1024 * 1024;
const PATHS = { image: '/mms/image', video: '/mms/video' };

// Read [start, end] of a source into one Buffer.
async function readRange(src, start, end) {
  const parts = [];
  const reader = src.open(start, end).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(parts);
}

// Video length (seconds) and size from the MP4 header boxes (moov > mvhd / tkhd).
async function mp4Info(src) {
  const out = {};
  try {
    let off = 0;
    for (let n = 0; n < 40 && off + 8 <= src.size; n++) {
      const h = await readRange(src, off, Math.min(off + 15, src.size - 1));
      let size = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (size === 1) size = Number(h.readBigUInt64BE(8));
      if (size === 0) size = src.size - off;
      if (size < 8) break;
      if (type === 'moov') {
        if (size > 16 * 1024 * 1024) break;
        const moov = await readRange(src, off, off + size - 1);
        const mv = moov.indexOf('mvhd');
        if (mv > 0) {
          const v = moov[mv + 4];
          const timescale = v === 1 ? moov.readUInt32BE(mv + 24) : moov.readUInt32BE(mv + 16);
          const duration = v === 1 ? Number(moov.readBigUInt64BE(mv + 28)) : moov.readUInt32BE(mv + 20);
          if (timescale) out.seconds = Math.max(1, Math.round(duration / timescale));
        }
        // First track with a size is the video track; width/height are 16.16 fixed point at the end of tkhd.
        let t = moov.indexOf('tkhd');
        while (t > 0) {
          const boxStart = t - 4;
          const boxSize = moov.readUInt32BE(boxStart);
          const w = moov.readUInt32BE(boxStart + boxSize - 8) >>> 16;
          const hgt = moov.readUInt32BE(boxStart + boxSize - 4) >>> 16;
          if (w && hgt) { out.width = w; out.height = hgt; break; }
          t = moov.indexOf('tkhd', t + 4);
        }
        break;
      }
      off += size;
    }
  } catch { /* unknown layout: send without it */ }
  return out;
}

// Image size from the JPEG frame header.
function jpegInfo(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return {};
}

async function source(env, media) {
  if (media.type === 'video') {
    const v = await openVideo(env, media.url);
    if (v) return { size: v.size, mimetype: 'video/mp4', open: (s, e) => v.stream(s, e) };
    const res = await fetch(media.url);
    if (!res.ok) throw new Error('مش قادر أنزّل الفيديو');
    const buf = new Uint8Array(await res.arrayBuffer());
    return { size: buf.length, mimetype: 'video/mp4', open: (s = 0, e = buf.length - 1) => new Response(buf.subarray(s, e + 1)).body };
  }
  const { buf, type } = await imageBytes(env, media.url);
  const u8 = new Uint8Array(buf);
  return { size: u8.length, mimetype: type || 'image/jpeg', info: jpegInfo(Buffer.from(u8)), open: (s = 0, e = u8.length - 1) => new Response(u8.subarray(s, e + 1)).body };
}

// One encryption pass; calls onEnc for every encrypted piece (mac included at the end).
async function encryptPass(src, keys, onEnc) {
  const aes = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const hmac = createHmac('sha256', keys.macKey).update(keys.iv);
  const plainHash = createHash('sha256');
  const reader = src.open().getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    read += b.length;
    plainHash.update(b);
    const e = aes.update(b);
    if (e.length) { hmac.update(e); await onEnc(e); }
  }
  const last = aes.final();
  hmac.update(last);
  await onEnc(last);
  await onEnc(hmac.digest().subarray(0, 10));
  if (read !== src.size) throw new Error(`media size mismatch (${read} != ${src.size})`);
  return plainHash.digest();
}

// Returns the message content ({ imageMessage } or { videoMessage }) ready to relay.
export async function prepareStatusMedia(env, sock, media, caption) {
  const type = media.type === 'video' ? 'video' : 'image';
  const src = await source(env, media);
  if (type === 'video' && src.size > MAX_VIDEO) throw new Error('فيديو الحالة لازم يكون أقل من 64 ميجا');
  let info = type === 'video' ? await mp4Info(src) : src.info || {};
  if (type === 'video') {
    // The browser measured the video at upload; it's the most reliable source.
    if (media.duration > 0) info.seconds = Math.max(1, Math.round(media.duration));
    if (media.width > 0 && media.height > 0) { info.width = Math.round(media.width); info.height = Math.round(media.height); }
  }
  const mediaKey = randomBytes(32);
  const keys = await getMediaKeys(mediaKey, type);

  const encHash = createHash('sha256');
  let encLen = 0;
  const fileSha256 = await encryptPass(src, keys, (e) => { encHash.update(e); encLen += e.length; });
  const fileEncSha256 = encHash.digest();
  const token = encodeBase64EncodedStringForUpload(fileEncSha256.toString('base64'));

  const conn = await sock.refreshMediaConn(false);
  let result = null;
  let lastErr = null;
  for (const { hostname } of conn.hosts || []) {
    try {
      const { readable, writable } = new FixedLengthStream(encLen);
      const writer = writable.getWriter();
      const pump = encryptPass(src, keys, (e) => writer.write(e)).then(() => writer.close(), (err) => { writer.abort(err); throw err; });
      const res = await fetch(`${env.WA_MEDIA_TEST_HTTP ? 'http' : 'https'}://${hostname}${PATHS[type]}/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}`, {
        method: 'POST',
        body: readable,
        headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' },
      });
      await pump;
      const j = await res.json().catch(() => ({}));
      if (j.url || j.direct_path) { result = j; break; }
      lastErr = new Error(`WhatsApp media upload ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!result) throw lastErr || new Error('رفع الميديا لواتساب فشل');

  return {
    info,
    [`${type}Message`]: {
      url: result.url,
      directPath: result.direct_path,
      mediaKey,
      fileEncSha256,
      fileSha256,
      fileLength: src.size,
      mimetype: src.mimetype,
      caption: caption || undefined,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      ...(info.width && info.height ? { width: info.width, height: info.height } : {}),
      ...(type === 'video' && info.seconds ? { seconds: info.seconds } : {}),
    },
  };
}
