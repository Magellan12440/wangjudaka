/**
 * 小程序静态体检：在没有微信开发者工具的环境里，先把“必然编译失败/运行报错”的问题挑出来。
 *
 * 检查项：
 *  1. app.json / 各页 json 可解析，页面四件套齐全，tabBar 图标存在
 *  2. 所有 js 通过 node --check（语法层）
 *  3. WXML 标签配对、wx:for 必须有 wx:key、同节点不得同时 wx:for + wx:if
 *  4. WXML 绑定的事件处理函数在页面 js 中真实存在
 *  5. utils/api.js 调用的接口路径在服务端路由表中存在
 *  6. 前端零凭据、品牌名统一
 *
 * 运行：npm run mini:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../miniprogram');
const SERVER = path.resolve(__dirname, '..');

let pass = 0;
const fail = [];
const warn = [];

const ok = (name) => { pass += 1; };
const bad = (name, detail) => { fail.push(detail ? `${name} → ${detail}` : name); };
const warnOnce = (name) => { warn.push(name); };

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

// —— 1. app.json 与页面四件套 ——
let app;
try {
  app = JSON.parse(read(path.join(ROOT, 'app.json')));
  ok('app.json 可解析');
} catch (e) {
  bad('app.json 可解析', e.message);
  app = { pages: [], tabBar: { list: [] } };
}

const pages = app.pages || [];
if (!pages.length) bad('app.json 声明页面');
else ok('app.json 声明页面');

for (const p of pages) {
  const base = path.join(ROOT, p);
  for (const ext of ['.js', '.json', '.wxml']) {
    if (!exists(base + ext)) bad(`页面文件齐全: ${p}`, `缺少 ${ext}`);
  }
  if (!exists(base + '.js')) continue;
  try {
    JSON.parse(read(base + '.json'));
  } catch (e) {
    bad(`页面 json 可解析: ${p}`, e.message);
  }
}
ok('页面四件套检查完成');

for (const item of (app.tabBar && app.tabBar.list) || []) {
  if (!pages.includes(item.pagePath)) bad('tabBar 页面已在 pages 中', item.pagePath);
  for (const key of ['iconPath', 'selectedIconPath']) {
    if (item[key] && !exists(path.join(ROOT, item[key]))) bad(`tabBar 图标存在: ${item[key]}`);
  }
}
ok('tabBar 配置检查完成');
if (!String((app.window || {}).navigationBarTitleText || '').includes('网剧大咖')) {
  bad('导航标题为网剧大咖', (app.window || {}).navigationBarTitleText);
} else ok('导航标题为网剧大咖');

// —— 2. JS 语法 ——
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(ROOT);
const jsFiles = files.filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad(`JS 语法: ${path.relative(ROOT, f)}`, String(e.stderr || e.message).split('\n').slice(0, 2).join(' '));
  }
}
ok('JS 语法检查完成');

// —— 3/4. WXML ——
const VOID = new Set(['input', 'image', 'icon', 'progress', 'switch', 'slider', 'checkbox', 'radio', 'textarea', 'camera', 'live-player', 'live-pusher', 'video', 'map', 'canvas', 'web-view', 'ad', 'open-data']);
const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const ATTR_RE = /([@\w:.-]+)\s*=\s*"([^"]*)"/g;

for (const pagePath of pages) {
  const wxmlPath = path.join(ROOT, pagePath + '.wxml');
  const jsPath = path.join(ROOT, pagePath + '.js');
  if (!exists(wxmlPath) || !exists(jsPath)) continue;
  const wxml = read(wxmlPath).replace(/<!--[\s\S]*?-->/g, '');
  const js = read(jsPath);

  // 标签配对
  const stack = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(wxml))) {
    const [raw, name, attrs, selfClose] = m;
    const isClose = raw.startsWith('</');
    if (isClose) {
      const top = stack.pop();
      if (top !== name) {
        bad(`WXML 标签配对: ${pagePath}`, `期望 </${top}>，实际 </${name}>（offset ${m.index}）`);
        break;
      }
      continue;
    }
    if (selfClose || VOID.has(name)) continue;

    // 同节点 wx:for + wx:if
    if (/\bwx:for\s*=/.test(attrs) && /\bwx:if\s*=/.test(attrs)) {
      bad(`wx:for 与 wx:if 不得同节点: ${pagePath}`, name);
    }
    // 同节点 wx:for + wx:else/wx:elif：编译器先展开 wx:for，
    // 该节点会被包进隐式 block，wx:else 随即失去配对的 wx:if（真实报错：
    // "Bad attr `wx:else` ... wx:if not found"）。正确写法是外层 <block wx:else>。
    if (/\bwx:for\s*=/.test(attrs) && /\bwx:(else|elif)\b/.test(attrs)) {
      bad(`wx:for 与 wx:else/wx:elif 不得同节点（应包一层 <block wx:else>）: ${pagePath}`, name);
    }
    if (/\bwx:for\s*=/.test(attrs) && !/\bwx:key\s*=/.test(attrs)) {
      bad(`wx:for 缺少 wx:key: ${pagePath}`, name);
    }

    // 事件处理函数存在性
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(attrs))) {
      const attr = a[1];
      const value = a[2].trim();
      if (!/^(bind|catch|capture-bind|capture-catch)/.test(attr)) continue;
      if (!value || value.includes('{{')) continue;
      const fn = value;
      const defined = new RegExp(`(^|\\n)\\s*${fn}\\s*\\(`).test(js)
        || new RegExp(`(^|\\n)\\s*${fn}\\s*:\\s*function`).test(js)
        || new RegExp(`(^|\\n)\\s*${fn}\\s*:\\s*\\(`).test(js);
      if (!defined) bad(`事件处理函数存在: ${pagePath}#${fn}`);
    }

    stack.push(name);
  }
  if (stack.length) bad(`WXML 标签未闭合: ${pagePath}`, stack.join(' > '));
}
ok('WXML 结构检查完成');

// —— 5. 接口路径对齐 ——
const routesSrc = read(path.join(SERVER, 'src/api/routes.js'));
const serverPaths = new Set();
for (const r of routesSrc.matchAll(/\['(GET|POST|PUT|DELETE)',\s*'([^']+)'/g)) {
  serverPaths.add(r[2].replace(/:[A-Za-z0-9_]+/g, '*'));
}

const apiSrc = read(path.join(ROOT, 'utils/api.js'));
const clientPaths = new Set();
for (const r of apiSrc.matchAll(/url:\s*`([^`]+)`/g)) {
  clientPaths.add(r[1].replace(/\$\{[^}]+\}/g, '*').split('?')[0]);
}
for (const r of apiSrc.matchAll(/url:\s*'([^']+)'/g)) {
  clientPaths.add(r[1].split('?')[0]);
}
for (const p of clientPaths) {
  if (!p.startsWith('/api/')) continue;
  if (!serverPaths.has(p)) bad('接口路径在服务端存在', p);
}
ok('接口路径对齐检查完成');

// —— 6. 页面跳转路径合法（navigateTo 打到 tabBar 页会静默失败）——
const tabPages = new Set(((app.tabBar && app.tabBar.list) || []).map((x) => '/' + x.pagePath));
for (const f of files.filter((x) => x.endsWith('.js'))) {
  const txt = read(f);
  const rel = path.relative(ROOT, f);
  for (const m of txt.matchAll(/wx\.navigateTo\(\{\s*url:\s*[`'"]([^`'"?]+)/g)) {
    const url = m[1].startsWith('/') ? m[1] : '/' + m[1];
    if (!pages.some((p) => '/' + p === url)) bad(`navigateTo 目标页面存在: ${rel}`, url);
    if (tabPages.has(url)) bad(`tabBar 页不能用 navigateTo: ${rel}`, url);
  }
  for (const m of txt.matchAll(/wx\.switchTab\(\{\s*url:\s*[`'"]([^`'"?]+)/g)) {
    const url = m[1].startsWith('/') ? m[1] : '/' + m[1];
    if (!tabPages.has(url)) bad(`switchTab 只能跳 tabBar 页: ${rel}`, url);
  }
}
ok('页面跳转路径检查完成');

// —— 7. WXML 插值不得调用函数（WXML 只支持表达式，不支持函数调用）——
for (const pagePath of pages) {
  const wxmlPath = path.join(ROOT, pagePath + '.wxml');
  if (!exists(wxmlPath)) continue;
  const wxml = read(wxmlPath).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of wxml.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const expr = m[1];
    // 排除对象字面量/数组/三元中的括号：只看「标识符(」形态
    if (/[A-Za-z_$][\w$]*\s*\(/.test(expr)) {
      bad(`WXML 不支持函数调用: ${pagePath}`, expr.trim().slice(0, 60));
    }
  }
}
ok('WXML 表达式检查完成');

// —— 8. 零凭据与品牌 ——
const forbidden = [
  { re: /sk-[A-Za-z0-9]{10,}/, name: '前端出现 sk- 密钥' },
  { re: /RELAY_API_KEY|RELAY_CONSOLE_PASSWORD|WX_SECRET|WX_PAY_APP_KEY/, name: '前端出现服务端凭据名' },
  { re: /灵悟漫剧工作台/, name: '残留旧品牌名' },
];
for (const f of files.filter((x) => /\.(js|json|wxml|wxss)$/.test(x))) {
  const txt = read(f);
  for (const rule of forbidden) {
    if (rule.re.test(txt)) bad(`${rule.name}: ${path.relative(ROOT, f)}`);
  }
}
ok('零凭据与品牌检查完成');

// —— 9. 设计系统与动效基线（V4.2 前端重做后不可退化）——
const appWxss = read(path.join(ROOT, 'app.wxss'));
const REQUIRED_CSS = [
  ['.screen', '页面容器'],
  ['.aurora', '极光背景'],
  ['.card', '玻璃卡'],
  ['.btn', '主按钮'],
  ['.tap-on', '点击特效'],
  ['.rise', '入场动画'],
  ['.seg-ind', '分段滑动指示器'],
  ['.ring', '进度环'],
  ['@keyframes rise', '入场关键帧'],
  ['@keyframes pageIn', '页面切换关键帧'],
];
for (const [token, label] of REQUIRED_CSS) {
  if (!appWxss.includes(token)) bad(`设计系统缺少 ${label}: ${token}`);
}
ok('设计系统令牌检查完成');

const motionSrc = read(path.join(ROOT, 'utils/motion.js'));
for (const fn of ['enter', 'haptic', 'countUp', 'ringStyle', 'segStyle', 'clear']) {
  if (!new RegExp(`(function\\s+${fn}\\s*\\()|(\\b${fn}\\s*[,}])`).test(motionSrc)) {
    bad(`动效工具缺少 ${fn}()`);
  }
}
ok('动效工具 API 检查完成');

for (const pagePath of pages) {
  const wxmlPath = path.join(ROOT, pagePath + '.wxml');
  if (!exists(wxmlPath)) continue;
  const wxml = read(wxmlPath);
  if (!wxml.includes('pageAnim')) bad(`页面缺少入场动效（pageAnim）: ${pagePath}`);
  if (!/hover-class="tap-on"/.test(wxml)) bad(`页面缺少点击特效（hover-class="tap-on"）: ${pagePath}`);
}
ok('页面动效基线检查完成');

// 旧版主色（#f2c14e）已统一为香槟金 #F3C969，避免新旧两套配色并存
for (const f of files.filter((x) => /\.(wxss|wxml)$/.test(x))) {
  if (/#f2c14e/i.test(read(f))) bad(`残留旧主色 #f2c14e: ${path.relative(ROOT, f)}`);
}
ok('配色体系统一检查完成');

// —— 隐私合规（V4.14）——
// 这一组全是"线上必炸"的项：任一缺失，用户点上传就会被微信以隐私原因拒绝。
{
  const p = path.join(ROOT, 'utils/privacy.js');
  if (!exists(p)) bad('隐私闸门模块存在', 'utils/privacy.js 缺失');
  else {
    const src = read(p);
    for (const fn of ['init', 'ensure', 'resolveAgree', 'isPrivacyError', 'explain']) {
      if (!new RegExp(`\\b${fn}\\b`).test(src)) bad(`隐私模块缺少 ${fn}()`);
    }
  }

  const appSrc = read(path.join(ROOT, 'app.js'));
  if (!/privacy\.init\s*\(/.test(appSrc)) {
    bad('App 启动注册隐私回调（privacy.init）', '用户未同意时隐私接口会直接失败，页面无从接住');
  }

  const gate = path.join(ROOT, 'components/privacy-gate', 'index');
  for (const ext of ['.js', '.json', '.wxml']) {
    if (!exists(gate + ext)) bad(`隐私弹窗组件齐全: privacy-gate/index${ext}`);
  }
  if (exists(gate + '.wxml')) {
    const g = read(gate + '.wxml');
    // 微信只认这个 open-type，showModal 的确定按钮授予不了授权
    if (!/open-type="agreePrivacyAuthorization"/.test(g)) {
      bad('隐私弹窗使用微信认可的同意按钮', '缺少 open-type="agreePrivacyAuthorization"');
    }
    if (!/id="privacy-agree-btn"/.test(g)) {
      bad('隐私弹窗按钮 id 与 resolve 的 buttonId 一致');
    }
  }

  const appJson = app.usingComponents || {};
  if (!appJson['privacy-gate']) bad('app.json 全局注册 privacy-gate 组件');

  // 隐私接口调用页必须挂组件，否则 ensure() 无人应答
  const pickerSrc = read(path.join(ROOT, 'utils/pickFile.js'));
  if (!/privacy\.ensure/.test(pickerSrc)) bad('选文件前先过隐私闸门（privacy.ensure）');
  const projectSrc = read(path.join(ROOT, 'pages/project/project.js'));
  if (!/privacy\.ensure/.test(projectSrc)) bad('相册/相机前先过隐私闸门（privacy.ensure）');
  for (const p2 of ['pages/create/create.wxml', 'pages/project/project.wxml', 'pages/login/login.wxml']) {
    const f = path.join(ROOT, p2);
    if (!exists(f)) continue;
    if (!/<privacy-gate\s*\/>/.test(read(f))) bad(`页面挂载隐私弹窗: ${p2}`);
  }
}
ok('隐私合规检查完成');

// —— 7. 输入框可读性（V4.18）——
// 原生 <input> 自身高度只有约 1.4rem。如果只给上下 padding 而不定高，
// 盒模型会把内容区挤到几个像素，用户输入的字只能看见半截（剧壳那四个输入框就是这样）。
{
  const appWxss = read(path.join(ROOT, 'app.wxss'));
  const m = appWxss.match(/(^|\n)\.input\s*\{([^}]*)\}/);
  if (!m) bad('全局 .input 有独立规则', '和 .textarea 合写时无法只给 input 定高');
  else {
    const body = m[2];
    if (!/height\s*:/.test(body)) {
      bad('全局 .input 设定明确高度', '原生 input 高度不足，叠加上下 padding 会把文字裁成半截');
    }
    const pd = body.match(/padding\s*:\s*([^;]+);/);
    if (pd && String(pd[1]).trim().split(/\s+/)[0] !== '0') {
      bad('全局 .input 纵向 padding 归零', `当前 ${pd[1].trim()}，纵向留白应交给 height + line-height`);
    }
  }

  // 页面里自己给输入框设了 height 的，必须同时给 line-height，否则文字上下不居中
  for (const dir of fs.readdirSync(path.join(ROOT, 'pages'))) {
    const f = path.join(ROOT, 'pages', dir, `${dir}.wxss`);
    if (!exists(f)) continue;
    const src = read(f);
    const re = /\.([A-Za-z-]*input[A-Za-z-]*)\s*\{([^}]*)\}/g;
    let mm;
    while ((mm = re.exec(src))) {
      const body = mm[2];
      if (/height\s*:/.test(body) && !/line-height\s*:/.test(body)) {
        bad(`输入框高度与行高配套: ${dir}.wxss .${mm[1]}`, '设了 height 就要给 line-height，否则文字不居中');
      }
    }
  }
}
ok('输入框可读性检查完成');

// —— 18. 异步任务与云托管通道（V4.19）——
// 内网通道 wx.cloud.callContainer 的 timeout 官方硬上限是 15s。只要 AI 出图还挂在
// 一次请求上等待，真机就必然超时（而服务端仍在扣点出图）。这一组把「必须异步」钉死：
// 谁把页面改回同步等结果，这里就红。
{
  const cloudSrc = path.join(ROOT, 'utils/cloud.js');
  if (!exists(cloudSrc)) {
    bad('云托管通道封装存在: utils/cloud.js', '生产环境主通道，不能只靠 wx.request');
  } else {
    const src = read(cloudSrc);
    if (!/wx\.cloud\.callContainer/.test(src)) bad('用 wx.cloud.callContainer 走内网通道');
    if (!/X-WX-SERVICE/.test(src)) bad('请求头带 X-WX-SERVICE（否则不知道打到哪个服务）');
    if (!/TIMEOUT_MAX\s*=\s*14000/.test(src)) {
      bad('timeout 压到 15s 以内', '官方上限 15s，传更大的值会被静默忽略；必须自己留余量');
    }
    if (!/wx\.cloud\.init/.test(src)) bad('调用前先 wx.cloud.init（否则报 cloud init error）');
  }

  const taskSrc = path.join(ROOT, 'utils/task.js');
  if (!exists(taskSrc)) bad('任务进度条工具存在: utils/task.js');
  else {
    const src = read(taskSrc);
    for (const fn of ['start', 'resume', 'detach', 'dismiss']) {
      if (!new RegExp(`function ${fn}\\b`).test(src)) bad(`进度条工具缺少 ${fn}()`);
    }
    if (!/pollTask/.test(src)) bad('进度靠轮询 /api/task/:id（不能同步等）');
  }

  const apiSrc = read(path.join(ROOT, 'utils/api.js'));
  for (const m of ['pollTask', 'startShotTask', 'startShotImagesTask', 'startAssetImageTask', 'task:']) {
    if (!new RegExp(m.replace(':', '\\s*:')).test(apiSrc)) bad(`api 缺少异步任务方法: ${m}`);
  }

  // 页面不许再同步等生成结果（这些调用在 15s 上限下必超时）
  const forbid = [
    ['pages/project/project.js', /api\.generateShot\s*\(/, '分镜出图'],
    ['pages/project/project.js', /api\.regenerateShot\s*\(/, '分镜重出'],
    ['pages/project/project.js', /api\.generateShotImages\s*\(/, '批量分镜图'],
    ['pages/project/project.js', /api\.buildProjectPlan\s*\(/, '剧本与总谱'],
  ];
  for (const [file, re, label] of forbid) {
    const f = path.join(ROOT, file);
    if (!exists(f)) continue;
    if (re.test(read(f))) bad(`${label}必须走异步任务`, '同步等待会被内网通道 15s 上限掐断，用户看到失败但点数已扣');
  }

  const projWxml = read(path.join(ROOT, 'pages/project/project.wxml'));
  if (!/class="task-bar/.test(projWxml)) bad('项目页有任务进度条');
  if (!/bindtap="dismissTask"/.test(projWxml)) bad('进度条能收起（成功/失败后要能关掉）');
  if (!/bindtap="leaveTaskRunning"/.test(projWxml)) {
    bad('长任务能「先去别处」', '把用户按在页面上等几分钟是错的，任务在服务端不会停');
  }
}
ok('异步任务与云托管通道检查完成');

// —— 结果 ——
console.log(`\n小程序体检：${pass} 组通过${fail.length ? ` / ${fail.length} 项失败` : ''}`);
if (warn.length) {
  console.log('\n提示：');
  for (const w of warn) console.log(`  · ${w}`);
}
if (fail.length) {
  console.log('\n失败项：');
  for (const f of fail) console.log(`  ❌ ${f}`);
  process.exitCode = 1;
} else {
  console.log('  ✅ 全部通过\n');
}
