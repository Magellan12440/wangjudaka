#!/usr/bin/env node
/**
 * 发布包打包器（零第三方依赖）。
 *
 * 为什么自己写 tar：服务端全程零运行时依赖，打包环节也不该引入 archiver/tar 这类包；
 * 同时要跨 Windows/macOS/Linux 行为一致（系统 tar 参数不一致、还会带上文件属主）。
 *
 * 产物：
 *   dist/wangju-daka-<version>.tar.gz
 *   dist/wangju-daka-<version>.tar.gz.sha256
 *
 * 用法：
 *   node scripts/pack_release.js              # 打包
 *   node scripts/pack_release.js --list       # 只列出会打进包的文件
 *
 * 包里**不含**：node_modules、tests、scripts、data、.env/.env.local、*.key、docs、小程序源码。
 * 换言之，拿到包的人解压 + 填 .env 就能跑，拿不到任何凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

/** 包里必须存在的运行时目录 */
const INCLUDE_DIRS = [
  ['server/src', 'server/src'],
  ['web', 'web'],
  ['deploy/nginx', 'deploy/nginx'],
  ['deploy/systemd', 'deploy/systemd'],
];

/** 包里必须存在的单文件 */
const INCLUDE_FILES = [
  ['Dockerfile'],
  ['docker-compose.yml'],
  ['.dockerignore'],
  ['deploy/README.md'],
  ['deploy/env.production.example'],
  ['server/package.json'],
  ['server/.env.example'],
];

/**
 * 任何情况下都不进包的东西（即便误放到 include 目录里也会被剔除）。
 *
 * 注意：这里的路径规则必须**锚定在工程根**，不能写成 /(^|\/)data\// 这类“任意层级”匹配——
 * 否则会把 server/src/seeds/data/ 里的种子 JSON 一起剔掉，包看着正常、到服务器上却过不了种子自检。
 */
const DENY = [
  /(^|\/)node_modules\//,
  /^data\//,
  /^data_test\//,
  /^server\/data\//,
  /^server\/data_test\//,
  /^tests\//,
  /^server\/tests\//,
  /^scripts\//,
  /^server\/scripts\//,
  /^dist\//,
  /^\.workbuddy\//,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.local$/,
  /\.key$/,
  /\.log$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)__pycache__\//,
];

function deny(rel) {
  const p = rel.split(path.sep).join('/') + (rel.endsWith('/') ? '' : '');
  return DENY.some((re) => re.test(p) || re.test(p + '/'));
}

function walk(absDir, relDir, out) {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, ent.name);
    const rel = path.join(relDir, ent.name);
    if (deny(rel)) continue;
    if (ent.isDirectory()) walk(abs, rel, out);
    else if (ent.isFile()) out.push({ abs, rel });
  }
}

// ---------- 最小 tar（ustar）写入 ----------
function octal(n, len) {
  // len 包含结尾 NUL
  const s = n.toString(8).padStart(len - 1, '0');
  return Buffer.from(s + '\0', 'ascii');
}

function tarHeader({ name, size, mode, mtime }) {
  const h = Buffer.alloc(512, 0);
  let fileName = name;
  let prefix = '';
  if (Buffer.byteLength(fileName) > 100) {
    // 拆 prefix/name：从右往左找能放下的切点
    const parts = name.split('/');
    while (parts.length > 1) {
      const candidate = parts.pop();
      const pre = parts.join('/');
      if (Buffer.byteLength(pre) <= 155 && Buffer.byteLength(candidate) <= 100) {
        prefix = pre;
        fileName = candidate;
        break;
      }
    }
  }
  h.write(fileName, 0, 100, 'utf8');
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(mtime, 12).copy(h, 136);
  h.write('        ', 148, 8, 'ascii'); // checksum 先占位为 8 空格
  h.write('0', 156, 1, 'ascii'); // typeflag: 普通文件
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  octal(0, 8).copy(h, 329);
  octal(0, 8).copy(h, 337);
  h.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function pad512(buf) {
  const rem = buf.length % 512;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(512 - rem, 0)]);
}

function buildTar(entries) {
  const chunks = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    const data = fs.readFileSync(e.abs);
    chunks.push(tarHeader({ name: e.name, size: data.length, mode: 0o644, mtime }));
    chunks.push(pad512(data));
  }
  chunks.push(Buffer.alloc(1024, 0)); // 结束块
  return Buffer.concat(chunks);
}

// ---------- 收集 ----------
function collect() {
  const files = [];
  for (const [rel] of INCLUDE_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺少必需文件：${rel}`);
    files.push({ abs, rel });
  }
  for (const [rel] of INCLUDE_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`缺少必需目录：${rel}`);
    const out = [];
    walk(abs, rel, out);
    if (!out.length) throw new Error(`目录为空：${rel}`);
    files.push(...out);
  }
  return files;
}

function main() {
  const files = collect();

  // 硬闸门：种子数据是运行必需品（风格/导演/镜头/节奏…），少一个包就是废包
  const seedFiles = files.filter((f) => /^server\/src\/seeds\/data\//.test(f.rel.split(path.sep).join('/')));
  if (seedFiles.length === 0) {
    throw new Error('种子数据缺失：server/src/seeds/data/ 下没有任何文件，打出来的包无法通过种子自检');
  }
  const webFiles = files.filter((f) => /^web\//.test(f.rel.split(path.sep).join('/')));
  if (webFiles.length === 0) {
    throw new Error('静态页面缺失：web/ 下没有任何文件');
  }

  const base = `wangju-daka-${VERSION}`;
  const entries = files
    .map((f) => ({ ...f, name: `${base}/${f.rel.split(path.sep).join('/')}` }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (process.argv.includes('--list')) {
    for (const e of entries) {
      const kb = (fs.statSync(e.abs).size / 1024).toFixed(1);
      console.log(`${kb.padStart(8)} KB  ${e.name}`);
    }
    console.log(`\n共 ${entries.length} 个文件`);
    return;
  }

  const tar = buildTar(entries);
  const gz = zlib.gzipSync(tar, { level: 9 });

  fs.mkdirSync(DIST, { recursive: true });
  const outFile = path.join(DIST, `${base}.tar.gz`);
  fs.writeFileSync(outFile, gz);

  const sha = crypto.createHash('sha256').update(gz).digest('hex');
  fs.writeFileSync(`${outFile}.sha256`, `${sha}  ${base}.tar.gz\n`, 'utf8');

  // 单独的构建信息，部署后可对照 /health 的 version
  fs.writeFileSync(path.join(DIST, `${base}.build.json`), JSON.stringify({
    name: base,
    version: VERSION,
    built_at: new Date().toISOString(),
    built_from: ROOT,
    files: entries.length,
    seed_files: seedFiles.length,
    web_files: webFiles.length,
    raw_bytes: tar.length,
    gzip_bytes: gz.length,
    sha256: sha,
    stamp: STAMP,
    paths: entries.map((e) => e.name.slice(base.length + 1)),
  }, null, 2) + '\n', 'utf8');

  const kb = (gz.length / 1024).toFixed(1);
  console.log(`\n✅ 已打包 ${base}.tar.gz（${entries.length} 个文件，${kb} KB）`);
  console.log(`   种子 ${seedFiles.length} 个 / 静态页 ${webFiles.length} 个`);
  console.log(`   dist/${base}.tar.gz`);
  console.log(`   dist/${base}.tar.gz.sha256`);
  console.log(`\n校验：   sha256sum dist/${base}.tar.gz`);
  console.log(`   Windows: certutil -hashfile dist\\${base}.tar.gz SHA256`);
  console.log(`\n部署：   tar -xzf ${base}.tar.gz && cd ${base}`);
  console.log(`         cp deploy/env.production.example server/.env && vi server/.env\n`);
}

main();
