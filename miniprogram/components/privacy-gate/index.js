// 隐私授权弹窗（V4.14）
// 微信只认 `open-type="agreePrivacyAuthorization"` 的按钮来授予隐私授权，
// wx.showModal 的确定按钮是无效的 —— 所以这里必须是真组件、真按钮。
const privacy = require('../../utils/privacy.js');

Component({
  options: {
    // 用全局设计系统的类名（app.wxss），同时保留自身样式
    styleIsolation: 'apply-shared',
    multipleSlots: false,
  },

  data: {
    open: false,
    contractName: '《用户隐私保护指引》',
    busy: false,
  },

  lifetimes: {
    attached() {
      this._detach = privacy.attach(this);
      /**
       * 只缓存合约名，**不主动弹窗**：
       * 首页已经有一份同意入口，这里再自动弹一次会变成两层弹窗。
       * 真正的弹出时机是「用户真的碰了隐私接口」（微信触发 onNeedPrivacyAuthorization）
       * 或调用方显式 privacy.ensure() 之后 —— 那时弹窗才有上下文。
       */
      privacy.check().then((r) => {
        if (r.contractName) this.setData({ contractName: r.contractName });
      });
    },
    detached() {
      if (this._detach) this._detach();
      this._detach = null;
    },
  },

  methods: {
    /** privacy 模块在需要授权时回调这里（微信触发的，不是我们自己猜的） */
    onNeed(payload) {
      this.setData({
        open: true,
        contractName: (payload && payload.contractName) || this.data.contractName,
      });
    },

    /**
     * 同意：先告诉 privacy 模块授予授权（它手里握着微信的 resolve 句柄），
     * 这样原来那个被拦下的接口（选文件 / 选图）会自动继续，用户不用再点一次。
     */
    agree() {
      privacy.resolveAgree();
      this.setData({ open: false, busy: false });
    },

    deny() {
      privacy.resolveDeny();
      this.setData({ open: false });
      wx.showToast({ title: '未同意将无法上传素材', icon: 'none' });
    },

    openContract() {
      if (!privacy.openContract()) {
        wx.navigateTo({ url: '/pages/legal/legal?type=privacy' });
      }
    },

    noop() {},
  },
});
