const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

const ASPECTS = [
  { key: '9:16', label: '竖屏 9:16', sub: '红果 / 抖音 / 视频号' },
  { key: '16:9', label: '横屏 16:9', sub: 'B 站 / 腾讯 / 优酷' },
  { key: '4:3', label: '横屏 4:3', sub: '番茄 / 百家号' },
  { key: '1:1', label: '方屏 1:1', sub: '小红书 / 信息流' },
];
const QUALITIES = [
  { key: '720p', label: '720P', sub: '审阅省点' },
  { key: '1080p', label: '1080P', sub: '平台定稿' },
  { key: '2k', label: '2K', sub: '收藏级' },
];
const EPISODE_COUNTS = [3, 6, 10, 20, 30];
const EPISODE_SECS = [60, 90, 120, 180];
const VIDEO_TYPES = [
  { key: 'dynamic', label: '动态漫剧', sub: '图生视频，镜头会动' },
  { key: 'static', label: '静态漫剧', sub: '关键帧 + 配音，成本最低' },
  { key: 'narration', label: '解说漫', sub: '旁白推进，节奏快' },
];
const IDEAS = [
  '被家族抛弃的少年，十年后带着一身修为归来复仇',
  '外卖员觉醒读心术，却发现老板才是幕后黑手',
  '和离后她靠一手绣活，成了长安城最贵的掌柜',
  '末日第七年，我在废墟里捡到了当年的情敌',
];

Page({
  data: {
    pageAnim: false,
    step: 1,
    typing: false,
    title: '',
    prompt: '',
    ideas: IDEAS,
    styles: [],
    styleCode: 'STY-DUSHI',
    styleName: '都市',
    aspect: '9:16',
    quality: '1080p',
    episodeCount: 6,
    episodeSec: 90,
    videoType: 'dynamic',
    aspectOpts: ASPECTS,
    qualityOpts: QUALITIES,
    episodeCountOpts: EPISODE_COUNTS,
    episodeSecOpts: EPISODE_SECS,
    typeOpts: VIDEO_TYPES,
    // 模型：每个环节只展示服务端给的「已实测可用」前五
    modelRoles: [],
    picks: { chat: '', image: '', video: '', audio: '' },
    editProfiles: [],
    editProfile: 'ED-STD',
    billingMultiplier: 2,
    shellEnabled: true,
    quote: null,
    quoteLoading: false,
    creating: false,
    createPhase: '',
    elapsed: 0,
    balance: 0,
    stylesError: '',
    showAllStyles: false,
    canCreate: false,
  },

  onLoad() {
    motion.enter(this);
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
    this.setData({ balance: app.globalData.balance || 0 });
    app.ready().then(() => {
      this.setData({ balance: app.globalData.balance || 0 });
      if (!this.data.styles.length) this.loadCatalog();
      if (!this.data.modelRoles.length) this.loadModels();
      if (app.globalData.draftTitle && !this.data.title) {
        this.setData({ title: app.globalData.draftTitle }, () => this.syncMeta());
      }
    });
    this.syncMeta();
  },

  onHide() {
    this.stopTicker();
    motion.clear(this);
  },

  onUnload() {
    this.__gone = true;
    this.stopTicker();
    motion.clear(this);
  },

  loadCatalog() {
    api.styles()
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        const picked = arr.find((s) => s.code === this.data.styleCode);
        this.setData({
          styles: arr,
          styleName: picked ? picked.name : this.data.styleName,
          stylesError: '',
        });
      })
      .catch((e) => this.setData({ stylesError: e.message || '风格库加载失败' }));
  },

  loadModels() {
    api.catalogModels()
      .then((d) => {
        const roles = d.roles || {};
        const picks = { ...this.data.picks };
        const modelRoles = [];
        ['chat', 'image', 'video', 'audio'].forEach((key) => {
          const r = roles[key];
          if (!r || !r.items || !r.items.length) return;
          const rec = r.items.find((x) => x.recommended) || r.items[0];
          if (!picks[key]) picks[key] = rec.code;
          modelRoles.push({
            key,
            name: r.name,
            hint: r.hint,
            items: r.items.map((x) => ({ ...x, on: x.code === picks[key] })),
          });
        });
        const edit = roles.edit;
        const editProfiles = (edit && edit.items) || [];
        this.setData({
          modelRoles,
          picks,
          editProfiles,
          billingMultiplier: d.billing_multiplier || 2,
          editProfile: this.data.editProfile || (editProfiles[0] && editProfiles[0].code) || 'ED-STD',
        });
      })
      .catch(() => {});
  },

  onTitle(e) {
    this.setData({ title: e.detail.value }, () => this.syncMeta());
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

  syncMeta() {
    this.setData({ canCreate: String(this.data.title || '').trim().length >= 2 });
  },

  next() {
    const title = String(this.data.title || '').trim();
    if (title.length < 2) {
      wx.showToast({ title: '先给这部剧起个名字（至少 2 个字）', icon: 'none' });
      return;
    }
    motion.haptic();
    this.setData({ step: 2 });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
    this.refreshQuote();
  },

  back() {
    motion.haptic();
    this.setData({ step: 1 });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  /** 选项：风格/画幅/画质/集数/单集时长/类型/剪辑档位 */
  pick(e) {
    motion.haptic();
    const { field } = e.currentTarget.dataset;
    let value = e.currentTarget.dataset.value;
    const patch = {};
    if (['episodeCount', 'episodeSec'].includes(field)) value = Number(value);
    patch[field] = value;
    if (field === 'styleCode') {
      const s = this.data.styles.find((x) => x.code === value);
      patch.styleName = s ? s.name : value;
    }
    this.setData(patch, () => {
      this.syncMeta();
      if (this.data.step >= 2) this.refreshQuote();
    });
  },

  /** 选模型：同一环节单选 */
  pickModel(e) {
    motion.haptic();
    const { role, code } = e.currentTarget.dataset;
    const patch = { [`picks.${role}`]: code };
    this.setData(patch);
    const modelRoles = this.data.modelRoles.map((r) =>
      r.key === role ? { ...r, items: r.items.map((x) => ({ ...x, on: x.code === code })) } : r
    );
    this.setData({ modelRoles });
  },

  pickEditProfile(e) {
    motion.haptic();
    this.setData({ editProfile: e.currentTarget.dataset.code });
  },

  toggleShell() {
    motion.haptic();
    this.setData({ shellEnabled: !this.data.shellEnabled });
  },

  toggleAllStyles() {
    motion.haptic();
    this.setData({ showAllStyles: !this.data.showAllStyles });
  },

  spec() {
    const d = this.data;
    return {
      aspect: d.aspect,
      quality: d.quality,
      episodeCount: d.episodeCount,
      totalMinutes: Math.max(1, Math.round((d.episodeCount * d.episodeSec) / 60)),
      episodeSec: d.episodeSec,
      videoType: d.videoType,
      styleCode: d.styleCode,
    };
  },

  refreshQuote() {
    const { title, prompt } = this.data;
    const seq = (this.quoteSeq = (this.quoteSeq || 0) + 1);
    this.setData({ quoteLoading: true });
    const spec = this.spec();
    api.quote({
      prompt: prompt || title,
      styleCode: spec.styleCode,
      totalMinutes: spec.totalMinutes,
      episodeSec: spec.episodeSec,
      aspect: spec.aspect,
      quality: spec.quality,
      videoType: spec.videoType,
    })
      .then((q) => {
        if (seq !== this.quoteSeq) return;
        this.setData({
          quote: {
            ...q,
            credits_text: String(Number(q.est_credits) || 0),
            time_text: (Number(q.est_minutes) || 0) >= 60
              ? `${((Number(q.est_minutes) || 0) / 60).toFixed(1)} 小时`
              : `${Number(q.est_minutes) || 0} 分钟`,
          },
          quoteLoading: false,
        });
      })
      .catch(() => {
        if (seq === this.quoteSeq) this.setData({ quoteLoading: false });
      });
  },

  /**
   * 开机 = 只建项目（一句话的活都留到项目里做）。
   * 用户只填了剧名也能开：素材、剧本、模型都可以后置再改。
   */
  create() {
    const app = getApp();
    if (this.data.creating) return;
    const title = String(this.data.title || '').trim();
    if (title.length < 2) {
      wx.showToast({ title: '先给这部剧起个名字', icon: 'none' });
      return;
    }
    motion.haptic();
    this.setData({ creating: true, createPhase: '创建项目', elapsed: 0 });
    this.startTicker();

    api.createProject({
      userId: app.globalData.userId,
      title,
      prompt: this.data.prompt || null,
      seriesTitle: title,
      shellEnabled: this.data.shellEnabled,
      models: this.data.picks,
      editProfile: this.data.editProfile,
      ...this.spec(),
    })
      .then((proj) => {
        this.setData({ createPhase: '进入剧组' });
        this.stopTicker();
        this.setData({ creating: false, createPhase: '', step: 1, title: '', prompt: '', quote: null });
        app.globalData.draftTitle = '';
        wx.navigateTo({ url: `/pages/project/project?id=${proj.id}&fresh=1&setup=1` });
      })
      .catch((e) => {
        this.stopTicker();
        this.setData({ creating: false, createPhase: '' });
        wx.showModal({ title: '创建失败', content: e.message || '请稍后重试', showCancel: false });
      });
  },

  startTicker() {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.__gone) return;
      this.setData({ elapsed: this.data.elapsed + 1 });
    }, 1000);
  },

  stopTicker() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  openLegal() {
    wx.navigateTo({ url: '/pages/legal/legal?type=ai' });
  },
});
