const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    items: [],
    // 详情弹层
    sheet: false,
    cur: null,
    form: { title: '', logline: '', note: '' },
    busy: '',
    projects: [],
  },

  onLoad(q) {
    motion.enter(this);
    this.projectId = (q && q.projectId) || '';
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api.libraryScripts()
      .then((d) => {
        const items = ((d && d.items) || []).map((x) => ({
          ...x,
          timeText: (x.updated_at || x.created_at || '').slice(5, 16).replace('T', ' '),
          charText: (x.characters || []).slice(0, 4).map((c) => c.name).filter(Boolean).join(' / '),
        }));
        this.setData({ items, loading: false });
      })
      .catch((e) => this.setData({ loading: false, error: (e && e.message) || '加载失败' }));
  },

  openItem(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find((x) => x.id === id);
    if (!item) return;
    motion.haptic();
    wx.showLoading({ title: '读取剧本…', mask: true });
    api.libraryScript(id)
      .then((full) => {
        wx.hideLoading();
        this.setData({
          sheet: true,
          cur: full,
          form: {
            title: (full.outline && full.outline.title) || full.title || '',
            logline: (full.outline && full.outline.logline) || full.logline || '',
            note: full.note || '',
          },
        });
      })
      .catch((err) => {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '读取失败', icon: 'none' });
      });
  },

  closeSheet() {
    this.setData({ sheet: false, cur: null, busy: '' });
  },

  onForm(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ [`form.${k}`]: e.detail.value });
  },

  save() {
    if (!this.data.cur || this.data.busy) return;
    const f = this.data.form;
    if (!String(f.title || '').trim()) {
      wx.showToast({ title: '标题不能为空', icon: 'none' });
      return;
    }
    this.setData({ busy: 'save' });
    api.updateLibraryScript(this.data.cur.id, {
      title: f.title, logline: f.logline, note: f.note,
    })
      .then(() => {
        this.setData({ busy: '' });
        wx.showToast({ title: '已保存', icon: 'none' });
        this.load();
      })
      .catch((e) => {
        this.setData({ busy: '' });
        wx.showToast({ title: (e && e.message) || '保存失败', icon: 'none' });
      });
  },

  /** 把这版剧本套用到某个项目：会重建总谱与资产卡 */
  applyTo() {
    if (!this.data.cur || this.data.busy) return;
    if (!this.projectId) {
      wx.showToast({ title: '从项目页进来才能套用', icon: 'none' });
      return;
    }
    this.setData({ busy: 'apply' });
    api.applyLibraryScript(this.data.cur.id, this.projectId)
      .then((r) => {
        this.setData({ busy: '' });
        const a = (r && r.assets) || {};
        wx.showModal({
          title: '已套用',
          content: `这版剧本已设为当前项目：${a.total || 0} 个资产卡待出图。回到项目页就能出图。`,
          showCancel: false,
          success: () => {
            this.closeSheet();
            if (getCurrentPages().length > 1) wx.navigateBack();
          },
        });
      })
      .catch((e) => {
        this.setData({ busy: '' });
        wx.showToast({ title: (e && e.message) || '套用失败', icon: 'none' });
      });
  },

  remove() {
    const cur = this.data.cur;
    if (!cur || this.data.busy) return;
    wx.showModal({
      title: '从剧本库移除',
      content: `「${cur.title}」会从你的剧本库删掉，项目里已生成的内容不受影响。`,
      confirmText: '移除',
      confirmColor: '#D9480F',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ busy: 'remove' });
        api.removeLibraryScript(cur.id)
          .then(() => {
            this.setData({ busy: '' });
            this.closeSheet();
            this.load();
          })
          .catch((e) => {
            this.setData({ busy: '' });
            wx.showToast({ title: (e && e.message) || '移除失败', icon: 'none' });
          });
      },
    });
  },

  goCreate() {
    motion.haptic();
    wx.switchTab({ url: '/pages/create/create' });
  },
});
