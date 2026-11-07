/**
 * 生成服务：把「编译 → 预扣 → 调用 → 结算/退款 → 落快照 → 一致性自检」串成一条不可跳过的链。
 *
 * 这是钱与算力交汇的唯一位置。任何生成（图/视频/音频/文本）都必须走这里：
 *   - 先编译（12 校验）
 *   - 再预扣（余额不足直接失败，不花钱）
 *   - 调算力（唯一出口 RelayAdapter，带签名）
 *   - 成功按真实消耗结算、失败全额退回
 *   - 落资产版本快照（保证后续改资产不污染已生成镜头）
 */
import compiler from '../compiler/PromptCompiler.js';
import relay from '../relay/RelayAdapter.js';
import ledger from '../ledger/Ledger.js';
import assetLibrary from '../assets/AssetLibrary.js';
import consistencyChecker from '../qc/ConsistencyChecker.js';
import { db } from '../store/db.js';
import { logger } from '../core/redact.js';
import { newId, nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import objectStore from '../storage/ObjectStore.js';

const COL = 'generations';

/**
 * 产物归档（V4.8）：上游给的是临时外链，既会过期，域名也不在小程序白名单里
 * （<image>/<video> 根本拉不到）。把内容转存到自己的云存储桶，换成 cloud:// 才能长期可看。
 *
 * 失败不影响生成结果：拿不到归档就保留原地址，并在日志里如实记一笔。
 */
async function archiveRemote(url, kind) {
  if (!/^https?:\/\//i.test(String(url || ''))) return '';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return '';
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const ext = kind === 'video'
      ? '.mp4'
      : ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg';
    const saved = await objectStore.put(buf, {
      ext,
      mime: ct || (kind === 'video' ? 'video/mp4' : 'image/jpeg'),
      prefix: kind === 'video' ? 'clips' : 'frames',
    });
    return saved.provider === 'cloud' ? saved.url : '';
  } catch (err) {
    logger.warn(`[generate] 产物归档失败，保留上游临时地址：${err?.message || err}`);
    return '';
  }
}

export class GenerateService {
  /**
   * @param {object} p
   *  userId, projectId, kind('image'|'video'|'audio'|'chat'),
   *  compileRequest（见 PromptCompiler 输入契约）,
   *  purpose('preview'|'delivery'), idemKey, meta
   */
  async run({
    userId,
    projectId,
    kind,
    compileRequest,
    purpose = 'preview',
    idemKey = null,
    meta = {},
  }) {
    const available = ledger.balance(userId);

    // 1) 编译（12 校验在此完成）
    const payload = compiler.compile({ ...compileRequest, kind, available_credits: available, options: { ...(compileRequest.options ?? {}), purpose } });

    // 2) 预扣
    const hold = ledger.hold({
      userId,
      points: payload.estimated_credits,
      refType: kind,
      refId: meta.shotNo ?? payload.shot_no ?? null,
      idemKey,
    });

    const rec = db.insert(COL, {
      id: newId('gen'),
      user_id: userId,
      project_id: projectId,
      kind,
      purpose,
      shot_no: meta.shotNo ?? payload.shot_no ?? null,
      model: payload.target_model,
      estimated_credits: payload.estimated_credits,
      hold_id: hold.hold?.id ?? null,
      prompt_zh: payload.prompt_zh,
      prompt_en: payload.prompt_en,
      cards: payload.cards,
      status: 'running',
      created_at: nowIso(),
    });

    try {
      // 3) 调用（唯一出口）
      const res = await relay.call(payload, { purpose });

      // 4) 落资产快照
      if (meta.assetsSnapshot) {
        assetLibrary.snapshot({ projectId, shotNo: meta.shotNo, assets: meta.assetsSnapshot });
      }

      // 4.5) 产物归档：上游外链 → 自己的云存储（cloud:// 才能在小程序里长期可看）
      let finalUrl = res.url;
      if (kind === 'image' || kind === 'video') {
        const archived = await archiveRemote(res.url, kind);
        if (archived) finalUrl = archived;
      }

      // 5) 一致性自检（图片/视频）：V3.3 起走独立质检服务，绝不假装通过
      let qc = null;
      if (kind === 'image' || kind === 'video') {
        qc = consistencyChecker.postGenerate({
          projectId,
          shotNo: meta.shotNo ?? payload.shot_no,
          assetCode: meta.primaryAssetCode ?? null,
          generatedUrl: res.url,
          generationId: rec.id,
          reference: meta.reference ?? buildReferenceFeatures(compileRequest, payload),
          candidate: meta.candidate ?? null, // 真实场景由 CLIP/人脸服务反推；未接入时保持 null
          similarityScore: meta.similarityScore ?? null,
        });
        if (qc.verdict === 'degraded') payload.compile_warnings.push(`一致性待人工复核：${qc.note ?? '未接入图像比对'}`);
        if (qc.verdict === 'drift') payload.compile_warnings.push(`一致性分 ${qc.score} 低于阈值，建议按镜号重生成`);
      }

      // 6) 结算
      const settle = ledger.settle(hold.hold.id, res.actual_credits);
      db.update(COL, rec.id, {
        status: 'done',
        result_url: finalUrl,
        source_url: finalUrl === res.url ? null : res.url,
        actual_credits: res.actual_credits,
        refunded: settle.refunded,
        seed: res.seed ?? payload.params?.seed ?? null,
        consistency: qc ? { check_id: qc.id, verdict: qc.verdict, score: qc.score, provider: qc.provider } : null,
        finished_at: nowIso(),
      });
      logger.info('生成完成', {
        kind,
        model: payload.target_model,
        credits: res.actual_credits,
        balance: settle.balance,
      });
      return {
        ok: true,
        generationId: rec.id,
        url: finalUrl,
        sourceUrl: finalUrl === res.url ? null : res.url,
        text: res.text,
        mock: !!res.mock,
        credits: res.actual_credits,
        refunded: settle.refunded,
        balance: settle.balance,
        consistency: qc,
        payload,
      };
    } catch (e) {
      // 失败全额退回
      if (hold.hold?.id) ledger.release(hold.hold.id, 'failed');
      db.update(COL, rec.id, { status: 'failed', error_code: e.code ?? 'UNKNOWN', error_msg: e.message, finished_at: nowIso() });
      logger.error('生成失败，已全额退回', { kind, code: e.code, msg: e.message });
      throw e;
    }
  }

  /** 按镜号重生成（四种粒度：同参重抽 / 改提示词 / 换参考图 / 换模型） */
  async regenerate({ userId, projectId, generationId, mode = 'resample', patch = {} }) {
    const old = db.findOne(COL, (g) => g.id === generationId);
    if (!old) fail(ERR.NOT_FOUND, '生成记录不存在');
    const idemKey = `regen:${generationId}:${mode}:${Object.keys(patch).length}`;
    const base = {
      kind: old.kind,
      project: patch.project ?? {},
      shot: patch.shot ?? {},
      assets: patch.assets ?? {},
      model: old.model,
      shot_no: old.shot_no,
    };
    if (mode === 'resample') {
      // 同参重抽：换 seed
      return this.run({
        userId,
        projectId,
        kind: old.kind,
        purpose: old.purpose,
        idemKey,
        meta: { shotNo: old.shot_no, take: (old.take ?? 0) + 1 },
        compileRequest: { ...patch, options: { seed: undefined } },
      });
    }
    if (mode === 'change_prompt') return this.#runPatch({ userId, projectId, old, patch, idemKey, mode });
    if (mode === 'change_reference') return this.#runPatch({ userId, projectId, old, patch, idemKey, mode });
    if (mode === 'change_model') {
      return this.run({
        userId,
        projectId,
        kind: old.kind,
        purpose: old.purpose,
        idemKey,
        meta: { shotNo: old.shot_no },
        compileRequest: { ...patch, model: patch.model },
      });
    }
    fail(ERR.BAD_REQUEST, `未知重生成模式: ${mode}`);
  }

  #runPatch({ userId, projectId, old, patch, idemKey, mode }) {
    return this.run({
      userId,
      projectId,
      kind: old.kind,
      purpose: old.purpose,
      idemKey,
      meta: { shotNo: old.shot_no },
      compileRequest: patch,
    });
  }

  list(projectId, shotNo = null) {
    return db.find(COL, (g) => g.project_id === projectId && (!shotNo || g.shot_no === shotNo));
  }

  get(id) {
    return db.findOne(COL, (g) => g.id === id);
  }
}

/**
 * 由编译输入构造参考特征（资产锁 / 情绪卡 / 光影卡 / 风格）。
 * 真实比对时此对象应与 CLIP/人脸服务从参考图提取的特征对齐；
 * 生成结果侧特征由调用方通过 meta.candidate 传入，未传入即降级为待人工复核。
 */
function buildReferenceFeatures(compileRequest, payload) {
  const assets = compileRequest?.assets ?? {};
  const locks = [];
  for (const group of ['characters', 'scenes', 'props']) {
    for (const a of Object.values(assets[group] ?? {})) {
      for (const l of a?.locks ?? []) locks.push(String(l));
    }
  }
  const emotions = Object.values(compileRequest?.shot?.emotions ?? {}).filter(Boolean).map(String);
  const lighting = [
    ...(compileRequest?.lighting?.codes ?? []),
    ...(Array.isArray(payload?.cards?.lighting) ? payload.cards.lighting : []),
  ].map(String);
  return {
    locks: [...new Set(locks)],
    emotion_codes: [...new Set(emotions)],
    lighting_codes: [...new Set(lighting)],
    style_code: compileRequest?.project?.style_code ?? null,
  };
}

export const generateService = new GenerateService();
export default generateService;
