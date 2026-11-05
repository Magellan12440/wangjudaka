const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const motion = require('../../utils/motion.js');

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    code: '',
    reward: 1,
    requireMilestone: true,
    stats: { total: 0, pending: 0, qualified: 0, rewarded: 0, rejected: 0, points_earned: 0 },
    bRewarded: 0,
    bPending: 0,
    bPoints: 0,
    items: [],
    rules: [],
    bindCode: '',
    binding: false,
    showBind: false,
  },

  onLoad() {
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

  load(showLoading) {
    const app = getApp();
    if (showLoading) this.setData({ loading: true, error: '' });
    return app.ready()
      .then(() => {
        if (!app.globalData.userId) throw new Error('登录未完成，请下拉重试');
        return api.inviteMe(app.globalData.userId);
      })
      .then((d) => {
        this.setData({
          loading: false,
          code: d.invite_code || '',
          reward: d.reward_points || 1,
          requireMilestone: d.require_milestone !== false,
          stats: d.stats || this.data.stats,
          items: (d.items || []).map((x) => ({
            id: x.id,
            name: x.name,
            char: String(x.name || '创').slice(0, 1),
            statusText: x.status_text,
            points: x.points,
            cls: x.status === 'rewarded' ? 'pill-green' : x.status === 'rejected' ? 'pill-gray' : 'pill-gold',
            timeText: fmt.timeAgo(x.created_at),
          })),
          rules: d.rules || [],
        });
        const st = d.stats || {};
        motion.countUp(this, 'bRewarded', st.rewarded || 0, { duration: 620 });
        motion.countUp(this, 'bPending', st.pending || 0, { duration: 620 });
        motion.countUp(this, 'bPoints', st.points_earned || 0, { duration: 760 });
      })
      .catch((e) => this.setData({ loading: false, error: e.message || '加载失败' }));
  },

  copyCode() {
    if (!this.data.code) return;
    wx.setClipboardData({
      data: this.data.code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
    });
  },

  toggleBind() {
    this.setData({ showBind: !this.data.showBind });
  },

  onBindInput(e) {
    this.setData({ bindCode: e.detail.value });
  },

  submitBind() {
    const code = (this.data.bindCode || '').trim().toUpperCase();
    if (code.length < 4) {
      wx.showToast({ title: '请输入完整邀请码', icon: 'none' });
      return;
    }
    if (this.data.binding) return;
    this.setData({ binding: true });
    const app = getApp();
    api.inviteBind({ code, deviceId: app.deviceId(), userId: app.globalData.userId })
      .then((r) => {
        wx.showModal({
          title: r.ok ? '绑定成功' : '绑定未通过',
          content: r.message || (r.ok ? '好友完成首部作品后奖励自动到账' : '该邀请码不可用'),
          showCancel: false,
        });
        if (r.ok) this.setData({ showBind: false, bindCode: '' });
        this.load(false);
      })
      .catch(() => {})
      .then(() => this.setData({ binding: false }));
  },

  goCreate() {
    wx.switchTab({ url: '/pages/create/create' });
  },

  openLegal() {
    wx.navigateTo({ url: '/pages/legal/legal?type=terms' });
  },

  onShareAppMessage() {
    const code = this.data.code;
    return {
      title: '网剧大咖 · 一句话开一部网剧，送你创作灵感',
      path: `/pages/index/index${code ? `?inviteCode=${code}` : ''}`,
    };
  },
});
