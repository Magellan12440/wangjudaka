/**
 * V4.16 分发收益排行榜。
 *
 * 用户原话：「做一个分发收益回填的收益排行榜，本排行榜所有用户可见。
 * 统计数据为所有平台，所有时间收益累加，不单独做单平台排行榜，也不做日榜周榜。
 * 排行榜只取前一千名，每日刷新一次，按总数据决定上榜还是下榜。所有用户默认参与此排行榜。」
 *
 * 逐条锁死：
 *  1. 口径：全平台 + 全时间累加，不存在"只看某平台"或"只看本月"的分支；
 *  2. 容量：榜单最多 1000 行，第 1001 名不出现，但自己仍查得到名次；
 *  3. 频率：同一天重复构建不重算、不换时间戳；
 *  4. 上下榜：按总收益排序，昨天在榜今天掉出去的人会消失；
 *  5. 参与：默认全员参与，关掉后立刻消失（不等次日）；
 *  6. 不泄漏：对外没有 user_id，手机号类昵称脱敏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import { revenueLeaderboard, TOP_N, maskName, dateKey } from '../src/distribution/RevenueLeaderboard.js';

let seq = 0;
const uid = (p) => `${p}_${(seq += 1)}_${Date.now().toString(36)}`;

function mkUser(nickname = null, extra = {}) {
  const id = uid('u_lb');
  db.insert('users', {
    id,
    nickname: nickname ?? `创作者_${id.slice(-6)}`,
    avatar: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...extra,
  });
  return id;
}

/** 造一条分发 + 一笔收益（走真实链路，保证 user_id 从分发继承） */
function mkEarning(userId, amount, { platform = 'PLT-HONGGUO', projectId = null, at = null } = {}) {
  const pid = projectId ?? uid('proj_lb');
  if (!projectId) {
    db.insert('projects', {
      id: pid, user_id: userId, title: '榜单样本',
      spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p' },
      created_at: new Date().toISOString(),
    });
  }
  const did = uid('dist_lb');
  db.insert('distributions', {
    id: did,
    user_id: userId,
    project_id: pid,
    episode: 1,
    platform,
    platform_name: platform,
    status: '已上线',
    revenue: { currency: 'CNY', amount: 0, updated_at: null },
    stats: { views: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const eid = uid('earn_lb');
  db.insert('earnings', {
    id: eid,
    distribution_id: did,
    project_id: pid,
    platform,
    episode: 1,
    period: '2026-11',
    currency: 'CNY',
    gross_amount_cny: amount,
    settlement_status: '待结算',
    created_at: at ?? new Date().toISOString(),
  });
  return { distributionId: did, earningId: eid, projectId: pid };
}

/**
 * 每个用例从零开始。
 * 排行榜的断言全是「绝对名次」，一旦上个用例的用户还留在库里，名次就会整体偏移 ——
 * 这种污染查起来最费时间，所以这里直接清空相关集合（本文件独占一个临时数据目录）。
 */
function resetBoard() {
  for (const col of ['leaderboard_entries', 'leaderboard_snapshots', 'earnings', 'distributions', 'projects', 'users']) {
    db._reset(col);
  }
}

test('口径：所有平台、所有时间的收益累加（不分平台、不分月）', () => {
  resetBoard();
  const u = mkUser('阿甲');
  mkEarning(u, 100, { platform: 'PLT-HONGGUO', at: '2026-01-05T00:00:00.000Z' });
  mkEarning(u, 250.5, { platform: 'PLT-FANQIE', at: '2026-06-05T00:00:00.000Z' });
  mkEarning(u, 49.5, { platform: 'PLT-DOUYIN', at: '2026-10-05T00:00:00.000Z' });

  const { rows } = revenueLeaderboard.scores();
  const mine = rows.find((r) => r.user_id === u);
  assert.equal(mine.total_cny, 400, '三平台、跨三个季度必须全额累加');
  assert.equal(mine.platform_count, 3, '平台数只作为展示信息，不参与分榜');

  const { snapshot } = revenueLeaderboard.build({ force: true });
  const entries = db.find('leaderboard_entries', (e) => e.snapshot_date === snapshot.snapshot_date);
  const row = entries.find((e) => e.user_id === u);
  assert.equal(row.total_cny, 400);
  assert.equal(row.platform_count, 3);
  // 没有 platform 维度的榜单：顶层没有分平台结构
  const view = revenueLeaderboard.view();
  assert.equal(view.list.some((x) => 'by_platform' in x), false);
});

test('名次：按总分降序，分高的在前，零收益不上榜', () => {
  resetBoard();
  const low = mkUser('低分');
  const high = mkUser('高分');
  const zero = mkUser('零收益');
  mkEarning(low, 10);
  mkEarning(high, 9999);

  const { rows } = revenueLeaderboard.scores();
  assert.equal(rows[0].user_id, high);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows.some((r) => r.user_id === zero), false, '0 收益等于没有数据，不占名额');
});

test('容量：只留前 1000 名，第 1001 名不上榜但自己查得到', () => {
  resetBoard();
  const total = TOP_N + 3;
  const ids = [];
  for (let i = 0; i < total; i += 1) {
    const u = mkUser(`用户${i}`);
    ids.push(u);
    mkEarning(u, i + 1); // 分数严格递增，名次可预测
  }

  const { snapshot } = revenueLeaderboard.build({ force: true });
  assert.equal(snapshot.entry_count, TOP_N, '榜上只能有 1000 条');
  assert.equal(snapshot.participants, total);
  assert.equal(snapshot.off_board, 3);
  assert.equal(
    db.count('leaderboard_entries', (e) => e.snapshot_date === snapshot.snapshot_date),
    TOP_N,
    '落库也只允许 1000 条，不能悄悄存全量',
  );

  const view = revenueLeaderboard.view({ limit: 5000 });
  assert.equal(view.list.length, TOP_N, 'limit 超过容量也不能突破 1000');

  // 收益从小到大给，所以 ids[0] 是最低分（第 1003 名），ids[2] 正好是第 1001 名
  const offBoard = ids.slice(0, 3);
  const justMissed = revenueLeaderboard.view({ userId: offBoard[2] }).me;
  assert.equal(justMissed.on_board, false);
  assert.equal(justMissed.rank, TOP_N + 1);
  assert.ok(justMissed.gap_to_top > 0, '榜外必须显示差多少能上榜');

  const worst = revenueLeaderboard.view({ userId: offBoard[0] }).me;
  assert.equal(worst.rank, total, '榜外名次照算，不因为没上榜就返回 null');

  const onBoard = revenueLeaderboard.view({ userId: ids[ids.length - 1] }).me;
  assert.equal(onBoard.rank, 1);
  assert.equal(onBoard.on_board, true);
});

test('每日一次：同一天重复构建不重算，跨天才换快照', () => {
  resetBoard();
  const u = mkUser('每日');
  mkEarning(u, 88);

  const day1 = new Date('2026-11-08T02:00:00.000Z'); // 东八区 10:00
  const first = revenueLeaderboard.build({ now: day1 });
  assert.equal(first.built, true);
  const stamp = first.snapshot.built_at;

  // 同一天再来一笔收益，也不应该在当天立刻改榜（否则就不是"每日刷新"了）
  mkEarning(u, 12);
  const again = revenueLeaderboard.build({ now: day1 });
  assert.equal(again.built, false, '当天已构建过就复用快照');
  assert.equal(again.snapshot.built_at, stamp);
  assert.equal(again.snapshot.snapshot_date, '2026-11-08');

  // 跨天（东八区 次日 00:30）才重建，且此时新数据才生效
  const day2 = new Date('2026-11-08T16:30:00.000Z');
  assert.equal(dateKey(day2), '2026-11-09');
  const next = revenueLeaderboard.build({ now: day2 });
  assert.equal(next.built, true);
  const row = db.find('leaderboard_entries', (e) => e.snapshot_date === '2026-11-09').find((e) => e.user_id === u);
  assert.equal(row.total_cny, 100, '次日刷新后才把新增收益算进去');
});

test('上下榜：总分决定去留，昨天在榜今天被超过就下榜', () => {
  resetBoard();
  const a = mkUser('甲');
  const b = mkUser('乙');
  mkEarning(a, 500);
  mkEarning(b, 100);

  const d1 = new Date('2026-11-08T03:00:00.000Z');
  revenueLeaderboard.build({ now: d1 });
  let view = revenueLeaderboard.view({ now: d1, userId: b });
  assert.equal(view.me.rank, 2);

  // 次日乙反超
  mkEarning(b, 900);
  const d2 = new Date('2026-11-08T17:00:00.000Z');
  revenueLeaderboard.build({ now: d2 });
  view = revenueLeaderboard.view({ now: d2, userId: b });
  assert.equal(view.me.rank, 1);
  assert.equal(view.me.trend, 'up', '名次上升要标出来');

  const aMe = revenueLeaderboard.view({ now: d2, userId: a }).me;
  assert.equal(aMe.trend, 'down');
  assert.equal(aMe.prev_rank, 1);
});

test('参与：默认全员参与，关掉后立刻从当天榜上消失，再打开能回来', () => {
  resetBoard();
  const u = mkUser('可退出');
  mkEarning(u, 300);
  const now = new Date('2026-11-08T04:00:00.000Z');
  revenueLeaderboard.build({ now });

  assert.equal(revenueLeaderboard.view({ now, userId: u }).me.on_board, true, '默认参与');

  const off = revenueLeaderboard.setParticipation(u, true, { now });
  assert.equal(off.participating, false);
  assert.equal(off.on_board, false);
  const view = revenueLeaderboard.view({ now, userId: u });
  assert.equal(view.list.some((x) => x.name === '可退出'), false, '关掉后不能还挂榜上');
  assert.equal(view.me.opt_out, true);

  const on = revenueLeaderboard.setParticipation(u, false, { now });
  assert.equal(on.participating, true);
  assert.equal(on.on_board, true);
});

test('隐私：对外不返回 user_id，手机号昵称脱敏', () => {
  resetBoard();
  const u = mkUser('13800138000');
  mkEarning(u, 66);

  const view = revenueLeaderboard.view({ userId: u });
  const item = view.list.find((x) => x.total_cny === 66);
  assert.ok(item);
  assert.equal('user_id' in item, false, '榜单对外不能带 user_id');
  assert.equal(item.name, '138****8000');
  assert.equal(maskName('ab@mail.com'), 'ab***@mail.com');
  assert.equal(maskName(''), '匿名创作者');
});

test('规则可对外陈述：全用户可见 / 1000 名 / 每日刷新 / 默认参与', () => {
  const r = revenueLeaderboard.rules();
  assert.equal(r.visible_to, 'all_users');
  assert.equal(r.capacity, 1000);
  assert.equal(r.refresh, 'daily');
  assert.equal(r.scope, 'all_platforms_all_time');
  assert.equal(r.participates_by_default, true);
  assert.ok(r.notes.length >= 4);
});
