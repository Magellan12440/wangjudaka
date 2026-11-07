/**
 * 云存储自检（V4.8）：真上传 → 核对大小 → 取临时链接 → 读回 → 删除。
 *
 * 用途：验证「代码能不能真的把文件放进云存储」，而不是只看配置项。
 * 不会碰业务数据：对象键前缀固定为 _selftest/，跑完即删。
 *
 * 用法：
 *   TCB_ENV=<云开发环境ID> npm run storage:check
 *   本地联调想强制走本地盘：STORAGE_PROVIDER=local npm run storage:check
 */
import { objectStore, cloudEnvId } from '../src/storage/ObjectStore.js';
import { config } from '../src/config/env.js';

// 1x1 透明 PNG
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001'
  + '0d0a2db40000000049454e44ae426082',
  'hex',
);

const pass = (m) => console.log(`  ✅ ${m}`);
const fail = (m) => { console.log(`  ❌ ${m}`); process.exitCode = 1; };

console.log('云存储自检');
console.log(`  服务端版本 : ${config.server.version}`);
console.log(`  环境 ID    : ${cloudEnvId() || '（未配置 TCB_ENV / COS_BUCKET）'}`);
console.log(`  策略       : ${objectStore.providerPref}`);
console.log(`  实际模式   : ${objectStore.mode}`);
console.log('');

if (objectStore.mode !== 'cloud') {
  console.log('⚠️  当前不会使用云存储，文件会落在容器本地盘（重启即丢）。要开启请配：');
  console.log('     WX_APPID / WX_SECRET  —— 服务端换取 access_token');
  console.log('     TCB_ENV               —— 云开发环境 ID（可从 COS_BUCKET=7072-<env>-<appid> 反推）');
  console.log('   然后：STORAGE_PROVIDER=cloud npm run storage:check 强验证一次');
  process.exit(process.exitCode || 0);
}

const saved = await objectStore.put(PNG, { ext: '.png', mime: 'image/png', prefix: '_selftest' });
if (saved.provider === 'cloud') pass(`上传成功 ${saved.url}`);
else fail(`上传走了本地通道（${saved.url}），说明云通道失败：${objectStore.status().last_error}`);

const size = await objectStore.headSize(saved.url);
if (size === PNG.length) pass(`HEAD 大小一致 ${size}B`);
else fail(`HEAD 大小异常：${size}（期望 ${PNG.length}）`);

const map = await objectStore.tempUrls([saved.url]);
if (map[saved.url] && /^https:\/\//.test(map[saved.url])) pass('临时链接可换取（小程序据此渲染）');
else fail('临时链接换取失败，前端会显示不出来');

const back = await objectStore.read(saved.url);
if (back && back.length === PNG.length) pass('内容回读一致');
else fail(`内容回读失败：${back ? back.length : 'null'}`);

const removed = await objectStore.remove(saved.url);
if (removed) pass('清理完成');
else fail('清理失败（不影响功能，但会留垃圾对象）');

console.log('');
console.log(process.exitCode ? '自检未通过' : '自检通过：云存储可用');
