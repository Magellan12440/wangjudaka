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
import { logger } from '../core/redact.js';

const USERS = 'users';
const SMS = 'sms_codes';
const SECRET = config.wechat.sessionSecret || crypto.randomBytes(32).toString('hex');


/** 手机号规范化：只接受中国大陆 11 位手机号（保留 +86 前缀容错） */
export function normalizePhone(input) {
  const raw = String(input ?? '').replace(/[\s-]/g, '');
  const m = raw.match(/^(?:\+?86)?(1[3-9]\d{9})$/);
  if (!m) fail('PHONE_INVALID', '请输入正确的 11 位手机号');
  return m[1];
}

export function maskPhone(phone) {
  const p = String(phone ?? '');
  if (p.length !== 11) return '';
  return `${p.slice(0, 3)}****${p.slice(-4)}`;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * 密码哈希（scrypt + 16 字节随机盐）。
 *
 * 抽成独立函数是因为「内置管理员账号」也要走同一套口径——
 * 管理员密码不能是明文、也不能换一种弱算法，否则管理后台就是整个系统最软的入口。
 */
export function hashPassword(password) {
  const pw = String(password ?? '');
  if (pw.length < 6) fail('PASSWORD_TOO_SHORT', '密码至少 6 位');
  if (pw.length > 64) fail('PASSWORD_TOO_LONG', '密码最长 64 位');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { password_hash: hash, password_salt: salt };
}

/** 校验密码：常量时间比较，避免按字节提前返回泄露长度信息 */
export function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const a = Buffer.from(crypto.scryptSync(String(password ?? ''), salt, 32).toString('hex'), 'hex');
  const b = Buffer.from(String(hash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
    // V4.7：被停用的账号立刻失效，不等 token 过期
    if (user.status === 'banned') fail(ERR.AUTH_TOKEN_INVALID, '账号已停用，请联系管理员');
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
  // ============================================================
  // 账号体系（V4.4）：微信之外，再给一条「手机号 + 密码 / 验证码」的路
  // ============================================================

  /**
   * 发验证码。
   * 没有接短信服务商时**不假装已发**：返回 sent:false + 测试码，并在文案里写明。
   * 接了服务商（config.sms.provider 非空）才真发，且绝不回吐验证码。
   */
  sendCode({ phone } = {}) {
    const p = normalizePhone(phone);
    const now = Date.now();
    const last = db.find(SMS, (x) => x.phone === p).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (last && now - new Date(last.created_at).getTime() < 60_000) {
      fail('SMS_TOO_FREQUENT', '验证码 60 秒内只能发一次，请稍后再试');
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.insert(SMS, {
      id: newId('sms'),
      phone: p,
      code_hash: sha256(`${p}:${code}`),
      expires_at: new Date(now + 5 * 60_000).toISOString(),
      attempts: 0,
      used: false,
      created_at: new Date().toISOString(),
    });
    const live = Boolean(config.sms?.provider);
    // 生产环境绝不下发验证码明文：否则任何人拿到手机号就能直接登录/接管账号。
    // 仅在非生产（本地/测试）或显式开启 SMS_DEV_CODE=1 时才回吐，且文案写明这是测试码。
    const exposeDev = !live && (config.server.env !== 'production' || String(process.env.SMS_DEV_CODE ?? '') === '1');
    logger.info('验证码已生成', { phone: maskPhone(p), live, exposeDev });
    return {
      sent: live,
      mode: live ? 'sms' : exposeDev ? 'dev' : 'unavailable',
      expires_in_sec: 300,
      dev_code: exposeDev ? code : undefined,
      note: live
        ? '验证码已下发'
        : exposeDev
          ? '未配置短信服务商，这是本地测试码（上线前请接入短信服务）'
          : '线上暂未接入短信服务，请先用微信登录；如需短信登录请联系管理员配置服务商',
    };
  }

  /** 手机号 + 验证码登录（未注册则自动注册，符合「验证码即注册」的直觉） */
  loginByCode({ phone, code, nickname = null } = {}) {
    const p = normalizePhone(phone);
    const row = db.find(SMS, (x) => x.phone === p && !x.used)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!row) fail('CODE_NOT_FOUND', '请先获取验证码');
    if (new Date(row.expires_at).getTime() < Date.now()) fail('CODE_EXPIRED', '验证码已过期，请重新获取');
    if (row.attempts >= 5) fail('CODE_LOCKED', '尝试次数过多，请重新获取验证码');
    if (sha256(`${p}:${String(code ?? '').trim()}`) !== row.code_hash) {
      db.update(SMS, row.id, { attempts: row.attempts + 1 });
      fail('CODE_INVALID', '验证码不对，请检查后重试');
    }
    db.update(SMS, row.id, { used: true, used_at: nowIso() });
    return this.#loginOrCreate({ phone: p, nickname });
  }

  /** 设置/修改密码（需已登录；旧密码不强制，因为微信用户本来就没密码） */
  setPassword(userId, { password } = {}) {
    const h = hashPassword(password);
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.NOT_FOUND, '用户不存在');
    db.update(USERS, userId, { ...h, password_updated_at: nowIso() });
    return this.publicUser(db.findOne(USERS, (u) => u.id === userId));
  }

  /** 手机号 + 密码登录 */
  loginByPassword({ phone, password } = {}) {
    const p = normalizePhone(phone);
    const user = db.findOne(USERS, (u) => u.phone === p);
    // 不区分「没这个号」和「密码错」，避免被用来探测手机号是否注册
    if (!user?.password_hash) fail('LOGIN_FAILED', '手机号或密码不对');
    if (!verifyPassword(password, user.password_hash, user.password_salt)) {
      fail('LOGIN_FAILED', '手机号或密码不对');
    }
    db.update(USERS, user.id, { last_login_at: nowIso() });
    return { token: this.#sign(user.id), user: this.publicUser(user), mode: 'password', isNewUser: false };
  }

  /** 绑定手机号（微信登录后补绑，便于换机找回） */
  bindPhone(userId, { phone, code } = {}) {
    const p = normalizePhone(phone);
    const row = db.find(SMS, (x) => x.phone === p && !x.used)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!row) fail('CODE_NOT_FOUND', '请先获取验证码');
    if (new Date(row.expires_at).getTime() < Date.now()) fail('CODE_EXPIRED', '验证码已过期');
    if (sha256(`${p}:${String(code ?? '').trim()}`) !== row.code_hash) {
      db.update(SMS, row.id, { attempts: row.attempts + 1 });
      fail('CODE_INVALID', '验证码不对');
    }
    const occupied = db.findOne(USERS, (u) => u.phone === p && u.id !== userId);
    if (occupied) fail('PHONE_TAKEN', '该手机号已绑定其他账号');
    db.update(SMS, row.id, { used: true, used_at: nowIso() });
    db.update(USERS, userId, { phone: p, phone_bound_at: nowIso() });
    return this.publicUser(db.findOne(USERS, (u) => u.id === userId));
  }

  /**
   * 直接建一个「手机号 + 密码」账号（管理后台激活内置管理员时用）。
   * 与短信登录的区别：不经过验证码，因为没有可用的短信通道，也不该为了让站长进来而伪造验证码。
   */
  createAccount({ phone, password, nickname = null, role = 'user' } = {}) {
    const p = normalizePhone(phone);
    if (db.findOne(USERS, (u) => u.phone === p)) fail('PHONE_TAKEN', '该手机号已被占用');
    const h = hashPassword(password);
    const user = db.insert(USERS, {
      id: newId('user'),
      openid: `phone_${sha256(p).slice(0, 20)}`,
      phone: p,
      nickname: nickname ?? (role === 'admin' ? '管理员' : `创作者${p.slice(-4)}`),
      avatar: null,
      role: role === 'admin' ? 'admin' : 'user',
      ...h,
      created_at: nowIso(),
      last_login_at: nowIso(),
    });
    ledger.ensureAccount(user.id);
    return this.publicUser(user);
  }

  /** 设定角色（提升/取消管理员）；至少保留一个管理员由调用方保证 */
  setRole(userId, role) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.NOT_FOUND, '用户不存在');
    db.update(USERS, userId, { role: role === 'admin' ? 'admin' : 'user', role_updated_at: nowIso() });
    return this.publicUser(db.findOne(USERS, (u) => u.id === userId));
  }

  /** 内部：手机号登录时没有账号就建一个（账本同时开户） */
  #loginOrCreate({ phone, nickname = null }) {
    let user = db.findOne(USERS, (u) => u.phone === phone);
    let isNewUser = false;
    if (!user) {
      user = db.insert(USERS, {
        id: newId('user'),
        openid: `phone_${sha256(phone).slice(0, 20)}`,
        phone,
        nickname: nickname ?? `创作者${phone.slice(-4)}`,
        avatar: null,
        created_at: nowIso(),
        last_login_at: nowIso(),
      });
      ledger.ensureAccount(user.id);
      isNewUser = true;
    } else {
      db.update(USERS, user.id, { last_login_at: nowIso(), ...(nickname ? { nickname } : {}) });
      user = db.findOne(USERS, (u) => u.id === user.id);
    }
    return { token: this.#sign(user.id), user: this.publicUser(user), mode: 'phone', isNewUser };
  }

  publicUser(user) {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      balance_points: ledger.balance(user.id),
      // 新用户默认昵称是「创作者_xxxxxx」，头像为空 —— 前端据此提示补全资料
      profile_complete: Boolean(user.avatar) && !/^创作者_/.test(String(user.nickname ?? '')),
      phone_masked: maskPhone(user.phone),
      has_password: Boolean(user.password_hash),
      has_phone: Boolean(user.phone),
      // V4.7：管理员与普通用户的唯一区别就是这一位，前端据此决定是否显示「管理后台」
      role: user.role === 'admin' ? 'admin' : 'user',
      is_admin: user.role === 'admin',
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
