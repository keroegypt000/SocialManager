// Take a published item down from its platform ("نزلت بالغلط" / broken video).
// Facebook and Instagram delete through the Graph API; WhatsApp statuses are revoked
// through our gateway (they disappear for everyone). Other platforms: delete in their app.
import { decrypt } from './crypto.js';
import { graph } from './meta.js';
import { gatewayFor, GATEWAY } from './whatsapp.js';

export class RemoveError extends Error {}

export async function removeTarget(env, targetId) {
  const t = await env.DB.prepare(
    `SELECT pt.*, a.platform, a.token_enc, a.id AS acc_id FROM post_targets pt JOIN accounts a ON a.id = pt.account_id WHERE pt.id = ?`
  ).bind(targetId).first();
  if (!t) throw new RemoveError('مش موجود');
  if (t.status === 'removed') return { ok: true, already: true };
  if (t.status !== 'published' || !t.external_post_id) throw new RemoveError('ده مش منشور، مفيش حاجة تتشال');

  const ids = String(t.external_post_id).split(',').filter(Boolean);
  try {
    if (t.platform === 'facebook' || t.platform === 'instagram') {
      const token = await decrypt(env.SESSION_SECRET, t.token_enc);
      for (const id of ids) await graph(env, id, { method: 'DELETE', params: { access_token: token } });
    } else if (t.platform === 'whatsapp') {
      if (t.token_enc !== GATEWAY) throw new RemoveError('الحالة دي اتنشرت يدوي: امسحها من الموبايل (حالتي ← ⋮ ← حذف).');
      await gatewayFor(env, t.acc_id).deleteStatus(ids.filter((x) => x !== 'ok'));
    } else {
      throw new RemoveError('الحذف من المنصة دي لسه مش متاح من هنا. امسحه من التطبيق نفسه.');
    }
  } catch (err) {
    if (err instanceof RemoveError) throw err;
    const m = String(err.message || err);
    if (/does not exist|Unsupported delete|cannot be loaded|#100/i.test(m) && t.platform !== 'whatsapp') {
      // Already gone on the platform: mark it removed here too.
    } else if (/permission|#10|#200/i.test(m)) {
      throw new RemoveError(`${t.platform === 'instagram' ? 'إنستجرام' : 'فيسبوك'} محتاج صلاحية حذف: اربط الحسابات تاني ووافق على كل الصلاحيات. (${m})`);
    } else {
      throw new RemoveError(m);
    }
  }
  await env.DB.prepare("UPDATE post_targets SET status = 'removed', error = NULL WHERE id = ?").bind(targetId).run();
  return { ok: true };
}

// Every published target of a post; returns what worked and what didn't.
export async function removePost(env, postId) {
  const { results } = await env.DB.prepare("SELECT id FROM post_targets WHERE post_id = ? AND status = 'published'").bind(postId).all();
  const out = [];
  for (const { id } of results) {
    try {
      await removeTarget(env, id);
      out.push({ id, ok: true });
    } catch (err) {
      out.push({ id, ok: false, error: err.message });
    }
  }
  return out;
}
