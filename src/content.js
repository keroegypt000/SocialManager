// "📺 المحتوى": everything sent to every platform, one entry per platform, and — on
// demand — what the platform itself reports about it (link, status, video length),
// so problems like a broken video can be seen from inside the platform.
import { decrypt } from './crypto.js';
import { graph, mediaOf, facebookVideoStatus } from './meta.js';

const DAY = 86400000;

export async function listContent(env, { scope, platform, clientId, days, allowedPlatforms }) {
  const where = [scope, 'COALESCE(p.scheduled_at, p.created_at) >= ?', "p.status != 'draft'"];
  const args = [Date.now() - Math.min(Math.max(Number(days) || 14, 1), 60) * DAY];
  if (platform) { where.push('a.platform = ?'); args.push(platform); }
  if (clientId) { where.push('p.client_id = ?'); args.push(Number(clientId)); }
  if (allowedPlatforms) where.push(`a.platform IN (${allowedPlatforms.map((x) => `'${x}'`).join(',')})`);
  const { results } = await env.DB.prepare(
    `SELECT pt.id AS target_id, pt.status AS target_status, pt.error, pt.external_post_id,
        p.id AS post_id, p.message, p.image_url, p.media, p.fb_reel, p.media_cleaned, p.status AS post_status,
        p.scheduled_at, p.created_at, a.platform, a.name AS account_name, c.name AS client_name, c.color AS client_color
     FROM post_targets pt JOIN posts p ON p.id = pt.post_id JOIN accounts a ON a.id = pt.account_id JOIN clients c ON c.id = p.client_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(p.scheduled_at, p.created_at) DESC LIMIT 300`
  ).bind(...args).all();
  return results.map((r) => ({ ...r, media: mediaOf(r) }));
}

// Ask the platform about one published item.
export async function liveDetails(env, targetId, scopeSql) {
  const t = await env.DB.prepare(
    `SELECT pt.*, a.platform, a.external_id AS account_external_id, a.token_enc, p.fb_reel, p.media, p.image_url
     FROM post_targets pt JOIN accounts a ON a.id = pt.account_id JOIN posts p ON p.id = pt.post_id
     WHERE pt.id = ? AND ${scopeSql}`
  ).bind(targetId).first();
  if (!t) return { error: 'مش موجود' };
  const id = t.external_post_id;
  const out = { platform: t.platform, id, url: null, facts: [], warnings: [] };
  if (!id || t.status !== 'published') {
    out.facts.push(t.status === 'failed' ? `فشل: ${t.error || ''}` : `الحالة على المنصة عندنا: ${t.status}`);
    return out;
  }
  const media = mediaOf(t);
  const isVideo = media.some((m) => m.type === 'video');
  try {
    if (t.platform === 'facebook') {
      const token = await decrypt(env.SESSION_SECRET, t.token_enc);
      if (isVideo) {
        const v = await facebookVideoStatus(env, id, token);
        out.url = v.permalink_url ? (v.permalink_url.startsWith('http') ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : `https://www.facebook.com/${id}`;
        const st = v.status || {};
        out.facts.push(`حالة الفيديو عند فيسبوك: ${st.video_status || '؟'}`);
        if (st.uploading_phase) out.facts.push(`الرفع: ${st.uploading_phase.status}${st.uploading_phase.bytes_transfered != null ? ` (${st.uploading_phase.bytes_transfered} بايت)` : ''}`);
        if (st.processing_phase) out.facts.push(`المعالجة: ${st.processing_phase.status}${st.processing_phase.error?.message ? ` — ${st.processing_phase.error.message}` : ''}`);
        if (st.publishing_phase) out.facts.push(`النشر: ${st.publishing_phase.status}${st.publishing_phase.publish_status ? ` (${st.publishing_phase.publish_status})` : ''}`);
        if (v.length != null) {
          out.facts.push(`مدة الفيديو عند فيسبوك: ${Number(v.length).toFixed(1)} ثانية`);
          const expected = media.find((m) => m.type === 'video')?.duration;
          if (Number(v.length) < 2 || (expected && Number(v.length) < expected - 2)) {
            out.warnings.push(`فيسبوك عنده الفيديو ${Number(v.length).toFixed(1)} ثانية بس${expected ? ` (الأصلي ${Math.round(expected)} ثانية)` : ''}. الفيديو وصل ناقص.`);
          }
        }
        if (st.video_status === 'error' || st.processing_phase?.status === 'error') out.warnings.push('فيسبوك فشل في معالجة الفيديو.');
      } else {
        const p = await graph(env, id, { params: { fields: 'permalink_url,is_published,created_time', access_token: token } });
        out.url = p.permalink_url || `https://www.facebook.com/${id}`;
        out.facts.push(p.is_published === false ? 'مش منشور (مخفي/مسودة)' : 'منشور على الصفحة');
      }
    } else if (t.platform === 'instagram') {
      const token = await decrypt(env.SESSION_SECRET, t.token_enc);
      const m = await graph(env, id, { params: { fields: 'permalink,media_type,media_product_type,timestamp', access_token: token } });
      out.url = m.permalink || null;
      out.facts.push(`النوع على إنستجرام: ${m.media_product_type || ''} ${m.media_type || ''}`.trim());
    } else if (t.platform === 'youtube') {
      out.url = `https://youtu.be/${id}`;
    } else if (t.platform === 'whatsapp') {
      out.facts.push('حالة واتساب: بتفضل 24 ساعة على الرقم. شوفها من "حالتي" على الموبايل.');
    }
  } catch (err) {
    out.warnings.push(`المنصة ردت بخطأ: ${err.message}`);
  }
  return out;
}
