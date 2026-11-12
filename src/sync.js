// One-click sync: connect Facebook once, and every page you manage becomes (or joins)
// a client on its own, with its Instagram account and ad accounts placed next to it.
//
// Rules:
// - An account that's already in the platform stays with its client (only its token,
//   name and picture are refreshed), so manual moves are never undone.
// - A new page joins the client of its Instagram account, or a client with the exact
//   same name, or else a new client named after the page.
// - A new ad account goes to the client of a page it has promoted, or a client whose
//   page name matches the ad account name, or else to "حسابات مش متوزعة".
// - Accounts or clients you delete are remembered and not brought back by the next sync.
// The long-lived user token is kept (encrypted) so the sync can also run daily on its own.
import { encrypt, decrypt } from './crypto.js';
import { graph } from './meta.js';

const DAY = 86400000;
export const UNASSIGNED = '📦 حسابات مش متوزعة';
const COLORS = ['#4f46e5', '#e11d48', '#059669', '#d97706', '#0891b2', '#7c3aed', '#db2777', '#65a30d', '#2563eb', '#ea580c'];

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-_.()'"|·]+/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');

async function getSetting(env, key) {
  return (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first())?.value ?? null;
}
const setSetting = (env, key, value) => env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, value);

export async function ignoredKeys(env) {
  try { return new Set(JSON.parse((await getSetting(env, 'sync_ignore')) || '[]')); } catch { return new Set(); }
}
// Remember deleted accounts so the next sync doesn't bring them back.
export async function ignoreKeys(env, keys) {
  if (!keys.length) return;
  const set = await ignoredKeys(env);
  for (const k of keys) if (!k.startsWith('whatsapp:')) set.add(k);
  await setSetting(env, 'sync_ignore', JSON.stringify([...set])).run();
}
export async function unignoreKeys(env, keys) {
  const set = await ignoredKeys(env);
  let changed = false;
  for (const k of keys) changed = set.delete(k) || changed;
  if (changed) await setSetting(env, 'sync_ignore', JSON.stringify([...set])).run();
}
export async function clearIgnored(env) {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'sync_ignore'").run();
}

const igName = (ig, pageName) => {
  const handle = ig.username ? `@${ig.username}` : '';
  if (ig.name && handle) return `${ig.name} (${handle})`;
  return ig.name || handle || pageName;
};

// Everything the Facebook user can manage: pages (+ Instagram) and ad accounts.
async function discover(env, token) {
  const pageFields = 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}';
  const pages = new Map();
  const addPage = (p) => {
    if (!p?.id || !p.access_token || pages.has(p.id)) return;
    pages.set(p.id, p);
  };
  const mine = await graph(env, 'me/accounts', { params: { access_token: token, fields: pageFields, limit: '100' } });
  (mine.data || []).forEach(addPage);
  // Pages that live in a Business Manager don't always show up in me/accounts.
  const bizPages = await graph(env, 'me/businesses', {
    params: { access_token: token, limit: '25', fields: `owned_pages.limit(100){${pageFields}},client_pages.limit(100){${pageFields}}` },
  }).catch(() => null);
  for (const b of bizPages?.data || []) [...(b.owned_pages?.data || []), ...(b.client_pages?.data || [])].forEach(addPage);

  let adsError = null;
  const ads = new Map();
  const mineAds = await graph(env, 'me/adaccounts', { params: { access_token: token, fields: 'id,name,currency', limit: '100' } })
    .catch((e) => { adsError = e.message; return null; });
  (mineAds?.data || []).forEach((a) => ads.set(a.id, a));
  const bizAds = await graph(env, 'me/businesses', {
    params: { access_token: token, limit: '25', fields: 'owned_ad_accounts.limit(100){id,name,currency},client_ad_accounts.limit(100){id,name,currency}' },
  }).catch(() => null);
  for (const b of bizAds?.data || []) [...(b.owned_ad_accounts?.data || []), ...(b.client_ad_accounts?.data || [])].forEach((a) => a?.id && ads.set(a.id, a));

  let adsNote = null;
  if (!ads.size) {
    const perms = await graph(env, 'me/permissions', { params: { access_token: token } }).catch(() => null);
    const granted = new Set((perms?.data || []).filter((p) => p.status === 'granted').map((p) => p.permission));
    const missing = ['ads_read', 'ads_management'].filter((p) => !granted.has(p));
    adsNote = perms && missing.length ? `missing:${missing.join(',')}` : adsError ? `error:${adsError}` : 'none';
  }
  return { pages: [...pages.values()], ads: [...ads.values()], adsNote };
}

// Pages an ad account has advertised, to know which client it belongs to.
async function promotedPages(env, token, adId) {
  const r = await graph(env, `${adId}/promote_pages`, { params: { access_token: token, fields: 'id', limit: '50' } }).catch(() => null);
  return (r?.data || []).map((p) => p.id);
}

export async function syncAccounts(env, token) {
  const now = Date.now();
  const { pages, ads, adsNote } = await discover(env, token);
  const db = env.DB;
  const ignore = await ignoredKeys(env);
  const [{ results: existing }, { results: clients }] = await db.batch([
    db.prepare('SELECT id, client_id, platform, external_id FROM accounts'),
    db.prepare('SELECT id, name FROM clients'),
  ]);
  const byKey = new Map(existing.map((a) => [`${a.platform}:${a.external_id}`, a]));
  const clientByName = new Map(clients.map((c) => [norm(c.name), c.id]));
  const result = { new_clients: [], added: 0, updated: 0, ignored: 0, unassigned: 0, pages: pages.length, ad_accounts: ads.length, ads_note: adsNote };

  // 1. Decide the client of every page; collect the clients that must be created.
  const plan = [];
  const toCreate = new Map(); // norm(name) -> name
  for (const p of pages) {
    const fbKey = `facebook:${p.id}`;
    const ig = p.instagram_business_account;
    const igKey = ig ? `instagram:${ig.id}` : null;
    if (ignore.has(fbKey) && (!igKey || ignore.has(igKey))) { result.ignored++; continue; }
    const cid = byKey.get(fbKey)?.client_id ?? (igKey && byKey.get(igKey)?.client_id) ?? clientByName.get(norm(p.name)) ?? null;
    if (!cid) toCreate.set(norm(p.name), p.name);
    plan.push({ p, cid, fbKey, igKey });
  }
  const unplacedAds = ads.filter((a) => !ignore.has(`meta_ads:${a.id}`) && !byKey.has(`meta_ads:${a.id}`));

  if (toCreate.size) {
    const names = [...toCreate.values()];
    const rows = await db.batch(names.map((name, i) => db.prepare('INSERT INTO clients (name, color, created_at) VALUES (?, ?, ?) RETURNING id')
      .bind(name, COLORS[(clients.length + i) % COLORS.length], now)));
    names.forEach((name, i) => clientByName.set(norm(name), rows[i].results[0].id));
    result.new_clients = names;
  }

  // 2. Accounts: refresh the ones we have, add the new ones next to their page.
  const stmts = [];
  const pageClient = new Map();
  const upsert = async (key, platform, externalId, name, picture, accToken, clientId) => {
    if (ignore.has(key)) { result.ignored++; return; }
    const enc = await encrypt(env.SESSION_SECRET, accToken);
    const have = byKey.get(key);
    if (have) {
      stmts.push(db.prepare('UPDATE accounts SET name = ?, picture = ?, token_enc = ? WHERE id = ?').bind(name, picture, enc, have.id));
      result.updated++;
    } else {
      stmts.push(db.prepare('INSERT OR IGNORE INTO accounts (client_id, platform, external_id, name, picture, token_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(clientId, platform, externalId, name, picture, enc, now));
      byKey.set(key, { client_id: clientId });
      result.added++;
    }
  };
  for (const { p, cid, fbKey, igKey } of plan) {
    const clientId = cid ?? clientByName.get(norm(p.name));
    pageClient.set(p.id, byKey.get(fbKey)?.client_id ?? clientId);
    await upsert(fbKey, 'facebook', p.id, p.name, p.picture?.data?.url || null, p.access_token, clientId);
    const ig = p.instagram_business_account;
    if (ig) await upsert(igKey, 'instagram', ig.id, igName(ig, p.name), ig.profile_picture_url || null, p.access_token, byKey.get(igKey)?.client_id ?? clientId);
  }

  // 3. Ad accounts: refresh the ones we have; place new ones by promoted page or name.
  let holder = null;
  for (const a of ads) {
    const key = `meta_ads:${a.id}`;
    const name = `${a.name || a.id}${a.currency ? ` (${a.currency})` : ''}`;
    if (ignore.has(key)) { result.ignored++; continue; }
    let cid = byKey.get(key)?.client_id ?? null;
    if (!cid && unplacedAds.length <= 25) {
      const promoted = await promotedPages(env, token, a.id);
      cid = promoted.map((id) => pageClient.get(id)).find(Boolean) ?? null;
    }
    if (!cid) {
      const an = norm(a.name);
      const match = pages.find((p) => { const pn = norm(p.name); return pn.length >= 3 && an.length >= 3 && (an.includes(pn) || pn.includes(an)); });
      if (match) cid = pageClient.get(match.id) ?? null;
    }
    if (!cid) {
      if (!holder) {
        holder = clientByName.get(norm(UNASSIGNED))
          ?? (await db.prepare('INSERT INTO clients (name, color, created_at) VALUES (?, ?, ?) RETURNING id').bind(UNASSIGNED, '#6b7084', now).first()).id;
        clientByName.set(norm(UNASSIGNED), holder);
      }
      cid = holder;
      result.unassigned++;
    }
    await upsert(key, 'meta_ads', a.id, name, null, token, cid);
  }

  stmts.push(setSetting(env, 'meta_user_token', await encrypt(env.SESSION_SECRET, token)));
  stmts.push(setSetting(env, 'meta_last_sync', String(now)));
  stmts.push(db.prepare('DELETE FROM report_cache'));
  await db.batch(stmts);
  return result;
}

// "تحديث دلوقتي" and the daily run: reuse the saved Facebook token.
export async function syncFromSaved(env) {
  const enc = await getSetting(env, 'meta_user_token');
  if (!enc) throw new Error('اربط فيسبوك الأول بزرار "اكتشف كل حساباتي"');
  try {
    return await syncAccounts(env, await decrypt(env.SESSION_SECRET, enc));
  } catch (err) {
    if (/session|expired|#190|OAuthException|validating access token/i.test(err.message)) {
      throw new Error('صلاحية ربط فيسبوك انتهت (بتتجدد كل شهرين). دوس "اكتشف كل حساباتي" تاني.');
    }
    throw err;
  }
}

export async function syncStatus(env) {
  const [enc, last] = await Promise.all([getSetting(env, 'meta_user_token'), getSetting(env, 'meta_last_sync')]);
  return { connected: !!enc, last_sync: last ? Number(last) : null, ignored: (await ignoredKeys(env)).size };
}

// From the cron: once a day, pick up new pages and refresh tokens.
export async function dailySync(env) {
  const { connected, last_sync } = await syncStatus(env);
  if (!connected || (last_sync && Date.now() - last_sync < DAY)) return;
  await syncFromSaved(env).catch(async (err) => {
    // Don't retry every 5 minutes when the token is dead.
    await setSetting(env, 'meta_last_sync', String(Date.now())).run();
    throw err;
  });
}
