/**
 * 收益看板 + 批量回填（V4.5）。
 *
 * 守四件事：
 *  1) 金额/结算状态以 earnings 账为准，不看 distributions 的兼容快照（否则「已结算」永远是 0）
 *  2) 按平台要认得 platform 字段（V3 主键），否则全部落到 unknown
 *  3) 批量回填整批校验归属，出现别人的记录就一条都不写
 *  4) 填过 0 也算填过，不能反复出现在待回填里
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import { distributionHub } from '../src/distribution/DistributionHub.js';
import { ledger } from '../src/ledger/Ledger.js';
import { config } from '../src/config/env.js';
import { revenueDashboard, batchFillRevenue } from '../src/api/routes.js';

let seq = 0;
const mkUser = () => {
  seq += 1;
  return db.insert('users', {
    id: `usr_rev_${seq}`,
    nickname: `收益测试${seq}`,
    created_at: new Date().toISOString(),
  });
};

function mkProject(userId, title) {
  seq += 1;
  return db.insert('projects', {
    id: `prj_rev_${seq}`,
    user_id: userId,
    title,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function mkDist(userId, projectId, platformCode, status = '已上线') {
  const d = distributionHub.create({ projectId, episodeNo: 1, platformCode, userId });
  if (status !== d.status) distributionHub.updateStatus(d.id, status);
  return db.findOne('distributions', (x) => x.id === d.id);
}

test('收益看板：空数据时给 0 与引导文案，不编造', () => {
  const u = mkUser().id;
  const r = revenueDashboard(u);
  assert.equal(r.total, 0);
  assert.equal(r.unfilled.length, 0);
  assert.ok(r.note.includes('还没有回填'));
});

test('收益看板：按平台归组认 platform 字段，不落到 unknown', () => {
  const u = mkUser().id;
  const p = mkProject(u, '平台归组剧');
  const d = mkDist(u, p.id, 'PLT-HONGGUO');
  distributionHub.recordRevenue(d.id, { amount: 1200, period: '2026-10', settlementStatus: '已结算' });

  const r = revenueDashboard(u);
  const codes = r.platforms.map((x) => x.platform_code);
  assert.ok(!codes.includes('unknown'), '不应出现 unknown 平台');
  assert.equal(r.platforms[0].platform_code, 'PLT-HONGGUO');
  assert.equal(r.platforms[0].amount, 1200);
});

test('收益看板：结算状态取自 earnings，已结算不再恒为 0', () => {
  const u = mkUser().id;
  const p = mkProject(u, '结算口径剧');
  const d1 = mkDist(u, p.id, 'PLT-HONGGUO');
  const d2 = mkDist(u, p.id, 'PLT-DOUYIN');
  distributionHub.recordRevenue(d1.id, { amount: 500, period: '2026-10', settlementStatus: '已结算' });
  distributionHub.recordRevenue(d2.id, { amount: 300, period: '2026-10', settlementStatus: '待结算' });

  const r = revenueDashboard(u);
  assert.equal(r.total, 800);
  assert.equal(r.settled, 500);
  assert.equal(r.pending, 300);
});

test('收益看板：跨月份能拆开，只取最近 6 个月', () => {
  const u = mkUser().id;
  const p = mkProject(u, '跨月剧');
  const d = mkDist(u, p.id, 'PLT-HONGGUO');
  distributionHub.recordRevenue(d.id, { amount: 100, period: '2026-09', settlementStatus: '待结算' });
  distributionHub.recordRevenue(d.id, { amount: 200, period: '2026-10', settlementStatus: '待结算' });

  const r = revenueDashboard(u);
  assert.deepEqual(r.monthly.map((m) => m.month), ['2026-09', '2026-10']);
  assert.deepEqual(r.monthly.map((m) => m.amount), [100, 200]);
  assert.equal(r.total, 300);
});

test('待回填清单：只列已上线且还没回填过的', () => {
  const u = mkUser().id;
  const p = mkProject(u, '待回填剧');
  const ready = mkDist(u, p.id, 'PLT-HONGGUO', '已上线');
  mkDist(u, p.id, 'PLT-DOUYIN', '审核中'); // 没上线，不该出现
  distributionHub.recordRevenue(ready.id, { amount: 88, period: '2026-10' });

  const r = revenueDashboard(u);
  const ids = r.unfilled.map((x) => x.distribution_id);
  assert.ok(!ids.includes(ready.id), '已回填的不应再提示');
});

test('批量回填：写入成功并可查到账期与状态', () => {
  const u = mkUser().id;
  const p = mkProject(u, '批量回填剧');
  const a = mkDist(u, p.id, 'PLT-HONGGUO');
  const b = mkDist(u, p.id, 'PLT-DOUYIN');

  const r = batchFillRevenue(u, {
    period: '2026-10',
    items: [
      { distribution_id: a.id, amount: 1000, settlement_status: '已结算' },
      { distribution_id: b.id, amount: 250.5, settlement_status: '待结算' },
    ],
  });
  assert.equal(r.written, 2);
  assert.equal(r.period, '2026-10');

  const board = revenueDashboard(u);
  assert.equal(board.total, 1250.5);
  assert.equal(board.settled, 1000);
  assert.equal(board.pending, 250.5);
});

test('批量回填：含他人记录时整批拒绝，一条都不写', () => {
  const owner = mkUser().id;
  const other = mkUser().id;
  const p1 = mkProject(owner, '我的剧');
  const p2 = mkProject(other, '别人的剧');
  const mine = mkDist(owner, p1.id, 'PLT-HONGGUO');
  const theirs = mkDist(other, p2.id, 'PLT-HONGGUO');

  assert.throws(
    () => batchFillRevenue(owner, { items: [
      { distribution_id: mine.id, amount: 10 },
      { distribution_id: theirs.id, amount: 20 },
    ] }),
    /不属于你/,
  );

  const board = revenueDashboard(owner);
  assert.equal(board.total, 0, '整批拒绝后不应有任何写入');
});

test('批量回填：负数金额、非法结算状态、空列表都被拒', () => {
  const u = mkUser().id;
  const p = mkProject(u, '校验剧');
  const d = mkDist(u, p.id, 'PLT-HONGGUO');

  assert.throws(() => batchFillRevenue(u, { items: [] }), /没有要回填/);
  assert.throws(() => batchFillRevenue(u, { items: [{ distribution_id: d.id, amount: -1 }] }), /不小于 0/);
  assert.throws(
    () => batchFillRevenue(u, { items: [{ distribution_id: d.id, amount: 1, settlement_status: '已到账' }] }),
    /结算状态/,
  );
  assert.throws(() => batchFillRevenue(u, { items: [{ distribution_id: 'dist_nope', amount: 1 }] }), /不属于你/);
});

test('批量回填：填 0 也算填过，不再出现在待回填里', () => {
  const u = mkUser().id;
  const p = mkProject(u, '零收益剧');
  const d = mkDist(u, p.id, 'PLT-HONGGUO');

  batchFillRevenue(u, { period: '2026-10', items: [{ distribution_id: d.id, amount: 0, settlement_status: '待结算' }] });
  const board = revenueDashboard(u);
  assert.equal(board.total, 0);
  assert.ok(!board.unfilled.some((x) => x.distribution_id === d.id));
});

test('额度预警：余额低于阈值给 low，用完给 empty，充足时不给提示', () => {
  const u = mkUser().id;
  ledger.ensureAccount(u);
  const acc = db.findOne('accounts', (a) => a.user_id === u);

  db.update('accounts', acc.id, { balance_points: 10000 });
  let q = revenueDashboard(u).quota;
  assert.equal(q.level, 'ok');
  assert.equal(q.note, null);

  db.update('accounts', acc.id, { balance_points: Math.max(1, config.credit.lowBalancePoints - 1) });
  q = revenueDashboard(u).quota;
  assert.equal(q.level, 'low');
  assert.ok(q.note.includes(String(config.credit.lowBalancePoints)));

  db.update('accounts', acc.id, { balance_points: 0 });
  q = revenueDashboard(u).quota;
  assert.equal(q.level, 'empty');
  assert.ok(q.note.includes('用完'));
});
