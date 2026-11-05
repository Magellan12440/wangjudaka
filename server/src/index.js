/**
 * 服务入口：本地 API 服务（零第三方依赖）。
 * 启动：node src/index.js   →   http://127.0.0.1:8787/health
 */
import http from 'node:http';
import { handleRequest } from './api/routes.js';
import { config, relayHealthSummary } from './config/env.js';
import seeds from './seeds/loader.js';
import { logger } from './core/redact.js';
import { db } from './store/db.js';
import assetLibrary from './assets/AssetLibrary.js';
import adminService from './admin/AdminService.js';
import adminConsole from './admin/AdminConsole.js';
import productionService from './pipeline/ProductionService.js';
import { loadRelayRuntime } from './relay/RelayRuntime.js';

// 导演总谱在规划阶段需要读角色情绪档案；用全局只读句柄避免启动期循环依赖
globalThis.__lingwuAssetLibrary = assetLibrary;

// V3.6：充值档次默认播种（幂等，集合非空时不动）
adminService.seedDefaultPackages();

// V4.7：管理员账号引导。配了 ADMIN_PHONE/ADMIN_PASSWORD 就直接建；
// 否则一个管理员都没有时生成一次性激活码，只打在启动日志里。
try {
  adminConsole.ensureBootstrap();
} catch (e) {
  logger.warn('管理员账号初始化失败（可在管理台稍后激活）', { msg: e.message });
}

// V4.3.1：管理台保存过的算力网关配置优先于环境变量（密钥不进 git，轮换不用发版）
try {
  loadRelayRuntime();
} catch (e) {
  logger.warn('算力网关运行时配置加载失败，回退到环境变量', { msg: e.message });
}

const v = seeds.validate();
if (!v.ok) {
  logger.error('种子库自检未通过，服务仍将启动但生成可能被拒', { problems: v.problems.slice(0, 10) });
} else {
  logger.info('种子库自检通过', v.counts);
}

const handler = (req, res) => {
  handleRequest(req, res).catch((e) => {
    logger.error('未捕获异常', { msg: e.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: '服务内部错误' }));
  });
};

const server = http.createServer(handler);

/**
 * 兜底端口：容器编排层（微信云托管 / K8s）只按它配置的端口探活。
 * 如果平台没把 PORT 注入进来，或注入的端口与控制台服务端口不一致，
 * 进程会听在一个没人探的端口上 → 探活全失败 → Back-off restarting failed container。
 * 所以在主端口之外，额外听一组常见端口，任一被探到即可通过。
 * 绑不上（EADDRINUSE / EACCES）只记 warn，绝不影响主端口启动。
 */
const FALLBACK_PORTS = String(process.env.FALLBACK_PORTS ?? (config.server.env === 'production' ? '80,3000,8080,8787' : ''))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((p) => Number.isInteger(p) && p > 0 && p < 65536 && p !== config.server.port);

const extraServers = [];
globalThis.__extraPorts = [];
for (const p of FALLBACK_PORTS) {
  const s = http.createServer(handler);
  s.on('error', (e) => logger.warn('兜底端口监听失败（不影响主端口）', { port: p, code: e.code }));
  s.listen(p, config.server.host, () => {
    globalThis.__extraPorts.push(p);
    logger.info('兜底端口已监听', { port: p });
    console.log(`  兜底端口: ${p}（供平台探活/反代使用）`);
  });
  extraServers.push(s);
}



server.listen(config.server.port, config.server.host, () => {
  logger.info('服务已启动', {
    port: config.server.port,
    host: config.server.host,
    version: config.server.version,
    env: config.server.env,
    dataDir: config.server.dataDir,
    relay: relayHealthSummary(),
    seedsOk: v.ok,
  });
  // 只打印安全摘要，绝不打印凭据
  const shown = config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host;
  console.log(`\n网剧大咖 服务端已启动  (v${config.server.version})`);
  console.log(`  地址: http://${shown}:${config.server.port}  (监听 ${config.server.host}:${config.server.port})`);
  console.log(`  数据: ${config.server.dataDir}`);
  console.log(`  算力: ${relayHealthSummary().mode} 模式 (网关 ${relayHealthSummary().gatewayHost})`);
  console.log(`  种子: 风格${v.counts.style_presets} 导演${v.counts.director_profiles} 镜头${v.counts.shot_cards} 转场${v.counts.transition_cards} 光影${v.counts.lighting_cards} 节奏${v.counts.rhythm_templates} 情绪${v.counts.emotion_cards}`);
  console.log(`  MOCK 模式下不产生真实算力消耗；配置 RELAY_API_KEY 后自动切换真实算力`);
  console.log(`  管理台: http://${shown}:${config.server.port}/admin.html（需 ADMIN_TOKEN）\n`);

  // V4.3：剧集托管调度器。用户选「自动成片」后关掉小程序也会继续逐集推进。
  // 测试环境不起（避免后台定时器干扰断言）；可用 PRODUCTION_RUNNER=off 关闭。
  if (config.server.env !== 'test' && String(process.env.PRODUCTION_RUNNER ?? 'on') !== 'off') {
    const timer = setInterval(() => {
      productionService.tickRunning().catch((e) => logger.warn('托管调度异常', { msg: e.message }));
    }, Number(process.env.PRODUCTION_TICK_MS ?? 4000));
    timer.unref?.();
    logger.info('剧集托管调度器已启动');
  }
});

/**
 * 优雅退出：容器 `docker stop` 与 systemd `systemctl stop` 发的都是 SIGTERM。
 * Node 默认信号处理不会触发 process.on('exit')，若直接死掉，db 里 50ms 防抖窗口内的
 * 写入会丢（充值、订单、项目这类数据不能赌）。所以这里显式停接入 → 落盘 → 退出。
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('收到退出信号，开始优雅关闭', { signal });
  const force = setTimeout(() => {
    logger.error('优雅关闭超时，强制退出', { timeoutMs: 8000 });
    try { db.flush(); } catch { /* 已尽力 */ }
    process.exit(1);
  }, 8000);
  force.unref();

  server.close(() => {
    try {
      db.flush();
      logger.info('数据已落盘，进程退出', { signal });
    } catch (e) {
      logger.error('退出前落盘失败', { msg: e.message });
    }
    clearTimeout(force);
    process.exit(0);
  });
  // 兜底端口一并关闭，避免残留句柄拖住退出
  for (const s of extraServers) {
    try { s.close(); } catch { /* 忽略 */ }
  }
  // 保持连接不拖死退出流程：10s 后由上面的兜底强制结束
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
