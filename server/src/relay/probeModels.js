/**
 * 模型探活（V4.3）：把「实测不能用的大模型」从用户可选列表里剔除。
 *
 * 策略（成本与诚实之间取平衡）：
 *  1. 先拉网关 /models 清单：不在清单里的模型直接判 unavailable（下架/改名）。
 *  2. chat 模型做一次最小真实调用（max_tokens=8）：这是唯一能不烧钱又验证「真能回话」的方式。
 *  3. 图片/视频/配音有明确单价，探活会真扣算力，所以只在管理员显式传 deep=true 时才跑，
 *     否则仅按清单判定（清单没有 = 不可用；清单有 = 可用但未逐次验证）。
 *
 * 结果写入 <dataDir>/model_health.json，ModelCatalog 据此过滤；带 checked_at 便于追溯。
 */
import { config } from '../config/env.js';
import seeds from '../seeds/loader.js';
import { fail } from '../core/errors.js';
import { modelCatalog } from './ModelCatalog.js';
import { logger } from '../core/redact.js';

async function gateway(pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const base = config.relay.gateway.replace(/\/+$/, '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.relay.apiKey}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeModels({ deep = false } = {}) {
  if (!config.relay.apiKey) {
    fail('RELAY_NOT_CONFIGURED', '未配置 RELAY_API_KEY，无法探活；请先在云托管环境变量里填入算力网关密钥');
  }
  const listed = await gateway('/models');
  const ids = new Set(
    (Array.isArray(listed.json?.data) ? listed.json.data : Array.isArray(listed.json?.models) ? listed.json.models : [])
      .map((x) => String(x?.id ?? x?.name ?? x))
  );

  const results = [];
  const roles = seeds.catalogRoles();
  const seen = new Set();
  for (const role of roles) {
    const list = modelCatalog.list(role);
    for (const item of list.items) {
      if (seen.has(item.code)) continue;
      seen.add(item.code);
      const model = seeds.model(item.code);
      if (!model) continue;
      const at = new Date().toISOString();
      if (!ids.has(String(model.upstream_id))) {
        results.push({ code: item.code, status: 'unavailable', checked_at: at, note: '网关清单中不存在该上游模型' });
        continue;
      }
      if (model.role !== 'chat' || !deep) {
        results.push({ code: item.code, status: 'ok', checked_at: at, note: deep ? '清单命中' : '仅核对清单（未做生成调用）' });
        continue;
      }
      const started = Date.now();
      try {
        const r = await gateway('/chat/completions', {
          method: 'POST',
          body: {
            model: model.upstream_id,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 8,
            temperature: 0,
          },
        });
        const ok = r.ok && Boolean(r.json?.choices?.[0]?.message?.content);
        results.push({
          code: item.code,
          status: ok ? 'ok' : 'down',
          latency_ms: Date.now() - started,
          checked_at: at,
          note: ok ? '最小调用成功' : `调用失败 HTTP ${r.status}`,
        });
      } catch (e) {
        results.push({ code: item.code, status: 'down', checked_at: at, note: e.message });
      }
    }
  }

  logger.info('模型探活完成', { count: results.length, down: results.filter((r) => r.status === 'down').length });
  return modelCatalog.recordHealth({ results, at: new Date().toISOString() });
}

export default probeModels;
