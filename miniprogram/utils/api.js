// 统一请求封装：只与自有后端通信，绝不接触上游算力凭据。
// token 自动注入 Authorization；401 自动重登并重试一次；所有错误带 code 供页面分支处理。
function base() {
  const app = getApp();
  return (app && app.globalData && app.globalData.baseUrl) || 'http://127.0.0.1:8787';
}

function token() {
  try {
    return wx.getStorageSync('token') || '';
  } catch (e) {
    return '';
  }
}

function request(opts) {
  const { url, method = 'GET', data = {}, toast = false, retry = true, timeout = 30000 } = opts;
  return new Promise((resolve, reject) => {
    wx.request({
      url: base() + url,
      method,
      data,
      timeout,
      header: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      },
      success: (res) => {
        const body = res.data || {};
        if (body.ok) return resolve(body.data);
        if (res.statusCode === 401 && retry) {
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
        if (toast) wx.showToast({ title: body.message || '请求失败', icon: 'none' });
        const err = new Error(body.message || '请求失败');
        err.code = body.code || 'REQUEST_FAILED';
        err.status = res.statusCode;
        err.detail = body.detail || {};
        reject(err);
      },
      fail: (e) => {
        if (toast) wx.showToast({ title: '网络异常，请稍后重试', icon: 'none' });
        const err = new Error('网络异常，请检查网络后重试');
        err.code = 'NETWORK_ERROR';
        err.raw = e;
        reject(err);
      },
    });
  });
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
      fail: () => {
        const err = new Error('上传中断，请检查网络后重试');
        err.code = 'NETWORK_ERROR';
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

  // —— 九大提示词库（V4.4，只读展示） ——
  prompts: () => request({ url: '/api/prompts' }),
  promptKind: (kind) => request({ url: `/api/prompts/${enc(kind)}` }),
};
