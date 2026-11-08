const api = require('../../utils/api.js');
const fmt = require('../../utils/format.js');
const config = require('../../config.js');
const motion = require('../../utils/motion.js');

const ENTRY_LABEL = {
  recharge: '充值',
  hold: '生成预扣',
  settle: '生成结算',
  refund: '失败退款',
  redeem: '兑换码',
  grant: '活动赠送',
  adjust: '人工调整',
};

Page({
  data: {
    pageAnim: false,
    userId: '',
    nickname: '',
    initial: '创',
    balanceShow: 0,
    avatar: '',
    balance: 0,
    loginMode: '',
    payMode: '',
    uidText: '',
    packages: [],
    selectedId: '',
    sheet: '',
    entries: [],
    redeems: [],
    redeemCode: '',
    redeeming: false,
    paying: false,
    // 网络自检（排查「网络异常」用）
    netText: '检测 ›',
    netOk: null,
    netBusy: false,
    version: config.version,
    supportEmail: config.supportEmail,
    cnyPerPoint: 1,
    payText: '请选择档次',
    showRecharge: true,
    loading: true,
    // 我的资产：逐集成片
    films: [],
    filmCount: 0,
    // 账号资产总账（V4.15）：跨项目，只读，证明"东西都还在"
    ledger: null,
    // 资料完善
    profileComplete: false,
    // 充值活动
    campaign: null,
    // 账号安全（V4.4）
    hasPhone: false,
    phoneMasked: '',
    hasPassword: false,
    secTab: 'phone',
    secPhone: '',
    secCode: '',
    secPwd: '',
    secPwd2: '',
    secCountdown: 0,
    secBusy: false,
    secDevCode: '',
    secError: '',
    // 收益看板（V4.4）
    revenueTotal: 0,
    // 收益排行榜（V4.16）：卡片上只放名次，点进去看全榜
    rankText: '—',
    // 管理后台（V4.7）：只看服务端给的 is_admin，不在本地猜
    isAdmin: false,
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
    // 没有登录态时先把人送到登录页，而不是留一个「创作者」的假头像
    if (!app.globalData.userId) {
      wx.navigateTo({ url: '/pages/login/login?redirect=' + encodeURIComponent('/pages/mine/mine') });
      return;
    }
    this.setData({
      balance: app.globalData.balance || 0,
      balanceShow: app.globalData.balance || 0,
      loginMode: app.globalData.loginMode || '',
    });
    app.ready().then(() => {
      this.syncUser();
      this.loadEntries();
      this.loadPackages();
      this.loadRedeems();
      this.loadFilms();
      this.loadRevenue();
      this.loadRank();
      this.loadAccountAssets();
    });
  },

  /** 收益看板入口：先取一个总额做卡片，点进去看明细 */
  loadRevenue() {
    api.revenue()
      .then((d) => this.setData({ revenueTotal: (d && d.total) || 0 }))
      .catch(() => { /* 看板失败不影响我的页 */ });
  },

  openRevenue() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/revenue/revenue' });
  },

  /** 排行榜入口：只取自己的名次做卡片（榜单本身在那页里看） */
  loadRank() {
    api.leaderboard()
      .then((d) => {
        const me = d && d.me;
        const n = me && me.rank;
        this.setData({ rankText: n ? `第 ${n} 名` : '未上榜' });
      })
      .catch(() => { /* 榜单失败不影响我的页 */ });
  },

  openRank() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/rank/rank' });
  },

  /** 管理后台（V4.7）：入口只对管理员渲染，进来后服务端还会再校验一次角色 */
  goAdmin() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/admin/admin' });
  },

  /** 网络自检：同时探公网与内网两条通道，告诉用户哪条能用 */
  runNetDiag() {
    if (this.data.netBusy) return;
    motion.haptic();
    this.setData({ netBusy: true, netText: '检测中…' });
    api.netDiag().then((r) => {
      const ok = r.ok;
      this.setData({
        netBusy: false,
        netOk: ok,
        netText: ok ? `正常 · ${r.channel} · v${r.version || '?'}` : '失败 · 两条通道都不通',
      });
      const line = (n, x) => `${n}：${x.ok ? `通（${x.ms}ms）` : `不通 — ${x.reason || '未知'}`}`;
      wx.showModal({
        title: ok ? `后端连通（走${r.channel}通道）` : '后端连不上',
        content: `${line('公网', r.http)}\n${line('内网', r.container)}\n`
          + (ok ? `\n版本：${r.version || '未知'}\n算力：${r.relay || '未知'}`
            : '\n公网要通，需在小程序后台把域名加进 request 合法域名；'
              + '内网要通，需基础库 ≥2.23.1 且云开发已开通。'),
        showCancel: false,
        confirmText: '知道了',
      });
    });
  },

  // 账号与额度统一到独立页面：手机号、密码、登录设备、额度、注销都在那里
  goAccount() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/account/account' });
  },

  /** 我的资产：所有已出成片（跨项目逐集汇总，方便一键分发） */
  loadFilms() {
    api.myFilms()
      .then((r) => {
        const items = (r && r.items) || (Array.isArray(r) ? r : []);
        const films = items.map((f) => ({
          id: f.id,
          projectId: f.project_id,
          projectTitle: f.project_title,
          indexLabel: f.index_label || '',
          ep: f.episode || 'E01',
          url: f.url,
          srtUrl: f.srt_url || '',
          durationText: f.duration_sec ? fmt.fmtDuration(f.duration_sec) : '',
          res: f.resolution || '',
          timeText: fmt.timeAgo(f.created_at),
        }));
        this.setData({ films, filmCount: films.length });
      })
      .catch(() => {});
  },

  /**
   * 账号资产总账（V4.15）。
   *
   * 这不是"管理"入口，是"对账"入口：用户能看到自己名下到底有多少角色卡、
   * 素材、生成记录、剧本，而且这些数字只增不减——不提供任何清理按钮。
   */
  loadAccountAssets() {
    api.accountAssets()
      .then((d) => this.setData({ ledger: d || null }))
      .catch(() => { /* 总账失败不影响主流程 */ });
  },

  copyFilm(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '成片链接已复制', icon: 'none' }),
    });
  },

  goDistribute(e) {
    const id = e.currentTarget.dataset.id;
    if (id) getApp().globalData.selectedProjectId = id;
    wx.switchTab({ url: '/pages/distribute/distribute' });
  },

  /** 完善资料：昵称（微信昵称不能静默获取，只能让用户自己填） */
  editProfile() {
    const app = getApp();
    wx.showModal({
      title: '设置昵称',
      editable: true,
      placeholderText: this.data.nickname || '取个笔名',
      confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return;
        const nickname = String(r.content || '').trim().slice(0, 20);
        if (!nickname) {
          wx.showToast({ title: '昵称不能为空', icon: 'none' });
          return;
        }
        api.updateProfile({ nickname })
          .then((d) => {
            if (d && d.user) app.applyUser({ user: d.user, mode: this.data.loginMode });
            this.setData({ nickname, initial: nickname.slice(0, 1), profileComplete: true });
            app.globalData.profileComplete = true;
            wx.showToast({ title: '已保存', icon: 'none' });
          })
          .catch(() => {});
      },
    });
  },

  syncUser() {
    const app = getApp();
    return api.me()
      .then((d) => {
        app.applyUser(d);
        const name = d.user.nickname || '创作者';
        this.setData({
          loading: false,
          userId: d.user.id,
          nickname: name,
          initial: name.slice(0, 1),
          avatar: d.user.avatar || '',
          balance: d.user.balance_points || 0,
          loginMode: d.mode || '',
          uidText: fmt.shortId(d.user.id),
          profileComplete: !!d.user.profile_complete,
          hasPhone: !!d.user.has_phone,
          phoneMasked: d.user.phone_masked || '',
          hasPassword: !!d.user.pwd_set,
          isAdmin: d.user.is_admin === true || d.user.role === 'admin',
        });
        motion.countUp(this, 'balanceShow', d.user.balance_points || 0, { duration: 700 });
      })
      .catch(() => {
        this.setData({
          loading: false,
          userId: app.globalData.userId,
          nickname: '创作者',
          initial: '创',
          balanceShow: app.globalData.balance || 0,
          uidText: fmt.shortId(app.globalData.userId),
        });
      });
  },

  loadPackages() {
    api.rechargePackages()
      .then((d) => {
        const list = (d.packages || []).map((p) => ({
          ...p,
          total: (p.points || 0) + (p.bonus || 0),
          tag: p.bonus ? `赠 ${p.bonus}` : '',
        }));
        this.setData({
          packages: list,
          payMode: d.pay_mode || '',
          showRecharge: d.pay_mode === 'live' || config.mockRecharge !== false,
          cnyPerPoint: d.cny_per_point || 1,
          campaign: d.campaign || null,
          selectedId: this.data.selectedId || (list[0] && list[0].id) || '',
        });
      })
      .catch(() => {});
  },

  loadEntries() {
    const app = getApp();
    if (!app.globalData.userId) return;
    api.entries(app.globalData.userId)
      .then((list) => {
        const entries = (Array.isArray(list) ? list : []).slice(0, 30).map((e) => ({
          id: e.id,
          title: e.channel === 'redeem_code' ? '兑换码入账' : (ENTRY_LABEL[e.type] || e.type),
          sub: `${fmt.timeAgo(e.created_at)} · 余额 ${e.after_points ?? '—'}`,
          points: e.points || 0,
          pointsText: `${e.points > 0 ? '+' : ''}${e.points || 0}`,
          positive: (e.points || 0) > 0,
        }));
        this.setData({ entries });
      })
      .catch(() => {});
  },

  loadRedeems() {
    const app = getApp();
    if (!app.globalData.userId) return;
    api.myRedeems(app.globalData.userId)
      .then((d) => this.setData({ redeems: (d && d.items) || [] }))
      .catch(() => {});
  },

  /** 充值：统一走独立页（弹层在安卓上会被支付系统弹窗盖住，切页还会丢） */
  openRecharge() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  /** 点某个档位：直接带着这一档进充值页，少一次选择 */
  openPackage(e) {
    const id = e.currentTarget.dataset.id;
    motion.haptic();
    wx.navigateTo({ url: '/pages/recharge/recharge' + (id ? '?id=' + encodeURIComponent(id) : '') });
  },

  closeSheet() {
    this.setData({ sheet: '' });
  },

  noop() {},

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录才能继续做剧，本地草稿不会丢失。',
      confirmText: '退出',
      success: (r) => {
        if (!r.confirm) return;
        try { wx.removeStorageSync('token'); } catch (e) { /* ignore */ }
        const app = getApp();
        app.globalData.userId = '';
        app.globalData.user = null;
        app.globalData.token = '';
        this.setData({ sheet: '' });
        wx.reLaunch({ url: '/pages/login/login' });
      },
    });
  },

  afterPaid(balance) {
    const app = getApp();
    if (typeof balance === 'number') {
      app.globalData.balance = balance;
      motion.clear(this);
      this.setData({ balance, balanceShow: balance });
    } else {
      app.refreshBalance();
    }
    this.syncUser();
    this.loadEntries();
  },

  openRedeem() {
    this.setData({ sheet: 'redeem' });
  },

  openInvite() {
    wx.navigateTo({ url: '/pages/invite/invite' });
  },

  /** 我的剧本库：选定过的剧本都在这，可改可套用 */
  openScripts() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/scripts/scripts' });
  },

  onRedeemInput(e) {
    this.setData({ redeemCode: e.detail.value });
  },

  redeem() {
    const code = (this.data.redeemCode || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'none' });
      return;
    }
    if (this.data.redeeming) return;
    this.setData({ redeeming: true });
    api.redeem(code, this.data.userId)
      .then((r) => {
        this.afterPaid(typeof r.balance === 'number' ? r.balance : undefined);
        wx.showModal({
          title: '兑换成功',
          content: `到账 ${r.credited} 点${r.bonus ? `（含赠送 ${r.bonus} 点）` : ''}，当前余额 ${r.balance} 点`,
          showCancel: false,
        });
        this.setData({ redeemCode: '', sheet: '' });
        this.loadRedeems();
      })
      .catch(() => {})
      .then(() => this.setData({ redeeming: false }));
  },

  openAbout() {
    this.setData({ sheet: 'about' });
  },

  copySupport() {
    wx.setClipboardData({
      data: this.data.supportEmail,
      success: () => wx.showToast({ title: '邮箱已复制', icon: 'none' }),
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  openLegal(e) {
    wx.navigateTo({ url: `/pages/legal/legal?type=${e.currentTarget.dataset.type || 'terms'}` });
  },

  onHide() {
    motion.clear(this);
  },

  onUnload() {
    if (this.secTimer) clearInterval(this.secTimer);
    this.__gone = true;
    motion.clear(this);
  },

  onShareAppMessage() {
    return { title: '网剧大咖 · 一句话，开一部网剧', path: '/pages/index/index' };
  },
});
