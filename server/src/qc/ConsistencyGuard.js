/**
 * 五维一致性守护（V4.11）—— 底层强制规则，不是"生成后再看看"。
 *
 * 为什么要独立于 ConsistencyChecker：
 *   ConsistencyChecker 管的是「图与图像不像」（CLIP/人脸相似度，需要 provider，可以 degraded）；
 *   这里管的是「结构上有没有资格生成」—— 角色有没有卡、道具是不是同一件、场景是不是同一处、
 *   这一镜的情绪/转场/节奏是不是总谱定的、说话人有没有固定声线、字幕放不放得下。
 *   这些不依赖任何外部服务，纯结构化判定，所以可以做成**硬闸门**：不满足就不许出图，
 *   不消耗用户点数，也不会产出"看起来正常但一改就崩"的片子。
 *
 * 五个维度（缺一不可）：
 *   character      角色一致性：有资产卡、锁不少于模板下限、有视觉依据
 *   prop           道具一致性：镜头里点名的道具必须是已建卡的那一件，且带锁
 *   scene          场景一致性：同一集的空间引用同一张场景卡，且带空间/光源锁
 *   content        内容一致性：镜别/运镜/光影/转场/情绪/节奏来自总谱，对白与说话人自洽
 *   audio_subtitle 声音字幕一致性：说话人有固定声线（voice 资产），字幕按同步规则放得下
 *
 * 三处入口：
 *   guardCompile(req)            编译器内（纯函数，不读库）→ 12 条校验的补充
 *   assertBeforeGenerate({...})  镜头生成前（读项目资产/总谱）→ 硬拦
 *   audit(projectId)             全片体检（交付闸门与前端面板）→ 出报告，不抛错
 */
import { db } from '../store/db.js';
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, speechUnits } from '../core/util.js';
import directorAgent from '../director/DirectorAgent.js';

export const DIMENSIONS = [
  { key: 'character', name: '角色一致性', what: '同一张脸：资产卡 + 连续性锁 + 视觉依据' },
  { key: 'prop', name: '道具一致性', what: '同一件东西：外形/材质/印记锁不得丢' },
  { key: 'scene', name: '场景一致性', what: '同一处景：空间结构、陈设位置、光源方向' },
  { key: 'content', name: '内容一致性', what: '镜别/运镜/光影/转场/情绪/节奏必须来自总谱' },
  { key: 'audio_subtitle', name: '声音字幕一致性', what: '固定声线 + 字幕放得下，不跳字不糊屏' },
];

const PROJECT = 'projects';
const ASSETS = 'assets';
const PLANS = 'director_plans';
const GENS = 'generations';
const GUARD = 'consistency_guard';

const FIELDS_LOCKED_BY_PLAN = ['shot_card', 'camera_move', 'lighting_codes', 'transition', 'rhythm'];

function dims() {
  const out = {};
  for (const d of DIMENSIONS) out[d.key] = { ok: true, issues: [], warnings: [] };
  return out;
}

function issue(dim, text, extra = {}) {
  dim.ok = false;
  dim.issues.push({ text, ...extra });
}

function warn(dim, text) {
  dim.warnings.push(text);
}

/** 资产是否带够锁（按模板下限；模板缺失时退到最小值 1） */
function lockShortfall(asset, assetType) {
  const tpl = seeds.lockTemplate(assetType ?? asset?.asset_type);
  const need = tpl?.required_lock_count ?? 1;
  const got = (asset?.locks ?? []).filter(Boolean).length;
  return { need, got, short: got < need };
}

// ————————————————————————————————————————————————
// 1) 编译器内：纯结构校验（不读 db，保证单测可复现）
// ————————————————————————————————————————————————

/**
 * @param {object} req PromptCompiler 的输入契约（shot / assets / lighting / transition / libraries）
 * @returns {object} { ok, dims, hard: [] }
 */
export function guardCompile(req = {}) {
  const d = dims();
  const shot = req.shot ?? {};
  const assets = req.assets ?? {};
  const offscreen = new Set(shot.offscreen ?? []);

  // —— 角色 ——
  for (const code of shot.characters ?? []) {
    if (offscreen.has(code)) continue;
    const a = assets.characters?.[code];
    if (!a) {
      issue(d.character, `角色 ${code} 没有资产卡`, { code });
      continue;
    }
    const { need, got, short } = lockShortfall(a, 'character');
    if (short) issue(d.character, `角色 ${code} 连续性锁不足（${got}/${need}）`, { code, need, got });
  }

  // —— 道具 ——
  for (const code of shot.props ?? []) {
    const a = assets.props?.[code];
    if (!a) {
      issue(d.prop, `道具 ${code} 没有设定卡（会被每镜重新设计）`, { code });
      continue;
    }
    const { need, got, short } = lockShortfall(a, 'prop');
    if (short) issue(d.prop, `道具 ${code} 一致性锁不足（${got}/${need}）`, { code, need, got });
  }

  // —— 场景 ——
  if (shot.scene) {
    const a = assets.scenes?.[shot.scene];
    if (!a) {
      issue(d.scene, `场景 ${shot.scene} 没有场景卡`, { code: shot.scene });
    } else {
      const { need, got, short } = lockShortfall(a, 'scene');
      if (short) issue(d.scene, `场景 ${shot.scene} 一致性锁不足（${got}/${need}）`, { code: shot.scene, need, got });
    }
  }

  // —— 内容 ——
  if (shot.shot_card && !seeds.shot(shot.shot_card)) {
    issue(d.content, `镜别卡不存在：${shot.shot_card}`);
  }
  if (shot.camera_move && seeds.shot(shot.camera_move)?.dim !== 'movement') {
    issue(d.content, `运镜卡不存在或维度不对：${shot.camera_move}`);
  }
  for (const [ch, code] of Object.entries(shot.emotions ?? {})) {
    if (!code) continue;
    if (!seeds.emotion(code)) issue(d.content, `角色 ${ch} 的情绪卡不存在：${code}`);
  }
  if (shot.dialogue && !shot.speaker) {
    issue(d.content, '有对白但没有指定说话人，声音会对不上嘴');
  }

  // —— 声音字幕 ——
  const sync = syncRuleOf(req.libraries?.sync ?? null);
  if (shot.dialogue && sync) {
    const cap = (sync.max_chars_per_line ?? 16) * (sync.max_lines ?? 1);
    const len = String(shot.dialogue).replace(/\s/g, '').length;
    if (len > cap) {
      issue(d.audio_subtitle, `对白 ${len} 字，按「${sync.name}」字幕最多放 ${cap} 字（会拆屏或糊字）`, {
        rule: sync.code, len, cap,
        hint: '精简对白，或在导演面板把字幕规则换成更宽的档位',
      });
    }
    if (shot.duration && speechUnits(String(shot.dialogue)) > shot.duration * 4.1) {
      issue(d.audio_subtitle, `对白念不完：${speechUnits(String(shot.dialogue)).toFixed(1)} 字/秒位，镜长只有 ${shot.duration}s`);
    }
  }
  if (shot.voice && !seeds.lockTemplate('voice')) {
    warn(d.audio_subtitle, '声线锁模板缺失，无法校验音色一致性');
  }

  const hard = [];
  for (const dim of Object.values(d)) hard.push(...dim.issues.map((x) => x.text));
  return { ok: hard.length === 0, dims: d, hard };
}

/** 字幕同步规则：优先用户 pin，其次导演默认，最后库第一项 */
export function syncRuleOf(code = null) {
  if (code && seeds.subtitleSyncRule(code)) return seeds.subtitleSyncRule(code);
  return seeds.subtitleSyncRule('SYN-STD') ?? (seeds.subtitleSync?.[0] ?? null);
}

// ————————————————————————————————————————————————
// 2) 镜头生成前（读项目）—— 硬拦
// ————————————————————————————————————————————————

export class ConsistencyGuard {
  /** 取项目当前资产索引（按类型分桶，code → asset） */
  assetIndex(projectId) {
    const rows = db.find(ASSETS, (a) => a.project_id === projectId);
    const out = { character: {}, scene: {}, prop: {}, voice: {}, emotion: {}, all: rows };
    for (const a of rows) {
      const bucket = out[a.asset_type];
      if (bucket) bucket[a.asset_code] = a;
    }
    return out;
  }

  /**
   * 资产卡补齐（V4.11）：镜头引用的角色/场景/道具若没有卡，按模板补一张。
   *
   * 为什么自动补而不是报错：补出来的是一张**带连续性锁的空卡**，出图前还必须有图，
   * 一致性一点没放松；但如果直接报错，用户会卡在"分镜里有这个场景、资产库里没有"
   * 这种前后不同步的死角里，来回找不到该点哪里。
   */
  ensureAssetCards(projectId, shot) {
    const tplOf = (t) => seeds.lockTemplate(t);
    const existing = this.assetIndex(projectId);
    const created = [];
    const mk = (type, code, name, lockValues, meta) => {
      const tpl = tplOf(type);
      if (!tpl) return;
      try {
        const row = db.insert(ASSETS, {
          id: newId('asset'),
          project_id: projectId,
          asset_type: type,
          asset_code: code,
          name,
          version: 1,
          locks: tpl.suggested_locks ?? [],
          lock_values: lockValues,
          image_url: null,
          negative: tpl.negative_defaults ?? [],
          meta,
          status: 'pending',
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        existing[type][code] = row;
        created.push({ type, code, name });
      } catch {
        // 并发/命名冲突时跳过：guard 随后会如实报"没有资产卡"，不会静默放行
      }
    };

    for (const code of shot.characters ?? []) {
      if (!existing.character[code]) mk('character', code, code, { name: code }, { auto_created: true });
    }
    if (shot.scene && !existing.scene[shot.scene]) {
      mk('scene', shot.scene, `场景 ${shot.scene}`, { name: shot.scene }, { auto_created: true });
    }
    for (const code of shot.props ?? []) {
      if (!existing.prop[code]) mk('prop', code, code, { name: code }, { auto_created: true });
    }
    return { created, count: created.length };
  }

  /**
   * 声音一致性：每个有对白/在画的角色都该有一份固定声线。
   * 缺了就**自动补建** —— 这是强制规则：宁可给一份默认声线，也不让同一角色每集换嗓子。
   * @returns { created: [], voices: { CH01: assetCode } }
   */
  ensureVoiceAssets(projectId) {
    const chars = db.find(ASSETS, (a) => a.project_id === projectId && a.asset_type === 'character');
    const voices = db.find(ASSETS, (a) => a.project_id === projectId && a.asset_type === 'voice');
    const byChar = new Map(voices.map((v) => [v.meta?.character_code, v]));
    const tpl = seeds.lockTemplate('voice');
    const created = [];
    let seq = voices.length;
    for (const c of chars) {
      if (byChar.has(c.asset_code)) continue;
      seq += 1;
      try {
        const row = db.insert(ASSETS, {
          id: newId('asset'),
          project_id: projectId,
          asset_type: 'voice',
          asset_code: `VO${String(seq).padStart(2, '0')}`,
          name: `${c.name ?? c.asset_code} 的声线`,
          version: 1,
          locks: tpl?.suggested_locks ?? ['音色与音高一致', '语速与口音一致', '基准情绪一致'],
          lock_values: {
            name: c.name ?? c.asset_code,
            timbre: c.lock_values?.traits ?? '',
            pace: '中速',
            base_emotion: '平静',
          },
          image_url: null,
          negative: [],
          meta: { character_code: c.asset_code, role: c.meta?.role ?? '', auto_created: true },
          status: 'ready',
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        created.push({ character_code: c.asset_code, voice_code: row.asset_code });
        byChar.set(c.asset_code, row);
      } catch {
        // 声线补建失败不阻断出图：会在 audit 里如实标出来
      }
    }
    return { created, voices: Object.fromEntries([...byChar].map(([k, v]) => [k, v.asset_code])) };
  }

  /**
   * 单镜五维体检（不抛错）。
   * @param {object} p { projectId, shot, planRecord, assets, requireImage, syncCode }
   */
  auditShot({ projectId, shot, planRecord = null, assets = null, requireImage = false, syncCode = null }) {
    const idx = assets ?? this.assetIndex(projectId);
    const d = dims();
    const overridden = new Set(shot.manual_override?.fields ?? []);
    const offscreen = new Set(shot.offscreen ?? []);

    // —— 角色 ——
    for (const code of shot.characters ?? []) {
      if (offscreen.has(code)) continue;
      const a = idx.character[code];
      if (!a) {
        issue(d.character, `角色 ${code} 没有资产卡`);
        continue;
      }
      const { need, got, short } = lockShortfall(a, 'character');
      if (short) issue(d.character, `角色 ${code} 连续性锁不足（${got}/${need}）`);
      if (requireImage && !a.image_url) {
        issue(d.character, `角色 ${code} 还没有设定图，分镜没有视觉依据`, { hint: '先去「角色场景」出图' });
      }
      const voice = Object.values(idx.voice).find((v) => v.meta?.character_code === code);
      if (!voice) warn(d.audio_subtitle, `角色 ${code} 还没有声线资产（生成时会自动补一份）`);
    }

    // —— 道具 ——
    for (const code of shot.props ?? []) {
      const a = idx.prop[code];
      if (!a) {
        issue(d.prop, `道具 ${code} 没有设定卡`);
        continue;
      }
      const { need, got, short } = lockShortfall(a, 'prop');
      if (short) issue(d.prop, `道具 ${code} 一致性锁不足（${got}/${need}）`);
    }

    // —— 场景 ——
    if (shot.scene) {
      const a = idx.scene[shot.scene];
      if (!a) issue(d.scene, `场景 ${shot.scene} 没有场景卡`);
      else {
        const { need, got, short } = lockShortfall(a, 'scene');
        if (short) issue(d.scene, `场景 ${shot.scene} 一致性锁不足（${got}/${need}）`);
        if (requireImage && !a.image_url) {
          issue(d.scene, `场景 ${shot.scene} 还没有概念图，每镜会重新想象这个地方`);
        }
      }
    }

    // —— 内容：与总谱对齐 ——
    const beats = planRecord?.plan?.episodes ?? planRecord?.episodes ?? [];
    const beat = beats.flatMap((e) => e.beats ?? []).find((b) => b.beat_no === shot.beat_no);
    if (beat) {
      for (const f of FIELDS_LOCKED_BY_PLAN) {
        if (overridden.has(f)) {
          warn(d.content, `${f} 已是人工改写（导演原值 ${JSON.stringify(beat[f] ?? beat.rhythm_code)}）`);
          continue;
        }
        const mine = f === 'rhythm' ? shot.rhythm : shot[f];
        const theirs = f === 'rhythm' ? beat.rhythm_code : beat[f];
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
          issue(d.content, `${f} 与导演总谱不一致（镜头 ${JSON.stringify(mine)} / 总谱 ${JSON.stringify(theirs)}）`, { field: f });
        }
      }
      for (const [ch, code] of Object.entries(shot.emotions ?? {})) {
        if (overridden.has('emotions')) break;
        if (beat.emotions?.[ch] && beat.emotions[ch] !== code) {
          issue(d.content, `角色 ${ch} 的情绪与总谱不一致（${code} / ${beat.emotions[ch]}）`, { field: 'emotions' });
        }
      }
    }
    if (shot.dialogue && !shot.speaker) issue(d.content, '有对白但没有指定说话人');
    if (shot.dialogue && (shot.characters ?? []).length && !(shot.characters ?? []).includes(shot.speaker)) {
      issue(d.content, `说话人 ${shot.speaker} 不在本镜的在场角色里，声音会对不上人`);
    }

    // —— 声音字幕 ——
    const sync = syncRuleOf(syncCode);
    if (shot.dialogue && sync) {
      const cap = (sync.max_chars_per_line ?? 16) * (sync.max_lines ?? 1);
      const len = String(shot.dialogue).replace(/\s/g, '').length;
      if (len > cap) {
        issue(d.audio_subtitle, `对白 ${len} 字，按「${sync.name}」字幕最多 ${cap} 字`, { rule: sync.code, len, cap });
      }
      const perSec = speechUnits(String(shot.dialogue)) / Math.max(0.1, Number(shot.duration) || 0);
      if (perSec > 4.1) {
        issue(d.audio_subtitle, `语速超限（${perSec.toFixed(2)} 字/秒，上限 4.1），念不完也听不清`);
      }
      const voice = Object.values(idx.voice).find((v) => v.meta?.character_code === shot.speaker);
      if (!voice && shot.speaker) {
        issue(d.audio_subtitle, `说话人 ${shot.speaker} 没有固定声线，同一角色会换嗓子`);
      }
    }

    const hard = [];
    for (const dim of Object.values(d)) hard.push(...dim.issues.map((x) => x.text));
    return { ok: hard.length === 0, dims: d, hard };
  }

  /**
   * 生成前硬闸门（ShotService / 资产出图前调用）。
   * @returns { audit, voices } 通过则返回体检结果，不通过抛 CONSISTENCY_VIOLATION
   */
  assertBeforeGenerate({ projectId, shot, planRecord = null, requireImage = true, syncCode = null }) {
    const voices = this.ensureVoiceAssets(projectId);
    const idx = this.assetIndex(projectId);
    const audit = this.auditShot({ projectId, shot, planRecord, assets: idx, requireImage, syncCode });
    if (!audit.ok) {
      const byDim = Object.entries(audit.dims)
        .filter(([, v]) => !v.ok)
        .map(([k, v]) => `${DIMENSIONS.find((d) => d.key === k)?.name}：${v.issues.map((i) => i.text).join('；')}`);
      fail(
        ERR.CONSISTENCY_VIOLATION,
        `五维一致性未通过，已拒绝生成：${byDim.join(' ｜ ')}`,
        { shot_no: shot?.no ?? null, dims: audit.dims, hint: '先补齐资产 / 在导演面板调整技巧库，或对该镜做手动改写并标注' },
      );
    }
    return { audit, voices };
  }

  /**
   * 全片五维体检（交付闸门 / 前端面板）。只读，不抛错。
   * @returns { project_id, episode, dimensions:[{key,name,ok,failed,issues}], shots:[], kpi }
   */
  audit(projectId, { episode = null, syncCode = null, persist = true } = {}) {
    const project = db.findOne(PROJECT, (p) => p.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const planRecord = db.findOne(PLANS, (x) => x.project_id === projectId);
    const shots = (planRecord?.storyboard?.shots ?? []).filter(
      (s) => !episode || Number(s.episode) === Number(String(episode).replace(/^E0*/i, '')) || `E0${s.episode}` === String(episode),
    );
    if (!shots.length) {
      return {
        project_id: projectId, episode, empty: true, dimensions: [],
        shots: [], kpi: { total: 0, pass: 0, pass_rate: null, ok: false },
        note: '还没有分镜，先选定一版剧本',
      };
    }
    // 有对白的镜才要求"图已出"（否则用户会卡在资产出图上动不了）
    const rows = shots.map((s) => {
      const a = this.auditShot({
        projectId, shot: s, planRecord, requireImage: true,
        syncCode: syncCode ?? directorAgent.libraryOverrides(projectId).sync ?? null,
      });
      return { shot_no: s.no, episode: s.episode, ok: a.ok, dims: a.dims };
    });

    const dimensions = DIMENSIONS.map((d) => {
      const fails = rows.filter((r) => !r.dims[d.key].ok);
      const warnings = rows.flatMap((r) => r.dims[d.key].warnings.map((w) => `${r.shot_no}: ${w}`));
      return {
        key: d.key,
        name: d.name,
        what: d.what,
        ok: fails.length === 0,
        failed: fails.length,
        total: rows.length,
        issues: fails.slice(0, 12).map((r) => ({
          shot_no: r.shot_no,
          issues: r.dims[d.key].issues,
        })),
        warnings: warnings.slice(0, 12),
      };
    });

    const pass = rows.filter((r) => r.ok).length;
    const report = {
      project_id: projectId,
      episode,
      dimensions,
      shots: rows.map((r) => ({
        shot_no: r.shot_no,
        episode: r.episode,
        ok: r.ok,
        failed_dims: DIMENSIONS.filter((d) => !r.dims[d.key].ok).map((d) => d.key),
      })),
      kpi: { total: rows.length, pass, pass_rate: Number((pass / rows.length).toFixed(4)), ok: pass === rows.length },
      rule: '五维一致性是底层强制规则：任一维不过，该镜不允许出图与交付',
      checked_at: nowIso(),
    };
    if (persist) {
      db.insert(GUARD, {
        id: newId('cg'),
        project_id: projectId,
        episode,
        kpi: report.kpi,
        dimensions: dimensions.map((d) => ({ key: d.key, ok: d.ok, failed: d.failed })),
        created_at: report.checked_at,
      });
    }
    return report;
  }

  /** 交付闸门用：返回 blockers（不抛错，交由 CompliancePack 汇总） */
  blockers(projectId, { episode = null } = {}) {
    const r = this.audit(projectId, { episode });
    return (r.dimensions ?? [])
      .filter((d) => !d.ok)
      .map((d) => ({
        code: 'CONSISTENCY_DIM_FAILED',
        dimension: d.key,
        issue: `${d.name}未通过：${d.failed}/${d.total} 镜有问题` +
          (d.issues[0] ? `（例：${d.issues[0].shot_no} ${d.issues[0].issues[0]?.text ?? ''}）` : ''),
      }));
  }

  /** 最近一次体检（前端直接展示） */
  latest(projectId) {
    return db.find(GUARD, (x) => x.project_id === projectId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;
  }

  /** 各维在本项目的实际锁情况（前端解释"为什么不过"） */
  locksOf(projectId) {
    const idx = this.assetIndex(projectId);
    const out = {};
    for (const type of ['character', 'scene', 'prop', 'voice']) {
      out[type] = Object.values(idx[type]).map((a) => ({
        code: a.asset_code,
        name: a.name,
        locks: (a.locks ?? []).length,
        need: seeds.lockTemplate(type)?.required_lock_count ?? 1,
        has_image: Boolean(a.image_url),
      }));
    }
    // 生成记录用于确认"这一镜是否真的按一致性规则出过图"
    out.generated = db.count(GENS, (g) => g.project_id === projectId && g.status === 'done');
    return out;
  }
}

export const consistencyGuard = new ConsistencyGuard();
export default consistencyGuard;
