import { test } from 'node:test';
import assert from 'node:assert/strict';
import ledger from '../src/ledger/Ledger.js';
import { db } from '../src/store/db.js';
import { ERR } from '../src/core/errors.js';

const U = 'u_ledger_' + Date.now();

test('开户与初始余额', () => {
  const acc = ledger.ensureAccount(U);
  assert.equal(acc.balance_points, 0);
});

test('充值入账，且幂等', () => {
  const r1 = ledger.recharge({ userId: U, points: 1000, idemKey: 'order-1', orderId: 'WX1' });
  assert.equal(r1.duplicated, false);
  assert.equal(r1.balance, 1000);
  const r2 = ledger.recharge({ userId: U, points: 1000, idemKey: 'order-1', orderId: 'WX1' });
  assert.equal(r2.duplicated, true, '同一订单号重复回调必须幂等');
  assert.equal(ledger.balance(U), 1000);
});

test('余额不足时预扣失败', () => {
  assert.throws(() => ledger.hold({ userId: U, points: 99999, refType: 'video', refId: 'S1' }), (e) => e.code === ERR.INSUFFICIENT_BALANCE);
});

test('预扣→结算（真实消耗少于预扣，多退少补）', () => {
  const before = ledger.balance(U);
  const h = ledger.hold({ userId: U, points: 100, refType: 'video', refId: 'S1' });
  assert.equal(ledger.balance(U), before - 100);
  const s = ledger.settle(h.hold.id, 70);
  assert.equal(s.refunded, 30);
  assert.equal(ledger.balance(U), before - 70);
});

test('预扣→取消（失败全额退回）', () => {
  const before = ledger.balance(U);
  const h = ledger.hold({ userId: U, points: 50, refType: 'image', refId: 'S2' });
  ledger.release(h.hold.id, 'failed');
  assert.equal(ledger.balance(U), before);
});

test('同一预扣不可重复结算', () => {
  const h = ledger.hold({ userId: U, points: 10, refType: 'image', refId: 'S3' });
  ledger.settle(h.hold.id, 10);
  assert.throws(() => ledger.settle(h.hold.id, 10), (e) => e.code === ERR.ORDER_STATE_INVALID);
});

test('对账：余额必须等于流水累计', () => {
  const r = ledger.reconcile(U);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('报价：上游成本 → 售价点数（含倍率）', () => {
  const q = ledger.quote({ upstreamUsd: 0.55 });
  assert.ok(q.points > 0);
  assert.ok(q.priceCny > q.costCny);
  assert.equal(q.markup, 1.35);
});

test('幂等键相同则不重复预扣', () => {
  const before = ledger.balance(U);
  const a = ledger.hold({ userId: U, points: 5, refType: 'image', refId: 'S4', idemKey: 'idem-A' });
  const b = ledger.hold({ userId: U, points: 5, refType: 'image', refId: 'S4', idemKey: 'idem-A' });
  assert.equal(b.duplicated, true);
  assert.equal(ledger.balance(U), before - 5);
  ledger.release(a.hold.id, 'test');
});
