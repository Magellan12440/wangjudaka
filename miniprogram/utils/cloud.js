/**
 * 云托管调用封装（V4.19）。
 *
 * 生产环境为什么走这条路，而不是普通的 wx.request：
 *
 *  1. 云托管默认域名（*.sh.run.tcloudbase.com）**不允许**配进小程序后台的
 *     「request 合法域名」——它是共享域名，微信只放行已备案的自有域名。
 *     所以线上版拿默认域名去 wx.request，真机上必然「网络异常 / 不在合法域名列表」。
 *  2. wx.cloud.callContainer 走微信内部链路，**不校验 request 合法域名**，
 *     这是上线过渡期（还没备案域名）唯一能用的通道，也是正式环境最稳的通道：
 *     不经过公网 DNS、不受用户本地网络代理影响。
 *
 * 必须记住的两条硬限制（官方，改不了）：
 *  - **timeout 最大 15s**：传更大的值会被静默忽略。所以任何可能超过 15s 的 AI 操作
 *    都不能挂在这一次请求上，必须走「提交任务 → 轮询」（见 utils/task.js）。
 *  - 请求体 ≤100KiB、返回 ≤1000KiB：大图/视频只能走 fileID，不能塞进响应体。
 *
 * 另外两个真机才暴露的坑：
 *  - 调用前必须先 wx.cloud.init({ env })，否则报 `cloud init error`；
 *  - 某个环境的服务名写错时，返回的是 404 而不是「服务不存在」，
 *    所以这里把 statusCode 原样抛给上层，由 api.js 决定要不要退公网。
 */
const config = require('../config.js');

/** 官方硬上限 15s，留 1s 余量给链路建立 */
const TIMEOUT_MAX = 14000;
const TIMEOUT_DEFAULT = 12000;

let inited = false;
let initError = '';

/** 是否有云开发能力（开发者工具、真机、基础库 ≥2.2.3 才有） */
function available() {
  return typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.callContainer === 'function';
}

/** 幂等初始化：重复调用不会有副作用，这也是官方建议的用法 */
function init() {
  if (inited) return initError ? null : true;
  if (!available()) {
    initError = 'NO_CLOUD';
    return null;
  }
  try {
    wx.cloud.init({ env: config.cloudEnv, traceUser: false });
    inited = true;
    initError = '';
    return true;
  } catch (e) {
    initError = (e && e.errMsg) || (e && e.message) || 'CLOUD_INIT_FAILED';
    return null;
  }
}

/** GET 参数拼到 path 上：云托管对 GET 的 data 处理与 wx.request 不同，手动拼最可控 */
function withQuery(path, method, data) {
  if (method !== 'GET' || !data) return path;
  const keys = Object.keys(data).filter((k) => data[k] !== undefined && data[k] !== null);
  if (!keys.length) return path;
  const qs = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(data[k]))}`)
    .join('&');
  return `${path}${path.indexOf('?') >= 0 ? '&' : '?'}${qs}`;
}

/**
 * 调用云托管服务。
 *
 * @param {object} p
 * @param {string} p.path 以 / 开头的接口路径（可带 query）
 * @param {string} [p.method] GET|POST|PUT|DELETE
 * @param {object} [p.data] POST 为 JSON 体，GET 会拼成 query
 * @param {object} [p.header] 额外请求头（Authorization 默认由调用方传）
 * @param {number} [p.timeout] 毫秒，超过 14000 会被压到 14000
 * @param {string} [p.service] 服务名，默认取 config.cloudService
 * @returns {Promise<{statusCode:number, data:any, header:object}>}
 *          失败时 reject，err.code 为 'NO_CLOUD' | 'TIMEOUT' | 'NETWORK_ERROR' | 'CLOUD_INIT_FAILED'
 */
function callContainer({
  path, method = 'GET', data = {}, header = {}, timeout = TIMEOUT_DEFAULT, service = config.cloudService,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) {
      const e = new Error('内网通道不可用（当前环境不支持 wx.cloud）');
      e.code = 'NO_CLOUD';
      return reject(e);
    }
    if (!init()) {
      const e = new Error('云开发初始化失败');
      e.code = 'CLOUD_INIT_FAILED';
      e.raw = initError;
      return reject(e);
    }
    wx.cloud.callContainer({
      // config.env 决定打到哪个云托管环境；X-WX-SERVICE 决定打到哪个服务
      config: { env: config.cloudEnv },
      path: withQuery(path, method, data),
      method,
      timeout: Math.min(Number(timeout) || TIMEOUT_DEFAULT, TIMEOUT_MAX),
      header: {
        'X-WX-SERVICE': service,
        'Content-Type': 'application/json',
        ...header,
      },
      // GET 不能带 data，否则部分基础库会把 body 和 query 混在一起
      data: method === 'GET' ? undefined : data,
      success: (res) => resolve({
        statusCode: res.statusCode ?? res.status ?? 200,
        data: res.data,
        header: res.header || {},
      }),
      fail: (e) => {
        const raw = String((e && (e.errMsg || e.message)) || '');
        const err = new Error(raw || '内网通道请求失败');
        // 这三种要区分开：超时说明该改异步任务了，而不是提示用户「检查网络」
        if (/timeout|超时/i.test(raw)) err.code = 'TIMEOUT';
        else if (/init/i.test(raw)) err.code = 'CLOUD_INIT_FAILED';
        else err.code = 'NETWORK_ERROR';
        err.raw = raw;
        reject(err);
      },
    });
  });
}

module.exports = {
  TIMEOUT_MAX,
  TIMEOUT_DEFAULT,
  available,
  init,
  callContainer,
  withQuery,
};
