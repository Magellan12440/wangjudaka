/** 通用工具：ID、时间、 deterministic 随机、文本度量 */

import crypto from 'node:crypto';

/** 短 ID：前缀 + 时间戳 base36 + 随机 */
export function newId(prefix = 'id') {
  const t = Date.now().toString(36);
  const r = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${t}${r}`;
}

/** 稳定哈希：用于由内容推导 seed，保证同参数同结果 */
export function stableHash(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** 由字符串推导整数 seed（0 ~ 2^31） */
export function seedFrom(str) {
  const h = stableHash(String(str)).slice(0, 8);
  return parseInt(h, 16) % 2147483647;
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * 中文可发声字数估算：中文按字计，英文按单词 * 1.6 折算。
 * 用于 DIALOGUE_OVERFLOW 校验（阈值 4.1 字/秒，方案书 §12.4 第 7 条）。
 */
export function speechUnits(text = '') {
  const zh = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (text.match(/[A-Za-z]+/g) || []).length;
  return zh + en * 1.6;
}

/** 该镜长最多能说多少字 */
export function maxSpeechUnits(seconds) {
  return seconds * 4.1;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** 加权随机挑选：weights = { key: number } */
export function weightedPick(weights, rnd = Math.random) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return null;
  let r = rnd() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

/** 深拷贝（JSON 安全子集） */
export function clone(o) {
  return o === undefined ? o : JSON.parse(JSON.stringify(o));
}

/** 数组按 key 去重 */
export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
