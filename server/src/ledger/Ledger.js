/**
 * 点数账本（§4 资金流）。
 *
 * 模型：用户充的是「点数」（1 点 = 1 元），真实算力由主账号算力池承担。
 * 关键要求：
 *  1. 预扣-结算-退款三段式，杜绝"生成失败也扣钱"和"重复扣钱"。
 *  2. 幂等：同一 idem_key 只生效一次（虚拟支付回调可能重复）。
 *  3. 余额永不为负（预扣前校验）。
 *  4. 每笔流水可追溯：余额变动 = 流水求和（对账用）。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, round } from '../core/util.js';
import { logger } from '../core/redact.js';
import { config } from '../config/env.js';

const ACC = 'accounts';
const ENT = 'ledger_entries';
const HOLD = 'holds';

export class Ledger {
  /** 开户（首次登录/注册时调用，幂等） */
  ensureAccount(userId) {
    let acc = db.findOne(ACC, (a) => a.user_id === userId);
    if (!acc) {
      acc = db.insert(ACC, {
        id: newId('acc'),
        user_id: userId,
        balance_points: 0,
        total_recharged: 0,
        total_spent: 0,
        status: 'active',
        created_at: nowIso(),
      });
    }
    return acc;
  }

  balance(userId) {
    const acc = this.ensureAccount(userId);
    return acc.balance_points;
  }

  /**
   * 充值（虚拟支付发货回调调用）。
   * @param {string} idemKey 幂等键：用微信订单号，重复回调只入账一次
   */
  recharge({ userId, points, idemKey, orderId = null, channel = 'wx_virtual_pay' }) {
    if (!(points > 0)) fail(ERR.BAD_REQUEST, '充值点数必须为正');
    const exists = db.findOne(ENT, (e) => e.idem_key === idemKey);
    if (exists) {
      logger.info('充值幂等命中', { idemKey });
      return { ok: true, duplicated: true, entry: exists };
    }
    const acc = this.ensureAccount(userId);
    const before = acc.balance_points;
    const after = before + points;
    db.update(ACC, acc.id, {
      balance_points: after,
      total_recharged: acc.total_recharged + points,
    });
    const entry = db.insert(ENT, {
      id: newId('ent'),
      user_id: userId,
      type: 'recharge',
      points,
      before_points: before,
      after_points: after,
      ref_type: 'order',
      ref_id: orderId,
      idem_key: idemKey,
      channel,
      created_at: nowIso(),
    });
    return { ok: true, duplicated: false, entry, balance: after };
  }

  /**
   * 赠送入账（活动 / 邀请奖励 / 人工补偿）：加余额，但**不计入 total_recharged**。
   * 与 recharge 的区别只在统计口径：邀请奖励不是用户花的钱，不能算进「累计充值」。
   * 幂等：同一 idemKey 只生效一次。
   */
  grant({ userId, points, idemKey, channel = 'grant', refType = 'invite', refId = null, note = null }) {
    if (!(points > 0)) fail(ERR.BAD_REQUEST, '赠送点数必须为正');
    const exists = db.findOne(ENT, (e) => e.idem_key === idemKey);
    if (exists) return { ok: true, duplicated: true, entry: exists, balance: this.balance(userId) };
    const acc = this.ensureAccount(userId);
    const before = acc.balance_points;
    const after = round(before + points, 2);
    db.update(ACC, acc.id, { balance_points: after });
    const entry = db.insert(ENT, {
      id: newId('ent'),
      user_id: userId,
      type: 'grant',
      points,
      before_points: before,
      after_points: after,
      ref_type: refType,
      ref_id: refId,
      idem_key: idemKey,
      channel,
      note: note ? String(note).slice(0, 100) : null,
      created_at: nowIso(),
    });
    logger.info('赠送入账', { userId, points, channel, refId });
    return { ok: true, duplicated: false, entry, balance: after };
  }

  /**
   * 人工调整（可正可负）：用于撤销奖励、运营补偿。
   * 负数最多把余额扣到 0（不产生负余额），实际变动量以 entry.points 为准，对账仍平衡。
   */
  adjust({ userId, points, idemKey, channel = 'manual_adjust', refType = 'manual', refId = null, note = null }) {
    if (!Number.isFinite(points) || points === 0) fail(ERR.BAD_REQUEST, '调整点数必须为非零数字');
    const exists = db.findOne(ENT, (e) => e.idem_key === idemKey);
    if (exists) return { ok: true, duplicated: true, entry: exists, balance: this.balance(userId) };
    const acc = this.ensureAccount(userId);
    const before = acc.balance_points;
    const after = Math.max(0, round(before + points, 2));
    const delta = round(after - before, 2);
    if (delta !== 0) db.update(ACC, acc.id, { balance_points: after });
    const entry = db.insert(ENT, {
      id: newId('ent'),
      user_id: userId,
      type: 'adjust',
      points: delta,
      before_points: before,
      after_points: after,
      ref_type: refType,
      ref_id: refId,
      idem_key: idemKey,
      channel,
      note: note ? String(note).slice(0, 100) : null,
      created_at: nowIso(),
    });
    logger.info('人工调整入账', { userId, delta, channel, refId });
    return { ok: true, duplicated: false, entry, balance: after };
  }

  /** 预扣：生成前冻结点数 */
  hold({ userId, points, refType, refId, idemKey }) {
    if (!(points > 0)) fail(ERR.BAD_REQUEST, '预扣点数必须为正');
    if (idemKey) {
      const dup = db.findOne(HOLD, (h) => h.idem_key === idemKey);
      if (dup) return { ok: true, duplicated: true, hold: dup };
    }
    const acc = this.ensureAccount(userId);
    if (acc.balance_points < points) {
      fail(ERR.INSUFFICIENT_BALANCE, '点数不足，请先充值', {
        balance: acc.balance_points,
        required: points,
      });
    }
    const after = acc.balance_points - points;
    db.update(ACC, acc.id, { balance_points: after });
    const hold = db.insert(HOLD, {
      id: newId('hold'),
      user_id: userId,
      points,
      ref_type: refType,
      ref_id: refId,
      idem_key: idemKey ?? null,
      status: 'held',
      settled_points: 0,
      created_at: nowIso(),
    });
    db.insert(ENT, {
      id: newId('ent'),
      user_id: userId,
      type: 'hold',
      points: -points,
      before_points: acc.balance_points,
      after_points: after,
      ref_type: refType,
      ref_id: refId,
      idem_key: idemKey ? `${idemKey}:hold` : null,
      created_at: nowIso(),
    });
    return { ok: true, duplicated: false, hold, balance: after };
  }

  /**
   * 结算：按真实消耗扣，多退少补。
   * @param {string} holdId
   * @param {number} actualPoints 真实消耗（来自 RelayAdapter 返回）
   */
  settle(holdId, actualPoints) {
    const hold = db.findOne(HOLD, (h) => h.id === holdId);
    if (!hold) fail(ERR.NOT_FOUND, '预扣记录不存在');
    if (hold.status !== 'held') fail(ERR.ORDER_STATE_INVALID, '预扣记录状态不可结算', { status: hold.status });
    const acc = this.ensureAccount(hold.user_id);
    const diff = round((hold.points ?? 0) - (actualPoints ?? 0), 2); // >0 需退还
    const after = round(acc.balance_points + diff, 2);
    db.update(ACC, acc.id, {
      balance_points: after,
      total_spent: round(acc.total_spent + (actualPoints ?? 0), 2),
    });
    db.update(HOLD, holdId, {
      status: 'settled',
      settled_points: actualPoints,
      settled_at: nowIso(),
    });
    db.insert(ENT, {
      id: newId('ent'),
      user_id: hold.user_id,
      type: diff >= 0 ? 'refund' : 'capture',
      // 约定：entry.points 一律是"余额变动量"（正=增加，负=减少），对账时直接求和
      points: diff,
      before_points: acc.balance_points,
      after_points: after,
      ref_type: hold.ref_type,
      ref_id: hold.ref_id,
      idem_key: `${holdId}:settle`,
      created_at: nowIso(),
    });
    return { ok: true, refunded: Math.max(0, diff), charged: actualPoints, balance: after };
  }

  /** 取消预扣（生成失败 / 用户放弃）→ 全额退回 */
  release(holdId, reason = 'failed') {
    const hold = db.findOne(HOLD, (h) => h.id === holdId);
    if (!hold) fail(ERR.NOT_FOUND, '预扣记录不存在');
    if (hold.status !== 'held') return { ok: true, duplicated: true };
    const acc = this.ensureAccount(hold.user_id);
    const after = round(acc.balance_points + hold.points, 2);
    db.update(ACC, acc.id, { balance_points: after });
    db.update(HOLD, holdId, { status: 'released', release_reason: reason, settled_at: nowIso() });
    db.insert(ENT, {
      id: newId('ent'),
      user_id: hold.user_id,
      type: 'release',
      points: hold.points,
      before_points: acc.balance_points,
      after_points: after,
      ref_type: hold.ref_type,
      ref_id: hold.ref_id,
      idem_key: `${holdId}:release`,
      created_at: nowIso(),
    });
    return { ok: true, refunded: hold.points, balance: after };
  }

  /** 流水（分页） */
  entries(userId, { limit = 50, offset = 0 } = {}) {
    const all = db.find(ENT, (e) => e.user_id === userId).reverse();
    return all.slice(offset, offset + limit);
  }

  /** 对账：余额必须等于流水累计，否则说明有 bug */
  reconcile(userId) {
    const acc = this.ensureAccount(userId);
    const entries = db.find(ENT, (e) => e.user_id === userId);
    let sum = 0;
    for (const e of entries) sum += e.points; // points 已带符号，直接求和
    const ok = Math.abs(sum - acc.balance_points) < 0.001;
    return { ok, balance: acc.balance_points, entriesSum: round(sum, 4), diff: round(acc.balance_points - sum, 4) };
  }

  /** 报价：上游真实成本（元）→ 售价点数。给运营看毛利用 */
  quote({ upstreamUsd }) {
    const costCny = round(upstreamUsd * config.credit.usdCnyRate, 4);
    const priceCny = round(costCny * config.credit.markup, 4);
    return {
      costCny,
      priceCny,
      points: Math.max(1, Math.ceil(priceCny / config.credit.cnyPerPoint)),
      markup: config.credit.markup,
    };
  }
}

export const ledger = new Ledger();
export default ledger;
