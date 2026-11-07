/**
 * Blueprint 引擎：DAG JSON 是事实，画布只是渲染（§1.2 / §14）。
 * 小程序端渲染纵向流程泳道，PC 端渲染无限画布，两端共用同一套 API。
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import compiler from '../compiler/PromptCompiler.js';
import { modelRegistry } from '../relay/ModelRegistry.js';

/** 运行集合名（Blueprint 与 RunSync 共用，避免出现 db.update('runs') 这类空集合写入） */
export const RUN_COL = 'blueprint_runs';
const COL = RUN_COL;

export class BlueprintEngine {
  templates() {
    return seeds.blueprintTemplates.map((t) => ({
      code: t.code,
      name: t.name,
      desc: t.desc,
      nodes: t.nodes.map((n) => ({ id: n.id, name: n.name, gate: !!n.gate, can_rerun: !!n.can_rerun })),
    }));
  }

  /** 创建一次运行（项目 + 模板） */
  createRun({ projectId, templateCode = 'BP_ONESHOT' }) {
    const tpl = seeds.blueprint(templateCode);
    if (!tpl) fail(ERR.NOT_FOUND, `蓝图模板不存在: ${templateCode}`);
    const nodes = tpl.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      status: 'pending',
      gate: !!n.gate,
      can_rerun: !!n.can_rerun,
      model_pref: n.model_pref ?? null,
      resolution: n.resolution ?? null,
      started_at: null,
      finished_at: null,
      cost_credits: 0,
      error: null,
    }));
    return db.insert(COL, {
      id: newId('run'),
      project_id: projectId,
      template: templateCode,
      nodes,
      gates: tpl.gates ?? [],
      status: 'pending',
      total_credits: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  get(runId) {
    return db.findOne(COL, (r) => r.id === runId);
  }

  list(projectId) {
    return db.find(COL, (r) => r.project_id === projectId);
  }

  /** 推进节点状态 */
  markNode(runId, nodeId, { status, costCredits = 0, error = null, output = null }) {
    const run = this.get(runId);
    if (!run) fail(ERR.NOT_FOUND, '运行不存在');
    const nodes = [...run.nodes];
    const i = nodes.findIndex((n) => n.id === nodeId);
    if (i < 0) fail(ERR.NOT_FOUND, `节点不存在: ${nodeId}`);
    nodes[i] = {
      ...nodes[i],
      status,
      cost_credits: (nodes[i].cost_credits ?? 0) + costCredits,
      error,
      output: output ?? nodes[i].output,
      started_at: nodes[i].started_at ?? nowIso(),
      finished_at: ['done', 'failed', 'skipped'].includes(status) ? nowIso() : null,
    };
    const total = nodes.reduce((a, n) => a + (n.cost_credits ?? 0), 0);
    const allDone = nodes.every((n) => ['done', 'skipped'].includes(n.status));
    return db.update(COL, runId, {
      nodes,
      total_credits: total,
      status: allDone ? 'done' : status === 'failed' ? 'failed' : 'running',
      updated_at: nowIso(),
    });
  }

  /** 下一个待执行节点 */
  nextNode(runId) {
    const run = this.get(runId);
    if (!run) return null;
    return run.nodes.find((n) => n.status === 'pending') ?? null;
  }

  /**
   * OneShot 提案卡：用户给一句话 → 产出成本与时长预估（§1.3）。
   * 关键：先给报价，用户确认后才开始花钱。
   */
  quote({ prompt, styleCode, totalMinutes, episodeSec = 90, episodeCount = null, aspect = '9:16', quality = '1080p', preset = 'balanced', videoType = 'dynamic' }) {
    const style = seeds.style(styleCode) ?? seeds.style('STY-DUSHI');
    // 集数以用户显式选择为准。用 totalMinutes 反推会在自定义场景下失真：
    // 3 集 × 90 秒 = 4.5 分钟，取整成 5 分钟再反推就变成 4 集。
    const epByMinutes = Math.max(1, Math.ceil((Number(totalMinutes) * 60) / Number(episodeSec)));
    const episodes = Number.isFinite(Number(episodeCount)) && Number(episodeCount) >= 1
      ? Math.min(200, Math.floor(Number(episodeCount)))
      : epByMinutes;
    const avgShotLen = Math.min(style.avg_shot_len, 10); // 视频模型单镜上限 10 秒
    const shotsPerEp = Math.ceil(episodeSec / avgShotLen);
    const totalShots = episodes * shotsPerEp;

    const imgModel = modelRegistry.get(modelRegistry.defaultFor('image'));
    const vidModel = modelRegistry.get(modelRegistry.defaultFor('video'));
    const llmModel = modelRegistry.get(modelRegistry.defaultFor('chat'));

    const imgCredits = compiler.estimate({ kind: 'image', model: imgModel, quality });
    const vidCredits = compiler.estimate({ kind: 'video', model: vidModel, duration: avgShotLen, quality });
    const llmCredits = compiler.estimate({ kind: 'chat', model: llmModel, tokens: 12000 });

    // 预览档策略：先用低成本跑通，定稿再出高质量（可省 40%~50%）
    const strategy = {
      fast: { imgRatio: 0.2, vidRatio: 0.4, label: '极速（全程预览档）' },
      balanced: { imgRatio: 0.2, vidRatio: 0.4, label: '均衡（720P 审阅 + 1080P 定稿）' },
      premium: { imgRatio: 1, vidRatio: 1, label: '高质（全程定稿档）' },
    }[preset] ?? { imgRatio: 0.2, vidRatio: 0.4, label: '均衡' };

    // 静态漫剧 / 解说漫不走逐镜图生视频，视频成本按比例折减
    const videoFactor = videoType === 'static' ? 0 : videoType === 'narration' ? 0.12 : 1;

    const estCredits = Math.ceil(
      totalShots * (imgCredits * (1 + strategy.imgRatio) + vidCredits * (1 + strategy.vidRatio) * videoFactor) + llmCredits
    );
    const estMinutes = Math.ceil(totalShots * (videoFactor ? 1.2 : 0.35)); // 静态漫剧无需逐镜等视频

    return {
      prompt,
      preset,
      strategy: strategy.label,
      style: { code: style.code, name: style.name },
      aspect,
      quality,
      video_type: videoType,
      episodes,
      episode_sec: episodeSec,
      shots_per_episode: shotsPerEp,
      total_shots: totalShots,
      avg_shot_len: avgShotLen,
      est_credits: estCredits,
      est_cny: +(estCredits * 1).toFixed(2), // 1 点 = 1 元
      est_minutes: estMinutes,
      breakdown: {
        image_per_shot: imgCredits,
        video_per_shot: vidCredits,
        llm_total: llmCredits,
      },
      note: videoType === 'static'
        ? '静态漫剧只出关键帧与配音，成本约为动态漫剧的三分之一；需要动作时再单独补出视频'
        : '预览档先行可在确认分镜后仅对定稿镜头出 1080P，通常可省 40%~50% 成本',
    };
  }
}

export const blueprintEngine = new BlueprintEngine();
export default blueprintEngine;
