import { decrypt } from './crypto.js';
import { publishFacebook, publishInstagram, containerStatus, finishInstagram, mediaOf } from './meta.js';
import { deleteVideo } from './media.js';
import { notifyAll } from './push.js';
import { EXTRA_PUBLISHERS, tiktokStatus } from './providers.js';
import { publishWhatsAppStatus, waLimitReached, getWaLimit, GATEWAY } from './whatsapp.js';

const PUBLISHERS = {
  facebook: publishFacebook,
  instagram: publishInstagram,
  // WhatsApp statuses: handled in publishPost (automatic gateway or one-tap manual).
};

const PROCESSING_TIMEOUT = 45 * 60 * 1000; // give up on an Instagram video after 45 minutes
const VIDEO_KEEP_DAYS = 7; // published videos are deleted from storage after this

// Post status from its targets: still processing -> 'publishing'.
export async function finalizePost(env, postId) {
  const { results } = await env.DB.prepare('SELECT status FROM post_targets WHERE post_id = ?').bind(postId).all();
  if (results.some((t) => t.status === 'processing' || t.status === 'pending')) return 'publishing';
  if (results.some((t) => t.status === 'manual')) {
    await env.DB.prepare("UPDATE posts SET status = 'manual' WHERE id = ?").bind(postId).run();
    return 'manual';
  }
  const ok = results.filter((t) => t.status === 'published').length;
  const status = results.length === 0 ? 'failed' : ok === results.length ? 'published' : ok === 0 ? 'failed' : 'partial';
  await env.DB.prepare('UPDATE posts SET status = ? WHERE id = ?').bind(status, postId).run();
  return status;
}

const fail = (env, targetId, err) =>
  env.DB.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?").bind(String(err.message || err).slice(0, 500), targetId).run();

// Publishes every target of one post that isn't published yet and sets the post's status.
export async function publishPost(env, postId) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
  if (!post) throw new Error('المنشور مش موجود');

  const { results: targets } = await env.DB.prepare(
    `SELECT pt.id, pt.status, a.id AS account_id, a.platform, a.external_id, a.token_enc
     FROM post_targets pt JOIN accounts a ON a.id = pt.account_id
     WHERE pt.post_id = ?`
  ).bind(postId).all();

  for (const t of targets) {
    if (['published', 'processing', 'manual'].includes(t.status)) continue;
    try {
      if (t.platform === 'whatsapp' && (await waLimitReached(env, t.account_id, postId))) {
        throw new Error(`وصلت للحد اليومي لحالات الرقم ده (${await getWaLimit(env)} في اليوم). اتنشرت على باقي الحسابات بس، وتقدر تعيد المحاولة بكرة.`);
      }
      let result;
      if (t.platform === 'whatsapp') {
        // Linked to our gateway: posts on its own. Otherwise waits for you to share it in one tap.
        result = t.token_enc === GATEWAY ? await publishWhatsAppStatus(env, t.account_id, post, mediaOf(post)) : { manual: true };
      } else if (EXTRA_PUBLISHERS[t.platform]) {
        // YouTube / LinkedIn / TikTok manage (and refresh) their own tokens.
        result = await EXTRA_PUBLISHERS[t.platform](env, { id: t.account_id, external_id: t.external_id, token_enc: t.token_enc }, post, mediaOf(post));
      } else {
        const fn = PUBLISHERS[t.platform];
        if (!fn) throw new Error('المنصة دي لسه مش مدعومة: ' + t.platform);
        const token = await decrypt(env.SESSION_SECRET, t.token_enc);
        result = await fn(env, t.external_id, token, post);
      }
      if (result && result.manual) {
        await env.DB.prepare("UPDATE post_targets SET status = 'manual', error = NULL WHERE id = ?").bind(t.id).run();
      } else if (result && result.pending) {
        await env.DB.prepare("UPDATE post_targets SET status = 'processing', external_post_id = ?, error = NULL, started_at = ? WHERE id = ?")
          .bind(String(result.pending), Date.now(), t.id).run();
      } else {
        await env.DB.prepare("UPDATE post_targets SET status = 'published', external_post_id = ?, error = NULL WHERE id = ?")
          .bind(String(result || ''), t.id).run();
      }
    } catch (err) {
      await fail(env, t.id, err);
    }
  }
  return finalizePost(env, postId);
}

// Called by the cron trigger every few minutes.
export async function runDuePosts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10"
  ).bind(Date.now()).all();

  let waiting = 0;
  for (const { id } of results) {
    // Claim the post first so two overlapping runs never publish it twice.
    const claim = await env.DB.prepare("UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (!claim.meta.changes) continue;
    try {
      if ((await publishPost(env, id)) === 'manual') waiting++;
    } catch (err) {
      console.error('publish failed', id, err);
      await env.DB.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").bind(id).run();
    }
  }
  // WhatsApp statuses just became due: ping the phone.
  if (waiting) await notifyAll(env).catch((err) => console.error('push failed', err));
}

// Instagram videos (and big albums) take a while to process: publish them once ready.
export async function runProcessing(env) {
  const { results } = await env.DB.prepare(
    `SELECT pt.id, pt.post_id, pt.external_post_id, pt.started_at, a.id AS account_id, a.platform, a.external_id, a.token_enc
     FROM post_targets pt JOIN accounts a ON a.id = pt.account_id
     WHERE pt.status = 'processing' LIMIT 20`
  ).all();
  const touched = new Set();
  for (const t of results) {
    touched.add(t.post_id);
    try {
      if (t.platform === 'tiktok') {
        const st = await tiktokStatus(env, { id: t.account_id, token_enc: t.token_enc }, String(t.external_post_id).replace(/^tiktok:/, ''));
        if (st.status === 'PUBLISH_COMPLETE') {
          const id = st.publicaly_available_post_id?.[0] || st.publicly_available_post_id?.[0] || t.external_post_id;
          await env.DB.prepare("UPDATE post_targets SET status = 'published', external_post_id = ?, error = NULL WHERE id = ?").bind(String(id), t.id).run();
        } else if (st.status === 'FAILED') {
          await fail(env, t.id, new Error(`تيك توك رفض الفيديو${st.fail_reason ? `: ${st.fail_reason}` : ''}`));
        } else if (Date.now() - (t.started_at || 0) > PROCESSING_TIMEOUT) {
          await fail(env, t.id, new Error('تيك توك اتأخر جداً في نشر الفيديو. شوف التطبيق نفسه.'));
        }
        continue;
      }
      const token = await decrypt(env.SESSION_SECRET, t.token_enc);
      const s = await containerStatus(env, t.external_post_id, token);
      if (s.status_code === 'FINISHED') {
        const id = await finishInstagram(env, t.external_id, token, t.external_post_id);
        await env.DB.prepare("UPDATE post_targets SET status = 'published', external_post_id = ?, error = NULL WHERE id = ?").bind(String(id), t.id).run();
      } else if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
        await fail(env, t.id, new Error(`إنستجرام رفض الفيديو${s.status ? `: ${s.status}` : ''}. اتأكد إنه MP4، طوله بين 3 ثواني و15 دقيقة.`));
      } else if (Date.now() - (t.started_at || 0) > PROCESSING_TIMEOUT) {
        await fail(env, t.id, new Error('إنستجرام اتأخر جداً في تجهيز الفيديو. جرّب "إعادة المحاولة".'));
      }
    } catch (err) {
      await fail(env, t.id, err);
    }
  }
  for (const postId of touched) await finalizePost(env, postId);
}

// Free KV space: delete videos of posts published more than VIDEO_KEEP_DAYS ago,
// unless another upcoming post still uses the same video.
export async function cleanupVideos(env) {
  if (!env.MEDIA) return;
  const cutoff = Date.now() - VIDEO_KEEP_DAYS * 86400000;
  const { results } = await env.DB.prepare(
    `SELECT id, media FROM posts
     WHERE media_cleaned = 0 AND media LIKE '%.mp4%' AND status IN ('published', 'failed', 'partial')
       AND COALESCE(scheduled_at, created_at) < ? ORDER BY COALESCE(scheduled_at, created_at) LIMIT 30`
  ).bind(cutoff).all();
  for (const p of results) {
    let allDeleted = true;
    for (const m of mediaOf(p).filter((x) => x.type === 'video')) {
      // instr() instead of LIKE: D1 rejects long LIKE patterns.
      const inUse = await env.DB.prepare(
        `SELECT 1 FROM posts WHERE id != ? AND instr(media, ?) > 0
           AND (status NOT IN ('published', 'failed', 'partial') OR COALESCE(scheduled_at, created_at) >= ?) LIMIT 1`
      ).bind(p.id, m.url, cutoff).first();
      if (inUse) {
        allDeleted = false; // keep it; checked again on a later run
        continue;
      }
      await deleteVideo(env, m.url);
      await env.DB.prepare('UPDATE posts SET media_cleaned = 1 WHERE instr(media, ?) > 0').bind(m.url).run();
    }
    if (allDeleted) await env.DB.prepare('UPDATE posts SET media_cleaned = 1 WHERE id = ?').bind(p.id).run();
  }
}
