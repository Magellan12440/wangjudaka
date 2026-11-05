/** 阶段 H / P0-1：HTTP 比对 provider 框架 —— 绝不假装通过 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpCompareProvider, extractScore } from '../src/qc/providers/HttpCompareProvider.js';
import { configureProviders, providerStatus, createConfiguredProvider } from '../src/qc/providers/index.js';
import { ConsistencyChecker } from '../src/qc/ConsistencyChecker.js';

const ENDPOINT = 'https://qc.example.com/compare';
const TOKEN = 'secret-token-should-never-leak';
const REF = { locks: ['pine-green jacket'], emotion_codes: ['EMO-X'] };

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}
const okResp = (body) => ({ ok: true, status: 200, json: async () => body });

test('extractScore：只认 0~1 的有限数字，越界与字符串一律拒绝', () => {
  assert.equal(extractScore({ score: 0.82 }), 0.82);
  assert.equal(extractScore({ similarity: 0 }), 0);
  assert.equal(extractScore({ data: { score: 0.91 } }), 0.91);
  assert.equal(extractScore({ result: { score: 1 } }), 1);
  assert.equal(extractScore({ score: 1.5 }), null);
  assert.equal(extractScore({ score: '0.9' }), null);
  assert.equal(extractScore({ score: NaN }), null);
  assert.equal(extractScore({ error: 'upstream down' }), null);
  assert.equal(extractScore(null), null);
});

test('未配置 endpoint：available=false，同步与异步都不产出分数', async () => {
  const p = new HttpCompareProvider({ endpoint: '', token: '', fetchImpl: fakeFetch(() => okResp({ score: 0.99 })) });
  assert.equal(p.available, false);
  assert.equal(p.syncCompare().score, null);
  assert.match(p.syncCompare().reason, /未配置/);
  const r = await p.compareAsync({ reference: REF, candidate: REF });
  assert.equal(r.score, null);
  assert.match(r.reason, /未配置/);
});

test('配置后：真实分数被采信并附来源维度', async () => {
  const p = new HttpCompareProvider({
    endpoint: ENDPOINT, token: TOKEN,
    fetchImpl: fakeFetch(async () => okResp({ score: 0.91, dimensions: { locks: 0.9, emotion: 0.95 } })),
  });
  assert.equal(p.available, true);
  const r = await p.compareAsync({ reference: REF, candidate: REF, generatedUrl: 'cos://a.png' });
  assert.equal(r.score, 0.91);
  assert.equal(r.dimensions.provider, 'http_clip');
  assert.equal(r.dimensions.external, true);
  assert.equal(r.dimensions.locks, 0.9);
  assert.equal(r.source, 'http_clip');
});

test('红线：HTTP 500 / 无分数 / 抛异常 / 超时都降级，绝不兜底给高分', async () => {
  const cases = [
    fakeFetch(async () => ({ ok: false, status: 503 })),
    fakeFetch(async () => okResp({ error: 'no score' })),
    fakeFetch(async () => { throw new Error('ECONNRESET'); }),
    fakeFetch(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }),
  ];
  for (const f of cases) {
    const p = new HttpCompareProvider({ endpoint: ENDPOINT, fetchImpl: f });
    const r = await p.compareAsync({ reference: REF, candidate: REF });
    assert.equal(r.score, null);
    assert.ok(r.reason && r.reason.length > 0);
  }
});

test('status()：不回显 token 与完整 endpoint', () => {
  const p = new HttpCompareProvider({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: fakeFetch(() => okResp({ score: 0.8 })) });
  const s = p.status();
  assert.equal(s.endpoint_host, 'qc.example.com');
  assert.equal(s.has_token, true);
  assert.equal(s.available, true);
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  assert.ok(!JSON.stringify(s).includes(ENDPOINT));
});

test('configureProviders：未配置时不注册任何 provider（恒 degraded）', () => {
  const fresh = new ConsistencyChecker();
  const r = configureProviders({ checker: fresh, overrides: { endpoint: '', fetchImpl: fakeFetch(() => okResp({ score: 0.99 })) } });
  assert.equal(r.configured, false);
  assert.equal(r.registered.length, 0);
  assert.ok(!fresh.listProviders().some((p) => p.name === 'http_clip'));
});

test('configureProviders：显式配置才注册，安全摘要不含凭据', () => {
  const fresh = new ConsistencyChecker();
  const r = configureProviders({
    checker: fresh,
    overrides: { endpoint: ENDPOINT, token: TOKEN, fetchImpl: fakeFetch(() => okResp({ score: 0.9 })) },
  });
  assert.equal(r.configured, true);
  assert.ok(fresh.listProviders().some((p) => p.name === 'http_clip' && p.available));
  assert.ok(!JSON.stringify(r).includes(TOKEN));
  assert.ok(!JSON.stringify(r).includes(ENDPOINT));
});

test('checkAsync：真实分数 → pass，且同步 check() 契约未被破坏', async () => {
  const fresh = new ConsistencyChecker();
  configureProviders({
    checker: fresh,
    overrides: { endpoint: ENDPOINT, fetchImpl: fakeFetch(() => okResp({ score: 0.93, dimensions: { locks: 0.93 } })) },
  });
  const rec = await fresh.checkAsync({
    projectId: 'P_ASYNC', shotNo: 'E01-S001', reference: REF, candidate: REF,
    providerName: 'http_clip',
  });
  assert.equal(rec.verdict, 'pass');
  assert.equal(rec.score, 0.93);
  assert.equal(rec.provider, 'http_clip');
  assert.equal(rec.dimensions.external, true);

  // 误用同步路径：同步壳不产出分数，必须降级而不是假装通过
  const wrong = fresh.check({
    projectId: 'P_ASYNC', shotNo: 'E01-S002', reference: REF, candidate: REF,
    providerName: 'http_clip',
  });
  assert.equal(wrong.verdict, 'degraded');
  assert.equal(wrong.score, null);
});

test('checkAsync：上游降级 / 未注册异步 provider → 继续 degraded，不假装通过', async () => {
  const fresh = new ConsistencyChecker();
  configureProviders({
    checker: fresh,
    overrides: { endpoint: ENDPOINT, fetchImpl: fakeFetch(async () => ({ ok: false, status: 500 })) },
  });
  const r1 = await fresh.checkAsync({ projectId: 'P_ASYNC', shotNo: 'E01-S003', providerName: 'http_clip' });
  assert.equal(r1.verdict, 'degraded');
  assert.equal(r1.score, null);
  assert.match(r1.note, /HTTP 500/);

  const plain = new ConsistencyChecker();
  const r2 = await plain.checkAsync({ projectId: 'P_ASYNC', shotNo: 'E01-S004' });
  assert.equal(r2.verdict, 'degraded');
  assert.equal(r2.score, null);
});

test('createConfiguredProvider / providerStatus：默认不配置，状态可安全下发', () => {
  const p = createConfiguredProvider({ endpoint: '', fetchImpl: fakeFetch(() => okResp({ score: 1 })) });
  assert.equal(p.available, false);
  const s = providerStatus();
  assert.equal(typeof s.configured, 'boolean');
  assert.ok(Array.isArray(s.providers));
  assert.ok(!JSON.stringify(s).includes(TOKEN));
});
