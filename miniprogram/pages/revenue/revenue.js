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
    // 额度预警（后端只给「偏低了」，不预测还能出几集）
    quota: null,
    // 待回填（已上线但收益为 0）
    unfilled: [],
    // 批量回填抽屉
    fillOpen: false,
    fillRows: [],
    fillPeriod: '',
    submitting: false,
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
        const unfilled = d.unfilled || [];
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
          quota: d.quota || null,
          unfilled,
          fillRows: unfilled.map((u) => ({
            distribution_id: u.distribution_id,
            platform_name: u.platform_name,
            title: u.title,
            amount: '',
            settle: '待结算',
          })),
        });
        motion.countUp(this, 'totalView', d.total || 0, { duration: 700 });
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  goDistribute() {
    motion.haptic();
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  goRecharge() {
    motion.haptic();
    // 充值是「我的」页里的弹层，不是独立页
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  openProject(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/project/project?id=${encodeURIComponent(id)}` });
  },

  // —— 批量回填 ——
  openFill() {
    if (!this.data.unfilled.length) {
      wx.showToast({ title: '没有待回填的记录', icon: 'none' });
      return;
    }
    motion.haptic();
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    this.setData({ fillOpen: true, fillPeriod: period });
  },

  closeFill() {
    this.setData({ fillOpen: false });
  },

  noop() {},

  onAmount(e) {
    const i = Number(e.currentTarget.dataset.i);
    const rows = this.data.fillRows;
    rows[i].amount = e.detail.value;
    this.setData({ fillRows: rows });
  },

  pickSettle(e) {
    const i = Number(e.currentTarget.dataset.i);
    const v = e.currentTarget.dataset.v;
    const rows = this.data.fillRows;
    rows[i].settle = v;
    this.setData({ fillRows: rows });
  },

  submitFill() {
    if (this.data.submitting) return;
    // 只提交填了有效金额的行；0 视为「确实没收益」，也允许（用于把脏数据改成 0）
    const items = this.data.fillRows
      .filter((r) => String(r.amount).trim() !== '')
      .map((r) => ({
        distribution_id: r.distribution_id,
        amount: Number(r.amount),
        settlement_status: r.settle,
      }));

    if (!items.length) {
      wx.showToast({ title: '还没有填金额', icon: 'none' });
      return;
    }
    const bad = items.find((x) => !Number.isFinite(x.amount) || x.amount < 0);
    if (bad) {
      wx.showToast({ title: '金额只能填不小于 0 的数字', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    api.revenueBatch({ period: this.data.fillPeriod, items })
      .then((r) => {
        this.setData({ submitting: false, fillOpen: false });
        wx.showToast({ title: `已回填 ${r.written} 条`, icon: 'success' });
        motion.haptic();
        this.load();
      })
      .catch((e) => {
        this.setData({ submitting: false });
        wx.showToast({ title: e.message || '回填失败', icon: 'none' });
      });
  },
});
