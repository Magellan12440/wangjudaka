/**
 * 声音设计：给时间线自动排「转场音效 / 环境音床 / 心跳 / 重击」，并给出混音参数。
 *
 * 原则（与 §10.4 一致）：
 *   1. 音效只服务剪切，不抢戏：转场音效默认 -12dB，环境床 -24 ~ -30dB；
 *   2. 对白优先：有对白的镜头不加心跳/脉冲，避免低频糊住人声；
 *   3. 每一条 cue 都要能解释「为什么在这里」——reason 字段必填，便于人工复核。
 */
import seeds from '../seeds/loader.js';
import { MOOD_TABLE, DEFAULT_MOOD } from './SynthBGM.js';
import { MIX_RULES } from './Renderer.js';

/** 各方言标签 → 合成器支持的 9 种情绪 */
export const MOOD_ALIAS = {
  suspense: 'suspense', fear: 'suspense', horror: 'suspense', mystery: 'mystery', dark: 'mystery',
  tense: 'tense', tension: 'tense', shock: 'tense', dissonant: 'tense', chaos: 'tense', struggle: 'tense',
  sad: 'sad', sadness: 'sad', melancholy: 'sad', empathy: 'sad', lonely: 'sad', empty: 'sad', grief: 'sad', remorse: 'sad',
  warm: 'warm', warmth: 'warm', gentle: 'warm', romance: 'warm', romantic: 'warm', sweet: 'warm', tender: 'warm', hopeful: 'warm', calm: 'warm',
  epic: 'epic', triumph: 'epic', triumphant: 'epic', majestic: 'epic', solemn: 'epic', power: 'epic', resolve: 'epic', sacrificial: 'epic',
  action: 'action', driving: 'action', swagger: 'action', rage: 'action',
  cyber: 'cyber', synthetic: 'cyber',
  daily: 'daily', ambient: 'daily', subtle: 'daily', bright: 'daily', joyful: 'daily', joy: 'daily',
};

export function normalizeMood(tag) {
  const k = String(tag ?? '').trim().toLowerCase();
  return MOOD_ALIAS[k] ?? null;
}

/** 从一段标签里挑出现次数最多的合法情绪 */
export function pickMood(tags = [], fallback = DEFAULT_MOOD) {
  const count = new Map();
  for (const t of tags) {
    const m = normalizeMood(t);
    if (m) count.set(m, (count.get(m) ?? 0) + 1);
  }
  if (!count.size) return fallback;
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function moodFromStyle(style) {
  return pickMood(style?.bgm_bias?.mood_tags ?? [], DEFAULT_MOOD);
}

/** 情绪卡 → bgm_mood 标签（情绪卡里是逗号分隔的英文标签） */
export function moodTagsFromEmotions(codes = []) {
  const out = [];
  for (const c of codes) {
    const card = seeds.emotion(c);
    for (const t of String(card?.bgm_mood ?? '').split(',')) {
      const s = t.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

/** 情绪强度：用于判断是否值得上一记重击 */
export function intensityFromEmotions(codes = []) {
  let max = 0;
  for (const c of codes) max = Math.max(max, Number(seeds.emotion(c)?.intensity ?? 0));
  return max;
}

function pushCue(list, cue, minGap = 0.28) {
  if (!cue || !cue.code) return false;
  const card = seeds.sfx(cue.code);
  if (!card) return false;
  const dur = cue.duration ?? card.duration ?? 0.5;
  const t = Math.max(0, cue.t);
  // 同一时刻附近已有同类音效则跳过，避免堆叠
  const clash = list.some((c) => c.kind === card.kind && Math.abs(c.t - t) < minGap);
  if (clash) return false;
  list.push({
    t: +t.toFixed(2),
    code: card.code,
    name: card.name,
    kind: card.kind,
    duration: dur,
    gain_db: cue.gain_db ?? card.gain_db ?? -14,
    fade_in: cue.fade_in ?? 0.04,
    fade_out: cue.fade_out ?? 0.12,
    reason: cue.reason ?? null,
    shot_no: cue.shot_no ?? null,
  });
  return true;
}

/**
 * 生成整集的音效表。
 * @param {object} p
 *  segments: [{ shot_no, index, start, end, duration, transition, dialogue:boolean,
 *               atmosphere, emotions:[code], is_episode_end }]
 *  style, totalSec
 */
export function buildSoundSheet({ segments = [], style = null, totalSec = 0 } = {}) {
  const cues = [];
  const ambience = [];
  const warnings = [];
  const total = totalSec || segments.at(-1)?.end || 0;

  // —— 转场音效 ——
  for (const [i, s] of segments.entries()) {
    if (i === 0) {
      if ((s.duration ?? 0) >= 3) {
        pushCue(cues, {
          code: 'SFX-RISER', t: Math.max(0, s.start - 1.6), duration: 1.6,
          reason: '集首蓄势，把观众拉进第一镜', shot_no: s.shot_no,
        });
      }
      continue;
    }
    const trn = s.transition ?? 'TRN-HARDCUT';
    if (trn !== 'TRN-HARDCUT') {
      const pool = seeds.sfxForTransition(trn);
      const card = pool[0];
      if (card) {
        const dur = card.duration || 0.5;
        pushCue(cues, {
          code: card.code,
          t: Math.max(0, s.start - dur + 0.05),
          duration: dur,
          reason: `转场 ${trn} 的声学落点，尾端对齐剪切点`,
          shot_no: s.shot_no,
        });
      } else {
        warnings.push({ shot: s.shot_no, issue: `转场 ${trn} 没有配对的音效卡，已留白` });
      }
    } else {
      // 硬切：情绪强度 ≥4 才补重击，否则保持干净
      const intensity = intensityFromEmotions(s.emotions ?? []);
      if (intensity >= 4) {
        pushCue(cues, {
          code: 'SFX-IMPACT', t: s.start, gain_db: -12,
          reason: `硬切 + 情绪强度 ${intensity}，给一个物理落点`, shot_no: s.shot_no,
        });
      }
    }
  }

  // —— 情绪层：紧张段补心跳（无对白时才加） ——
  for (const s of segments) {
    if (s.dialogue) continue;
    const mood = pickMood(moodTagsFromEmotions(s.emotions ?? []), null);
    if (mood && ['suspense', 'tense', 'mystery'].includes(mood)) {
      pushCue(cues, {
        code: 'SFX-HEARTBEAT', t: s.start + 0.2, gain_db: -22, duration: 1.2,
        reason: `无对白的${mood}段，心跳垫底替代配乐`, shot_no: s.shot_no,
      });
    }
  }

  // —— 集末 ——
  const last = segments.at(-1);
  if (last?.is_episode_end && total > 1) {
    pushCue(cues, {
      code: 'SFX-STING', t: Math.max(0, total - 1.2), gain_db: -16,
      reason: '集末钩子，用惊弦收住', shot_no: last.shot_no,
    });
  }

  // —— 环境音床：按出现最多的氛围铺 1~2 条 ——
  const atmCount = new Map();
  for (const s of segments) {
    const a = s.atmosphere;
    if (a) atmCount.set(a, (atmCount.get(a) ?? 0) + 1);
  }
  const topAtm = [...atmCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [atm, n] of topAtm) {
    const beds = seeds.ambienceForAtmosphere(atm);
    const bed = beds[0];
    if (!bed) continue;
    ambience.push({
      code: bed.code, name: bed.name, atmosphere: atm,
      t: 0, duration: +total.toFixed(2), gain_db: bed.gain_db ?? -26,
      fade_in: 1.5, fade_out: 2.0,
      reason: `氛围 ${atm} 出现 ${n} 次，全程铺底`,
    });
  }
  if (!ambience.length && total > 0) {
    const room = seeds.sfx('SFX-ROOM-BED');
    if (room) {
      ambience.push({
        code: room.code, name: room.name, atmosphere: 'default',
        t: 0, duration: +total.toFixed(2), gain_db: room.gain_db ?? -30,
        fade_in: 1.5, fade_out: 2.0, reason: '没有明确氛围时用室内静场兜底',
      });
    }
  }

  // —— 配乐情绪 ——
  const segMoods = segments.flatMap((s) => [moodFromEmotionsLoose(s), moodFromStyle(style)]);
  const mood = pickMood(segMoods.map((m) => m ?? ''), moodFromStyle(style));
  const bpmRange = style?.bgm_bias?.bpm_range ?? null;
  const bpm = bpmRange ? Math.round((bpmRange[0] + bpmRange[1]) / 2) : MOOD_TABLE[mood]?.bpm ?? 72;

  return {
    mood,
    bpm,
    cues: cues.sort((a, b) => a.t - b.t),
    ambience,
    mix: {
      target_lufs: MIX_RULES.target_lufs,
      true_peak_dbtp: MIX_RULES.true_peak_dbtp,
      ducking: {
        reduction_db: MIX_RULES.ducking_reduction_db,
        attack_ms: MIX_RULES.ducking_attack_ms,
        release_ms: MIX_RULES.ducking_release_ms,
        trigger: 'dialogue',
      },
      bgm_gain_db: -20,
      sfx_bus_db: -12,
      ambience_bus_db: -26,
    },
    stats: {
      sfx_count: cues.length,
      ambience_count: ambience.length,
      duration_sec: +total.toFixed(2),
    },
    warnings,
  };
}

function moodFromEmotionsLoose(seg) {
  if (!seg?.emotions?.length) return null;
  return pickMood(moodTagsFromEmotions(seg.emotions), null);
}

export const soundDesign = { buildSoundSheet, pickMood, normalizeMood, moodFromStyle, MOOD_ALIAS };
export default soundDesign;
