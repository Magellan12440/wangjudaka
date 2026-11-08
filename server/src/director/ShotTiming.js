/**
 * 镜头时长模型（V4.17）。
 *
 * 改它的原因很具体：V4.16 之前，一集里每一镜的时长都等于 `集时长 / 镜数`，
 * 也就是**整集所有镜头一样长**。这在结构上就否掉了节奏本身 ——
 * 快切段落和情绪留白镜分到同样的 4.2 秒，观众感受不到"快慢对比"，
 * 节奏库算得再准也落不了地。
 *
 * 本模型的判据来自公开方法论（见 docs/导演引擎开源方案调研.md）：
 *   - 时长由「叙事目的」决定优先级：推进/升级最快、转折/升华最慢
 *   - 再被「景别」收窄：特写 2-4s、全景 3-6s、远景 4-8s（用镜头卡自带的 len_hint）
 *   - 再按「张力」微调：张力越高越短（动作段加速），张力低且是情绪镜则给呼吸
 *   - 单镜硬上下限：视频模型单次生成上限 10s，低于 1s 观感是闪帧
 *   - 最后整体归一：全片总和必须等于用户选的单集时长（结构性承诺，不能漂）
 *
 * 所有随机都走独立随机流（由 plan_id 派生），不污染总谱其它选择，
 * 保证"同样的输入 → 同样的总谱"。
 */
import seeds from '../seeds/loader.js';
import { seedFrom, clamp, round } from '../core/util.js';

/**
 * 叙事目的 → 时长区间（秒）。
 * 说明：区间是"基准带"，不是硬边界；硬边界由镜头卡的 len_hint 与 1~10s 决定。
 */
export const NARRATIVE_FUNCTIONS = {
  hook: { label: '开场钩子', range: [2, 3.5], why: '前三秒决定划不划走，必须快而炸' },
  establish: { label: '交代/建立', range: [3.5, 5], why: '先让观众看清空间与关系，信息要读得完' },
  advance: { label: '推进/升级', range: [2.5, 3.5], why: '事件在加速，镜头也要加速' },
  present: { label: '展现/呈现', range: [4, 5], why: '标准叙事镜，给足读取时间' },
  mood: { label: '情绪/氛围', range: [4, 5.5], why: '氛围需要呼吸，不能一剪就走' },
  turn: { label: '转折/翻转', range: [5, 7], why: '翻转的重量要落地，太快会像没发生' },
  empathy: { label: '共情/沉淀', range: [5, 8], why: '观众需要时间站到角色那一边' },
  echo: { label: '呼应/闭环', range: [4, 5], why: '要让观众认出这是前面的伏笔' },
  endHook: { label: '集末钩子', range: [3, 4], why: '留一个未解的问题，但不能拖' },
};

/** 硬边界：视频模型单次生成 ≤10s；<1s 会被看成闪帧 */
export const MIN_SHOT_SEC = 1;
export const MAX_SHOT_SEC = 10;

/** 景别由远到近的顺序，用于判断"景别跳级" */
export const DISTANCE_ORDER = [
  'SHT-EWS', 'SHT-BIRD', 'SHT-TOP', 'SHT-WS', 'SHT-FS', 'SHT-MLS', 'SHT-MS',
  'SHT-MCU', 'SHT-CU', 'SHT-ECU', 'SHT-EYE', 'SHT-SHOE', 'SHT-MACRO',
];

/**
 * 叙事目的判定：把总谱里的「节奏位」翻译成九列分镜表里的「叙事目的」。
 *
 * 为什么要单独一层：节奏库的 purpose 是"结构位置"（黄金三秒/反转落点），
 * 分镜表要的是"这一镜在全片里干什么"（交代/推进/转折/升华）。
 * 两者不是一回事，混用会出现"集末钩子"被当成"升华"给到 10 秒。
 */
export function functionOf({ purpose = '推进', index = 1, per = 1, tension = 3 } = {}) {
  const p = String(purpose);
  if (p.includes('黄金三秒')) return 'hook';
  if (p.includes('集末钩子')) return 'endHook';
  if (p.includes('反转')) return 'turn';
  if (p.includes('共情')) return 'empathy';
  if (p.includes('冲突升级')) return 'advance';
  if (p.includes('呼应')) return 'echo';
  if (p.includes('建立') || p.includes('交代')) return 'establish';
  // 常规推进拍：第 2 镜先交代空间（除非一集只有两三镜），其余按张力分推进/展现
  if (index === 2 && per >= 5) return 'establish';
  return tension >= 4 ? 'advance' : 'present';
}

function lenHintOf(shotCard) {
  const card = seeds.shot(shotCard);
  const h = card?.len_hint;
  if (!Array.isArray(h) || h.length < 2) return [MIN_SHOT_SEC, MAX_SHOT_SEC];
  return [Number(h[0]) || MIN_SHOT_SEC, Number(h[1]) || MAX_SHOT_SEC];
}

/** 区间求交，交不上就以叙事目的为准（景别让位于叙事功能） */
function intersect(a, b, hard = [MIN_SHOT_SEC, MAX_SHOT_SEC]) {
  const lo = Math.max(a[0], b[0], hard[0]);
  const hi = Math.min(a[1], b[1], hard[1]);
  if (hi < lo) {
    const mid = clamp((a[0] + a[1]) / 2, hard[0], hard[1]);
    return [Math.max(hard[0], mid - 0.5), Math.min(hard[1], mid + 0.5)];
  }
  return [lo, hi];
}

/** 独立随机流：只服务时长，不影响总谱其它随机选择 */
function makeRnd(seedStr) {
  let a = seedFrom(seedStr) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 分配一集的镜头时长。
 *
 * @param {object} p
 * @param {Array} p.beats   每个 beat 至少要有 beat_no / beat_purpose / shot_card / tension
 * @param {number} p.epSec  本集目标时长（秒）
 * @param {string} p.seed   随机流种子（用 plan_id + 集号）
 * @returns {{ items: Array, stats: object }}
 */
export function allocate({ beats = [], epSec = 90, seed = 'plan' } = {}) {
  if (!beats.length) return { items: [], stats: { total: 0, avg: 0 } };
  const rnd = makeRnd(`${seed}|timing`);
  const hard = [MIN_SHOT_SEC, MAX_SHOT_SEC];

  // —— 区间体检：先算每条拍的可用区间，再检查"总容量"能不能装下这一集 ——
  const ranged = beats.map((b, i) => {
    const fn = functionOf({ purpose: b.beat_purpose, index: i + 1, per: beats.length, tension: b.tension });
    const meta = NARRATIVE_FUNCTIONS[fn] ?? NARRATIVE_FUNCTIONS.present;
    const card = lenHintOf(b.shot_card);
    const [lo, hi] = intersect(meta.range, card, [MIN_SHOT_SEC, MAX_SHOT_SEC]);
    return { beat_no: b.beat_no, fn, meta, card, lo, hi, tension: Number(b.tension) || 3 };
  });

  // 上限装不下（镜数少、集时长长）：放开到 10s，按比例摊，而不是让整集短 40%
  const capHi = ranged.reduce((a, d) => a + d.hi, 0);
  const relaxHigh = capHi < epSec;
  // 下限就超了（镜数多、集时长短）：允许压到 1s。否则永远减不下去，整集会多出几十秒
  const capLo = ranged.reduce((a, d) => a + d.lo, 0);
  const relaxLow = capLo > epSec;

  for (const d of ranged) {
    if (relaxHigh) d.hi = MAX_SHOT_SEC;
    if (relaxLow) {
      const factor = epSec / Math.max(0.1, capLo);
      d.lo = Math.max(MIN_SHOT_SEC, round(d.lo * factor));
      d.hi = Math.max(d.lo, d.hi);
    }
  }

  const drafts = ranged.map((d) => {
    const mid = (d.lo + d.hi) / 2;
    // 张力修正：越紧越快（×0.85），情绪/共情且张力低则给呼吸（×1.1）
    let factor = 1;
    if (d.tension >= 4.2) factor *= 0.85;
    if (d.tension <= 2.6 && (d.fn === 'mood' || d.fn === 'empathy' || d.fn === 'establish')) factor *= 1.1;
    // ±8% 抖动：避免整集出现"一串一模一样的 3.4 秒"
    const jitter = 0.92 + rnd() * 0.16;
    const want = clamp(mid * factor * jitter, d.lo, d.hi);
    return {
      beat_no: d.beat_no, fn: d.fn, fnLabel: d.meta.label, why: d.meta.why,
      lo: d.lo, hi: d.hi, want,
    };
  });

  // —— 归一：总和必须等于 epSec，且每镜都得在自己区间内 ——
  const total = epSec;
  let sum = drafts.reduce((a, d) => a + d.want, 0) || 1;
  const scaled = drafts.map((d) => ({ ...d, sec: clamp(round((d.want / sum) * total), d.lo, d.hi) }));

  /**
   * 把差额按"还剩多少余量"分配。
   * 为什么要多轮：把某一镜顶到上限后，它就不再吸收差额，剩下的要重新摊给还有余量的镜头。
   * 旧实现只做一轮比例缩放 + 一次余数吸收，遇到大量镜头被钉在 lo/hi 时会整集多出几秒。
   */
  for (let pass = 0; pass < 24; pass += 1) {
    const diff = round(total - scaled.reduce((a, d) => a + d.sec, 0));
    if (Math.abs(diff) < 0.01) break;
    const pool = diff > 0
      ? scaled.filter((d) => d.sec < d.hi - 0.001)
      : scaled.filter((d) => d.sec > d.lo + 0.001);
    if (!pool.length) break;
    if (diff > 0) {
      const slack = pool.reduce((a, d) => a + (d.hi - d.sec), 0) || 1;
      for (const d of pool) d.sec = round(clamp(d.sec + (diff * (d.hi - d.sec)) / slack, d.lo, d.hi));
    } else {
      const slack = pool.reduce((a, d) => a + (d.sec - d.lo), 0) || 1;
      for (const d of pool) d.sec = round(clamp(d.sec + (diff * (d.sec - d.lo)) / slack, d.lo, d.hi));
    }
  }

  // 最后一分钱：还差不到 0.01 才允许微调一个有那么一点余量的镜头
  let diff = round(total - scaled.reduce((a, d) => a + d.sec, 0));
  if (Math.abs(diff) >= 0.01) {
    const host = diff > 0
      ? [...scaled].sort((a, b) => (b.hi - b.sec) - (a.hi - a.sec))[0]
      : [...scaled].sort((a, b) => (b.sec - b.lo) - (a.sec - a.lo))[0];
    host.sec = round(clamp(host.sec + diff, host.lo, host.hi));
  }

  const items = scaled.map((d) => ({
    beat_no: d.beat_no,
    duration_sec: d.sec,
    narrative_function: d.fn,
    narrative_label: d.fnLabel,
    narrative_why: d.why,
    timing: { range: [d.lo, d.hi], want: round(d.want) },
  }));

  const secs = items.map((i) => i.duration_sec);
  const fast = secs.filter((s) => s <= 2.5).length;
  return {
    items,
    stats: {
      shots: items.length,
      total: round(secs.reduce((a, b) => a + b, 0)),
      avg: round(secs.reduce((a, b) => a + b, 0) / secs.length),
      min: Math.min(...secs),
      max: Math.max(...secs),
      fast_ratio: round(fast / secs.length),
      // 快慢对比指标：最长/最短。1.0 说明整集一个节奏（正是我们要修的病）
      contrast: round(Math.max(...secs) / Math.max(0.1, Math.min(...secs))),
    },
  };
}

/** 一句话「叙事目的」（写进分镜表第 9 列，也给剧本阶段当约束） */
export function intentOf({ beat, seconds }) {
  const fn = NARRATIVE_FUNCTIONS[beat.narrative_function] ?? NARRATIVE_FUNCTIONS.present;
  const shot = seeds.shot(beat.shot_card);
  const move = seeds.shot(beat.camera_move);
  const bits = [];
  if (shot?.name) bits.push(shot.name);
  if (move?.name && move.dim === 'movement') bits.push(move.name);
  return `${fn.label}：用${bits.join('+') || '镜头'}在 ${seconds} 秒内${fn.why}`;
}
