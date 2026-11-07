/**
 * 管理员账号体系（V4.7）。
 *
 * 之前管理端只有一条路：X-Admin-Token 头 + 网页 admin.html。
 * 站长在手机上根本进不去 —— 要么开电脑，要么放弃。
 *
 * 这一层把「管理员」变成一种**账号属性**：users.role === 'admin'。
 * 于是管理员可以在小程序里正常登录，「我的」页多一个「管理后台」，
 * 普通用户根本看不到这个入口（前端按 is_admin 渲染，后端每个管理接口再校验一次）。
 *
 * 三条硬约束：
 *  1. 管理员密码与普通用户同口径（scrypt + 盐），不另开一条弱路径。
 *  2. 系统里第一个管理员由「一次性激活码」创建，激活码只打印在服务端日志里，
 *     不通过任何公开接口返回 —— 否则谁先扫到 /api/admin/bootstrap 谁就是站长。
 *  3. 已配置 ADMIN_TOKEN 的老部署不受影响：令牌仍然能用，等价于超级管理员。
 */
import crypto from 'node:crypto';
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, round } from '../core/util.js';
import { logger } from '../core/redact.js';
import { authService, normalizePhone, maskPhone } from '../auth/AuthService.js';
import ledger from '../ledger/Ledger.js';

const USERS = 'users';
const PROJECTS = 'projects';
const SETTINGS = 'app_settings';
const BOOTSTRAP_KEY = 'admin_bootstrap';

/** 激活码字母表：去掉易混淆的 0/O/1/I/L */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function fmtCode(norm) {
  return String(norm).replace(/(.{5})(?=.)/g, '$1-');
}

function normalizeCode(input) {
  return String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
}

function timingEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readSetting(key) {
  const row = db.findOne(SETTINGS, (s) => s.key === key);
  return row?.value ?? null;
}

function writeSetting(key, value) {
  const row = db.findOne(SETTINGS, (s) => s.key === key);
  if (row) db.update(SETTINGS, row.id, { value, updated_at: nowIso() });
  else db.insert(SETTINGS, { id: newId('set'), key, value, updated_at: nowIso() });
  return value;
}

export class AdminConsole {
  constructor({ ledgerSvc = ledger } = {}) {
    this.ledger = ledgerSvc;
  }

  // ============================================================
  // 鉴权
  // ============================================================
  /**
   * 管理接口统一入口：
   *  a) X-Admin-Token 与 ADMIN_TOKEN 常量时间比对（老部署 / 运维脚本）
   *  b) Authorization: Bearer <session> 且该用户 role === 'admin'
   * 两者都不满足 → 403，不区分「没配令牌」和「令牌错」对外细节。
   */
  assertAdmin(req) {
    const token = req?.headers?.['x-admin-token'] ?? req?.headers?.['X-Admin-Token'];
    const expect = config.admin.token;
    if (expect && timingEqual(token, expect)) return { mode: 'token', userId: null };

    const user = authService.optionalUser(req);
    if (user && user.role === 'admin' && user.status !== 'banned') {
      return { mode: 'account', userId: user.id, user };
    }
    fail(ERR.ADMIN_UNAUTHORIZED, '需要管理员权限');
    return null;
  }

  /** 兼容旧签名：assertAdmin(adminTokenHeader) */
  assertAdminToken(token) {
    const expect = config.admin.token;
    if (!expect) fail(ERR.ADMIN_UNAUTHORIZED, '服务端未配置 ADMIN_TOKEN，管理端不可用');
    if (!timingEqual(token, expect)) fail(ERR.ADMIN_UNAUTHORIZED, '管理员令牌无效');
    return true;
  }

  // ============================================================
  // 首管理员引导
  // ============================================================
  adminCount() {
    return db.find(USERS, (u) => u.role === 'admin').length;
  }

  /**
   * 启动时调用：
   *  - 配了 ADMIN_PHONE + ADMIN_PASSWORD → 直接建/校正管理员（运维最省事的一条路）
   *  - 否则若一个管理员都没有 → 生成一次性激活码，只打到日志里
   * 幂等：已有管理员时不再生成新码。
   */
  ensureBootstrap() {
    const phone = String(config.admin.phone ?? '').trim();
    const password = String(config.admin.password ?? '');

    if (phone && password) {
      try {
        const p = normalizePhone(phone);
        const exist = db.findOne(USERS, (u) => u.phone === p);
        if (exist) {
          if (exist.role !== 'admin') db.update(USERS, exist.id, { role: 'admin' });
          logger.info('管理员账号已就绪（来自环境变量）', { phone: maskPhone(p) });
        } else {
          authService.createAccount({ phone: p, password, nickname: '管理员', role: 'admin' });
          logger.info('管理员账号已创建（来自环境变量）', { phone: maskPhone(p) });
        }
        return { mode: 'env', created: !exist };
      } catch (e) {
        logger.error('管理员账号初始化失败', { error: e.message });
      }
    }

    if (this.adminCount() > 0) return { mode: 'existing', created: false };

    const cur = readSetting(BOOTSTRAP_KEY);
    if (cur && !cur.used && cur.code) return { mode: 'code', created: false };

    const code = randomCode(10);
    writeSetting(BOOTSTRAP_KEY, { code, created_at: nowIso(), used: false, used_at: null });
    // 只出现在服务端日志：云托管控制台「日志」里搜「管理员激活码」即可
    logger.warn('管理员激活码（仅本次可见，用于创建第一个管理员账号）', { code: fmtCode(code) });
    return { mode: 'code', created: true };
  }

  /** 激活状态：公开接口，只回答「还需不需要激活」，绝不回吐激活码 */
  bootstrapStatus() {
    const has = this.adminCount() > 0;
    const setting = readSetting(BOOTSTRAP_KEY);
    return {
      has_admin: has,
      need_bootstrap: !has,
      // 有码但没人用：告诉前端「去服务端日志里找激活码」，不告诉他码是什么
      code_issued: Boolean(setting && !setting.used && setting.code),
      hint: has
        ? '管理员已就绪，用管理员手机号与密码登录'
        : '首次使用：在服务端日志中搜索「管理员激活码」，用激活码创建管理员账号',
    };
  }

  /** 用激活码创建第一个管理员 */
  bootstrap({ code, phone, password, nickname = null } = {}) {
    if (this.adminCount() > 0) {
      fail('ADMIN_ALREADY_BOOTSTRAPPED', '系统已有管理员，请直接登录');
    }
    const setting = readSetting(BOOTSTRAP_KEY);
    if (!setting || !setting.code) {
      fail('ADMIN_BOOTSTRAP_UNAVAILABLE', '未生成激活码：请确认服务端已正常启动并查看日志');
    }
    if (setting.used) fail('ADMIN_BOOTSTRAP_USED', '激活码已被使用，请直接登录');
    if (!timingEqual(normalizeCode(code), setting.code)) {
      fail('ADMIN_BOOTSTRAP_INVALID', '激活码不对，请核对服务端日志里的那一串');
    }
    const user = authService.createAccount({ phone, password, nickname: nickname || '管理员', role: 'admin' });
    writeSetting(BOOTSTRAP_KEY, { ...setting, used: true, used_at: nowIso(), used_by: user.id });
    logger.info('管理员账号已通过激活码创建', { phone: maskPhone(normalizePhone(phone)) });
    const session = authService.loginByPassword({ phone, password });
    return { token: session.token, user: session.user, mode: 'bootstrap' };
  }

  /** 管理员登录：先按普通账号验密码，再核角色 */
  login({ phone, password } = {}) {
    const session = authService.loginByPassword({ phone, password });
    if (session.user.role !== 'admin') {
      fail(ERR.ADMIN_UNAUTHORIZED, '这个账号不是管理员');
    }
    if (session.user.status === 'banned') {
      fail(ERR.ADMIN_UNAUTHORIZED, '账号已停用');
    }
    return { ...session, mode: 'admin_login' };
  }

  // ============================================================
  // 用户管理
  // ============================================================
  #accounts() {
    return db.find('accounts');
  }

  #balanceOf(userId) {
    return ledger.balance(userId);
  }

  listUsers({ q = '', role = '', limit = 30, offset = 0 } = {}) {
    const keyword = String(q ?? '').trim().toLowerCase();
    const max = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const skip = Math.max(Number(offset) || 0, 0);

    let users = db.find(USERS).sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    if (role === 'admin') users = users.filter((u) => u.role === 'admin');
    if (role === 'user') users = users.filter((u) => u.role !== 'admin');
    if (keyword) {
      users = users.filter((u) => {
        const hay = [u.id, u.nickname, u.phone, u.phone_masked].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(keyword);
      });
    }

    const total = users.length;
    const page = users.slice(skip, skip + max);

    const projCount = new Map();
    for (const p of db.find(PROJECTS)) projCount.set(p.user_id, (projCount.get(p.user_id) ?? 0) + 1);

    return {
      total,
      limit: max,
      offset: skip,
      items: page.map((u) => ({
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar ?? null,
        phone_masked: maskPhone(u.phone),
        role: u.role === 'admin' ? 'admin' : 'user',
        status: u.status === 'banned' ? 'banned' : 'active',
        pwd_set: Boolean(u.password_hash),
        balance_points: this.#balanceOf(u.id),
        projects: projCount.get(u.id) ?? 0,
        created_at: u.created_at ?? null,
        last_login_at: u.last_login_at ?? null,
      })),
    };
  }

  userDetail(userId) {
    const u = db.findOne(USERS, (x) => x.id === userId);
    if (!u) fail(ERR.NOT_FOUND, '用户不存在');
    const projects = db.find(PROJECTS, (p) => p.user_id === userId);
    const entries = db.find('ledger_entries', (e) => e.user_id === userId)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, 20);
    return {
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar ?? null,
      phone_masked: maskPhone(u.phone),
      role: u.role === 'admin' ? 'admin' : 'user',
      status: u.status === 'banned' ? 'banned' : 'active',
      balance_points: this.#balanceOf(userId),
      created_at: u.created_at ?? null,
      last_login_at: u.last_login_at ?? null,
      projects: projects.map((p) => ({ id: p.id, title: p.title, label: p.index_label ?? '', created_at: p.created_at ?? null })),
      entries: entries.map((e) => ({
        id: e.id,
        type: e.type,
        delta: e.delta ?? e.points ?? null,
        balance_after: e.balance_after ?? null,
        note: e.note ?? null,
        created_at: e.created_at ?? null,
      })),
    };
  }

  /** 人工调账：正数补偿、负数扣减；走 Ledger.adjust（幂等 + 有流水） */
  adjustPoints({ userId, delta, note = null, idemKey = null } = {}) {
    const u = db.findOne(USERS, (x) => x.id === userId);
    if (!u) fail(ERR.NOT_FOUND, '用户不存在');
    const d = Number(delta);
    if (!Number.isFinite(d) || !Number.isInteger(d) || d === 0) {
      fail(ERR.BAD_REQUEST, '调整值必须是非零整数');
    }
    if (Math.abs(d) > 1_000_000) fail(ERR.BAD_REQUEST, '单次调整不能超过 100 万点');
    const before = this.#balanceOf(userId);
    if (before + d < 0) fail(ERR.BAD_REQUEST, `扣减后余额会变成负数（当前 ${before} 点）`);

    const key = idemKey || `admin_adjust:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const r = this.ledger.adjust({
      userId,
      points: d,
      idemKey: key,
      channel: 'admin_manual',
      refType: 'admin',
      refId: null,
      note: note ? String(note).slice(0, 120) : `管理员调整 ${d > 0 ? '+' : ''}${d} 点`,
    });
    logger.info('管理员调整点数', { userId, delta: d, balance: r.balance });
    return { balance: r.balance, delta: d, duplicated: r.duplicated === true };
  }

  setUserStatus({ userId, status, actorId = null } = {}) {
    const u = db.findOne(USERS, (x) => x.id === userId);
    if (!u) fail(ERR.NOT_FOUND, '用户不存在');
    if (status !== 'active' && status !== 'banned') fail(ERR.BAD_REQUEST, '状态只能是 active 或 banned');
    if (status === 'banned' && u.role === 'admin') fail(ERR.BAD_REQUEST, '不能停用管理员账号');
    if (userId === actorId) fail(ERR.BAD_REQUEST, '不能停用自己');
    db.update(USERS, userId, { status, status_updated_at: nowIso() });
    return { id: userId, status };
  }

  /** 提升/降级管理员；禁止把最后一个管理员降级（会把系统锁死） */
  setUserRole({ userId, role, actorId = null } = {}) {
    const u = db.findOne(USERS, (x) => x.id === userId);
    if (!u) fail(ERR.NOT_FOUND, '用户不存在');
    const next = role === 'admin' ? 'admin' : 'user';
    if (next === 'user' && u.role === 'admin') {
      if (this.adminCount() <= 1) fail(ERR.BAD_REQUEST, '至少要保留一个管理员');
      if (userId === actorId) fail(ERR.BAD_REQUEST, '不能取消自己的管理员身份');
    }
    authService.setRole(userId, next);
    return { id: userId, role: next };
  }

  /** 管理端概览：一屏看清「有多少人、多少剧、钱到哪去了」 */
  stats() {
    const users = db.find(USERS);
    const projects = db.find(PROJECTS);
    const accounts = this.#accounts();
    const today = new Date().toISOString().slice(0, 10);
    const gens = db.find('generations');
    return {
      users: {
        total: users.length,
        admins: users.filter((u) => u.role === 'admin').length,
        banned: users.filter((u) => u.status === 'banned').length,
        today: users.filter((u) => String(u.created_at ?? '').startsWith(today)).length,
      },
      projects: {
        total: projects.length,
        today: projects.filter((p) => String(p.created_at ?? '').startsWith(today)).length,
      },
      credits: {
        balance_total: round(accounts.reduce((s, a) => s + (Number(a.balance_points) || 0), 0), 2),
        recharged_total: round(accounts.reduce((s, a) => s + (Number(a.total_recharged) || 0), 0), 2),
        spent_total: round(accounts.reduce((s, a) => s + (Number(a.total_spent) || 0), 0), 2),
        generations: gens.length,
      },
    };
  }
}

export const adminConsole = new AdminConsole();
export default adminConsole;
