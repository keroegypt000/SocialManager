import { ensureSchema } from './db.js';
import { handleApi, json } from './api.js';
import { requireSecrets, isAuthed } from './auth.js';
import { metaStart, metaCallback } from './meta.js';
import { runDuePosts, runProcessing, cleanupVideos } from './publisher.js';
import { serveVideo } from './media.js';

function errorPage(message) {
  const safe = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response(
    `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>خطأ</title>
     <body style="font-family:system-ui;padding:40px;line-height:1.8"><h2>حصلت مشكلة</h2><p>${safe}</p><a href="/">ارجع للوحة التحكم</a></body></html>`,
    { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // Uploaded media must be public: Facebook and Instagram download it from here.
    const image = url.pathname.match(/^\/media\/([0-9a-f-]{36}\.jpg)$/);
    if (image) {
      if (!env.MEDIA) return new Response('Not found', { status: 404 });
      const obj = await env.MEDIA.getWithMetadata(image[1], 'arrayBuffer');
      if (!obj.value) return new Response('Not found', { status: 404 });
      return new Response(obj.value, {
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }
    const video = url.pathname.match(/^\/media\/([0-9a-f-]{36})\.mp4$/);
    if (video) {
      if (!env.MEDIA) return new Response('Not found', { status: 404 });
      return serveVideo(env, ctx, req, video[1]);
    }

    const isApi = url.pathname.startsWith('/api/');
    const isAuth = url.pathname.startsWith('/auth/');
    if (!isApi && !isAuth) return env.ASSETS.fetch(req);

    try {
      requireSecrets(env);
      await ensureSchema(env);
    } catch (err) {
      return isApi ? json({ error: err.message, setup: true }, 500) : errorPage(err.message);
    }

    if (isApi) return handleApi(req, env, url);

    try {
      if (!(await isAuthed(req, env))) return Response.redirect(url.origin + '/', 302);
      if (url.pathname === '/auth/meta/start') return await metaStart(env, url);
      if (url.pathname === '/auth/meta/callback') return await metaCallback(env, url);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return errorPage(err.message);
    }
  },

  // Every 5 minutes: publish due posts, finish Instagram videos that were still
  // processing, and free storage from old published videos.
  async scheduled(event, env) {
    requireSecrets(env);
    await ensureSchema(env);
    const jobs = [['due posts', runDuePosts], ['processing', runProcessing], ['video cleanup', cleanupVideos]];
    for (const [name, job] of jobs) {
      try {
        await job(env);
      } catch (err) {
        console.error(`scheduled ${name} failed:`, err.message);
      }
    }
  },
};
