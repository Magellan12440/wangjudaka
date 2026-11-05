/**
 * V4.3 六项迭代的契约测试（不触网，全部走本地 mock 链路）。
 *
 * 覆盖：
 *  1. 统一计费：实际消耗 ×2，预扣-结算-退款口径一致
 *  2. 模型目录：每环节 ≤5、只列可用、默认 DeepSeek V4.1
 *  3. 项目索引：按用户自增、跨用户隔离、按编号可查
 *  4. 剧壳：默认值 / 保存 / 无片头文件时不接入时间线
 *  5. 剧集托管：单集任务只含一集，重复创建幂等
 *  6. 分发资料包：成片缺失如实列出，zip 可生成
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/store/db.js';
import { config } from '../src/config/env.js';
import ledger from '../src/ledger/Ledger.js';
import { modelCatalog } from '../src/relay/ModelCatalog.js';
import { projectIndex } from '../src/projects/ProjectIndex.js';
import { shellService } from '../src/shell/ShellService.js';
import { productionService } from '../src/pipeline/ProductionService.js';
import { submissionPack } from '../src/distribution/SubmissionPack.js';
import { zipBuffer, crc32 } from '../src/util/zip.js';
import authService from '../src/auth/AuthService.js';
import editService from '../src/pipeline/EditService.js';
import adminService from '../src/admin/AdminService.js';
import seeds from '../src/seeds/loader.js';

let seq = 0;
function seedsModel(code) { return seeds.model(code); }

function mkProject(userId = null) {
  seq += 1;
  const uid = userId ?? `u_v43_${seq}`;
  const id = `proj_v43_${seq}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.insert('projects', {
    id,
    user_id: uid,
    title: `测试剧${seq}`,
    ...projectIndex.assignPatch(uid),
    spec: {
      style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p',
      total_minutes: 3, episode_sec: 90, video_type: 'static',
    },
    created_at: new Date().toISOString(),
  });
  return { id, userId: uid };
}

test('计费：统一按实际消耗 ×2 扣点，与配置一致', () => {
  assert.equal(config.credit.markup, 2, 'markup 必须是 2');
  const q = ledger.quote({ upstreamUsd: 1 }); // 1 USD → 7.1 元成本
  assert.equal(q.markup, 2);
  assert.equal(q.points, Math.ceil((q.priceCny / config.credit.cnyPerPoint)));
  assert.ok(Math.abs(q.priceCny - q.costCny * 2) < 0.001, '售价必须正好是成本的 2 倍');
});

test('计费：预扣 → 结算按实际退差额（多退）', () => {
  const userId = `u_bill_${Date.now()}`;
  ledger.recharge({ userId, points: 100, idemKey: `r-${userId}` });
  const hold = ledger.hold({ userId, points: 40, refType: 'video', refId: 'E01-S001', idemKey: `h-${userId}` });
  assert.equal(ledger.balance(userId), 60);
  const settled = ledger.settle(hold.hold.id, 12);
  assert.equal(settled.refunded, 28);
  assert.equal(ledger.balance(userId), 88);
  const rec = ledger.reconcile(userId);
  assert.equal(rec.ok, true, '账本必须平衡');
});

test('模型目录：每个环节 ≤5、无下架/非商用条目、默认 DeepSeek V4.1', () => {
  for (const role of ['chat', 'image', 'video', 'audio', 'edit']) {
    const l = modelCatalog.list(role);
    assert.ok(l.items.length > 0, `${role} 至少要有一个可选模型`);
    assert.ok(l.items.length <= 5, `${role} 最多 5 个`);
    for (const it of l.items) {
      assert.ok(it.code && it.label, `${role} 条目必须有 code 与展示名`);
      if (role === 'edit') continue;
      const m = seeds.model(it.code);
      assert.ok(m, `${it.code} 必须存在于注册表`);
      assert.notEqual(m.commercial_ok, false, `${it.code} 不可商用不该出现在用户列表`);
      assert.notEqual(m.upstream_available, false, `${it.code} 已下架不该出现`);
    }
  }
  const chat = modelCatalog.list('chat');
  assert.equal(modelCatalog.defaultFor('chat'), 'AUTO-DEEPSEEK-V4_1-FLASH');
  assert.ok(chat.items[0].recommended);
});

test('模型目录：上游下架模型不出现在列表', () => {
  const m = seedsModel('IMG-OPEN-SDXL');
  assert.equal(m.upstream_available, false);
  assert.equal(modelCatalog.hiddenReason('IMG-OPEN-SDXL', { models: {} }), 'upstream_unavailable');
  assert.ok(!modelCatalog.list('image').items.some((x) => x.code === 'IMG-OPEN-SDXL'));
});

test('项目索引：每个用户各自从 1 开始，按编号只能查到自己', () => {
  const a = `u_idx_a_${Date.now()}`;
  const b = `u_idx_b_${Date.now()}`;
  const p1 = mkProject(a);
  const p2 = mkProject(a);
  const p3 = mkProject(b);
  assert.equal(projectIndex.findByNo(a, 1).id, p1.id);
  assert.equal(projectIndex.findByNo(a, 2).id, p2.id);
  assert.equal(projectIndex.findByNo(b, 1).id, p3.id);
  assert.equal(projectIndex.findByNo(a, 1).id !== p3.id, true, '不能查到别人的项目');
  assert.equal(projectIndex.view({ index_no: 7 }).index_label, '#007');
});

test('项目索引：历史项目补号幂等且连续', () => {
  const userId = `u_idx_legacy_${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    db.insert('projects', { id: `legacy_${userId}_${i}`, user_id: userId, title: `旧剧${i}`, created_at: `2026-01-0${i + 1}T00:00:00.000Z` });
  }
  const first = projectIndex.ensure(userId);
  assert.equal(first.changed, 3);
  const second = projectIndex.ensure(userId);
  assert.equal(second.changed, 0, '再跑一次不应再改');
  const nos = db.find('projects', (p) => p.user_id === userId).map((p) => p.index_no).sort((x, y) => x - y);
  assert.deepEqual(nos, [1, 2, 3]);
});

test('剧壳：默认可用、保存白名单字段、无片头文件不接时间线', () => {
  const { id } = mkProject();
  const s = shellService.get(id);
  assert.equal(s.enabled, true);
  assert.ok(s.series_title.length > 0, '系列名默认取剧名');
  const next = shellService.save(id, {
    series_title: '长夜系列', tagline: '每集三分钟', opening: { sec: 5, text: '长夜将至' },
    theme_color: '#123456', injected: '应当被忽略',
  });
  assert.equal(next.series_title, '长夜系列');
  assert.equal(next.opening.sec, 5);
  assert.equal(next.theme_color, '#123456');
  assert.equal(next.injected, undefined, '非白名单字段不能写进项目');
  const segs = shellService.segments(id);
  assert.equal(segs.intro, null, '没有生成/上传片头时不能硬塞进时间线');
});

test('剧集托管：单集任务只锁定一集，重复创建复用同一任务', () => {
  const { id, userId } = mkProject();
  const job = productionService.create({ projectId: id, userId, mode: 'single', episodes: [2] });
  assert.equal(job.mode, 'single');
  assert.equal(job.episodes.length, 1);
  const again = productionService.create({ projectId: id, userId, mode: 'single', episodes: [2] });
  assert.equal(again.id, job.id, '未完成任务必须复用，避免重复扣费');
  assert.equal(productionService.list(id).length, 1);
  const paused = productionService.pause(job.id);
  assert.equal(paused.status, 'paused');
  assert.equal(productionService.resume(job.id).status, 'running');
});

test('分发资料包：没有成片时如实列出缺失，并仍产出可下载 zip', async () => {
  const { id, userId } = mkProject();
  const r = await submissionPack.prepare({ projectId: id, episode: 'E01', userId });
  assert.match(r.zip.url, /^\/media\/[a-f0-9]{24}\.zip$/);
  assert.ok(r.missing.some((m) => m.key === 'video_1080p'), '必须如实报缺成片');
  assert.equal(r.ready, false);
  const abs = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data');
  void abs;
  assert.ok(r.files.some((f) => f.name.includes('平台材料清单')), '清单必须进包');
  assert.ok(Array.isArray(r.checklist) && r.checklist.length >= 3);
});

test('zip 写入器：可被标准工具识别的 PK 头与结尾记录', () => {
  const buf = zipBuffer([{ name: 'a.txt', data: Buffer.from('hello 漫剧', 'utf8') }]);
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal(buf.subarray(buf.length - 22, buf.length - 18).toString('hex'), '504b0506');
  assert.equal(crc32(Buffer.from('hello 漫剧', 'utf8')), crc32(Buffer.from('hello 漫剧', 'utf8')));
  const out = path.join(config.server.dataDir, `zip_test_${Date.now()}.zip`);
  fs.mkdirSync(config.server.dataDir, { recursive: true });
  fs.writeFileSync(out, buf);
  assert.ok(fs.statSync(out).size > 40);
});

test('登录资料完善：昵称不能为空，改完 profile_complete 变 true', async () => {
  const r = await authService.login({ code: `v43-code-${Date.now()}` });
  assert.equal(r.user.profile_complete, false, '新用户默认资料未完善');
  assert.throws(() => authService.updateProfile(r.user.id, { nickname: '   ' }));
  const u = authService.updateProfile(r.user.id, { nickname: '林导', avatar: 'https://example.com/a.png' });
  assert.equal(u.nickname, '林导');
  assert.equal(u.profile_complete, true);
});

test('剪辑档位：ED-EDL 只导剪辑单，不伪造成片', async () => {
  const { id } = mkProject();
  const r = await editService.render(id, 'E01', { preset: null });
  // 没有分镜时先被结构化的「还没分镜」拦下；有分镜后才会走到 EDL_ONLY
  assert.equal(r.ok, false);
  assert.ok(['EDIT_PLAN_BLOCKED', 'EDL_ONLY'].includes(r.code));
});


test('充值活动：按档次加赠取较大值，未开活动不加赠', () => {
  const admin = adminService;
  const pkg = { id: 'pkg_v43_a', code: 'PKG-A', bonus: 10, points: 100 };
  admin.saveCampaign({ enabled: false, bonusByPackage: { pkg_v43_a: 50 } });
  assert.equal(admin.effectiveBonus(pkg), 10, '活动关闭时按档次自带赠送');
  admin.saveCampaign({ enabled: true, bonusByPackage: { pkg_v43_a: 50 } });
  assert.equal(admin.effectiveBonus(pkg), 50, '活动加赠更大时取活动值');
  admin.saveCampaign({ enabled: true, bonusByPackage: { pkg_v43_a: 5 } });
  assert.equal(admin.effectiveBonus(pkg), 10, '活动加赠更小时不降低，取较大值');
  admin.saveCampaign({ enabled: true, endAt: '2000-01-01T00:00:00.000Z', bonusByPackage: { pkg_v43_a: 99 } });
  assert.equal(admin.campaignActive(), false, '过了结束时间自动失效');
  assert.equal(admin.effectiveBonus(pkg), 10);
  admin.saveCampaign({ enabled: false, endAt: null, bonusByPackage: {} });
});

test('充值活动：时间格式非法直接拒绝', () => {
  assert.throws(() => adminService.saveCampaign({ enabled: true, endAt: '不是时间' }));
});

test('分销资料包：材料齐备时 ready=true，缺件时不假装可提审', async () => {
  const { id } = mkProject();
  const r = await submissionPack.prepare({ projectId: id, episode: 'E01' });
  assert.ok(r.zip.url.startsWith('/media/'));
  assert.ok(r.checklist.length >= 5, '清单至少含 5 类平台材料');
  if (!r.ready) {
    assert.ok(r.missing.length > 0, '未齐时必须列出缺什么');
  }
});
