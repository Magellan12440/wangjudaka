/**
 * 邀请裂变（V4.1）。
 *
 * 规则（一条一条都能被测试验证）：
 *  1. 每个用户有唯一专属邀请码（6 位，去混淆字母表），首次访问自动生成。
 *  2. 被邀请人必须是**新用户**：注册 24 小时内、且此刻还没有任何项目（老号不能补绑）。
 *  3. 一人只能被邀请一次：invitee_id 全局唯一。
 *  4. 不能自己邀请自己：邀请人 id 相同直接拒；同一台设备（device hash 相同）也拒。
 *  5. 同一 IP 24 小时内成功绑定超过阈值 → 该条判无效（防批量注册）。
 *  6. **奖励不注册即发**：被邀请人完成首个项目里程碑后才结算，避免「注册即薅」。
 *  7. 邀请人每日奖励笔数有上限；超限的保持 qualified，后续自动补发。
 *  8. 发放走 Ledger.grant，幂等键 invite:<inviteId>，重放不多发。
 *
 * 奖励口径：默认 1 点 = 1 元算力额度（config.invite.rewardPoints，可在后台改）。
 */
import crypto from 'node:crypto';
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import ledger from '../ledger/Ledger.js';

const CODES = 'invite_codes';
const INVITES = 'invites';
const SETTINGS = 'app_settings';
const USERS = 'users';
const PROJECTS = 'projects';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY = 86400_000;

export const INVITE_STATUS = {
  PENDING: 'pending',        // 已绑定，等被邀请人完成里程碑
  QUALIFIED: 'qualified',    // 达标但受每日上限限制，待补发
  REWARDED: 'rewarded',      // 已发奖
  REJECTED: 'rejected',      // 判定无效（附 reason）
};

export const REJECT_REASON = {
  SELF: 'self',
  SAME_DEVICE: 'same_device',
  ALREADY_INVITED: 'already_invited',
  NOT_NEW_USER: 'not_new_user',
  IP_FLOOD: 'ip_flood',
  CODE_INVALID: 'code_invalid',
  MANUAL: 'manual',
  INVITER_LIMIT: 'inviter_limit',
};

const REASON_TEXT = {
  self: '不能邀请自己',
  same_device: '同一设备注册的账号不能互相邀请',
  already_invited: '该账号已被邀请过',
  not_new_user: '仅限新注册且未创建过作品的账号',
  ip_flood: '同一网络环境短时间内注册过于集中',
  code_invalid: '邀请码不存在或已停用',
  manual: '管理员判定无效',
  inviter_limit: '邀请人奖励笔数已达上限',
};

const STATUS_TEXT = {
  pending: '待完成首部作品',
  qualified: '已达标（待发放）',
  rewarded: '已发放',
  rejected: '无效',
};

function hash(v) {
  if (!v) return null;
  return crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 16);
}

function randomCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function normalizeInviteCode(input) {
  return String(input ?? '').replace(/[\s-]/g, '').toUpperCase().slice(0, 12);
}

function maskName(name) {
  const s = String(name ?? '创作者');
  if (s.length <= 2) return `${s[0]}*`;
  return `${s.slice(0, 1)}${'*'.repeat(Math.min(3, s.length - 2))}${s.slice(-1)}`;
}

export class InviteService {
  constructor({ ledgerSvc = ledger } = {}) {
    this.ledger = ledgerSvc;
  }

  // ============================================================
  // 规则配置（默认取 env，可在管理后台覆盖）
  // ============================================================
  settings() {
    const saved = db.findOne(SETTINGS, (s) => s.id === 'invite') ?? {};
    const d = {
      reward_points: config.invite.rewardPoints,
      daily_reward_limit: config.invite.dailyRewardLimit,
      ip_daily_limit: config.invite.ipDailyLimit,
      require_milestone: config.invite.requireMilestone,
      bind_window_hours: config.invite.bindWindowHours,
    };
    return { ...d, ...Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in d && v !== undefined)) };
  }

  updateSettings(patch = {}) {
    const cur = this.settings();
    const next = { ...cur };
    if (patch.reward_points !== undefined) {
      const v = Number(patch.reward_points);
      if (!(v > 0 && v <= 1000)) fail(ERR.BAD_REQUEST, '奖励点数需在 0.01~1000 之间');
      next.reward_points = v;
    }
    if (patch.daily_reward_limit !== undefined) {
      const v = Number(patch.daily_reward_limit);
      if (!Number.isInteger(v) || v < 1 || v > 1000) fail(ERR.BAD_REQUEST, '每日奖励笔数上限需为 1~1000 的整数');
      next.daily_reward_limit = v;
    }
    if (patch.ip_daily_limit !== undefined) {
      const v = Number(patch.ip_daily_limit);
      if (!Number.isInteger(v) || v < 1 || v > 1000) fail(ERR.BAD_REQUEST, '同 IP 绑定上限需为 1~1000 的整数');
      next.ip_daily_limit = v;
    }
    if (patch.require_milestone !== undefined) next.require_milestone = Boolean(patch.require_milestone);
    if (patch.bind_window_hours !== undefined) {
      const v = Number(patch.bind_window_hours);
      if (!(v > 0 && v <= 720)) fail(ERR.BAD_REQUEST, '新用户绑定窗口需在 1~720 小时之间');
      next.bind_window_hours = v;
    }
    const row = db.findOne(SETTINGS, (s) => s.id === 'invite');
    if (row) db.update(SETTINGS, 'invite', { ...next, updated_at: nowIso() });
    else db.insert(SETTINGS, { id: 'invite', ...next, created_at: nowIso(), updated_at: nowIso() });
    logger.info('邀请规则已更新', next);
    return this.settings();
  }

  // ============================================================
  // 邀请码
  // ============================================================
  /** 取（或首次生成）某用户的专属邀请码 */
  ensureCode(userId) {
    if (!userId) fail(ERR.BAD_REQUEST, '缺少用户标识');
    const found = db.findOne(CODES, (c) => c.user_id === userId && c.status === 'active');
    if (found) return found;
    for (let i = 0; i < 50; i += 1) {
      const code = randomCode(6);
      if (db.findOne(CODES, (c) => c.code === code)) continue;
      const row = db.insert(CODES, {
        id: newId('ic'),
        code,
        user_id: userId,
        status: 'active',
        created_at: nowIso(),
      });
      logger.info('邀请码已生成', { userId });
      return row;
    }
    fail(ERR.BAD_REQUEST, '邀请码生成失败，请稍后重试');
  }

  codeOwner(codeInput) {
    const code = normalizeInviteCode(codeInput);
    if (!code) return null;
    return db.findOne(CODES, (c) => c.code === code && c.status === 'active');
  }

  // ============================================================
  // 绑定（注册时调用）
  // ============================================================
  /**
   * @returns {{ok:boolean, status:string, reason?:string, message:string, inviteId?:string}}
   */
  bindOnRegister({ inviteeId, code: codeInput, deviceId = null, ip = null }) {
    const st = this.settings();
    const code = normalizeInviteCode(codeInput);
    if (!code) fail(ERR.BAD_REQUEST, '请输入邀请码');

    const owner = this.codeOwner(code);
    if (!owner) return this.#reject({ inviteeId, code, reason: REJECT_REASON.CODE_INVALID });

    const inviter = db.findOne(USERS, (u) => u.id === owner.user_id);
    if (!inviter) return this.#reject({ inviteeId, code, inviterId: owner.user_id, reason: REJECT_REASON.CODE_INVALID });

    // 4. 自己不能邀请自己
    if (inviter.id === inviteeId) return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.SELF });

    // 3. 一人只能被邀请一次
    const dup = db.findOne(INVITES, (i) => i.invitee_id === inviteeId);
    if (dup) return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.ALREADY_INVITED, existed: dup });

    // 2. 必须是新用户：注册窗口内 + 还没有作品
    const invitee = db.findOne(USERS, (u) => u.id === inviteeId);
    if (!invitee) fail(ERR.BAD_REQUEST, '用户不存在');
    const ageMs = Date.now() - new Date(invitee.created_at).getTime();
    if (ageMs > st.bind_window_hours * 3600_000) {
      return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.NOT_NEW_USER });
    }
    if (db.count(PROJECTS, (p) => p.user_id === inviteeId) > 0) {
      return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.NOT_NEW_USER });
    }

    // 4b. 同设备互邀（一台手机注册两个号互相邀请）
    const devHash = hash(deviceId);
    if (devHash && inviter.device_hash && devHash === inviter.device_hash) {
      return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.SAME_DEVICE, devHash });
    }

    // 5. 同 IP 频控
    const ipHash = hash(ip);
    if (ipHash) {
      const since = Date.now() - DAY;
      const sameIp = db.find(INVITES, (i) => i.ip_hash === ipHash
        && i.status !== INVITE_STATUS.REJECTED
        && new Date(i.created_at).getTime() >= since);
      if (sameIp.length >= st.ip_daily_limit) {
        return this.#reject({ inviteeId, code, inviterId: inviter.id, reason: REJECT_REASON.IP_FLOOD, ipHash });
      }
    }

    const invite = db.insert(INVITES, {
      id: newId('inv'),
      inviter_id: inviter.id,
      invitee_id: inviteeId,
      code,
      status: INVITE_STATUS.PENDING,
      reason: null,
      reward_points: st.reward_points,
      device_hash: devHash,
      ip_hash: ipHash,
      invitee_created_at: invitee.created_at,
      qualified_at: null,
      rewarded_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    // 记录下来源设备，供后续自邀判定
    if (devHash) db.update(USERS, inviteeId, { device_hash: devHash });

    logger.info('邀请关系已建立', { inviteId: invite.id, inviter: inviter.id });
    if (!st.require_milestone) {
      const r = this.#settle(invite.id);
      return {
        ok: r.status === INVITE_STATUS.REWARDED,
        status: r.status,
        reason: r.reason,
        message: r.status === INVITE_STATUS.REWARDED ? `邀请奖励 ${st.reward_points} 点已到账` : (REASON_TEXT[r.reason] ?? '待发放'),
        inviteId: invite.id,
      };
    }
    return {
      ok: true,
      status: INVITE_STATUS.PENDING,
      message: '邀请已绑定，好友完成首部作品后奖励自动到账',
      inviteId: invite.id,
    };
  }

  #reject({ inviteeId, code, inviterId = null, reason, devHash = null, ipHash = null, existed = null }) {
    // 已绑定过的重复调用直接返回原记录，不重复落无效记录
    if (existed) {
      return { ok: false, status: existed.status, reason: REASON_TEXT[existed.reason] ?? '已绑定过邀请关系', message: REASON_TEXT[REJECT_REASON.ALREADY_INVITED], inviteId: existed.id };
    }
    const row = db.insert(INVITES, {
      id: newId('inv'),
      inviter_id: inviterId,
      invitee_id: inviteeId,
      code,
      status: INVITE_STATUS.REJECTED,
      reason,
      reward_points: 0,
      device_hash: devHash,
      ip_hash: ipHash,
      qualified_at: null,
      rewarded_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    logger.info('邀请判定无效', { inviteId: row.id, reason });
    return { ok: false, status: INVITE_STATUS.REJECTED, reason: REASON_TEXT[reason] ?? reason, message: REASON_TEXT[reason] ?? '邀请无效', inviteId: row.id };
  }

  // ============================================================
  // 里程碑 → 结算
  // ============================================================
  /**
   * 被邀请人完成关键行为（默认：创建首个项目）时调用。
   * 幂等：已 rewarded 的直接返回。
   */
  markMilestone({ userId, milestone = 'project_created' }) {
    if (!userId) return null;
    const invite = db.findOne(INVITES, (i) => i.invitee_id === userId
      && [INVITE_STATUS.PENDING, INVITE_STATUS.QUALIFIED].includes(i.status));
    if (!invite) return null;
    if (!invite.qualified_at) {
      db.update(INVITES, invite.id, { qualified_at: nowIso(), milestone, updated_at: nowIso() });
    }
    return this.#settle(invite.id);
  }

  /** 补发：把某邀请人名下 qualified（受每日上限限制）的记录按顺序发放 */
  retryQualified(inviterId) {
    const rows = db.find(INVITES, (i) => i.inviter_id === inviterId && i.status === INVITE_STATUS.QUALIFIED)
      .sort((a, b) => String(a.qualified_at ?? a.created_at).localeCompare(String(b.qualified_at ?? b.created_at)));
    return rows.map((r) => this.#settle(r.id));
  }

  #rewardedToday(inviterId) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return db.count(INVITES, (i) => i.inviter_id === inviterId
      && i.status === INVITE_STATUS.REWARDED
      && i.rewarded_at
      && new Date(i.rewarded_at).getTime() >= start.getTime());
  }

  #settle(inviteId) {
    const inv = db.findOne(INVITES, (i) => i.id === inviteId);
    if (!inv) fail(ERR.NOT_FOUND, '邀请记录不存在');
    if (inv.status === INVITE_STATUS.REWARDED) return { status: inv.status, reason: null, points: inv.reward_points };
    if (inv.status === INVITE_STATUS.REJECTED) return { status: inv.status, reason: inv.reason, points: 0 };

    const st = this.settings();
    const limit = st.daily_reward_limit;
    if (this.#rewardedToday(inv.inviter_id) >= limit) {
      db.update(INVITES, inv.id, { status: INVITE_STATUS.QUALIFIED, reason: REJECT_REASON.INVITER_LIMIT, updated_at: nowIso() });
      logger.info('邀请奖励受每日上限限制，已挂起', { inviteId: inv.id });
      return { status: INVITE_STATUS.QUALIFIED, reason: REJECT_REASON.INVITER_LIMIT, points: 0 };
    }

    const points = Number(inv.reward_points ?? st.reward_points) || st.reward_points;
    const r = this.ledger.grant({
      userId: inv.inviter_id,
      points,
      idemKey: `invite:${inv.id}`,
      channel: 'invite_reward',
      refType: 'invite',
      refId: inv.id,
      note: '邀请好友奖励',
    });
    db.update(INVITES, inv.id, {
      status: INVITE_STATUS.REWARDED,
      reward_points: points,
      rewarded_at: nowIso(),
      updated_at: nowIso(),
      ledger_entry_id: r.entry?.id ?? null,
    });
    logger.info('邀请奖励已发放', { inviteId: inv.id, inviter: inv.inviter_id, points });
    return { status: INVITE_STATUS.REWARDED, reason: null, points };
  }

  // ============================================================
  // 查询
  // ============================================================
  /** 我的邀请面板：邀请码 + 统计 + 明细 */
  dashboard(userId) {
    if (!userId) fail(ERR.BAD_REQUEST, '缺少用户标识');
    const code = this.ensureCode(userId);
    const st = this.settings();
    const rows = db.find(INVITES, (i) => i.inviter_id === userId);
    const rewarded = rows.filter((r) => r.status === INVITE_STATUS.REWARDED);
    const users = new Map(db.find(USERS).map((u) => [u.id, u]));
    return {
      invite_code: code.code,
      reward_points: st.reward_points,
      require_milestone: st.require_milestone,
      stats: {
        total: rows.filter((r) => r.status !== INVITE_STATUS.REJECTED).length,
        pending: rows.filter((r) => r.status === INVITE_STATUS.PENDING).length,
        qualified: rows.filter((r) => r.status === INVITE_STATUS.QUALIFIED).length,
        rewarded: rewarded.length,
        rejected: rows.filter((r) => r.status === INVITE_STATUS.REJECTED).length,
        points_earned: rewarded.reduce((s, r) => s + (r.reward_points ?? 0), 0),
      },
      items: rows
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          name: maskName(users.get(r.invitee_id)?.nickname),
          status: r.status,
          status_text: r.status === INVITE_STATUS.REJECTED ? (REASON_TEXT[r.reason] ?? '无效') : STATUS_TEXT[r.status],
          points: r.status === INVITE_STATUS.REWARDED ? r.reward_points : 0,
          created_at: r.created_at,
        })),
      rules: [
        `好友通过你的邀请码注册，且完成首部作品后，你得 ${st.reward_points} 点算力额度（1 点 = 1 元）。`,
        '同一账号只能被邀请一次；同一设备、同一网络批量注册不计入有效邀请。',
        `邀请人每日最多结算 ${st.daily_reward_limit} 笔奖励，超出部分次日自动补发。`,
        '奖励由系统自动发放，无需手动领取；作弊行为会被撤销并追回。',
      ],
    };
  }

  /** 管理端列表 */
  adminList({ status = null, limit = 100, offset = 0 } = {}) {
    const users = new Map(db.find(USERS).map((u) => [u.id, u]));
    let all = db.find(INVITES, (i) => !status || i.status === status);
    all = all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return {
      total: all.length,
      items: all.slice(offset, offset + Number(limit || 100)).map((r) => ({
        ...r,
        inviter_name: users.get(r.inviter_id)?.nickname ?? r.inviter_id,
        invitee_name: users.get(r.invitee_id)?.nickname ?? r.invitee_id,
        reason_text: r.reason ? (REASON_TEXT[r.reason] ?? r.reason) : null,
      })),
    };
  }

  adminStats() {
    const all = db.find(INVITES);
    const rewarded = all.filter((r) => r.status === INVITE_STATUS.REWARDED);
    const rejected = all.filter((r) => r.status === INVITE_STATUS.REJECTED);
    const byReason = {};
    for (const r of rejected) byReason[r.reason ?? 'unknown'] = (byReason[r.reason ?? 'unknown'] ?? 0) + 1;
    return {
      total: all.length,
      pending: all.filter((r) => r.status === INVITE_STATUS.PENDING).length,
      qualified: all.filter((r) => r.status === INVITE_STATUS.QUALIFIED).length,
      rewarded: rewarded.length,
      rejected: rejected.length,
      pointsIssued: rewarded.reduce((s, r) => s + (r.reward_points ?? 0), 0),
      invitees: new Set(all.filter((r) => r.status !== INVITE_STATUS.REJECTED).map((r) => r.invitee_id)).size,
      rejectReasons: Object.entries(byReason).map(([reason, count]) => ({ reason, text: REASON_TEXT[reason] ?? reason, count })),
      settings: this.settings(),
    };
  }

  /** 管理端：人工判定无效（已发奖则同时从余额扣回） */
  adminReject(inviteId, reason = REJECT_REASON.MANUAL) {
    const inv = db.findOne(INVITES, (i) => i.id === inviteId);
    if (!inv) fail(ERR.NOT_FOUND, '邀请记录不存在');
    if (inv.status === INVITE_STATUS.REJECTED) return { ok: true, duplicated: true };
    if (inv.status === INVITE_STATUS.REWARDED) {
      // 追回：负数调整，余额最多扣到 0，对账仍平衡
      this.ledger.adjust({
        userId: inv.inviter_id,
        points: -Math.abs(inv.reward_points ?? 0),
        idemKey: `invite:${inv.id}:revoke`,
        channel: 'invite_reward_revoke',
        refType: 'invite',
        refId: inv.id,
        note: '邀请奖励撤销',
      });
    }
    db.update(INVITES, inviteId, { status: INVITE_STATUS.REJECTED, reason, updated_at: nowIso() });
    logger.info('邀请被管理员判定无效', { inviteId, reason });
    return { ok: true, duplicated: false };
  }
}

export const inviteService = new InviteService();
export default inviteService;
