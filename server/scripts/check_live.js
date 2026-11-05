#!/usr/bin/env node
/**
 * 线上环境体检（打真实域名，不碰本地数据）。
 *
 * 用法：
 *   node scripts/check_live.js
 *   node scripts/check_live.js --base https://xxx.sh.run.tcloudbase.com
 *
 * 设计原则：
 *  - 只读为主。唯一写入是建一个带 smoke 标记的项目（用来验证写链路与 db 可用），
 *    title 固定带 [smoke] 前缀，便于后台识别清理。
 *  - 只依赖 node 内置 fetch（Node 18+），零第三方依赖。
 *  - 输出 PASS / WARN / FAIL 三级，FAIL 直接非零退出，可挂 CI。
 */

const args = process.argv.slice(2);
const baseArgIdx = args.indexOf('--base');
const BASE = (
  baseArgIdx >= 0 ? args[baseArgIdx + 1] : process.env.LIVE_BASE
) || 'https://express-r0ph-341726-13-1525512932.sh.run.tcloudbase.com';
const BASE_URL = BASE.replace(/\/+$/, '');

const results = [];
const pass = (name, detail = '') => results.push({ level: 'PASS', name, detail });
const warn = (name, detail = '') => results.push({ level: 'WARN', name, detail });
const fail = (name, detail = '') => results.push({ level: 'FAIL', name, detail });

async function api(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout ?? 60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如模板页 HTML） */ }
  return { status: res.status, json, text };
}

async function main() {
  console.log(`线上体检：${BASE_URL}\n`);

  // 1) 健康检查
  let health = null;
  try {
    const r = await api('/health', { timeout: 20000 });
    if (r.status !== 200 || !r.json?.data) {
      fail('/health', `HTTP ${r.status}，返回的不是本项目（很可能是模板镜像）：${r.text.slice(0, 60).replace(/\s+/g, ' ')}`);
    } else {
      health = r.json.data;
      pass('/health', `version=${health.version} uptime=${health.uptime_sec}s ports=${(health.ports ?? []).join('/')}`);
    }
  } catch (e) {
    fail('/health', `请求失败：${e.message}`);
  }

  if (health) {
    // 2) 种子完整性：线上缺库会导致「能登录但生成全报错」
    if (health.seeds_ok === true) {
      pass('种子库', Object.entries(health.seeds ?? {}).map(([k, v]) => `${k}:${v}`).join(' '));
    } else {
      fail('种子库', `seeds_ok=false 缺失=${JSON.stringify(health.seeds_missing)}`);
    }
    // 3) 算力网关模式：mock 模式下所有生成都是假数据，必须显式警告
    const mode = health.relay?.mode;
    if (mode === 'live') {
      pass('算力网关', `live（${health.relay.gatewayHost}）`);
    } else {
      warn('算力网关', `mode=${mode} —— 线上未配置 RELAY_API_KEY，生成结果是模拟数据，需在云托管环境变量里补齐`);
    }
  }

  // 4) 目录类接口
  for (const [path, label, min] of [
    ['/api/styles', '风格预设', 20],
    ['/api/platforms', '分发平台', 6],
  ]) {
    const r = await api(path);
    const arr = r.json?.data;
    if (r.status === 200 && Array.isArray(arr) && arr.length >= min) pass(label, `${arr.length} 条`);
    else fail(label, `HTTP ${r.status}，期望 >=${min} 条，实际 ${Array.isArray(arr) ? arr.length : '非数组'}`);
  }

  const platforms = (await api('/api/platforms')).json?.data ?? [];
  const noUrl = platforms.filter((p) => !p.creator_url).map((p) => p.code);
  if (platforms.length && !noUrl.length) pass('平台登录入口', '全部带 creator_url');
  else if (noUrl.length) warn('平台登录入口', `缺 creator_url：${noUrl.join(',')}`);

  // 5) 写链路：建一个 smoke 项目
  const userId = `smoke_check_${Date.now()}`;
  const cr = await api('/api/projects', {
    method: 'POST',
    body: {
      userId,
      title: '[smoke] 线上体检',
      styleCode: 'STY-GUFENG',
      aspect: '9:16',
      quality: '1080p',
      totalMinutes: 4.5,
      episodeSec: 90,
      videoType: 'dynamic',
      prompt: '重生嫡女回府那夜，烛火被人动过手脚',
    },
  });
  const proj = cr.json?.data;
  if (cr.status === 200 && proj?.id) {
    pass('创建项目', `${proj.id}（中文标题回传：${proj.title}）`);
    // 中文编码回归：云端如果返回乱码，说明请求体编码链路有问题
    if (proj.title === '[smoke] 线上体检') pass('中文编码', 'UTF-8 往返一致');
    else warn('中文编码', `回传标题不一致：${proj.title}`);
  } else {
    fail('创建项目', `HTTP ${cr.status} ${cr.json?.code ?? ''} ${cr.json?.message ?? ''}`);
  }

  if (proj?.id) {
    // 6) 剪辑单：无素材时必须「可以失败」，但不能 500
    const ed = await api(`/api/projects/${proj.id}/edit`, { timeout: 90000 });
    const d = ed.json?.data;
    if (ed.status === 200 && d && typeof d.ok === 'boolean') {
      if (d.station === 'need_storyboard') {
        pass('剪辑单接口', '未生成分镜 → 结构化返回 NO_STORYBOARD（前端引导去流程页，非 428 报错）');
      } else {
        pass('剪辑单接口', `ok=${d.ok} blocking=${d.blocking} 缺素材=${(d.missing_shots ?? []).length} 镜`);
      }
      if (d.ok === false && d.station !== 'need_storyboard' && (d.missing_shots ?? []).length === 0) {
        warn('剪辑单阻断', `无缺失素材却 ok=false：${JSON.stringify((d.errors ?? []).slice(0, 2))}`);
      }
    } else {
      fail('剪辑单接口', `HTTP ${ed.status} ${ed.json?.code ?? ''}`);
    }

    // 7) 分发链路：建单 + 四步状态机
    const dist = await api('/api/distribution', {
      method: 'POST',
      body: { projectId: proj.id, episodeNo: 'E01', platformCode: 'PLT-HONGGUO', userId },
    });
    const distId = dist.json?.data?.id;
    if (dist.status === 200 && distId) {
      pass('分发建单', `${distId} status=${dist.json.data.status}`);
      const list = await api(`/api/distribution?projectId=${encodeURIComponent(proj.id)}`);
      const row = (list.json?.data ?? []).find((x) => x.id === distId);
      const steps = row?.steps ?? [];
      if (steps.length === 4) pass('分发四步', steps.map((s) => `${s.no}${s.label}:${s.state}`).join(' → '));
      else warn('分发四步', `steps 数量=${steps.length}（期望 4）`);
    } else {
      fail('分发建单', `HTTP ${dist.status} ${dist.json?.code ?? ''} ${dist.json?.message ?? ''}`);
    }
  }

  // —— 汇总 ——
  const fails = results.filter((r) => r.level === 'FAIL');
  const warns = results.filter((r) => r.level === 'WARN');
  console.log('检查项：');
  for (const r of results) {
    const mark = r.level === 'PASS' ? '✅' : r.level === 'WARN' ? '⚠️ ' : '❌';
    console.log(`  ${mark} ${r.name.padEnd(12, ' ')} ${r.detail}`);
  }
  console.log(`\n结果：${results.length - fails.length - warns.length} 通过 / ${warns.length} 警告 / ${fails.length} 失败`);
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error('体检异常：', e.message);
  process.exit(1);
});
