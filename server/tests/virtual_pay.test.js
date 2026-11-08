/**
 * V4.14 虚拟支付接入：签名口径、会话密钥、到账查询。
 *
 * 用户问「虚拟支付怎么接入」。真正会让人卡住的不是代码，而是三件事：
 *  1. 签名到底怎么算（写错的话沙箱能过、正式全量失败）；
 *  2. 用户态签名要用 session_key，而它只在登录时出现过一次，必须落库；
 *  3. `wx.requestVirtualPayment` 的 success 不等于到账 —— 到账只认发货回调。
 * 这三条各自都有"看起来对、上线就炸"的变体，所以逐条锁住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import wechatClient from '../src/wechat/WechatClient.js';
import virtualPay from '../src/pay/VirtualPay.js';
import ledger from '../src/ledger/Ledger.js';

const hmac = (key, raw) => crypto.createHmac('sha256', key).update(raw).digest('hex');

let seq = 0;
const uid = (p) => `${p}_${(seq += 1)}_${Date.now()}`;

function mkUser(extra = {}) {
  const id = uid('u_pay');
  db.insert('users', {
    id, openid: `openid_${id}`, nickname: '测试用户',
    created_at: new Date().toISOString(),
    ...extra,
  });
  ledger.ensureAccount(id);
  return id;
}

test('签名按官方口径：paySig 用 appKey 且带 requestVirtualPayment&，signature 用 session_key', () => {
  // 临时给出"已配置"的密钥（不依赖真实环境变量）
  const vp = config.wechat.virtualPay;
  const backup = { offerId: vp.offerId, appKey: vp.appKey, appid: config.wechat.appid, secret: config.wechat.secret };
  vp.offerId = '1450000000';
  vp.appKey = 'test_app_key_xxx';
  config.wechat.appid = 'wx_test_appid';
  config.wechat.secret = 'test_secret';

  try {
    assert.equal(wechatClient.payConfigured, true, '配齐 offerId+appKey+appid 后应视为已配置');

    const sign = wechatClient.signVirtualPayOrder({
      offerId: '1450000000', outTradeNo: 'order_1', fee: 60, sessionKey: 'SESSION_KEY_ABC', platform: 'ios',
    });

    // signData 必须是紧凑 JSON，且字段齐全（少一个字段微信就报参数错误）
    const data = JSON.parse(sign.signData);
    assert.equal(data.offerId, '1450000000');
    assert.equal(data.buyQuantity, 60);
    assert.equal(data.currencyType, 'CNY');
    assert.equal(data.platform, 'ios');
    assert.equal(data.zoneId, '1');
    assert.equal(data.env, vp.env === 0 ? 0 : 1);
    assert.equal(sign.signData, JSON.stringify(data), 'signData 必须是紧凑 JSON（不能有空格）');

    assert.equal(sign.paySig, hmac('test_app_key_xxx', `requestVirtualPayment&${sign.signData}`));
    assert.equal(sign.signature, hmac('SESSION_KEY_ABC', sign.signData));
    assert.equal(sign.signed_with_session_key, true);
    assert.equal(sign.mode, 'live');

    // 没有 session_key 时必须如实标 mock，而不是拿 appKey 冒充（正式环境一定验不过）
    const noSess = wechatClient.signVirtualPayOrder({
      offerId: '1450000000', outTradeNo: 'order_2', fee: 60,
    });
    assert.equal(noSess.mode, 'mock');
    assert.equal(noSess.signed_with_session_key, false);
  } finally {
    vp.offerId = backup.offerId;
    vp.appKey = backup.appKey;
    config.wechat.appid = backup.appid;
    config.wechat.secret = backup.secret;
  }
});

test('未配商户号时走 mock 下单，并且 mock 发货能真的加点', () => {
  const userId = mkUser();
  const pkg = virtualPay.packages()[0];
  assert.ok(pkg, '至少应该有一个默认档位');

  const order = virtualPay.createOrder({ userId, packageId: pkg.id });
  assert.equal(order.mode, 'mock');
  assert.ok(order.order_id);
  assert.ok(order.points > 0);
  assert.match(order.notice, /mock-success/, 'mock 模式必须告诉联调方怎么模拟发货');

  const before = ledger.balance(userId);
  const r = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(r.ok, true);
  assert.equal(ledger.balance(userId), before + order.points, 'mock 发货后点数必须到账');

  // 重复发货幂等
  const again = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(again.duplicated, true);
  assert.equal(ledger.balance(userId), before + order.points, '重复回调不能重复加点');

  // 客户端轮询能查到已到账
  const q = virtualPay.query({ userId, orderId: order.order_id });
  assert.equal(q.paid, true);
  assert.equal(q.status, 'paid');
  assert.equal(q.points, order.points);
});

test('支付结果轮询：pending 时如实说"还没到账"，并拒绝查别人的订单', () => {
  const userId = mkUser();
  const other = mkUser();
  const pkg = virtualPay.packages()[0];
  const order = virtualPay.createOrder({ userId, packageId: pkg.id });

  const q = virtualPay.query({ userId, orderId: order.order_id });
  assert.equal(q.paid, false);
  assert.equal(q.status, 'pending');
  assert.match(q.pending_hint, /到账/);

  assert.throws(
    () => virtualPay.query({ userId: other, orderId: order.order_id }),
    (e) => e.code === 'OBJECT_FORBIDDEN',
    '不能查别人的订单',
  );
});

test('接入体检能指出还差哪几步', () => {
  const st = virtualPay.status();
  assert.ok(Array.isArray(st.items) && st.items.length >= 6);
  assert.equal(typeof st.ready, 'boolean');
  assert.ok(Array.isArray(st.missing));
  for (const it of st.items) {
    assert.ok(it.key && it.label && it.todo, '每一项都要有 key/label/todo，用户才知道怎么补');
    assert.equal(typeof it.done, 'boolean');
  }
  // 未配置时必须明确列出来，而不是只说"未配置"
  if (!st.configured) {
    assert.ok(st.missing.includes('offer_id'));
    assert.ok(st.missing.includes('app_key'));
    assert.equal(st.mode, 'mock');
  }
  // 不能回任何密钥内容
  const text = JSON.stringify(st);
  assert.equal(/test_app_key|appKey":/.test(text), false, '体检结果不能包含密钥');
});
