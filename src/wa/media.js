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

async function source(env, media) {
  if (media.type === 'video') {
    const v = await openVideo(env, media.url);
    if (v) return { size: v.size, mimetype: 'video/mp4', open: () => v.stream() };
    const res = await fetch(media.url);
    if (!res.ok) throw new Error('مش قادر أنزّل الفيديو');
    const buf = new Uint8Array(await res.arrayBuffer());
    return { size: buf.length, mimetype: 'video/mp4', open: () => new Response(buf).body };
  }
  const { buf, type } = await imageBytes(env, media.url);
  const u8 = new Uint8Array(buf);
  return { size: u8.length, mimetype: type || 'image/jpeg', open: () => new Response(u8).body };
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
    },
  };
}
