/**
 * 管理员后台服务（V3.6 · 阶段 J）。
 *
 * 能力：
 *  1. 充值档次管理：点数 / 售价 / 赠送福利 / 上下架 / 排序，小程序「我的」页动态拉取。
 *  2. 兑换码：批量生成（面额 + 赠送 + 前缀 + 有效期 + 使用次数上限）、列表、作废、统计。
 *  3. 用户兑换：校验（存在/未作废/未过期/未达上限/每码每用户一次）→ Ledger 入账（幂等）。
 *
 * 安全约束（硬）：
 *  - 所有管理端方法必须先过 assertAdmin()；未配置 ADMIN_TOKEN 时一律拒绝（无默认口令）。
 *  - 兑换入账走 Ledger.recharge，幂等键 redeem:<code>:<userId>，重放/双击/断网重试不多入账。
 *  - 兑换码只出现在服务端与管理端响应中；用户侧接口只返回自己兑换过的码（脱敏为部分可见）。
 */
import crypto from 'node:crypto';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, round } from '../core/util.js';
import { logger } from '../core/redact.js';
import { config } from '../config/env.js';
import ledger from '../ledger/Ledger.js';

const PKG = 'recharge_packages';
const CODE = 'redeem_codes';
const USAGE = 'redeem_usages';

/** 码字母表：去掉易混淆字符 0/O/1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCodeBody(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/** 规范化用户输入的兑换码：去空格/横杠、转大写 */
export function normalizeCode(input) {
  return String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/** 展示格式：XXXX-XXXX-XX（仅用于生成与显示，存储用规范化形式） */
function formatCode(norm) {
  return norm.replace(/(.{4})(?=.)/g, '$1-');
}

export class AdminService {
  constructor({ ledgerSvc = ledger } = {}) {
    this.ledger = ledgerSvc;
  }

  // ============================================================
  // 鉴权
  // ============================================================
  /** 管理端鉴权：常量时间比较，未配置 token 时一律拒绝 */
  assertAdmin(token) {
    const expect = config.admin.token;
    if (!expect) fail(ERR.ADMIN_UNAUTHORIZED, '服务端未配置 ADMIN_TOKEN，管理端不可用');
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(expect);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) fail(ERR.ADMIN_UNAUTHORIZED, '管理员令牌无效');
    return true;
  }

  // ============================================================
  // 充值档次
  // ============================================================
  /** 首次启动播种默认档次（集合为空时才种，幂等） */
  seedDefaultPackages() {
    if (db.find(PKG).length > 0) return { seeded: false };
    const defaults = [
      { code: 'PKG-100', name: '尝鲜包', points: 100, bonus: 0, price_cny: 100, sort: 1 },
      { code: 'PKG-500', name: '创作包', points: 500, bonus: 30, price_cny: 500, sort: 2 },
      { code: 'PKG-1000', name: '工作室包', points: 1000, bonus: 100, price_cny: 1000, sort: 3 },
    ];
    for (const d of defaults) {
      // 默认档用 code 作为 id（PKG-100 等），便于测试与历史调用直接引用
      db.insert(PKG, {
        id: d.code, ...d, status: 'active', created_at: nowIso(),
      });
    }
    logger.info('充值档次默认播种完成', { count: defaults.length });
    return { seeded: true, count: defaults.length };
  }

  /** 校验档次字段 */
  #validatePackage({ name, points, bonus = 0, priceCny, sort = 0 }) {
    if (!name || String(name).trim().length < 1 || String(name).length > 30) {
      fail(ERR.PACKAGE_INVALID, '档次名称必填且不超过 30 字');
    }
    if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
      fail(ERR.PACKAGE_INVALID, '点数必须为 1~1,000,000 的整数');
    }
    if (!Number.isInteger(bonus) || bonus < 0 || bonus > points * 10) {
      fail(ERR.PACKAGE_INVALID, '赠送点数必须为不小于 0 的整数，且不超过本档点数的 10 倍');
    }
    if (!(Number(priceCny) >= 0.01 && Number(priceCny) <= 1_000_000)) {
      fail(ERR.PACKAGE_INVALID, '售价必须 ≥ 0.01 元');
    }
    return { name: String(name).trim(), points, bonus, price_cny: round(Number(priceCny), 2), sort: Number(sort) || 0 };
  }

  createPackage(input) {
    const v = this.#validatePackage(input);
    const row = db.insert(PKG, {
      id: newId('pkg'),
      code: input.code ? String(input.code).trim().toUpperCase() : `PKG-${v.points}-${Date.now() % 100000}`,
      ...v,
      status: 'active',
      created_at: nowIso(),
    });
    logger.info('充值档次已创建', { id: row.id, points: v.points, price: v.price_cny });
    return row;
  }

  updatePackage(id, patch) {
    const cur = db.findOne(PKG, (p) => p.id === id);
    if (!cur) fail(ERR.PACKAGE_NOT_FOUND, '充值档次不存在');
    const merged = {
      name: patch.name ?? cur.name,
      points: patch.points ?? cur.points,
      bonus: patch.bonus ?? cur.bonus,
      priceCny: patch.priceCny ?? cur.price_cny,
      sort: patch.sort ?? cur.sort,
    };
    const v = this.#validatePackage(merged);
    const updated = db.update(PKG, id, { ...v });
    logger.info('充值档次已更新', { id });
    return updated;
  }

  /** 上架/下架。下架不影响已购用户，只是小程序不再展示 */
  setPackageStatus(id, status) {
    if (!['active', 'offline'].includes(status)) fail(ERR.PACKAGE_INVALID, '状态只能是 active/offline');
    const cur = db.findOne(PKG, (p) => p.id === id);
    if (!cur) fail(ERR.PACKAGE_NOT_FOUND, '充值档次不存在');
    return db.update(PKG, id, { status });
  }

  listPackages({ includeOffline = true } = {}) {
    return db
      .find(PKG, (p) => includeOffline || p.status === 'active')
      .sort((a, b) => (a.sort - b.sort) || String(a.created_at).localeCompare(String(b.created_at)));
  }

  /** 公开视图：只下发前端需要的字段（不含内部备注），只含上架档 */
  publicPackages() {
    return this.listPackages({ includeOffline: false }).map((p) => {
      const bonus = this.effectiveBonus(p);
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        points: p.points,
        bonus,
        totalPoints: p.points + bonus,
        priceCny: p.price_cny,
      };
    });
  }

  // ============================================================
  // 充值活动（V4.3）：按档次设置加赠点数，可设起止时间
  // ============================================================
  campaign() {
    const row = db.findOne('app_settings', (s) => s.key === 'recharge_campaign');
    return row?.value ?? { enabled: false, startAt: null, endAt: null, bonusByPackage: {}, note: '' };
  }

  saveCampaign(patch = {}) {
    const cur = this.campaign();
    const next = {
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      startAt: patch.startAt ?? cur.startAt ?? null,
      endAt: patch.endAt ?? cur.endAt ?? null,
      note: String(patch.note ?? cur.note ?? '').slice(0, 60),
      bonusByPackage: (() => {
        const src = patch.bonusByPackage ?? cur.bonusByPackage ?? {};
        const out = {};
        for (const [k, v] of Object.entries(src)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
        }
        return out;
      })(),
    };
    if (next.startAt && Number.isNaN(new Date(next.startAt).getTime())) fail(ERR.BAD_REQUEST, '活动开始时间格式不正确');
    if (next.endAt && Number.isNaN(new Date(next.endAt).getTime())) fail(ERR.BAD_REQUEST, '活动结束时间格式不正确');
    const row = db.findOne('app_settings', (s) => s.key === 'recharge_campaign');
    if (row) db.update('app_settings', row.id, { value: next, updated_at: nowIso() });
    else db.insert('app_settings', { id: newId('set'), key: 'recharge_campaign', value: next, updated_at: nowIso() });
    logger.info('充值活动已更新', { enabled: next.enabled, bonus: Object.keys(next.bonusByPackage).length });
    return next;
  }

  /** 活动是否生效（未设起止 = 一直生效） */
  campaignActive() {
    const c = this.campaign();
    if (!c.enabled) return false;
    const now = Date.now();
    if (c.startAt && now < new Date(c.startAt).getTime()) return false;
    if (c.endAt && now > new Date(c.endAt).getTime()) return false;
    return true;
  }

  /** 某档次最终赠送点数：活动加赠与档次自带赠送取较大值（不叠加，避免超发） */
  effectiveBonus(pkg) {
    const base = pkg.bonus ?? 0;
    if (!this.campaignActive()) return base;
    const c = this.campaign();
    const extra = c.bonusByPackage?.[pkg.id] ?? c.bonusByPackage?.[pkg.code];
    if (extra === undefined) return base;
    return Math.max(base, Number(extra) || 0);
  }

  // ============================================================
  // 兑换码
  // ============================================================
  /**
   * 批量生成兑换码。
   * @param {object} o {points, bonus, count, prefix, expiresAt|expireDays, maxUses, note}
   */
  generateCodes({ points, bonus = 0, count = 1, prefix = 'LW', expiresAt = null, expireDays = null, maxUses = 1, note = '' }) {
    if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
      fail(ERR.BAD_REQUEST, '兑换码面额必须为 1~1,000,000 的整数');
    }
    if (!Number.isInteger(bonus) || bonus < 0) fail(ERR.BAD_REQUEST, '赠送点数必须为不小于 0 的整数');
    if (!Number.isInteger(count) || count < 1 || count > config.admin.redeemBatchMax) {
      fail(ERR.BAD_REQUEST, `单批生成数量为 1~${config.admin.redeemBatchMax}`);
    }
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000) {
      fail(ERR.BAD_REQUEST, '单码使用次数上限必须为 1~100000');
    }
    const pfx = String(prefix ?? 'LW').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'LW';
    let exp = null;
    if (expiresAt) {
      const t = new Date(expiresAt);
      if (Number.isNaN(t.getTime())) fail(ERR.BAD_REQUEST, '有效期格式不正确');
      exp = t.toISOString();
    } else {
      const days = Number.isInteger(expireDays) && expireDays > 0 ? expireDays : config.admin.redeemDefaultExpireDays;
      exp = new Date(Date.now() + days * 86400_000).toISOString();
    }
    const batchId = newId('batch');
    const rows = [];
    const seen = new Set();
    while (rows.length < count) {
      const norm = `${pfx}${randomCodeBody(10)}`;
      if (seen.has(norm)) continue;
      if (db.findOne(CODE, (c) => c.code === norm)) continue; // 全库唯一
      seen.add(norm);
      rows.push(db.insert(CODE, {
        id: newId('rc'),
        code: norm,
        code_display: formatCode(norm),
        points,
        bonus,
        total_points: points + bonus,
        batch_id: batchId,
        max_uses: maxUses,
        used_count: 0,
        status: 'active',
        expires_at: exp,
        note: String(note ?? '').slice(0, 100),
        created_at: nowIso(),
      }));
    }
    logger.info('兑换码批次已生成', { batchId, count: rows.length, points, bonus });
    return {
      batchId,
      count: rows.length,
      points,
      bonus,
      totalPoints: points + bonus,
      expiresAt: exp,
      maxUses,
      codes: rows.map((r) => r.code_display),
    };
  }

  listCodes({ status = null, batchId = null, limit = 100, offset = 0 } = {}) {
    let all = db.find(CODE, (c) => (!status || c.status === status) && (!batchId || c.batch_id === batchId));
    all = all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const total = all.length;
    const items = all.slice(offset, offset + limit).map((c) => ({
      ...c,
      remaining_uses: Math.max(0, c.max_uses - c.used_count),
      expired: new Date(c.expires_at).getTime() < Date.now(),
    }));
    return { total, items };
  }

  revokeCode(codeInput) {
    const norm = normalizeCode(codeInput);
    const cur = db.findOne(CODE, (c) => c.code === norm);
    if (!cur) fail(ERR.REDEEM_CODE_INVALID, '兑换码不存在');
    if (cur.status === 'revoked') return { ok: true, duplicated: true, code: cur.code_display };
    db.update(CODE, cur.id, { status: 'revoked', revoked_at: nowIso() });
    logger.info('兑换码已作废', { code: cur.code_display });
    return { ok: true, duplicated: false, code: cur.code_display };
  }

  codeStats() {
    const all = db.find(CODE);
    const usages = db.find(USAGE);
    const now = Date.now();
    const active = all.filter((c) => c.status === 'active' && new Date(c.expires_at).getTime() >= now);
    return {
      totalCodes: all.length,
      activeCodes: active.length,
      revokedCodes: all.filter((c) => c.status === 'revoked').length,
      totalRedemptions: usages.length,
      totalPointsIssued: round(usages.reduce((s, u) => s + (u.points_credited ?? 0), 0), 2),
      totalFaceValueActive: round(active.reduce((s, c) => s + (c.total_points ?? 0) * Math.max(0, c.max_uses - c.used_count), 0), 2),
    };
  }

  /** 管理端：某码的使用明细 */
  codeUsages(codeInput) {
    const norm = normalizeCode(codeInput);
    return db.find(USAGE, (u) => u.code === norm)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /** 用户侧：我的兑换记录（码部分脱敏） */
  myRedeems(userId, { limit = 50 } = {}) {
    return db.find(USAGE, (u) => u.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit)
      .map((u) => ({
        id: u.id,
        codeMasked: maskCode(u.code),
        pointsCredited: u.points_credited,
        createdAt: u.created_at,
      }));
  }

  // ============================================================
  // 用户兑换
  // ============================================================
  /**
   * 用户兑换算力额度。
   * 幂等：Ledger 幂等键 redeem:<code>:<userId>；同一用户对同一码重放不多入账。
   */
  redeem({ userId, code: codeInput }) {
    if (!userId) fail(ERR.BAD_REQUEST, '缺少用户标识');
    const norm = normalizeCode(codeInput);
    if (!norm) fail(ERR.REDEEM_CODE_INVALID, '请输入兑换码');
    const code = db.findOne(CODE, (c) => c.code === norm);
    if (!code || code.status === 'revoked') fail(ERR.REDEEM_CODE_INVALID, '兑换码无效或已作废');
    if (new Date(code.expires_at).getTime() < Date.now()) {
      fail(ERR.REDEEM_CODE_EXPIRED, '兑换码已过期', { expiresAt: code.expires_at });
    }
    // 每码每用户一次（硬约束，与幂等键同一粒度）
    const mine = db.findOne(USAGE, (u) => u.code === norm && u.user_id === userId);
    if (mine) fail(ERR.REDEEM_CODE_ALREADY_USED, '你已兑换过该码，每个码每人限用一次');
    if (code.used_count >= code.max_uses) fail(ERR.REDEEM_CODE_EXHAUSTED, '兑换码使用次数已用完');

    const total = code.total_points ?? (code.points + (code.bonus ?? 0));
    const idemKey = `redeem:${norm}:${userId}`;
    const r = this.ledger.recharge({
      userId,
      points: total,
      idemKey,
      orderId: code.id,
      channel: 'redeem_code',
    });
    if (r.duplicated) {
      // 并发重放兜底：理论上已被 mine 检查拦截，这里防御
      fail(ERR.REDEEM_CODE_ALREADY_USED, '你已兑换过该码，每个码每人限用一次');
    }
    db.update(CODE, code.id, { used_count: code.used_count + 1 });
    db.insert(USAGE, {
      id: newId('ru'),
      code: norm,
      code_id: code.id,
      user_id: userId,
      points_credited: total,
      idem_key: idemKey,
      created_at: nowIso(),
    });
    logger.info('兑换码兑换成功', { userId, points: total, batchId: code.batch_id });
    return {
      ok: true,
      credited: total,
      base: code.points,
      bonus: code.bonus ?? 0,
      balance: r.balance,
      remainingUses: Math.max(0, code.max_uses - (code.used_count + 1)),
    };
  }

  /** 管理端概览：充值档次数 / 兑换码统计 / 账户汇总 */
  overview() {
    const pkgs = db.find(PKG);
    const accounts = db.find('accounts');
    return {
      packages: { total: pkgs.length, active: pkgs.filter((p) => p.status === 'active').length },
      codes: this.codeStats(),
      users: {
        total: accounts.length,
        totalBalance: round(accounts.reduce((s, a) => s + (a.balance_points ?? 0), 0), 2),
        totalRecharged: round(accounts.reduce((s, a) => s + (a.total_recharged ?? 0), 0), 2),
        totalSpent: round(accounts.reduce((s, a) => s + (a.total_spent ?? 0), 0), 2),
      },
    };
  }
}

function maskCode(norm) {
  const s = String(norm ?? '');
  if (s.length <= 6) return '****';
  return `${s.slice(0, 2)}****${s.slice(-4)}`;
}

export const adminService = new AdminService();
export default adminService;
