/**
 * 算力网关运行时配置（V4.3.1）：
 * 密钥不进 git，管理台写入后立即生效，重启仍有效；读接口只给脱敏值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/env.js';
import * as relay from '../src/relay/RelayRuntime.js';

const KEY = 'sk-test-0123456789abcdef0123456789abcdef';

function snapshot() {
  return { gateway: config.relay.gateway, apiKey: config.relay.apiKey, mock: config.relay.mock };
}
function restore(s) {
  config.relay.gateway = s.gateway;
  config.relay.apiKey = s.apiKey;
  config.relay.mock = s.mock;
}

test('脱敏：只露首尾，中间打码，绝不回吐完整密钥', () => {
  assert.equal(relay.maskKey(''), '');
  assert.equal(relay.maskKey('short'), 'sho****');
  const m = relay.maskKey(KEY);
  assert.ok(m.startsWith('sk-te'), m);
  assert.ok(m.endsWith('cdef'), m);
  assert.ok(!m.includes('0123456789abcdef'), '中段必须打码');
});

test('保存密钥：立即生效、来源标为 admin、读接口脱敏', () => {
  const bak = snapshot();
  try {
    const v = relay.saveRelayRuntime({ apiKey: KEY });
    assert.equal(config.relay.apiKey, KEY);
    assert.equal(config.relay.mock, false, '有密钥即真实调用');
    assert.equal(v.source, 'admin');
    assert.equal(v.has_api_key, true);
    assert.ok(!JSON.stringify(v).includes(KEY), '返回体不含明文密钥');
    assert.equal(v.api_key_masked, relay.maskKey(KEY));
  } finally {
    restore(bak);
  }
});

test('传空密钥 = 清除，回到环境变量基线', () => {
  const bak = snapshot();
  try {
    relay.saveRelayRuntime({ apiKey: KEY });
    const v = relay.saveRelayRuntime({ apiKey: '' });
    assert.equal(v.source === 'admin', false, '清除后不再标记为管理台来源');
  } finally {
    restore(bak);
  }
});

test('网关地址只允许 http/https，非法值直接拒绝', () => {
  const bak = snapshot();
  try {
    assert.throws(() => relay.saveRelayRuntime({ gateway: 'file:///etc/passwd' }), /http/);
    assert.throws(() => relay.saveRelayRuntime({ gateway: '不是地址' }), /URL|http/);
    const v = relay.saveRelayRuntime({ gateway: 'https://example.com/v1/' });
    assert.equal(config.relay.gateway, 'https://example.com/v1', '末尾斜杠应被去掉');
    assert.ok(v);
  } finally {
    restore(bak);
  }
});

test('密钥格式校验：太短/含空格一律拒绝', () => {
  const bak = snapshot();
  try {
    assert.throws(() => relay.saveRelayRuntime({ apiKey: 'sk-short' }), /格式/);
    assert.throws(() => relay.saveRelayRuntime({ apiKey: KEY + ' ' + KEY }), /格式/);
  } finally {
    restore(bak);
  }
});

test('演练模式开关：mock=true 时不打上游，但仍记录密钥', () => {
  const bak = snapshot();
  try {
    const v = relay.saveRelayRuntime({ apiKey: KEY, mock: true });
    assert.equal(config.relay.mock, true);
    assert.equal(v.has_api_key, true);
    assert.equal(v.mock, true);
  } finally {
    restore(bak);
  }
});
