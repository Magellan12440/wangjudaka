import { test } from 'node:test';
import assert from 'node:assert/strict';
import timeline from '../src/media/Timeline.js';
import renderer from '../src/media/Renderer.js';

const segs = [
  { shot_no: 'E01-S001', clip_url: 'a.mp4', duration: 5, transition: 'TRN-HARDCUT' },
  { shot_no: 'E01-S002', clip_url: 'b.mp4', duration: 5, transition: 'TRN-HARDCUT' },
  { shot_no: 'E01-S003', clip_url: 'c.mp4', duration: 5, transition: 'TRN-HARDCUT' },
];

test('全硬切时间线合法并累计时长', () => {
  const t = timeline.build(segs);
  assert.equal(t.ok, true);
  assert.equal(t.total_sec, 15);
  assert.equal(t.non_hard_ratio, 0);
});

test('规则1：非硬切必须有理由', () => {
  const t = timeline.build([{ shot_no: 'S1', clip_url: 'a.mp4', duration: 5, transition: 'TRN-XFADE' }]);
  assert.equal(t.ok, false);
  assert.equal(t.errors[0].code, 'TRANSITION_REASON_REQUIRED');
});

test('规则2：非硬切占比超限被拒（普通导演 30%）', () => {
  const many = Array.from({ length: 4 }, (_, i) => ({
    shot_no: `S${i}`, clip_url: 'a.mp4', duration: 5,
    transition: 'TRN-XFADE', transition_reason: '抒情',
  }));
  const t = timeline.build(many);
  assert.ok(t.errors.some((e) => e.code === 'NON_HARD_RATIO_EXCEEDED' || e.code === 'TRANSITION_TOO_DENSE'));
});

test('爽感型导演阈值更严（10%）', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    shot_no: `S${i}`, clip_url: 'a.mp4', duration: 10,
    transition: 'TRN-XFADE', transition_reason: '抒情',
  }));
  const t = timeline.build(many, { directorProfile: 'DIR-INTENSE' });
  assert.ok(t.errors.some((e) => e.code === 'NON_HARD_RATIO_EXCEEDED'));
});

test('规则3：时序跳跃 > 1 天必须用叠化/黑场/白闪', () => {
  const t = timeline.build([{ shot_no: 'S1', clip_url: 'a.mp4', duration: 5, transition: 'TRN-HARDCUT', time_jump_days: 3 }]);
  assert.ok(t.errors.some((e) => e.code === 'TIME_JUMP_TRANSITION_REQUIRED'));
});

test('规则5：集末禁止硬切', () => {
  const t = timeline.build([{ shot_no: 'S1', clip_url: 'a.mp4', duration: 5, transition: 'TRN-HARDCUT', is_episode_end: true }]);
  assert.ok(t.errors.some((e) => e.code === 'EPISODE_END_NEEDS_FREEZE_OR_FADE'));
});

test('规则7：对白进行中禁止花哨转场', () => {
  const t = timeline.build([{ shot_no: 'S1', clip_url: 'a.mp4', duration: 5, transition: 'TRN-SLIDE-L', transition_reason: '快节奏', dialogue: '你好' }]);
  assert.ok(t.errors.some((e) => e.code === 'TRANSITION_FORBIDDEN_DURING_DIALOGUE'));
});

test('集末钩子规则：四种才算合格', () => {
  assert.equal(timeline.checkEnding({ ending_hook: '悬念未解' }).ok, true);
  assert.equal(timeline.checkEnding({ ending_hook: '平铺收尾' }).ok, false);
});

test('FFmpeg 命令包含 AI 标识烧录与响度归一', () => {
  const t = timeline.build(segs);
  const r = renderer.buildCommand({ timeline: t, audio: { bgm_url: 'bgm.mp3' }, output: 'out/E01.mp4' });
  assert.ok(r.cmd.includes('ffmpeg -y'));
  assert.ok(r.cmd.includes('drawtext'), '必须烧录 AI 标识');
  assert.ok(r.cmd.includes('loudnorm=I=-16'), '必须做 -16 LUFS 响度归一');
  assert.ok(r.cmd.includes('ai_generated="true"'), '必须写元数据标识');
  assert.ok(r.cmd.includes('concat'), '硬切走 concat');
});

test('非硬切转场生成 xfade 表达式', () => {
  const t = timeline.build([
    { shot_no: 'S1', clip_url: 'a.mp4', duration: 5, transition: 'TRN-HARDCUT' },
    { shot_no: 'S2', clip_url: 'b.mp4', duration: 5, transition: 'TRN-HARDCUT' },
    { shot_no: 'S3', clip_url: 'c.mp4', duration: 5, transition: 'TRN-HARDCUT' },
    { shot_no: 'S4', clip_url: 'd.mp4', duration: 5, transition: 'TRN-XFADE', transition_reason: '时间流逝' },
  ]);
  assert.equal(t.ok, true, JSON.stringify(t.errors));
  const r = renderer.buildCommand({ timeline: t });
  assert.ok(r.cmd.includes('xfade=transition=fade'));
});

test('配乐规格：每镜都有情绪与音量，ducking 默认开启', () => {
  const t = timeline.build(segs);
  const m = renderer.buildMusicSpec({ timeline: t, moodByShot: { 'E01-S001': 'suspense' } });
  assert.equal(m.timeline.length, 3);
  assert.equal(m.master_loudness.target_lufs, -16);
  assert.equal(m.ducking.reduction_db, -12);
});

test('交付包含 AI 创作说明与证据清单', () => {
  const t = timeline.build(segs);
  const m = renderer.buildMusicSpec({ timeline: t });
  const pkg = renderer.buildDeliveryPackage({ projectId: 'P1', episodeNo: 'E01', timeline: t, musicSpec: m });
  assert.ok(pkg.files.some((f) => f.type === 'declaration'));
  assert.ok(pkg.ai_evidence.length >= 7);
  assert.equal(pkg.ai_label.removable, false, 'AI 标识不可去除');
  assert.equal(pkg.ai_label.head_3s, true);
});
