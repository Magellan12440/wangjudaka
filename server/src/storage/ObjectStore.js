/**
 * 对象存储（V4.8）：素材与生成产物的统一落盘入口。
 *
 * 为什么必须做：云托管容器的文件系统是临时的，缩容到 0 / 重新部署即还原，
 * 存在 `data/uploads` 里的素材会全部消失；而且小程序 <image>/<video> 拉取
 * `/media/*` 要过 downloadFile 合法域名，云托管默认域名根本配不进白名单。
 *
 * 通道：
 *   1) cloud —— 微信云开发存储桶。写法不是「微信给的 uploadfile 接口」（实测只给小程序的
 *      wx.uploadFile 用，服务端直传恒 403/缺 policy），而是：access_token → getqcloudtoken
 *      拿临时腾讯云凭证 → 用 COS 的 q-sign 签名直接 PUT 到同一个桶。
 *      好处：对象路径与云开发 fileID 完全一致，小程序仍能用 wx.cloud.getTempFileURL 渲染。
 *   2) local —— 容器本地磁盘（兜底，重启即丢），返回值显式标注 provider:'local'。
 *
 * 诚实原则：云通道不可用/失败时自动降级，并把真实原因写进 status().last_error。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import wechatClient from '../wechat/WechatClient.js';
import { logger } from '../core/redact.js';

const CG = 'https://api.weixin.qq.com';
const MEDIA_ROOT = path.join(config.server.dataDir, 'uploads');

const sha1hex = (s) => crypto.createHash('sha1').update(s).digest('hex');
const hmacHex = (k, s) => crypto.createHmac('sha1', k).update(s).digest('hex');

/** 从 7072-prod-xxxx-1525512932 这类桶名反推云开发环境 ID（env 段本身可能含 -） */
export function envFromBucket(bucket) {
  const s = String(bucket || '');
  const m = /^\d+-(.+)-[0-9a-z]+$/i.exec(s);
  return m ? m[1] : '';
}

export function cloudEnvId() {
  return config.storage.env || envFromBucket(config.storage.bucket);
}

export function cosHost() {
  const b = config.storage.bucket;
  const r = config.storage.region;
  return b && r ? `${b}.cos.${r}.myqcloud.com` : '';
}

/** 文件扩展名白名单式清洗：只接受 .xx 形态，避免拼出 ../ */
function safeExt(ext) {
  const e = String(ext || '').toLowerCase();
  return /^\.[a-z0-9]{2,5}$/.test(e) ? e : '';
}

export function buildKey(ext, prefix = config.storage.prefix) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const name = crypto.randomBytes(12).toString('hex');
  return `${prefix}/${y}/${m}/${name}${safeExt(ext)}`;
}

function localName(ext) {
  return `${crypto.randomBytes(12).toString('hex')}${safeExt(ext) || '.bin'}`;
}

/** cloud://<env>.<bucket>/<key> → /<key> */
export function keyFromFileId(fileId) {
  const s = String(fileId || '');
  if (!s.startsWith('cloud://')) return '';
  const rest = s.slice('cloud://'.length);
  const i = rest.indexOf('/');
  return i < 0 ? '' : rest.slice(i);
}

/** q-sign（sha1）请求签名：临时密钥时把 x-cos-security-token 一起签进去 */
function signRequest({ method, keyPath, cred }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 3600}`;
  const signKey = hmacHex(cred.secretKey, keyTime);
  const headers = { host: cosHost() };
  if (cred.token) headers['x-cos-security-token'] = cred.token;
  const list = Object.keys(headers).sort();
  const headerStr = list.map((k) => `${k}=${encodeURIComponent(headers[k])}`).join('&');
  const httpString = `${method.toLowerCase()}\n${keyPath}\n\n${headerStr}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`;
  const signature = hmacHex(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${cred.secretId}&q-sign-time=${keyTime}`
    + `&q-key-time=${keyTime}&q-header-list=${list.join(';')}&q-url-param-list=&q-signature=${signature}`;
}

class ObjectStore {
  #cred = null; // { secretId, secretKey, token, exp }
  #lastError = '';
  #lastErrorAt = 0;
  #cloudOk = null;

  get providerPref() {
    return String(config.storage.provider || 'auto').toLowerCase();
  }

  get configured() {
    return Boolean(wechatClient.configured && cosHost() && cloudEnvId());
  }

  /**
   * 生效模式。
   * 注意顺序：没配齐凭据时一律本地 —— 即使 STORAGE_PROVIDER=cloud。
   * 否则「强制云」会变成「强制报错」：测试环境/未配 WX 凭据的实例里，
   * 每一次上传都会抛 access_token 不可用，把业务链路一起带崩。
   */
  get mode() {
    if (this.providerPref === 'local') return 'local';
    if (!this.configured) return 'local';
    if (this.providerPref === 'cloud') return 'cloud';
    return this.#cloudOk !== false ? 'cloud' : 'local';
  }

  status() {
    const env = cloudEnvId();
    return {
      mode: this.mode,
      provider: this.providerPref,
      env: env ? `${env.slice(0, 4)}***` : '',
      bucket: config.storage.bucket ? `${config.storage.bucket.slice(0, 6)}***` : '',
      configured: this.configured,
      wechat: wechatClient.mode,
      last_error: this.#lastError || '',
      last_error_at: this.#lastErrorAt ? new Date(this.#lastErrorAt).toISOString() : '',
    };
  }

  #markFail(err) {
    this.#lastError = String((err && err.message) || err || 'unknown').slice(0, 300);
    this.#lastErrorAt = Date.now();
    this.#cloudOk = false;
  }

  #markOk() {
    this.#cloudOk = true;
    this.#lastError = '';
    this.#lastErrorAt = 0;
  }

  /** 临时腾讯云凭证（2 小时），提前 5 分钟续 */
  async #qcloudCred({ force = false } = {}) {
    if (!force && this.#cred && this.#cred.exp > Date.now() + 5 * 60 * 1000) return this.#cred;
    const at = await wechatClient.accessToken();
    if (!at) throw new Error('微信 access_token 不可用（WX_APPID/WX_SECRET 未配置）');
    const res = await fetch(`${CG}/tcb/getqcloudtoken?access_token=${encodeURIComponent(at)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lifespan: 7200 }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.secretid || !j.secretkey) {
      throw new Error(`临时凭证获取失败（errcode ${j.errcode ?? res.status}）`);
    }
    this.#cred = {
      secretId: j.secretid,
      secretKey: j.secretkey,
      token: j.token || '',
      exp: j.expired_time ? Number(j.expired_time) * 1000 : Date.now() + 3600 * 1000,
    };
    return this.#cred;
  }

  /**
   * 落一份二进制。
   * @returns {Promise<{url:string, key:string, provider:'cloud'|'local', size:number, file?:string}>}
   *   url 为 cloud:// fileID（云）或 /media/<name>（本地）
   */
  async put(buffer, { ext = '', mime = 'application/octet-stream', prefix } = {}) {
    if (!buffer?.length) throw new Error('empty buffer');
    const size = buffer.length;
    if (size > config.storage.maxBytes) {
      throw Object.assign(new Error('文件超过存储上限'), { code: 'FILE_TOO_LARGE' });
    }

    if (this.mode === 'cloud') {
      try {
        const key = buildKey(ext, prefix || config.storage.prefix);
        const fileId = await this.#cosPut(buffer, { key, mime });
        this.#markOk();
        return { url: fileId, key, provider: 'cloud', size };
      } catch (err) {
        this.#markFail(err);
        if (this.providerPref === 'cloud') throw err;
        logger.warn(`[storage] 云存储不可用，已降级本地：${err?.message || err}`);
      }
    }

    return this.#localPut(buffer, ext);
  }

  #localPut(buffer, ext) {
    const name = localName(ext);
    fs.mkdirSync(MEDIA_ROOT, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_ROOT, name), buffer);
    return { url: `/media/${name}`, key: name, provider: 'local', size: buffer.length, file: name };
  }

  async #cosPut(buffer, { key, mime }) {
    const host = cosHost();
    if (!host) throw new Error('未配置 COS_BUCKET / COS_REGION');
    const cred = await this.#qcloudCred();
    const headers = { Authorization: signRequest({ method: 'put', keyPath: `/${key}`, cred }) };
    if (cred.token) headers['x-cos-security-token'] = cred.token;
    if (mime) headers['Content-Type'] = mime;

    const res = await fetch(`https://${host}/${key}`, {
      method: 'PUT',
      headers,
      body: buffer,
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 凭证过期就强制换一次再试，避免整个 2 小时窗口都用坏凭证
      if (res.status === 403) {
        this.#cred = null;
        const fresh = await this.#qcloudCred({ force: true });
        const h2 = { Authorization: signRequest({ method: 'put', keyPath: `/${key}`, cred: fresh }) };
        if (fresh.token) h2['x-cos-security-token'] = fresh.token;
        if (mime) h2['Content-Type'] = mime;
        const retry = await fetch(`https://${host}/${key}`, {
          method: 'PUT', headers: h2, body: buffer, signal: AbortSignal.timeout(120000),
        });
        if (retry.ok) return `cloud://${cloudEnvId()}.${config.storage.bucket}/${key}`;
      }
      throw new Error(`COS 上传失败 HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    return `cloud://${cloudEnvId()}.${config.storage.bucket}/${key}`;
  }

  /** 带签名的服务端请求（HEAD / GET / DELETE） */
  async #signedFetch(method, fileId, { timeout = 30000 } = {}) {
    const host = cosHost();
    const keyPath = keyFromFileId(fileId);
    if (!host || !keyPath) return null;
    const cred = await this.#qcloudCred();
    const headers = { Authorization: signRequest({ method, keyPath, cred }) };
    if (cred.token) headers['x-cos-security-token'] = cred.token;
    return fetch(`https://${host}${keyPath}`, { method, headers, signal: AbortSignal.timeout(timeout) });
  }

  /**
   * 核实云端对象真实大小（HEAD）。拿不到返回 0 —— 调用方据此决定是否拒收。
   * 不信任前端自报 size：否则可以绕开素材体积上限。
   */
  async headSize(fileId) {
    if (!String(fileId || '').startsWith('cloud://')) return 0;
    try {
      const res = await this.#signedFetch('HEAD', fileId, { timeout: 20000 });
      if (!res || !res.ok) return 0;
      const len = Number(res.headers.get('content-length') || 0);
      return Number.isFinite(len) && len > 0 ? len : 0;
    } catch (err) {
      logger.warn(`[storage] HEAD 云文件失败：${err?.message || err}`);
      return 0;
    }
  }

  /** 删除：cloud:// 走 COS DELETE，/media/ 走本地 unlink；失败只记日志不抛 */
  async remove(url) {
    const s = String(url || '');
    if (!s) return false;
    if (s.startsWith('cloud://')) {
      if (!this.configured) return false;
      try {
        const res = await this.#signedFetch('DELETE', s, { timeout: 20000 });
        return Boolean(res && (res.ok || res.status === 204 || res.status === 404));
      } catch (err) {
        logger.warn(`[storage] 云文件删除失败：${err?.message || err}`);
        return false;
      }
    }
    if (s.startsWith('/media/')) {
      try {
        fs.unlinkSync(path.join(MEDIA_ROOT, s.slice('/media/'.length)));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * 批量换取临时下载链接。
   * 前端显示不走这里（小程序用 wx.cloud.getTempFileURL 更省事，且不受域名白名单限制），
   * 这里主要给后端自检与外部脚本用。
   * @returns {Promise<Record<string,string>>} fileId → 带签名的 https 直链
   */
  async tempUrls(fileIds = [], maxAge = config.storage.maxAge) {
    const list = [...new Set(fileIds.filter((x) => typeof x === 'string' && x.startsWith('cloud://')))];
    if (!list.length || !this.configured) return {};
    const host = cosHost();
    let cred;
    try {
      cred = await this.#qcloudCred();
    } catch {
      return {};
    }
    const out = {};
    for (const id of list) {
      const keyPath = keyFromFileId(id);
      if (!keyPath) continue;
      const now = Math.floor(Date.now() / 1000);
      const keyTime = `${now};${now + Math.max(60, maxAge)}`;
      const signKey = hmacHex(cred.secretKey, keyTime);
      const params = cred.token ? { 'x-cos-security-token': cred.token } : {};
      const paramList = Object.keys(params).sort();
      const paramStr = paramList.map((k) => `${k}=${encodeURIComponent(params[k])}`).join('&');
      const httpString = `get\n${keyPath}\n${paramStr}\nhost=${encodeURIComponent(host)}\n`;
      const stringToSign = `sha1\n${keyTime}\n${sha1hex(httpString)}\n`;
      const signature = hmacHex(signKey, stringToSign);
      const q = `${paramStr ? `${paramStr}&` : ''}q-sign-algorithm=sha1&q-ak=${cred.secretId}`
        + `&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host`
        + `&q-url-param-list=${paramList.join(';')}&q-signature=${signature}`;
      out[id] = `https://${host}${keyPath}?${q}`;
    }
    return out;
  }

  /** 读回文件内容（本地的直接读；云端带签名 GET） */
  async read(url) {
    const s = String(url || '');
    if (!s) return null;
    if (s.startsWith('/media/')) {
      try {
        return fs.readFileSync(path.join(MEDIA_ROOT, s.slice('/media/'.length)));
      } catch {
        return null;
      }
    }
    if (s.startsWith('cloud://')) {
      try {
        const res = await this.#signedFetch('GET', s, { timeout: 60000 });
        if (!res || !res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null;
      }
    }
    return null;
  }
}

export const objectStore = new ObjectStore();
export default objectStore;
