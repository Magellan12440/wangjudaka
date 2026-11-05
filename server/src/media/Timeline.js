/**
 * 时间线 / EDL：把镜头片段、转场、音频组织成可渲染的剪辑决策表。
 * 转场使用规则（§7.3）在这里强制执行，不是建议。
 */
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';

export const TRANSITION_RULES = {
  default_hard_cut: '默认硬切，任何非硬切必须有理由',
  max_non_hard_ratio: 0.30,          // 爽感型 0.10
  time_jump_over_1day: ['TRN-XFADE', 'TRN-DISSOLVE-B', 'TRN-DISSOLVE-W'],
  flashback: ['TRN-DISSOLVE-W', 'TRN-HLUMA'],
  episode_end_forbid: ['TRN-HARDCUT'], // 集末禁止硬切到黑屏，需定格或入黑
  min_gap_between_non_hard: 8,
  forbid_during_dialogue: ['TRN-WIPE-R', 'TRN-WIPE-UP', 'TRN-SLIDE-L', 'TRN-PIXEL'],
};

export class Timeline {
  /**
   * @param {Array} segments [{ shot_no, clip_url, duration, transition, transition_reason,
   *                            dialogue, is_episode_end, time_jump_days, is_flashback }]
   */
  build(segments, { directorProfile = 'DIR-BALANCED' } = {}) {
    const errors = [];
    const warnings = [];
    let t = 0;
    const out = [];
    let lastNonHardAt = -Infinity;
    let nonHardCount = 0;

    const isIntense = directorProfile === 'DIR-INTENSE';
    const maxRatio = isIntense ? 0.1 : TRANSITION_RULES.max_non_hard_ratio;

    for (const [i, s] of segments.entries()) {
      const trnCode = s.transition ?? 'TRN-HARDCUT';
      const card = seeds.transition(trnCode);
      if (!card) {
        errors.push({ shot: s.shot_no, code: 'TRANSITION_NOT_FOUND', transition: trnCode });
        continue;
      }
      const isHard = trnCode === 'TRN-HARDCUT';

      // 规则 1：非硬切必须有理由
      if (!isHard && !s.transition_reason) {
        errors.push({ shot: s.shot_no, code: 'TRANSITION_REASON_REQUIRED', transition: trnCode });
      }
      if (!isHard) nonHardCount += 1;

      // 规则 6：两个非硬切之间至少间隔 8 秒
      if (!isHard && t - lastNonHardAt < TRANSITION_RULES.min_gap_between_non_hard) {
        errors.push({
          shot: s.shot_no,
          code: 'TRANSITION_TOO_DENSE',
          detail: `距上一个非硬切 ${(t - lastNonHardAt).toFixed(1)}s < 8s`,
        });
      }
      if (!isHard) lastNonHardAt = t;

      // 规则 3：时序跳跃 > 1 天必须用叠化/黑场/白闪
      if ((s.time_jump_days ?? 0) > 1 && !TRANSITION_RULES.time_jump_over_1day.includes(trnCode)) {
        errors.push({ shot: s.shot_no, code: 'TIME_JUMP_TRANSITION_REQUIRED', transition: trnCode });
      }

      // 规则 4：回忆/闪回需白闪或亮度溶解
      if (s.is_flashback && !TRANSITION_RULES.flashback.includes(trnCode)) {
        warnings.push({ shot: s.shot_no, code: 'FLASHBACK_SUGGESTION', suggestion: TRANSITION_RULES.flashback });
      }

      // 规则 5：集末禁止硬切到黑屏
      if (s.is_episode_end && TRANSITION_RULES.episode_end_forbid.includes(trnCode)) {
        errors.push({ shot: s.shot_no, code: 'EPISODE_END_NEEDS_FREEZE_OR_FADE' });
      }

      // 规则 7：对白进行中禁止花哨转场
      if (s.dialogue && TRANSITION_RULES.forbid_during_dialogue.includes(trnCode)) {
        errors.push({ shot: s.shot_no, code: 'TRANSITION_FORBIDDEN_DURING_DIALOGUE', transition: trnCode });
      }

      const dur = s.duration ?? 5;
      out.push({
        index: i,
        shot_no: s.shot_no,
        clip_url: s.clip_url,
        start: +t.toFixed(2),
        end: +(t + dur).toFixed(2),
        duration: dur,
        transition: trnCode,
        transition_kind: card.kind,
        transition_ffmpeg: card.ffmpeg ?? null,
        transition_reason: s.transition_reason ?? null,
        is_episode_end: !!s.is_episode_end,
      });
      t += dur;
    }

    // 规则 2：非硬切占比
    const ratio = segments.length ? nonHardCount / segments.length : 0;
    if (ratio > maxRatio) {
      errors.push({
        code: 'NON_HARD_RATIO_EXCEEDED',
        ratio: +ratio.toFixed(3),
        max: maxRatio,
        director: directorProfile,
      });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      segments: out,
      total_sec: +t.toFixed(2),
      non_hard_ratio: +ratio.toFixed(3),
    };
  }

  /** 集末 3 秒强制规则检查（§9.6） */
  checkEnding(episode) {
    const need = ['悬念未解', '新威胁出现', '反转揭半', '情绪高点'];
    const ok = need.includes(episode?.ending_hook);
    return {
      ok,
      ending_hook: episode?.ending_hook ?? null,
      hint: ok ? null : `集末 3 秒必须是：${need.join(' / ')} 之一，否则完播率会崩`,
    };
  }
}

export const timeline = new Timeline();
export default timeline;
