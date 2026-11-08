/**
 * V4.11 五维一致性：角色 / 道具 / 场景 / 内容 / 声音字幕。
 *
 * 这一组的关键不是"能不能报错"，而是**每一维都能单独把生成拦住**：
 * 五条规则里只要有一条形同虚设，用户就会拿到"脸变了 / 道具变了 / 声音换了"的成片。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import { guardCompile, consistencyGuard, DIMENSIONS, syncRuleOf } from '../src/qc/ConsistencyGuard.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import { makeReq } from './helpers.js';
import { ERR } from '../src/core/errors.js';

const BASE = `proj_cg_${Date.now()}`;

test('五维定义齐全，且顺序稳定（前端按这个顺序展示）', () => {
  assert.deepEqual(DIMENSIONS.map((d) => d.key), ['character', 'prop', 'scene', 'content', 'audio_subtitle']);
  for (const d of DIMENSIONS) {
    assert.ok(d.name && d.what, `${d.key} 缺中文名或说明`);
  }
});

test('编译期：合格的镜头请求五维全过', () => {
  const r = guardCompile(makeReq());
  assert.equal(r.ok, true, r.hard.join('；'));
  for (const dim of Object.values(r.dims)) assert.equal(dim.ok, true);
});

test('角色一致性：锁不足直接拦（不是警告）', () => {
  const req = makeReq();
  req.assets.characters.CH01.locks = ['pine-green lapel service jacket'];
  const r = guardCompile(req);
  assert.equal(r.ok, false);
  assert.equal(r.dims.character.ok, false);
  assert.match(r.hard.join(), /连续性锁不足/);
});

test('角色一致性：没有资产卡等于没有视觉依据', () => {
  const req = makeReq();
  delete req.assets.characters.CH01;
  const r = guardCompile(req);
  assert.equal(r.dims.character.ok, false);
});

test('道具一致性：镜头点名了但没建卡，必须拦', () => {
  const req = makeReq();
  delete req.assets.props.PR01;
  const r = guardCompile(req);
  assert.equal(r.dims.prop.ok, false);
  assert.match(r.hard.join(), /道具 PR01/);
});

test('场景一致性：同一处景没有场景卡，每镜都会重新想象', () => {
  const req = makeReq();
  delete req.assets.scenes.SC01B;
  const r = guardCompile(req);
  assert.equal(r.dims.scene.ok, false);
});

test('声音字幕一致性：对白超出字幕规则容量就拦（否则一定糊屏）', () => {
  const rule = syncRuleOf('SYN-SHORT');
  const cap = rule.max_chars_per_line * rule.max_lines;
  const req = makeReq();
  req.libraries = { sync: 'SYN-SHORT' };   // 用户在导演面板指定的字幕档位
  req.shot.duration = 10;
  req.shot.dialogue = '你'.repeat(cap + 1);
  const r = guardCompile(req);
  assert.equal(r.dims.audio_subtitle.ok, false);
  assert.match(r.hard.join(), /字幕最多/);
});

test('内容一致性：情绪卡不存在 / 有对白没说话人，都要拦', () => {
  const bad = makeReq();
  bad.shot.emotions = { CH01: 'EMO-NOT-EXIST' };
  assert.equal(guardCompile(bad).dims.content.ok, false);

  const noSpeaker = makeReq();
  noSpeaker.shot.speaker = null;
  assert.equal(guardCompile(noSpeaker).dims.content.ok, false);
});

/** 造一个真实落库的项目：角色 / 场景 / 道具 + 一份与分镜同源的总谱 */
function mkProjectWithAssets() {
  const projectId = `${BASE}_${Math.random().toString(36).slice(2, 6)}`;
  db.insert('projects', {
    id: projectId, user_id: 'u_cg', title: '一致性样本',
    spec: { style_code: 'STY-DUSHI' }, created_at: new Date().toISOString(),
  });
  assetLibrary.create({
    projectId, assetType: 'character', name: '林默',
    locks: ['lean face', 'short black hair', 'pine-green jacket', 'silver earring'],
    imageUrl: 'cos://asset/CH01.png',
  });
  assetLibrary.create({
    projectId, assetType: 'scene', name: '审讯室',
    locks: ['single desk lamp', 'concrete wall', 'window on the left'],
    imageUrl: 'cos://asset/SC01.png',
  });
  assetLibrary.create({
    projectId, assetType: 'prop', name: '银色打火机',
    locks: ['scratched chrome', 'matte silver shell', 'initials on the lid'],
    imageUrl: 'cos://asset/PR01.png',
  });

  const beat = {
    beat_no: 'E01-B01',
    shot_card: 'SHT-MCU', camera_move: 'SHT-PUSH',
    lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT',
    rhythm_code: 'HOOK-01', emotions: { CH01: 'EMO-CALM-02' },
  };
  const shot = {
    no: 'E01-S001', beat_no: 'E01-B01', episode: 1, duration: 4,
    shot_card: 'SHT-MCU', camera_move: 'SHT-PUSH',
    lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT',
    rhythm: 'HOOK-01', emotions: { CH01: 'EMO-CALM-02' },
    characters: ['CH01'], scene: 'SC01', props: ['PR01'],
    dialogue: null, speaker: null,
  };
  db.insert('director_plans', {
    id: `dplan_${projectId}`, project_id: projectId, plan_id: `plan_${projectId}`,
    plan: { plan_id: `plan_${projectId}`, episodes: [{ no: 1, beats: [beat] }], global: {} },
    storyboard: { shots: [shot] },
    created_at: new Date().toISOString(),
  });
  return { projectId, shot };
}

test('声音一致性：每个角色自动补一份固定声线，且不重复补', () => {
  const { projectId } = mkProjectWithAssets();
  const first = consistencyGuard.ensureVoiceAssets(projectId);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].character_code, 'CH01');

  const second = consistencyGuard.ensureVoiceAssets(projectId);
  assert.equal(second.created.length, 0, '第二次不该重复建声线');
  assert.equal(Object.values(second.voices).length, 1);

  const voices = db.find('assets', (a) => a.project_id === projectId && a.asset_type === 'voice');
  assert.equal(voices.length, 1);
  assert.equal(voices[0].meta.character_code, 'CH01');
  assert.ok((voices[0].locks ?? []).length >= 3);
});

test('全片体检：五维各出一条结论，KPI 可量化', () => {
  const { projectId } = mkProjectWithAssets();
  const r = consistencyGuard.audit(projectId);
  assert.equal(r.dimensions.length, 5);
  assert.equal(r.kpi.total, 1);
  assert.equal(r.kpi.ok, true, JSON.stringify(r.dimensions.filter((d) => !d.ok)));
  assert.equal(r.kpi.pass_rate, 1);
});

test('全片体检：镜头情绪被偷偷改掉 → 内容一致性失败并指出具体镜号', () => {
  const { projectId, shot } = mkProjectWithAssets();
  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  shot.emotions = { CH01: 'EMO-RAGE-SUPPRESSED-04' };
  db.update('director_plans', rec.id, { storyboard: { shots: [shot] } });

  const r = consistencyGuard.audit(projectId);
  const content = r.dimensions.find((d) => d.key === 'content');
  assert.equal(content.ok, false);
  assert.equal(content.failed, 1);
  assert.equal(content.issues[0].shot_no, 'E01-S001');
});

test('有对白但说话人没有声线 → 声音字幕维失败', () => {
  const { projectId } = mkProjectWithAssets();
  consistencyGuard.ensureVoiceAssets(projectId);
  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  const shot = rec.storyboard.shots[0];
  const withLine = { ...shot, dialogue: '你以为这就结束了？', speaker: 'CH01' };

  // 删掉刚自动补的声线，模拟"资产被清理"或"跨项目复用角色"
  const voice = db.findOne('assets', (a) => a.project_id === projectId && a.asset_type === 'voice');
  db.remove('assets', voice.id);
  db.update('director_plans', rec.id, { storyboard: { shots: [withLine] } });

  const r = consistencyGuard.audit(projectId);
  const audio = r.dimensions.find((d) => d.key === 'audio_subtitle');
  assert.equal(audio.ok, false);
  assert.match(JSON.stringify(audio.issues), /固定声线/);
});

test('生成前闸门：不达标抛 CONSISTENCY_VIOLATION，达标则顺带把声线补齐', () => {
  const { projectId, shot } = mkProjectWithAssets();
  // 达标
  const ok = consistencyGuard.assertBeforeGenerate({ projectId, shot, planRecord: db.findOne('director_plans', (x) => x.project_id === projectId) });
  assert.equal(ok.audit.ok, true);
  assert.ok(Object.keys(ok.voices).length >= 1);

  // 不达标：把角色锁砍到 1 条
  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  const ch = db.findOne('assets', (a) => a.project_id === projectId && a.asset_type === 'character');
  db.update('assets', ch.id, { locks: ['lean face'] });
  assert.throws(
    () => consistencyGuard.assertBeforeGenerate({ projectId, shot, planRecord: rec }),
    (e) => e.code === ERR.CONSISTENCY_VIOLATION,
  );
});

test('交付阻塞项：按维度汇总，能直接给用户看', () => {
  const { projectId, shot } = mkProjectWithAssets();
  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  db.update('director_plans', rec.id, {
    storyboard: { shots: [{ ...shot, shot_card: 'SHT-CU' }] }, // 与总谱镜别不一致
  });
  const blockers = consistencyGuard.blockers(projectId);
  assert.ok(blockers.length >= 1);
  assert.equal(blockers[0].code, 'CONSISTENCY_DIM_FAILED');
  assert.ok(blockers[0].issue.includes('内容一致性'));
});
