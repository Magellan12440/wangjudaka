/**
 * 容量测算（V4.9.1）。
 *
 * 背景：平台只有一个上游算力池密钥（RELAY_API_KEY），所有用户共享。
 * 「能同时服务多少人」不是拍脑袋，而是三条硬约束里最小的那条：
 *
 *   1. 并发闸门 RELAY_MAX_CONCURRENCY：一条生成调用占用一个槽位，
 *      从提交到拿到成片都占着（视频是提交 + 轮询，期间不释放）。
 *   2. 每分钟请求数 RELAY_RPM_LIMIT：同样按「一次生成 = 一次 acquire」计。
 *   3. 池余额：每次生成真实消耗 = 视频秒数 × 单价 + 关键帧张数 × 单价。
 *
 * 所以本模块输出三样东西：单条成本、并发上限、余额还能撑多久，
 * 并把「现在卡在哪一条」直接说出来，避免用「加机器」去解「没钱」的问题。
 */
import { config } from '../config/env.js';
import seeds from '../seeds/loader.js';
import relayPool from './RelayPool.js';

/** 单价（算力），全部从模型注册表读，不在这里写死 */
function unitPrices() {
  const pick = (code) => seeds.model(code)?.price ?? {};
  const vid = pick('VID-DEFAULT');
  const vidCheap = pick('VID-CHEAP');
  const img = pick('IMG-DEFAULT');
  const llm = pick('LLM-PLOT');
  return {
    videoSuanliPerSec: Number(vid.suanli ?? 0),
    videoCheapSuanliPerSec: Number(vidCheap.suanli ?? 0),
    imageSuanli: Number(img.suanli ?? 0),
    llmInSuanliPer1k: Number(llm.suanli_in ?? 0),
    llmOutSuanliPer1k: Number(llm.suanli_out ?? 0),
  };
}

/** 一部剧的镜头构成：与 Blueprint.quote 同一套规则（每集 90 秒 / 单镜 5 秒 / 每镜 1 张关键帧） */
function dramaShape({ episodes = 3, episodeSec = 90, shotSec = 5 } = {}) {
  const shotsPerEp = Math.ceil(episodeSec / shotSec);
  return {
    episodes,
    episode_sec: episodeSec,
    shot_sec: shotSec,
    shots_per_episode: shotsPerEp,
    shots: episodes * shotsPerEp,
    video_seconds: episodes * episodeSec,
  };
}

class Capacity {
  /**
   * @param {object} p
   *   episodes / episodeSec：按你关心的一部剧规格算（默认 3 集 × 90 秒）
   *   activeUsersWanted：想看「如果要支撑 N 个用户同时出片」时的缺口
   */
  async snapshot({ episodes = 3, episodeSec = 90, activeUsersWanted = 0 } = {}) {
    // 拿最新余额（有 TTL 缓存；mock 模式直接返回 null）
    await relayPool.refreshBalance().catch(() => null);
    const pool = relayPool.health();
    const price = unitPrices();
    const shape = dramaShape({ episodes, episodeSec });

    // —— 单条成本 ——
    const perShotCost = shape.shot_sec * price.videoSuanliPerSec;
    const perShotCostCheap = shape.shot_sec * price.videoCheapSuanliPerSec;
    const frameCost = price.imageSuanli; // 每镜 1 张关键帧
    const llmPerEpisode = 40 * price.llmInSuanliPer1k + 12 * price.llmOutSuanliPer1k; // 粗略：40k 输入 / 12k 输出
    const episodeCost = shape.shots_per_episode * (perShotCost + frameCost) + llmPerEpisode;
    const dramaCost = episodeCost * shape.episodes;

    // —— 吞吐（并发 × 时延）——
    const stat = pool.stats || {};
    const avgLatencyMs = stat.success > 0
      ? Math.round(stat.totalLatencyMs / stat.success)
      : Number(config.relay.timeoutMs) / 2; // 没有样本时按超时的一半保守估
    const avgLatencySec = Math.max(5, Math.round(avgLatencyMs / 1000));
    const slots = pool.maxConcurrency;
    // 每个槽位每秒能产出多少秒成片：一条 5 秒镜头占用 avgLatencySec
    const shotsPerMinute = (slots / avgLatencySec) * 60;
    const videoSecondsPerHour = Math.round(shotsPerMinute * 60 * shape.shot_sec);
    const dramasPerDay = Math.floor(((slots * 86400) / avgLatencySec) / shape.shots);

    // —— 余额能撑多久 ——
    const balance = pool.balance?.source === 'live' ? Number(pool.balance.realBalanceSuanli) : null;
    const runwayShots = balance === null ? null : Math.floor(balance / (perShotCost + frameCost));
    const runwayEpisodes = balance === null ? null : Math.floor(balance / episodeCost);
    const runwayDramas = balance === null ? null : Math.floor(balance / dramaCost);
    const runwayVideoMinutes = balance === null ? null : Math.round((balance / perShotCost) * shape.shot_sec / 60);

    // —— 能同时服务多少人 ——
    // 一个正在出片的用户，会连续下单镜头；给 2 个槽位才算「不排队」，1 个槽位算「能跑但等」
    const usersComfortable = Math.max(0, Math.floor(slots / 2));
    const usersMax = slots;
    // 每人每天产 1 部 3 集短剧时，日可服务人数
    const usersPerDay = dramasPerDay;

    // —— 瓶颈判定 ——
    const rpmBudget = pool.rpmLimit; // 每分钟最多 1 次 acquire/生成
    const rpmNeededForSlots = Math.ceil((slots / avgLatencySec) * 60);
    let bottleneck = 'none';
    if (balance !== null && runwayDramas !== null && runwayDramas < 1) bottleneck = 'balance';
    else if (rpmNeededForSlots > rpmBudget) bottleneck = 'rpm';
    else if (slots <= 2) bottleneck = 'concurrency';
    else if (balance !== null && balance < dramaCost * 3) bottleneck = 'balance_low';

    const advice = [];
    if (bottleneck === 'balance' || bottleneck === 'balance_low') {
      advice.push(`池里只剩 ${balance} 算力，一部 ${shape.episodes} 集短剧要 ${Math.round(dramaCost)} 算力：先补仓，再谈扩容`);
      advice.push('余额低于熔断线会自动暂停服务（RELAY_FUSED），补仓后立即恢复，不需要重启容器');
    }
    if (bottleneck === 'concurrency') {
      advice.push(`把 RELAY_MAX_CONCURRENCY 从 ${slots} 调到 ${Math.max(8, slots * 2)}（前提：上游账户允许，且余额够）`);
    }
    if (rpmNeededForSlots > rpmBudget) {
      advice.push(`并发 ${slots} 在 ${avgLatencySec}s 时延下需要 ${rpmNeededForSlots} RPM，当前限 ${rpmBudget}：要么降并发，要么申请提额`);
    }
    if (activeUsersWanted > 0) {
      const needSlots = activeUsersWanted * 2;
      const gap = needSlots - slots;
      advice.push(gap > 0
        ? `要支撑 ${activeUsersWanted} 人同时出片需要约 ${needSlots} 个并发槽位，当前 ${slots}，缺 ${gap}`
        : `当前 ${slots} 槽位够 ${activeUsersWanted} 人同时出片（每人 2 槽）`);
      const needBalance = Math.round(dramaCost * activeUsersWanted);
      if (balance !== null) {
        advice.push(`这 ${activeUsersWanted} 人各跑一部，需要池余额约 ${needBalance} 算力，当前 ${balance}`);
      }
    }

    return {
      at: new Date().toISOString(),
      pool: {
        mode: pool.mode,
        max_concurrency: slots,
        rpm_limit: rpmBudget,
        rpm_used: pool.rpmUsed,
        inflight: pool.inflight,
        balance_suanli: balance,
        balance_source: pool.balance?.source ?? 'unknown',
        key_quota_used: pool.balance?.keyQuotaUsed ?? null,
        water_level: pool.water?.level ?? 'unknown',
      },
      unit_cost: {
        video_suanli_per_sec: price.videoSuanliPerSec,
        video_cheap_suanli_per_sec: price.videoCheapSuanliPerSec,
        image_suanli: price.imageSuanli,
        llm_in_suanli_per_1k: price.llmInSuanliPer1k,
        llm_out_suanli_per_1k: price.llmOutSuanliPer1k,
      },
      shape,
      cost: {
        per_shot_suanli: Number((perShotCost + frameCost).toFixed(2)),
        per_shot_cheap_suanli: Number((perShotCostCheap + frameCost).toFixed(2)),
        per_episode_suanli: Number(episodeCost.toFixed(1)),
        per_drama_suanli: Number(dramaCost.toFixed(1)),
        per_drama_points: Math.ceil(dramaCost * config.credit.markup / config.credit.cnyPerPoint),
      },
      throughput: {
        avg_latency_sec: avgLatencySec,
        shots_per_minute: Number(shotsPerMinute.toFixed(2)),
        video_seconds_per_hour: videoSecondsPerHour,
        dramas_per_day: dramasPerDay,
      },
      concurrency: {
        slots,
        users_comfortable: usersComfortable,
        users_max: usersMax,
        users_per_day: usersPerDay,
      },
      runway: {
        shots: runwayShots,
        episodes: runwayEpisodes,
        dramas: runwayDramas,
        video_minutes: runwayVideoMinutes,
      },
      bottleneck,
      advice,
    };
  }
}

export const capacity = new Capacity();
export default capacity;
