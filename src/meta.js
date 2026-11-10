// Meta (Facebook + Instagram) Graph API: account connection and publishing.
import { encrypt, decrypt } from './crypto.js';
import { makeState, readState } from './auth.js';
import { getInvite } from './invite.js';

const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
  'read_insights',
  'instagram_manage_insights',
  'ads_read',
  'ads_management',
];

const version = (env) => env.META_GRAPH_VERSION || 'v23.0';

export function metaConfigured(env) {
  return Boolean(env.META_APP_ID && env.META_APP_SECRET);
}

export async function graph(env, path, { method = 'GET', params = {} } = {}) {
  const url = new URL(`${env.META_GRAPH_BASE || 'https://graph.facebook.com'}/${version(env)}/${path}`);
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

// Opens Facebook's login dialog. From the dashboard: ?client_id=N (you are logged in).
// From an invite link: { invite } (the client logs in with their own Facebook).
export async function metaStart(env, url, { invite } = {}) {
  if (!metaConfigured(env)) throw new Error('META_APP_ID و META_APP_SECRET مش متسجلين في Cloudflare.');
  let subject;
  if (invite) {
    subject = `inv-${invite.token}`;
  } else {
    const clientId = Number(url.searchParams.get('client_id'));
    if (!clientId) throw new Error('client_id missing');
    subject = String(clientId);
  }
  const dialog = new URL(`https://www.facebook.com/${version(env)}/dialog/oauth`);
  dialog.searchParams.set('client_id', env.META_APP_ID);
  dialog.searchParams.set('redirect_uri', redirectUri(url.origin));
  dialog.searchParams.set('state', await makeState(env, subject));
  dialog.searchParams.set('response_type', 'code');
  if (env.META_CONFIG_ID) dialog.searchParams.set('config_id', env.META_CONFIG_ID);
  else dialog.searchParams.set('scope', SCOPES.join(','));
  return Response.redirect(dialog.toString(), 302);
}

export async function metaCallback(env, url, { isAdmin = false } = {}) {
  const subject = await readState(env, url.searchParams.get('state'));
  let clientId = null;
  let invite = null;
  if (subject && subject.startsWith('inv-')) {
    invite = await getInvite(env, subject.slice(4));
    clientId = invite?.client_id;
  } else if (subject && isAdmin) {
    clientId = Number(subject);
  }
  // Where to send the user back: the dashboard for you, the invite page for a client.
  const back = (q) => Response.redirect(invite ? `${url.origin}/invite/${invite.token}?${q}` : `${url.origin}/#/clients?${q}`, 302);
  if (url.searchParams.get('error')) return back('error=' + encodeURIComponent(url.searchParams.get('error_description') || 'تم إلغاء الربط'));
  if (!clientId) {
    if (!isAdmin && !invite) return Response.redirect(`${url.origin}/`, 302);
    return back('error=' + encodeURIComponent('انتهت صلاحية طلب الربط، جرّب تاني'));
  }

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

  // Facebook returns every page the user manages, so we don't save them yet:
  // the user picks which ones belong to this client on the next screen.
  const items = [];
  for (const page of pages.data || []) {
    items.push({
      platform: 'facebook', external_id: page.id, name: page.name,
      picture: page.picture?.data?.url || null, token: page.access_token, page_id: page.id,
    });
    const ig = page.instagram_business_account;
    if (ig) {
      items.push({
        platform: 'instagram', external_id: ig.id, name: ig.username || page.name,
        picture: ig.profile_picture_url || null, token: page.access_token, page_id: page.id,
      });
    }
  }
  // Ad accounts the person can use (needs ads_read). They use the long-lived user token,
  // which lasts about 60 days; reconnecting refreshes it.
  const ads = await graph(env, 'me/adaccounts', {
    params: { access_token: long.access_token, fields: 'id,name,account_status,currency', limit: '100' },
  }).catch(() => null);
  for (const ad of ads?.data || []) {
    items.push({ platform: 'meta_ads', external_id: ad.id, name: `${ad.name || ad.id} (${ad.currency || ''})`.trim(), picture: null, token: long.access_token, page_id: null });
  }
  if (!items.length) return back(invite ? 'error=' + encodeURIComponent('مالقيناش صفحات. اتأكد إنك اخترت صفحتك في شاشة فيسبوك وإنك أدمن عليها.') : 'connected=0');

  const token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pending_links WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO pending_links (token, client_id, payload_enc, expires_at) VALUES (?, ?, ?, ?)')
      .bind(token, clientId, await encrypt(env.SESSION_SECRET, JSON.stringify(items)), Date.now() + 30 * 60 * 1000),
  ]);
  if (invite) return Response.redirect(`${url.origin}/invite/${invite.token}/pick?p=${token}`, 302);
  return Response.redirect(`${url.origin}/#/connect?token=${token}`, 302);
}

// Load a pending selection (tokens stay server-side).
export async function readPending(env, token) {
  const row = await env.DB.prepare(
    'SELECT p.*, c.name AS client_name FROM pending_links p JOIN clients c ON c.id = p.client_id WHERE p.token = ? AND p.expires_at > ?'
  ).bind(token, Date.now()).first();
  if (!row) return null;
  return { clientId: row.client_id, clientName: row.client_name, items: JSON.parse(await decrypt(env.SESSION_SECRET, row.payload_enc)) };
}

// Save the chosen accounts to the client. An account belongs to one client only,
// so if it's linked to another client it is moved here.
export async function savePending(env, token, keys) {
  const pending = await readPending(env, token);
  if (!pending) return null;
  const wanted = new Set(keys);
  const now = Date.now();
  const stmts = [];
  let saved = 0;
  for (const it of pending.items) {
    if (!wanted.has(`${it.platform}:${it.external_id}`)) continue;
    saved++;
    const tokenEnc = await encrypt(env.SESSION_SECRET, it.token);
    const existing = await env.DB.prepare(
      'SELECT id, client_id FROM accounts WHERE platform = ? AND external_id = ? ORDER BY (client_id = ?) DESC'
    ).bind(it.platform, it.external_id, pending.clientId).all();
    const [keep, ...dupes] = existing.results;
    if (keep) {
      stmts.push(env.DB.prepare('UPDATE accounts SET client_id = ?, name = ?, picture = ?, token_enc = ? WHERE id = ?')
        .bind(pending.clientId, it.name, it.picture, tokenEnc, keep.id));
      for (const d of dupes) stmts.push(env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(d.id));
    } else {
      stmts.push(env.DB.prepare(
        'INSERT INTO accounts (client_id, platform, external_id, name, picture, token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(pending.clientId, it.platform, it.external_id, it.name, it.picture, tokenEnc, now));
    }
  }
  stmts.push(env.DB.prepare('DELETE FROM pending_links WHERE token = ?').bind(token));
  await env.DB.batch(stmts);
  return { clientId: pending.clientId, saved };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The media of a post as a list; old posts only have image_url.
export function mediaOf(post) {
  if (post.media) {
    try { return typeof post.media === 'string' ? JSON.parse(post.media) : post.media; } catch { /* fall through */ }
  }
  return post.image_url ? [{ type: 'image', url: post.image_url }] : [];
}

// ---------- Facebook ----------
export async function publishFacebook(env, pageId, token, post) {
  const media = mediaOf(post);
  const video = media.find((m) => m.type === 'video');
  const images = media.filter((m) => m.type === 'image');
  const text = post.message || '';

  if (video) return post.fb_reel ? publishFacebookReel(env, pageId, token, video.url, text) : publishFacebookVideo(env, pageId, token, video.url, text);

  if (images.length > 1) {
    // Album: upload each photo unpublished, then one post that attaches them all.
    const ids = [];
    for (const img of images) {
      const r = await graph(env, `${pageId}/photos`, { method: 'POST', params: { url: img.url, published: 'false', access_token: token } });
      ids.push(r.id);
    }
    const params = { message: text, access_token: token };
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    const r = await graph(env, `${pageId}/feed`, { method: 'POST', params });
    return r.id;
  }

  if (images.length === 1) {
    const r = await graph(env, `${pageId}/photos`, { method: 'POST', params: { url: images[0].url, caption: text, access_token: token } });
    return r.post_id || r.id;
  }

  const params = { message: text, access_token: token };
  if (post.link) params.link = post.link;
  const r = await graph(env, `${pageId}/feed`, { method: 'POST', params });
  return r.id;
}

async function publishFacebookVideo(env, pageId, token, url, text) {
  const r = await graph(env, `${pageId}/videos`, { method: 'POST', params: { file_url: url, description: text, access_token: token } });
  return r.id;
}

// Facebook Reels: start an upload session, let Facebook fetch the file from our URL, then publish.
async function publishFacebookReel(env, pageId, token, url, text) {
  const start = await graph(env, `${pageId}/video_reels`, { method: 'POST', params: { upload_phase: 'start', access_token: token } });
  const base = env.META_RUPLOAD_BASE || 'https://rupload.facebook.com';
  const res = await fetch(`${base}/video-upload/${version(env)}/${start.video_id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_url: url },
  });
  const up = await res.json().catch(() => ({}));
  if (!res.ok || up.error || up.success === false) {
    throw new Error(up.error?.message || up.debug_info?.message || 'فيسبوك مقدرش ينزل الفيديو');
  }
  await graph(env, `${pageId}/video_reels`, {
    method: 'POST',
    params: { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: text, access_token: token },
  });
  return start.video_id;
}

// ---------- Instagram ----------
export async function containerStatus(env, id, token) {
  const s = await graph(env, id, { params: { fields: 'status_code,status', access_token: token } });
  return s;
}

async function waitForContainer(env, id, token, tries, delay) {
  for (let i = 0; i < tries; i++) {
    const s = await containerStatus(env, id, token);
    if (s.status_code === 'FINISHED') return 'FINISHED';
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new Error(`إنستجرام رفض الملف${s.status ? `: ${s.status}` : ''}`);
    }
    await sleep(delay);
  }
  return 'IN_PROGRESS';
}

export async function finishInstagram(env, igId, token, containerId) {
  const r = await graph(env, `${igId}/media_publish`, { method: 'POST', params: { creation_id: containerId, access_token: token } });
  return r.id;
}

// Returns the published media id, or { pending: containerId } when a video is still
// processing (the cron job finishes it later).
export async function publishInstagram(env, igId, token, post) {
  const media = mediaOf(post);
  const video = media.find((m) => m.type === 'video');
  const images = media.filter((m) => m.type === 'image');
  const caption = post.message || '';
  if (!media.length) throw new Error('إنستجرام محتاج صورة أو فيديو.');

  if (video) {
    const c = await graph(env, `${igId}/media`, {
      method: 'POST',
      params: { media_type: 'REELS', video_url: video.url, caption, share_to_feed: 'true', access_token: token },
    });
    const state = await waitForContainer(env, c.id, token, 6, 4000);
    if (state !== 'FINISHED') return { pending: c.id };
    return finishInstagram(env, igId, token, c.id);
  }

  if (images.length > 1) {
    const children = [];
    for (const img of images) {
      const c = await graph(env, `${igId}/media`, {
        method: 'POST',
        params: { image_url: img.url, is_carousel_item: 'true', access_token: token },
      });
      children.push(c.id);
    }
    for (const id of children) {
      if ((await waitForContainer(env, id, token, 8, 1500)) !== 'FINISHED') throw new Error('إنستجرام اتأخر في تجهيز الصور، جرّب تاني');
    }
    const album = await graph(env, `${igId}/media`, {
      method: 'POST',
      params: { media_type: 'CAROUSEL', children: children.join(','), caption, access_token: token },
    });
    if ((await waitForContainer(env, album.id, token, 8, 1500)) !== 'FINISHED') return { pending: album.id };
    return finishInstagram(env, igId, token, album.id);
  }

  const c = await graph(env, `${igId}/media`, { method: 'POST', params: { image_url: images[0].url, caption, access_token: token } });
  if ((await waitForContainer(env, c.id, token, 6, 2000)) !== 'FINISHED') return { pending: c.id };
  return finishInstagram(env, igId, token, c.id);
}
