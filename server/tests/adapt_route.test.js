/**
 * 素材改编路线（V4.6）。
 *
 * 用户的原话是「没有直接上传内容生成剧本的创作方式」——所以这条路的红线是：
 *  1) 选了「改编我的素材」，没素材时**不许**凭空生成（那是偷换，不是改编）
 *  2) 改编强度必须真的改变给模型的指令，不能只是个 UI 选项
 *  3) 默认路线仍是 AI 出创意，不能把老用户的路堵了
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAdaptReady } from '../src/api/routes.js';
import { adaptInstruction } from '../src/pipeline/StoryEngine.js';

test('改编准入：material 路线没有正文时拒绝，并说清缺什么', () => {
  assert.throws(
    () => assertAdaptReady({ origin: 'material' }, { text: '', chars: 0 }),
    /改编我的素材/,
  );
  assert.throws(() => assertAdaptReady({ origin: 'material' }, null), /改编我的素材/);
});

test('改编准入：material 路线有正文则放行', () => {
  assert.equal(assertAdaptReady({ origin: 'material' }, { text: '第一章 少年出山……', chars: 1200 }), true);
});

test('改编准入：AI 出创意路线不受素材限制（老路径不能被堵）', () => {
  assert.equal(assertAdaptReady({ origin: 'idea' }, { text: '', chars: 0 }), true);
  assert.equal(assertAdaptReady({}, { text: '', chars: 0 }), true, '没有 origin 字段的历史项目按 idea 处理');
});

test('改编强度：忠于原著明确禁止改结局', () => {
  const s = adaptInstruction({ adapt_mode: 'faithful' }, true);
  assert.ok(s.includes('忠于原著'));
  assert.ok(s.includes('不得改动结局'));
  assert.ok(!s.includes('重排节奏'), '忠于原著不能同时允许重排');
});

test('改编强度：按短剧重排允许调结构但锁死世界观与动机', () => {
  const s = adaptInstruction({ adapt_mode: 'remix' }, true);
  assert.ok(s.includes('重排节奏'));
  assert.ok(s.includes('世界观与主角动机不得改变'));
});

test('改编强度：没有素材时不给任何改编指令（不能对空素材瞎指挥）', () => {
  assert.equal(adaptInstruction({ adapt_mode: 'faithful' }, false), '');
  assert.equal(adaptInstruction({ adapt_mode: 'remix' }, false), '');
});

test('改编强度：未选模式时不给指令，避免 AI 自作主张', () => {
  assert.equal(adaptInstruction({}, true), '');
  assert.equal(adaptInstruction({ adapt_mode: null }, true), '');
  assert.equal(adaptInstruction({ adapt_mode: 'unknown' }, true), '');
});
