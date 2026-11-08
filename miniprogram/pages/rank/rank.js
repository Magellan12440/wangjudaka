const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const motion = require('../../utils/motion.js');

const PAGE_SIZE = 50;

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    // 榜单口径（服务端返回，前端不自己写一套文案）
    rules: null,
    snap: null,
    me: null,
    all: [],
    list: [],
    shown: 0,
    total: 0,
    hasMore: false,
    loadingMore: false,
    meText: '',
    gapText: '',
    optedOut: false,
    toggling: false,
    // 每日刷新提示
    refreshText: '',
  },

  onLoad() {
    motion.enter(this);
    this.load(true);
  },

  onShow() {
    motion.enter(this);
    if (!this.data.loading) this.load(false);
  },

  onHide() {
    motion.clear(this);
  },

  onUnload() {
    this.__gone = true;
    motion.clear(this);
  },

  onPullDownRefresh() {
    this.load(false).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.more();
  },

  load(showLoading) {
    if (showLoading) this.setData({ loading: true, error: '' });
    return api.leaderboard()
      .then((d) => {
        const all = (d.list || []).map((it) => ({
          rank: it.rank,
          name: it.name || '匿名创作者',
          avatar: it.avatar || '',
          amount: fmt.fmtMoney(it.total_cny),
          projects: it.project_count || 0,
          platforms: it.platform_count || 0,
          trend: it.trend || 'flat',
          trendText: it.trend === 'up' ? '↑' : it.trend === 'down' ? '↓' : it.trend === 'new' ? 'NEW' : '',
          medal: it.rank === 1 ? 'gold' : it.rank === 2 ? 'silver' : it.rank === 3 ? 'bronze' : '',
          initial: String(it.name || '创').slice(0, 1),
        }));
        const snap = d.snapshot || {};
        const me = d.me || null;
        this.setData({
          loading: false,
          error: '',
          rules: d.rules || null,
          snap,
          me,
          all,
          total: all.length,
          list: all.slice(0, PAGE_SIZE),
          shown: Math.min(all.length, PAGE_SIZE),
          hasMore: all.length > PAGE_SIZE,
          optedOut: me ? me.opt_out === true : false,
          meAmount: fmt.fmtMoney(me ? me.total_cny || 0 : 0),
          meText: this.meTextOf(me),
          gapText: this.gapTextOf(me),
          refreshText: this.refreshTextOf(snap),
        });
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '榜单加载失败' }));
  },

  /** 我的位置：榜内给名次，榜外给「还差多少」——不说"你没上榜"就完了 */
  meTextOf(me) {
    if (!me) return '';
    if (me.rank == null) return me.opt_out ? '你已关闭参与，不在榜单统计范围' : '还没有收益回填记录';
    return me.on_board ? `第 ${me.rank} 名` : `第 ${me.rank} 名（未进前 1000）`;
  },

  gapTextOf(me) {
    if (!me || me.on_board || !me.gap_to_top) return '';
    return `再累计 ¥${fmt.fmtMoney(me.gap_to_top)} 即可进入前 1000`;
  },

  refreshTextOf(snap) {
    if (!snap || !snap.date) return '';
    return `${snap.date} 更新 · 全平台全时间累计 · 每日刷新一次`;
  },

  reload() {
    this.load(true);
  },

  more() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    const shown = this.data.shown + PAGE_SIZE;
    this.setData({
      loadingMore: true,
      list: this.data.all.slice(0, shown),
      shown: Math.min(shown, this.data.all.length),
      hasMore: shown < this.data.all.length,
      loadingMore: false,
    });
  },

  /** 参与开关：默认全员参与，关掉后立即从榜单移除（服务端会当场重建当天快照） */
  toggleJoin() {
    if (this.data.toggling) return;
    const next = !this.data.optedOut;
    const ask = next
      ? { title: '关闭榜单参与', content: '关闭后你的账号与收益不会再出现在公开榜单上，已有的历史名次也一并移除。随时可以再打开。', confirmText: '关闭参与' }
      : { title: '重新参与榜单', content: '打开后按你的累计收益参与排名，下次刷新即可在榜上看到自己。', confirmText: '参与' };
    wx.showModal({
      ...ask,
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ toggling: true });
        api.setLeaderboardParticipation(next)
          .then(() => {
            this.setData({ toggling: false });
            wx.showToast({ title: next ? '已关闭参与' : '已参与榜单', icon: 'none' });
            this.load(false);
          })
          .catch((e) => {
            this.setData({ toggling: false });
            wx.showToast({ title: e.message || '操作失败', icon: 'none' });
          });
      },
    });
  },

  goRevenue() {
    wx.navigateTo({ url: '/pages/revenue/revenue' });
  },

  goDistribute() {
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  showRules() {
    const r = this.data.rules;
    if (!r) return;
    wx.showModal({
      title: r.title || '排行榜规则',
      content: `${r.description || ''}\n\n${(r.notes || []).join('\n')}`,
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
