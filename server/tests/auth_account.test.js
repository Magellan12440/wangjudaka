/**
 * 账号体系（V4.4）：手机号验证码、密码、绑定手机。
 * 重点守两件事：未接短信服务时不假装已发；密码错误不泄露账号是否存在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import authService, { normalizePhone, maskPhone } from '../src/auth/AuthService.js';
import { db } from '../src/store/db.js';

const PHONE = '13900139000';

test('手机号规范化：接受常见写法，拒绝非法号码', () => {
  assert.equal(normalizePhone('13900139000'), '13900139000');
  assert.equal(normalizePhone('+86 139-0013-9000'), '13900139000');
  assert.throws(() => normalizePhone('12345'), /手机号/);
  assert.throws(() => normalizePhone(''), /手机号/);
  assert.equal(maskPhone('13900139000'), '139****9000');
});

test('验证码：未配置服务商时返回测试码并标明模式，绝不假装已发', () => {
  const r = authService.sendCode({ phone: PHONE });
  assert.equal(r.sent, false);
  assert.equal(r.mode, 'dev');
  assert.match(r.dev_code, /^\d{6}$/);
  assert.ok(r.note.includes('未配置短信服务商'));
});

test('验证码：60 秒内重复发送被拒', () => {
  authService.sendCode({ phone: '13700137000' });
  assert.throws(() => authService.sendCode({ phone: '13700137000' }), /60 秒/);
});

test('验证码：错误码被拒且累计尝试次数，正确码可登录并自动注册', () => {
  const phone = '13600136000';
  const { dev_code: code } = authService.sendCode({ phone });
  assert.throws(() => authService.loginByCode({ phone, code: '000000' }), /验证码不对/);
  const r = authService.loginByCode({ phone, code });
  assert.ok(r.token);
  assert.equal(r.isNewUser, true, '新手机号应自动注册');
  assert.equal(r.user.has_password, false);
  assert.ok(r.user.phone_masked.includes('****'));
});

test('密码：设置后可用手机号+密码登录，错误密码被拒且文案不区分原因', () => {
  const phone = '13500135000';
  const { dev_code: code } = authService.sendCode({ phone });
  const { token, user } = authService.loginByCode({ phone, code });
  assert.ok(token);

  assert.throws(() => authService.setPassword(user.id, { password: '123' }), /至少 6 位/);
  const after = authService.setPassword(user.id, { password: 'goodpass123' });
  assert.equal(after.has_password, true);

  const ok = authService.loginByPassword({ phone, password: 'goodpass123' });
  assert.ok(ok.token);
  assert.equal(ok.mode, 'password');

  assert.throws(() => authService.loginByPassword({ phone, password: 'wrong' }), /手机号或密码不对/);
  assert.throws(() => authService.loginByPassword({ phone: '13400134000', password: 'x' }), /手机号或密码不对/);
});

test('绑定手机：手机号被占用时拒绝，未被占用则绑定成功', () => {
  // 造一个已占用该手机号的用户（模拟老账号已经绑过）
  const taken = '13100131000';
  db.insert('users', {
    id: 'user_taken_1', openid: 'phone_taken_1', phone: taken,
    nickname: '老账号', avatar: null, created_at: new Date().toISOString(),
  });

  const fresh = '13000130001';
  const login = authService.loginByCode({ phone: fresh, code: authService.sendCode({ phone: fresh }).dev_code });
  assert.ok(login.token);

  // 验证码是这个手机号的，但号已被占用 → 必须拒绝
  const code = authService.sendCode({ phone: taken }).dev_code;
  assert.throws(() => authService.bindPhone(login.user.id, { phone: taken, code }), /已绑定其他账号/);

  const own = '13000130002';
  const code2 = authService.sendCode({ phone: own }).dev_code;
  const bound = authService.bindPhone(login.user.id, { phone: own, code: code2 });
  assert.equal(bound.has_phone, true);
  assert.equal(bound.phone_masked, '130****0002');
});

test('验证码只落哈希，不存明文', () => {
  const phone = '13000130000';
  authService.sendCode({ phone });
  const rows = db.find('sms_codes', (x) => x.phone === phone);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.code_hash && r.code_hash.length === 64, '应为 sha256 十六进制');
    assert.equal(r.code, undefined, '不允许存明文验证码');
  }
});
