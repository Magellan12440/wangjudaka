/** V3.3 一致性自检服务：M3 出口条件「角色相似度 ≥ 0.82」的可回归断言 */
import test from 'node:test';
import assert from 'node:assert/strict';
import consistencyChecker, { featureProvider, DEFAULT_THRESHOLD } from '../src/qc/ConsistencyChecker.js';
import generateService from '../src/pipeline/GenerateService.js';
import ledger from '../src/ledger/Ledger.js';
import { db } from '../src/store/db.js';
import { ERR } from '../src/core/errors.js';
import { makeReq } from './helpers.js';

const P = 'qc_proj';
const REF = {
  locks: ['pine-green jacket', 'silver ring earring'],
  emotion_codes: ['EMO-RAGE-SUPPRESSED-04'],
  lighting_codes: ['LIG-PRACTICAL'],
  style_code: 'STY-XUANYI',
};

function run(overrides = {}) {
  return consistencyChecker.check({
    projectId: P, shotNo: `E01-S${String(Math.random()).slice(2, 8)}`,
    assetCode: 'CH01', reference: REF, ...overrides,
  });
}

test('provider 注册表：feature 可用，mock 恒不可用', () => {
  const list = consistencyChecker.listProviders();
  assert.ok(list.some((p) => p.name === 'feature' && p.available));
  assert.ok(list.some((p) => p.name === 'mock' && !p.available));
  assert.equal(featureProvider.available, true);
});

test('红线：没有比对能力时绝不假装通过（degraded / score=null / 待人工复核）', () => {
  const r = consistencyChecker.check({ projectId: P, shotNo: 'E01-S901', providerName: 'mock', reference: REF });
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.score, null);
  assert.equal(r.needs_manual_review, true);
  assert.ok(!('ok' in r), 'degraded 结果不得携带 ok:true 语义');
  assert.equal(r.provider, 'mock');
});

test('未接比对服务且未传候选特征 → 自动降级，不产出分数', () => {
  const r = run();
  assert.equal(r.verdict, 'degraded');
  assert.equal(r.score, null);
  assert.match(r.note, /未接入|MOCK/);
});

test('特征完全一致 → pass 且分数为 1', () => {
  const r = run({ candidate: REF, shotNo: 'E01-S902' });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.score, 1);
  assert.equal(r.needs_manual_review, false);
  assert.equal(r.provider, 'feature');
  assert.ok(r.advice.length === 0);
});

test('特征漂移 → drift + 重生成建议（映射到四种粒度）', () => {
  const r = run({
    shotNo: 'E01-S903',
    candidate: { locks: ['totally different coat'], emotion_codes: ['EMO-JOY-01'], lighting_codes: ['LIG-HIGHKEY'], style_code: 'STY-CYBER' },
  });
  assert.equal(r.verdict, 'drift');
  assert.ok(r.score < DEFAULT_THRESHOLD);
  assert.ok(r.advice.length >= 2);
  const modes = r.advice.map((a) => a.mode);
  assert.ok(modes.includes('resample'));
  assert.ok(modes.includes('change_reference'));
});

test('strict 模式（交付闸门）遇到漂移会阻断', () => {
  assert.throws(() => run({
    shotNo: 'E01-S904', strict: true,
    reference: REF, candidate: { locks: ['x'] },
  }), (e) => e.code === ERR.CONSISTENCY_DRIFT);
});

test('外部已算好的分数可直接采信', () => {
  const r = run({ shotNo: 'E01-S905', similarityScore: 0.91, providerName: null });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.score, 0.91);
  assert.equal(r.provider, 'external');
});

test('注册外部 CLIP/人脸 provider 后可用', () => {
  consistencyChecker.registerProvider({
    name: 'clip_test', available: true,
    compare: () => ({ score: 0.88, dimensions: { clip: 0.88 } }),
  });
  const r = run({ shotNo: 'E01-S906', providerName: 'clip_test' });
  assert.equal(r.provider, 'clip_test');
  assert.equal(r.verdict, 'pass');
  assert.equal(r.score, 0.88);
});

test('未知 provider 被拒绝，不静默降级', () => {
  assert.throws(() => run({ shotNo: 'E01-S907', providerName: 'not_exist' }),
    (e) => e.code === ERR.BAD_REQUEST);
});

test('报告：通过率 / KPI / 漂移清单 / 按集聚合，且同镜取最新一条', () => {
  const id = 'qc_report_proj';
  const shot = 'E02-S001';
  consistencyChecker.check({ projectId: id, shotNo: shot, reference: REF, candidate: { locks: ['x'] } });
  consistencyChecker.check({ projectId: id, shotNo: shot, reference: REF, candidate: REF });
  consistencyChecker.check({ projectId: id, shotNo: 'E02-S002', reference: REF, providerName: 'mock' });
  const rep = consistencyChecker.report(id);
  assert.equal(rep.total_shots, 2, '同镜多次生成只取最新');
  assert.equal(rep.passed, 1);
  assert.equal(rep.degraded, 1);
  assert.equal(rep.drifted, 0);
  assert.equal(rep.pass_rate, 0.5);
  assert.equal(rep.kpi_met, false, '存在待复核项时 KPI 不算达标');
  assert.ok(rep.by_episode.some((e) => e.key === 'E02'));
  assert.deepEqual(rep.manual_review_shots, ['E02-S002']);
});

test('重生成建议接口：drift 给模式，pass 给空', () => {
  const drift = run({ shotNo: 'E01-S908', candidate: { locks: ['x'] } });
  const a = consistencyChecker.adviceFor(drift.id);
  assert.equal(a.verdict, 'drift');
  assert.ok(a.modes.length > 0);
  const pass = run({ shotNo: 'E01-S909', candidate: REF });
  assert.deepEqual(consistencyChecker.adviceFor(pass.id).modes, []);
});

test('生成链已接入质检：MOCK 生成不回滚、不假装通过，结果写入生成记录', async () => {
  const U = 'qc_user';
  ledger.recharge({ userId: U, points: 1000, idemKey: 'qc-recharge' });
  const r = await generateService.run({
    userId: U, projectId: P, kind: 'video', purpose: 'preview',
    idemKey: 'qc-gen-1', meta: { shotNo: 'E01-S910' },
    compileRequest: makeReq(),
  });
  assert.equal(r.ok, true);
  assert.ok(r.consistency, '生成结果必须带质检结论');
  assert.equal(r.consistency.verdict, 'degraded', 'MOCK 阶段无候选特征，必须降级');
  const gen = db.findOne('generations', (g) => g.id === r.generationId);
  assert.equal(gen.consistency.check_id, r.consistency.id);
  assert.equal(gen.status, 'done', '一致性降级不得回滚已成功的生成');
});

test('生成链传入候选特征时可出真实分数', async () => {
  const U = 'qc_user2';
  ledger.recharge({ userId: U, points: 1000, idemKey: 'qc-recharge-2' });
  const req = makeReq();
  const r = await generateService.run({
    userId: U, projectId: P, kind: 'video', purpose: 'preview',
    idemKey: 'qc-gen-2', meta: {
      shotNo: 'E01-S911',
      candidate: {
        locks: ['pine-green lapel service jacket', 'silver ring earring on left ear', 'single desk lamp, glass table, two chairs', 'scratched chrome zippo with engraved character'],
        emotion_codes: ['EMO-RAGE-SUPPRESSED-04'],
        lighting_codes: ['LIG-PRACTICAL'],
        style_code: 'STY-XUANYI',
      },
    },
    compileRequest: req,
  });
  assert.equal(r.consistency.provider, 'feature');
  assert.ok(['pass', 'drift'].includes(r.consistency.verdict));
  assert.equal(typeof r.consistency.score, 'number');
});
