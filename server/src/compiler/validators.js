/**
 * §12.4 编译期校验清单 —— 任一失败即拒绝生成（不花钱先拦住）。
 * 每一条都是可单元测试的纯函数。
 */
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';
import { speechUnits, maxSpeechUnits } from '../core/util.js';

/** 内容安全红线词（可扩展；正式环境建议接入平台机审 API 做二次校验） */
export const REDLINE_WORDS = [
  // 违禁与极端
  '毒品', '制毒', '贩毒', '枪支交易', '爆炸物制作',
  // 色情低俗（描述性，非医学/艺术语境）
  '裸露生殖', '性行为描写', '猥亵儿童',
  // 政治敏感（不做任何政治内容生成）
  '国家领导人', '政治宣传', '颠覆国家',
  // 侵权
  '真实明星姓名', '迪士尼角色', '漫威角色',
];

/** 敏感要素（出现在画面描述中需人工确认） */
export const SENSITIVE_ELEMENTS = [
  '真实国旗', '真实军徽', '真实警徽', '真实货币', '真实商标', '真实品牌Logo',
];

export function checkContentSafety(texts = []) {
  const joined = String(texts.join(' '));
  for (const w of REDLINE_WORDS) {
    if (joined.includes(w)) {
      fail(ERR.CONTENT_BLOCKED, `内容包含红线要素，已被拦截：${w}`, { hit: w });
    }
  }
  const warns = [];
  for (const e of SENSITIVE_ELEMENTS) {
    if (joined.includes(e)) warns.push(e);
  }
  return { ok: true, warnings: warns };
}

/** 1. 命中且仅命中 1 张镜头卡 */
export function checkShotCard(ctx) {
  const { shotCardCodes } = ctx;
  if (!Array.isArray(shotCardCodes) || shotCardCodes.length !== 1) {
    fail(ERR.MISSING_DIRECTOR_CARD, '每个镜头必须命中且仅命中一张镜头卡', {
      got: shotCardCodes ?? null,
    });
  }
  const card = seeds.shot(shotCardCodes[0]);
  if (!card) fail(ERR.MISSING_DIRECTOR_CARD, `镜头卡不存在: ${shotCardCodes[0]}`);
  return card;
}

/** 2. 至少 1 张光影卡，且与风格的强制/禁止一致 */
export function checkLighting(ctx) {
  const { lightingCodes, style } = ctx;
  if (!lightingCodes?.length) fail(ERR.MISSING_LIGHTING_CARD, '缺少光影卡');
  for (const c of lightingCodes) {
    if (!seeds.lighting(c)) fail(ERR.MISSING_LIGHTING_CARD, `光影卡不存在: ${c}`);
  }
  if (style) {
    for (const req of style.lighting_cards_required ?? []) {
      if (!lightingCodes.includes(req)) {
        fail(ERR.STYLE_REQUIRED_LIGHTING, `风格 ${style.name} 要求光影卡 ${req}`, { style: style.code });
      }
    }
    for (const forb of style.lighting_cards_forbidden ?? []) {
      if (lightingCodes.includes(forb)) {
        fail(ERR.STYLE_FORBIDDEN_LIGHTING, `风格 ${style.name} 禁止光影卡 ${forb}`, { style: style.code });
      }
    }
  }
  return lightingCodes.map((c) => seeds.lighting(c));
}

/** 3. 至少 1 条连续性锁 */
export function checkContinuityLocks(ctx) {
  const { locks } = ctx;
  if (!locks?.length) {
    fail(ERR.MISSING_CONTINUITY_LOCK, '缺少连续性锁：角色/场景/道具至少要有可引用的稳定特征');
  }
  return locks;
}

/** 4. 视觉依据覆盖：出现的角色必须能引用到资产，或显式声明画外 */
export function checkVisualBasis(ctx) {
  const { characters, assetMap = {}, offscreen = [] } = ctx;
  const missing = [];
  for (const c of characters ?? []) {
    if (offscreen.includes(c)) continue;
    if (!assetMap[c]) missing.push(c);
  }
  if (missing.length) {
    fail(ERR.VISUAL_BASIS_NOT_COVERED, '以下角色在画面中但没有可用视觉依据（资产）', {
      missing,
      hint: '请先生成角色资产，或显式声明该角色为画外',
    });
  }
  return true;
}

/** 5. 视频提示词时长 == 分镜时长 */
export function checkDuration(ctx) {
  const { kind, shotDuration, requestedDuration } = ctx;
  if (kind !== 'video') return true;
  const req = requestedDuration ?? shotDuration;
  if (Math.abs((req ?? 0) - (shotDuration ?? 0)) > 0.01) {
    fail(ERR.DURATION_MISMATCH, '视频时长与分镜时长不一致', {
      shot: shotDuration,
      requested: req,
    });
  }
  return true;
}

/** 6. 参考图齐全：缺失需写成挂图计划，不能偷偷转文生视频 */
export function checkReferences(ctx) {
  const { kind, references = [], allowPending = false, pendingPlan } = ctx;
  const required = references.filter((r) => r.required);
  const missing = required.filter((r) => !r.url);
  if (missing.length && !(allowPending && pendingPlan?.length)) {
    fail(ERR.MISSING_REFERENCE, '缺少必需参考图，且未给出挂图计划', {
      missing: missing.map((r) => ({ role: r.role, asset_code: r.asset_code })),
    });
  }
  if (kind === 'video' && missing.length && allowPending) {
    // 允许，但必须在输出里挂计划（由调用方写入 pending_reference_plan）
    return { pending: missing };
  }
  return { pending: [] };
}

/** 7. 对白字数 ≤ 镜长 × 4.1 */
export function checkDialogue(ctx) {
  const { dialogue, duration } = ctx;
  if (!dialogue) return { units: 0, max: maxSpeechUnits(duration ?? 0) };
  const units = speechUnits(dialogue);
  const max = maxSpeechUnits(duration ?? 0);
  if (units > max) {
    fail(ERR.DIALOGUE_OVERFLOW, `对白超出该镜长可承载的字数（${units.toFixed(1)} > ${max.toFixed(1)}）`, {
      duration,
      units,
      max,
      hint: '精简对白或延长镜长',
    });
  }
  return { units, max };
}

/** 8. 说话人绑定明确；同框其他正脸必须写明闭口不说话 */
export function checkSpeaker(ctx) {
  const { dialogue, speaker, onScreenCharacters = [] } = ctx;
  if (dialogue && !speaker) {
    fail(ERR.SPEAKER_AMBIGUOUS, '有对白但未指定说话人');
  }
  const others = onScreenCharacters.filter((c) => c !== speaker);
  return { speaker, silentOthers: others };
}

/** 9. 非硬切转场必须给理由 */
export function checkTransition(ctx) {
  const { transitionCode, transitionReason } = ctx;
  if (!transitionCode) return { code: 'TRN-HARDCUT', reason: null };
  const card = seeds.transition(transitionCode);
  if (!card) fail(ERR.TRANSITION_REASON_REQUIRED, `转场卡不存在: ${transitionCode}`);
  if (card.code !== 'TRN-HARDCUT' && !transitionReason) {
    fail(ERR.TRANSITION_REASON_REQUIRED, '非硬切转场必须说明理由', { code: transitionCode });
  }
  return { code: card.code, reason: transitionReason ?? null, card };
}

/**
 * 13. 情绪卡校验（第 13 条强制链）。
 * 规则：
 *  a. 画面中每个在场的角色都必须绑定一张情绪卡 —— 没有情绪的表演就是"面瘫"，这是漫剧最难看的事故。
 *  b. 情绪卡必须存在于种子库。
 *  c. 高强情绪（≥4）需要足够镜长铺陈：低于 2.5 秒演不出"压抑的暴怒"，只能演成"皱眉"。
 *  d. 有对白时，说话人必须有情绪卡（语气 = 情绪 × 声线）。
 *  e. 情绪卡的镜头/光影亲和必须被尊重：规划阶段若给出冲突的镜别，给出警告而非硬拦（允许导演刻意反用）。
 */
export function checkEmotion(ctx) {
  const {
    characters = [],
    emotionMap = {},       // { CH01: 'EMO-XXX' } 或 { CH01: { card, asset } }
    emotionAssets = {},    // { CH01: 情绪资产对象 }
    duration = 5,
    speaker = null,
    shotCard = null,
    lightingCodes = [],
    allowNeutral = false,
  } = ctx;

  const resolved = {};
  const warnings = [];

  for (const c of characters) {
    const raw = emotionMap[c];
    const code = typeof raw === 'string' ? raw : raw?.card ?? raw?.emotion_card ?? null;
    if (!code) {
      // 允许调用方显式声明"该角色本镜不需要情绪"（如远景群演、纯背影）
      if (allowNeutral) { resolved[c] = null; continue; }
      fail(ERR.MISSING_EMOTION_CARD, `角色 ${c} 在该镜缺少情绪卡，无法生成表演`, {
        character: c,
        hint: '角色情绪是资产：请从角色情绪调色板中指定一张，或显式声明 allowNeutral',
      });
    }
    const card = seeds.emotion(code);
    if (!card) fail(ERR.EMOTION_CARD_NOT_FOUND, `情绪卡不存在: ${code}`);

    // c. 高强情绪需要镜长铺陈
    const minDur = card.duration_hint?.[0] ?? 2;
    if (card.intensity >= 4 && (duration ?? 0) < 2.5) {
      fail(ERR.EMOTION_INTENSITY_TOO_SHORT, `情绪「${card.name}」强度 ${card.intensity}，需要至少 2.5 秒铺陈`, {
        character: c, card: card.code, duration, min: 2.5,
      });
    }
    // e. 亲和冲突只警告
    if (shotCard && card.shot_affinity?.length && !card.shot_affinity.includes(shotCard)) {
      warnings.push(`角色 ${c} 的情绪「${card.name}」建议镜别 ${card.shot_affinity.join('/')}，当前为 ${shotCard}`);
    }
    const recLight = (card.lighting_affinity ?? []).filter((l) => lightingCodes.includes(l));
    if (card.lighting_affinity?.length && !recLight.length) {
      warnings.push(`角色 ${c} 的情绪「${card.name}」建议光影 ${card.lighting_affinity.join('/')}，当前未命中`);
    }
    resolved[c] = { card, asset: emotionAssets[c] ?? null, min_duration: minDur };
  }

  // d. 说话人必须有情绪
  if (speaker && characters.includes(speaker) && !resolved[speaker]) {
    fail(ERR.MISSING_EMOTION_CARD, `说话人 ${speaker} 缺少情绪卡，无法给出语气`, { speaker });
  }
  return { resolved, warnings, cards: Object.values(resolved).filter(Boolean).map((r) => r.card) };
}

/** 11. 余额足够 */
export function checkCredits(ctx) {
  const { availableCredits, estimatedCredits } = ctx;
  if ((availableCredits ?? 0) < (estimatedCredits ?? 0)) {
    fail(ERR.INSUFFICIENT_CREDITS, '点数不足，请先充值', {
      available: availableCredits ?? 0,
      required: estimatedCredits ?? 0,
    });
  }
  return true;
}

/** 12. BGM 授权字段齐全且可商用 */
export function checkBgm(ctx) {
  const { bgmTrackId } = ctx;
  if (!bgmTrackId) return null;
  const t = seeds.bgm(bgmTrackId);
  if (!t) fail(ERR.LICENSE_FIELD_MISSING, `曲目不存在: ${bgmTrackId}`);
  const required = ['license', 'attribution_required', 'commercial_use', 'content_id_registered', 'verified_at'];
  for (const f of required) {
    if (t[f] === undefined) {
      fail(ERR.LICENSE_FIELD_MISSING, `曲目 ${bgmTrackId} 缺少授权字段 ${f}`);
    }
  }
  if (t.commercial_use !== true) {
    fail(ERR.LICENSE_FIELD_MISSING, `曲目 ${bgmTrackId} 不允许商用`);
  }
  return t;
}
