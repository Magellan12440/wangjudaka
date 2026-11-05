/**
 * 比对 provider 装配入口（P0-1 框架）。
 *
 * 只有在显式配置 QC_COMPARE_ENDPOINT 时才注册真实比对能力；否则不注册任何
 * provider，所有镜头继续恒 degraded（§25.4 的刻意设计，不允许跳过）。
 * 本模块绝不把 token / 完整 endpoint 写进任何返回值或日志。
 */
import { config } from '../../config/env.js';
import consistencyChecker from '../ConsistencyChecker.js';
import { HttpCompareProvider } from './HttpCompareProvider.js';

export { HttpCompareProvider, extractScore } from './HttpCompareProvider.js';

export const CONFIG_KEYS = [
  'QC_COMPARE_ENDPOINT',
  'QC_COMPARE_TOKEN',
  'QC_COMPARE_TIMEOUT_MS',
  'QC_COMPARE_PROVIDER_NAME',
];

export function createConfiguredProvider(overrides = {}) {
  return new HttpCompareProvider({
    name: overrides.name ?? config.qc.compareProviderName,
    endpoint: overrides.endpoint ?? config.qc.compareEndpoint,
    token: overrides.token ?? config.qc.compareToken,
    timeoutMs: overrides.timeoutMs ?? config.qc.compareTimeoutMs,
    fetchImpl: overrides.fetchImpl ?? null,
  });
}

/**
 * 按环境配置装配 provider 并注册到 checker。
 * 返回可被 /api/qc/providers/config 直接下发的安全摘要。
 */
export function configureProviders({ checker = consistencyChecker, overrides = {} } = {}) {
  const provider = createConfiguredProvider(overrides);
  const registered = [];
  if (provider.available) {
    checker.registerProvider({
      name: provider.name,
      available: true,
      compare: () => provider.syncCompare(),
      compareAsync: (args) => provider.compareAsync(args),
      status: () => provider.status(),
    });
    registered.push(provider.name);
  }
  return {
    configured: provider.available,
    provider: provider.name,
    registered,
    status: provider.status(),
    config_keys: CONFIG_KEYS,
    note: provider.available
      ? '已注册 HTTP 比对服务；请通过 checkAsync 接口或脚本触发真实打分'
      : '未配置 QC_COMPARE_ENDPOINT：不注册任何比对能力，所有镜头恒 degraded（不假装通过）',
  };
}

/** 给运维/前端看的安全状态，不含任何凭据 */
export function providerStatus({ checker = consistencyChecker } = {}) {
  return {
    configured: Boolean(config.qc.compareEndpoint),
    default_name: config.qc.compareProviderName,
    endpoint_host: (() => {
      try {
        return new URL(config.qc.compareEndpoint).host;
      } catch {
        return null;
      }
    })(),
    has_token: Boolean(config.qc.compareToken),
    timeout_ms: config.qc.compareTimeoutMs,
    providers: checker.listProviders(),
  };
}

export default configureProviders;
