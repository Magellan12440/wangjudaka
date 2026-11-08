/**
 * 资产归属与账号隔离（V4.15）——四条硬规则。
 *
 * 用户提的规则原话：
 *   「资产与账号强相关，不同用户之间的资产强制隔离，同一账号的资产永久保留在数据库中，
 *     除非用户主动删除，否则永久保留，这也是为了避免法律风险。」
 *
 * 拆成可执行的四条：
 *   R1 资产必带主人：每条资产/素材/生成记录/剧本存档都写 `user_id`，从项目继承，
 *      **不接受请求体指定**（否则谁都能把资产挂到别人名下）。
 *   R2 读写都验主：跨账号访问一律当作"不存在"处理，既不返回数据，也不确认存在性。
 *   R3 只增不删：没有 TTL、没有数量裁剪、没有级联删除。项目删了资产也留着（`orphan`）。
 *   R4 只有本人能删：删除必须显式调接口 + `confirm`，且留一条不可改的删除凭证。
 *
 * 为什么 R3 要写这么死：这类内容（小说改编、角色形象、成片）在法律上可能构成
 * 用户的"作品"与"个人信息"，平台单方面清理会同时踩著作权与个人信息保护两条线。
 * 所以宁可让库变大，也不替用户做删除决定。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';

const PROJECTS = 'projects';
const ASSETS = 'assets';
const MATERIALS = 'materials';
const GENS = 'generations';
const VAULT = 'script_vault';
const PLANS = 'director_plans';
const DELETIONS = 'asset_deletions';

/** 需要跟着账号走的所有集合（新增集合必须登记在这里，check 脚本会核对） */
export const OWNED_COLLECTIONS = [ASSETS, MATERIALS, GENS, VAULT, PLANS];

export const ASSET_RULE = {
  version: 1,
  title: '资产与账号强绑定',
  retention: 'permanent',
  clauses: [
    { id: 'R1', text: '所有资产记录必须带 user_id，写入时从项目继承，不接受客户端指定所有者。' },
    { id: 'R2', text: '读与写都先验归属；跨账号访问统一按「不存在」处理，不泄漏资产是否存在。' },
    { id: 'R3', text: '不做 TTL、不做数量裁剪、不随项目级联删除；账号在，资产就在。' },
    { id: 'R4', text: '只有资产所有者本人可以删除，且必须显式确认，删除动作留审计凭证。' },
  ],
};

/** 项目的主人；项目不存在返回 null（不抛错，便于迁移时跳过） */
export function projectOwner(projectId) {
  if (!projectId) return null;
  const p = db.findOne(PROJECTS, (x) => x.id === projectId);
  return p?.user_id ?? null;
}

/**
 * 取经归属校验的项目。
 *
 * 跨账号故意报 NOT_FOUND 而不是 FORBIDDEN：403 等于告诉对方"这个 id 是存在的"，
 * 拿它去撞 id 就能枚举出别人有多少项目、什么时候建的。
 */
export function ownedProject(projectId, userId) {
  const p = db.findOne(PROJECTS, (x) => x.id === projectId);
  if (!p) fail(ERR.NOT_FOUND, '项目不存在');
  if (userId && p.user_id !== userId) fail(ERR.NOT_FOUND, '项目不存在');
  return p;
}

/** 写入时解析主人：优先项目主人；显式传了 userId 就必须一致 */
export function resolveOwner(projectId, userId = null) {
  const owner = projectOwner(projectId);
  if (!owner) fail(ERR.NOT_FOUND, '项目不存在');
  if (userId && userId !== owner) fail(ERR.OBJECT_FORBIDDEN, '不能往别人的项目里写资产');
  return owner;
}

/**
 * 历史数据补主人（幂等）。
 *
 * V4.15 之前 `assets` 表根本没有 user_id 字段——只能靠 project_id 反查。
 * 一旦项目被迁移/复制，资产就成了无主数据，谁拿到 projectId 都能读。
 * 这里在启动时补一次，补完 `auditIsolation()` 应该是全绿。
 */
export function backfillOwnership({ dryRun = false } = {}) {
  const stat = { scanned: 0, filled: 0, orphan: 0, by_collection: {} };
  for (const col of OWNED_COLLECTIONS) {
    const rows = db.find(col);
    let filled = 0;
    let orphan = 0;
    for (const r of rows) {
      stat.scanned += 1;
      if (r.user_id) continue;
      const owner = projectOwner(r.project_id);
      if (!owner) {
        // 找不到项目也**不删**：标出来等人工处理，删了就违反 R3
        orphan += 1;
        if (!dryRun) db.update(col, r.id, { owner_state: 'orphan', user_id: null });
        continue;
      }
      filled += 1;
      if (!dryRun) db.update(col, r.id, { user_id: owner, owner_state: 'ok' });
    }
    stat.filled += filled;
    stat.orphan += orphan;
    stat.by_collection[col] = { total: rows.length, filled, orphan };
  }
  if (!dryRun && (stat.filled || stat.orphan)) {
    logger.info('资产归属补全完成', stat);
  }
  return stat;
}

/**
 * 隔离自检：所有已归属记录的 user_id 必须与项目主人一致。
 * 交给运营/上线前跑，任何一条不一致都说明有绕过归属的写入口。
 */
export function auditIsolation() {
  const issues = [];
  let checked = 0;
  for (const col of OWNED_COLLECTIONS) {
    for (const r of db.find(col)) {
      checked += 1;
      const owner = projectOwner(r.project_id);
      if (!r.user_id) {
        issues.push({ collection: col, id: r.id, project_id: r.project_id, issue: 'MISSING_OWNER' });
      } else if (owner && r.user_id !== owner) {
        issues.push({
          collection: col, id: r.id, project_id: r.project_id,
          issue: 'OWNER_MISMATCH', user_id: r.user_id, project_owner: owner,
        });
      } else if (!owner) {
        issues.push({ collection: col, id: r.id, project_id: r.project_id, issue: 'ORPHAN' });
      }
    }
  }
  return {
    ok: issues.filter((x) => x.issue === 'OWNER_MISMATCH').length === 0,
    checked,
    issues: issues.slice(0, 200),
    total_issues: issues.length,
    rule: ASSET_RULE,
  };
}

/**
 * 账号资产总账（跨项目）。
 *
 * 用途有两个：给用户看"我的东西都还在"；给出事时留证据——
 * 这份账是只读的，不提供任何"清理"入口。
 */
export function accountLedger(userId) {
  if (!userId) fail(ERR.AUTH_REQUIRED, '请先登录');
  const projects = db.find(PROJECTS, (p) => p.user_id === userId);
  const ids = new Set(projects.map((p) => p.id));
  const countOf = (col, pred) => db.count(col, (r) => pred(r, ids));
  const assets = db.find(ASSETS, (a) => ids.has(a.project_id) || a.user_id === userId);
  const byType = {};
  for (const a of assets) byType[a.asset_type] = (byType[a.asset_type] ?? 0) + 1;
  return {
    user_id: userId,
    retention: 'permanent',
    rule_version: ASSET_RULE.version,
    projects: projects.map((p) => ({
      id: p.id, title: p.title, created_at: p.created_at, archived: p.archived === true,
    })),
    totals: {
      projects: projects.length,
      assets: assets.length,
      assets_with_image: assets.filter((a) => a.image_url).length,
      materials: countOf(MATERIALS, (r, s) => s.has(r.project_id) || r.user_id === userId),
      generations: countOf(GENS, (r, s) => s.has(r.project_id) || r.user_id === userId),
      scripts: db.count(VAULT, (r) => r.user_id === userId),
      plans: countOf(PLANS, (r, s) => s.has(r.project_id) || r.user_id === userId),
    },
    assets_by_type: byType,
    note: '这些内容永久保留在你的账号下，不会因为项目归档、会员到期或长期未登录被清理；只有你本人主动删除才会移除。',
  };
}

/** 删除凭证：谁、什么时候、删了什么、为什么。只增不改。 */
export function recordDeletion({ userId, projectId, asset, reason = '' }) {
  return db.insert(DELETIONS, {
    id: newId('adel'),
    user_id: userId,
    project_id: projectId,
    asset_id: asset?.id ?? null,
    asset_code: asset?.asset_code ?? null,
    asset_type: asset?.asset_type ?? null,
    asset_name: asset?.name ?? null,
    image_url: asset?.image_url ?? null,
    version: asset?.version ?? null,
    reason: String(reason ?? '').slice(0, 300),
    deleted_at: nowIso(),
  });
}

export function deletionLog({ userId, projectId = null }) {
  return db.find(DELETIONS, (d) => d.user_id === userId && (!projectId || d.project_id === projectId))
    .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
}

export const assetOwnership = {
  RULE: ASSET_RULE,
  OWNED_COLLECTIONS,
  projectOwner,
  ownedProject,
  resolveOwner,
  backfillOwnership,
  auditIsolation,
  accountLedger,
  recordDeletion,
  deletionLog,
};

export default assetOwnership;
