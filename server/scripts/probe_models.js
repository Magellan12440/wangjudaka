#!/usr/bin/env node
/**
 * 模型探活 CLI（V4.3）。
 *
 * 用法：
 *   node scripts/probe_models.js           # 核对网关清单（不产生生成费用）
 *   node scripts/probe_models.js --deep    # chat 模型做一次最小真实调用
 *
 * 结果写入 <DATA_DIR>/model_health.json，用户端模型选择器立即按结果过滤：
 * 探活失败（down）或清单里没有（unavailable）的模型不再出现在可选列表。
 */
import { probeModels } from '../src/relay/probeModels.js';

const deep = process.argv.includes('--deep');

probeModels({ deep })
  .then((r) => {
    const down = Object.entries(r.models).filter(([, v]) => v.status !== 'ok');
    console.log(`探活完成：${Object.keys(r.models).length} 个模型，${down.length} 个不可用`);
    for (const [code, v] of down) console.log(`  - ${code}: ${v.status} ${v.note ?? ''}`);
  })
  .catch((e) => {
    console.error(`探活失败：${e.message}`);
    process.exit(1);
  });
