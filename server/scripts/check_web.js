/**
 * PC 前端功能体检（阶段 H）：语法 / 引用完整性 / 无外链 CDN / 零凭据 /
 * 前后端 API 路径对齐。零第三方依赖，直接用 node 跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const ROUTES = path.join(ROOT, 'server', 'src', 'api', 'routes.js');

let passed = 0;
let failed = 0;
const problems = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; problems.push(`${name}${detail ? '：' + detail : ''}`); console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function read(f) { return fs.readFileSync(f, 'utf8'); }

console.log('\n=== PC 前端体检（web/）===\n');

const files = walk(WEB).sort();
const jsFiles = files.filter((f) => f.endsWith('.js'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const cssFiles = files.filter((f) => f.endsWith('.css'));
ok('前端文件齐备（3 HTML / 3 JS / 2 CSS）',
  htmlFiles.length >= 3 && jsFiles.length >= 3 && cssFiles.length >= 2,
  `html=${htmlFiles.length} js=${jsFiles.length} css=${cssFiles.length}`);

// 1. JS 语法
let syntaxOk = true;
const syntaxErrors = [];
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { syntaxOk = false; syntaxErrors.push(path.basename(f) + ': ' + String(e.stderr || e.message).slice(0, 120)); }
}
ok('全部前端 JS 通过 node --check', syntaxOk, syntaxErrors.join(' | '));

// 2. 后端路由表
const routeSrc = read(ROUTES);
const backendPatterns = [];
const routeRe = /\[\s*'(GET|POST|PUT|DELETE|PATCH)'\s*,\s*'(\/[^']+)'/g;
let m;
while ((m = routeRe.exec(routeSrc)) !== null) backendPatterns.push(m[2]);
ok('后端路由表可解析（>= 60 条）', backendPatterns.length >= 60, `count=${backendPatterns.length}`);

/** 把 /api/x/:id 与 /api/x/${id} 统一成 :x，query 截断 */
function normalize(p) {
  return p.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return ':x';
    if (/^\$\{[^}]*\}$/.test(seg)) return ':x';
    return seg;
  });
}
function pathMatches(front, back) {
  if (front.length !== back.length) return false;
  return front.every((s, i) => s === back[i] || s === ':x' || back[i] === ':x');
}

// 3. HTML 引用完整性 + 无外链 CDN
const REF_RE = /(?:src|href)\s*=\s*"([^"]+)"/g;
let refsOk = true;
const refProblems = [];
let remoteRefs = 0;
for (const f of htmlFiles) {
  const src = read(f);
  let r;
  while ((r = REF_RE.exec(src)) !== null) {
    const ref = r[1];
    if (/^https?:\/\//i.test(ref)) { remoteRefs += 1; continue; }
    if (ref.startsWith('#') || ref.startsWith('data:')) continue;
    if (ref.startsWith('/')) {
      // 后端路由引用（/health 或 /api/...），参与第 5 步路径对齐
      continue;
    }
    if (!fs.existsSync(path.join(WEB, ref))) {
      refsOk = false;
      refProblems.push(`${path.basename(f)} → ${ref}`);
    }
  }
}
ok('HTML 本地引用（js/css/页面）全部存在', refsOk, refProblems.join(' | '));
ok('无任何外链 CDN / 第三方脚本', remoteRefs === 0, `remote=${remoteRefs}`);

// 4. 前端零凭据（含 .env.local 真实值动态比对：任何已配置的真实凭据都不得出现在 web/）
const SECRET_PATTERNS = [
  ['sk- API Key', /sk-[A-Za-z0-9_-]{8,}/],
  ['主账号手机号', /18615711453/],
  ['上游 Key 变量名', /RELAY_API_KEY/],
  ['控制台密码变量名', /RELAY_CONSOLE_PASSWORD/],
  ['比对服务 Token 变量名', /QC_COMPARE_TOKEN/],
  ['微信密钥变量名', /WX_SECRET/],
  ['明文密码赋值', /password\s*[:=]\s*['"][^'"]{4,}['"]/i],
];
// 动态读取 .env.local 中已配置的真实敏感值，逐一在前端文件中查找
const ENV_LOCAL = path.join(ROOT, 'server', '.env.local');
const SENSITIVE_ENV_KEYS = ['RELAY_API_KEY', 'WX_SECRET', 'ADMIN_TOKEN', 'SESSION_SECRET', 'QC_COMPARE_TOKEN', 'WX_PAY_APP_KEY', 'RELAY_CONSOLE_PASSWORD'];
const dynamicSecrets = [];
if (fs.existsSync(ENV_LOCAL)) {
  for (const line of fs.readFileSync(ENV_LOCAL, 'utf8').split(/\r?\n/)) {
    const m2 = /^([A-Z_]+)=(.+)$/.exec(line.trim());
    if (!m2) continue;
    if (SENSITIVE_ENV_KEYS.includes(m2[1]) && m2[2].trim().length >= 6) dynamicSecrets.push([`.env.local 真实值 ${m2[1]}`, m2[2].trim()]);
  }
}
const hitSecrets = [];
for (const f of files) {
  const src = read(f);
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(src)) hitSecrets.push(`${path.basename(f)} → ${name}`);
  }
  for (const [name, val] of dynamicSecrets) {
    if (src.includes(val)) hitSecrets.push(`${path.basename(f)} → ${name}`);
  }
}
ok('前端零凭据命中（Key / 账号 / Token / 密码 / .env.local 真实值）', hitSecrets.length === 0, hitSecrets.join(' | '));

// 5. 前后端 API 路径对齐
const API_LITERAL = /(\/(?:api|health)[A-Za-z0-9_/${}.:?=&%\-]*)/g;
const frontendPaths = new Set();
for (const f of [...jsFiles, ...htmlFiles]) {
  const src = read(f);
  let a;
  while ((a = API_LITERAL.exec(src)) !== null) frontendPaths.add(a[1]);
}
const normalizedBack = backendPatterns.map(normalize);
const unmatched = [];
for (const p of frontendPaths) {
  const n = normalize(p);
  if (!normalizedBack.some((b) => pathMatches(n, b))) unmatched.push(p);
}
ok(`前端调用的 ${frontendPaths.size} 个接口路径全部存在于后端路由`,
  unmatched.length === 0, unmatched.join(' | '));

// 6. 无危险动态执行
const dangerous = [];
for (const f of jsFiles) {
  const src = read(f);
  if (/\beval\s*\(/.test(src) || /new\s+Function\s*\(/.test(src)) dangerous.push(path.basename(f));
}
ok('前端无 eval / new Function 动态执行', dangerous.length === 0, dangerous.join(' | '));

// 7. 关键交互元素存在
const canvasHtml = read(path.join(WEB, 'canvas.html'));
const uploadHtml = read(path.join(WEB, 'upload-helper.html'));
ok('画布页含 viewport / nodesLayer / 保存与重置按钮',
  ['id="viewport"', 'id="nodesLayer"', 'id="btnSave"', 'id="btnReset"'].every((s) => canvasHtml.includes(s)));
ok('上传助手含 no_auto_submit 提示 / 预填 / 回写 / 导入导出',
  ['no_auto_submit = true', 'id="btnPrepare"', 'id="btnMark"', 'id="btnExport"', 'id="btnImport"'].every((s) => uploadHtml.includes(s)));

// 8. 管理后台（V3.6）
const adminHtml = read(path.join(WEB, 'admin.html'));
const adminJs = read(path.join(WEB, 'admin.js'));
ok('管理台含令牌门禁 / 档次表单 / 兑换码生成 / 列表分页',
  ['id="tokenInput"', 'id="btnPkgCreate"', 'id="btnGen"', 'id="codeRows"'].every((s) => adminHtml.includes(s)));
ok('管理台令牌只存 sessionStorage，且全部管理请求带 X-Admin-Token',
  adminJs.includes('sessionStorage') && adminJs.includes("'X-Admin-Token'") && !adminJs.includes('localStorage'));
ok('管理台含邀请裂变面板（规则表单 / 记录表 / 判定无效）',
  ['id="invStats"', 'id="btnInvSave"', 'id="invRows"', 'id="fltInvStatus"'].every((s) => adminHtml.includes(s))
  && adminJs.includes('/api/admin/invites') && adminJs.includes('/api/admin/invite-settings')
  && adminJs.includes('/api/admin/invites/reject'));

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) {
  console.log('\n待修问题：');
  problems.forEach((p) => console.log('  · ' + p));
  process.exitCode = 1;
}
