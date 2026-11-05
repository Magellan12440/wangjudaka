#!/usr/bin/env node
/**
 * LIVE 最小成本真机验收（V3.5）。
 *
 * 用途：用真实 API Key 对真实网关做端到端冒烟，验证：
 *  1. 余额接口（/skills/balance）→ RelayPool 真实水位
 *  2. chat 同步链路（/chat/completions）
 *  3. 媒体任务制链路（/media/generate → /skills/task-status 轮询）
 *  4. 全程凭据不出现在任何输出里
 *
 * 安全：
 *  - 必须显式 --live 才会执行（防止 CI/手滑误跑真实计费）。
 *  - 默认只做 chat（≈0.001 算力）+ image（≈0.023 算力）；
 *    --with-video 追加一次 3 秒 480P 视频（≈1.3 算力）。
 *  - 全程打印「算力消耗前后对比」，让每一分真实消耗可追溯。
 *
 * 用法：
 *   node scripts/live_smoke.js --live
 *   node scripts/live_smoke.js --live --with-video
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const WITH_VIDEO = args.includes('--with-video');

if (!LIVE) {
  console.log('这是真实计费冒烟。确认要消耗主账号算力请加 --live；要连视频一起验再加 --with-video。');
  process.exit(0);
}

// 强制 live 模式（必须在任何 config import 之前设置；env.js 不覆盖已有进程变量）
process.env.RELAY_MOCK = 'false';
if (!process.env.DATA_DIR) process.env.DATA_DIR = './data';

const { config } = await import('../src/config/env.js');
const { relayPool } = await import('../src/relay/RelayPool.js');
const { relay, issueStamp } = await import('../src/relay/RelayAdapter.js');

const REPORT = path.resolve(__dirname, '..', 'data', 'live_smoke_report.json');
const steps = [];
let failures = 0;

function ok(name, pass, extra = '') {
  steps.push({ name, pass: !!pass, extra: String(extra) });
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures += 1;
}

function makeCompiled({ kind, target_model, prompt_en, prompt_zh, params = {}, reference_images = [] }) {
  const compiled = {
    kind, target_model, prompt_en, prompt_zh,
    shot_no: null, reference_images, params, estimated_credits: 1,
  };
  compiled._stamp = issueStamp(compiled);
  return compiled;
}

async function balance() {
  const r = await relayPool.refreshBalance({ force: true });
  return r.balance;
}

async function main() {
  console.log('=== LIVE 真机验收（真实计费）===');
  console.log(`网关: ${config.relay.gatewayHost ?? new URL(config.relay.gateway).host} | 模式: ${config.relay.mock ? 'mock(异常!)' : 'live'}`);
  ok('live 模式已生效', config.relay.mock === false);
  ok('API Key 已配置', Boolean(config.relay.apiKey));

  const before = await balance();
  ok('余额接口可用（/skills/balance）', typeof before === 'number', `当前余额 ${before} 算力`);
  if (typeof before !== 'number' || before < 1) {
    console.log('余额不足 1 算力，停止以保护账户。请先充值。');
    process.exit(1);
  }

  // —— 1. chat 同步链路 ——
  const t0 = Date.now();
  try {
    const chat = await relay.call(makeCompiled({
      kind: 'chat',
      target_model: 'LLM-PLOT',
      prompt_en: 'Reply with exactly: OK',
      prompt_zh: '只回复两个字：正常',
      params: { temperature: 0, max_tokens: 16 },
    }));
    ok('chat 同步链路（/chat/completions → glm-5.3-flash）', chat.ok && typeof chat.text === 'string' && chat.text.length > 0,
      `耗时 ${Date.now() - t0}ms，消耗 ${chat.actual_credits} 点，返回「${(chat.text ?? '').slice(0, 30)}」`);
  } catch (e) {
    ok('chat 同步链路（/chat/completions）', false, `${e.code ?? ''} ${e.message}`);
  }

  // —— 2. image 任务制链路 ——
  const t1 = Date.now();
  try {
    const img = await relay.call(makeCompiled({
      kind: 'image',
      target_model: 'IMG-FAST',
      prompt_en: 'A single red origami paper crane on a plain white background, minimalist, clean studio lighting',
      prompt_zh: '一只红色折纸鹤，纯白背景，极简',
      params: { resolution: '1080x1920' },
    }));
    ok('image 任务制链路（/media/generate → 轮询 → tt-image-2.5）', img.ok && /^https?:\/\//.test(img.url ?? ''),
      `耗时 ${Math.round((Date.now() - t1) / 1000)}s，真实扣费 ${img.actual_suanli ?? '?'} 算力，url 已取得`);
    if (img.url) console.log(`   图片地址(24h 内有效): ${img.url.slice(0, 90)}…`);
  } catch (e) {
    ok('image 任务制链路', false, `${e.code ?? ''} ${e.message}`);
  }

  // —— 3. video 任务制链路（可选，≈1.3 算力） ——
  if (WITH_VIDEO) {
    const t2 = Date.now();
    try {
      const vid = await relay.call(makeCompiled({
        kind: 'video',
        target_model: 'VID-CHEAP',
        prompt_en: 'A red origami paper crane slowly flapping its wings on a white table, static camera, soft light',
        prompt_zh: '红色折纸鹤在白色桌面上缓慢扇动翅膀，固定镜头',
        params: { resolution: '854x480', duration: 3 },
      }));
      ok('video 任务制链路（wan3.0-video 3s 480P）', vid.ok && /^https?:\/\//.test(vid.url ?? ''),
        `耗时 ${Math.round((Date.now() - t2) / 1000)}s，真实扣费 ${vid.actual_suanli ?? '?'} 算力`);
      if (vid.url) console.log(`   视频地址(24h 内有效): ${vid.url.slice(0, 90)}…`);
    } catch (e) {
      ok('video 任务制链路', false, `${e.code ?? ''} ${e.message}`);
    }
  } else {
    console.log('⏭  视频链路跳过（加 --with-video 启用，约 1.3 算力）');
  }

  // —— 4. 真实消耗对账 ——
  const after = await balance();
  const spent = typeof before === 'number' && typeof after === 'number' ? Number((before - after).toFixed(4)) : null;
  ok('真实消耗对账（余额差额 > 0）', typeof spent === 'number' && spent > 0, `本次消耗 ${spent} 算力，剩余 ${after}`);

  // —— 5. 凭据零泄漏自检 ——
  const allText = JSON.stringify(steps);
  const leaked = /sk-[A-Za-z0-9]{8,}|RELAY_API_KEY=|Bearer [A-Za-z0-9]/.test(allText);
  ok('冒烟输出凭据零泄漏', !leaked);

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), spentSuanli: spent, steps }, null, 2));
  console.log(`\n报告: ${REPORT}`);
  console.log(failures === 0 ? '\n🎉 LIVE 验收通过' : `\n💥 ${failures} 项失败`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('live 冒烟执行异常:', e.message);
  process.exitCode = 1;
});
