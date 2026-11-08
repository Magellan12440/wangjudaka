/**
 * 资产出图（V4.10）：把「角色 / 场景 / 道具」从一张卡变成一张图。
 *
 * 为什么单独一层：
 *  - 分镜出图要求画面里的角色**已经有图**（视觉依据），否则一致性锁形同虚设；
 *  - 所以资产图必须独立于分镜走一次生成，且生成完立刻写回资产卡（image_url + version）；
 *  - 合规、扣费、归档、质检仍然全部经过 GenerateService，不另开出口。
 */
import { db } from '../store/db.js';
import { generateService } from './GenerateService.js';
import { assetLibrary } from '../assets/AssetLibrary.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import { fail, ERR } from '../core/errors.js';
import { logger } from '../core/redact.js';

const PROJECT = 'projects';
const ASSETS = 'assets';

export class AssetImageService {
  /**
   * 生成一张资产设定图。
   * @param {object} p { projectId, assetCode, userId, force }
   */
  async generate({ projectId, assetCode, userId = null, force = false }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const asset = assetLibrary.get(projectId, assetCode);
    if (!asset) fail(ERR.NOT_FOUND, `资产 ${assetCode} 不存在`);
    if (asset.image_url && !force) {
      return {
        ok: true, skipped: true, url: asset.image_url, asset_code: asset.asset_code,
        reason: '这张资产已经有图了，如需换一张请点重绘',
      };
    }

    const r = await generateService.run({
      userId: userId ?? project.user_id,
      projectId,
      kind: 'image',
      purpose: 'preview',
      idemKey: `asset:${asset.asset_code}:${Date.now()}`,
      meta: { shotNo: `${asset.asset_code}-SHEET`, primaryAssetCode: asset.asset_code },
      compileRequest: {
        project: {
          style_code: project.spec?.style_code,
          director_code: project.spec?.director_code ?? null,
          // 设定图本身用方图（当参考面板用），但画质必须沿用用户选择：
          // 之前这里把 2K 硬降成 720P，用户选的画质在资产环节被悄悄打折。
          aspect: '1:1',
          quality: project.spec?.quality ?? '1080p',
          video_type: project.spec?.video_type ?? 'dynamic',
          episode_count: project.spec?.episode_count ?? null,
          episode_sec: project.spec?.episode_sec ?? 90,
          total_minutes: project.spec?.total_minutes ?? 10,
        },
        model: modelCatalog.resolve('image', project.spec?.models?.image ?? null),
        shot_no: `${asset.asset_code}-SHEET`,
        asset: {
          asset_code: asset.asset_code,
          asset_type: asset.asset_type,
          name: asset.name,
          locks: asset.locks ?? [],
          lock_values: asset.lock_values ?? {},
          meta: asset.meta ?? {},
        },
        options: { mode: 'asset_sheet' },
      },
    });

    if (!r?.url) fail(ERR.RELAY_UPSTREAM_ERROR, '资产图生成失败：上游没有返回图片地址');

    const updated = assetLibrary.update(projectId, asset.asset_code, {
      image_url: r.url,
      status: 'ready',
    });
    logger.info('资产出图完成', { projectId, assetCode: asset.asset_code, credits: r.credits });
    return {
      ok: true,
      url: r.url,
      asset_code: updated?.asset_code ?? asset.asset_code,
      asset_type: asset.asset_type,
      version: updated?.version ?? asset.version,
      credits: r.credits,
      balance: r.balance,
      mock: !!r.mock,
      warnings: r.payload?.compile_warnings ?? [],
    };
  }

  /**
   * 按类型批量出图（前端「一键出全部资产图」）。
   * 顺序执行，避免瞬间打满并发闸门；单个失败不中断，如实回报。
   */
  async generateBatch({ projectId, userId = null, assetType = null, limit = 8 }) {
    const rows = db.find(ASSETS, (a) => a.project_id === projectId
      && (!assetType || a.asset_type === assetType)
      && !a.image_url)
      .slice(0, Math.max(1, Math.min(12, Number(limit) || 8)));
    const results = [];
    let credits = 0;
    for (const a of rows) {
      try {
        const r = await this.generate({ projectId, assetCode: a.asset_code, userId });
        credits += Number(r.credits) || 0;
        results.push({ code: a.asset_code, ok: true, url: r.url, mock: !!r.mock });
      } catch (e) {
        results.push({ code: a.asset_code, ok: false, code_err: e.code, message: e.message });
        // 余额被拒就别继续试了，剩下的必然也失败
        if (e.code === ERR.INSUFFICIENT_CREDITS) break;
      }
    }
    return {
      total: rows.length,
      done: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      credits,
      results,
    };
  }

  /** 资产总览：按类型分组，前端一次拿全（含出图进度） */
  overview(projectId) {
    const rows = db.find(ASSETS, (a) => a.project_id === projectId);
    const groups = { character: [], scene: [], prop: [] };
    for (const a of rows) {
      const bucket = groups[a.asset_type] ?? null;
      if (!bucket) continue;
      bucket.push({
        code: a.asset_code,
        name: a.name,
        type: a.asset_type,
        version: a.version,
        locks: (a.locks ?? []).length,
        image_url: a.image_url ?? null,
        status: a.image_url ? 'ready' : 'pending',
        desc: a.lock_values?.traits || a.lock_values?.desc || a.meta?.desc || '',
      });
    }
    const all = Object.values(groups).flat();
    return {
      groups,
      total: all.length,
      ready: all.filter((x) => x.status === 'ready').length,
      by_type: {
        character: { total: groups.character.length, ready: groups.character.filter((x) => x.status === 'ready').length },
        scene: { total: groups.scene.length, ready: groups.scene.filter((x) => x.status === 'ready').length },
        prop: { total: groups.prop.length, ready: groups.prop.filter((x) => x.status === 'ready').length },
      },
    };
  }
}

export const assetImageService = new AssetImageService();
export default assetImageService;
