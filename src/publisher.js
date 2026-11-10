import { decrypt } from './crypto.js';
import { publishFacebook, publishInstagram } from './meta.js';

const PUBLISHERS = {
  facebook: publishFacebook,
  instagram: publishInstagram,
};

// Publishes every pending target of one post and sets the post's final status.
export async function publishPost(env, postId) {
  const post = await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(postId).first();
  if (!post) throw new Error('المنشور مش موجود');

  const { results: targets } = await env.DB.prepare(
    `SELECT pt.id, pt.status, a.platform, a.external_id, a.token_enc
     FROM post_targets pt JOIN accounts a ON a.id = pt.account_id
     WHERE pt.post_id = ?`
  ).bind(postId).all();

  for (const t of targets) {
    if (t.status === 'published') continue;
    try {
      const fn = PUBLISHERS[t.platform];
      if (!fn) throw new Error('المنصة دي لسه مش مدعومة: ' + t.platform);
      const token = await decrypt(env.SESSION_SECRET, t.token_enc);
      const externalId = await fn(env, t.external_id, token, post);
      t.status = 'published';
      await env.DB.prepare("UPDATE post_targets SET status = 'published', external_post_id = ?, error = NULL WHERE id = ?")
        .bind(String(externalId || ''), t.id).run();
    } catch (err) {
      t.status = 'failed';
      await env.DB.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE id = ?")
        .bind(String(err.message || err).slice(0, 500), t.id).run();
    }
  }

  const ok = targets.filter((t) => t.status === 'published').length;
  const status = targets.length === 0 ? 'failed' : ok === targets.length ? 'published' : ok === 0 ? 'failed' : 'partial';
  await env.DB.prepare('UPDATE posts SET status = ? WHERE id = ?').bind(status, postId).run();
  return status;
}

// Called by the cron trigger every few minutes.
export async function runDuePosts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10"
  ).bind(Date.now()).all();

  for (const { id } of results) {
    // Claim the post first so two overlapping runs never publish it twice.
    const claim = await env.DB.prepare("UPDATE posts SET status = 'publishing' WHERE id = ? AND status = 'scheduled'").bind(id).run();
    if (!claim.meta.changes) continue;
    try {
      await publishPost(env, id);
    } catch (err) {
      console.error('publish failed', id, err);
      await env.DB.prepare("UPDATE posts SET status = 'failed' WHERE id = ?").bind(id).run();
    }
  }
}
