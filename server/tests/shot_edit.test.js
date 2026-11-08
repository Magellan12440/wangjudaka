/**
 * V4.11 生成物手动更改与重生成。
 *
 * 用户诉求很具体：「生成的剧本 / 角色 / 道具 / 场景 / 分镜图 / 视频片段，我要能自己改、能重出」。
 * 这里锁住三件事：
 *  1. 改设定（updateShot）只改允许改的字段，并同步回总谱 —— 改完不产生两份事实；
 *  2. 重出（regenerate）必须沿用当初的编译输入，不能一重出就报"风格不存在"；
 *  3. 多版本（pick）选定后，剪辑拿到的就是用户选的那一版。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import shotService from '../src/pipeline/ShotService.js';
import generateService from '../src/pipeline/GenerateService.js';
import ledger from '../src/ledger/Ledger.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import editService from '../src/pipeline/EditService.js';
import { makeReq } from './helpers.js';

let seq = 0;
function mkProject() {
  seq += 1;
  const projectId = `proj_se_${seq}_${Date.now()}`;
  db.insert('projects', {
    id: projectId, user_id: `u_se_${seq}`, title: '改写样本',
    spec: { style_code: 'STY-DUSHI', director_code: 'DIR-BALANCED', aspect: '9:16', quality: '1080p' },
    created_at: new Date().toISOString(),
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
    projectId, assetType: 'scene', name: '天台',
    locks: ['water tank', 'chain fence', 'night skyline'],
    imageUrl: 'cos://asset/SC02.png',
  });
  assetLibrary.create({
    projectId, assetType: 'prop', name: '打火机',
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

test('手动改写：允许改镜别/运镜/场景/对白，并同步回总谱（只有一份事实）', () => {
  const { projectId } = mkProject();
  const r = shotService.updateShot({
    projectId, shotNo: 'E01-S001',
    patch: {
      shot_card: 'SHT-CU', camera_move: 'SHT-STATIC',
      scene: 'SC02', props: [], dialogue: '你早就知道了？', speaker: 'CH01',
    },
  });
  assert.ok(r.changed.includes('shot_card'));
  assert.equal(r.shot.shot_card, 'SHT-CU');
  assert.deepEqual(r.shot.props, []);
  assert.ok(r.shot.manual_override.fields.includes('scene'));

  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  assert.equal(rec.storyboard.shots[0].shot_card, 'SHT-CU');
  assert.equal(rec.plan.episodes[0].beats[0].shot_card, 'SHT-CU', '总谱必须同步，否则下一镜一致性校验会判冲突');
  assert.equal(rec.plan.episodes[0].beats[0].emotions.CH01, 'EMO-CALM-02');
  assert.ok((rec.plan.global.manual_overrides ?? []).length >= 1);
});

test('手动改写：不允许改角色名单（换人必须回剧本重选）', () => {
  const { projectId } = mkProject();
  assert.throws(
    () => shotService.updateShot({ projectId, shotNo: 'E01-S001', patch: { characters: ['CH02'] } }),
    (e) => e.code === 'BAD_REQUEST' && /不允许手动改写/.test(e.message),
  );
});

test('手动改写：引用不存在的道具/场景卡要被拦下，否则一致性当场破防', () => {
  const { projectId } = mkProject();
  assert.throws(
    () => shotService.updateShot({ projectId, shotNo: 'E01-S001', patch: { props: ['PR99'] } }),
    (e) => e.code === 'ASSET_NOT_FOUND',
  );
  assert.throws(
    () => shotService.updateShot({ projectId, shotNo: 'E01-S001', patch: { scene: 'SC99' } }),
    (e) => e.code === 'ASSET_NOT_FOUND',
  );
});

test('手动改写：非硬切转场必须给理由；有对白必须给说话人', () => {
  const { projectId } = mkProject();
  assert.throws(
    () => shotService.updateShot({ projectId, shotNo: 'E01-S001', patch: { transition: 'TRN-DISSOLVE-W' } }),
    (e) => e.code === 'TRANSITION_REASON_REQUIRED',
  );
  assert.throws(
    () => shotService.updateShot({ projectId, shotNo: 'E01-S001', patch: { dialogue: '我来了' } }),
    (e) => e.code === 'SPEAKER_AMBIGUOUS',
  );
});

test('重生成：resample 沿用原编译输入（不再一重出就报风格不存在）', async () => {
  const { projectId } = mkProject();
  const uid = `u_regen_${Date.now()}`;
  ledger.recharge({ userId: uid, points: 5000, idemKey: `se-${uid}` });

  const first = await generateService.run({
    userId: uid, projectId, kind: 'image', purpose: 'preview',
    meta: { shotNo: 'E01-S001' },
    compileRequest: makeReq({ kind: 'image', model: 'IMG-FAST', shot: { duration: 5, dialogue: null, speaker: null } }),
  });
  assert.equal(first.ok, true);

  const rec = generateService.get(first.generationId);
  assert.ok(rec.compile_input, '生成记录必须落编译输入');

  const again = await generateService.regenerate({
    userId: uid, projectId, generationId: first.generationId, mode: 'resample',
  });
  assert.equal(again.ok, true);
  assert.equal(again.payload.target_model, rec.model);

  // 老记录（没有 compile_input）要给明确指引，而不是抛一个看不懂的编译错误
  db.update('generations', rec.id, { compile_input: null });
  await assert.rejects(
    () => generateService.regenerate({ userId: uid, projectId, generationId: rec.id, mode: 'resample' }),
    (e) => e.code === 'BAD_REQUEST' && /编译输入/.test(e.message),
  );
});

test('多版本选定：pick 之后剪辑取的就是这一版，而不是"最新一版"', () => {
  const { projectId } = mkProject();
  const mkGen = (id, url, at, kind = 'image') => db.insert('generations', {
    id, user_id: 'u_se', project_id: projectId, kind, shot_no: 'E01-S001',
    model: 'IMG-FAST', status: 'done', result_url: url, created_at: at,
  });
  mkGen('gen_old', 'cos://shot/old.png', '2026-01-01T00:00:00.000Z');
  mkGen('gen_new', 'cos://shot/new.png', '2026-01-02T00:00:00.000Z');

  const before = editService.collectShots(projectId);
  assert.equal(before.shots[0].clip_url, 'cos://shot/new.png', '未选定时默认取最新');

  shotService.pick({ projectId, shotNo: 'E01-S001', generationId: 'gen_old' });
  const after = editService.collectShots(projectId);
  assert.equal(after.shots[0].clip_url, 'cos://shot/old.png', '选定后必须用用户那一版');

  const hist = shotService.history(projectId, 'E01-S001');
  assert.equal(hist.find((h) => h.id === 'gen_old').picked, true);
  assert.equal(hist.find((h) => h.id === 'gen_new').picked, false);
});

test('多版本选定：不属于该镜 / 未成功的产物都不能设为正式版', () => {
  const { projectId } = mkProject();
  db.insert('generations', {
    id: `gen_bad_${projectId}`, user_id: 'u_se', project_id: projectId, kind: 'image',
    shot_no: 'E01-S999', model: 'IMG-FAST', status: 'done', result_url: 'cos://x.png',
    created_at: new Date().toISOString(),
  });
  assert.throws(
    () => shotService.pick({ projectId, shotNo: 'E01-S001', generationId: `gen_bad_${projectId}` }),
    (e) => e.code === 'BAD_REQUEST' && /不属于该分镜/.test(e.message),
  );

  db.insert('generations', {
    id: `gen_run_${projectId}`, user_id: 'u_se', project_id: projectId, kind: 'image',
    shot_no: 'E01-S001', model: 'IMG-FAST', status: 'running',
    created_at: new Date().toISOString(),
  });
  assert.throws(
    () => shotService.pick({ projectId, shotNo: 'E01-S001', generationId: `gen_run_${projectId}` }),
    (e) => e.code === 'BAD_REQUEST' && /还没成功/.test(e.message),
  );
});
