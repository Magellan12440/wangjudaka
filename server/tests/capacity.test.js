import { test } from 'node:test';
import assert from 'node:assert/strict';
import capacity from '../src/relay/Capacity.js';
import { config } from '../src/config/env.js';

test('容量测算：单镜 / 单集 / 整部的成本与注册表单价一致', async () => {
  const r = await capacity.snapshot({ episodes: 3, episodeSec: 90 });
  // 5 秒 720p + 1 张关键帧
  assert.equal(r.unit_cost.video_suanli_per_sec, 0.7776);
  assert.equal(r.cost.per_shot_suanli, 4.25);
  assert.equal(r.shape.shots_per_episode, 18);
  assert.equal(r.shape.shots, 54);
  // 单集 = 18 × 4.248 + LLM，落在 70~85 算力之间
  assert.ok(r.cost.per_episode_suanli > 70 && r.cost.per_episode_suanli < 85, String(r.cost.per_episode_suanli));
  // 整部 = 单集 × 3
  assert.equal(r.cost.per_drama_suanli, Number((r.cost.per_episode_suanli * 3).toFixed(1)));
});

test('容量测算：并发承载按槽位算，不吹牛', async () => {
  const r = await capacity.snapshot({ episodes: 3, episodeSec: 90 });
  assert.equal(r.concurrency.slots, config.relay.maxConcurrency);
  // 每人 2 槽才算「不排队」
  assert.equal(r.concurrency.users_comfortable, Math.floor(config.relay.maxConcurrency / 2));
  assert.equal(r.concurrency.users_max, config.relay.maxConcurrency);
  assert.ok(r.throughput.shots_per_minute > 0);
  assert.ok(r.throughput.dramas_per_day > 0);
});

test('容量测算：想支撑的人数越多，缺口越大', async () => {
  const r = await capacity.snapshot({ episodes: 3, episodeSec: 90, activeUsersWanted: 20 });
  const need = 20 * 2;
  assert.ok(r.advice.some((a) => a.includes(String(need))), r.advice.join('|'));
  assert.ok(r.advice.some((a) => a.includes('缺')), r.advice.join('|'));
});

test('容量测算：拿不到真实余额时如实标 null，不伪装成 0', async () => {
  const r = await capacity.snapshot({});
  if (r.pool.balance_source !== 'live') {
    assert.equal(r.runway.shots, null);
    assert.equal(r.pool.balance_suanli, null);
  }
});
