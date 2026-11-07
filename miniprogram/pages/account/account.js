// 账号与额度：把「我是谁 / 安全 / 额度 / 隐私」四件事收在一页。
// 设计原则：只展示用户能理解的信息，内部口径（扣点倍率、结算方式）不上前台。
const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');
const accounts = require('../../utils/accounts.js');

const RESEND_SEC = 60;

// 余额提醒阈值选项：0 = 关闭
const ALERT_OPTIONS = [
  { value: 0, label: '关闭提醒' },
  { value: 10, label: '低于 10 点' },
  { value: 20, label: '低于 20 点' },
  { value: 50, label: '低于 50 点' },
  { value: 100, label: '低于 100 点' },
  { value: 200, label: '低于 200 点' },
];

const pad2 = (n) => String(n).padStart(2, '0');

const timeText = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',
    busy: false,

    user: {},
    uidText: '',
    initial: '创',
    security: {},
    balance: { points: 0 },
    balanceCny: '0.00',
    quota: { today: 0, week: 0, month: 0, avg_per_episode: 0 },
    runsLeft: 0,
    sessions: [],
    // 本机账号簿（可一键切换）
    accounts: [],

    alertOptions: ALERT_OPTIONS.map((o) => o.label),
    alertIndex: 0,
    alertLabel: '低于 20 点',

    sheet: '',
    countdown: 0,
    devCode: '',
    smsNote: '',
    formError: '',

    phone: '',
    code: '',
    oldPwd: '',
    newPwd: '',
    newPwd2: '',
    closePwd: '',
    closeConfirm: '',
  },

  onLoad() {
    motion.enter(this);
  },

  onShow() {
    this.load();
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ error: '' });
    return api.accountOverview()
      .then((d) => this.apply(d))
      .catch((e) => {
        const code = e && e.code;
        const msg = code === 'UNAUTHORIZED' || code === 'AUTH_TOKEN_INVALID'
          ? '登录状态已失效，请重新登录'
          : e.message || '加载失败，请稍后重试';
        this.setData({ loading: false, error: msg });
      });
  },

  apply(d) {
    const user = (d && d.user) || {};
    const balance = (d && d.balance) || { points: 0 };
    const quota = (d && d.quota) || { today: 0, week: 0, month: 0, avg_per_episode: 0 };
    const sessions = ((d && d.sessions) || []).map((s) => Object.assign({}, s, {
      timeText: timeText(s.last_seen_at || s.created_at),
    }));

    const idx = ALERT_OPTIONS.findIndex((o) => Number(o.value) === Number(quota.alert_threshold));
    const alertIndex = idx >= 0 ? idx : 2;

    const cnyPerPoint = (d && d.balance && d.balance.cny_per_point) || 0.01;
    const avg = Number(quota.avg_per_episode) || 0;
    const runsLeft = avg > 0 ? Math.floor(Number(balance.points || 0) / avg) : 0;

    const nickname = user.nickname || '创作者';

    this.setData({
      loading: false,
      error: '',
      user,
      uidText: user.id ? String(user.id).slice(-8).toUpperCase() : '—',
      initial: String(nickname).slice(0, 1),
      security: (d && d.security) || {},
      balance,
      balanceCny: (Number(balance.points || 0) * cnyPerPoint).toFixed(2),
      quota,
      runsLeft: runsLeft > 999 ? '999+' : runsLeft,
      sessions,
      accounts: getApp().accountList(),
      alertIndex,
      alertLabel: ALERT_OPTIONS[alertIndex].label,
    });

    const app = getApp();
    if (app && app.globalData) {
      app.globalData.balance = balance.points;
      app.globalData.lowBalanceAlert = Number(quota.alert_threshold) || 0;
    }
  },

  /* —— 额度提醒 —— */
  onAlertChange(e) {
    const idx = Number(e.detail.value);
    const opt = ALERT_OPTIONS[idx];
    if (!opt) return;
    this.setData({ alertIndex: idx, alertLabel: opt.label });
    api.setAlert(opt.value)
      .then(() => {
        const app = getApp();
        if (app && app.globalData) app.globalData.lowBalanceAlert = opt.value;
        wx.showToast({ title: opt.value ? '已设置提醒' : '已关闭提醒', icon: 'none' });
      })
      .catch((err) => wx.showToast({ title: err.message || '设置失败', icon: 'none' }));
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  /** 充值 / 兑换统一进独立充值页 */
  goRecharge() {
    motion.haptic();
    wx.navigateTo({ url: '/pages/recharge/recharge' });
  },

  /** 兑换码在「我的」页里（弹层） */
  goRedeem() {
    motion.haptic();
    wx.switchTab({ url: '/pages/mine/mine' });
    wx.showToast({ title: '点「兑换码」输入', icon: 'none' });
  },

  /* —— 切换账号 —— */
  switchAccount(e) {
    const userId = e.currentTarget.dataset.id;
    if (!userId || userId === this.data.user.id) return;
    const app = getApp();
    const row = (this.data.accounts || []).find((a) => a.userId === userId);
    if (row && row.expired) {
      this.needRelogin(row);
      return;
    }
    motion.haptic();
    wx.showLoading({ title: '切换中…', mask: true });
    app.switchAccount(userId)
      .then(() => {
        wx.hideLoading();
        wx.showToast({ title: `已切换到 ${(row && row.nickname) || '新账号'}`, icon: 'none' });
        this.load();
        // 首页与「我的」都缓存了上个账号的数据，切回去重进一次最干净
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
      })
      .catch((err) => {
        wx.hideLoading();
        if (err && err.code === 'NEED_LOGIN') this.needRelogin(row);
        else wx.showToast({ title: (err && err.message) || '切换失败，请重试', icon: 'none' });
      });
  },

  /** token 已失效（改密/退出全部设备）：引导重新登录这个账号 */
  needRelogin(row) {
    wx.showModal({
      title: '需要重新登录',
      content: `${(row && row.nickname) || '这个账号'}的登录状态已失效（可能改过密码，或在这台设备退出过）。重新登录后即可切过去。`,
      confirmText: '去登录',
      success: (r) => {
        if (!r.confirm) return;
        getApp().toLogin({ add: true });
      },
    });
  },

  addAccount() {
    motion.haptic();
    getApp().toLogin({ add: true });
  },

  /** 长按移除一个已保存的账号（不动服务端会话，只是不再列出来） */
  removeAccount(e) {
    const userId = e.currentTarget.dataset.id;
    const row = (this.data.accounts || []).find((a) => a.userId === userId);
    if (!row) return;
    if (row.current) {
      wx.showToast({ title: '当前正在用的账号不能移除', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '移除账号',
      content: `从这台设备的账号列表里移除「${row.nickname}」？下次要用需要重新登录。`,
      confirmText: '移除',
      success: (r) => {
        if (!r.confirm) return;
        accounts.remove(userId);
        this.setData({ accounts: getApp().accountList() });
      },
    });
  },

  /* —— 弹层 —— */
  openPhone() {
    motion.haptic();
    const phone = this.data.security.phone_masked ? '' : '';
    this.setData({ sheet: 'phone', formError: '', phone, code: '', devCode: '' });
  },

  openPassword() {
    motion.haptic();
    this.setData({ sheet: 'pwd', formError: '', oldPwd: '', newPwd: '', newPwd2: '' });
  },

  openDevices() {
    motion.haptic();
    this.setData({ sheet: 'devices' });
  },

  openClose() {
    motion.haptic();
    this.setData({ sheet: 'close', formError: '', closePwd: '', closeConfirm: '' });
  },

  openLegal(e) {
    const type = e.currentTarget.dataset.type;
    wx.navigateTo({ url: `/pages/legal/legal?type=${type}` });
  },

  closeSheet() {
    if (this.data.busy) return;
    this.setData({ sheet: '', formError: '', devCode: '' });
  },

  noop() {},

  onInput(e) {
    const key = e.currentTarget.dataset.key;
    let v = e.detail.value;
    if (key === 'phone' || key === 'code') v = String(v || '').replace(/\D/g, '');
    if (key === 'phone') v = v.slice(0, 11);
    if (key === 'code') v = v.slice(0, 6);
    this.setData({ [key]: v, formError: '' });
  },

  /* —— 绑定手机 —— */
  sendCode() {
    const phone = this.data.phone;
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      this.setData({ formError: '请输入正确的 11 位手机号' });
      return;
    }
    if (this.data.countdown > 0) return;
    api.sendSms(phone)
      .then((d) => {
        const ok = d.sent || d.dev_code;
        this.setData({
          countdown: ok ? RESEND_SEC : 0,
          devCode: d.dev_code || '',
          smsNote: ok ? '' : (d.note || '验证码服务暂未开通，请改用微信登录或密码登录'),
        });
        if (ok) this.tick();
        if (d.sent) wx.showToast({ title: '验证码已发送', icon: 'none' });
      })
      .catch((err) => this.setData({ formError: err.message || '发送失败' }));
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

  bindPhone() {
    const { phone, code } = this.data;
    if (!/^1[3-9]\d{9}$/.test(phone)) return this.setData({ formError: '请输入正确的 11 位手机号' });
    if (!/^\d{4,6}$/.test(code)) return this.setData({ formError: '请输入验证码' });
    this.setData({ busy: true, formError: '' });
    api.bindPhone(phone, code)
      .then(() => {
        this.setData({ busy: false, sheet: '' });
        wx.showToast({ title: '绑定成功', icon: 'success' });
        this.load();
      })
      .catch((err) => this.setData({ busy: false, formError: err.message || '绑定失败' }));
  },

  /* —— 密码 —— */
  savePassword() {
    const { oldPwd, newPwd, newPwd2, security } = this.data;
    if (!newPwd || newPwd.length < 6) return this.setData({ formError: '新密码至少 6 位' });
    if (newPwd.length > 64) return this.setData({ formError: '新密码最多 64 位' });
    if (newPwd !== newPwd2) return this.setData({ formError: '两次输入的新密码不一致' });
    if (security.pwd_set && !oldPwd) return this.setData({ formError: '请输入当前密码' });
    this.setData({ busy: true, formError: '' });
    api.changePassword(security.pwd_set ? oldPwd : null, newPwd)
      .then(() => {
        this.setData({ busy: false, sheet: '', oldPwd: '', newPwd: '', newPwd2: '' });
        wx.showToast({ title: security.pwd_set ? '密码已更新' : '密码已设置', icon: 'success' });
        this.load();
      })
      .catch((err) => this.setData({ busy: false, formError: err.message || '保存失败' }));
  },

  /* —— 设备 —— */
  revokeSession(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.showModal({
      title: '让这台设备下线？',
      content: '该设备需要重新登录才能继续使用。',
      confirmText: '下线',
      confirmColor: '#D8453C',
      success: (r) => {
        if (!r.confirm) return;
        api.revokeSession(id)
          .then(() => {
            wx.showToast({ title: '已下线', icon: 'none' });
            this.load();
          })
          .catch((err) => wx.showToast({ title: err.message || '操作失败', icon: 'none' }));
      },
    });
  },

  logoutAll() {
    wx.showModal({
      title: '退出全部设备？',
      content: '包括当前这台。之后需要用微信或手机号重新登录。',
      confirmText: '全部退出',
      confirmColor: '#D8453C',
      success: (r) => {
        if (!r.confirm) return;
        api.logoutAll()
          .then(() => {
            const app = getApp();
            if (app && app.logout) app.logout();
            wx.reLaunch({ url: '/pages/login/login' });
          })
          .catch((err) => wx.showToast({ title: err.message || '操作失败', icon: 'none' }));
      },
    });
  },

  /* —— 注销 —— */
  doClose() {
    const { closePwd, closeConfirm, security } = this.data;
    if (String(closeConfirm).trim() !== '注销') {
      return this.setData({ formError: '请输入「注销」两个字以确认' });
    }
    if (security.pwd_set && !closePwd) {
      return this.setData({ formError: '请输入登录密码' });
    }
    wx.showModal({
      title: '最后确认',
      content: '注销后立即无法登录，30 天后数据不可恢复。确定继续？',
      confirmText: '确定注销',
      confirmColor: '#D8453C',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true, formError: '' });
        api.closeAccount({
          confirmText: String(closeConfirm).trim(),
          password: closePwd || undefined,
        })
          .then(() => {
            this.setData({ busy: false, sheet: '' });
            const app = getApp();
            if (app && app.logout) app.logout();
            wx.reLaunch({ url: '/pages/login/login' });
          })
          .catch((err) => this.setData({ busy: false, formError: err.message || '注销失败' }));
      },
    });
  },
});
