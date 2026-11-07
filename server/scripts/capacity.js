#!/usr/bin/env node
/**
 * 容量测算 CLI（V4.9.1）
 *
 *   npm run capacity                 # 默认：3 集 × 90 秒
 *   npm run capacity -- --episodes 10 --sec 60 --users 20
 *   npm run capacity -- --json       # 给脚本/监控读
 *
 * 会真的去问一次上游余额（有缓存），所以要用生产密钥跑：
 *   RELAY_API_KEY=xxx node scripts/capacity.js
 */
import capacity from '../src/relay/Capacity.js';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const episodes = Number(flag('episodes', 3)) || 3;
const episodeSec = Number(flag('sec', 90)) || 90;
const users = Number(flag('users', 0)) || 0;
const asJson = Boolean(flag('json', false));

const r = await capacity.snapshot({ episodes, episodeSec, activeUsersWanted: users });

if (asJson) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const p = r.pool;
const s = r.shape;
const c = r.cost;
const t = r.throughput;

console.log('');
console.log('=== 算力池容量测算 ===');
console.log(`模式              ${p.mode}    水位 ${p.water_level}`);
console.log(`池余额            ${p.balance_suanli === null ? '—（mock 或余额接口不可用）' : p.balance_suanli + ' 算力'}`);
console.log(`并发槽位 / RPM    ${p.max_concurrency} 槽 / ${p.rpm_limit} RPM（当前占用 ${p.inflight}）`);
console.log('');
console.log(`规格              ${s.episodes} 集 × ${s.episode_sec}s = ${s.shots} 个镜头`);
console.log(`单镜成本          ${c.per_shot_suanli} 算力（720p） / ${c.per_shot_cheap_suanli} 算力（480p）`);
console.log(`单集成片          ${c.per_episode_suanli} 算力`);
console.log(`一部剧            ${c.per_drama_suanli} 算力 ≈ ${c.per_drama_points} 点`);
console.log('');
console.log(`单条时延          ${t.avg_latency_sec}s`);
console.log(`吞吐              ${t.shots_per_minute} 镜/分钟 · ${t.video_seconds_per_hour} 秒成片/小时`);
console.log(`日产能            ${t.dramas_per_day} 部/天（满负荷）`);
console.log(`可同时出片        ${r.concurrency.users_comfortable} 人舒适 / ${r.concurrency.users_max} 人极限`);
console.log('');
if (r.runway.shots !== null) {
  console.log(`余额可支撑        还能出 ${r.runway.shots} 个镜头 / ${r.runway.episodes} 集 / ${r.runway.dramas} 部剧`);
} else {
  console.log('余额可支撑        —（当前拿不到真实余额，检查 RELAY_API_KEY 是否为生产密钥）');
}
console.log('');
console.log(`当前瓶颈          ${r.bottleneck}`);
for (const a of r.advice) console.log(`  · ${a}`);
console.log('');
