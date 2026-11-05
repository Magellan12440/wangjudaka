/* PC / H5 上传助手 · 只做预填与提醒，绝不自动投稿 */
(function () {
  'use strict';
  var LW = window.LW;
  var api = LW.api, qs = LW.qs, esc = LW.esc, toast = LW.toast;

  var API = {
    projects: function (uid) { return `/api/projects?userId=${encodeURIComponent(uid)}`; },
    platforms: '/api/platforms',
    distribution: function (pid) { return `/api/distribution?projectId=${encodeURIComponent(pid)}`; },
    createDistribution: '/api/distribution',
    prepare: '/api/upload/prepare',
    bundle: '/api/upload/bundle',
    importBundle: '/api/upload/import',
    mark: '/api/upload/mark',
    submissions: function (did) { return `/api/upload/submissions?distributionId=${encodeURIComponent(did)}`; },
    bundles: function (did) { return `/api/upload/bundles?distributionId=${encodeURIComponent(did)}`; },
    compliancePackPost: '/api/compliance/pack'
  };

  var state = {
    userId: 'pc_user',
    projectId: '',
    distributionId: '',
    platforms: [],
    distributions: [],
    prepared: null
  };

  async function init() {
    bind();
    try {
      state.platforms = await api(API.platforms);
      await loadProjects();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadProjects() {
    var list = await api(API.projects(state.userId));
    var sel = qs('#projectSel');
    if (!list.length) {
      sel.innerHTML = '<option value="">（暂无项目，请先在小程序或画布页创建）</option>';
      state.projectId = '';
      return;
    }
    sel.innerHTML = list.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.title) + ' · ' + esc(String(p.id).slice(-6)) + '</option>';
    }).join('');
    state.projectId = list[0].id;
    await loadDistributions();
  }

  async function loadDistributions() {
    var sel = qs('#distSel');
    if (!state.projectId) { sel.innerHTML = '<option value="">—</option>'; return; }
    var list = await api(API.distribution(state.projectId));
    state.distributions = list;
    if (!list.length) {
      sel.innerHTML = '<option value="">（该项目暂无分发任务）</option>';
      state.distributionId = '';
      qs('#distHint').innerHTML = '<button class="btn sm" id="btnCreateDist">+ 创建演示分发任务</button>';
      qs('#btnCreateDist').addEventListener('click', createDemoDistribution);
      return;
    }
    sel.innerHTML = list.map(function (d) {
      return '<option value="' + esc(d.id) + '">' + esc(d.platform_name) + ' / ' + esc(d.episode) + ' / ' + esc(d.status) + '</option>';
    }).join('');
    state.distributionId = list[0].id;
    qs('#distHint').textContent = '共 ' + list.length + ' 个分发任务';
  }

  async function createDemoDistribution() {
    if (!state.projectId) { toast('请先选择项目', 'err'); return; }
    var code = state.platforms.length ? state.platforms[0].code : 'PLT-HONGGUO';
    try {
      var d = await api(API.createDistribution, {
        method: 'POST',
        body: { projectId: state.projectId, episodeNo: 'E01', platformCode: code, userId: state.userId }
      });
      await loadDistributions();
      qs('#distSel').value = d.id;
      state.distributionId = d.id;
      toast('演示分发任务已创建', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- 生成预填单 ---------- */
  async function prepare() {
    if (!state.distributionId) { toast('请先选择分发任务', 'err'); return; }
    try {
      var p = await api(API.prepare, { method: 'POST', body: { distributionId: state.distributionId } });
      state.prepared = p;
      renderAll(p);
      toast('预填单已生成（未向平台提交任何内容）', 'ok');
      await loadHistory();
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderAll(p) {
    renderFields(p);
    renderLinks(p);
    renderChecklist(p);
    renderGate(p);
    renderWarnings(p);
    fillStatusFlow(p.platform.code, p.current_status);
  }

  function renderFields(p) {
    var body = qs('#fieldsBody');
    if (!p.fields.length) { body.innerHTML = '<tr><td colspan="3" class="empty">无预填字段</td></tr>'; return; }
    body.innerHTML = p.fields.map(function (f, i) {
      return '<tr>' +
        '<td>' + esc(f.label) + (f.required ? ' <span class="badge err">必填</span>' : '') +
        (f.hint ? '<div class="small muted" style="margin-top:4px">' + esc(f.hint) + '</div>' : '') + '</td>' +
        '<td class="field-val">' + esc(f.value) + '</td>' +
        '<td>' + (f.copyable ? '<button class="btn sm" data-copy="' + i + '">复制</button>' : '<span class="small muted">只读</span>') + '</td>' +
        '</tr>';
    }).join('');
    LW.qsa('[data-copy]', body).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = p.fields[Number(btn.getAttribute('data-copy'))];
        LW.copy(f.value).then(function (ok) { toast(ok ? '已复制：' + f.label : '复制失败，请手动选中', ok ? 'ok' : 'err'); });
      });
    });
  }

  function renderLinks(p) {
    var box = qs('#linkBox');
    box.innerHTML =
      '<div class="row"><span class="badge info">' + esc(p.platform.name) + '</span>' +
      '<span class="small muted">当前状态：' + esc(p.current_status) + '</span></div>' +
      '<p class="small" style="margin:10px 0">' + esc(p.links.label) + '<br><span class="mono small">' + esc(p.links.upload_url) + '</span></p>' +
      '<div class="row">' +
      '<button class="btn sm primary" id="btnOpenPlatform">在新窗口打开上传页</button>' +
      '<button class="btn sm" id="btnEvidence">生成 AI 创作说明截图包</button>' +
      '</div>' +
      '<div class="notice warn" style="margin-top:10px">' + esc(p.links.reason) + '</div>';
    qs('#btnOpenPlatform').addEventListener('click', function () {
      window.open(p.links.upload_url, '_blank', 'noopener');
      toast('已打开平台上传页；完成后请回来点「回写状态」', 'ok');
    });
    qs('#btnEvidence').addEventListener('click', function () { openEvidence(p); });
  }

  async function openEvidence(p) {
    try {
      var d = await api(API.compliancePackPost, {
        method: 'POST',
        body: { projectId: p.project_id, episodeNo: p.episode }
      });
      if (!d.html) { toast('证据包已生成到服务端，但未返回 HTML 预览', 'err'); return; }
      var blob = new Blob([d.html], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      toast('已打开 7 页证据包，请逐页打印或全屏截图', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderChecklist(p) {
    var box = qs('#checklistBox');
    if (!p.checklist.length) { box.innerHTML = '<p class="hint">无需额外材料</p>'; return; }
    box.innerHTML = p.checklist.map(function (c, i) {
      return '<label><input type="checkbox" data-check="' + i + '"><span>' +
        (c.required ? '<span class="badge err">必填</span> ' : '<span class="badge">选填</span> ') +
        esc(c.label) + (c.note ? '<br><span class="small muted">' + esc(c.note) + '</span>' : '') +
        '</span></label>';
    }).join('') + '<p class="small muted" id="checkCount" style="margin-top:8px">已备齐 0 / ' + p.checklist.length + '</p>';
    var update = function () {
      var n = LW.qsa('[data-check]:checked', box).length;
      qs('#checkCount').textContent = '已备齐 ' + n + ' / ' + p.checklist.length;
    };
    LW.qsa('[data-check]', box).forEach(function (cb) { cb.addEventListener('change', update); });
  }

  function renderGate(p) {
    var g = p.delivery_gate;
    var box = qs('#gateBox');
    if (!g || g.available === false) {
      box.innerHTML = '<div class="notice warn">交付闸门暂不可用：' + esc(g && g.reason ? g.reason : '尚未生成合规包') + '</div>';
      return;
    }
    var passed = (g.passed === true || g.ok === true || g.allowed === true);
    var blockers = g.blockers || g.reasons || [];
    box.innerHTML = '<div class="row"><span class="badge ' + (passed ? 'ok' : 'err') + '">' +
      (passed ? '已放行' : '未放行') + '</span><span class="small muted">一致性 / 证据链 / AI 标识三项校验</span></div>' +
      (blockers.length
        ? '<ul class="small" style="margin:8px 0 0;padding-left:18px">' + blockers.slice(0, 6).map(function (b) { return '<li>' + esc(typeof b === 'string' ? b : JSON.stringify(b)) + '</li>'; }).join('') + '</ul>'
        : '<p class="small muted" style="margin:8px 0 0">无阻断项</p>');
  }

  function renderWarnings(p) {
    qs('#warnBox').innerHTML = p.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
  }

  function fillStatusFlow(platformCode, current) {
    var p = state.platforms.find(function (x) { return x.code === platformCode; });
    var flow = (p && p.status_flow && p.status_flow.length)
      ? p.status_flow
      : ['准备中', '待上传', '审核中', '已上线', '被驳回', '已下线'];
    qs('#statusSel').innerHTML = flow.map(function (s) { return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');
    if (current && flow.indexOf(current) >= 0) qs('#statusSel').value = current;
  }

  /* ---------- 回写 / 导出 / 导入 ---------- */
  async function mark() {
    if (!state.distributionId) { toast('请先选择分发任务', 'err'); return; }
    var p = state.prepared;
    var prefill = p ? {
      fields: p.fields.map(function (f) { return { key: f.key, value: f.value }; }),
      checklist: p.checklist.map(function (c) { return { key: c.key, label: c.label }; })
    } : null;
    try {
      await api(API.mark, {
        method: 'POST',
        body: {
          distributionId: state.distributionId,
          status: qs('#statusSel').value,
          note: qs('#noteText').value || null,
          openedAt: new Date().toISOString(),
          prefill: prefill
        }
      });
      toast('状态已回写到工作台（平台侧仍需你本人操作）', 'ok');
      await loadHistory();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadHistory() {
    if (!state.distributionId) return;
    try {
      var list = await api(API.submissions(state.distributionId));
      qs('#submissionList').innerHTML = list.length
        ? '<div style="margin-top:8px">最近回写：<br>' + list.slice(-5).reverse().map(function (s) {
            return '<div class="mono small">· ' + esc(s.status) + ' · ' + esc(LW.fmtTime(s.created_at)) + ' · 提交方 ' + esc(s.submitted_by) + '</div>';
          }).join('') + '</div>'
        : '<span class="muted">暂无回写记录</span>';
    } catch (e) { /* 历史读取失败不阻断主流程 */ }
  }

  async function exportBundle() {
    if (!state.distributionId) { toast('请先选择分发任务', 'err'); return; }
    try {
      var b = await api(API.bundle, { method: 'POST', body: { distributionId: state.distributionId } });
      LW.downloadJson('upload-bundle-' + b.bundle_id + '.json', b);
      toast('预填包已导出（schema ' + b.schema + '）', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function importBundle() {
    var raw = qs('#importText').value.trim();
    if (!raw) { toast('请先粘贴预填包 JSON', 'err'); return; }
    var obj;
    try { obj = JSON.parse(raw); } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); return; }
    try {
      var r = await api(API.importBundle, { method: 'POST', body: { bundle: obj } });
      qs('#importHint').textContent = '已导入 ' + r.field_count + ' 个字段；未向任何平台提交作品';
      toast('预填包导入成功', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadBundles() {
    if (!state.distributionId) { toast('请先选择分发任务', 'err'); return; }
    try {
      var list = await api(API.bundles(state.distributionId));
      qs('#bundleList').textContent = list.length
        ? '导出记录 ' + list.length + ' 条，最近：' + LW.fmtTime(list[list.length - 1].exported_at)
        : '暂无导出记录';
    } catch (e) { toast(e.message, 'err'); }
  }

  function bind() {
    qs('#projectSel').addEventListener('change', function (e) {
      state.projectId = e.target.value;
      state.prepared = null;
      loadDistributions().catch(function (x) { toast(x.message, 'err'); });
    });
    qs('#distSel').addEventListener('change', function (e) { state.distributionId = e.target.value; });
    qs('#btnRefresh').addEventListener('click', function () {
      loadDistributions().then(function () { toast('已刷新'); }).catch(function (e) { toast(e.message, 'err'); });
    });
    qs('#btnPrepare').addEventListener('click', prepare);
    qs('#btnCopyAll').addEventListener('click', function () {
      if (!state.prepared) { toast('请先生成预填单', 'err'); return; }
      LW.copy(state.prepared.copy_text).then(function (ok) {
        toast(ok ? '已复制全部预填内容' : '复制失败，请手动选中', ok ? 'ok' : 'err');
      });
    });
    qs('#btnMark').addEventListener('click', mark);
    qs('#btnExport').addEventListener('click', exportBundle);
    qs('#btnLoadBundles').addEventListener('click', loadBundles);
    qs('#btnImport').addEventListener('click', importBundle);
  }

  init();
})();
