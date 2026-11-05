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
    version: config.version,
    supportEmail: config.supportEmail,
    cnyPerPoint: 1,
    payText: '请选择档次',
    showRecharge: true,
    loading: true,
    // 我的资产：逐集成片
    films: [],
    filmCount: 0,
    // 资料完善
    profileComplete: false,
    // 充值活动
    campaign: null,
  },

  onShow() {
    const app = getApp();
    motion.enter(this);
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
    });
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
          // 未配置虚拟支付商户号时，是否允许用 mock 发货把流程走通（上线前应关闭）
          showRecharge: d.pay_mode === 'live' || config.mockRecharge !== false,
          cnyPerPoint: d.cny_per_point || 1,
          campaign: d.campaign || null,
          selectedId: this.data.selectedId || (list[0] && list[0].id) || '',
        }, () => this.refreshPayText());
      })
      .catch(() => {});
  },

  /** 虚拟支付未开通时的占位说明，避免出现「能点但付不了」的入口 */
  rechargeSoon() {
    wx.showModal({
      title: '充值即将开放',
      content: '平台正在接入微信虚拟支付，开通后即可在线充值。当前可通过兑换码获取点数，或在「意见反馈」留下联系方式。',
      confirmText: '去兑换',
      cancelText: '知道了',
      success: (r) => {
        if (r.confirm) this.openRedeem();
      },
    });
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

  openRecharge() {
    if (!this.data.showRecharge) return this.rechargeSoon();
    this.setData({ sheet: 'recharge' });
  },

  closeSheet() {
    this.setData({ sheet: '' });
  },

  noop() {},

  selectPackage(e) {
    this.setData({ selectedId: e.currentTarget.dataset.id }, () => this.refreshPayText());
  },

  refreshPayText() {
    const p = this.data.packages.find((x) => x.id === this.data.selectedId);
    this.setData({ payText: p ? `微信支付 ¥${p.priceCny}` : '请选择档次' });
  },

  /** 全终端使用微信官方虚拟支付；未配置商户号时显式走联调发货 */
  pay() {
    const pkg = this.data.packages.find((p) => p.id === this.data.selectedId);
    if (!pkg || this.data.paying) return;
    this.setData({ paying: true });
    api.createPayOrder(pkg.id)
      .then((order) => {
        if (order.mode === 'mock') {
          return api.mockPaySuccess(order.order_id).then((r) => {
            this.afterPaid(r.balance);
            wx.showToast({ title: `联调到账 ${order.points} 点`, icon: 'none' });
          });
        }
        return new Promise((resolve, reject) => {
          if (!wx.requestVirtualPayment) {
            wx.showToast({ title: '当前微信版本不支持虚拟支付，请升级', icon: 'none' });
            reject(new Error('unsupported'));
            return;
          }
          const p = order.requestVirtualPayment;
          wx.requestVirtualPayment({
            signData: p.signData,
            paySig: p.paySig,
            signature: p.signature,
            mode: p.mode,
            zoneId: p.zoneId,
            success: () => {
              // 发货以微信回调为准，这里主动查一次余额兜底
              setTimeout(() => {
                this.syncUser().then(() => {
                  this.loadEntries();
                  wx.showToast({ title: '充值成功', icon: 'none' });
                  resolve();
                });
              }, 1200);
            },
            fail: (err) => {
              if (err && err.errMsg && !/cancel/.test(err.errMsg)) {
                wx.showToast({ title: '支付未完成', icon: 'none' });
              }
              reject(err);
            },
          });
        });
      })
      .then(() => this.loadPackages())
      .catch(() => {})
      .then(() => this.setData({ paying: false }));
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
    this.__gone = true;
    motion.clear(this);
  },

  onShareAppMessage() {
    return { title: '网剧大咖 · 一句话，开一部网剧', path: '/pages/index/index' };
  },
});
