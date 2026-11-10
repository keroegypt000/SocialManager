// YouTube, LinkedIn and TikTok: connect (OAuth) and publish.
// Each one switches on when its keys are set as Cloudflare secrets:
//   YouTube:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   LinkedIn: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
//   TikTok:   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Tokens are stored encrypted as JSON { access_token, refresh_token, expires_at } and refreshed when needed.
// Base URLs can be overridden (GOOGLE_*_BASE, LINKEDIN_*_BASE, TIKTOK_*_BASE) for local testing.
import { encrypt, decrypt } from './crypto.js';
import { makeState, readState } from './auth.js';
import { openVideo, imageBytes } from './media.js';

const b = (env, key, def) => env[key] || def;

const PROVIDERS = {
  youtube: {
    configured: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    authUrl(env, redirect, state) {
      const u = new URL(`${b(env, 'GOOGLE_AUTH_BASE', 'https://accounts.google.com')}/o/oauth2/v2/auth`);
      u.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', state,
        scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
        access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      });
      return u.toString();
    },
    async token(env, params) {
      const res = await fetch(`${b(env, 'GOOGLE_TOKEN_BASE', 'https://oauth2.googleapis.com')}/token`, {
        method: 'POST',
        body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }),
      });
      return jsonOrThrow(res, 'Google');
    },
    async accounts(env, tok) {
      const res = await fetch(`${b(env, 'GOOGLE_API_BASE', 'https://www.googleapis.com')}/youtube/v3/channels?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const data = await jsonOrThrow(res, 'YouTube');
      return (data.items || []).map((c) => ({ external_id: c.id, name: c.snippet?.title || 'قناة يوتيوب', picture: c.snippet?.thumbnails?.default?.url || null }));
    },
  },
  linkedin: {
    configured: (env) => Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET),
    authUrl(env, redirect, state) {
      const u = new URL(`${b(env, 'LINKEDIN_AUTH_BASE', 'https://www.linkedin.com')}/oauth/v2/authorization`);
      u.search = new URLSearchParams({ response_type: 'code', client_id: env.LINKEDIN_CLIENT_ID, redirect_uri: redirect, state, scope: 'openid profile w_member_social' });
      return u.toString();
    },
    async token(env, params) {
      const res = await fetch(`${b(env, 'LINKEDIN_AUTH_BASE', 'https://www.linkedin.com')}/oauth/v2/accessToken`, {
        method: 'POST',
        body: new URLSearchParams({ client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET, ...params }),
      });
      return jsonOrThrow(res, 'LinkedIn');
    },
    async accounts(env, tok) {
      const res = await fetch(`${b(env, 'LINKEDIN_API_BASE', 'https://api.linkedin.com')}/v2/userinfo`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const me = await jsonOrThrow(res, 'LinkedIn');
      return [{ external_id: `urn:li:person:${me.sub}`, name: me.name || 'حساب لينكدإن', picture: me.picture || null }];
    },
  },
  tiktok: {
    configured: (env) => Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
    authUrl(env, redirect, state) {
      const u = new URL(`${b(env, 'TIKTOK_AUTH_BASE', 'https://www.tiktok.com')}/v2/auth/authorize/`);
      u.search = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, response_type: 'code', scope: 'user.info.basic,video.publish,video.upload', redirect_uri: redirect, state });
      return u.toString();
    },
    async token(env, params) {
      const res = await fetch(`${b(env, 'TIKTOK_API_BASE', 'https://open.tiktokapis.com')}/v2/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, ...params }),
      });
      return jsonOrThrow(res, 'TikTok');
    },
    async accounts(env, tok) {
      const res = await fetch(`${b(env, 'TIKTOK_API_BASE', 'https://open.tiktokapis.com')}/v2/user/info/?fields=open_id,display_name,avatar_url`, {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      const data = await jsonOrThrow(res, 'TikTok');
      const u = data.data?.user || {};
      return [{ external_id: u.open_id || tok.open_id, name: u.display_name || 'حساب تيك توك', picture: u.avatar_url || null }];
    },
  },
};

export const EXTRA_PLATFORMS = Object.keys(PROVIDERS);
export const providersStatus = (env) => Object.fromEntries(EXTRA_PLATFORMS.map((p) => [p, PROVIDERS[p].configured(env)]));

async function jsonOrThrow(res, who) {
  const data = await res.json().catch(() => ({}));
  const err = data.error && typeof data.error === 'object' && data.error.code && data.error.code !== 'ok' ? data.error : null;
  if (!res.ok || err || (typeof data.error === 'string' && data.error)) {
    const msg = err?.message || data.error_description || data.message || (typeof data.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
    throw new Error(`${who}: ${msg}`);
  }
  return data;
}

const redirectFor = (origin, p) => `${origin}/auth/${p}/callback`;

export async function providerStart(env, url, platform) {
  const p = PROVIDERS[platform];
  if (!p?.configured(env)) throw new Error(`${platform} لسه مش متفعّل. ضيف مفاتيحه في Cloudflare (الخطوات في README).`);
  const clientId = Number(url.searchParams.get('client_id'));
  if (!clientId) throw new Error('client_id missing');
  return Response.redirect(p.authUrl(env, redirectFor(url.origin, platform), await makeState(env, `${platform}-${clientId}`)), 302);
}

export async function providerCallback(env, url, platform) {
  const back = (q) => Response.redirect(`${url.origin}/#/clients?${q}`, 302);
  const p = PROVIDERS[platform];
  const subject = await readState(env, url.searchParams.get('state'));
  const m = String(subject || '').match(new RegExp(`^${platform}-(\\d+)$`));
  if (url.searchParams.get('error')) return back('error=' + encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error')));
  if (!m) return back('error=' + encodeURIComponent('انتهت صلاحية طلب الربط، جرّب تاني'));
  const clientId = Number(m[1]);

  const tok = await p.token(env, { code: url.searchParams.get('code'), grant_type: 'authorization_code', redirect_uri: redirectFor(url.origin, platform) });
  const accounts = await p.accounts(env, tok);
  if (!accounts.length) return back('error=' + encodeURIComponent('مالقيناش حساب أو قناة على الحساب ده'));
  const stored = await encrypt(env.SESSION_SECRET, JSON.stringify({
    access_token: tok.access_token, refresh_token: tok.refresh_token || null,
    expires_at: tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : null,
  }));
  const now = Date.now();
  await env.DB.batch(accounts.map((a) => env.DB.prepare(
    `INSERT INTO accounts (client_id, platform, external_id, name, picture, token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client_id, platform, external_id) DO UPDATE SET name = excluded.name, picture = excluded.picture, token_enc = excluded.token_enc`
  ).bind(clientId, platform, a.external_id, a.name, a.picture, stored, now)));
  return back(`connected=${accounts.length}`);
}

// A valid access token for an account, refreshing (and saving) it when it's about to expire.
async function freshToken(env, acc, platform) {
  const tok = JSON.parse(await decrypt(env.SESSION_SECRET, acc.token_enc));
  if (!tok.expires_at || tok.expires_at - Date.now() > 5 * 60 * 1000) return tok.access_token;
  if (!tok.refresh_token) throw new Error('صلاحية الحساب انتهت. اربطه تاني من صفحة العملاء.');
  const r = await PROVIDERS[platform].token(env, { grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  const next = {
    access_token: r.access_token,
    refresh_token: r.refresh_token || tok.refresh_token,
    expires_at: r.expires_in ? Date.now() + Number(r.expires_in) * 1000 : null,
  };
  await env.DB.prepare('UPDATE accounts SET token_enc = ? WHERE id = ?').bind(await encrypt(env.SESSION_SECRET, JSON.stringify(next)), acc.id).run();
  return next.access_token;
}

const firstLine = (s, max) => (String(s || '').split('\n').find((l) => l.trim()) || '').trim().slice(0, max);

// ---------- publishing ----------
async function publishYouTube(env, acc, post, media) {
  const video = media.find((m) => m.type === 'video');
  if (!video) throw new Error('يوتيوب محتاج فيديو.');
  const file = await openVideo(env, video.url);
  if (!file) throw new Error('يوتيوب بيقبل فيديو مرفوع على المنصة بس.');
  const token = await freshToken(env, acc, 'youtube');
  const api = b(env, 'GOOGLE_API_BASE', 'https://www.googleapis.com');
  const title = firstLine(post.message, 100) || 'فيديو جديد';
  const init = await fetch(`${api}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': file.type, 'X-Upload-Content-Length': String(file.size),
    },
    body: JSON.stringify({
      snippet: { title, description: String(post.message || '').slice(0, 4900), categoryId: '22' },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) await jsonOrThrow(init, 'YouTube');
  const uploadUrl = init.headers.get('Location');
  if (!uploadUrl) throw new Error('YouTube: مرجعش لينك الرفع');
  const { readable, writable } = new FixedLengthStream(file.size);
  file.stream().pipeTo(writable).catch(() => {});
  const up = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: readable });
  const data = await jsonOrThrow(up, 'YouTube');
  return data.id;
}

async function linkedinImage(env, token, owner, url) {
  const api = b(env, 'LINKEDIN_API_BASE', 'https://api.linkedin.com');
  const res = await fetch(`${api}/rest/images?action=initializeUpload`, {
    method: 'POST', headers: linkedinHeaders(env, token), body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  const init = await jsonOrThrow(res, 'LinkedIn');
  const { buf } = await imageBytes(env, url);
  const put = await fetch(init.value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: buf });
  if (!put.ok) throw new Error(`LinkedIn: رفع الصورة فشل (${put.status})`);
  return init.value.image;
}

const linkedinHeaders = (env, token) => ({
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  'LinkedIn-Version': env.LINKEDIN_VERSION || '202610', 'X-Restli-Protocol-Version': '2.0.0',
});

async function publishLinkedIn(env, acc, post, media) {
  if (media.some((m) => m.type === 'video')) throw new Error('لينكدإن: نشر الفيديو من المنصة لسه مش متاح، انشر صور أو نص.');
  const token = await freshToken(env, acc, 'linkedin');
  const owner = acc.external_id;
  const images = [];
  for (const m of media) images.push(await linkedinImage(env, token, owner, m.url));
  const body = {
    author: owner, commentary: String(post.message || '').slice(0, 3000), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
  };
  if (images.length === 1) body.content = { media: { id: images[0] } };
  if (images.length > 1) body.content = { multiImage: { images: images.map((id) => ({ id })) } };
  const res = await fetch(`${b(env, 'LINKEDIN_API_BASE', 'https://api.linkedin.com')}/rest/posts`, {
    method: 'POST', headers: linkedinHeaders(env, token), body: JSON.stringify(body),
  });
  if (!res.ok) await jsonOrThrow(res, 'LinkedIn');
  return res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || 'ok';
}

async function tiktokCall(env, token, path, body) {
  const res = await fetch(`${b(env, 'TIKTOK_API_BASE', 'https://open.tiktokapis.com')}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body),
  });
  return jsonOrThrow(res, 'TikTok');
}

// TikTok: upload our video in chunks, then the cron job checks until it's published.
async function publishTikTok(env, acc, post, media) {
  const video = media.find((m) => m.type === 'video');
  if (!video) throw new Error('تيك توك محتاج فيديو.');
  const file = await openVideo(env, video.url);
  if (!file) throw new Error('تيك توك بيقبل فيديو مرفوع على المنصة بس.');
  const token = await freshToken(env, acc, 'tiktok');
  const creator = await tiktokCall(env, token, '/v2/post/publish/creator_info/query/', {});
  const options = creator.data?.privacy_level_options || [];
  // Apps not yet audited by TikTok can only post privately (SELF_ONLY).
  const privacy = options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : options[0] || 'SELF_ONLY';

  // TikTok chunks: 5-64 MB each, the last one may be bigger; small files go in one piece.
  const MB = 1024 * 1024;
  const chunkSize = file.size <= 64 * MB ? file.size : 20 * MB;
  const count = file.size <= 64 * MB ? 1 : Math.floor(file.size / chunkSize);
  const init = await tiktokCall(env, token, '/v2/post/publish/video/init/', {
    post_info: { title: String(post.message || '').slice(0, 2200), privacy_level: privacy, disable_comment: false, disable_duet: false, disable_stitch: false },
    source_info: { source: 'FILE_UPLOAD', video_size: file.size, chunk_size: chunkSize, total_chunk_count: count },
  });
  const { publish_id: publishId, upload_url: uploadUrl } = init.data || {};
  if (!uploadUrl) throw new Error('TikTok: مرجعش لينك الرفع');
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? file.size - 1 : start + chunkSize - 1;
    const { readable, writable } = new FixedLengthStream(end - start + 1);
    file.stream(start, end).pipeTo(writable).catch(() => {});
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type, 'Content-Range': `bytes ${start}-${end}/${file.size}` },
      body: readable,
    });
    if (!put.ok) throw new Error(`TikTok: رفع الجزء ${i + 1} فشل (${put.status})`);
  }
  return { pending: `tiktok:${publishId}` };
}

export async function tiktokStatus(env, acc, publishId) {
  const token = await freshToken(env, acc, 'tiktok');
  const r = await tiktokCall(env, token, '/v2/post/publish/status/fetch/', { publish_id: publishId });
  return r.data || {};
}

export const EXTRA_PUBLISHERS = { youtube: publishYouTube, linkedin: publishLinkedIn, tiktok: publishTikTok };
