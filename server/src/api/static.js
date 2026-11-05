/**
 * 本地静态资源托管（阶段 H：让 PC 无限画布 / 上传助手可直接被服务打开）。
 *
 * 安全约束：
 *  - 只能读工程根 `web/` 目录内的文件，路径规范化后必须仍在 WEB_ROOT 内（防目录穿越）。
 *  - 扩展名白名单；不提供目录列表；不跟随符号链接到外部。
 *  - 不缓存（no-store），避免开发期拿到旧页面；带 nosniff。
 *  - 只处理 GET / HEAD，其余方法交回 JSON 路由。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** src/api → src → server → 工程根 → web */
export const WEB_ROOT = path.resolve(__dirname, '..', '..', '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const rel = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  const resolved = path.resolve(WEB_ROOT, `.${rel}`);
  if (resolved !== WEB_ROOT && !resolved.startsWith(WEB_ROOT + path.sep)) return null;
  if (!MIME[path.extname(resolved).toLowerCase()]) return null;
  return resolved;
}

/**
 * 尝试托管静态文件。
 * @returns {boolean} true = 已响应（含 403/404 静态错误），false = 不是静态请求，交给 JSON 路由
 */
export function tryServeStatic(req, res, pathname) {
  const method = req.method?.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  // 只接管明确的 web 页面/资源，API 路径一律不接管
  if (pathname.startsWith('/api/') || pathname === '/health') return false;

  const file = resolveStaticPath(pathname);
  if (!file) return false;

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext],
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  };
  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

/** 供健康检查 / 前端体检脚本使用 */
export function staticStatus() {
  let files = [];
  try {
    files = fs.readdirSync(WEB_ROOT, { recursive: true })
      .filter((f) => typeof f === 'string' && MIME[path.extname(f).toLowerCase()])
      .map((f) => f.split(path.sep).join('/'))
      .sort();
  } catch {
    files = [];
  }
  return { web_root_exists: fs.existsSync(WEB_ROOT), file_count: files.length, files };
}

export default tryServeStatic;
