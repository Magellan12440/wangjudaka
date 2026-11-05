/* 网剧大咖 · 管理员后台（V3.6）
 * 令牌仅存 sessionStorage（关页即清）；所有管理请求带 X-Admin-Token。
 * 本页面不含任何硬编码凭据。
 */
(function () {
  'use strict';

  var SS_KEY = 'lw_admin_token';
  var token = '';
  var page = { offset: 0, limit: 20, total: 0 };

  function headers() { return { 'X-Admin-Token': token }; }
  function $(id) { return document.getElementById(id); }

  function call(path, opt) {
    opt = opt || {};
    opt.headers = headers();
    return LW.api(path, opt);
  }

  // ---------- 门禁 ----------
  function enter(t) {
    token = t;
    call('/api/admin/overview').then(function () {
      sessionStorage.setItem(SS_KEY, t);
      $('gate').style.display = 'none';
      $('app').style.display = 'block';
      refreshAll();
    }).catch(function (e) {
      $('gateErr').style.display = 'block';
      $('gateErr').textContent = '进入失败：' + e.message;
    });
  }

  $('btnLogin').onclick = function () {
    var t = $('tokenInput').value.trim();
    if (!t) { $('gateErr').style.display = 'block'; $('gateErr').textContent = '请输入 ADMIN_TOKEN'; return; }
    enter(t);
  };
  $('tokenInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnLogin').click(); });

  var saved = sessionStorage.getItem(SS_KEY);
  if (saved) enter(saved);

  // ---------- 概览 ----------
  function renderOverview(d) {
    var c = d.codes, u = d.users, p = d.packages;
    $('ovStats').innerHTML =
      stat(p.active + ' / ' + p.total, '上架档次 / 总档次') +
      stat(c.activeCodes, '有效兑换码') +
      stat(c.totalRedemptions, '累计兑换次数') +
      stat(c.totalPointsIssued, '累计发放点数') +
      stat(c.totalFaceValueActive, '有效码剩余面值') +
      stat(u.total, '注册用户') +
      stat(u.totalBalance, '用户余额合计') +
      stat(u.totalSpent + ' / ' + u.totalRecharged, '累计消耗 / 累计充值');
    function stat(b, s) { return '<div class="stat"><b>' + LW.esc(b) + '</b><span>' + LW.esc(s) + '</span></div>'; }
  }

  // ---------- 充值档次 ----------
  function renderPackages(items) {
    var tb = $('pkgRows');
    if (!items.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">暂无档次</td></tr>'; return; }
    tb.innerHTML = items.map(function (p) {
      var off = p.status !== 'active';
      return '<tr class="' + (off ? 'pkg-off' : '') + '">' +
        '<td><b>' + LW.esc(p.name) + '</b><div class="small muted mono">' + LW.esc(p.code) + '</div></td>' +
        '<td>' + p.points + '</td>' +
        '<td>' + (p.bonus ? '<span class="badge ok">+' + p.bonus + '</span>' : '—') + '</td>' +
        '<td>¥' + p.price_cny + '</td>' +
        '<td>' + (off ? '<span class="badge">已下架</span>' : '<span class="badge ok">上架中</span>') + '</td>' +
        '<td class="row">' +
          '<button class="btn sm" data-act="toggle" data-id="' + p.id + '" data-st="' + (off ? 'active' : 'offline') + '">' + (off ? '上架' : '下架') + '</button>' +
          '<button class="btn sm" data-act="edit" data-id="' + p.id + '">改赠送</button>' +
        '</td></tr>';
    }).join('');
    LW.qsa('button[data-act]', tb).forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-id');
        if (b.getAttribute('data-act') === 'toggle') {
          call('/api/admin/packages/' + encodeURIComponent(id) + '/status', { method: 'POST', body: { status: b.getAttribute('data-st') } })
            .then(function () { LW.toast('状态已更新', 'ok'); loadPackages(); })
            .catch(function (e) { LW.toast(e.message, 'err'); });
        } else {
          var cur = items.find(function (x) { return x.id === id; });
          var v = prompt('修改「' + cur.name + '」的赠送点数（当前 ' + (cur.bonus || 0) + '）：', String(cur.bonus || 0));
          if (v === null) return;
          call('/api/admin/packages/' + encodeURIComponent(id), { method: 'POST', body: { bonus: parseInt(v, 10) || 0 } })
            .then(function () { LW.toast('赠送福利已更新', 'ok'); loadPackages(); })
            .catch(function (e) { LW.toast(e.message, 'err'); });
        }
      };
    });
  }

  function loadPackages() {
    return call('/api/admin/packages').then(function (d) { renderPackages(d.items); });
  }

  $('btnPkgCreate').onclick = function () {
    var body = {
      name: $('pkgName').value.trim(),
      points: parseInt($('pkgPoints').value, 10),
      bonus: parseInt($('pkgBonus').value, 10) || 0,
      priceCny: parseFloat($('pkgPrice').value),
      sort: parseInt($('pkgSort').value, 10) || 0,
    };
    call('/api/admin/packages', { method: 'POST', body: body }).then(function () {
      LW.toast('档次已创建，小程序端立即生效', 'ok');
      $('pkgName').value = ''; $('pkgPoints').value = ''; $('pkgBonus').value = '0'; $('pkgPrice').value = '';
      loadPackages(); loadOverview();
    }).catch(function (e) { LW.toast(e.message, 'err'); });
  };

  // ---------- 充值活动 ----------
  var campaignCache = { bonusByPackage: {} };

  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderCampaign(c) {
    campaignCache = c || { bonusByPackage: {} };
    $('cpEnabled').value = c && c.enabled ? '1' : '0';
    $('cpStart').value = toLocalInput(c && c.startAt);
    $('cpEnd').value = toLocalInput(c && c.endAt);
    $('cpNote').value = (c && c.note) || '';
    $('cpState').textContent = c && c.active ? '活动进行中' : (c && c.enabled ? '未到时间或已结束' : '未开启');
    $('cpState').className = 'badge' + (c && c.active ? ' ok' : '');
    var tb = $('cpRows');
    call('/api/admin/packages').then(function (d) {
      var items = d.items || [];
      if (!items.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">先建充值档次</td></tr>'; return; }
      var map = (campaignCache.bonusByPackage) || {};
      tb.innerHTML = items.map(function (p) {
        var v = map[p.id];
        if (v === undefined) v = map[p.code];
        return '<tr>' +
          '<td><b>' + LW.esc(p.name) + '</b><div class="small muted mono">' + LW.esc(p.code) + '</div></td>' +
          '<td>' + p.points + '</td>' +
          '<td>' + (p.bonus ? '+' + p.bonus : '—') + '</td>' +
          '<td><input type="number" min="0" step="1" data-pkg="' + p.id + '" value="' + (v === undefined ? '' : v) + '" placeholder="不参加" style="width:110px"></td>' +
          '</tr>';
      }).join('');
    });
  }

  function loadCampaign() {
    return call('/api/admin/campaign').then(renderCampaign);
  }

  $('btnCpSave').onclick = function () {
    var map = {};
    LW.qsa('#cpRows input[data-pkg]').forEach(function (inp) {
      var raw = inp.value.trim();
      if (raw === '') return;
      var n = parseInt(raw, 10);
      if (isFinite(n) && n >= 0) map[inp.getAttribute('data-pkg')] = n;
    });
    var body = {
      enabled: $('cpEnabled').value === '1',
      startAt: $('cpStart').value || null,
      endAt: $('cpEnd').value || null,
      note: $('cpNote').value.trim(),
      bonusByPackage: map,
    };
    call('/api/admin/campaign', { method: 'POST', body: body }).then(function (c) {
      LW.toast('活动已保存，小程序「我的」页立即生效', 'ok');
      renderCampaign(c);
    }).catch(function (e) { LW.toast(e.message, 'err'); });
  };

  // ---------- 兑换码生成 ----------
  $('btnGen').onclick = function () {
    var body = {
      points: parseInt($('rcPoints').value, 10),
      bonus: parseInt($('rcBonus').value, 10) || 0,
      count: parseInt($('rcCount').value, 10) || 1,
      prefix: $('rcPrefix').value.trim() || 'LW',
      expireDays: parseInt($('rcDays').value, 10) || 90,
      maxUses: parseInt($('rcMaxUses').value, 10) || 1,
      note: $('rcNote').value.trim(),
    };
    call('/api/admin/redeem-codes', { method: 'POST', body: body }).then(function (d) {
      $('genResult').style.display = 'block';
      $('genMeta').textContent = '批次 ' + d.batchId + ' · ' + d.count + ' 张 · 每张 ' + d.totalPoints + ' 点 · ' + LW.fmtTime(d.expiresAt) + ' 前有效';
      $('genCodes').innerHTML = d.codes.map(function (c) { return '<div>' + LW.esc(c) + '</div>'; }).join('');
      $('btnCopyCodes').onclick = function () {
        LW.copy(d.codes.join('\n')).then(function (ok) { LW.toast(ok ? '已复制 ' + d.count + ' 个兑换码' : '复制失败', ok ? 'ok' : 'err'); });
      };
      $('btnDlCodes').onclick = function () {
        LW.downloadJson('redeem-codes-' + d.batchId + '.json', d);
      };
      loadCodes(); loadOverview();
    }).catch(function (e) { LW.toast(e.message, 'err'); });
  };

  // ---------- 兑换码列表 ----------
  function renderCodes(d) {
    page.total = d.total;
    var tb = $('codeRows');
    if (!d.items.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">暂无兑换码</td></tr>'; }
    else {
      tb.innerHTML = d.items.map(function (c) {
        var st = c.status === 'revoked' ? '<span class="badge err">已作废</span>'
          : c.expired ? '<span class="badge warn">已过期</span>'
          : '<span class="badge ok">有效</span>';
        return '<tr>' +
          '<td class="code-cell">' + LW.esc(c.code_display) + '</td>' +
          '<td>' + c.points + (c.bonus ? '<span class="badge ok">+' + c.bonus + '</span>' : '') + '</td>' +
          '<td>' + c.used_count + ' / ' + c.max_uses + '</td>' +
          '<td class="small">' + LW.fmtTime(c.expires_at) + '</td>' +
          '<td>' + st + '</td>' +
          '<td class="small muted">' + LW.esc(c.note || '—') + '</td>' +
          '<td class="row">' +
            '<button class="btn sm" data-act="copy" data-code="' + LW.esc(c.code_display) + '">复制</button>' +
            (c.status === 'active' ? '<button class="btn sm danger" data-act="revoke" data-code="' + LW.esc(c.code_display) + '">作废</button>' : '') +
          '</td></tr>';
      }).join('');
    }
    LW.qsa('button[data-act]', tb).forEach(function (b) {
      b.onclick = function () {
        var code = b.getAttribute('data-code');
        if (b.getAttribute('data-act') === 'copy') {
          LW.copy(code).then(function (ok) { LW.toast(ok ? '已复制 ' + code : '复制失败', ok ? 'ok' : 'err'); });
        } else if (confirm('确定作废兑换码 ' + code + '？作废后不可恢复。')) {
          call('/api/admin/redeem-codes/revoke', { method: 'POST', body: { code: code } })
            .then(function () { LW.toast('已作废', 'ok'); loadCodes(); loadOverview(); })
            .catch(function (e) { LW.toast(e.message, 'err'); });
        }
      };
    });
    var from = page.total === 0 ? 0 : page.offset + 1;
    var to = Math.min(page.offset + page.limit, page.total);
    $('pageInfo').textContent = from + '-' + to + ' / 共 ' + page.total + ' 条';
    $('btnPrev').disabled = page.offset <= 0;
    $('btnNext').disabled = page.offset + page.limit >= page.total;
  }

  function loadCodes() {
    var st = $('fltStatus').value;
    return call('/api/admin/redeem-codes?limit=' + page.limit + '&offset=' + page.offset + (st ? '&status=' + st : ''))
      .then(renderCodes);
  }
  function loadStats() {
    return call('/api/admin/redeem-codes/stats').then(function (s) {
      $('codeStats').textContent = '有效 ' + s.activeCodes + ' · 作废 ' + s.revokedCodes + ' · 累计兑换 ' + s.totalRedemptions + ' 次 · 累计发放 ' + s.totalPointsIssued + ' 点';
    });
  }
  function loadOverview() {
    return call('/api/admin/overview').then(renderOverview);
  }

  // ---------- 邀请裂变 ----------
  var INV_STATUS_TEXT = {
    pending: '<span class="badge">待完成作品</span>',
    qualified: '<span class="badge warn">待发放</span>',
    rewarded: '<span class="badge ok">已发放</span>',
    rejected: '<span class="badge err">无效</span>'
  };

  function renderInvStats(s) {
    var st = s.settings || {};
    $('invReward').value = st.reward_points;
    $('invDaily').value = st.daily_reward_limit;
    $('invIp').value = st.ip_daily_limit;
    $('invWindow').value = st.bind_window_hours;
    $('invMilestone').value = st.require_milestone ? '1' : '0';

    $('invStats').innerHTML =
      invStat(s.rewarded, '已发放奖励') +
      invStat(s.pending, '待完成作品') +
      invStat(s.rejected, '判定无效') +
      invStat(s.pointsIssued + ' 点', '累计发出额度');
    $('invReasons').textContent = (s.rejectReasons || []).length
      ? '无效原因：' + s.rejectReasons.map(function (r) { return r.text + ' ' + r.count; }).join(' · ')
      : '暂无无效记录';
    function invStat(b, t) { return '<div class="stat"><b>' + LW.esc(b) + '</b><span>' + LW.esc(t) + '</span></div>'; }
  }

  function renderInvites(d) {
    var tb = $('invRows');
    if (!d.items.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">暂无邀请记录</td></tr>'; return; }
    tb.innerHTML = d.items.map(function (r) {
      var canReject = r.status !== 'rejected';
      return '<tr>' +
        '<td>' + LW.esc(r.inviter_name) + '</td>' +
        '<td>' + LW.esc(r.invitee_name) + '</td>' +
        '<td class="code-cell">' + LW.esc(r.code) + '</td>' +
        '<td>' + (INV_STATUS_TEXT[r.status] || LW.esc(r.status)) +
          (r.reason_text ? '<div class="small muted">' + LW.esc(r.reason_text) + '</div>' : '') + '</td>' +
        '<td>' + (r.status === 'rewarded' ? '+' + r.reward_points + ' 点' : '—') + '</td>' +
        '<td class="small muted">' + LW.esc(String(r.created_at).slice(0, 19).replace('T', ' ')) + '</td>' +
        '<td>' + (canReject
          ? '<button class="btn sm danger" data-inv="' + LW.esc(r.id) + '">判定无效</button>'
          : '—') + '</td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call(tb.querySelectorAll('[data-inv]'), function (b) {
      b.onclick = function () { rejectInvite(b.getAttribute('data-inv')); };
    });
  }

  function rejectInvite(id) {
    if (!window.confirm('判定这次邀请无效？若奖励已发放，会从邀请人余额扣回。')) return;
    call('/api/admin/invites/reject', { method: 'POST', body: { inviteId: id, reason: 'manual' } })
      .then(function () { LW.toast('已判定无效'); loadInvStats(); loadInvites(); })
      .catch(function (e) { LW.toast(e.message, 'err'); });
  }

  function loadInvStats() {
    return call('/api/admin/invites/stats').then(renderInvStats);
  }
  function loadInvites() {
    var st = $('fltInvStatus').value;
    return call('/api/admin/invites?limit=50' + (st ? '&status=' + st : '')).then(renderInvites);
  }

  $('btnInvSave').onclick = function () {
    var body = {
      reward_points: Number($('invReward').value),
      daily_reward_limit: Number($('invDaily').value),
      ip_daily_limit: Number($('invIp').value),
      bind_window_hours: Number($('invWindow').value),
      require_milestone: $('invMilestone').value === '1'
    };
    call('/api/admin/invite-settings', { method: 'POST', body: body })
      .then(function () { LW.toast('规则已保存'); loadInvStats(); })
      .catch(function (e) { LW.toast(e.message, 'err'); });
  };
  $('btnInvFlt').onclick = function () { loadInvites(); };

  $('btnFlt').onclick = function () { page.offset = 0; loadCodes(); };
  $('btnPrev').onclick = function () { page.offset = Math.max(0, page.offset - page.limit); loadCodes(); };
  $('btnNext').onclick = function () { page.offset += page.limit; loadCodes(); };
  $('btnRefresh').onclick = function () { refreshAll(); };

  function refreshAll() {
    loadOverview().catch(function (e) { LW.toast(e.message, 'err'); });
    loadPackages().catch(function (e) { LW.toast(e.message, 'err'); });
    loadCampaign().catch(function (e) { LW.toast(e.message, 'err'); });
    loadCodes().catch(function (e) { LW.toast(e.message, 'err'); });
    loadStats().catch(function (e) { LW.toast(e.message, 'err'); });
    loadInvStats().catch(function (e) { LW.toast(e.message, 'err'); });
    loadInvites().catch(function (e) { LW.toast(e.message, 'err'); });
  }
})();
