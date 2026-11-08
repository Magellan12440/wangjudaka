/**
 * 镜头语法体检（V4.17）。
 *
 * 为什么需要一层"语法"而不是只查一致性：
 *   一致性守卫（ConsistencyGuard）管的是「人和物有没有崩」——角色有没有卡、锁够不够、
 *   对白念不念得完。它管不到「这组镜头剪起来顺不顺」。两者都过、片子照样难看的情况很常见：
 *   连着四个中景、全靠硬切、每镜一样长 —— 每一镜都合规，连起来像 PPT。
 *
 * 本模块只做**判断与建议**，不做自动改写：改写会让导演总谱失去唯一事实的地位。
 * 判据来自公开的镜头语法（30° 法则 / 建立镜 / 快慢对比 / 覆盖度）与
 * 分镜时长统计基准，来源见 docs/导演引擎开源方案调研.md。
 *
 * 严重度：
 *   error —— 规格性错误（时长越界），必须改
 *   warn  —— 观感问题（重复、跳级、无呼吸），建议改
 *   info  —— 提示（可选优化）
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { DISTANCE_ORDER, MIN_SHOT_SEC, MAX_SHOT_SEC } from './ShotTiming.js';
import { round } from '../core/util.js';

const ESTABLISHING = new Set(['SHT-EWS', 'SHT-WS', 'SHT-FS', 'SHT-MLS']);
const CLOSE = new Set(['SHT-CU', 'SHT-ECU', 'SHT-EYE', 'SHT-MACRO']);
const STATIC_MOVE = 'SHT-STATIC';

function dimOf(code) {
  return seeds.shot(code)?.dim ?? null;
}

function distIndex(code) {
  const i = DISTANCE_ORDER.indexOf(code);
  return i < 0 ? null : i;
}

/** 把 shots 按集分组（shots 必须已按 order 升序） */
export function byEpisode(shots = []) {
  const map = new Map();
  for (const s of shots) {
    const ep = Number(s.episode) || 1;
    if (!map.has(ep)) map.set(ep, []);
    map.get(ep).push(s);
  }
  return map;
}

export class ShotGrammar {
  /**
   * 单集体检。
   * @param {Array} shots 同一集的镜头（按顺序）
   */
  auditEpisode(shots = [], { episode = null, directorCode = null } = {}) {
    const issues = [];
    const add = (severity, code, text, fix, shot = null) => issues.push({
      severity, code, episode: episode ?? (shot ? Number(shot.episode) : null),
      shot_no: shot?.no ?? null, text, fix,
    });
    if (!shots.length) return issues;

    // 1. 时长越界（硬规格）
    for (const s of shots) {
      const d = Number(s.duration) || 0;
      if (d > MAX_SHOT_SEC + 0.01) {
        add('error', 'DURATION_OVER', `第 ${s.no} 镜 ${d}s，超过视频模型单次生成上限 ${MAX_SHOT_SEC}s`, '拆成两镜，或改成镜头内推拉', s);
      } else if (d < MIN_SHOT_SEC - 0.01) {
        add('error', 'DURATION_UNDER', `第 ${s.no} 镜 ${d}s，低于 ${MIN_SHOT_SEC}s 会看成闪帧`, '并到相邻镜，或延长到 1s 以上', s);
      }
    }

    // 2. 同一张卡连续用（画面像卡住）
    let runCard = 1;
    for (let i = 1; i < shots.length; i += 1) {
      runCard = shots[i].shot_card === shots[i - 1].shot_card ? runCard + 1 : 1;
      if (runCard === 3) {
        add('warn', 'REPEAT_CARD', `第 ${shots[i].no} 镜起连续 3 镜都是「${seeds.shot(shots[i].shot_card)?.name ?? shots[i].shot_card}」`, '换一个同叙事的景别/角度，避免看起来像静止画面', shots[i]);
      }
    }

    // 3. 同一种运镜连续用（机械感）
    let runMove = 1;
    for (let i = 1; i < shots.length; i += 1) {
      const same = shots[i].camera_move && shots[i].camera_move === shots[i - 1].camera_move;
      runMove = same ? runMove + 1 : 1;
      if (runMove === 3 && shots[i].camera_move !== STATIC_MOVE) {
        add('warn', 'REPEAT_MOVE', `连续 3 镜都是「${seeds.shot(shots[i].camera_move)?.name ?? shots[i].camera_move}」`, '中间插一镜固定或反向运镜，动势才有层次', shots[i]);
      }
    }

    // 4. 景别覆盖不足 + 跳级
    const dists = shots.map((s) => (dimOf(s.shot_card) === 'distance' ? s.shot_card : null));
    let runDist = 1;
    for (let i = 1; i < dists.length; i += 1) {
      if (!dists[i] || dists[i] !== dists[i - 1]) { runDist = 1; continue; }
      runDist += 1;
      if (runDist === 4) {
        add('warn', 'DISTANCE_STUCK', `连续 4 镜同一景别（${seeds.shot(dists[i])?.name}）`, '按"远交代 → 中推进 → 近给情绪"走一遍覆盖', shots[i]);
      }
    }
    for (let i = 1; i < shots.length; i += 1) {
      const a = distIndex(dists[i - 1]);
      const b = distIndex(dists[i]);
      if (a == null || b == null) continue;
      const jump = Math.abs(a - b);
      const hard = (shots[i].transition ?? 'TRN-HARDCUT') === 'TRN-HARDCUT';
      if (jump >= 4 && hard) {
        add('warn', 'JUMP_CUT', `第 ${shots[i].no} 镜从「${seeds.shot(dists[i - 1])?.name}」直接硬切到「${seeds.shot(dists[i])?.name}」`,
          '中间补一镜过渡景别，或改用叠化/推镜过渡', shots[i]);
      }
    }

    // 5. 空间没交代就开打
    const head = shots.slice(0, 3);
    if (head.length >= 2 && !head.some((s) => ESTABLISHING.has(s.shot_card))) {
      add('warn', 'NO_ESTABLISH', '本集前 3 镜没有交代空间（远景/全景）', '开场第一镜先给环境，观众才知道人在哪', head[0]);
    }

    // 6. 快切之后没有呼吸
    const fastRun = 4;
    const longSec = 4.5;
    for (let i = 0; i + fastRun <= shots.length; i += 1) {
      const seg = shots.slice(i, i + fastRun);
      if (!seg.every((s) => Number(s.duration) <= 2.5)) continue;
      const after = shots.slice(i + fastRun, i + fastRun + 5);
      if (after.length && !after.some((s) => Number(s.duration) >= longSec)) {
        add('warn', 'NO_BREATH', `连续 ${fastRun} 个快切（≤2.5s）之后没有一镜 ≥${longSec}s`,
          '快之后必须给慢，不然观众没有喘息，后面的爆点也不显爆', seg[seg.length - 1]);
        break;
      }
    }

    // 7. 整集节奏扁平（本次重点修的病）
    const secs = shots.map((s) => Number(s.duration) || 0);
    const max = Math.max(...secs);
    const min = Math.min(...secs);
    if (secs.length >= 6 && min > 0 && max / min < 1.5) {
      add('warn', 'NO_CONTRAST', `整集最快 ${round(min)}s、最慢 ${round(max)}s，快慢对比不足 1.5 倍`,
        '让推进段压到 2-3s、情绪段放到 5-7s，节奏才有起伏');
    }

    // 8. 特写滥用
    const closeN = shots.filter((s) => CLOSE.has(s.shot_card)).length;
    if (shots.length >= 6 && closeN / shots.length > 0.5) {
      add('warn', 'CLOSEUP_OVERLOAD', `特写类占 ${Math.round((closeN / shots.length) * 100)}%（${closeN}/${shots.length}）`,
        '特写是重音不是底色，超过一半会让观众失去空间感');
    }

    // 9. 集末定格（钩子落地的方式）
    const last = shots[shots.length - 1];
    if (last && last.is_episode_end && last.transition !== 'TRN-FREEZE') {
      add('info', 'END_NO_FREEZE', `集末镜用的是「${seeds.transition(last.transition)?.name ?? last.transition}」`,
        '集末建议定格留钩，下一集接得上', last);
    }

    // 10. 全集一个转场（intense 导演除外）
    const nonHard = shots.filter((s) => s.transition && s.transition !== 'TRN-HARDCUT' && s.transition !== 'TRN-FREEZE').length;
    if (shots.length >= 8 && nonHard === 0 && directorCode !== 'DIR-INTENSE') {
      add('info', 'TRANSITION_DROUGHT', '全 8 镜以上全是硬切，段落之间没有过渡',
        '段落切换处给一次叠化/推镜，观众才知道时间跳了');
    }

    return issues;
  }

  /** 整片体检 */
  audit({ shots = [], directorCode = null } = {}) {
    const groups = byEpisode(shots);
    const issues = [];
    for (const [ep, list] of groups) {
      issues.push(...this.auditEpisode(list, { episode: ep, directorCode }));
    }
    const count = (sev) => issues.filter((i) => i.severity === sev).length;
    const error = count('error');
    const warn = count('warn');
    const info = count('info');
    const score = Math.max(0, Math.min(100, 100 - error * 20 - warn * 6 - info * 1));
    return {
      ok: error === 0,
      score,
      grade: score >= 90 ? 'A' : score >= 78 ? 'B' : score >= 60 ? 'C' : 'D',
      episodes: groups.size,
      shots: shots.length,
      counts: { error, warn, info },
      issues,
      // 给前端一句话结论，别让人自己数
      summary: issues.length
        ? `${issues.length} 条语法提示（${error} 必改 / ${warn} 建议 / ${info} 可选）`
        : '镜头语法无问题：覆盖、节奏、转场都立得住',
    };
  }

  /**
   * 从项目实际分镜里取镜头。
   * 说明：体检读的是「已经排好的分镜」，不是总谱草稿——分镜是用户真正会看到的那一版。
   */
  auditProject(projectId, { planRecord = null } = {}) {
    const rec = planRecord ?? db.findOne('director_plans', (x) => x.project_id === projectId);
    const shots = rec?.storyboard?.shots ?? rec?.shots ?? [];
    const directorCode = rec?.plan?.director_code ?? null;
    return { ...this.audit({ shots, directorCode }), plan_id: rec?.plan_id ?? null };
  }
}

export const shotGrammar = new ShotGrammar();
export default shotGrammar;
