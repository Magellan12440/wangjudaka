/**
 * V4.17 导演引擎 2.0。
 *
 * 本轮改动对应四个"看得见的病"：
 *  1. 一集里每一镜时长完全一样 → 节奏库算了等于没算（快慢对比恒为 1.0）
 *  2. 总谱里没有任何一处说清"这部片要什么感觉" → 各环节各自理解风格
 *  3. 分镜表缺第 9 列"叙事目的" → 无法回答"这一镜为什么这么长"
 *  4. 一致性只管人和物崩没崩，没人管"这组镜头剪起来顺不顺"
 *
 * 另外把公开的生成失败模式（超字数 / 多参考图同框 / 参考图与文字打架）做成花钱前的预检。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, functionOf, NARRATIVE_FUNCTIONS, MIN_SHOT_SEC, MAX_SHOT_SEC } from '../src/director/ShotTiming.js';
import directingBrief from '../src/director/DirectingBrief.js';
import shotGrammar from '../src/director/ShotGrammar.js';
import { audit as auditBudget } from '../src/director/PromptBudget.js';
import storyEngine from '../src/pipeline/StoryEngine.js';
import compiler from '../src/compiler/PromptCompiler.js';
import ledger from '../src/ledger/Ledger.js';
import seeds from '../src/seeds/loader.js';
import { db } from '../src/store/db.js';
import assetLibrary from '../src/assets/AssetLibrary.js';

const U = 'u_d17';
const P = 'proj_d17';
const SPEC = {
  style_code: 'STY-XUANYI', director_code: 'DIR-INTENSE',
  aspect: '9:16', quality: '1080p', total_minutes: 6, episode_sec: 90, episode_count: 4,
};

test('时长模型：总和精确等于本集时长，且每镜都在硬边界内', () => {
  const beats = Array.from({ length: 24 }, (_, i) => ({
    beat_no: `B${i}`, beat_purpose: i === 0 ? '黄金三秒开场' : i === 23 ? '集末钩子' : '推进',
    shot_card: i % 3 === 0 ? 'SHT-CU' : 'SHT-MS', tension: 3,
  }));
  const r = allocate({ beats, epSec: 90, seed: 'ep1' });
  assert.equal(r.items.length, 24);
  const sum = r.items.reduce((a, x) => a + x.duration_sec, 0);
  assert.ok(Math.abs(sum - 90) < 0.05, `总和 ${sum} 应等于 90`);
  for (const it of r.items) {
    assert.ok(it.duration_sec >= MIN_SHOT_SEC && it.duration_sec <= MAX_SHOT_SEC, `${it.beat_no} 时长越界 ${it.duration_sec}`);
  }
});

test('时长模型：快慢对比不再恒为 1（旧实现每镜一样长）', () => {
  const beats = [
    { beat_no: 'B1', beat_purpose: '黄金三秒开场', shot_card: 'SHT-CU', tension: 4.5 },
    { beat_no: 'B2', beat_purpose: '推进', shot_card: 'SHT-MS', tension: 4 },
    { beat_no: 'B3', beat_purpose: '冲突升级 L2', shot_card: 'SHT-MS', tension: 4.2 },
    { beat_no: 'B4', beat_purpose: '反转落点', shot_card: 'SHT-CU', tension: 4.6 },
    { beat_no: 'B5', beat_purpose: '共情高点', shot_card: 'SHT-MCU', tension: 3 },
    { beat_no: 'B6', beat_purpose: '推进', shot_card: 'SHT-MS', tension: 3.6 },
    { beat_no: 'B7', beat_purpose: '推进', shot_card: 'SHT-MS', tension: 3.8 },
    { beat_no: 'B8', beat_purpose: '集末钩子', shot_card: 'SHT-MCU', tension: 5 },
  ];
  const r = allocate({ beats, epSec: 32, seed: 'contrast' });
  assert.ok(r.stats.contrast > 1.4, `快慢对比 ${r.stats.contrast} 应大于 1.4`);
  assert.ok(r.stats.max > r.stats.min, '最长镜必须比最短镜长');
});

test('时长模型：镜数少、集时长长时不能被卡上限拖短', () => {
  // 13 镜排 86 秒，中景卡 len_hint 上限只有 6 秒 —— 不放开就会整集短 40%
  const beats = Array.from({ length: 13 }, (_, i) => ({
    beat_no: `B${i}`, beat_purpose: '推进', shot_card: 'SHT-MS', tension: 3,
  }));
  const r = allocate({ beats, epSec: 85.71, seed: 'cap' });
  const sum = r.items.reduce((a, x) => a + x.duration_sec, 0);
  assert.ok(Math.abs(sum - 85.71) < 0.05, `总和 ${sum}`);
});

test('叙事目的：结构位映射正确，且每个目的都有基准时长与理由', () => {
  assert.equal(functionOf({ purpose: '黄金三秒开场' }), 'hook');
  assert.equal(functionOf({ purpose: '集末钩子' }), 'endHook');
  assert.equal(functionOf({ purpose: '反转落点' }), 'turn');
  assert.equal(functionOf({ purpose: '共情高点' }), 'empathy');
  assert.equal(functionOf({ purpose: '冲突升级 L3' }), 'advance');
  assert.equal(functionOf({ purpose: '推进', index: 2, per: 10 }), 'establish');
  for (const [k, v] of Object.entries(NARRATIVE_FUNCTIONS)) {
    assert.ok(v.label && v.why && Array.isArray(v.range), `${k} 元数据不全`);
    assert.ok(v.range[1] <= MAX_SHOT_SEC + 2, `${k} 基准上限超过硬边界`);
  }
});

test('导演定调：同一输入永远同一份，且每项都带可核对的 target', () => {
  const style = seeds.style('STY-XUANYI');
  const director = seeds.director('DIR-INTENSE');
  const outline = { title: '龙魂', logline: '废柴觉醒', characters: [{ code: 'CH01', name: '林默', role: 'protagonist' }] };
  const a = directingBrief.build({ outline, spec: SPEC, style, director });
  const b = directingBrief.build({ outline, spec: SPEC, style, director });
  assert.deepEqual(a, b, '定调必须是确定性的，不能每次刷新都变');
  assert.ok(a.tone.includes(style.name) && a.tone.includes(director.name));
  assert.ok(a.one_liner.includes('林默'));
  assert.ok(a.checkpoints.length >= 4);
  assert.ok(a.checkpoints.find((c) => c.key === 'contrast').target >= 1.5);
  assert.ok(a.avoid.length >= 2, '负向约束不能为空（模型不会自动"不做"什么）');
  assert.ok(a.color.roles.length >= 2);
});

test('总谱：定调与叙事目的真的落进产物', async () => {
  ledger.recharge({ userId: U, points: 5000, idemKey: 'd17-1' });
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: '废柴少年觉醒龙魂', spec: SPEC });
  const plan = storyEngine.directorPlan({ outline, spec: SPEC });
  assert.ok(plan.global.directing_brief, '总谱必须带定调');
  assert.equal(plan.global.directing_brief.derived_from.style, SPEC.style_code);

  const beats = plan.episodes.flatMap((e) => e.beats);
  assert.ok(beats.every((b) => b.narrative_function), '每个 beat 都要有叙事目的');
  assert.ok(beats.every((b) => b.narrative_intent), '每个 beat 都要有一句话意图');

  // 节奏对比必须真的起来（旧实现这里会是 1.00）
  for (const ep of plan.episodes) {
    assert.ok(ep.timing, `EP${ep.no} 缺节奏统计`);
    assert.ok(ep.timing.contrast > 1.0, `EP${ep.no} 快慢对比仍为 ${ep.timing.contrast}`);
  }
  const total = plan.episodes.reduce((a, e) => a + e.beats.reduce((x, b) => x + b.duration_sec, 0), 0);
  assert.ok(Math.abs(total - plan.stats.total_sec) < 1, '分集时长之和必须与统计一致');
});

test('分镜：第 9 列叙事目的带到分镜表里', async () => {
  const { outline } = await storyEngine.outline({ userId: U, projectId: P, prompt: 'x', spec: SPEC });
  const sb = await storyEngine.storyboard({ outline, spec: SPEC });
  assert.ok(sb.shots.length > 0);
  assert.ok(sb.shots.every((s) => s.narrative_function), '分镜缺叙事目的');
  const hook = sb.shots.find((s) => s.narrative_function === 'hook');
  assert.ok(hook, '开场钩子必须被标出来');
  assert.match(hook.narrative_intent, /开场钩子/);
});

test('语法体检：整集一个节奏、连用同景别、开场不通空间全都抓得住', () => {
  // 造一组"每镜 4 秒、全是中景、全靠硬切、开场直接中景"的镜头：典型 PPT 片子
  const shots = Array.from({ length: 10 }, (_, i) => ({
    no: `E01-S${String(i + 1).padStart(3, '0')}`, episode: 1, index: i + 1,
    duration: 4, shot_card: 'SHT-MS', camera_move: 'SHT-STATIC', transition: 'TRN-HARDCUT',
    is_episode_end: i === 9,
  }));
  const r = shotGrammar.audit({ shots, directorCode: 'DIR-BALANCED' });
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('NO_CONTRAST'), '整集一个节奏必须报');
  assert.ok(codes.includes('REPEAT_CARD'), '连续同景别必须报');
  assert.ok(codes.includes('NO_ESTABLISH'), '开场没交代空间必须报');
  assert.ok(r.score < 80, `分数应偏低，实际 ${r.score}`);
});

test('语法体检：合规的一组镜头不该被误杀', () => {
  const shots = [
    { no: 'S1', episode: 1, duration: 5, shot_card: 'SHT-WS', camera_move: 'SHT-STATIC', transition: 'TRN-HARDCUT' },
    { no: 'S2', episode: 1, duration: 3, shot_card: 'SHT-MS', camera_move: 'SHT-TRACK', transition: 'TRN-HARDCUT' },
    { no: 'S3', episode: 1, duration: 2.5, shot_card: 'SHT-CU', camera_move: 'SHT-PUSH', transition: 'TRN-HARDCUT' },
    { no: 'S4', episode: 1, duration: 2.5, shot_card: 'SHT-MCU', camera_move: 'SHT-HAND', transition: 'TRN-XFADE' },
    { no: 'S5', episode: 1, duration: 6, shot_card: 'SHT-MS', camera_move: 'SHT-STATIC', transition: 'TRN-HARDCUT' },
    { no: 'S6', episode: 1, duration: 4, shot_card: 'SHT-CU', camera_move: 'SHT-STATIC', transition: 'TRN-FREEZE', is_episode_end: true },
  ];
  const r = shotGrammar.audit({ shots });
  assert.equal(r.ok, true);
  assert.equal(r.counts.error, 0);
  assert.ok(r.score >= 78, `分数 ${r.score} 偏低，误杀了`);
});

test('语法体检：时长越界是硬错', () => {
  const r = shotGrammar.audit({
    shots: [
      { no: 'S1', episode: 1, duration: 14, shot_card: 'SHT-MS', transition: 'TRN-HARDCUT' },
      { no: 'S2', episode: 1, duration: 0.4, shot_card: 'SHT-CU', transition: 'TRN-HARDCUT' },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.filter((i) => i.severity === 'error').map((i) => i.code).sort(),
    ['DURATION_OVER', 'DURATION_UNDER']);
});

test('提示词预算：超字数、参考图同框过多、有参考还重描身体都要报', () => {
  const longPrompt = `cinematic ${'very detailed description '.repeat(70)}`;
  const over = auditBudget({ prompt: longPrompt, maxChars: 500 });
  assert.ok(over.warnings.some((w) => w.code === 'PROMPT_OVER_BUDGET'), '超字数必须报');
  assert.ok(over.level === 'warn');

  const refs = [
    { role: 'character', url: 'a' }, { role: 'character', url: 'b' },
    { role: 'scene', url: 'c' }, { role: 'style_reference', url: 'd' },
  ];
  const overload = auditBudget({ prompt: 'a girl', references: refs });
  assert.ok(overload.warnings.some((w) => w.code === 'REF_OVERLOAD'));

  const conflict = auditBudget({
    prompt: '主角，发型凌乱，脸型瘦削，肤色偏冷',
    references: [{ role: 'character', url: 'a' }],
  });
  assert.ok(conflict.warnings.some((w) => w.code === 'REF_DESCRIBE_CONFLICT'), '有参考图还重描长相要拦');

  const clean = auditBudget({ prompt: 'a wide shot of an empty street at dusk', references: [{ role: 'scene', url: 'a' }] });
  assert.equal(clean.level, 'ok');
});

test('编译器：产物带 budget 快照，超预算进 compile_warnings', async () => {
  // 编译器要求"至少有一处可引用的稳定特征"，所以给一个场景资产（这测的是预算，不是锁）
  const pid = `p_budget_${Date.now()}`;
  db.insert('projects', {
    id: pid, user_id: U, title: '预算样本',
    spec: { style_code: SPEC.style_code, aspect: SPEC.aspect, quality: SPEC.quality },
    created_at: new Date().toISOString(),
  });
  const scene = assetLibrary.create({
    projectId: pid, assetType: 'scene', name: '雨夜天台', code: 'SC01',
    locks: ['水泥天台', '锈蚀护栏', '霓虹反光', '积水倒影'],
    // 场景参考图是 required：没图会被 MISSING_REFERENCE 拦下（这测的是预算，不是缺图）
    imageUrl: 'https://cdn.example.com/sc01.jpg',
  });
  const shot = {
    no: 'E01-S000', duration: 4, shot_card: 'SHT-WS', camera_move: 'SHT-STATIC',
    lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT', characters: [], scene: 'SC01', props: [],
    dialogue: null, speaker: null, ambient: [], ambient_sound: 'room tone', music_entry: 'No music',
  };
  const p = compiler.compile({
    shot_no: shot.no, kind: 'image', shot,
    // 编译器要的是按类型分组的索引，不是数组
    assets: { characters: {}, scenes: { [scene.asset_code ?? 'SC01']: scene }, props: {} },
    model: 'IMG-TT-26',
    project: { style_code: SPEC.style_code, aspect: SPEC.aspect, quality: SPEC.quality },
    libraries: {},
    available_credits: 9999,
  });
  assert.ok(p.budget, '编译产物必须带预算快照');
  assert.equal(typeof p.budget.chars, 'number');
  assert.ok(p.budget.cap >= 200);
  assert.ok(Array.isArray(p.budget.warnings));
});
