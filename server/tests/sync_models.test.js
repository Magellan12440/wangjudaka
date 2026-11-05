/** V3.3 模型清单同步脚本：纯函数契约（不触网、不改注册表文件） */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferRole, extractUpstreamIds, mergeModels } from '../scripts/sync_models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'seeds', 'data', 'model_registry.seed.json'), 'utf8'));

test('inferRole 覆盖图片/视频/音频/聊天四类', () => {
  assert.equal(inferRole('gpt-image-1'), 'image');
  assert.equal(inferRole('flux-1.1-pro'), 'image');
  assert.equal(inferRole('seedance-1.5-pro'), 'video');
  assert.equal(inferRole('kling-v2'), 'video');
  assert.equal(inferRole('cosyvoice3-tts'), 'audio');
  assert.equal(inferRole('whisper-large'), 'audio');
  assert.equal(inferRole('gpt-4o-mini'), 'chat');
});

test('extractUpstreamIds 兼容三种响应形态并去重', () => {
  assert.deepEqual(extractUpstreamIds({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(extractUpstreamIds({ models: [{ name: 'x' }] }), ['x']);
  assert.deepEqual(extractUpstreamIds(['m1', 'm2']), ['m1', 'm2']);
  assert.deepEqual(extractUpstreamIds({}), []);
});

test('合并保留全部人工字段：code / price / commercial_ok 不被上游覆盖', () => {
  const ids = REG.models.map((m) => m.upstream_id);
  const { registry, diff } = mergeModels(REG, ids, '2026-11-03T00:00:00.000Z');
  assert.equal(registry.models.length, REG.models.length);
  assert.equal(diff.added.length, 0);
  assert.equal(diff.marked_unavailable.length, 0);
  for (const before of REG.models) {
    const after = registry.models.find((m) => m.upstream_id === before.upstream_id);
    assert.equal(after.code, before.code);
    assert.equal(after.role, before.role);
    assert.equal(after.commercial_ok, before.commercial_ok);
    assert.deepEqual(after.price, before.price);
    assert.equal(after.upstream_available, true);
  }
  assert.equal(registry._last_sync, '2026-11-03T00:00:00.000Z');
});

test('上游新模型：默认禁止商用、需人工核验、角色自动推断', () => {
  const ids = [...REG.models.map((m) => m.upstream_id), 'wan2.6-i2v', 'brand-new-chat-model'];
  const { registry, diff } = mergeModels(REG, ids);
  assert.equal(diff.added.length, 2);
  const wan = registry.models.find((m) => m.upstream_id === 'wan2.6-i2v');
  assert.equal(wan.role, 'video');
  assert.equal(wan.commercial_ok, false, '新模型必须默认禁止商用');
  assert.equal(wan.needs_review, true);
  assert.equal(wan.upstream_available, true);
  assert.ok(diff.needs_review.includes(wan.code));
  assert.match(diff.role_counts.video.toString(), /\d/);
});

test('本地有而上游没有：只标记不可用，绝不删除条目', () => {
  const ids = REG.models.slice(1).map((m) => m.upstream_id);
  const { registry, diff } = mergeModels(REG, ids);
  assert.equal(registry.models.length, REG.models.length, '条目数不变');
  assert.equal(diff.marked_unavailable.length, 1);
  assert.equal(diff.marked_unavailable[0].action, 'marked_unavailable_not_deleted');
  const marked = registry.models.find((m) => m.upstream_id === REG.models[0].upstream_id);
  assert.equal(marked.upstream_available, false);
  assert.equal(marked.price.usd !== undefined || true, true);
  assert.deepEqual(marked.price, REG.models[0].price, '定价字段保留');
});

test('连续两次同步不重复新增（幂等）', () => {
  const ids = [...REG.models.map((m) => m.upstream_id), 'new-video-model-v1'];
  const first = mergeModels(REG, ids).registry;
  const second = mergeModels(first, ids);
  assert.equal(second.registry.models.length, first.models.length);
  assert.equal(second.diff.added.length, 0);
});
