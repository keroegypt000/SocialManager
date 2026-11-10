import { checkPassword, sessionCookie, clearCookie, isAuthed } from './auth.js';
import { metaConfigured, readPending, savePending } from './meta.js';
import { publishPost } from './publisher.js';

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

const parsePost = (p) => ({ ...p, targets: JSON.parse(p.targets || '[]') });

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

  if (!(await isAuthed(req, env))) throw new HttpError(401, 'سجّل الدخول الأول');

  // --- authenticated routes ---
  if (path === '/me') {
    return json({ ok: true, metaConfigured: metaConfigured(env), redirectUri: `${url.origin}/auth/meta/callback` });
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
    await db.prepare('DELETE FROM clients WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
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
      items: pending.items.map((it) => {
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

  // Accounts
  if (path === '/accounts' && method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const sql = `SELECT id, client_id, platform, external_id, name, picture, created_at FROM accounts
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
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(m[1]).run();
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

  if (path === '/posts' && method === 'POST') {
    const b = await body(req);
    const clientId = Number(b.client_id);
    const accountIds = (b.account_ids || []).map(Number).filter(Boolean);
    const message = String(b.message || '').trim();
    const imageUrl = cleanUrl(b.image_url);
    const link = cleanUrl(b.link);
    const mode = b.mode; // 'now' | 'schedule' | 'draft'
    if (!clientId) bad('اختار العميل');
    if (!accountIds.length) bad('اختار حساب واحد على الأقل');
    if (!message && !imageUrl) bad('اكتب نص المنشور أو ضيف صورة');
    if (!['now', 'schedule', 'draft'].includes(mode)) bad('طريقة نشر غير معروفة');

    let scheduledAt = null;
    if (mode === 'schedule') {
      scheduledAt = Number(b.scheduled_at);
      if (!scheduledAt || scheduledAt < Date.now() - 60000) bad('اختار ميعاد في المستقبل');
    }

    // Make sure every chosen account belongs to this client.
    const placeholders = accountIds.map(() => '?').join(',');
    const owned = await db.prepare(`SELECT id, platform FROM accounts WHERE client_id = ? AND id IN (${placeholders})`)
      .bind(clientId, ...accountIds).all();
    if (owned.results.length !== accountIds.length) bad('فيه حساب مش تبع العميل ده');
    if (!imageUrl && owned.results.some((a) => a.platform === 'instagram')) bad('إنستجرام محتاج صورة. ضيف رابط صورة أو شيل حساب إنستجرام.');

    const status = mode === 'draft' ? 'draft' : mode === 'schedule' ? 'scheduled' : 'publishing';
    const post = await db.prepare(
      'INSERT INTO posts (client_id, message, image_url, link, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(clientId, message, imageUrl, link, scheduledAt, status, Date.now()).first();
    await db.batch(accountIds.map((aid) =>
      db.prepare('INSERT INTO post_targets (post_id, account_id) VALUES (?, ?)').bind(post.id, aid)));

    if (mode === 'now') await publishPost(env, post.id);
    const saved = await db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(post.id).first();
    return json(parsePost(saved), 201);
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

  m = path.match(/^\/posts\/(\d+)$/);
  if (m && method === 'DELETE') {
    await db.prepare('DELETE FROM posts WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
