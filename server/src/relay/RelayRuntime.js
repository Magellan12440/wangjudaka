/**
 * 算力网关运行时配置（V4.3.1）。
 *
 * 为什么要有这层：密钥不能进 git（仓库是公开的），而云托管的环境变量只有控制台能改。
 * 于是把「网关地址 + 密钥 + 是否 mock」做成管理台可写、存数据盘的运行时配置：
 *   优先级：管理台设置 > 环境变量 > 代码默认
 *   改完立即生效，不用重新发版；换密钥只影响下一个请求。
 *
 * 安全约束：
 *  - 只允许管理员写（路由层已过 X-Admin-Token）；
 *  - 读取一律脱敏，任何接口都不会回吐完整密钥；
 *  - 网关地址只允许 http/https，防 file:// 之类被写成读取本地文件的手段。
 */
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';

const KEY = 'relay_runtime';

/** 脱敏：只露前 5 位与后 4 位，中间打码 */
export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length <= 12) return `${s.slice(0, 3)}****`;
  return `${s.slice(0, 5)}****${s.slice(-4)}`;
}

function readRow() {
  const row = db.findOne('app_settings', (s) => s.key === KEY);
  return row?.value ?? null;
}

function writeRow(value) {
  const row = db.findOne('app_settings', (s) => s.key === KEY);
  if (row) db.update('app_settings', row.id, { value, updated_at: nowIso() });
  else db.insert('app_settings', { id: newId('set'), key: KEY, value, updated_at: nowIso() });
}

/**
 * 启动时套用已保存的运行时配置。
 * 没配过就什么都不做，沿用环境变量（这是首次部署的正常路径）。
 */
export function loadRelayRuntime() {
  const saved = readRow();
  if (!saved) return { applied: false };
  applyToConfig(saved);
  logger.info('已套用管理台保存的算力网关配置', { gateway: config.relay.gateway, mock: config.relay.mock });
  return { applied: true, ...view() };
}

function applyToConfig(saved) {
  if (saved.gateway) config.relay.gateway = saved.gateway;
  if (saved.apiKey) {
    config.relay.apiKey = saved.apiKey;
    // 显式保存过 false 才关；保存 true 就保持 mock（便于自测）
    config.relay.mock = saved.mock === true;
  } else if (typeof saved.mock === 'boolean') {
    config.relay.mock = saved.mock;
  }
}

/**
 * 保存并立即生效。
 * @param {{apiKey?:string, gateway?:string, mock?:boolean}} patch
 */
export function saveRelayRuntime(patch = {}) {
  const cur = readRow() ?? {};
  const next = { ...cur };

  if (patch.apiKey !== undefined) {
    const k = String(patch.apiKey ?? '').trim();
    if (k) {
      if (!/^[-A-Za-z0-9_.:]{16,200}$/.test(k)) {
        fail('RELAY_KEY_INVALID', '密钥格式不对：应为 16 位以上的字母数字串（通常以 sk- 开头）');
      }
      next.apiKey = k;
    } else {
      // 传空字符串 = 清除，回到环境变量或 mock
      delete next.apiKey;
    }
  }

  if (patch.gateway !== undefined) {
    const g = String(patch.gateway ?? '').trim().replace(/\/+$/, '');
    if (g) {
      let u;
      try {
        u = new URL(g);
      } catch {
        fail('RELAY_GATEWAY_INVALID', '网关地址不是合法 URL');
      }
      if (!['http:', 'https:'].includes(u.protocol)) {
        fail('RELAY_GATEWAY_INVALID', '网关地址只支持 http/https');
      }
      next.gateway = g;
    } else {
      delete next.gateway;
    }
  }

  if (patch.mock !== undefined) next.mock = !!patch.mock;
  next.updated_at = nowIso();

  writeRow(next);

  // 先回退到环境变量基线，再套用新值，避免「清了密钥却还在用旧的」
  config.relay.gateway = process.env.RELAY_GATEWAY?.trim() || 'https://api.lingkeai.ai/v1';
  const envKey = process.env.RELAY_API_KEY?.trim() || '';
  config.relay.apiKey = envKey;
  config.relay.mock = String(process.env.RELAY_MOCK ?? '').toLowerCase() === 'true' || !config.relay.apiKey;
  applyToConfig(next);

  logger.info('算力网关配置已更新', { gateway: config.relay.gateway, mock: config.relay.mock, hasKey: Boolean(config.relay.apiKey) });
  return view();
}

/** 脱敏视图：给管理台看的状态 */
export function view() {
  const saved = readRow();
  return {
    gateway: config.relay.gateway,
    api_key_masked: maskKey(config.relay.apiKey),
    has_api_key: Boolean(config.relay.apiKey),
    mock: Boolean(config.relay.mock),
    source: saved?.apiKey ? 'admin' : config.relay.apiKey ? 'env' : 'none',
    updated_at: saved?.updated_at ?? null,
    max_concurrency: config.relay.maxConcurrency,
    rpm_limit: config.relay.rpmLimit,
  };
}

export default { loadRelayRuntime, saveRelayRuntime, view, maskKey };
