// 充值页（V4.9.1）
//
// 为什么从「我的」里的弹层改成独立页面：
//  1) 弹层叠在 tab 页上，页面一刷新/切 tab 就没了，点到一半的订单容易丢；
//  2) 安卓上虚拟支付的系统弹窗会盖住半屏 sheet，用户以为「点了没反应」；
//  3) 独立页能放下订单记录、自定义金额、说明文案，不用挤在 62vh 里。
// 现在所有「充值」入口（余额卡、档位卡、收益页、余额不足提示、账号页）都指到这里。
const api = require('../../utils/api.js');
const motion = require('../../utils/motion.js');

const ORDER_STATUS = {
  pending: { text: '待支付', cls: 'wait' },
  paid: { text: '已到账', cls: 'ok' },
  cancelled: { text: '已取消', cls: 'off' },
  refunded: { text: '已退款', cls: 'off' },
};

const money = (n) => (Number(n) || 0).toFixed(2).replace(/\.00$/, '');

Page({
  data: {
    pageAnim: false,
    loading: true,
    error: '',

    balance: 0,
    cnyPerPoint: 1,
    runsLeft: 0,

    packages: [],
    selectedId: '',
    custom: '',
    customPoints: 0,

    payMode: 'mock',
    payMissing: [],
    live: false,
    paying: false,
    payAmount: '0',
    payText: '选一个档位，或填金额',

    orders: [],
    campaign: null,

    // 充完之后大概能干什么，给用户一个参照（用真实平均消耗算，不编数字）
    usageHints: [],
  },

  onLoad(query) {
    motion.enter(this);
    if (query && query.id) this.presetId = decodeURIComponent(query.id);
    this.load();
  },

  onShow() {
    // 从支付返回时会再次触发：余额可能已经变了
    if (!this.data.loading) this.syncBalance();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ error: '' });
    return Promise.all([
      api.rechargePackages().catch(() => null),
      api.me().catch(() => null),
      api.payOrders().catch(() => []),
      // 接入体检（V4.14）：没打通时告诉运营「还差哪几步」，而不是只在日志里报错
      api.payStatus().catch(() => null),
    ]).then(([pkgRes, me, orderRes, paySt]) => {
      const pk = (pkgRes && pkgRes.packages) || [];
      const packages = pk.map((p) => ({
        id: p.id,
        name: p.name || '',
        points: Number(p.points) || 0,
        bonus: Number(p.bonus) || 0,
        total: (Number(p.points) || 0) + (Number(p.bonus) || 0),
        priceCny: Number(p.priceCny) || 0,
        priceText: money(p.priceCny),
        tag: p.bonus ? `赠 ${p.bonus}` : '',
      }));
      const balance = (me && me.user && Number(me.user.balance_points)) || 0;
      const cnyPerPoint = (pkgRes && Number(pkgRes.cny_per_point)) || 1;
      const payMode = (pkgRes && pkgRes.pay_mode) || 'mock';
      const payMissing = (paySt && paySt.items ? paySt.items.filter((x) => !x.done) : [])
        .map((x) => ({ key: x.key, label: x.label, todo: x.todo }));
      const orders = (Array.isArray(orderRes) ? orderRes : ((orderRes && orderRes.items) || [])).slice(0, 12).map((o) => {
        const st = ORDER_STATUS[o.status] || { text: o.status || '—', cls: 'off' };
        return {
          id: o.id,
          points: Number(o.points) || 0,
          amountText: money(o.amount_cny),
          statusText: st.text,
          statusCls: st.cls,
          timeText: String(o.paid_at || o.created_at || '').slice(0, 16).replace('T', ' '),
          canPay: o.status === 'pending',
        };
      });

      let selectedId = this.data.selectedId;
      const want = this.presetId || selectedId;
      if (want && packages.some((p) => p.id === want)) selectedId = want;
      else if (!selectedId && packages.length) selectedId = packages[0].id;

      this.setData({
        loading: false,
        error: pkgRes ? '' : '档位没加载出来，下拉可重试',
        packages,
        balance,
        cnyPerPoint,
        payMode,
        payMissing,
        live: payMode === 'live',
        orders,
        campaign: (pkgRes && pkgRes.campaign) || null,
        selectedId,
      }, () => {
        this.refreshSelection();
        this.buildHints(balance, cnyPerPoint);
      });
      return null;
    });
  },

  syncBalance() {
    api.me().then((d) => {
      const b = Number((d && d.user && d.user.balance_points) || 0);
      this.setData({ balance: b });
    }).catch(() => {});
  },

  /** 用「余额 + 一次生成平均多少钱」估算还能跑几次：比写死文案可信 */
  buildHints(balance, cnyPerPoint) {
    api.accountQuota().then((q) => {
      const avg = Number((q && q.avg_per_episode) || 0);
      const hints = [];
      if (avg > 0) {
        hints.push(`你最近一次生成平均消耗 ${avg} 点，当前余额约可再跑 ${Math.max(0, Math.floor(balance / avg))} 次`);
      }
      hints.push(`1 点 = ¥${cnyPerPoint}，生成失败会全额退回`);
      this.setData({ usageHints: hints });
    }).catch(() => {
      this.setData({ usageHints: [`1 点 = ¥${cnyPerPoint}，生成失败会全额退回`] });
    });
  },

  pickPackage(e) {
    const id = e.currentTarget.dataset.id;
    motion.haptic();
    this.setData({ selectedId: id, custom: '', customPoints: 0 });
    this.refreshSelection();
  },

  onCustom(e) {
    const v = String(e.detail.value || '').replace(/[^\d.]/g, '');
    const amt = Number(v) || 0;
    const rate = this.data.cnyPerPoint || 1;
    this.setData({
      custom: v,
      customPoints: Math.floor(amt / rate),
      selectedId: v ? '' : this.data.selectedId,
    }, () => this.refreshSelection());
  },

  clearCustom() {
    this.setData({ custom: '', customPoints: 0, selectedId: (this.data.packages[0] || {}).id || '' },
      () => this.refreshSelection());
  },

  refreshSelection() {
    const p = this.data.packages.find((x) => x.id === this.data.selectedId);
    if (p) {
      this.setData({ payAmount: p.priceText, payText: `${p.total} 点到账${p.bonus ? `（含赠 ${p.bonus}）` : ''}` });
      return;
    }
    if (this.data.customPoints > 0) {
      this.setData({ payAmount: String(this.data.custom), payText: `${this.data.customPoints} 点到账` });
      return;
    }
    this.setData({ payAmount: '0', payText: '选一个档位，或填金额' });
  },

  /** 下单 + 支付。mock 通道（未配商户号）直接发货，真实通道走 wx.requestVirtualPayment */
  pay() {
    if (this.data.paying) return;
    const pkg = this.data.packages.find((p) => p.id === this.data.selectedId);
    const amount = Number(this.data.custom) || 0;
    if (!pkg && !(amount > 0)) {
      wx.showToast({ title: '先选一个档位或填金额', icon: 'none' });
      return;
    }
    motion.haptic();
    this.setData({ paying: true });
    const payload = pkg ? { packageId: pkg.id } : { amountCny: amount };
    api.createPayOrder(payload)
      .then((order) => {
        if (!order) throw new Error('下单失败');
        if (order.mode === 'mock') {
          // 未配置虚拟支付商户号时的联调通道：不扣真钱，点数立即到账
          return api.mockPaySuccess(order.order_id).then((r) => {
            const b = (r && r.balance);
            wx.showModal({
              title: '点数已到账',
              content: `本次到账 ${order.points} 点${typeof b === 'number' ? `，当前余额 ${b} 点` : ''}。\n\n`
                + '（当前是内测支付通道：不产生真实扣款。正式收款需在后台配置微信虚拟支付商户号后自动切换。）',
              showCancel: false,
              confirmText: '知道了',
            });
            return this.load();
          });
        }
        if (!wx.requestVirtualPayment) {
          throw Object.assign(new Error('当前微信版本不支持虚拟支付，请升级微信后再试'), { code: 'UNSUPPORTED' });
        }
        const p = order.requestVirtualPayment || {};
        return new Promise((resolve, reject) => {
          wx.requestVirtualPayment({
            signData: p.signData,
            paySig: p.paySig,
            signature: p.signature,
            // mode：微短剧道具直购 = short_series_goods；env：0 正式 / 1 沙箱（必须与 signData 内一致）
            mode: p.mode,
            env: p.env,
            zoneId: p.zoneId,
            success: () => {
              /**
               * success 只代表"用户在微信里付完了"，点数要等微信的**发货回调**才入账（V4.14）。
               * 旧实现死等 1.5 秒就刷新，回调慢一点就会出现"钱付了、点数没到"的假象。
               * 现在按订单号轮询，最多约 12 秒；仍未到账就如实告诉用户去哪看。
               */
              this.pollPaid(order.order_id, order.points)
                .then((r) => {
                  if (r && r.paid) {
                    wx.showToast({ title: `支付成功，${order.points} 点到账`, icon: 'none' });
                  } else {
                    wx.showModal({
                      title: '钱已付，点数还在路上',
                      content: `微信的到账通知还没到（订单 ${order.order_id}）。\n\n`
                        + '通常 1 分钟内到账；若一直没到，请把订单号发给客服核对，不会重复扣款。',
                      showCancel: false,
                      confirmText: '知道了',
                    });
                  }
                  this.load();
                  resolve();
                })
                .catch(() => {
                  this.load();
                  resolve();
                });
            },
            fail: (err) => {
              const msg = String((err && err.errMsg) || '');
              if (!/cancel/i.test(msg)) wx.showToast({ title: '支付未完成，可重新发起', icon: 'none' });
              reject(Object.assign(new Error(msg || '支付取消'), { code: 'PAY_CANCEL' }));
            },
          });
        });
      })
      .catch((e) => {
        if (e && e.code === 'PAY_CANCEL') return;
        wx.showToast({ title: (e && e.message) || '下单失败，请重试', icon: 'none' });
      })
      .then(() => this.setData({ paying: false }));
  },

  /**
   * 轮询订单是否已到账（V4.14）。
   * 发货由微信回调驱动，回调延迟不可控，所以只轮询本地订单状态，不猜时间。
   * @param {string} orderId
   * @param {number} points
   * @param {number} tries 次数 × 1.5s
   */
  pollPaid(orderId, points, tries = 8) {
    const once = (left) => api.payQuery(orderId).then((r) => {
      if (r && r.paid) return r;
      if (left <= 1) return r || { paid: false };
      return new Promise((resolve) => setTimeout(resolve, 1500)).then(() => once(left - 1));
    });
    return once(Math.max(1, tries));
  },

  /** 待支付订单重新拉起支付（走后端同一订单，避免重复下单） */
  payAgain(e) {
    const id = e.currentTarget.dataset.id;
    const o = this.data.orders.find((x) => x.id === id);
    if (!o || !o.canPay) {
      wx.showToast({ title: '这单不用再付了', icon: 'none' });
      return;
    }
    if (this.data.payMode === 'mock') {
      api.mockPaySuccess(id).then(() => {
        wx.showToast({ title: '已到账', icon: 'none' });
        this.load();
      }).catch(() => {});
      return;
    }
    // 真实通道：让用户按同样金额重新下单（微信侧同 outTradeNo 不能重复支付）
    const again = this.data.packages.find((p) => Math.abs(p.priceCny - Number(o.amountText)) < 0.01);
    wx.showModal({
      title: '重新支付',
      content: `上一笔 ¥${o.amountText} 未完成。重新支付会生成一笔新订单，金额与点数相同。`,
      confirmText: '重新支付',
      success: (r) => {
        if (!r.confirm) return;
        if (again) this.setData({ selectedId: again.id, custom: '' }, () => this.pay());
        else this.setData({ selectedId: '', custom: o.amountText }, () => this.pay());
      },
    });
  },

  openRedeem() {
    motion.haptic();
    wx.switchTab({ url: '/pages/mine/mine' });
    wx.showToast({ title: '在「我的」里点兑换码', icon: 'none' });
  },

  contact() {
    wx.showModal({
      title: '需要更大额度？',
      content: '工作室 / MCN 批量采购可以走对公转账，按档位另议赠送比例。请在小程序「我的 → 关于」里复制客服邮箱联系我们。',
      showCancel: false,
      confirmText: '知道了',
    });
  },
});
