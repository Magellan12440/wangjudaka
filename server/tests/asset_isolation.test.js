/**
 * V4.15 资产归属与账号隔离。
 *
 * 用户原话：「资产与账号强相关，不同用户之间的资产强制隔离，同一账号的资产永久保留在数据库中，
 * 除非用户主动删除，否则永久保留，这也是为了避免法律风险。」
 *
 * 这条规则拆成四条可执行约束，逐条锁：
 *  R1 每条资产必带 user_id，写入时从项目继承，不接受客户端指定；
 *  R2 跨账号访问一律按「不存在」处理（不给 403，403 等于确认资源存在）；
 *  R3 没有 TTL、没有数量裁剪、不随项目级联删除；
 *  R4 只有本人能删，必须显式确认，删完留凭证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import accountLedgerDefault, { backfillOwnership, auditIsolation, accountLedger, ASSET_RULE } from '../src/assets/AssetOwnership.js';
import scriptLibrary from '../src/projects/ScriptLibrary.js';

let seq = 0;
const uid = (p) => `${p}_${(seq += 1)}_${Date.now()}`;

function mkProject(userId = null, extra = {}) {
  const id = uid('proj_own');
  db.insert('projects', {
    id,
    user_id: userId ?? uid('u_own'),
    title: '归属样本',
    spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p' },
    created_at: new Date().toISOString(),
    ...extra,
  });
  return db.findOne('projects', (x) => x.id === id);
}

function mkChar(projectId, code = 'CH01', name = '林默') {
  return assetLibrary.create({
    projectId, assetType: 'character', name, code,
    locks: ['lean face', 'short black hair', 'pine-green jacket', 'silver earring'],
  });
}

test('R1 资产入库就带主人，且不接受客户端指定的别人', () => {
  const p = mkProject();
  const a = mkChar(p.id);
  assert.equal(a.user_id, p.user_id, '资产必须继承项目主人');
  assert.equal(a.owner_state, 'ok');

  // 拿别人的 userId 往这个项目写 → 直接拒，不是"忽略后照写"
  assert.throws(
    () => assetLibrary.create({
      projectId: p.id, assetType: 'character', name: '冒名', code: 'CH09', userId: 'u_someone_else',
      locks: ['a', 'b', 'c', 'd'],
    }),
    (e) => e.code === 'OBJECT_FORBIDDEN',
  );
  assert.equal(assetLibrary.get(p.id, 'CH09'), null, '被拒的写入不能留下任何记录');
});

test('R2 跨账号读不到：列表 / 总览 / 名册 / 单卡全部按不存在处理', () => {
  const p = mkProject();
  mkChar(p.id);

  // 内部接口传错主人：报 OBJECT_FORBIDDEN（内部调用有明确错误码，便于定位越权点）
  assert.throws(() => assetLibrary.list(p.id, null, 'u_intruder'), (e) => e.code === 'OBJECT_FORBIDDEN');

  // 对外语义：不给 403，直接"不存在"
  assert.throws(() => accountLedgerDefault.ownedProject(p.id, 'u_intruder'), (e) => e.code === 'NOT_FOUND');

  // 真主人读得到
  const mine = accountLedgerDefault.ownedProject(p.id, p.user_id);
  assert.equal(mine.id, p.id);
  assert.equal(assetLibrary.list(p.id, null, p.user_id).length, 1);
});

test('R2 别人账号的资产不会出现在我的总账里', () => {
  const a = mkProject();
  const b = mkProject();
  mkChar(a.id, 'CH01', '甲');
  mkChar(b.id, 'CH01', '乙');
  mkChar(b.id, 'CH02', '丙');

  const la = accountLedger(a.user_id);
  const lb = accountLedger(b.user_id);
  assert.equal(la.totals.assets, 1);
  assert.equal(lb.totals.assets, 2);
  assert.equal(la.retention, 'permanent');
  assert.equal(la.rule_version, ASSET_RULE.version);
  assert.ok(la.projects.every((x) => x.id !== b.id), '总账里不能混进别人的项目');
});

test('R1 迁移：老数据补主人，孤儿记录留着不删', () => {
  const p = mkProject();
  // 模拟 V4.15 之前的历史行：没有 user_id，也没有 owner_state
  const legacyId = uid('asset_legacy');
  db.insert('assets', {
    id: legacyId, project_id: p.id, asset_type: 'character', asset_code: 'CH07',
    name: '历史配角', version: 1, locks: ['a', 'b', 'c', 'd'], status: 'ready',
    created_at: new Date().toISOString(),
  });
  // 项目已经不在的孤儿
  const orphanId = uid('asset_orphan');
  db.insert('assets', {
    id: orphanId, project_id: 'proj_that_never_existed', asset_type: 'prop',
    asset_code: 'PR01', name: '无主道具', version: 1, locks: ['x'], status: 'pending',
    created_at: new Date().toISOString(),
  });

  const stat = backfillOwnership();
  assert.ok(stat.filled >= 1);

  const fixed = db.findOne('assets', (x) => x.id === legacyId);
  assert.equal(fixed.user_id, p.user_id, '老数据必须补成项目主人');
  assert.equal(fixed.owner_state, 'ok');

  const orphan = db.findOne('assets', (x) => x.id === orphanId);
  assert.ok(orphan, '找不到项目的资产也**不能删**（R3）');
  assert.equal(orphan.user_id, null);
  assert.equal(orphan.owner_state, 'orphan', '要标出来等人工处理');
});

test('隔离自检能抓出被篡改归属的资产', () => {
  const p = mkProject();
  const a = mkChar(p.id);
  const hit = (r) => r.issues.some((x) => x.id === a.id && x.issue === 'OWNER_MISMATCH');

  // 刚建出来必须是干净的（只核对这一条，不看整个库——库里有历史数据，不该互相干扰）
  assert.equal(hit(auditIsolation()), false);

  // 人为把资产挪到别人名下（模拟某条写入口绕过归属）
  db.update('assets', a.id, { user_id: 'u_attacker' });
  const r = auditIsolation();
  assert.equal(hit(r), true, '自检必须抓出归属被改过的资产');
  assert.equal(r.ok, false, '一旦有 mismatch 就整体不通过');
  const bad = r.issues.find((x) => x.id === a.id);
  assert.equal(bad.project_owner, p.user_id, '报表要能对上"应该是谁"');

  db.update('assets', a.id, { user_id: p.user_id });
  assert.equal(hit(auditIsolation()), false);
});

test('R4 删除要显式确认，删完留凭证，且别人删不了', () => {
  const p = mkProject();
  const a = mkChar(p.id);

  assert.throws(
    () => assetLibrary.remove({ projectId: p.id, code: a.asset_code, userId: p.user_id, confirm: false }),
    (e) => e.code === 'BAD_REQUEST',
  );
  assert.ok(assetLibrary.get(p.id, a.asset_code), '没确认就不能动数据');

  // 别人来删：按项目不存在处理
  assert.throws(
    () => assetLibrary.remove({ projectId: p.id, code: a.asset_code, userId: 'u_intruder', confirm: true }),
    (e) => e.code === 'NOT_FOUND',
  );
  assert.ok(assetLibrary.get(p.id, a.asset_code));

  const out = assetLibrary.remove({
    projectId: p.id, code: a.asset_code, userId: p.user_id, confirm: true, reason: 'user_deleted',
  });
  assert.equal(out.removed, true);
  assert.ok(out.receipt_id);
  assert.equal(assetLibrary.get(p.id, a.asset_code), null, '确认后才真的删');

  const log = assetLibrary.deletions({ projectId: p.id, userId: p.user_id });
  assert.equal(log.length, 1);
  assert.equal(log[0].asset_code, a.asset_code);
  assert.equal(log[0].reason, 'user_deleted');
  // 凭证只增：删完再查还在
  assert.equal(assetLibrary.deletions({ projectId: p.id, userId: p.user_id }).length, 1);
});

test('R3 剧本库超量不删：只提示，旧稿仍在库里', () => {
  const userId = uid('u_vault');
  const p = mkProject(userId);

  // 塞到超过建议量（60）
  for (let i = 0; i < 62; i += 1) {
    db.insert('script_vault', {
      id: uid('svault'),
      user_id: userId,
      project_id: p.id,
      plan_id: `plan_${i}`,
      title: `旧稿 ${i}`,
      outline: {},
      created_at: new Date().toISOString(),
      updated_at: new Date(Date.now() - i * 1000).toISOString(),
    });
  }

  // 再存一部新的：老逻辑会把最旧的删掉，现在必须留着
  scriptLibrary.upsertFromCandidate({
    userId, projectId: p.id,
    cand: { id: uid('cand'), plan_id: 'plan_new', plan: {}, script: {}, storyboard: {} },
    outline: { title: '新稿' },
    assets: { total: 0 },
  });

  const list = scriptLibrary.vaultList(userId);
  assert.equal(list.total, 63, '63 部都得在');
  assert.equal(list.retention, 'permanent');
  assert.ok(list.notice.includes('永久保留'), '超量要明确告诉用户不会被清理');
});

test('账号总账跨项目统计，且给出保留承诺', () => {
  const userId = uid('u_ledger');
  const p1 = mkProject(userId);
  const p2 = mkProject(userId);
  mkChar(p1.id, 'CH01', '甲');
  mkChar(p2.id, 'CH01', '乙');
  mkChar(p2.id, 'SC01', '场景');
  db.update('assets', assetLibrary.get(p2.id, 'SC01').id, { image_url: 'cos://x/SC01.png' });

  const l = accountLedger(userId);
  assert.equal(l.totals.projects, 2);
  assert.equal(l.totals.assets, 3);
  assert.equal(l.totals.assets_with_image, 1);
  assert.equal(l.retention, 'permanent');
  assert.ok(l.note.includes('永久保留'));
  assert.ok(l.assets_by_type.character >= 2);
});

test('源码扫描：任何直接写 assets 的地方都必须带 user_id', async () => {
  // 有 4 处是绕过 AssetLibrary 直接 db.insert(ASSETS) 的（补卡/补齐配角/声线）。
  // 这种路径最容易漏归属，所以这里做一次静态扫描：只允许带 user_id 的写法。
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '../src');

  const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const offenders = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    // 逐个 insert 块检查：从 db.insert(ASSETS 到对应的 project_id 之后 200 字符内必须有 user_id
    const re = /db\.insert\((?:ASSETS|'assets')\s*,\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const block = src.slice(m.index, m.index + 420);
      if (!/user_id\s*:/.test(block)) {
        offenders.push(`${path.relative(root, file)}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `这些写入没有落账号归属：${offenders.join(', ')}`);
});

test('源码扫描：没有任何地方会自动清理账号资产（R3）', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '../src');

  const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const hits = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    // 资产删除只能出现在 AssetLibrary.remove（用户主动删）
    if (/db\.remove\(\s*(ASSETS|'assets')/.test(src) && !rel.endsWith('AssetLibrary.js')) {
      hits.push(`${rel}: 直接删 assets`);
    }
    // 剧本库不允许再按数量裁掉用户稿件；
    // 唯一允许的是用户自己点的单项删除（方法名带 remove/delete 且以 userId 收口）。
    const vaultRe = /db\.remove\(\s*VAULT/g;
    let vm;
    while ((vm = vaultRe.exec(src))) {
      const before = src.slice(0, vm.index);
      const fn = [...before.matchAll(/(\w+)\s*\(([^)]*)\)\s*\{/g)].pop();
      const okUserDelete = fn && /remove|delete/i.test(fn[1]) && /userId/.test(fn[2]);
      if (!okUserDelete) {
        hits.push(`${rel}:${before.split('\n').length} 自动删剧本仓`);
      }
    }
  }
  assert.deepEqual(hits, [], `发现自动清理账号资产的代码：${hits.join(', ')}`);
});
