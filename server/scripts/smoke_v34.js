/**
 * 阶段 H（V3.4）端到端 HTTP 冒烟：自启动独立服务，不依赖外部终端。
 *  - 独立端口 8791、独立数据目录 data_smoke_h，跑完自动清理
 *  - 全程 MOCK，不产生任何真实算力消耗
 *  - 覆盖：静态页面 / 目录穿越防护 / 画布 DAG 不可篡改 / 上传助手不自动投稿 / 异步质检降级 / 凭据零命中
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_H_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
// 每次运行独立临时目录：不删除旧目录（删除在受管环境会触发策略拦截），也不污染工程
const DATA_DIR = path.join(os.tmpdir(), `wangjudaka-smoke-h-${process.pid}-${Date.now()}`);

let passed = 0;
let failed = 0;
const allText = [];

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

async function call(method, pathname, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + pathname, init);
  const text = await r.text();
  allText.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* 静态页面是 HTML */ }
  return { status: r.status, text, json, headers: r.headers };
}
const data = (r) => (r.json && r.json.data) || {};

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR, RELAY_MOCK: 'true', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    if (!await waitHealth()) {
      console.error('服务未能在超时内启动，日志：\n' + serverLog);
      process.exitCode = 1;
      return;
    }

    console.log('\n=== 阶段 H 端到端冒烟（V3.4）===\n');

    // 1. 健康检查
    const h = await call('GET', '/health');
    ok('服务健康 /health', h.status === 200 && h.json?.ok === true && data(h).relay?.mode === 'mock');

    // 2. 静态资源清单
    const ws = await call('GET', '/api/web/status');
    const wsd = data(ws);
    ok('web/ 静态资源清单 >= 8 个文件', wsd.web_root_exists === true && wsd.file_count >= 8,
      `file_count=${wsd.file_count}`);

    // 3. 静态页面可访问
    const pages = ['/index.html', '/canvas.html', '/upload-helper.html', '/canvas.js', '/common.css', '/upload-helper.js'];
    let pagesOk = true;
    for (const p of pages) {
      const r = await call('GET', p);
      if (r.status !== 200 || r.text.length < 50) pagesOk = false;
    }
    ok('6 个前端页面/脚本均可通过服务访问', pagesOk);

    // 4. 目录穿越防护
    const evil = await call('GET', '/%2e%2e/server/.env.local');
    ok('目录穿越被拦截且无凭据泄漏', evil.status === 404 && !/sk-[A-Za-z0-9]{8,}/.test(evil.text));

    // 5. 建项目
    const proj = await call('POST', '/api/projects', {
      userId: 'smoke_h_user', title: '阶段H冒烟剧', styleCode: 'STY-DUSHI',
      totalMinutes: 10, episodeSec: 90, prompt: '一句话：雨夜失忆侦探',
    });
    const projectId = data(proj).id;
    ok('创建项目', proj.status === 200 && Boolean(projectId));

    // 6. 蓝图模板
    const bps = await call('GET', '/api/blueprints');
    ok('蓝图模板 5 套可用', bps.status === 200 && data(bps).length >= 5);

    // 7. 创建运行
    const runR = await call('POST', '/api/runs', { projectId, templateCode: 'BP_ONESHOT' });
    const runId = data(runR).id;
    ok('创建 BP_ONESHOT 运行', runR.status === 200 && Boolean(runId));

    // 8. 画布 graph
    const g0 = await call('GET', `/api/canvas/${runId}/graph`);
    const gd0 = data(g0);
    ok('graph：12 节点 / 11 依赖边 / 自动布局',
      gd0.nodes?.length === 12 && gd0.edges?.length === 11 && gd0.layout_source === 'auto');

    // 9. 保存布局
    const save = await call('PUT', `/api/canvas/${runId}/layout`, {
      layout: {
        nodes: { N01: { x: 123, y: 456 }, N02: { x: 500, y: 456 } },
        viewport: { x: 10, y: 20, zoom: 1.25 },
        note: '冒烟布局',
      },
    });
    ok('保存画布布局（12 节点自动补齐）',
      save.status === 200 && Object.keys(data(save).nodes || {}).length === 12);

    // 10. 读回布局
    const g1 = await call('GET', `/api/canvas/${runId}/graph`);
    const gd1 = data(g1);
    ok('读回布局：source=user / 坐标与视口生效',
      gd1.layout_source === 'user' && gd1.nodes.find((n) => n.id === 'N01').x === 123 && gd1.viewport.zoom === 1.25);

    // 11. 伪造节点被拒
    const fake = await call('PUT', `/api/canvas/${runId}/layout`, {
      layout: { nodes: { N99_FAKE: { x: 1, y: 2 } } },
    });
    ok('红线：伪造 DAG 节点被拒 CANVAS_UNKNOWN_NODE',
      fake.status === 400 && fake.json?.code === 'CANVAS_UNKNOWN_NODE', fake.json?.code);

    // 12. 夹带节点定义被拒
    const tamper = await call('PUT', `/api/canvas/${runId}/layout`, {
      layout: { nodes: { N01: { x: 1, y: 2, status: 'done' } } },
    });
    ok('红线：布局夹带节点定义被拒 CANVAS_DAG_IMMUTABLE',
      tamper.status === 400 && tamper.json?.code === 'CANVAS_DAG_IMMUTABLE', tamper.json?.code);

    // 13. 重置布局
    const reset = await call('POST', `/api/canvas/${runId}/layout/reset`, {});
    ok('重置布局回到 auto', reset.status === 200 && data(reset).source === 'auto');

    // 14. 推进节点状态
    await call('POST', `/api/runs/${runId}/nodes/N01`, { status: 'done', costCredits: 4 });
    const g2 = await call('GET', `/api/canvas/${runId}/graph`);
    ok('推进节点后 graph.stats 同步（DAG 是事实）',
      data(g2).stats.done === 1 && data(g2).total_credits === 4);

    // 15. 建分发任务
    const distR = await call('POST', '/api/distribution', {
      projectId, episodeNo: 'E01', platformCode: 'PLT-HONGGUO', userId: 'smoke_h_user',
    });
    const distId = data(distR).id;
    ok('创建红果分发任务', distR.status === 200 && Boolean(distId));

    // 16. 上传助手预填
    const prep = await call('POST', '/api/upload/prepare', { distributionId: distId });
    const pd = data(prep);
    ok('预填单：字段 / 平台入口 / no_auto_submit',
      pd.fields?.length >= 10 && pd.links?.upload_url?.startsWith('https://') &&
      pd.no_auto_submit === true && pd.policy?.auto_submit === false);

    // 17. 导出 + 导入预填包
    const bundle = await call('POST', '/api/upload/bundle', { distributionId: distId });
    const bd = data(bundle);
    const imp = await call('POST', '/api/upload/import', { bundle: bd });
    ok('预填包导出 / 导入闭环',
      bd.schema === 'lingwu.upload.bundle/1' && imp.status === 200 && data(imp).ok === true);

    // 18. 状态回写
    const mark = await call('POST', '/api/upload/mark', {
      distributionId: distId, status: '审核中', note: '冒烟：本人已在平台上传',
    });
    const md = data(mark);
    const subs = await call('GET', `/api/upload/submissions?distributionId=${distId}`);
    ok('状态回写：user_manual / 不自动投稿 / 留痕可查',
      md.submission?.submitted_by === 'user_manual' && md.submission?.auto_submitted === false &&
      md.no_auto_submit === true && data(subs).length === 1);

    // 19. 非法状态被拒
    const badMark = await call('POST', '/api/upload/mark', { distributionId: distId, status: '草稿' });
    ok('红线：平台不支持的状态被拒 UPLOAD_STATUS_INVALID',
      badMark.status === 400 && badMark.json?.code === 'UPLOAD_STATUS_INVALID', badMark.json?.code);

    // 20. 比对 provider 未配置 → 不注册、恒降级
    const pcfg = await call('GET', '/api/qc/providers/config');
    const pc = data(pcfg);
    const cfg = await call('POST', '/api/qc/providers/configure', {});
    ok('比对 provider：未配置时不注册（不假装通过）',
      pc.configured === false && data(cfg).configured === false);

    // 21. 异步自检降级（不传结构化特征，避免自动命中本地 feature provider）
    const asyncQc = await call('POST', '/api/qc/consistency/check-async', {
      projectId, shotNo: 'E01-S001',
    });
    ok('异步自检在无比对服务时 verdict=degraded / score=null',
      data(asyncQc).verdict === 'degraded' && data(asyncQc).score === null,
      data(asyncQc).verdict);

    // 22. 全局凭据零命中（只认「真实值形态」；配置键名属于合法运维信息）
    const joined = allText.join('\n') + serverLog;
    const leaked = /sk-[A-Za-z0-9]{8,}|18615711453|(?:RELAY_API_KEY|RELAY_CONSOLE_PASSWORD|QC_COMPARE_TOKEN|RELAY_CONSOLE_ACCOUNT)\s*=\s*\S{4,}/.test(joined);
    ok('所有响应与启动日志：前端零凭据命中', !leaked);

    console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.on('exit', r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exitCode = 1;
});
