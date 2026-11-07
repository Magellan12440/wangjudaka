import { test } from 'node:test';
import assert from 'node:assert/strict';
import relay, { RelayAdapter } from '../src/relay/RelayAdapter.js';
import { relayPool } from '../src/relay/RelayPool.js';
import { modelRegistry } from '../src/relay/ModelRegistry.js';
import compiler from '../src/compiler/PromptCompiler.js';
import { makeReq } from './helpers.js';
import { ERR } from '../src/core/errors.js';
import { config } from '../src/config/env.js';

test('唯一出口：无编译器签名的请求被拒绝', async () => {
  await assert.rejects(
    () => relay.call({ kind: 'video', target_model: 'VID-DEFAULT', prompt_en: 'x' }),
    (e) => e.code === ERR.ILLEGAL_RELAY_ACCESS
  );
});

test('唯一出口：伪造签名被拒绝', async () => {
  const p = compiler.compile(makeReq());
  p._stamp = { body: '{}', sig: 'deadbeef' };
  await assert.rejects(() => relay.call(p), (e) => e.code === ERR.ILLEGAL_RELAY_ACCESS);
});

test('唯一出口：篡改签名内容被拒绝（改模型但保留旧签名）', async () => {
  const p = compiler.compile(makeReq());
  p.target_model = 'IMG-DEFAULT';
  await assert.rejects(() => relay.call(p), (e) => e.code === ERR.ILLEGAL_RELAY_ACCESS);
});

test('私有构造：外部无法 new RelayAdapter', () => {
  assert.throws(() => new RelayAdapter('wrong'), /ILLEGAL_RELAY_ACCESS/);
});

test('编译 → 调用 全链路可跑通（MOCK 模式）', async () => {
  const p = compiler.compile(makeReq({ model: 'VID-CHEAP', options: { purpose: 'preview' } }));
  const res = await relay.call(p);
  assert.equal(res.ok, true);
  assert.equal(res.mock, true);
  assert.ok(res.url.startsWith('mock://video/'));
  assert.ok(res.actual_credits > 0);
});

test('不可商用模型用于交付被拒绝', () => {
  assert.throws(() => modelRegistry.getForDelivery('TTS-OPEN-F5'), (e) => e.code === ERR.MODEL_NOT_COMMERCIAL);
});

test('算力池：并发闸门生效', async () => {
  relayPool.maxConcurrency = 1;
  relayPool.inflight = 1;
  // waitMs: 0 = 不排队，立刻告诉我满了
  await assert.rejects(() => relayPool.acquire({ waitMs: 0 }), (e) => e.code === ERR.RELAY_RATE_LIMITED);
  relayPool.inflight = 0;
  relayPool.maxConcurrency = config.relay.maxConcurrency;
});

test('算力池：槽位满时先排队，腾出来后自动放行', async () => {
  relayPool.maxConcurrency = 1;
  relayPool.inflight = 1;
  relayPool.windowStart = Date.now();
  relayPool.windowCount = 0;
  // 200ms 后一个槽位释放：排队中的请求应该成功，而不是直接报错
  const timer = setTimeout(() => { relayPool.inflight = 0; }, 200);
  const ok = await relayPool.acquire({ waitMs: 2000 });
  clearTimeout(timer);
  assert.equal(ok, true, '腾出槽位后应当放行');
  relayPool.release();
  relayPool.maxConcurrency = config.relay.maxConcurrency;
});

test('算力池：水位熔断生效', async () => {
  relayPool.setPoolState({ capacityPoints: 1000, balancePoints: 10 }); // 1% < fuse 5%
  await assert.rejects(() => relayPool.acquire({ estimatedCredits: 1 }), (e) => e.code === ERR.RELAY_FUSED);
  relayPool.setPoolState({ capacityPoints: 0, balancePoints: 0 }); // 复原
});

test('算力池：连续失败触发熔断', () => {
  for (let i = 0; i < 5; i++) relayPool.recordFailure(new Error('x'));
  assert.equal(relayPool.health().fused, true);
  relayPool.fuseUntil = 0; // 复原
});

test('模型注册表的对前端输出不含上游真名与真实成本字段', () => {
  const list = modelRegistry.listForClient('video');
  assert.ok(list.length > 0);
  for (const m of list) {
    assert.equal(m.upstream_id, undefined);
    assert.equal(m.price, undefined);
    assert.ok(m.points_per_unit > 0);
  }
});
