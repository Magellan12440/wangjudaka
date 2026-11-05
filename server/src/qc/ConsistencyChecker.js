/**
 * 一致性自检服务（§16 M3 出口条件：角色跨镜相似度 ≥ 0.82；§18.3 第 9 步）。
 *
 * 这是对 V3.2 之前 AssetLibrary.checkConsistency 占位实现的正式替换。
 * 三条硬规则：
 *  1. **绝不假装通过**：没有可用的比对 provider 时，verdict 恒为 degraded，
 *     score 恒为 null，并标记 needs_manual_review；不写「ok: true」。
 *  2. **生成后标记，不回滚**：漂移只标记 + 出重生成建议，不抛异常、不退已成功的产物；
 *     交付前闸门（CompliancePack.deliveryGate）才做阻断。
 *  3. **provider 可插拔**：内置 feature（结构化特征）用于本地联调，mock 恒降级；
 *     CLIP / 人脸比对以 HTTP provider 注册，未配置绝不静默当作可用。
 *
 * provider 契约：
 *   { name, available, compare({ reference, candidate }) -> { score: number|null, dimensions: object } }
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, clamp, round } from '../core/util.js';

const COL = 'consistency_checks';
export const DEFAULT_THRESHOLD = 0.82;

/** 特征维度权重：连续性锁最重，其次光影与情绪，风格最低 */
export const FEATURE_WEIGHTS = { locks: 0.45, emotion: 0.20, lighting: 0.20, style: 0.15 };

function asSet(v) {
  if (Array.isArray(v)) return new Set(v.filter(Boolean).map(String));
  if (v && typeof v === 'object') return new Set(Object.values(v).filter(Boolean).map(String));
  if (v === undefined || v === null || v === '') return new Set();
  return new Set([String(v)]);
}

/** 加权 Jaccard：空集对空集视为「无从判断」→ 该维度返回 null */
function jaccard(a, b) {
  const A = asSet(a);
  const B = asSet(b);
  if (A.size === 0 && B.size === 0) return null;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function normFeatures(f) {
  const x = f ?? {};
  return {
    locks: x.locks ?? x.asset_locks ?? [],
    emotion: x.emotion_codes ?? x.emotions ?? [],
    lighting: x.lighting_codes ?? x.lighting ?? [],
    style: x.style_code ?? x.style ?? [],
  };
}

/** 内置 provider：结构化特征比对（无需外部服务，可复现、可单测） */
export const featureProvider = {
  name: 'feature',
  available: true,
  compare({ reference, candidate }) {
    const R = normFeatures(reference);
    const C = normFeatures(candidate);
    const dims = {};
    for (const k of Object.keys(FEATURE_WEIGHTS)) dims[k] = jaccard(R[k], C[k]);
    const usable = Object.entries(dims).filter(([, v]) => v !== null);
    if (!usable.length) return { score: null, dimensions: dims, reason: '参考与候选均无可用特征' };
    const wsum = usable.reduce((a, [k]) => a + FEATURE_WEIGHTS[k], 0);
    const score = usable.reduce((a, [k, v]) => a + FEATURE_WEIGHTS[k] * v, 0) / wsum;
    return { score: round(clamp(score, 0, 1), 4), dimensions: dims };
  },
};

/** 内置 provider：MOCK，恒降级，绝不产出分数 */
export const mockProvider = {
  name: 'mock',
  available: false,
  compare() {
    return { score: null, dimensions: {}, reason: 'MOCK 模式未接入图像比对服务' };
  },
};

export class ConsistencyChecker {
  constructor() {
    this.providers = new Map([
      [featureProvider.name, featureProvider],
      [mockProvider.name, mockProvider],
    ]);
    this.activeProvider = null; // null = 自动：有真实特征用 feature，否则 mock
  }

  /** 注册外部比对服务（CLIP / InsightFace HTTP 客户端等） */
  registerProvider(impl) {
    if (!impl?.name || typeof impl.compare !== 'function') {
      fail(ERR.BAD_REQUEST, '比对 provider 必须包含 name 与 compare()');
    }
    this.providers.set(impl.name, { available: true, ...impl });
    return this.listProviders();
  }

  listProviders() {
    return [...this.providers.values()].map((p) => ({ name: p.name, available: p.available !== false }));
  }

  useProvider(name) {
    if (name !== null && !this.providers.has(name)) {
      fail(ERR.BAD_REQUEST, `比对 provider 不存在: ${name}`, { available: this.listProviders() });
    }
    this.activeProvider = name;
  }

  #resolveProvider({ providerName, reference, candidate, similarityScore }) {
    if (typeof similarityScore === 'number') {
      // 外部服务已算好分数：直接采信，但必须带来源
      return {
        name: providerName ?? 'external',
        available: true,
        compare: () => ({ score: clamp(similarityScore, 0, 1), dimensions: { external: similarityScore } }),
      };
    }
    if (providerName) {
      const p = this.providers.get(providerName);
      if (!p) fail(ERR.BAD_REQUEST, `比对 provider 不存在: ${providerName}`);
      return p;
    }
    if (this.activeProvider) return this.providers.get(this.activeProvider);
    // 自动：候选与参考都带结构化特征时用 feature，否则降级 mock
    const hasFeatures = (x) => {
      const f = normFeatures(x);
      return Object.values(f).some((v) => asSet(v).size > 0);
    };
    return hasFeatures(reference) && hasFeatures(candidate) ? featureProvider : mockProvider;
  }

  /**
   * 单镜生成后自检。
   * @param {object} p projectId, shotNo, assetCode, generatedUrl,
   *        reference（资产快照特征）, candidate（生成结果特征，真实场景由图像服务反推）,
   *        similarityScore（外部已算好的分数，可选）, providerName, threshold, strict
   */
  check({
    projectId,
    shotNo,
    assetCode = null,
    generatedUrl = null,
    reference = null,
    candidate = null,
    similarityScore = null,
    providerName = null,
    threshold = DEFAULT_THRESHOLD,
    strict = false,
    generationId = null,
    precomputed = null,
  }) {
    if (!projectId || !shotNo) fail(ERR.BAD_REQUEST, '一致性自检需要 projectId 与 shotNo');
    const th = clamp(Number(threshold) || DEFAULT_THRESHOLD, 0, 1);
    let provider = this.#resolveProvider({ providerName, reference, candidate, similarityScore });
    let verdict;
    let score = null;
    let dimensions = {};
    let note = null;

    if (precomputed !== null && precomputed !== undefined) {
      // checkAsync 已 await 过真实 HTTP provider：采信其分数，但绝不兜底给高分
      provider = { name: precomputed.provider ?? 'external', available: true };
      dimensions = precomputed.dimensions ?? {};
      score = typeof precomputed.score === 'number' ? clamp(precomputed.score, 0, 1) : null;
      if (score === null) {
        verdict = 'degraded';
        note = precomputed.reason ?? '比对服务未返回有效分数';
      } else {
        verdict = score >= th ? 'pass' : 'drift';
      }
    } else if (provider.available === false) {
      verdict = 'degraded';
      note = provider.compare?.().reason ?? '未接入图像比对服务';
    } else {
      const r = provider.compare({ reference, candidate, generatedUrl });
      dimensions = r.dimensions ?? {};
      score = typeof r.score === 'number' ? clamp(r.score, 0, 1) : null;
      if (score === null) {
        verdict = 'degraded';
        note = r.reason ?? '比对服务未返回有效分数';
      } else if (score >= th) {
        verdict = 'pass';
      } else {
        verdict = 'drift';
      }
    }

    const rec = db.insert(COL, {
      id: newId('qc'),
      project_id: projectId,
      shot_no: shotNo,
      episode: episodeOf(shotNo),
      asset_code: assetCode,
      generation_id: generationId,
      generated_url: generatedUrl,
      provider: provider.name,
      score,
      threshold: th,
      dimensions,
      verdict,
      needs_manual_review: verdict !== 'pass',
      note,
      reference: reference ? normalizeForStore(reference) : null,
      candidate: candidate ? normalizeForStore(candidate) : null,
      advice: verdict === 'drift' ? buildAdvice(dimensions, score, th) : [],
      created_at: nowIso(),
    });

    // strict 模式（交付闸门）才阻断；生成后自检只标记
    if (strict && verdict === 'drift') {
      fail(ERR.CONSISTENCY_DRIFT, `一致性分 ${score} 低于阈值 ${th}，疑似角色漂移`, {
        shotNo, assetCode, checkId: rec.id,
      });
    }
    return rec;
  }

  /**
   * 异步自检（阶段 H / P0-1）：真实 HTTP 比对服务（CLIP / 人脸特征）走这里。
   * 不改 check() 的同步契约——原有生成链路与单测行为完全不变；
   * 未配置异步 provider 时原样退回同步路径（继续 degraded，绝不假装通过）。
   */
  async checkAsync(opts = {}) {
    const provider = this.#asyncProvider(opts.providerName ?? null);
    if (!provider) return this.check(opts);
    const r = await provider.compareAsync({
      reference: opts.reference ?? null,
      candidate: opts.candidate ?? null,
      generatedUrl: opts.generatedUrl ?? null,
    });
    return this.check({
      ...opts,
      providerName: opts.providerName ?? provider.name,
      precomputed: {
        score: typeof r?.score === 'number' ? r.score : null,
        dimensions: r?.dimensions ?? {},
        reason: r?.reason ?? null,
        provider: provider.name,
      },
    });
  }

  /** 找已注册且支持异步比对的 provider；未配置返回 null */
  #asyncProvider(name) {
    if (name) {
      const p = this.providers.get(name);
      return p && typeof p.compareAsync === 'function' ? p : null;
    }
    for (const p of this.providers.values()) {
      if (typeof p.compareAsync === 'function' && p.available !== false) return p;
    }
    return null;
  }

  get(id) {
    const r = db.findOne(COL, (x) => x.id === id);
    if (!r) fail(ERR.NOT_FOUND, '一致性检查记录不存在');
    return r;
  }

  /** 重生成建议：把漂移维度映射到 GenerateService.regenerate 的四种模式 */
  adviceFor(id) {
    const r = this.get(id);
    if (r.verdict !== 'drift') {
      return { check_id: id, verdict: r.verdict, modes: [], note: r.verdict === 'pass' ? '无需重生成' : '需先接入比对服务或人工复核' };
    }
    return {
      check_id: id,
      verdict: r.verdict,
      shot_no: r.shot_no,
      score: r.score,
      threshold: r.threshold,
      weakest_dimension: Object.entries(r.dimensions ?? {}).filter(([, v]) => typeof v === 'number').sort((a, b) => a[1] - b[1])[0]?.[0] ?? null,
      modes: buildAdvice(r.dimensions ?? {}, r.score, r.threshold),
    };
  }

  /** 全项目质检报告：M3 KPI 的可量化出口 */
  report(projectId, { threshold = DEFAULT_THRESHOLD, episode = null } = {}) {
    const all = db.find(COL, (x) => x.project_id === projectId && (!episode || x.episode === episode));
    // 同一镜可能多次生成，取该镜最新一条
    const latest = new Map();
    for (const r of all) {
      const prev = latest.get(r.shot_no);
      if (!prev || r.created_at >= prev.created_at) latest.set(r.shot_no, r);
    }
    const rows = [...latest.values()];
    const scored = rows.filter((r) => typeof r.score === 'number');
    const passed = rows.filter((r) => r.verdict === 'pass');
    const drifted = rows.filter((r) => r.verdict === 'drift');
    const degraded = rows.filter((r) => r.verdict === 'degraded');
    const avg = scored.length ? round(scored.reduce((a, r) => a + r.score, 0) / scored.length, 4) : null;
    const passRate = rows.length ? round(passed.length / rows.length, 4) : null;

    return {
      project_id: projectId,
      episode,
      threshold,
      total_shots: rows.length,
      scored: scored.length,
      passed: passed.length,
      drifted: drifted.length,
      degraded: degraded.length,
      pass_rate: passRate,
      avg_score: avg,
      kpi_target: DEFAULT_THRESHOLD,
      kpi_met: avg !== null && avg >= DEFAULT_THRESHOLD && degraded.length === 0,
      blockers: [
        ...drifted.map((r) => ({ type: 'drift', shot_no: r.shot_no, score: r.score })),
        ...degraded.map((r) => ({ type: 'degraded', shot_no: r.shot_no, note: r.note })),
      ],
      by_asset: groupBy(rows, (r) => r.asset_code ?? '未指定'),
      by_episode: groupBy(rows, (r) => r.episode ?? '未知'),
      drift_shots: drifted.map((r) => ({ shot_no: r.shot_no, score: r.score, advice: r.advice })),
      manual_review_shots: degraded.map((r) => r.shot_no),
    };
  }

  /** 生成链路调用：把 MOCK 降级与真实比对统一成一份结果 */
  postGenerate({ projectId, shotNo, assetCode, generatedUrl, generationId, reference, candidate, similarityScore }) {
    return this.check({
      projectId, shotNo, assetCode, generatedUrl, generationId,
      reference, candidate, similarityScore,
      strict: false,
    });
  }
}

function normalizeForStore(f) {
  const x = normFeatures(f);
  return {
    locks: [...asSet(x.locks)],
    emotion_codes: [...asSet(x.emotion)],
    lighting_codes: [...asSet(x.lighting)],
    style_code: [...asSet(x.style)],
  };
}

function episodeOf(shotNo) {
  const m = /^(E\d+)/i.exec(String(shotNo ?? ''));
  return m ? m[1].toUpperCase() : '未分集';
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([key, list]) => {
    const sc = list.filter((x) => typeof x.score === 'number');
    return {
      key,
      total: list.length,
      passed: list.filter((x) => x.verdict === 'pass').length,
      drifted: list.filter((x) => x.verdict === 'drift').length,
      degraded: list.filter((x) => x.verdict === 'degraded').length,
      avg_score: sc.length ? round(sc.reduce((a, x) => a + x.score, 0) / sc.length, 4) : null,
    };
  }).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** 按最低维度给建议，映射到四种重生成粒度（§3.4） */
function buildAdvice(dimensions, score, threshold) {
  const numeric = Object.entries(dimensions ?? {}).filter(([, v]) => typeof v === 'number');
  const weakest = numeric.sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'locks';
  const gap = round(Math.max(0, threshold - (score ?? 0)), 4);
  const modes = [];
  if (weakest === 'locks' || gap > 0.15) {
    modes.push({ mode: 'change_reference', priority: 1, reason: '连续性锁/角色外观偏离，优先补强参考图与资产锁' });
  }
  if (weakest === 'lighting' || weakest === 'style') {
    modes.push({ mode: 'change_prompt', priority: 2, reason: '光影或风格维度偏离，需重写提示词并重跑编译器' });
  }
  if (weakest === 'emotion') {
    modes.push({ mode: 'change_prompt', priority: 2, reason: '情绪表演偏离，需重新指定情绪卡与微表情时间轴' });
  }
  modes.push({ mode: 'resample', priority: 3, reason: '同参重抽一次，排除随机种子导致的偶发漂移' });
  if (gap > 0.25) {
    modes.push({ mode: 'change_model', priority: 4, reason: '分差过大，建议换一致性更强的图片/视频模型' });
  }
  return modes.sort((a, b) => a.priority - b.priority);
}

export const consistencyChecker = new ConsistencyChecker();
export default consistencyChecker;
