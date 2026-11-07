/**
 * 微信开放平台统一客户端（V3.5）。
 *
 * 职责：access_token 管理、code2session 登录、内容安全机审、虚拟支付签名。
 *
 * 降级原则（与全局一致）：未配置 WX_APPID/WX_SECRET 时 mode='mock'，
 * 所有能力返回显式标注的 mock 结果，绝不假装已接真实微信能力；
 * 配置了但调用失败时如实抛错并落审计日志。
 *
 * 安全：appid/secret/appKey 只在服务端读取（config.wechat），
 * 任何返回值/日志不得包含 secret/appKey（core/redact 兜底 SECRET_KEYS）。
 */
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../core/redact.js';
import { fail, ERR } from '../core/errors.js';
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';

const AUDIT = 'wx_api_audit';
const CG = 'https://api.weixin.qq.com';

class WechatClient {
  constructor() {
    this._token = null; // { value, expiresAt }
  }

  get configured() {
    return Boolean(config.wechat.appid && config.wechat.secret);
  }

  get mode() {
    return this.configured ? 'live' : 'mock';
  }

  /** 审计：每次真实/降级调用都落一条（不含密钥） */
  #audit(action, detail = {}) {
    try {
      db.insert(AUDIT, { id: newId('wxa'), action, mode: this.mode, detail, created_at: nowIso() });
    } catch {
      /* 审计失败不阻断主链路 */
    }
  }

  /**
   * 统一出站请求：把「fetch failed」这种无用信息翻译成可诊断的原因。
   *
   * 为什么要做：云托管容器里网络不通时，Node 的 fetch 只抛 `TypeError: fetch failed`，
   * 真实原因藏在 err.cause（ENOTFOUND / ETIMEDOUT / ECONNREFUSED / CERT_*）。
   * 不把它挖出来，线上只能看到「微信登录失败」，等于没信息。
   */
  async #fetchJson(url, { timeout = 10000, ...opts } = {}) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeout), ...opts });
      const json = await res.json().catch(() => ({}));
      return { res, json };
    } catch (err) {
      const cause = err?.cause || {};
      const code = cause.code || cause.errno || err?.name || 'UNKNOWN';
      const host = cause.hostname || 'api.weixin.qq.com';
      this.#audit('fetch_failed', { code, host });
      fail(ERR.WX_API_ERROR, `连不上微信接口（${code} @ ${host}）`);
      return null;
    }
  }

  /** 获取 access_token（缓存，提前 300s 续期） */
  async accessToken({ force = false } = {}) {
    if (!this.configured) return null;
    if (!force && this._token && Date.now() < this._token.expiresAt) return this._token.value;
    const url = `${CG}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(config.wechat.appid)}&secret=${encodeURIComponent(config.wechat.secret)}`;
    const { res, json } = await this.#fetchJson(url);
    if (!res.ok || !json.access_token) {
      this.#audit('access_token_failed', { status: res.status, errcode: json.errcode });
      fail(ERR.WX_API_ERROR, `微信 access_token 获取失败（errcode ${json.errcode ?? res.status}）`);
    }
    this._token = {
      value: json.access_token,
      expiresAt: Date.now() + Math.max(60, Number(json.expires_in ?? 7200) - 300) * 1000,
    };
    this.#audit('access_token', { ok: true });
    return this._token.value;
  }

  /**
   * 登录：jscode2session
   * @returns {Promise<{openid:string, unionid:string|null, sessionKey:string|null, mode:string}>}
   */
  async code2session(code) {
    if (!code || typeof code !== 'string') fail(ERR.BAD_REQUEST, '缺少 wx.login 的 code');
    if (!this.configured) {
      // MOCK：code 决定 openid，保证同一 code 幂等同一用户
      const openid = `mock_${crypto.createHash('sha1').update(String(code)).digest('hex').slice(0, 24)}`;
      this.#audit('code2session_mock', {});
      return { openid, unionid: null, sessionKey: null, mode: 'mock' };
    }
    const url = `${CG}/sns/jscode2session?appid=${encodeURIComponent(config.wechat.appid)}&secret=${encodeURIComponent(config.wechat.secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const { res, json } = await this.#fetchJson(url);
    if (!res.ok || json.errcode) {
      this.#audit('code2session_failed', { status: res.status, errcode: json.errcode });
      fail(ERR.WX_AUTH_FAILED, `微信登录失败（errcode ${json.errcode ?? res.status}${json.errmsg ? ` ${json.errmsg}` : ''}）`);
    }
    this.#audit('code2session', { ok: true });
    return { openid: json.openid, unionid: json.unionid ?? null, sessionKey: json.session_key ?? null, mode: 'live' };
  }

  /**
   * 连通性自检（运维用）：真的去敲一次微信接口，而不是只看「配没配」。
   *
   * access_token 拿不到 → 多半是 appid/secret 不对或出网被拦；
   * access_token 拿得到但 jscode2session 连不上 → 出网/证书问题；
   * 两者都通但返回 errcode → 业务原因（如 code 已用过、AppID 与小程序不匹配）。
   * 返回里绝不含 secret / token 原文。
   */
  async probe() {
    // 字段名刻意避开 redact 的敏感词（access_token / session_key 等），
    // 否则整段会被替换成 "***"，运维看到的就是一团马赛克。
    const out = { configured: this.configured, mode: this.mode };
    if (!this.configured) {
      out.hint = '未配置 WX_APPID / WX_SECRET，微信能力处于 mock';
      return out;
    }
    try {
      const tk = await this.accessToken({ force: true });
      out.auth = { ok: Boolean(tk), len: tk ? String(tk).length : 0 };
    } catch (e) {
      out.auth = { ok: false, error: e.message, code: e.code ?? null };
      return out; // 连不上就不必继续测第二条链路
    }
    try {
      const url = `${CG}/sns/jscode2session?appid=${encodeURIComponent(config.wechat.appid)}`
        + `&secret=${encodeURIComponent(config.wechat.secret)}&js_code=DIAG_INVALID_CODE&grant_type=authorization_code`;
      const { res, json } = await this.#fetchJson(url);
      // 网络通就会拿到业务错误码（40029 code 无效 / 40163 已使用），这本身就是「通」的证据
      out.login = { ok: true, http: res.status, errcode: json.errcode ?? 0, errmsg: json.errmsg ?? '' };
    } catch (e) {
      out.login = { ok: false, error: e.message, code: e.code ?? null };
    }
    return out;
  }

  /**
   * 文本内容安全：msgSecCheck（scene：1=资料 2=评论 3=论坛 4=社交日志）
   * @returns {Promise<{pass:boolean, label:number|null, mode:string, traceId:string|null}>}
   */
  async msgSecCheck({ openid = '', scene = 3, content }) {
    if (!config.wechat.msgSecCheckEnabled) {
      this.#audit('msgsec_disabled', {});
      return { pass: true, label: null, mode: 'disabled', traceId: null };
    }
    if (!this.configured) {
      this.#audit('msgsec_mock', { len: String(content ?? '').length });
      return { pass: true, label: null, mode: 'mock', traceId: null };
    }
    // v2 接口必须带「本小程序真实用户」的 openid：openid 缺失/伪造一律 40003，
    // 直接抛错会把「建项目」这类主流程卡死。取不到就如实降级并留审计，
    // 由后台 security_audit 追溯（mode=degraded_no_openid 一眼可辨，不假装已机审）。
    if (!openid) {
      this.#audit('msgsec_degraded_no_openid', { len: String(content ?? '').length });
      return { pass: true, label: null, mode: 'degraded_no_openid', traceId: null };
    }
    const token = await this.accessToken();
    const res = await fetch(`${CG}/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        openid,
        scene: Number(scene) || 3,
        version: 2,
        content: String(content ?? '').slice(0, 2500),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => ({}));
    // errcode 87014 = 内容违规；0 = 通过；其他 = 接口异常
    if (json.errcode === 87014) {
      this.#audit('msgsec_block', { label: json?.result?.label ?? null, traceId: json.trace_id ?? null });
      return { pass: false, label: json?.result?.label ?? null, mode: 'live', traceId: json.trace_id ?? null };
    }
    // 40003 openid 无效 / 61010 用户近期未使用小程序 → 这个用户查不了，降级不误伤
    if (json.errcode === 40003 || json.errcode === 61010) {
      this.#audit('msgsec_degraded_openid', { errcode: json.errcode });
      return { pass: true, label: null, mode: 'degraded_openid_stale', traceId: json.trace_id ?? null };
    }
    if (!res.ok || (json.errcode && json.errcode !== 0)) {
      this.#audit('msgsec_error', { status: res.status, errcode: json.errcode });
      fail(ERR.WX_API_ERROR, `内容安全接口异常（errcode ${json.errcode ?? res.status}）`);
    }
    const suggest = json?.result?.suggest ?? 'pass';
    const pass = suggest === 'pass';
    this.#audit('msgsec', { suggest, label: json?.result?.label ?? null });
    return { pass, label: json?.result?.label ?? null, mode: 'live', traceId: json.trace_id ?? null };
  }

  /**
   * 图片内容安全：media_check_async 需要异步回调；同步场景用 img_sec_check（≤1MB 图片）。
   * 这里实现 URL 拉取后 img_sec_check；失败/超限则降级标注 mode:'skipped' 并落审计（由交付闸门另行把关）。
   */
  async imgSecCheck({ imageUrl }) {
    if (!config.wechat.msgSecCheckEnabled) return { pass: true, mode: 'disabled' };
    if (!this.configured) {
      this.#audit('imgsec_mock', {});
      return { pass: true, mode: 'mock' };
    }
    try {
      const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length > 1024 * 1024) {
        this.#audit('imgsec_skipped', { reason: 'too_large', bytes: buf.length });
        return { pass: true, mode: 'skipped_too_large' };
      }
      const token = await this.accessToken();
      const form = new FormData();
      form.append('media', new Blob([buf]), 'check.jpg');
      const res = await fetch(`${CG}/wxa/img_sec_check?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => ({}));
      if (json.errcode === 87014) {
        this.#audit('imgsec_block', {});
        return { pass: false, mode: 'live' };
      }
      if (!res.ok || (json.errcode && json.errcode !== 0)) {
        this.#audit('imgsec_error', { status: res.status, errcode: json.errcode });
        return { pass: true, mode: 'error_pass_through' }; // 接口异常不误伤，但必须落审计
      }
      this.#audit('imgsec', { ok: true });
      return { pass: true, mode: 'live' };
    } catch (e) {
      this.#audit('imgsec_error', { err: e?.message });
      return { pass: true, mode: 'error_pass_through' };
    }
  }

  // ———————————————————— 虚拟支付签名 ————————————————————

  /** 虚拟支付回调验签与下单签名共用的 HMAC-SHA256（密钥 = WX_PAY_APP_KEY） */
  payHmac(raw) {
    return crypto.createHmac('sha256', config.wechat.virtualPay.appKey).update(raw).digest('hex');
  }

  /**
   * 生成 wx.requestVirtualPayment 前端签名（小程序虚拟支付 2.0）。
   * signData 按微信规范序列化；signature 用 session_key（live）或占位（mock）。
   * 文档：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
   */
  signVirtualPayOrder({ offerId, outTradeNo, zoneId = '1', fee, sessionKey = null }) {
    const ts = Math.floor(Date.now() / 1000);
    const signData = JSON.stringify({
      offerId, buyQuantity: fee, env: config.wechat.virtualPay.env,
      zoneId, outTradeNo: outTradeNo, currencyType: 'CNY',
    });
    const paySigRaw = `${signData}&org_key=${config.wechat.virtualPay.appKey}&out_trade_no=${outTradeNo}`;
    const paySig = this.payHmac(paySigRaw);
    // 用户签名：live 用 session_key，mock 用 appKey（仅联调，真实环境微信会校验 session_key）
    const sigKey = sessionKey || config.wechat.virtualPay.appKey;
    const signature = crypto
      .createHmac('sha256', sigKey)
      .update(`${signData}&ts=${ts}`)
      .digest('hex');
    return { mode: this.payConfigured ? 'live' : 'mock', signData, paySig, signature, ts, zoneId, env: config.wechat.virtualPay.env };
  }

  /** 虚拟支付发货回调验签：Wechatpay-Signature 用平台证书链，沙箱/首期用 appKey HMAC 兜底 */
  verifyPayNotify({ signature, rawBody }) {
    if (!this.payConfigured) return { ok: false, reason: 'not_configured' };
    if (!signature) return { ok: false, reason: 'missing_signature' };
    const expect = this.payHmac(String(rawBody ?? ''));
    const a = Buffer.from(String(signature));
    const b = Buffer.from(expect);
    return { ok: a.length === b.length && crypto.timingSafeEqual(a, b) };
  }

  get payConfigured() {
    const vp = config.wechat.virtualPay;
    return Boolean(config.wechat.appid && vp.offerId && vp.appKey);
  }

  /** 状态自检（/api/web/status 同类，给运维看板用） */
  status() {
    return {
      mode: this.mode,
      login: this.configured ? 'live' : 'mock（未配置 WX_APPID/WX_SECRET）',
      secCheck: !this.configured ? 'mock' : config.wechat.msgSecCheckEnabled ? 'live' : 'disabled',
      virtualPay: this.payConfigured
        ? `live（env=${config.wechat.virtualPay.env === 0 ? '正式' : '沙箱'}）`
        : 'mock（未配置 WX_PAY_OFFER_ID/WX_PAY_APP_KEY）',
    };
  }
}

export const wechatClient = new WechatClient();
export default wechatClient;
