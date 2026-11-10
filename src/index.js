import { ensureSchema } from './db.js';
import { handleApi, json } from './api.js';
import { requireSecrets, isAuthed } from './auth.js';
import { metaStart, metaCallback } from './meta.js';
import { runDuePosts } from './publisher.js';

function errorPage(message) {
  const safe = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return new Response(
    `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>خطأ</title>
     <body style="font-family:system-ui;padding:40px;line-height:1.8"><h2>حصلت مشكلة</h2><p>${safe}</p><a href="/">ارجع للوحة التحكم</a></body></html>`,
    { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
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

  async scheduled(event, env) {
    try {
      requireSecrets(env);
      await ensureSchema(env);
      await runDuePosts(env);
    } catch (err) {
      console.error('scheduled run failed:', err.message);
      throw err;
    }
  },
};
