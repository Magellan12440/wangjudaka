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

    // 注册 / 找回密码
    sheet: '',
    regPhone: '',
    regCode: '',
    regPwd: '',
    regName: '',
    regCountdown: 0,
    regBusy: false,
    regError: '',
    regNote: '',
    regDevCode: '',
    fgPhone: '',
    fgCode: '',
    fgPwd: '',
    fgCountdown: 0,
    fgBusy: false,
    fgError: '',
    fgNote: '',
    fgDevCode: '',
  },

  onLoad(query) {
    motion.enter(this);
    // 从「我的」被踢出来时带上回跳目标
    this.redirect = query && query.redirect ? decodeURIComponent(query.redirect) : '';
    // 「切换账号 → 添加另一个账号」：已经登录着也不能被弹回首页
    this.addMode = !!(query && query.mode === 'add');
    if (query && query.phone) {
      try { this.setData({ phone: decodeURIComponent(query.phone) }); } catch (e) { /* ignore */ }
    }
    const app = getApp();
    if (!this.addMode && app && app.globalData && app.globalData.userId) {
      // 已登录就没必要停在这一页
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
    for (const k of ['cd_regCountdown', 'cd_fgCountdown']) {
      if (this[k]) { clearInterval(this[k]); this[k] = null; }
    }
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
        const unusable = !d.sent && !d.dev_code;
        this.setData({
          sending: false,
          countdown: d.sent || d.dev_code ? RESEND_SEC : 0,
          // 后端未接短信服务商时会明确返回 dev 码，照实展示；线上则只说明「暂未接入」。
          // 这类「能力未开通」不是报错，别用红字吓人，单独一行提示该走哪条路。
          devCode: d.dev_code || '',
          devNote: d.sent ? '' : d.note || '未配置短信服务',
          smsNote: unusable ? '验证码登录暂未开通，请用上面的「微信一键登录」，或改用手机号 + 密码登录' : '',
          error: '',
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
    wx.showToast({ title: this.addMode ? '已添加并切换' : '登录成功', icon: 'none' });
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

  // —— 注册 / 找回密码 ——
  openRegister() {
    motion.haptic();
    this.setData({
      sheet: 'register', regError: '', regNote: '', regDevCode: '',
      regPhone: this.data.phone || '', regCode: '', regPwd: '', regName: '',
    });
  },

  openForgot() {
    motion.haptic();
    this.setData({
      sheet: 'forgot', fgError: '', fgNote: '', fgDevCode: '',
      fgPhone: this.data.phone || '', fgCode: '', fgPwd: '',
    });
  },

  closeSheet() {
    this.setData({ sheet: '' });
  },

  noop() {},

  onRegInput(e) {
    const key = e.currentTarget.dataset.key;
    let v = e.detail.value || '';
    if (key === 'regPhone' || key === 'fgPhone') v = v.replace(/\D/g, '').slice(0, 11);
    if (key === 'regCode' || key === 'fgCode') v = v.replace(/\D/g, '').slice(0, 6);
    this.setData({ [key]: v });
  },

  /** 验证码倒计时：两个弹层各记一份，避免互相干扰 */
  startCd(key) {
    if (this['cd_' + key]) clearInterval(this['cd_' + key]);
    this.setData({ [key]: RESEND_SEC });
    this['cd_' + key] = setInterval(() => {
      const n = (this.data[key] || 0) - 1;
      if (n <= 0) {
        clearInterval(this['cd_' + key]);
        this['cd_' + key] = null;
        this.setData({ [key]: 0 });
        return;
      }
      this.setData({ [key]: n });
    }, 1000);
  },

  sendCodeTo(phone, cdKey, noteKey, devKey, errKey) {
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ [errKey]: '请输入正确的 11 位手机号' });
    if (this.data[cdKey] > 0) return;
    api.sendSms(phone)
      .then((d) => {
        const ok = d.sent || d.dev_code;
        this.setData({
          [devKey]: d.dev_code || '',
          [noteKey]: ok ? '' : (d.note || '验证码服务暂未开通，可先设密码，稍后在账号页验证手机号'),
          [errKey]: '',
        });
        if (ok) this.startCd(cdKey);
        if (d.sent) wx.showToast({ title: '验证码已发送', icon: 'none' });
      })
      .catch((err) => this.setData({ [errKey]: err.message || '发送失败' }));
  },

  sendRegCode() {
    this.sendCodeTo(this.data.regPhone, 'regCountdown', 'regNote', 'regDevCode', 'regError');
  },

  sendFgCode() {
    this.sendCodeTo(this.data.fgPhone, 'fgCountdown', 'fgNote', 'fgDevCode', 'fgError');
  },

  doRegister() {
    if (!this.checkAgree()) return;
    const { regPhone, regCode, regPwd, regName } = this.data;
    if (!/^1[3-9]\d{9}$/.test(regPhone)) return this.setData({ regError: '请输入正确的 11 位手机号' });
    if (!regPwd || regPwd.length < 6) return this.setData({ regError: '密码至少 6 位' });
    if (regPwd.length > 64) return this.setData({ regError: '密码最多 64 位' });
    if (this.data.regBusy) return;
    this.setData({ regBusy: true, regError: '' });
    motion.haptic();
    api.register({ phone: regPhone, password: regPwd, code: regCode || null, nickname: regName || null })
      .then((d) => {
        this.setData({ regBusy: false, sheet: '' });
        const app = getApp();
        app.globalData.token = d.token;
        wx.setStorageSync('token', d.token);
        app.applyUser(d);
        this.done();
      })
      .catch((e) => this.setData({ regBusy: false, regError: e.message || '创建失败' }));
  },

  doReset() {
    const { fgPhone, fgCode, fgPwd } = this.data;
    if (!/^1[3-9]\d{9}$/.test(fgPhone)) return this.setData({ fgError: '请输入正确的 11 位手机号' });
    if (!/^\d{4,6}$/.test(fgCode)) return this.setData({ fgError: '请输入验证码' });
    if (!fgPwd || fgPwd.length < 6) return this.setData({ fgError: '新密码至少 6 位' });
    if (this.data.fgBusy) return;
    this.setData({ fgBusy: true, fgError: '' });
    api.resetPassword(fgPhone, fgCode, fgPwd)
      .then(() => {
        this.setData({ fgBusy: false, sheet: '', phone: fgPhone, password: fgPwd, mode: 'password' });
        wx.showToast({ title: '密码已重置，请登录', icon: 'none' });
      })
      .catch((e) => this.setData({ fgBusy: false, fgError: e.message || '重置失败' }));
  },

  checkAgree() {
    if (this.data.agree) return true;
    this.setData({ error: '请先阅读并同意用户协议与隐私政策' });
    return false;
  },
});
