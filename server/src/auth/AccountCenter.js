/**
 * 账号中心（V4.9）：把「账号主体真正关心的四件事」收成一个模块。
 *
 *  1. 我是谁：手机号、密码、登录方式、注册时间；
 *  2. 安全：登录设备、退出全部设备、注销账号；
 *  3. 额度：余额、今日/近 7 天/近 30 天消耗、花在哪些剧上、余额提醒阈值；
 *  4. 记录：最近的流水与登录。
 *
 * 这里只做**读**和**偏好设置**；改密、踢设备、注销等有副作用的动作留在 AuthService，
 * 避免把凭据逻辑散到两个文件里。
 */
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import { nowIso } from '../core/util.js';
import { ledger } from '../ledger/Ledger.js';
import authService from './AuthService.js';

const USERS = 'users';

const dayStart = (offsetDays = 0) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
};

const round1 = (n) => Math.round(Number(n) * 10) / 10;

class AccountCenter {
  /** 账号总览：身份 + 安全状态 + 额度概览，一次拿全 */
  overview(userId, sid = null) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.NOT_FOUND, '用户不存在');
    const acc = ledger.ensureAccount(userId);
    return {
      user: authService.publicUser(user),
      security: {
        has_phone: Boolean(user.phone),
        phone_masked: authService.publicUser(user).phone_masked,
        phone_verified: Boolean(user.phone_verified),
        pwd_set: Boolean(user.password_hash),
        pwd_updated_at: user.password_updated_at ?? null,
        last_login_at: user.last_login_at ?? null,
        sms_available: Boolean(config.sms?.provider),
        sms_note: config.sms?.provider
          ? '短信通道已接入'
          : '短信通道未接入：验证码登录与找回密码暂不可用，请用微信登录或手机号 + 密码',
      },
      balance: {
        points: round1(acc.balance_points),
        total_recharged: round1(acc.total_recharged ?? 0),
        total_spent: round1(acc.total_spent ?? 0),
        cny_per_point: config.credit.cnyPerPoint,
      },
      sessions: authService.sessions(userId, sid),
      quota: this.quota(userId),
    };
  }

  /** 额度与用量：按天、按项目拆开，让「钱花哪了」说清楚 */
  quota(userId) {
    const acc = ledger.ensureAccount(userId);
    const rows = db.find('ledger_entries', (e) => e.user_id === userId);
    const t0 = dayStart(0);
    const t7 = dayStart(6);
    const t30 = dayStart(29);

    let today = 0;
    let week = 0;
    let month = 0;
    const byProject = new Map();
    const byType = new Map();

    for (const e of rows) {
      const ts = new Date(e.created_at).getTime();
      const p = Number(e.points) || 0;
      if (p >= 0) continue;
      const spend = -p;
      if (ts >= t0) today += spend;
      if (ts >= t7) week += spend;
      if (ts >= t30) month += spend;
      if (e.ref_id && e.ref_type && /project|hold|job/i.test(String(e.ref_type))) {
        byProject.set(e.ref_id, (byProject.get(e.ref_id) || 0) + spend);
      }
      byType.set(e.type || 'other', (byType.get(e.type || 'other') || 0) + spend);
    }

    const user = db.findOne(USERS, (u) => u.id === userId);
    const alert = Number(user?.low_balance_alert);
    return {
      balance: round1(acc.balance_points),
      today: round1(today),
      week: round1(week),
      month: round1(month),
      // 余额提醒阈值：余额低于它就在首页提示，0 表示关闭
      alert_threshold: Number.isFinite(alert) ? alert : 20,
      // 按项目拆分：ID 由调用方补标题，这里只给数字
      by_project: [...byProject.entries()]
        .map(([id, points]) => ({ project_id: id, points: round1(points) }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 5),
      by_type: [...byType.entries()].map(([type, points]) => ({ type, points: round1(points) })),
      // 一次生成大概够多少：给「余额还能撑几集」一个直觉
      avg_per_episode: this.#avgPerEpisode(rows),
    };
  }

  #avgPerEpisode(rows) {
    const spends = rows.filter((e) => (Number(e.points) || 0) < 0).map((e) => -Number(e.points));
    if (!spends.length) return 0;
    const total = spends.reduce((a, b) => a + b, 0);
    return round1(total / spends.length);
  }

  /** 保存额度提醒阈值（0 = 关闭） */
  setAlert(userId, { threshold } = {}) {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 0) fail(ERR.BAD_REQUEST, '提醒阈值不合法');
    if (n > 100000) fail(ERR.BAD_REQUEST, '提醒阈值过大');
    db.update(USERS, userId, { low_balance_alert: round1(n), alert_updated_at: nowIso() });
    return { alert_threshold: round1(n) };
  }
}

export const accountCenter = new AccountCenter();
export default accountCenter;
