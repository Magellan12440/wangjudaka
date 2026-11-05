#!/usr/bin/env node
/**
 * 算力密钥连通性体检（V4.3.1）。
 *
 * 用途：在管理台填完密钥后，命令行也能独立验证「真的能出字、真的按 token 计费」。
 * 与探活脚本的区别：探活只打 64 token 的 ping；这里走完整编译链（PromptCompiler → RelayAdapter），
 * 用一句真实的编剧指令，验证签名、鉴权、计费换算、正文解析四段都通。
 *
 * 用法：
 *   node scripts/live_relay_check.js                 # 默认模型（DeepSeek V4.1）
 *   node scripts/live_relay_check.js --model LLM-PLOT-PRO
 *   node scripts/live_relay_check.js --mock          # 只验链路，不出网
 */
import { config, relayHealthSummary } from '../src/config/env.js';
import { PromptCompiler } from '../src/compiler/PromptCompiler.js';
import relay from '../src/relay/RelayAdapter.js';
import { modelCatalog } from '../src/relay/ModelCatalog.js';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const mock = argv.includes('--mock');
if (mock) config.relay.mock = true;

const modelCode = arg('--model') ?? modelCatalog.defaultFor('chat');

const compiler = new PromptCompiler();
const compiled = compiler.compile({
  kind: 'chat',
  model: modelCode,
  available_credits: 100,
  max_tokens: 300,
  system: '你是短剧编剧，只输出正文，不要解释。',
  user: '用一句话写一个都市悬疑短剧的开场钩子，不超过 40 字。',
});

console.log('通道：', relayHealthSummary());
console.log('模型：', modelCode, '→', compiled.target_model);

const started = Date.now();
try {
  const r = await relay.call(compiled, { purpose: 'preview' });
  const ms = Date.now() - started;
  const text = String(r.text ?? '').trim();
  console.log('\n耗时：', ms, 'ms');
  console.log('计费点数：', r.actual_credits, r.mock ? '（演练，未真实扣费）' : '（按实际 token 换算）');
  console.log('正文：', text ? text.slice(0, 200) : '(空)');
  if (!text) {
    console.error('\n❌ 有响应但没有正文，检查模型是否为推理型或输出上限过小');
    process.exit(1);
  }
  console.log('\n✅ 密钥可用：编译 → 鉴权 → 调用 → 计费 全链路通');
} catch (e) {
  console.error('\n❌ 调用失败：', e.code ?? '', e.message);
  process.exit(1);
}
