/**
 * 模型注册表：算力池可用模型的唯一事实来源。
 *
 * 职责：
 *  1. 维护 code → 上游模型 的映射（code 是我们给前端的展示代号，upstream_id 才是真发给网关的）
 *  2. commercial_ok = false 的模型禁止用于交付产物（许可证红线，§3.7）
 *  3. 成本换算：上游 USD → 点数（售价）
 */
import seeds from '../seeds/loader.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';

export class ModelRegistry {
  constructor() {
    this.models = seeds.modelRegistry;
    this.meta = seeds.modelRegistryMeta;
  }

  /** 列出可给前端看的模型（不含上游真名与真实成本） */
  listForClient(role = null) {
    return this.models
      .filter((m) => !role || m.role === role)
      .map((m) => ({
        code: m.code,
        role: m.role,
        display_name: m.display_name,
        // 前端按档位展示价格，不知道真实上游价
        points_per_unit: this.quotePoints(m),
        supports_reference: !!m.supports_reference,
        supports_first_frame: !!m.supports_first_frame,
        commercial_ok: m.commercial_ok !== false,
      }));
  }

  /** 内部取用（含 upstream_id） */
  get(code) {
    const m = seeds.model(code);
    if (!m) fail(ERR.RELAY_MODEL_NOT_FOUND, `模型不存在: ${code}`);
    return m;
  }

  /** 交付用途：不可商用的模型直接拒绝 */
  getForDelivery(code) {
    const m = this.get(code);
    if (m.commercial_ok === false) {
      fail(ERR.MODEL_NOT_COMMERCIAL, `模型 ${code} 许可证不允许商业交付，请换用可商用模型`, {
        code,
        notes: m.notes,
      });
    }
    return m;
  }

  /**
   * 报价：上游真实成本 → 售价点数。
   * 价格字段优先使用 suanli（中转站算力，V3.5 真实定价）：
   *   points = ceil( suanli * SUANLI_CNY_RATE / CNY_PER_POINT * MARKUP )
   * 兼容旧 usd 字段：points = ceil( usd * USD_CNY_RATE / CNY_PER_POINT * MARKUP )
   * chat/tts 按 token 计价的模型取 in+out 之和作为"单次典型成本"的保守估计。
   */
  quotePoints(model) {
    const p = model.price ?? {};
    let cny = 0;
    if (typeof p.suanli === 'number') cny = p.suanli * config.credit.suanliCnyRate;
    else if (typeof p.suanli_in === 'number') {
      cny = (p.suanli_in + (p.suanli_out ?? 0)) * config.credit.suanliCnyRate;
    } else if (typeof p.usd === 'number') cny = p.usd * config.credit.usdCnyRate;
    else if (typeof p.usd_in === 'number') cny = (p.usd_in + (p.usd_out ?? 0)) * config.credit.usdCnyRate;
    return Math.max(1, Math.ceil((cny / config.credit.cnyPerPoint) * config.credit.markup));
  }

  /** 按角色挑默认模型（可商用优先；带 role_default 的排第一） */
  defaultFor(role) {
    const list = seeds.modelsByRole(role, { commercialOnly: true });
    if (!list.length) fail(ERR.RELAY_MODEL_NOT_FOUND, `没有可商用的 ${role} 模型`);
    // V4.13：目录里标了"推荐"的模型必须真的是默认值。
    // 以前默认取注册表第一条，于是"推荐 TT Image 2.6"只在前端是个标签，后端仍走第一条。
    const preferred = list.find((m) => m.role_default === true);
    return (preferred ?? list[0]).code;
  }
}

export const modelRegistry = new ModelRegistry();
export default modelRegistry;
