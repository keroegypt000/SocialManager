// Automatic WhatsApp statuses through our own gateway (src/wa/gateway.js), a Durable
// Object per WhatsApp account running inside Cloudflare. WhatsApp has no official API
// for statuses, so the gateway links the number like WhatsApp Web (QR scan).
// A WhatsApp account with token_enc = 'gateway' posts on its own; others keep the
// one-tap manual flow.
export class WhatsAppError extends Error {}

export const GATEWAY = 'gateway';
const DAY = 86400000;

export function gatewayFor(env, accountId) {
  if (!env.WA_GATEWAY) throw new WhatsAppError('بوابة واتساب مش متفعّلة في Cloudflare');
  return env.WA_GATEWAY.get(env.WA_GATEWAY.idFromName(`acc-${accountId}`));
}

async function waAccount(env, accountId) {
  const acc = await env.DB.prepare("SELECT id, token_enc FROM accounts WHERE id = ? AND platform = 'whatsapp'").bind(accountId).first();
  if (!acc) throw new WhatsAppError('حساب الواتساب مش موجود');
  return acc;
}

// The "⚡ تلقائي" dialog: QR to scan, or the linked number. Marks the account automatic once linked.
export async function whatsappLink(env, accountId) {
  const acc = await waAccount(env, accountId);
  const s = await gatewayFor(env, acc.id).link();
  if (s.connected && acc.token_enc !== GATEWAY) {
    await env.DB.prepare('UPDATE accounts SET token_enc = ? WHERE id = ?').bind(GATEWAY, acc.id).run();
  }
  return s;
}

// Unlink the number and go back to manual sharing.
export async function whatsappUnlink(env, accountId) {
  const acc = await waAccount(env, accountId);
  await gatewayFor(env, acc.id).logout().catch(() => {});
  await env.DB.prepare("UPDATE accounts SET token_enc = '' WHERE id = ?").bind(acc.id).run();
  return { ok: true };
}

// Post a status: every image/video becomes its own status (caption on the first one),
// a post without media becomes a text status.
export async function publishWhatsAppStatus(env, accountId, post, media) {
  const gw = gatewayFor(env, accountId);
  const text = [post.message, post.link].filter(Boolean).join('\n\n');
  const ids = [];
  if (!media.length) {
    if (!text) throw new Error('الحالة فاضية');
    ids.push((await gw.postStatus({ text })).id);
  } else {
    for (const [i, m] of media.entries()) {
      ids.push((await gw.postStatus({ media: m, caption: i === 0 ? text.slice(0, 700) : '' })).id);
    }
  }
  return ids.join(',');
}

// From the cron: once a day, bring every linked number online briefly so WhatsApp
// keeps the link (it drops devices that stay offline about two weeks).
export async function dailyWhatsAppKeepAlive(env) {
  const key = 'wa_keepalive';
  const last = Number((await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first())?.value) || 0;
  if (Date.now() - last < DAY) return;
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, String(Date.now())).run();
  const { results } = await env.DB.prepare("SELECT id FROM accounts WHERE platform = 'whatsapp' AND token_enc = ?").bind(GATEWAY).all();
  for (const { id } of results.slice(0, 20)) {
    try { await gatewayFor(env, id).keepAlive(); } catch (err) { console.error('wa keepalive', id, err.message); }
  }
}

// ---------- optional daily limit per WhatsApp number ----------
// Counted on Egypt's calendar day. Empty/0 = no limit.
const TZ = 'Africa/Cairo';
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export async function getWaLimit(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'wa_daily_limit'").first();
  return Number(row?.value) || 0;
}
export async function setWaLimit(env, n) {
  const v = Math.max(0, Math.min(50, Math.floor(Number(n) || 0)));
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('wa_daily_limit', ?)").bind(String(v)).run();
  return v;
}

// Statuses of one account per day around the given times (planned + done), ignoring one post (when editing it).
async function usage(env, accountId, times, excludePostId) {
  const from = Math.min(...times) - 2 * 86400000;
  const to = Math.max(...times) + 2 * 86400000;
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(p.scheduled_at, p.created_at) AS at FROM post_targets pt JOIN posts p ON p.id = pt.post_id
     WHERE pt.account_id = ? AND p.id != ? AND COALESCE(p.scheduled_at, p.created_at) BETWEEN ? AND ?
       AND (pt.status IN ('published', 'manual', 'processing') OR (pt.status = 'pending' AND p.status IN ('scheduled', 'publishing')))`
  ).bind(accountId, excludePostId || 0, from, to).all();
  const count = {};
  for (const r of results) count[dayOf(r.at)] = (count[dayOf(r.at)] || 0) + 1;
  return count;
}

// When creating/editing: refuse if a day would go over the limit.
export async function checkWaLimit(env, accounts, times, excludePostId) {
  const limit = await getWaLimit(env);
  if (!limit) return;
  for (const acc of accounts) {
    const count = await usage(env, acc.id, times, excludePostId);
    for (const t of times) {
      const d = dayOf(t);
      count[d] = (count[d] || 0) + 1;
      if (count[d] > limit) {
        throw new WhatsAppError(`حالات واتساب "${acc.name}": الحد ${limit} في اليوم، ويوم ${d} هيعدّي الحد. غيّر الميعاد، أو زوّد الحد من صفحة حالات واتساب.`);
      }
    }
  }
}

// When publishing (covers copies and calendar moves too): true if today is already full.
export async function waLimitReached(env, accountId, postId) {
  const limit = await getWaLimit(env);
  if (!limit) return false;
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT COALESCE(p.scheduled_at, p.created_at) AS at FROM post_targets pt JOIN posts p ON p.id = pt.post_id
     WHERE pt.account_id = ? AND p.id != ? AND pt.status IN ('published', 'manual', 'processing')
       AND COALESCE(p.scheduled_at, p.created_at) > ?`
  ).bind(accountId, postId, now - 2 * 86400000).all();
  const today = dayOf(now);
  return results.filter((r) => dayOf(r.at) === today).length >= limit;
}
