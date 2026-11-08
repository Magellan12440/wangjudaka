/**
 * V4.13 图片模型与配角资产。
 *
 * 用户要求：新增「纳米香蕉 2.1」「TTimage 2.6」，推荐 2.6；两者都能用于角色/道具/场景设定图
 * 与分镜图；并且剧本里的配角也要有资产，全剧前后一致。
 *
 * 这里锁住四件事：
 *  1. 目录里能选到这两个模型，推荐位真的是 2.6，后端默认值也真的是 2.6（不是"只在前端标个推荐"）；
 *  2. 资产设定图与分镜图都吃同一个图片模型选择；
 *  3. 配角（大纲没写、只在分镜/剧本里出现）会被建卡，并且带锁；
 *  4. 角色名册能提前报出"缺卡 / 缺图"，而不是等出图失败才发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import seeds from '../src/seeds/loader.js';
import { modelCatalog } from '../src/relay/ModelCatalog.js';
import { modelRegistry } from '../src/relay/ModelRegistry.js';
import compiler from '../src/compiler/PromptCompiler.js';
import assetImageService from '../src/pipeline/AssetImageService.js';
import scriptLibrary from '../src/projects/ScriptLibrary.js';

let seq = 0;
const uid = (p) => `${p}_${(seq += 1)}_${Date.now()}`;

test('图片目录：TT Image 2.6 与纳米香蕉 2.1 都可选，推荐位是 2.6', () => {
  const list = modelCatalog.list('image');
  const codes = list.items.map((x) => x.code);
  assert.ok(codes.includes('IMG-TT-26'), '目录里没有 TT Image 2.6');
  assert.ok(codes.includes('IMG-NANO-BANANA-21'), '目录里没有纳米香蕉 2.1');
  assert.equal(list.items.find((x) => x.recommended)?.code, 'IMG-TT-26', '推荐位必须是 TT Image 2.6');
  assert.equal(modelCatalog.defaultFor('image'), 'IMG-TT-26');
  assert.equal(modelRegistry.defaultFor('image'), 'IMG-TT-26', '后端默认值也要是 2.6，不能只在前端标推荐');
  assert.ok(list.items.length <= 5, '一个环节最多 5 个模型');

  const banana = modelRegistry.get('IMG-NANO-BANANA-21');
  assert.equal(banana.role, 'image');
  assert.equal(banana.commercial_ok, true);
  assert.equal(banana.upstream_id, 'banana-2.1');
  const tt = modelRegistry.get('IMG-TT-26');
  assert.equal(tt.role, 'image');
  assert.equal(tt.upstream_id, 'tt-image-2.6');
  assert.equal(tt.commercial_ok, true);
});

test('两个新模型都能真的出图：资产设定图 / 分镜图都按选择的模型编译', () => {
  for (const model of ['IMG-TT-26', 'IMG-NANO-BANANA-21']) {
    // 资产设定图
    const sheet = compiler.compile({
      kind: 'image', available_credits: 99999, model,
      project: { style_code: 'STY-GUFENG', aspect: '9:16', quality: '1080p', episode_count: 1, episode_sec: 60, total_minutes: 1 },
      asset: {
        asset_code: 'CH01', asset_type: 'character', name: '沈昭',
        locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'], lock_values: {},
      },
      options: { mode: 'asset_sheet' },
    });
    assert.equal(sheet.target_model, model);
    assert.equal(sheet.asset_sheet, true);

    // 分镜图
    const shot = compiler.compile({
      kind: 'image', available_credits: 99999, model,
      project: { style_code: 'STY-GUFENG', aspect: '9:16', quality: '1080p', episode_count: 1, episode_sec: 60, total_minutes: 1 },
      shot_no: 'E01-S001',
      shot: {
        duration: 5, shot_card: 'SHT-MS', camera_move: 'SHT-PUSH',
        characters: ['CH01'], scene: 'SC01', props: [], dialogue: '',
        action_start: '推门', action_end: '回头', emotions: { CH01: 'EMO-CALM-02' },
      },
      lighting: { codes: [] }, transition: { code: 'TRN-HARDCUT' },
      assets: {
        characters: { CH01: { asset_code: 'CH01', name: '沈昭', locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'], image_url: 'cos://a.png' } },
        scenes: { SC01: { asset_code: 'SC01', name: '厅堂', locks: ['木柱', '高窗', '冷顶光'], image_url: 'cos://s.png' } },
        props: {}, emotions: {},
      },
      options: { allow_pending_reference: true },
    });
    assert.equal(shot.target_model, model);
    assert.equal(shot.kind, 'image');
  }
});

/** 造一个已有分镜的项目：大纲只写了 CH01，分镜里还有配角 CH07，剧本里还有 CH09 说话 */
function mkProjectWithSupporting() {
  const projectId = uid('proj_sup');
  db.insert('projects', {
    id: projectId, user_id: uid('u_sup'), title: '配角样本',
    spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p', episode_count: 1, episode_sec: 60, total_minutes: 1 },
    created_at: new Date().toISOString(),
  });
  db.insert('director_plans', {
    id: uid('dplan'), project_id: projectId, plan_id: uid('plan'),
    outline: {
      title: '配角样本',
      characters: [{ code: 'CH01', name: '林默', role: '主角', traits: '瘦，左眉疤' }],
      locations: [{ code: 'SC01', name: '审讯室' }],
      props: [],
    },
    plan: { plan_id: uid('plan'), episodes: [{ no: 1, beats: [] }], global: {} },
    script: {
      episodes: [{
        no: 1,
        scenes: [
          { beat_no: 'E01-B01', action: '推门', dialogue: [{ speaker: 'CH01', line: '说吧。' }] },
          { beat_no: 'E01-B02', action: '低头', dialogue: [{ speaker: 'CH09', line: '我什么都不知道。' }] },
        ],
      }],
    },
    storyboard: {
      shots: [
        { no: 'E01-S001', beat_no: 'E01-B01', episode: 1, index: 1, order: 10001, characters: ['CH01'], scene: 'SC01', duration: 4, transition: 'TRN-HARDCUT' },
        { no: 'E01-S002', beat_no: 'E01-B02', episode: 1, index: 2, order: 10002, characters: ['CH01', 'CH07'], scene: 'SC01', duration: 4, transition: 'TRN-HARDCUT' },
      ],
    },
    created_at: new Date().toISOString(),
  });
  return projectId;
}

test('配角：剧本/分镜里出现过的角色都会被建卡，且带连续性锁', () => {
  const projectId = mkProjectWithSupporting();
  const before = db.find('assets', (a) => a.project_id === projectId && a.asset_type === 'character');
  assert.equal(before.length, 0);

  const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
  const r = scriptLibrary.syncAssets({
    projectId, outline: planRec.outline, storyboard: planRec.storyboard, script: planRec.script,
  });
  assert.ok(r.created >= 3, `应至少建 3 张角色卡（主角 + 两个配角），实际 ${r.created}`);

  const cards = db.find('assets', (a) => a.project_id === projectId && a.asset_type === 'character');
  const codes = cards.map((a) => a.asset_code).sort();
  assert.ok(codes.includes('CH07'), '分镜里的配角 CH07 没有建卡');
  assert.ok(codes.includes('CH09'), '剧本里的配角 CH09 没有建卡');
  for (const c of cards) {
    assert.ok((c.locks ?? []).length >= 4, `${c.asset_code} 的连续性锁不足`);
  }
  const ch07 = cards.find((a) => a.asset_code === 'CH07');
  assert.equal(ch07.meta?.supporting, true, '配角要标出来，方便页面分组');
  assert.ok(ch07.meta?.shots >= 1);
});

test('角色名册：提前报出缺卡 / 缺图，不用等出图失败', () => {
  const projectId = mkProjectWithSupporting();
  const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
  scriptLibrary.syncAssets({
    projectId, outline: planRec.outline, storyboard: planRec.storyboard, script: planRec.script,
  });

  const roster = assetImageService.roster(projectId);
  assert.equal(roster.total, 3, `名册应有 3 个角色，实际 ${roster.total}`);
  assert.equal(roster.main, 1);
  assert.equal(roster.supporting, 2);
  assert.deepEqual(roster.missing_cards, []);
  assert.equal(roster.missing_images.length, 3, '新卡都还没出图');
  assert.match(roster.note, /定妆图/);
  assert.equal(roster.ready, 0);

  const ch07 = roster.characters.find((c) => c.code === 'CH07');
  assert.equal(ch07.has_card, true);
  assert.equal(ch07.has_image, false);
  assert.equal(ch07.supporting, true);
});

test('角色名册：同名不同码不会凭空多建一张卡（一致性最怕"两张脸"）', () => {
  const projectId = mkProjectWithSupporting();
  const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
  // 剧本里把 speaker 写成了人名而不是角色码
  planRec.script.episodes[0].scenes[1].dialogue = [{ speaker: '林默', line: '我什么都不知道。' }];
  scriptLibrary.syncAssets({
    projectId, outline: planRec.outline, storyboard: planRec.storyboard, script: planRec.script,
  });
  const roster = assetImageService.roster(projectId);
  assert.ok(!roster.characters.some((c) => c.code === '林默'), '人名不应被当成新角色建卡');
  assert.ok(seeds.lockTemplate('character'));
});
