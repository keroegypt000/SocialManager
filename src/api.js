import { checkPassword, sessionCookie, clearCookie, currentUser, hashPassword, verifyPassword, memberFromRow, PERMS } from './auth.js';
import { authorize, Forbidden, clientFilter } from './access.js';
import { metaConfigured, readPending, savePending, mediaOf } from './meta.js';
import { startVideo, putChunk, finishVideo, videoExists, MediaError } from './media.js';
import { createInvite, revokeInvites } from './invite.js';
import { buildReport, createReportLink, clientForReportLink } from './reports.js';
import { adsOverview, setObjectStatus, setBudget, campaignDetails, pagePosts, boostPost, AdsError } from './ads.js';
import { providersStatus } from './providers.js';
import { whatsappLink, whatsappUnlink, WhatsAppError, GATEWAY, getWaLimit, setWaLimit, checkWaLimit, getWaSettings, setWaMediaOnly } from './whatsapp.js';
import { syncFromSaved, syncStatus, ignoreKeys, clearIgnored } from './sync.js';
import { publishPost, finalizePost } from './publisher.js';
import { publishInBackground } from './queue.js';
import { listContent, liveDetails } from './content.js';
import { removeTarget, removePost, RemoveError } from './remove.js';
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
  const num = (v, max) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Math.round(Number(v) * 100) / 100 : undefined);
  list = list.map((m) => ({
    type: m.type === 'video' ? 'video' : 'image',
    url: cleanUrl(m.url),
    // Measured by the browser at upload (used for WhatsApp statuses).
    ...(m.type === 'video' ? { duration: num(m.duration, 3600), width: num(m.width, 10000), height: num(m.height, 10000) } : {}),
  })).filter((m) => m.url);
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
    const { username, password } = await body(req);
    const uname = String(username || '').trim();
    const slow = () => new Promise((r) => setTimeout(r, 800)); // slow down guessing
    // The owner: no username (or "admin") + ADMIN_PASSWORD.
    if (!uname || uname.toLowerCase() === 'admin') {
      if (!(await checkPassword(env, password))) { await slow(); throw new HttpError(401, 'كلمة السر غلط'); }
      return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env, 0, 0) });
    }
    const u = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').bind(uname).first();
    if (!u || !(await verifyPassword(password, u.pass_hash))) { await slow(); throw new HttpError(401, 'اسم المستخدم أو كلمة السر غلط'); }
    await db.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(Date.now(), u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(env, u.id, u.session_ver) });
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

  const user = await currentUser(req, env);
  if (!user) throw new HttpError(401, 'سجّل الدخول الأول');
  try {
    await authorize(env, user, req, path, method);
  } catch (err) {
    if (err instanceof Forbidden) throw new HttpError(403, err.message);
    throw err;
  }
  const scope = (column) => clientFilter(user, column); // SQL: only this user's clients

  // --- authenticated routes ---
  if (path === '/me') {
    return json({
      ok: true, metaConfigured: metaConfigured(env), redirectUri: `${url.origin}/auth/meta/callback`, providers: providersStatus(env), origin: url.origin,
      user: { id: user.id, owner: user.owner, name: user.name, username: user.username, perms: user.perms, clients: user.clients },
    });
  }

  if (path === '/stats') {
    const monthAgo = Date.now() - 30 * 86400000;
    const [counts, upcoming] = await db.batch([
      db.prepare(`SELECT
        (SELECT COUNT(*) FROM clients WHERE ${scope('id')}) AS clients,
        (SELECT COUNT(*) FROM accounts WHERE ${scope('client_id')}) AS accounts,
        (SELECT COUNT(*) FROM posts WHERE status = 'scheduled' AND ${scope('client_id')}) AS scheduled,
        (SELECT COUNT(*) FROM posts WHERE status = 'published' AND COALESCE(scheduled_at, created_at) >= ? AND ${scope('client_id')}) AS published30,
        (SELECT COUNT(*) FROM posts WHERE status IN ('failed', 'partial') AND ${scope('client_id')}) AS failed`).bind(monthAgo),
      db.prepare(`${POST_SELECT} WHERE p.status = 'scheduled' AND ${scope('p.client_id')} ORDER BY p.scheduled_at LIMIT 6`),
    ]);
    return json({ ...counts.results[0], upcoming: upcoming.results.map(parsePost) });
  }

  // Clients
  if (path === '/clients' && method === 'GET') {
    const { results } = await db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM accounts a WHERE a.client_id = c.id) AS account_count
       FROM clients c WHERE ${scope('c.id')} ORDER BY c.name`
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

  // ---------- 📺 content: everything sent to every platform ----------
  if (path === '/content' && method === 'GET') {
    const q = url.searchParams;
    const allowedPlatforms = user.owner || user.perms.includes('posts') ? null : ['whatsapp'];
    return json(await listContent(env, { scope: scope('p.client_id'), platform: q.get('platform'), clientId: q.get('client_id'), days: q.get('days'), allowedPlatforms }));
  }
  const cm = path.match(/^\/content\/(\d+)\/live$/);
  if (cm && method === 'GET') return json(await liveDetails(env, Number(cm[1]), scope('p.client_id')));

  // ---------- take published items down from the platforms ----------
  const rmT = path.match(/^\/targets\/(\d+)\/remove$/);
  const rmP = path.match(/^\/posts\/(\d+)\/remove$/);
  if ((rmT || rmP) && method === 'POST') {
    try {
      if (rmT) return json(await removeTarget(env, Number(rmT[1])));
      const results = await removePost(env, Number(rmP[1]));
      if (!results.length) bad('مفيش حاجة منشورة تتشال');
      return json({ results, failed: results.filter((r) => !r.ok) });
    } catch (err) {
      if (err instanceof RemoveError) bad(err.message);
      throw err;
    }
  }

  // ---------- team members (owner only) ----------
  if (path === '/users' && method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM users ORDER BY name').all();
    return json(results.map((r) => ({ ...memberFromRow(r), active: !!r.active, last_login: r.last_login, created_at: r.created_at, all_clients: r.clients === '"*"' })));
  }
  const readMember = async (b, { creating }) => {
    const name = String(b.name || '').trim().slice(0, 60);
    const username = String(b.username || '').trim().toLowerCase();
    if (!name) bad('اكتب اسم الشخص');
    if (!/^[a-z0-9._-]{3,30}$/.test(username) || username === 'admin') bad('اسم المستخدم: من 3 لـ 30 حرف إنجليزي أو رقم (من غير مسافات)، ومينفعش يكون admin');
    if (creating || b.password) {
      if (String(b.password || '').length < 6) bad('كلمة السر لازم تكون 6 حروف أو أكتر');
    }
    const perms = (Array.isArray(b.perms) ? b.perms : []).filter((p) => PERMS.includes(p));
    let clients;
    if (b.all_clients) clients = '"*"';
    else {
      const ids = [...new Set((Array.isArray(b.clients) ? b.clients : []).map(Number).filter(Number.isInteger))];
      if (!ids.length) bad('اختار عميل واحد على الأقل');
      clients = JSON.stringify(ids);
    }
    return { name, username, perms: JSON.stringify(perms), clients, password: b.password ? String(b.password) : null };
  };
  if (path === '/users' && method === 'POST') {
    const u = await readMember(await body(req), { creating: true });
    try {
      const row = await db.prepare('INSERT INTO users (username, name, pass_hash, clients, perms, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
        .bind(u.username, u.name, await hashPassword(u.password), u.clients, u.perms, Date.now()).first();
      return json(row, 201);
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) bad('اسم المستخدم ده موجود قبل كده');
      throw err;
    }
  }
  let um = path.match(/^\/users\/(\d+)$/);
  if (um && method === 'PUT') {
    const b = await body(req);
    if (b.active !== undefined && Object.keys(b).length === 1) {
      // Enable / disable only. Disabling logs them out (session_ver bump).
      await db.prepare('UPDATE users SET active = ?, session_ver = session_ver + 1 WHERE id = ?').bind(b.active ? 1 : 0, um[1]).run();
      return json({ ok: true });
    }
    const u = await readMember(b, { creating: false });
    try {
      if (u.password) {
        await db.prepare('UPDATE users SET username = ?, name = ?, clients = ?, perms = ?, pass_hash = ?, session_ver = session_ver + 1 WHERE id = ?')
          .bind(u.username, u.name, u.clients, u.perms, await hashPassword(u.password), um[1]).run();
      } else {
        await db.prepare('UPDATE users SET username = ?, name = ?, clients = ?, perms = ? WHERE id = ?')
          .bind(u.username, u.name, u.clients, u.perms, um[1]).run();
      }
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) bad('اسم المستخدم ده موجود قبل كده');
      throw err;
    }
    return json({ ok: true });
  }
  if (um && method === 'DELETE') {
    await db.prepare('DELETE FROM users WHERE id = ?').bind(um[1]).run();
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

  if (path === '/whatsapp/limit' && method === 'GET') return json(await getWaSettings(env));
  if (path === '/whatsapp/limit' && method === 'PUT') {
    const b = await body(req);
    if ('limit' in b) await setWaLimit(env, b.limit);
    if ('media_only' in b) await setWaMediaOnly(env, !!b.media_only);
    return json(await getWaSettings(env));
  }

  if (path === '/whatsapp/count' && method === 'GET') {
    if (!user.owner && !user.perms.includes('whatsapp')) return json({ count: 0 });
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM post_targets pt JOIN posts p ON p.id = pt.post_id WHERE pt.status = 'manual' AND ${scope('p.client_id')}`).first();
    return json({ count: r.n });
  }

  if (path === '/whatsapp/queue' && method === 'GET') {
    const sel = `SELECT pt.id AS target_id, pt.status AS target_status, pt.error, p.id AS post_id, p.message, p.image_url, p.media,
        p.scheduled_at, p.created_at, a.id AS account_id, a.name AS account_name,
        CASE WHEN a.token_enc = '${GATEWAY}' THEN 1 ELSE 0 END AS auto,
        c.name AS client_name, c.color AS client_color
      FROM post_targets pt JOIN posts p ON p.id = pt.post_id JOIN accounts a ON a.id = pt.account_id JOIN clients c ON c.id = p.client_id
      WHERE a.platform = 'whatsapp' AND ${scope('p.client_id')}`;
    const week = Date.now() - 7 * 86400000;
    const [ready, upcoming, published, failed, accounts] = await db.batch([
      db.prepare(`${sel} AND pt.status = 'manual' ORDER BY COALESCE(p.scheduled_at, p.created_at)`),
      db.prepare(`${sel} AND pt.status = 'pending' AND p.status IN ('scheduled', 'publishing') AND p.scheduled_at <= ? ORDER BY p.scheduled_at LIMIT 30`)
        .bind(Date.now() + 7 * 86400000),
      db.prepare(`${sel} AND pt.status = 'published' AND COALESCE(p.scheduled_at, p.created_at) >= ? ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 60`).bind(week),
      db.prepare(`${sel} AND pt.status = 'failed' AND COALESCE(p.scheduled_at, p.created_at) >= ? ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 20`).bind(week),
      db.prepare(`SELECT a.id, a.name, c.name AS client_name, c.color AS client_color,
          CASE WHEN a.token_enc = '${GATEWAY}' THEN 1 ELSE 0 END AS auto
        FROM accounts a JOIN clients c ON c.id = a.client_id WHERE a.platform = 'whatsapp' AND ${scope('a.client_id')} ORDER BY c.name, a.name`),
    ]);
    const shape = (r) => ({ ...r, media: mediaOf(r) });
    return json({
      ready: ready.results.map(shape), upcoming: upcoming.results.map(shape),
      published: published.results.map(shape), failed: failed.results.map(shape), accounts: accounts.results,
    });
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
      WHERE ${scope('client_id')} ${clientId ? 'AND client_id = ?' : ''} ORDER BY platform, name`;
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
  // Posts list. Tabs: upcoming (soonest first) / done / attention / drafts / all,
  // plus client, platform, text and date-range filters.
  if ((path === '/posts' || path === '/posts/counts') && method === 'GET') {
    const where = [scope('p.client_id')];
    const args = [];
    const q = url.searchParams;
    if (q.get('client_id')) { where.push('p.client_id = ?'); args.push(q.get('client_id')); }
    if (q.get('platform')) {
      where.push('EXISTS (SELECT 1 FROM post_targets x JOIN accounts xa ON xa.id = x.account_id WHERE x.post_id = p.id AND xa.platform = ?)');
      args.push(q.get('platform'));
    }
    if (q.get('q')) { where.push('instr(lower(p.message), lower(?)) > 0'); args.push(String(q.get('q')).slice(0, 100)); }
    if (q.get('from')) { where.push('COALESCE(p.scheduled_at, p.created_at) >= ?'); args.push(Number(q.get('from'))); }
    if (q.get('to')) { where.push('COALESCE(p.scheduled_at, p.created_at) < ?'); args.push(Number(q.get('to'))); }
    const TABS = {
      upcoming: "p.status IN ('scheduled', 'publishing')",
      done: "p.status = 'published'",
      attention: "p.status IN ('failed', 'partial', 'manual')",
      drafts: "p.status = 'draft'",
    };
    const base = where.length ? where.join(' AND ') : '1=1';
    if (path === '/posts/counts') {
      const r = await db.prepare(`SELECT
        ${Object.entries(TABS).map(([k, cond]) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) AS ${k}`).join(', ')}, COUNT(*) AS all_posts
        FROM posts p WHERE ${base}`).bind(...args).first();
      return json(Object.fromEntries(Object.entries(r).map(([k, v]) => [k === 'all_posts' ? 'all' : k, v || 0])));
    }
    const tab = q.get('tab');
    if (TABS[tab]) where.push(TABS[tab]);
    if (q.get('status')) { where.push('p.status = ?'); args.push(q.get('status')); }
    const asc = tab === 'upcoming' || q.get('order') === 'asc';
    const sql = `${POST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY COALESCE(p.scheduled_at, p.created_at) ${asc ? 'ASC' : 'DESC'} LIMIT 500`;
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

    // "Publish now": answer right away, the post publishes in the background.
    if (input.mode === 'now') {
      await db.prepare('UPDATE posts SET publish_started_at = ? WHERE id = ?').bind(Date.now(), ids[0]).run();
      await publishInBackground(env, ids[0]);
    }
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(ids[0]).first();
    return json({ ...parsePost(saved), created: ids.length }, 201);
  }

  m = path.match(/^\/posts\/(\d+)\/publish$/);
  if (m && method === 'POST') {
    const claim = await db.prepare(
      "UPDATE posts SET status = 'publishing' WHERE id = ? AND status IN ('draft', 'scheduled', 'failed', 'partial')"
    ).bind(m[1]).run();
    if (!claim.meta.changes) bad('المنشور بيتنشر دلوقتي أو اتنشر خلاص');
    await db.prepare('UPDATE posts SET publish_started_at = ? WHERE id = ?').bind(Date.now(), m[1]).run();
    await publishInBackground(env, Number(m[1]));
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
    if (input.mode === 'now') {
      await db.prepare('UPDATE posts SET publish_started_at = ? WHERE id = ?').bind(Date.now(), m[1]).run();
      await publishInBackground(env, Number(m[1]));
    }
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(m[1]).first();
    return json(parsePost(saved));
  }
  if (m && method === 'DELETE') {
    await db.prepare('DELETE FROM posts WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
