// Meta (Facebook + Instagram) Graph API: account connection and publishing.
import { encrypt } from './crypto.js';
import { makeState, readState } from './auth.js';

const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

const version = (env) => env.META_GRAPH_VERSION || 'v23.0';

export function metaConfigured(env) {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

export async function graph(env, path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`https://graph.facebook.com/${version(env)}/${path}`);
  const init = { method };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.body = new URLSearchParams(params);
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error?.error_user_msg || data.error?.message || `Graph API error ${res.status}`);
  }
  return data;
}

const redirectUri = (origin) => `${origin}/auth/meta/callback`;

export async function metaStart(env, url) {
  if (!metaConfigured(env)) throw new Error('META_APP_ID و META_APP_SECRET مش متسجلين في Cloudflare.');
  const clientId = Number(url.searchParams.get('client_id'));
  if (!clientId) throw new Error('client_id missing');
  const dialog = new URL(`https://www.facebook.com/${version(env)}/dialog/oauth`);
  dialog.searchParams.set('client_id', env.META_APP_ID);
  dialog.searchParams.set('redirect_uri', redirectUri(url.origin));
  dialog.searchParams.set('state', await makeState(env, clientId));
  dialog.searchParams.set('response_type', 'code');
  if (env.META_CONFIG_ID) dialog.searchParams.set('config_id', env.META_CONFIG_ID);
  else dialog.searchParams.set('scope', SCOPES.join(','));
  return Response.redirect(dialog.toString(), 302);
}

export async function metaCallback(env, url) {
  const back = (q) => Response.redirect(`${url.origin}/#/clients?${q}`, 302);
  if (url.searchParams.get('error')) return back('error=' + encodeURIComponent(url.searchParams.get('error_description') || 'تم إلغاء الربط'));

  const clientId = await readState(env, url.searchParams.get('state'));
  if (!clientId) return back('error=' + encodeURIComponent('انتهت صلاحية طلب الربط، جرّب تاني'));

  const common = { client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET };
  const short = await graph(env, 'oauth/access_token', {
    params: { ...common, redirect_uri: redirectUri(url.origin), code: url.searchParams.get('code') },
  });
  // Long-lived user token -> page tokens derived from it don't expire.
  const long = await graph(env, 'oauth/access_token', {
    params: { ...common, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token },
  });
  const pages = await graph(env, 'me/accounts', {
    params: {
      access_token: long.access_token,
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
      limit: '100',
    },
  });

  const now = Date.now();
  const upsert = `INSERT INTO accounts (client_id, platform, external_id, name, picture, token_enc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (client_id, platform, external_id) DO UPDATE SET name = excluded.name, picture = excluded.picture, token_enc = excluded.token_enc`;
  const stmts = [];
  for (const page of pages.data || []) {
    const token = await encrypt(env.SESSION_SECRET, page.access_token);
    stmts.push(env.DB.prepare(upsert).bind(clientId, 'facebook', page.id, page.name, page.picture?.data?.url || null, token, now));
    const ig = page.instagram_business_account;
    if (ig) {
      stmts.push(env.DB.prepare(upsert).bind(clientId, 'instagram', ig.id, ig.username || page.name, ig.profile_picture_url || null, token, now));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return back(`connected=${stmts.length}&client=${clientId}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function publishFacebook(env, pageId, token, post) {
  if (post.image_url) {
    const r = await graph(env, `${pageId}/photos`, {
      method: 'POST',
      params: { url: post.image_url, caption: post.message || '', access_token: token },
    });
    return r.post_id || r.id;
  }
  const params = { message: post.message || '', access_token: token };
  if (post.link) params.link = post.link;
  const r = await graph(env, `${pageId}/feed`, { method: 'POST', params });
  return r.id;
}

export async function publishInstagram(env, igId, token, post) {
  if (!post.image_url) throw new Error('إنستجرام محتاج صورة. ضيف رابط صورة للمنشور.');
  const container = await graph(env, `${igId}/media`, {
    method: 'POST',
    params: { image_url: post.image_url, caption: post.message || '', access_token: token },
  });
  // Wait until Instagram finishes processing the image.
  for (let i = 0; i < 6; i++) {
    const s = await graph(env, container.id, { params: { fields: 'status_code', access_token: token } });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error('إنستجرام رفض الصورة. اتأكد إن الرابط بيفتح صورة JPG مباشرة.');
    await sleep(2000);
  }
  const r = await graph(env, `${igId}/media_publish`, {
    method: 'POST',
    params: { creation_id: container.id, access_token: token },
  });
  return r.id;
}
