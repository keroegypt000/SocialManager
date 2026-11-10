// Video storage on the free KV tier. A KV value is limited to 25 MB, so a video is
// uploaded and stored in 20 MB chunks and served back as one file (with Range support,
// which Facebook and Instagram may use when downloading it).
//
// Keys:  <id>.mp4      -> JSON { size, type, chunks, done }
//        <id>.mp4#<n>  -> raw bytes of chunk n

export const CHUNK = 20 * 1024 * 1024;
export const MAX_VIDEO = 100 * 1024 * 1024;
const YEAR = 365 * 86400;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];

const metaKey = (id) => `${id}.mp4`;
const chunkKey = (id, i) => `${id}.mp4#${i}`;

export class MediaError extends Error {}

export async function startVideo(env, { size, type }) {
  size = Number(size);
  if (!VIDEO_TYPES.includes(type)) throw new MediaError('الفيديو لازم يكون MP4 أو MOV');
  if (!size || size <= 0) throw new MediaError('الملف فاضي');
  if (size > MAX_VIDEO) throw new MediaError('الفيديو أكبر من 100 ميجا. صغّره أو قصّره الأول.');
  const id = crypto.randomUUID();
  const meta = { size, type, chunks: Math.ceil(size / CHUNK), done: false };
  // Unfinished uploads disappear by themselves after a day.
  await env.MEDIA.put(metaKey(id), JSON.stringify(meta), { expirationTtl: 86400 });
  return { id, chunkSize: CHUNK, chunks: meta.chunks };
}

async function readMeta(env, id) {
  const raw = await env.MEDIA.get(metaKey(id));
  return raw ? JSON.parse(raw) : null;
}

export async function putChunk(env, id, index, req) {
  const meta = await readMeta(env, id);
  if (!meta || meta.done) throw new MediaError('الرفع ده مش موجود أو خلص خلاص');
  index = Number(index);
  if (!Number.isInteger(index) || index < 0 || index >= meta.chunks) throw new MediaError('جزء غلط');
  const expected = Math.min(CHUNK, meta.size - index * CHUNK);
  const len = Number(req.headers.get('Content-Length'));
  if (len !== expected) throw new MediaError('حجم الجزء مش مظبوط، جرّب ترفع تاني');
  await env.MEDIA.put(chunkKey(id, index), req.body, { expirationTtl: YEAR });
}

export async function finishVideo(env, id, origin) {
  const meta = await readMeta(env, id);
  if (!meta) throw new MediaError('الرفع ده مش موجود');
  if (!meta.done) {
    const { keys } = await env.MEDIA.list({ prefix: `${metaKey(id)}#` });
    if (keys.length !== meta.chunks) throw new MediaError('الفيديو مترفعش كامل، جرّب تاني');
    meta.done = true;
    await env.MEDIA.put(metaKey(id), JSON.stringify(meta), { expirationTtl: YEAR });
  }
  return { url: `${origin}/media/${metaKey(id)}` };
}

export async function videoExists(env, url) {
  const m = String(url).match(/\/media\/([0-9a-f-]{36})\.mp4$/);
  if (!m) return true; // not one of ours
  const meta = await readMeta(env, m[1]);
  return Boolean(meta && meta.done);
}

export async function deleteVideo(env, url) {
  const m = String(url).match(/\/media\/([0-9a-f-]{36})\.mp4$/);
  if (!m) return;
  const meta = await readMeta(env, m[1]);
  const keys = [metaKey(m[1])];
  if (meta) for (let i = 0; i < meta.chunks; i++) keys.push(chunkKey(m[1], i));
  await Promise.all(keys.map((k) => env.MEDIA.delete(k)));
}

// Pass through only bytes [from, to) of a stream.
function sliceStream(stream, from, to) {
  let pos = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const start = pos;
      pos += chunk.byteLength;
      if (pos <= from || start >= to) return;
      controller.enqueue(chunk.subarray(Math.max(0, from - start), Math.min(chunk.byteLength, to - start)));
    },
  }));
}

export async function serveVideo(env, ctx, req, id) {
  const meta = await readMeta(env, id);
  if (!meta || !meta.done) return new Response('Not found', { status: 404 });

  let start = 0;
  let end = meta.size - 1;
  let status = 200;
  const range = (req.headers.get('Range') || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), meta.size - 1);
    } else {
      start = Math.max(0, meta.size - Number(range[2])); // suffix range: last N bytes
    }
    if (start > end || start >= meta.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${meta.size}` } });
    }
    status = 206;
  }

  const headers = {
    'Content-Type': meta.type,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${meta.size}`;
  if (req.method === 'HEAD') return new Response(null, { status, headers });

  const { readable, writable } = new TransformStream();
  const pump = (async () => {
    try {
      for (let i = Math.floor(start / CHUNK); i <= Math.floor(end / CHUNK); i++) {
        const chunkStart = i * CHUNK;
        const body = await env.MEDIA.get(chunkKey(id, i), 'stream');
        if (!body) throw new Error('missing chunk ' + i);
        const from = Math.max(0, start - chunkStart);
        const to = Math.min(CHUNK, end + 1 - chunkStart);
        const part = from === 0 && to >= Math.min(CHUNK, meta.size - chunkStart) ? body : sliceStream(body, from, to);
        await part.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (err) {
      console.error('video stream failed', err);
      await writable.abort(err).catch(() => {});
    }
  })();
  ctx.waitUntil(pump);
  return new Response(readable, { status, headers });
}
