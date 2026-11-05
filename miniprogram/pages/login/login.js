const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

const RESEND_SEC = 60;

Page({
  data: {
    pageAnim: false,
    mode: 'wechat', // wechat | code | password
    phone: '',
    code: '',
    password: '',
    agree: true,
    sending: false,
    countdown: 0,
    devCode: '',
    devNote: '',
    busy: false,
    focusField: '',
    error: '',
  },

  onLoad(query) {
    motion.enter(this);
    // 从「我的」被踢出来时带上回跳目标
    this.redirect = query && query.redirect ? decodeURIComponent(query.redirect) : '';
    const app = getApp();
    if (app && app.globalData && app.globalData.userId) {
      // 已登录就没必要停在这一页
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    motion.haptic();
    this.setData({ mode, error: '' });
  },

  onPhone(e) {
    this.setData({ phone: String(e.detail.value || '').replace(/\D/g, '').slice(0, 11), error: '' });
  },
  onCode(e) {
    this.setData({ code: String(e.detail.value || '').replace(/\D/g, '').slice(0, 6), error: '' });
  },
  onPassword(e) {
    this.setData({ password: e.detail.value || '', error: '' });
  },
  onFocus(e) {
    this.setData({ focusField: e.currentTarget.dataset.field });
  },
  onBlur() {
    this.setData({ focusField: '' });
  },
  toggleAgree() {
    motion.haptic();
    this.setData({ agree: !this.data.agree });
  },
  openLegal(e) {
    const type = e.currentTarget.dataset.type || 'terms';
    wx.navigateTo({ url: `/pages/legal/legal?type=${type}` });
  },

  /** 微信一键登录（沿用 app 里的 wx.login 链路，不重复实现） */
  wechatLogin() {
    if (!this.checkAgree()) return;
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    motion.haptic();
    const app = getApp();
    app.login()
      .then(() => {
        const ok = app.globalData && app.globalData.userId;
        this.setData({ busy: false });
        if (!ok) {
          this.setData({ error: '微信登录失败，请改用手机号登录' });
          return;
        }
        this.done();
      })
      .catch(() => this.setData({ busy: false, error: '微信登录失败，请改用手机号登录' }));
  },

  sendCode() {
    const phone = this.data.phone;
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      this.setData({ error: '请输入正确的 11 位手机号' });
      return;
    }
    if (this.data.countdown > 0 || this.data.sending) return;
    this.setData({ sending: true, error: '' });
    api.sendSms(phone)
      .then((d) => {
        this.setData({
          sending: false,
          countdown: d.sent || d.dev_code ? RESEND_SEC : 0,
          // 后端未接短信服务商时会明确返回 dev 码，照实展示；线上则只会说明「暂未接入」
          devCode: d.dev_code || '',
          devNote: d.sent ? '' : d.note || '未配置短信服务',
          error: d.sent || d.dev_code ? '' : (d.note || '暂不可用'),
        });
        if (d.sent || d.dev_code) this.tick();
        if (d.sent) wx.showToast({ title: '验证码已发送', icon: 'none' });
      })
      .catch((e) => this.setData({ sending: false, error: e.message || '发送失败' }));
  },

  tick() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const n = this.data.countdown - 1;
      if (n <= 0) {
        clearInterval(this.timer);
        this.timer = null;
        this.setData({ countdown: 0 });
        return;
      }
      this.setData({ countdown: n });
    }, 1000);
  },

  loginByCode() {
    if (!this.checkAgree()) return;
    const { phone, code } = this.data;
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ error: '请输入正确的 11 位手机号' });
    if (!/^\d{6}$/.test(code)) return this.setData({ error: '请输入 6 位验证码' });
    this.submit(api.loginByCode(phone, code));
  },

  loginByPassword() {
    if (!this.checkAgree()) return;
    const { phone, password } = this.data;
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ error: '请输入正确的 11 位手机号' });
    if (password.length < 6) return this.setData({ error: '密码至少 6 位' });
    this.submit(api.loginByPassword(phone, password));
  },

  submit(promise) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    motion.haptic();
    promise
      .then((d) => {
        const app = getApp();
        app.globalData.token = d.token;
        wx.setStorageSync('token', d.token);
        app.applyUser(d);
        this.setData({ busy: false });
        this.done();
      })
      .catch((e) => this.setData({ busy: false, error: e.message || '登录失败' }));
  },

  done() {
    wx.showToast({ title: '登录成功', icon: 'none' });
    if (this.redirect) {
      const tab = ['/pages/index/index', '/pages/create/create', '/pages/distribute/distribute', '/pages/mine/mine'];
      if (tab.some((t) => this.redirect.startsWith(t))) wx.switchTab({ url: this.redirect });
      else wx.redirectTo({ url: this.redirect });
      return;
    }
    setTimeout(() => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: '/pages/mine/mine' });
    }, 300);
  },

  checkAgree() {
    if (this.data.agree) return true;
    this.setData({ error: '请先阅读并同意用户协议与隐私政策' });
    return false;
  },
});
