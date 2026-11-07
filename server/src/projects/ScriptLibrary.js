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
import seeds from '../seeds/loader.js';
import { logger } from '../core/redact.js';

const CAND = 'script_candidates';
const VAULT = 'script_vault';
const PLANS = 'director_plans';
const ASSETS = 'assets';
const MAX_CANDIDATES_KEEP = 9;
const MAX_VAULT = 60;

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

  #trim(projectId) {
    const rows = db.find(CAND, (x) => x.project_id === projectId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    for (const r of rows.slice(MAX_CANDIDATES_KEEP)) db.remove(CAND, r.id);
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
    const assets = this.syncAssets({ projectId, outline, storyboard: cand.storyboard });

    // 3) 个人资产库：选定即入库（同一份候选重复点「选定」不会重复入库）
    const vaultId = this.upsertFromCandidate({ userId: userId ?? null, projectId, cand, outline, assets });

    return { plan_id: cand.plan_id, assets, vault_id: vaultId };
  }

  /**
   * 按选定剧本生成角色 / 场景 / 道具资产卡。
   * 只补不删：用户已经在库里改过的资产（有图 / 改过锁）保留，避免二次选定把人工调整冲掉。
   */
  syncAssets({ projectId, outline, storyboard }) {
    const existing = db.find(ASSETS, (a) => a.project_id === projectId);
    const has = new Set(existing.map((a) => `${a.asset_type}:${a.asset_code}`));
    let created = 0;

    const createSafely = (assetType, name, lockValues = {}, meta = {}) => {
      const tpl = seeds.lockTemplate(assetType);
      if (!tpl) return;
      try {
        assetLibrary.create({
          projectId,
          assetType,
          name: name || assetType,
          locks: tpl.suggested_locks ?? [],
          lockValues,
          meta,
        });
        created += 1;
      } catch (e) {
        logger.warn('资产卡落库失败', { projectId, assetType, name, msg: e.message });
      }
    };

    // 角色：大纲里的人物（有 traits 就写进 lock_values，出图时是真实依据）
    for (const c of outline?.characters ?? []) {
      const code = c.code || 'CH00';
      if (has.has(`character:${code}`)) continue;
      createSafely('character', c.name || code, {
        name: c.name ?? '', role: c.role ?? '', traits: c.traits ?? '',
      }, { role: c.role ?? '', traits: c.traits ?? '' });
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
      }, { desc: loc?.desc ?? '' });
      has.add(`scene:${code}`);
    });

    // 道具：大纲显式给出才建（不硬凑，空道具比假道具安全）
    for (const p of outline?.props ?? []) {
      const code = p.code || 'PR00';
      if (has.has(`prop:${code}`)) continue;
      createSafely('prop', p.name || code, { name: p.name ?? '', desc: p.desc ?? '' }, { desc: p.desc ?? '' });
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
    // 上限：超出按更新时间裁掉最旧的
    const mine = db.find(VAULT, (x) => x.user_id === userId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    for (const r of mine.slice(MAX_VAULT)) db.remove(VAULT, r.id);
    return created.id;
  }

  // —— 个人剧本库 ——

  vaultList(userId) {
    if (!userId) fail(ERR.AUTH_REQUIRED, '请先登录');
    const rows = db.find(VAULT, (x) => x.user_id === userId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return {
      total: rows.length,
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
