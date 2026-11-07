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

/**
 * 创作来源（V4.6）。
 * 两条路都通向同一套生产链，区别只在「剧本从哪来」：
 *   idea     —— AI 出创意，适合还没有故事的人
 *   material —— 用户自带小说/剧本改编，系统必须沿用素材里的人物与世界观
 * 第二条路是为「手上已经有成熟创意、只想快点拍出来」的用户准备的。
 */
const ORIGINS = [
  {
    key: 'idea',
    label: '让 AI 出创意',
    sub: '给一个题材方向，系统编故事',
    icon: '创',
  },
  {
    key: 'material',
    label: '改编我的素材',
    sub: '贴小说/剧本正文，按你的故事拍',
    icon: '改',
  },
];

/** 改编强度：素材改编时必须让用户明确「改到什么程度」，否则 AI 会自作主张 */
const ADAPT_MODES = [
  { key: 'faithful', label: '忠于原著', sub: '主线、人物、结局都不动，只做竖屏拆分' },
  { key: 'remix', label: '按短剧重排', sub: '保设定保人物，重排节奏、合并次要角色、加强钩子' },
];

const MIN_ADAPT_CHARS = 200;

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
    // V4.8.1：预设之外允许自定义，输入框内容单独存字符串，避免边输边被 Number 吃掉
    countCustom: false,
    secCustom: false,
    countInput: '6',
    secInput: '90',
    totalMinutesText: '',
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
    // 模型 / 剪辑档位属于专业参数：默认收起，不让第一次用的人一上来就面对一堆术语
    showAdvanced: false,
    quote: null,
    quoteLoading: false,
    creating: false,
    createPhase: '',
    elapsed: 0,
    balance: 0,
    stylesError: '',
    showAllStyles: false,
    canCreate: false,
    // —— 多项目（V4.7）：一个人可以同时有几部剧在跑 ——
    myProjects: [],
    switcherOpen: false,
    // —— 创作来源（V4.6）——
    origins: ORIGINS,
    origin: 'idea',
    adaptModes: ADAPT_MODES,
    adaptMode: 'remix',
    scriptText: '',
    scriptChars: 0,
    scriptName: '',
    minAdaptChars: MIN_ADAPT_CHARS,
  },

  onLoad() {
    motion.enter(this);
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
    this.setData({ balance: app.globalData.balance || 0 });

    /**
     * 「另开一部」（V4.7）。
     *
     * 以前的坑：创作页是 tabBar 页，切走再切回来还是上次那一步，
     * 用户想开第二部剧只能反复点返回、手动清空，很容易以为「系统只允许一个项目」。
     * 现在任何入口（首页「新建 +」、项目页「另开一部」、我的剧组）都带这个标记，
     * 一进来就把表单复位，落到第 1 步。
     */
    const draft = app.globalData.draftTitle;
    if (app.globalData.startNew) {
      app.globalData.startNew = false;
      this.resetNew({ keepCatalog: true });
    }
    // 首页带过来的剧名优先：复位后再填，否则会被 reset 冲掉
    if (draft) {
      app.globalData.draftTitle = '';
      this.setData({ title: draft.slice(0, 30) }, () => this.syncMeta());
    } else if (!this.data.title && app.globalData.draftTitle) {
      this.setData({ title: app.globalData.draftTitle }, () => this.syncMeta());
    }

    app.ready().then(() => {
      this.setData({ balance: app.globalData.balance || 0 });
      if (!this.data.styles.length) this.loadCatalog();
      if (!this.data.modelRoles.length) this.loadModels();
      this.loadMyProjects();
    });
    this.syncMeta();
  },

  /** 拉一次自己有多少部剧，用于「我的剧组」切换 */
  loadMyProjects() {
    const app = getApp();
    if (!app.globalData.userId) return;
    api.projects(app.globalData.userId)
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        this.setData({ myProjects: arr.slice(0, 30).map((p) => ({ id: p.id, title: p.title, label: p.index_label || '' })) });
      })
      .catch(() => {});
  },

  /**
   * 复位成「新建一部」的干净状态。
   * keepCatalog：保留已加载的风格/模型目录，避免复位后又白屏一次。
   */
  resetNew(opts = {}) {
    const app = getApp();
    app.globalData.draftTitle = '';
    this.setData({
      step: 1,
      title: '',
      prompt: '',
      origin: 'idea',
      adaptMode: 'remix',
      scriptText: '',
      scriptChars: 0,
      scriptName: '',
      quote: null,
      quoteLoading: false,
      creating: false,
      createPhase: '',
      stylesError: '',
    });
    if (!opts.keepCatalog) {
      this.setData({ styles: [], modelRoles: [], editProfiles: [] });
      this.loadCatalog();
      this.loadModels();
    }
    this.syncMeta();
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /** 顶栏「另开一部」：已经有了剧，仍要能再开一部 */
  newProject() {
    motion.haptic();
    this.resetNew({ keepCatalog: true });
    wx.showToast({ title: '已清空，填写新剧名即可', icon: 'none' });
  },

  openSwitcher() {
    motion.haptic();
    this.loadMyProjects();
    this.setData({ switcherOpen: true });
  },

  closeSwitcher() {
    this.setData({ switcherOpen: false });
  },

  pickProject(e) {
    const id = e.currentTarget.dataset.id;
    motion.haptic();
    this.setData({ switcherOpen: false });
    wx.navigateTo({ url: `/pages/project/project?id=${id}` });
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
    const d = this.data;
    const titled = String(d.title || '').trim().length >= 2;
    // 改编路线：只有剧名不算准备好，得真有正文——否则「改编」两个字是空的
    const ready = d.origin === 'material'
      ? titled && String(d.scriptText || '').trim().length >= MIN_ADAPT_CHARS
      : titled;
    const mins = Math.max(1, Math.round((Number(d.episodeCount) * Number(d.episodeSec)) / 60));
    this.setData({
      canCreate: ready,
      totalMinutesText: `${mins} 分钟（${d.episodeCount} 集 × ${d.episodeSec} 秒）`,
    });
  },

  /** 集数自定义输入：只收 1-200 的整数，越界就夹紧（不弹错，避免打字时被打断） */
  onCountInput(e) {
    const raw = String(e.detail.value || '').replace(/[^\d]/g, '');
    const n = Number(raw);
    const patch = { countInput: raw };
    if (raw && n >= 1 && n <= 200) patch.episodeCount = n;
    this.setData(patch, () => this.syncMeta());
  },

  onCountBlur(e) {
    const n = Math.min(200, Math.max(1, Number(String(e.detail.value || '').replace(/[^\d]/g, '')) || this.data.episodeCount));
    this.setData({ countInput: String(n), episodeCount: n }, () => {
      this.syncMeta();
      if (this.data.step >= 2) this.refreshQuote();
    });
  },

  /** 单集时长自定义输入：15-600 秒 */
  onSecInput(e) {
    const raw = String(e.detail.value || '').replace(/[^\d]/g, '');
    const n = Number(raw);
    const patch = { secInput: raw };
    if (raw && n >= 15 && n <= 600) patch.episodeSec = n;
    this.setData(patch, () => this.syncMeta());
  },

  onSecBlur(e) {
    const n = Math.min(600, Math.max(15, Number(String(e.detail.value || '').replace(/[^\d]/g, '')) || this.data.episodeSec));
    this.setData({ secInput: String(n), episodeSec: n }, () => {
      this.syncMeta();
      if (this.data.step >= 2) this.refreshQuote();
    });
  },

  pickOrigin(e) {
    const origin = e.currentTarget.dataset.key;
    if (!origin || origin === this.data.origin) return;
    motion.haptic();
    this.setData({ origin }, () => this.syncMeta());
    if (origin === 'material') wx.pageScrollTo({ scrollTop: 300, duration: 240 });
  },

  pickAdaptMode(e) {
    const adaptMode = e.currentTarget.dataset.key;
    if (!adaptMode) return;
    motion.haptic();
    this.setData({ adaptMode });
  },

  onScriptText(e) {
    const v = e.detail.value || '';
    this.setData({ scriptText: v, scriptChars: v.replace(/\s/g, '').length }, () => this.syncMeta());
  },

  /**
   * 从微信聊天里选 TXT 读进输入框。
   * 只支持 txt：docx 是压缩包，前端解不了——那条路走「建组后素材页选 DOCX 自动取正文」，
   * 这里如实提示，不假装能读。
   */
  pickScriptFile() {
    motion.haptic();
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['txt', 'md'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) {
          wx.showToast({ title: '文本超过 2MB，请拆分后再传', icon: 'none' });
          return;
        }
        wx.getFileSystemManager().readFile({
          filePath: f.path,
          encoding: 'utf8',
          success: (r) => {
            const text = String(r.data || '').slice(0, 20000);
            this.setData({
              scriptText: text,
              scriptChars: text.replace(/\s/g, '').length,
              scriptName: f.name || '',
            }, () => this.syncMeta());
            wx.showToast({ title: `已读入 ${(f.name || '文本').slice(0, 12)}`, icon: 'none' });
          },
          fail: () => wx.showToast({ title: '这个文件读不出正文，可直接粘贴', icon: 'none' }),
        });
      },
      fail: () => {},
    });
  },

  next() {
    const title = String(this.data.title || '').trim();
    if (title.length < 2) {
      wx.showToast({ title: '先给这部剧起个名字（至少 2 个字）', icon: 'none' });
      return;
    }
    if (this.data.origin === 'material') {
      const chars = String(this.data.scriptText || '').trim().length;
      if (chars < MIN_ADAPT_CHARS) {
        wx.showToast({ title: `改编至少要有 ${MIN_ADAPT_CHARS} 字正文`, icon: 'none' });
        return;
      }
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
    if (field === 'episodeCount' || field === 'episodeSec') {
      const isCount = field === 'episodeCount';
      const customKey = isCount ? 'countCustom' : 'secCustom';
      if (value === 'custom') {
        // 切到自定义：保留当前数值作为输入框初值，用户再改
        patch[customKey] = true;
        patch[isCount ? 'countInput' : 'secInput'] = String(isCount ? this.data.episodeCount : this.data.episodeSec);
        return this.setData(patch, () => this.syncMeta());
      }
      patch[customKey] = false;
      patch[isCount ? 'countInput' : 'secInput'] = String(Number(value));
      value = Number(value);
    }
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

  toggleAdvanced() {
    motion.haptic();
    this.setData({ showAdvanced: !this.data.showAdvanced });
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
      // 不做整数取整：3 集 × 90 秒 = 4.5 分钟，取整会让服务端反推出 4 集
      totalMinutes: Math.max(1, Number(((d.episodeCount * d.episodeSec) / 60).toFixed(2))),
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
      episodeCount: spec.episodeCount,
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
      origin: this.data.origin,
      adaptMode: this.data.origin === 'material' ? this.data.adaptMode : null,
      ...this.spec(),
    })
      .then((proj) => {
        // 改编路线：项目一建好就把正文落成素材，用户进项目就能直接点「生成剧本」，
        // 不用再走一遍「先上传、再返回」的来回。
        const text = String(this.data.scriptText || '').trim();
        if (this.data.origin !== 'material' || !text) return proj;
        this.setData({ createPhase: '上传素材' });
        return api
          .addTextMaterial(proj.id, {
            name: this.data.scriptName || `${title}_正文.txt`,
            text,
            note: this.data.adaptMode === 'faithful' ? '忠于原著' : '按短剧重排',
            source: 'paste',
          })
          .then(() => proj)
          .catch(() => {
            // 素材没存上不能让用户以为改编成功了——明确告诉他去素材页补
            wx.showModal({
              title: '正文没存上',
              content: '项目已创建，但正文上传失败。请到「素材」页重新粘贴正文，再生成剧本。',
              showCancel: false,
            });
            return proj;
          });
      })
      .then((proj) => {
        this.setData({ createPhase: '进入剧组' });
        this.stopTicker();
        // 先记下路线，下面 setData 会把 origin 复位，不能复位后再判断
        const wasMaterial = this.data.origin === 'material';
        this.setData({
          creating: false, createPhase: '', step: 1, title: '', prompt: '',
          quote: null, scriptText: '', scriptChars: 0, scriptName: '', origin: 'idea',
        });
        app.globalData.draftTitle = '';
        // 新剧建好就把它设为分发页的默认项目，省一次手选
        app.globalData.selectedProjectId = proj.id;
        // 改编路线直接落在素材 tab：下一步就是点「用这些素材生成剧本」
        const adapt = wasMaterial ? '&tab=material&adapt=1' : '';
        wx.navigateTo({ url: `/pages/project/project?id=${proj.id}&fresh=1&setup=1${adapt}` });
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
