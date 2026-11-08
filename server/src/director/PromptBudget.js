/**
 * 提示词预算与参考图体检（V4.17）。
 *
 * 来源：对公开失败模式清单（17 类生成失败）的实测总结，其中三条最费钱、最常见：
 *   1. **字数硬上限**：单条提示词超过约 1500 字符时，部分视频/图片模型会静默丢后半段，
 *      角色锁、负面词全在尾部 → 表现成"一致性莫名下降"。丢在哪没人告诉你，只扣钱。
 *   2. **多参考图同框**：一次塞 4 张角色参考，模型会把人脸"平均"，越参越不像。
 *   3. **参考图 + 文字重描身体**：已经给了长相参考，又用文字写一遍发型脸型，
 *      两套描述打架，模型只能折中。
 *
 * 本模块只做**预检与告警**，不改写提示词：
 *   自动裁剪会把"导演锁定的信息"悄悄删掉，比超字数更难排查。
 *   告警进 compile_warnings，同时通过 /api/director/preflight 可在花钱前单独查。
 */
import { round } from '../core/util.js';

/** 单条提示词软上限（字符）。可用 PROMPT_MAX_CHARS 覆盖（不同模型上限不同） */
export const DEFAULT_MAX_CHARS = Number(process.env.PROMPT_MAX_CHARS ?? 1500);
/** 参考图同框超过这个数，一致性风险陡增 */
export const REF_SAFE_LIMIT = 3;

/** 会与参考图打架的"身体重描"关键词（中文 + 英文） */
const BODY_WORDS = [
  '发型', '发色', '脸型', '五官', '眉眼', '肤色', '身材', '身高', '体型',
  'hair', 'hairstyle', 'face shape', 'facial features', 'skin tone', 'body type',
];

/**
 * 估算提示词将要发给模型的字符数。
 * 说明：不按"字数"算——模型吃的是字符流，中英文混排时按字数会低估一半。
 */
export function measure(text = '') {
  const s = String(text ?? '');
  return {
    chars: s.length,
    words: s.trim() ? s.trim().split(/\s+/).length : 0,
  };
}

/**
 * @param {object} p
 * @param {string} p.prompt       真正要发出去的正向提示词
 * @param {string} p.negative     负向提示词（部分模型单独字段，也算预算）
 * @param {Array}  p.references   参考图 [{role, asset_code, url}]
 * @param {number} p.maxChars
 * @returns {{ ok, level, chars, cap, usage, warnings: [] }}
 */
export function audit({ prompt = '', negative = '', references = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
  const warnings = [];
  const pos = measure(prompt);
  const neg = measure(negative);
  const chars = pos.chars + neg.chars;
  const cap = Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS);
  const usage = round(chars / cap, 3);

  // —— 1. 字数预算 ——
  if (chars > cap) {
    warnings.push({
      code: 'PROMPT_OVER_BUDGET',
      severity: 'warn',
      text: `提示词 ${chars} 字符，超过软上限 ${cap}（超出 ${chars - cap}）`,
      fix: '把一致性锁移到参考图里、删掉重复的画风描述；尾部的内容模型最先忽略',
    });
  } else if (usage >= 0.9) {
    warnings.push({
      code: 'PROMPT_NEAR_BUDGET',
      severity: 'info',
      text: `提示词 ${chars} 字符，已用掉预算的 ${Math.round(usage * 100)}%`,
      fix: '再往里加内容前先删一条重复描述，别等到被截断',
    });
  }

  // —— 2. 参考图同框 ——
  const refs = (references ?? []).filter((r) => r && (r.url || r.asset_code));
  if (refs.length > REF_SAFE_LIMIT) {
    warnings.push({
      code: 'REF_OVERLOAD',
      severity: 'warn',
      text: `同框参考图 ${refs.length} 张（安全线 ${REF_SAFE_LIMIT}）`,
      fix: '只留长相参考 + 1 张场景/风格；配角改用文字锁定，多张人脸会互相平均',
    });
  }

  // —— 3. 参考图 + 文字重描身体 ——
  const hasIdentity = refs.some((r) => ['character', 'identity_reference'].includes(String(r.role)));
  if (hasIdentity) {
    const hits = BODY_WORDS.filter((w) => String(prompt).toLowerCase().includes(w.toLowerCase()));
    if (hits.length >= 2) {
      warnings.push({
        code: 'REF_DESCRIBE_CONFLICT',
        severity: 'warn',
        text: `已给长相参考，提示词里又重描了 ${hits.slice(0, 4).join('、')}`,
        fix: '有参考图时只写"表情 / 动作 / 光位"，长相交给参考图，两套描述会打架',
      });
    }
  }

  const level = warnings.some((w) => w.severity === 'warn') ? 'warn' : warnings.length ? 'info' : 'ok';
  return {
    ok: level === 'ok',
    level,
    chars,
    cap,
    usage,
    breakdown: { prompt: pos.chars, negative: neg.chars, references: refs.length },
    warnings,
  };
}

/** 转成 compile_warnings 里的字符串（保持既有告警格式一致） */
export function warningLines(result) {
  return (result?.warnings ?? []).map((w) => `提示词预算：${w.text}（${w.fix}）`);
}

export const promptBudget = { audit, measure, warningLines, DEFAULT_MAX_CHARS, REF_SAFE_LIMIT };
export default promptBudget;
