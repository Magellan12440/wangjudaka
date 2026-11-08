import { test } from 'node:test';
import assert from 'node:assert/strict';
import blueprintEngine from '../src/pipeline/Blueprint.js';
import generateService from '../src/pipeline/GenerateService.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import creationDocs from '../src/docs/CreationDocs.js';
import distributionHub from '../src/distribution/DistributionHub.js';
import ledger from '../src/ledger/Ledger.js';
import { makeReq } from './helpers.js';
import { ERR } from '../src/core/errors.js';
import { db } from '../src/store/db.js';

const P = 'proj_test_' + Date.now();
const U = 'u_pipe_' + Date.now();
// V4.15：资产归属从项目继承，所以测试也得先有一张真项目
db.insert('projects', {
  id: P, user_id: U, title: 'pipeline 测试项目',
  spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p' },
  created_at: new Date().toISOString(),
});

test('蓝图模板齐全（含 OneShot 12 节点）', () => {
  const t = blueprintEngine.templates();
  assert.ok(t.length >= 5);
  const one = t.find((x) => x.code === 'BP_ONESHOT');
  assert.equal(one.nodes.length, 12);
});

test('创建运行并推进节点', () => {
  const run = blueprintEngine.createRun({ projectId: P, templateCode: 'BP_ONESHOT' });
  assert.equal(run.nodes.length, 12);
  assert.equal(run.nodes[0].status, 'pending');
  const next = blueprintEngine.nextNode(run.id);
  assert.equal(next.id, 'N01');
  const after = blueprintEngine.markNode(run.id, 'N01', { status: 'done', costCredits: 2 });
  assert.equal(after.nodes[0].status, 'done');
  assert.equal(after.total_credits, 2);
});

test('OneShot 报价：先给成本与时长预估', () => {
  const q = blueprintEngine.quote({ prompt: '废柴少年觉醒龙魂', styleCode: 'STY-XIANXIA', totalMinutes: 10, episodeSec: 90, quality: '1080p' });
  assert.equal(q.episodes, 7); // 10*60/90 ≈ 6.67 → 7
  assert.ok(q.total_shots > 0);
  assert.ok(q.est_credits > 0);
  assert.ok(q.est_minutes > 0);
  assert.ok(q.breakdown.video_per_shot > 0);
});

test('自定义集数/时长：报价按用户选的集数，不被总分钟取整带偏', () => {
  // 3 集 × 90 秒 = 4.5 分钟。若先取整成 5 分钟再反推，会算成 4 集。
  const q = blueprintEngine.quote({
    prompt: 'x', styleCode: 'STY-DUSHI', totalMinutes: 4.5, episodeSec: 90, episodeCount: 3,
  });
  assert.equal(q.episodes, 3);
  assert.equal(q.episode_sec, 90);
  assert.equal(q.shots_per_episode, Math.ceil(90 / q.avg_shot_len));

  // 不传 episodeCount 时退回按分钟反推，保持老行为
  const legacy = blueprintEngine.quote({ prompt: 'x', styleCode: 'STY-DUSHI', totalMinutes: 9, episodeSec: 90 });
  assert.equal(legacy.episodes, 6);

  // 自定义超长集数也要能算，且不超过 200
  const big = blueprintEngine.quote({
    prompt: 'x', styleCode: 'STY-DUSHI', totalMinutes: 200, episodeSec: 60, episodeCount: 500,
  });
  assert.equal(big.episodes, 200);
});

test('高质档报价高于极速档', () => {
  const fast = blueprintEngine.quote({ prompt: 'x', styleCode: 'STY-DUSHI', totalMinutes: 10, preset: 'fast' });
  const premium = blueprintEngine.quote({ prompt: 'x', styleCode: 'STY-DUSHI', totalMinutes: 10, preset: 'premium' });
  assert.ok(premium.est_credits > fast.est_credits);
});

test('生成全链路：编译→预扣→调用→结算', async () => {
  ledger.recharge({ userId: U, points: 5000, idemKey: 'pipe-1' });
  const before = ledger.balance(U);
  const res = await generateService.run({
    userId: U,
    projectId: P,
    kind: 'video',
    purpose: 'preview',
    meta: { shotNo: 'E01-S012', primaryAssetCode: 'CH01' },
    compileRequest: makeReq({ available_credits: 9999, model: 'VID-CHEAP' }),
  });
  assert.equal(res.ok, true);
  assert.ok(res.credits > 0);
  assert.equal(ledger.balance(U), before - res.credits);
  const rec = generateService.get(res.generationId);
  assert.equal(rec.status, 'done');
});

test('生成失败：全额退款且余额不变', async () => {
  const before = ledger.balance(U);
  await assert.rejects(
    () => generateService.run({
      userId: U, projectId: P, kind: 'video', purpose: 'preview',
      meta: { shotNo: 'E01-S099' },
      compileRequest: makeReq({ available_credits: 9999, shot: { duration: 5, dialogue: '你以为这就结束了吗我告诉你从你走进这扇门的那一刻起你就已经没有退路了今天不是你死就是我亡' } }),
    }),
    (e) => e.code === ERR.DIALOGUE_OVERFLOW
  );
  assert.equal(ledger.balance(U), before, '失败必须全额退回');
});

test('按镜号重生成：换模型模式可用', async () => {
  ledger.recharge({ userId: U, points: 500, idemKey: 'pipe-2' });
  const first = await generateService.run({
    userId: U, projectId: P, kind: 'image', purpose: 'preview',
    meta: { shotNo: 'E01-S001' },
    compileRequest: makeReq({ kind: 'image', model: 'IMG-FAST', available_credits: 9999 }),
  });
  const again = await generateService.regenerate({
    userId: U, projectId: P, generationId: first.generationId, mode: 'change_model',
    patch: makeReq({ kind: 'image', model: 'IMG-DEFAULT', available_credits: 9999 }),
  });
  assert.equal(again.ok, true);
  assert.equal(again.payload.target_model, 'IMG-DEFAULT');
});

test('资产库：创建需满足最少锁数，升版可算影响面', () => {
  const a = assetLibrary.create({
    projectId: P, assetType: 'character', name: '林默',
    locks: ['lean face', 'short black hair', 'pine-green lapel jacket', 'silver ring earring'],
    lockValues: { name: '林默', face_shape: 'lean', hair: 'short black' },
  });
  assert.equal(a.version, 1);
  assert.ok(a.locks.length >= 4);
  const v2 = assetLibrary.update(P, a.asset_code, {
    locks: ['lean face', 'short black hair', 'pine-green lapel jacket', 'silver ring earring'],
  });
  assert.equal(v2.version, 2);
  const impact = assetLibrary.impactOfUpdate({ projectId: P, assetCode: a.asset_code, newVersion: 2 });
  assert.ok(Array.isArray(impact.affected_shots));
});

test('资产锁数不足 → 拒绝创建', () => {
  assert.throws(
    () => assetLibrary.create({ projectId: P, assetType: 'character', name: 'X', locks: ['only-one'] }),
    () => true
  );
});

test('创作文档跨文档校验：分镜引用不存在的角色会被抓出', () => {
  creationDocs.save({ projectId: P, type: 'characters', content: { items: [{ code: 'CH01' }] } });
  creationDocs.save({
    projectId: P, type: 'storyboard',
    content: {
      target_total_sec: 90,
      shots: [
        { no: 'E01-S001', characters: ['CH01', 'CH99'], scene: 'SC01', shot_card: 'SHT-MS', duration: 5, lighting_codes: ['LIG-COOL'] },
        { no: 'E01-S002', characters: ['CH01'], shot_card: 'SHT-MS', duration: 5 },
      ],
    },
  });
  const r = creationDocs.check(P);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'CHAR_NOT_IN_CARDS'));
  assert.ok(r.errors.some((e) => e.code === 'LIGHTING_MISSING'));
});

test('分发：平台不可内嵌，但可建任务跟踪状态', () => {
  const ps = distributionHub.platforms();
  assert.ok(ps.length >= 8);
  for (const p of ps) assert.equal(p.in_app_embeddable, false, '第三方业务域名无法在小程序内嵌');
  const d = distributionHub.create({ projectId: P, episodeNo: 'E01', platformCode: 'PLT-HONGGUO', userId: U });
  assert.equal(d.status, '准备中');
  assert.ok(d.checklist.some((c) => c.key === 'ai_declaration'));
  const up = distributionHub.updateStatus(d.id, '审核中');
  assert.equal(up.status, '审核中');
  distributionHub.recordRevenue(d.id, { amount: 1234.5 });
  const s = distributionHub.summary(P);
  assert.equal(s.total_revenue_cny, 1234.5);
});

test('非法状态被拒', () => {
  const d = distributionHub.create({ projectId: P, episodeNo: 'E02', platformCode: 'PLT-HONGGUO', userId: U });
  assert.throws(() => distributionHub.updateStatus(d.id, '随便写'), (e) => e.code === ERR.BAD_REQUEST);
});
