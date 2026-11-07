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
  createOrder({ userId, packageId = null, amountCny = null, sessionKey = null }) {
    if (!userId) fail(ERR.AUTH_REQUIRED, '请先登录');
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
        notice: '未配置虚拟支付商户号（WX_PAY_OFFER_ID/WX_PAY_APP_KEY）。联调时请调用 POST /api/pay/virtual/mock-success 模拟发货。',
      };
    }

    const sign = wechatClient.signVirtualPayOrder({
      offerId: config.wechat.virtualPay.offerId,
      outTradeNo: order.id,
      fee: Math.round(order.amount_cny * 10), // 虚拟支付单位：0.1 元
      sessionKey,
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
        mode: sign.env,
        zoneId: sign.zoneId,
      },
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

  listByUser(userId) {
    return db.find(ORDERS, (o) => o.user_id === userId).reverse();
  }
}

export const virtualPay = new VirtualPay();
export default virtualPay;
