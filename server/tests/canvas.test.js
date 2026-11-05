/** 阶段 H：PC 无限画布服务 —— DAG 是事实、布局只是渲染层 */
import test from 'node:test';
import assert from 'node:assert/strict';
import canvasService from '../src/canvas/CanvasService.js';
import blueprintEngine from '../src/pipeline/Blueprint.js';
import { ERR } from '../src/core/errors.js';

const P = 'canvas_proj_' + Date.now();

function newRun(tpl = 'BP_ONESHOT') {
  return blueprintEngine.createRun({ projectId: P, templateCode: tpl });
}
function rejects(code, fn) {
  assert.throws(fn, (e) => e.code === code, `期望错误码 ${code}`);
}

test('自动布局：节点数与 DAG 一致，坐标确定性且互不重叠', () => {
  const run = newRun();
  const a = canvasService.autoLayout(run.id);
  const b = canvasService.autoLayout(run.id);
  assert.equal(Object.keys(a.nodes).length, run.nodes.length);
  assert.deepEqual(a.nodes, b.nodes);
  assert.equal(a.source, 'auto');
  const pts = Object.values(a.nodes).map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(pts).size, pts.length);
});

test('graph：节点定义来自 DAG，边由模板顺序推导', () => {
  const run = newRun();
  const g = canvasService.graph(run.id);
  assert.equal(g.nodes.length, 12);
  assert.equal(g.edges.length, 11);
  assert.equal(g.edge_source, 'template_order');
  assert.equal(g.edges[0].from, 'N01');
  assert.equal(g.edges[0].to, 'N02');
  assert.equal(g.nodes[0].name, '需求解析');
  assert.equal(g.nodes.find((n) => n.id === 'N04').gate, true);
  assert.ok(g.nodes.find((n) => n.id === 'N04').gate_rule.rule.includes('hook'));
});

test('graph：未保存布局时 source=auto，带默认视口与统计', () => {
  const g = canvasService.graph(newRun().id);
  assert.equal(g.layout_source, 'auto');
  assert.equal(g.viewport.zoom, 1);
  assert.equal(g.stats.total, 12);
  assert.equal(g.stats.done, 0);
  assert.equal(g.stats.progress, 0);
  assert.equal(g.plan, null);
});

test('保存布局：坐标与视口持久化，graph 读到 source=user', () => {
  const run = newRun();
  const saved = canvasService.saveLayout(run.id, {
    nodes: { N01: { x: 111, y: 222 }, N02: { x: 400, y: 250 } },
    viewport: { x: 12, y: -8, zoom: 1.5 },
    note: '手工排版',
  });
  assert.equal(saved.source, 'user');
  assert.equal(saved.nodes.N01.x, 111);
  assert.equal(saved.note, '手工排版');
  assert.equal(Object.keys(saved.nodes).length, 12, '未提交的节点要自动补齐');

  const g = canvasService.graph(run.id);
  assert.equal(g.layout_source, 'user');
  assert.equal(g.nodes.find((n) => n.id === 'N01').x, 111);
  assert.equal(g.viewport.zoom, 1.5);
  assert.equal(g.nodes.find((n) => n.id === 'N02').y, 250);
});

test('保存布局：只提交部分节点时其余沿用旧坐标', () => {
  const run = newRun();
  canvasService.saveLayout(run.id, { nodes: { N01: { x: 10, y: 20 }, N02: { x: 300, y: 20 } } });
  const again = canvasService.saveLayout(run.id, { nodes: { N01: { x: 99, y: 88 } } });
  assert.equal(again.nodes.N01.x, 99);
  assert.equal(again.nodes.N02.x, 300, '未提交的 N02 应保留上次坐标');
});

test('红线：未知节点被拒（画布不能凭空新增 DAG 节点）', () => {
  const run = newRun();
  rejects(ERR.CANVAS_UNKNOWN_NODE, () => canvasService.saveLayout(run.id, {
    nodes: { N99_FAKE: { x: 1, y: 2 } },
  }));
});

test('红线：布局夹带 status / name / gate 等节点定义字段被拒', () => {
  const run = newRun();
  for (const key of ['status', 'name', 'gate', 'cost_credits', 'edges']) {
    rejects(ERR.CANVAS_DAG_IMMUTABLE, () => canvasService.saveLayout(run.id, {
      nodes: { N01: { x: 1, y: 2, [key]: 'done' } },
    }));
  }
});

test('红线：顶层夹带未知字段被拒', () => {
  const run = newRun();
  rejects(ERR.CANVAS_DAG_IMMUTABLE, () => canvasService.saveLayout(run.id, {
    nodes: { N01: { x: 1, y: 2 } }, status: 'done',
  }));
});

test('红线：非有限数 / 越界坐标被拒', () => {
  const run = newRun();
  rejects(ERR.CANVAS_INVALID_COORD, () => canvasService.saveLayout(run.id, {
    nodes: { N01: { x: '100', y: 2 } },
  }));
  rejects(ERR.CANVAS_INVALID_COORD, () => canvasService.saveLayout(run.id, {
    nodes: { N01: { x: Infinity, y: 2 } },
  }));
  rejects(ERR.CANVAS_INVALID_COORD, () => canvasService.saveLayout(run.id, {
    nodes: { N01: { x: 9999999, y: 2 } },
  }));
});

test('红线：zoom 越界 / 视口非数被拒', () => {
  const run = newRun();
  rejects(ERR.CANVAS_INVALID_VIEWPORT, () => canvasService.saveLayout(run.id, {
    nodes: {}, viewport: { x: 0, y: 0, zoom: 9 },
  }));
  rejects(ERR.CANVAS_INVALID_VIEWPORT, () => canvasService.saveLayout(run.id, {
    nodes: {}, viewport: { x: 'a', y: 0, zoom: 1 },
  }));
});

test('重置布局：回到 auto 且节点数不变', () => {
  const run = newRun();
  canvasService.saveLayout(run.id, { nodes: { N01: { x: 777, y: 666 } } });
  const reset = canvasService.resetLayout(run.id);
  assert.equal(reset.source, 'auto');
  assert.equal(reset.nodes.N01.x, 80);
  assert.equal(canvasService.graph(run.id).layout_source, 'auto');
  assert.equal(Object.keys(reset.nodes).length, 12);
});

test('推进节点状态后 graph.stats 同步（证明 DAG 是唯一事实）', () => {
  const run = newRun();
  blueprintEngine.markNode(run.id, 'N01', { status: 'done', costCredits: 3 });
  blueprintEngine.markNode(run.id, 'N02', { status: 'running' });
  const g = canvasService.graph(run.id);
  assert.equal(g.stats.done, 1);
  assert.equal(g.stats.running, 1);
  assert.equal(g.total_credits, 3);
  assert.equal(g.nodes.find((n) => n.id === 'N01').status, 'done');
  assert.equal(Math.round(g.stats.progress * 100), 8);
});

test('list：按项目返回运行并标注 has_layout', () => {
  const run = newRun('BP_PREVIEW');
  canvasService.saveLayout(run.id, { nodes: { N02: { x: 5, y: 5 } } });
  const list = canvasService.list(P);
  assert.ok(list.length >= 1);
  const hit = list.find((r) => r.run_id === run.id);
  assert.equal(hit.has_layout, true);
  assert.equal(hit.template, 'BP_PREVIEW');
});

test('graph：不存在的运行报 CANVAS_RUN_NOT_FOUND', () => {
  rejects(ERR.CANVAS_RUN_NOT_FOUND, () => canvasService.graph('run_not_exist'));
});
