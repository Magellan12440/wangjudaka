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

// 导演总谱在规划阶段需要读角色情绪档案；用全局只读句柄避免启动期循环依赖
globalThis.__lingwuAssetLibrary = assetLibrary;

// V3.6：充值档次默认播种（幂等，集合非空时不动）
adminService.seedDefaultPackages();

const v = seeds.validate();
if (!v.ok) {
  logger.error('种子库自检未通过，服务仍将启动但生成可能被拒', { problems: v.problems.slice(0, 10) });
} else {
  logger.info('种子库自检通过', v.counts);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    logger.error('未捕获异常', { msg: e.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'INTERNAL', message: '服务内部错误' }));
  });
});

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
  // 保持连接不拖死退出流程：10s 后由上面的兜底强制结束
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
