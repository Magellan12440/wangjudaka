import { test } from 'node:test';
import assert from 'node:assert/strict';
import virtualPay from '../src/pay/VirtualPay.js';
import ledger from '../src/ledger/Ledger.js';

const U = 'u_recharge_' + Date.now();

test('按档位下单：点数含赠送，mock 发货后余额到账', () => {
  const pkgs = virtualPay.packages();
  assert.ok(pkgs.length >= 1, '至少要有一个上架档位');
  const pkg = pkgs.find((p) => p.bonus > 0) || pkgs[0];

  const order = virtualPay.createOrder({ userId: U, packageId: pkg.id });
  assert.equal(order.mode, 'mock', '未配置商户号时应走 mock 通道');
  assert.equal(order.points, pkg.points + (pkg.bonus || 0));
  assert.equal(order.amount_cny, pkg.priceCny);

  const before = ledger.balance(U);
  const r = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(r.ok, true);
  assert.equal(r.balance, before + order.points);

  // 同一订单重复发货必须幂等，不能凭空多点
  const again = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(again.duplicated, true);
  assert.equal(ledger.balance(U), r.balance);
});

test('自定义金额下单：1 点 = 1 元，向下取整', () => {
  const before = ledger.balance(U);
  const order = virtualPay.createOrder({ userId: U, amountCny: 30 });
  assert.equal(order.points, 30);
  assert.equal(order.amount_cny, 30);
  const r = virtualPay.mockPaySuccess({ orderId: order.order_id });
  assert.equal(r.balance, before + 30);
});

test('自定义金额的边界：0 / 负数 / 超大 一律拒绝', () => {
  assert.throws(() => virtualPay.createOrder({ userId: U, amountCny: 0 }), /档位|金额/);
  assert.throws(() => virtualPay.createOrder({ userId: U, amountCny: -5 }), /档位|金额/);
  assert.throws(() => virtualPay.createOrder({ userId: U, amountCny: 99999 }), /最多/);
});

test('不存在的档位被拒绝，不会产生零元订单', () => {
  assert.throws(() => virtualPay.createOrder({ userId: U, packageId: 'PKG-NOT-EXIST' }), /不存在/);
});

test('未登录不能下单', () => {
  assert.throws(() => virtualPay.createOrder({ packageId: 'PKG-100' }), /登录/);
});

test('扣费链路：预扣按余额拦截，结算多退少补', () => {
  const V = 'u_recharge_hold_' + Date.now();
  ledger.recharge({ userId: V, points: 100, idemKey: `rc-${V}` });
  // 余额 100，预扣 60
  const hold = ledger.hold({ userId: V, points: 60, refType: 'video', refId: 'S1' });
  assert.equal(ledger.balance(V), 40);
  // 实际只花了 25：退回 35
  const settle = ledger.settle(hold.hold.id, 25);
  assert.equal(settle.refunded, 35);
  assert.equal(ledger.balance(V), 75);
  // 余额不够时必须拦住（而不是扣成负数）
  assert.throws(
    () => ledger.hold({ userId: V, points: 500, refType: 'video', refId: 'S2' }),
    (e) => e.code === 'INSUFFICIENT_BALANCE',
  );
  assert.equal(ledger.balance(V), 75);
});
