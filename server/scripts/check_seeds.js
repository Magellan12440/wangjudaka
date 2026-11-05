/**
 * 种子库自检：投产前必跑。
 * 用法：node scripts/check_seeds.js
 * 退出码：0 通过 / 1 有问题
 */
import seeds from '../src/seeds/loader.js';

const r = seeds.validate();

console.log('=== 种子库自检 ===');
console.log('数量：', JSON.stringify(r.counts));
console.log('曲库可商用曲目：', seeds.licensableBgm().length, '/', seeds.bgmLibrary.length);
console.log('可商用模型：', seeds.modelsByRole('video', { commercialOnly: true }).length, '个视频 /',
  seeds.modelsByRole('image', { commercialOnly: true }).length, '个图片');
console.log('分发平台：', seeds.distributionPlatforms.length);
console.log('蓝图模板：', seeds.blueprintTemplates.length);

if (!r.ok) {
  console.error('\n发现问题：');
  for (const p of r.problems) console.error(' -', JSON.stringify(p));
  process.exit(1);
}
console.log('\n全部通过 ✅');
