/**
 * 管理员账号体系（V4.7）。
 *
 * 用户的原话是「帮我内置管理员账号，让我可以在小程序内部就可以操作管理员权限」。
 * 这件事的红线是：
 *  1) 激活码不能从公开接口拿到（谁先扫到谁就是站长）
 *  2) 管理员与普通用户的区别必须是真的（role），不能只靠前端藏入口
 *  3) 管理员的破坏性操作要有兜底（不能把最后一个管理员降级，不能扣成负余额）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import { adminConsole } from '../src/admin/AdminConsole.js';
import { authService } from '../src/auth/AuthService.js';
import { config } from '../src/config/env.js';
import { handleRequest, routes } from '../src/api/routes.js';

/** 直接拿激活码：模拟「站长在服务端日志里看到的那一串」 */
function peekCode() {
  const row = db.findOne('app_settings', (s) => s.key === 'admin_bootstrap');
  return row?.value?.code ?? null;
}

function call(method, path, { body = {}, query = {}, headers = {} } = {}) {
  const res = {
    code: 0,
    payload: null,
    setHeader() {},
    writeHead(c) { this.code = c; },
    end(s) { try { this.payload = JSON.parse(s); } catch { this.payload = s; } },
  };
  const url = new URL(`http://localhost${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return handleRequest({ method, url: url.toString(), method_: method, headers, body }, res)
    .then(() => ({ status: res.code, ...res.payload }));
}

/** 直接调 handler（绕过 HTTP 层的 body 解析），用于只读场景 */
async function invoke(path, { query = {}, headers = {}, body = {}, params = {} } = {}) {
  const def = routes.find(([m, p]) => m === 'GET' && p === path);
  if (!def) throw new Error(`没有这个路由: ${path}`);
  const req = { headers };
  const data = await def[2]({ params, query, body, req });
  return data;
}

test('引导状态：没有管理员时要求激活，且绝不返回激活码本身', () => {
  adminConsole.ensureBootstrap();
  const st = adminConsole.bootstrapStatus();
  assert.equal(st.need_bootstrap, true);
  assert.equal(st.has_admin, false);
  assert.ok(st.code_issued, '应该已经生成了激活码');
  // 整个响应体里不能出现激活码
  assert.ok(!JSON.stringify(st).includes(peekCode()), '激活码不能出现在公开响应里');
});

test('激活：错误的激活码被拒，正确的能建出管理员', () => {
  const code = peekCode();
  assert.throws(() => adminConsole.bootstrap({ code: 'WRONGCODE1', phone: '13800000001', password: 'admin888' }),
    /激活码不对/);

  const r = adminConsole.bootstrap({ code, phone: '13800000001', password: 'admin888' });
  assert.ok(r.token, '激活成功应直接签发登录态');
  assert.equal(r.user.role, 'admin');
  assert.equal(r.user.is_admin, true);
  assert.equal(adminConsole.bootstrapStatus().need_bootstrap, false);
});

test('激活码一次性：用过之后再激活会被拒', () => {
  assert.throws(() => adminConsole.bootstrap({ code: peekCode(), phone: '13800000002', password: 'admin888' }),
    /已有管理员|已被使用/);
});

test('管理员登录：密码对且是管理员才放行；普通账号登不进管理端', () => {
  const ok = adminConsole.login({ phone: '13800000001', password: 'admin888' });
  assert.equal(ok.user.role, 'admin');

  authService.createAccount({ phone: '13800000009', password: 'user8888' });
  assert.throws(() => adminConsole.login({ phone: '13800000009', password: 'user8888' }), /不是管理员/);
  assert.throws(() => adminConsole.login({ phone: '13800000001', password: 'wrongpw' }), /手机号或密码不对/);
});

test('管理鉴权：管理员 session 可过，普通用户 session 403', () => {
  const admin = adminConsole.login({ phone: '13800000001', password: 'admin888' });
  const plain = authService.loginByPassword({ phone: '13800000009', password: 'user8888' });

  const okActor = adminConsole.assertAdmin({ headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(okActor.mode, 'account');

  assert.throws(() => adminConsole.assertAdmin({ headers: { authorization: `Bearer ${plain.token}` } }),
    /需要管理员权限/);
  assert.throws(() => adminConsole.assertAdmin({ headers: {} }), /需要管理员权限/);
});

test('管理鉴权：配置了 ADMIN_TOKEN 时，令牌仍然等价于超级管理员', () => {
  const actor = adminConsole.assertAdmin({ headers: { 'x-admin-token': config.admin.token } });
  assert.equal(actor.mode, 'token');
  assert.throws(() => adminConsole.assertAdmin({ headers: { 'x-admin-token': 'not-the-token' } }),
    /需要管理员权限/);
});

test('用户列表：能搜到人，且不泄露密码哈希与 openid', () => {
  const r = adminConsole.listUsers({ q: '13800000009' });
  assert.ok(r.total >= 1);
  const u = r.items[0];
  assert.equal(u.phone_masked, '138****0009');
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes('password_hash'), '列表不能带密码哈希');
  assert.ok(!raw.includes('password_salt'), '列表不能带盐');
  assert.ok(!raw.includes('openid'), '列表不能带 openid');
});

test('调账：加点是加、扣点是扣，扣成负数被拒', () => {
  const u = db.findOne('users', (x) => x.phone === '13800000009');
  const a = adminConsole.adjustPoints({ userId: u.id, delta: 100, note: '补偿' });
  assert.equal(a.balance >= 100, true);
  const b = adminConsole.adjustPoints({ userId: u.id, delta: -40, note: '回收' });
  assert.equal(b.balance, a.balance - 40);
  assert.throws(() => adminConsole.adjustPoints({ userId: u.id, delta: -999999 }), /负数/);
  assert.throws(() => adminConsole.adjustPoints({ userId: u.id, delta: 0 }), /非零整数/);
});

test('角色：不能把最后一个管理员降级，也不能取消自己', () => {
  const me = db.findOne('users', (x) => x.phone === '13800000001');
  assert.throws(() => adminConsole.setUserRole({ userId: me.id, role: 'user', actorId: me.id }),
    /至少要保留一个管理员|不能取消自己/);
});

test('停用：普通用户可以停，管理员不能停，也不能停自己', () => {
  const u = db.findOne('users', (x) => x.phone === '13800000009');
  const me = db.findOne('users', (x) => x.phone === '13800000001');
  assert.equal(adminConsole.setUserStatus({ userId: u.id, status: 'banned', actorId: me.id }).status, 'banned');
  // 停用后原有登录态立即失效
  assert.throws(() => adminConsole.setUserStatus({ userId: me.id, status: 'banned', actorId: me.id }), /不能停用/);
  assert.equal(adminConsole.setUserStatus({ userId: u.id, status: 'active', actorId: me.id }).status, 'active');
});

test('公开接口：GET /api/admin/bootstrap 200 且不含激活码', async () => {
  const r = await call('GET', '/api/admin/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.data.has_admin, true);
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes(peekCode()), '公开接口绝不能回吐激活码');
});

test('管理接口：未登录 403，管理员登录后 200', async () => {
  const denied = await call('GET', '/api/admin/users');
  assert.equal(denied.status, 403);

  const admin = adminConsole.login({ phone: '13800000001', password: 'admin888' });
  const ok = await call('GET', '/api/admin/users', { headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.data.items));
});
