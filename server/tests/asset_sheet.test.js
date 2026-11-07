/**
 * V4.10：资产设定图编译 + 百万字正文分层压缩。
 *
 * 资产图这条分支的关键约束只有一条：**不能自锁**。
 * 分镜图要求「角色已有图才能出」，而资产图就是在造那张图，
 * 所以它必须走独立分支，且不带参考图、不校验情绪卡。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import compiler from '../src/compiler/PromptCompiler.js';
import { db } from '../src/store/db.js';
import materialService from '../src/assets/MaterialService.js';

const STYLE = 'STY-DUSHI';

function baseReq(over = {}) {
  return {
    project: { style_code: STYLE, aspect: '1:1', quality: '720p' },
    shot_no: 'CH01-SHEET',
    asset: {
      asset_code: 'CH01',
      asset_type: 'character',
      name: '沈砚',
      locks: ['面部轮廓与上妆一致', '发型发色一致', '标志性服装与配色一致', '随身道具一致'],
      lock_values: { traits: '瘦、左眉有疤' },
      meta: {},
    },
    available_credits: 100000,
    options: { mode: 'asset_sheet' },
    ...over,
  };
}

test('资产设定图：产出合法 payload（带 stamp，无参考图）', () => {
  const p = compiler.compile(baseReq());
  assert.equal(p.kind, 'image');
  assert.equal(p.asset_code, 'CH01');
  assert.equal(p.asset_type, 'character');
  assert.ok(p.prompt_zh.includes('角色定妆图'));
  assert.ok(p.prompt_zh.includes('左眉有疤'), '设定要进提示词');
  assert.deepEqual(p.reference_images, []);
  assert.equal(p.continuity_locks.length, 4);
  assert.ok(p._stamp, '必须有 stamp 才能过 RelayAdapter');
  assert.ok(p.estimated_credits > 0);
});

test('资产设定图：场景与道具走各自构图', () => {
  const scene = compiler.compile(baseReq({
    asset: { asset_code: 'SC01', asset_type: 'scene', name: '灯塔底层', locks: ['空间结构一致', '关键陈设一致', '光源方向一致'], lock_values: { desc: '潮湿的石壁' } },
  }));
  assert.ok(scene.prompt_zh.includes('场景概念图'));

  const prop = compiler.compile(baseReq({
    asset: { asset_code: 'PR01', asset_type: 'prop', name: '油灯', locks: ['外形与材质一致', '颜色一致', '印记一致'], lock_values: { desc: '铜制、有裂痕' } },
  }));
  assert.ok(prop.prompt_zh.includes('道具设定图'));
});

test('资产设定图：锁不足直接拒绝（一致性不允许糊弄）', () => {
  assert.throws(
    () => compiler.compile(baseReq({
      asset: { asset_code: 'CH99', asset_type: 'character', name: '临时', locks: ['只有一条'] },
    })),
    /连续性锁/,
  );
});

test('资产设定图：余额不足时编译期就失败', () => {
  assert.throws(() => compiler.compile(baseReq({ available_credits: 0 })), /余额|点数|不足/);
});

test('百万字正文：分层压缩保留结构，且不超预算', () => {
  const pid = `proj_long_${Date.now()}`;
  db.insert('projects', { id: pid, user_id: 'u_long', title: '长篇', spec: {}, created_at: new Date().toISOString() });
  // 造一本 105 万字、300 章的「小说」（留在 120 万上限之内）
  const chunk = '他推开门，风雪灌进来，灯芯晃了一下。\n';
  const perChapter = 3500;
  const parts = [];
  for (let i = 1; i <= 300; i += 1) {
    parts.push(`第${i}章 夜行`);
    parts.push(chunk.repeat(Math.ceil(perChapter / chunk.length)).slice(0, perChapter));
  }
  const novel = parts.join('\n').slice(0, 1050000);
  assert.ok(novel.length > 1000000, `样本长度 ${novel.length}`);

  const m = materialService.addText({ projectId: pid, name: '长夜行.txt', text: novel });
  assert.ok(m.chars > 1000000, '百万字应该能入库');

  const d = materialService.digest(pid, { maxChars: 24000, perText: 24000 });
  assert.equal(d.condensed, true);
  assert.ok(d.chars <= 24000 + 2000, `摘要长度 ${d.chars}`);
  assert.ok(d.text.includes('【全书结构】'), '应保留章节结构');
  assert.ok(d.text.includes('【开头】') && d.text.includes('【结尾】'), '应保留开头与结尾');
  assert.ok(d.total_chars > 1000000);
});
