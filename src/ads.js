// Meta Ads (Marketing API): stats per ad account, campaigns with pause/resume,
// and promoting an existing Facebook post. New ads are always created PAUSED,
// so nothing spends money until someone turns them on.
import { decrypt } from './crypto.js';
import { graph } from './meta.js';

const DAY = 86400000;
const INSIGHT_FIELDS = 'spend,impressions,reach,clicks,ctr,cpc,actions';
// Currencies Meta counts without cents (amounts are sent in the smallest unit).
const NO_CENTS = ['JPY', 'KRW', 'CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'PYG', 'TWD', 'VND'];

const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class AdsError extends Error {}

async function adAccount(env, accountId, clientId) {
  const acc = await env.DB.prepare("SELECT * FROM accounts WHERE id = ? AND platform = 'meta_ads'").bind(accountId).first();
  if (!acc || (clientId && acc.client_id !== Number(clientId))) throw new AdsError('حساب الإعلانات مش موجود');
  return { acc, token: await decrypt(env.SESSION_SECRET, acc.token_enc) };
}

// Graph errors in plain Arabic where we can.
function explain(err) {
  const m = String(err.message || err);
  if (/session|expired|access token|OAuthException|#190/i.test(m)) return 'صلاحية حساب الإعلانات انتهت (بتتجدد كل شهرين تقريباً). اربط فيسبوك تاني للعميل ده.';
  if (/ads_read|ads_management|permission/i.test(m)) return 'محتاج صلاحية الإعلانات. اربط فيسبوك تاني عشان توافق على صلاحيات الإعلانات.';
  return m;
}

// "Results": the main action Meta counted (messages, leads, purchases, engagement...).
function results(actions = []) {
  const prefer = ['onsite_conversion.messaging_conversation_started_7d', 'lead', 'offsite_conversion.fb_pixel_purchase', 'purchase', 'link_click', 'post_engagement', 'page_engagement'];
  for (const type of prefer) {
    const a = actions.find((x) => x.action_type === type);
    if (a) return { type, value: Number(a.value) || 0 };
  }
  return null;
}

const num = (v) => (v == null ? null : Number(v));
function shapeInsights(i = {}) {
  return {
    spend: num(i.spend), impressions: num(i.impressions), reach: num(i.reach), clicks: num(i.clicks),
    ctr: num(i.ctr), cpc: num(i.cpc), result: results(i.actions),
  };
}

export async function adsOverview(env, clientId, from, to) {
  from = Number(from);
  to = Number(to);
  if (!from || !to || to <= from) throw new AdsError('اختار فترة صحيحة');
  const range = JSON.stringify({ since: ymd(from), until: ymd(to - 1) });
  const { results: accounts } = await env.DB.prepare("SELECT * FROM accounts WHERE client_id = ? AND platform = 'meta_ads' ORDER BY name").bind(clientId).all();
  const out = [];
  for (const acc of accounts) {
    const item = { id: acc.id, name: acc.name, external_id: acc.external_id, totals: null, campaigns: [], currency: null, error: null };
    try {
      const token = await decrypt(env.SESSION_SECRET, acc.token_enc);
      const info = await graph(env, acc.external_id, { params: { fields: 'currency,account_status,amount_spent,balance', access_token: token } });
      item.currency = info.currency;
      item.status = info.account_status;
      const ins = await graph(env, `${acc.external_id}/insights`, { params: { fields: INSIGHT_FIELDS, time_range: range, access_token: token } });
      item.totals = shapeInsights(ins.data?.[0]);
      const camps = await graph(env, `${acc.external_id}/campaigns`, {
        params: {
          fields: `id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,insights.time_range(${range}){${INSIGHT_FIELDS}}`,
          limit: '50', access_token: token,
        },
      });
      item.campaigns = (camps.data || []).map((c) => ({
        id: c.id, name: c.name, status: c.status, effective_status: c.effective_status, objective: c.objective,
        daily_budget: num(c.daily_budget), lifetime_budget: num(c.lifetime_budget), start_time: c.start_time, stop_time: c.stop_time,
        ...shapeInsights(c.insights?.data?.[0]),
      }));
    } catch (err) {
      item.error = explain(err);
    }
    out.push(item);
  }
  return out;
}

export async function setCampaignStatus(env, accountId, campaignId, status) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new AdsError('حالة غير معروفة');
  if (!/^\d+$/.test(String(campaignId))) throw new AdsError('حملة غير معروفة');
  const { acc, token } = await adAccount(env, accountId);
  // Make sure the campaign belongs to this ad account before touching it.
  const c = await graph(env, String(campaignId), { params: { fields: 'account_id', access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  if (`act_${c.account_id}` !== acc.external_id) throw new AdsError('الحملة دي مش تبع حساب الإعلانات ده');
  await graph(env, String(campaignId), { method: 'POST', params: { status, access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  return { ok: true };
}

// Promote an existing Facebook post: campaign -> ad set -> ad, all PAUSED.
export async function boostPost(env, { account_id, post_target_id, daily_budget, days, countries, age_min, age_max, name }) {
  const { acc, token } = await adAccount(env, account_id);
  const t = await env.DB.prepare(
    `SELECT pt.external_post_id, a.external_id AS page_id, a.client_id, p.message
     FROM post_targets pt JOIN accounts a ON a.id = pt.account_id JOIN posts p ON p.id = pt.post_id
     WHERE pt.id = ? AND a.platform = 'facebook' AND pt.status = 'published'`
  ).bind(post_target_id).first();
  if (!t || !t.external_post_id) throw new AdsError('اختار منشور فيسبوك اتنشر');
  if (t.client_id !== acc.client_id) throw new AdsError('حساب الإعلانات والمنشور لازم يكونوا لنفس العميل');

  const budget = Number(daily_budget);
  const nDays = Math.round(Number(days));
  if (!(budget > 0)) throw new AdsError('اكتب ميزانية يومية');
  if (!(nDays >= 1 && nDays <= 90)) throw new AdsError('المدة من يوم لـ 90 يوم');
  const geo = String(countries || 'EG').toUpperCase().split(/[\s,]+/).filter((c) => /^[A-Z]{2}$/.test(c));
  if (!geo.length) throw new AdsError('اكتب كود دولة واحدة على الأقل (مثلاً EG أو KW)');
  const ageMin = Math.max(18, Number(age_min) || 18);
  const ageMax = Math.min(65, Number(age_max) || 65);

  const info = await graph(env, acc.external_id, { params: { fields: 'currency', access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  const minor = Math.round(budget * (NO_CENTS.includes(info.currency) ? 1 : 100));
  const storyId = t.external_post_id.includes('_') ? t.external_post_id : `${t.page_id}_${t.external_post_id}`;
  const label = String(name || '').trim() || `ترويج: ${(t.message || 'منشور').slice(0, 40)}`;
  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + nDays * DAY);
  const call = (path, params) => graph(env, path, { method: 'POST', params: { ...params, access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });

  const campaign = await call(`${acc.external_id}/campaigns`, {
    name: label, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
    special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false',
  });
  const adset = await call(`${acc.external_id}/adsets`, {
    name: `${label} - جمهور`, campaign_id: campaign.id, status: 'PAUSED',
    daily_budget: String(minor), billing_event: 'IMPRESSIONS', optimization_goal: 'POST_ENGAGEMENT',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    start_time: start.toISOString(), end_time: end.toISOString(),
    targeting: JSON.stringify({ geo_locations: { countries: geo }, age_min: ageMin, age_max: ageMax }),
  });
  const ad = await call(`${acc.external_id}/ads`, {
    name: label, adset_id: adset.id, status: 'PAUSED',
    creative: JSON.stringify({ object_story_id: storyId }),
  });
  return { campaign_id: campaign.id, adset_id: adset.id, ad_id: ad.id, currency: info.currency };
}

// Ads totals for the client report (spend, reach, clicks...).
export async function adsForReport(env, clientId, from, to) {
  const list = await adsOverview(env, clientId, from, to).catch(() => []);
  return list.map((a) => ({ name: a.name, currency: a.currency, totals: a.totals, error: a.error, campaigns: a.campaigns.filter((c) => c.spend).length }));
}
