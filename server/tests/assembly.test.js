/**
 * V4.13 成片装配：索引、版本、漏镜/重号。
 *
 * 这三件事任何一个出错，成片都会"少一段 / 多一段 / 顺序错"，
 * 而用户只能看到"成片不对"，看不到原因。所以这里把规则钉死：
 *  1. 成片顺序 = 镜号索引顺序（数组被重排也不会乱）；
 *  2. 同一镜重出后，新版本顶替旧版本，旧版本标废弃但保留（可回退），剪辑只认当前版本；
 *  3. 缺镜 / 重号 / 选中废弃版本 → 报出来，渲染前硬拦。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import assembly from '../src/pipeline/Assembly.js';
import shotService from '../src/pipeline/ShotService.js';
import editService from '../src/pipeline/EditService.js';
import editPlan from '../src/media/EditPlan.js';
import assetLibrary from '../src/assets/AssetLibrary.js';

let seq = 0;

/** 造一个项目 + 分镜；shots 允许乱序传入，用来验证"剪辑自己会排好" */
function mkProject({ shots = null } = {}) {
  seq += 1;
  const projectId = `proj_asm_${seq}_${Date.now()}`;
  db.insert('projects', {
    id: projectId, user_id: `u_asm_${seq}`, title: '装配样本',
    spec: {
      style_code: 'STY-DUSHI', director_code: 'DIR-BALANCED',
      aspect: '9:16', quality: '1080p', episode_count: 1, episode_sec: 90, total_minutes: 1.5,
    },
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

  const mkShot = (i) => ({
    no: `E01-S00${i}`, beat_no: `E01-B0${i}`, episode: 1, index: i, order: 10000 + i,
    duration: 4, shot_card: 'SHT-MCU', camera_move: 'SHT-PUSH',
    lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT',
    rhythm: 'HOOK-01', emotions: { CH01: 'EMO-CALM-02' },
    characters: ['CH01'], scene: 'SC01', props: [],
    dialogue: null, speaker: null,
  });
  const list = shots ?? [mkShot(1), mkShot(2), mkShot(3)];
  db.insert('director_plans', {
    id: `dplan_${projectId}`, project_id: projectId, plan_id: `plan_${projectId}`,
    plan: { plan_id: `plan_${projectId}`, episodes: [{ no: 1, beats: [] }], global: {} },
    storyboard: { shots: list },
    created_at: new Date().toISOString(),
  });
  return projectId;
}

function addGen(projectId, shotNo, { kind = 'image', url = null, createdAt = null, supersededBy = null } = {}) {
  seq += 1;
  const id = `gen_${projectId}_${seq}`;
  db.insert('generations', {
    id, project_id: projectId, kind, shot_no: shotNo, status: 'done',
    result_url: url ?? `cos://clip/${id}.${kind === 'video' ? 'mp4' : 'png'}`,
    created_at: createdAt ?? new Date(Date.now() + seq).toISOString(),
    superseded_by: supersededBy,
  });
  return id;
}

test('装配：分镜数组乱序时，成片仍按镜号索引排好', () => {
  const s1 = { no: 'E01-S001', beat_no: 'E01-B01', episode: 1, index: 1, order: 10001, duration: 4, transition: 'TRN-HARDCUT', characters: ['CH01'], scene: 'SC01' };
  const s2 = { no: 'E01-S002', beat_no: 'E01-B02', episode: 1, index: 2, order: 10002, duration: 4, transition: 'TRN-HARDCUT', characters: ['CH01'], scene: 'SC01' };
  const s3 = { no: 'E01-S003', beat_no: 'E01-B03', episode: 1, index: 3, order: 10003, duration: 4, transition: 'TRN-HARDCUT', characters: ['CH01'], scene: 'SC01' };
  const projectId = mkProject({ shots: [s3, s1, s2] }); // 故意打乱
  addGen(projectId, 'E01-S001');
  addGen(projectId, 'E01-S002');
  addGen(projectId, 'E01-S003');

  const audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.deepEqual(audit.clips.map((c) => c.shot_no), ['E01-S001', 'E01-S002', 'E01-S003']);
  assert.deepEqual(audit.clips.map((c) => c.index), [0, 1, 2]);
  assert.equal(audit.ok, true);
  assert.ok(audit.order_conflicts.length >= 1, '数组本身乱序要报出来（说明有人原地改过顺序）');
});

test('装配：缺镜必须报出来，而不是默默跳过', () => {
  const projectId = mkProject();
  addGen(projectId, 'E01-S001');
  addGen(projectId, 'E01-S003');
  const audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missing.map((m) => m.shot_no), ['E01-S002']);
  assert.equal(audit.total, 3);
  assert.equal(audit.ready, 2);
  assert.equal(audit.coverage, 0.667);

  // 硬拦：不许渲染
  assert.throws(
    () => assembly.assertAssembly({ projectId, episode: 1 }),
    (e) => e.code === 'ASSEMBLY_INCOMPLETE' && /E01-S002/.test(e.message),
  );
});

test('装配：重复镜号（同一段剪两次）与断号都要被抓到', () => {
  const mk = (i) => ({
    no: `E01-S00${i}`, beat_no: `E01-B0${i}`, episode: 1, index: i, order: 10000 + i,
    duration: 4, transition: 'TRN-HARDCUT', characters: ['CH01'], scene: 'SC01',
  });
  const projectId = mkProject({ shots: [mk(1), mk(1), mk(3)] });
  for (const no of ['E01-S001', 'E01-S003']) addGen(projectId, no);
  const audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.equal(audit.duplicates.length, 1);
  assert.match(audit.duplicates[0].text, /索引号相同/);
  assert.equal(audit.gaps.length, 1);
  assert.match(audit.gaps[0].text, /断档/);
});

test('版本：重出后新版本顶替旧版本，剪辑只取新版本；选回旧版本也合法', () => {
  const projectId = mkProject();
  const oldGen = addGen(projectId, 'E01-S001', { kind: 'image', createdAt: '2026-11-01T00:00:00.000Z' });
  addGen(projectId, 'E01-S002');
  addGen(projectId, 'E01-S003');

  // 用户重出第一镜 → 新版本成为当前版本
  const newGen = addGen(projectId, 'E01-S001', { kind: 'image', createdAt: '2026-11-02T00:00:00.000Z' });
  const v1 = shotService.markCurrent({ projectId, shotNo: 'E01-S001', kind: 'image', generationId: newGen });
  assert.equal(v1.order, 10001, '版本更新不能改动索引');
  assert.deepEqual(v1.superseded, [oldGen], '旧版本要被标废弃（保留可回退）');

  const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
  const shot = rec.storyboard.shots.find((s) => s.no === 'E01-S001');
  assert.equal(shot.picked.image_generation_id, newGen);

  let audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.equal(audit.clips[0].clip.generation_id, newGen);
  assert.equal(audit.clips[0].clip.superseded, false);
  assert.equal(audit.ok, true);

  // 用户又选回旧版本 → 旧版本重新生效，新版本被废弃
  const v2 = shotService.markCurrent({ projectId, shotNo: 'E01-S001', kind: 'image', generationId: oldGen });
  assert.deepEqual(v2.superseded, [newGen]);
  const oldRow = db.findOne('generations', (g) => g.id === oldGen);
  assert.equal(oldRow.superseded_by, null, '被重新选中的版本必须清掉废弃标记');

  audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.equal(audit.clips[0].clip.generation_id, oldGen);
});

test('版本：选中的版本被废弃但没重选 → 渲染前硬拦（用户选的与成片用的不一致是事故）', () => {
  const projectId = mkProject();
  const a = addGen(projectId, 'E01-S001');
  db.update('director_plans', db.findOne('director_plans', (x) => x.project_id === projectId).id, {
    storyboard: {
      shots: db.findOne('director_plans', (x) => x.project_id === projectId).storyboard.shots.map((s) => (
        s.no === 'E01-S001' ? { ...s, picked: { image_generation_id: a } } : s
      )),
    },
  });
  const b = addGen(projectId, 'E01-S001', { createdAt: '2026-11-05T00:00:00.000Z' });
  // 绕过 markCurrent：模拟"新版本落库了、但分镜上还指着旧版本"
  db.update('generations', a, { superseded_by: b });

  const audit = assembly.auditAssembly({ projectId, episode: 1 });
  assert.equal(audit.superseded_picks.length, 1);
  assert.match(audit.superseded_picks[0].text, /已被新版本顶掉/);
  assert.throws(
    () => assembly.assertAssembly({ projectId, episode: 1 }),
    (e) => e.code === 'ASSEMBLY_INCOMPLETE',
  );
});

test('剪辑单：逐段带 film_index / 镜号 / 版本 / 剧本引用', () => {
  const projectId = mkProject();
  const g1 = addGen(projectId, 'E01-S001');
  addGen(projectId, 'E01-S002');
  addGen(projectId, 'E01-S003');
  const plan = editService.plan(projectId, 1);
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.assembly.clips.length, 3);
  assert.deepEqual(plan.assembly.clips.map((c) => c.film_index), [1, 2, 3]);
  assert.deepEqual(plan.assembly.clips.map((c) => c.shot_no), ['E01-S001', 'E01-S002', 'E01-S003']);
  assert.equal(plan.assembly.clips[0].generation_id, g1);
  assert.equal(plan.assembly.clips[0].beat_no, 'E01-B01');
  assert.equal(plan.assembly.style.code, 'STY-DUSHI');
  assert.deepEqual(plan.missing_shots, []);
});

test('剪辑单：重复镜号直接判 fatal（不能静默剪两次）', () => {
  const base = {
    clip_url: 'a.mp4', duration: 4, transition: 'TRN-HARDCUT',
  };
  const r = editPlan.buildEditPlan({
    projectId: 'p_dup', episodeNo: 'E01',
    shots: [
      { ...base, shot_no: 'E01-S001', order: 10001 },
      { ...base, shot_no: 'E01-S001', order: 10001 },
    ],
    aspect: '9:16', quality: '1080p', subtitleRule: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'DUPLICATE_CLIP'));
  assert.equal(r.assembly.clips.length, 2, '索引表仍然要给出来，方便定位重复段');
});

test('剪辑单：顺序倒挂判 fatal', () => {
  const base = { clip_url: 'a.mp4', duration: 4, transition: 'TRN-HARDCUT' };
  const r = editPlan.buildEditPlan({
    projectId: 'p_ord', episodeNo: 'E01',
    shots: [
      { ...base, shot_no: 'E01-S002', order: 10002 },
      { ...base, shot_no: 'E01-S001', order: 10001 },
    ],
    aspect: '9:16', quality: '1080p', subtitleRule: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'ORDER_CONFLICT'));
});
