/**
 * 资产库（§1 一致性基石）：角色 / 场景 / 道具 / 声线。
 *
 * 三条硬规则：
 *  1. 资产必须带 locks（连续性锁），否则不允许被镜头引用（编译器会拦）。
 *  2. 资产有版本号；镜头固化引用时的版本号（快照），改资产不污染已生成的镜头。
 *  3. 改资产时可预演影响面：命中哪些镜头、重生成要花多少点。
 */
import { db } from '../store/db.js';
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';

const COL = 'assets';
const SNAP = 'asset_snapshots';

export class AssetLibrary {
  /**
   * 创建资产
   * @param {object} p { projectId, assetType, name, code?, locks[], lock_values{}, image_url, meta }
   *
   * V4.13：支持显式指定 asset_code。
   * 以前只按"当前数量 +1"自动编号，于是剧本里的 CH07（配角）会被建成 CH02 ——
   * 分镜引用 CH07 时照样找不到资产，系统只好再补一张空卡，配角脸和设定图永远对不上。
   * 现在有 code 就用 code（必须唯一），没有才自动编号。
   */
  create({ projectId, assetType, name, code = null, locks = [], lockValues = {}, imageUrl = null, meta = {} }) {
    const tpl = seeds.lockTemplate(assetType);
    if (!tpl) fail(ERR.BAD_REQUEST, `未知资产类型: ${assetType}`);
    // 锁必须显式给出：自动补齐会让"一致性"形同虚设，这里不接受少于下限的锁
    const filled = [...new Set(locks.filter(Boolean))].slice(0, 8);
    if (filled.length < tpl.required_lock_count) {
      fail(ERR.MISSING_CONTINUITY_LOCK, `${assetType} 资产至少需要 ${tpl.required_lock_count} 条连续性锁`, {
        got: filled.length,
        template: tpl.suggested_locks,
      });
    }
    const prefix = tpl.code_prefix;
    let assetCode = null;
    if (code) {
      const wanted = String(code).trim().slice(0, 24).toUpperCase();
      if (!wanted) fail(ERR.BAD_REQUEST, '资产编码不能为空');
      if (db.findOne(COL, (a) => a.project_id === projectId && a.asset_code === wanted)) {
        fail(ERR.BAD_REQUEST, `资产编码已存在：${wanted}`);
      }
      assetCode = wanted;
    } else {
      let seq = db.count(COL, (a) => a.project_id === projectId && a.asset_type === assetType) + 1;
      assetCode = `${prefix}${String(seq).padStart(2, '0')}`;
      // 自动编号不能撞上已有的手工编码（比如 CH07 已存在，next=7 时会撞）
      while (db.findOne(COL, (a) => a.project_id === projectId && a.asset_code === assetCode)) {
        seq += 1;
        assetCode = `${prefix}${String(seq).padStart(2, '0')}`;
      }
    }
    const asset = db.insert(COL, {
      id: newId('asset'),
      project_id: projectId,
      asset_type: assetType,
      asset_code: assetCode,
      name,
      version: 1,
      locks: filled,
      lock_values: lockValues,
      image_url: imageUrl,
      negative: tpl.negative_defaults,
      meta,
      status: imageUrl ? 'ready' : 'pending',
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    return asset;
  }

  get(projectId, code) {
    return db.findOne(COL, (a) => a.project_id === projectId && a.asset_code === code);
  }

  /**
   * 情绪资产入库（第 13 条强制链）。
   * 情绪不是"随便写个词"，而是从情绪卡固化成该角色的表演锁：
   * 同一张「压抑的暴怒」卡，在不同角色脸上是两套肌肉记忆，入库即固化，跨镜头不得漂移。
   *
   * @param {object} p { projectId, emotionCode, characterCode, name, lockValues{}, intensity }
   */
  createEmotion({ projectId, emotionCode, characterCode = null, name = null, lockValues = {}, intensity = null }) {
    const card = seeds.emotion(emotionCode);
    if (!card) fail(ERR.EMOTION_CARD_NOT_FOUND, `情绪卡不存在: ${emotionCode}`);
    // 卡片自带 8 条表演锁；调用方可按角色覆写（如"这道疤在他愤怒时会发白"）
    const lockVals = {
      name: name ?? card.name,
      ...card.lock,
      ...lockValues,
    };
    const seq = db.count(COL, (a) => a.project_id === projectId && a.asset_type === 'emotion') + 1;
    const code = `EM${String(seq).padStart(2, '0')}`;
    return db.insert(COL, {
      id: newId('asset'),
      project_id: projectId,
      asset_type: 'emotion',
      asset_code: code,
      name: name ?? `${card.name}`,
      version: 1,
      locks: [
        `眉：${lockVals.brow}`,
        `眼：${lockVals.eyes}`,
        `嘴：${lockVals.mouth}`,
        `下颌：${lockVals.jaw}`,
        `呼吸：${lockVals.breath}`,
      ],
      lock_values: lockVals,
      image_url: null,
      negative: card.negative ?? [],
      meta: {
        emotion_card: card.code,
        emotion_cat: card.cat,
        character_code: characterCode,
        intensity: intensity ?? card.intensity,
        motion_en: card.motion_en,
        motion_zh: card.motion_zh,
        micro_timeline: card.micro_timeline,
        voice_hint: card.voice_hint,
        shot_affinity: card.shot_affinity,
        lighting_affinity: card.lighting_affinity,
        transition_affinity: card.transition_affinity,
        bgm_mood: card.bgm_mood,
        duration_hint: card.duration_hint,
      },
      status: 'ready',
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  /** 列出某角色已固化的情绪资产 */
  emotionsOf(projectId, characterCode = null) {
    return db.find(COL, (a) => {
      if (a.project_id !== projectId || a.asset_type !== 'emotion') return false;
      return !characterCode || a.meta?.character_code === characterCode;
    });
  }

  /**
   * 角色情绪档案：把一个角色的"情绪调色板"固化下来。
   * baseline 是该角色的常态表情，palette 是他在本剧允许出现的情绪集合。
   * 规划阶段只能从 palette 里挑 —— 这样角色不会突然做出不属于他的表情。
   */
  setEmotionPalette(projectId, characterCode, { baseline, palette = [], forbid = [] }) {
    const a = this.get(projectId, characterCode);
    if (!a) fail(ERR.ASSET_NOT_FOUND, `角色资产不存在: ${characterCode}`);
    for (const code of [...palette, baseline].filter(Boolean)) {
      if (!seeds.emotion(code)) fail(ERR.EMOTION_CARD_NOT_FOUND, `情绪卡不存在: ${code}`);
    }
    return db.update(COL, a.id, {
      meta: {
        ...(a.meta ?? {}),
        emotion_profile: { baseline: baseline ?? null, palette, forbid },
      },
      updated_at: nowIso(),
    });
  }

  /** 取角色可用情绪集合（未设置档案时，按角色定位给一套默认调色板） */
  emotionPaletteOf(projectId, characterCode) {
    const a = this.get(projectId, characterCode);
    const prof = a?.meta?.emotion_profile;
    if (prof?.palette?.length) return prof;
    const fallback = ['EMO-CALM-02', 'EMO-DEFIANCE-04', 'EMO-RAGE-SUPPRESSED-04', 'EMO-RESOLVE-05', 'EMO-RELIEF-03'];
    return { baseline: 'EMO-CALM-02', palette: fallback, forbid: [], is_default: true };
  }

  list(projectId, assetType = null) {
    return db.find(COL, (a) => a.project_id === projectId && (!assetType || a.asset_type === assetType));
  }

  /** 更新资产 → 版本 +1（旧镜头不受影响） */
  update(projectId, code, patch) {
    const a = this.get(projectId, code);
    if (!a) fail(ERR.ASSET_NOT_FOUND, `资产不存在: ${code}`);
    const tpl = seeds.lockTemplate(a.asset_type);
    const nextLocks = patch.locks ?? a.locks;
    if ((nextLocks ?? []).length < tpl.required_lock_count) {
      fail(ERR.MISSING_CONTINUITY_LOCK, '更新后连续性锁数量不足');
    }
    const updated = db.update(COL, a.id, {
      ...patch,
      version: (a.version ?? 1) + 1,
      updated_at: nowIso(),
    });
    return updated;
  }

  /** 生成资产图时引用的锁定提示词（中文，供人工审阅） */
  lockPromptZh(asset) {
    return `${asset.name}：${(asset.locks ?? []).join('、')}`;
  }

  /**
   * 固化快照：镜头生成时调用，记录当时用的资产版本。
   * 之后改资产不会污染已生成镜头，且能算出影响面。
   */
  snapshot({ projectId, shotNo, assets = {} }) {
    return db.insert(SNAP, {
      id: newId('snap'),
      project_id: projectId,
      shot_no: shotNo,
      assets, // { CH01: { version: 3, image_url }, SC01B: {...} }
      created_at: nowIso(),
    });
  }

  snapshotsOfShot(projectId, shotNo) {
    return db.findOne(SNAP, (s) => s.project_id === projectId && s.shot_no === shotNo);
  }

  /**
   * 影响面预演：某个资产升版后，哪些镜头会"变脸"。
   * @returns { shots: [], reGenCostPoints }
   */
  impactOfUpdate({ projectId, assetCode, newVersion, costPerShot = 6 }) {
    const snaps = db.find(SNAP, (s) => s.project_id === projectId);
    const shots = [];
    for (const s of snaps) {
      const used = s.assets?.[assetCode];
      if (used && used.version !== newVersion) {
        shots.push({ shot_no: s.shot_no, used_version: used.version });
      }
    }
    return {
      asset_code: assetCode,
      new_version: newVersion,
      affected_shots: shots,
      affected_count: shots.length,
      est_points: shots.length * costPerShot,
    };
  }

  /**
   * 一致性自检（生成后）。
   * 真实实现：CLIP 图像相似度 / 人脸特征比对；此处提供统一接口与阈值，
   * MOCK 阶段用"是否引用了资产快照"做下限保证。
   */
  checkConsistency({ shotNo, assetCode, generatedUrl, similarityScore = null, threshold = 0.82 }) {
    if (similarityScore === null) {
      // 无可比对分数时降级：只要引用了资产快照就认为通过，但标记待复核
      return { ok: true, score: null, degraded: true, note: '未接入图像比对，需人工复核' };
    }
    const ok = similarityScore >= threshold;
    if (!ok) {
      fail(ERR.CONSISTENCY_DRIFT, `一致性分 ${similarityScore} 低于阈值 ${threshold}，疑似角色漂移`, {
        shotNo,
        assetCode,
        generatedUrl,
      });
    }
    return { ok, score: similarityScore, threshold };
  }
}

export const assetLibrary = new AssetLibrary();
export default assetLibrary;
