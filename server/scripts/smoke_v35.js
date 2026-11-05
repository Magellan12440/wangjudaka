#!/usr/bin/env node
/**
 * V3.5 端到端 HTTP 冒烟：登录态 / 内容安全 / 虚拟支付（mock 联调链路）。
 * 跑通微信三件套的完整闭环。
 *
 * - 指定 SMOKE_BASE：打到已运行的服务
 * - 未指定：自启动一个临时服务（独立 DATA_DIR + 强制 mock），跑完自动关停
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_V35_PORT || 8798);
let BASE = process.env.SMOKE_BASE || `http://127.0.0.1:${PORT}`;
let child = null;

const steps = [];
let failures = 0;
const allText = [];

function ok(name, pass, extra = '') {
  steps.push({ name, pass: !!pass, extra: String(extra) });
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!pass) failures += 1;
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  allText.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, json, text };
}

const data = (r) => r.json?.data;

async function reachable() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

/** 没有现成服务时自启一个临时服务（独立数据目录 + 强制 mock），跑完即关 */
async function bootstrapServer() {
  if (process.env.SMOKE_BASE || await reachable()) return;
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(os.tmpdir(), `wangjudaka-smoke-v35-${process.pid}-${Date.now()}`),
      RELAY_MOCK: 'true',
      NODE_ENV: 'test',
      // 屏蔽 .env.local 真实微信凭据，避免假 code 打到真接口
      WX_APPID: '', WX_SECRET: '', WX_PAY_OFFER_ID: '', WX_PAY_APP_KEY: '', RELAY_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 80; i += 1) {
    if (await reachable()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`临时服务未启动\n${log}`);
}

async function main() {
  await bootstrapServer();
  console.log(`=== V3.5 冒烟（微信三件套） @ ${BASE} ===`);

  // 1. 健康
  const h = await call('GET', '/health');
  ok('服务健康 /health', h.status === 200);

  // 2. 微信通道状态自检（应显式标注 mock/live）
  const ws = await call('GET', '/api/wechat/status');
  ok('微信通道状态自检', ws.status === 200 && ['mock', 'live'].includes(data(ws)?.mode), `mode=${data(ws)?.mode}`);

  // 3. 登录 → token
  const login = await call('POST', '/api/auth/login', { code: `smoke_${Date.now()}` });
  const token = data(login)?.token;
  ok('POST /api/auth/login 返回 token', login.status === 200 && typeof token === 'string' && token.includes('.'));
  const auth = { Authorization: `Bearer ${token}` };
  const uid = data(login)?.user?.id;

  // 4. 登录幂等：同 code 同用户
  const login2 = await call('POST', '/api/auth/login', { code: `smoke_same` });
  const login3 = await call('POST', '/api/auth/login', { code: `smoke_same` });
  ok('同一 code 幂等同一用户', data(login2)?.user?.id === data(login3)?.user?.id);

  // 5. /me 带 token
  const me = await call('GET', '/api/auth/me', null, auth);
  ok('GET /api/auth/me 带 token 返回用户', me.status === 200 && data(me)?.user?.id === uid);

  // 6. /me 无 token → 401
  const me401 = await call('GET', '/api/auth/me');
  ok('GET /api/auth/me 无 token → 401', me401.status === 401);

  // 7. 点数包
  const pkgs = await call('GET', '/api/pay/packages');
  ok('GET /api/pay/packages', pkgs.status === 200 && data(pkgs)?.packages?.length >= 3, `pay_mode=${data(pkgs)?.pay_mode}`);

  // 8. 下单（带 token）
  const order = await call('POST', '/api/pay/virtual/order', { packageId: 'PKG-100' }, auth);
  ok('POST /api/pay/virtual/order 建单', order.status === 200 && data(order)?.order_id, `mode=${data(order)?.mode}`);

  // 9. 下单（无 token）→ 401
  const order401 = await call('POST', '/api/pay/virtual/order', { packageId: 'PKG-100' });
  ok('未登录下单 → 401', order401.status === 401);

  // 10. mock 发货 → 余额到账
  const pay = await call('POST', '/api/pay/virtual/mock-success', { orderId: data(order)?.order_id });
  ok('mock 发货入账（余额 +100）', pay.status === 200 && data(pay)?.balance >= 100, `balance=${data(pay)?.balance}`);

  // 11. 重复发货幂等
  const pay2 = await call('POST', '/api/pay/virtual/mock-success', { orderId: data(order)?.order_id });
  ok('重复发货幂等（duplicated）', data(pay2)?.duplicated === true);

  // 12. 支付回调：未配置商户号时必须拒绝（红线）
  const notify = await call('POST', '/api/pay/virtual/notify', { out_trade_no: data(order)?.order_id });
  ok('未配置商户号时回调验签拒绝', notify.status === 400 && /验签失败/.test(notify.text));

  // 13. 项目创建（机审 mock 放行，验证链路不阻断正常创作）
  const proj = await call('POST', '/api/projects', { userId: uid, title: 'V3.5 冒烟漫剧', prompt: '一只折纸鹤的治愈之旅' });
  ok('POST /api/projects 机审通过并建项目', proj.status === 200 && data(proj)?.id);

  // 14. 主动机审接口
  const sec = await call('POST', '/api/security/check', { content: '测试一段正常文案', bizType: 'smoke' });
  ok('POST /api/security/check 返回 pass+mode', sec.status === 200 && data(sec)?.pass === true && !!data(sec)?.mode);

  // 15. 机审审计可查
  const audit = await call('GET', '/api/security/audit?bizType=smoke');
  ok('GET /api/security/audit 审计可查', audit.status === 200 && Array.isArray(data(audit)) && data(audit).length >= 1);

  // 16. 全部响应凭据零泄漏（匹配「键=值」形态，避免误伤状态说明文字）
  const joined = allText.join('\n');
  const leaked = /sk-[A-Za-z0-9]{8,}|RELAY_API_KEY=|WX_SECRET=[^\s，]|WX_PAY_APP_KEY=|RELAY_CONSOLE_PASSWORD=|y1244011310/.test(joined);
  ok('全部响应凭据零泄漏', !leaked);

  console.log(`\n结果：${steps.length - failures}/${steps.length} 通过`);
  process.exitCode = failures ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('冒烟执行异常:', e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (child) child.kill();
  });
