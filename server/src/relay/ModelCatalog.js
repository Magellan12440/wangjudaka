/**
 * 用户可选模型目录（V4.3）。
 *
 * 产品规则（硬）：
 *  1. 每个环节最多展示 5 个模型，按人工排序（热度/效果）取前 5，绝不把 195 条上游清单甩给用户。
 *  2. 只展示「能用」的：上游已下架、实测探活失败、许可证不允许商用、目录未登记的一律隐藏。
 *  3. 前端只知道展示名、档位说明与点数额度，永远拿不到 upstream_id 与真实成本。
 *
 * 探活结果来自 data/model_health.json（scripts/probe_models.js 写入）：
 *  status=down → 隐藏；status=ok → 展示；无记录 → 按目录登记状态展示（verified 默认 true）。
 */
import fs from 'node:fs';
import path from 'node:path';
import seeds from '../seeds/loader.js';
import { config } from '../config/env.js';
import { modelRegistry } from '../relay/ModelRegistry.js';
import { logger } from '../core/redact.js';
import { fail, ERR } from '../core/errors.js';

const HEALTH_FILE = () => path.join(config.server.dataDir, 'model_health.json');
const MAX_PER_ROLE = 5;

let cache = { at: 0, data: null, mtime: 0 };

function readHealth() {
  const file = HEALTH_FILE();
  try {
    const st = fs.statSync(file);
    if (cache.data && cache.mtime === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { at: Date.now(), data, mtime: st.mtimeMs };
    return data;
  } catch {
    return cache.data ?? { models: {} };
  }
}

export class ModelCatalog {
  /** 某个模型为什么不可选；返回 null 表示可选 */
  hiddenReason(modelCode, health) {
    const m = seeds.model(modelCode);
    if (!m) return 'not_registered';
    if (m.upstream_available === false) return 'upstream_unavailable';
    if (m.commercial_ok === false) return 'not_commercial';
    const h = health?.models?.[modelCode];
    if (h && h.status === 'down') return 'probe_failed';
    if (h && h.status === 'unavailable') return 'probe_unavailable';
    return null;
  }

  /** 单个环节的可选列表（已过滤 + 截断到 5） */
  list(role) {
    const meta = seeds.catalogRole(role);
    if (!meta) fail(ERR.NOT_FOUND, `未知的模型环节: ${role}`);
    const health = readHealth();
    const items = [];
    const hidden = [];
    for (const raw of meta.items ?? []) {
      if (items.length >= MAX_PER_ROLE) break;
      if (role === 'edit') {
        items.push({
          code: raw.code,
          label: raw.label,
          desc: raw.desc,
          recommended: !!raw.recommended,
          preset: raw.preset ?? null,
          points_per_unit: null,
          price_text: raw.preset ? '按成片时长计费' : '免费（仅导出）',
          verified: true,
        });
        continue;
      }
      const reason = this.hiddenReason(raw.model, health);
      if (reason) {
        hidden.push({ code: raw.model, reason });
        continue;
      }
      const m = seeds.model(raw.model);
      const points = modelRegistry.quotePoints(m);
      items.push({
        code: m.code,
        label: raw.label ?? m.display_name,
        desc: raw.desc ?? '',
        recommended: !!raw.recommended,
        points_per_unit: points,
        price_text: this.#priceText(m, points),
        verified: health?.models?.[m.code]?.status === 'ok' ? true : raw.verified !== false,
      });
    }
    return {
      role,
      name: meta.name,
      hint: meta.hint ?? '',
      items,
      hidden: hidden.length,
      checked_at: health?.checked_at ?? null,
      max_per_role: MAX_PER_ROLE,
    };
  }

  /** 全部环节（一次请求渲染所有选择器） */
  all() {
    const roles = seeds.catalogRoles();
    const out = {};
    for (const r of roles) out[r] = this.list(r);
    return { roles: out, billing_multiplier: config.credit.markup };
  }

  defaultFor(role) {
    const l = this.list(role);
    const rec = l.items.find((x) => x.recommended) ?? l.items[0];
    return rec ? rec.code : null;
  }

  /**
   * 校验用户选择的模型：不在该环节可选列表里就回退默认。
   * 这样即使前端传了脏 code（或模型刚被封），也不会把请求打到不可用上游。
   */
  resolve(role, code) {
    const l = this.list(role);
    if (code && l.items.some((x) => x.code === code)) return code;
    if (code) {
      logger.warn('用户选择的模型不可用，回退默认', { role, code });
    }
    return this.defaultFor(role);
  }

  /** 对外视图：只给展示字段 */
  publicRoles() {
    const all = this.all();
    const roles = {};
    for (const [k, v] of Object.entries(all.roles)) {
      roles[k] = {
        name: v.name,
        hint: v.hint,
        items: v.items.map((x) => ({
          code: x.code, label: x.label, desc: x.desc,
          recommended: x.recommended, price_text: x.price_text, verified: x.verified,
        })),
      };
    }
    return { roles, billing_multiplier: all.billing_multiplier, checked_at: readHealth()?.checked_at ?? null };
  }

  /** 剪辑档位 → ffmpeg preset（ED-EDL 返回 null：只导出剪辑单，不合成） */
  editPreset(code) {
    const l = this.list('edit');
    const hit = l.items.find((x) => x.code === code) ?? l.items.find((x) => x.recommended) ?? l.items[0];
    return hit?.preset ?? 'medium';
  }

  /** 探活结果落盘（scripts/probe_models.js 与管理员触发共用） */
  recordHealth({ results, at = new Date().toISOString() }) {
    const models = {};
    for (const r of results ?? []) models[r.code] = r;
    const data = { checked_at: at, models };
    try {
      fs.mkdirSync(path.dirname(HEALTH_FILE()), { recursive: true });
      fs.writeFileSync(HEALTH_FILE(), JSON.stringify(data, null, 2));
      cache = { at: Date.now(), data, mtime: 0 };
    } catch (e) {
      logger.error('模型探活结果落盘失败', { msg: e.message });
    }
    return data;
  }

  health() {
    return readHealth();
  }

  #priceText(model, points) {
    const unit = model.price?.unit ?? '';
    if (unit === '1k_tokens') return `约 ${points} 点 / 千字`;
    if (unit === 'image') return `约 ${points} 点 / 张`;
    if (unit === 'video_second') return `约 ${points} 点 / 秒`;
    if (unit === '1k_chars') return `约 ${points} 点 / 千字`;
    if (unit === 'clip') return `约 ${points} 点 / 段`;
    return `约 ${points} 点 / 次`;
  }
}

export const modelCatalog = new ModelCatalog();
export default modelCatalog;
