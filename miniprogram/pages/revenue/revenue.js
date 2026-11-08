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
    exporting: false,
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

  /** 排行榜（V4.16）：所有人可见，全平台全时间累计 */
  goRank() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/rank/rank' });
  },

  goDistribute() {
    motion.haptic();
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  goRecharge() {
    motion.haptic();
    // 充值是独立页（弹层在安卓上会被支付系统弹窗盖住）
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  /**
   * 导出对账单。
   * 小程序里没有「下载文件到电脑」这条路（csv 也打不开），
   * 所以走复制到剪贴板——用户粘进 Excel / WPS 就能直接对账。
   */
  exportBill() {
    if (this.data.exporting) return;
    motion.haptic();
    this.setData({ exporting: true });
    api.revenueExport()
      .then((r) => {
        this.setData({ exporting: false });
        if (!r.rows) {
          wx.showModal({ title: '这个月还没回填', content: r.note, showCancel: false });
          return;
        }
        wx.setClipboardData({
          data: r.csv,
          success: () => wx.showModal({
            title: `已复制 ${r.rows} 条`,
            content: `${r.filename}（合计 ¥${r.total}）已复制到剪贴板，粘贴到 Excel / WPS 即可对账。${r.note}`,
            showCancel: false,
          }),
        });
      })
      .catch((e) => {
        this.setData({ exporting: false });
        wx.showToast({ title: e.message || '导出失败', icon: 'none' });
      });
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
