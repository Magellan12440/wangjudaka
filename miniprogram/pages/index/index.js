const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const motion = require('../../utils/motion.js');

const INSPIRATIONS = [
  '被家族抛弃的少年，十年后带着一身修为归来复仇',
  '外卖员觉醒读心术，却发现老板才是幕后黑手',
  '和离后她靠一手绣活，成了长安城最贵的掌柜',
  '末日第七年，我在废墟里捡到了当年的情敌',
];

Page({
  data: {
    navStatus: 20,
    navSolid: false,
    pageAnim: false,
    typing: false,
    loading: true,
    error: '',
    balance: 0,
    loginMode: '',
    prompt: '',
    stats: { projects: 0, episodes: 0, shots: 0, minutes: 0 },
    statProjects: 0,
    statEpisodes: 0,
    statShots: 0,
    revenueTotal: 0,
    projects: [],
    inspirations: INSPIRATIONS,
    privacyNeeded: false,
  },

  onLoad() {
    const app = getApp();
    this.setData({
      navStatus: app.globalData.statusBarHeight || 20,
    });
    this.checkPrivacy();
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
    const patch = { balance: app.globalData.balance || 0, loginMode: app.globalData.loginMode || '' };
    // 首页输入的一句话 → 跳到创作页后仍保留
    if (app.globalData.draftPrompt && !this.data.prompt) patch.prompt = app.globalData.draftPrompt;
    this.setData(patch);
    // 已有数据时静默刷新，避免每次切 tab 都闪骨架屏
    this.load(!this.data.projects.length);
  },

  onHide() {
    motion.clear(this);
  },

  onUnload() {
    this.__gone = true;
    motion.clear(this);
  },

  onPageScroll(e) {
    const solid = e.scrollTop > 12;
    if (solid !== this.data.navSolid) this.setData({ navSolid: solid });
  },

  onPullDownRefresh() {
    this.load(false).then(() => wx.stopPullDownRefresh());
  },

  load(showSkeleton) {
    const app = getApp();
    if (showSkeleton) this.setData({ loading: true, error: '' });
    return app.ready()
      .then(() => {
        if (!app.globalData.userId) throw new Error('登录未完成，请下拉重试');
        return api.home(app.globalData.userId);
      })
      .then((d) => {
        const list = (d.projects || []).map((p) => fmt.projectView(p, {}));
        const stats = d.stats || { projects: 0, episodes: 0, shots: 0, minutes: 0 };
        this.setData({
          loading: false,
          balance: app.globalData.balance || 0,
          loginMode: app.globalData.loginMode || '',
          stats,
          projects: list,
        });
        motion.countUp(this, 'statProjects', stats.projects || 0, { duration: 620 });
        motion.countUp(this, 'statEpisodes', stats.episodes || 0, { duration: 620 });
        motion.countUp(this, 'statShots', stats.shots || 0, { duration: 620 });
        // 收益只用来看趋势，失败不打扰首页
        api.revenue().then((r) => this.setData({ revenueTotal: (r && r.total) || 0 })).catch(() => {});
      })
      .catch((e) => {
        this.setData({ loading: false, error: e.message || '加载失败' });
      });
  },

  goRevenue() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/revenue/revenue' });
  },

  onInput(e) {
    this.setData({ prompt: e.detail.value });
  },

  onFocus() {
    this.setData({ typing: true });
  },

  onBlur() {
    this.setData({ typing: false });
  },

  pickIdea(e) {
    motion.haptic();
    this.setData({ prompt: e.currentTarget.dataset.text });
  },

  /** 首页收集剧名即可建项目，其余设定在「创作」页补齐 */
  startCreate() {
    const title = (this.data.prompt || '').trim();
    if (title.length < 2) {
      wx.showToast({ title: '先想个剧名，两个字就行', icon: 'none' });
      return;
    }
    motion.haptic();
    const app = getApp();
    app.globalData.draftTitle = title.slice(0, 30);
    app.globalData.draftPrompt = '';
    app.globalData.startNew = true;
    wx.switchTab({ url: '/pages/create/create' });
  },

  openProject(e) {
    motion.haptic();
    wx.navigateTo({ url: `/pages/project/project?id=${e.currentTarget.dataset.id}` });
  },

  goMine() {
    motion.haptic();
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  goCreate() {
    motion.haptic();
    // 从「新建 +」进来：不管创作页上次停在哪一步，都复位成新建
    getApp().globalData.startNew = true;
    getApp().globalData.draftTitle = '';
    wx.switchTab({ url: '/pages/create/create' });
  },

  goDistribute() {
    motion.haptic();
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  goInvite() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/invite/invite' });
  },

  openLegal(e) {
    wx.navigateTo({ url: `/pages/legal/legal?type=${e.currentTarget.dataset.type || 'terms'}` });
  },

  // —— 隐私授权（提审必备）——
  checkPrivacy() {
    if (!wx.getPrivacySetting) return;
    wx.getPrivacySetting({
      success: (r) => {
        if (r.needAuthorization) this.setData({ privacyNeeded: true });
      },
      fail: () => {},
    });
  },

  agreePrivacy() {
    this.setData({ privacyNeeded: false });
  },

  rejectPrivacy() {
    this.setData({ privacyNeeded: false });
    wx.showToast({ title: '未同意隐私保护指引，部分功能不可用', icon: 'none' });
  },

  openPrivacyContract() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({ fail: () => {} });
    } else {
      this.openLegal({ currentTarget: { dataset: { type: 'privacy' } } });
    }
  },

  onShareAppMessage() {
    return {
      title: '网剧大咖 · 一句话，开一部网剧',
      path: '/pages/index/index',
    };
  },
});
