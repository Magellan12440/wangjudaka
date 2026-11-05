/**
 * 登录态服务（V3.5）：wx.login(code) → openid → 用户 → 自签 session token。
 *
 * 设计：
 *  1. 用户主键是 openid（微信生态唯一）；本地 users 集合做 openid → userId 映射。
 *  2. session token 为 HMAC 自签（userId.expiresAt.sig），无状态可验签；
 *     签名密钥默认进程内随机（重启即失效），生产用 SESSION_SECRET 固定。
 *  3. 未配置 WX_APPID 时 wechatClient 自动走 mock：同一 code → 同一 mock openid，
 *     本地联调链路完整可走，响应里显式带 mode:'mock'。
 *
 * 安全：openid 不返回给前端以外的任何第三方；token 只在 Authorization 头传递。
 */
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { ledger } from '../ledger/Ledger.js';
import wechatClient from '../wechat/WechatClient.js';

const USERS = 'users';
const SECRET = config.wechat.sessionSecret || crypto.randomBytes(32).toString('hex');

class AuthService {
  /**
   * 登录/注册（幂等）。
   * @returns {Promise<{token:string, user:object, mode:string, isNewUser:boolean}>}
   */
  async login({ code, nickname = null, avatar = null } = {}) {
    const sess = await wechatClient.code2session(code);
    let user = db.findOne(USERS, (u) => u.openid === sess.openid);
    let isNewUser = false;
    if (!user) {
      user = db.insert(USERS, {
        id: newId('user'),
        openid: sess.openid,
        unionid: sess.unionid,
        nickname: nickname ?? `创作者_${sess.openid.slice(-6)}`,
        avatar: avatar ?? null,
        created_at: nowIso(),
        last_login_at: nowIso(),
      });
      ledger.ensureAccount(user.id); // 开户：登录即建点数账本
      isNewUser = true;
    } else {
      db.update(USERS, user.id, {
        last_login_at: nowIso(),
        ...(nickname ? { nickname } : {}),
        ...(avatar ? { avatar } : {}),
      });
      user = db.findOne(USERS, (u) => u.id === user.id);
    }
    const token = this.#sign(user.id);
    return {
      token,
      mode: sess.mode,
      isNewUser,
      user: this.publicUser(user),
    };
  }

  /** 自签 token：base64url(payload).sig */
  #sign(userId) {
    const expiresAt = Date.now() + config.wechat.sessionTtlMs;
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: expiresAt })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  /** 验签 → { userId } | null */
  verify(token) {
    if (!token || typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data.uid || Date.now() > data.exp) return null;
      return { userId: data.uid };
    } catch {
      return null;
    }
  }

  /** 从请求里取用户（Authorization: Bearer xxx）；无 token → fail 401 */
  requireUser(req) {
    const auth = req?.headers?.authorization ?? req?.headers?.Authorization ?? '';
    const token = String(auth).replace(/^Bearer\s+/i, '');
    const v = this.verify(token);
    if (!v) fail(ERR.AUTH_TOKEN_INVALID, '登录态无效或已过期，请重新登录');
    const user = db.findOne(USERS, (u) => u.id === v.userId);
    if (!user) fail(ERR.AUTH_TOKEN_INVALID, '用户不存在');
    return user;
  }

  /** 可选登录：有 token 返回用户，无则 null */
  optionalUser(req) {
    try {
      return this.requireUser(req);
    } catch {
      return null;
    }
  }

  /** 对外用户信息（不含 openid 等内部字段） */
  publicUser(user) {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      balance_points: ledger.balance(user.id),
      // 新用户默认昵称是「创作者_xxxxxx」，头像为空 —— 前端据此提示补全资料
      profile_complete: Boolean(user.avatar) && !/^创作者_/.test(String(user.nickname ?? '')),
      created_at: user.created_at,
    };
  }

  /** 补全资料（昵称 / 头像）：只允许改自己的，长度做硬限制 */
  updateProfile(userId, { nickname = null, avatar = null } = {}) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.AUTH_TOKEN_INVALID, '用户不存在');
    const patch = {};
    if (nickname !== null && nickname !== undefined) {
      const n = String(nickname).trim();
      if (!n) fail(ERR.BAD_REQUEST, '昵称不能为空');
      patch.nickname = n.slice(0, 20);
    }
    if (avatar !== null && avatar !== undefined) {
      const a = String(avatar).trim();
      if (a && !/^(https?:\/\/|wxfile:\/\/|cloud:\/\/|\/media\/)/.test(a)) {
        fail(ERR.BAD_REQUEST, '头像地址不合法');
      }
      patch.avatar = a.slice(0, 512) || null;
    }
    if (!Object.keys(patch).length) fail(ERR.BAD_REQUEST, '没有要更新的资料');
    db.update(USERS, userId, { ...patch, profile_updated_at: nowIso() });
    return this.publicUser(db.findOne(USERS, (u) => u.id === userId));
  }
}

export const authService = new AuthService();
export default authService;
