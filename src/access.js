// What a signed-in team member may do. The owner passes everything.
// Called once per API request, before the routes run, so every route is covered.
// List routes also filter by clientFilter() so members only see their own clients.
export class Forbidden extends Error {}

const PERM_MSG = {
  posts: 'مش مسموحلك تنشر أو تعدّل منشورات',
  whatsapp: 'مش مسموحلك بحالات واتساب',
  reports: 'مش مسموحلك تشوف التقارير',
  ads: 'مش مسموحلك بالإعلانات',
};

export function clientFilter(user, column) {
  if (user.owner || user.clients === null) return '1=1'; // owner, or a member allowed every client
  const ids = (user.clients || []).map(Number).filter(Number.isInteger);
  return ids.length ? `${column} IN (${ids.join(',')})` : '0';
}

export async function authorize(env, user, req, path, method) {
  if (user.owner) return;
  const db = env.DB;
  const deny = (msg = 'الصلاحية دي لصاحب الحساب بس') => { throw new Forbidden(msg); };
  const need = (perm) => { if (!user.perms.includes(perm)) deny(PERM_MSG[perm]); };
  const clientOk = (id) => user.clients === null || user.clients.includes(Number(id));
  const needClient = (id) => { if (!clientOk(id)) deny('العميل ده مش ضمن صلاحياتك'); };
  const readBody = async () => { try { return await req.clone().json(); } catch { return {}; } };
  const needAccount = async (id) => {
    const a = await db.prepare('SELECT client_id FROM accounts WHERE id = ?').bind(Number(id)).first();
    if (!a) deny('الحساب مش موجود');
    needClient(a.client_id);
  };
  const needPost = async (id) => {
    const p = await db.prepare('SELECT client_id FROM posts WHERE id = ?').bind(Number(id)).first();
    if (!p) return; // the route answers 404
    needClient(p.client_id);
  };
  let m;

  // Open to every member (lists are filtered by client inside the routes).
  if (path === '/me' || path === '/stats' || path === '/logout') return;
  if (method === 'GET' && (path === '/clients' || path === '/accounts')) return;
  if (path === '/whatsapp/count' || path.startsWith('/push/')) return;

  // Owner only: clients, connecting accounts, invites, team, WhatsApp linking and settings.
  if (path === '/clients' || /^\/clients\/\d+/.test(path)) deny();
  if (path.startsWith('/sync') || path.startsWith('/connect/') || path.startsWith('/users')) deny();
  if (path === '/accounts/whatsapp' || /^\/accounts\/\d+$/.test(path)) deny();
  if (/^\/whatsapp\/accounts\//.test(path)) deny();
  if (path === '/whatsapp/limit' && method !== 'GET') deny();

  // Uploading images/videos is part of posting.
  if (path === '/media' || path.startsWith('/media/')) return need('posts');

  // Posts
  if (path === '/posts' || path === '/posts/counts') {
    need('posts');
    if (method === 'POST') needClient((await readBody()).client_id);
    return;
  }
  if ((m = path.match(/^\/posts\/(\d+)(?:\/(publish|move|duplicate))?$/))) {
    need('posts');
    await needPost(m[1]);
    if (method === 'PUT') needClient((await readBody()).client_id);
    return;
  }
  if ((m = path.match(/^\/series\/([0-9a-f-]{36})$/))) {
    need('posts');
    const { results } = await db.prepare('SELECT DISTINCT client_id FROM posts WHERE series_id = ?').bind(m[1]).all();
    results.forEach((r) => needClient(r.client_id));
    return;
  }

  // WhatsApp statuses page
  if (path === '/whatsapp/queue' || path === '/whatsapp/limit') return need('whatsapp');
  if ((m = path.match(/^\/whatsapp\/targets\/(\d+)\//))) {
    need('whatsapp');
    const t = await db.prepare('SELECT p.client_id FROM post_targets pt JOIN posts p ON p.id = pt.post_id WHERE pt.id = ?').bind(Number(m[1])).first();
    if (t) needClient(t.client_id);
    return;
  }

  // Reports
  if ((m = path.match(/^\/reports\/(\d+)(?:\/link)?$/))) {
    need('reports');
    return needClient(m[1]);
  }

  // Ads
  if (path.startsWith('/ads/')) {
    need('ads');
    if ((m = path.match(/^\/ads\/(\d+)(?:\/page-posts)?$/))) return needClient(m[1]);
    if ((m = path.match(/^\/ads\/accounts\/(\d+)\/campaigns\/\d+$/))) return needAccount(m[1]);
    if (method === 'POST') return needAccount((await readBody()).account_id);
    return deny();
  }

  // Anything not listed above is for the owner.
  deny();
}
