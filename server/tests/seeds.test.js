import { test } from 'node:test';
import assert from 'node:assert/strict';
import seeds from '../src/seeds/loader.js';

test('种子库完整性：数量与交叉引用均正确', () => {
  const r = seeds.validate();
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('七大库数量符合方案书 §18.1', () => {
  assert.equal(seeds.stylePresets.length, 32);
  assert.equal(seeds.directorProfiles.length, 6);
  assert.equal(seeds.shotCards.length, 38);
  assert.equal(seeds.transitionCards.length, 27);
  assert.equal(seeds.lightingCards.length, 42);
  assert.equal(seeds.rhythmTemplates.length, 44);
});

test('节奏模板四类齐全：hook12 / conflict10 / reversal12 / empathy10', () => {
  assert.equal(seeds.rhythmByCat('hook').length, 12);
  assert.equal(seeds.rhythmByCat('conflict').length, 10);
  assert.equal(seeds.rhythmByCat('reversal').length, 12);
  assert.equal(seeds.rhythmByCat('empathy').length, 10);
});

test('镜头卡五维齐全', () => {
  for (const dim of ['distance', 'height', 'orientation', 'lens', 'movement']) {
    assert.ok(seeds.shotsByDim(dim).length > 0, `缺维度 ${dim}`);
  }
});

test('转场卡分画面内与后期两类', () => {
  const inCam = seeds.transitionCards.filter((t) => t.kind === 'in_camera');
  const post = seeds.transitionCards.filter((t) => t.kind === 'post');
  assert.equal(inCam.length, 12);
  assert.equal(post.length, 15); // §7.2 含硬切共 15 条后期转场
});

test('曲库授权字段红线：五字段齐全且可商用', () => {
  const ok = seeds.licensableBgm();
  assert.ok(ok.length > 0);
  for (const t of ok) {
    for (const f of ['license', 'attribution_required', 'commercial_use', 'content_id_registered', 'verified_at']) {
      assert.notEqual(t[f], undefined, `${t.track_id} 缺 ${f}`);
    }
    assert.equal(t.commercial_use, true);
  }
});

test('模型注册表：不可商用模型可被识别', () => {
  const f5 = seeds.model('TTS-OPEN-F5');
  assert.equal(f5.commercial_ok, false);
  assert.equal(seeds.modelsByRole('audio', { commercialOnly: true }).some((m) => m.code === 'TTS-OPEN-F5'), false);
});

test('风格预设的强制光影卡与导演原型可解析', () => {
  const s = seeds.style('STY-XUANYI');
  assert.ok(s.lighting_cards_required.includes('LIG-LOWKEY'));
  assert.equal(s.director_profile_default, 'DIR-NOIR');
  assert.ok(seeds.director('DIR-NOIR'));
});
