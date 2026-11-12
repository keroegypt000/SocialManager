// Client reports: followers, views, reach, engagement and top posts per account,
// read live from the Graph API for a date range and cached for a few hours.
//
// Metric names follow Meta's 2025/2026 changes:
//   Facebook: page_impressions -> page_media_view, page_impressions_unique -> page_total_media_view_unique,
//             page_fans -> page_follows, post_impressions -> post_media_view.
//   Instagram: impressions -> views (total_value).
// Every metric is fetched on its own and failures are tolerated, so one renamed or
// unavailable metric (or a missing permission) never breaks the whole report.
import { decrypt } from './crypto.js';
import { graph } from './meta.js';
import { adsForReport } from './ads.js';

const CACHE_MS = 2 * 3600 * 1000;
const DAY = 86400000;

const sec = (ms) => Math.floor(ms / 1000);
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

// Split [from, to) into windows of at most `days` days (Instagram allows 30).
function windows(from, to, days) {
  const out = [];
  for (let s = from; s < to; s += days * DAY) out.push([s, Math.min(to, s + days * DAY)]);
  return out;
}

async function tryGraph(env, path, params, errors, label) {
  try {
    return await graph(env, path, { params });
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

// Per-post insights through one Graph batch call (up to 50 posts per call), so a post
// that doesn't support a metric only loses its own numbers, not everyone's.
// Tries each metric set in order for the posts that failed the previous one.
async function postInsights(env, token, ids, metricSets, errors, label) {
  const found = new Map();
  let pending = ids;
  let lastErr = null;
  for (const metrics of metricSets) {
    if (!pending.length) break;
    const failed = [];
    for (let i = 0; i < pending.length; i += 50) {
      const chunk = pending.slice(i, i + 50);
      const batch = chunk.map((id) => ({ method: 'GET', relative_url: `${id}/insights?metric=${metrics}` }));
      let res;
      try {
        res = await graph(env, '', { method: 'POST', params: { access_token: token, include_headers: 'false', batch: JSON.stringify(batch) } });
      } catch (err) {
        lastErr = err.message;
        failed.push(...chunk);
        continue;
      }
      chunk.forEach((id, j) => {
        let body = {};
        try { body = JSON.parse(res?.[j]?.body || '{}'); } catch { /* ignore */ }
        if (res?.[j]?.code === 200 && Array.isArray(body.data)) {
          found.set(id, Object.fromEntries(body.data.map((m) => [m.name, Number(m.values?.[0]?.value ?? m.total_value?.value) || 0])));
        } else {
          lastErr = body.error?.message || `code ${res?.[j]?.code}`;
          failed.push(id);
        }
      });
    }
    pending = failed;
  }
  if (pending.length && lastErr) errors.push(`${label} (${pending.length} منشور): ${lastErr}`);
  return found;
}

// ---------- Facebook page ----------
async function facebookReport(env, acc, token, from, to) {
  to = Math.min(to, Date.now()); // Graph rejects ranges that end in the future.
  const errors = [];
  const out = { platform: 'facebook', id: acc.id, name: acc.name, picture: acc.picture, kpis: {}, daily: [], posts: [], errors };

  const info = await tryGraph(env, acc.external_id, { fields: 'followers_count,fan_count', access_token: token }, errors, 'المتابعين');
  if (info) out.kpis.followers = info.followers_count ?? info.fan_count ?? null;

  const series = {};
  for (const metric of ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements', 'page_follows']) {
    const r = await tryGraph(env, `${acc.external_id}/insights`, {
      metric, period: 'day', since: sec(from), until: sec(to), access_token: token,
    }, errors, metric);
    const values = r?.data?.[0]?.values;
    if (values) series[metric] = values.map((v) => ({ day: v.end_time?.slice(0, 10), value: Number(v.value) || 0 }));
  }
  if (series.page_media_view) out.kpis.views = sum(series.page_media_view.map((v) => v.value));
  if (series.page_total_media_view_unique) out.kpis.reach = sum(series.page_total_media_view_unique.map((v) => v.value));
  if (series.page_post_engagements) out.kpis.engagement = sum(series.page_post_engagements.map((v) => v.value));
  if (series.page_follows?.length > 1) {
    out.kpis.followers_change = series.page_follows.at(-1).value - series.page_follows[0].value;
  }
  const main = series.page_media_view || series.page_total_media_view_unique || [];
  out.daily = main.map((v) => ({ day: v.day, value: v.value }));
  out.dailyLabel = series.page_media_view ? 'المشاهدات' : 'الوصول';

  // Posts in the range with engagement counts (+ views/reach when the metrics are available).
  const baseFields = 'id,message,created_time,full_picture,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';
  const params = { since: sec(from), until: sec(to), limit: '50', access_token: token };
  const posts = await tryGraph(env, `${acc.external_id}/published_posts`, { ...params, fields: baseFields }, errors, 'المنشورات');
  const insights = await postInsights(env, token, (posts?.data || []).map((p) => p.id), [
    'post_media_view,post_total_media_view_unique',
    'post_media_view',
    'post_impressions,post_impressions_unique',
  ], errors, 'مشاهدات المنشورات');
  for (const p of posts?.data || []) {
    const raw = insights.get(p.id) || {};
    const ins = {
      post_media_view: raw.post_media_view ?? raw.post_impressions,
      post_total_media_view_unique: raw.post_total_media_view_unique ?? raw.post_impressions_unique,
    };
    const reactions = p.reactions?.summary?.total_count || 0;
    const comments = p.comments?.summary?.total_count || 0;
    const shares = p.shares?.count || 0;
    out.posts.push({
      id: p.id, text: p.message || '', time: p.created_time, image: p.full_picture || null, url: p.permalink_url || null,
      views: ins.post_media_view ?? null, reach: ins.post_total_media_view_unique ?? null,
      likes: reactions, comments, shares, engagement: reactions + comments + shares,
    });
  }
  out.kpis.posts = out.posts.length;
  // Page-wide engagement unavailable: fall back to the sum over the period's posts.
  if (out.kpis.engagement == null && out.posts.length) out.kpis.engagement = sum(out.posts.map((p) => p.engagement));
  // Same for views and reach when the account-wide numbers aren't available.
  for (const k of ['views', 'reach']) {
    const known = out.posts.filter((p) => p[k] != null);
    if (out.kpis[k] == null && known.length) {
      out.kpis[k] = sum(known.map((p) => p[k]));
      out.kpis[`${k}_from_posts`] = true;
    }
  }
  return out;
}

// ---------- Instagram account ----------
async function instagramReport(env, acc, token, from, to) {
  to = Math.min(to, Date.now()); // Graph rejects ranges that end in the future.
  const errors = [];
  const out = { platform: 'instagram', id: acc.id, name: acc.name, picture: acc.picture, kpis: {}, daily: [], posts: [], errors };

  const info = await tryGraph(env, acc.external_id, { fields: 'followers_count,media_count', access_token: token }, errors, 'المتابعين');
  if (info) out.kpis.followers = info.followers_count ?? null;

  // Totals for the range (Instagram allows at most 30 days per call).
  const totals = {};
  for (const metric of ['views', 'reach', 'total_interactions']) {
    let total = 0;
    let ok = false;
    for (const [s, u] of windows(from, to, 30)) {
      const r = await tryGraph(env, `${acc.external_id}/insights`, {
        metric, period: 'day', metric_type: 'total_value', since: sec(s), until: sec(u), access_token: token,
      }, errors, metric);
      const v = r?.data?.[0]?.total_value?.value;
      if (v != null) { total += Number(v) || 0; ok = true; }
    }
    if (ok) totals[metric] = total;
  }
  if (totals.views != null) out.kpis.views = totals.views;
  if (totals.reach != null) out.kpis.reach = totals.reach;
  if (totals.total_interactions != null) out.kpis.engagement = totals.total_interactions;

  // Daily reach for the chart, and new followers per day (last 30 days only, 100+ followers).
  for (const [s, u] of windows(from, to, 30)) {
    const r = await tryGraph(env, `${acc.external_id}/insights`, { metric: 'reach', period: 'day', since: sec(s), until: sec(u), access_token: token }, errors, 'reach (يومي)');
    for (const v of r?.data?.[0]?.values || []) out.daily.push({ day: v.end_time?.slice(0, 10), value: Number(v.value) || 0 });
  }
  out.dailyLabel = 'الوصول';
  if (to - from <= 31 * DAY && Date.now() - from <= 31 * DAY) {
    const r = await graph(env, `${acc.external_id}/insights`, {
      params: { metric: 'follower_count', period: 'day', since: sec(from), until: sec(to), access_token: token },
    }).catch(() => null);
    const vals = r?.data?.[0]?.values;
    if (vals) out.kpis.followers_change = sum(vals.map((v) => v.value));
  }

  // Posts in the range.
  const baseFields = 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count';
  const params = { since: sec(from), until: sec(to), limit: '50', access_token: token };
  const media = await tryGraph(env, `${acc.external_id}/media`, { ...params, fields: baseFields }, errors, 'المنشورات');
  const insights = await postInsights(env, token, (media?.data || []).map((m) => m.id), [
    'views,reach,shares,saved,total_interactions',
    'views,reach',
    'reach,saved,total_interactions',
  ], errors, 'مشاهدات المنشورات');
  for (const m of media?.data || []) {
    const ins = insights.get(m.id) || {};
    const likes = m.like_count || 0;
    const comments = m.comments_count || 0;
    const shares = ins.shares ?? 0;
    const saved = ins.saved ?? 0;
    out.posts.push({
      id: m.id, text: m.caption || '', time: m.timestamp, url: m.permalink || null,
      image: m.media_type === 'VIDEO' ? m.thumbnail_url || null : m.media_url || null,
      type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'album' : m.media_type === 'VIDEO' ? 'video' : 'image',
      views: ins.views ?? null, reach: ins.reach ?? null,
      likes, comments, shares, saved, engagement: ins.total_interactions ?? likes + comments + shares + saved,
    });
  }
  out.kpis.posts = out.posts.length;
  // Page-wide engagement unavailable: fall back to the sum over the period's posts.
  if (out.kpis.engagement == null && out.posts.length) out.kpis.engagement = sum(out.posts.map((p) => p.engagement));
  // Same for views and reach when the account-wide numbers aren't available.
  for (const k of ['views', 'reach']) {
    const known = out.posts.filter((p) => p[k] != null);
    if (out.kpis[k] == null && known.length) {
      out.kpis[k] = sum(known.map((p) => p[k]));
      out.kpis[`${k}_from_posts`] = true;
    }
  }
  return out;
}

// What the platform itself did for the client in the range.
async function platformStats(env, clientId, from, to) {
  const r = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN p.status = 'published' THEN 1 ELSE 0 END) AS published,
       SUM(CASE WHEN p.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
       SUM(CASE WHEN p.status IN ('failed', 'partial') THEN 1 ELSE 0 END) AS failed,
       COUNT(*) AS total
     FROM posts p WHERE p.client_id = ? AND COALESCE(p.scheduled_at, p.created_at) >= ? AND COALESCE(p.scheduled_at, p.created_at) < ?`
  ).bind(clientId, from, to).first();
  const wa = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM post_targets pt JOIN posts p ON p.id = pt.post_id JOIN accounts a ON a.id = pt.account_id
     WHERE a.platform = 'whatsapp' AND pt.status = 'published' AND p.client_id = ?
       AND COALESCE(p.scheduled_at, p.created_at) >= ? AND COALESCE(p.scheduled_at, p.created_at) < ?`
  ).bind(clientId, from, to).first();
  return { published: r.published || 0, scheduled: r.scheduled || 0, failed: r.failed || 0, total: r.total || 0, whatsapp: wa.n || 0 };
}

export async function buildReport(env, clientId, from, to, { refresh = false } = {}) {
  from = Number(from);
  to = Number(to);
  if (!from || !to || to <= from) throw new Error('اختار فترة صحيحة');
  if (to - from > 93 * DAY) throw new Error('أقصى فترة للتقرير 3 شهور');

  const client = await env.DB.prepare('SELECT id, name, color FROM clients WHERE id = ?').bind(clientId).first();
  if (!client) throw new Error('العميل مش موجود');

  const key = `v2:${clientId}:${from}:${to}`;
  if (!refresh) {
    const cached = await env.DB.prepare('SELECT json, created_at FROM report_cache WHERE key = ?').bind(key).first();
    if (cached && Date.now() - cached.created_at < CACHE_MS) return { ...JSON.parse(cached.json), cached_at: cached.created_at };
  }

  const { results: accounts } = await env.DB.prepare(
    "SELECT * FROM accounts WHERE client_id = ? AND platform IN ('facebook', 'instagram') ORDER BY platform, name"
  ).bind(clientId).all();
  const sections = [];
  for (const acc of accounts) {
    try {
      const token = await decrypt(env.SESSION_SECRET, acc.token_enc);
      sections.push(acc.platform === 'facebook'
        ? await facebookReport(env, acc, token, from, to)
        : await instagramReport(env, acc, token, from, to));
    } catch (err) {
      sections.push({ platform: acc.platform, id: acc.id, name: acc.name, kpis: {}, daily: [], posts: [], errors: [err.message] });
    }
  }

  const report = {
    client: { id: client.id, name: client.name, color: client.color },
    from, to, generated_at: Date.now(),
    accounts: sections,
    platform: await platformStats(env, clientId, from, to),
    ads: await adsForReport(env, clientId, from, to),
  };
  // Reports with missing numbers aren't cached, so the next look tries again.
  if (!sections.some((s) => s.errors.length)) {
    await env.DB.prepare('INSERT OR REPLACE INTO report_cache (key, json, created_at) VALUES (?, ?, ?)')
      .bind(key, JSON.stringify(report), Date.now()).run();
  }
  await env.DB.prepare('DELETE FROM report_cache WHERE created_at < ?').bind(Date.now() - 7 * DAY).run();
  return report;
}

// Read-only report links for clients.
export async function createReportLink(env, clientId, origin) {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 90 * DAY;
  await env.DB.prepare('INSERT INTO report_links (token, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(token, clientId, Date.now(), expiresAt).run();
  return { url: `${origin}/#/r/${token}`, expires_at: expiresAt };
}

export async function clientForReportLink(env, token) {
  if (!/^[0-9a-f-]{36}$/.test(String(token || ''))) return null;
  const row = await env.DB.prepare('SELECT client_id FROM report_links WHERE token = ? AND expires_at > ?').bind(token, Date.now()).first();
  return row?.client_id || null;
}
