/**
 * V4.14 分环节参数 + 本地参考图 + 自动填词。
 *
 * 用户原话：「生成剧本、生成角色、生成分镜图、生成视频等环节，加入模型选择、风格选择、
 * 画面比例、画质选择等等细节，以及参考素材本地上传的途径（如角色，可以上传本地照片，
 * 同时自动提取剧本中刻画的形象，结合风格设定，自动填充提示词，其它环节以此类推）」
 *
 * 这里锁住五件事：
 *  1. 七个环节各自能读到模型 / 风格 / 画幅 / 画质选项，且「不该有的选项不出现」
 *     （剧本环节没有画幅，剪辑环节没有风格）；
 *  2. 改了某个环节，只有该环节变，项目规格与其它环节不变；
 *  3. 非法值直接报错，不静默退回；
 *  4. 出图时环节参数真的进了请求（模型 / 分辨率 / 参考图）；
 *  5. 自动填词能从剧本原文抽出外貌描写，并给出处。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import assetImageService from '../src/pipeline/AssetImageService.js';
import assetPrompt from '../src/pipeline/AssetPrompt.js';
import stageOptions from '../src/pipeline/StageOptions.js';
import compiler from '../src/compiler/PromptCompiler.js';
import ledger from '../src/ledger/Ledger.js';
import { resolutionOf } from '../src/core/frame.js';

let seq = 0;
const uid = (p) => `${p}_${(seq += 1)}_${Date.now()}`;

function mkProject(extra = {}) {
  const projectId = uid('proj_stage');
  const userId = uid('u_stage');
  ledger.recharge({ userId, points: 100000, idemKey: `test:${projectId}`, channel: 'test' });
  db.insert('projects', {
    id: projectId,
    user_id: userId,
    title: '环节参数样本',
    spec: {
      style_code: 'STY-DUSHI', director_code: 'DIR-BALANCED',
      aspect: '9:16', quality: '1080p', episode_count: 6, episode_sec: 90, total_minutes: 9,
      ...extra,
    },
    created_at: new Date().toISOString(),
  });
  return { projectId, userId };
}

function mkChar(projectId, name = '林默') {
  return assetLibrary.create({
    projectId, assetType: 'character', name, code: 'CH01',
    locks: ['lean face', 'short black hair', 'pine-green jacket', 'silver earring'],
    imageUrl: null,
  });
}

test('七个环节都能读到选项，且不支持的能力不会出现', () => {
  const { projectId } = mkProject();
  const d = stageOptions.get(projectId);

  for (const key of ['script', 'character', 'scene', 'prop', 'storyboard', 'video', 'film']) {
    assert.ok(d.stages[key], `缺少环节 ${key}`);
  }

  // 剧本：有模型、有风格，没有画幅画质（画幅是成片规格，不在这改）
  assert.ok(d.stages.script.options.models.length > 0, '剧本环节必须能选模型');
  assert.equal(d.stages.script.options.aspects.length, 0, '剧本环节不该出现画幅选项');
  assert.equal(d.stages.script.options.qualities.length, 0, '剧本环节不该出现画质选项');
  assert.ok(d.stages.script.options.styles.length >= 32, '剧本环节要能换文风（32 个风格）');

  // 角色/场景/道具/分镜/视频：四件套齐全
  for (const key of ['character', 'scene', 'prop', 'storyboard', 'video']) {
    const st = d.stages[key];
    assert.ok(st.options.models.length > 0, `${key} 必须能选模型`);
    assert.ok(st.options.styles.length >= 32, `${key} 必须能换风格`);
    assert.ok(st.options.aspects.length >= 4, `${key} 必须能换画幅`);
    assert.ok(st.options.qualities.length >= 3, `${key} 必须能换画质`);
  }

  // 剪辑：只能换剪辑档位，不能换风格（否则成片风格与分镜对不上）
  assert.equal(d.stages.film.options.styles.length, 0, '剪辑环节不该能换风格');
  assert.ok(d.stages.film.options.models.length > 0, '剪辑环节要能选剪辑档位');

  // 默认值来自项目规格，不是硬编码
  assert.equal(d.stages.character.current.aspect, '9:16');
  assert.equal(d.stages.character.current.quality, '1080p');
  assert.equal(d.stages.character.current.style_code, 'STY-DUSHI');
});

test('改角色环节只影响角色：项目规格与其它环节都不动', () => {
  const { projectId } = mkProject();
  const before = db.findOne('projects', (p) => p.id === projectId);

  const r = stageOptions.set(projectId, 'character', {
    model: 'IMG-NANO-BANANA-21', style_code: 'STY-GUFENG', aspect: '4:3', quality: '2k',
  });
  assert.equal(r.ok, true);
  assert.equal(r.effective.model, 'IMG-NANO-BANANA-21');
  assert.equal(r.effective.aspect, '4:3');
  assert.equal(r.effective.quality, '2k');
  assert.equal(r.effective.style_name, '古风');

  const after = db.findOne('projects', (p) => p.id === projectId);
  assert.equal(after.spec.aspect, before.spec.aspect, '项目规格的画幅不能被环节设置改掉');
  assert.equal(after.spec.quality, before.spec.quality, '项目规格的画质不能被环节设置改掉');
  assert.equal(after.spec.style_code, before.spec.style_code, '项目规格的风格不能被环节设置改掉');

  // 其它环节仍是项目默认
  const shot = stageOptions.effective(projectId, 'storyboard');
  assert.equal(shot.aspect, '9:16');
  assert.equal(shot.quality, '1080p');
  assert.equal(shot.style_code, 'STY-DUSHI');

  // 视频环节单独设，不影响分镜
  stageOptions.set(projectId, 'video', { quality: '720p' });
  assert.equal(stageOptions.effective(projectId, 'video').quality, '720p');
  assert.equal(stageOptions.effective(projectId, 'storyboard').quality, '1080p');
});

test('非法值直接报错，不静默退回默认', () => {
  const { projectId } = mkProject();
  assert.throws(
    () => stageOptions.set(projectId, 'character', { aspect: '21:9' }),
    (e) => e.code === 'SPEC_VIOLATION',
    '不存在的画幅必须报错',
  );
  assert.throws(
    () => stageOptions.set(projectId, 'character', { model: 'IMG-NOT-EXIST' }),
    (e) => e.code === 'BAD_REQUEST',
    '不在可选池里的模型必须报错',
  );
  assert.throws(
    () => stageOptions.set(projectId, 'character', { style_code: 'STY-NOT-EXIST' }),
    (e) => e.code === 'BAD_REQUEST',
  );
  // 不支持的字段被忽略，而不是假装生效
  const r = stageOptions.set(projectId, 'film', { style_code: 'STY-GUFENG' });
  assert.equal(stageOptions.effective(projectId, 'film').style_code, 'STY-DUSHI');
  assert.ok(r.ignored.includes('style_code'), '剪辑环节换风格应被标为 ignored');
});

test('出资产图时，环节参数真的进了请求（模型 / 分辨率 / 参考图）', async () => {
  const { projectId, userId } = mkProject();
  mkChar(projectId);

  stageOptions.set(projectId, 'character', {
    model: 'IMG-NANO-BANANA-21', aspect: '4:3', quality: '2k',
  });
  // 挂一张本地参考图
  assetLibrary.attachReferences({
    projectId, code: 'CH01',
    images: [{ url: 'cos://ref/face.png', name: 'face.png' }],
  });

  // 把真正的出站调用换掉：这一步要验的是"编译出什么请求"，而不是上游能不能连通
  const { generateService } = await import('../src/pipeline/GenerateService.js');
  const orig = generateService.run;
  let captured = null;
  generateService.run = async (req) => {
    captured = req;
    return { url: 'cos://mock/CH01.png', credits: 1, balance: 1, mock: true, generationId: null };
  };
  let r;
  try {
    r = await assetImageService.generate({ projectId, assetCode: 'CH01', userId, force: true });
  } finally {
    generateService.run = orig;
  }

  assert.equal(r.effective.stage, 'character');
  assert.equal(r.effective.model, 'IMG-NANO-BANANA-21', '环节选的模型必须真的用上');
  assert.equal(r.effective.aspect, '4:3');
  assert.equal(r.effective.quality, '2k');
  assert.equal(r.reference_count, 1, '参考图必须计数');

  // 真正交给编译器的请求
  assert.ok(captured, '应该调用了一次生成服务');
  assert.equal(captured.compileRequest.model, 'IMG-NANO-BANANA-21');
  assert.equal(captured.compileRequest.project.aspect, '4:3');
  assert.equal(captured.compileRequest.project.quality, '2k');
  assert.equal(captured.compileRequest.options.reference_images.length, 1, '参考图必须进编译请求');
  assert.equal(captured.compileRequest.options.reference_images[0].url, 'cos://ref/face.png');
  assert.equal(captured.meta.stage, 'character');
  assert.equal(captured.meta.stage_options.aspect, '4:3');
});

test('参考图与提示词进编译器：真的出现在请求里，而不是"上传了没生效"', () => {
  const base = {
    kind: 'image', available_credits: 99999, model: 'IMG-TT-26',
    project: { style_code: 'STY-GUFENG', aspect: '9:16', quality: '1080p', episode_count: 1, episode_sec: 60, total_minutes: 1 },
    asset: {
      asset_code: 'CH01', asset_type: 'character', name: '沈昭',
      locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'],
      lock_values: { prompt: '二十八岁，青灰长衫，左手有一道旧疤' },
    },
    options: {
      mode: 'asset_sheet',
      reference_images: [{ url: 'cos://ref/face.png', name: 'face.png' }],
    },
  };
  const payload = compiler.compile(base);
  assert.equal(payload.reference_images.length, 1, '用户参考图必须进 reference_images');
  assert.equal(payload.reference_images[0].url, 'cos://ref/face.png');
  assert.equal(payload.reference_images[0].role, 'identity_reference');
  assert.match(payload.prompt_zh, /左手有一道旧疤/, '用户写的提示词必须进提示词正文');
  // 有参考图就不该再挂"待补参考"的计划（否则会被当成缺图）
  assert.equal(payload.pending_reference_plan.length, 0);

  // 没有参考图时仍然照旧挂待补计划
  const noRef = compiler.compile({ ...base, options: { mode: 'asset_sheet' } });
  assert.equal(noRef.reference_images.length, 0);
  assert.equal(noRef.pending_reference_plan.length, 1);
});

test('自动填词：从剧本原文抽出外貌描写，并结合风格与参考图', () => {
  const { projectId } = mkProject();
  mkChar(projectId, '沈砚');
  db.insert('director_plans', {
    id: uid('dplan'), project_id: projectId, plan_id: uid('plan'),
    plan: { plan_id: 'p', episodes: [] },
    outline: {
      episodes: [{
        no: 1,
        summary: '沈砚年约二十七，青衫下摆沾着雨泥，左眉有一道旧疤。他走进厅堂，没有说话。',
        conflicts: [{ desc: '他被家族除名，左手攥着那封休书' }],
      }],
    },
    script: {
      episodes: [{
        no: 1,
        scenes: [{
          no: 1,
          summary: '雨夜的厅堂，沈砚站在门槛外，青衫湿透。',
          action: '他抬手擦去脸上的雨水，露出一双很冷的眼睛。',
          dialogue: [{ speaker: '沈砚', line: '我回来了。' }],
        }],
      }],
    },
    storyboard: { shots: [] },
    created_at: new Date().toISOString(),
  });

  const d = assetPrompt.draft({ projectId, assetCode: 'CH01' });
  assert.equal(d.ok, true);
  assert.match(d.prompt, /沈砚/, '提示词里必须有这个人的名字');
  assert.ok(d.basis.quoted_count >= 1, '应该从剧本里抽到至少一句描写');
  assert.ok(d.basis.quotes.some((q) => /青衫|疤|眼睛/.test(q.text)), '抽到的句子要真的是外貌描写');
  assert.ok(d.basis.quotes.every((q) => q.where), '每句都要带出处（第几集第几场）');
  assert.match(d.prompt, /古风|都市/, '提示词里必须带画风');
  assert.equal(d.basis.style.code, 'STY-DUSHI');

  // 挂参考图后再抽，提示词里要提到参考图
  assetLibrary.attachReferences({
    projectId, code: 'CH01', images: [{ url: 'cos://ref/a.png', name: 'a.png' }],
  });
  const d2 = assetPrompt.draft({ projectId, assetCode: 'CH01' });
  assert.match(d2.prompt, /参考图/);
  assert.equal(d2.basis.reference_count, 1);
});

test('提示词与参考图互不影响版本号（参考图是输入，不是设定变更）', () => {
  const { projectId } = mkProject();
  const card = mkChar(projectId);
  const v0 = card.version;

  assetLibrary.attachReferences({
    projectId, code: 'CH01', images: [{ url: 'cos://ref/a.png', name: 'a.png' }],
  });
  assetLibrary.setPrompt({ projectId, code: 'CH01', prompt: '二十八岁，青灰长衫' });

  const after = assetLibrary.get(projectId, 'CH01');
  assert.equal(after.version, v0, '挂参考图/写提示词不该顶掉设定版本（否则已出的分镜会被误判为旧版本）');
  assert.equal(after.reference_images.length, 1);
  assert.equal(after.lock_values.prompt, '二十八岁，青灰长衫');

  // 删参考图
  assetLibrary.attachReferences({ projectId, code: 'CH01', images: [], mode: 'clear' });
  assert.equal(assetLibrary.get(projectId, 'CH01').reference_images.length, 0);
});

test('分辨率换算与环节画幅一致（4:3 2K 不能还是竖屏像素）', () => {
  const { projectId } = mkProject();
  stageOptions.set(projectId, 'storyboard', { aspect: '4:3', quality: '2k' });
  const eff = stageOptions.effective(projectId, 'storyboard');
  assert.equal(resolutionOf(eff.aspect, eff.quality), '1920x1440');
  assert.notEqual(resolutionOf(eff.aspect, eff.quality), resolutionOf('9:16', '2k'));
});

test('出分镜图 / 视频时也吃环节参数，且两者互不串', async () => {
  const { projectId, userId } = mkProject();
  mkChar(projectId);
  const scene = assetLibrary.create({
    projectId, assetType: 'scene', name: '审讯室', code: 'SC01',
    locks: ['single desk lamp', 'concrete wall', 'window on the left'],
    imageUrl: 'cos://asset/SC01.png',
  });
  assetLibrary.update(projectId, 'CH01', { image_url: 'cos://asset/CH01.png' });

  const mkShot = (i) => ({
    no: `E01-S00${i}`, beat_no: `E01-B0${i}`, episode: 1, index: i, order: 10000 + i,
    duration: 4, shot_card: 'SHT-MCU', camera_move: 'SHT-PUSH',
    lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT',
    rhythm: 'HOOK-01', emotions: { CH01: 'EMO-CALM-02' },
    characters: ['CH01'], scene: 'SC01', props: [],
    dialogue: null, speaker: null,
  });
  db.insert('director_plans', {
    id: uid('dplan'), project_id: projectId, plan_id: uid('plan'),
    plan: { plan_id: 'p', episodes: [{ no: 1, beats: [] }], global: {} },
    storyboard: { shots: [mkShot(1)] },
    created_at: new Date().toISOString(),
  });

  stageOptions.set(projectId, 'storyboard', { model: 'IMG-NANO-BANANA-21', aspect: '1:1', quality: '1080p' });
  stageOptions.set(projectId, 'video', { model: 'VID-PRO', quality: '720p' });

  const shotService = (await import('../src/pipeline/ShotService.js')).default;
  const { generateService } = await import('../src/pipeline/GenerateService.js');
  const orig = generateService.run;
  const seen = [];
  generateService.run = async (req) => {
    seen.push(req);
    return { url: 'cos://mock/x.png', credits: 1, balance: 1, mock: true, generationId: null };
  };
  try {
    await shotService.generate({ projectId, shotNo: 'E01-S001', kind: 'image', userId });
  } finally {
    generateService.run = orig;
  }

  assert.equal(seen.length, 1);
  assert.equal(seen[0].compileRequest.project.aspect, '1:1', '分镜图必须用分镜环节的画幅');
  assert.equal(seen[0].compileRequest.model, 'IMG-NANO-BANANA-21');
  assert.equal(seen[0].meta.stage, 'storyboard');

  // 视频环节的设置不影响分镜
  assert.equal(stageOptions.effective(projectId, 'video').quality, '720p');
  assert.equal(stageOptions.effective(projectId, 'storyboard').quality, '1080p');
  assert.equal(scene.asset_code, 'SC01');
});
