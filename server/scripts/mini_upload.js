#!/usr/bin/env node
/**
 * 小程序「上传 / 预览」命令行工具（微信官方 miniprogram-ci 的薄封装）。
 *
 * 为什么需要它：微信只认「代码上传密钥」（.key 文件），**AppSecret 不能上传代码**。
 * 密钥必须由小程序管理员本人在后台下载：
 *   微信公众平台 → 管理 → 开发管理 → 开发设置 → 小程序代码上传 → 生成/下载密钥
 * 下载后放到 miniprogram/private.<appid>.key（已在 .gitignore 里，不会误提交）。
 *
 * 用法：
 *   npm run mini:doctor            # 体检：密钥 / 依赖 / appid / 各环境后端地址
 *   npm run mini:lan               # 打印电脑局域网 IP（手机内测填 develop 用）
 *   npm run mini:preview           # 生成预览二维码（开发版，手机扫码）
 *   npm run mini:upload -- --version 1.0.1 --desc "内测第一版"
 *
 * 注意：本脚本只能做到「上传成开发版」。上传后还要在后台
 * 「版本管理 → 开发版本」手动点「选为体验版」或「提交审核」——
 * 提审没有开放给个人开发者的接口，必须管理员在后台确认。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const MINI_ROOT = path.resolve(SERVER_ROOT, '../miniprogram');
const PC_CFG = path.join(MINI_ROOT, 'project.config.json');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i > -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function defaultVersion() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `1.0.${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function appid() {
  try {
    return String(readJson(PC_CFG).appid || '').trim();
  } catch {
    return '';
  }
}

/** 密钥查找顺序：环境变量 → miniprogram/private.<appid>.key → miniprogram/private.key */
function findKey(id) {
  const candidates = [
    process.env.MINI_UPLOAD_KEY,
    path.join(MINI_ROOT, `private.${id}.key`),
    path.join(MINI_ROOT, 'private.key'),
    path.join(SERVER_ROOT, `private.${id}.key`),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 继续找下一个 */ }
  }
  return '';
}

/** 各环境的后端地址（直接读 config.js，避免两处维护） */
function hosts() {
  const src = fs.readFileSync(path.join(MINI_ROOT, 'config.js'), 'utf8');
  const out = {};
  for (const env of ['develop', 'trial', 'release']) {
    const m = src.match(new RegExp(`${env}:\\s*'([^']+)'`));
    if (m) out[env] = m[1];
  }
  return out;
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
  }
  return out;
}

function loadCi() {
  try {
    return require('miniprogram-ci');
  } catch {
    console.error(C.err('\n缺少依赖 miniprogram-ci（官方上传 SDK）。在 server/ 下执行：'));
    console.error('  npm install -D miniprogram-ci\n');
    console.error(C.dim('装完重跑本命令即可；不想装也可以用微信开发者工具的「上传」按钮。\n'));
    process.exit(2);
  }
}

// —— doctor ——
async function doctor() {
  const id = appid();
  const key = findKey(id);
  let ciInstalled = true;
  try { require.resolve('miniprogram-ci'); } catch { ciInstalled = false; }

  console.log(C.b('\n小程序上传环境体检\n'));
  console.log(`  AppID            ${id || C.err('缺失（project.config.json）')}`);
  console.log(`  小程序目录       ${MINI_ROOT}`);
  console.log(`  上传密钥         ${key ? C.ok(key) : C.err('未找到 .key 文件')}`);
  console.log(`  miniprogram-ci   ${ciInstalled ? C.ok('已安装') : C.warn('未安装（npm install -D miniprogram-ci）')}`);

  // 账号类型：用密钥问微信本身。小游戏账号传不了小程序代码，必须在这里拦住
  let isGame = false;
  if (key && ciInstalled) {
    try {
      const probe = project(id, key);
      const a = await probe.attr();
      isGame = Boolean(a && a.gameApp);
      const name = a && a.appName ? C.dim(`  ${a.appName}`) : '';
      console.log(`  账号类型         ${isGame ? C.err('小游戏 —— 不能上传小程序代码') : C.ok('小程序')}${name}`);
    } catch (e) {
      console.log(`  账号类型         ${C.warn(`读取失败：${String(e.message || e).slice(0, 60)}`)}`);
    }
  }

  const h = hosts();
  console.log(C.b('\n  各环境后端地址'));
  for (const env of ['develop', 'trial', 'release']) {
    const v = h[env] || '';
    const bad = env !== 'develop' && !/^https:\/\//.test(v);
    console.log(`    ${env.padEnd(8)} ${v || C.err('未配置')}${bad ? C.err('  ← 体验版/线上版必须 https 且域名已备案') : ''}`);
    if (env !== 'develop' && /wangjudaka\.com/.test(v)) {
      console.log(C.warn('             ↑ 还是占位域名，真机体验版会连不上'));
    }
  }
  if (/127\.0\.0\.1|localhost/.test(h.develop || '')) {
    console.log(C.dim('\n  提示：手机扫预览码时 127.0.0.1 指的是手机自己，连不上电脑。'));
    console.log(C.dim('        执行 npm run mini:lan 拿到局域网 IP，填到 config.js 的 develop 即可。'));
  }

  console.log(C.b('\n  下一步'));
  if (isGame) {
    console.log(C.err('    ⛔ 这个 AppID 是小游戏账号，小程序代码传不上去。'));
    console.log('    1) 用新邮箱在 mp.weixin.qq.com 注册「小程序」，类目选非游戏（工具/文娱等）');
    console.log('    2) 换 miniprogram/project.config.json 的 appid、server/.env.local 的 WX_APPID / WX_SECRET');
    console.log('    3) 在新账号下重新生成「代码上传密钥」，存成 private.<新AppID>.key');
    console.log(C.dim('    原因与证据见 docs/上传与内测指南.md 第 0.5 节\n'));
  } else if (!key) {
    console.log('    1) 微信公众平台 → 管理 → 开发管理 → 开发设置 → 小程序代码上传 → 生成并下载密钥');
    console.log(`    2) 存成 ${path.join(MINI_ROOT, `private.${id || 'wxXXXX'}.key`)}`);
    console.log('    3) 若开启了 IP 白名单，要么关掉，要么把本机公网 IP 加进去（报「无效的 ip」就是这里）');
    console.log('    4) 回到这里执行 npm run mini:preview 或 npm run mini:upload\n');
  } else {
    console.log('    1) npm run mini:preview        → 生成二维码，手机扫码即可内测（开发版）');
    console.log('    2) npm run mini:upload         → 上传为开发版');
    console.log('    3) 后台「版本管理 → 开发版本」→ 选为体验版 / 提交审核（这一步只能你点）\n');
  }
  return key;
}

// —— lan ——
function lan() {
  const list = lanAddresses();
  console.log(C.b('\n电脑局域网地址（手机与电脑需在同一 WiFi）\n'));
  if (!list.length) {
    console.log(C.warn('  没找到局域网网卡，检查是否连着 WiFi / 有线网。\n'));
    return;
  }
  for (const it of list) {
    console.log(`  ${it.address}   ${C.dim(it.name)}`);
  }
  console.log(C.b('\n把 config.js 里 develop 改成（端口按 server/.env 的 PORT，默认 8787）：'));
  console.log(`  develop: 'http://${list[0].address}:8787',`);
  console.log(C.dim('\n然后重新「预览」扫码；手机上从右上角「…」→ 打开「开发调试」即可绕过域名校验。'));
  console.log(C.dim('正式体验版不能这样绕，必须 https + 已备案域名。\n'));
}

// —— preview / upload ——
function project(id, keyPath) {
  const ci = loadCi();
  return new ci.Project({
    appid: id,
    type: 'miniProgram',
    projectPath: MINI_ROOT,
    privateKeyPath: keyPath,
    ignores: ['node_modules/**/*', 'dist/**/*'],
  });
}

/** 小游戏账号传不了小程序代码，上传前明确拦住并给出处置办法 */
async function ensureMiniProgram(p, id) {
  let attr = null;
  try { attr = await p.attr(); } catch { return; }
  if (!attr || !attr.gameApp) return;
  console.error(C.err(`\n⛔ AppID ${id} 是「小游戏」账号，小程序代码传不上去。`));
  console.error('   微信返回 gameApp=true、类目为「游戏 > …」，官方规则：游戏类目不可改为其他一级类目。');
  console.error('   处置：用新邮箱重新注册「小程序」（类目选非游戏）→ 换 AppID / AppSecret / 代码上传密钥。');
  console.error(C.dim('   详见 docs/上传与内测指南.md 第 0.5 节\n'));
  process.exit(3);
}

async function preview() {
  const id = appid();
  const key = await doctor();
  if (!key) process.exit(2);
  const ci = loadCi();
  const proj = project(id, key);
  await ensureMiniProgram(proj, id);
  const outDir = path.join(MINI_ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `preview-${stamp()}.png`);

  console.log(C.b('\n生成预览二维码中…（编译 + 上传，约 10–60 秒）\n'));
  await ci.preview({
    project: proj,
    desc: arg('desc', `内测预览 ${new Date().toLocaleString('zh-CN')}`),
    robot: Number(arg('robot', '1')),
    setting: { es6: true, minify: true, autoPrefixWxSS: true, minifyWXML: true, minifyWXSS: true },
    qrcodeFormat: 'image',
    qrcodeOutputDest: dest,
    onProgressUpdate: (t) => {
      if (t && t._msg) process.stdout.write(`\r  ${String(t._msg).slice(0, 60).padEnd(60)}`);
    },
  });
  process.stdout.write('\r' + ' '.repeat(62) + '\r');
  console.log(C.ok(`✅ 预览码已生成：${dest}`));
  console.log('\n手机扫码后：');
  console.log('  · 管理员/开发者本人扫码即可打开（开发版）');
  console.log('  · 其他人看不了开发版，需要先「上传 + 设为体验版 + 加体验成员」');
  console.log(C.dim('  · 若页面空白，多半是手机连不上后端：先跑 npm run mini:lan\n'));
}

async function upload() {
  const id = appid();
  const key = await doctor();
  if (!key) process.exit(2);
  const ci = loadCi();
  const proj = project(id, key);
  await ensureMiniProgram(proj, id);
  const version = arg('version', defaultVersion());
  const desc = arg('desc', `内测 ${new Date().toLocaleString('zh-CN')}`);

  console.log(C.b(`\n上传代码：v${version} · ${desc}\n`));
  await ci.upload({
    project: proj,
    version,
    desc,
    robot: Number(arg('robot', '1')),
    setting: { es6: true, minify: true, autoPrefixWxSS: true, minifyWXML: true, minifyWXSS: true },
    onProgressUpdate: (t) => {
      if (t && t._msg) process.stdout.write(`\r  ${String(t._msg).slice(0, 60).padEnd(60)}`);
    },
  });
  process.stdout.write('\r' + ' '.repeat(62) + '\r');
  console.log(C.ok(`✅ 已上传 v${version}（开发版）`));
  console.log('\n接下来（只能你在后台点，没有开放接口）：');
  console.log('  1) 打开 https://mp.weixin.qq.com → 管理 → 版本管理 → 开发版本');
  console.log('  2) 找到刚上传的版本 → 「选为体验版」→ 生成体验版二维码');
  console.log('  3) 成员管理 → 添加体验成员（对方的微信号）');
  console.log('  4) 自测没问题 → 同一个开发版本点「提交审核」');
  console.log(C.dim('  体验版要求：request 合法域名已配好（https + 已备案），否则页面空白\n'));
}

function help() {
  console.log(`
${C.b('小程序上传 / 内测工具')}

  npm run mini:doctor                     体检（密钥 / 依赖 / 地址）
  npm run mini:lan                        打印局域网 IP（手机内测用）
  npm run mini:preview                    生成预览二维码（开发版）
  npm run mini:preview -- --desc "文案"
  npm run mini:upload                     上传开发版（版本号默认日期式）
  npm run mini:upload -- --version 1.0.2 --desc "修复XX"

${C.dim('AppSecret 不能上传代码，必须用后台生成的「代码上传密钥」(.key)。')}
${C.dim('上传后「设为体验版 / 提交审核」仍需管理员在微信公众平台操作。')}
`);
}

const cmd = process.argv[2] || '';
try {
  if (cmd === 'doctor') await doctor();
  else if (cmd === 'lan') lan();
  else if (cmd === 'preview') await preview();
  else if (cmd === 'upload') await upload();
  else help();
} catch (e) {
  const msg = String((e && e.message) || e);
  console.error(C.err(`\n执行失败：${msg}\n`));
  if (/invalid ip|ip not in|白名单/i.test(msg)) {
    console.error(C.warn('→ 是 IP 白名单：后台「小程序代码上传」里关闭白名单，或把本机公网 IP 加进去。\n'));
  } else if (/privateKey|key/i.test(msg) && /ENOENT|no such file/i.test(msg)) {
    console.error(C.warn('→ 密钥路径不对，跑 npm run mini:doctor 看它期望的位置。\n'));
  } else if (/appid|appId/i.test(msg)) {
    console.error(C.warn('→ AppID 与密钥不匹配：密钥要在该小程序的账号下生成。\n'));
  }
  process.exitCode = 1;
}
