import { checkPassword, sessionCookie, clearCookie, isAuthed } from './auth.js';
import { metaConfigured, readPending, savePending, mediaOf } from './meta.js';
import { startVideo, putChunk, finishVideo, videoExists, MediaError } from './media.js';
import { createInvite, revokeInvites } from './invite.js';
import { buildReport, createReportLink, clientForReportLink } from './reports.js';
import { adsOverview, setObjectStatus, setBudget, campaignDetails, pagePosts, boostPost, AdsError } from './ads.js';
import { providersStatus } from './providers.js';
import { whatsappLink, whatsappUnlink, WhatsAppError, GATEWAY, getWaLimit, setWaLimit, checkWaLimit } from './whatsapp.js';
import { syncFromSaved, syncStatus, ignoreKeys, clearIgnored } from './sync.js';
import { publishPost, finalizePost } from './publisher.js';
import { publicKey as pushPublicKey, subscribe as pushSubscribe, notifyAll } from './push.js';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const bad = (msg) => { throw new HttpError(400, msg); };

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

function cleanUrl(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (!/^https?:\/\//i.test(v)) bad('الرابط لازم يبدأ بـ http أو https');
  return v;
}

const POST_SELECT = `SELECT p.*, c.name AS client_name, c.color AS client_color,
  (SELECT json_group_array(json_object('id', pt.id, 'account_id', pt.account_id, 'status', pt.status,
     'error', pt.error, 'platform', a.platform, 'name', a.name))
   FROM post_targets pt JOIN accounts a ON a.id = pt.account_id WHERE pt.post_id = p.id) AS targets
  FROM posts p JOIN clients c ON c.id = p.client_id`;

const parsePost = (p) => ({ ...p, targets: JSON.parse(p.targets || '[]'), media: mediaOf(p) });

const MAX_IMAGES = 10;

// Media list from the form: up to 10 images (album) or exactly one video.
function readMedia(b) {
  let list = Array.isArray(b.media) ? b.media : b.image_url ? [{ type: 'image', url: b.image_url }] : [];
  list = list.map((m) => ({ type: m.type === 'video' ? 'video' : 'image', url: cleanUrl(m.url) })).filter((m) => m.url);
  const videos = list.filter((m) => m.type === 'video');
  if (videos.length > 1) bad('فيديو واحد بس في المنشور');
  if (videos.length && list.length > 1) bad('مينفعش تجمع فيديو وصور في نفس المنشور');
  if (list.length > MAX_IMAGES) bad(`أقصى عدد ${MAX_IMAGES} صور في الألبوم`);
  return list;
}

const MAX_SERIES = 200;

// Validates the post form (create or edit). `times` holds every publish time:
// one for a normal scheduled post, many for a repeat or custom-dates series.
async function readPostInput(env, b, { single = false, postId = 0 } = {}) {
  const db = env.DB;
  const clientId = Number(b.client_id);
  const accountIds = [...new Set((b.account_ids || []).map(Number).filter(Boolean))];
  const message = String(b.message || '').trim();
  const media = readMedia(b);
  const imageUrl = media.find((m) => m.type === 'image')?.url || null;
  const hasVideo = media.some((m) => m.type === 'video');
  const fbReel = hasVideo && Boolean(b.fb_reel);
  const link = cleanUrl(b.link);
  const mode = b.mode; // 'now' | 'schedule' | 'draft'
  if (!clientId) bad('اختار العميل');
  if (!accountIds.length) bad('اختار حساب واحد على الأقل');
  if (!message && !media.length) bad('اكتب نص المنشور أو ضيف صورة أو فيديو');
  for (const m of media) {
    if (m.type === 'video' && !(await videoExists(env, m.url))) bad('الفيديو ده اتمسح من التخزين (بيتمسح بعد النشر بأسبوع). ارفعه تاني.');
  }
  if (!['now', 'schedule', 'draft'].includes(mode)) bad('طريقة نشر غير معروفة');

  let times = [];
  if (mode === 'schedule') {
    const raw = Array.isArray(b.scheduled_times) ? b.scheduled_times : [b.scheduled_at];
    times = [...new Set(raw.map(Number).filter(Boolean))].sort((x, y) => x - y);
    if (!times.length) bad('اختار ميعاد النشر');
    if (times[0] < Date.now() - 60000) bad('فيه ميعاد فات. كل المواعيد لازم تكون في المستقبل.');
    if (single && times.length > 1) bad('التعديل بيكون لميعاد واحد بس');
    if (times.length > MAX_SERIES) bad(`أقصى عدد ${MAX_SERIES} منشور في المرة الواحدة`);
  }

  const placeholders = accountIds.map(() => '?').join(',');
  const owned = await db.prepare(`SELECT id, platform, name FROM accounts WHERE client_id = ? AND id IN (${placeholders})`)
    .bind(clientId, ...accountIds).all();
  if (owned.results.length !== accountIds.length) bad('فيه حساب مش تبع العميل ده');
  if (!media.length && owned.results.some((a) => a.platform === 'instagram')) bad('إنستجرام محتاج صورة أو فيديو. ضيفهم أو شيل حساب إنستجرام.');
  const picked = new Set(owned.results.map((a) => a.platform));
  if (!hasVideo && (picked.has('youtube') || picked.has('tiktok'))) bad(`${picked.has('youtube') ? 'يوتيوب' : 'تيك توك'} محتاج فيديو مرفوع على المنصة. ارفع فيديو أو شيل الحساب ده.`);
  if (hasVideo && picked.has('linkedin')) bad('لينكدإن: نشر الفيديو من المنصة لسه مش متاح. شيل لينكدإن أو استخدم صور.');
  if (picked.has('meta_ads')) bad('حسابات الإعلانات مش بتتنشر عليها منشورات');
  if (picked.has('whatsapp') && mode !== 'draft') {
    try {
      await checkWaLimit(env, owned.results.filter((a) => a.platform === 'whatsapp'), mode === 'now' ? [Date.now()] : times, postId);
    } catch (err) {
      if (err instanceof WhatsAppError) bad(err.message);
      throw err;
    }
  }

  return { clientId, accountIds, message, imageUrl, media: media.length ? JSON.stringify(media) : null, fbReel: fbReel ? 1 : 0, link, mode, times };
}

export async function handleApi(req, env, url) {
  try {
    return await route(req, env, url);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: err.message || 'حصل خطأ في السيرفر' }, 500);
  }
}

async function route(req, env, url) {
  const path = url.pathname.replace(/^\/api/, '');
  const method = req.method;
  const db = env.DB;

  // --- public routes ---
  if (path === '/login' && method === 'POST') {
    const { password } = await body(req);
    if (!(await checkPassword(env, password))) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      throw new HttpError(401, 'كلمة السر غلط');
    }
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env) });
  }
  if (path === '/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  // Read-only report shared with a client (no login).
  let pr = path.match(/^\/public\/report\/([0-9a-f-]{36})$/);
  if (pr && method === 'GET') {
    const clientId = await clientForReportLink(env, pr[1]);
    if (!clientId) throw new HttpError(404, 'لينك التقرير انتهى أو اتلغى');
    try {
      return json(await buildReport(env, clientId, url.searchParams.get('from'), url.searchParams.get('to')));
    } catch (err) { bad(err.message); }
  }

  if (!(await isAuthed(req, env))) throw new HttpError(401, 'سجّل الدخول الأول');

  // --- authenticated routes ---
  if (path === '/me') {
    return json({ ok: true, metaConfigured: metaConfigured(env), redirectUri: `${url.origin}/auth/meta/callback`, providers: providersStatus(env), origin: url.origin });
  }

  if (path === '/stats') {
    const monthAgo = Date.now() - 30 * 86400000;
    const [counts, upcoming] = await db.batch([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM clients) AS clients,
        (SELECT COUNT(*) FROM accounts) AS accounts,
        (SELECT COUNT(*) FROM posts WHERE status = 'scheduled') AS scheduled,
        (SELECT COUNT(*) FROM posts WHERE status = 'published' AND COALESCE(scheduled_at, created_at) >= ?) AS published30,
        (SELECT COUNT(*) FROM posts WHERE status IN ('failed', 'partial')) AS failed`).bind(monthAgo),
      db.prepare(`${POST_SELECT} WHERE p.status = 'scheduled' ORDER BY p.scheduled_at LIMIT 6`),
    ]);
    return json({ ...counts.results[0], upcoming: upcoming.results.map(parsePost) });
  }

  // Clients
  if (path === '/clients' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM accounts a WHERE a.client_id = c.id) AS account_count
       FROM clients c ORDER BY c.name`
    ).all();
    return json(results);
  }
  if (path === '/clients' && method === 'POST') {
    const { name, color, notes } = await body(req);
    if (!name || !String(name).trim()) bad('اكتب اسم العميل');
    const row = await db.prepare('INSERT INTO clients (name, color, notes, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .bind(String(name).trim(), color || '#4f46e5', notes || null, Date.now()).first();
    return json(row, 201);
  }
  let m = path.match(/^\/clients\/(\d+)$/);
  if (m && method === 'PUT') {
    const { name, color, notes } = await body(req);
    if (!name || !String(name).trim()) bad('اكتب اسم العميل');
    await db.prepare('UPDATE clients SET name = ?, color = ?, notes = ? WHERE id = ?')
      .bind(String(name).trim(), color || '#4f46e5', notes || null, m[1]).run();
    return json({ ok: true });
  }
  if (m && method === 'DELETE') {
    const { results: gone } = await db.prepare('SELECT platform, external_id FROM accounts WHERE client_id = ?').bind(m[1]).all();
    await db.prepare('DELETE FROM clients WHERE id = ?').bind(m[1]).run();
    await ignoreKeys(env, gone.map((a) => `${a.platform}:${a.external_id}`));
    return json({ ok: true });
  }

  // One-click sync of every Facebook page / Instagram / ad account.
  if (path === '/sync' && method === 'GET') return json(await syncStatus(env));
  if (path === '/sync' && method === 'POST') {
    try {
      return json(await syncFromSaved(env));
    } catch (err) {
      bad(err.message);
    }
  }
  if (path === '/sync/ignored' && method === 'DELETE') {
    await clearIgnored(env);
    return json({ ok: true });
  }

  // Video upload in chunks: start -> PUT each chunk -> finish.
  try {
    if (path === '/media/video' && method === 'POST') {
      if (!env.MEDIA) throw new HttpError(500, 'تخزين الميديا مش متفعّل');
      return json(await startVideo(env, await body(req)), 201);
    }
    let mv = path.match(/^\/media\/video\/([0-9a-f-]{36})\/(\d+)$/);
    if (mv && method === 'PUT') {
      await putChunk(env, mv[1], mv[2], req);
      return json({ ok: true });
    }
    mv = path.match(/^\/media\/video\/([0-9a-f-]{36})\/finish$/);
    if (mv && method === 'POST') return json(await finishVideo(env, mv[1], url.origin));
  } catch (err) {
    if (err instanceof MediaError) bad(err.message);
    throw err;
  }

  // Image upload. The browser already converts to JPEG and resizes, so we only check and store.
  if (path === '/media' && method === 'POST') {
    if (!env.MEDIA) throw new HttpError(500, 'تخزين الصور مش متفعّل');
    if (req.headers.get('Content-Type') !== 'image/jpeg') bad('الصورة لازم تكون JPEG');
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) bad('الملف فاضي');
    if (buf.byteLength > 8 * 1024 * 1024) bad('الصورة أكبر من 8 ميجا');
    const head = new Uint8Array(buf, 0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) bad('الملف مش صورة JPEG سليمة');
    const key = `${crypto.randomUUID()}.jpg`;
    // Kept for a year: long enough for any scheduled post.
    await env.MEDIA.put(key, buf, { expirationTtl: 365 * 86400 });
    return json({ url: `${url.origin}/media/${key}` }, 201);
  }

  // Picking which connected pages belong to a client
  m = path.match(/^\/connect\/([0-9a-f-]{36})$/);
  if (m && method === 'GET') {
    const pending = await readPending(env, m[1]);
    if (!pending) throw new HttpError(404, 'انتهت صلاحية الربط (30 دقيقة). دوس "ربط فيسبوك وإنستجرام" تاني.');
    const { results: linked } = await db.prepare(
      'SELECT a.platform, a.external_id, a.client_id, c.name AS client_name FROM accounts a JOIN clients c ON c.id = a.client_id'
    ).all();
    const owner = new Map(linked.map((l) => [`${l.platform}:${l.external_id}`, l]));
    return json({
      client_id: pending.clientId,
      client_name: pending.clientName,
      ads_note: pending.items.find((it) => it.platform === '_note')?.name || null,
      items: pending.items.filter((it) => it.platform !== '_note').map((it) => {
        const o = owner.get(`${it.platform}:${it.external_id}`);
        return {
          key: `${it.platform}:${it.external_id}`, platform: it.platform, name: it.name, picture: it.picture, page_id: it.page_id,
          linked_client_id: o?.client_id || null, linked_client_name: o?.client_name || null,
        };
      }),
    });
  }
  if (m && method === 'POST') {
    const { keys } = await body(req);
    if (!Array.isArray(keys) || !keys.length) bad('اختار حساب واحد على الأقل');
    const result = await savePending(env, m[1], keys.map(String));
    if (!result) throw new HttpError(404, 'انتهت صلاحية الربط (30 دقيقة). دوس "ربط فيسبوك وإنستجرام" تاني.');
    return json(result);
  }

  // Meta Ads
  try {
    let ad = path.match(/^\/ads\/(\d+)$/);
    if (ad && method === 'GET') return json(await adsOverview(env, Number(ad[1]), url.searchParams.get('from'), url.searchParams.get('to')));
    ad = path.match(/^\/ads\/(\d+)\/page-posts$/);
    if (ad && method === 'GET') return json(await pagePosts(env, Number(ad[1])));
    ad = path.match(/^\/ads\/(?:campaigns|objects)\/(\d+)\/status$/);
    if (ad && method === 'POST') {
      const b = await body(req);
      return json(await setObjectStatus(env, Number(b.account_id), ad[1], b.status));
    }
    ad = path.match(/^\/ads\/objects\/(\d+)\/budget$/);
    if (ad && method === 'POST') {
      const b = await body(req);
      return json(await setBudget(env, Number(b.account_id), ad[1], b.amount));
    }
    ad = path.match(/^\/ads\/accounts\/(\d+)\/campaigns\/(\d+)$/);
    if (ad && method === 'GET') {
      return json(await campaignDetails(env, Number(ad[1]), ad[2], url.searchParams.get('from'), url.searchParams.get('to')));
    }
    if (path === '/ads/boost' && method === 'POST') return json(await boostPost(env, await body(req)), 201);
  } catch (err) {
    if (err instanceof AdsError) bad(err.message);
    throw err;
  }

  // Reports
  let rp = path.match(/^\/reports\/(\d+)$/);
  if (rp && method === 'GET') {
    try {
      return json(await buildReport(env, Number(rp[1]), url.searchParams.get('from'), url.searchParams.get('to'), { refresh: url.searchParams.get('refresh') === '1' }));
    } catch (err) { bad(err.message); }
  }
  rp = path.match(/^\/reports\/(\d+)\/link$/);
  if (rp && method === 'POST') {
    const c = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(rp[1]).first();
    if (!c) throw new HttpError(404, 'العميل مش موجود');
    return json(await createReportLink(env, c.id, url.origin), 201);
  }

  // Invite link for a client to connect their own pages.
  let inv = path.match(/^\/clients\/(\d+)\/invites$/);
  if (inv && method === 'POST') {
    const c = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(inv[1]).first();
    if (!c) throw new HttpError(404, 'العميل مش موجود');
    return json(await createInvite(env, c.id, url.origin), 201);
  }
  if (inv && method === 'DELETE') return json({ deleted: await revokeInvites(env, Number(inv[1])) });

  // ---------- WhatsApp statuses (shared from the phone in one tap) ----------
  if (path === '/accounts/whatsapp' && method === 'POST') {
    const { client_id, name } = await body(req);
    const client = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(Number(client_id)).first();
    if (!client) bad('العميل مش موجود');
    const label = String(name || '').trim().slice(0, 60) || 'حالة واتساب';
    const row = await db.prepare(
      "INSERT INTO accounts (client_id, platform, external_id, name, picture, token_enc, created_at) VALUES (?, 'whatsapp', ?, ?, NULL, '', ?) RETURNING id"
    ).bind(client.id, crypto.randomUUID(), label, Date.now()).first();
    return json(row, 201);
  }

  // Automatic statuses (Whapi): save the token, show the QR / connection state.
  let wa = path.match(/^\/whatsapp\/accounts\/(\d+)\/(link|unlink)$/);
  if (wa) {
    try {
      if (wa[2] === 'link' && method === 'GET') return json(await whatsappLink(env, Number(wa[1])));
      if (wa[2] === 'unlink' && method === 'GET' && env.WA_MEDIA_TEST_HTTP) {
        return json(await env.WA_GATEWAY.get(env.WA_GATEWAY.idFromName('debug')).debugPrepareMedia(JSON.parse(url.searchParams.get('m'))));
      }
      if (wa[2] === 'unlink' && method === 'POST') return json(await whatsappUnlink(env, Number(wa[1])));
    } catch (err) {
      if (err instanceof WhatsAppError) bad(err.message);
      throw err;
    }
  }

  if (path === '/whatsapp/limit' && method === 'GET') return json({ limit: await getWaLimit(env) });
  if (path === '/whatsapp/limit' && method === 'PUT') return json({ limit: await setWaLimit(env, (await body(req)).limit) });

  if (path === '/whatsapp/count' && method === 'GET') {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM post_targets WHERE status = 'manual'").first();
    return json({ count: r.n });
  }

  if (path === '/whatsapp/queue' && method === 'GET') {
    const sel = `SELECT pt.id AS target_id, pt.status AS target_status, p.id AS post_id, p.message, p.image_url, p.media,
        p.scheduled_at, p.created_at, a.name AS account_name, c.name AS client_name, c.color AS client_color
      FROM post_targets pt JOIN posts p ON p.id = pt.post_id JOIN accounts a ON a.id = pt.account_id JOIN clients c ON c.id = p.client_id
      WHERE a.platform = 'whatsapp'`;
    const [ready, upcoming] = await db.batch([
      db.prepare(`${sel} AND pt.status = 'manual' ORDER BY COALESCE(p.scheduled_at, p.created_at)`),
      db.prepare(`${sel} AND pt.status = 'pending' AND p.status = 'scheduled' AND p.scheduled_at <= ? ORDER BY p.scheduled_at LIMIT 30`)
        .bind(Date.now() + 7 * 86400000),
    ]);
    const shape = (r) => ({ ...r, media: mediaOf(r) });
    return json({ ready: ready.results.map(shape), upcoming: upcoming.results.map(shape) });
  }

  let wt = path.match(/^\/whatsapp\/targets\/(\d+)\/(done|skip)$/);
  if (wt && method === 'POST') {
    const t = await db.prepare(
      "SELECT pt.post_id FROM post_targets pt JOIN accounts a ON a.id = pt.account_id WHERE pt.id = ? AND a.platform = 'whatsapp' AND pt.status = 'manual'"
    ).bind(wt[1]).first();
    if (!t) bad('الحالة دي اتنشرت أو اتشالت خلاص');
    if (wt[2] === 'done') {
      await db.prepare("UPDATE post_targets SET status = 'published', error = NULL WHERE id = ?").bind(wt[1]).run();
    } else {
      await db.prepare("UPDATE post_targets SET status = 'failed', error = 'اتخطت (منزلتش على الحالة)' WHERE id = ?").bind(wt[1]).run();
    }
    return json({ ok: true, status: await finalizePost(env, t.post_id) });
  }

  // Phone notifications
  if (path === '/push/key' && method === 'GET') return json({ publicKey: await pushPublicKey(env) });
  if (path === '/push/subscribe' && method === 'POST') {
    const { endpoint } = await body(req);
    try { await pushSubscribe(env, endpoint); } catch (err) { bad(err.message); }
    return json({ ok: true });
  }
  if (path === '/push/test' && method === 'POST') return json({ sent: await notifyAll(env) });

  // Accounts
  if (path === '/accounts' && method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const sql = `SELECT id, client_id, platform, external_id, name, picture, created_at,
      CASE WHEN platform = 'whatsapp' AND token_enc = '${GATEWAY}' THEN 1 ELSE 0 END AS auto FROM accounts
      ${clientId ? 'WHERE client_id = ?' : ''} ORDER BY platform, name`;
    const stmt = clientId ? db.prepare(sql).bind(clientId) : db.prepare(sql);
    return json((await stmt.all()).results);
  }
  m = path.match(/^\/accounts\/(\d+)$/);
  if (m && method === 'PUT') {
    const { client_id } = await body(req);
    const target = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(Number(client_id)).first();
    if (!target) bad('العميل مش موجود');
    const acc = await db.prepare('SELECT platform, external_id FROM accounts WHERE id = ?').bind(m[1]).first();
    if (!acc) throw new HttpError(404, 'الحساب مش موجود');
    // Drop a duplicate of the same account already sitting on the target client.
    await db.batch([
      db.prepare('DELETE FROM accounts WHERE client_id = ? AND platform = ? AND external_id = ? AND id != ?')
        .bind(target.id, acc.platform, acc.external_id, m[1]),
      db.prepare('UPDATE accounts SET client_id = ? WHERE id = ?').bind(target.id, m[1]),
    ]);
    return json({ ok: true });
  }
  if (m && method === 'DELETE') {
    const acc = await db.prepare('SELECT platform, external_id FROM accounts WHERE id = ?').bind(m[1]).first();
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(m[1]).run();
    if (acc) await ignoreKeys(env, [`${acc.platform}:${acc.external_id}`]);
    return json({ ok: true });
  }

  // Posts
  if (path === '/posts' && method === 'GET') {
    const where = [];
    const args = [];
    const q = url.searchParams;
    if (q.get('client_id')) { where.push('p.client_id = ?'); args.push(q.get('client_id')); }
    if (q.get('status')) { where.push('p.status = ?'); args.push(q.get('status')); }
    if (q.get('from')) { where.push('COALESCE(p.scheduled_at, p.created_at) >= ?'); args.push(Number(q.get('from'))); }
    if (q.get('to')) { where.push('COALESCE(p.scheduled_at, p.created_at) < ?'); args.push(Number(q.get('to'))); }
    const sql = `${POST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 500`;
    const { results } = await db.prepare(sql).bind(...args).all();
    return json(results.map(parsePost));
  }

  // Create: one post, or a whole series (repeats / custom dates) sharing a series_id.
  if (path === '/posts' && method === 'POST') {
    const input = await readPostInput(env, await body(req));
    const now = Date.now();
    const seriesId = input.times.length > 1 ? crypto.randomUUID() : null;
    const status = input.mode === 'draft' ? 'draft' : input.mode === 'now' ? 'publishing' : 'scheduled';
    const slots = input.mode === 'schedule' ? input.times : [null];

    const ids = [];
    // D1 batches are limited, so insert in chunks.
    for (let i = 0; i < slots.length; i += 50) {
      const chunk = slots.slice(i, i + 50);
      const res = await db.batch(chunk.map((at) => db.prepare(
        'INSERT INTO posts (client_id, message, image_url, media, fb_reel, link, scheduled_at, status, created_at, series_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).bind(input.clientId, input.message, input.imageUrl, input.media, input.fbReel, input.link, at, status, now, seriesId)));
      ids.push(...res.map((r) => r.results[0].id));
    }
    const targetStmts = ids.flatMap((pid) => input.accountIds.map((aid) =>
      db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)').bind(pid, aid)));
    for (let i = 0; i < targetStmts.length; i += 90) await db.batch(targetStmts.slice(i, i + 90));

    if (input.mode === 'now') await publishPost(env, ids[0]);
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(ids[0]).first();
    return json({ ...parsePost(saved), created: ids.length }, 201);
  }

  m = path.match(/^\/posts\/(\d+)\/publish$/);
  if (m && method === 'POST') {
    const claim = await db.prepare(
      "UPDATE posts SET status = 'publishing' WHERE id = ? AND status IN ('draft', 'scheduled', 'failed', 'partial')"
    ).bind(m[1]).run();
    if (!claim.meta.changes) bad('المنشور بيتنشر دلوقتي أو اتنشر خلاص');
    await publishPost(env, Number(m[1]));
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(m[1]).first();
    return json(parsePost(saved));
  }

  // Move a post to a new time (calendar drag or "change time").
  m = path.match(/^\/posts\/(\d+)\/move$/);
  if (m && method === 'POST') {
    const { scheduled_at, undo_status } = await body(req);
    const at = Number(scheduled_at);
    const editable = ['draft', 'scheduled', 'failed', 'partial'];
    // Undo puts the post back exactly as it was (time and status), even if that time has passed.
    const undo = editable.includes(undo_status);
    if (!at || (!undo && at < Date.now() - 60000)) bad('الميعاد الجديد لازم يكون في المستقبل');
    if (undo && undo_status === 'scheduled' && at < Date.now() - 60000) bad('الميعاد الأصلي فات، مينفعش يرجع. غيّر الميعاد من المنشور.');
    const p = await db.prepare('SELECT status FROM posts WHERE id = ?').bind(m[1]).first();
    if (!p) throw new HttpError(404, 'المنشور مش موجود');
    if (!editable.includes(p.status)) bad('المنشور ده اتنشر خلاص، مينفعش يتنقل. اعمل منه نسخة.');
    // A draft stays a draft; anything else becomes scheduled for the new time.
    const status = undo ? undo_status : p.status === 'draft' ? 'draft' : 'scheduled';
    await db.prepare('UPDATE posts SET scheduled_at = ?, status = ? WHERE id = ?').bind(at, status, m[1]).run();
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(m[1]).first();
    return json(parsePost(saved));
  }

  // Copy a post (any status) to a new time.
  m = path.match(/^\/posts\/(\d+)\/duplicate$/);
  if (m && method === 'POST') {
    const { scheduled_at } = await body(req);
    const at = Number(scheduled_at);
    if (!at || at < Date.now() - 60000) bad('ميعاد النسخة لازم يكون في المستقبل');
    const src = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(m[1]).first();
    if (!src) throw new HttpError(404, 'المنشور مش موجود');
    const { results: targets } = await db.prepare('SELECT account_id FROM post_targets WHERE post_id = ?').bind(m[1]).all();
    if (!targets.length) bad('المنشور ده ملوش حسابات. الحسابات بتاعته اتشالت.');
    for (const md of mediaOf(src)) {
      if (md.type === 'video' && !(await videoExists(env, md.url))) bad('الفيديو بتاع المنشور ده اتمسح من التخزين (بيتمسح بعد النشر بأسبوع). استخدم "نسخ وتكرار" وارفعه تاني.');
    }
    const copy = await db.prepare(
      "INSERT INTO posts (client_id, message, image_url, media, fb_reel, link, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?) RETURNING id"
    ).bind(src.client_id, src.message, src.image_url, src.media, src.fb_reel || 0, src.link, at, Date.now()).first();
    await db.batch(targets.map((t) => db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)').bind(copy.id, t.account_id)));
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(copy.id).first();
    return json(parsePost(saved), 201);
  }

  // Delete the upcoming (not yet published) posts of a series.
  m = path.match(/^\/series\/([0-9a-f-]{36})$/);
  if (m && method === 'DELETE') {
    const r = await db.prepare("DELETE FROM posts WHERE series_id = ? AND status IN ('scheduled', 'draft') RETURNING id").bind(m[1]).all();
    return json({ ok: true, deleted: r.results.length });
  }

  m = path.match(/^\/posts\/(\d+)$/);
  if (m && method === 'GET') {
    const p = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(m[1]).first();
    if (!p) throw new HttpError(404, 'المنشور مش موجود');
    return json(parsePost(p));
  }
  // Edit a post that hasn't been published yet (only this one, not the rest of its series).
  if (m && method === 'PUT') {
    const existing = await db.prepare('SELECT status FROM posts WHERE id = ?').bind(m[1]).first();
    if (!existing) throw new HttpError(404, 'المنشور مش موجود');
    if (!['draft', 'scheduled', 'failed', 'partial'].includes(existing.status)) bad('المنشور ده اتنشر خلاص. اعمل منه نسخة بدل التعديل.');
    const input = await readPostInput(env, await body(req), { single: true, postId: Number(m[1]) });
    const status = input.mode === 'draft' ? 'draft' : input.mode === 'now' ? 'publishing' : 'scheduled';
    const at = input.mode === 'schedule' ? input.times[0] : null;
    await db.batch([
      db.prepare('UPDATE posts SET client_id = ?, message = ?, image_url = ?, media = ?, fb_reel = ?, link = ?, scheduled_at = ?, status = ?, media_cleaned = 0 WHERE id = ?')
        .bind(input.clientId, input.message, input.imageUrl, input.media, input.fbReel, input.link, at, status, m[1]),
      db.prepare('DELETE FROM post_targets WHERE post_id = ?').bind(m[1]),
      ...input.accountIds.map((aid) => db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)').bind(m[1], aid)),
    ]);
    if (input.mode === 'now') await publishPost(env, Number(m[1]));
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(m[1]).first();
    return json(parsePost(saved));
  }
  if (m && method === 'DELETE') {
    await db.prepare('DELETE FROM posts WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
