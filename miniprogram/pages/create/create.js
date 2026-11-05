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
const MINUTES = [5, 10, 20, 30, 60];
const EPISODES = [60, 90, 120, 180];
const VIDEO_TYPES = [
  { key: 'dynamic', label: '动态漫剧', sub: '图生视频，镜头会动' },
  { key: 'static', label: '静态漫剧', sub: '关键帧 + 配音，成本最低' },
  { key: 'narration', label: '解说漫', sub: '旁白推进，节奏快' },
];
const PRESETS = [
  { key: 'fast', label: '极速', sub: '全程预览档' },
  { key: 'balanced', label: '均衡', sub: '720P 审阅 + 1080P 定稿' },
  { key: 'premium', label: '高质', sub: '全程定稿档' },
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
    prompt: '',
    ideas: IDEAS,
    styles: [],
    styleCode: 'STY-DUSHI',
    styleName: '都市',
    directors: [],
    directorCode: '',
    directorName: '自动匹配',
    aspect: '9:16',
    quality: '1080p',
    minutes: 10,
    episodeSec: 90,
    videoType: 'dynamic',
    preset: 'balanced',
    language: 'zh',
    aspectOpts: ASPECTS,
    qualityOpts: QUALITIES,
    minuteOpts: MINUTES,
    episodeOpts: EPISODES,
    typeOpts: VIDEO_TYPES,
    presetOpts: PRESETS,
    quote: null,
    quoteLoading: false,
    creating: false,
    autoMode: true,       // 一句话直出：创建后自动跑到成片
    createPhase: '',
    elapsed: 0,
    balance: 0,
    stylesError: '',
    showAllStyles: false,
    episodesText: 7,
    videoTypeText: '动态漫剧',
    imagePct: 0,
    videoPct: 0,
    llmPct: 0,
    segQualityStyle: '',
  },

  onLoad() {
    this.quoteSeq = 0;
    this.setData({ segQualityStyle: motion.segStyle(1, QUALITIES.length) });
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
    this.setData({ balance: app.globalData.balance || 0 });
    app.ready().then(() => {
      this.setData({ balance: app.globalData.balance || 0 });
      if (!this.data.styles.length) this.loadCatalog();
      // 首页带过来的一句话
      if (app.globalData.draftPrompt && !this.data.prompt) {
        this.setData({ prompt: app.globalData.draftPrompt }, () => this.syncMeta());
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
    Promise.all([api.styles(), api.directors()])
      .then(([styles, directors]) => {
        const list = Array.isArray(styles) ? styles : [];
        const picked = list.find((s) => s.code === this.data.styleCode);
        this.setData({
          styles: list,
          styleName: picked ? picked.name : this.data.styleName,
          directors: (Array.isArray(directors) ? directors : []).filter((d) => /^DIR-/.test(d.code)),
          stylesError: '',
        });
      })
      .catch((e) => this.setData({ stylesError: e.message || '风格库加载失败' }));
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
    this.setData({ prompt: e.currentTarget.dataset.text }, () => this.syncMeta());
  },

  /** 展示层的派生字段（集数、类型名、质量指示器）统一在这里算 */
  syncMeta() {
    const { minutes, episodeSec, videoType, quality } = this.data;
    const episodes = Math.max(1, Math.ceil((Number(minutes) * 60) / Number(episodeSec || 90)));
    const vt = VIDEO_TYPES.find((x) => x.key === videoType);
    const qi = Math.max(0, QUALITIES.findIndex((x) => x.key === quality));
    this.setData({
      episodesText: episodes,
      videoTypeText: vt ? vt.label : '动态漫剧',
      segQualityStyle: motion.segStyle(qi, QUALITIES.length),
    });
  },

  next() {
    const prompt = (this.data.prompt || '').trim();
    if (prompt.length < 6) {
      wx.showToast({ title: '再多写几个字，让 AI 看懂你的故事', icon: 'none' });
      return;
    }
    motion.haptic();
    this.setData({ step: 2 });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
    this.refreshQuote();
  },

  back() {
    motion.haptic();
    const step = Math.max(1, this.data.step - 1);
    this.setData({ step });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  toQuote() {
    motion.haptic();
    this.refreshQuote();
    this.setData({ step: 3 });
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  pick(e) {
    motion.haptic();
    const { field, value } = e.currentTarget.dataset;
    const patch = {};
    if (field === 'minutes' || field === 'episodeSec') patch[field] = Number(value);
    else patch[field] = value;
    if (field === 'styleCode') {
      const s = this.data.styles.find((x) => x.code === value);
      patch.styleName = s ? s.name : value;
    }
    if (field === 'directorCode') {
      const d = this.data.directors.find((x) => x.code === value);
      patch.directorName = d ? d.name : '自动匹配';
    }
    this.setData(patch, () => this.syncMeta());
    if (this.data.step >= 2) this.refreshQuote();
  },

  toggleAllStyles() {
    motion.haptic();
    this.setData({ showAllStyles: !this.data.showAllStyles });
  },

  refreshQuote() {
    const { prompt, styleCode, minutes, episodeSec, aspect, quality, preset, videoType } = this.data;
    if (!prompt) return;
    const seq = ++this.quoteSeq;
    this.setData({ quoteLoading: true });
    api.quote({ prompt, styleCode, totalMinutes: minutes, episodeSec, aspect, quality, preset, videoType })
      .then((q) => {
        if (seq !== this.quoteSeq) return; // 丢弃过期响应
        this.setData({ quote: this.decorate(q), quoteLoading: false });
      })
      .catch(() => {
        if (seq === this.quoteSeq) this.setData({ quoteLoading: false });
      });
  },

  decorate(q) {
    const credits = Number(q.est_credits) || 0;
    const minutes = Number(q.est_minutes) || 0;
    const b = q.breakdown || {};
    const imageCost = Math.round((b.image_per_shot || 0) * (q.total_shots || 0));
    const videoCost = Math.round((b.video_per_shot || 0) * (q.total_shots || 0));
    const llmCost = Math.round(b.llm_total || 0);
    const sum = imageCost + videoCost + llmCost || 1;
    this.setData({
      imagePct: Math.round((imageCost / sum) * 100),
      videoPct: Math.round((videoCost / sum) * 100),
      llmPct: Math.max(0, 100 - Math.round((imageCost / sum) * 100) - Math.round((videoCost / sum) * 100)),
    });
    return {
      ...q,
      credits_text: credits.toLocaleString ? credits.toLocaleString() : String(credits),
      cny_text: Number(q.est_cny || credits).toFixed(0),
      time_text: minutes >= 60 ? `${(minutes / 60).toFixed(1)} 小时` : `${minutes} 分钟`,
      image_cost: imageCost,
      video_cost: videoCost,
      llm_cost: llmCost,
    };
  },

  spec() {
    const { styleCode, directorCode, aspect, quality, preset, minutes, episodeSec, videoType, language } = this.data;
    return {
      style_code: styleCode,
      director_code: directorCode || null,
      aspect,
      quality,
      preset,
      total_minutes: minutes,
      episode_sec: episodeSec,
      video_type: videoType,
      language,
    };
  },

  /**
   * 开机 = 只创建项目 + 流水线。
   * 剧本/关键帧/视频全部留到项目内触发：素材要先上传，总谱要基于素材生成。
   */
  toggleAuto() {
    motion.haptic();
    this.setData({ autoMode: !this.data.autoMode });
  },

  create() {
    const app = getApp();
    if (this.data.creating) return;
    motion.haptic();
    this.setData({ creating: true, createPhase: '创建项目', elapsed: 0 });
    this.startTicker();
    const prompt = this.data.prompt.trim();
    const auto = this.data.autoMode;

    api.createProject({
      userId: app.globalData.userId,
      title: prompt.slice(0, 18),
      styleCode: this.data.styleCode,
      directorCode: this.data.directorCode || null,
      aspect: this.data.aspect,
      quality: this.data.quality,
      totalMinutes: this.data.minutes,
      episodeSec: this.data.episodeSec,
      preset: this.data.preset,
      videoType: this.data.videoType,
      language: this.data.language,
      prompt,
    })
      .then((proj) => {
        this.setData({ createPhase: '建立流水线' });
        return api.createRun(proj.id, 'BP_ONESHOT').catch(() => null).then(() => proj);
      })
      .then((proj) => {
        if (!auto) return { proj, runId: '' };
        this.setData({ createPhase: '启动一句话成剧' });
        // 编排失败不应该挡住"项目已建好"这件事：降级成手动模式进入剧组
        return api.oneshotStart(proj.id)
          .then((run) => ({ proj, runId: run && run.id ? run.id : '' }))
          .catch(() => ({ proj, runId: '' }));
      })
      .then(({ proj, runId }) => {
        this.setData({ createPhase: '进入剧组' });
        this.stopTicker();
        this.setData({ creating: false, createPhase: '', step: 1, prompt: '', quote: null });
        app.globalData.draftPrompt = '';
        const tail = runId ? `&setup=1&oneshot=${runId}` : '&setup=1';
        wx.navigateTo({ url: `/pages/project/project?id=${proj.id}&fresh=1${tail}` });
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
