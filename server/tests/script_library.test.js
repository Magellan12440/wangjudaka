/**
 * V4.10 剧本库：候选 → 选定 → 入库 → 修改 → 套用。
 *
 * 这一组测的是「流程能不能走通」以及「选定后资产卡真的被建出来」，
 * 不去断言模型输出内容（那属于上游，不该由单测背书）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import scriptLibrary from '../src/projects/ScriptLibrary.js';

let seq = 0;
function mkProject(userId = null) {
  seq += 1;
  const id = `proj_sl_${seq}_${Date.now()}`;
  db.insert('projects', {
    id,
    user_id: userId || `u_sl_${seq}`,
    title: `剧本项目${seq}`,
    spec: { origin: 'material', style_code: 'STY-DUSHI' },
    created_at: new Date().toISOString(),
  });
  return id;
}

/** 造一份最小可用的候选产物（结构按 StoryEngine 的真实输出形状） */
function fakePlan(pid, no = 1) {
  return {
    plan_id: `plan_${pid}_${no}`,
    plan_version: 1,
    validation: { ok: true, problems: [] },
    stats: { shots: 2 },
    episodes: [
      {
        no: 1,
        beats: [
          { beat_no: 'E01-B01', duration_sec: 5, emotions: { CH01: 'EMO-FEAR' } },
          { beat_no: 'E01-B02', duration_sec: 5, emotions: { CH01: 'EMO-ANGER' } },
        ],
      },
    ],
  };
}

function fakeOutline(title = '长夜执灯人') {
  return {
    title,
    logline: '守灯人必须在天亮前找到最后一盏灯',
    characters: [{ code: 'CH01', name: '沈砚', role: '主角', traits: '瘦、左眉有疤' }],
    locations: [{ code: 'SC01', name: '灯塔底层' }],
    props: [{ code: 'PR01', name: '油灯' }],
    episodes: [{ no: 1, goal: '拿到灯' }],
  };
}

function fakeStoryboard(pid, no = 1) {
  return {
    shots: [
      { no: 'E01-S001', episode: 1, scene: 'SC01', characters: ['CH01'], duration: 5 },
      { no: 'E01-S002', episode: 1, scene: 'SC01', characters: ['CH01'], duration: 5 },
    ],
  };
}

function fakeScript() {
  return { episodes: [{ no: 1, scenes: [{ beat_no: 'E01-B01', action: '他推开门', dialogue: [{ speaker: '沈砚', line: '灯呢？' }] }] }] };
}

function addCand(pid, userId, no = 1, title) {
  return scriptLibrary.addCandidate({
    projectId: pid,
    userId,
    outline: fakeOutline(title || `第 ${no} 版`),
    plan: fakePlan(pid, no),
    script: fakeScript(),
    storyboard: fakeStoryboard(pid, no),
    materialsUsed: [{ id: 'm1', kind: 'text', name: '原文.txt' }],
    referenceChars: 3200,
    totalChars: 1200000,
    condensed: true,
    label: `第 ${no} 版`,
  });
}

test('候选：写入后可列出，且带摘要字段', () => {
  const pid = mkProject();
  const c = addCand(pid, 'u_cand');
  const list = scriptLibrary.candidates(pid);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, c.id);
  assert.equal(list.items[0].episodes, 1);
  assert.equal(list.items[0].shots, 2);
  assert.ok(list.items[0].chars > 0);
});

test('候选：上限裁剪，不会无限堆积', () => {
  const pid = mkProject();
  for (let i = 0; i < 12; i += 1) addCand(pid, 'u_trim', i + 1);
  const list = scriptLibrary.candidates(pid);
  assert.ok(list.items.length <= 9, `实际 ${list.items.length}`);
});

test('选定：写总谱 + 建角色/场景/道具资产 + 入库', () => {
  const pid = mkProject('u_select');
  const c = addCand(pid, 'u_select', 1, '选定版');

  const r = scriptLibrary.select({ projectId: pid, userId: 'u_select', candidateId: c.id });
  assert.equal(r.plan_id, c.plan.plan_id);
  assert.ok(r.vault_id, '选定后应自动入库');

  const assets = db.find('assets', (a) => a.project_id === pid);
  const types = assets.map((a) => a.asset_type);
  assert.ok(types.includes('character'), '应有角色卡');
  assert.ok(types.includes('scene'), '应有场景卡');
  assert.ok(types.includes('prop'), '应有道具卡');
  assert.ok(assets.every((a) => (a.locks ?? []).length >= 3), '每张卡都要有连续性锁');

  const plan = db.findOne('director_plans', (x) => x.project_id === pid);
  assert.equal(plan.plan_id, c.plan.plan_id);
  assert.equal(plan.selected_candidate_id, c.id);
});

test('选定：换一版不会重复建资产（只补缺的）', () => {
  const pid = mkProject('u_switch');
  const a = addCand(pid, 'u_switch', 1, '第一版');
  const b = addCand(pid, 'u_switch', 2, '第二版');
  scriptLibrary.select({ projectId: pid, userId: 'u_switch', candidateId: a.id });
  const first = db.count('assets', (x) => x.project_id === pid);
  scriptLibrary.select({ projectId: pid, userId: 'u_switch', candidateId: b.id });
  const second = db.count('assets', (x) => x.project_id === pid);
  assert.equal(second, first, '同类型同编号的资产不应重复创建');
  const plan = db.findOne('director_plans', (x) => x.project_id === pid);
  assert.equal(plan.outline.title, '第二版');
});

test('剧本库：列表 / 改名 / 移除', () => {
  const pid = mkProject('u_vault');
  const c = addCand(pid, 'u_vault', 1, '原名');
  const r = scriptLibrary.select({ projectId: pid, userId: 'u_vault', candidateId: c.id });

  const list = scriptLibrary.vaultList('u_vault');
  assert.equal(list.total, 1);
  assert.equal(list.items[0].id, r.vault_id);

  const up = scriptLibrary.vaultUpdate('u_vault', r.vault_id, { title: '新名字', logline: '改了梗概' });
  assert.equal(up.title, '新名字');
  assert.equal(up.logline, '改了梗概');
  assert.equal(db.findOne('script_vault', (x) => x.id === r.vault_id).title, '新名字');

  scriptLibrary.vaultRemove('u_vault', r.vault_id);
  assert.equal(scriptLibrary.vaultList('u_vault').total, 0);
});

test('剧本库：别人的剧本改不动', () => {
  const pid = mkProject('u_owner');
  const c = addCand(pid, 'u_owner', 1);
  const r = scriptLibrary.select({ projectId: pid, userId: 'u_owner', candidateId: c.id });
  assert.throws(() => scriptLibrary.vaultUpdate('u_other', r.vault_id, { title: 'x' }), /不存在|不属于/);
});

test('套用：把库存剧本套到另一个项目，重建总谱', () => {
  const pid = mkProject('u_apply');
  const c = addCand(pid, 'u_apply', 1, '可复用');
  const r = scriptLibrary.select({ projectId: pid, userId: 'u_apply', candidateId: c.id });
  const pid2 = mkProject('u_apply');
  const out = scriptLibrary.vaultApply({ userId: 'u_apply', id: r.vault_id, projectId: pid2 });
  assert.equal(out.plan_id, c.plan.plan_id);
  const plan2 = db.findOne('director_plans', (x) => x.project_id === pid2);
  assert.equal(plan2.applied_from_vault, r.vault_id);
  assert.ok(out.assets.total >= 3);
});

test('activeOf：回报当前项目是否已入库', () => {
  const pid = mkProject('u_active');
  const c = addCand(pid, 'u_active', 1, '当前版');
  const r = scriptLibrary.select({ projectId: pid, userId: 'u_active', candidateId: c.id });
  const a = scriptLibrary.activeOf(pid);
  assert.equal(a.plan_id, c.plan.plan_id);
  assert.equal(a.vault_id, r.vault_id);
});
