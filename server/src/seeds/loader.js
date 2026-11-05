/**
 * 种子数据加载器：把 §5–§11 的七大内置库载入内存并建立索引。
 * 所有库在进程启动时一次性加载（数据量小，< 2MB），后续按 code O(1) 查询。
 *
 * 强制约束：任何提示词生成都必须从这里取卡，不允许在业务代码里硬编码提示词片段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../core/redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

/**
 * 美术风格（画法/渲染），不是题材：2D 动漫可以拍宫斗也可以拍赛博，
 * 所以它们不参与「配方按题材筛选」，否则会被题材标签饿死。
 */
const ART_STYLE_CODES = new Set(['STY-2DANIME', 'STY-3DANIME', 'STY-3DREAL']);

/**
 * 容器化部署的硬教训：种子缺失时若直接 throw，进程会在启动第一步退出，
 * 容器进入 CrashLoopBackOff，看板上只有「部署失败 / Back-off restarting」，
 * 完全看不到真正的原因（也是我们踩过的那次坑）。
 * 所以这里改为「降级 + 显式记录」：缺哪个文件就记下来，返回空结构，
 * 由 validate() 汇总成 problems，/health 直接把缺失清单吐出来。
 */
export const seedProblems = [];

function readJson(file, fallback = []) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) {
    const msg = `种子文件缺失: ${file}`;
    seedProblems.push({ file, issue: 'missing' });
    logger.error(msg, { path: p, hint: '检查 .gitignore / .dockerignore 是否误排除了 server/src/seeds/data' });
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    seedProblems.push({ file, issue: `parse: ${e.message}` });
    logger.error(`种子文件解析失败: ${file}`, { error: e.message });
    return fallback;
  }
}

function indexBy(list, key = 'code') {
  const m = new Map();
  for (const it of list) {
    if (m.has(it[key])) logger.warn('种子重复键', { file: key, key: it[key] });
    m.set(it[key], it);
  }
  return m;
}

class SeedStore {
  constructor() {
    this.stylePresets = readJson('style_presets.json');
    this.directorProfiles = readJson('director_profiles.json');
    this.shotCards = readJson('shot_cards.json');
    this.transitionCards = readJson('transition_cards.json');
    this.lightingCards = readJson('lighting_cards.json');
    this.rhythmTemplates = readJson('rhythm_templates.json');
    this.emotionCards = readJson('emotion_cards.json');
    this.scriptLineTemplates = readJson('script_line_templates.json');
    this.bgmLibrary = readJson('bgm_library.json');
    this.distributionPlatforms = readJson('distribution_platforms.json');
    this.revenuePolicies = readJson('revenue_policies.json');
    this.continuityLockTemplates = readJson('continuity_lock_templates.json');
    // 导演语法扩展库（构图/氛围/镜头/调色 + 组合配方）与音效卡
    this.cinemaGrammar = readJson('cinema_grammar.json');
    this.sfxLibrary = readJson('sfx_library.json');
    // V4.4：九大提示词库新增三类（特效 / 剪辑成片 / 字幕同步），前六类沿用原有卡片库
    this.fxLibrary = readJson('fx_library.json');
    this.editRecipes = readJson('edit_recipes.json');
    this.subtitleSync = readJson('subtitle_sync.json');
    const reg = readJson('model_registry.seed.json');
    this.modelRegistry = reg.models ?? [];
    this.modelRegistryMeta = { note: reg._note, lastSync: reg._last_sync };
    const bp = readJson('blueprint_templates.json');
    this.blueprintTemplates = Array.isArray(bp) ? bp : bp.templates ?? [];
    // V4.3：用户可选模型目录（每环节最多 5 个，人工排序 + 实测过滤）
    this.modelCatalog = readJson('model_catalog.json', { roles: {} });

    // 索引
    this._style = indexBy(this.stylePresets);
    this._director = indexBy(this.directorProfiles);
    this._shot = indexBy(this.shotCards);
    this._transition = indexBy(this.transitionCards);
    this._lighting = indexBy(this.lightingCards);
    this._rhythm = indexBy(this.rhythmTemplates);
    this._emotion = indexBy(this.emotionCards);
    this._scriptLine = indexBy(this.scriptLineTemplates, 'purpose');
    this._bgm = indexBy(this.bgmLibrary, 'track_id');
    this._platform = indexBy(this.distributionPlatforms);
    this._revenuePolicy = indexBy(this.revenuePolicies);
    this._model = indexBy(this.modelRegistry);
    this._blueprint = indexBy(this.blueprintTemplates);
    this._lockTpl = indexBy(this.continuityLockTemplates, 'asset_type');
    // 语法库索引
    this._composition = indexBy(this.cinemaGrammar.composition ?? []);
    this._atmosphere = indexBy(this.cinemaGrammar.atmosphere ?? []);
    this._lens = indexBy(this.cinemaGrammar.lens ?? []);
    this._color = indexBy(this.cinemaGrammar.color ?? []);
    this._recipe = indexBy(this.cinemaGrammar.recipes ?? []);
    this._sfx = indexBy(this.sfxLibrary, 'code');
    this._fx = indexBy(this.fxLibrary, 'code');
    this._editRecipe = indexBy(this.editRecipes, 'code');
    this._sync = indexBy(this.subtitleSync, 'code');

    // 按类别预分组
    this._rhythmByCat = {};
    for (const t of this.rhythmTemplates) {
      (this._rhythmByCat[t.cat] ||= []).push(t);
    }
    this._emotionByCat = {};
    for (const c of this.emotionCards) {
      (this._emotionByCat[c.cat] ||= []).push(c);
    }
    this._shotByDim = {};
    for (const c of this.shotCards) {
      (this._shotByDim[c.dim] ||= []).push(c);
    }
  }

  // —— 查询 API ——
  style(code) { return this._style.get(code) ?? null; }
  director(code) { return this._director.get(code) ?? null; }
  shot(code) { return this._shot.get(code) ?? null; }
  transition(code) { return this._transition.get(code) ?? null; }
  lighting(code) { return this._lighting.get(code) ?? null; }
  rhythm(code) { return this._rhythm.get(code) ?? null; }
  emotion(code) { return this._emotion.get(code) ?? null; }
  bgm(trackId) { return this._bgm.get(trackId) ?? null; }
  platform(code) { return this._platform.get(code) ?? null; }
  revenuePolicy(code) { return this._revenuePolicy.get(code) ?? null; }
  model(code) { return this._model.get(code) ?? null; }
  /** 构图 / 氛围 / 镜头 / 调色 卡 */
  composition(code) { return this._composition.get(code) ?? null; }
  atmosphere(code) { return this._atmosphere.get(code) ?? null; }
  lens(code) { return this._lens.get(code) ?? null; }
  colorGrade(code) { return this._color.get(code) ?? null; }
  /** 导演语法配方（镜头+运镜+构图+氛围+光影+转场+节奏 的组合） */
  recipe(code) { return this._recipe.get(code) ?? null; }
  /** 按情绪标签抽配方；无命中返回全部 */
  recipesByMood(tag) {
    if (!tag) return this.cinemaGrammar.recipes ?? [];
    const hit = (this.cinemaGrammar.recipes ?? []).filter((r) => (r.mood ?? []).includes(tag));
    return hit.length ? hit : this.cinemaGrammar.recipes ?? [];
  }
  /**
   * 按风格筛可用配方。
   * styles 为空 = 结构性配方（如集末定格），全风格可用；
   * 一旦某风格有专属配方，就只用专属 + 结构性的，避免古风剧抽到霓虹雨夜。
   * 美术风格（2D/3D/真人）不是题材，不能按题材筛 —— 否则只剩集末定格一条，直接退化成无配方。
   */
  recipesForStyle(styleCode) {
    const all = this.cinemaGrammar.recipes ?? [];
    if (!styleCode) return all;
    // 美术风格（2D / 3D / 真人）不是题材：全库开放，否则只剩集末定格一条，直接退化成无配方
    if (ART_STYLE_CODES.has(styleCode)) return all;
    const hit = all.filter((r) => {
      const tags = r.styles ?? [];
      return tags.length === 0 || tags.includes(styleCode);
    });
    return hit.length ? hit : all;
  }
  /** 按节奏卡筛配方（配方的 rhythm 就是它的结构身份） */
  recipesByRhythm(rhythmCode) {
    if (!rhythmCode) return [];
    return (this.cinemaGrammar.recipes ?? []).filter((r) => r.rhythm === rhythmCode);
  }
  /** 音效卡 */
  sfx(code) { return this._sfx.get(code) ?? null; }

  // —— V4.4 九大提示词库 ——
  fx(code) { return this._fx.get(code) ?? null; }
  editRecipe(code) { return this._editRecipe.get(code) ?? null; }
  subtitleSyncRule(code) { return this._sync.get(code) ?? null; }
  /** 按转场找音效（用于自动排点） */
  sfxForTransition(transitionCode) {
    return this.sfxLibrary.filter((s) => (s.for_transition ?? []).includes(transitionCode));
  }
  /** 按氛围找环境音床 */
  ambienceForAtmosphere(atmosphereCode) {
    return this.sfxLibrary.filter((s) => s.kind === 'ambience' && (s.for_atmosphere ?? []).includes(atmosphereCode));
  }
  blueprint(code) { return this._blueprint.get(code) ?? null; }
  lockTemplate(assetType) { return this._lockTpl.get(assetType) ?? null; }

  /** 用户可选模型目录（见 model_catalog.json） */
  catalogRoles() { return Object.keys(this.modelCatalog?.roles ?? {}); }
  catalogRole(role) { return this.modelCatalog?.roles?.[role] ?? null; }

  rhythmByCat(cat) { return this._rhythmByCat[cat] ?? []; }
  shotsByDim(dim) { return this._shotByDim[dim] ?? []; }
  emotionsByCat(cat) { return this._emotionByCat[cat] ?? []; }
  /** 兜底剧本台词（按戏剧目的取；正式链路优先用模型输出） */
  scriptLines(purpose) { return this._scriptLine.get(purpose)?.lines ?? this._scriptLine.get('推进')?.lines ?? []; }

  /**
   * 按目标强度挑选情绪卡（±1 容差，同强度内按 valence 距离排序）。
   * 用于导演规划阶段给每个角色节拍挑情绪，保证情绪强度贴合剧情张力。
   */
  emotionsByIntensity(intensity, { cat = null, tolerance = 1 } = {}) {
    const pool = cat ? this.emotionsByCat(cat) : this.emotionCards;
    const hit = pool.filter((c) => Math.abs(c.intensity - intensity) <= tolerance);
    const sorted = [...hit].sort(
      (a, b) => Math.abs(a.intensity - intensity) - Math.abs(b.intensity - intensity)
    );
    return sorted.length ? sorted : [...pool].sort((a, b) => b.intensity - a.intensity).slice(0, 3);
  }

  /** 情绪卡的镜头/光影亲和建议（用于规划阶段反推镜别与布光） */
  emotionAffinity(code) {
    const c = this.emotion(code);
    if (!c) return null;
    return {
      code: c.code,
      name: c.name,
      intensity: c.intensity,
      shots: c.shot_affinity ?? [],
      lighting: c.lighting_affinity ?? [],
      transitions: c.transition_affinity ?? [],
      bgm_mood: c.bgm_mood ?? [],
      duration_hint: c.duration_hint ?? [2, 6],
    };
  }

  /** 按角色选模型（chat/image/video/audio/music），可选厂商偏好与是否要求可商用 */
  modelsByRole(role, { commercialOnly = true } = {}) {
    return this.modelRegistry.filter(
      (m) => m.role === role && (!commercialOnly || m.commercial_ok !== false)
    );
  }

  /** 合法曲目（授权字段齐全且可商用） */
  licensableBgm(moodTag = null) {
    return this.bgmLibrary.filter((t) => {
      const ok =
        t.commercial_use === true &&
        t.license &&
        typeof t.attribution_required === 'boolean' &&
        t.content_id_registered !== undefined &&
        t.verified_at;
      if (!ok) return false;
      return !moodTag || (t.mood_tags ?? []).includes(moodTag);
    });
  }

  /** 完整性自检：返回缺失/异常项，供启动与测试调用 */
  validate() {
    const problems = [];
    const expect = {
      style_presets: 32,
      director_profiles: 6,
      shot_cards: 38,
      transition_cards: 27,
      lighting_cards: 42,
      rhythm_templates: 44,
      emotion_cards: 40,
      revenue_policies: 8,
    };
    const actual = {
      style_presets: this.stylePresets.length,
      director_profiles: this.directorProfiles.length,
      shot_cards: this.shotCards.length,
      transition_cards: this.transitionCards.length,
      lighting_cards: this.lightingCards.length,
      rhythm_templates: this.rhythmTemplates.length,
      emotion_cards: this.emotionCards.length,
      revenue_policies: this.revenuePolicies.length,
    };
    for (const [k, v] of Object.entries(expect)) {
      if (actual[k] !== v) problems.push({ item: k, expected: v, actual: actual[k] });
    }
    // 新增库只做非空校验（内容会持续扩充，不锁死数量）
    actual.cinema_grammar = (this.cinemaGrammar.recipes ?? []).length;
    actual.sfx_cards = this.sfxLibrary.length;
    for (const [k, min] of [['cinema_grammar', 12], ['sfx_cards', 10]]) {
      if (actual[k] < min) problems.push({ item: k, expected: `>=${min}`, actual: actual[k] });
    }
    // 可选模型目录：每个环节都要有货，否则前端选择器会空掉
    for (const role of ['chat', 'image', 'video', 'audio', 'edit']) {
      const r = this.catalogRole(role);
      if (!r) problems.push({ item: `model_catalog.${role}`, issue: '目录缺少该环节' });
      else if (!(r.items ?? []).length) problems.push({ item: `model_catalog.${role}`, issue: '目录没有任何模型' });
      else if ((r.items ?? []).length > 5) problems.push({ item: `model_catalog.${role}`, issue: '每个环节最多 5 个模型' });
    }
    actual.model_catalog_roles = this.catalogRoles().length;
    // 交叉引用校验：风格引用的光影卡必须存在
    for (const s of this.stylePresets) {
      for (const c of [...(s.lighting_cards_required ?? []), ...(s.lighting_cards_forbidden ?? [])]) {
        if (!this.lighting(c)) problems.push({ item: `${s.code} -> ${c}`, issue: '光影卡不存在' });
      }
      // 风格强制卡不得与禁止卡重叠
      const overlap = (s.lighting_cards_required ?? []).filter((c) => (s.lighting_cards_forbidden ?? []).includes(c));
      if (overlap.length) problems.push({ item: s.code, issue: `强制卡与禁止卡重叠: ${overlap.join(',')}` });
      if (!this.director(s.director_profile_default)) {
        problems.push({ item: `${s.code} -> ${s.director_profile_default}`, issue: '导演原型不存在' });
      }
    }
    // 导演原型引用的光影卡
    for (const d of this.directorProfiles) {
      for (const c of d.lighting_bias ?? []) {
        if (!this.lighting(c)) problems.push({ item: `${d.code} -> ${c}`, issue: '光影卡不存在' });
      }
    }
    // 语法配方：引用的每一张卡都必须真实存在（否则生成时才炸）
    for (const r of this.cinemaGrammar.recipes ?? []) {
      if (!this.shot(r.shot)) problems.push({ item: `${r.code} -> ${r.shot}`, issue: '镜头卡不存在' });
      if (r.move && this.shot(r.move)?.dim !== 'movement') {
        problems.push({ item: `${r.code} -> ${r.move}`, issue: '运镜卡不存在或不是 movement 维度' });
      }
      for (const c of r.lighting ?? []) {
        if (!this.lighting(c)) problems.push({ item: `${r.code} -> ${c}`, issue: '光影卡不存在' });
      }
      for (const [field, lookup] of [
        ['transition', 'transition'], ['rhythm', 'rhythm'],
        ['composition', 'composition'], ['atmosphere', 'atmosphere'],
        ['lens', 'lens'], ['color', 'colorGrade'],
      ]) {
        if (r[field] && !this[lookup](r[field])) {
          problems.push({ item: `${r.code} -> ${r[field]}`, issue: `${field} 卡不存在` });
        }
      }
      // styles 标签是配方的适用面：写错风格 code 会让整条配方永远抽不到，必须拦在自检里
      if (r.styles !== undefined && !Array.isArray(r.styles)) {
        problems.push({ item: r.code, issue: 'styles 必须是数组（空数组 = 全风格可用）' });
      }
      for (const s of r.styles ?? []) {
        if (!this.style(s)) problems.push({ item: `${r.code} -> ${s}`, issue: 'styles 里的风格不存在' });
      }
      if (!r.intent) problems.push({ item: r.code, issue: '配方缺 intent（选配方要靠它匹配戏剧目的）' });
      if (!r.why) problems.push({ item: r.code, issue: '配方缺 why（说不清为什么这么拍就不该进库）' });
    }
    // 音效卡：必填字段 + 合成参数
    for (const s of this.sfxLibrary) {
      for (const f of ['code', 'name', 'kind', 'synth']) {
        if (!s[f]) problems.push({ item: s.code ?? '?', issue: `音效卡缺字段 ${f}` });
      }
      if (typeof s.duration !== 'number' || s.duration < 0) {
        problems.push({ item: s.code, issue: 'duration 必须是非负数（0 = 跟镜头长度）' });
      }
    }
    // 情绪卡：必备字段 + 交叉引用 + 强度区间
    const EMOTION_LOCK_FIELDS = ['brow', 'eyes', 'mouth', 'jaw', 'breath', 'gesture', 'posture', 'gaze'];
    for (const e of this.emotionCards) {
      for (const f of ['code', 'cat', 'name', 'intensity', 'lock', 'prompt_en', 'motion_en', 'micro_timeline']) {
        if (e[f] === undefined) problems.push({ item: e.code ?? '?', issue: `情绪卡缺字段 ${f}` });
      }
      for (const f of EMOTION_LOCK_FIELDS) {
        if (!e.lock?.[f]) problems.push({ item: e.code, issue: `情绪卡缺表演锁 ${f}` });
      }
      if (!(e.intensity >= 1 && e.intensity <= 5)) problems.push({ item: e.code, issue: '强度越界 1..5' });
      for (const c of e.shot_affinity ?? []) {
        if (!this.shot(c)) problems.push({ item: `${e.code} -> ${c}`, issue: '镜头卡不存在' });
      }
      for (const c of e.lighting_affinity ?? []) {
        if (!this.lighting(c)) problems.push({ item: `${e.code} -> ${c}`, issue: '光影卡不存在' });
      }
      for (const c of e.transition_affinity ?? []) {
        if (!this.transition(c)) problems.push({ item: `${e.code} -> ${c}`, issue: '转场卡不存在' });
      }
    }
    // 情绪必须可作为资产类型入库
    if (!this.lockTemplate('emotion')) problems.push({ item: 'emotion', issue: '缺少情绪资产连续性锁模板' });

    // 收益政策库：平台对齐、四类系数、时效与免责声明（§13.4 政策时效性红线）
    const REVENUE_TYPES = ['live_action', '3d', '2d', 'narration'];
    for (const p of this.revenuePolicies) {
      if (!this.platform(p.code)) problems.push({ item: p.code, issue: '收益政策引用了不存在的分发平台' });
      for (const f of ['code', 'name', 'pricing_model', 'coef', 'base_cny_per_1k_effective_views', 'settlement', 'policy_updated_at', 'policy_source_url', 'disclaimer']) {
        if (p[f] === undefined) problems.push({ item: p.code, issue: `收益政策缺字段 ${f}` });
      }
      for (const t of REVENUE_TYPES) {
        if (typeof p.coef?.[t] !== 'number' || p.coef[t] <= 0) {
          problems.push({ item: `${p.code} -> ${t}`, issue: '分成系数缺失或非正数' });
        }
      }
      if (!(p.base_cny_per_1k_effective_views > 0)) problems.push({ item: p.code, issue: '基准单价必须为正数' });
      if (!p.settlement?.cycle) problems.push({ item: p.code, issue: '缺结算周期' });
      if (!/^https?:\/\//.test(p.policy_source_url ?? '')) problems.push({ item: p.code, issue: '政策来源链接无效' });
      if (!/以平台最新公告为准/.test(p.disclaimer ?? '')) problems.push({ item: p.code, issue: '缺政策时效性免责声明' });
    }
    for (const p of this.distributionPlatforms) {
      if (!this.revenuePolicy(p.code)) problems.push({ item: p.code, issue: '分发平台缺收益政策' });
    }

    // 曲库授权字段
    for (const t of this.bgmLibrary) {
      for (const f of ['license', 'attribution_required', 'commercial_use', 'content_id_registered', 'verified_at']) {
        if (t[f] === undefined) problems.push({ item: t.track_id, issue: `缺授权字段 ${f}` });
      }
    }
    // 缺失/损坏的文件是最硬的问题，排在最前，方便线上 /health 一眼看到
    for (const p of seedProblems) problems.unshift({ item: p.file, issue: `加载失败(${p.issue})` });
    return { ok: problems.length === 0, problems, counts: actual, missing_files: seedProblems.map((p) => p.file) };
  }
}

export const seeds = new SeedStore();
export default seeds;
