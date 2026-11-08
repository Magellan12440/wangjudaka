const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    projectId: '',
    ov: null,
    consistency: null,
    // 库选择弹层
    sheet: false,
    sheetKind: '',
    sheetName: '',
    sheetHint: '',
    sheetCode: '',
    options: [],
    busy: '',

    rules: [
      '情绪 / 转场 / 运镜 / 节奏四库，在任何生成前都必须有可解析的卡；缺一张就不出图',
      '你不选的时候由导演按剧情与风格自动挑；你选了就按你的来，并写进决策记录',
      '人工改写分镜会同步回导演总谱，全片始终只有一份事实',
      '五维一致性（角色 / 道具 / 场景 / 内容 / 声音字幕）是底层规则，任一维不过不出图、不交付',
    ],
  },

  onLoad(q) {
    motion.enter(this);
    this.setData({ projectId: (q && q.id) || '', pageAnim: true });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    const id = this.data.projectId;
    if (!id) {
      this.setData({ loading: false, error: '缺少项目编号' });
      return Promise.resolve();
    }
    this.setData({ loading: true, error: '' });
    return Promise.all([api.director(id), api.consistency(id).catch(() => null)])
      .then(([ov, consistency]) => {
        const dims = (consistency && consistency.dimensions) || [];
        this.setData({
          loading: false,
          ov: this.shape(ov),
          consistency: consistency
            ? {
              kpi: consistency.kpi || null,
              empty: Boolean(consistency.empty),
              dims: dims.map((d) => ({
                ...d,
                mark: d.ok ? '✓' : '✕',
                desc: d.ok ? '全片通过' : `${d.failed}/${d.total} 镜需要修`,
                sample: d.issues && d.issues[0]
                  ? `${d.issues[0].shot_no}：${(d.issues[0].issues && d.issues[0].issues[0] && d.issues[0].issues[0].text) || ''}`
                  : '',
              })),
            }
            : null,
        });
      })
      .catch((e) => this.setData({ loading: false, error: (e && e.message) || '加载失败' }));
  },

  shape(ov) {
    if (!ov) return null;
    return {
      ...ov,
      chain: (ov.chain || []).map((c) => ({
        ...c,
        statusText: !c.gate.ok ? '闸门未通过' : c.done ? '已完成' : '待执行',
        statusCls: !c.gate.ok ? 'pill-red' : c.done ? 'pill-green' : 'pill-gray',
        libText: (c.libs || []).map((l) => l.label).join(' · '),
        issueText: (c.gate.issues || []).join('；'),
      })),
      log: (ov.log || []).map((x) => ({
        ...x,
        timeText: String(x.at || '').slice(5, 16).replace('T', ' '),
        text: (x.decisions || []).join('；') || x.action,
      })),
    };
  },

  openLib(e) {
    const kind = e.currentTarget.dataset.kind;
    const lib = ((this.data.ov && this.data.ov.core_libs) || []).find((x) => x.kind === kind);
    if (!lib) return;
    motion.haptic();
    this.setData({
      sheet: true,
      sheetKind: kind,
      sheetName: lib.name,
      sheetHint: lib.hint,
      sheetCode: lib.mode === 'pinned' ? lib.code : '',
      options: (lib.options || []).map((o) => ({
        ...o,
        on: o.code === lib.code,
      })),
    });
  },

  closeLib() {
    this.setData({ sheet: false });
  },

  chooseOption(e) {
    const code = e.currentTarget.dataset.code;
    const kind = this.data.sheetKind;
    if (this.data.busy) return;
    motion.haptic();
    this.setData({ busy: kind });
    api.directorPolicy(this.data.projectId, { libs: { [kind]: { mode: 'pinned', code } } })
      .then(() => {
        this.setData({ busy: '', sheet: false });
        wx.showToast({ title: '已按你选的走', icon: 'none' });
        return this.load();
      })
      .catch((err) => {
        this.setData({ busy: '' });
        wx.showModal({ title: '没选上', content: (err && err.message) || '稍后再试', showCancel: false });
      });
  },

  useAuto(e) {
    const kind = e.currentTarget.dataset.kind || this.data.sheetKind;
    if (this.data.busy) return;
    motion.haptic();
    this.setData({ busy: kind });
    api.directorPolicy(this.data.projectId, { libs: { [kind]: { mode: 'auto' } } })
      .then(() => {
        this.setData({ busy: '', sheet: false });
        wx.showToast({ title: '交回导演自动选', icon: 'none' });
        return this.load();
      })
      .catch((err) => {
        this.setData({ busy: '' });
        wx.showModal({ title: '操作失败', content: (err && err.message) || '稍后再试', showCancel: false });
      });
  },

  resetAll() {
    wx.showModal({
      title: '全部交回导演？',
      content: '四库会恢复自动选择。强制规则仍然生效：每一环该用库照旧要用。',
      success: (r) => {
        if (!r.confirm) return;
        api.directorPolicyReset(this.data.projectId)
          .then(() => {
            wx.showToast({ title: '已恢复自动', icon: 'none' });
            return this.load();
          })
          .catch((err) => wx.showModal({ title: '操作失败', content: (err && err.message) || '稍后再试', showCancel: false }));
      },
    });
  },

  /** 回项目页继续做（这一步该点哪里，项目页的进度条会告诉用户） */
  goProject() {
    motion.haptic();
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: `/pages/project/project?id=${encodeURIComponent(this.data.projectId)}` });
  },

  noop() {},
});
