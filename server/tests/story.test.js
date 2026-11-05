import { test } from 'node:test';
import assert from 'node:assert/strict';
import storyEngine from '../src/pipeline/StoryEngine.js';
import ledger from '../src/ledger/Ledger.js';
import compiler from '../src/compiler/PromptCompiler.js';
import creationDocs from '../src/docs/CreationDocs.js';

const U = 'u_story';
const P = 'proj_story';

const SPEC = {
  style_code: 'STY-XUANYI',
  director_code: 'DIR-NOIR',
  aspect: '9:16',
  quality: '1080p',
  total_minutes: 10,
  episode_sec: 90,
};

test('准备：充值', () => {
  ledger.recharge({ userId: U, points: 3000, idemKey: 'story-1' });
  assert.ok(ledger.balance(U) >= 3000);
});

test('N02 大纲：产出结构（模型不可用时走兜底，仍合规）', async () => {
  const { outline, fromModel } = await storyEngine.outline({
    userId: U, projectId: P, prompt: '废柴少年觉醒龙魂，在全城羞辱后逆袭归来', spec: SPEC,
  });
  assert.ok(outline.episodes.length >= 6, `集数 ${outline.episodes.length}`);
  assert.ok(outline.characters.length >= 2);
  for (const c of outline.characters) assert.ok(c.locks.length >= 4, '角色锁至少 4 条');
  assert.equal(typeof fromModel, 'boolean');
});

test('N04 节奏闸门：兜底大纲直接达标', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const g = storyEngine.rhythmGate(outline);
  assert.equal(g.passed, true, JSON.stringify(g.report?.gates));
});

test('N04 短剧（5 分钟 / 4 集）也必须过节奏闸门', async () => {
  const spec = { ...SPEC, total_minutes: 5 };
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: '短剧也要有反转', spec });
  assert.equal(outline.episodes.length, 4);
  const g = storyEngine.rhythmGate(outline);
  assert.equal(g.passed, true, JSON.stringify(g.report?.gates));
  const reversals = outline.episodes.reduce((a, e) => a + (e.reversals?.length ?? 0), 0);
  assert.ok(reversals >= 3, `反转数 ${reversals}`);
});

test('N05 分镜：每镜字段齐备，能一次过编译器 12 校验', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const sb = await storyEngine.storyboard({ outline, spec: SPEC });
  assert.ok(sb.shots.length > 0);
  // V3.2：分镜图阶段每镜就必须带齐情绪卡与总谱标注，不等到视频生成
  assert.ok(sb.plan_id, '分镜必须引用导演总谱 plan_id');
  assert.equal(sb.plan_validation?.ok, true, '导演总谱自检必须通过');
  for (const s of sb.shots) {
    assert.ok(s.emotions && Object.keys(s.emotions).length > 0, `${s.no} 缺情绪卡`);
    assert.ok(s.lighting_codes?.length, `${s.no} 缺光影卡`);
    assert.ok(s.shot_card && s.transition, `${s.no} 缺镜别或转场`);
  }

  // 用第一集前几镜做编译校验（含资产引用）
  const assets = {
    characters: Object.fromEntries(outline.characters.map((c) => [c.code, {
      asset_code: c.code, name: c.name, image_url: `cos://${c.code}.png`, locks: c.locks,
    }])),
    scenes: {}, props: {},
  };
  let checked = 0;
  for (const s of sb.shots.slice(0, 5)) {
    const r = compiler.validateOnly({
      kind: 'video',
      shot_no: s.no,
      available_credits: 99999,
      project: { style_code: SPEC.style_code, director_code: SPEC.director_code, aspect: SPEC.aspect, quality: SPEC.quality },
      shot: {
        duration: s.duration, shot_card: s.shot_card, camera_move: s.camera_move,
        characters: s.characters, scene: null, props: [], offscreen: [],
        action_start: 'a', action_end: 'b', ambient: s.ambient,
        ambient_sound: s.ambient_sound, music_entry: s.music_entry,
        emotions: s.emotions,
        first_frame_url: `cos://${s.no}.png`,
      },
      lighting: { codes: s.lighting_codes },
      transition: { code: s.transition, reason: s.transition_reason ?? undefined },
      assets,
      model: 'VID-CHEAP',
    });
    assert.equal(r.ok, true, `${s.no} 编译失败: ${r.code} ${r.message ?? ''}`);
    checked += 1;
  }
  assert.ok(checked >= 3);
});

test('分镜时长总和接近目标总时长', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const sb = await storyEngine.storyboard({ outline, spec: SPEC });
  const target = SPEC.total_minutes * 60;
  const diff = Math.abs(sb.stats.total_sec - target) / target;
  assert.ok(diff < 0.25, `偏差 ${(diff * 100).toFixed(1)}%`);
});

test('集末镜头带钩子与定格转场', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const sb = await storyEngine.storyboard({ outline, spec: SPEC });
  const ends = sb.shots.filter((s) => s.is_episode_end);
  assert.ok(ends.length >= 1);
  for (const e of ends) {
    assert.ok(e.ending_hook);
    assert.equal(e.transition, 'TRN-FREEZE');
  }
});

test('角色草稿可转成资产（锁数达标）', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const drafts = storyEngine.toAssetDrafts(outline);
  assert.ok(drafts.length >= 2);
  for (const d of drafts) assert.ok(d.locks.length >= 4);
});

test('分镜写入创作文档后跨文档体检不报致命错误', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const sb = await storyEngine.storyboard({ outline, spec: SPEC });
  creationDocs.save({ projectId: P, type: 'characters', content: { items: outline.characters } });
  creationDocs.save({ projectId: P, type: 'storyboard', content: sb });
  const r = creationDocs.check(P);
  const fatal = r.errors.filter((e) => ['CHAR_NOT_IN_CARDS', 'LIGHTING_MISSING', 'SHOT_CARD_MISSING'].includes(e.code));
  assert.equal(fatal.length, 0, JSON.stringify(r.errors.slice(0, 5)));
});
