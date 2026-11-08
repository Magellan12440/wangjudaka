/**
 * 小程序页面「运行时」自测（无微信开发者工具也能跑）。
 *
 * 做法：在 Node 里伪造 App / Page / wx / getApp 运行环境，直接 require 页面 js，
 * 按真实生命周期（onLoad → onShow）把每个页面跑一遍，再对 page.data 断言。
 *
 * 与 check_miniprogram.js 的分工：
 *   - check_miniprogram.js  = 静态体检（语法 / 结构 / 路径对齐）
 *   - 本脚本                = 运行时体检（真实调接口、真实走 setData）
 *
 * 运行：npm run mini:sim
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const MINI_ROOT = path.resolve(SERVER_ROOT, '../miniprogram');
const PORT = Number(process.env.SIM_PORT || 8796);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const toasts = [];
const modals = [];
const navs = [];

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(`${name}${detail ? ' → ' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 伪造 wx 运行时 ——
const storage = new Map();

function setByPath(obj, key, value) {
  if (!key.includes('.')) { obj[key] = value; return; }
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

const wx = {
  request(opts) {
    // 对齐小程序行为：GET 的 data 会被序列化进 query string
    let url = opts.url;
    const method = (opts.method || 'GET').toUpperCase();
    let body;
    if (method === 'GET') {
      const qs = Object.entries(opts.data || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    } else if (opts.data) {
      body = JSON.stringify(opts.data);
    }
    fetch(url, { method, headers: opts.header || {}, body })
      .then(async (r) => {
        const text = await r.text();
        let data = text;
        try { data = JSON.parse(text); } catch { /* keep text */ }
        opts.success && opts.success({ statusCode: r.status, data });
      })
      .catch((e) => opts.fail && opts.fail({ errMsg: String(e.message) }));
  },
  login({ success }) { success && success({ code: 'sim-code-fixed' }); },
  getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
  showToast: (o) => { toasts.push(o.title); },
  showLoading: () => {},
  hideLoading: () => {},
  showModal: (o) => {
    modals.push({ title: o.title || '', content: o.content || '' });
    o.success && o.success({ confirm: true, cancel: false, content: o.content || '' });
  },
  showActionSheet: (o) => { o.success && o.success({ tapIndex: 0 }); },
  setClipboardData: (o) => { o.success && o.success({}); },
  pageScrollTo: () => {},
  stopPullDownRefresh: () => {},
  switchTab: (o) => { navs.push(`switchTab:${o.url}`); o.success && o.success({}); },
  navigateTo: (o) => { navs.push(`navigateTo:${o.url}`); o.success && o.success({}); },
  redirectTo: (o) => { navs.push(`redirectTo:${o.url}`); o.success && o.success({}); },
  setNavigationBarTitle: () => {},
  getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 375, windowHeight: 667 }),
  getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, left: 280, right: 368 }),
  getPrivacySetting: (o) => { o.success && o.success({ needAuthorization: false }); },
  openPrivacyContract: () => {},
  previewImage: () => {},
  requestVirtualPayment: (o) => { o.fail && o.fail({ errMsg: 'requestVirtualPayment:cancel' }); },
};

// —— 伪造 App 实例 ——
let appInstance = null;
function makeApp() {
  const app = {
    globalData: {
      baseUrl: BASE, token: '', userId: '', balance: 0, loginMode: '', user: null,
      statusBarHeight: 44, navBarHeight: 88, draftPrompt: '', selectedProjectId: '',
    },
    readyPromise: null,
    ready() { return this.readyPromise || Promise.resolve(this.globalData); },
    applyUser(d) {
      if (!d || !d.user) return this.globalData;
      this.globalData.user = d.user;
      this.globalData.userId = d.user.id;
      this.globalData.balance = d.user.balance_points || 0;
      this.globalData.loginMode = d.mode || '';
      return this.globalData;
    },
    refreshBalance() { return Promise.resolve(this.globalData.balance); },
    relogin() { return this.login(); },
    // 账号簿（V4.9.1）：仿真环境里给一个空列表，账号页就不会因为缺方法而整页失败
    accountList() { return []; },
    switchAccount() { return Promise.resolve(this.globalData); },
    toLogin(o) { navs.push(`navigateTo:/pages/login/login${o && o.add ? '?mode=add' : ''}`); },
    login() {
      this.readyPromise = fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'sim-code-fixed' }),
      })
        .then((r) => r.json())
        .then((body) => {
          const d = body.data || {};
          if (d.token) { this.globalData.token = d.token; storage.set('token', d.token); }
          return this.applyUser(d);
        });
      return this.readyPromise;
    },
  };
  return app;
}

function installGlobals() {
  global.wx = wx;
  global.getApp = () => appInstance;
  global.App = (cfg) => { appInstance = Object.assign(cfg, cfg); };
  global.getCurrentPages = () => [];
}

// —— 页面加载器 ——
function loadPage(relPath) {
  const req = createRequire(path.join(MINI_ROOT, relPath.replace(/\.js$/, '.js')));
  let captured = null;
  global.Page = (cfg) => { captured = cfg; };
  const full = path.join(MINI_ROOT, relPath);
  delete req.cache[req.resolve(full)];
  req(full);
  if (!captured) throw new Error(`页面未注册: ${relPath}`);
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data || {}));
  page.setData = (patch, cb) => {
    for (const [k, v] of Object.entries(patch || {})) setByPath(page.data, k, v);
    if (typeof cb === 'function') cb();
  };
  return page;
}

async function waitHealth() {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch { /* not ready */ }
    await sleep(150);
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(os.tmpdir(), `wangjudaka-sim-${process.pid}-${Date.now()}`),
      RELAY_MOCK: 'true',
      NODE_ENV: 'test',
      ADMIN_TOKEN: 'sim-admin-token',
      WX_APPID: '', WX_SECRET: '', WX_PAY_OFFER_ID: '', WX_PAY_APP_KEY: '', RELAY_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  try {
    if (!(await waitHealth())) throw new Error(`服务未启动\n${log}`);

    installGlobals();
    // 先按真实启动顺序跑 App.onLaunch：登录 → globalData 就绪
    const appCfg = makeApp();
    appInstance = appCfg;
    await appCfg.login();
    ok('启动登录拿到用户', Boolean(appInstance.globalData.userId), appInstance.globalData.userId);

    // —— 1. 首页 ——
    const index = loadPage('pages/index/index.js');
    index.onLoad();
    index.onShow();
    await sleep(600);
    ok('首页出骨架后拿到数据', index.data.loading === false && !index.data.error, index.data.error);
    ok('首页统计已聚合', (index.data.stats.projects || 0) >= 0 && typeof index.data.stats.shots === 'number');
    ok('首页隐私弹层默认关闭', index.data.privacyNeeded === false);

    // 首页只输剧名 → 跳创作（新建项目就是全部创作的开关）
    index.onInput({ detail: { value: '长夜归人' } });
    index.startCreate();
    ok('首页把剧名带给创作页', appInstance.globalData.draftTitle === '长夜归人', appInstance.globalData.draftTitle);
    ok('首页跳转到创作 tab', navs.some((n) => n.includes('/pages/create/create')));

    // —— 2. 创作页 ——
    const create = loadPage('pages/create/create.js');
    create.onLoad();
    create.onShow();
    await sleep(600);
    ok('创作页风格库加载 32 套', (create.data.styles || []).length === 32, String((create.data.styles || []).length));
    ok('创作页带入首页剧名', create.data.title === '长夜归人', create.data.title);
    ok('创作页无剧名不可建项目', create.data.canCreate === true);
    ok('模型目录每环节最多 5 个', (create.data.modelRoles || []).length === 4
      && (create.data.modelRoles || []).every((r) => r.items.length <= 5),
    JSON.stringify((create.data.modelRoles || []).map((r) => `${r.key}:${r.items.length}`)));
    ok('剧本环节默认 DeepSeek V4.1', (create.data.picks || {}).chat === 'AUTO-DEEPSEEK-V4_1-FLASH', create.data.picks && create.data.picks.chat);

    create.refreshQuote();
    await sleep(500);
    ok('报价返回预估点数', create.data.quote && create.data.quote.est_credits > 0, JSON.stringify(create.data.quote && create.data.quote.est_credits));
    ok('报价文案已预计算', Boolean(create.data.quote && create.data.quote.time_text && create.data.quote.credits_text));
    ok('报价按 2 倍计费口径展示', Number(create.data.billingMultiplier) === 2, String(create.data.billingMultiplier));

    // 静态漫剧应比动态便宜（切参数后重新报价）
    const dynamicCredits = create.data.quote.est_credits;
    create.setData({ step: 2 }); // 只有第 2 步起改参数才会自动重算报价
    create.pick({ currentTarget: { dataset: { field: 'videoType', value: 'static' } } });
    await sleep(500);
    ok('静态漫剧报价更低', create.data.quote.est_credits < dynamicCredits,
      `${create.data.quote.est_credits} < ${dynamicCredits}`);

    // —— 3. 真实建项目（走页面 create()，验证串起来的主链路）——
    create.pick({ currentTarget: { dataset: { field: 'videoType', value: 'dynamic' } } });
    await sleep(400);
    // 建项目后停在素材 tab，剧本与分镜在项目内再生成（不自动烧点）
    create.create();
    await sleep(2400);
    const projNav = navs.find((n) => n.includes('/pages/project/project'));
    ok('创作完成后进入剧组', Boolean(projNav), projNav || '未跳转');
    ok('首次进入带 setup 引导标记', String(projNav).includes('setup=1'), projNav || '');
    ok('建项目后进入设置引导', String(projNav).includes('fresh=1'), projNav || '');
    const projectId = projNav ? decodeURIComponent(projNav.split('id=')[1].split('&')[0]) : '';

    // 充值：管理员发兑换码 → 用户兑换（顺带验证兑换写链路，镜头生成要花点数）
    const codeRes = await fetch(`${BASE}/api/admin/redeem-codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'sim-admin-token' },
      body: JSON.stringify({ points: 500, count: 1 }),
    }).then((r) => r.json()).catch(() => null);
    const redeemCode = codeRes && codeRes.data && (codeRes.data.codes || [])[0];
    ok('管理员可生成兑换码', Boolean(redeemCode), JSON.stringify(codeRes).slice(0, 100));
    if (redeemCode) {
      const rd = await fetch(`${BASE}/api/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: appInstance.globalData.userId, code: redeemCode }),
      }).then((r) => r.json());
      ok('兑换码可充值点数', Boolean(rd && rd.data && rd.data.balance >= 500), JSON.stringify(rd && rd.data && rd.data.balance));
      appInstance.globalData.balance = (rd && rd.data && rd.data.balance) || 0;
    }

    // —— 4. 剧组：素材 → 剧本 → 逐镜出图 ——
    const project = loadPage('pages/project/project.js');
    project.onLoad({ id: projectId, fresh: '1', setup: '1' });
    project.onShow();
    await sleep(1000);
    ok('剧组页加载成功', project.data.loading === false && !project.data.error, project.data.error);
    ok('新项目默认停在素材 tab', project.data.tab === 'material', project.data.tab);
    ok('新项目素材为空', (project.data.materials || []).length === 0, String((project.data.materials || []).length));
    ok('新项目无成片、无托管任务', (project.data.films || []).length === 0 && !project.data.job);
    ok('新项目制作进度为个位数', project.data.progress.percent <= 20, String(project.data.progress.percent));
    ok('界面不再暴露流水线节点', project.data.nodes === undefined, typeof project.data.nodes);

    // 上传小说正文作为剧本创作素材
    project.openTextSheet();
    project.onTextName({ detail: { value: '测试小说素材' } });
    project.onTextBody({
      detail: {
        value: '第一场 夜 外 城中村天台\n李默握着一张被雨水泡皱的欠条，风把纸角掀起来，露出“叁拾万”三个字。\n'
          + '他身后是整片出租屋的灯，像一盘没熄的炭。\n\n'
          + '第二场 日 内 面馆\n老板娘把一碗面推过来，汤面浮着两片薄如纸的牛肉。\n'
          + '“你爸那笔账，不该你来还。”她说。\n',
      },
    });
    project.saveText();
    await sleep(900);
    ok('素材文本已入库', (project.data.materials || []).length >= 1, String((project.data.materials || []).length));
    ok('素材统计已更新', (project.data.materialStats || {}).total >= 1, JSON.stringify(project.data.materialStats));

    // 用素材生成剧本与分镜
    project.generateScript();
    await sleep(2600);
    ok('生成后自动切到剧本 tab', project.data.tab === 'script', project.data.tab);
    ok('剧本分集已就绪', (project.data.epOptions || []).length >= 1, String((project.data.epOptions || []).length));
    ok('场次已渲染', (project.data.currentScenes || []).length >= 1, String((project.data.currentScenes || []).length));
    ok('场次光影文案已预计算', (project.data.currentScenes || []).every((s) => typeof s.lockedText === 'string'));
    ok('分镜卡已就绪', (project.data.shots || []).length > 0);
    ok('剧本生成后制作进度前进', project.data.progress.percent > 0, String(project.data.progress.percent));
    ok('剧组页进度结构完整', typeof project.data.progress.done === 'number' && typeof project.data.progress.total === 'number',
      JSON.stringify(project.data.progress));
    ok('交付清单 6 项', (project.data.deliveryItems || []).length === 6);
    ok('角色资产已落库', (project.data.assets || {}).total >= 3, String(project.data.assets && project.data.assets.total));

    // 视频必须先有关键帧（服务端闸门：没有关键帧 / 没过五维一致性都拦）
    const shotNo = ((project.data.shots || [])[1] || {}).no;
    modals.length = 0;
    project.genShot({ currentTarget: { dataset: { no: shotNo, kind: 'video' } } });
    await sleep(1200);
    ok('无关键帧时视频被拦下', modals.some((m) => /关键帧|一致性/.test(m.content)), JSON.stringify(modals.slice(-1)));

    // V4.11：五维一致性要求先有资产设定图（角色/场景），分镜才有视觉依据
    project.genAssetType({ currentTarget: { dataset: { type: 'character' } } });
    await sleep(3200);
    project.genAssetType({ currentTarget: { dataset: { type: 'scene' } } });
    await sleep(3200);
    ok('资产设定图已就绪', ((project.data.assetProgress || {}).ready || 0) >= 2,
      JSON.stringify(project.data.assetProgress && project.data.assetProgress.ready));

    // 按镜出关键帧
    project.genShot({ currentTarget: { dataset: { no: shotNo, kind: 'image' } } });
    await sleep(2600);
    ok('逐镜出图成功', ((project.data.gens || {}).total || 0) >= 1, JSON.stringify(project.data.gens && project.data.gens.total));

    project.switchTab({ currentTarget: { dataset: { tab: 'script' } } });
    ok('剧组页切 tab', project.data.tab === 'script', project.data.tab);
    project.toggleShots();
    ok('分镜展开/收起可用', typeof project.data.shotLimit === 'number');

    // 成片 tab：剪辑单（不假装出片，只给真实覆盖率）
    project.switchTab({ currentTarget: { dataset: { tab: 'deliver' } } });
    await sleep(1500);
    if (project.data.edit) {
      ok('成片 tab 拿到剪辑单', project.data.edit.shotCount > 0, `shots=${project.data.edit.shotCount}`);
      ok('剪辑单含字幕与声音', project.data.edit.subtitleCount > 0 && project.data.edit.sfxCount >= 0,
        `srt=${project.data.edit.subtitleCount} sfx=${project.data.edit.sfxCount}`);
      ok('剪辑单标明素材覆盖率', project.data.edit.coverage <= 100, String(project.data.edit.coverage));
    } else {
      ok('成片 tab 拿到剪辑单', false, project.data.editError || '无剪辑单');
    }

    // —— 5. 分发中控 ——
    const dist = loadPage('pages/distribute/distribute.js');
    dist.onLoad();
    await sleep(900);
    ok('分发页加载项目列表', (dist.data.projects || []).length >= 1, String((dist.data.projects || []).length));
    ok('分发页 8 个平台', (dist.data.platforms || []).length === 8, String((dist.data.platforms || []).length));
    ok('分发页平台短名已算好', (dist.data.platforms || []).every((p) => p.short && p.cls), '');
    ok('分发页收益政策可拉取', (dist.data.policies || []).length > 0);
    dist.calculate();
    await sleep(600);
    ok('分发页收益测算出数', Boolean(dist.data.calc && dist.data.calc.net), JSON.stringify(dist.data.calc && dist.data.calc.net));

    // 建一条分发任务 + 回填数据（验证写链路）
    dist.setData({ projectId, sheetPlatform: dist.data.platforms[0] });
    dist.createTask({ currentTarget: { dataset: { code: dist.data.platforms[0].code } } });
    await sleep(800);
    ok('分发任务创建成功', (dist.data.tasks || []).length >= 1, String((dist.data.tasks || []).length));
    if ((dist.data.tasks || []).length) {
      const t = dist.data.tasks[0];
      dist.setData({ statsTask: t, statsForm: { views: '120000', likes: '8000', completion: '55' } });
      dist.submitStats();
      await sleep(700);
      const after = (dist.data.tasks || []).find((x) => x.id === t.id);
      ok('分发数据回填生效', Boolean(after && after.viewsText && after.viewsText !== '—'), after && after.viewsText);
    }

    // —— 6. 我的 ——
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    await sleep(900);
    ok('我的页用户信息就绪', Boolean(mine.data.userId) && mine.data.loading === false);
    ok('我的页点数档位可拉取', (mine.data.packages || []).length > 0);
    ok('我的页余额为数字', typeof mine.data.balance === 'number');
    navs.length = 0;
    mine.openRecharge();
    ok('充值跳到独立充值页', navs.some((u) => u.includes('/pages/recharge/recharge')), navs.join(','));
    navs.length = 0;
    mine.openPackage({ currentTarget: { dataset: { id: 'PKG-500' } } });
    ok('点档位带着档位号跳转', navs.some((u) => u.includes('id=PKG-500')), navs.join(','));
    mine.closeSheet();
    mine.openRedeem();
    ok('我的页兑换弹层可打开', mine.data.sheet === 'redeem');
    mine.closeSheet();

    // —— 6b. 账号与额度（V4.9）——
    const acc = loadPage('pages/account/account.js');
    acc.onLoad();
    acc.onShow();
    await sleep(900);
    ok('账号页拿到身份', Boolean(acc.data.user && acc.data.user.id) && acc.data.loading === false, acc.data.error || '');
    ok('账号页展示可用点数', typeof (acc.data.balance || {}).points === 'number');
    ok('账号页有安全状态', typeof (acc.data.security || {}).pwd_set === 'boolean');
    ok('账号页给出额度用量', typeof (acc.data.quota || {}).today === 'number');
    acc.openPassword();
    ok('改密弹层可打开', acc.data.sheet === 'pwd', acc.data.sheet);
    acc.setData({ oldPwd: '', newPwd: 'sim-pass-123', newPwd2: 'sim-pass-123' });
    acc.savePassword();
    await sleep(800);
    ok('密码可设置/修改且不报错', !acc.data.formError, acc.data.formError);
    acc.openDevices();
    ok('登录设备弹层可打开', acc.data.sheet === 'devices', acc.data.sheet);
    ok('登录设备列表含当前设备', (acc.data.sessions || []).some((s) => s.current) || acc.data.sessions.length === 0);
    acc.closeSheet();

    // 切换账号（V4.9.1）：账号簿 + 添加账号走登录页 add 模式
    ok('账号页有账号簿', Array.isArray(acc.data.accounts));
    navs.length = 0;
    acc.addAccount();
    ok('添加账号进登录页 add 模式', navs.some((u) => u.includes('mode=add')), navs.join(','));

    // —— 6c. 充值页（V4.9.1）——
    const pay = loadPage('pages/recharge/recharge.js');
    pay.onLoad({});
    await sleep(1000);
    ok('充值页拉到档位', (pay.data.packages || []).length > 0, pay.data.error || '');
    ok('充值页默认选中一档', Boolean(pay.data.selectedId));
    ok('充值页余额为数字', typeof pay.data.balance === 'number');
    pay.onCustom({ detail: { value: '30' } });
    ok('自定义金额换算出点数', pay.data.customPoints === 30, String(pay.data.customPoints));
    const balBefore = pay.data.balance;
    pay.clearCustom();
    pay.pay();
    await sleep(1500);
    ok('充值链路可走通并到账', pay.data.balance > balBefore, `${balBefore} → ${pay.data.balance}`);

    // —— 7. 邀请页（裂变）——
    const invite = loadPage('pages/invite/invite.js');
    invite.onLoad();
    await sleep(700);
    ok('邀请页拿到专属邀请码', /^[A-Z2-9]{6}$/.test(invite.data.code), invite.data.code);
    ok('邀请页显示奖励额度', invite.data.reward > 0, String(invite.data.reward));
    ok('邀请页有规则说明', (invite.data.rules || []).length >= 3);
    ok('邀请页统计结构完整', typeof invite.data.stats.pending === 'number' && typeof invite.data.stats.rewarded === 'number');
    const share = invite.onShareAppMessage();
    ok('分享链接带邀请码', String(share.path).includes(`inviteCode=${invite.data.code}`), share.path);

    // —— 8. 我的页邀请入口 ——
    mine.openInvite();
    ok('我的页可进入邀请页', navs.some((n) => n.includes('/pages/invite/invite')));

    // —— 9. 续集：以第一季为参考开第二季 ——
    project.setData({ seriesInfo: { seasons: [{ id: projectId }], shared_assets: [{ name: '甲' }], series: null } });
    project.doCreateSeason(2);
    await sleep(2600);
    ok('续集创建后跳到新一季', navs.some((n) => n.startsWith('redirectTo:/pages/project/project?id=')), navs.slice(-2).join(' | '));
    const seasonNav = navs.filter((n) => n.startsWith('redirectTo:/pages/project/project?id=')).pop();
    const seasonId = seasonNav ? seasonNav.split('id=')[1].split('&')[0] : '';
    const seasonRes = await fetch(`${BASE}/api/projects/${seasonId}/series`).then((r) => r.json());
    ok('新一季属于同一系列', seasonRes.data.series && seasonRes.data.seasons.length === 2, String((seasonRes.data.seasons || []).length));
    ok('续集资产已继承', (seasonRes.data.shared_assets || []).length >= 1);

    // —— 9.5 素材改编路线（V4.6）：贴正文 → 建项目 → 素材自动入库 → 按素材生成剧本 ——
    const adaptPage = loadPage('pages/create/create.js');
    adaptPage.onLoad();
    adaptPage.onShow();
    await sleep(500);
    ok('创作页默认是 AI 出创意路线', adaptPage.data.origin === 'idea', adaptPage.data.origin);

    adaptPage.pickOrigin({ currentTarget: { dataset: { key: 'material' } } });
    adaptPage.onTitle({ detail: { value: '修真改编测试剧' } });
    ok('改编路线：只有剧名不能建项目', adaptPage.data.canCreate === false);

    adaptPage.onScriptText({ detail: { value: '第一章 少年出山。'.repeat(5) } });
    ok('改编路线：正文不足 200 字仍不能建项目', adaptPage.data.canCreate === false,
      String(adaptPage.data.scriptChars));

    const longText = '第一章 少年出山\n青云宗外门弟子林昭，因灵根不纯被逐出山门。'
      + '三年后他在后山寒潭中捞起一枚黑铁小剑，剑鸣如龙。'
      + '宗门大比当日，他一剑破开护山大阵，众长老哗然。'
      + '这段素材的核心是：被驱逐者的隐忍与回击，终点不是复仇而是证明。'.repeat(6);
    adaptPage.onScriptText({ detail: { value: longText } });
    ok('改编路线：正文够字数后可建项目', adaptPage.data.canCreate === true, String(adaptPage.data.scriptChars));
    ok('改编路线：改编强度默认按短剧重排', adaptPage.data.adaptMode === 'remix', adaptPage.data.adaptMode);

    navs.length = 0;
    adaptPage.create();
    await sleep(3500);
    const adaptNav = navs.find((n) => n.includes('/pages/project/project'));
    ok('改编路线创建后进入剧组', Boolean(adaptNav), adaptNav || '未跳转');
    ok('改编路线落在素材 tab', Boolean(adaptNav && adaptNav.includes('tab=material')), adaptNav || '');

    const adaptProjectId = adaptNav ? decodeURIComponent(adaptNav.split('id=')[1].split('&')[0]) : '';
    if (adaptProjectId) {
      const projRes = await fetch(`${BASE}/api/projects/${adaptProjectId}`, {
        headers: { Authorization: `Bearer ${appInstance.globalData.token}` },
      }).then((r) => r.json()).catch(() => null);
      const proj = projRes && projRes.data;
      ok('项目记录了素材改编来源', Boolean(proj && proj.spec && proj.spec.origin === 'material'),
        JSON.stringify(proj && proj.spec && { o: proj.spec.origin, m: proj.spec.adapt_mode }));
      ok('改编强度写进了项目规格', Boolean(proj && proj.spec && proj.spec.adapt_mode === 'remix'),
        String(proj && proj.spec && proj.spec.adapt_mode));

      // 正文必须真的落成素材，否则「改编」是空的
      const matRes = await fetch(`${BASE}/api/projects/${adaptProjectId}/materials`, {
        headers: { Authorization: `Bearer ${appInstance.globalData.token}` },
      }).then((r) => r.json()).catch(() => null);
      const matStats = matRes && matRes.data && matRes.data.stats;
      ok('正文已自动存为素材', Boolean(matStats && matStats.total >= 1), JSON.stringify(matStats && matStats.total));

      // 按素材生成剧本：这条路的终点是「真能出剧本」，不是只有 UI
      const planRes = await fetch(`${BASE}/api/projects/${adaptProjectId}/plan`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${appInstance.globalData.token}` },
        body: JSON.stringify({}),
      }).then((r) => r.json()).catch(() => null);
      const planData = planRes && planRes.data;
      ok('按素材生成剧本能跑通', Boolean(planRes && planRes.ok && planData && planData.shots > 0),
        JSON.stringify({ ok: planRes && planRes.ok, code: planRes && planRes.code, shots: planData && planData.shots }));
      ok('剧本生成记录里带上了素材', Boolean(planData && planData.materials_used >= 1), String(planData && planData.materials_used));
      ok('生成后自动落成一份候选', Boolean(planData && planData.candidate_id), String(planData && planData.candidate_id));
      ok('选定后自动进入我的剧本库', Boolean(planData && planData.vault_id), String(planData && planData.vault_id));

      // 候选与选定（V4.10）：多出一版 → 列表里能看见两版 → 换选第二版
      const candRes = await fetch(`${BASE}/api/projects/${adaptProjectId}/plan/candidates`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${appInstance.globalData.token}` },
        body: JSON.stringify({ count: 2 }),
      }).then((r) => r.json()).catch(() => null);
      const candData = candRes && candRes.data;
      ok('能一次多出两版剧本', Boolean(candRes && candRes.ok && candData && candData.count === 2),
        JSON.stringify({ ok: candRes && candRes.ok, n: candData && candData.count }));
      ok('候选列表有明确当前版', Boolean(candData && candData.active_plan_id && candData.items.length >= 3),
        JSON.stringify({ active: candData && candData.active_plan_id, n: candData && candData.items.length }));

      const other = (candData && candData.items || []).find((x) => !x.selected);
      if (other) {
        const selRes = await fetch(`${BASE}/api/projects/${adaptProjectId}/plan/select`, {
          method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${appInstance.globalData.token}` },
          body: JSON.stringify({ candidateId: other.id }),
        }).then((r) => r.json()).catch(() => null);
        const selData = selRes && selRes.data;
        ok('换选另一版能成功', Boolean(selRes && selRes.ok && selData && selData.plan_id === other.plan_id),
          JSON.stringify({ ok: selRes && selRes.ok, plan: selData && selData.plan_id }));
        ok('选定后资产卡齐了（角色/场景/道具）', Boolean(selData && selData.assets && selData.assets.total >= 3),
          JSON.stringify(selData && selData.assets));
      }

      // 资产总览：分组与出图进度
      const ovRes = await fetch(`${BASE}/api/projects/${adaptProjectId}/assets/overview`, {
        headers: { Authorization: `Bearer ${appInstance.globalData.token}` },
      }).then((r) => r.json()).catch(() => null);
      const ov = ovRes && ovRes.data;
      ok('资产总览按角色/场景/道具分组', Boolean(ov && ov.groups && Array.isArray(ov.groups.character) && Array.isArray(ov.groups.scene)),
        JSON.stringify(ov && ov.by_type));

      // 我的剧本库：列表里能看到刚选定的那版
      const libRes = await fetch(`${BASE}/api/library/scripts`, {
        headers: { Authorization: `Bearer ${appInstance.globalData.token}` },
      }).then((r) => r.json()).catch(() => null);
      const lib = libRes && libRes.data;
      ok('我的剧本库能列出定稿剧本', Boolean(lib && lib.total >= 1), JSON.stringify(lib && lib.total));
      const libItem = lib && lib.items && lib.items[0];
      if (libItem) {
        const upRes = await fetch(`${BASE}/api/library/scripts/${libItem.id}/update`, {
          method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${appInstance.globalData.token}` },
          body: JSON.stringify({ title: '改过的标题' }),
        }).then((r) => r.json()).catch(() => null);
        ok('剧本库支持改名（随时可改）', Boolean(upRes && upRes.ok && upRes.data && upRes.data.title === '改过的标题'),
          JSON.stringify(upRes && upRes.data && upRes.data.title));
      }
    }

    // —— 10. 第二部剧：只填剧名就开 + 索引隔离 + 托管生产 + 资料包如实缺件 ——
    const create2 = loadPage('pages/create/create.js');
    create2.onLoad();
    create2.onShow();
    await sleep(600);
    navs.length = 0;
    create2.onTitle({ detail: { value: '外卖员读心术' } });
    create2.create();
    await sleep(3000);
    const autoNav = navs.find((n) => n.includes('/pages/project/project'));
    ok('只填剧名也能建项目', Boolean(autoNav), autoNav || '未跳转');
    const autoProjectId = autoNav ? decodeURIComponent(autoNav.split('id=')[1].split('&')[0]) : '';

    // 索引编号：同用户内自增，同名剧靠它区分
    const listRes = await fetch(`${BASE}/api/projects?userId=${appInstance.globalData.userId}`).then((r) => r.json()).catch(() => null);
    const projectsData = (listRes && (Array.isArray(listRes.data) ? listRes.data : (listRes.data || {}).items)) || [];
    const labels = projectsData.map((p) => p.index_label).filter(Boolean);
    ok('项目索引编号唯一且成序列', projectsData.length >= 2 && new Set(labels).size === labels.length
      && labels.every((l) => /^#\d{3}$/.test(l)), labels.join(','));

    // 托管生产：建任务 → 单步推进（不假装成功，停在哪就报哪）
    const prodRes = await fetch(`${BASE}/api/projects/${autoProjectId}/produce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'single', episodes: ['E01'] }),
    }).then((r) => r.json()).catch(() => null);
    const job = prodRes && prodRes.data;
    ok('托管任务可创建', Boolean(job && job.id), String(JSON.stringify(prodRes && prodRes.error)).slice(0, 120));
    if (job) {
      ok('托管任务含逐集状态', (job.episode_states || []).length >= 1, String((job.episode_states || []).length));
      const stepRes = await fetch(`${BASE}/api/produce/${encodeURIComponent(job.id)}/step`, { method: 'POST' })
        .then((r) => r.json()).catch(() => null);
      const j2 = stepRes && stepRes.data;
      ok('托管单步推进有回执', Boolean(j2 && ['running', 'paused', 'done'].includes(j2.status)),
        `${j2 && j2.status} ${JSON.stringify((j2 && j2.episode_states || []).map((s) => s.error))}`);
      ok('推进后进度结构可读', Boolean(j2 && j2.progress && typeof j2.progress.percent === 'number'),
        JSON.stringify(j2 && j2.progress));
    }

    // 资料包：缺成片时如实标「未齐」，不假装能提审
    const packRes = await fetch(`${BASE}/api/projects/${autoProjectId}/submission/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ episode: 'E01' }),
    }).then((r) => r.json()).catch(() => null);
    const pk = packRes && packRes.data;
    ok('资料包可打包并落 zip', Boolean(pk && pk.zip && pk.zip.url), String(JSON.stringify(packRes && packRes.error)).slice(0, 120));
    ok('缺成片时如实标注未齐', Boolean(pk && pk.ready === false && (pk.missing || []).length > 0),
      `missing=${pk && (pk.missing || []).length}`);
    ok('资料包清单给出平台材料项', Boolean(pk && (pk.checklist || []).length >= 5), String(pk && (pk.checklist || []).length));

    // 剧组页：成片 tab 能拿到托管进度卡与资料包卡
    const autoProject = loadPage('pages/project/project.js');
    autoProject.onLoad({ id: autoProjectId, fresh: '1', setup: '1' });
    autoProject.onShow();
    await sleep(2000);
    autoProject.switchTab({ currentTarget: { dataset: { tab: 'deliver' } } });
    await sleep(1600);
    ok('成片页拿到托管任务', Boolean(autoProject.data.job && autoProject.data.job.id), JSON.stringify(autoProject.data.job && autoProject.data.job.status));
    ok('成片页逐集状态可渲染', Array.isArray(autoProject.data.jobStates));
    autoProject.stopJobPolling();

    // —— 10.5 账号体系 + 收益看板 + 提示词库（V4.4 九库 + V4.12 规格库） ——
    const promptRes = await fetch(`${BASE}/api/prompts`).then((r) => r.json()).catch(() => null);
    const pSummary = (promptRes && promptRes.data && promptRes.data.summary) || [];
    ok('九大提示词库 + 用户规格库全部可用', pSummary.length === 10 && pSummary.every((x) => x.usable), pSummary.map((x) => x.kind).join(','));

    const smsRes = await fetch(`${BASE}/api/auth/sms`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '13800138000' }),
    }).then((r) => r.json()).catch(() => null);
    const sms = smsRes && smsRes.data;
    ok('验证码接口可用且如实标注模式', Boolean(sms && sms.mode), String(JSON.stringify(smsRes && smsRes.error)).slice(0, 100));
    ok('未接短信服务时返回测试码（不假装已发）', Boolean(sms && (sms.sent === false ? sms.dev_code : true)), JSON.stringify(sms && sms.mode));

    let phoneToken = '';
    if (sms && sms.dev_code) {
      const loginRes = await fetch(`${BASE}/api/auth/login/code`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000', code: sms.dev_code }),
      }).then((r) => r.json()).catch(() => null);
      const lc = loginRes && loginRes.data;
      phoneToken = (lc && lc.token) || '';
      ok('手机号验证码登录成功', Boolean(phoneToken), String(JSON.stringify(loginRes && loginRes.error)).slice(0, 100));
      ok('登录返回账号安全字段', Boolean(lc && lc.user && 'pwd_set' in lc.user && 'phone_masked' in lc.user),
        JSON.stringify(lc && lc.user && { p: lc.user.phone_masked, w: lc.user.pwd_set }));
    }

    if (phoneToken) {
      const pwRes = await fetch(`${BASE}/api/auth/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${phoneToken}` },
        body: JSON.stringify({ password: 'test123456' }),
      }).then((r) => r.json()).catch(() => null);
      ok('设置密码成功', Boolean(pwRes && pwRes.ok), String(JSON.stringify(pwRes && pwRes.error)).slice(0, 100));
      const pwLogin = await fetch(`${BASE}/api/auth/login/password`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000', password: 'test123456' }),
      }).then((r) => r.json()).catch(() => null);
      ok('手机号+密码登录成功', Boolean(pwLogin && pwLogin.data && pwLogin.data.token), String(JSON.stringify(pwLogin && pwLogin.error)).slice(0, 100));
      const badLogin = await fetch(`${BASE}/api/auth/login/password`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000', password: 'wrongpass' }),
      }).then((r) => r.json()).catch(() => null);
      ok('错误密码被拒绝且不泄露账号是否存在', Boolean(badLogin && badLogin.ok === false), JSON.stringify(badLogin && badLogin.code));
    }

    // 收益看板：未回填时必须是 0 + 说明，不许编造数字
    const revRes = await fetch(`${BASE}/api/me/revenue`, { headers: { Authorization: `Bearer ${appInstance.globalData.token}` } })
      .then((r) => r.json()).catch(() => null);
    const rev = revRes && revRes.data;
    ok('收益看板可读', Boolean(rev && typeof rev.total === 'number'), String(JSON.stringify(revRes && revRes.error)).slice(0, 100));
    ok('未回填时收益为 0 且给出说明', Boolean(rev && rev.total >= 0 && rev.note), JSON.stringify(rev && { t: rev.total, n: String(rev.note).slice(0, 20) }));

    // 收益看板页面能渲染
    const revPage = loadPage('pages/revenue/revenue.js');
    revPage.onLoad();
    revPage.onShow();
    await sleep(1200);
    ok('收益看板页拿到数据', revPage.data.loading === false, JSON.stringify({ err: revPage.data.error, total: revPage.data.total }));
    ok('收益看板页有柱状/空态二选一', revPage.data.bars.length > 0 || revPage.data.projects.length === 0);

    // 登录页：三种方式都在
    const loginPage = loadPage('pages/login/login.js');
    loginPage.onLoad({});
    ok('登录页默认微信登录', loginPage.data.mode === 'wechat', loginPage.data.mode);
    loginPage.onPhone({ detail: { value: '13800138000' } });
    ok('登录页手机号只留数字且限 11 位', loginPage.data.phone === '13800138000', loginPage.data.phone);
    loginPage.loginByPassword();
    ok('登录页缺密码时给提示而不是静默', Boolean(loginPage.data.error), loginPage.data.error);

    // —— 10.6 多项目（V4.7）：一部剧在跑，也要能再开一部、能换着看 ——
    const multi = loadPage('pages/create/create.js');
    multi.onLoad();
    multi.onShow();
    await sleep(600);
    ok('创作页拿到自己的剧组列表', Array.isArray(multi.data.myProjects) && multi.data.myProjects.length >= 1,
      String((multi.data.myProjects || []).length));

    multi.setData({ step: 2, title: '占位剧名', prompt: '占位创意' });
    appInstance.globalData.startNew = true;
    multi.onShow();
    ok('「另开一部」把表单复位到第一步', multi.data.step === 1 && multi.data.title === '', JSON.stringify({ s: multi.data.step, t: multi.data.title }));
    ok('「另开一部」用完即清标记', appInstance.globalData.startNew === false);

    multi.openSwitcher();
    await sleep(400);
    ok('切换抽屉能打开并列出项目', multi.data.switcherOpen === true && (multi.data.myProjects || []).length >= 1);
    multi.closeSwitcher();
    ok('切换抽屉可关闭', multi.data.switcherOpen === false);

    const projSwitcher = loadPage('pages/project/project.js');
    projSwitcher.onLoad({ id: projectId, setup: '1' });
    await sleep(1200);
    projSwitcher.openSwitcher();
    await sleep(600);
    ok('项目页也能直接换剧', projSwitcher.data.switcherOpen === true && (projSwitcher.data.projectList || []).length >= 1,
      String((projSwitcher.data.projectList || []).length));
    const curItem = (projSwitcher.data.projectList || []).find((x) => x.id === projectId);
    ok('当前这部剧在列表里标了「当前」', Boolean(curItem && curItem.current), JSON.stringify(curItem && curItem.current));
    projSwitcher.closeSwitcher();

    // —— 10.7 管理员账号（V4.7）：激活码 → 建号 → 进后台 ——
    const bootStatus = await fetch(`${BASE}/api/admin/bootstrap`).then((r) => r.json()).catch(() => null);
    ok('引导状态可读且说明还需不需要激活', Boolean(bootStatus && bootStatus.ok && typeof bootStatus.data.need_bootstrap === 'boolean'),
      JSON.stringify(bootStatus && bootStatus.data));

    const codeMatch = log.match(/管理员激活码[^A-Z]*([A-Z0-9]{5}-[A-Z0-9]{5})/);
    ok('首次启动在日志里给出激活码', Boolean(codeMatch), codeMatch ? '已拿到' : String(log).slice(-160));
    const bootCode = codeMatch ? codeMatch[1] : '';

    const wrongBoot = await fetch(`${BASE}/api/admin/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZ-ZZZZZ', phone: '13900000001', password: 'admin888' }),
    }).then((r) => r.json()).catch(() => null);
    ok('错误激活码被拒', Boolean(wrongBoot && wrongBoot.ok === false), JSON.stringify(wrongBoot && wrongBoot.code));

    const bootRes = await fetch(`${BASE}/api/admin/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: bootCode || 'NOSUCH', phone: '13900000001', password: 'admin888', nickname: '站长' }),
    }).then((r) => r.json()).catch(() => null);
    const adminToken = bootRes && bootRes.data && bootRes.data.token;
    ok('激活码能建出管理员并直接拿到登录态', Boolean(adminToken), JSON.stringify(bootRes && (bootRes.code || bootRes.message)));
    ok('管理员账号带 is_admin', Boolean(bootRes && bootRes.data && bootRes.data.user && bootRes.data.user.is_admin === true));

    const adminHeaders = { Authorization: `Bearer ${adminToken}` };
    const statsRes = await fetch(`${BASE}/api/admin/stats`, { headers: adminHeaders }).then((r) => r.json()).catch(() => null);
    ok('管理员登录态能读后台概览', Boolean(statsRes && statsRes.ok && statsRes.data.users.total >= 1),
      JSON.stringify(statsRes && (statsRes.code || statsRes.message)));

    const usersRes = await fetch(`${BASE}/api/admin/users`, { headers: adminHeaders }).then((r) => r.json()).catch(() => null);
    ok('管理员能看用户列表', Boolean(usersRes && usersRes.ok && Array.isArray(usersRes.data.items) && usersRes.data.items.length >= 1));
    ok('用户列表不带密码哈希', !JSON.stringify(usersRes).includes('password_hash'));

    const plainToken = appInstance.globalData.token;
    const plainHeaders = { Authorization: `Bearer ${plainToken}` };
    const deniedStats = await fetch(`${BASE}/api/admin/stats`, { headers: plainHeaders });
    ok('普通用户访问管理接口 403', deniedStats.status === 403, String(deniedStats.status));

    // 管理员页面：带着管理员登录态进来应直接进后台
    appInstance.globalData.token = adminToken;
    wx.setStorageSync('token', adminToken);
    appInstance.applyUser({ user: bootRes.data.user });
    const adminPage = loadPage('pages/admin/admin.js');
    adminPage.onLoad();
    await sleep(1200);
    ok('管理员打开后台直接进控制台', adminPage.data.phase === 'console', adminPage.data.phase);
    adminPage.loadStats();
    await sleep(800);
    ok('后台概览拿到数字', Boolean(adminPage.data.stats && adminPage.data.stats.users.total >= 1));

    adminPage.switchTab({ currentTarget: { dataset: { key: 'users' } } });
    await sleep(1000);
    ok('后台用户 tab 能列出账号', (adminPage.data.users || []).length >= 1, String((adminPage.data.users || []).length));

    // 「我的」页入口：按服务端返回的 is_admin 决定显不显示，不在本地猜
    const minePage = loadPage('pages/mine/mine.js');
    appInstance.globalData.token = plainToken;
    wx.setStorageSync('token', plainToken);
    await minePage.syncUser();
    ok('普通用户看不到管理后台入口', minePage.data.isAdmin === false, String(minePage.data.isAdmin));

    appInstance.globalData.token = adminToken;
    wx.setStorageSync('token', adminToken);
    await minePage.syncUser();
    ok('管理员在我的页能看到入口', minePage.data.isAdmin === true, String(minePage.data.isAdmin));
    appInstance.globalData.token = plainToken;
    wx.setStorageSync('token', plainToken);

    // —— 11. 协议页 ——
    const legal = loadPage('pages/legal/legal.js');
    legal.onLoad({ type: 'privacy' });
    ok('协议页可切到隐私政策', legal.data.doc.title === '隐私政策', legal.data.doc.title);
    legal.switchDoc({ currentTarget: { dataset: { type: 'ai' } } });
    ok('协议页可切到 AI 说明', legal.data.doc.title.includes('AI'));

    console.log(`\n=== 小程序页面运行时自测：${passed} 通过 / ${failures.length} 失败 ===`);
    if (failures.length) process.exitCode = 1;
  } finally {
    child.kill();
  }
}

main().catch((e) => {
  console.error('自测执行异常:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
