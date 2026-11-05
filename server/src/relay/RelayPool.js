/**
 * 算力池：单主账号下的并发闸门、限流、熔断、水位告警。
 *
 * 背景（V2.0 §4）：主账号是代理商算力池，所有用户共享同一个 Key。
 * 因此必须有：并发上限、RPM 限流、连续失败熔断、余额水位三级告警。
 *
 * V3.5：水位改为「真实余额驱动」。
 *  网关实测暴露 GET /skills/balance（返回 balance 算力、Key 已用量），
 *  因此 live 模式下优先用真实余额与绝对阈值（POOL_*_SUANLI）判定水位；
 *  余额接口不可用或 MOCK 模式时，回退到本地估算水位（POOL_BALANCE_POINTS 比例制）。
 *  余额查询有 TTL 缓存，不会每次请求都打上游。
 */
import { config } from '../config/env.js';
import { logger } from '../core/redact.js';
import { fail, ERR } from '../core/errors.js';

class RelayPool {
  constructor() {
    this.inflight = 0;
    this.maxConcurrency = config.relay.maxConcurrency;
    this.rpmLimit = config.relay.rpmLimit;
    this.windowStart = Date.now();
    this.windowCount = 0;

    this.consecutiveFailures = 0;
    this.fuseUntil = 0;
    this.fuseThreshold = 5;
    this.fuseCooldownMs = 60_000;

    /** 本地估算水位（单位：点）。MOCK / 余额接口不可用时使用 */
    this.poolBalancePoints = Number(process.env.POOL_BALANCE_POINTS ?? 0);
    this.poolCapacityPoints = Number(process.env.POOL_CAPACITY_POINTS ?? 0);

    /** 真实余额（单位：算力）。live 模式由 /skills/balance 刷新 */
    this.realBalanceSuanli = null;
    this.keyQuotaUsed = null;
    this.balanceFetchedAt = 0;
    this.balanceFetchFailedAt = 0;

    this.stats = { success: 0, failure: 0, spentPoints: 0, totalLatencyMs: 0 };
  }

  /** 是否处于"真实余额可用"状态 */
  get hasRealBalance() {
    return !config.relay.mock && typeof this.realBalanceSuanli === 'number';
  }

  /** 水位：0~1。真实余额模式下返回相对 warn 线的归一化比例；本地模式返回余额/容量 */
  waterRatio() {
    if (this.hasRealBalance) {
      const warn = Math.max(config.pool.warnSuanli, 0.0001);
      return Math.max(0, Math.min(1, this.realBalanceSuanli / warn));
    }
    if (!this.poolCapacityPoints) return 1;
    return Math.max(0, Math.min(1, this.poolBalancePoints / this.poolCapacityPoints));
  }

  waterLevel() {
    if (this.hasRealBalance) {
      const b = this.realBalanceSuanli;
      if (b <= config.pool.fuseSuanli) return 'fuse';
      if (b <= config.pool.criticalSuanli) return 'critical';
      if (b <= config.pool.warnSuanli) return 'warn';
      return 'normal';
    }
    const r = this.waterRatio();
    if (r <= config.pool.fuseRatio) return 'fuse';
    if (r <= config.pool.criticalRatio) return 'critical';
    if (r <= config.pool.warnRatio) return 'warn';
    return 'normal';
  }

  /**
   * 刷新真实余额（TTL 缓存，失败不抛）。
   * @returns {Promise<{balance:number|null, source:string}>}
   */
  async refreshBalance({ force = false } = {}) {
    if (config.relay.mock || !config.relay.apiKey) {
      return { balance: null, source: 'mock' };
    }
    const now = Date.now();
    if (!force && now - this.balanceFetchedAt < config.pool.balanceTtlMs) {
      return { balance: this.realBalanceSuanli, source: 'cache' };
    }
    // 上次失败 30s 内不再重试，避免余额接口故障拖慢主链路
    if (!force && now - this.balanceFetchFailedAt < 30_000) {
      return { balance: this.realBalanceSuanli, source: 'backoff' };
    }
    try {
      const base = config.relay.gateway.replace(/\/+$/, '');
      const res = await fetch(`${base}/skills/balance`, {
        headers: { Authorization: `Bearer ${config.relay.apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof (json?.balance) !== 'number') {
        throw new Error(`balance HTTP ${res.status}`);
      }
      this.realBalanceSuanli = Number(json.balance);
      this.keyQuotaUsed = Number(json?.api_key_quota?.used ?? 0);
      this.balanceFetchedAt = now;
      const lv = this.waterLevel();
      if (lv !== 'normal') {
        logger.warn('算力池真实余额水位告警', { level: lv, balanceSuanli: this.realBalanceSuanli });
      }
      return { balance: this.realBalanceSuanli, source: 'live' };
    } catch (e) {
      this.balanceFetchFailedAt = now;
      logger.error('真实余额查询失败，回退本地水位', { err: e?.message });
      return { balance: this.realBalanceSuanli, source: 'fallback' };
    }
  }

  /** 设置本地估算水位（运维入口 / MOCK） */
  setPoolState({ balancePoints, capacityPoints }) {
    if (typeof balancePoints === 'number') this.poolBalancePoints = balancePoints;
    if (typeof capacityPoints === 'number') this.poolCapacityPoints = capacityPoints;
    const lv = this.waterLevel();
    if (lv !== 'normal') {
      logger.warn('算力池水位告警', { level: lv, ratio: this.waterRatio().toFixed(3) });
    }
    return { level: lv, ratio: this.waterRatio() };
  }

  /** 扣减水位（真实消耗后调用）：真实余额与本地估算同步扣 */
  consume(points) {
    if (this.poolCapacityPoints) {
      this.poolBalancePoints = Math.max(0, this.poolBalancePoints - points);
    }
    if (typeof this.realBalanceSuanli === 'number') {
      this.realBalanceSuanli = Math.max(0, this.realBalanceSuanli - points);
    }
  }

  async acquire({ estimatedCredits = 0 } = {}) {
    // 0) 先刷新真实余额（有缓存则几乎零成本）
    await this.refreshBalance();
    // 1) 熔断
    if (Date.now() < this.fuseUntil) {
      fail(ERR.RELAY_FUSED, '算力池暂时熔断，正在恢复中，请稍后重试');
    }
    // 2) 水位
    const lv = this.waterLevel();
    if (lv === 'fuse') {
      logger.error('算力池水位触及熔断线', { ratio: this.waterRatio(), realBalanceSuanli: this.realBalanceSuanli });
      fail(ERR.RELAY_FUSED, '算力池额度不足，已暂停服务，请等待运营补仓');
    }
    // 3) 并发
    if (this.inflight >= this.maxConcurrency) {
      fail(ERR.RELAY_RATE_LIMITED, '算力池已达并发上限，请稍后再试');
    }
    // 4) RPM
    this.#slideWindow();
    if (this.windowCount >= this.rpmLimit) {
      fail(ERR.RELAY_RATE_LIMITED, '算力池已达每分钟请求上限，请稍后再试');
    }
    // 5) 单次预估消耗不得超过可用水位
    if (this.hasRealBalance && estimatedCredits > 0 && estimatedCredits > this.realBalanceSuanli) {
      fail(ERR.RELAY_FUSED, '算力池余额不足以完成本次生成，请等待运营补仓', {
        balanceSuanli: this.realBalanceSuanli,
      });
    } else if (this.poolCapacityPoints && estimatedCredits > this.poolBalancePoints) {
      fail(ERR.RELAY_FUSED, '算力池额度不足以完成本次生成，请等待运营补仓');
    }

    this.inflight += 1;
    this.windowCount += 1;
    return true;
  }

  release() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  recordSuccess({ costPoints = 0, latencyMs = 0 } = {}) {
    this.consecutiveFailures = 0;
    this.stats.success += 1;
    this.stats.spentPoints += costPoints;
    this.stats.totalLatencyMs += latencyMs;
    this.consume(costPoints);
  }

  recordFailure(err) {
    this.consecutiveFailures += 1;
    this.stats.failure += 1;
    logger.error('上游调用失败', {
      consecutive: this.consecutiveFailures,
      code: err?.code ?? 'UNKNOWN',
    });
    if (this.consecutiveFailures >= this.fuseThreshold) {
      this.fuseUntil = Date.now() + this.fuseCooldownMs;
      this.consecutiveFailures = 0;
      logger.error('连续失败触发熔断', { cooldownMs: this.fuseCooldownMs });
    }
  }

  #slideWindow() {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
  }

  health() {
    return {
      mode: config.relay.mock ? 'mock' : 'live',
      inflight: this.inflight,
      maxConcurrency: this.maxConcurrency,
      rpmUsed: this.windowCount,
      rpmLimit: this.rpmLimit,
      fused: Date.now() < this.fuseUntil,
      water: { level: this.waterLevel(), ratio: Number(this.waterRatio().toFixed(4)) },
      balance: {
        source: this.hasRealBalance ? 'live' : (config.relay.mock ? 'mock' : 'fallback_local'),
        realBalanceSuanli: this.realBalanceSuanli,
        keyQuotaUsed: this.keyQuotaUsed,
        fetchedAt: this.balanceFetchedAt ? new Date(this.balanceFetchedAt).toISOString() : null,
      },
      stats: { ...this.stats },
    };
  }
}

export const relayPool = new RelayPool();
export default relayPool;
