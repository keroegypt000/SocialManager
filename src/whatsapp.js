// Automatic WhatsApp statuses through Whapi.Cloud (hosted gateway, free Sandbox plan).
// WhatsApp itself has no official API for statuses, so the gateway links the number
// like WhatsApp Web (QR scan). A WhatsApp account with a saved Whapi token posts on its
// own; one without a token keeps the one-tap manual flow.
import { encrypt, decrypt } from './crypto.js';

const base = (env) => env.WHAPI_BASE || 'https://gate.whapi.cloud';

export class WhatsAppError extends Error {}

async function whapi(env, token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const explain = (status, data) => {
  if (status === 401 || status === 403) return 'التوكن غلط أو اتلغى. انسخه تاني من Whapi.';
  if (status === 402) return 'خطة Whapi المجانية خلصت أو محتاجة تجديد (ادخل Whapi واعمل أي حاجة في القناة).';
  if (status === 429) return 'Whapi: طلبات كتير، استنى شوية.';
  return data?.error?.message || `Whapi error ${status}`;
};

// Connection state for the dialog: connected (with the number) or a QR to scan.
export async function whatsappLinkState(env, token) {
  const r = await whapi(env, token, '/users/login?wakeup=true&size=300');
  if (r.status === 409) {
    const h = await whapi(env, token, '/health').catch(() => ({ data: {} }));
    const u = h.data?.user || {};
    return { connected: true, phone: u.id ? String(u.id).split('@')[0] : null, name: u.name || null };
  }
  if (r.status !== 200) throw new WhatsAppError(explain(r.status, r.data));
  return { connected: false, qr: r.data.base64 || null, expire: r.data.expire || 20, state: r.data.status };
}

// Save (or remove) the token on a WhatsApp account.
export async function setWhatsAppToken(env, accountId, token) {
  const acc = await env.DB.prepare("SELECT id FROM accounts WHERE id = ? AND platform = 'whatsapp'").bind(accountId).first();
  if (!acc) throw new WhatsAppError('حساب الواتساب مش موجود');
  const t = String(token || '').trim();
  if (!t) {
    await env.DB.prepare("UPDATE accounts SET token_enc = '' WHERE id = ?").bind(acc.id).run();
    return { auto: false };
  }
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(t)) throw new WhatsAppError('التوكن شكله مش صح. انسخه من صفحة القناة في Whapi (API Token).');
  const state = await whatsappLinkState(env, t);
  await env.DB.prepare('UPDATE accounts SET token_enc = ? WHERE id = ?').bind(await encrypt(env.SESSION_SECRET, t), acc.id).run();
  return { auto: true, ...state };
}

export async function accountToken(env, accountId) {
  const acc = await env.DB.prepare("SELECT token_enc FROM accounts WHERE id = ? AND platform = 'whatsapp'").bind(accountId).first();
  if (!acc?.token_enc) throw new WhatsAppError('الحساب ده مش متفعّل تلقائي');
  return decrypt(env.SESSION_SECRET, acc.token_enc);
}

// Post a status: every image/video becomes its own status (caption on the first one),
// a post without media becomes a text status.
export async function publishWhatsAppStatus(env, token, post, media) {
  const text = [post.message, post.link].filter(Boolean).join('\n\n');
  const ids = [];
  const send = async (path, body) => {
    const r = await whapi(env, token, path, { method: 'POST', body });
    if (r.status >= 300 || r.data?.sent === false) {
      if (r.status === 409 || /not auth|qr/i.test(r.data?.error?.message || '')) {
        throw new Error('رقم الواتساب اتفصل من Whapi. افتح العملاء والحسابات ← ⚡ تلقائي، وامسح الكود تاني.');
      }
      throw new Error(explain(r.status, r.data));
    }
    ids.push(r.data?.message?.id || 'ok');
  };
  if (!media.length) {
    if (!text) throw new Error('الحالة فاضية');
    await send('/stories', { caption: text, background_color: '#FF128C7E', caption_color: '#FFFFFFFF', font_type: 'SYSTEM_BOLD' });
  } else {
    for (const [i, m] of media.entries()) {
      await send('/stories/send/media', {
        media: m.url,
        mime_type: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
        ...(i === 0 && text ? { caption: text.slice(0, 700) } : {}),
      });
    }
  }
  return ids.join(',');
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
