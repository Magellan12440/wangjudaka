/**
 * 运行进度同步：节点状态由「真实产物」驱动，而不是手工点“完成”。
 *
 * 规则：只有对应产物存在时才把节点标记为 done，其余保持 pending。
 * 这样小程序上的 12 节点泳道不会假装进度，也不会出现“点一下就出片”的假交互。
 * 媒体节点（N06/N08/N09/N10）需要生产 Worker 写入真实生成记录后才会自动点亮。
 */
import { db } from '../store/db.js';
import blueprintEngine, { RUN_COL } from './Blueprint.js';
import { nowIso } from '../core/util.js';

const FINAL = ['done', 'skipped'];

function artifactState(projectId) {
  const project = db.findOne('projects', (x) => x.id === projectId);
  const plan = db.findOne('director_plans', (x) => x.project_id === projectId);
  const assets = db.find('assets', (a) => a.project_id === projectId);
  const gens = db.find('generations', (g) => g.project_id === projectId);
  const packs = db.find('compliance_packs', (p) => p.project_id === projectId);
  const dists = db.find('distributions', (d) => d.project_id === projectId);
  const shots = plan?.storyboard?.shots ?? [];

  const hasKind = (kind) => gens.some((g) => g.kind === kind && (g.status === 'done' || g.status === 'success'));
  // 节点顺序与 seeds/blueprint_templates.json 的 BP_ONESHOT 对齐：
  // N01 需求解析 / N02 大纲人物 / N03 剧本 / N04 节奏 / N05 分镜表 /
  // N06 资产 / N07 关键帧 / N08 视频 / N09 配音配乐 / N10 混音 / N11 剪辑 / N12 交付
  return {
    N01: Boolean(project && (project.spec?.prompt || project.title)),
    N02: Boolean(plan?.outline),
    N03: Boolean(plan?.script?.episodes?.length),
    N04: Boolean(plan?.plan?.validation?.ok),
    N05: shots.length > 0,
    N06: assets.length > 0,
    N07: assets.some((a) => a.image_url) || hasKind('image'),
    N08: hasKind('video'),
    N09: hasKind('audio') || hasKind('music'),
    N10: Boolean(project?.mix?.output_url),
    N11: Boolean(project?.render?.output_url || project?.delivery?.video_url),
    N12: packs.length > 0 || dists.length > 0,
  };
}

/** 就地同步一个 run；无变化时不写盘，返回最新 run */
export function syncRun(runId) {
  const run = blueprintEngine.get(runId);
  if (!run) return null;
  const ready = artifactState(run.project_id);
  const ts = nowIso();
  let changed = false;
  const nodes = run.nodes.map((n) => {
    if (!ready[n.id] || n.status === 'done') return n;
    changed = true;
    return {
      ...n,
      status: 'done',
      started_at: n.started_at ?? ts,
      finished_at: ts,
      output: n.output ?? { source: 'artifact', synced_at: ts },
    };
  });
  if (!changed) return run;

  const total = nodes.reduce((a, n) => a + (n.cost_credits ?? 0), 0);
  const allDone = nodes.every((n) => FINAL.includes(n.status));
  const anyProgress = nodes.some((n) => FINAL.includes(n.status));
  return db.update(RUN_COL, runId, {
    nodes,
    total_credits: total,
    status: allDone ? 'done' : anyProgress ? 'running' : 'pending',
    updated_at: ts,
  }) ?? { ...run, nodes, total_credits: total, updated_at: ts };
}

/** 项目下所有 run 同步（通常只有一个） */
export function syncProjectRuns(projectId) {
  return blueprintEngine.list(projectId).map((r) => syncRun(r.id));
}

/** 进度摘要，给小程序头部与 PC 画布共用 */
export function runProgress(run) {
  if (!run) return { done: 0, total: 12, percent: 0, next: null };
  const total = run.nodes.length || 12;
  const done = run.nodes.filter((n) => FINAL.includes(n.status)).length;
  const next = run.nodes.find((n) => n.status === 'pending') ?? null;
  return {
    done,
    total,
    percent: Math.round((done / total) * 100),
    next: next ? { id: next.id, name: next.name } : null,
  };
}
