/**
 * V3.2 第 2 组验收：导演视听总谱前置到「剧本生成 + 分镜图生成」之前。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import storyEngine from '../src/pipeline/StoryEngine.js';
import directorPlanEngine from '../src/pipeline/DirectorPlan.js';
import seeds from '../src/seeds/loader.js';
import compiler from '../src/compiler/PromptCompiler.js';
import { ERR } from '../src/core/errors.js';

const SPEC = {
  style_code: 'STY-XUANYI', director_code: 'DIR-NOIR',
  aspect: '9:16', quality: '1080p', total_minutes: 10, episode_sec: 90,
};

async function chain(spec = SPEC) {
  const { outline } = await storyEngine.outline({ userId: 'plan_test', projectId: 'plan_proj', prompt: '废柴少年觉醒龙魂，在全城羞辱后逆袭归来', spec });
  const plan = storyEngine.directorPlan({ outline, spec });
  const script = await storyEngine.script({ outline, plan, spec });
  const sb = await storyEngine.storyboard({ outline, spec, plan, script });
  return { outline, plan, script, sb };
}

test('N02.5：总谱在剧本之前产出，且五项视听标注逐拍定死', async () => {
  const { outline, plan } = await chain();
  assert.equal(plan.stage, 'N02.5');
  assert.equal(plan.plan_version, '3.2');
  assert.ok(plan.plan_id);
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation.problems.slice(0, 3)));
  assert.equal(plan.episodes.length, outline.episodes.length);

  let beats = 0;
  for (const ep of plan.episodes) {
    for (const b of ep.beats) {
      beats += 1;
      assert.ok(seeds.shot(b.shot_card), `${b.beat_no} 镜别无效`);
      assert.ok(seeds.shot(b.camera_move), `${b.beat_no} 运镜无效`);
      assert.ok(b.lighting_codes.length >= 1, `${b.beat_no} 缺光影`);
      for (const l of b.lighting_codes) assert.ok(seeds.lighting(l));
      assert.ok(seeds.transition(b.transition), `${b.beat_no} 转场无效`);
      assert.ok(b.rhythm_code === null || seeds.rhythm(b.rhythm_code), `${b.beat_no} 节奏码无效`);
      assert.ok(Object.keys(b.emotions).length >= 1, `${b.beat_no} 缺情绪卡`);
      for (const c of Object.values(b.emotions)) assert.ok(seeds.emotion(c));
      assert.ok(b.duration_sec > 0 && b.duration_sec <= 10);
      assert.ok(b.bgm_mood.length >= 1);
    }
  }
  assert.ok(beats >= 80, `总谱应覆盖全片节拍，实际 ${beats}`);
  assert.equal(plan.validation.stats.emotion_jumps, 0, '情绪强度不得跳变超过 2');
});

test('N02.5：总谱自检会拦住不合格规划（缺光影 / 情绪跳变 / 超配额）', async () => {
  const { plan } = await chain();
  const broken = structuredClone(plan);
  broken.episodes[0].beats[0].lighting_codes = [];
  const r1 = directorPlanEngine.validate(broken);
  assert.equal(r1.ok, false);
  assert.ok(r1.problems.some((p) => p.issue.includes('光影')));

  const broken2 = structuredClone(plan);
  broken2.episodes[0].beats[2].emotions = { CH01: 'EMO-CALM-02' };
  broken2.episodes[0].beats[3].emotions = { CH01: 'EMO-FRENZY-05' };
  const r2 = directorPlanEngine.validate(broken2);
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => p.issue.includes('情绪强度跃迁')));
});

test('N03：剧本严格按总谱场次写，不增删不改写视听标注', async () => {
  const { plan, script } = await chain();
  assert.equal(script.plan_id, plan.plan_id);
  const beatNos = plan.episodes.flatMap((e) => e.beats.map((b) => b.beat_no));
  const sceneNos = script.episodes.flatMap((e) => e.scenes.map((s) => s.beat_no));
  assert.deepEqual(sceneNos, beatNos, '剧本场次必须与总谱拍点一一对应');

  const beatMap = new Map(plan.episodes.flatMap((e) => e.beats.map((b) => [b.beat_no, b])));
  for (const sc of script.episodes.flatMap((e) => e.scenes)) {
    const b = beatMap.get(sc.beat_no);
    assert.equal(sc.locked.shot_card, b.shot_card, `${sc.beat_no} 剧本私改镜别`);
    assert.equal(sc.locked.transition, b.transition, `${sc.beat_no} 剧本私改转场`);
    assert.deepEqual(sc.locked.emotions, b.emotions, `${sc.beat_no} 剧本私改情绪`);
    for (const d of sc.dialogue) {
      assert.ok(d.speaker && d.line.length <= 15, '对白必须短且绑定说话人');
    }
  }
  // 集末 3 秒留白：不给对白
  for (const ep of script.episodes) {
    assert.deepEqual(ep.scenes[ep.scenes.length - 1].dialogue, []);
  }
});

test('N03：总谱不合格时剧本与分镜图都被拒绝（不带着坏规划往下花算力）', async () => {
  const { outline, plan } = await chain();
  const broken = structuredClone(plan);
  broken.episodes[0].beats[0].lighting_codes = [];
  broken.validation = directorPlanEngine.validate(broken);
  await assert.rejects(
    () => storyEngine.script({ outline, plan: broken, spec: SPEC }),
    (e) => e.code === ERR.PLAN_NOT_APPROVED
  );
  await assert.rejects(
    () => storyEngine.storyboard({ outline, spec: SPEC, plan: broken }),
    (e) => e.code === ERR.PLAN_NOT_APPROVED
  );
});

test('N05：分镜图阶段就带齐情绪/镜别/光影/转场/节奏，可直接编译', async () => {
  const { outline, plan, sb } = await chain();
  assert.equal(sb.plan_id, plan.plan_id);
  assert.equal(sb.plan_validation.ok, true);
  assert.equal(sb.shots.length, plan.stats.beats);

  const beatMap = new Map(plan.episodes.flatMap((e) => e.beats.map((b) => [b.beat_no, b])));
  for (const s of sb.shots) {
    const b = beatMap.get(s.beat_no);
    assert.equal(s.shot_card, b.shot_card);
    assert.equal(s.transition, b.transition);
    assert.deepEqual(s.lighting_codes, b.lighting_codes);
    assert.deepEqual(s.emotions, b.emotions, `${s.no} 分镜没有继承总谱情绪`);
    assert.ok(s.rhythm !== undefined);
  }

  // 拿「分镜图」这一阶段的数据直接做 image 编译：情绪必须在出图前就进提示词
  const assets = {
    characters: Object.fromEntries(outline.characters.slice(0, 2).map((c) => [c.code, {
      asset_code: c.code, name: c.name, image_url: `cos://${c.code}.png`, locks: c.locks,
    }])),
    scenes: {}, props: {},
  };
  const first = sb.shots[0];
  const p = compiler.compile({
    kind: 'image',
    shot_no: first.no,
    available_credits: 99999,
    project: SPEC,
    shot: {
      duration: first.duration, shot_card: first.shot_card, camera_move: first.camera_move,
      characters: first.characters, emotions: first.emotions, offscreen: [],
      action_start: 'a', action_end: 'b', ambient: [], ambient_sound: null, music_entry: 'No music',
    },
    lighting: { codes: first.lighting_codes },
    transition: { code: first.transition, reason: first.transition_reason ?? undefined },
    assets,
    model: 'IMG-DEFAULT',
  });
  assert.ok(p.prompt_en.includes('Performance lock, highest priority'), '分镜图提示词必须强调情绪');
  assert.equal(p.cards.emotion.CH01, first.emotions.CH01);
  assert.ok(p.cards.lighting.includes('LIG-LOWKEY'));
  assert.ok(p.cards.transition === first.transition);
});

test('N02.5：情绪资产参与构图（部分镜别由情绪卡亲和反推）', async () => {
  const { plan } = await chain();
  let hit = 0;
  let total = 0;
  for (const ep of plan.episodes) {
    for (const b of ep.beats) {
      const code = Object.values(b.emotions)[0];
      const card = seeds.emotion(code);
      if (!card?.shot_affinity?.length) continue;
      total += 1;
      if (card.shot_affinity.includes(b.shot_card)) hit += 1;
    }
  }
  assert.ok(total > 0);
  assert.ok(hit / total > 0.2, `情绪亲和命中率过低 ${hit}/${total}`);
});

test('全 32 风格：总谱自检均通过（导演级规则提前生效，不留到视频阶段）', async () => {
  const bad = [];
  for (const st of seeds.stylePresets) {
    const spec = { ...SPEC, style_code: st.code };
    const { outline } = await storyEngine.outline({
      userId: 'plan_all', projectId: 'plan_all', prompt: '废柴逆袭，全城羞辱后觉醒', spec,
    });
    const plan = storyEngine.directorPlan({ outline, spec });
    if (!plan.validation.ok) bad.push(`${st.code}: ${plan.validation.problems[0]?.issue}`);
  }
  assert.deepEqual(bad, [], bad.slice(0, 5).join(' | '));
});
