/**
 * 剧集系列（V4.1）：项目 = 一季，系列 = 多季集合。
 *
 * 解决的问题：
 *  - 新建项目生成短剧后，角色资产归属**该项目**（assets.project_id），不会串到别的项目；
 *  - 拍第二季/第三季时，直接以某一季为「参考」开新季：继承风格/画幅/画质等规格，
 *    并把角色资产（含连续性锁）复制过来，锁定值不变，保证跨季形象一致；
 *  - 每份继承资产都记 lineage（origin_project_id / origin_asset_code），可追溯到第一季。
 *
 * 红线：继承只复制「设定与锁」，不复制生成结果（image_url 置空），避免拿上一季的画面冒充本季产物。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import assetLibrary from '../assets/AssetLibrary.js';

const PROJECTS = 'projects';
const ASSETS = 'assets';
const SERIES = 'series';

export class SeriesService {
  /** 读取系列；项目第一次进系列时自动建 */
  ensureSeries(project) {
    if (project.series_id) {
      const s = db.findOne(SERIES, (x) => x.id === project.series_id);
      if (s) return s;
    }
    const s = db.insert(SERIES, {
      id: newId('ser'),
      user_id: project.user_id,
      title: project.title,
      style_code: project.spec?.style_code ?? null,
      created_at: nowIso(),
    });
    db.update(PROJECTS, project.id, { series_id: s.id, season_no: project.season_no ?? 1 });
    return s;
  }

  /** 某项目所属系列的完整视图：所有季 + 资产汇总 */
  seriesOf(projectId) {
    const project = db.findOne(PROJECTS, (p) => p.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const series = this.ensureSeries(project);
    const seasons = db.find(PROJECTS, (p) => p.series_id === series.id)
      .sort((a, b) => (a.season_no ?? 1) - (b.season_no ?? 1))
      .map((p) => ({
        id: p.id,
        title: p.title,
        season_no: p.season_no ?? 1,
        status: p.status,
        created_at: p.created_at,
        prev_project_id: p.prev_project_id ?? null,
        archived: p.archived === true,
      }));
    // 跨季角色总表：同名角色以最早一季的锁为准
    const allAssets = db.find(ASSETS, (a) => seasons.some((s) => s.id === a.project_id));
    const byName = new Map();
    for (const a of allAssets.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))) {
      if (!byName.has(a.name)) {
        byName.set(a.name, {
          name: a.name,
          asset_type: a.asset_type,
          origin_project_id: a.origin_project_id ?? a.project_id,
          origin_asset_code: a.origin_asset_code ?? a.asset_code,
          locks: a.locks,
          seasons: [a.project_id],
        });
      } else {
        byName.get(a.name).seasons.push(a.project_id);
      }
    }
    return {
      series: { id: series.id, title: series.title, style_code: series.style_code, created_at: series.created_at },
      seasons,
      shared_assets: [...byName.values()],
    };
  }

  /** 用户侧：所有系列（首页分组用） */
  listSeries(userId) {
    const projects = db.find(PROJECTS, (p) => p.user_id === userId);
    const map = new Map();
    for (const p of projects) {
      const sid = p.series_id ?? `solo:${p.id}`;
      if (!map.has(sid)) map.set(sid, { id: sid, title: p.title, seasons: [] });
      map.get(sid).seasons.push({ id: p.id, title: p.title, season_no: p.season_no ?? 1, status: p.status, archived: p.archived === true });
    }
    return [...map.values()]
      .map((g) => ({ ...g, seasons: g.seasons.sort((a, b) => a.season_no - b.season_no) }))
      .sort((a, b) => b.seasons.length - a.seasons.length);
  }

  /**
   * 开下一季。
   * @param {object} o { projectId, title, prompt, inheritAssets }
   */
  createSeason({ projectId, title = null, prompt = null, inheritAssets = true }) {
    const base = db.findOne(PROJECTS, (p) => p.id === projectId);
    if (!base) fail(ERR.NOT_FOUND, '参考项目不存在');
    const series = this.ensureSeries(base);
    const seasons = db.find(PROJECTS, (p) => p.series_id === series.id);
    const nextNo = Math.max(0, ...seasons.map((s) => s.season_no ?? 1)) + 1;

    const baseSpec = base.spec ?? {};
    // 续集提示词：沿用上一季创意 + 显式声明延续关系，供故事引擎当作参考
    const continuityPrompt = [
      String(prompt ?? baseSpec.prompt ?? base.title ?? '').trim(),
      `【第 ${nextNo} 季·延续第 ${base.season_no ?? 1} 季】沿用前作世界观与角色设定，人物关系与形象保持一致。`,
    ].filter(Boolean).join('\n');

    const proj = db.insert(PROJECTS, {
      id: newId('proj'),
      user_id: base.user_id,
      title: title ?? `${series.title} 第 ${nextNo} 季`,
      spec: {
        ...baseSpec,
        prompt: continuityPrompt,
        continuity_from: base.id,
        continuity_season: base.season_no ?? 1,
      },
      series_id: series.id,
      season_no: nextNo,
      prev_project_id: base.id,
      status: 'draft',
      created_at: nowIso(),
    });

    let copied = 0;
    if (inheritAssets) {
      const chars = db.find(ASSETS, (a) => a.project_id === base.id && a.asset_type === 'character');
      for (const a of chars) {
        try {
          assetLibrary.create({
            projectId: proj.id,
            assetType: a.asset_type,
            name: a.name,
            locks: a.locks,
            lockValues: a.lock_values,
            imageUrl: null, // 红线：不继承画面，只继承设定与锁
            meta: {
              ...(a.meta ?? {}),
              inherited: true,
              origin_project_id: a.origin_project_id ?? a.project_id,
              origin_asset_code: a.origin_asset_code ?? a.asset_code,
              inherited_at: nowIso(),
            },
          });
          copied += 1;
        } catch (e) {
          logger.error('续集资产继承失败', { asset: a.asset_code, msg: e.message });
        }
      }
    }

    logger.info('续集项目已创建', { projectId: proj.id, from: base.id, season: nextNo, copied });
    return { project: proj, season_no: nextNo, inherited_assets: copied, series_id: series.id };
  }

  /** 归档 / 取消归档（不物理删除，资产与流水都留痕） */
  setArchived(projectId, archived) {
    const p = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!p) fail(ERR.NOT_FOUND, '项目不存在');
    return db.update(PROJECTS, projectId, {
      archived: Boolean(archived),
      status: archived ? 'archived' : (p.status === 'archived' ? 'draft' : p.status),
      updated_at: nowIso(),
    });
  }

  /** 资产的跨季血缘 */
  lineage(projectId) {
    const assets = db.find(ASSETS, (a) => a.project_id === projectId);
    const projects = new Map(db.find(PROJECTS).map((p) => [p.id, p]));
    return assets.map((a) => {
      const origin = a.origin_project_id ?? a.meta?.origin_project_id ?? a.project_id;
      return {
        asset_code: a.asset_code,
        name: a.name,
        asset_type: a.asset_type,
        inherited: Boolean(a.meta?.inherited),
        origin_project_id: origin,
        origin_project_title: projects.get(origin)?.title ?? null,
        origin_asset_code: a.origin_asset_code ?? a.meta?.origin_asset_code ?? a.asset_code,
        locks: a.locks,
      };
    });
  }
}

export const seriesService = new SeriesService();
export default seriesService;
