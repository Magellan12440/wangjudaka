/**
 * 通用 HTTP 比对 provider 适配器（P0-1 框架落地 / §24、§25.4）。
 *
 * 用来接 CLIP / InsightFace / 任意自建的图像或特征比对服务，契约：
 *   POST <endpoint>
 *   Authorization: Bearer <token>（可选）
 *   body: { reference, candidate, generated_url }
 *   期望响应：{ score: 0~1 } 或 { similarity: 0~1 } 或 { data: { score } }
 *            可附 dimensions: { locks, emotion, lighting, style } 供漂移归因
 *
 * 「绝不假装通过」三条硬规则（与 ConsistencyChecker 一致）：
 *  1. 未配置 endpoint → available=false，compare 恒返回 score:null → verdict=degraded。
 *  2. 超时 / 非 2xx / 响应无合法分数 / 抛异常 → score:null + reason，绝不兜底给高分。
 *  3. 只有上游明确返回 0~1 的有限数字才采信，并在 dimensions 留证来源。
 *
 * 注意：ConsistencyChecker.check() 是同步契约。因此本 provider 提供
 *   - compareAsync()：真·异步 HTTP，由 checkAsync() 调用；
 *   - syncCompare()：同步壳，永远不产出分数（防误用同步路径时假装通过）。
 */
import { config } from '../../config/env.js';

const UNCONFIGURED_REASON = '未配置比对服务地址（QC_COMPARE_ENDPOINT），降级待人工复核';

export class HttpCompareProvider {
  constructor({
    name = 'http_clip',
    endpoint = '',
    token = '',
    timeoutMs = 8000,
    fetchImpl = null,
  } = {}) {
    this.name = name;
    this.endpoint = endpoint || config.qc.compareEndpoint;
    this.token = token || config.qc.compareToken;
    this.timeoutMs = Number(timeoutMs) || config.qc.compareTimeoutMs;
    this._fetch = fetchImpl ?? globalThis.fetch;
    this.available = Boolean(this.endpoint) && typeof this._fetch === 'function';
    this.lastError = null;
    this.lastStatus = null;
  }

  /** 同步壳：绝不产出分数，仅用于满足 provider 契约与防误用 */
  syncCompare() {
    return {
      score: null,
      dimensions: {},
      reason: this.available
        ? 'HTTP 比对是异步服务，请通过 checkAsync / /api/qc/consistency/check-async 调用'
        : UNCONFIGURED_REASON,
    };
  }

  /** 兼容 provider 契约的同步 compare（转发同步壳） */
  compare() {
    return this.syncCompare();
  }

  async compareAsync({ reference = null, candidate = null, generatedUrl = null } = {}) {
    if (!this.available) {
      return { score: null, dimensions: {}, reason: UNCONFIGURED_REASON };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ reference, candidate, generated_url: generatedUrl }),
        signal: controller.signal,
      });
      this.lastStatus = resp.status;
      if (!resp.ok) {
        this.lastError = `HTTP ${resp.status}`;
        return {
          score: null,
          dimensions: { http_status: resp.status },
          reason: `比对服务返回 HTTP ${resp.status}，降级待人工复核`,
        };
      }
      const data = await resp.json();
      const score = extractScore(data);
      if (score === null) {
        this.lastError = 'invalid_score';
        return {
          score: null,
          dimensions: { response_keys: Object.keys(data ?? {}).slice(0, 12) },
          reason: '比对服务未返回 0~1 的有效分数，降级待人工复核',
        };
      }
      this.lastError = null;
      return {
        score,
        dimensions: {
          ...(isPlainObject(data?.dimensions) ? data.dimensions : {}),
          provider: this.name,
          external: true,
          http_status: resp.status,
        },
        source: this.name,
      };
    } catch (e) {
      this.lastError = e?.name === 'AbortError' ? 'timeout' : (e?.message ?? 'unknown_error');
      return {
        score: null,
        dimensions: {},
        reason: `比对服务不可用（${this.lastError}），降级待人工复核`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 运维状态：绝不回显 token 或完整 endpoint */
  status() {
    return {
      name: this.name,
      available: this.available,
      configured: Boolean(this.endpoint),
      endpoint_host: safeHost(this.endpoint),
      has_token: Boolean(this.token),
      timeout_ms: this.timeoutMs,
      last_error: this.lastError,
      last_status: this.lastStatus,
    };
  }
}

/** 严格取分：只认 0~1 的有限数字，字符串数字也拒绝（防上游把错误码当分数） */
export function extractScore(data) {
  if (data === null || typeof data !== 'object') return null;
  const candidates = [
    data.score,
    data.similarity,
    data.similarity_score,
    data.data?.score,
    data.data?.similarity,
    data.result?.score,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) return v;
  }
  return null;
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export default HttpCompareProvider;
