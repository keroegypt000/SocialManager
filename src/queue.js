// "Publish now" in the background: the API answers right away and a Durable Object
// (one per post) publishes from its alarm, which may run for minutes (big videos)
// without anyone waiting on the page.
import { DurableObject } from 'cloudflare:workers';
import { publishPost } from './publisher.js';
import { ensureSchema } from './db.js';
import { notifyAll } from './push.js';

export class PublishJob extends DurableObject {
  async start(postId) {
    await this.ctx.storage.put('post', Number(postId));
    await this.ctx.storage.setAlarm(Date.now());
    return { queued: true };
  }

  async alarm() {
    const id = await this.ctx.storage.get('post');
    if (!id) return;
    await this.ctx.storage.delete('post');
    await ensureSchema(this.env);
    try {
      const status = await publishPost(this.env, id);
      if (status === 'manual') await notifyAll(this.env).catch(() => {});
    } catch (err) {
      console.error('background publish failed', id, err);
      await this.env.DB.prepare("UPDATE posts SET status = 'failed' WHERE id = ? AND status = 'publishing'").bind(id).run().catch(() => {});
    }
  }
}

// Hand a post (already marked 'publishing') to its background job.
export async function publishInBackground(env, postId) {
  if (!env.PUBLISH_JOB) return publishPost(env, postId); // not configured: publish inline
  await env.PUBLISH_JOB.get(env.PUBLISH_JOB.idFromName(`post-${postId}`)).start(Number(postId));
  return 'queued';
}

// From the cron: a post stuck in 'publishing' for 20+ minutes with targets still
// pending (the background job was interrupted) gets another try. Published targets
// are skipped, so nothing is posted twice.
export async function resumeStuckPublishing(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM posts p
     WHERE p.status = 'publishing' AND COALESCE(p.publish_started_at, p.created_at) < ?
       AND EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.status = 'pending')
       AND NOT EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = p.id AND pt.status = 'processing')
     LIMIT 5`
  ).bind(Date.now() - 20 * 60 * 1000).all();
  for (const { id } of results) {
    await env.DB.prepare('UPDATE posts SET publish_started_at = ? WHERE id = ?').bind(Date.now(), id).run();
    await publishInBackground(env, id);
  }
}
