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

// Campaigns, ad sets and ads all carry account_id: make sure the object belongs to
// this ad account before touching it.
async function ownedObject(env, accountId, objectId, fields = 'account_id') {
  if (!/^\d+$/.test(String(objectId))) throw new AdsError('عنصر غير معروف');
  const { acc, token } = await adAccount(env, accountId);
  const obj = await graph(env, String(objectId), { params: { fields: `account_id,${fields}`, access_token: token } })
    .catch((e) => { throw new AdsError(explain(e)); });
  if (`act_${obj.account_id}` !== acc.external_id) throw new AdsError('ده مش تبع حساب الإعلانات ده');
  return { acc, token, obj };
}

const post = (env, path, params, token) => graph(env, path, { method: 'POST', params: { ...params, access_token: token } })
  .catch((e) => { throw new AdsError(explain(e)); });

// Pause / resume / delete a campaign, ad set or ad.
export async function setObjectStatus(env, accountId, objectId, status) {
  if (!['ACTIVE', 'PAUSED', 'DELETED'].includes(status)) throw new AdsError('حالة غير معروفة');
  const { token } = await ownedObject(env, accountId, objectId);
  await post(env, String(objectId), { status }, token);
  return { ok: true };
}
export const setCampaignStatus = setObjectStatus;

const minorUnits = (amount, currency) => Math.round(Number(amount) * (NO_CENTS.includes(currency) ? 1 : 100));

// Change the budget of a campaign or ad set (whichever holds it), daily or total.
export async function setBudget(env, accountId, objectId, amount) {
  const value = Number(amount);
  if (!(value > 0)) throw new AdsError('اكتب الميزانية');
  const { acc, token, obj } = await ownedObject(env, accountId, objectId, 'daily_budget,lifetime_budget');
  const field = Number(obj.lifetime_budget) > 0 && !(Number(obj.daily_budget) > 0) ? 'lifetime_budget' : 'daily_budget';
  if (!(Number(obj[field]) > 0)) throw new AdsError('الميزانية مش على المستوى ده. افتح تفاصيل الحملة وغيّرها من المجموعة الإعلانية.');
  const info = await graph(env, acc.external_id, { params: { fields: 'currency', access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  await post(env, String(objectId), { [field]: String(minorUnits(value, info.currency)) }, token);
  return { ok: true, field };
}

// Ad sets and ads inside one campaign, with their numbers for the range.
export async function campaignDetails(env, accountId, campaignId, from, to) {
  const { token } = await ownedObject(env, accountId, campaignId);
  const range = JSON.stringify({ since: ymd(Number(from)), until: ymd(Number(to) - 1) });
  const ins = `insights.time_range(${range}){${INSIGHT_FIELDS}}`;
  const get = (path, fields) => graph(env, path, { params: { fields, limit: '50', access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  const adsets = await get(`${campaignId}/adsets`, `id,name,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,targeting{age_min,age_max,genders,geo_locations},${ins}`);
  const ads = await get(`${campaignId}/ads`, `id,name,status,effective_status,adset_id,creative{thumbnail_url,effective_object_story_id},${ins}`);
  return {
    adsets: (adsets.data || []).map((a) => ({
      id: a.id, name: a.name, status: a.status, effective_status: a.effective_status,
      daily_budget: num(a.daily_budget), lifetime_budget: num(a.lifetime_budget), start_time: a.start_time, end_time: a.end_time,
      audience: {
        countries: a.targeting?.geo_locations?.countries || [], age_min: a.targeting?.age_min, age_max: a.targeting?.age_max,
        genders: a.targeting?.genders || [],
      },
      ...shapeInsights(a.insights?.data?.[0]),
    })),
    ads: (ads.data || []).map((a) => ({
      id: a.id, name: a.name, status: a.status, effective_status: a.effective_status, adset_id: a.adset_id,
      thumbnail: a.creative?.thumbnail_url || null,
      ...shapeInsights(a.insights?.data?.[0]),
    })),
  };
}

// Recent posts of the client's Facebook pages, straight from Facebook (also ones made outside the platform).
export async function pagePosts(env, clientId) {
  const { results: pages } = await env.DB.prepare("SELECT * FROM accounts WHERE client_id = ? AND platform = 'facebook' ORDER BY name").bind(clientId).all();
  const out = [];
  for (const page of pages) {
    try {
      const token = await decrypt(env.SESSION_SECRET, page.token_enc);
      const r = await graph(env, `${page.external_id}/published_posts`, {
        params: { fields: 'id,message,full_picture,created_time,permalink_url', limit: '25', access_token: token },
      });
      for (const p of r.data || []) {
        out.push({ page_account_id: page.id, page_name: page.name, id: p.id, text: p.message || '', image: p.full_picture || null, time: p.created_time, url: p.permalink_url || null });
      }
    } catch (err) {
      out.push({ page_account_id: page.id, page_name: page.name, error: err.message });
    }
  }
  return out;
}

// Promote an existing Facebook post: campaign -> ad set -> ad, all PAUSED.
export async function boostPost(env, {
  account_id, post_target_id, page_account_id, page_post_id, daily_budget, days, countries, age_min, age_max, genders,
  objective = 'engagement', start_now = false, name,
}) {
  const { acc, token } = await adAccount(env, account_id);
  let t;
  if (page_post_id) {
    // A post picked straight from the page (ads page).
    const page = await env.DB.prepare("SELECT external_id, client_id FROM accounts WHERE id = ? AND platform = 'facebook'").bind(page_account_id).first();
    if (!page) throw new AdsError('اختار صفحة فيسبوك');
    if (!new RegExp(`^${page.external_id}_\\d+$`).test(String(page_post_id))) throw new AdsError('المنشور مش تبع الصفحة دي');
    t = { external_post_id: String(page_post_id), page_id: page.external_id, client_id: page.client_id, message: '' };
  } else {
    t = await env.DB.prepare(
      `SELECT pt.external_post_id, a.external_id AS page_id, a.client_id, p.message
       FROM post_targets pt JOIN accounts a ON a.id = pt.account_id JOIN posts p ON p.id = pt.post_id
       WHERE pt.id = ? AND a.platform = 'facebook' AND pt.status = 'published'`
    ).bind(post_target_id).first();
  }
  if (!t || !t.external_post_id) throw new AdsError('اختار منشور فيسبوك اتنشر');
  if (t.client_id !== acc.client_id) throw new AdsError('حساب الإعلانات والمنشور لازم يكونوا لنفس العميل');
  const GOALS = {
    engagement: { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'POST_ENGAGEMENT' },
    awareness: { objective: 'OUTCOME_AWARENESS', optimization_goal: 'REACH' },
  };
  const goal = GOALS[objective];
  if (!goal) throw new AdsError('هدف غير معروف');
  const status = start_now === true ? 'ACTIVE' : 'PAUSED';
  const gender = [1, 2].includes(Number(genders)) ? [Number(genders)] : null;

  const budget = Number(daily_budget);
  const nDays = Math.round(Number(days));
  if (!(budget > 0)) throw new AdsError('اكتب ميزانية يومية');
  if (!(nDays >= 1 && nDays <= 90)) throw new AdsError('المدة من يوم لـ 90 يوم');
  const geo = String(countries || 'EG').toUpperCase().split(/[\s,]+/).filter((c) => /^[A-Z]{2}$/.test(c));
  if (!geo.length) throw new AdsError('اكتب كود دولة واحدة على الأقل (مثلاً EG أو KW)');
  const ageMin = Math.max(18, Number(age_min) || 18);
  const ageMax = Math.min(65, Number(age_max) || 65);

  const info = await graph(env, acc.external_id, { params: { fields: 'currency', access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });
  const minor = minorUnits(budget, info.currency);
  const storyId = t.external_post_id.includes('_') ? t.external_post_id : `${t.page_id}_${t.external_post_id}`;
  const label = String(name || '').trim() || `ترويج: ${(t.message || 'منشور').slice(0, 40)}`;
  const start = new Date(Date.now() + 10 * 60 * 1000);
  const end = new Date(start.getTime() + nDays * DAY);
  const call = (path, params) => graph(env, path, { method: 'POST', params: { ...params, access_token: token } }).catch((e) => { throw new AdsError(explain(e)); });

  const campaign = await call(`${acc.external_id}/campaigns`, {
    name: label, objective: goal.objective, status,
    special_ad_categories: '[]', is_adset_budget_sharing_enabled: 'false',
  });
  const adset = await call(`${acc.external_id}/adsets`, {
    name: `${label} - جمهور`, campaign_id: campaign.id, status,
    daily_budget: String(minor), billing_event: 'IMPRESSIONS', optimization_goal: goal.optimization_goal,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    start_time: start.toISOString(), end_time: end.toISOString(),
    targeting: JSON.stringify({ geo_locations: { countries: geo }, age_min: ageMin, age_max: ageMax, ...(gender ? { genders: gender } : {}) }),
  });
  const ad = await call(`${acc.external_id}/ads`, {
    name: label, adset_id: adset.id, status,
    creative: JSON.stringify({ object_story_id: storyId }),
  });
  return { campaign_id: campaign.id, adset_id: adset.id, ad_id: ad.id, currency: info.currency, status };
}

// Ads totals for the client report (spend, reach, clicks...).
export async function adsForReport(env, clientId, from, to) {
  const list = await adsOverview(env, clientId, from, to).catch(() => []);
  return list.map((a) => ({ name: a.name, currency: a.currency, totals: a.totals, error: a.error, campaigns: a.campaigns.filter((c) => c.spend).length }));
}
