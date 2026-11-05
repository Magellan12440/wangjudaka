/* PC 无限画布 · 渲染层
 * DAG JSON 是事实：节点定义全部来自 /api/canvas/:runId/graph，
 * 本文件只负责把坐标画出来、把拖拽后的坐标存回去，从不修改节点定义。
 */
(function () {
  'use strict';
  var LW = window.LW;
  var api = LW.api, qs = LW.qs, esc = LW.esc, toast = LW.toast;

  var API = {
    projects: function (uid) { return `/api/projects?userId=${encodeURIComponent(uid)}`; },
    createProject: '/api/projects',
    blueprints: '/api/blueprints',
    runs: '/api/runs',
    canvasRuns: function (pid) { return `/api/canvas/runs?projectId=${encodeURIComponent(pid)}`; },
    graph: function (id) { return `/api/canvas/${id}/graph`; },
    layout: function (id) { return `/api/canvas/${id}/layout`; },
    layoutReset: function (id) { return `/api/canvas/${id}/layout/reset`; },
    node: function (rid, nid) { return `/api/runs/${rid}/nodes/${nid}`; }
  };

  var NODE_W = 220, NODE_H = 92;
  var STATUS_LABEL = { pending: '待执行', running: '进行中', done: '已完成', failed: '失败', skipped: '已跳过' };
  var STATUS_BADGE = { pending: '', running: 'info', done: 'ok', failed: 'err', skipped: '' };

  var state = {
    userId: 'pc_user',
    projectId: '',
    runId: LW.param('runId'),
    templates: [],
    runs: [],
    graph: null,
    selected: null,
    zoom: 1, panX: 40, panY: 40,
    drag: null,
    dirty: false
  };

  async function init() {
    bind();
    try {
      await loadTemplates();
      await loadProjects();
      if (state.runId) await loadGraph();
    } catch (e) { toast(e.message, 'err'); }
    render();
  }

  /* ---------- 数据加载 ---------- */
  async function loadTemplates() {
    var list = await api(API.blueprints);
    state.templates = list;
    qs('#tplSel').innerHTML = list.map(function (t) {
      return '<option value="' + esc(t.code) + '">' + esc(t.name) + '</option>';
    }).join('');
  }

  async function loadProjects() {
    var list = await api(API.projects(state.userId));
    var sel = qs('#projectSel');
    if (!list.length) {
      sel.innerHTML = '<option value="">（暂无项目，请点「+ 演示项目」）</option>';
      state.projectId = '';
      state.runId = '';
      state.graph = null;
      return;
    }
    sel.innerHTML = list.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.title) + ' · ' + esc(String(p.id).slice(-6)) + '</option>';
    }).join('');
    state.projectId = list[0].id;
    sel.value = state.projectId;
    await loadRuns();
  }

  async function loadRuns() {
    var sel = qs('#runSel');
    if (!state.projectId) {
      sel.innerHTML = '<option value="">—</option>';
      state.runId = ''; state.graph = null;
      return;
    }
    var list = await api(API.canvasRuns(state.projectId));
    state.runs = list;
    sel.innerHTML = list.length
      ? list.map(function (r) { return '<option value="' + esc(r.run_id) + '">' + esc(r.template) + ' · ' + esc(r.status) + ' · ' + esc(String(r.run_id).slice(-6)) + '</option>'; }).join('')
      : '<option value="">（该项目暂无运行）</option>';
    state.runId = list.length ? list[list.length - 1].run_id : '';
    if (list.length) sel.value = state.runId;
    if (state.runId) await loadGraph();
    else { state.graph = null; render(); }
  }

  async function loadGraph() {
    if (!state.runId) { state.graph = null; render(); return; }
    var g = await api(API.graph(state.runId));
    state.graph = g;
    state.zoom = (g.viewport && g.viewport.zoom) || 1;
    state.panX = (g.viewport && Number(g.viewport.x)) || 0;
    state.panY = (g.viewport && Number(g.viewport.y)) || 0;
    state.selected = null;
    setDirty(false);
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var g = state.graph;
    qs('#emptyHint').classList.toggle('hidden', Boolean(g));
    updateStats(g);
    drawEdges(g);
    drawNodes(g);
    applyTransform();
    renderInspector(state.selected);
  }

  function updateStats(g) {
    qs('#stTotal').textContent = g ? g.stats.total : 0;
    qs('#stDone').textContent = g ? g.stats.done : 0;
    qs('#stProgress').textContent = g ? Math.round(g.stats.progress * 100) + '%' : '0%';
    qs('#stCredits').textContent = g ? g.total_credits : 0;
    qs('#infoTpl').textContent = g ? g.template_name + ' / ' + g.template : '—';
    qs('#infoStatus').textContent = g ? g.status : '—';
    qs('#infoPlan').textContent = g && g.plan ? g.plan.plan_id + ' v' + g.plan.plan_version : '未生成';
    qs('#infoQc').textContent = g && g.qc_summary
      ? g.qc_summary.total_shots + ' 镜 / 通过率 ' + (g.qc_summary.pass_rate === null ? '—' : g.qc_summary.pass_rate) + ' / KPI ' + (g.qc_summary.kpi_met ? '达标' : '未达标')
      : '暂无质检数据';
    qs('#infoLayout').textContent = g
      ? (g.layout_source === 'auto' ? '自动布局（未保存）' : '用户布局 ' + LW.fmtTime(g.layout_updated_at))
      : '—';
    qs('#edgeInfo').textContent = g ? g.edges.length + ' 条依赖边，来源：' + (g.edge_source === 'template.edges' ? '模板显式定义' : '模板节点顺序') : '—';
    qs('#gateInfo').innerHTML = g && g.gates.length
      ? g.gates.map(function (x) {
          return '<div style="margin-bottom:8px"><b>' + esc(x.at) + '</b> ' + esc(x.rule) +
            '<br><span class="muted">未过：' + esc(x.on_fail) + '</span></div>';
        }).join('')
      : '<span class="muted">该模板无闸门</span>';
  }

  function center(n) { return { x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 }; }

  function drawEdges(g) {
    var layer = qs('#edgeLayer');
    layer.innerHTML = '';
    if (!g) return;
    var byId = {};
    g.nodes.forEach(function (n) { byId[n.id] = n; });
    g.edges.forEach(function (e) {
      var a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      var p1 = center(a), p2 = center(b);
      var dx = p2.x - p1.x;
      var off = Math.max(60, Math.abs(dx) * 0.4) * (dx >= 0 ? 1 : -1);
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M ' + p1.x + ',' + p1.y + ' C ' + (p1.x + off) + ',' + p1.y + ' ' + (p2.x - off) + ',' + p2.y + ' ' + p2.x + ',' + p2.y);
      path.setAttribute('class', 'edge' + (b.gate ? ' gate' : ''));
      path.setAttribute('marker-end', 'url(#arrow)');
      layer.appendChild(path);
    });
  }

  function drawNodes(g) {
    var layer = qs('#nodesLayer');
    layer.innerHTML = '';
    if (!g) return;
    g.nodes.forEach(function (n) {
      var d = document.createElement('div');
      d.className = 'node st-' + esc(n.status) + (state.selected === n.id ? ' selected' : '');
      d.setAttribute('data-id', n.id);
      d.style.left = n.x + 'px';
      d.style.top = n.y + 'px';
      d.innerHTML =
        '<div class="nid">' + esc(n.id) + (n.gate ? ' <span class="gate-flag">◆ 闸门</span>' : '') + '</div>' +
        '<div class="nname">' + esc(n.name) + '</div>' +
        '<div class="nmeta"><span class="badge ' + STATUS_BADGE[n.status] + '">' + esc(STATUS_LABEL[n.status] || n.status) + '</span>' +
        (n.model_pref ? '<span class="badge info">' + esc(n.model_pref) + '</span>' : '') +
        (n.per_shot ? '<span class="badge">逐镜</span>' : '') +
        '<span class="ncost">' + esc(n.cost_credits) + ' 点</span></div>';
      layer.appendChild(d);
    });
  }

  function renderInspector(id) {
    var panel = qs('#nodePanel');
    var n = id && state.graph ? state.graph.nodes.find(function (x) { return x.id === id; }) : null;
    if (!n) {
      panel.innerHTML = '<p class="hint">点击画布中的节点查看与推进状态。</p>';
      return;
    }
    var opts = Object.keys(STATUS_LABEL).map(function (s) {
      return '<option value="' + s + '"' + (s === n.status ? ' selected' : '') + '>' + STATUS_LABEL[s] + '</option>';
    }).join('');
    panel.innerHTML =
      '<dl class="kv">' +
      '<dt>节点</dt><dd class="mono">' + esc(n.id) + '</dd>' +
      '<dt>名称</dt><dd>' + esc(n.name) + '</dd>' +
      '<dt>当前状态</dt><dd><span class="badge ' + STATUS_BADGE[n.status] + '">' + esc(STATUS_LABEL[n.status] || n.status) + '</span></dd>' +
      '<dt>产出</dt><dd>' + esc(n.out || '—') + '</dd>' +
      '<dt>模型偏好</dt><dd>' + esc(n.model_pref || '默认') + '</dd>' +
      '<dt>画质</dt><dd>' + esc(n.resolution || '默认') + '</dd>' +
      '<dt>累计消耗</dt><dd>' + esc(n.cost_credits) + ' 点</dd>' +
      '<dt>闸门</dt><dd>' + (n.gate_rule ? esc(n.gate_rule.rule) : '无') + '</dd>' +
      '<dt>坐标</dt><dd class="mono">' + esc(n.x) + ', ' + esc(n.y) + '</dd>' +
      '</dl>' +
      '<div class="stack" style="margin-top:12px">' +
      '<div><label class="fld" for="nodeStatus">推进到</label><select id="nodeStatus" style="width:100%">' + opts + '</select></div>' +
      '<div><label class="fld" for="nodeCost">本次消耗点数</label><input id="nodeCost" type="number" min="0" value="0" style="width:100%"></div>' +
      '<button class="btn primary" id="btnPushNode">推进状态</button>' +
      '</div>' +
      (n.can_rerun ? '<div class="notice" style="margin-top:12px">该节点支持重跑；重生成由生成服务按四种模式处理。</div>'
        : '<div class="notice warn" style="margin-top:12px">该节点不可重跑（流程锚点）。</div>');
    qs('#btnPushNode').addEventListener('click', function () { pushNode(n.id); });
  }

  function applyTransform() {
    qs('#world').style.transform = 'translate(' + state.panX + 'px,' + state.panY + 'px) scale(' + state.zoom + ')';
    qs('#zoomText').textContent = Math.round(state.zoom * 100) + '%';
  }

  function setDirty(v) {
    state.dirty = v;
    qs('#dirty').classList.toggle('hidden', !v);
  }

  /* ---------- 交互 ---------- */
  function selectNode(id) {
    state.selected = id;
    LW.qsa('.node').forEach(function (el) { el.classList.toggle('selected', el.getAttribute('data-id') === id); });
    renderInspector(id);
  }

  async function pushNode(id) {
    var status = qs('#nodeStatus').value;
    var cost = Number(qs('#nodeCost').value) || 0;
    try {
      await api(API.node(state.runId, id), { method: 'POST', body: { status: status, costCredits: cost } });
      toast('节点 ' + id + ' 已推进到「' + STATUS_LABEL[status] + '」', 'ok');
      await loadGraph();
      selectNode(id);
    } catch (e) { toast(e.message, 'err'); }
  }

  function onMouseDown(e) {
    if (!state.graph) return;
    var nodeEl = e.target.closest ? e.target.closest('.node') : null;
    if (nodeEl) {
      var id = nodeEl.getAttribute('data-id');
      var n = state.graph.nodes.find(function (x) { return x.id === id; });
      state.drag = { type: 'node', id: id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y, moved: false };
      selectNode(id);
    } else {
      state.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: state.panX, oy: state.panY };
      qs('#viewport').classList.add('grabbing');
    }
    e.preventDefault();
  }

  function onMouseMove(e) {
    var d = state.drag;
    if (!d) return;
    if (d.type === 'pan') {
      state.panX = d.ox + (e.clientX - d.sx);
      state.panY = d.oy + (e.clientY - d.sy);
      applyTransform();
      return;
    }
    var dx = (e.clientX - d.sx) / state.zoom;
    var dy = (e.clientY - d.sy) / state.zoom;
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    var n = state.graph.nodes.find(function (x) { return x.id === d.id; });
    n.x = Math.round(d.ox + dx);
    n.y = Math.round(d.oy + dy);
    var el = qs('.node[data-id="' + d.id + '"]');
    if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    drawEdges(state.graph);
    if (d.moved) setDirty(true);
  }

  function onMouseUp() {
    state.drag = null;
    qs('#viewport').classList.remove('grabbing');
  }

  function onWheel(e) {
    e.preventDefault();
    var f = e.deltaY < 0 ? 1.1 : 0.9;
    state.zoom = Math.min(2.5, Math.max(0.2, state.zoom * f));
    applyTransform();
  }

  function fitView() {
    var g = state.graph;
    var vp = qs('#viewport');
    if (!g || !g.nodes.length) return;
    var xs = g.nodes.map(function (n) { return n.x; });
    var ys = g.nodes.map(function (n) { return n.y; });
    var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
    var maxX = Math.max.apply(null, xs) + NODE_W, maxY = Math.max.apply(null, ys) + NODE_H;
    var w = vp.clientWidth, h = vp.clientHeight;
    var bw = maxX - minX + 80, bh = maxY - minY + 80;
    state.zoom = Math.min(1.2, Math.max(0.2, Math.min(w / bw, h / bh)));
    state.panX = (w - (maxX - minX) * state.zoom) / 2 - minX * state.zoom;
    state.panY = (h - (maxY - minY) * state.zoom) / 2 - minY * state.zoom;
    applyTransform();
  }

  async function saveLayout() {
    if (!state.graph || !state.runId) { toast('没有可保存的画布', 'err'); return; }
    var nodes = {};
    state.graph.nodes.forEach(function (n) { nodes[n.id] = { x: n.x, y: n.y }; });
    try {
      await api(API.layout(state.runId), {
        method: 'PUT',
        body: {
          layout: {
            nodes: nodes,
            viewport: { x: Math.round(state.panX), y: Math.round(state.panY), zoom: state.zoom },
            note: 'PC 无限画布保存'
          }
        }
      });
      setDirty(false);
      toast('布局已保存（DAG 定义未改动）', 'ok');
      await loadGraph();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function resetLayout() {
    if (!state.runId) { toast('请先选择运行', 'err'); return; }
    try {
      await api(API.layoutReset(state.runId), { method: 'POST', body: {} });
      setDirty(false);
      await loadGraph();
      fitView();
      toast('已重置为自动布局', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function newProject() {
    try {
      var p = await api(API.createProject, {
        method: 'POST',
        body: {
          userId: state.userId,
          title: '演示项目 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          styleCode: 'STY-DUSHI', totalMinutes: 10, episodeSec: 90,
          prompt: '一句话演示：都市悬疑漫剧，失忆的侦探找回自己的身份'
        }
      });
      await loadProjects();
      qs('#projectSel').value = p.id;
      state.projectId = p.id;
      await loadRuns();
      toast('演示项目已创建，接着点「创建运行」', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function newRun() {
    if (!state.projectId) { toast('请先创建演示项目', 'err'); return; }
    try {
      var tpl = qs('#tplSel').value || 'BP_ONESHOT';
      var run = await api(API.runs, { method: 'POST', body: { projectId: state.projectId, templateCode: tpl } });
      state.runId = run.id;
      await loadRuns();
      qs('#runSel').value = run.id;
      await loadGraph();
      fitView();
      toast('运行已创建：' + tpl, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function bind() {
    qs('#projectSel').addEventListener('change', function (e) {
      state.projectId = e.target.value;
      loadRuns().catch(function (x) { toast(x.message, 'err'); });
    });
    qs('#runSel').addEventListener('change', function (e) {
      state.runId = e.target.value;
      loadGraph().catch(function (x) { toast(x.message, 'err'); });
    });
    qs('#btnNewProject').addEventListener('click', newProject);
    qs('#btnNewRun').addEventListener('click', newRun);
    qs('#btnRefresh').addEventListener('click', function () { loadGraph().then(function () { toast('已刷新'); }).catch(function (e) { toast(e.message, 'err'); }); });
    qs('#btnSave').addEventListener('click', saveLayout);
    qs('#btnReset').addEventListener('click', resetLayout);
    qs('#btnFit').addEventListener('click', fitView);
    qs('#btnZoomIn').addEventListener('click', function () { state.zoom = Math.min(2.5, state.zoom * 1.15); applyTransform(); });
    qs('#btnZoomOut').addEventListener('click', function () { state.zoom = Math.max(0.2, state.zoom / 1.15); applyTransform(); });
    qs('#btnZoomReset').addEventListener('click', function () { state.zoom = 1; applyTransform(); });

    var vp = qs('#viewport');
    vp.addEventListener('mousedown', onMouseDown);
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('click', function (e) {
      if (!state.graph) return;
      if (!e.target.closest || !e.target.closest('.node')) {
        state.selected = null;
        LW.qsa('.node').forEach(function (el) { el.classList.remove('selected'); });
        renderInspector(null);
      }
    });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  init();
})();
