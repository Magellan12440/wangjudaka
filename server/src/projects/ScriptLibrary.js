/**
 * 剧本库（V4.10）：把「生成剧本」从一次性动作变成可挑选、可留存的资产。
 *
 * 过去的问题：`POST /plan` 直接覆盖 director_plans，用户只能接受唯一结果，
 * 也没有任何地方能回看「我上一版剧本」。这不符合真实的创作流程。
 *
 * 现在的三段式：
 *   1) 候选（script_candidates）：一次生成 1~3 份，先看标题/梗概/人物/集数再决定
 *   2) 选定（select）：把选中的那份写成项目的导演总谱，并按它生成角色/场景/道具资产卡
 *   3) 入库（script_vault）：同时写进用户的个人资产库，可以改名、改设定、随时重新套用到项目
 *
 * 为什么要保留整份 script：选定后用户还要能「照这版重做」，重建一次剧本要花算力和时间，
 * 直接留档比重新生成便宜得多。
 */
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import assetLibrary from '../assets/AssetLibrary.js';
import { directorAgent } from '../director/DirectorAgent.js';
import { directorPlanEngine } from '../pipeline/DirectorPlan.js';
import seeds from '../seeds/loader.js';
import { logger } from '../core/redact.js';

const CAND = 'script_candidates';
const VAULT = 'script_vault';
const PLANS = 'director_plans';
const ASSETS = 'assets';
// V4.15：这两个上限只影响**默认展示条数**，不再删数据。
// 以前超过就 db.remove，等于平台替用户丢稿——既可能是用户的作品，也可能是纠纷证据。
const MAX_CANDIDATES_SHOW = 9;
const SUGGEST_VAULT_SIZE = 60;

function clampStr(v, n) {
  return String(v ?? '').slice(0, n);
}

/** 候选/留档的对外摘要：不把几万字的正文塞进列表接口 */
function summary(rec, activeId = null) {
  const outline = rec.outline ?? {};
  const shots = rec.storyboard?.shots ?? [];
  const chars = (rec.script?.episodes ?? []).reduce(
    (n, ep) => n + (ep.scenes ?? []).reduce((m, sc) => m + String(sc.action ?? '').length
      + (sc.dialogue ?? []).reduce((k, d) => k + String(d.line ?? '').length, 0), 0),
    0,
  );
  return {
    id: rec.id,
    plan_id: rec.plan_id,
    title: outline.title || rec.title || '未命名剧本',
    logline: outline.logline || '',
    characters: (outline.characters ?? []).map((c) => ({ code: c.code, name: c.name, role: c.role ?? '' })),
    episodes: (outline.episodes ?? []).length || (rec.script?.episodes ?? []).length,
    shots: shots.length,
    chars,
    label: rec.label ?? '',
    source: rec.source ?? 'generate',
    created_at: rec.created_at,
    selected: Boolean(activeId && rec.plan_id === activeId),
    in_vault: Boolean(rec.vault_id),
  };
}

export class ScriptLibrary {
  /** 生成候选时用：把一份完整的剧本产物写进候选表 */
  addCandidate({
    projectId, userId, outline, plan, script, storyboard,
    materialsUsed = [], referenceChars = 0, totalChars = 0, condensed = false,
    label = '', source = 'generate',
  }) {
    if (!outline || !plan) fail(ERR.BAD_REQUEST, '候选剧本内容不完整');
    const rec = db.insert(CAND, {
      id: newId('scand'),
      project_id: projectId,
      user_id: userId ?? null,
      plan_id: plan.plan_id,
      plan_version: plan.plan_version ?? 1,
      label: clampStr(label, 40),
      source,
      outline,
      plan,
      script: script ?? null,
      storyboard: storyboard ?? null,
      materials_used: materialsUsed,
      reference_chars: referenceChars,
      total_chars: totalChars,
      condensed: !!condensed,
      created_at: nowIso(),
    });
    this.#trim(projectId);
    return rec;
  }

  /**
   * 以前的"裁剪"会把超出的候选直接删掉（V4.15 起不再删）。
   * 保留这个方法名是为了不动调用点；现在它只标记 `beyond_fold`，
   * 列表里折叠展示，数据仍在库里。
   */
  #trim(projectId) {
    const rows = db.find(CAND, (x) => x.project_id === projectId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const r of rows.slice(MAX_CANDIDATES_SHOW)) {
      if (r.beyond_fold !== true) db.update(CAND, r.id, { beyond_fold: true });
    }
  }

  candidates(projectId) {
    const active = db.findOne(PLANS, (x) => x.project_id === projectId);
    const rows = db.find(CAND, (x) => x.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return {
      active_plan_id: active?.plan_id ?? null,
      items: rows.map((r) => summary(r, active?.plan_id)),
    };
  }

  getCandidate(candidateId) {
    const rec = db.findOne(CAND, (x) => x.id === candidateId);
    if (!rec) fail(ERR.NOT_FOUND, '这份剧本候选已经不在了，请重新生成');
    return rec;
  }

  /**
   * 选定一份候选：写成项目总谱 + 按它生成资产卡 + 同步个人剧本库。
   * @returns {{plan_id:string, assets:{created:number,total:number}, vault_id:string}}
   */
  select({ projectId, userId, candidateId, title = '' }) {
    const cand = this.getCandidate(candidateId);
    if (cand.project_id !== projectId) fail(ERR.BAD_REQUEST, '这份剧本属于另一个项目');

    const outline = title
      ? { ...(cand.outline ?? {}), title: clampStr(title, 60) }
      : (cand.outline ?? {});

    // V4.11：选定即代表这条链路正式开工 —— 先过虚拟导演闸门（四库必须落实），
    // 再把用户 pin 的技巧重新落到这一版总谱上（候选可能是 pin 之前生成的）。
    directorAgent.assertStage(projectId, 'plan');
    try {
      directorAgent.applyToPlan(cand.plan, projectId);
      cand.plan.validation = directorPlanEngine.validate(cand.plan);
    } catch (e) {
      logger.warn('选定剧本时应用导演策略失败，沿用候选自带编排', { projectId, error: e.message });
    }

    // 1) 项目总谱：覆盖成选中的那一版（导演总谱与分镜必须同源，不能拼两份）
    const rec = {
      project_id: projectId,
      plan_id: cand.plan_id,
      plan_version: cand.plan_version ?? 1,
      outline,
      plan: cand.plan,
      script: cand.script,
      storyboard: cand.storyboard,
      materials_used: cand.materials_used ?? [],
      reference_chars: cand.reference_chars ?? 0,
      total_chars: cand.total_chars ?? 0,
      condensed: !!cand.condensed,
      selected_candidate_id: cand.id,
      created_at: nowIso(),
    };
    const old = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (old) {
      const patch = { ...rec };
      delete patch.id;
      db.update(PLANS, old.id, patch);
    } else {
      db.insert(PLANS, { id: newId('dplan'), ...rec });
    }

    // 2) 资产卡：角色 / 场景 / 道具按这一版重建
    const assets = this.syncAssets({ projectId, outline, storyboard: cand.storyboard, script: cand.script });

    // 3) 个人资产库：选定即入库（同一份候选重复点「选定」不会重复入库）
    const vaultId = this.upsertFromCandidate({ userId: userId ?? null, projectId, cand, outline, assets });

    directorAgent.log({
      projectId, stage: 'script', action: 'select_candidate',
      decisions: [
        `选定《${outline.title ?? '未命名'}》（${cand.id}）`,
        `按此版落 ${assets.total} 张资产卡`,
        `总谱自检 ${cand.plan?.validation?.ok ? '通过' : '未通过'}`,
      ],
      gate: { ok: Boolean(cand.plan?.validation?.ok), issues: (cand.plan?.validation?.problems ?? []).slice(0, 5) },
      actor: 'user',
    });

    return { plan_id: cand.plan_id, assets, vault_id: vaultId };
  }

  /**
   * 按选定剧本生成角色 / 场景 / 道具资产卡。
   * 只补不删：用户已经在库里改过的资产（有图 / 改过锁）保留，避免二次选定把人工调整冲掉。
   *
   * V4.13：角色的来源从「大纲里列过的人」扩到「剧本里真的出现过的人」。
   * 以前只有大纲 characters 会被建卡，于是配角（甚至是台词不少的反派手下）在大纲里没被列出来，
   * 到了分镜出图才被兜底补一张 code 当名字的空卡 —— 定妆图自然对不上剧本，前后也不一致。
   * 现在三处取并集：大纲人物 ∪ 分镜角色码 ∪ 剧本说话人，一个都不漏。
   */
  syncAssets({ projectId, outline, storyboard, script = null }) {
    const existing = db.find(ASSETS, (a) => a.project_id === projectId);
    const has = new Set(existing.map((a) => `${a.asset_type}:${a.asset_code}`));
    let created = 0;

    const createSafely = (assetType, name, lockValues = {}, meta = {}, code = null) => {
      const tpl = seeds.lockTemplate(assetType);
      if (!tpl) return;
      try {
        assetLibrary.create({
          projectId,
          assetType,
          name: name || assetType,
          // V4.13：必须用剧本里的角色码（CH07），否则分镜引用 CH07 时找不到资产
          code: code || undefined,
          locks: tpl.suggested_locks ?? [],
          lockValues,
          meta,
        });
        created += 1;
      } catch (e) {
        logger.warn('资产卡落库失败', { projectId, assetType, name, code, msg: e.message });
      }
    };

    // —— 角色名册（并集）——
    const roster = new Map();
    for (const c of outline?.characters ?? []) {
      if (!c?.code) continue;
      roster.set(c.code, {
        code: c.code,
        name: c.name || c.code,
        role: c.role ?? '',
        traits: c.traits ?? '',
        locks: c.locks ?? [],
        source: 'outline',
      });
    }
    // 分镜里出现但大纲没写的人：至少要知道他出现在哪几集、有没有台词
    const appearance = new Map();
    for (const s of storyboard?.shots ?? []) {
      for (const code of s.characters ?? []) {
        if (!code) continue;
        const cur = appearance.get(code) ?? { episodes: new Set(), shots: 0, lines: 0 };
        const ep = Number(String(s.no ?? '').replace(/^E0*/i, '').split('-')[0]) || null;
        if (ep) cur.episodes.add(ep);
        cur.shots += 1;
        appearance.set(code, cur);
      }
    }
    const speakCount = new Map();
    // 台词里的 speaker 可能是角色码（CH01），也可能是人名（模型偶尔会写人名）。
    // 只有能落到角色码上的才算"角色"：否则会凭空建出一张叫「沈砚」的重复卡，
    // 跟已有的 CH01 变成两张脸 —— 这正是一致性最怕的事。
    const codeByName = new Map([...roster.values()].map((r) => [String(r.name ?? '').trim(), r.code]));
    const resolveSpeaker = (speaker) => {
      const raw = String(speaker ?? '').trim();
      if (!raw) return null;
      if (roster.has(raw) || /^CH\d+$/i.test(raw)) return raw;
      return codeByName.get(raw) ?? null;
    };
    for (const ep of script?.episodes ?? []) {
      for (const sc of ep.scenes ?? []) {
        for (const d of sc.dialogue ?? []) {
          const code = resolveSpeaker(d?.speaker);
          if (!code) continue;
          speakCount.set(code, (speakCount.get(code) ?? 0) + 1);
        }
      }
    }
    const rosterIndex = new Map([...roster.keys()].map((c, i) => [c, i]));
    const allCodes = [...new Set([...roster.keys(), ...appearance.keys(), ...speakCount.keys()])]
      // 主角优先（大纲顺序），配角按出场次数从多到少：出图批次有限时先保出场多的
      .sort((a, b) => {
        const ra = rosterIndex.has(a) ? 0 : 1;
        const rb = rosterIndex.has(b) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        if (ra === 0) return rosterIndex.get(a) - rosterIndex.get(b);
        return (appearance.get(b)?.shots ?? 0) - (appearance.get(a)?.shots ?? 0);
      });

    for (const code of allCodes) {
      if (has.has(`character:${code}`)) continue;
      const r = roster.get(code);
      const app = appearance.get(code);
      const lines = speakCount.get(code) ?? 0;
      const isSupporting = !r;
      createSafely('character', r?.name || `配角 ${code}`, {
        name: r?.name ?? `配角 ${code}`,
        role: r?.role || (isSupporting ? '配角' : ''),
        traits: r?.traits ?? '',
        first_appearance: app?.episodes?.size ? `EP${[...app.episodes].sort((x, y) => x - y)[0]}` : '',
      }, {
        role: r?.role || (isSupporting ? '配角' : ''),
        traits: r?.traits ?? '',
        supporting: isSupporting,
        episodes: app ? [...app.episodes].sort((x, y) => x - y) : [],
        shots: app?.shots ?? 0,
        lines,
        from_script: isSupporting,
      }, code);
      has.add(`character:${code}`);
    }

    // 场景：以分镜实际用到的 scene 码为准（SC01…），保证镜头一定能引用到
    const sceneCodes = [...new Set((storyboard?.shots ?? []).map((s) => s.scene).filter(Boolean))].sort();
    const named = new Map((outline?.locations ?? []).map((l, i) => [i, l]));
    sceneCodes.forEach((code, i) => {
      if (has.has(`scene:${code}`)) return;
      const loc = named.get(i);
      createSafely('scene', loc?.name || `场景 ${code.replace(/^SC0*/i, '')}`, {
        name: loc?.name ?? code, desc: loc?.desc ?? '', episode: Number(code.replace(/^SC/i, '')) || i + 1,
      }, { desc: loc?.desc ?? '' }, code);
      has.add(`scene:${code}`);
    });

    // 道具：大纲显式给出才建（不硬凑，空道具比假道具安全）
    for (const p of outline?.props ?? []) {
      const code = p.code || 'PR00';
      if (has.has(`prop:${code}`)) continue;
      createSafely('prop', p.name || code, { name: p.name ?? '', desc: p.desc ?? '' }, { desc: p.desc ?? '' }, code);
      has.add(`prop:${code}`);
    }

    const total = db.count(ASSETS, (a) => a.project_id === projectId);
    return { created, total };
  }

  /** 选定即入库：按候选 + 项目去重（同一项目同一 plan_id 只留一条） */
  upsertFromCandidate({ userId, projectId, cand, outline, assets }) {
    if (!userId) return '';
    const old = db.findOne(VAULT, (x) => x.user_id === userId && x.project_id === projectId && x.plan_id === cand.plan_id);
    const row = {
      user_id: userId,
      project_id: projectId,
      candidate_id: cand.id,
      plan_id: cand.plan_id,
      title: outline?.title || '未命名剧本',
      logline: outline?.logline ?? '',
      outline,
      plan: cand.plan,
      script: cand.script,
      storyboard: cand.storyboard,
      materials_used: cand.materials_used ?? [],
      asset_total: assets?.total ?? 0,
      updated_at: nowIso(),
    };
    if (old) {
      db.update(VAULT, old.id, row);
      return old.id;
    }
    const created = db.insert(VAULT, {
      id: newId('svault'), created_at: nowIso(), ...row,
    });
    // V4.15：不再按数量裁剪。剧本库是账号资产，超出建议量只提示，不删旧稿。
    return created.id;
  }

  // —— 个人剧本库 ——

  vaultList(userId) {
    if (!userId) fail(ERR.AUTH_REQUIRED, '请先登录');
    const rows = db.find(VAULT, (x) => x.user_id === userId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return {
      total: rows.length,
      retention: 'permanent',
      // 超过建议量只提醒，绝不自动清理
      notice: rows.length > SUGGEST_VAULT_SIZE
        ? `你的剧本库已有 ${rows.length} 部，超过建议量 ${SUGGEST_VAULT_SIZE} 部。这些都会永久保留，需要清理请自己删除。`
        : '',
      items: rows.map((r) => ({
        id: r.id,
        project_id: r.project_id,
        plan_id: r.plan_id,
        title: r.title,
        logline: r.logline,
        characters: (r.outline?.characters ?? []).map((c) => ({ code: c.code, name: c.name })),
        episodes: (r.script?.episodes ?? []).length || (r.outline?.episodes ?? []).length,
        shots: (r.storyboard?.shots ?? []).length,
        asset_total: r.asset_total ?? 0,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  }

  vaultGet(userId, id) {
    const row = db.findOne(VAULT, (x) => x.id === id && x.user_id === userId);
    if (!row) fail(ERR.NOT_FOUND, '剧本不存在或不属于你');
    return row;
  }

  /** 改剧本：标题 / 一句话梗概 / 人物小传 / 集标题（不重跑模型，改的是存档） */
  vaultUpdate(userId, id, patch = {}) {
    const row = this.vaultGet(userId, id);
    const outline = { ...(row.outline ?? {}) };
    if (patch.title !== undefined) outline.title = clampStr(patch.title, 60);
    if (patch.logline !== undefined) outline.logline = clampStr(patch.logline, 400);
    if (Array.isArray(patch.characters)) {
      const byCode = new Map(outline.characters?.map((c) => [c.code, c]) ?? []);
      for (const c of patch.characters) {
        if (!c?.code) continue;
        byCode.set(c.code, { ...(byCode.get(c.code) ?? {}), ...c });
      }
      outline.characters = [...byCode.values()];
    }
    if (Array.isArray(patch.episodes)) {
      const byNo = new Map((outline.episodes ?? []).map((e) => [e.no, e]));
      for (const e of patch.episodes) {
        if (e?.no === undefined) continue;
        byNo.set(e.no, { ...(byNo.get(e.no) ?? {}), ...e });
      }
      outline.episodes = [...byNo.values()].sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
    }
    const updated = db.update(VAULT, id, {
      outline,
      title: outline.title ?? row.title,
      logline: outline.logline ?? row.logline,
      note: patch.note !== undefined ? clampStr(patch.note, 300) : row.note,
      updated_at: nowIso(),
    });
    return {
      id,
      title: updated.title,
      logline: updated.logline,
      characters: outline.characters ?? [],
      episodes: outline.episodes ?? [],
      updated_at: updated.updated_at,
    };
  }

  vaultRemove(userId, id) {
    const row = this.vaultGet(userId, id);
    db.remove(VAULT, row.id);
    return { removed: true, id };
  }

  /**
   * 把库里存的剧本重新套用到某个项目（换项目 / 项目被重置时用）。
   * 会重建总谱与其资产卡，等同「用这版剧本重拍一次」。
   */
  vaultApply({ userId, id, projectId }) {
    const row = this.vaultGet(userId, id);
    const project = db.findOne('projects', (p) => p.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '目标项目不存在');
    if (project.user_id && userId && project.user_id !== userId) fail(ERR.FORBIDDEN, '这不是你的项目');

    const rec = {
      project_id: projectId,
      plan_id: row.plan_id,
      plan_version: row.plan?.plan_version ?? 1,
      outline: row.outline,
      plan: row.plan,
      script: row.script,
      storyboard: row.storyboard,
      materials_used: row.materials_used ?? [],
      selected_candidate_id: row.candidate_id ?? null,
      applied_from_vault: row.id,
      created_at: nowIso(),
    };
    const old = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (old) {
      const patch = { ...rec };
      delete patch.id;
      db.update(PLANS, old.id, patch);
    } else {
      db.insert(PLANS, { id: newId('dplan'), ...rec });
    }
    const assets = this.syncAssets({ projectId, outline: row.outline, storyboard: row.storyboard });
    return { plan_id: row.plan_id, assets };
  }

  /** 当前项目选中的那份是否已入库（前端用来显示「已存入我的剧本库」） */
  activeOf(projectId) {
    const active = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (!active) return null;
    const v = db.findOne(VAULT, (x) => x.project_id === projectId && x.plan_id === active.plan_id);
    return { plan_id: active.plan_id, vault_id: v?.id ?? null, title: active.outline?.title ?? '' };
  }
}

export const scriptLibrary = new ScriptLibrary();
export default scriptLibrary;
