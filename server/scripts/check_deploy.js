#!/usr/bin/env node
/**
 * 部署套件自检（零依赖）：确认「拿去服务器就能跑」这件事本身没有缺口。
 *
 * 覆盖：
 *  1. 部署资产齐全（Dockerfile / compose / nginx / systemd / env 模板 / 部署手册）
 *  2. 服务端确实零运行时依赖（否则打包漏 node_modules 会直接跑不起来）
 *  3. Dockerfile 引用的路径都存在，且监听 0.0.0.0
 *  4. Nginx：HTTPS、反代到 8787、放宽生成超时、限制请求体
 *  5. systemd：EnvironmentFile / SIGTERM / 自动重启 / 数据目录可写
 *  6. 环境变量模板覆盖上线必需项
 *  7. 零凭据：部署资产里不得出现真实密钥形态
 *
 * 用法：npm run deploy:check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? ` → ${detail}` : ''}`);
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const exists = (p) => fs.existsSync(p);

console.log('\n部署套件自检\n');

// —— 1. 资产齐全 ——
const assets = [
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'deploy/README.md',
  'deploy/env.production.example',
  'deploy/nginx/wangjudaka.conf',
  'deploy/systemd/wangjudaka.service',
  'server/.env.example',
  'server/src/index.js',
  'web/index.html',
];
for (const a of assets) ok(`资产存在: ${a}`, exists(path.join(ROOT, a)));

// —— 2. 零运行时依赖 ——
const pkg = JSON.parse(read(path.join(SERVER, 'package.json')) || '{}');
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
ok('服务端零第三方运行时依赖', runtimeDeps.length === 0, runtimeDeps.join(','));
ok('声明 Node 版本 >= 22', />=?\s*22/.test(pkg.engines?.node ?? ''), pkg.engines?.node);
ok('有 start 脚本', pkg.scripts?.start === 'node src/index.js', pkg.scripts?.start);

// —— 3. Dockerfile ——
const docker = read(path.join(ROOT, 'Dockerfile'));
ok('Dockerfile 用 Node 22 镜像', /^FROM\s+node:22/m.test(docker));
ok('Dockerfile 复制 server/src', /COPY\s+server\/src/.test(docker));
ok('Dockerfile 复制 web/', /COPY\s+web\s/.test(docker));
ok('Dockerfile 声明数据卷', /VOLUME\s+\[?"?\/data/.test(docker));
ok('Dockerfile 带健康检查', /HEALTHCHECK/.test(docker));
ok('Dockerfile 以 node src/index.js 启动', /CMD\s+\["node",\s*"src\/index\.js"\]/.test(docker));
// Dockerfile 里引用的源路径必须真实存在，否则 build 时才炸
for (const m of docker.matchAll(/^COPY\s+(\S+)\s+\S+/gm)) {
  const src = m[1];
  if (src.startsWith('--')) continue;
  ok(`Dockerfile 引用的路径存在: ${src}`, exists(path.join(ROOT, src)));
}

// —— 4. compose ——
const compose = read(path.join(ROOT, 'docker-compose.yml'));
ok('compose 挂载持久化数据卷', /volumes:/.test(compose) && /\/data/.test(compose));
ok('compose 使用 env_file', /env_file:/.test(compose));
ok('compose 自动重启', /restart:\s*unless-stopped/.test(compose));

// —— 5. Nginx ——
const nginx = read(path.join(ROOT, 'deploy/nginx/wangjudaka.conf'));
ok('Nginx 配置了证书', /ssl_certificate\s+\//.test(nginx) && /ssl_certificate_key\s+\//.test(nginx));
ok('Nginx 启用 TLS 1.2+', /ssl_protocols\s+TLSv1\.2/.test(nginx));
ok('Nginx 反代到 127.0.0.1:8787', /server\s+127\.0\.0\.1:8787/.test(nginx));
ok('Nginx 放宽生成超时（>=300s）', /proxy_read_timeout\s+(3\d\d|[4-9]\d\d|\d{4,})s/.test(nginx));
ok('Nginx 限制请求体', /client_max_body_size\s+\d+[mM]/.test(nginx));
ok('Nginx 有 HTTP→HTTPS 跳转', /return\s+301\s+https:\/\//.test(nginx));
ok('Nginx 保留 ACME 验证路径', /\.well-known\/acme-challenge/.test(nginx));

// —— 6. systemd ——
const unit = read(path.join(ROOT, 'deploy/systemd/wangjudaka.service'));
ok('systemd 使用 EnvironmentFile', /EnvironmentFile=.*\.env/.test(unit));
ok('systemd 指定工作目录', /WorkingDirectory=.*\/server/.test(unit));
ok('systemd 启动命令为 node src/index.js', /ExecStart=.*node\s+src\/index\.js/.test(unit));
ok('systemd 自动重启', /Restart=always/.test(unit));
ok('systemd 用 SIGTERM 优雅停止', /KillSignal=SIGTERM/.test(unit));
ok('systemd 允许写入数据目录', /ReadWritePaths=/.test(unit));

// —— 7. 环境变量模板 ——
const envTpl = read(path.join(ROOT, 'deploy/env.production.example'));
for (const k of ['PORT', 'HOST', 'NODE_ENV', 'DATA_DIR', 'ADMIN_TOKEN', 'SESSION_SECRET', 'WX_APPID', 'WX_SECRET', 'RELAY_GATEWAY']) {
  ok(`生产环境模板含 ${k}`, new RegExp(`^${k}=`, 'm').test(envTpl), k);
}
ok('生产模板 HOST 默认仅本机（配反代时）', /^HOST=127\.0\.0\.1$/m.test(envTpl));
ok('生产模板 NODE_ENV=production', /^NODE_ENV=production$/m.test(envTpl));

// —— 8. 部署手册要点 ——
const guide = read(path.join(ROOT, 'deploy/README.md'));
ok('部署手册含 Docker 路线', /docker compose up/i.test(guide));
ok('部署手册含 systemd 路线', /systemctl/.test(guide));
ok('部署手册含 HTTPS/证书章节', /certbot|Let's Encrypt/i.test(guide));
ok('部署手册含备份与恢复', /备份/.test(guide) && /恢复/.test(guide));
ok('部署手册含小程序域名配置', /request\s*合法域名/.test(guide));

// —— 9. 零凭据 ——
const scanTargets = [
  'Dockerfile', 'docker-compose.yml', '.dockerignore',
  'deploy/README.md', 'deploy/env.production.example',
  'deploy/nginx/wangjudaka.conf', 'deploy/systemd/wangjudaka.service',
];
let leak = null;
for (const rel of scanTargets) {
  const t = read(path.join(ROOT, rel));
  if (/sk-[A-Za-z0-9]{16,}/.test(t)) leak = `${rel}: sk- 形态密钥`;
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(t)) leak = `${rel}: 私钥块`;
  if (/^WX_SECRET=\S+/m.test(t)) leak = `${rel}: WX_SECRET 有实际值`;
  if (/^ADMIN_TOKEN=\S+/m.test(t)) leak = `${rel}: ADMIN_TOKEN 有实际值`;
  if (/^SESSION_SECRET=\S+/m.test(t)) leak = `${rel}: SESSION_SECRET 有实际值`;
  if (leak) break;
}
ok('部署资产不含任何真实凭据', !leak, leak ?? '');

// —— 10. 真实跑一遍打包清单 ——
// 过滤规则最容易「悄悄」剔掉运行必需文件（例如把 server/src/seeds/data 当数据目录排除），
// 所以这里不用正则猜，直接调用打包器的 --list 看它到底会打进什么。
let list = '';
try {
  list = execFileSync(process.execPath, [path.join(SERVER, 'scripts/pack_release.js'), '--list'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  ok('打包清单可生成', list.includes('个文件'), list.slice(0, 80));
} catch (e) {
  ok('打包清单可生成', false, e.message);
}
if (list) {
  ok('打包清单含种子数据（seeds/data/*.json）', /server\/src\/seeds\/data\/[^\s]+\.json/.test(list));
  ok('打包清单含 web/index.html', /web\/index\.html/.test(list));
  ok('打包清单含 server/src/index.js', /server\/src\/index\.js/.test(list));
  ok('打包清单含部署手册', /deploy\/README\.md/.test(list));
  ok('打包清单不含 .env / .env.local', !/(^|\/)\.env$|(^|\/)\.env\.local$/m.test(list));
  ok('打包清单不含 .key 密钥', !/\.key\s*$/m.test(list));
  ok('打包清单不含 tests/ 与 scripts/', !/(^|\/)(tests|scripts)\//.test(list));
  ok('打包清单不含 data/ 运行数据', !/wangju-daka-[^\s/]+\/(?:server\/)?data(?:_test)?\//.test(list));
}

// —— 11. 镜像内容完整性：种子库必须被 git 跟踪（云托管按仓库构建）——
// 踩过的坑：server/.gitignore 里写过 `data/`，把 src/seeds/data/ 整个忽略掉，
// 本地一切正常，推到 GitHub 后镜像里没有种子 JSON，容器启动即崩
// （AppError: 种子文件缺失: style_presets.json → Back-off restarting failed container）。
let tracked = '';
try {
  tracked = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', 'server/src/seeds/data'], {
    cwd: path.resolve(SERVER, '..'),
    encoding: 'utf8',
    timeout: 30000,
  });
} catch (e) {
  tracked = '';
}
const seedTracked = tracked.split('\n').filter((x) => x.endsWith('.json'));
ok('种子库已被 git 跟踪（云托管构建依赖）', seedTracked.length >= 10, `仅 ${seedTracked.length} 个`);
// 关键的几份必须点名存在，避免「只剩一个空目录」也能通过数量检查之外的极端情况
for (const must of ['style_presets.json', 'shot_cards.json', 'transition_cards.json', 'lighting_cards.json', 'cinema_grammar.json']) {
  ok(`种子已跟踪：${must}`, seedTracked.some((p) => p.endsWith('/' + must)));
}
// Dockerfile 必须把整个 server/src 打进镜像（种子在 src 里面）
const dockerfileText = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
ok('Dockerfile 打包整个 server/src（含种子）', /COPY\s+server\/src\s/.test(dockerfileText));

// —— 结果 ——
if (fails.length === 0) {
  console.log(`  结果：${pass} 通过 / 0 失败`);
  console.log('  ✅ 全部通过\n');
  process.exit(0);
}
console.log(`  结果：${pass} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log(`  ❌ ${f}`);
console.log('');
process.exit(1);
