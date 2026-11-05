/**
 * 管理后台（V4.7）——小程序内的管理员控制台。
 *
 * 设计取向：
 *  1. 进页面先问服务端「还需不需要激活」，而不是本地判断——服务端才知道有没有管理员。
 *  2. 激活码只从服务端日志取，页面上不提供任何「查看激活码」的入口（那等于公开后门）。
 *  3. 危险动作（调点数、停用、给管理员）都要二次确认，且成功后立刻刷新当前行，
 *     不做「点了没反应」的乐观更新。
 */
const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

const TABS = [
  { key: 'stats', label: '概览' },
  { key: 'users', label: '用户' },
  { key: 'codes', label: '兑换码' },
  { key: 'tools', label: '工具' },
];

Page({
  data: {
    pageAnim: false,
    navStatus: 20,
    phase: 'loading', // loading | login | boot | console
    boot: null, // 服务端返回的引导状态
    tab: 'stats',
    tabs: TABS,
    tabIndex: 0,
    segStyle: '',

    // 登录 / 激活表单
    phone: '',
    password: '',
    code: '',
    nickname: '',
    busy: false,
    error: '',

    // 后台数据
    stats: null,
    statsError: '',
    users: [],
    userTotal: 0,
    keyword: '',
    usersLoading: false,
    codes: [],
    codesLoading: false,
    newPoints: '',
    newCount: '5',
    probe: null,
    probing: false,
    relay: null,

    // 用户操作抽屉
    acting: null,
    deltaInput: '',
    deltaNote: '',
    sheetOpen: false,
  },

  onLoad() {
    const app = getApp();
    this.setData({ navStatus: app.globalData.statusBarHeight || 20 });
    motion.enter(this);
    this.checkBootstrap();
  },

  onShow() {
    if (this.data.phase === 'console') this.loadStats();
  },

  onHide() {
    motion.clear(this);
  },

  onUnload() {
    motion.clear(this);
  },

  back() {
    motion.haptic();
    const pages = getCurrentPages();
    if (pages.length > 1) wx.navigateBack();
    else wx.switchTab({ url: '/pages/mine/mine' });
  },

  /** 服务端说了算：有没有管理员、要不要激活 */
  checkBootstrap() {
    api.adminBootstrapStatus()
      .then((d) => {
        const app = getApp();
        const me = app.globalData.user;
        // 已经是管理员就直接进后台
        if (me && me.is_admin) {
          this.setData({ boot: d, phase: 'console' });
          this.loadStats();
          return;
        }
        this.setData({ boot: d, phase: d.need_bootstrap ? 'boot' : 'login' });
      })
      .catch((e) => this.setData({ boot: null, phase: 'login', error: e.message || '无法连接服务端' }));
  },

  onField(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value, error: '' });
  },

  login() {
    const phone = String(this.data.phone || '').trim();
    const password = String(this.data.password || '');
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ error: '请输入 11 位手机号' });
    if (password.length < 6) return this.setData({ error: '请输入密码' });
    if (this.data.busy) return;
    motion.haptic();
    this.setData({ busy: true, error: '' });
    api.adminLogin(phone, password)
      .then((d) => this.enterConsole(d))
      .catch((e) => this.setData({ busy: false, error: e.message || '登录失败' }));
  },

  /** 用激活码创建第一个管理员（激活码在服务端日志里） */
  bootstrapAdmin() {
    const code = String(this.data.code || '').trim();
    const phone = String(this.data.phone || '').trim();
    const password = String(this.data.password || '');
    if (!code) return this.setData({ error: '请填服务端日志里的激活码' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ error: '请输入 11 位手机号' });
    if (password.length < 6) return this.setData({ error: '密码至少 6 位' });
    if (this.data.busy) return;
    motion.haptic();
    this.setData({ busy: true, error: '' });
    api.adminBootstrap({ code, phone, password, nickname: this.data.nickname || '管理员' })
      .then((d) => this.enterConsole(d))
      .catch((e) => this.setData({ busy: false, error: e.message || '激活失败' }));
  },

  enterConsole(d) {
    const app = getApp();
    app.globalData.token = d.token;
    wx.setStorageSync('token', d.token);
    app.applyUser(d);
    this.setData({ busy: false, phase: 'console', password: '', code: '' });
    this.loadStats();
    wx.showToast({ title: '已进入管理后台', icon: 'none' });
  },

  switchTab(e) {
    const { key } = e.currentTarget.dataset;
    const index = TABS.findIndex((t) => t.key === key);
    motion.haptic();
    this.setData({ tab: key, tabIndex: index, segStyle: motion.segStyle(index, TABS.length) });
    if (key === 'stats') this.loadStats();
    if (key === 'users') this.loadUsers();
    if (key === 'codes') this.loadCodes();
    if (key === 'tools') this.loadRelay();
  },

  // —— 概览 ——
  loadStats() {
    this.setData({ statsError: '' });
    api.adminStats()
      .then((s) => this.setData({ stats: s }))
      .catch((e) => this.setData({ statsError: e.message || '加载失败' }));
  },

  // —— 用户 ——
  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  searchUsers() {
    motion.haptic();
    this.loadUsers();
  },

  loadUsers() {
    this.setData({ usersLoading: true });
    api.adminUsers(this.data.keyword)
      .then((r) => this.setData({ users: r.items || [], userTotal: r.total || 0, usersLoading: false }))
      .catch((e) => {
        this.setData({ usersLoading: false });
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      });
  },

  /** 打开某个用户的操作抽屉 */
  act(e) {
    const id = e.currentTarget.dataset.id;
    const u = this.data.users.find((x) => x.id === id);
    if (!u) return;
    motion.haptic();
    this.setData({ acting: u, sheetOpen: true, deltaInput: '', deltaNote: '' });
  },

  closeSheet() {
    this.setData({ sheetOpen: false });
  },

  onDelta(e) {
    this.setData({ deltaInput: e.detail.value });
  },

  onDeltaNote(e) {
    this.setData({ deltaNote: e.detail.value });
  },

  /** 调点数：正数加、负数扣；后端会拒绝扣成负数 */
  submitDelta() {
    const u = this.data.acting;
    if (!u) return;
    const delta = parseInt(this.data.deltaInput, 10);
    if (!Number.isFinite(delta) || delta === 0) {
      return wx.showToast({ title: '请输入非零整数，如 100 或 -50', icon: 'none' });
    }
    const verb = delta > 0 ? `加 ${delta}` : `扣 ${Math.abs(delta)}`;
    wx.showModal({
      title: '确认调账',
      content: `确定给「${u.nickname || u.id}」${verb} 点吗？会记一条流水，可在用户详情里查。`,
      success: (r) => {
        if (!r.confirm) return;
        api.adminAdjustPoints(u.id, delta, this.data.deltaNote || null)
          .then((res) => {
            wx.showToast({ title: `已调整，余额 ${res.balance} 点`, icon: 'none' });
            this.setData({ sheetOpen: false });
            this.loadUsers();
          })
          .catch((e) => wx.showToast({ title: e.message || '调整失败', icon: 'none' }));
      },
    });
  },

  toggleStatus() {
    const u = this.data.acting;
    if (!u) return;
    const next = u.status === 'banned' ? 'active' : 'banned';
    const word = next === 'banned' ? '停用' : '恢复';
    wx.showModal({
      title: `${word}账号`,
      content: next === 'banned'
        ? `停用后「${u.nickname || u.id}」立刻无法使用（登录态也失效）。确定吗？`
        : `恢复后该账号可以正常使用。`,
      success: (r) => {
        if (!r.confirm) return;
        api.adminSetStatus(u.id, next)
          .then(() => {
            this.setData({ sheetOpen: false });
            this.loadUsers();
            wx.showToast({ title: `已${word}`, icon: 'none' });
          })
          .catch((e) => wx.showToast({ title: e.message || '操作失败', icon: 'none' }));
      },
    });
  },

  toggleRole() {
    const u = this.data.acting;
    if (!u) return;
    const next = u.role === 'admin' ? 'user' : 'admin';
    const word = next === 'admin' ? '设为管理员' : '取消管理员';
    wx.showModal({
      title: word,
      content: next === 'admin'
        ? `「${u.nickname || u.id}」将能进入管理后台，可调别人点数、停用账号。确定吗？`
        : '取消后该账号立刻失去后台入口（至少要留一个管理员）。',
      success: (r) => {
        if (!r.confirm) return;
        api.adminSetRole(u.id, next)
          .then(() => {
            this.setData({ sheetOpen: false });
            this.loadUsers();
            wx.showToast({ title: `已${word}`, icon: 'none' });
          })
          .catch((e) => wx.showToast({ title: e.message || '操作失败', icon: 'none' }));
      },
    });
  },

  // —— 兑换码 ——
  loadCodes() {
    this.setData({ codesLoading: true });
    api.adminCodes()
      .then((r) => this.setData({ codes: (r.items || r || []).slice(0, 20), codesLoading: false }))
      .catch((e) => {
        this.setData({ codesLoading: false });
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      });
  },

  onNewPoints(e) {
    this.setData({ newPoints: e.detail.value });
  },

  onNewCount(e) {
    this.setData({ newCount: e.detail.value });
  },

  createCodes() {
    const points = parseInt(this.data.newPoints, 10);
    const count = parseInt(this.data.newCount, 10);
    if (!Number.isFinite(points) || points <= 0) {
      return wx.showToast({ title: '面额要是正整数', icon: 'none' });
    }
    if (!Number.isFinite(count) || count <= 0 || count > 100) {
      return wx.showToast({ title: '数量 1~100', icon: 'none' });
    }
    motion.haptic();
    api.adminCreateCodes({ points, count })
      .then((r) => {
        const list = r.items || r.codes || [];
        wx.showModal({
          title: `已生成 ${list.length} 张`,
          content: list.slice(0, 5).map((c) => (typeof c === 'string' ? c : c.code)).join('\n'),
          showCancel: false,
        });
        this.loadCodes();
      })
      .catch((e) => wx.showToast({ title: e.message || '生成失败', icon: 'none' }));
  },

  copyCode(e) {
    const code = e.currentTarget.dataset.code;
    wx.setClipboardData({ data: code });
  },

  // —— 工具 ——
  loadRelay() {
    api.adminRelay()
      .then((r) => this.setData({ relay: r }))
      .catch(() => this.setData({ relay: null }));
  },

  probeModels() {
    if (this.data.probing) return;
    motion.haptic();
    this.setData({ probing: true });
    api.adminProbeModels(false)
      .then((r) => {
        this.setData({ probing: false, probe: r });
        wx.showToast({ title: '探活完成', icon: 'none' });
      })
      .catch((e) => {
        this.setData({ probing: false });
        wx.showToast({ title: e.message || '探活失败', icon: 'none' });
      });
  },
});
