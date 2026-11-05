/** V3.3 合规交付包 / AI 创作说明截图包 / 交付闸门 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import compliancePack, { EVIDENCE_PAGES } from '../src/compliance/CompliancePack.js';
import consistencyChecker from '../src/qc/ConsistencyChecker.js';
import { config } from '../src/config/env.js';
import { ERR } from '../src/core/errors.js';

const P = 'compliance_proj';
const EP = 'E01';

const SHOTS = [
  { no: 'E01-S001', shot_card: 'SHT-CU', camera_move: 'SHT-PUSH', lighting_codes: ['LIG-PRACTICAL'], transition: 'TRN-HARDCUT', rhythm: 'HOOK-01', emotions: { CH01: 'EMO-RAGE-SUPPRESSED-04' }, duration: 5, episode: 1, is_episode_end: false },
  { no: 'E01-S002', shot_card: 'SHT-MCU', camera_move: 'SHT-PUSH', lighting_codes: ['LIG-LOWKEY'], transition: 'TRN-OBJWIPE', rhythm: 'CFL-01', emotions: { CH01: 'EMO-KILL-INTENT-05' }, duration: 5, episode: 1, is_episode_end: true },
];
const SEGS = [
  { shot_no: 'E01-S001', start: 0, end: 5, duration: 5, transition: 'TRN-HARDCUT', transition_reason: null },
  { shot_no: 'E01-S002', start: 5, end: 10, duration: 5, transition: 'TRN-OBJWIPE', transition_reason: '时间跳跃' },
];
const GENS = [
  { id: 'gen_1', kind: 'image', shot_no: 'E01-S001', model: 'IMG-DEFAULT', prompt_en: 'a man in pine-green jacket, low key lamp light', created_at: '2026-11-03T10:00:00.000Z', actual_credits: 4, status: 'done' },
  { id: 'gen_2', kind: 'video', shot_no: 'E01-S001', model: 'VID-DEFAULT', prompt_en: 'camera pushes in, suppressed rage', created_at: '2026-11-03T10:05:00.000Z', actual_credits: 6, status: 'done' },
];
const PLAN = { plan_id: 'PLAN-TEST', validation: { ok: true, stats: {} }, stats: { beats: 2 } };
const SCRIPT = { episodes: [{ title: '羞辱', hook: { code: 'HOOK-01' }, conflicts: [{ code: 'CFL-01' }], reversals: [], ending_hook: '悬念' }] };

function buildFull(overrides = {}) {
  return compliancePack.build({
    projectId: P, episodeNo: EP,
    project: { id: P, title: '废柴逆袭', prompt: '废柴少年觉醒龙魂', style_code: 'STY-XIANXIA', aspect: '9:16', quality: '1080p', totalMinutes: 10, episodeSec: 90, created_at: '2026-11-03T09:00:00.000Z' },
    plan: PLAN, script: SCRIPT,
    storyboard: { shots: SHOTS, stats: { shots: SHOTS.length, total_sec: 10 } },
    assets: [{ asset_code: 'CH01', asset_type: 'character', name: '林默', version: 3, locks: ['pine-green jacket'] }],
    generations: GENS,
    timeline: { segments: SEGS },
    musicSpec: { credits_required: [{ track: 'BGM-001', text: 'Demo Music' }] },
    ...overrides,
  });
}

test('生成完整合规包：4 个文件落盘，声明与清单齐全', () => {
  const pack = buildFull();
  assert.equal(pack.validation.ok, true, JSON.stringify(pack.validation.problems));
  for (const f of ['ai_declaration.md', 'ai_evidence.html', 'manifest.json', 'credits.txt']) {
    assert.ok(fs.existsSync(path.join(pack.dir, f)), `缺文件 ${f}`);
  }
  const decl = fs.readFileSync(path.join(pack.dir, 'ai_declaration.md'), 'utf8');
  assert.match(decl, /AI 创作说明/);
  assert.match(decl, /不提供去除 AI 标识/);
  assert.match(decl, /人工创作与审核环节/);
  const credits = fs.readFileSync(path.join(pack.dir, 'credits.txt'), 'utf8');
  assert.match(credits, /BGM-001/);
  assert.equal(pack.counts.keyframes, 1);
  assert.equal(pack.counts.videos, 1);
  assert.equal(pack.ai_label.removable, false);
});

test('证据页：7 页全屏、每页带网址与时间戳，可离线打印', () => {
  const pack = buildFull();
  const html = pack.html;
  assert.equal((html.match(/<section class="page">/g) ?? []).length, EVIDENCE_PAGES.length);
  assert.match(html, /@page \{ size: A4 landscape; margin: 0; \}/);
  assert.match(html, /工作台网址：/);
  assert.match(html, /生成时间：/);
  assert.match(html, /page-break-after:always/, '页面必须具备打印分页规则');
  // 真实数据必须出现在页面上，而不是占位
  assert.match(html, /E01-S001/);
  assert.match(html, /IMG-DEFAULT/);
  assert.match(html, /VID-DEFAULT/);
  assert.match(html, /TRN-OBJWIPE/);
  assert.match(html, /-16 LUFS/);
});

test('证据页对用户输入做 HTML 转义，防止注入', () => {
  const pack = buildFull({
    project: { id: P, title: '<script>alert(1)</script>', prompt: '<img src=x>' },
  });
  assert.ok(!pack.html.includes('<script>alert(1)</script>'));
  assert.ok(pack.html.includes('&lt;script&gt;'));
  assert.ok(!pack.html.includes('<img src=x>'));
});

test('证据链校验：缺生成记录 / 关键帧 / 视频 / 时间线一律拦下', () => {
  const pack = buildFull({ generations: [] });
  assert.equal(pack.validation.ok, false);
  const codes = pack.validation.problems.map((p) => p.code);
  assert.ok(codes.includes('EVIDENCE_NO_GENERATIONS'));
  assert.ok(codes.includes('EVIDENCE_NO_KEYFRAME'));
  assert.ok(codes.includes('EVIDENCE_NO_VIDEO'));

  const p2 = buildFull({ timeline: { segments: [] } });
  assert.ok(p2.validation.problems.some((p) => p.code === 'EVIDENCE_NO_TIMELINE'));
  const p3 = buildFull({ storyboard: { shots: [] } });
  assert.ok(p3.validation.problems.some((p) => p.code === 'EVIDENCE_NO_STORYBOARD'));
});

test('AI 标识被关闭时禁止交付（§19 红线）', () => {
  const orig = config.compliance.aiLabelEnabled;
  try {
    config.compliance.aiLabelEnabled = false;
    const pack = buildFull();
    assert.ok(pack.validation.problems.some((p) => p.code === 'AI_LABEL_DISABLED'));
  } finally {
    config.compliance.aiLabelEnabled = orig;
  }
});

test('合规包可持久化并读回，manifest 一致', () => {
  const pack = buildFull();
  const got = compliancePack.get(P, EP);
  assert.equal(got.pack_id, pack.pack_id);
  assert.equal(got.counts.shots, SHOTS.length);
  assert.equal(got.html, pack.html);
});

test('未生成合规包时读回抛 NOT_FOUND', () => {
  assert.throws(() => compliancePack.get('never_built_proj', EP), (e) => e.code === ERR.NOT_FOUND);
});

test('交付闸门：无质检 / 无合规包 → 阻断并给出下一步动作', () => {
  const g = compliancePack.deliveryGate({ projectId: 'gate_empty_proj', episodeNo: EP });
  assert.equal(g.ready, false);
  const codes = g.blockers.map((b) => b.code);
  assert.ok(codes.includes('QC_EMPTY'));
  assert.ok(codes.includes('PACK_NOT_BUILT'));
  assert.ok(g.next_actions.length > 0);
});

test('交付闸门：质检全通过 + 证据齐备 → 放行', () => {
  const proj = 'gate_ready_proj';
  // 先为该项目的每一镜补一条 pass 质检
  const REF = { locks: ['pine-green jacket'], emotion_codes: ['EMO-A'], lighting_codes: ['LIG-PRACTICAL'], style_code: 'STY-XIANXIA' };
  // 只质检 1 镜：KPI 仍达标可放行，但应给出「尚有镜未质检」的告警
  for (const s of SHOTS.slice(0, 1)) {
    consistencyChecker.check({ projectId: proj, shotNo: s.no, reference: REF, candidate: REF });
  }
  compliancePack.build({
    projectId: proj, episodeNo: EP,
    project: { id: proj, title: '交付测试', prompt: 'x' },
    plan: PLAN, script: SCRIPT,
    storyboard: { shots: SHOTS, stats: { shots: SHOTS.length } },
    assets: [{ asset_code: 'CH01', name: '林默', version: 1, locks: ['pine-green jacket'] }],
    generations: GENS, timeline: { segments: SEGS },
    musicSpec: { credits_required: [] },
  });
  const g = compliancePack.deliveryGate({ projectId: proj, episodeNo: EP });
  assert.equal(g.ready, true, JSON.stringify(g.blockers));
  assert.equal(g.consistency.kpi_met, true);
  assert.equal(g.evidence.ok, true);
  assert.equal(g.warnings.length, 1, '未质检的镜应给出告警但不阻断');
  assert.match(g.warnings[0], /一致性自检/);
  assert.match(g.next_actions[0], /下载交付包/);
});

test('交付闸门：存在漂移镜 → 阻断', () => {
  const proj = 'gate_drift_proj';
  const REF = { locks: ['a', 'b'], emotion_codes: ['EMO-A'], lighting_codes: ['L1'], style_code: 'S1' };
  consistencyChecker.check({ projectId: proj, shotNo: 'E01-S001', reference: REF, candidate: { locks: ['x'] } });
  const g = compliancePack.deliveryGate({ projectId: proj, episodeNo: EP });
  assert.equal(g.ready, false);
  assert.ok(g.blockers.some((b) => b.code === 'QC_DRIFT'));
});
