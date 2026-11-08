/**
 * V4.13 三十多个风格：选了哪一个，产物就必须长成哪一个。
 *
 * 审计动机（用户原话）："确保用户选三十多个风格的其中一个后，实际产出的产物符合用户要求"。
 * 当时确实存在断点：风格色板只给前端画色块、transition_bias 与 rhythm_params 没人读、
 * 成片连一个像素的风格信息都没有。这里对**32 个风格逐个**跑一遍：
 *  1. 图片 / 视频 / 资产设定图 / 文本 四个环节都能拿到这套风格的完整描述；
 *  2. 色板与负面词真的进了提示词（不再是"只在前端显示"）；
 *  3. 总谱里落一份 style_contract，并且转场偏好真的影响拍法；
 *  4. 风格之间不串味（A 的画风描述不会出现在 B 的提示词里）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import seeds from '../src/seeds/loader.js';
import compiler from '../src/compiler/PromptCompiler.js';
import storyEngine from '../src/pipeline/StoryEngine.js';
import directorPlanEngine from '../src/pipeline/DirectorPlan.js';
import { resolutionOf } from '../src/core/frame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'seeds', 'data', 'style_presets.json'), 'utf8'),
);

const ASSETS = {
  characters: {
    CH01: {
      asset_code: 'CH01', name: '沈昭',
      locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'],
      image_url: 'cos://asset/CH01.png',
    },
  },
  scenes: {
    SC01: {
      asset_code: 'SC01', name: '厅堂',
      locks: ['木柱', '高窗', '冷顶光'],
      image_url: 'cos://asset/SC01.png',
    },
  },
  props: {},
  emotions: {},
};

function baseReq(style, kind = 'image', extra = {}) {
  return {
    kind,
    available_credits: 99999,
    project: {
      style_code: style.code, aspect: '9:16', quality: '1080p', video_type: 'dynamic',
      episode_count: 1, episode_sec: 60, total_minutes: 1,
    },
    shot_no: 'E01-S001',
    shot: {
      duration: 5, shot_card: 'SHT-MS', camera_move: 'SHT-PUSH',
      characters: ['CH01'], scene: 'SC01', props: [],
      action_start: '推门', action_end: '回头',
      emotions: { CH01: 'EMO-CALM-02' }, dialogue: '',
    },
    lighting: { codes: [] },
    transition: { code: 'TRN-HARDCUT' },
    assets: ASSETS,
    options: { allow_pending_reference: true },
    ...extra,
  };
}

test('风格种子：32 个风格的必填项齐全（画风/色板/转场偏好/节奏参数/负面词）', () => {
  assert.equal(STYLES.length, 32);
  for (const s of STYLES) {
    assert.ok(s.art_prompt_zh && s.art_prompt_en, `${s.code} 缺画风描述`);
    assert.ok((s.palette ?? []).length >= 3, `${s.code} 色板不足 3 色`);
    assert.ok(Object.keys(s.transition_bias ?? {}).length >= 1, `${s.code} 缺转场偏好`);
    assert.ok((s.rhythm_params?.conflict_per_episode ?? 0) >= 1, `${s.code} 缺节奏参数`);
    assert.ok((s.negative_extra ?? []).length >= 1, `${s.code} 缺负面词`);
    assert.ok(seeds.director(s.director_profile_default), `${s.code} 默认导演不存在`);
  }
});

test('图片环节：32 个风格逐个核对画风/色板/负面词都进了提示词', () => {
  for (const s of STYLES) {
    const p = compiler.compile(baseReq(s));
    assert.ok(p.prompt_zh.includes(s.name), `${s.code} 提示词里没有风格名`);
    assert.ok(p.prompt_zh.includes(s.art_prompt_zh.slice(0, 12)), `${s.code} 缺中文画风描述`);
    assert.ok(p.prompt_en.includes(s.art_prompt_en.slice(0, 20)), `${s.code} 缺英文画风描述`);
    for (const hex of s.palette) {
      assert.ok(p.prompt_en.includes(hex), `${s.code} 色板 ${hex} 没进提示词`);
    }
    for (const neg of s.negative_extra) {
      assert.ok(p.prompt_zh.includes(neg), `${s.code} 负面词「${neg}」没进提示词`);
    }
    assert.equal(p.cards.style, s.code);
    assert.ok(p.cards.spec, `${s.code} 缺规格指纹`);
  }
});

test('视频环节：32 个风格同样带全套风格约束', () => {
  for (const s of STYLES) {
    const p = compiler.compile(baseReq(s, 'video', {
      shot: { ...baseReq(s).shot, first_frame_url: 'cos://asset/E01-S001.png' },
    }));
    assert.equal(p.kind, 'video');
    assert.ok(p.prompt_zh.includes(s.art_prompt_zh.slice(0, 12)), `${s.code} 视频缺画风`);
    for (const hex of s.palette) assert.ok(p.prompt_en.includes(hex), `${s.code} 视频色板缺 ${hex}`);
    assert.ok(p.params.duration > 0);
  }
});

test('资产设定图：沿用用户画幅与画质，并带同一套风格色板', () => {
  for (const s of [STYLES[0], STYLES[10], STYLES[31]]) {
    const project = { style_code: s.code, aspect: '16:9', quality: '2k', video_type: 'dynamic', episode_count: 1, episode_sec: 60, total_minutes: 1 };
    const p = compiler.compile({
      kind: 'image',
      available_credits: 99999,
      project,
      asset: {
        asset_code: 'CH01', asset_type: 'character', name: '沈昭',
        locks: ['黑发束冠', '左眉疤', '青灰长衫', '布靴'],
        lock_values: { traits: '清瘦' },
      },
      options: { mode: 'asset_sheet' },
    });
    assert.equal(p.asset_sheet, true);
    assert.equal(p.params.aspect, '16:9', '设定图不能偷偷改成 1:1');
    assert.equal(p.params.resolution, resolutionOf('16:9', '2k'));
    for (const hex of s.palette) assert.ok(p.prompt_en.includes(hex), `${s.code} 设定图缺色板 ${hex}`);
    assert.ok(p.prompt_zh.includes(s.name), `${s.code} 设定图缺风格名`);
  }
});

test('风格不串味：A 的画风描述不会出现在 B 的提示词里', () => {
  const a = compiler.compile(baseReq(STYLES[0]));
  for (const other of STYLES.slice(1)) {
    assert.ok(!a.prompt_zh.includes(other.art_prompt_zh.slice(0, 12)) || other.code === STYLES[0].code,
      `A 的提示词里出现了 ${other.code} 的画风`);
  }
});

test('总谱：style_contract 完整落库，风格参数可追溯', async () => {
  const spec = {
    style_code: 'STY-XUANYI', director_code: 'DIR-NOIR',
    aspect: '9:16', quality: '1080p', total_minutes: 3, episode_sec: 90, episode_count: 2,
  };
  const { outline } = await storyEngine.outline({
    userId: 'u_style', projectId: 'p_style', prompt: '守夜人连查三桩命案，最后一桩死者是自己', spec,
  });
  const plan = storyEngine.directorPlan({ outline, spec, projectId: 'p_style' });
  const c = plan.global.style_contract;
  const s = seeds.style('STY-XUANYI');
  assert.ok(c, '总谱里必须有风格契约');
  assert.equal(c.code, s.code);
  assert.equal(c.name, s.name);
  assert.deepEqual(c.palette, s.palette);
  assert.deepEqual(c.transition_bias, s.transition_bias);
  assert.deepEqual(c.rhythm_params, s.rhythm_params);
  assert.deepEqual(c.negative_extra, s.negative_extra);
  assert.ok(plan.episodes.length >= 1);
});

test('转场：风格的 transition_bias 真的影响拍法（古风用得上叠化/物象划）', async () => {
  const spec = {
    style_code: 'STY-GUFENG', director_code: 'DIR-LYRIC',
    aspect: '9:16', quality: '1080p', total_minutes: 6, episode_sec: 90, episode_count: 4,
  };
  const { outline } = await storyEngine.outline({
    userId: 'u_style2', projectId: 'p_style2', prompt: '旧宅里的一封家书牵出二十年旧案', spec,
  });
  const plan = storyEngine.directorPlan({ outline, spec, projectId: 'p_style2' });
  const bias = Object.keys(seeds.style('STY-GUFENG').transition_bias);
  const used = new Set(plan.episodes.flatMap((e) => e.beats.map((b) => b.transition)));
  const hit = [...used].filter((t) => bias.includes(t) && t !== 'TRN-HARDCUT');
  assert.ok(hit.length >= 1, `古风的转场偏好一个都没用上，实际用到：${[...used].join('/')}`);
});

test('风格偏差审计：风格声明与总谱实际不符时必须报出来', async () => {
  const spec = {
    style_code: 'STY-XUANYI', director_code: 'DIR-NOIR',
    aspect: '9:16', quality: '1080p', total_minutes: 3, episode_sec: 90, episode_count: 2,
  };
  const { outline } = await storyEngine.outline({
    userId: 'u_style3', projectId: 'p_style3', prompt: '雨夜连环案', spec,
  });
  const plan = storyEngine.directorPlan({ outline, spec, projectId: 'p_style3' });
  // 正常规划：不该报"色板缺失 / 风格不存在"
  const ok = directorPlanEngine.auditStyle(plan);
  assert.ok(!ok.some((w) => w.item === 'style.palette'), '正常规划不应报色板缺失');

  // 把转场全改成硬切 → 必须报"偏好转场一个都没用上"
  const broken = structuredClone(plan);
  for (const ep of broken.episodes) for (const b of ep.beats) b.transition = 'TRN-HARDCUT';
  const warns = directorPlanEngine.auditStyle(broken);
  assert.ok(warns.some((w) => w.item === 'style.transition_bias'), '转场偏好未落地却没报');
});
