/**
 * 成片装配（V4.13）：把「分镜 → 版本 → 成片」的索引关系收紧成一条可校验的链。
 *
 * 解决的问题（用户实际碰到过的三种）：
 *  1. 剪辑按数组顺序取镜，分镜数组一旦被重排（重新选定剧本、重出某一镜），成片顺序就乱；
 *  2. 同一镜重出多次后，剪辑取「最新那条」，但用户已经选定过某一版，选定的那版被无视；
 *  3. 某一镜失败/漏出时，剪辑把空洞跳过去继续拼，成片少一段也没人知道。
 *
 * 所以这里只做三件事，且都只依赖结构（不猜、不模糊匹配）：
 *  - 定序：order = 集号 × 10000 + 集内镜序，唯一且可比较；
 *  - 定版：选定版本 > 最新未被弃用的版本；旧版本显式标记 superseded_by（不删除，可回退）；
 *  - 校验：漏镜 / 重复 / 断号 / 顺序冲突 / 选中了已弃用版本，全部如实报出来，
 *    交付前由 assertAssembly 硬拦（"少一段"是事故，不是可选建议）。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { nowIso } from '../core/util.js';

const PLANS = 'director_plans';
const GENS = 'generations';

/** 单集内镜序最大 9999：超出说明分镜号不是本系统生成的 */
const EP_FACTOR = 10000;

/** 从镜号解析 { episode, index }；解析不出来返回 null */
export function parseShotNo(shotNo) {
  const m = /^E(\d{1,3})[-_]S(\d{1,4})$/i.exec(String(shotNo ?? '').trim());
  if (!m) return null;
  return { episode: Number(m[1]), index: Number(m[2]) };
}

/** 从 beat_no（E01-B007）解析集内序号 */
export function parseBeatNo(beatNo) {
  const m = /^E(\d{1,3})[-_]B(\d{1,4})$/i.exec(String(beatNo ?? '').trim());
  if (!m) return null;
  return { episode: Number(m[1]), index: Number(m[2]) };
}

/**
 * 镜头的唯一排序键。
 * 优先用已落的 order；否则用 no 解析；都没有才退回 beat_no，最后按名字兜底。
 * 绝不返回 NaN —— 一条 NaN 会让整个 sort 结果不确定。
 */
export function shotOrder(shot) {
  if (Number.isFinite(Number(shot?.order))) return Number(shot.order);
  const byNo = parseShotNo(shot?.no ?? shot?.shot_no);
  if (byNo) return byNo.episode * EP_FACTOR + byNo.index;
  const byBeat = parseBeatNo(shot?.beat_no);
  if (byBeat) return byBeat.episode * EP_FACTOR + byBeat.index;
  return Number.MAX_SAFE_INTEGER;
}

export function episodeOf(shot) {
  const byNo = parseShotNo(shot?.no ?? shot?.shot_no);
  if (byNo) return byNo.episode;
  const n = Number(shot?.episode);
  return Number.isFinite(n) ? n : null;
}

/**
 * 给分镜补齐 order / episode / index。
 * 幂等：已经有正确值的不动；换了镜号（理论上不该发生，但不能假设）会跟着改。
 */
export function syncShotOrder(shots = []) {
  return (shots ?? []).map((s) => {
    const byNo = parseShotNo(s.no ?? s.shot_no);
    const byBeat = parseBeatNo(s.beat_no);
    const episode = byNo?.episode ?? (Number.isFinite(Number(s.episode)) ? Number(s.episode) : byBeat?.episode ?? null);
    const index = byNo?.index ?? byBeat?.index ?? (Number.isFinite(Number(s.index)) ? Number(s.index) : null);
    const order = episode != null && index != null
      ? episode * EP_FACTOR + index
      : (Number.isFinite(Number(s.order)) ? Number(s.order) : null);
    return { ...s, episode, index, order };
  });
}

export function sortShots(shots = []) {
  return [...shots].sort((a, b) => {
    const d = shotOrder(a) - shotOrder(b);
    if (d !== 0) return d;
    return String(a.no ?? a.shot_no ?? '').localeCompare(String(b.no ?? b.shot_no ?? ''));
  });
}

/** 一条生成记录是不是「当前有效」（没被新版本顶掉、成功、有地址） */
export function isActiveGeneration(g) {
  return Boolean(g) && !g.superseded_by && g.status === 'done' && Boolean(g.result_url || g.url);
}

export function urlOf(g) {
  return g ? (g.result_url || g.url || null) : null;
}

/**
 * 取某一镜的当前版本。
 * 优先级：用户选定 > 同 kind 最新有效版本 > 另一 kind 最新有效版本（视频没有时用静帧）。
 * @returns {{gen:object|null, source:'picked'|'latest'|'fallback'|'none', kind:string|null}}
 */
export function resolveShotVersion({ shot, gens = [], preferKind = null }) {
  const picked = shot?.picked ?? {};
  const order = [];
  if (preferKind) order.push(preferKind);
  for (const k of ['video', 'image']) if (!order.includes(k)) order.push(k);

  for (const kind of order) {
    const id = picked[`${kind}_generation_id`];
    if (!id) continue;
    const g = gens.find((x) => x.id === id);
    // 选中的版本被弃用了 → 不能静默换一条，必须报出来（用户选的和成片用的不一致是事故）
    if (g) return { gen: g, source: 'picked', kind, picked_superseded: Boolean(g.superseded_by), active: isActiveGeneration(g) };
  }

  const byKind = (kind) => gens
    .filter((g) => g.kind === kind && isActiveGeneration(g))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;

  for (const kind of order) {
    const g = byKind(kind);
    if (g) return { gen: g, source: 'latest', kind };
  }
  return { gen: null, source: 'none', kind: null };
}

/**
 * 装配审计：这一集到底能不能拼成一条完整的片子。
 * @param {object} p { projectId, episode, planRec }
 */
export function auditAssembly({ projectId, episode = null, planRec = null }) {
  const rec = planRec ?? db.findOne(PLANS, (x) => x.project_id === projectId);
  const all = rec?.storyboard?.shots ?? [];
  const ep = episode == null ? null : Number(episode);
  const inEp = ep ? all.filter((s) => episodeOf(s) === ep) : all;
  const ordered = sortShots(inEp);
  const gens = db.find(GENS, (g) => g.project_id === projectId);

  const clips = [];
  const missing = [];
  const duplicates = [];
  const gaps = [];
  const orderConflicts = [];
  const superseded = [];
  const seen = new Map();

  ordered.forEach((shot, i) => {
    const key = shot.no ?? shot.shot_no;
    const order = shotOrder(shot);
    if (seen.has(order)) {
      duplicates.push({
        order, shot_no: key, conflict_with: seen.get(order),
        text: `${key} 与 ${seen.get(order)} 的索引号相同（${order}）`,
      });
    } else {
      seen.set(order, key);
    }

    // 只取这一镜自己的版本：跨镜共享 generators 会让"最新一条"串到别人身上（S002 的片子出现在 S001）
    const shotGens = gens.filter((g) => g.shot_no === key);
    const v = resolveShotVersion({ shot, gens: shotGens });
    const imagePicked = shot.picked?.image_generation_id
      ? shotGens.find((g) => g.id === shot.picked.image_generation_id) ?? null
      : null;

    if (v.gen && v.gen.superseded_by) {
      superseded.push({
        shot_no: key, generation_id: v.gen.id, superseded_by: v.gen.superseded_by,
        text: `${key} 选中的版本 ${v.gen.id} 已被新版本顶掉，但仍是"正式版"`,
      });
    }

    const row = {
      index: i,
      order,
      episode: episodeOf(shot),
      shot_no: key,
      beat_no: shot.beat_no ?? null,
      shot_card: shot.shot_card ?? null,
      duration: Number(shot.duration ?? 0),
      transition: shot.transition ?? 'TRN-HARDCUT',
      spoken: Boolean(shot.dialogue),
      // 剧本引用：来源 beat + 台词 + 说话人（成片必须能追到剧本的哪一场）
      script_ref: shot.beat_no ? { beat_no: shot.beat_no, speaker: shot.speaker ?? null, line: shot.dialogue ?? null } : null,
      // 分镜图引用：即使成片用视频，也保留分镜静帧，方便回查"画面对不对"
      still_url: urlOf(imagePicked) ?? (v.gen?.kind === 'image' ? urlOf(v.gen) : null),
      clip: v.gen ? {
        generation_id: v.gen.id,
        kind: v.gen.kind,
        url: urlOf(v.gen),
        source: v.source,
        superseded: Boolean(v.gen.superseded_by),
      } : null,
    };
    clips.push(row);
    if (!v.gen) missing.push({ shot_no: key, order, text: `${key} 还没有可用的画面` });
  });

  // 断号：同一集内镜序必须 1..N 连续（少号 = 少了一场戏，不能默默跳过）
  const byEp = new Map();
  for (const c of clips) {
    if (c.episode == null) continue;
    if (!byEp.has(c.episode)) byEp.set(c.episode, []);
    byEp.get(c.episode).push(c.shot_no);
  }
  for (const [epNo, list] of byEp) {
    const nums = list.map((no) => parseShotNo(no)?.index).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i += 1) {
      if (nums[i] === nums[i - 1]) continue; // 重复已在 duplicates 里报
      if (nums[i] !== nums[i - 1] + 1) {
        gaps.push({
          episode: epNo, from: nums[i - 1], to: nums[i],
          text: `第 ${epNo} 集镜号断档：S${String(nums[i - 1]).padStart(3, '0')} 之后直接是 S${String(nums[i]).padStart(3, '0')}`,
        });
      }
    }
  }

  // 顺序冲突：分镜数组本身不是有序的（说明有人原地改过顺序而没重建 order）
  const rawOrders = inEp.map((s) => shotOrder(s));
  for (let i = 1; i < rawOrders.length; i += 1) {
    if (rawOrders[i] < rawOrders[i - 1]) {
      orderConflicts.push({
        at: i, prev: rawOrders[i - 1], got: rawOrders[i],
        text: `分镜数组第 ${i + 1} 条的顺序（${rawOrders[i]}）小于前一条（${rawOrders[i - 1]}）`,
      });
    }
  }

  const total = clips.length;
  const ready = clips.filter((c) => c.clip).length;
  const issues = [
    ...missing.map((m) => m.text),
    ...duplicates.map((d) => d.text),
    ...gaps.map((g) => g.text),
    ...superseded.map((s) => s.text),
  ];

  return {
    ok: issues.length === 0,
    project_id: projectId,
    episode: ep ?? (clips[0]?.episode ?? null),
    total,
    ready,
    coverage: total ? +(ready / total).toFixed(3) : 0,
    total_sec: +clips.reduce((a, c) => a + (c.duration || 0), 0).toFixed(2),
    clips,
    missing,
    duplicates,
    gaps,
    order_conflicts: orderConflicts,
    superseded_picks: superseded,
    issues,
    checked_at: nowIso(),
  };
}

/** 硬拦版：少一段 / 重一段 / 选了废弃版本 → 不许渲染 */
export function assertAssembly(ctx, { allowMissing = false } = {}) {
  const r = auditAssembly(ctx);
  const blocking = [
    ...(allowMissing ? [] : r.missing.map((m) => m.text)),
    ...r.duplicates.map((d) => d.text),
    ...r.superseded_picks.map((s) => s.text),
    ...r.order_conflicts.map((o) => o.text),
  ];
  if (blocking.length) {
    fail(ERR.ASSEMBLY_INCOMPLETE, `成片装配不完整：${blocking.slice(0, 4).join('；')}`, {
      episode: r.episode,
      missing: r.missing,
      duplicates: r.duplicates,
      superseded_picks: r.superseded_picks,
      order_conflicts: r.order_conflicts,
      coverage: r.coverage,
      hint: '把缺的镜头补齐、把重复镜号重建分镜、把被弃用版本重新选定，再渲染',
    });
  }
  return r;
}

/**
 * 版本顶替：同一镜同一类出新版本后，把旧的标成 superseded。
 * 不删除记录（用户仍可在历史里回退），只是让剪辑/分发不再默认取它。
 * @returns {{superseded:string[], kept:string[]}}
 */
export function supersedeOlder({ projectId, shotNo, kind, keepId }) {
  const rows = db.find(GENS, (g) => g.project_id === projectId
    && g.shot_no === shotNo && g.kind === kind
    && g.id !== keepId && !g.superseded_by && g.status === 'done');
  const superseded = [];
  for (const g of rows) {
    db.update(GENS, g.id, { superseded_by: keepId, superseded_at: nowIso() });
    superseded.push(g.id);
  }
  return { superseded, kept: [keepId] };
}

export const assembly = {
  parseShotNo, parseBeatNo, shotOrder, episodeOf, syncShotOrder, sortShots,
  isActiveGeneration, resolveShotVersion, auditAssembly, assertAssembly, supersedeOlder,
};

export default assembly;
