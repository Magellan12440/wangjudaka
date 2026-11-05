/**
 * V3.6 管理员后台 + 兑换码 单元测试。
 * 运行环境由 setup-env.js 提供：ADMIN_TOKEN='test-admin-token'，数据目录隔离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import adminService, { AdminService, normalizeCode } from '../src/admin/AdminService.js';
import ledger from '../src/ledger/Ledger.js';
import virtualPay from '../src/pay/VirtualPay.js';
import { db } from '../src/store/db.js';

const TOKEN = 'test-admin-token';

test('鉴权：未配置/错误/正确令牌三种情形', () => {
  // 正确
  assert.ok(adminService.assertAdmin(TOKEN));
  // 错误
  assert.throws(() => adminService.assertAdmin('wrong-token'), /管理员令牌无效/);
  assert.throws(() => adminService.assertAdmin(''), /管理员令牌无效/);
  assert.throws(() => adminService.assertAdmin(undefined), /管理员令牌无效/);
  // 未配置 ADMIN_TOKEN 时一律拒绝
  const svc = new AdminService();
  const { config } = awaitImportConfig();
  const bak = config.admin.token;
  config.admin.token = '';
  assert.throws(() => svc.assertAdmin(TOKEN), /未配置 ADMIN_TOKEN/);
  config.admin.token = bak;
});

// 同步拿到 config（模块已加载，直接取缓存）
import { config as __cfg } from '../src/config/env.js';
function awaitImportConfig() {
  return { config: __cfg };
}

test('充值档次：默认播种幂等 + 公开视图只含上架档', () => {
  const r1 = adminService.seedDefaultPackages();
  assert.equal(r1.seeded, true);
  assert.equal(r1.count, 3);
  const r2 = adminService.seedDefaultPackages();
  assert.equal(r2.seeded, false);
  const pub = adminService.publicPackages();
  assert.equal(pub.length, 3);
  assert.equal(pub[0].id, 'PKG-100');
  assert.equal(pub[1].totalPoints, 530); // 500+30
  // 公开字段白名单
  for (const p of pub) {
    assert.deepEqual(Object.keys(p).sort(), ['bonus', 'code', 'id', 'name', 'points', 'priceCny', 'totalPoints'].sort());
  }
});

test('充值档次：创建/更新/上下架/校验', () => {
  const p = adminService.createPackage({ name: '旗舰包', points: 5000, bonus: 800, priceCny: 5000, sort: 9 });
  assert.ok(p.id.startsWith('pkg_'));
  assert.equal(p.status, 'active');
  // 更新
  const u = adminService.updatePackage(p.id, { bonus: 1000 });
  assert.equal(u.bonus, 1000);
  assert.equal(u.points, 5000); // 未改字段保持
  // 下架 → 公开视图消失，管理视图仍在
  adminService.setPackageStatus(p.id, 'offline');
  assert.ok(!adminService.publicPackages().some((x) => x.id === p.id));
  assert.ok(adminService.listPackages().some((x) => x.id === p.id));
  // 非法输入
  assert.throws(() => adminService.createPackage({ name: '', points: 10, priceCny: 10 }), /名称/);
  assert.throws(() => adminService.createPackage({ name: 'x', points: 0, priceCny: 10 }), /点数/);
  assert.throws(() => adminService.createPackage({ name: 'x', points: 10, bonus: -1, priceCny: 10 }), /赠送/);
  assert.throws(() => adminService.createPackage({ name: 'x', points: 10, priceCny: 0 }), /售价/);
  assert.throws(() => adminService.updatePackage('pkg_none', { points: 5 }), /不存在/);
  assert.throws(() => adminService.setPackageStatus(p.id, 'bad'), /active\/offline/);
});

test('兑换码：批量生成（格式/唯一/上限/有效期）', () => {
  const r = adminService.generateCodes({ points: 200, bonus: 20, count: 10, prefix: 'VIP', expireDays: 30, maxUses: 2, note: '内测' });
  assert.equal(r.count, 10);
  assert.equal(r.totalPoints, 220);
  assert.equal(r.codes.length, 10);
  assert.equal(new Set(r.codes).size, 10); // 批内唯一
  for (const c of r.codes) {
    const stripped = c.replace(/-/g, '');
    assert.match(stripped, /^VIP[A-Z2-9]{10}$/); // 前缀 + 10 位码体
    assert.match(c, /^[A-Z2-9]+(-[A-Z2-9]+)+$/); // 展示形态带分组横杠
    assert.ok(!/[01OIL]/.test(stripped.slice(3))); // 无易混淆字符
  }
  // 超批量上限被拒
  assert.throws(() => adminService.generateCodes({ points: 1, count: 99999 }), /单批生成数量/);
  // 非法面额
  assert.throws(() => adminService.generateCodes({ points: 0, count: 1 }), /面额/);
  assert.throws(() => adminService.generateCodes({ points: 10, count: 1, maxUses: 0 }), /使用次数上限/);
  // 全库唯一性：再生成 50 个也不撞
  const r2 = adminService.generateCodes({ points: 1, count: 50, prefix: 'T2' });
  const all = db.find('redeem_codes');
  assert.equal(new Set(all.map((c) => c.code)).size, all.length);
});

test('兑换：成功入账 + 余额正确 + 流水可追溯', () => {
  const { codes } = adminService.generateCodes({ points: 300, bonus: 30, count: 1, prefix: 'USE' });
  const before = ledger.balance('u_redeem_1');
  const r = adminService.redeem({ userId: 'u_redeem_1', code: codes[0] });
  assert.equal(r.ok, true);
  assert.equal(r.credited, 330);
  assert.equal(r.base, 300);
  assert.equal(r.bonus, 30);
  assert.equal(ledger.balance('u_redeem_1'), before + 330);
  // 流水类型与渠道
  const entries = ledger.entries('u_redeem_1');
  const e = entries.find((x) => x.channel === 'redeem_code');
  assert.ok(e, '应有 redeem_code 渠道流水');
  assert.equal(e.points, 330);
  // 对账平衡
  assert.ok(ledger.reconcile('u_redeem_1').ok);
});

test('兑换：每码每用户一次 + 重放不多入账', () => {
  const { codes } = adminService.generateCodes({ points: 100, count: 1, prefix: 'ONCE' });
  adminService.redeem({ userId: 'u_a', code: codes[0] });
  const bal = ledger.balance('u_a');
  assert.throws(() => adminService.redeem({ userId: 'u_a', code: codes[0] }), /每人限用一次/);
  assert.equal(ledger.balance('u_a'), bal); // 未多入账
});

test('兑换：次数上限 / 过期 / 作废 / 无效码', () => {
  // maxUses=1：第二个用户被拒
  const { codes: c1 } = adminService.generateCodes({ points: 10, count: 1, prefix: 'LIM', maxUses: 1 });
  adminService.redeem({ userId: 'u_b1', code: c1[0] });
  assert.throws(() => adminService.redeem({ userId: 'u_b2', code: c1[0] }), /次数已用完/);
  // 已过期
  const { codes: c2 } = adminService.generateCodes({ points: 10, count: 1, prefix: 'EXP', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.throws(() => adminService.redeem({ userId: 'u_b3', code: c2[0] }), /已过期/);
  // 作废
  const { codes: c3 } = adminService.generateCodes({ points: 10, count: 1, prefix: 'RVK' });
  const rv = adminService.revokeCode(c3[0]);
  assert.equal(rv.ok, true);
  assert.throws(() => adminService.redeem({ userId: 'u_b4', code: c3[0] }), /无效或已作废/);
  // 二次作废幂等
  assert.equal(adminService.revokeCode(c3[0]).duplicated, true);
  // 无效码与空码
  assert.throws(() => adminService.redeem({ userId: 'u_b5', code: 'NOPE-CODE-XX' }), /无效或已作废/);
  assert.throws(() => adminService.redeem({ userId: 'u_b5', code: '   ' }), /请输入兑换码/);
  assert.throws(() => adminService.redeem({ userId: '', code: 'X' }), /用户标识/);
});

test('兑换：输入规范化（小写/空格/横杠等价）', () => {
  const { codes } = adminService.generateCodes({ points: 50, count: 1, prefix: 'NORM' });
  const raw = codes[0]; // NORMXXXX-XXXX-XX
  const messy = raw.toLowerCase().replace(/-/g, ' ');
  const r = adminService.redeem({ userId: 'u_norm', code: messy });
  assert.equal(r.credited, 50);
  assert.equal(normalizeCode(' ab-cd '), 'ABCD');
});

test('统计与明细：概览 / 码统计 / 使用明细 / 我的兑换（脱敏）', () => {
  const ov = adminService.overview();
  assert.ok(ov.packages.total >= 4);
  assert.ok(ov.codes.totalCodes > 0);
  assert.ok(ov.codes.totalRedemptions > 0);
  assert.ok(ov.codes.totalPointsIssued > 0);
  assert.ok(ov.users.total > 0);
  const stats = adminService.codeStats();
  assert.ok(stats.revokedCodes >= 1);
  const usages = adminService.codeUsages('USE');
  assert.ok(Array.isArray(usages));
  const mine = adminService.myRedeems('u_redeem_1');
  assert.equal(mine.length, 1);
  assert.match(mine[0].codeMasked, /\*\*\*\*/); // 用户侧只见脱敏码
  assert.equal(mine[0].pointsCredited, 330);
  // 列表分页与筛选
  const list = adminService.listCodes({ status: 'revoked' });
  assert.ok(list.items.every((c) => c.status === 'revoked'));
  assert.ok(list.items[0].remaining_uses >= 0);
});

test('虚拟支付档次与管理后台同源（单事实源）', () => {
  const pkgs = virtualPay.packages();
  assert.ok(pkgs.length >= 3);
  const p500 = pkgs.find((p) => p.code === 'PKG-500');
  assert.equal(p500.points + p500.bonus, p500.totalPoints);
  // 按 code 下单也可用
  const order = virtualPay.createOrder({ userId: 'u_pay_src', packageId: 'PKG-100' });
  assert.equal(order.points, 100);
});
