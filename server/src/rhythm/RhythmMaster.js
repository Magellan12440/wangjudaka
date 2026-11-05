/**
 * 剧情节奏把控大师（§9）。位置 N04，剧本生成后强制过闸。
 *
 * 四项闸门：
 *  hook_score      第 1 集前 3 秒是否出现反常/危机/悬念/强情绪       ≥ 0.75
 *  conflict_density 每集冲突事件数                                   ≥ 2.5 个/集
 *  reversal_count   全剧 ≥ 3 次结构级反转，第 2 集必有 1 次          硬性
 *  empathy_peak     每 3 集至少 1 个共情高点                          ≥ 1/3集
 */
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';

const THRESHOLD = {
  hook_score: 0.75,
  conflict_per_episode: 2.5,
  reversal_total: 3,
  empathy_per_3_episodes: 1,
};

export class RhythmMaster {
  /**
   * @param {object} script 结构：
   * {
   *   episodes: [
   *     { no: 1, hook: { code:'HOOK-01', micro_hook: true },
   *       conflicts: [{ code:'CFL-02', escalation: 2, at_sec: 12 }],
   *       reversals: [{ code:'REV-01', foreshadow: 2 }],
   *       empathy: [{ code:'EMP-02' }],
   *       ending_hook: '悬念未解' }
   *   ]
   * }
   */
  diagnose(script) {
    const eps = script?.episodes ?? [];
    if (!eps.length) fail(ERR.BAD_REQUEST, '剧本为空，无法做节奏诊断');

    // 1) 黄金三秒
    const ep1 = eps[0];
    let hookScore = 0;
    if (ep1?.hook?.code && seeds.rhythm(ep1.hook.code)?.cat === 'hook') hookScore += 0.6;
    if (ep1?.hook?.micro_hook) hookScore += 0.2;
    if (ep1?.hook?.shots && ep1.hook.shots >= 2) hookScore += 0.2;
    hookScore = Math.min(1, hookScore);

    // 每集微钩子覆盖率（不只第 1 集）
    const microCovered = eps.filter((e) => e.hook?.micro_hook).length;
    const microCoverage = microCovered / eps.length;

    // 2) 冲突密度 + 升级检查
    let conflictTotal = 0;
    const conflictIssues = [];
    for (const e of eps) {
      const cs = e.conflicts ?? [];
      conflictTotal += cs.length;
      const distinct = new Set(cs.map((c) => c.code)).size;
      if (distinct < 2) conflictIssues.push({ ep: e.no, issue: '冲突类型少于 2 种' });
      // 升级：后一个冲突强度必须大于前一个
      for (let i = 1; i < cs.length; i++) {
        const a = seeds.rhythm(cs[i - 1].code)?.escalation ?? 1;
        const b = seeds.rhythm(cs[i].code)?.escalation ?? 1;
        if (b <= a) conflictIssues.push({ ep: e.no, issue: `第 ${i + 1} 个冲突未升级（${a}→${b}）` });
      }
    }
    const conflictDensity = conflictTotal / eps.length;

    // 3) 反转
    const reversals = eps.flatMap((e) => (e.reversals ?? []).map((r) => ({ ...r, ep: e.no })));
    const reversalTotal = reversals.length;
    // 单本剧（只有 1 集）没有「第 2 集」，这条闸门天然不可满足 —— 直接跳过，不能因此拦死用户
    const epCount = eps.length;
    const ep2Applicable = epCount >= 2;
    const ep2HasAnchor = ep2Applicable
      ? reversals.some((r) => r.ep === 2 && ['REV-01', 'REV-09'].includes(r.code))
      : true;
    // 单本剧把反转总数门槛降到 1（仍是结构级反转，只是不要求连载级密度）
    const reversalThreshold = epCount === 1 ? 1 : THRESHOLD.reversal_total;
    const thinForeshadow = reversals.filter((r) => (r.foreshadow ?? 0) < 2);

    // 4) 共情
    const empathyEps = eps.filter((e) => (e.empathy ?? []).length > 0).map((e) => e.no);
    const empathyRatio = empathyEps.length / eps.length;

    // 集末钩子
    const badEndings = eps.filter((e) => !e.ending_hook).map((e) => e.no);

    const gates = [
      { key: 'hook_score', value: +hookScore.toFixed(2), threshold: THRESHOLD.hook_score, pass: hookScore >= THRESHOLD.hook_score },
      { key: 'conflict_density', value: +conflictDensity.toFixed(2), threshold: THRESHOLD.conflict_per_episode, pass: conflictDensity >= THRESHOLD.conflict_per_episode },
      { key: 'reversal_total', value: reversalTotal, threshold: reversalThreshold, pass: reversalTotal >= reversalThreshold },
      { key: 'ep2_reversal_anchor', value: ep2HasAnchor ? 1 : 0, threshold: ep2Applicable ? 1 : 0, pass: ep2HasAnchor, applicable: ep2Applicable },
      { key: 'empathy_ratio', value: +empathyRatio.toFixed(2), threshold: 1 / 3, pass: empathyRatio >= 1 / 3 },
    ];

    const passed = gates.every((g) => g.pass);
    const report = {
      passed,
      gates,
      details: {
        micro_hook_coverage: +microCoverage.toFixed(2),
        conflict_issues: conflictIssues,
        thin_foreshadow: thinForeshadow.map((r) => ({ ep: r.ep, code: r.code })),
        empathy_episodes: empathyEps,
        missing_ending_hook: badEndings,
      },
      advice: passed ? [] : this.#advise({ hookScore, conflictDensity, reversalTotal, ep2HasAnchor, empathyRatio, eps }),
    };
    return report;
  }

  /** 不达标时的自动修订建议（喂回 N03 重写的指令） */
  #advise({ hookScore, conflictDensity, reversalTotal, ep2HasAnchor, empathyRatio, eps }) {
    const out = [];
    if (hookScore < THRESHOLD.hook_score) {
      const candidates = seeds.rhythmByCat('hook').slice(0, 3).map((h) => `${h.code} ${h.name}`);
      out.push({
        target: 'episode_1_opening',
        action: '重写第 1 集开场 3 个镜头',
        hint: `从黄金三秒模板中选型：${candidates.join(' / ')}`,
        severity: 'high',
      });
    }
    if (conflictDensity < THRESHOLD.conflict_per_episode) {
      const perEp = Math.ceil(THRESHOLD.conflict_per_episode);
      out.push({
        target: 'all_episodes',
        action: `每集补足到至少 ${perEp} 个不同编码的冲突，且强度递增`,
        hint: `可用冲突型：${seeds.rhythmByCat('conflict').map((c) => c.code).join(', ')}`,
        severity: 'high',
      });
    }
    if (reversalTotal < THRESHOLD.reversal_total) {
      out.push({
        target: 'structure',
        action: `补充到至少 ${THRESHOLD.reversal_total} 次结构级反转，每次反转前埋 ≥2 处伏笔`,
        hint: `可用反转型：${seeds.rhythmByCat('reversal').map((r) => r.code).join(', ')}`,
        severity: 'high',
      });
    }
    if (!ep2HasAnchor) {
      out.push({
        target: 'episode_2',
        action: '第 2 集必须插入 REV-01（身份反转）或 REV-09（力量反转）作为爽点锚定',
        severity: 'high',
      });
    }
    if (empathyRatio < 1 / 3) {
      const need = Math.ceil(eps.length / 3) - eps.filter((e) => (e.empathy ?? []).length).length;
      out.push({
        target: 'episodes',
        action: `再插入 ${need} 个共情高点（约每 3 集一个）`,
        hint: `可用共情型：${seeds.rhythmByCat('empathy').map((e2) => `${e2.code} ${e2.name}`).join(' / ')}`,
        severity: 'medium',
      });
    }
    return out;
  }

  /** 闸门：不达标直接抛错，交由流水线回退 N03 重写 */
  gate(script) {
    const r = this.diagnose(script);
    if (!r.passed) {
      const failed = r.gates.filter((g) => !g.pass).map((g) => g.key);
      const code = failed.includes('hook_score')
        ? ERR.RHYTHM_HOOK_TOO_WEAK
        : failed.includes('conflict_density')
          ? ERR.RHYTHM_CONFLICT_SPARSE
          : failed.includes('empathy_ratio')
            ? ERR.RHYTHM_EMPATHY_MISSING
            : ERR.RHYTHM_REVERSAL_MISSING;
      const e = new Error(`节奏闸门未通过：${failed.join(', ')}`);
      e.code = code;
      e.report = r;
      throw e;
    }
    return r;
  }

  /** 单集 90 秒节奏曲线（供分镜时长分配） */
  curve(totalSec = 90) {
    const segs = [
      { name: 'hook', ratio: 3 / 90 },
      { name: 'setup_first_conflict', ratio: 22 / 90 },
      { name: 'conflict_escalation', ratio: 25 / 90 },
      { name: 'reversal_or_empathy', ratio: 25 / 90 },
      { name: 'new_hook_ending', ratio: 15 / 90 },
    ];
    let t = 0;
    return segs.map((s) => {
      const dur = +(totalSec * s.ratio).toFixed(2);
      const seg = { ...s, start: +t.toFixed(2), end: +(t + dur).toFixed(2) };
      t += dur;
      return seg;
    });
  }
}

export const rhythmMaster = new RhythmMaster();
export default rhythmMaster;
