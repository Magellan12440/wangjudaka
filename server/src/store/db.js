/**
 * 极简 JSON 持久化仓库。
 * 设计意图：本地/单机阶段零依赖跑通全链路；接口形状与 MySQL 版一致，
 * 后续替换实现（Prisma/Drizzle）时业务层零改动。
 *
 * 集合（collection）→ 文件：data/<collection>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../core/redact.js';

const DATA_DIR = config.server.dataDir;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileOf(col) {
  if (!/^[a-zA-Z0-9_-]+$/.test(col)) throw new Error(`非法集合名: ${col}`);
  return path.join(DATA_DIR, `${col}.json`);
}

const cache = new Map();

function readCol(col) {
  if (cache.has(col)) return cache.get(col);
  ensureDir();
  const f = fileOf(col);
  let rows = [];
  if (fs.existsSync(f)) {
    try {
      rows = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      logger.error('集合读取失败，已置空', { col, error: e.message });
      rows = [];
    }
  }
  cache.set(col, rows);
  return rows;
}

let flushTimer = null;
function scheduleFlush(col) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const c of cache.keys()) writeCol(c);
  }, 50);
}

function writeCol(col) {
  ensureDir();
  const rows = cache.get(col) ?? [];
  const f = fileOf(col);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

export const db = {
  /** 查询：predicate 可选 */
  find(col, predicate = () => true) {
    return readCol(col).filter(predicate).map((r) => JSON.parse(JSON.stringify(r)));
  },
  findOne(col, predicate) {
    const r = readCol(col).find(predicate);
    return r ? JSON.parse(JSON.stringify(r)) : null;
  },
  /** 插入（若已存在同 id 则抛错） */
  insert(col, row) {
    const rows = readCol(col);
    if (row.id && rows.some((r) => r.id === row.id)) {
      throw new Error(`重复 id: ${row.id}`);
    }
    const rec = { ...row, _createdAt: row._createdAt ?? new Date().toISOString() };
    rows.push(rec);
    scheduleFlush(col);
    return JSON.parse(JSON.stringify(rec));
  },
  upsert(col, row, key = 'id') {
    const rows = readCol(col);
    const i = rows.findIndex((r) => r[key] === row[key]);
    if (i >= 0) {
      rows[i] = { ...rows[i], ...row, _updatedAt: new Date().toISOString() };
      scheduleFlush(col);
      return JSON.parse(JSON.stringify(rows[i]));
    }
    return db.insert(col, row);
  },
  update(col, id, patch) {
    const rows = readCol(col);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch, _updatedAt: new Date().toISOString() };
    scheduleFlush(col);
    return JSON.parse(JSON.stringify(rows[i]));
  },
  remove(col, id) {
    const rows = readCol(col);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    rows.splice(i, 1);
    scheduleFlush(col);
    return true;
  },
  count(col, predicate = () => true) {
    return readCol(col).filter(predicate).length;
  },
  /** 强制落盘（测试与关停时调用） */
  flush() {
    for (const c of cache.keys()) writeCol(c);
  },
  /** 清空（仅供测试） */
  _reset(col) {
    cache.delete(col);
    const f = fileOf(col);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  },
};

process.on('exit', () => db.flush());
