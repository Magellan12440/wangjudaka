// 网剧大咖 · 小程序入口
// 启动即走真实登录链路：wx.login → 后端 code2session → 自签 token。
// 未配置微信 AppID 时服务端自动降级 mock 登录（同一 code 幂等同一用户），本地联调不受影响。
const api = require('./utils/api.js');
const config = require('./config.js');

App({
  globalData: {
    baseUrl: config.baseUrl,
    env: config.env,
    brand: config.brand,
    token: '',
    userId: '',
    balance: 0,
    loginMode: '',
    user: null,
    statusBarHeight: 20,
    navBarHeight: 64,
    // 跨 tab 传参：首页输入的剧名、分发页选中的项目与平台
    draftTitle: '',
    draftPrompt: '',
    // V4.7：多项目 —— 任何「新建」入口置 true，创作页 onShow 见到就复位成空表单
    startNew: false,
    selectedProjectId: '',
    selectedPlatform: '',
    profileComplete: false,
    // 裂变：分享链接带进来的邀请码（首次登录时提交给服务端判定有效性）
    pendingInviteCode: '',
  },

  onLaunch(options) {
    this.initWindow();
    this.warnPlaceholderHost();
    this.captureInviteCode(options);
    this.selfCheck();
    this.readyPromise = this.bootstrap();
  },

  /**
   * 启动自检：先打一次 /health。
   * 连不上时给出「具体是哪一类问题 + 连的是哪个域名」，而不是让页面一直转圈。
   * 只在首次失败时弹窗（storage 记账），避免每次冷启动都打扰。
   */
  selfCheck() {
    if (typeof wx === 'undefined' || !wx.request) return;
    api.netDiag().then((r) => {
      this.globalData.netDiag = r;
      if (r.ok) {
        try { wx.removeStorageSync('netfail_notified'); } catch (e) { /* ignore */ }
        return;
      }
      let notified = '';
      try { notified = wx.getStorageSync('netfail_notified') || ''; } catch (e) { /* ignore */ }
      if (notified === r.baseUrl) return;
      try { wx.setStorageSync('netfail_notified', r.baseUrl); } catch (e) { /* ignore */ }
      wx.showModal({
        title: '连不上后端',
        content: `原因：${r.reason}\n地址：${r.baseUrl}\n\n`
          + '如果是「域名未加入 request 合法域名」：小程序后台 → 开发管理 → 开发设置 → 服务器域名，'
          + '把上面这个 https 域名加进 request 合法域名，再重新编译/重进小程序。',
        showCancel: false,
        confirmText: '知道了',
      });
    });
  },

  /** 体验版/线上版仍指向占位域名时明确提示：否则真机上只表现为「一直转圈」 */
  warnPlaceholderHost() {
    const host = String(config.baseUrl || '');
    if (config.env === 'develop' || host.indexOf('api.wangjudaka.com') === -1) return;
    wx.showModal({
      title: '后端地址未配置',
      content: `当前是${config.env === 'trial' ? '体验版' : '线上版'}，但后端仍为占位域名。`
        + `请把 config.js 里 hosts.${config.env} 改成已备案的 https 域名，`
        + '并在小程序后台「开发管理 → 服务器域名」加入该域名，然后重新上传。',
      showCancel: false,
      confirmText: '知道了',
    });
  },

  onShow(options) {
    // 冷启动后再从分享卡片进入（小程序已在后台）也要接住邀请码
    this.captureInviteCode(options);
  },

  /** 从分享参数里取邀请码：支持 ?inviteCode=XXX 与 ?invite=XXX */
  captureInviteCode(options) {
    let q = (options && options.query) || {};
    if (!q.inviteCode && !q.invite && wx.getEnterOptionsSync) {
      try { q = wx.getEnterOptionsSync().query || q; } catch (e) { /* ignore */ }
    }
    const code = String(q.inviteCode || q.invite || '').trim().toUpperCase();
    if (code) this.globalData.pendingInviteCode = code.slice(0, 12);
  },

  /** 设备标识（仅本地生成的随机串，用于识别同设备刷邀请，不采集硬件信息） */
  deviceId() {
    let id = wx.getStorageSync('device_id');
    if (!id) {
      id = `d_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      wx.setStorageSync('device_id', id);
    }
    return id;
  },

  /** 计算自定义导航栏高度（首页用 custom navigation） */
  initWindow() {
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.globalData.statusBarHeight = info.statusBarHeight || 20;
    } catch (e) {
      this.globalData.statusBarHeight = 20;
    }
    let nav = 44;
    try {
      const menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.top && menu.height) {
        nav = (menu.top - this.globalData.statusBarHeight) * 2 + menu.height;
      }
    } catch (e) { /* 开发者工具早期可能拿不到胶囊信息，用默认值 */ }
    this.globalData.navBarHeight = Math.max(44, nav);
  },

  /** 所有页面统一等待登录完成，避免首屏拿到空 userId */
  ready() {
    return this.readyPromise || Promise.resolve(this.globalData);
  },

  bootstrap() {
    const token = wx.getStorageSync('token');
    if (!token) return this.login();
    this.globalData.token = token;
    return api.me()
      .then((d) => this.applyUser(d))
      .catch(() => this.login());
  },

  /** 清掉旧 token 并重新登录；失败也不阻塞页面（页面会显示访客态） */
  login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = new Promise((resolve) => {
      wx.login({
        success: (r) => {
          if (!r.code) return resolve(this.globalData);
          api.login({
            code: r.code,
            inviteCode: this.globalData.pendingInviteCode || undefined,
            deviceId: this.deviceId(),
          })
            .then((d) => {
              this.globalData.token = d.token;
              wx.setStorageSync('token', d.token);
              if (d.invite) this.globalData.inviteResult = d.invite;
              resolve(this.applyUser(d));
            })
            .catch(() => resolve(this.globalData));
        },
        fail: () => resolve(this.globalData),
      });
    }).then((d) => {
      this.loginPromise = null;
      return d;
    });
    return this.loginPromise;
  },

  applyUser(d) {
    if (!d || !d.user) return this.globalData;
    this.globalData.user = d.user;
    this.globalData.userId = d.user.id;
    this.globalData.balance = d.user.balance_points || 0;
    this.globalData.profileComplete = !!d.user.profile_complete;
    this.globalData.loginMode = d.mode || '';
    return this.globalData;
  },

  refreshBalance() {
    return api.me()
      .then((d) => {
        this.applyUser(d);
        return this.globalData.balance;
      })
      .catch(() => this.globalData.balance);
  },

  /** 统一处理登录失效：清 token 后重登一次 */
  relogin() {
    try { wx.removeStorageSync('token'); } catch (e) { /* ignore */ }
    this.globalData.token = '';
    return this.login();
  },
});
