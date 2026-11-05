// 端到端：建项目 → 一句话编排 → 剪辑单（mock relay）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wjd-oneshot-'));
const port = 8901;
const child = spawn(process.execPath, ['src/index.js'], {
  cwd: path.resolve('server'),
  env: {
    ...process.env,
    PORT: String(port), HOST: '0.0.0.0', NODE_ENV: 'production', DATA_DIR: dataDir,
    RELAY_MOCK: 'true', WX_APPID: '', WX_SECRET: '', ADMIN_TOKEN: 'x',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${port}`;
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'x' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${p} → ${r.status} ${j.code} ${j.message}`);
  return j.data;
};
const get = async (p) => {
  const r = await fetch(base + p);
  const j = await r.json();
  if (!j.ok) throw new Error(`${p} → ${r.status} ${j.code} ${j.message}`);
  return j.data;
};

const wait = async () => {
  for (let i = 0; i < 60; i++) {
    try { await get('/health'); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error('服务未起来');
};

try {
  await wait();
  const userId = 'u_test_oneshot';
  const codes = await post('/api/admin/redeem-codes', { points: 20000, count: 1 });
  const code = codes.codes?.[0] ?? codes.code;
  await post('/api/redeem', { userId, code });
  console.log('充值', code);

  const project = await post('/api/projects', {
    title: '一句话测试剧', userId,
    prompt: '被退婚的女主三年后带着资本回国，在订婚宴上当众撕碎婚书',
    styleCode: 'STY-XUANYI', aspect: '9:16', quality: '1080p',
    videoType: 'static', totalMinutes: 1, episodeSec: 60, preset: 'fast',
  });
  console.log('项目', project.id, project.title);

  let run = await post('/api/oneshot/start', { projectId: project.id });
  console.log('run', run.id, 'step', run.step, 'status', run.status);

  for (let i = 0; i < 40; i++) {
    if (['done', 'failed', 'paused'].includes(run.status)) break;
    run = await post(`/api/oneshot/${run.id}/step`, {});
    console.log(`  step=${run.step} status=${run.status} ${JSON.stringify(run.progress)}`);
  }
  console.log('最终', run.status, JSON.stringify(run.progress));
  console.log('步骤', run.steps.map((s) => `${s.key}:${s.status}`).join(' '));
  if (run.status !== 'done') {
    console.log('错误', JSON.stringify(run.steps.map((s) => s.error).filter(Boolean)));
    console.log('日志尾部', log.split('\n').slice(-15).join('\n'));
    process.exit(1);
  }

  const plan = await get(`/api/projects/${project.id}/edit`);
  console.log('剪辑单 ok', plan.ok, '镜头', plan.timeline.segments.length, '总时长', plan.timeline.total_sec);
  console.log('字幕', plan.subtitles.total, '音效', plan.sound.cues.length, 'BGM', plan.bgm.mode);
  console.log('交付物', plan.deliverables.map((d) => d.name).join(' | '));

  const rendered = await post(`/api/projects/${project.id}/edit/render`, {});
  console.log('渲染', rendered.ok, rendered.code ?? '', rendered.hint ?? '');
  if (rendered.cmd) console.log('命令前缀', rendered.cmd.slice(0, 120));
} catch (e) {
  console.error('❌', e.message);
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
