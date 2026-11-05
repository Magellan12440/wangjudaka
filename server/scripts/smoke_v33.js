#!/usr/bin/env node
/**
 * V3.3 端到端 HTTP 冒烟（MOCK 模式，不产生真实算力消耗）。
 * 用法：先 `node src/index.js` 启动服务，再 `node scripts/smoke_v33.js`。
 *
 * 覆盖：项目 → 总谱 → 充值 → 出图/出视频（带一致性自检）→ 质检报告
 *      → 合规包 → 交付闸门 → 分发 → 数据/收益回传 → 看板 → 收益计算器。
 */
const B = process.env.SMOKE_BASE || 'http://127.0.0.1:8787';

async function req(path, payload = null, method = null) {
  const m = method ?? (payload === null ? 'GET' : 'POST');
  const res = await fetch(B + path, {
    method: m,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: payload === null ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const d = await res.json();
  if (!d.ok) throw new Error(`${m} ${path} → ${d.code}: ${d.message}`);
  return d.data;
}

const FEAT = {
  locks: ['pine-green jacket'],
  emotion_codes: ['EMO-RAGE-SUPPRESSED-04'],
  lighting_codes: ['LIG-PRACTICAL'],
  style_code: 'STY-XUANYI',
};

function compileRequest(model, shotNo) {
  return {
    shot_no: shotNo,
    project: { style_code: 'STY-XUANYI', director_code: 'DIR-NOIR', aspect: '9:16', quality: '1080p' },
    shot: {
      duration: 5, shot_card: 'SHT-CU', characters: ['CH01'],
      emotions: { CH01: 'EMO-RAGE-SUPPRESSED-04' },
      offscreen: [], ambient: [],
      action_start: 'palms flat on the table', action_end: 'eyes lift',
      first_frame_url: 'cos://f.png', music_entry: 'No music',
    },
    lighting: { codes: ['LIG-PRACTICAL'] },
    transition: { code: 'TRN-HARDCUT' },
    assets: {
      characters: { CH01: { asset_code: 'CH01', name: '林默', image_url: 'cos://c.png', locks: ['pine-green jacket'] } },
    },
    model,
    options: { purpose: 'delivery' },
  };
}

async function main() {
  const P = `smoke_v33_${Date.now()}`;
  const U = `smoke_user_${Date.now()}`;

  const health = await req('/health');
  console.log('1. 健康检查:', health.relay.mode, '| 种子', JSON.stringify(health.seeds));

  const proj = await req('/api/projects', {
    userId: U, title: 'V3.3 冒烟剧', prompt: '废柴少年觉醒龙魂',
    styleCode: 'STY-XIANXIA', aspect: '9:16', quality: '1080p',
    totalMinutes: 10, episodeSec: 90, preset: 'balanced',
  }, 'POST');
  const pid = proj.id;
  const plan = await req(`/api/projects/${pid}/plan`, {}, 'POST');
  console.log('2. 项目与总谱:', pid, '| 自检', plan.validation.ok, '| 分镜', plan.shots, '镜');

  await req('/api/account/recharge', { userId: U, points: 5000, idemKey: `${U}-recharge` }, 'POST');
  const g1 = await req('/api/generate', {
    userId: U, projectId: pid, kind: 'image', purpose: 'delivery', shotNo: 'E01-S001',
    reference: FEAT, candidate: FEAT,
    compileRequest: compileRequest('IMG-DEFAULT', 'E01-S001'),
  }, 'POST');
  const g2 = await req('/api/generate', {
    userId: U, projectId: pid, kind: 'video', purpose: 'delivery', shotNo: 'E01-S002',
    reference: FEAT, candidate: FEAT,
    compileRequest: compileRequest('VID-DEFAULT', 'E01-S002'),
  }, 'POST');
  console.log('3. 出图/出视频:', g1.consistency.verdict, g1.consistency.score, '|', g2.consistency.verdict, g2.consistency.score,
    '| 余额', g2.balance);

  const providers = await req('/api/qc/providers');
  const qc = await req(`/api/qc/consistency/report?projectId=${pid}&episode=E01`);
  console.log('4. 质检:', providers.map((p) => p.name).join('/'), '| 通过', qc.passed, '/', qc.total_shots,
    '| 平均', qc.avg_score, '| KPI', qc.kpi_met);

  const pack = await req('/api/compliance/pack', { projectId: pid, episodeNo: 'E01' }, 'POST');
  console.log('5. 合规包:', pack.pack_id, '|', pack.evidence_pages.length, '页 | 校验', pack.validation.ok,
    '| HTML', pack.html.length, '字符 | 文件', pack.files.map((f) => f.name).join(','));

  const gate = await req('/api/qc/delivery-gate', { projectId: pid, episodeNo: 'E01' }, 'POST');
  console.log('6. 交付闸门:', gate.ready ? '放行 ✅' : '阻断', '| 阻断项', gate.blockers.length);

  const dist = await req('/api/distribution', {
    userId: U, projectId: pid, episodeNo: 'E01', platformCode: 'PLT-HONGGUO',
  }, 'POST');
  await req('/api/distribution/' + dist.id + '/stats', {
    views: 100000, likes: 5000, comments: 800, shares: 300, completion_rate: 0.45,
    recordedAt: '2026-11-01T10:00:00.000Z',
  }, 'POST');
  await req('/api/distribution/' + dist.id + '/stats', {
    views: 260000, likes: 13000, comments: 1900, shares: 700, completion_rate: 0.52,
    recordedAt: '2026-11-02T10:00:00.000Z',
  }, 'POST');
  await req('/api/distribution/' + dist.id + '/revenue', { amount: 3200.5, period: '2026-11' }, 'POST');

  const dash = await req(`/api/analytics/dashboard?projectId=${pid}`);
  const settle = await req(`/api/analytics/settlements?projectId=${pid}`);
  const calc = await req('/api/analytics/revenue/calculate', {
    platformCode: 'PLT-HONGGUO', dramaType: '2d', views: 1000000,
    completionRate: 0.5, costPoints: 2600,
  }, 'POST');
  const policies = await req('/api/revenue-policies');
  console.log('7. 数据看板:', '播放', dash.overview.total_views, '| 趋势', dash.trend.length, '天',
    '| 待结算 ¥' + dash.overview.pending_settlement_cny);
  console.log('8. 结算提醒:', settle.pending_count, '笔 |', settle.reminder.slice(0, 42) + '…');
  console.log('9. 收益计算器: 估算 ¥' + calc.estimate.gross_cny, '| 净 ¥' + calc.estimate.net_cny,
    '| ROI', calc.estimate.roi, '| 政策库', policies.length, '平台');

  const ok = gate.ready && pack.validation.ok && qc.kpi_met && dash.trend.length === 2;
  console.log(ok ? '\n=== V3.3 HTTP 冒烟全部通过 ✅ ===' : '\n=== V3.3 HTTP 冒烟存在失败项 ❌ ===');
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error('冒烟失败:', e.message);
  process.exitCode = 1;
});
