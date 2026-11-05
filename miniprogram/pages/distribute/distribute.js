const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const motion = require('../../utils/motion.js');

const PLATFORM_STYLE = {
  'PLT-HONGGUO': { short: '红', cls: 'pf-a' },
  'PLT-DOUYIN': { short: '抖', cls: 'pf-b' },
  'PLT-KUAISHOU': { short: '快', cls: 'pf-c' },
  'PLT-TENCENT': { short: '腾', cls: 'pf-d' },
  'PLT-YOUKU': { short: '优', cls: 'pf-e' },
  'PLT-MANGO': { short: '芒', cls: 'pf-f' },
  'PLT-XIAOHONGSHU': { short: '小', cls: 'pf-g' },
  'PLT-BILIBILI': { short: 'B', cls: 'pf-h' },
};

const DRAMA_TYPES = [
  { key: '2d', label: '2D 动漫' },
  { key: '3d', label: '3D 动漫' },
  { key: 'live_action', label: '仿真人' },
];

/** 四步闭环的状态 → 展示（点 / 类 / 文案） */
const STEP_STYLE = {
  done: { dot: '✓', cls: 'st-done', text: '已完成' },
  current: { dot: '●', cls: 'st-cur', text: '进行中' },
  todo: { dot: '○', cls: 'st-todo', text: '待开始' },
  blocked: { dot: '!', cls: 'st-bad', text: '被驳回' },
};

function shapeSteps(steps) {
  return (steps || []).map((s) => {
    const st = STEP_STYLE[s.state] || STEP_STYLE.todo;
    return { ...s, dot: st.dot, cls: st.cls, stateText: st.text };
  });
}

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    projects: [],
    projectId: '',
    projectTitle: '',
    platforms: [],
    tasks: [],
    summary: null,
    board: null,
    // 看板数字（滚动动画用）
    bTasks: 0,
    bOnline: 0,
    bRevenue: 0,
    viewsText: '0',
    // 平台详情弹层
    sheetPlatform: null,
    // 数据回填弹层
    statsTask: null,
    statsForm: { views: '', likes: '', completion: '' },
    // 收益估算
    policies: [],
    policyNames: [],
    policyIndex: 0,
    dramaTypes: DRAMA_TYPES,
    typeIndex: 0,
    viewsInput: '100000',
    completionInput: '50',
    calc: null,
    calcLoading: false,
    packInfo: null,
    busy: '',
    // 一键备齐（V4.3）
    films: [],
    filmEp: '',
    packEp: '',
    pack: null,
    packBusy: '',
    uploaded: false,
  },

  onLoad() {
    this.bootstrap();
  },

  onShow() {
    motion.enter(this);
    // 从项目详情跳过来时，优先用选中的项目
    const app = getApp();
    const selected = app.globalData.selectedProjectId;
    this.setData({ selectedPlatform: app.globalData.selectedPlatform || '' });
    if (selected && selected !== this.data.projectId) {
      this.setData({ projectId: selected });
      this.loadProjectData();
    }
    if (!this.data.projects.length) this.bootstrap(true);
  },

  onHide() {
    motion.clear(this);
  },

  onUnload() {
    this.__gone = true;
    motion.clear(this);
  },

  retry() {
    this.bootstrap(false);
  },

  noop() {},

  bootstrap(silent) {
    const app = getApp();
    if (!silent) this.setData({ loading: true, error: '' });
    app.ready()
      .then(() => {
        if (!app.globalData.userId) throw new Error('登录未完成，请下拉重试');
        return Promise.all([api.projects(app.globalData.userId), api.platforms(), api.revenuePolicies()]);
      })
      .then(([projects, platforms, policies]) => {
        const list = (Array.isArray(projects) ? projects : []).map((p) => fmt.projectView(p, {}));
        const plats = (Array.isArray(platforms) ? platforms : []).map((p) => ({
          ...p,
          short: (PLATFORM_STYLE[p.code] || {}).short || p.name.slice(0, 1),
          cls: (PLATFORM_STYLE[p.code] || {}).cls || 'pf-a',
          label: String(p.name).split('（')[0].replace(' TV', '').replace('（短剧）', ''),
        }));
        const pol = Array.isArray(policies) ? policies : [];
        let projectId = this.data.projectId || app.globalData.selectedProjectId;
        if (!projectId && list.length) projectId = list[0].id;
        const cur = list.find((x) => x.id === projectId);
        this.setData({
          loading: false,
          projects: list,
          platforms: plats,
          policies: pol,
          policyNames: pol.map((p) => p.name),
          projectId,
          projectTitle: cur ? cur.title : '',
        });
        if (projectId) this.loadProjectData();
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  loadProjectData() {
    const projectId = this.data.projectId;
    if (!projectId) return;
    const cur = this.data.projects.find((x) => x.id === projectId);
    this.setData({ projectTitle: cur ? cur.title : this.data.projectTitle });
    this.loadPack();
    api.distributions(projectId)
      .then((list) => {
        const tasks = (Array.isArray(list) ? list : []).map((t) => {
          const pf = this.data.platforms.find((p) => p.code === t.platform);
          const steps = shapeSteps(t.steps);
          return {
            ...t,
            short: pf ? pf.short : t.platform_name.slice(0, 1),
            cls: pf ? pf.cls : 'pf-a',
            viewsText: fmt.fmtNumber(t.stats && t.stats.views),
            revenueText: fmt.fmtMoney(t.revenue && t.revenue.amount),
            completionText: t.stats && typeof t.stats.completion_rate === 'number' ? `${Math.round(t.stats.completion_rate * 100)}%` : '—',
            timeText: fmt.timeAgo(t.updated_at || t.created_at),
            flow: (pf && pf.status_flow) || [],
            steps,
            stepDone: steps.filter((s) => s.state === 'done').length,
            creatorUrl: pf ? pf.creator_url : '',
            contractText: t.contract && t.contract.signed ? `已签 · ${(t.contract.contract_no || t.contract.channel || '').slice(0, 18)}` : '未登记',
          };
        });
        this.setData({ tasks });
      })
      .catch(() => this.setData({ tasks: [] }));

    api.platformSummary(projectId)
      .then((s) => {
        this.setData({ summary: s });
        motion.countUp(this, 'bTasks', (s && s.count) || 0, { duration: 560 });
        motion.countUp(this, 'bOnline', (s && s.online) || 0, { duration: 560 });
        motion.countUp(this, 'bRevenue', Math.round((s && s.total_revenue_cny) || 0), { duration: 760 });
      })
      .catch(() => {});
    api.dashboard(projectId)
      .then((d) => {
        const ov = d.overview || null;
        this.setData({ board: ov, viewsText: fmt.fmtNumber(ov && ov.total_views) });
      })
      .catch(() => this.setData({ board: null }));
  },

  selectProject(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.projectId) return;
    getApp().globalData.selectedProjectId = id;
    this.setData({ projectId: id, tasks: [], summary: null, board: null, calc: null, bTasks: 0, bOnline: 0, bRevenue: 0, viewsText: '0' });
    this.loadProjectData();
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' });
  },

  goProject() {
    if (!this.data.projectId) return;
    wx.navigateTo({ url: `/pages/project/project?id=${this.data.projectId}` });
  },

  // —— 平台详情 ——
  openPlatform(e) {
    const code = e.currentTarget.dataset.code;
    const p = this.data.platforms.find((x) => x.code === code);
    if (p) this.setData({ sheetPlatform: p });
  },

  closeSheet() {
    this.setData({ sheetPlatform: null, statsTask: null });
  },

  copyLink() {
    const p = this.data.sheetPlatform;
    if (!p) return;
    wx.setClipboardData({
      data: p.creator_url,
      success: () => wx.showToast({ title: '入口已复制，请在电脑端打开', icon: 'none' }),
    });
  },

  createTask(e) {
    const platform = this.data.sheetPlatform || this.data.platforms.find((x) => x.code === e.currentTarget.dataset.code);
    if (!platform) return;
    if (!this.data.projectId) {
      wx.showToast({ title: '先创建一部剧', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `创建分发任务：${platform.name}`,
      content: '小程序不能内嵌第三方平台登录。上传、审核、签约与提现需在电脑端完成，本任务只用于跟踪状态与回填数据。',
      confirmText: '创建',
      success: (r) => {
        if (!r.confirm) return;
        api.createDistribution({
          userId: getApp().globalData.userId,
          projectId: this.data.projectId,
          episodeNo: 'E01',
          platformCode: platform.code,
        })
          .then(() => {
            this.setData({ sheetPlatform: null });
            wx.showToast({ title: '任务已创建', icon: 'none' });
            this.loadProjectData();
          })
          .catch(() => {});
      },
    });
  },

  // —— 四步闭环 ——
  stepAction(e) {
    const { key, id } = e.currentTarget.dataset;
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return;
    motion.haptic();
    if (key === 'distribute') return this.openCreator(task);
    if (key === 'review') return this.updateStatus(e);
    if (key === 'contract') return this.signContract(task);
    if (key === 'withdraw') return this.recordRevenue(e);
  },

  /** 打开平台创作者中心：小程序不能内嵌第三方登录，只能复制入口到电脑端 */
  openCreator(task) {
    const url = task.creatorUrl;
    if (!url) {
      wx.showToast({ title: '该平台未收录入口地址', icon: 'none' });
      return;
    }
    const p = this.data.platforms.find((x) => x.code === task.platform) || {};
    wx.showModal({
      title: `去 ${p.name || task.platform_name} 上传`,
      content: [
        p.upload_client ? `上传端：${p.upload_client}` : '',
        p.identity_choice ? `身份：${p.identity_choice}` : '',
        p.ai_declaration_required ? '需同时提交 AI 创作说明与创作过程截图' : '',
      ].filter(Boolean).join('\n') || '请在电脑端打开创作者中心完成上传。',
      confirmText: '复制入口',
      success: (r) => {
        if (!r.confirm) return;
        wx.setClipboardData({
          data: url,
          success: () => {
            wx.showModal({
              title: '入口已复制',
              content: `${url}\n\n在电脑浏览器打开，登录后上传成片。传完回这里把状态改成「审核中」。`,
              showCancel: false,
            });
          },
        });
      },
    });
  },

  /** 合同签订登记：平台侧签，小程序只登记，登记后才能录收益 */
  signContract(task) {
    if (task.contract && task.contract.signed) {
      wx.showModal({
        title: '合同已登记',
        content: `渠道：${task.contract.channel || '平台线上电子合同'}\n编号：${task.contract.contract_no || '未填'}\n时间：${String(task.contract.signed_at || '').slice(0, 10)}`,
        showCancel: false,
      });
      return;
    }
    wx.showModal({
      title: '登记合同签署',
      editable: true,
      placeholderText: '合同编号（可留空）',
      content: '',
      confirmText: '我已签署',
      success: (r) => {
        if (!r.confirm) return;
        api.distributionContract(task.id, { contractNo: (r.content || '').trim() || null })
          .then(() => {
            wx.showToast({ title: '合同已登记', icon: 'none' });
            this.loadProjectData();
          })
          .catch(() => {});
      },
    });
  },

  copyCreatorByPlatform(e) {
    const code = e.currentTarget.dataset.code;
    const p = this.data.platforms.find((x) => x.code === code);
    if (!p || !p.creator_url) return;
    wx.setClipboardData({
      data: p.creator_url,
      success: () => wx.showToast({ title: '入口已复制，请在电脑端打开', icon: 'none' }),
    });
  },


  updateStatus(e) {
    const id = e.currentTarget.dataset.id;
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task || !task.flow || !task.flow.length) {
      wx.showToast({ title: '该平台没有可用状态', icon: 'none' });
      return;
    }
    const list = task.flow;
    wx.showActionSheet({
      itemList: list,
      success: (r) => {
        const status = list[r.tapIndex];
        if (!status || status === task.status) return;
        api.distributionStatus(id, status)
          .then(() => {
            wx.showToast({ title: '状态已更新', icon: 'none' });
            this.loadProjectData();
          })
          .catch(() => {});
      },
    });
  },

  recordRevenue(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '录入本期收益',
      editable: true,
      placeholderText: '金额（元），例如 1200',
      success: (r) => {
        if (!r.confirm || !r.content) return;
        const amount = Number(r.content);
        if (!isFinite(amount) || amount < 0) {
          wx.showToast({ title: '请输入正确的金额', icon: 'none' });
          return;
        }
        api.distributionRevenue(id, { amount, currency: 'CNY' })
          .then(() => {
            wx.showToast({ title: '收益已入账', icon: 'none' });
            this.loadProjectData();
          })
          .catch(() => {});
      },
    });
  },

  openStats(e) {
    const id = e.currentTarget.dataset.id;
    const task = this.data.tasks.find((t) => t.id === id);
    if (!task) return;
    this.setData({
      statsTask: task,
      statsForm: {
        views: task.stats && task.stats.views ? String(task.stats.views) : '',
        likes: task.stats && task.stats.likes ? String(task.stats.likes) : '',
        completion: task.stats && task.stats.completion_rate ? String(Math.round(task.stats.completion_rate * 100)) : '',
      },
    });
  },

  onStatsInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`statsForm.${field}`]: e.detail.value });
  },

  submitStats() {
    const t = this.data.statsTask;
    if (!t) return;
    const f = this.data.statsForm;
    const payload = {
      views: Number(f.views) || 0,
      likes: Number(f.likes) || 0,
      completion_rate: Math.max(0, Math.min(100, Number(f.completion) || 0)) / 100,
    };
    this.setData({ busy: 'stats' });
    api.distributionStats(t.id, payload)
      .then(() => {
        this.setData({ statsTask: null });
        wx.showToast({ title: '数据已回填', icon: 'none' });
        this.loadProjectData();
      })
      .catch(() => {})
      .then(() => this.setData({ busy: '' }));
  },

  // —— 收益估算 ——
  onPolicyChange(e) { this.setData({ policyIndex: Number(e.detail.value) }); },
  pickType(e) { this.setData({ typeIndex: Number(e.currentTarget.dataset.index) }); },
  onViewsInput(e) { this.setData({ viewsInput: e.detail.value }); },
  onCompletionInput(e) { this.setData({ completionInput: e.detail.value }); },

  calculate() {
    const p = this.data.policies[this.data.policyIndex];
    if (!p) return;
    this.setData({ calcLoading: true });
    api.calculateRevenue({
      platformCode: p.code,
      dramaType: this.data.dramaTypes[this.data.typeIndex].key,
      views: Number(this.data.viewsInput) || 0,
      completionRate: (Number(this.data.completionInput) || 0) / 100,
      costPoints: 0,
    })
      .then((c) => {
        this.setData({
          calc: {
            platform: c.platform.name,
            gross: fmt.fmtMoney(c.estimate.gross_cny),
            net: fmt.fmtMoney(c.estimate.net_cny),
            effective: fmt.fmtNumber(c.effective_views),
            coef: c.platform.coef,
            coefLabel: c.platform.coef_label,
            disclaimer: c.disclaimer,
            updated: c.policy_updated_at,
          },
        });
      })
      .catch((err) => wx.showToast({ title: err.message || '该平台暂不支持此类型', icon: 'none' }))
      .then(() => this.setData({ calcLoading: false }));
  },

  buildPack() {
    if (!this.data.projectId || this.data.busy) return;
    this.setData({ busy: 'pack' });
    api.buildCompliancePack({ projectId: this.data.projectId, episodeNo: 'E01' })
      .then((pack) => {
        this.setData({ packInfo: { pages: pack.evidence_pages.length, ok: pack.validation.ok } });
        wx.showModal({
          title: '合规包已生成',
          content: `共 ${pack.evidence_pages.length} 页创作过程证据（全屏 / 带网址 / 带时间戳）。请在电脑端打印为 PDF 后随片上传。`,
          showCancel: false,
        });
      })
      .catch(() => {})
      .then(() => this.setData({ busy: '' }));
  },

  onPullDownRefresh() {
    this.loadProjectData();
    wx.stopPullDownRefresh();
  },

  // —— 一键备齐平台审核材料（V4.3） ——

  /** 成片 + 已备过的资料包，决定默认集号 */
  loadPack() {
    const projectId = this.data.projectId;
    if (!projectId) return;
    api.projectFilms(projectId)
      .then((list) => {
        const films = (Array.isArray(list) ? list : []).map((f) => ({
          ...f,
          epText: f.episode || 'E01',
          sizeText: f.bytes ? fmt.fmtBytes(f.bytes) : '',
        }));
        const last = films[films.length - 1];
        const ep = this.data.packEp || this.data.filmEp || (last && last.episode) || 'E01';
        this.setData({ films, filmEp: this.data.filmEp || (last && last.episode) || '', packEp: ep });
      })
      .catch(() => this.setData({ films: [] }));

    api.submissions(projectId)
      .then((r) => {
        const items = (r && r.items) || [];
        if (!items.length) return;
        const last = items[0];
        this.setData({
          pack: this.shapePack(last),
          uploaded: !!last.submitted_at,
          packEp: this.data.packEp || last.episode,
        });
      })
      .catch(() => {});
  },

  shapePack(raw) {
    if (!raw) return null;
    const files = (raw.files || []).map((f) => ({
      key: f.key, name: f.name,
    }));
    const checklist = (raw.checklist || []).map((c) => ({
      ...c,
      mark: c.done ? '✓' : (c.required ? '✕' : '–'),
      cls: c.done ? 'pill-green' : (c.required ? 'pill-red' : 'pill-gray'),
    }));
    return {
      id: raw.id,
      episode: raw.episode,
      zipUrl: raw.zip_url || (raw.zip && raw.zip.url) || '',
      bytes: raw.bytes || (raw.zip && raw.zip.bytes) || 0,
      sizeText: fmt.fmtBytes(raw.bytes || (raw.zip && raw.zip.bytes) || 0),
      files,
      checklist,
      missing: raw.checklist ? raw.checklist.filter((c) => c.missing) : [],
      ready: !!raw.ready,
      note: raw.note || '',
      createdAt: fmt.timeAgo(raw.created_at),
    };
  },

  pickPackEp(e) {
    this.setData({ packEp: e.currentTarget.dataset.ep, pack: null, uploaded: false });
  },

  preparePack() {
    const projectId = this.data.projectId;
    if (!projectId || this.data.packBusy) return;
    const platformCode = getApp().globalData.selectedPlatform || null;
    this.setData({ packBusy: 'pack' });
    api.prepareSubmission(projectId, { episode: this.data.packEp || null, platformCode })
      .then((r) => {
        this.setData({ pack: this.shapePack(r), uploaded: false });
        if (r.ready) {
          wx.showModal({
            title: '材料已备齐',
            content: `共 ${r.files.length} 个文件，已打成一个压缩包（${fmt.fmtBytes(r.zip.bytes)}）。复制下载链接到电脑端，解压后按清单逐项上传。`,
            showCancel: false,
          });
        } else {
          wx.showModal({
            title: '还缺材料',
            content: `缺 ${r.missing.length} 项：${r.missing.map((m) => m.label || m.key).join('、')}\n\n把缺的补上再打一次包，平台提审一次过。`,
            showCancel: false,
          });
        }
      })
      .catch(() => {})
      .then(() => this.setData({ packBusy: '' }));
  },

  copyPackUrl() {
    const p = this.data.pack;
    if (!p || !p.zipUrl) return;
    const base = getApp().globalData.baseUrl || '';
    const url = /^https?:/.test(p.zipUrl) ? p.zipUrl : `${base}${p.zipUrl}`;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '下载链接已复制', icon: 'none' }),
    });
  },

  /** 登记「我已上传」——第三方平台无开放上传 API，只能由平台侧完成，这里只做状态推进 */
  markUploaded() {
    const p = this.data.pack;
    if (!p) return;
    const task = this.data.tasks.find((t) => t.platform === getApp().globalData.selectedPlatform);
    wx.showModal({
      title: '确认已提交到平台',
      content: '确认你已在电脑端创作者中心完成上传并提交审核。登记后任务状态会推进到「内容审核」。',
      confirmText: '已提交',
      success: (r) => {
        if (!r.confirm) return;
        api.markSubmitted(p.id, task ? task.id : null)
          .then(() => {
            this.setData({ uploaded: true });
            wx.showToast({ title: '已登记', icon: 'none' });
            this.loadProjectData();
          })
          .catch(() => {});
      },
    });
  },

  /** 选中平台：写入 globalData，后续打包带上该平台的材料清单 */
  pickPackPlatform(e) {
    const code = e.currentTarget.dataset.code;
    const cur = getApp().globalData.selectedPlatform;
    const next = cur === code ? '' : code;
    getApp().globalData.selectedPlatform = next;
    this.setData({ selectedPlatform: next });
  },

  copyFilm(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '成片链接已复制', icon: 'none' }),
    });
  },
});
