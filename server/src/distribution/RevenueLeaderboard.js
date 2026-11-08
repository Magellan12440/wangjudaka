/**
 * 分发收益排行榜（V4.16）。
 *
 * 用户口径（原话）：所有用户可见；统计所有平台、所有时间的收益累加；
 * 不做单平台榜、不做日榜周榜；只取前 1000 名；每日刷新一次；
 * 按总数据决定上榜还是下榜；所有用户默认参与。
 *
 * 实现上要守住的几条：
 *  1. **只读派生数据**：榜单不改任何 earnings / distributions，只读后算总分。
 *     分数算错了可以重建，业务数据不会被榜单污染。
 *  2. **口径单一**：总分 = 该账号在 earnings 里的 gross_amount_cny 全量累加
 *     （换算在记录时就做完了，这里不再乘汇率）。不区分平台、不区分月份。
 *  3. **每日一次**：按 Asia/Shanghai 自然日切片。同一天重复请求返回同一份快照，
 *     不会因为有人刷接口就变成实时榜（实时榜会让排名抖动，也失去"每日刷新"的承诺）。
 *  4. **榜上只留前 1000**：榜外的人查自己的名次仍然查得到（rank 照算），
 *     但列表里不出现，避免"一万人名单"这种既没意义又耗流量的返回。
 *  5. **不泄漏身份**：对外只有昵称（手机号/邮箱脱敏）+ 排名 + 金额，
 *     不返回 user_id、项目名、手机号原文。
 */
import { db } from '../store/db.js';
import { round } from '../core/util.js';

const SNAPSHOT = 'leaderboard_snapshots';
const ENTRY = 'leaderboard_entries';
const USERS = 'users';
const EARN = 'earnings';
const DIST = 'distributions';

/** 榜单容量：只取前 1000 名 */
export const TOP_N = 1000;
/** 快照保留天数：只用于算「较昨日」涨跌，超期清掉派生数据 */
export const KEEP_DAYS = 30;
/** 时区：国内用户，按东八区切自然日 */
const TZ_OFFSET_MIN = 8 * 60;

/** 上榜规则（对外可陈述，接口直接返回这段话） */
export const RULE = {
  scope: 'all_platforms_all_time',
  title: '分发收益排行榜',
  visible_to: 'all_users',
  capacity: TOP_N,
  refresh: 'daily',
  refresh_timezone: 'Asia/Shanghai',
  participates_by_default: true,
  metric: '累计收益（元）',
  description: '所有平台、所有时间的收益累加，不设单平台榜，也不设日榜/周榜；每日刷新一次，按累计总收益决定上榜与否；所有用户默认参与。',
  notes: [
    '同一天内多次打开看到的是同一份榜单，不会实时变动（每日只刷新一次）。',
    '收益以「分发收益回填」录入的金额为准，同一条分发可多次回填，按累加计算。',
    '只展示前 1000 名；榜外用户可在本页看到自己的当前名次与差距。',
    '默认全员参与；不想出现在榜单上可在本页关闭，关闭后立即从榜单移除。',
  ],
};

/** 东八区自然日：YYYY-MM-DD */
export function dateKey(now = new Date()) {
  const t = new Date(now.getTime() + TZ_OFFSET_MIN * 60 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 昵称脱敏：手机号/邮箱做遮挡，普通昵称原样（昵称本身在小程序内就是公开的） */
export function maskName(name, fallback = '匿名创作者') {
  const s = String(name ?? '').trim();
  if (!s) return fallback;
  if (/^1\d{10}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(7)}`;
  const mail = s.match(/^([^@]{1,64})@(.+)$/);
  if (mail) {
    const head = mail[1];
    const keep = head.slice(0, Math.min(2, head.length));
    return `${keep}***@${mail[2]}`;
  }
  return s.slice(0, 24);
}

export class RevenueLeaderboard {
  /** 规则（前端文案 + 后台说明共用一份，不各写一套） */
  rules() {
    return { ...RULE, keep_days: KEEP_DAYS };
  }

  /**
   * 汇总每个账号的累计收益。
   *
   * earnings 只有 distribution_id，账号要从 distributions 继承——
   * 这正是归属链上唯一可信的来源（资产那边 V4.15 也是同一条链）。
   */
  scores() {
    const dists = new Map(db.find(DIST).map((d) => [d.id, d]));
    const users = new Map(db.find(USERS).map((u) => [u.id, u]));

    const byUser = new Map();
    let unattributed = 0;
    let total = 0;

    for (const e of db.find(EARN)) {
      const d = dists.get(e.distribution_id);
      const userId = d?.user_id ?? null;
      const amount = Number(e.gross_amount_cny);
      if (!userId || !Number.isFinite(amount)) { unattributed += 1; continue; }
      const cur = byUser.get(userId) ?? {
        user_id: userId,
        total_cny: 0,
        projectIds: new Set(),
        distributionIds: new Set(),
        episodes: 0,
        platforms: new Set(),
        first_at: null,
        last_at: null,
      };
      cur.total_cny += amount;
      if (d.project_id) cur.projectIds.add(d.project_id);
      cur.distributionIds.add(d.id);
      if (d.platform) cur.platforms.add(d.platform);
      cur.episodes += 1;
      const at = String(e.created_at ?? '');
      if (at) {
        if (!cur.first_at || at < cur.first_at) cur.first_at = at;
        if (!cur.last_at || at > cur.last_at) cur.last_at = at;
      }
      byUser.set(userId, cur);
      total += amount;
    }

    const rows = [];
    for (const s of byUser.values()) {
      const u = users.get(s.user_id);
      // 账号不存在或被封禁的不上榜（不能拿一个注销号占着全民可见的位置）
      if (!u) continue;
      if ((u.status ?? 'active') !== 'active') continue;
      // 默认参与；主动关闭的从榜单移除（已上榜的人关掉后下一次刷新就消失）
      if (u.leaderboard_opt_out === true) continue;
      if (!(s.total_cny > 0)) continue; // 0 收益等于没有数据，不占用前 1000 的名额
      rows.push({
        user_id: s.user_id,
        display_name: maskName(u.nickname),
        avatar: u.avatar ?? null,
        total_cny: round(s.total_cny, 2),
        project_count: s.projectIds.size,
        distribution_count: s.distributionIds.size,
        revenue_records: s.episodes,
        platform_count: s.platforms.size,
        first_revenue_at: s.first_at,
        last_revenue_at: s.last_at,
      });
    }

    // 排序：总分降序 → 最早一笔收益更早的在前（老账号先到）→ 用户 id 兜底，保证结果稳定可复现
    rows.sort((a, b) => (
      b.total_cny - a.total_cny
      || String(a.first_revenue_at ?? '').localeCompare(String(b.first_revenue_at ?? ''))
      || String(a.user_id).localeCompare(String(b.user_id))
    ));
    rows.forEach((r, i) => { r.rank = i + 1; });

    return {
      rows,
      participants: rows.length,
      total_cny: round(total, 2),
      unattributed_records: unattributed,
    };
  }

  /** 最近一份快照（不触发构建） */
  latestSnapshot() {
    const all = db.find(SNAPSHOT).sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)));
    return all[0] ?? null;
  }

  /**
   * 构建某个自然日的快照（幂等）。
   * force=false 时当天已构建过就直接返回，保证「每日刷新一次」不被请求次数左右。
   */
  build({ now = new Date(), force = false, source = 'auto' } = {}) {
    const date = dateKey(now);
    const existing = db.findOne(SNAPSHOT, (s) => s.snapshot_date === date);
    if (existing && !force) return { snapshot: existing, built: false };

    const prev = db.find(SNAPSHOT)
      .filter((s) => String(s.snapshot_date) < date)
      .sort((a, b) => String(b.snapshot_date).localeCompare(String(a.snapshot_date)))[0] ?? null;
    const prevRank = new Map();
    if (prev) {
      for (const e of db.find(ENTRY, (x) => x.snapshot_date === prev.snapshot_date)) {
        prevRank.set(e.user_id, e.rank);
      }
    }

    const { rows, participants, total_cny: totalCny, unattributed_records: unattributed } = this.scores();

    // 换榜前把同一天的旧行清掉（force 重建 / 首次构建），避免同一日期出现两份名次
    for (const old of db.find(ENTRY, (x) => x.snapshot_date === date)) db.remove(ENTRY, old.id);

    const board = rows.slice(0, TOP_N);
    for (const r of board) {
      const before = prevRank.get(r.user_id) ?? null;
      db.insert(ENTRY, {
        id: `lbe_${date}_${r.rank}`,
        snapshot_date: date,
        rank: r.rank,
        user_id: r.user_id,
        display_name: r.display_name,
        avatar: r.avatar,
        total_cny: r.total_cny,
        project_count: r.project_count,
        distribution_count: r.distribution_count,
        revenue_records: r.revenue_records,
        platform_count: r.platform_count,
        prev_rank: before,
        // 升 / 降 / 新上榜：榜外掉下来的人看不到自己的 prev_rank，这是刻意的
        trend: before == null ? 'new' : before > r.rank ? 'up' : before < r.rank ? 'down' : 'flat',
        first_revenue_at: r.first_revenue_at,
        last_revenue_at: r.last_revenue_at,
      });
    }

    const snap = {
      id: `lbs_${date}`,
      snapshot_date: date,
      built_at: new Date().toISOString(),
      source,
      entry_count: board.length,
      participants,
      off_board: Math.max(0, participants - board.length),
      total_revenue_cny: totalCny,
      top1_cny: board[0]?.total_cny ?? 0,
      unattributed_records: unattributed,
      rules_version: 1,
    };
    const saved = existing
      ? db.update(SNAPSHOT, existing.id, { ...snap, id: existing.id })
      : db.insert(SNAPSHOT, snap);

    this.prune(date);
    return { snapshot: saved, built: true };
  }

  /** 只留最近 KEEP_DAYS 天的派生数据（榜单快照不是资产，可滚动清理） */
  prune(today) {
    const dates = [...new Set(db.find(SNAPSHOT).map((s) => s.snapshot_date))].sort();
    const keep = new Set(dates.slice(-KEEP_DAYS));
    keep.add(today);
    for (const s of db.find(SNAPSHOT)) if (!keep.has(s.snapshot_date)) db.remove(SNAPSHOT, s.id);
    for (const e of db.find(ENTRY)) if (!keep.has(e.snapshot_date)) db.remove(ENTRY, e.id);
  }

  /** 惰性刷新：跨天后的第一次访问触发构建（服务不会因为没人访问就漏掉一天） */
  ensureFresh({ now = new Date() } = {}) {
    const date = dateKey(now);
    const snap = this.latestSnapshot();
    if (snap && snap.snapshot_date === date) return snap;
    return this.build({ now }).snapshot;
  }

  /**
   * 榜单视图。公开可读：任何用户（含未登录）看到的是同一份。
   * me 只在带登录态时计算，用于「我的名次 / 差多少能上榜」。
   */
  view({ userId = null, now = new Date(), limit = TOP_N } = {}) {
    const snap = this.ensureFresh({ now });
    const all = db.find(ENTRY, (e) => e.snapshot_date === snap.snapshot_date)
      .sort((a, b) => a.rank - b.rank);
    const size = Math.max(1, Math.min(Number(limit) || TOP_N, TOP_N));
    const list = all.slice(0, size).map((e) => ({
      rank: e.rank,
      name: e.display_name,
      avatar: e.avatar,
      total_cny: e.total_cny,
      project_count: e.project_count,
      platform_count: e.platform_count,
      trend: e.trend,
      prev_rank: e.prev_rank,
    }));

    let me = null;
    if (userId) {
      const u = db.findOne(USERS, (x) => x.id === userId);
      const onBoard = all.find((e) => e.user_id === userId) ?? null;
      if (onBoard) {
        me = {
          rank: onBoard.rank,
          on_board: true,
          name: onBoard.display_name,
          total_cny: onBoard.total_cny,
          trend: onBoard.trend,
          prev_rank: onBoard.prev_rank,
          gap_to_top: 0,
        };
      } else {
        // 榜外也要能看到自己：现算一次名次，不写进快照（快照只放前 1000）
        const { rows } = this.scores();
        const idx = rows.findIndex((r) => r.user_id === userId);
        const row = idx >= 0 ? rows[idx] : null;
        const last = all[all.length - 1] ?? null;
        me = {
          rank: row ? row.rank : null,
          on_board: false,
          name: row ? row.display_name : maskName(u?.nickname),
          total_cny: row ? row.total_cny : 0,
          trend: row ? 'out' : 'none',
          prev_rank: null,
          // 差多少能进前 1000：只需要追平最后一名，不需要超过
          gap_to_top: row && last ? round(Math.max(0, last.total_cny - row.total_cny), 2) : null,
          opt_out: u?.leaderboard_opt_out === true,
        };
      }
    }

    return {
      rules: this.rules(),
      snapshot: {
        date: snap.snapshot_date,
        built_at: snap.built_at,
        entry_count: snap.entry_count,
        participants: snap.participants,
        off_board: snap.off_board,
        total_revenue_cny: snap.total_revenue_cny,
        top1_cny: snap.top1_cny,
      },
      list,
      me,
    };
  }

  /** 参与开关：默认参与，关掉后立刻从当天榜单移除（不必等次日刷新） */
  setParticipation(userId, optOut, { now = new Date() } = {}) {
    const u = db.findOne(USERS, (x) => x.id === userId);
    if (!u) return { ok: false, reason: 'user_not_found' };
    db.update(USERS, userId, {
      leaderboard_opt_out: optOut === true,
      leaderboard_opt_out_at: optOut === true ? new Date().toISOString() : null,
    });
    // 立即重建当天快照：用户点了「不参与」，下一秒还能在榜上看到自己就是欺骗
    const { snapshot } = this.build({ now, force: true, source: 'participation' });
    const onBoard = db.findOne(ENTRY, (e) => e.snapshot_date === snapshot.snapshot_date && e.user_id === userId);
    return {
      participating: optOut !== true,
      on_board: Boolean(onBoard),
      rank: onBoard?.rank ?? null,
      snapshot_date: snapshot.snapshot_date,
    };
  }

  /** 后台：手动重算（口径改了/数据修正后用），并返回与上一份快照的差异 */
  rebuild({ now = new Date(), source = 'admin' } = {}) {
    const before = this.latestSnapshot();
    const { snapshot } = this.build({ now, force: true, source });
    const prevDate = before && before.snapshot_date !== snapshot.snapshot_date ? before.snapshot_date : null;
    const prevIds = new Set(prevDate
      ? db.find(ENTRY, (e) => e.snapshot_date === prevDate).map((e) => e.user_id) : []);
    const curr = db.find(ENTRY, (e) => e.snapshot_date === snapshot.snapshot_date);
    return {
      snapshot,
      detail: {
        entries: curr.length,
        participants: snapshot.participants,
        off_board: snapshot.off_board,
        total_revenue_cny: snapshot.total_revenue_cny,
        unattributed_records: snapshot.unattributed_records,
        joined: prevDate ? curr.filter((e) => !prevIds.has(e.user_id)).length : null,
        left: prevDate ? [...prevIds].filter((id) => !curr.some((e) => e.user_id === id)).length : null,
      },
    };
  }
}

export const revenueLeaderboard = new RevenueLeaderboard();
export default revenueLeaderboard;
