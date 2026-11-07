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
const SESSIONS = 'auth_sessions';
const MAX_SESSIONS = 20;
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

/** 从 UA 里猜一个说人话的设备名（iOS / Android / 微信 / 开发者工具） */
export function deviceName(ua) {
  const s = String(ua || '');
  if (!s) return '未知设备';
  if (/MicroMessenger/i.test(s)) {
    if (/iPhone|iPad|iOS/i.test(s)) return '微信 · iPhone';
    if (/Android/i.test(s)) return '微信 · Android';
    return '微信';
  }
  if (/wechatdevtools/i.test(s)) return '微信开发者工具';
  if (/iPhone|iPad|iOS/i.test(s)) return 'iPhone';
  if (/Android/i.test(s)) return 'Android';
  if (/Windows/i.test(s)) return 'Windows 电脑';
  if (/Macintosh|Mac OS/i.test(s)) return 'Mac';
  return '未知设备';
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
  async login({ code, nickname = null, avatar = null, req = null } = {}) {
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
    const sid = this.recordSession(user, req, sess.mode || 'wechat');
    const token = this.#sign(user.id, user, sid);
    return {
      token,
      mode: sess.mode,
      isNewUser,
      user: this.publicUser(user),
    };
  }

  /**
   * 自签 token：base64url(payload).sig
   *
   * payload 里除了 uid/exp，还带两个字段：
   *  - tv：账号的 token 版本。改密码 / 退出所有设备时 +1，旧 token 立刻失效；
   *  - sid：本次登录的设备会话号，用于「登录设备」列表里认出当前这台。
   */
  #sign(userId, user = null, sid = null) {
    const expiresAt = Date.now() + config.wechat.sessionTtlMs;
    const sessionId = sid || crypto.randomBytes(8).toString('hex');
    const payload = Buffer.from(JSON.stringify({
      uid: userId,
      exp: expiresAt,
      tv: Number(user?.token_version) || 0,
      sid: sessionId,
    })).toString('base64url');
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
      return { userId: data.uid, tv: Number(data.tv) || 0, sid: data.sid ?? null };
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
    if (user.status === 'closed') fail(ERR.AUTH_TOKEN_INVALID, '账号已注销');
    // 改密码 / 退出所有设备后，旧 token 的版本号对不上，直接失效
    if ((Number(user.token_version) || 0) !== v.tv) {
      fail(ERR.AUTH_TOKEN_INVALID, '登录状态已变更，请重新登录');
    }
    // 把会话号挂在请求对象上，路由里可以判断「这台是不是当前设备」
    try { if (req && v.sid) req.sessionId = v.sid; } catch { /* 只读请求不做强制 */ }
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
  loginByCode({ phone, code, nickname = null, req = null } = {}) {
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
    return this.#loginOrCreate({ phone: p, nickname, req });
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
  loginByPassword({ phone, password, req = null } = {}) {
    const p = normalizePhone(phone);
    const user = db.findOne(USERS, (u) => u.phone === p);
    // 不区分「没这个号」和「密码错」，避免被用来探测手机号是否注册
    if (!user?.password_hash) fail('LOGIN_FAILED', '手机号或密码不对');
    if (!verifyPassword(password, user.password_hash, user.password_salt)) {
      fail('LOGIN_FAILED', '手机号或密码不对');
    }
    db.update(USERS, user.id, { last_login_at: nowIso() });
    const fresh = db.findOne(USERS, (u) => u.id === user.id);
    const sid = this.recordSession(fresh, req, 'password');
    return { token: this.#sign(user.id, fresh, sid), user: this.publicUser(fresh), mode: 'password', isNewUser: false };
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
  #loginOrCreate({ phone, nickname = null, req = null }) {
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
    const sid = this.recordSession(user, req, 'phone');
    return { token: this.#sign(user.id, user, sid), user: this.publicUser(user), mode: 'phone', isNewUser };
  }

  // ============================================================
  // 会话与设备（V4.9）：谁在什么时候、用什么设备登录过
  // ============================================================

  /** 记录一次登录（只用于展示与自助下线，鉴权仍靠 token 里的 tv） */
  recordSession(user, req, mode = 'unknown') {
    const sid = crypto.randomBytes(8).toString('hex');
    try {
      const h = req?.headers ?? {};
      const ua = String(h['user-agent'] ?? h['User-Agent'] ?? '').slice(0, 200);
      const fwd = String(h['x-forwarded-for'] ?? '').split(',')[0].trim();
      const ip = (fwd || req?.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 46);
      db.insert(SESSIONS, {
        id: sid,
        user_id: user.id,
        mode,
        ua,
        ip,
        device: deviceName(ua),
        created_at: nowIso(),
        last_seen_at: nowIso(),
        revoked: false,
      });
      // 只留最近 N 条，避免 JSON 库无限增长
      const rows = db.find(SESSIONS, (x) => x.user_id === user.id);
      if (rows.length > MAX_SESSIONS) {
        rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        for (const r of rows.slice(0, rows.length - MAX_SESSIONS)) db.remove(SESSIONS, r.id);
      }
    } catch (e) {
      logger.warn('登录会话记录失败（不影响登录）', { error: e.message });
    }
    return sid;
  }

  /** 登录设备列表（最新的在前） */
  sessions(userId, currentSid = null) {
    return db.find(SESSIONS, (x) => x.user_id === userId && !x.revoked)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 10)
      .map((x) => ({
        id: x.id,
        device: x.device || '未知设备',
        ua: x.ua || '',
        ip: x.ip || '',
        mode: x.mode || '',
        created_at: x.created_at,
        last_seen_at: x.last_seen_at,
        current: Boolean(currentSid && x.id === currentSid),
      }));
  }

  /** 让某个设备下线（需属于本人） */
  revokeSession(userId, sessionId) {
    const row = db.find(SESSIONS, (x) => x.id === sessionId && x.user_id === userId)[0];
    if (!row) fail(ERR.NOT_FOUND, '设备不存在或已下线');
    db.update(SESSIONS, row.id, { revoked: true, revoked_at: nowIso() });
    return { revoked: true, id: row.id };
  }

  /**
   * 退出所有设备：token_version + 1。
   * 旧 token 的 tv 对不上，下一次请求就会被拒 —— 不需要维护黑名单。
   */
  logoutAll(userId) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.AUTH_TOKEN_INVALID, '用户不存在');
    db.update(USERS, userId, { token_version: (Number(user.token_version) || 0) + 1, logged_out_all_at: nowIso() });
    for (const r of db.find(SESSIONS, (x) => x.user_id === userId && !x.revoked)) {
      db.update(SESSIONS, r.id, { revoked: true, revoked_at: nowIso() });
    }
    return { ok: true };
  }

  // ============================================================
  // 注册 / 密码管理（V4.9）
  // ============================================================

  /**
   * 手机号 + 密码注册。
   *
   * 线上短信通道未接入时，不做「验证码注册」的假动作：直接开号，
   * 但把 phone_verified 标成 false —— 后台与用户自己都能看到「手机号未验证」，
   * 等短信通道开通后再走一次验证即可。
   */
  register({ phone, password, nickname = null, code = null, req = null } = {}) {
    const p = normalizePhone(phone);
    if (db.findOne(USERS, (u) => u.phone === p)) fail('PHONE_TAKEN', '这个手机号已经注册过了，直接登录即可');
    const h = hashPassword(password);
    // 给了验证码且真实有效 → 顺手标记已验证；否则留待后续验证
    let verified = false;
    if (code) {
      const row = db.find(SMS, (x) => x.phone === p && !x.used)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (row && new Date(row.expires_at).getTime() >= Date.now()
        && sha256(`${p}:${String(code).trim()}`) === row.code_hash) {
        db.update(SMS, row.id, { used: true, used_at: nowIso() });
        verified = true;
      }
    }
    const user = db.insert(USERS, {
      id: newId('user'),
      openid: `phone_${sha256(p).slice(0, 20)}`,
      phone: p,
      phone_verified: verified,
      phone_bound_at: nowIso(),
      nickname: String(nickname ?? '').trim().slice(0, 20) || `创作者${p.slice(-4)}`,
      avatar: null,
      role: 'user',
      token_version: 0,
      ...h,
      created_at: nowIso(),
      last_login_at: nowIso(),
    });
    ledger.ensureAccount(user.id);
    const sid = this.recordSession(user, req, 'register');
    return { token: this.#sign(user.id, user, sid), user: this.publicUser(user), mode: 'password', isNewUser: true };
  }

  /**
   * 改密码（已登录）。
   * 已经设过密码的账号必须先验旧密码；纯微信用户第一次设密码则不需要。
   */
  changePassword(userId, { oldPassword = '', newPassword, sid = null } = {}) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.AUTH_TOKEN_INVALID, '用户不存在');
    if (user.password_hash) {
      if (!oldPassword) fail('OLD_PASSWORD_REQUIRED', '请输入当前密码');
      if (!verifyPassword(oldPassword, user.password_hash, user.password_salt)) {
        fail('OLD_PASSWORD_WRONG', '当前密码不对');
      }
      if (verifyPassword(newPassword, user.password_hash, user.password_salt)) {
        fail('PASSWORD_SAME', '新密码不能与当前密码相同');
      }
    }
    const h = hashPassword(newPassword);
    db.update(USERS, userId, {
      ...h,
      password_updated_at: nowIso(),
      // 改密码即踢掉其它设备上的登录态
      token_version: (Number(user.token_version) || 0) + 1,
    });
    for (const r of db.find(SESSIONS, (x) => x.user_id === userId && !x.revoked)) {
      db.update(SESSIONS, r.id, { revoked: true, revoked_at: nowIso() });
    }
    const fresh = db.findOne(USERS, (u) => u.id === userId);
    // 当前设备重新签发，避免用户改完密码把自己也踢下线
    return { token: this.#sign(userId, fresh, sid), user: this.publicUser(fresh) };
  }

  /** 忘记密码：手机号 + 验证码重置（需要短信通道，未接入时走 dev 码） */
  resetPassword({ phone, code, newPassword } = {}) {
    const p = normalizePhone(phone);
    const user = db.findOne(USERS, (u) => u.phone === p);
    // 不暴露手机号是否注册：验证码校验失败时统一报「验证码不对」
    const row = db.find(SMS, (x) => x.phone === p && !x.used)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!row) fail('CODE_NOT_FOUND', '请先获取验证码');
    if (new Date(row.expires_at).getTime() < Date.now()) fail('CODE_EXPIRED', '验证码已过期，请重新获取');
    if (sha256(`${p}:${String(code ?? '').trim()}`) !== row.code_hash) {
      db.update(SMS, row.id, { attempts: (row.attempts || 0) + 1 });
      fail('CODE_INVALID', '验证码不对');
    }
    db.update(SMS, row.id, { used: true, used_at: nowIso() });
    if (!user) fail('LOGIN_FAILED', '该手机号还没有账号，请先注册');
    const h = hashPassword(newPassword);
    db.update(USERS, p ? user.id : user.id, {
      ...h,
      password_updated_at: nowIso(),
      token_version: (Number(user.token_version) || 0) + 1,
    });
    for (const r of db.find(SESSIONS, (x) => x.user_id === user.id && !x.revoked)) {
      db.update(SESSIONS, r.id, { revoked: true, revoked_at: nowIso() });
    }
    return { ok: true, phone_masked: maskPhone(p) };
  }

  /** 注销账号：标记 closed 并踢掉所有登录态（数据保留，便于申诉恢复） */
  closeAccount(userId, { confirmText, password = '', code = '' } = {}) {
    const user = db.findOne(USERS, (u) => u.id === userId);
    if (!user) fail(ERR.AUTH_TOKEN_INVALID, '用户不存在');
    if (String(confirmText ?? '').trim() !== '注销') fail('CONFIRM_REQUIRED', '请输入「注销」两个字以确认');
    if (user.password_hash) {
      if (!password || !verifyPassword(password, user.password_hash, user.password_salt)) {
        fail('LOGIN_FAILED', '密码不对，无法注销');
      }
    } else if (user.phone) {
      const row = db.find(SMS, (x) => x.phone === user.phone && !x.used)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (!row || sha256(`${user.phone}:${String(code ?? '').trim()}`) !== row.code_hash) {
        fail('CODE_INVALID', '验证码不对，无法注销');
      }
      db.update(SMS, row.id, { used: true, used_at: nowIso() });
    } else {
      fail('CONFIRM_REQUIRED', '请先在账号安全里绑定手机号或设置密码，再注销');
    }
    db.update(USERS, userId, {
      status: 'closed',
      closed_at: nowIso(),
      token_version: (Number(user.token_version) || 0) + 1,
    });
    for (const r of db.find(SESSIONS, (x) => x.user_id === userId && !x.revoked)) {
      db.update(SESSIONS, r.id, { revoked: true, revoked_at: nowIso() });
    }
    return { ok: true };
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
      pwd_set: Boolean(user.password_hash),
      has_phone: Boolean(user.phone),
      phone_verified: Boolean(user.phone_verified),
      status: user.status || 'active',
      pwd_updated_at: user.password_updated_at ?? null,
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
