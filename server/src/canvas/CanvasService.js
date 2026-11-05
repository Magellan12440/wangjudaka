/**
 * PC 无限画布服务（阶段 H / §18.3 第 14 步）。
 *
 * 硬原则（§1.2 / §23）：**DAG JSON 是事实，画布只是渲染层**。
 *  1. 节点定义（id / name / gate / status / 消耗 / 产出）来自 blueprint_runs 与蓝图模板；
 *     布局只能存「坐标 + 视口 + 备注」，永远不能写回节点定义。
 *  2. 保存布局做不可篡改校验：未知节点、夹带 status/name/gate/edges、
 *     越界坐标、非法视口一律拒绝，避免脏布局反向污染 DAG。
 *  3. 依赖边由模板节点顺序推导（模板未来带显式 edges 时优先采用），
 *     画布前端不参与边的生成，只负责把边画出来。
 *
 * 小程序纵向泳道与 PC 无限画布共用同一份 graph() 输出，只是渲染层不同。
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import blueprintEngine from '../pipeline/Blueprint.js';
import consistencyChecker from '../qc/ConsistencyChecker.js';
import { nowIso, round } from '../core/util.js';

const COL = 'canvas_layouts';
export const LAYOUT_SCHEMA = 1;
const COORD_LIMIT = 100000;
const GRID_X = 280;
const GRID_Y = 170;
const PER_ROW = 4;

const ALLOWED_TOP_KEYS = new Set(['nodes', 'viewport', 'note', 'schema']);
/** 这些字段属于 DAG 事实，画布一旦携带即判为越权 */
const FORBIDDEN_NODE_KEYS = new Set([
  'id', 'name', 'status', 'gate', 'can_rerun', 'model_pref', 'resolution',
  'cost_credits', 'error', 'output', 'started_at', 'finished_at',
  'edges', 'out', 'per_shot', 'gate_rule',
]);

export class CanvasService {
  #run(runId) {
    const run = blueprintEngine.get(runId);
    if (!run) fail(ERR.CANVAS_RUN_NOT_FOUND, `蓝图运行不存在: ${runId}`);
    return run;
  }

  #template(run) {
    const tpl = seeds.blueprint(run.template);
    if (!tpl) fail(ERR.CANVAS_RUN_NOT_FOUND, `蓝图模板缺失: ${run.template}`);
    return tpl;
  }

  /** 默认布局：按模板节点顺序铺 4 列网格（确定性，可复现、可单测） */
  autoLayout(runId) {
    const run = this.#run(runId);
    const tplNodes = this.#template(run).nodes ?? [];
    const nodes = {};
    run.nodes.forEach((n, i) => {
      const ti = tplNodes.findIndex((t) => t.id === n.id);
      const idx = ti >= 0 ? ti : i;
      nodes[n.id] = {
        x: 80 + (idx % PER_ROW) * GRID_X,
        y: 80 + Math.floor(idx / PER_ROW) * GRID_Y,
      };
    });
    return {
      run_id: runId,
      schema: LAYOUT_SCHEMA,
      nodes,
      viewport: { x: 0, y: 0, zoom: 1 },
      note: null,
      source: 'auto',
      updated_at: null,
    };
  }

  getLayout(runId) {
    this.#run(runId);
    return db.findOne(COL, (l) => l.run_id === runId);
  }

  /**
   * 校验并保存布局。允许顶层键：nodes / viewport / note / schema。
   * 未提交的节点沿用旧布局或自动坐标，因此前端可以只提交被拖动的节点。
   */
  saveLayout(runId, layout) {
    const run = this.#run(runId);
    const auto = this.autoLayout(runId);
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
      fail(ERR.CANVAS_INVALID_COORD, '布局必须是对象');
    }
    for (const k of Object.keys(layout)) {
      if (!ALLOWED_TOP_KEYS.has(k)) {
        fail(ERR.CANVAS_DAG_IMMUTABLE, `布局不允许携带字段 ${k}（DAG 定义不可由画布修改）`);
      }
    }

    const validIds = new Set(run.nodes.map((n) => n.id));
    if (layout.nodes !== undefined) {
      if (!layout.nodes || typeof layout.nodes !== 'object' || Array.isArray(layout.nodes)) {
        fail(ERR.CANVAS_INVALID_COORD, 'layout.nodes 必须是对象');
      }
      for (const [id, pos] of Object.entries(layout.nodes)) {
        if (!validIds.has(id)) {
          fail(ERR.CANVAS_UNKNOWN_NODE, `画布出现未知节点 ${id}，不能凭空新增 DAG 节点`, {
            validIds: [...validIds],
          });
        }
        if (!pos || typeof pos !== 'object' || Array.isArray(pos)) {
          fail(ERR.CANVAS_INVALID_COORD, `节点 ${id} 坐标必须是 {x, y}`);
        }
        for (const k of Object.keys(pos)) {
          if (FORBIDDEN_NODE_KEYS.has(k)) {
            fail(ERR.CANVAS_DAG_IMMUTABLE, `节点 ${id} 不允许携带 ${k}（节点定义属于 DAG，画布只存坐标）`);
          }
        }
        for (const axis of ['x', 'y']) {
          const v = pos[axis];
          if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) {
            fail(ERR.CANVAS_INVALID_COORD,
              `节点 ${id} 的 ${axis} 必须是有限数且绝对值 ≤ ${COORD_LIMIT}`);
          }
        }
      }
    }

    let viewport = null;
    if (layout.viewport !== undefined) {
      const vp = layout.viewport;
      if (!vp || typeof vp !== 'object' || Array.isArray(vp)) {
        fail(ERR.CANVAS_INVALID_VIEWPORT, 'layout.viewport 必须是对象');
      }
      for (const axis of ['x', 'y']) {
        const v = vp[axis];
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > COORD_LIMIT) {
          fail(ERR.CANVAS_INVALID_VIEWPORT, `视口 ${axis} 必须是有限数`);
        }
      }
      if (typeof vp.zoom !== 'number' || !Number.isFinite(vp.zoom) || vp.zoom < 0.1 || vp.zoom > 4) {
        fail(ERR.CANVAS_INVALID_VIEWPORT, '视口 zoom 必须在 0.1 ~ 4 之间');
      }
      viewport = { x: round(vp.x, 2), y: round(vp.y, 2), zoom: round(vp.zoom, 3) };
    }

    const prev = this.getLayout(runId);
    const base = prev ?? auto;
    const mergedNodes = {};
    for (const n of run.nodes) {
      const p = (layout.nodes && layout.nodes[n.id]) || base.nodes?.[n.id] || auto.nodes[n.id];
      mergedNodes[n.id] = { x: round(p.x, 2), y: round(p.y, 2) };
    }

    const rec = {
      id: `canvas_${runId}`,
      run_id: runId,
      project_id: run.project_id,
      schema: LAYOUT_SCHEMA,
      nodes: mergedNodes,
      viewport: viewport ?? base.viewport ?? auto.viewport,
      note: typeof layout.note === 'string' ? layout.note.slice(0, 500) : (base.note ?? null),
      source: 'user',
      updated_at: nowIso(),
    };
    db.upsert(COL, rec);
    return rec;
  }

  /** 重置为自动布局 */
  resetLayout(runId) {
    this.#run(runId);
    db.remove(COL, `canvas_${runId}`);
    return this.autoLayout(runId);
  }

  /**
   * 合并视图：DAG 事实 + 布局坐标 + 依赖边 + 项目总谱/质检摘要。
   * 小程序泳道与 PC 画布都消费这一份输出。
   */
  graph(runId) {
    const run = this.#run(runId);
    const tpl = this.#template(run);
    const tplNodes = tpl.nodes ?? [];
    const stored = this.getLayout(runId);
    const layout = stored ?? this.autoLayout(runId);
    const gateByNode = new Map((tpl.gates ?? []).map((g) => [g.at, g]));

    const nodes = run.nodes.map((n) => {
      const t = tplNodes.find((x) => x.id === n.id) ?? {};
      const p = layout.nodes?.[n.id] ?? { x: 0, y: 0 };
      const g = gateByNode.get(n.id);
      return {
        id: n.id,
        name: n.name,
        status: n.status,
        gate: !!n.gate,
        can_rerun: !!n.can_rerun,
        model_pref: n.model_pref ?? t.model_pref ?? null,
        resolution: n.resolution ?? t.resolution ?? null,
        out: t.out ?? null,
        per_shot: !!t.per_shot,
        cost_credits: n.cost_credits ?? 0,
        error: n.error ?? null,
        output: n.output ?? null,
        started_at: n.started_at ?? null,
        finished_at: n.finished_at ?? null,
        gate_rule: g ? { rule: g.rule, on_fail: g.on_fail } : null,
        x: p.x,
        y: p.y,
      };
    });

    const explicit = Array.isArray(tpl.edges) ? tpl.edges : null;
    const edges = explicit
      ? explicit.map((e) => ({ from: e.from, to: e.to }))
      : run.nodes.slice(1).map((n, i) => ({ from: run.nodes[i].id, to: n.id }));

    const done = nodes.filter((n) => ['done', 'skipped'].includes(n.status)).length;
    const running = nodes.filter((n) => n.status === 'running').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;

    const planRec = db.findOne('director_plans', (x) => x.project_id === run.project_id);
    const plan = planRec
      ? {
          plan_id: planRec.plan_id,
          plan_version: planRec.plan_version,
          validation: planRec.plan?.validation ?? null,
          stats: planRec.plan?.stats ?? null,
        }
      : null;

    let qcSummary = null;
    try {
      const r = consistencyChecker.report(run.project_id);
      qcSummary = {
        total_shots: r.total_shots,
        pass_rate: r.pass_rate,
        avg_score: r.avg_score,
        kpi_met: r.kpi_met,
        degraded: r.degraded,
        blockers: r.blockers?.length ?? 0,
      };
    } catch {
      qcSummary = null;
    }

    return {
      run_id: run.id,
      project_id: run.project_id,
      template: run.template,
      template_name: tpl.name,
      status: run.status,
      total_credits: run.total_credits ?? 0,
      nodes,
      edges,
      edge_source: explicit ? 'template.edges' : 'template_order',
      gates: tpl.gates ?? [],
      viewport: layout.viewport ?? { x: 0, y: 0, zoom: 1 },
      layout_source: stored ? stored.source ?? 'user' : 'auto',
      layout_updated_at: stored?.updated_at ?? null,
      stats: {
        total: nodes.length,
        done,
        running,
        failed,
        pending: nodes.length - done - running - failed,
        progress: nodes.length ? round(done / nodes.length, 4) : 0,
      },
      plan,
      qc_summary: qcSummary,
      updated_at: run.updated_at ?? null,
    };
  }

  /** 某项目下的画布列表（前端项目切换用） */
  list(projectId) {
    return blueprintEngine.list(projectId).map((r) => ({
      run_id: r.id,
      project_id: r.project_id,
      template: r.template,
      status: r.status,
      total_credits: r.total_credits ?? 0,
      has_layout: Boolean(this.getLayout(r.id)),
      created_at: r.created_at,
    }));
  }
}

export const canvasService = new CanvasService();
export default canvasService;
