/**
 * V3.5 微信三件套测试：登录态 / 内容安全 / 虚拟支付。
 * 全部跑在 MOCK 降级模式（测试环境无 WX_APPID），验证：
 *  - mock 链路完整可走且显式标注 mode
 *  - 真实模式的红线（mock 发货被拒、验签失败被拒）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import authService from '../src/auth/AuthService.js';
import contentSecurity from '../src/security/ContentSecurity.js';
import virtualPay from '../src/pay/VirtualPay.js';
import wechatClient from '../src/wechat/WechatClient.js';
import { ledger } from '../src/ledger/Ledger.js';

test('登录：同一 code 幂等同一用户，开户自动建账本', async () => {
  const a = await authService.login({ code: 'test_code_001' });
  const b = await authService.login({ code: 'test_code_001' });
  assert.equal(a.mode, 'mock'); // 测试环境未配置 WX_APPID
  assert.equal(a.user.id, b.user.id);
  assert.equal(a.isNewUser, true);
  assert.equal(b.isNewUser, false);
  assert.ok(a.token.includes('.'));
  // 登录即开户
  assert.equal(ledger.balance(a.user.id), 0);
});

test('登录态：自签 token 可验签，篡改与过期被拒绝', async () => {
  const { token, user } = await authService.login({ code: 'test_code_002' });
  const v = authService.verify(token);
  assert.equal(v.userId, user.id);
  // 篡改签名
  assert.equal(authService.verify(token.slice(0, -2) + 'xx'), null);
  // 篡改 payload
  const [payload] = token.split('.');
  assert.equal(authService.verify(`${payload}.forged`), null);
  assert.equal(authService.verify(''), null);
  assert.equal(authService.verify(null), null);
});

test('requireUser：无 token/伪 token 抛 401 系错误，真 token 返回用户', async () => {
  const { token, user } = await authService.login({ code: 'test_code_003' });
  const okReq = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(authService.requireUser(okReq).id, user.id);
  assert.throws(() => authService.requireUser({ headers: {} }), /登录态无效|无效/);
});

test('内容安全：mock 模式放行但显式标注，空内容直接过，审计可查询', async () => {
  const r = await contentSecurity.assertText({ content: '一个关于折纸鹤的治愈故事', bizType: 'story_outline' });
  assert.equal(r.pass, true);
  assert.equal(r.mode, 'mock');
  const empty = await contentSecurity.checkText({ content: '   ' });
  assert.equal(empty.mode, 'empty');
  const trail = contentSecurity.auditTrail({ bizType: 'story_outline' });
  assert.ok(trail.length >= 1);
  assert.equal(trail[0].mode, 'mock');
});

test('内容安全：openid 从登录档案解析，未知用户绝不伪造', async () => {
  // msgSecCheck v2 只认「本小程序真实用户」的 openid；伪造或空值会 40003，
  // 等于机审失效或主流程被卡死。这里锁住「从档案取真值 / 取不到就返回空」。
  const { user } = await authService.login({ code: 'test_code_openid' });
  const openid = contentSecurity.openidOf(user.id);
  assert.ok(openid && openid.length > 8, '登录用户应能从档案取到 openid');
  assert.equal(contentSecurity.openidOf('user_not_exist'), '');
  assert.equal(contentSecurity.openidOf(null), '');
  assert.equal(contentSecurity.openidOf(''), '');
});

test('内容安全：非 http 图片地址跳过机审（本地/mock 产物）', async () => {
  const r = await contentSecurity.checkImage({ imageUrl: 'mock://image/img_123' });
  assert.equal(r.mode, 'skipped_not_http');
});

test('虚拟支付：mock 模式下单返回联调说明，不返回真实签名参数', async () => {
  const { user } = await authService.login({ code: 'test_code_pay' });
  const order = virtualPay.createOrder({ userId: user.id, packageId: 'PKG-100' });
  assert.equal(order.mode, 'mock');
  assert.equal(order.points, 100);
  assert.ok(order.notice.includes('WX_PAY_OFFER_ID'));
  assert.equal(order.requestVirtualPayment, undefined);
});

test('虚拟支付：mock 发货入账 + 幂等 + 账本对账平衡', async () => {
  const { user } = await authService.login({ code: 'test_code_pay2' });
  const order = virtualPay.createOrder({ userId: user.id, packageId: 'PKG-500' });
  assert.equal(order.points, 530); // 500 + 30 赠送
  const r1 = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(r1.ok, true);
  assert.equal(r1.balance, 530);
  // 重复发货幂等
  const r2 = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(r2.duplicated, true);
  // 账本对账
  const rec = ledger.reconcile(user.id);
  assert.equal(rec.ok, true);
  assert.equal(rec.balance, 530);
});

test('虚拟支付：不存在的订单与无效点数包被拒绝', async () => {
  const { user } = await authService.login({ code: 'test_code_pay3' });
  assert.throws(() => virtualPay.createOrder({ userId: user.id, packageId: 'PKG-999' }), /点数包不存在/);
  assert.throws(() => virtualPay.mockPaySuccess({ orderId: 'order_none' }), /订单不存在/);
  assert.throws(() => virtualPay.get('order_none'), /订单不存在/);
});

test('回调验签：未配置商户号时回调一律拒绝', () => {
  assert.throws(
    () => virtualPay.handleNotify({ signature: 'x', rawBody: '{}', payload: {} }),
    /验签失败|not_configured/
  );
});

test('微信客户端状态自检：三能力均如实标注 mock', () => {
  const s = wechatClient.status();
  assert.equal(s.mode, 'mock');
  assert.match(s.login, /mock/);
  assert.match(s.virtualPay, /mock/);
});

test('未登录创建充值订单被拒绝（AUTH_REQUIRED）', () => {
  assert.throws(() => virtualPay.createOrder({ userId: null, packageId: 'PKG-100' }), /请先登录/);
});
