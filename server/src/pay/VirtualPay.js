/**
 * 微信虚拟支付通道（V3.5）。
 *
 * 背景：iOS 微信小程序禁止虚拟商品走微信支付/第三方支付，必须走微信官方
 * 「虚拟支付」（米大师），Android 可自选。本模块统一两端的下单与发货：
 *
 *  1. createOrder：本地建单（pending）→ 已配置商户号则返回 wx.requestVirtualPayment
 *     所需签名参数；未配置则 mode:'mock'，用 mockPaySuccess 联调发货。
 *  2. handleNotify：微信发货回调 → 验签 → 订单置 paid → Ledger.recharge（幂等键=微信订单号）。
 *  3. 状态机：pending → paid / cancelled / refunded；paid 不可逆。
 *
 * 红线：发货只认「验签通过的回调」或「mock 模式显式联调动作」；
 * 任何 HTTP 参数都不能直接让订单变 paid。
 */
import { config } from '../config/env.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { ledger } from '../ledger/Ledger.js';
import wechatClient from '../wechat/WechatClient.js';
import adminService from '../admin/AdminService.js';

const ORDERS = 'pay_orders';

class VirtualPay {
  /**
   * 点数包：V3.6 起以管理员后台档次为唯一事实源（含赠送福利），
   * 集合为空时自动播种默认三档（幂等）。金额单位：元。
   */
  packages() {
    adminService.seedDefaultPackages();
    return adminService.publicPackages();
  }

  /**
   * 创建充值订单。
   * @param {object} p
   *   packageId：档位 id；不传时用 amountCny 走「自定义金额」（1 点 = cnyPerPoint 元，无赠送）
   * @returns 返回 wx.requestVirtualPayment 参数；mock 模式返回联调说明。
   */
  createOrder({ userId, packageId = null, amountCny = null, sessionKey = null, platform = 'android' }) {
    if (!userId) fail(ERR.AUTH_REQUIRED, '请先登录');
    // session_key 由登录时落库，调用方不必也不应该自己传（它是服务端机密）
    const user = db.findOne('users', (u) => u.id === userId);
    const sk = sessionKey || user?.wx_session_key || null;
    let pkg = null;
    let points;
    let priceCny;
    let packageRef = null;

    if (packageId) {
      pkg = this.packages().find((p) => p.id === packageId || p.code === packageId);
      if (!pkg) fail(ERR.BAD_REQUEST, `点数包不存在: ${packageId}`);
      points = Number(pkg.points || 0) + Number(pkg.bonus ?? 0);
      priceCny = Number(pkg.priceCny);
      packageRef = pkg.id;
    } else {
      // 自定义金额：只按汇率兑点，不叠加赠送（赠送是档位专属福利）
      const amt = Number(amountCny);
      if (!Number.isFinite(amt) || amt <= 0) fail(ERR.BAD_REQUEST, '请选择档位或填写充值金额');
      if (amt < 1) fail(ERR.BAD_REQUEST, '最低充值 1 元');
      if (amt > 5000) fail(ERR.BAD_REQUEST, '单笔最多 5000 元，如需更多请联系客服');
      priceCny = Math.round(amt * 100) / 100;
      points = Math.floor(priceCny / config.credit.cnyPerPoint);
      if (!(points > 0)) fail(ERR.BAD_REQUEST, '金额太小，不足 1 点');
    }

    const order = db.insert(ORDERS, {
      id: newId('order'),
      user_id: userId,
      package_id: packageRef,
      points,
      amount_cny: priceCny,
      status: 'pending',
      channel: 'wx_virtual_pay',
      wx_order_id: null,
      created_at: nowIso(),
    });

    if (!wechatClient.payConfigured) {
      return {
        mode: 'mock',
        order_id: order.id,
        points: order.points,
        amount_cny: order.amount_cny,
        notice: '未配置虚拟支付商户号（OfferID / 支付密钥）。联调时请调用 POST /api/pay/virtual/mock-success 模拟发货。',
      };
    }

    const sign = wechatClient.signVirtualPayOrder({
      offerId: config.wechat.virtualPay.offerId,
      outTradeNo: order.id,
      // 虚拟支付计价单位是 0.1 元，且必须是整数：¥6.00 → 60
      fee: Math.round(order.amount_cny * 10),
      sessionKey: sk,
      platform,
    });
    return {
      mode: sign.mode,
      order_id: order.id,
      points: order.points,
      amount_cny: order.amount_cny,
      requestVirtualPayment: {
        signData: sign.signData,
        paySig: sign.paySig,
        signature: sign.signature,
        // mode 决定走哪种虚拟支付形态：微短剧用 short_series_goods（道具直购）
        mode: config.wechat.virtualPay.mode,
        // env 单独给：0=正式 1=沙箱，和 signData 里的 env 必须一致
        env: sign.env,
        zoneId: sign.zoneId,
      },
      hint: sign.mode === 'mock'
        ? '未拿到会话密钥，签名是 mock 的（微信侧一定验不过）。请确认已配置 AppID / AppSecret，并且这次请求带了登录态。'
        : '把 requestVirtualPayment 整段原样传给 wx.requestVirtualPayment 即可。',
    };
  }

  /**
   * 微信发货回调（POST /api/pay/virtual/notify）。
   * 验签通过才发货；重复回调幂等。
   */
  handleNotify({ signature, rawBody, payload }) {
    const v = wechatClient.verifyPayNotify({ signature, rawBody });
    if (!v.ok) fail(ERR.PAY_NOTIFY_INVALID, `回调验签失败（${v.reason}）`);
    let data = payload;
    if (!data && rawBody) {
      try { data = JSON.parse(rawBody); } catch { data = null; }
    }
    const outTradeNo = data?.out_trade_no ?? data?.OutTradeNo ?? null;
    const wxOrderId = data?.order_id ?? data?.OrderId ?? null;
    if (!outTradeNo) fail(ERR.PAY_ORDER_INVALID, '回调缺少 out_trade_no');
    return this.#deliver({ orderId: outTradeNo, wxOrderId });
  }

  /**
   * MOCK 联调发货：仅当虚拟支付未配置时可用，真实模式下一律拒绝。
   */
  mockPaySuccess({ orderId }) {
    if (wechatClient.payConfigured) {
      fail(ERR.PAY_ORDER_INVALID, '虚拟支付已配置，mock 发货被禁用（真实模式只认验签回调）');
    }
    return this.#deliver({ orderId, wxOrderId: `mock_wx_${orderId}` });
  }

  /** 发货：订单置 paid + 点数入账（幂等） */
  #deliver({ orderId, wxOrderId }) {
    const order = db.findOne(ORDERS, (o) => o.id === orderId);
    if (!order) fail(ERR.ORDER_NOT_FOUND, '订单不存在');
    if (order.status === 'paid') {
      return { ok: true, duplicated: true, order_id: order.id, points: order.points };
    }
    if (order.status !== 'pending') {
      fail(ERR.ORDER_STATE_INVALID, `订单状态不可发货: ${order.status}`);
    }
    const rc = ledger.recharge({
      userId: order.user_id,
      points: order.points,
      idemKey: `wxpay:${wxOrderId ?? order.id}`,
      orderId: order.id,
      channel: 'wx_virtual_pay',
    });
    db.update(ORDERS, order.id, {
      status: 'paid',
      wx_order_id: wxOrderId,
      paid_at: nowIso(),
      ledger_duplicated: rc.duplicated,
    });
    return { ok: true, duplicated: false, order_id: order.id, points: order.points, balance: rc.balance };
  }

  /** 查询订单 */
  get(orderId) {
    const o = db.findOne(ORDERS, (x) => x.id === orderId);
    if (!o) fail(ERR.ORDER_NOT_FOUND, '订单不存在');
    return o;
  }

  /**
   * 客户端轮询支付结果（V4.14）。
   *
   * 为什么要它：`wx.requestVirtualPayment` 的 success 只代表"用户在微信里付完了"，
   * 点数到账必须等微信的**发货回调**。回调有延迟（通常 1-3 秒，网络差时更久），
   * 前端如果只等 1.5 秒就刷新余额，就会出现"钱付了、点数没到"的假象。
   * 这里给一个确定性查询：按订单号轮询本地状态，paid 就一定是真到账了。
   */
  query({ userId, orderId }) {
    const o = db.findOne(ORDERS, (x) => x.id === orderId);
    if (!o) fail(ERR.ORDER_NOT_FOUND, '订单不存在');
    if (userId && o.user_id !== userId) fail(ERR.OBJECT_FORBIDDEN, '这不是你的订单');
    return {
      order_id: o.id,
      status: o.status,
      paid: o.status === 'paid',
      points: o.points,
      amount_cny: o.amount_cny,
      paid_at: o.paid_at ?? null,
      // 未配置商户号时前端只能走 mock 发货，不要提示"等待回调"
      channel: o.channel,
      pending_hint: o.status === 'pending'
        ? '微信的到账通知还没到。通常几秒内到账；超过 1 分钟可点「我已支付，刷新」。'
        : null,
    };
  }

  /**
   * 虚拟支付接入体检（V4.14）。
   *
   * 用户问「虚拟支付怎么接入」时，最难的不是写代码，而是不知道还差哪几步。
   * 这里把「差什么」直接算出来：微信后台开通 / offerId / appKey / 回调地址 / session_key。
   * 只回布尔与提示，绝不回密钥内容。
   */
  status() {
    const vp = config.wechat.virtualPay;
    const configured = wechatClient.payConfigured;
    const items = [
      {
        key: 'appid',
        label: '小程序 AppID / AppSecret',
        done: Boolean(config.wechat.appid && config.wechat.secret),
        todo: '在微信后台「开发管理 → 开发设置」里拿 AppID 与 AppSecret，配到服务端环境变量。',
      },
      {
        key: 'capability',
        label: '开通「虚拟支付」能力',
        done: configured,
        todo: '小程序后台「功能 → 虚拟支付」提交申请（需要企业主体 + 对应类目），审核通过才有 offerId。',
      },
      {
        key: 'offer_id',
        label: 'OfferID',
        done: Boolean(vp.offerId),
        todo: '虚拟支付后台「基础配置」里的 OfferID，形如 1450000000，配到服务端环境变量。',
      },
      {
        key: 'app_key',
        label: 'AppKey（支付密钥）',
        done: Boolean(vp.appKey),
        todo: '虚拟支付后台「基础配置 → 支付密钥」里的 AppKey，只放服务端环境变量。',
      },
      {
        key: 'env',
        label: '环境（沙箱 / 正式）',
        done: true,
        todo: `当前环境：${vp.env === 0 ? '正式' : '沙箱'}；联调用沙箱，上线改成正式。`,
      },
      {
        key: 'notify',
        label: '发货回调地址',
        done: Boolean(vp.notifyUrl),
        todo: '填 https://你的域名/api/pay/virtual/notify，并在虚拟支付后台「回调配置」里登记。',
      },
      {
        key: 'pay_mode',
        label: '支付形态',
        done: true,
        todo: `当前 ${vp.mode}；微短剧卖点数包用 short_series_goods。`,
      },
    ];
    return {
      configured,
      mode: configured ? 'live' : 'mock',
      env: vp.env === 0 ? 'production' : 'sandbox',
      pay_mode: vp.mode,
      ready: items.filter((x) => !x.done).length === 0,
      missing: items.filter((x) => !x.done).map((x) => x.key),
      items,
      docs: 'docs/虚拟支付接入指南.md',
    };
  }

  listByUser(userId) {
    return db.find(ORDERS, (o) => o.user_id === userId).reverse();
  }
}

export const virtualPay = new VirtualPay();
export default virtualPay;
