const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    total: 0,
    settled: 0,
    pending: 0,
    published: 0,
    bars: [],
    platforms: [],
    projects: [],
    note: '',
  },

  onLoad() {
    motion.enter(this);
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    return api.revenue()
      .then((d) => {
        // 柱状图高度按最大值归一化，纯 CSS 撑起来（不引图表库）
        const monthly = d.monthly || [];
        const max = Math.max(1, ...monthly.map((m) => m.amount));
        const bars = monthly.map((m) => ({
          month: m.month.slice(5),
          amount: m.amount,
          h: Math.max(6, Math.round((m.amount / max) * 140)),
        }));
        this.setData({
          loading: false,
          error: '',
          total: d.total || 0,
          settled: d.settled || 0,
          pending: d.pending || 0,
          published: d.published_count || 0,
          bars,
          platforms: d.platforms || [],
          projects: d.projects || [],
          note: d.note || '',
        });
        motion.countUp(this, 'totalView', d.total || 0, { duration: 700 });
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  goDistribute() {
    motion.haptic();
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  openProject(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/project/project?id=${encodeURIComponent(id)}` });
  },
});
