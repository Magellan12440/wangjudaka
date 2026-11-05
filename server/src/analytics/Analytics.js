/**
 * 分发数据看板 + 收益计算器（§13.2 / §16 M5 / §18.3 第 13 步）。
 *
 * 与 DistributionHub 的关系：
 *  - Hub 负责「分发任务状态机」；本模块负责「时序数据 + 收益账 + 估算」。
 *  - Hub.recordStats / recordRevenue 保持原返回结构兼容，但改为追加写入本模块的集合，
 *    使数据不再被覆盖、可出趋势、可对账（§14：账本只追加不修改）。
 *
 * 红线：所有分成系数来自 revenue_policies.json 并带 policy_updated_at 与免责声明，
 * 计算结果一律标注「估算，非平台承诺」；不得把估算值当作应收款写入账本。
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, clamp, round } from '../core/util.js';

const SNAP = 'stat_snapshots';
const EARN = 'earnings';
const DIST = 'distributions';

/** 有效播放折算：完播率越高，同等播放量折算越多（估算模型，非平台口径） */
export const EFFECTIVE_VIEW_BASE = 0.4;
export const EFFECTIVE_VIEW_WEIGHT = 0.6;

export class Analytics {
  policies() {
    return seeds.revenuePolicies.map((p) => ({
      ...p,
      // 前端展示必须带时效与免责
      in_app_embeddable: false,
      estimate_only: true,
    }));
  }

  policy(code) {
    const p = seeds.revenuePolicy(code);
    if (!p) fail(ERR.BAD_REQUEST, `收益政策不存在: ${code}`, { available: seeds.revenuePolicies.map((x) => x.code) });
    return p;
  }

  /** 数据回传：追加时序快照，不覆盖历史 */
  recordStatsSnapshot({ distributionId, stats, recordedAt = null }) {
    const d = db.findOne(DIST, (x) => x.id === distributionId);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    const at = recordedAt ?? nowIso();
    const views = num(stats.views, 0);
    const likes = num(stats.likes, 0);
    const comments = num(stats.comments, 0);
    const shares = num(stats.shares, 0);
    const completionRate = stats.completion_rate === null || stats.completion_rate === undefined
      ? null
      : clamp(num(stats.completion_rate, 0), 0, 1);
    const rec = db.insert(SNAP, {
      id: newId('snap'),
      distribution_id: distributionId,
      project_id: d.project_id,
      platform: d.platform,
      episode: d.episode,
      recorded_at: at,
      views, likes, comments, shares,
      completion_rate: completionRate,
      engagement_rate: views > 0 ? round((likes + comments + shares) / views, 6) : null,
      source: stats.source ?? 'manual',
    });
    // 兼容原字段：Hub 读的是 distributions.stats
    db.update(DIST, distributionId, {
      stats: { ...(d.stats ?? {}), ...stats, updated_at: at },
      updated_at: at,
    });
    return rec;
  }

  /** 收益回传：追加账期记录，不覆盖历史 */
  recordRevenue({ distributionId, period, grossAmount, currency = 'CNY', settlementStatus = '待结算', note = null }) {
    const d = db.findOne(DIST, (x) => x.id === distributionId);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    const amount = num(grossAmount, NaN);
    if (!Number.isFinite(amount) || amount < 0) fail(ERR.BAD_REQUEST, '收益金额必须是非负数字');
    const rec = db.insert(EARN, {
      id: newId('earn'),
      distribution_id: distributionId,
      project_id: d.project_id,
      platform: d.platform,
      episode: d.episode,
      period: period ?? monthOf(nowIso()),
      currency,
      gross_amount_cny: currency === 'CNY' ? round(amount, 2) : round(amount * config.credit.usdCnyRate, 2),
      settlement_status: settlementStatus,
      invoice_status: '未开票',
      credited_at: null,
      note,
      created_at: nowIso(),
    });
    // 兼容原字段：累计金额
    const total = db.find(EARN, (e) => e.distribution_id === distributionId)
      .reduce((a, e) => a + e.gross_amount_cny, 0);
    db.update(DIST, distributionId, {
      revenue: { currency: 'CNY', amount: round(total, 2), period: rec.period, updated_at: nowIso() },
      updated_at: nowIso(),
    });
    return rec;
  }

  updateSettlement(earningId, { settlementStatus = null, invoiceStatus = null }) {
    const e = db.findOne(EARN, (x) => x.id === earningId);
    if (!e) fail(ERR.NOT_FOUND, '收益记录不存在');
    const patch = { updated_at: nowIso() };
    if (settlementStatus) patch.settlement_status = settlementStatus;
    if (invoiceStatus) patch.invoice_status = invoiceStatus;
    if (settlementStatus === '已结算') patch.credited_at = nowIso();
    return db.update(EARN, earningId, patch);
  }

  /**
   * 收益计算器：按平台政策估算分账，并与本工作台的点数成本对照。
   * 估算，不是应收款；政策以平台最新公告为准。
   */
  calculateRevenue({ platformCode, dramaType = '2d', views = 0, completionRate = 0.5, costPoints = 0, exclusiveMultiplier = 1 }) {
    const p = this.policy(platformCode);
    const coef = p.coef?.[dramaType];
    if (typeof coef !== 'number') {
      fail(ERR.BAD_REQUEST, `平台 ${p.name} 不支持漫剧类型 ${dramaType}`, { supported: Object.keys(p.coef ?? {}) });
    }
    const v = Math.max(0, num(views, 0));
    const cr = clamp(num(completionRate, 0.5), 0, 1);
    const mult = clamp(num(exclusiveMultiplier, 1), 0.5, 3);
    const effectiveViews = v * (EFFECTIVE_VIEW_BASE + EFFECTIVE_VIEW_WEIGHT * cr);
    const base = num(p.base_cny_per_1k_effective_views, 0);
    const gross = (effectiveViews / 1000) * base * coef * mult;
    const cost = Math.max(0, num(costPoints, 0)) * config.credit.cnyPerPoint;
    const net = gross - cost;
    const per1k = (base * coef * mult * (EFFECTIVE_VIEW_BASE + EFFECTIVE_VIEW_WEIGHT * cr));
    const breakevenViews = per1k > 0 ? Math.ceil((cost / per1k) * 1000) : null;
    return {
      platform: { code: p.code, name: p.name, coef_label: p.coef_labels?.[dramaType] ?? dramaType, coef, pricing_model: p.pricing_model },
      inputs: { views: v, completion_rate: cr, drama_type: dramaType, exclusive_multiplier: mult, cost_points: Math.max(0, num(costPoints, 0)) },
      effective_views: Math.round(effectiveViews),
      estimate: {
        gross_cny: round(gross, 2),
        compute_cost_cny: round(cost, 2),
        net_cny: round(net, 2),
        roi: cost > 0 ? round(net / cost, 4) : null,
        breakeven_views: breakevenViews,
      },
      settlement: p.settlement,
      policy_updated_at: p.policy_updated_at,
      policy_source_url: p.policy_source_url,
      estimate_only: true,
      disclaimer: p.disclaimer,
      formula: 'gross = views × (0.4 + 0.6 × 完播率) ÷ 1000 × 基准单价 × 类型系数 × 独家倍率',
    };
  }

  /** 实时数据看板：按平台 / 按集 / 按日聚合 + 趋势 + 派生指标 */
  dashboard({ projectId, from = null, to = null, granularity = 'day' } = {}) {
    if (!projectId) fail(ERR.BAD_REQUEST, '看板需要 projectId');
    const inRange = (iso) => (!from || iso >= from) && (!to || iso <= to);
    const snaps = db.find(SNAP, (s) => s.project_id === projectId && inRange(s.recorded_at));
    const dists = db.find(DIST, (d) => d.project_id === projectId);
    const earns = db.find(EARN, (e) => e.project_id === projectId);

    // 每个分发任务取最新快照作为当前值
    const latest = new Map();
    for (const s of snaps) {
      const prev = latest.get(s.distribution_id);
      if (!prev || s.recorded_at >= prev.recorded_at) latest.set(s.distribution_id, s);
    }
    const current = [...latest.values()];

    const totalViews = current.reduce((a, s) => a + s.views, 0);
    const totalLikes = current.reduce((a, s) => a + s.likes, 0);
    const totalInteractions = current.reduce((a, s) => a + s.likes + s.comments + s.shares, 0);
    const crList = current.map((s) => s.completion_rate).filter((x) => typeof x === 'number');
    const revenueCny = round(earns.reduce((a, e) => a + e.gross_amount_cny, 0), 2);
    const settledCny = round(earns.filter((e) => e.settlement_status === '已结算').reduce((a, e) => a + e.gross_amount_cny, 0), 2);

    return {
      project_id: projectId,
      range: { from, to, granularity },
      generated_at: nowIso(),
      overview: {
        distributions: dists.length,
        online: dists.filter((d) => d.status === '已上线').length,
        total_views: totalViews,
        total_likes: totalLikes,
        engagement_rate: totalViews > 0 ? round(totalInteractions / totalViews, 6) : null,
        avg_completion_rate: crList.length ? round(crList.reduce((a, b) => a + b, 0) / crList.length, 4) : null,
        total_revenue_cny: revenueCny,
        settled_cny: settledCny,
        pending_settlement_cny: round(revenueCny - settledCny, 2),
      },
      by_platform: aggregate(snaps, (s) => s.platform, dists, 'platform'),
      by_episode: aggregate(snaps, (s) => s.episode, dists, 'episode'),
      trend: trendOf(snaps, granularity),
      earnings: earns.map((e) => ({
        id: e.id, period: e.period, platform: e.platform, episode: e.episode,
        amount_cny: e.gross_amount_cny, status: e.settlement_status, invoice: e.invoice_status,
        credited_at: e.credited_at,
      })),
      distributions: dists.map((d) => ({
        id: d.id, platform: d.platform_name, episode: d.episode, status: d.status,
        views: latest.get(d.id)?.views ?? d.stats?.views ?? 0,
      })),
      estimate_only_note: '收益为平台回传/录入值，非估算；估算请调用 /api/analytics/revenue/calculate',
    };
  }

  /** 结算提醒：次月 bill_day 出账，返回待办与提醒文案 */
  settlements({ projectId }) {
    const pending = db.find(EARN, (e) => e.project_id === projectId && e.settlement_status !== '已结算');
    const items = pending.map((e) => {
      const p = seeds.revenuePolicy(e.platform);
      const billDay = p?.settlement?.bill_day ?? 10;
      return {
        earning_id: e.id,
        period: e.period,
        amount_cny: e.gross_amount_cny,
        status: e.settlement_status,
        invoice_status: e.invoice_status,
        expected_bill_date: nextBillDate(e.period, billDay),
        platform: p?.name ?? e.platform,
        withdraw_note: p?.settlement?.withdraw_note ?? null,
        invoice_required: p?.settlement?.invoice_required ?? false,
      };
    });
    return {
      project_id: projectId,
      pending_count: items.length,
      pending_amount_cny: round(items.reduce((a, x) => a + x.amount_cny, 0), 2),
      items,
      reminder: items.length
        ? `有 ${items.length} 笔收益待结算，最近账单日 ${items.map((x) => x.expected_bill_date).sort()[0]}；请在对应平台创作者中心核对账单并发起提现/开票。`
        : '暂无待结算收益。',
      note: '小程序不能代做提现/开票（平台登录态与对公流程限制），仅做提醒与状态跟踪。',
    };
  }
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function monthOf(iso) {
  return String(iso).slice(0, 7);
}

/** 账期 YYYY-MM 的次月 billDay */
function nextBillDate(period, billDay) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return null;
  const d = new Date(Date.UTC(y, m, Math.min(28, billDay || 10)));
  return d.toISOString().slice(0, 10);
}

/** 按 key 聚合：取每个任务最新快照，再按 key 汇总 */
function aggregate(snaps, keyFn, dists, dim) {
  const latest = new Map();
  for (const s of snaps) {
    const prev = latest.get(s.distribution_id);
    if (!prev || s.recorded_at >= prev.recorded_at) latest.set(s.distribution_id, s);
  }
  const m = new Map();
  for (const s of latest.values()) {
    const k = keyFn(s) ?? '未知';
    if (!m.has(k)) m.set(k, { key: k, platforms: new Set(), episodes: new Set(), views: 0, likes: 0, interactions: 0, completion_rates: [] });
    const g = m.get(k);
    g.platforms.add(s.platform);
    g.episodes.add(s.episode);
    g.views += s.views;
    g.likes += s.likes;
    g.interactions += s.likes + s.comments + s.shares;
    if (typeof s.completion_rate === 'number') g.completion_rates.push(s.completion_rate);
  }
  return [...m.values()].map((g) => ({
    key: g.key,
    dimension: dim,
    views: g.views,
    likes: g.likes,
    engagement_rate: g.views > 0 ? round(g.interactions / g.views, 6) : null,
    avg_completion_rate: g.completion_rates.length
      ? round(g.completion_rates.reduce((a, b) => a + b, 0) / g.completion_rates.length, 4) : null,
    platform_count: g.platforms.size,
    episode_count: g.episodes.size,
  })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** 趋势：每天/每周取最后一条累计值，做差分得增量，避免累计值重复计数 */
function trendOf(snaps, granularity) {
  const buckets = new Map();
  for (const s of snaps) {
    const key = granularity === 'week' ? weekKey(s.recorded_at) : String(s.recorded_at).slice(0, 10);
    const cur = buckets.get(key);
    if (!cur || s.recorded_at >= cur.recorded_at) buckets.set(key, s);
  }
  const keys = [...buckets.keys()].sort();
  const out = [];
  let prevViews = 0;
  let prevLikes = 0;
  for (const k of keys) {
    const s = buckets.get(k);
    const dv = Math.max(0, s.views - prevViews);
    const dl = Math.max(0, s.likes - prevLikes);
    out.push({
      bucket: k,
      views_total: s.views,
      views_delta: dv,
      likes_total: s.likes,
      likes_delta: dl,
      completion_rate: s.completion_rate,
      engagement_rate: s.engagement_rate,
    });
    prevViews = s.views;
    prevLikes = s.likes;
  }
  return out;
}

function weekKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export const analytics = new Analytics();
export default analytics;
