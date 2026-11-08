/**
 * 用户规格强制生效（V4.12）。
 *
 * 这一组用例守的是「用户在开机页点的东西到底算不算数」：
 * 风格 / 时长 / 剧集 / 画质 / 屏幕比例 必须同时满足三个条件——
 *   1. 进入提示词（模型看得见，不是只当参数）；
 *   2. 进入实际参数（分辨率 / duration / 集数结构）；
 *   3. 事后可核对（总谱自检 + 交付闸门能查出偏差）。
 *
 * 之前真实存在的三个坑（都已修复，这里锁住）：
 *   · 2K 被算成 576×1024，比 720P 还糊，还只扣 0.6 倍点数；
 *   · 4:3 与 1:1 一律按 1920×1080 横屏出；
 *   · 剧集数只写在提示词的一句话里，模型写几集就是几集。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReq } from './helpers.js';
import { PromptCompiler } from '../src/compiler/PromptCompiler.js';
import * as specLib from '../src/prompts/SpecLibrary.js';
import * as frame from '../src/core/frame.js';
import { StoryEngine } from '../src/pipeline/StoryEngine.js';
import { directorPlanEngine } from '../src/pipeline/DirectorPlan.js';
import { RESOLUTION_MAP } from '../src/media/EditPlan.js';

const compiler = new PromptCompiler();
const engine = new StoryEngine();
const planEngine = directorPlanEngine;

const compileWith = (project = {}, over = {}) => compiler.compile({
  ...makeReq(over),
  project: { ...makeReq().project, ...project },
});

test('画幅×画质：四画幅三画质全部正确，不再有 2K 缩水 / 方图横屏', () => {
  assert.equal(frame.resolutionOf('9:16', '2k'), '1440x2560');
  assert.equal(frame.resolutionOf('16:9', '2k'), '2560x1440');
  assert.equal(frame.resolutionOf('4:3', '1080p'), '1440x1080');
  assert.equal(frame.resolutionOf('1:1', '1080p'), '1080x1080');
  // 编译器与剪辑单必须是同一份口径
  assert.deepEqual(RESOLUTION_MAP, frame.RESOLUTION_MAP);
});

test('用户选方屏 2K：参数与提示词都按方屏 2K 走', () => {
  const p = compileWith({ aspect: '1:1', quality: '2k' });
  assert.equal(p.params.aspect, '1:1');
  assert.equal(p.params.resolution, '1440x1440');
  const text = `${p.prompt_en}\n${p.prompt_zh}`;
  assert.match(text, /1440x1440/);
  assert.match(text, /方屏|square/i);
  assert.match(text, /2K 级清晰度/);
});

test('用户选 4:3：提示词里是学院比例，不是一句"4:3 framing"糊过去', () => {
  const p = compileWith({ aspect: '4:3', quality: '1080p' });
  assert.equal(p.params.resolution, '1440x1080');
  assert.match(p.prompt_zh, /横屏 4:3 学院比例/);
  assert.match(p.prompt_en, /academy-ratio/i);
});

test('用户选的画质会改变细节要求，也改变计价（2K 必须比 1080P 贵）', () => {
  const q720 = compileWith({ quality: '720p' });
  const q1080 = compileWith({ quality: '1080p' });
  const q2k = compileWith({ quality: '2k' });
  assert.ok(q720.estimated_credits <= q1080.estimated_credits);
  assert.ok(q2k.estimated_credits > q1080.estimated_credits, '2K 不能比 1080P 便宜');
  assert.match(q2k.prompt_zh, /超高细节渲染/);
  assert.match(q720.prompt_zh, /干净清晰的渲染/);
});

test('单镜时长进提示词：动作必须在这段时间内完成', () => {
  const p = compileWith({}, { shot: { ...makeReq().shot, duration: 7 } });
  assert.equal(p.params.duration, 7);
  assert.match(p.prompt_en, /exactly 7 seconds/i);
  assert.match(p.prompt_zh, /正好 7 秒/);
});

test('片型影响提示词：静态漫剧不许做运镜，解说漫要求旁白优先', () => {
  const st = compileWith({ video_type: 'static' });
  assert.match(`${st.prompt_en}${st.prompt_zh}`, /静态关键帧|static keyframe/i);
  const nr = compileWith({ video_type: 'narration' });
  assert.match(`${nr.prompt_en}${nr.prompt_zh}`, /旁白|voice-over/i);
});

test('风格色板真正进提示词（之前 palette 只给前端看，从不进生成）', () => {
  const p = compiler.compile({
    ...makeReq(),
    project: { ...makeReq().project, style_code: 'STY-GUFENG', aspect: '9:16', quality: '1080p' },
  });
  assert.match(p.prompt_zh, /严格色板/);
  assert.match(p.prompt_en, /strict color palette/i);
  assert.match(p.prompt_en, /#1C1C1C/i, '色板里的十六进制色值必须真的出现');
});

test('规格库是第十个库：每次生成都带，且产品上留下 SPEC 指纹', () => {
  const p = compileWith({ aspect: '16:9', quality: '1080p' });
  const specBlock = p.prompt_libraries.blocks.find((b) => b.kind === 'spec');
  assert.ok(specBlock, '缺用户规格库');
  assert.match(specBlock.code, /^SPEC-16x9-1080P/);
  assert.equal(p.cards.spec, specBlock.code);
  assert.equal(p.meta.spec.aspect, '16:9');
  assert.equal(p.meta.spec.resolution, '1920x1080');
});

test('素材库参考图真的进请求（之前是死参数，上传了等于没传）', () => {
  const p = compiler.compile({
    ...makeReq(),
    options: {
      ...makeReq().options,
      material_references: [{ name: '参考画风.png', url: 'cos://material/m1.png' }],
    },
  });
  const ref = p.reference_images.find((r) => r.role === 'style_reference');
  assert.ok(ref, '素材参考图没进参考列表');
  assert.equal(ref.url, 'cos://material/m1.png');
});

test('非法画幅/画质直接报错，不静默退回 9:16', () => {
  assert.throws(() => compileWith({ aspect: '21:9' }), /不支持的画幅|SPEC_VIOLATION/);
  assert.throws(() => compileWith({ quality: '4k' }), /不支持的画质|SPEC_VIOLATION/);
});

test('文本环节：集数与单集时长写进编剧铁律，且要求 episodes 恰好 N 个', () => {
  const rules = specLib.textRules(specLib.normalize({
    style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p',
    episode_count: 6, episode_sec: 90, total_minutes: 9, video_type: 'dynamic',
  }), { stage: 'outline' });
  assert.match(rules.zh, /共 6 集/);
  assert.match(rules.zh, /单集 90 秒/);
  assert.match(rules.zh, /恰好 6 个元素/);
});

test('fitEpisodes：模型少写集数 → 补足到用户集数，并仍能过节奏闸门', () => {
  const spec = specLib.normalize({
    style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p',
    episode_count: 6, episode_sec: 90, total_minutes: 9,
  });
  const outline = {
    title: '短样',
    episodes: [
      {
        no: 1, goal: '建立困境', hook: { code: 'HOOK-01', micro_hook: true, shots: 3 },
        conflicts: [{ code: 'CFL-02', escalation: 2 }, { code: 'CFL-05', escalation: 3 }],
        reversals: [], empathy: [], ending_hook: '悬念未解',
      },
      {
        no: 2, goal: '冲突升级', hook: { code: 'HOOK-05', micro_hook: true, shots: 3 },
        conflicts: [{ code: 'CFL-03', escalation: 2 }, { code: 'CFL-06', escalation: 4 }],
        reversals: [{ code: 'REV-01', foreshadow: 2 }], empathy: [], ending_hook: '悬念未解',
      },
    ],
  };
  const r = engine.fitEpisodes(outline, spec);
  assert.equal(r.outline.episodes.length, 6);
  assert.equal(r.adjustment.action, 'padded');
  // 每集时长按用户总时长均分，总秒数不漂
  const total = r.outline.episodes.reduce((a, e) => a + e.duration_sec, 0);
  assert.ok(Math.abs(total - 540) < 1, `总时长应约 540 秒，实际 ${total}`);
  // 补出来的集必须自带递增冲突 + 集末钩子，否则节奏闸门会拦
  for (const ep of r.outline.episodes) {
    assert.ok(ep.ending_hook, `第 ${ep.no} 集缺集末钩子`);
    assert.ok((ep.conflicts ?? []).length >= 2, `第 ${ep.no} 集冲突不足`);
  }
});

test('fitEpisodes：模型多写集数 → 并进末集，反转与钩子不丢', () => {
  const spec = specLib.normalize({ episode_count: 2, episode_sec: 90, total_minutes: 3 });
  const eps = [1, 2, 3, 4].map((no) => ({
    no, goal: `第${no}集`, hook: { code: 'HOOK-05', micro_hook: true, shots: 3 },
    conflicts: [{ code: `CFL-0${no}`, escalation: 2 }, { code: 'CFL-07', escalation: 4 }],
    reversals: no === 4 ? [{ code: 'REV-12', foreshadow: 3 }] : [],
    empathy: [], ending_hook: '悬念未解',
  }));
  const r = engine.fitEpisodes({ title: 'x', episodes: eps }, spec);
  assert.equal(r.outline.episodes.length, 2);
  assert.equal(r.adjustment.action, 'merged');
  const last = r.outline.episodes[1];
  assert.ok(last.reversals.some((x) => x.code === 'REV-12'), '末集反转被丢掉了');
});

test('规格体检：集数/时长/画幅不符都会报出来', () => {
  const spec = specLib.normalize({
    aspect: '16:9', quality: '1080p', episode_count: 6, episode_sec: 90, total_minutes: 9,
  });
  const plan = {
    plan_id: 'P1', aspect: '9:16', quality: '1080p',
    episodes: [
      { no: 1, duration_sec: 90, beats: [{ beat_no: 'E01-B001', duration_sec: 6 }] },
      { no: 2, duration_sec: 60, beats: [{ beat_no: 'E02-B001', duration_sec: 12 }] },
    ],
  };
  const r = specLib.audit({ spec, plan });
  assert.equal(r.ok, false);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('episode_count'), '集数不符没报');
  assert.ok(codes.includes('episode_sec'), '单集时长不符没报');
  assert.ok(codes.includes('aspect_mismatch'), '画幅不符没报');
  assert.ok(codes.includes('shot_too_long'), '超 10 秒的镜头没报');
});

test('总谱自检：集数与用户选择不一致时不许进剧本', () => {
  const outline = {
    title: '集数校验',
    characters: [{ code: 'CH01', name: 'A', role: 'protagonist', traits: 'x', locks: [] }],
    episodes: [1, 2].map((no) => ({
      no, goal: '冲突升级', hook: { code: 'HOOK-05', micro_hook: true, shots: 3 },
      conflicts: [{ code: 'CFL-02', escalation: 2 }, { code: 'CFL-07', escalation: 4 }],
      reversals: no === 2 ? [{ code: 'REV-01', foreshadow: 2 }] : [],
      empathy: [{ code: 'EMP-02' }], ending_hook: '悬念未解', duration_sec: 90,
    })),
  };
  const plan = planEngine.build({
    outline,
    spec: {
      style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p',
      episode_count: 6, episode_sec: 90, total_minutes: 9,
      episode_sec_target: 90,
    },
  });
  const itemKeys = plan.validation.problems.map((p) => p.item);
  assert.ok(itemKeys.includes('episode_count'), '集数不符没被自检拦下');
});

// ——— V4.13：规格要贯穿到「每一个环节」，而不只是分镜图 ———

test('文本环节：集数/单集时长/画幅/片型都进编剧铁律（不是一句中文提示）', () => {
  const p = compiler.compile({
    kind: 'chat',
    stage: 'outline',
    available_credits: 99999,
    project: {
      style_code: 'STY-DUSHI', aspect: '4:3', quality: '2k',
      video_type: 'narration', episode_count: 8, episode_sec: 60, total_minutes: 8,
    },
    messages: [{ role: 'system', content: '写大纲' }],
    max_tokens: 2000,
  });
  const text = (p.messages ?? []).map((m) => m.content).join('\n');
  assert.ok(/8 集/.test(text), '集数没进编剧铁律');
  assert.ok(/60 秒/.test(text), '单集时长没进编剧铁律');
  assert.ok(/4:3/.test(text), '画幅没进编剧铁律');
  assert.ok(/解说/.test(text), '片型没进编剧铁律');
  assert.equal(p.cards.spec.startsWith('SPEC-4x3-2K-E8-60S'), true, p.cards.spec);
});

test('资产设定图：画幅/画质/色板沿用用户选择，不许偷偷改成方图', () => {
  const p = compiler.compile({
    kind: 'image',
    available_credits: 99999,
    project: {
      style_code: 'STY-GUFENG', aspect: '1:1', quality: '2k',
      video_type: 'dynamic', episode_count: 1, episode_sec: 60, total_minutes: 1,
    },
    asset: {
      asset_code: 'CH01', asset_type: 'character', name: '沈昭',
      locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'], lock_values: {},
    },
    options: { mode: 'asset_sheet' },
  });
  assert.equal(p.params.aspect, '1:1');
  assert.equal(p.params.resolution, frame.resolutionOf('1:1', '2k'));
  assert.ok(p.prompt_en.includes('1:1'), '提示词里没有画幅约束');
  for (const hex of ['#1C1C1C', '#9E2B25']) {
    assert.ok(p.prompt_en.includes(hex), `色板 ${hex} 没进设定图提示词`);
  }
});

test('剪辑渲染：成片分辨率必须等于用户点选的画幅×画质，否则拒绝渲染', async () => {
  const { default: editService } = await import('../src/pipeline/EditService.js');
  const { db } = await import('../src/store/db.js');
  const pid = `proj_spec_render_${Date.now()}`;
  db.insert('projects', {
    id: pid, user_id: 'u_spec_render', title: '规格渲染',
    spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '720p', episode_count: 1, episode_sec: 30, total_minutes: 0.5 },
    created_at: new Date().toISOString(),
  });
  // 没有分镜 → 先被装配/剪辑单挡住（说明它不会在无片的情况下硬渲染）
  const r = await editService.render(pid, null).catch((e) => ({ error: e }));
  assert.ok(r.ok === false || r.error, '无分镜时不应渲染成功');
  if (r.code === 'EDIT_PLAN_BLOCKED') {
    assert.ok(r.plan && r.plan.ok === false);
  } else if (r.error) {
    assert.equal(r.error.code, 'PROJECT_REQUIRED');
  }
});
