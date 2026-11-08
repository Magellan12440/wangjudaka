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
import { stageOptions, stageOfAsset } from './StageOptions.js';
import { aspectOf, qualityOf } from '../core/frame.js';
import { resolveOwner } from '../assets/AssetOwnership.js';
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';
import { logger } from '../core/redact.js';
import { newId, nowIso } from '../core/util.js';

const PROJECT = 'projects';
const ASSETS = 'assets';

export class AssetImageService {
  /**
   * 合并出"这一张图到底该用什么参数"。
   * 三层优先级：本次临时覆盖 > 该环节已保存的设置 > 项目规格。
   * 非法值直接报错，不静默退回 —— 用户点了 2K 就必须是 2K，否则等于没得选。
   */
  #effective(projectId, stage, overrides, project) {
    const base = stageOptions.effective(projectId, stage);
    const o = overrides || {};
    const model = o.model ? modelCatalog.resolve('image', o.model) : base.model;
    const styleCode = o.style_code ?? o.styleCode ?? base.style_code;
    const style = seeds.style(styleCode);
    const aspect = o.aspect ?? base.aspect;
    const quality = o.quality ?? base.quality;
    if (!aspectOf(aspect)) fail(ERR.SPEC_VIOLATION, `不支持的画幅：${aspect}`);
    if (!qualityOf(quality)) fail(ERR.SPEC_VIOLATION, `不支持的画质：${quality}`);
    return {
      stage,
      model,
      style_code: styleCode,
      style_name: style?.name ?? styleCode,
      palette: style?.palette ?? base.palette ?? [],
      aspect,
      quality,
      project_spec: project?.spec ?? null,
    };
  }

  /**
   * 生成一张资产设定图。
   * @param {object} p { projectId, assetCode, userId, force, overrides }
   *   overrides：本次临时覆盖（模型/画幅/画质/风格），不改项目也不改环境变量，
   *              前端「本环节设置」里点的那几个值就是从这里进来的。
   */
  async generate({ projectId, assetCode, userId = null, force = false, overrides = null }) {
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

    /**
     * 分环节参数（V4.14）：角色/场景/道具各自可换模型、画幅、画质、风格。
     * 优先级：本次临时覆盖 > 该环节已保存的设置 > 项目规格。
     */
    const stage = stageOfAsset(asset.asset_type);
    const eff = this.#effective(projectId, stage, overrides, project);

    // 用户上传的本地参考图（V4.14）：作为长相/结构依据进参考图列表
    const referenceImages = (asset.reference_images ?? []).filter((r) => r && r.url);

    const r = await generateService.run({
      userId: userId ?? project.user_id,
      projectId,
      kind: 'image',
      purpose: 'preview',
      idemKey: `asset:${asset.asset_code}:${Date.now()}`,
      meta: {
        shotNo: `${asset.asset_code}-SHEET`,
        primaryAssetCode: asset.asset_code,
        stage,
        stage_options: {
          model: eff.model, style_code: eff.style_code, aspect: eff.aspect, quality: eff.quality,
        },
        references: referenceImages.map((x) => x.name ?? x.url).slice(0, 4),
      },
      compileRequest: {
        project: {
          // 项目级字段先铺开，再让环节参数覆盖掉风格/画幅/画质那几项
          ...(project.spec ?? {}),
          style_code: eff.style_code,
          director_code: project.spec?.director_code ?? null,
          aspect: eff.aspect,
          quality: eff.quality,
          video_type: project.spec?.video_type ?? 'dynamic',
          episode_count: project.spec?.episode_count ?? null,
          episode_sec: project.spec?.episode_sec ?? 90,
          total_minutes: project.spec?.total_minutes ?? 10,
          palette: eff.palette?.length ? eff.palette : (project.spec?.palette ?? undefined),
        },
        model: modelCatalog.resolve('image', eff.model),
        shot_no: `${asset.asset_code}-SHEET`,
        asset: {
          asset_code: asset.asset_code,
          asset_type: asset.asset_type,
          name: asset.name,
          locks: asset.locks ?? [],
          lock_values: asset.lock_values ?? {},
          meta: asset.meta ?? {},
        },
        options: {
          mode: 'asset_sheet',
          reference_images: referenceImages,
        },
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
      // 这一张实际用了什么参数（V4.14）：用户能核对选择是否真的生效
      effective: {
        stage,
        model: eff.model,
        style_code: eff.style_code,
        aspect: eff.aspect,
        quality: eff.quality,
      },
      reference_count: referenceImages.length,
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

  /**
   * 角色名册（V4.13）：剧本里出现过的每个人 vs 资产库里有没有卡 / 有没有图。
   *
   * 为什么需要一个独立的"名册"视图：一致性闸门只会在出某镜时校验该镜的角色，
   * 于是"配角没建卡"要等到出那一镜才暴露，用户看到的是"生成失败"，而不是"还差 3 张配角图"。
   * 这里把缺口提前列清楚，页面能直接一键补齐。
   */
  roster(projectId) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    const outline = planRec?.outline ?? {};
    const shots = planRec?.storyboard?.shots ?? [];
    const script = planRec?.script ?? null;
    const assets = db.find(ASSETS, (a) => a.project_id === projectId);
    const cardOf = new Map(assets.filter((a) => a.asset_type === 'character').map((a) => [a.asset_code, a]));

    const roster = new Map();
    for (const c of outline.characters ?? []) {
      if (!c?.code) continue;
      roster.set(c.code, {
        code: c.code, name: c.name || c.code, role: c.role ?? '',
        traits: c.traits ?? '', source: 'outline', episodes: new Set(), shots: 0, lines: 0,
      });
    }
    for (const s of shots) {
      for (const code of s.characters ?? []) {
        if (!code) continue;
        if (!roster.has(code)) {
          roster.set(code, {
            code, name: `配角 ${code}`, role: '', traits: '', source: 'storyboard',
            episodes: new Set(), shots: 0, lines: 0,
          });
        }
        const r = roster.get(code);
        const ep = Number(String(s.no ?? '').replace(/^E0*/i, '').split('-')[0]) || null;
        if (ep) r.episodes.add(ep);
        r.shots += 1;
      }
    }
    // 台词 speaker 可能是角色码，也可能是人名：人名先在既有名册里按名字匹配，
    // 匹配不到就忽略（宁可漏算台词数，也不能凭空多出一张"同人不同码"的卡）
    const codeByName = new Map([...roster.values()].map((r) => [String(r.name ?? '').trim(), r.code]));
    const resolveSpeaker = (speaker) => {
      const raw = String(speaker ?? '').trim();
      if (!raw) return null;
      if (roster.has(raw) || /^CH\d+$/i.test(raw)) return raw;
      return codeByName.get(raw) ?? null;
    };
    for (const ep of script?.episodes ?? []) {
      for (const sc of ep.scenes ?? []) {
        for (const d of sc.dialogue ?? []) {
          const code = resolveSpeaker(d?.speaker);
          if (!code) continue;
          if (!roster.has(code)) {
            roster.set(code, {
              code, name: `配角 ${code}`, role: '', traits: '', source: 'script',
              episodes: new Set([Number(ep.no) || null]), shots: 0, lines: 0,
            });
          }
          const r = roster.get(code);
          r.lines += 1;
          if (ep.no) r.episodes.add(Number(ep.no));
        }
      }
    }

    const characters = [...roster.values()].map((r) => {
      const card = cardOf.get(r.code) ?? null;
      return {
        code: r.code,
        name: card?.name || r.name,
        role: card?.lock_values?.role || r.role || (r.source === 'outline' ? '' : '配角'),
        supporting: r.source !== 'outline',
        source: r.source,
        traits: card?.lock_values?.traits || r.traits || '',
        episodes: [...r.episodes].filter((x) => x).sort((a, b) => a - b),
        shots: r.shots,
        lines: r.lines,
        has_card: Boolean(card),
        has_image: Boolean(card?.image_url),
        image_url: card?.image_url ?? null,
        locks: (card?.locks ?? []).length,
      };
    }).sort((a, b) => (a.supporting === b.supporting ? b.shots - a.shots : a.supporting ? 1 : -1));

    const missingCards = characters.filter((c) => !c.has_card).map((c) => c.code);
    const missingImages = characters.filter((c) => c.has_card && !c.has_image).map((c) => c.code);
    return {
      project_id: projectId,
      total: characters.length,
      main: characters.filter((c) => !c.supporting).length,
      supporting: characters.filter((c) => c.supporting).length,
      ready: characters.filter((c) => c.has_image).length,
      characters,
      missing_cards: missingCards,
      missing_images: missingImages,
      note: missingImages.length
        ? `还有 ${missingImages.length} 个角色没有定妆图；分镜出图会因「视觉依据缺失」被拦，这不是 bug`
        : '全部角色都已出图，可以开始出分镜',
    };
  }

  /**
   * 补齐角色名册里的缺口（V4.13）：缺卡的先建卡，缺图的逐张出图（顺序执行，失败不中断）。
   * 只补角色 —— 场景/道具走各自的入口，避免一次点下去花掉一堆点数还看不清花在哪。
   */
  async fillMissingCharacters({ projectId, userId = null, limit = 12 }) {
    const before = this.roster(projectId);
    let created = 0;
    for (const code of before.missing_cards) {
      try {
        // 复用一致性守卫的补卡逻辑口径：带模板锁的空卡，仍需真的出图
        const tpl = seeds.lockTemplate('character');
        if (!tpl) break;
        db.insert(ASSETS, {
          id: newId('asset'),
          project_id: projectId,
          // V4.15：补出来的卡同样要归属账号，否则它在隔离自检里就是一条 MISSING_OWNER
          user_id: resolveOwner(projectId, userId),
          owner_state: 'ok',
          asset_type: 'character',
          asset_code: code,
          name: code,
          version: 1,
          locks: tpl.suggested_locks ?? [],
          lock_values: { name: code },
          image_url: null,
          negative: tpl.negative_defaults ?? [],
          meta: { auto_created: true, backfilled: true },
          status: 'pending',
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        created += 1;
      } catch (e) {
        logger.warn('补角色卡失败', { projectId, code, msg: e.message });
      }
    }
    const after = this.roster(projectId);
    const todo = after.characters.filter((c) => !c.has_image).slice(0, Math.max(1, Math.min(24, Number(limit) || 12)));
    const results = [];
    let credits = 0;
    for (const c of todo) {
      try {
        const r = await this.generate({ projectId, assetCode: c.code, userId });
        credits += Number(r.credits) || 0;
        results.push({ code: c.code, ok: true, url: r.url });
      } catch (e) {
        results.push({ code: c.code, ok: false, code_err: e.code, message: e.message });
        if (e.code === ERR.INSUFFICIENT_CREDITS) break;
      }
    }
    const final = this.roster(projectId);
    return {
      ok: final.missing_images.length === 0,
      created_cards: created,
      total_missing: todo.length,
      done: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok).length,
      credits,
      results,
      roster: final,
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
        // 配角要能在页面上分组显示（"这个人我根本没印象"通常就是配角没建卡/没出图）
        supporting: !!a.meta?.supporting,
        episodes: a.meta?.episodes ?? [],
        desc: a.lock_values?.traits || a.lock_values?.desc || a.meta?.desc || '',
        // 提示词与参考图（V4.14）：这张卡"现在是用什么描述、几张图定住的"，页面要能直接改
        prompt: a.lock_values?.prompt || '',
        reference_count: (a.reference_images ?? []).length,
        reference_images: (a.reference_images ?? []).slice(0, 4).map((r) => ({
          url: r.url, name: r.name ?? '',
        })),
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
