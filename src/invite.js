// Invite links: a client connects their own Facebook/Instagram pages from their phone,
// without logging into the dashboard and without sharing a password.
//
//   /invite/<token>          explanation + "connect with Facebook" button
//   /invite/<token>/start    -> Facebook login (the client's own account)
//   /invite/<token>/pick     the client ticks which of their pages to connect
import { metaStart, metaConfigured, readPending, savePending } from './meta.js';

const INVITE_DAYS = 7;

export async function createInvite(env, clientId, origin) {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + INVITE_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO invites (token, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, clientId, Date.now(), expiresAt).run();
  return { url: `${origin}/invite/${token}`, expires_at: expiresAt };
}

export async function revokeInvites(env, clientId) {
  const r = await env.DB.prepare('DELETE FROM invites WHERE client_id = ? RETURNING token').bind(clientId).all();
  return r.results.length;
}

export async function getInvite(env, token) {
  if (!/^[0-9a-f-]{36}$/.test(String(token || ''))) return null;
  return env.DB.prepare(
    'SELECT i.*, c.name AS client_name FROM invites i JOIN clients c ON c.id = i.client_id WHERE i.token = ? AND i.expires_at > ?'
  ).bind(token, Date.now()).first();
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#f4f5f9; --card:#fff; --text:#1c1f2b; --muted:#6b7084; --border:#e3e5ec; --fb:#1877f2; --ok:#15803d; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12141b; --card:#1b1e28; --text:#e8e9ef; --muted:#9a9fb3; --border:#2c3040; } }
  * { box-sizing: border-box; }
  body { margin:0; font-family:'Cairo',system-ui,sans-serif; background:var(--bg); color:var(--text); line-height:1.8; }
  main { max-width:520px; margin:0 auto; padding:24px 16px 48px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:22px; }
  h1 { font-size:22px; margin:0 0 6px; }
  .muted { color:var(--muted); font-size:14px; }
  ol { padding-inline-start:20px; margin:14px 0; }
  .btn { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; font:inherit; font-weight:700; font-size:17px;
         border:0; border-radius:12px; padding:14px; cursor:pointer; text-decoration:none; background:var(--fb); color:#fff; margin-top:14px; }
  .note { background:var(--bg); border-radius:10px; padding:12px; font-size:14px; margin-top:14px; }
  .err { background:#fdecec; color:var(--bad); border-radius:10px; padding:12px; margin-bottom:14px; }
  .ok { font-size:48px; text-align:center; }
  label.pick { display:flex; align-items:center; gap:10px; border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-top:8px; }
  label.pick img { width:34px; height:34px; border-radius:50%; object-fit:cover; }
  .tag { font-size:12px; font-weight:700; color:#fff; border-radius:6px; padding:1px 8px; }
  .fb { background:#1877f2; } .ig { background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af); }
  .sub { margin-inline-start:28px; }
</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

const expired = () => page('اللينك انتهى', `<div class="card"><h1>اللينك ده مبقاش شغال ⏳</h1>
  <p>اللينك انتهت صلاحيته أو اتلغى. اطلب لينك جديد من الشخص اللي بعتهولك.</p></div>`, 410);

export async function handleInvite(req, env, url) {
  const m = url.pathname.match(/^\/invite\/([0-9a-f-]{36})(\/start|\/pick)?\/?$/);
  if (!m) return expired();
  const invite = await getInvite(env, m[1]);
  if (!invite) return expired();
  const base = `/invite/${invite.token}`;

  if (m[2] === '/start') {
    if (!metaConfigured(env)) return page('غير متاح', '<div class="card"><h1>الربط مش متاح دلوقتي</h1></div>', 503);
    return metaStart(env, url, { invite });
  }

  if (m[2] === '/pick') {
    if (req.method === 'POST') {
      const form = await req.formData();
      const p = String(form.get('p') || '');
      const keys = form.getAll('k').map(String);
      const pending = await readPending(env, p);
      if (!pending || pending.clientId !== invite.client_id) return expired();
      if (!keys.length) return Response.redirect(`${url.origin}${base}/pick?p=${p}&none=1`, 303);
      const r = await savePending(env, p, keys);
      await env.DB.prepare('UPDATE invites SET used_at = ? WHERE token = ?').bind(Date.now(), invite.token).run();
      return page('تم الربط', `<div class="card"><div class="ok">✅</div>
        <h1 style="text-align:center">تم ربط ${r.saved} ${r.saved === 1 ? 'حساب' : 'حسابات'} بنجاح</h1>
        <p class="muted" style="text-align:center">شكراً! تقدر تقفل الصفحة دي دلوقتي.</p>
        <div class="note">لو حبيت تلغي الربط في أي وقت: فيسبوك ← الإعدادات والخصوصية ← الإعدادات ← <b>تكاملات الأعمال (Business integrations)</b> ← شيل التطبيق.</div></div>`);
    }

    const p = url.searchParams.get('p') || '';
    const pending = await readPending(env, p);
    if (!pending || pending.clientId !== invite.client_id) return expired();
    const pages = pending.items.filter((i) => i.platform === 'facebook');
    const row = (it, sub) => `<label class="pick ${sub ? 'sub' : ''}">
        <input type="checkbox" name="k" value="${esc(`${it.platform}:${it.external_id}`)}" checked>
        ${it.picture ? `<img src="${esc(it.picture)}" alt="">` : ''}
        <span class="tag ${it.platform === 'instagram' ? 'ig' : 'fb'}">${{ facebook: 'فيسبوك', instagram: 'إنستجرام', meta_ads: 'حساب إعلانات' }[it.platform]}</span>
        <b>${esc(it.name)}</b></label>`;
    return page('اختار صفحاتك', `<div class="card">
      ${url.searchParams.get('none') ? '<div class="err">اختار صفحة واحدة على الأقل.</div>' : ''}
      <h1>اختار الصفحات اللي عايز تربطها</h1>
      <p class="muted">شيل العلامة من أي صفحة مش عايزها تتربط.</p>
      <form method="post" action="${base}/pick">
        <input type="hidden" name="p" value="${esc(p)}">
        ${pages.map((pg) => row(pg, false) + pending.items.filter((i) => i.platform === 'instagram' && i.page_id === pg.page_id).map((ig) => row(ig, true)).join('')).join('')}
        ${pending.items.filter((i) => i.platform === 'meta_ads').map((ad) => row(ad, false)).join('')}
        <button class="btn" type="submit">✅ اربط الصفحات دي</button>
      </form></div>`);
  }

  const error = url.searchParams.get('error');
  return page(`ربط صفحات ${invite.client_name}`, `<div class="card">
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <h1>أهلاً 👋</h1>
    <p>عشان نقدر ننشر على صفحاتك (<b>${esc(invite.client_name)}</b>)، محتاجين تربطها بالمنصة. الموضوع بياخد دقيقة:</p>
    <ol>
      <li>دوس الزرار الأزرق تحت، وادخل فيسبوك <b>بحسابك إنت</b>.</li>
      <li>فيسبوك هيسألك عن الصفحات وحساب إنستجرام: اختار صفحاتك ووافق.</li>
      <li>هترجع هنا تأكد الصفحات، وخلاص.</li>
    </ol>
    <a class="btn" href="${base}/start">ادخل بفيسبوك واربط صفحتك</a>
    <div class="note">🔒 <b>إحنا مش بنشوف الباسورد بتاعك خالص.</b> الدخول بيتم على موقع فيسبوك نفسه، والمنصة بتاخد صلاحية النشر على الصفحات اللي تختارها بس. وتقدر تلغيها في أي وقت من إعدادات فيسبوك.</div>
    <p class="muted" style="margin-top:12px">اللينك ده شغال لحد ${esc(new Date(invite.expires_at).toLocaleDateString('ar-EG', { dateStyle: 'long' }))}.</p>
  </div>`);
}
