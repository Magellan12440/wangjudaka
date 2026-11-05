/**
 * 素材文件托管（/media/<file>）。
 *
 * 为什么不做鉴权：小程序的 <image>/<video> 不能带 Authorization 头。
 * 折中方案 = 不可猜的文件名（24 位随机 hex）+ 只读 + 不列目录 + nosniff。
 * 素材本身是用户自己上传的公开参考物，不含凭据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';

export const MEDIA_ROOT = path.join(config.server.dataDir, 'uploads');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};

const FILE_RE = /^[a-f0-9]{24}\.[a-z0-9]{2,5}$/;

export function resolveMediaPath(filename) {
  if (!FILE_RE.test(String(filename || ''))) return null;
  const full = path.join(MEDIA_ROOT, filename);
  return full.startsWith(MEDIA_ROOT + path.sep) ? full : null;
}

export function mediaMime(filename) {
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * @returns {boolean} true = 已响应
 */
export function tryServeMedia(req, res, pathname) {
  if (!pathname.startsWith('/media/')) return false;
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  let name;
  try {
    name = decodeURIComponent(pathname.slice('/media/'.length));
  } catch {
    res.writeHead(400);
    res.end();
    return true;
  }
  const file = resolveMediaPath(name);
  if (!file) {
    res.writeHead(404);
    res.end();
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return true;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return true;
  }

  const headers = {
    'Content-Type': mediaMime(name),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };

  // 视频播放器会发 Range：只支持单段，够用且实现简单
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const size = stat.size;
    let start = range[1] === '' ? null : Number(range[1]);
    let end = range[2] === '' ? null : Number(range[2]);
    if (start === null) {
      // bytes=-500 → 末尾 500 字节
      const tail = end ?? 0;
      start = Math.max(0, size - tail);
      end = size - 1;
    } else {
      end = end === null ? size - 1 : Math.min(end, size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

export default tryServeMedia;
