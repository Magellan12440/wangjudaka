/**
 * 生成 tabBar 图标（浅色模式）。
 *
 * 为什么自己画：原先的图标是给深色底做的浅色线稿，换白底后几乎看不见；
 * 而项目里没有 ImageMagick/PIL，只有 pngjs。
 * 做法：4 倍超采样画 SDF 形状，再盒式降采样，得到平滑边缘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 依赖装在 server/ 下，用 createRequire 指过去，避免根目录找不到 pngjs
const require = createRequire(path.resolve('server/package.json'));
const { PNG } = require('pngjs');

const OUT = path.resolve('miniprogram/assets/tab');
const SIZE = 81;
const SS = 4;                  // 超采样倍数
const W = SIZE * SS;

const NORMAL = [146, 158, 176]; // #929EB0
const ACTIVE = [255, 138, 61];  // #FF8A3D

const dist2 = (x, y, x1, y1) => Math.hypot(x - x1, y - y1);
const seg = (x, y, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
};
const roundRect = (x, y, x1, y1, x2, y2, r) => {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const hx = (x2 - x1) / 2 - r, hy = (y2 - y1) / 2 - r;
  const dx = Math.abs(x - cx) - hx, dy = Math.abs(y - cy) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const arc = (x, y, cx, cy, r, a1, a2) => {
  const ang = Math.atan2(y - cy, x - cx);
  let deg = (ang * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg >= a1 && deg <= a2 ? Math.abs(dist2(x, y, cx, cy) - r) : 1e9;
};

const STROKE = 5.6 * SS;

const ICONS = {
  home(x, y) {
    const s = 25; // 屋顶
    return Math.min(
      seg(x, y, 15 * SS, 38 * SS, 40.5 * SS, 17 * SS),
      seg(x, y, 40.5 * SS, 17 * SS, 66 * SS, 38 * SS),
      seg(x, y, 20 * SS, 36 * SS, 20 * SS, 64 * SS),
      seg(x, y, 61 * SS, 36 * SS, 61 * SS, 64 * SS),
      seg(x, y, 20 * SS, 64 * SS, 61 * SS, 64 * SS),
    ) - STROKE / 2;
  },
  create(x, y) {
    return Math.min(
      Math.abs(roundRect(x, y, 17 * SS, 17 * SS, 64 * SS, 64 * SS, 12 * SS)) - STROKE / 2,
      seg(x, y, 40.5 * SS, 28 * SS, 40.5 * SS, 53 * SS) - STROKE / 2,
      seg(x, y, 28 * SS, 40.5 * SS, 53 * SS, 40.5 * SS) - STROKE / 2,
    );
  },
  distribute(x, y) {
    const n = [
      [22 * SS, 25 * SS], [59 * SS, 25 * SS], [40.5 * SS, 58 * SS],
    ];
    const r = 6.4 * SS;
    return Math.min(
      ...n.map(([cx, cy]) => dist2(x, y, cx, cy) - r),
      seg(x, y, n[0][0], n[0][1], n[1][0], n[1][1]) - STROKE / 2,
      seg(x, y, n[0][0], n[0][1], n[2][0], n[2][1]) - STROKE / 2,
      seg(x, y, n[1][0], n[1][1], n[2][0], n[2][1]) - STROKE / 2,
    );
  },
  mine(x, y) {
    return Math.min(
      Math.abs(dist2(x, y, 40.5 * SS, 27 * SS) - 11.5 * SS) - STROKE / 2,
      arc(x, y, 40.5 * SS, 68 * SS, 19 * SS, 200, 340) - STROKE / 2,
      seg(x, y, 21.5 * SS, 68 * SS, 24 * SS, 62 * SS) - STROKE / 2,
      seg(x, y, 59.5 * SS, 68 * SS, 57 * SS, 62 * SS) - STROKE / 2,
    );
  },
};

function render(name, rgb) {
  const big = new Float32Array(W * W); // 覆盖率
  const fn = ICONS[name];
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const d = fn(x + 0.5, y + 0.5);
      // 1.2px 过渡带做柔边（超采样空间）
      big[y * W + x] = Math.max(0, Math.min(1, 0.5 - d / (1.6 * SS)));
    }
  }
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          sum += big[(y * SS + dy) * W + (x * SS + dx)];
        }
      }
      const a = sum / (SS * SS);
      const i = (y * SIZE + x) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = Math.round(a * 255);
    }
  }
  return PNG.sync.write(png);
}

fs.mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(ICONS)) {
  fs.writeFileSync(path.join(OUT, `${name}.png`), render(name, NORMAL));
  fs.writeFileSync(path.join(OUT, `${name}-on.png`), render(name, ACTIVE));
  console.log('✓', name);
}
