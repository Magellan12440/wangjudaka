/**
 * 生成小程序 tabBar 图标（81×81 PNG，零第三方依赖）。
 *
 * 为什么自己画：小程序 tabBar 只认本地图片，不接受字体图标或 SVG；
 * 引入图标库会带来体积与授权问题。这里用距离场 + 3× 超采样生成抗锯齿线条图标。
 *
 * 用法：node scripts/make_mini_icons.js
 * 输出：../miniprogram/assets/tab/{home,create,distribute,mine}[-on].png
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../miniprogram/assets/tab');

const SIZE = 81;
const SS = 3;
const NORMAL = [0x8d, 0x97, 0xa9];
const ACTIVE = [0xf2, 0xc1, 0x4e];

// —— 基础几何 ——
const distSeg = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
};

const segs = (list) => (x, y) => Math.min(...list.map(([a, b, c, d]) => distSeg(x, y, a, b, c, d)));

const poly = (pts) => segs(pts.slice(1).map((p, i) => [pts[i][0], pts[i][1], p[0], p[1]]));

const arc = (cx, cy, r) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r);

function roundRect(x1, y1, x2, y2, r) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const hw = (x2 - x1) / 2 - r;
  const hh = (y2 - y1) / 2 - r;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw;
    const qy = Math.abs(y - cy) - hh;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const inside = Math.min(Math.max(qx, qy), 0);
    return Math.abs(outside + inside - r);
  };
}

// —— 四个图标（描边风格，线宽 9 / 81）——
const ICONS = {
  home: (x, y) => Math.min(
    poly([[16, 38], [40.5, 17], [65, 38]])(x, y),
    poly([[22, 35], [22, 66], [59, 66], [59, 35]])(x, y),
    poly([[35, 66], [35, 50], [46, 50], [46, 66]])(x, y),
  ),
  create: (x, y) => Math.min(
    roundRect(15, 15, 66, 66, 15)(x, y),
    segs([[40.5, 27, 40.5, 54], [27, 40.5, 54, 40.5]])(x, y),
  ),
  distribute: (x, y) => Math.min(
    poly([[20, 47], [20, 64], [61, 64], [61, 47]])(x, y),
    segs([[40.5, 15, 40.5, 47]])(x, y),
    poly([[30, 27], [40.5, 15], [51, 27]])(x, y),
  ),
  mine: (x, y) => Math.min(
    arc(40.5, 29, 12)(x, y),
    poly([[20, 67], [22, 60], [29, 54], [40.5, 51], [52, 54], [59, 60], [61, 67]])(x, y),
  ),
};

// —— 光栅化：超采样求覆盖率 ——
function render(fn, color) {
  const W = SIZE * SS;
  const buf = Buffer.alloc(W * W * 4);
  for (let py = 0; py < W; py++) {
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) / SS;
      const y = (py + 0.5) / SS;
      const d = fn(x, y);
      const alpha = Math.max(0, Math.min(1, (4.6 - d) / 1.6)); // 线宽约 9
      const i = (py * W + px) * 4;
      if (alpha > 0) {
        buf[i] = color[0];
        buf[i + 1] = color[1];
        buf[i + 2] = color[2];
        buf[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  // 下采样到 81×81（3×3 平均，预乘 alpha）
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = buf[i + 3] / 255;
          r += buf[i] * al;
          g += buf[i + 1] * al;
          b += buf[i + 2] * al;
          a += al;
        }
      }
      const n = SS * SS;
      const ca = a / n;
      const o = (y * SIZE + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(ca * 255);
    }
  }
  return out;
}

// —— 最小 PNG 编码器 ——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const [name, fn] of Object.entries(ICONS)) {
  for (const [suffix, color] of [['', NORMAL], ['-on', ACTIVE]]) {
    const file = path.join(OUT, `${name}${suffix}.png`);
    fs.writeFileSync(file, png(render(fn, color)));
    n++;
  }
}
console.log(`tabBar 图标已生成：${n} 个 → ${OUT}`);
