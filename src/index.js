import { ensureSchema } from './db.js';
import { handleApi, json } from './api.js';
import { requireSecrets, isAuthed } from './auth.js';
import { metaStart, metaCallback } from './meta.js';
import { runDuePosts, runProcessing, cleanupVideos } from './publisher.js';
import { serveVideo } from './media.js';
import { handleInvite } from './invite.js';
import { providerStart, providerCallback } from './providers.js';
import { dailySync } from './sync.js';

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
    const isInvite = url.pathname.startsWith('/invite/');
    if (!isApi && !isAuth && !isInvite) return env.ASSETS.fetch(req);

    try {
      requireSecrets(env);
      await ensureSchema(env);
    } catch (err) {
      return isApi ? json({ error: err.message, setup: true }, 500) : errorPage(err.message);
    }

    if (isApi) return handleApi(req, env, url);

    try {
      // Public: a client connecting their own pages with an invite link.
      if (isInvite) return await handleInvite(req, env, url);
      const authed = await isAuthed(req, env);
      // The callback serves both you (logged in) and invited clients (not logged in).
      if (url.pathname === '/auth/meta/callback') return await metaCallback(env, url, { isAdmin: authed });
      if (!authed) return Response.redirect(url.origin + '/', 302);
      if (url.pathname === '/auth/meta/start') return await metaStart(env, url);
      const prov = url.pathname.match(/^\/auth\/(youtube|linkedin|tiktok)\/(start|callback)$/);
      if (prov) return await (prov[2] === 'start' ? providerStart(env, url, prov[1]) : providerCallback(env, url, prov[1]));
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
    const jobs = [['due posts', runDuePosts], ['processing', runProcessing], ['video cleanup', cleanupVideos], ['daily account sync', dailySync]];
    for (const [name, job] of jobs) {
      try {
        await job(env);
      } catch (err) {
        console.error(`scheduled ${name} failed:`, err.message);
      }
    }
  },
};
