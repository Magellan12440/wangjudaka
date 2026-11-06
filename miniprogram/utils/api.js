// 统一请求封装：只与自有后端通信，绝不接触上游算力凭据。
// token 自动注入 Authorization；401 自动重登并重试一次；所有错误带 code 供页面分支处理。
const config = require('../config.js');

function base() {
  // 优先用 App 上算好的地址；拿不到时（页面先于 App 实例化、或 Node 自测）
  // 必须回退到 config.baseUrl，绝不能回退到 127.0.0.1 —— 手机上的 127.0.0.1 是手机自己。
  let fromApp = '';
  try {
    const app = getApp();
    fromApp = (app && app.globalData && app.globalData.baseUrl) || '';
  } catch (e) { /* 非小程序环境 */ }
  return fromApp || config.baseUrl;
}

function token() {
  try {
    return wx.getStorageSync('token') || '';
  } catch (e) {
    return '';
  }
}

// 通道偏好：一旦小程序内网通道成功过，后续优先走它（省掉一次必然失败的 http 请求）
const CHANNEL_KEY = 'use_container';

function preferContainer() {
  try { return wx.getStorageSync(CHANNEL_KEY) === 1; } catch (e) { return false; }
}

function markContainer(ok) {
  try {
    if (ok) wx.setStorageSync(CHANNEL_KEY, 1);
    else wx.removeStorageSync(CHANNEL_KEY);
  } catch (e) { /* ignore */ }
}

/** 把 wx 的 errMsg 翻成人话，供页面分支与用户判断 */
function classify(raw) {
  const s = String(raw || '');
  if (/not in domain list/i.test(s)) return 'DOMAIN_NOT_ALLOWED';
  if (/timeout/i.test(s)) return 'TIMEOUT';
  if (/ssl|cert/i.test(s)) return 'SSL_ERROR';
  return 'NETWORK_ERROR';
}

const CODE_TITLE = {
  DOMAIN_NOT_ALLOWED: '域名未加入白名单',
  TIMEOUT: '请求超时',
  SSL_ERROR: '证书校验失败',
  NETWORK_ERROR: '网络异常，请稍后重试',
  NO_CLOUD: '内网通道不可用',
};

/** 两条通道的响应处理完全一致，抽出来避免逻辑漂移 */
function handleResponse(res, opts, resolve, reject) {
  const body = res.data || {};
  if (body.ok) return resolve(body.data);
  if (res.statusCode === 401 && opts.retry) {
    const app = getApp();
    if (app && app.relogin) {
      return app.relogin()
        .then(() => request({ ...opts, retry: false }))
        .then(resolve)
        .catch(reject);
    }
  }
  if (res.statusCode === 401) {
    try { wx.removeStorageSync('token'); } catch (e) { /* ignore */ }
  }
  if (opts.toast) wx.showToast({ title: body.message || '请求失败', icon: 'none' });
  const err = new Error(body.message || '请求失败');
  err.code = body.code || 'REQUEST_FAILED';
  err.status = res.statusCode;
  err.detail = body.detail || {};
  reject(err);
}

function failWith(raw, opts, reject) {
  const code = classify(raw);
  const title = CODE_TITLE[code] || CODE_TITLE.NETWORK_ERROR;
  if (opts.toast) wx.showToast({ title, icon: 'none', duration: 2500 });
  const err = new Error(title);
  err.code = code;
  err.raw = raw;
  err.baseUrl = base();
  err.detail = { errMsg: String(raw || ''), baseUrl: base() };
  reject(err);
}

/** 通道 A：公网 HTTPS（wx.request）。域名没进白名单时会在 fail 里报 not in domain list。 */
function viaHttp(opts) {
  return new Promise((resolve, reject) => {
    const { url, method = 'GET', data = {}, timeout = 30000 } = opts;
    wx.request({
      url: base() + url,
      method,
      data,
      timeout,
      header: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      },
      success: (res) => handleResponse(res, opts, resolve, reject),
      fail: (e) => failWith(e && e.errMsg, opts, reject),
    });
  });
}

/**
 * 通道 B：小程序内网调用（wx.cloud.callContainer）。
 * 走微信内部链路到云托管，**不受 request 合法域名约束**，也不需要公网域名。
 * 需要基础库 ≥ 2.23.1 且已在 onLaunch 里 wx.cloud.init。
 */
function viaContainer(opts) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callContainer) {
      const err = new Error(CODE_TITLE.NO_CLOUD);
      err.code = 'NO_CLOUD';
      return reject(err);
    }
    const { url, method = 'GET', data = {}, timeout = 30000 } = opts;
    wx.cloud.callContainer({
      config: { env: config.cloudEnv },
      path: url,
      method,
      timeout,
      header: {
        'X-WX-SERVICE': config.cloudService,
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      },
      data,
      success: (res) => handleResponse(res, opts, resolve, reject),
      fail: (e) => failWith(e && e.errMsg, opts, reject),
    });
  });
}

/**
 * 请求入口：先走公网，遇到「域名未加白名单」或连不上，自动切内网通道重试一次。
 * 内网通道成功过就记住，后续直接走它——避免每次请求都先撞一次墙。
 */
function request(opts) {
  const o = Object.assign({ retry: true }, opts);
  const tryOrder = preferContainer() ? [viaContainer, viaHttp] : [viaHttp, viaContainer];
  const attempt = (i) => {
    if (i >= tryOrder.length) {
      return Promise.reject(Object.assign(new Error(CODE_TITLE.NETWORK_ERROR), { code: 'NETWORK_ERROR' }));
    }
    return tryOrder[i](o).catch((err) => {
      // 业务错误（4xx/5xx 且服务端有返回）不换通道，换了也一样
      if (err && err.status && err.code !== 'DOMAIN_NOT_ALLOWED') throw err;
      const retriable = ['DOMAIN_NOT_ALLOWED', 'NETWORK_ERROR', 'TIMEOUT', 'NO_CLOUD'].indexOf(err && err.code) >= 0;
      if (!retriable) throw err;
      const switchedToContainer = tryOrder[i] === viaHttp && tryOrder[i + 1] === viaContainer;
      return attempt(i + 1).then((d) => {
        if (switchedToContainer) markContainer(true);
        return d;
      });
    });
  };
  return attempt(0);
}

const enc = (v) => encodeURIComponent(v || '');

/** 把服务端返回的 /media/x.png 拼成可直接给 <image> / <video> 的绝对地址 */
function mediaUrl(p) {
  const s = String(p || '');
  if (!s) return '';
  if (/^https?:\/\//.test(s) || s.startsWith('wxfile://') || s.startsWith('ttfile://')) return s;
  return base() + (s.startsWith('/') ? s : `/${s}`);
}

/**
 * 上传素材：wx.uploadFile 走 multipart，不能用普通 request。
 * 服务端会按文件类型分流（文本入库 / 图片视频落盘）。
 */
function uploadMaterial(projectId, filePath, note) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${base()}/api/projects/${enc(projectId)}/materials/upload`,
      filePath,
      name: 'file',
      formData: { note: note || '' },
      timeout: 180000,
      header: token() ? { Authorization: `Bearer ${token()}` } : {},
      success: (res) => {
        let body = {};
        try { body = JSON.parse(res.data || '{}'); } catch (e) { /* keep empty */ }
        if (body.ok) return resolve(body.data);
        const err = new Error(body.message || '上传失败');
        err.code = body.code || 'UPLOAD_FAILED';
        err.status = res.statusCode;
        reject(err);
      },
      fail: (e) => {
        const raw = String((e && e.errMsg) || '');
        const isDomain = /not in domain list/i.test(raw);
        const err = new Error(isDomain ? '域名未加入白名单，无法上传' : '上传中断，请检查网络后重试');
        err.code = isDomain ? 'DOMAIN_NOT_ALLOWED' : 'NETWORK_ERROR';
        err.detail = { errMsg: raw, baseUrl: base() };
        reject(err);
      },
    });
  });
}

// 说明：小程序页面统一用 require，因此这里必须是 CommonJS 导出（不能写 export default）
module.exports = {
  request,
  mediaUrl,
  baseUrl: base,

  // —— 登录态 ——
  login: (payload) => request({ url: '/api/auth/login', method: 'POST', data: payload, retry: false }),
  me: () => request({ url: '/api/auth/me' }),
  updateProfile: (payload) =>
    request({ url: '/api/auth/profile', method: 'POST', data: payload, toast: true }),
  wechatStatus: () => request({ url: '/api/wechat/status' }),

  // —— 用户可选模型目录（每环节最多 5 个，已实测可用才出现） ——
  catalogModels: (role) => request({ url: '/api/catalog/models', data: role ? { role } : {} }),

  // —— 首页 / 项目聚合 ——
  home: (userId) => request({ url: '/api/home', data: { userId } }),
  overview: (projectId) => request({ url: `/api/projects/${enc(projectId)}/overview` }),

  // —— 目录 ——
  styles: () => request({ url: '/api/styles' }),
  directors: () => request({ url: '/api/directors' }),
  models: (role) => request({ url: '/api/models', data: role ? { role } : {} }),
  platforms: () => request({ url: '/api/platforms' }),
  emotionCards: (params) => request({ url: '/api/emotion-cards', data: params || {} }),
  emotionCard: (code) => request({ url: `/api/emotion-cards/${enc(code)}` }),

  // —— 账户 ——
  balance: (userId) => request({ url: '/api/account/balance', data: { userId } }),
  entries: (userId) => request({ url: '/api/account/entries', data: { userId } }),

  // —— 充值（虚拟支付，iOS 合规唯一通道）——
  payPackages: () => request({ url: '/api/pay/packages' }),
  rechargePackages: () => request({ url: '/api/recharge/packages' }),
  createPayOrder: (packageId) =>
    request({ url: '/api/pay/virtual/order', method: 'POST', data: { packageId }, toast: true }),
  mockPaySuccess: (orderId) =>
    request({ url: '/api/pay/virtual/mock-success', method: 'POST', data: { orderId }, toast: true }),
  payOrders: () => request({ url: '/api/pay/virtual/orders' }),

  // —— 兑换码 ——
  redeem: (code, userId) =>
    request({ url: '/api/redeem', method: 'POST', data: { code, userId }, toast: true }),
  myRedeems: (userId) => request({ url: '/api/redeem/mine', data: userId ? { userId } : {} }),

  // —— 项目 ——
  createProject: (payload) => request({ url: '/api/projects', method: 'POST', data: payload, toast: true, timeout: 60000 }),
  projects: (userId) => request({ url: '/api/projects', data: { userId } }),
  project: (id) => request({ url: `/api/projects/${enc(id)}` }),
  lookupProject: (no) => request({ url: '/api/projects/lookup', data: { no } }),
  updateProject: (id, payload) =>
    request({ url: `/api/projects/${enc(id)}/settings`, method: 'POST', data: payload, toast: true }),
  projectPlan: (projectId) => request({ url: `/api/projects/${enc(projectId)}/plan` }),
  buildProjectPlan: (projectId) =>
    request({ url: `/api/projects/${enc(projectId)}/plan`, method: 'POST', data: {}, timeout: 120000 }),
  docsCheck: (projectId) => request({ url: `/api/projects/${enc(projectId)}/docs/check` }),

  // —— 剧壳（片头片尾 / 系列标识） ——
  projectShell: (projectId) => request({ url: `/api/projects/${enc(projectId)}/shell` }),
  saveShell: (projectId, payload) =>
    request({ url: `/api/projects/${enc(projectId)}/shell`, method: 'POST', data: payload, toast: true }),
  renderShellCard: (projectId, kind) =>
    request({
      url: `/api/projects/${enc(projectId)}/shell/card`, method: 'POST',
      data: { kind: kind || 'intro' }, timeout: 120000,
    }),

  // —— 剧集生产（单集 / 全自动托管） ——
  produce: (projectId, payload) =>
    request({
      url: `/api/projects/${enc(projectId)}/produce`, method: 'POST',
      data: payload || {}, toast: true, timeout: 240000,
    }),
  projectJobs: (projectId) => request({ url: `/api/projects/${enc(projectId)}/produce` }),
  produceJob: (jobId) => request({ url: `/api/produce/${enc(jobId)}` }),
  produceStep: (jobId) =>
    request({ url: `/api/produce/${enc(jobId)}/step`, method: 'POST', data: {}, timeout: 240000 }),
  producePause: (jobId) => request({ url: `/api/produce/${enc(jobId)}/pause`, method: 'POST', data: {}, toast: true }),
  produceResume: (jobId) => request({ url: `/api/produce/${enc(jobId)}/resume`, method: 'POST', data: {}, toast: true }),
  projectFilms: (projectId) => request({ url: `/api/projects/${enc(projectId)}/films` }),
  myFilms: () => request({ url: '/api/me/films' }),

  // —— 分发资料包（一键备齐平台审核材料） ——
  prepareSubmission: (projectId, payload) =>
    request({
      url: `/api/projects/${enc(projectId)}/submission/prepare`, method: 'POST',
      data: payload || {}, toast: true, timeout: 180000,
    }),
  submissions: (projectId) => request({ url: `/api/projects/${enc(projectId)}/submission` }),
  markSubmitted: (packId, distributionId) =>
    request({
      url: `/api/submission/${enc(packId)}/submitted`, method: 'POST',
      data: { distributionId: distributionId || null }, toast: true,
    }),

  // —— 剧本（项目内） ——
  projectScript: (projectId) => request({ url: `/api/projects/${enc(projectId)}/script` }),

  // —— 素材库（文本 / 图片 / 视频 / docx） ——
  materials: (projectId) => request({ url: `/api/projects/${enc(projectId)}/materials` }),
  addTextMaterial: (projectId, payload) =>
    request({ url: `/api/projects/${enc(projectId)}/materials/text`, method: 'POST', data: payload, toast: true, timeout: 60000 }),
  uploadMaterial,
  removeMaterial: (projectId, materialId) =>
    request({ url: `/api/projects/${enc(projectId)}/materials/${enc(materialId)}/remove`, method: 'POST', data: {}, toast: true }),
  materialDigest: (projectId) => request({ url: `/api/projects/${enc(projectId)}/materials/digest` }),

  // —— 镜头生产（项目内） ——
  generateShot: (projectId, shotNo, kind) =>
    request({
      url: `/api/projects/${enc(projectId)}/shots/${enc(shotNo)}/generate`,
      method: 'POST', data: { kind: kind || 'image' }, toast: true, timeout: 180000,
    }),
  shotGenerations: (projectId, shotNo) =>
    request({ url: `/api/projects/${enc(projectId)}/shots/${enc(shotNo)}/generations` }),

  // —— 一句话成片 ——
  quote: (payload) => request({ url: '/api/oneshot/quote', method: 'POST', data: payload, toast: true }),
  storyChain: (payload) => request({ url: '/api/story/chain', method: 'POST', data: payload, toast: true, timeout: 120000 }),
  directorPlan: (payload) => request({ url: '/api/story/plan', method: 'POST', data: payload }),
  script: (payload) => request({ url: '/api/story/script', method: 'POST', data: payload }),
  storyboard: (payload) => request({ url: '/api/story/storyboard', method: 'POST', data: payload }),
  blueprints: () => request({ url: '/api/blueprints' }),
  createRun: (projectId, templateCode) =>
    request({ url: '/api/runs', method: 'POST', data: { projectId, templateCode } }),
  run: (id) => request({ url: `/api/runs/${enc(id)}` }),
  runNext: (id) => request({ url: `/api/runs/${enc(id)}/next` }),
  markNode: (runId, nodeId, payload) =>
    request({ url: `/api/runs/${enc(runId)}/nodes/${enc(nodeId)}`, method: 'POST', data: payload }),

  // —— 资产 ——
  assets: (projectId, type) =>
    request({ url: `/api/projects/${enc(projectId)}/assets`, data: type ? { type } : {} }),
  createAsset: (projectId, payload) =>
    request({ url: `/api/projects/${enc(projectId)}/assets`, method: 'POST', data: payload, toast: true }),

  // —— 生成 ——
  generate: (payload) => request({ url: '/api/generate', method: 'POST', data: payload, toast: true, timeout: 180000 }),
  generations: (projectId) => request({ url: '/api/generations', data: { projectId } }),

  // —— 分发 ——
  distributions: (projectId) => request({ url: '/api/distribution', data: { projectId } }),
  createDistribution: (payload) =>
    request({ url: '/api/distribution', method: 'POST', data: payload, toast: true }),
  distributionStatus: (id, status, extra) =>
    request({ url: `/api/distribution/${enc(id)}/status`, method: 'POST', data: { status, extra: extra || {} }, toast: true }),
  distributionRevenue: (id, payload) =>
    request({ url: `/api/distribution/${enc(id)}/revenue`, method: 'POST', data: payload, toast: true }),
  distributionStats: (id, payload) =>
    request({ url: `/api/distribution/${enc(id)}/stats`, method: 'POST', data: payload, toast: true }),
  distributionContract: (id, payload) =>
    request({ url: `/api/distribution/${enc(id)}/contract`, method: 'POST', data: payload || {}, toast: true }),
  platformSummary: (projectId) => request({ url: '/api/distribution/summary', data: { projectId } }),

  // —— 质检 / 交付 ——
  qcProviders: () => request({ url: '/api/qc/providers' }),
  qcReport: (projectId, params) =>
    request({ url: '/api/qc/consistency/report', data: Object.assign({ projectId }, params || {}) }),
  qcCheck: (payload) => request({ url: '/api/qc/consistency/check', method: 'POST', data: payload }),
  qcAdvice: (id) => request({ url: `/api/qc/consistency/advice/${enc(id)}` }),
  deliveryGate: (payload) => request({ url: '/api/qc/delivery-gate', method: 'POST', data: payload }),

  // —— 数据看板 / 收益 / 合规包 ——
  dashboard: (projectId) => request({ url: '/api/analytics/dashboard', data: { projectId } }),
  settlements: (projectId) => request({ url: '/api/analytics/settlements', data: { projectId } }),
  revenuePolicies: () => request({ url: '/api/revenue-policies' }),
  calculateRevenue: (payload) =>
    request({ url: '/api/analytics/revenue/calculate', method: 'POST', data: payload }),
  buildCompliancePack: (payload) =>
    request({ url: '/api/compliance/pack', method: 'POST', data: payload, toast: true, timeout: 60000 }),
  compliancePack: (projectId, episodeNo) =>
    request({ url: '/api/compliance/pack', data: { projectId, episodeNo: episodeNo || 'E01' } }),

  // —— 邀请裂变 ——
  inviteMe: (userId) => request({ url: '/api/invite/me', data: userId ? { userId } : {} }),
  inviteBind: (payload) => request({ url: '/api/invite/bind', method: 'POST', data: payload, toast: true }),

  // —— 系列 / 续集 ——
  series: (userId) => request({ url: '/api/series', data: userId ? { userId } : {} }),
  projectSeries: (projectId) => request({ url: `/api/projects/${enc(projectId)}/series` }),
  createSeason: (projectId, payload) =>
    request({ url: `/api/projects/${enc(projectId)}/season`, method: 'POST', data: payload || {}, toast: true, timeout: 60000 }),
  lineage: (projectId) => request({ url: `/api/projects/${enc(projectId)}/assets/lineage` }),
  archiveProject: (projectId, archived) =>
    request({ url: `/api/projects/${enc(projectId)}/archive`, method: 'POST', data: { archived }, toast: true }),

  // —— 剪辑成片（V4.2） ——
  editPlan: (projectId, episode) =>
    request({ url: `/api/projects/${enc(projectId)}/edit`, data: episode ? { episode } : {}, timeout: 60000 }),
  editRender: (projectId, episode) =>
    request({
      url: `/api/projects/${enc(projectId)}/edit/render`, method: 'POST',
      data: { episode: episode || null }, toast: true, timeout: 600000,
    }),

  // —— 一句话成剧编排（V4.2） ——
  oneshotStart: (projectId) =>
    request({ url: '/api/oneshot/start', method: 'POST', data: { projectId }, toast: true, timeout: 180000 }),
  oneshotStep: (runId) =>
    request({ url: `/api/oneshot/${enc(runId)}/step`, method: 'POST', data: {}, timeout: 180000 }),
  oneshotRun: (runId) => request({ url: `/api/oneshot/${enc(runId)}` }),

  // —— 内容安全 ——
  securityCheck: (payload) =>
    request({ url: '/api/security/check', method: 'POST', data: payload, toast: true }),

  // —— 账号体系（V4.4）：验证码 / 手机号密码 / 绑定手机 ——
  sendSms: (phone) => request({ url: '/api/auth/sms', method: 'POST', data: { phone }, toast: true }),
  loginByCode: (phone, code, nickname) =>
    request({ url: '/api/auth/login/code', method: 'POST', data: { phone, code, nickname: nickname || null } }),
  loginByPassword: (phone, password) =>
    request({ url: '/api/auth/login/password', method: 'POST', data: { phone, password } }),
  setPassword: (password) =>
    request({ url: '/api/auth/password', method: 'POST', data: { password }, toast: true }),
  bindPhone: (phone, code) =>
    request({ url: '/api/auth/bind-phone', method: 'POST', data: { phone, code }, toast: true }),

  // —— 收益看板（V4.4） ——
  revenue: () => request({ url: '/api/me/revenue' }),
  // 批量回填：一次提交多条，后端整批校验归属、整批写入（不做半截成功）
  revenueBatch: (payload) =>
    request({ url: '/api/me/revenue/batch', method: 'POST', data: payload, toast: true }),
  // 月度对账单：返回 CSV 文本，前端复制到剪贴板（小程序打不开 csv 文件）
  // 不传账期即当月——路径固定，体检脚本才能核对服务端是否存在这个接口
  revenueExport: () => request({ url: '/api/me/revenue/export' }),

  // —— 九大提示词库（V4.4，只读展示） ——
  prompts: () => request({ url: '/api/prompts' }),
  promptKind: (kind) => request({ url: `/api/prompts/${enc(kind)}` }),

  // —— 管理后台（V4.7）：管理员在手机里就能操作 ——
  adminBootstrapStatus: () => request({ url: '/api/admin/bootstrap' }),
  adminBootstrap: (payload) =>
    request({ url: '/api/admin/bootstrap', method: 'POST', data: payload, toast: true }),
  adminLogin: (phone, password) =>
    request({ url: '/api/admin/login', method: 'POST', data: { phone, password } }),
  adminStats: () => request({ url: '/api/admin/stats' }),
  adminUsers: (q, offset) =>
    request({ url: '/api/admin/users', data: { q: q || '', offset: offset || 0, limit: 30 } }),
  adminUser: (id) => request({ url: `/api/admin/users/${enc(id)}` }),
  adminAdjustPoints: (id, delta, note) =>
    request({ url: `/api/admin/users/${enc(id)}/points`, method: 'POST', data: { delta, note }, toast: true }),
  adminSetStatus: (id, status) =>
    request({ url: `/api/admin/users/${enc(id)}/status`, method: 'POST', data: { status }, toast: true }),
  adminSetRole: (id, role) =>
    request({ url: `/api/admin/users/${enc(id)}/role`, method: 'POST', data: { role }, toast: true }),
  adminCodes: () => request({ url: '/api/admin/redeem-codes' }),
  adminCreateCodes: (payload) =>
    request({ url: '/api/admin/redeem-codes', method: 'POST', data: payload, toast: true }),
  adminModels: () => request({ url: '/api/admin/models/catalog' }),
  adminProbeModels: (deep) =>
    request({ url: '/api/admin/models/probe', method: 'POST', data: { deep: deep === true }, timeout: 120000 }),
  adminRelay: () => request({ url: '/api/admin/relay' }),

  /**
   * 网络自检：把「公网通道」和「内网通道」都探一遍，直接告诉你哪条能用。
   * 不抛异常，任何失败都转成结构化结果。
   */
  netDiag: () =>
    new Promise((resolve) => {
      const host = base();

      const probeHttp = new Promise((r) => {
        const started = Date.now();
        wx.request({
          url: `${host}/health`,
          method: 'GET',
          timeout: 12000,
          success: (res) => {
            const body = res.data || {};
            const d = body.data || body;
            r({
              ok: res.statusCode === 200,
              ms: Date.now() - started,
              status: res.statusCode,
              version: d.version || '',
              relay: (d.relay && d.relay.mode) || '',
              reason: res.statusCode === 200 ? '' : `HTTP ${res.statusCode}`,
            });
          },
          fail: (e) => {
            const raw = String((e && e.errMsg) || '');
            r({
              ok: false,
              ms: Date.now() - started,
              status: 0,
              version: '',
              relay: '',
              reason: /not in domain list/i.test(raw) ? '域名未加入 request 合法域名'
                : /timeout/i.test(raw) ? '请求超时'
                  : /ssl|cert/i.test(raw) ? '证书校验失败'
                    : (raw || '网络不可达'),
            });
          },
        });
      });

      const probeContainer = new Promise((r) => {
        if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callContainer) {
          return r({ ok: false, reason: '未初始化云开发（基础库 < 2.23.1 或未 init）' });
        }
        const started = Date.now();
        wx.cloud.callContainer({
          config: { env: config.cloudEnv },
          path: '/health',
          method: 'GET',
          timeout: 12000,
          header: { 'X-WX-SERVICE': config.cloudService, 'Content-Type': 'application/json' },
          success: (res) => {
            let d = res.data;
            if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = {}; } }
            d = (d && d.data) || d || {};
            r({ ok: res.statusCode === 200, ms: Date.now() - started, version: d.version || '' });
          },
          fail: (e) => r({ ok: false, ms: Date.now() - started, reason: String((e && e.errMsg) || '调用失败') }),
        });
      });

      Promise.all([probeHttp, probeContainer]).then(([http, container]) => {
        const best = http.ok ? http : (container.ok ? container : http);
        resolve({
          ok: http.ok || container.ok,
          baseUrl: host,
          ms: best.ms,
          status: best.status || 0,
          version: best.version || '',
          relay: best.relay || '',
          channel: http.ok ? '公网' : (container.ok ? '内网' : '都不通'),
          reason: http.ok || container.ok ? ''
            : (container.reason ? `${http.reason}；内网：${container.reason}` : http.reason),
          http,
          container,
        });
      });
    }),
};
