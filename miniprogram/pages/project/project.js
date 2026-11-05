const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const motion = require('../../utils/motion.js');

// 用户只看「做剧的步骤」，流水线/画布/节点一律留在后端
const TABS = [
  { key: 'material', label: '素材' },
  { key: 'script', label: '剧本' },
  { key: 'assets', label: '角色' },
  { key: 'gens', label: '镜头' },
  { key: 'shell', label: '剧壳' },
  { key: 'deliver', label: '成片' },
];

/**
 * 改编流水线的阶段判定（V4.6）。
 * 全部基于**真实产物**（素材条数 / 有没有大纲 / 资产数 / 出图数 / 成片数），
 * 不做假进度：没有就是没有，用户点进去自己能看到。
 */
function buildAdaptFlow(s = {}) {
  const steps = [
    { key: 'material', label: '上传素材', tab: 'material', done: Number(s.materials || 0) > 0 },
    { key: 'script', label: '生成剧本', tab: 'script', done: Boolean(s.hasPlan) },
    { key: 'episode', label: '剧集划分', tab: 'script', done: Number(s.episodes || 0) > 1 },
    { key: 'assets', label: '角色场景', tab: 'assets', done: Number(s.assets || 0) > 0 },
    { key: 'shots', label: '分镜图', tab: 'gens', done: Number(s.shotImages || 0) > 0 },
    { key: 'film', label: '剪辑成片', tab: 'deliver', done: Number(s.films || 0) > 0 },
    { key: 'dist', label: '分发上架', tab: 'deliver', done: Number(s.delivered || 0) > 0 },
  ];
  const firstUndone = steps.findIndex((x) => !x.done);
  if (firstUndone >= 0) steps[firstUndone].current = true;
  const NEXT_TEXT = {
    material: '先把小说/剧本正文贴进来——这是改编的原料',
    script: '点「按我的素材生成剧本」，产出大纲与剧集',
    episode: '确认集数与单集时长，再生成分镜',
    assets: '生成角色/道具/场景资产，把造型锁死',
    shots: '出分镜图，再转成视频',
    film: '剪辑成片，合成字幕与配音',
    dist: '备齐材料，上传到分发平台',
  };
  return {
    total: steps.length,
    done: steps.filter((x) => x.done).length,
    steps,
    next: firstUndone >= 0 ? NEXT_TEXT[steps[firstUndone].key] : '全部走完了，去分发页回填收益',
  };
}

const KIND_TEXT = { text: '文本', image: '图片', video: '视频', audio: '音频' };const KIND_ICON = { text: '文', image: '图', video: '影', audio: '声' };

const BGM_MODE_TEXT = {
  provided: '用户上传',
  library: '曲库真文件',
  synth: '程序合成（无版权）',
  none: '未配乐',
};

/** 剪辑单 → 页面视图模型（只做展示所需映射，不重算任何时间码） */
function shapeEdit(p) {
  if (!p) return null;
  const tl = p.timeline || { segments: [], total_sec: 0 };
  const v = p.video || {};
  const segs = (tl.segments || []).map((s) => ({
    shot_no: s.shot_no,
    start: Number(s.start).toFixed(1),
    end: Number(s.end).toFixed(1),
    duration: Number(s.duration).toFixed(1),
    transition: String(s.transition || '').replace('TRN-', ''),
    line: (s.dialogue_list || []).map((d) => (d.speaker ? `${d.speaker}：${d.line}` : d.line)).join(' / '),
    still: !!s.still,
    clipOk: !!s.clip_url,
  }));
  const errs = (p.errors || []).map((e) => ({
    code: e.code,
    issue: e.issue,
    shot: e.shot || '',
    fatal: e.severity !== 'advisory',
  }));
  return {
    ok: !!p.ok,
    episode: p.episode,
    aspect: v.aspect,
    resolution: v.resolution,
    fps: v.fps,
    totalSec: Number(tl.total_sec || 0).toFixed(1),
    shotCount: segs.length,
    coverage: Math.round((p.coverage ?? 0) * 100),
    missing: p.missing_shots || [],
    missingText: (p.missing_shots || []).slice(0, 8).join('、') + ((p.missing_shots || []).length > 8 ? ' 等' : ''),
    subtitleCount: (p.subtitles && p.subtitles.total) || 0,
    maxChars: p.subtitles && p.subtitles.stats ? p.subtitles.stats.max_chars_per_line : 0,
    sfxCount: (p.sound && p.sound.cues ? p.sound.cues.length : 0),
    ambienceCount: (p.sound && p.sound.ambience ? p.sound.ambience.length : 0),
    mood: (p.sound && p.sound.mood) || '—',
    bpm: (p.sound && p.sound.bpm) || '—',
    bgmMode: BGM_MODE_TEXT[p.bgm && p.bgm.mode] || '未知',
    bgmNote: (p.bgm && p.bgm.note) || '',
    deliverables: p.deliverables || [],
    fatal: errs.filter((e) => e.fatal),
    advisory: errs.filter((e) => !e.fatal),
    segments: segs,
    segLimit: 8,
    // 分镜还没生成时后端返回结构化的空剪辑单（station=need_storyboard），
    // UI 要引导去「流程」页，而不是显示「还差 0 个片段」这种莫名其妙的话
    station: p.station || null,
    noStoryboard: p.station === 'need_storyboard',
    nextAction: p.next_action || null,
    hasClips: segs.length > 0,
  };
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

/** 一句话成剧的三步中文名 */
const OS_LABEL = { plan: '剧本 · 总谱 · 分镜', shots: '逐镜出图出片', edit: '剪辑成片' };

function osSummary(step) {
  const s = step.summary;
  if (!s) return '';
  if (step.key === 'plan') return `${s.episodes ?? 0} 集 · ${s.shots_total ?? s.shots ?? 0} 镜 · 资产 ${s.assets ?? 0}`;
  if (step.key === 'shots') return `${s.shots_done ?? 0} / ${s.shots_total ?? 0} 镜`;
  if (step.key === 'edit') return s.rendered ? '成片已渲染' : (s.code === 'FFMPEG_MISSING' ? '命令已生成，待执行' : '剪辑单已生成');
  return '';
}

function shapeRun(run) {
  if (!run) return null;
  const statusText = { running: '进行中', done: '已完成', paused: '已暂停', failed: '已中断' }[run.status] || run.status;
  return {
    id: run.id,
    status: run.status,
    statusText,
    percent: (run.progress && run.progress.percent) || 0,
    shotsTotal: (run.progress && run.progress.shots_total) || 0,
    shotsDone: (run.progress && run.progress.shots_done) || 0,
    resumed: run.status !== 'done',
    pausedReason: run.paused_reason || '',
    steps: (run.steps || []).map((s) => ({
      key: s.key,
      label: OS_LABEL[s.key] || s.key,
      status: s.status,
      cls: s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'cur' : '',
      dot: s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'running' ? '●' : '○',
      note: osSummary(s),
      error: s.error || '',
    })),
  };
}

/** 资料包展示口径：文件大小等格式化（WXML 不能调函数，统一在这里算好） */
function packView(pack) {
  if (!pack) return null;
  const files = (pack.files || []).map((f) => ({
    ...f,
    sizeText: f.bytes ? fmt.fmtBytes(f.bytes) : '已包含',
  }));
  const missing = pack.checklist ? pack.checklist.filter((c) => c.missing) : (pack.missing || []);
  return {
    ...pack,
    files,
    missingText: missing.map((m) => m.label || m.key).join('、'),
    checklist: (pack.checklist || []).map((c) => ({
      ...c,
      mark: c.done ? '✓' : (c.required ? '✕' : '–'),
    })),
  };
}

Page({
  data: {
    projectId: '',
    pageAnim: false,
    loading: true,
    error: '',
    tab: 'material',
    tabs: TABS,
    recipes: [],
    syncRules: [],
    tabIndex: 0,
    segTabsStyle: '',
    setup: false,
    project: null,
    progress: { done: 0, total: 12, percent: 0, next: null },
    ringStyle: '',
    run: null,
    plan: null,
    shots: [],
    shotLimit: 12,
    shotItems: [],
    assets: null,
    gens: null,
    qc: null,
    gate: null,
    docs: null,
    deliveryItems: [],
    deliveryDone: 0,
    // 成片（剪辑单 + 渲染）
    edit: null,
    editLoading: false,
    editError: '',
    editBusy: '',
    editEpisode: '',      // 空 = 全片
    film: null,           // { video/srt/sheet/... }
    filmCmd: '',          // 云端无 ffmpeg 时的可复制命令
    os: null,             // 一句话成剧进度（兼容旧任务，不再在界面展示）
    osError: '',
    // 剧壳（片头片尾）
    shell: null,
    shellForm: { seriesTitle: '', tagline: '', introText: '', outroText: '', introSec: 3, outroSec: 4, enabled: true },
    shellBusy: '',
    // 剧集生产（单集 / 全自动）
    job: null,
    jobStates: [],
    produceEp: 1,
    produceBusy: '',
    // 分发资料包
    pack: null,
    packBusy: '',
    busy: '',
    balance: 0,
    isFresh: false,
    seriesInfo: { seasons: [], shared_assets: [], series: null },

    // 素材
    materials: [],
    materialStats: { total: 0, by_kind: { text: 0, image: 0, video: 0 }, text_chars: 0 },
    materialsUsed: 0,
    uploading: false,
    uploadText: '',
    materialNote: '',
    textSheet: false,
    textName: '',
    textBody: '',
    savingText: false,

    // 剧本
    scriptData: null,
    scriptLoading: false,
    scriptError: '',
    epIndex: 0,
    epOptions: [],
    currentScenes: [],
  },

  onLoad(q) {
    const app = getApp();
    const setup = q.setup === '1';
    this.setData({
      projectId: q.id || '',
      balance: app.globalData.balance || 0,
      isFresh: q.fresh === '1',
      setup,
      tab: setup ? 'material' : 'deliver',
      tabIndex: setup ? 0 : 5,
      segTabsStyle: motion.segStyle(setup ? 0 : 5, TABS.length),
    });
    this.reload(true);
  },

  onShow() {
    motion.enter(this);
    this.setData({ balance: getApp().globalData.balance || 0 });
    // 回到前台继续轮询托管任务（后台仍在逐集推进）
    if (this.data.job && this.data.job.status === 'running') this.pollJob();
    if (!this.data.recipes.length) this.loadEditLibraries();
  },

  onHide() {
    motion.clear(this);
    this.stopOneshot();
    this.stopJobPolling();
  },

  onUnload() {
    this.__gone = true;
    motion.clear(this);
    this.stopOneshot();
    this.stopJobPolling();
    this.stopUploading();
  },

  onPullDownRefresh() {
    this.reload(false).then(() => wx.stopPullDownRefresh());
  },

  noop() {},

  reload(showLoading) {
    if (!this.data.projectId) {
      this.setData({ loading: false, error: '缺少项目编号' });
      return Promise.resolve();
    }
    if (showLoading) this.setData({ loading: true, error: '' });
    return api.overview(this.data.projectId)
      .then((d) => {
        this.apply(d);
        this.loadSeries();
        this.loadMaterials();
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  /** 系列信息：本系列几季、多少个角色设定可复用 */
  loadSeries() {
    return api.projectSeries(this.data.projectId)
      .then((s) => this.setData({ seriesInfo: s }))
      .catch(() => {});
  },

  loadMaterials() {
    return api.materials(this.data.projectId)
      .then((d) => {
        const items = (d.items || []).map((m) => ({
          ...m,
          kindText: KIND_TEXT[m.kind] || '素材',
          icon: KIND_ICON[m.kind] || '素',
          sizeText: m.kind === 'text' ? `${m.chars} 字` : sizeText(m.size),
          timeText: fmt.timeAgo(m.created_at),
          thumb: m.kind === 'image' || m.kind === 'video' ? api.mediaUrl(m.url) : '',
          isImage: m.kind === 'image',
        }));
        this.setData({ materials: items, materialStats: d.stats || this.data.materialStats });
      })
      .catch(() => {});
  },

  apply(d) {
    const p = d.project || {};
    const spec = p.spec || {};
    const st = fmt.projectStatus(p.status);
    const plan = d.plan;
    const episodes = (plan && plan.episodes) || Math.max(1, Math.ceil(((Number(spec.total_minutes) || 10) * 60) / (Number(spec.episode_sec) || 90)));
    const assets = d.assets || { total: 0, ready: 0, items: [] };
    const gens = d.generations || { total: 0, credits: 0, items: [] };
    const qc = d.qc;
    const gate = d.gate;
    const progress = d.progress || { done: 0, total: 12, percent: 0, next: null };
    // 剧壳 / 剧集托管 / 资料包 / 已出成片（全部来自服务端聚合，前端不自己推状态）
    const shell = d.shell || {};
    const job = (d.jobs || [])[0] || null;
    const pack = packView((d.submissions || [])[0] || null);
    const films = d.films || [];

    const deliveryItems = [
      {
        label: '成片 MP4（片头 3 秒 AI 标识）',
        ok: gens.items.some((g) => g.kind === 'video' && g.status === 'done'),
        note: gens.items.some((g) => g.kind === 'video') ? '已生成镜头级视频' : '等待逐镜出片',
      },
      {
        label: '封面图（含 AI 标识角标）',
        ok: assets.ready > 0,
        note: assets.ready > 0 ? `${assets.ready} 张资产图就绪` : '等待关键帧生成',
      },
      {
        label: 'AI 创作说明 + 过程截图包',
        ok: Boolean(gate && !(gate.blockers || []).some((b) => b.code === 'PACK_NOT_BUILT')),
        note: '生成 7 页证据包',
      },
      {
        label: '一致性质检 KPI ≥ 0.82',
        ok: Boolean(qc && qc.kpi_met),
        note: qc && qc.total ? `均分 ${qc.avg === null ? '—' : qc.avg} / ${qc.total} 镜` : '尚未做一致性自检',
      },
      { label: '版权链证明', ok: false, note: '需在平台创作者中心上传原创声明' },
      { label: '平台合同', ok: false, note: '在平台侧签署，小程序不代签' },
    ];

    // 镜头 tab：把最近一次关键帧 / 视频挂到分镜上
    const byShot = {};
    for (const g of gens.items || []) {
      if (!g.shot_no) continue;
      byShot[g.shot_no] = byShot[g.shot_no] || {};
      const url = g.url || '';
      const usable = /^https?:\/\//.test(url) || url.startsWith('wxfile://');
      if (!usable) continue;
      if (g.kind === 'image' && !byShot[g.shot_no].image) byShot[g.shot_no].image = url;
      if (g.kind === 'video' && !byShot[g.shot_no].video) byShot[g.shot_no].video = url;
    }
    const shotItems = (d.shots || []).map((s) => ({
      ...s,
      imageUrl: (byShot[s.no] && byShot[s.no].image) || '',
      videoUrl: (byShot[s.no] && byShot[s.no].video) || '',
    }));

    this.setData({
      loading: false,
      error: '',
      project: {
        id: p.id,
        title: p.title || '未命名网剧',
        char: fmt.charOf(p.title),
        cover: fmt.coverOf(p.id || p.title),
        styleName: (d.style && d.style.name) || spec.style_code || '都市',
        statusText: st.text,
        statusCls: st.cls,
        episodes,
        minutes: Number(spec.total_minutes) || 0,
        episodeSec: Number(spec.episode_sec) || 90,
        quality: spec.quality || '1080p',
        aspect: spec.aspect || '9:16',
        videoType: spec.video_type || 'dynamic',
        prompt: spec.prompt || '',
        // 创作来源（V4.6）：改编路线的文案与提示跟 AI 出创意不一样
        origin: spec.origin === 'material' ? 'material' : 'idea',
        adaptMode: spec.adapt_mode || null,
        adaptModeText: spec.adapt_mode === 'faithful' ? '忠于原著' : '按短剧重排',
        createdAt: p.created_at,
        timeText: fmt.timeAgo(p.created_at),
        seasonNo: Number(p.season_no) || 1,
        seasonTag: (Number(p.season_no) || 1) > 1 ? `第 ${Number(p.season_no)} 季` : '',
        seriesId: p.series_id || '',
      },
      progress,
      ringStyle: motion.ringStyle(progress.percent),
      run: d.run ? { id: d.run.id, status: d.run.status, totalCredits: d.run.total_credits || 0 } : null,
      plan,
      shots: d.shots || [],
      shotItems,
      assets: {
        total: assets.total,
        ready: assets.ready,
        items: (assets.items || []).map((a) => ({ ...a, char: fmt.charOf(a.name) })),
      },
      gens: {
        total: gens.total,
        credits: gens.credits,
        items: (gens.items || []).map((g) => ({
          ...g,
          kindText: g.kind === 'image' ? '关键帧' : g.kind === 'video' ? '视频' : g.kind === 'audio' ? '配音' : g.kind === 'music' ? '配乐' : g.kind,
          kindChar: g.kind === 'image' ? '帧' : g.kind === 'video' ? '影' : g.kind === 'audio' ? '声' : '乐',
          statusText: g.status === 'done' || g.status === 'success' ? '已完成' : g.status === 'failed' ? '失败' : '进行中',
          statusCls: g.status === 'done' || g.status === 'success' ? 'pill-green' : g.status === 'failed' ? 'pill-red' : 'pill-gold',
          timeText: fmt.timeAgo(g.created_at),
          playable: Boolean(g.url),
          isVideo: g.kind === 'video',
        })),
      },
      qc,
      gate,
      shell,
      shellForm: {
        seriesTitle: shell.series_title || p.title || '',
        tagline: shell.tagline || '',
        introText: (shell.opening && shell.opening.text) || p.title || '',
        outroText: (shell.ending && shell.ending.text) || '下集更精彩 · 关注不迷路',
        introSec: (shell.opening && shell.opening.sec) || 3,
        outroSec: (shell.ending && shell.ending.sec) || 4,
        enabled: shell.enabled !== false,
      },
      job: job ? this.shapeJob(job) : null,
      jobStates: job ? (job.episode_states || []) : [],
      pack: pack || null,
      films,
      docs: d.docs,
      materialsUsed: d.materials_used || 0,
      deliveryItems,
      deliveryDone: deliveryItems.filter((x) => x.ok).length,
      epList: Array.from({ length: Math.max(1, Number(episodes) || 1) }, (_, i) => i + 1),
      produceEp: this.data.produceEp && this.data.produceEp <= episodes ? this.data.produceEp : 1,
      // 改编流水线（V4.6）：素材 → 剧本 → 资产 → 镜头 → 分发，用户随时知道自己在第几步
      adaptFlow: buildAdaptFlow({
        origin: spec.origin === 'material' ? 'material' : 'idea',
        materials: (d.stats && d.stats.total) || (this.data.materialStats && this.data.materialStats.total) || 0,
        hasPlan: Boolean(plan),
        episodes: plan && plan.episodes ? plan.episodes : 0,
        assets: assets.total,
        shots: (d.shots || []).length,
        shotImages: (d.shots || []).filter((s) => s.has_image || s.image_url).length,
        films: (films || []).length,
        delivered: deliveryItems.filter((x) => x.ok).length,
      }),
    });
  },

  // ——— tab ———
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    const idx = TABS.findIndex((t) => t.key === tab);
    motion.haptic();
    this.setData({ tab, tabIndex: idx < 0 ? 0 : idx, segTabsStyle: motion.segStyle(idx < 0 ? 0 : idx, TABS.length) });
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
    if (tab === 'script') this.loadScript();
    if (tab === 'material') this.loadMaterials();
    if (tab === 'deliver') this.loadEdit();
  },

  /** 剪辑单提示「还没分镜」时，一键跳回流程页去生成 */
  goFlow() {
    motion.haptic();
    const idx = TABS.findIndex((t) => t.key === 'script');
    const i = idx < 0 ? 0 : idx;
    this.setData({ tab: 'script', tabIndex: i, segTabsStyle: motion.segStyle(i, TABS.length) });
    wx.pageScrollTo({ scrollTop: 0, duration: 180 });
  },

  /** 九大提示词库里的「剪辑配方」「字幕同步」：让用户能换打法，而不是写死 */
  loadEditLibraries() {
    Promise.all([api.promptKind('edit'), api.promptKind('sync')])
      .then(([r, s2]) => {
        this.setData({
          recipes: (r.items || []).map((x) => ({ code: x.code, name: x.name, text: x.text })),
          syncRules: (s2.items || []).map((x) => ({ code: x.code, name: x.name, text: x.text })),
        });
      })
      .catch(() => { /* 库读不到不影响剪辑单本身 */ });
  },

  pickRecipe() {
    const list = this.data.recipes || [];
    if (!list.length) return;
    motion.haptic();
    wx.showActionSheet({
      itemList: list.map((x) => `${x.name}（${x.code.replace('EDR-', '')}）`),
      success: (r) => {
        const pick = list[r.tapIndex];
        if (!pick) return;
        api.updateProject(this.data.projectId, { editRecipe: pick.code })
          .then(() => {
            wx.showToast({ title: `已切换：${pick.name}`, icon: 'none' });
            this.reloadEdit();
          })
          .catch(() => {});
      },
    });
  },

  pickSyncRule() {
    const list = this.data.syncRules || [];
    if (!list.length) return;
    motion.haptic();
    wx.showActionSheet({
      itemList: list.map((x) => `${x.name}（${x.code.replace('SYN-', '')}）`),
      success: (r) => {
        const pick = list[r.tapIndex];
        if (!pick) return;
        api.updateProject(this.data.projectId, { subtitleSync: pick.code })
          .then(() => {
            wx.showToast({ title: `已切换：${pick.name}`, icon: 'none' });
            this.reloadEdit();
          })
          .catch(() => {});
      },
    });
  },

  toggleShots() {    motion.haptic();
    this.setData({ shotLimit: this.data.shotLimit >= this.data.shots.length ? 12 : this.data.shots.length });
  },

  backTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  // ——— 素材 ———
  openTextSheet() {
    motion.haptic();
    this.setData({ textSheet: true, textName: '', textBody: '' });
  },

  closeTextSheet() {
    this.setData({ textSheet: false });
  },

  onTextName(e) {
    this.setData({ textName: e.detail.value });
  },

  onTextBody(e) {
    this.setData({ textBody: e.detail.value });
  },

  onNote(e) {
    this.setData({ materialNote: e.detail.value });
  },

  saveText() {
    const text = (this.data.textBody || '').trim();
    if (text.length < 20) {
      wx.showToast({ title: '正文太短，至少 20 字', icon: 'none' });
      return;
    }
    if (this.data.savingText) return;
    this.setData({ savingText: true });
    api.addTextMaterial(this.data.projectId, {
      name: (this.data.textName || '').trim() || '粘贴文本',
      text,
      note: this.data.materialNote || '',
    })
      .then((d) => {
        wx.showToast({ title: '素材已入库', icon: 'none' });
        this.setData({
          textSheet: false, textName: '', textBody: '', materialStats: d.stats || this.data.materialStats,
        });
        this.loadMaterials();
      })
      .catch((e) => wx.showModal({ title: '保存失败', content: e.message || '请稍后重试', showCancel: false }))
      .then(() => this.setData({ savingText: false }));
  },

  pickImages() {
    if (this.data.uploading) return;
    motion.haptic();
    if (!wx.chooseMedia) {
      wx.showToast({ title: '当前微信版本不支持选图，请升级', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (r) => this.uploadAll((r.tempFiles || []).map((f) => ({ path: f.tempFilePath, size: f.size })), 'image'),
    });
  },

  pickVideos() {
    if (this.data.uploading) return;
    motion.haptic();
    if (!wx.chooseMedia) {
      wx.showToast({ title: '当前微信版本不支持选视频，请升级', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
      success: (r) => this.uploadAll((r.tempFiles || []).map((f) => ({ path: f.tempFilePath, size: f.size })), 'video'),
    });
  },

  pickFiles() {
    if (this.data.uploading) return;
    motion.haptic();
    if (!wx.chooseMessageFile) {
      wx.showToast({ title: '当前环境不支持选文件', icon: 'none' });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['txt', 'md', 'docx'],
      success: (r) => this.uploadAll((r.tempFiles || []).map((f) => ({ path: f.path || f.tempFilePath, size: f.size })), 'file'),
    });
  },

  uploadAll(files, kind) {
    if (!files.length) return;
    const limit = kind === 'video' ? 24 * 1024 * 1024 : kind === 'image' ? 8 * 1024 * 1024 : 10 * 1024 * 1024;
    const valid = files.filter((f) => {
      if (f.size && f.size > limit) {
        wx.showToast({ title: `${kind === 'video' ? '视频' : '文件'}超过 ${Math.round(limit / 1024 / 1024)}MB`, icon: 'none' });
        return false;
      }
      return true;
    });
    if (!valid.length) return;

    this.setData({ uploading: true, uploadText: `0/${valid.length}` });
    let done = 0;
    const note = this.data.materialNote || '';
    const step = (i) => {
      if (i >= valid.length) {
        this.setData({ uploading: false, uploadText: '', materialNote: '' });
        this.loadMaterials();
        wx.showToast({ title: `已上传 ${done} 个素材`, icon: 'none' });
        return;
      }
      this.setData({ uploadText: `${i}/${valid.length}` });
      api.uploadMaterial(this.data.projectId, valid[i].path, note)
        .then(() => { done += 1; })
        .catch((e) => {
          if (e.code !== 'MATERIAL_TOO_LARGE') {
            wx.showToast({ title: e.message || '上传失败', icon: 'none' });
          }
        })
        .then(() => step(i + 1));
    };
    step(0);
  },

  stopUploading() {
    // wx.uploadFile 没有统一取消句柄；页面卸载后不再继续串行上传即可
    this.__gone = true;
  },

  previewMaterial(e) {
    const m = this.data.materials[e.currentTarget.dataset.index];
    if (!m) return;
    if (m.kind === 'image') {
      wx.previewImage({ urls: [m.thumb || api.mediaUrl(m.url)], current: m.thumb || api.mediaUrl(m.url) });
      return;
    }
    if (m.kind === 'video') {
      wx.previewMedia({ sources: [{ url: api.mediaUrl(m.url), type: 'video' }] });
      return;
    }
    if (m.preview) {
      wx.showModal({ title: m.name, content: m.preview, showCancel: false, confirmText: '知道了' });
    }
  },

  removeMaterial(e) {
    const m = this.data.materials[e.currentTarget.dataset.index];
    if (!m) return;
    wx.showModal({
      title: '删除素材',
      content: `确定删除「${m.name}」？删除后不再参与剧本生成。`,
      confirmText: '删除',
      confirmColor: '#FF7080',
      success: (r) => {
        if (!r.confirm) return;
        api.removeMaterial(this.data.projectId, m.id)
          .then(() => this.loadMaterials())
          .catch((err) => wx.showToast({ title: err.message || '删除失败', icon: 'none' }));
      },
    });
  },

  /** 用当前素材生成剧本与分镜（覆盖旧版） */
  generateScript() {
    if (this.data.busy) return;
    motion.haptic();
    const has = this.data.materialStats.total > 0;
    const go = () => {
      this.setData({ busy: 'plan' });
      api.buildProjectPlan(this.data.projectId)
        .then((r) => {
          wx.showToast({ title: `${r.script_episodes} 集 · ${r.shots} 镜`, icon: 'none' });
          return this.reload(false).then(() => {
            this.setData({ tab: 'script', tabIndex: 1, segTabsStyle: motion.segStyle(1, TABS.length) });
            return this.loadScript();
          });
        })
        .catch((e) => wx.showModal({ title: '生成失败', content: e.message || '请稍后重试', showCancel: false }))
        .then(() => this.setData({ busy: '' }));
    };
    if (has) return go();
    wx.showModal({
      title: '还没上传素材',
      content: '可以直接按一句话创意生成；上传小说正文或参考图，人物与情节会更贴近你的设定。',
      confirmText: '直接生成',
      cancelText: '去上传',
      success: (r) => {
        if (r.confirm) go();
        else this.setData({ tab: 'material', tabIndex: 0, segTabsStyle: motion.segStyle(0, TABS.length) });
      },
    });
  },

  // ——— 剧本 ———
  loadScript() {
    if (this.data.scriptLoading) return Promise.resolve();
    this.setData({ scriptLoading: true, scriptError: '' });
    return api.projectScript(this.data.projectId)
      .then((d) => {
        const episodes = d.episodes || [];
        const epOptions = episodes.map((ep) => ({ no: ep.no, label: `第 ${ep.no} 集`, scenes: (ep.scenes || []).length }));
        const idx = Math.min(this.data.epIndex, Math.max(0, episodes.length - 1));
        this.setData({
          scriptData: d,
          epOptions,
          epIndex: idx,
          currentScenes: this.decorateScenes((episodes[idx] && episodes[idx].scenes) || []),
          scriptLoading: false,
        });
      })
      .catch((e) => this.setData({ scriptLoading: false, scriptError: e.message || '剧本加载失败' }));
  },

  pickEpisode(e) {
    const idx = Number(e.currentTarget.dataset.index) || 0;
    motion.haptic();
    const episodes = (this.data.scriptData && this.data.scriptData.episodes) || [];
    this.setData({
      epIndex: idx,
      currentScenes: this.decorateScenes((episodes[idx] && episodes[idx].scenes) || []),
    });
  },

  /** 场次展示层：把数组型标注拼成一行字，WXML 里不做 join */
  decorateScenes(scenes) {
    return (scenes || []).map((sc) => {
      const l = sc.locked || null;
      const lighting = l ? (l.lighting_codes || []).join(' / ') : '';
      return {
        ...sc,
        lockedText: l ? `光影 ${lighting || '—'} · 转场 ${l.transition || '—'} · 节奏 ${l.rhythm_code || '—'}` : '',
      };
    });
  },

  // ——— 镜头生产 ———
  genShot(e) {
    const { no, kind } = e.currentTarget.dataset;
    if (!no || this.data.busy) return;
    motion.haptic();
    this.setData({ busy: `${no}:${kind}` });
    api.generateShot(this.data.projectId, no, kind || 'image')
      .then((r) => {
        wx.showToast({ title: `${kind === 'video' ? '视频' : '关键帧'}完成 · ${r.credits} 点`, icon: 'none' });
        return this.reload(false);
      })
      .catch((err) => {
        const map = {
          INSUFFICIENT_CREDITS: '点数不足，请先充值',
          SHOT_SOURCE_REQUIRED: '请先生成这一镜的关键帧',
        };
        wx.showModal({ title: '生成未完成', content: map[err.code] || err.message || '请稍后重试', showCancel: false });
      })
      .then(() => this.setData({ busy: '' }));
  },

  // ——— 其他动作 ———
  createSeason() {
    if (this.data.busy) return;
    motion.haptic();
    const no = (this.data.project.seasonNo || 1) + 1;
    const chars = this.data.seriesInfo.shared_assets.length;
    wx.showModal({
      title: '拍下一季',
      content: `以《${this.data.project.title}》为参考新建第 ${no} 季：继承风格与画幅，复制 ${chars} 个角色设定（连续性锁不变，不继承上一季画面）。`,
      confirmText: '创建',
      cancelText: '再想想',
      success: (r) => {
        if (r.confirm) this.doCreateSeason(no);
      },
    });
  },

  doCreateSeason(no) {
    this.setData({ busy: 'season' });
    api.createSeason(this.data.projectId, {})
      .then((r) => api.buildProjectPlan(r.project.id)
        .catch(() => null)
        .then(() => api.createRun(r.project.id, 'BP_ONESHOT').catch(() => null))
        .then(() => r.project))
      .then((p) => {
        wx.showToast({ title: `第 ${no} 季已创建`, icon: 'none' });
        wx.redirectTo({ url: `/pages/project/project?id=${p.id}&fresh=1` });
      })
      .catch((e) => wx.showModal({ title: '创建失败', content: e.message || '请稍后重试', showCancel: false }))
      .then(() => this.setData({ busy: '' }));
  },

  buildPlan() {
    if (this.data.busy) return;
    this.setData({ busy: 'plan' });
    api.buildProjectPlan(this.data.projectId)
      .then(() => {
        wx.showToast({ title: '剧本与总谱已生成', icon: 'none' });
        return this.reload(false);
      })
      .catch((e) => wx.showModal({ title: '生成失败', content: e.message || '请稍后重试', showCancel: false }))
      .then(() => this.setData({ busy: '' }));
  },

  buildRun() {
    if (this.data.busy) return;
    this.setData({ busy: 'run' });
    api.createRun(this.data.projectId, 'BP_ONESHOT')
      .then(() => {
        wx.showToast({ title: '流水线已建立', icon: 'none' });
        return this.reload(false);
      })
      .catch((e) => wx.showModal({ title: '建立失败', content: e.message || '请稍后重试', showCancel: false }))
      .then(() => this.setData({ busy: '' }));
  },

  buildPack() {
    if (this.data.busy) return;
    this.setData({ busy: 'pack' });
    api.buildCompliancePack({ projectId: this.data.projectId, episodeNo: 'E01' })
      .then((pack) => {
        wx.showModal({
          title: '合规包已生成',
          content: `共 ${pack.evidence_pages.length} 页创作过程证据（全屏 / 带网址 / 带时间戳），校验${pack.validation.ok ? '通过' : '未通过'}。请在电脑端打印为 PDF 后随片上传。`,
          showCancel: false,
        });
        return this.reload(false);
      })
      .catch((e) => wx.showModal({ title: '生成失败', content: e.message || '请稍后重试', showCancel: false }))
      .then(() => this.setData({ busy: '' }));
  },

  previewGen(e) {
    const item = this.data.gens.items.find((g) => g.id === e.currentTarget.dataset.id);
    if (!item || !item.url) {
      wx.showToast({ title: '该产物还没有可预览的地址', icon: 'none' });
      return;
    }
    if (item.kind === 'image') {
      wx.previewImage({ urls: [item.url], current: item.url });
      return;
    }
    wx.setClipboardData({
      data: item.url,
      success: () => wx.showToast({ title: '产物链接已复制，可在浏览器打开', icon: 'none' }),
    });
  },

  copyPrompt() {
    wx.setClipboardData({
      data: this.data.project.prompt || '',
      success: () => wx.showToast({ title: '创意已复制', icon: 'none' }),
    });
  },

  /** 交付 Checklist 的第一项由真实剪辑单决定：没剪出来就不算交付 */
  syncDelivery() {
    const items = (this.data.deliveryItems || []).map((x) => ({ ...x }));
    if (!items.length) return;
    const ed = this.data.edit;
    const film = this.data.film;
    items[0] = {
      ...items[0],
      ok: !!film,
      note: film
        ? `成片已渲染 · ${ed ? ed.totalSec + 's / ' + ed.resolution : '可下载'}`
        : ed && ed.ok
          ? `剪辑单就绪 · ${ed.shotCount} 镜 / ${ed.totalSec}s，点上方「渲染成片」`
          : ed
            ? `还缺 ${ed.missing.length} 个镜头片段`
            : items[0].note,
    };
    this.setData({ deliveryItems: items, deliveryDone: items.filter((x) => x.ok).length });
  },

  // ——— 一句话成剧（OneShot 单步推进）———
  pumpOneshot() {
    if (!this.osId || this.__gone) return;
    this.stopOneshot();
    const tick = () => {
      if (this.__gone) return;
      api.oneshotStep(this.osId)
        .then((run) => {
          this.setData({ os: shapeRun(run) });
          if (run.status === 'running') {
            this.osTimer = setTimeout(tick, 900);
            return;
          }
          this.osTimer = null;
          if (run.status === 'done') {
            this.reload(false).then(() => this.loadEdit(true));
            wx.showToast({ title: '一集已跑完', icon: 'none' });
          } else if (run.status === 'paused') {
            wx.showModal({
              title: '已暂停',
              content: run.paused_reason === 'INSUFFICIENT_CREDITS'
                ? '余额不足，已停在当前进度。充值后点「继续」即可从断点续跑，已生成的镜头不会重花。'
                : (run.paused_reason || '编排已暂停，可继续。'),
              confirmText: '去充值',
              cancelText: '稍后',
              success: (r) => { if (r.confirm) wx.switchTab({ url: '/pages/mine/mine' }); },
            });
          } else if (run.status === 'failed') {
            const bad = (run.steps || []).find((s) => s.status === 'failed');
            wx.showModal({
              title: '编排中断',
              content: (bad && bad.error) || '某一步失败了，可点「继续」重试该步。',
              showCancel: false,
            });
          }
        })
        .catch((e) => {
          this.osTimer = null;
          this.setData({ osError: e.message || '推进失败' });
        });
    };
    tick();
  },

  stopOneshot() {
    if (this.osTimer) {
      clearTimeout(this.osTimer);
      this.osTimer = null;
    }
  },

  resumeOneshot() {
    motion.haptic();
    this.setData({ osError: '' });
    this.pumpOneshot();
  },

  stopRun() {
    this.stopOneshot();
    wx.showToast({ title: '已暂停推进，随时可继续', icon: 'none' });
    this.setData({ os: this.data.os ? { ...this.data.os, status: 'paused', statusText: '已暂停' } : null });
  },

  // ——— 成片：剪辑单 / 渲染 ———
  loadEdit(silent) {
    if (!this.data.projectId) return;
    if (!silent) this.setData({ editLoading: true, editError: '' });
    api.editPlan(this.data.projectId, this.data.editEpisode || null)
      .then((p) => {
        this.setData({ edit: shapeEdit(p), editLoading: false, editError: '' });
        this.syncDelivery();
      })
      .catch((e) => this.setData({
        edit: null,
        editLoading: false,
        editError: e.message || '剪辑单不可用（可能还没有分镜）',
      }));
  },

  reloadEdit() {
    motion.haptic();
    this.setData({ film: null, filmCmd: '' });
    this.loadEdit(false);
  },

  pickEditEpisode(e) {
    const ep = e.currentTarget.dataset.ep || '';
    if (ep === this.data.editEpisode) return;
    motion.haptic();
    this.setData({ editEpisode: ep, film: null, filmCmd: '' });
    this.loadEdit(false);
  },

  moreSegments() {
    const ed = this.data.edit;
    if (!ed) return;
    this.setData({ 'edit.segLimit': ed.segLimit + 12 });
  },

  renderFilm() {
    if (this.data.editBusy) return;
    const ed = this.data.edit;
    if (!ed) {
      wx.showToast({ title: '先出剪辑单', icon: 'none' });
      return;
    }
    if (!ed.ok) {
      wx.showModal({
        title: '还不能剪',
        content: ed.missing.length
          ? `还有 ${ed.missing.length} 个镜头没出片（${ed.missing.slice(0, 6).join('、')}${ed.missing.length > 6 ? ' 等' : ''}），补齐后再渲染。`
          : `剪辑单有 ${ed.fatal.length} 个阻断项，先处理第一条：${ed.fatal[0].issue || ed.fatal[0].code}`,
        showCancel: false,
      });
      return;
    }
    motion.haptic();
    this.setData({ editBusy: 'render' });
    wx.showLoading({ title: '剪辑中…', mask: true });
    api.editRender(this.data.projectId, this.data.editEpisode || null)
      .then((r) => {
        wx.hideLoading();
        if (r.ok) {
          this.setData({ film: r.assets || null, filmCmd: '' });
          this.syncDelivery();
          wx.showModal({
            title: '成片已生成',
            content: `约 ${ed.totalSec} 秒 · ${ed.resolution} · 字幕 ${ed.subtitleCount} 条已烧录，配乐与音效已混音。可复制链接下载或直接去分发中控。`,
            confirmText: '去分发',
            success: (x) => { if (x.confirm) this.goDistribute(); },
          });
          return;
        }
        if (r.code === 'FFMPEG_MISSING') {
          this.setData({ filmCmd: r.cmd || '', film: null });
          wx.showModal({
            title: '渲染环境缺 ffmpeg',
            content: '剪辑单、字幕、配乐、音效都已生成并落盘，只差最后一步合成。命令已准备好，可复制到装有 ffmpeg 的机器（或云托管镜像）执行。',
            confirmText: '复制命令',
            success: (x) => {
              if (x.confirm && r.cmd) {
                wx.setClipboardData({ data: r.cmd, success: () => wx.showToast({ title: '命令已复制', icon: 'none' }) });
              }
            },
          });
          return;
        }
        // EDIT_PLAN_BLOCKED 等
        const first = (r.errors && r.errors[0]) || {};
        wx.showModal({
          title: '剪辑被拦下',
          content: r.hint || first.issue || '剪辑单存在阻断问题',
          showCancel: false,
        });
      })
      .catch((e) => {
        wx.hideLoading();
        wx.showModal({ title: '渲染失败', content: e.message || '请稍后重试', showCancel: false });
      })
      .then(() => this.setData({ editBusy: '' }));
  },

  copyFilmCmd() {
    if (!this.data.filmCmd) return;
    wx.setClipboardData({
      data: this.data.filmCmd,
      success: () => wx.showToast({ title: '命令已复制', icon: 'none' }),
    });
  },

  copyFilmFile(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    });
  },

  previewFilm() {
    const f = this.data.film;
    if (!f || !f.video) {
      wx.showToast({ title: '还没有成片文件', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: f.video.url,
      success: () => wx.showToast({ title: '成片链接已复制，可在浏览器打开', icon: 'none' }),
    });
  },

  // ——— 剧壳（片头片尾）———
  shapeJob(job) {
    const st = job.status;
    const text = { running: '后台制作中', paused: '已暂停', done: '全部完成', failed: '已中断' }[st] || st;
    const cls = st === 'done' ? 'pill-green' : st === 'failed' ? 'pill-red' : st === 'paused' ? 'pill-gold' : 'pill-blue';
    return { ...job, statusText: text, statusCls: cls, percent: (job.progress && job.progress.percent) || 0 };
  },

  onShellInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`shellForm.${field}`]: e.detail.value });
  },

  pickShellSec(e) {
    motion.haptic();
    const { field, value } = e.currentTarget.dataset;
    this.setData({ [`shellForm.${field}`]: Number(value) });
  },

  saveShell() {
    if (this.data.shellBusy) return;
    const f = this.data.shellForm;
    this.setData({ shellBusy: 'save' });
    api.saveShell(this.data.projectId, {
      enabled: f.enabled,
      series_title: f.seriesTitle,
      tagline: f.tagline,
      opening: { enabled: true, sec: f.introSec, text: f.introText },
      ending: { enabled: true, sec: f.outroSec, text: f.outroText },
    })
      .then((shell) => {
        wx.showToast({ title: '剧壳已保存', icon: 'none' });
        this.setData({ shell });
      })
      .catch(() => {})
      .then(() => this.setData({ shellBusy: '' }));
  },

  makeShellCard(e) {
    const kind = e.currentTarget.dataset.kind || 'intro';
    if (this.data.shellBusy) return;
    this.setData({ shellBusy: kind });
    wx.showLoading({ title: kind === 'intro' ? '生成片头…' : '生成片尾…', mask: true });
    api.renderShellCard(this.data.projectId, kind)
      .then((r) => {
        wx.hideLoading();
        if (r.ok) {
          wx.showToast({ title: `${kind === 'intro' ? '片头' : '片尾'}已生成`, icon: 'none' });
          return this.reload(false);
        }
        wx.showModal({
          title: '当前环境无法生成',
          content: (r.hint || '生成失败') + (r.cmd ? '\n\n命令已生成，可复制到本机执行。' : ''),
          confirmText: r.cmd ? '复制命令' : '知道了',
          success: (x) => {
            if (x.confirm && r.cmd) wx.setClipboardData({ data: r.cmd });
          },
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: err.message || '生成失败', icon: 'none' });
      })
      .then(() => this.setData({ shellBusy: '' }));
  },

  // ——— 剧集生产（单集 / 全自动托管）———
  pickProduceEp(e) {
    motion.haptic();
    this.setData({ produceEp: Number(e.currentTarget.dataset.ep) || 1 });
  },

  produce(mode) {
    if (this.data.produceBusy) return;
    motion.haptic();
    const ep = `E${String(this.data.produceEp).padStart(2, '0')}`;
    const label = mode === 'auto' ? '全自动逐集生成' : `第 ${this.data.produceEp} 集`;
    wx.showModal({
      title: mode === 'auto' ? '开启自动成片' : '生成这一集',
      content: mode === 'auto'
        ? '后台会从这一集开始逐集出图、出片、剪辑，关掉小程序也会继续；做完的成片自动进「我的资产」，余额不足会停在当前集。'
        : `${label}：先补齐缺失镜头，再剪辑成片。已有产物不会重复扣费。`,
      confirmText: '开始',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ produceBusy: mode });
        api.produce(this.data.projectId, { mode, episode: ep })
          .then((job) => {
            this.setData({ job: this.shapeJob(job), jobStates: job.episode_states || [] });
            this.pollJob();
          })
          .catch((err) => wx.showModal({ title: '未能开始', content: err.message || '请稍后重试', showCancel: false }))
          .then(() => this.setData({ produceBusy: '' }));
      },
    });
  },

  pollJob() {
    const job = this.data.job;
    if (!job || !job.id) return;
    if (this.jobTimer) clearTimeout(this.jobTimer);
    const tick = () => {
      if (this.__gone) return;
      api.produceStep(job.id)
        .then((next) => {
          this.setData({ job: this.shapeJob(next), jobStates: next.episode_states || [] });
          if (next.status === 'running') {
            this.jobTimer = setTimeout(tick, 1500);
            return;
          }
          this.jobTimer = null;
          this.reload(false);
          if (next.status === 'done') {
            wx.showToast({ title: '成片已全部完成', icon: 'none' });
          } else if (next.status === 'paused') {
            wx.showModal({
              title: '已暂停',
              content: next.paused_reason === 'INSUFFICIENT_CREDITS'
                ? '余额不足，已停在当前集。充值后点「继续托管」即可从断点续跑，已生成镜头不会重花。'
                : (next.paused_reason === 'FFMPEG_MISSING'
                  ? '当前服务器缺少剪辑组件，剪辑单与字幕已生成，可联系管理员配置渲染环境。'
                  : (next.paused_reason || '已暂停')),
              showCancel: false,
            });
          }
        })
        .catch(() => { this.jobTimer = null; });
    };
    tick();
  },

  pauseJob() {
    const job = this.data.job;
    if (!job) return;
    api.producePause(job.id).then((j) => this.setData({ job: this.shapeJob(j), jobStates: j.episode_states || [] })).catch(() => {});
  },

  resumeJob() {
    const job = this.data.job;
    if (!job) return;
    api.produceResume(job.id).then((j) => {
      this.setData({ job: this.shapeJob(j), jobStates: j.episode_states || [] });
      this.pollJob();
    }).catch(() => {});
  },

  stopJobPolling() {
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }
  },

  // ——— 分发资料包 ———
  preparePack() {
    if (this.data.packBusy) return;
    motion.haptic();
    const platformCode = getApp().globalData.selectedPlatform || null;
    this.setData({ packBusy: 'prepare' });
    wx.showLoading({ title: '打包审核材料…', mask: true });
    api.prepareSubmission(this.data.projectId, {
      episode: `E${String(this.data.produceEp).padStart(2, '0')}`,
      platformCode,
    })
      .then((raw) => {
        wx.hideLoading();
        const pack = packView(raw);
        this.setData({ pack });
        wx.showModal({
          title: pack.ready ? '材料已备齐' : '材料还缺几项',
          content: pack.ready
            ? `共 ${pack.files.length} 个文件，已打成一个压缩包。复制链接到电脑下载，在创作者中心整包上传即可。`
            : pack.missing.map((m) => `· ${m.label}：${m.hint}`).join('\n'),
          confirmText: '复制下载链接',
          cancelText: '稍后',
          success: (r) => {
            if (r.confirm) wx.setClipboardData({ data: api.baseUrl() + pack.zip.url });
          },
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showModal({ title: '打包失败', content: err.message || '请稍后重试', showCancel: false });
      })
      .then(() => this.setData({ packBusy: '' }));
  },

  copyPack() {
    if (!this.data.pack) return;
    wx.setClipboardData({
      data: api.baseUrl() + this.data.pack.zip.url,
      success: () => wx.showToast({ title: '下载链接已复制', icon: 'none' }),
    });
  },

  markUploaded() {
    const pack = this.data.pack;
    if (!pack) return;
    api.markSubmitted(pack.id)
      .then(() => {
        wx.showToast({ title: '已标记提交', icon: 'none' });
        this.reload(false);
      })
      .catch(() => {});
  },

  openFilm(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '成片链接已复制', icon: 'none' }),
    });
  },

  goDistribute() {
    motion.haptic();
    getApp().globalData.selectedProjectId = this.data.projectId;
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  openLegal(e) {
    wx.navigateTo({ url: `/pages/legal/legal?type=${e.currentTarget.dataset.type || 'ai'}` });
  },

  onShareAppMessage() {
    return {
      title: `${this.data.project ? this.data.project.title : '我的网剧'} · 网剧大咖`,
      path: '/pages/index/index',
    };
  },
});
