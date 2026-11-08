/**
 * V3.2 第 1 组验收：角色情绪库（情绪作为资产）+ 提示词强制强调。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import seeds from '../src/seeds/loader.js';
import compiler from '../src/compiler/PromptCompiler.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import { segmentEmotion } from '../src/compiler/segments.js';
import * as V from '../src/compiler/validators.js';
import { ERR } from '../src/core/errors.js';
import { makeReq } from './helpers.js';
import { db } from '../src/store/db.js';

const EM = 'EMO-RAGE-SUPPRESSED-04';
const EM_P = 'proj_emotion_test';
const EM_U = 'u_emotion_test';
// V4.15：资产卡必须挂在真实项目与账号下（主人由项目继承）
if (!db.findOne('projects', (x) => x.id === EM_P)) {
  db.insert('projects', {
    id: EM_P, user_id: EM_U, title: '情绪库测试项目',
    spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p' },
    created_at: new Date().toISOString(),
  });
}

test('情绪库：40 张卡 / 5 类 / 8 条表演锁 / 引用全部有效', () => {
  assert.equal(seeds.emotionCards.length, 40);
  const cats = new Set(seeds.emotionCards.map((c) => c.cat));
  assert.deepEqual([...cats].sort(), ['basic', 'conflict', 'high', 'low', 'micro']);
  for (const c of seeds.emotionCards) {
    for (const f of ['brow', 'eyes', 'mouth', 'jaw', 'breath', 'gesture', 'posture', 'gaze']) {
      assert.ok(c.lock[f], `${c.code} 缺 ${f}`);
    }
    assert.ok(c.micro_timeline.length >= 2, `${c.code} 缺微表情时间轴`);
    assert.ok(c.motion_en && c.voice_hint, `${c.code} 缺动态/语气`);
    for (const s of c.shot_affinity) assert.ok(seeds.shot(s), `${c.code} 镜头卡 ${s} 不存在`);
    for (const l of c.lighting_affinity) assert.ok(seeds.lighting(l), `${c.code} 光影卡 ${l} 不存在`);
    for (const t of c.transition_affinity) assert.ok(seeds.transition(t), `${c.code} 转场卡 ${t} 不存在`);
  }
  assert.equal(seeds.emotion(EM).name, '压抑的暴怒');
  assert.equal(seeds.lockTemplate('emotion').required_lock_count, 4);
});

test('情绪卡校验：在场角色缺情绪卡 → MISSING_EMOTION_CARD', () => {
  assert.throws(
    () => V.checkEmotion({ characters: ['CH01'], emotionMap: {}, duration: 5 }),
    (e) => e.code === ERR.MISSING_EMOTION_CARD
  );
});

test('情绪卡校验：卡不存在 / 高强情绪镜长不足 / 说话人缺情绪', () => {
  assert.throws(
    () => V.checkEmotion({ characters: ['CH01'], emotionMap: { CH01: 'EMO-NOT-EXIST' } }),
    (e) => e.code === ERR.EMOTION_CARD_NOT_FOUND
  );
  assert.throws(
    () => V.checkEmotion({ characters: ['CH01'], emotionMap: { CH01: EM }, duration: 2 }),
    (e) => e.code === ERR.EMOTION_INTENSITY_TOO_SHORT
  );
  assert.throws(
    () => V.checkEmotion({
      characters: ['CH01', 'CH02'],
      emotionMap: { CH01: EM },
      speaker: 'CH02',
      allowNeutral: true, // 显式放行 CH02 也不能让"说话人"没语气
      duration: 5,
    }),
    (e) => e.code === ERR.MISSING_EMOTION_CARD
  );
});

test('情绪卡校验：合法返回 resolved + 亲和警告', () => {
  const r = V.checkEmotion({
    characters: ['CH01'],
    emotionMap: { CH01: EM },
    emotionAssets: { CH01: { name: '林默·压抑的暴怒' } },
    duration: 5,
    speaker: 'CH01',
    shotCard: 'SHT-WS',          // 与「压抑的暴怒」的 CU/ECU 亲和冲突 → 只警告
    lightingCodes: ['LIG-PASTEL'],
  });
  assert.equal(r.resolved.CH01.card.code, EM);
  assert.equal(r.resolved.CH01.asset.name, '林默·压抑的暴怒');
  assert.equal(r.cards.length, 1);
  assert.ok(r.warnings.some((w) => w.includes('建议镜别')));
});

test('情绪段：强调前缀 + 逐角色点名 + 视频弧线 + 微表情时间轴 + 语气', () => {
  const card = seeds.emotion(EM);
  const out = segmentEmotion({
    resolved: { CH01: { card, asset: { name: '林默' } } },
    isVideo: true, duration: 5, speaker: 'CH01',
    characterNames: { CH01: '林默' },
  });
  assert.ok(out.en.includes('Performance lock, highest priority'), '必须显式声明最高优先级');
  assert.ok(out.en.includes('林默'), '必须逐角色点名');
  assert.ok(out.en.includes(card.code), '必须带情绪卡编码');
  assert.ok(out.en.includes(card.prompt_en), '必须写肌肉级表演细节');
  assert.ok(out.en.includes('Emotion arc across the shot'), '视频必须带情绪弧线');
  assert.ok(out.en.includes('Micro-expression timeline'), '视频必须带微表情时间轴');
  assert.ok(out.en.includes('Delivery:'), '说话人必须带语气');
  assert.ok(out.zh.includes('表演锁定（最高优先级'));

  const still = segmentEmotion({ resolved: { CH01: { card } }, isVideo: false });
  assert.ok(!still.en.includes('Emotion arc'), '图片不需要情绪弧线');
});

test('编译器：提示词含情绪强调，负面词含表情基线与卡片专属排除项', () => {
  const p = compiler.compile(makeReq());
  const card = seeds.emotion(EM);
  assert.ok(p.prompt_en.includes('Performance lock, highest priority'));
  assert.ok(p.prompt_en.includes(card.prompt_en));
  assert.ok(p.prompt_en.includes('Emotion arc across the shot'));
  assert.ok(p.prompt_en.includes('Micro-expression timeline'));
  assert.ok(p.negative.includes('blank expression'), '表情基线');
  assert.ok(p.negative.includes('shouting'), '情绪卡专属排除项');
  assert.equal(p.cards.emotion.CH01, EM);
});

test('编译器：缺情绪卡直接拒绝（不花钱先拦住）', () => {
  // 用 null 覆盖（deepMerge 对 {} 会递归合并，原来的情绪卡不会被删掉）
  const r = compiler.validateOnly(makeReq({ shot: { emotions: null }, emotion_map: null }));
  assert.equal(r.ok, false);
  assert.equal(r.code, ERR.MISSING_EMOTION_CARD);
});

test('编译器：分镜图（image）同样强制情绪，不等到视频才用', () => {
  const r = compiler.validateOnly(makeReq({
    kind: 'image',
    shot: { first_frame_url: null },
    options: { purpose: 'preview', allow_pending_reference: true, pending_plan: [{ role: 'character' }] },
  }));
  assert.equal(r.ok, true, `分镜图编译失败: ${r.code} ${r.message ?? ''}`);
  const p = compiler.compile(makeReq({ kind: 'image' }));
  assert.ok(p.prompt_en.includes('Performance lock, highest priority'));
  assert.equal(p.cards.emotion.CH01, EM);
});

test('资产库：情绪卡固化为角色表演资产，可调色板、可版本化', () => {
  const P = EM_P;
  const a = assetLibrary.createEmotion({
    projectId: P, emotionCode: EM, characterCode: 'CH01', name: '林默·压抑的暴怒',
    lockValues: { jaw: 'jaw clenched with a faint scar pulling white at the hinge' },
  });
  assert.equal(a.asset_type, 'emotion');
  assert.equal(a.asset_code, 'EM01');
  assert.equal(a.status, 'ready');
  assert.ok(a.locks.length >= 4, '至少 4 条表演锁');
  assert.equal(a.lock_values.jaw, 'jaw clenched with a faint scar pulling white at the hinge');
  assert.equal(a.meta.emotion_card, EM);
  assert.equal(a.meta.intensity, 4);
  assert.ok(a.meta.micro_timeline.length >= 2);
  assert.deepEqual(assetLibrary.emotionsOf(P, 'CH01').map((x) => x.asset_code), ['EM01']);

  // 角色情绪档案：上游规划只能从调色板里挑情绪
  assetLibrary.create({ projectId: P, assetType: 'character', name: '林默', locks: ['a', 'b', 'c', 'd'] });
  assetLibrary.setEmotionPalette(P, 'CH01', {
    baseline: 'EMO-CALM-02',
    palette: ['EMO-CALM-02', 'EMO-DEFIANCE-04', EM],
    forbid: ['EMO-FRENZY-05'],
  });
  const prof = assetLibrary.emotionPaletteOf(P, 'CH01');
  assert.deepEqual(prof.palette, ['EMO-CALM-02', 'EMO-DEFIANCE-04', EM]);
  assert.deepEqual(prof.forbid, ['EMO-FRENZY-05']);
  assert.equal(prof.is_default, undefined);
});
