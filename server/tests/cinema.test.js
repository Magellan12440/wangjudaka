/**
 * V4.2 第 4 / 5 组验收：大师语法配方库 + 分发四步闭环。
 *
 * 这一组测的是「用户看得见的效果」而不是内部实现：
 *   1. 每一条配方都必须真的能被抽到（否则库里躺着的卡等于没有）
 *   2. 总谱里带 grammar 的节拍必须引用真实存在的卡，且不破坏既有自检
 *   3. 编译器必须把 grammar 拼进提示词；传错 code 必须报错而不是静默忽略
 *   4. 分发四步（上传/审核/合同/提现）随状态真实推进，不是写死的文案
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import storyEngine from '../src/pipeline/StoryEngine.js';
import directorPlanEngine from '../src/pipeline/DirectorPlan.js';
import seeds from '../src/seeds/loader.js';
import compiler from '../src/compiler/PromptCompiler.js';
import { makeReq } from './helpers.js';
import { distributionHub } from '../src/distribution/DistributionHub.js';

const SPEC = {
  style_code: 'STY-XUANYI', aspect: '9:16', quality: '1080p',
  total_minutes: 10, episode_sec: 90,
};

async function chain(spec = SPEC) {
  const { outline } = await storyEngine.outline({
    userId: 'cinema_test', projectId: 'cinema_proj',
    prompt: '废柴少年觉醒龙魂，在全城羞辱后逆袭归来', spec,
  });
  return { outline, plan: storyEngine.directorPlan({ outline, spec }) };
}

test('配方库：每条配方字段齐备，且引用的卡都真实存在', () => {
  const recipes = seeds.cinemaGrammar.recipes;
  assert.ok(recipes.length >= 20, `配方数 ${recipes.length}`);
  for (const r of recipes) {
    assert.ok(r.code.startsWith('GRM-'), `${r.code} 前缀不对`);
    assert.ok(r.intent, `${r.code} 缺 intent`);
    assert.ok(r.why && r.why.length > 10, `${r.code} 缺 why`);
    assert.ok(seeds.shot(r.shot), `${r.code} 镜别无效`);
    assert.equal(seeds.shot(r.move)?.dim, 'movement', `${r.code} 运镜必须是 movement 维度`);
    assert.ok(seeds.composition(r.composition), `${r.code} 构图卡无效`);
    assert.ok(seeds.atmosphere(r.atmosphere), `${r.code} 氛围卡无效`);
    assert.ok(seeds.lens(r.lens), `${r.code} 焦段卡无效`);
    assert.ok(seeds.colorGrade(r.color), `${r.code} 调色卡无效`);
    assert.ok(seeds.transition(r.transition), `${r.code} 转场卡无效`);
    assert.ok(r.lighting.length >= 1, `${r.code} 缺光影`);
    for (const l of r.lighting) assert.ok(seeds.lighting(l), `${r.code} 光影卡无效 ${l}`);
  }
});

test('配方库：每个题材风格都能抽到专属配方，美术风格不被饿死', () => {
  const all = seeds.cinemaGrammar.recipes;
  for (const s of seeds.stylePresets) {
    const pool = seeds.recipesForStyle(s.code);
    assert.ok(pool.length >= 3, `${s.code} 只有 ${pool.length} 条配方`);
    // 结构性配方（styles 为空）对所有风格开放
    const structural = pool.filter((r) => !(r.styles ?? []).length);
    assert.ok(structural.length >= 1, `${s.code} 缺结构性配方`);
  }
  // 美术风格不做题材筛选：全库开放
  assert.equal(seeds.recipesForStyle('STY-3DANIME').length, all.length);
  // 题材风格必须被过滤（古风不该抽到霓虹雨夜）
  const gufeng = seeds.recipesForStyle('STY-GUFENG').map((r) => r.code);
  assert.ok(!gufeng.includes('GRM-NEON-RAIN'), '古风不应命中赛博配方');
  assert.ok(gufeng.includes('GRM-ROBE-ENTRANCE'), '古风应命中衣袂登场');
});

test('总谱：结构性节拍带 grammar，且自检仍通过', async () => {
  const { plan } = await chain();
  assert.equal(plan.validation.ok, true, JSON.stringify(plan.validation.problems.slice(0, 3)));
  assert.ok(plan.stats.recipe_beats > 0, '一条配方都没抽到');
  assert.ok(plan.stats.recipe_beats < plan.stats.beats, '不该每一拍都套配方');

  let grammarBeats = 0;
  for (const ep of plan.episodes) {
    for (const b of ep.beats) {
      if (!b.grammar) continue;
      grammarBeats += 1;
      const g = b.grammar;
      assert.ok(seeds.recipe(g.recipe), `${b.beat_no} 配方无效`);
      assert.ok(seeds.composition(g.composition), `${b.beat_no} 构图无效`);
      assert.ok(seeds.atmosphere(g.atmosphere), `${b.beat_no} 氛围无效`);
      assert.ok(seeds.colorGrade(g.color), `${b.beat_no} 调色无效`);
      assert.ok(g.lens === null || seeds.lens(g.lens), `${b.beat_no} 焦段无效`);
      assert.ok(g.intent, `${b.beat_no} 缺意图`);
      assert.ok(seeds.lighting(g.lighting ?? seeds.recipe(g.recipe).lighting[0]));
    }
    // 集末必须是定格收尾
    const last = ep.beats[ep.beats.length - 1];
    assert.equal(last.transition, 'TRN-FREEZE', `EP${ep.no} 集末不是定格`);
    if (last.grammar) assert.equal(last.grammar.recipe, 'GRM-FREEZE-END');
    // 开场保持远景建置：配方不许把开场改成特写
    assert.equal(ep.beats[0].shot_card, 'SHT-WS', `EP${ep.no} 开场镜别被配方改坏`);
  }
  assert.equal(grammarBeats, plan.stats.recipe_beats);
  // 同一集内不重复同一配方
  for (const ep of plan.episodes) {
    const codes = ep.beats.map((b) => b.grammar?.recipe).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length, `EP${ep.no} 配方重复`);
  }
});

test('总谱：配方的光影不得踩风格禁忌，强制光影一张都不能丢', async () => {
  for (const styleCode of ['STY-CYBER', 'STY-GUFENG', 'STY-DAOMU']) {
    const spec = { ...SPEC, style_code: styleCode };
    const { plan } = await chain(spec);
    const style = seeds.style(styleCode);
    const forbidden = new Set(style.lighting_cards_forbidden ?? []);
    for (const ep of plan.episodes) {
      for (const b of ep.beats) {
        for (const l of b.lighting_codes) {
          assert.ok(!forbidden.has(l), `${styleCode} ${b.beat_no} 用了禁忌光影 ${l}`);
        }
        for (const must of style.lighting_cards_required) {
          if (forbidden.has(must)) continue;
          assert.ok(b.lighting_codes.includes(must), `${styleCode} ${b.beat_no} 丢了强制光影 ${must}`);
        }
      }
    }
  }
});

test('编译器：grammar 拼进提示词，四类卡都进英文段', () => {
  const base = makeReq();
  const p = compiler.compile({
    ...base,
    grammar: {
      recipe: 'GRM-VERTIGO',
      composition: 'CMP-CENTER',
      lens: 'LNS-85MM',
      color: 'CLR-DESAT',
      atmosphere: 'ATM-DUST',
      shot_card: base.shot.shot_card,
    },
  });
  assert.equal(p.cards.recipe, 'GRM-VERTIGO');
  assert.equal(p.cards.composition, 'CMP-CENTER');
  assert.equal(p.cards.lens, 'LNS-85MM');
  assert.equal(p.cards.color, 'CLR-DESAT');
  assert.equal(p.cards.atmosphere, 'ATM-DUST');
  assert.ok(p.prompt_en.includes('dead-center composition'), '构图卡没进英文提示词');
  assert.ok(p.prompt_en.includes('85mm'), '焦段卡没进英文提示词');
  assert.ok(p.prompt_en.includes('desaturated') || p.prompt_en.includes('desatur'), '调色卡没进英文提示词');
  assert.ok(p.prompt_en.includes('dust motes'), '氛围卡没进英文提示词');
  // 中文审阅串里要能看到配方名与意图，方便用户核对"为什么这么拍"
  assert.ok(p.prompt_zh.includes('眩晕推拉'));
  assert.ok(p.prompt_zh.includes('认知崩塌'));
});

test('编译器：不传 grammar 时与旧行为完全一致（零影响）', () => {
  const base = makeReq();
  const noGrammar = compiler.compile(base);
  assert.equal(noGrammar.cards.recipe, null);
  assert.equal(noGrammar.cards.composition, null);
  assert.ok(!noGrammar.prompt_en.includes('dead-center composition'));
  // 同一请求重复编译必须得到同样的提示词（不引入随机）
  const again = compiler.compile(base);
  assert.equal(again.prompt_en, noGrammar.prompt_en);
});

test('编译器：非法配方 / 非法构图直接报错，不静默兜底', () => {
  const base = makeReq();
  assert.throws(
    () => compiler.compile({ ...base, grammar: { recipe: 'GRM-NOT-EXIST' } }),
    (e) => e.code === 'MISSING_DIRECTOR_CARD'
  );
  assert.throws(
    () => compiler.compile({ ...base, grammar: { composition: 'CMP-NOPE' } }),
    (e) => e.code === 'MISSING_DIRECTOR_CARD'
  );
});

test('分发：四步闭环随状态真实推进', () => {
  const d = distributionHub.create({
    projectId: 'dist_proj', episodeNo: 'E01', platformCode: 'PLT-HONGGUO', userId: 'u1',
  });
  const stepOf = (rec) => Object.fromEntries(distributionHub.stepsFor(rec).map((s) => [s.key, s.state]));

  let s = stepOf(d);
  assert.equal(s.distribute, 'current');
  assert.equal(s.review, 'todo');
  assert.equal(s.contract, 'todo');
  assert.equal(s.withdraw, 'todo');

  distributionHub.updateStatus(d.id, '审核中');
  s = stepOf(distributionHub.listWithSteps('dist_proj')[0]);
  assert.equal(s.distribute, 'done');
  assert.equal(s.review, 'current');

  distributionHub.updateStatus(d.id, '已通过');
  s = stepOf(distributionHub.listWithSteps('dist_proj')[0]);
  assert.equal(s.review, 'done');
  assert.equal(s.contract, 'current', '审核通过后该推着去签合同');

  distributionHub.recordRevenue(d.id, { amount: 1200 });
  s = stepOf(distributionHub.listWithSteps('dist_proj')[0]);
  assert.equal(s.withdraw, 'done');
});

test('分发：合同登记后清单打勾、状态推进，且不重复登记', () => {
  const d = distributionHub.create({
    projectId: 'dist_proj2', episodeNo: 'E01', platformCode: 'PLT-DOUYIN', userId: 'u2',
  });
  const signed = distributionHub.signContract(d.id, { contractNo: 'DY-2026-0001' });
  assert.equal(signed.contract.signed, true);
  assert.equal(signed.contract.contract_no, 'DY-2026-0001');
  assert.ok(signed.contract.signed_at);
  assert.equal(signed.status, '待上传', '签完合同应推进到待上传');
  const item = signed.checklist.find((c) => c.key === 'contract');
  assert.equal(item.done, true, '合同项必须在清单里打勾');

  const again = distributionHub.signContract(d.id, { contractNo: 'DY-OTHER' });
  assert.equal(again.contract.contract_no, 'DY-2026-0001', '重复登记不应覆盖原始签署记录');
  assert.equal(again.contract.already, true);
});

test('分发：被驳回时审核步骤标红，且四步状态互斥可解释', () => {
  const d = distributionHub.create({
    projectId: 'dist_proj3', episodeNo: 'E01', platformCode: 'PLT-KUAISHOU', userId: 'u3',
  });
  distributionHub.updateStatus(d.id, '审核中');
  distributionHub.updateStatus(d.id, '被驳回', { reject_reason: 'AI 标识不合规' });
  const rec = distributionHub.listWithSteps('dist_proj3')[0];
  const step = distributionHub.stepsFor(rec).find((s) => s.key === 'review');
  assert.equal(step.state, 'blocked');
  assert.ok(step.action.includes('驳回'));
  assert.equal(rec.reject_reason, 'AI 标识不合规', '驳回原因必须留存');
});

test('总谱自检：配方不会破坏转场配额与最小间隔', async () => {
  const { plan } = await chain();
  for (const ep of plan.episodes) {
    let nonHard = 0;
    let lastAt = -Infinity;
    let t = 0;
    for (const b of ep.beats) {
      if (b.transition !== 'TRN-HARDCUT' && b.transition !== 'TRN-FREEZE') {
        nonHard += 1;
        assert.ok(t - lastAt >= 8.5, `EP${ep.no} ${b.beat_no} 非硬切间隔不足 8.5s`);
        lastAt = t;
      }
      t += b.duration_sec;
    }
    assert.ok(nonHard <= ep.transition_quota.max_non_hard,
      `EP${ep.no} 非硬切 ${nonHard} 超配额 ${ep.transition_quota.max_non_hard}`);
  }
  // validate 的二次确认
  assert.equal(directorPlanEngine.validate(plan).ok, true);
});
