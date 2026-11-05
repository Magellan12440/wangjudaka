/** V3.3 数据看板 / 收益计算器 / 结算提醒 */
import test from 'node:test';
import assert from 'node:assert/strict';
import analytics from '../src/analytics/Analytics.js';
import distributionHub from '../src/distribution/DistributionHub.js';
import { db } from '../src/store/db.js';
import { ERR } from '../src/core/errors.js';

const P = 'analytics_proj';
const U = 'analytics_user';

function newDist(episode = 'E01', platform = 'PLT-HONGGUO') {
  return distributionHub.create({ projectId: P, episodeNo: episode, platformCode: platform, userId: U });
}

test('收益政策库：8 平台齐全且带时效与免责声明', () => {
  const ps = analytics.policies();
  assert.equal(ps.length, 8);
  for (const p of ps) {
    assert.ok(p.policy_updated_at, `${p.code} 缺政策日期`);
    assert.match(p.policy_source_url, /^https?:\/\//);
    assert.match(p.disclaimer, /以平台最新公告为准/);
    assert.equal(p.estimate_only, true);
    assert.equal(p.in_app_embeddable, false, '平台登录不能内嵌');
    for (const t of ['live_action', '3d', '2d', 'narration']) {
      assert.ok(p.coef[t] > 0, `${p.code} 缺 ${t} 系数`);
    }
  }
});

test('未知平台 / 不支持的漫剧类型被拒绝', () => {
  assert.throws(() => analytics.policy('PLT-NOT-EXIST'), (e) => e.code === ERR.BAD_REQUEST);
  assert.throws(() => analytics.calculateRevenue({ platformCode: 'PLT-HONGGUO', dramaType: 'unknown', views: 100 }),
    (e) => e.code === ERR.BAD_REQUEST);
});

test('数据回传：追加时序快照，不覆盖历史，可出增量趋势', () => {
  const d = newDist('E03', 'PLT-DOUYIN');
  const p = 'trend_proj';
  const d2 = distributionHub.create({ projectId: p, episodeNo: 'E01', platformCode: 'PLT-DOUYIN', userId: U });
  analytics.recordStatsSnapshot({ distributionId: d2.id, stats: { views: 100, likes: 10, comments: 2, shares: 1, completion_rate: 0.4 }, recordedAt: '2026-11-01T10:00:00.000Z' });
  analytics.recordStatsSnapshot({ distributionId: d2.id, stats: { views: 180, likes: 20, comments: 3, shares: 2, completion_rate: 0.45 }, recordedAt: '2026-11-01T20:00:00.000Z' });
  analytics.recordStatsSnapshot({ distributionId: d2.id, stats: { views: 300, likes: 30, comments: 5, shares: 3, completion_rate: 0.5 }, recordedAt: '2026-11-02T10:00:00.000Z' });

  const snaps = db.find('stat_snapshots', (s) => s.distribution_id === d2.id);
  assert.equal(snaps.length, 3, '快照必须追加而非覆盖');
  const dash = analytics.dashboard({ projectId: p });
  assert.equal(dash.overview.total_views, 300);
  assert.equal(dash.trend.length, 2);
  assert.equal(dash.trend[0].views_total, 180);
  assert.equal(dash.trend[0].views_delta, 180);
  assert.equal(dash.trend[1].views_delta, 120, '按日差分，累计值不重复计数');
  assert.equal(dash.by_platform.length, 1);
  assert.equal(dash.by_episode.length, 1);
  assert.ok(dash.overview.avg_completion_rate >= 0.5);
});

test('收益回传：追加账期记录，累计金额一致，结算状态可推进', () => {
  const d = newDist('E04');
  analytics.recordRevenue({ distributionId: d.id, period: '2026-10', grossAmount: 100 });
  analytics.recordRevenue({ distributionId: d.id, period: '2026-11', grossAmount: 50 });
  const earns = db.find('earnings', (e) => e.distribution_id === d.id);
  assert.equal(earns.length, 2);
  const cur = db.findOne('distributions', (x) => x.id === d.id);
  assert.equal(cur.revenue.amount, 150, '旧字段保持累计语义');

  const s = distributionHub.summary(P);
  assert.ok(s.total_revenue_cny >= 150);
  assert.ok(s.snapshot_count >= 0);

  analytics.updateSettlement(earns[0].id, { settlementStatus: '已结算', invoiceStatus: '已开票' });
  const settled = db.findOne('earnings', (e) => e.id === earns[0].id);
  assert.equal(settled.settlement_status, '已结算');
  assert.ok(settled.credited_at);
  const pending = analytics.settlements({ projectId: P });
  assert.ok(pending.pending_amount_cny >= 50);
  assert.match(pending.reminder, /待结算|账单日/);
});

test('DistributionHub 旧接口保持兼容（收益/数据回传返回分发记录）', () => {
  const d = newDist('E05');
  const r = distributionHub.recordRevenue(d.id, { amount: 1234.5 });
  assert.equal(r.revenue.amount, 1234.5);
  const s = distributionHub.recordStats(d.id, { views: 999, likes: 88 });
  assert.equal(s.stats.views, 999);
  assert.equal(typeof distributionHub.summary(P).total_revenue_cny, 'number');
});

test('收益计算器：系数×有效播放×单价，给出 ROI 与回本播放量', () => {
  const r = analytics.calculateRevenue({
    platformCode: 'PLT-HONGGUO', dramaType: '2d', views: 1_000_000,
    completionRate: 0.5, costPoints: 100,
  });
  assert.equal(r.platform.coef, 40);
  assert.equal(r.effective_views, 700_000);
  assert.equal(r.estimate.gross_cny, 4200);
  assert.equal(r.estimate.compute_cost_cny, 100);
  assert.equal(r.estimate.net_cny, 4100);
  assert.ok(r.estimate.roi > 0);
  assert.ok(r.estimate.breakeven_views > 0 && r.estimate.breakeven_views < 1_000_000);
  assert.equal(r.estimate_only, true);
  assert.match(r.disclaimer, /以平台最新公告为准/);
  assert.match(r.formula, /完播率/);
});

test('独家倍率与漫剧类型显著影响估算', () => {
  const base = { platformCode: 'PLT-HONGGUO', views: 100_000, completionRate: 0.5, costPoints: 0 };
  const a = analytics.calculateRevenue({ ...base, dramaType: '2d' });
  const b = analytics.calculateRevenue({ ...base, dramaType: 'live_action' });
  const c = analytics.calculateRevenue({ ...base, dramaType: '2d', exclusiveMultiplier: 2 });
  assert.ok(b.estimate.gross_cny > a.estimate.gross_cny);
  assert.equal(c.estimate.gross_cny, a.estimate.gross_cny * 2);
});

test('结算提醒给出次月账单日与提现说明', () => {
  const d = newDist('E06', 'PLT-TENCENT');
  analytics.recordRevenue({ distributionId: d.id, period: '2026-11', grossAmount: 300 });
  const r = analytics.settlements({ projectId: P });
  assert.ok(r.items.length > 0);
  const item = r.items.find((x) => x.earning_id);
  assert.ok(item.expected_bill_date, '应给出预计账单日');
  assert.match(item.expected_bill_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.note, /不能代做/);
});

test('recordStats 透传 recordedAt：多条回传不挤到同一时刻，且不污染业务指标', () => {
  const d = newDist('E07');
  distributionHub.recordStats(d.id, { views: 100, likes: 5, recordedAt: '2026-10-01T10:00:00.000Z' });
  distributionHub.recordStats(d.id, { views: 200, likes: 9, recordedAt: '2026-10-02T10:00:00.000Z' });
  const snaps = db.find('stat_snapshots', (s) => s.distribution_id === d.id);
  assert.equal(snaps.length, 2);
  assert.notEqual(snaps[0].recorded_at, snaps[1].recorded_at);
  const cur = db.findOne('distributions', (x) => x.id === d.id);
  assert.equal(cur.stats.views, 200);
  assert.ok(!('recordedAt' in (cur.stats ?? {})), 'recordedAt 不得写进业务指标字段');
});

test('看板缺少 projectId 被拒绝', () => {
  assert.throws(() => analytics.dashboard({}), (e) => e.code === ERR.BAD_REQUEST);
});
