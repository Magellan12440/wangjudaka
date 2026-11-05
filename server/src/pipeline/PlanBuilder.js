/**
 * 计划构建（V4.3）：把「项目 → 大纲 → 总谱 → 剧本 → 分镜 → 角色资产」抽成一个可复用步骤。
 *
 * 一句话成剧（OneShot）与剧集托管（ProductionService）需要同一份产物，
 * 如果各写一份，迟早出现「一键成片有 27 镜、单集成片只有 12 镜」的错位。
 * 所以统一从这里进入，并保持幂等：已有分镜时默认复用，force=true 才重写。
 */
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import { storyEngine } from './StoryEngine.js';
import { assetLibrary } from '../assets/AssetLibrary.js';
import { materialService } from '../assets/MaterialService.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import contentSecurity from '../security/ContentSecurity.js';

/** 生成并落库导演计划；返回 { plan, script, storyboard, materials_used, reused } */
export async function ensureProjectPlan(project, { force = false, model = null } = {}) {
  const existing = db.findOne('director_plans', (x) => x.project_id === project.id);
  if (!force && existing?.storyboard?.shots?.length) {
    return {
      plan: existing.plan,
      script: existing.script,
      storyboard: existing.storyboard,
      materials_used: existing.materials_used ?? [],
      reused: true,
    };
  }

  const spec = project.spec ?? {};
  const prompt = spec.prompt || project.title || '未命名漫剧';
  // 剧本/推理统一走用户选择的 chat 模型，默认 DeepSeek V4.1
  const chatModel = model ?? modelCatalog.resolve('chat', spec.models?.chat ?? null);
  const digest = materialService.digest(project.id);
  if (digest.text) {
    await contentSecurity.assertText({
      content: digest.text.slice(0, 2400),
      openid: contentSecurity.openidOf(project.user_id),
      bizType: 'material_digest',
      bizId: project.id,
      scene: 1,
    });
  }

  const { outline } = await storyEngine.outline({
    userId: project.user_id,
    projectId: project.id,
    prompt,
    spec,
    reference: digest.text,
    model: chatModel,
  });
  const plan = storyEngine.directorPlan({ outline, spec, projectId: project.id });
  const script = await storyEngine.script({
    outline, plan, spec, userId: project.user_id, projectId: project.id, model: chatModel,
  });
  const storyboard = await storyEngine.storyboard({ outline, spec, plan, script });

  const rec = {
    project_id: project.id,
    plan_id: plan.plan_id,
    plan_version: plan.plan_version,
    outline,
    plan,
    script,
    storyboard,
    materials_used: digest.used,
    reference_chars: digest.chars,
    created_at: nowIso(),
  };
  if (existing) {
    const patch = { ...rec };
    delete patch.id;
    db.update('director_plans', existing.id, patch);
  } else {
    db.insert('director_plans', { id: newId('dplan'), ...rec });
  }

  let assetCount = db.find('assets', (a) => a.project_id === project.id).length;
  if (!assetCount) {
    for (const d of storyEngine.toAssetDrafts(outline).slice(0, 8)) {
      try {
        assetLibrary.create({
          projectId: project.id,
          assetType: d.asset_type,
          name: d.name,
          locks: d.locks,
          lockValues: d.lock_values,
          meta: d.meta,
        });
        assetCount += 1;
      } catch (e) {
        logger.warn('角色资产落库失败', { projectId: project.id, msg: e.message });
      }
    }
  }

  return { outline, plan, script, storyboard, materials_used: digest.used, reused: false, assets: assetCount };
}

export default ensureProjectPlan;
