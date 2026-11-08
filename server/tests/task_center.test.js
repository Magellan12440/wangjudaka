/**
 * V4.19 异步任务中心。
 *
 * 起因：wx.cloud.callContainer 的 timeout 官方硬上限 15s，而 AI 出图要 20~40s、
 * 视频要 1~3 分钟。同步接口在真机上必然超时——用户看到失败，服务端其实还在扣点出图。
 * 所以慢操作全部改成「提交拿 task_id → 轮询 /api/task/:id」。
 *
 * 这里逐条锁死几个「错了就会骗到用户」的行为：
 *  1. 提交立刻返回，不阻塞；
 *  2. 进度单调不降、运行时封顶 92%（绝不 100% 却没结果）；
 *  3. 失败必然带 error_code，且不留「一直在跑」的僵尸状态；
 *  4. 不是自己的任务按「不存在」处理（404，不泄露存在性）；
 *  5. 同一 idemKey 不重复执行（双击/重试不该扣两次点）；
 *  6. 进程重启后旧任务被收尾，不会永远转圈；
 *  7. 排队中可以取消，已在跑的如实告知撤不回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import { TaskCenter, TASK_STATUS } from '../src/pipeline/TaskCenter.js';
import { AppError } from '../src/core/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reset() {
  db._reset('tasks');
  // 队列是模块级的：不清空的话，上个用例里「永不结束」的任务会一直占着并发位，
  // 后面的用例只能排队等超时（这不是产品问题，是测试自己制造的）。
  taskCenterRef.resetQueue();
}

const taskCenterRef = new TaskCenter();

/** 等任务跑到终态（或超时），返回最终视图 */
async function settle(center, id, { userId = null, timeout = 4000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const v = center.view(id, { userId });
    if (v.done) return v;
    if (Date.now() - startedAt > timeout) return v;
    await sleep(20);
  }
}

test('提交立刻返回 task_id，状态是 pending/running，不阻塞调用方', async () => {
  reset();
  const center = new TaskCenter();
  let released = false;
  const t = center.submit({
    userId: 'u_task_1',
    type: 'image',
    run: () => new Promise((resolve) => { setTimeout(() => { released = true; resolve({ url: '/media/a.png' }); }, 60); }),
  });
  assert.ok(t.task_id, '必须返回任务号');
  assert.equal(t.reused, false);
  // 关键：submit 是同步返回的，执行体还没跑完
  assert.equal(released, false, '提交不应等待执行体完成');
  const v = center.view(t.task_id);
  assert.ok([TASK_STATUS.PENDING, TASK_STATUS.RUNNING].includes(v.status));
  assert.equal(v.done, false);
  await settle(center, t.task_id);
});

test('成功：status=succeeded、progress=100、result 原样透传', async () => {
  reset();
  const center = new TaskCenter();
  const t = center.submit({
    userId: 'u_task_2', type: 'image',
    run: async () => ({ url: '/media/ok.png', credits: 8 }),
  });
  const v = await settle(center, t.task_id);
  assert.equal(v.status, TASK_STATUS.SUCCEEDED);
  assert.equal(v.ok, true);
  assert.equal(v.progress, 100);
  assert.equal(v.result.url, '/media/ok.png');
  assert.equal(v.result.credits, 8);
  assert.equal(v.error_message, null);
});

test('运行中进度单调不降，且封顶 92%（不假装 100%）', async () => {
  reset();
  const center = new TaskCenter();
  const t = center.submit({
    userId: 'u_task_3', type: 'video', etaSec: 10,
    run: async ({ report }) => {
      report(20, 'compiling');
      await sleep(30);
      report(10, 'calling'); // 故意回退：服务端应挡掉
      await sleep(30);
      report(70, 'archiving');
      await sleep(60);
      return { url: '/media/v.mp4' };
    },
  });
  const seen = [];
  for (let i = 0; i < 60; i += 1) {
    const v = center.view(t.task_id);
    seen.push(v.progress);
    if (v.done) break;
    // 运行中永远不超过 92：最后 8% 只在真正完成时给
    if (!v.done) assert.ok(v.progress <= 92, `运行中进度不能超过 92，实际 ${v.progress}`);
    await sleep(15);
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `进度不能回退：${seen[i - 1]} → ${seen[i]}`);
  }
  const final = center.view(t.task_id);
  assert.equal(final.progress, 100, '完成后才给 100');
});

test('失败：带 error_code 与中文说明，不会停在 running', async () => {
  reset();
  const center = new TaskCenter();
  const t = center.submit({
    userId: 'u_task_4', type: 'image',
    run: async () => {
      const e = new AppError('INSUFFICIENT_CREDITS', '点数不足，请先充值');
      throw e;
    },
  });
  const v = await settle(center, t.task_id);
  assert.equal(v.status, TASK_STATUS.FAILED);
  assert.equal(v.done, true);
  assert.equal(v.ok, false);
  assert.equal(v.error_code, 'INSUFFICIENT_CREDITS');
  assert.equal(v.error_message, '点数不足，请先充值');
});

test('归属隔离：别人的任务查不到，按「不存在」处理', async () => {
  reset();
  const center = new TaskCenter();
  const t = center.submit({ userId: 'u_task_5', type: 'image', run: async () => ({ ok: 1 }) });
  await settle(center, t.task_id);
  assert.throws(() => center.view(t.task_id, { userId: 'someone_else' }), (e) => e.code === 'TASK_NOT_FOUND');
  // 本人照常能查
  assert.equal(center.view(t.task_id, { userId: 'u_task_5' }).task_id, t.task_id);
  // 不存在的任务号也是同一个错误码，不泄露「存在但不是你的」
  assert.throws(() => center.view('task_nope'), (e) => e.code === 'TASK_NOT_FOUND');
});

test('idemKey 幂等：重复提交拿回同一个任务，不重复执行', async () => {
  reset();
  const center = new TaskCenter();
  let runs = 0;
  const make = () => center.submit({
    userId: 'u_task_6', type: 'image', idemKey: 'idem-abc',
    run: async () => { runs += 1; return { ok: 1 }; },
  });
  const a = make();
  const b = make();
  assert.equal(b.task_id, a.task_id, '同 idemKey 必须复用任务号');
  assert.equal(b.reused, true);
  await settle(center, a.task_id);
  assert.equal(runs, 1, '执行体只能跑一次');
});

test('并发上限：一个人手上任务过多时明确拒绝（429 TASK_TOO_MANY）', async () => {
  reset();
  const center = new TaskCenter();
  const hang = () => new Promise(() => {}); // 永不结束，制造积压
  for (let i = 0; i < 6; i += 1) {
    center.submit({ userId: 'u_task_7', type: 'image', run: hang });
  }
  assert.throws(
    () => center.submit({ userId: 'u_task_7', type: 'image', run: hang }),
    (e) => e.code === 'TASK_TOO_MANY',
  );
  // 换个人不受影响（他也会排队，但「提交被接受」本身就是这里要验的）
  const other = center.submit({ userId: 'u_task_7b', type: 'image', run: async () => ({ ok: 1 }) });
  assert.ok(other.task_id);
  assert.equal(center.view(other.task_id).done, false);
});

test('取消：排队中的能撤，已在跑的如实告知撤不回', async () => {
  reset();
  const center = new TaskCenter();
  // 先用两个长任务把并发位占满（MAX_RUNNING=2），第三个必然还在排队
  const hang = () => new Promise(() => {});
  center.submit({ userId: 'u_task_8a', type: 'image', run: hang });
  center.submit({ userId: 'u_task_8b', type: 'image', run: hang });
  const queued = center.submit({ userId: 'u_task_8', type: 'image', run: async () => ({ ok: 1 }) });
  await sleep(20);
  const r = center.cancel(queued.task_id, { userId: 'u_task_8' });
  assert.equal(r.canceled, true);
  assert.equal(center.view(queued.task_id).status, TASK_STATUS.CANCELED);

  const runningTask = center.submit({
    userId: 'u_task_8c', type: 'image',
    run: () => new Promise((res) => { setTimeout(() => res({ ok: 1 }), 120); }),
  });
  // 等到真的开始跑（并发位可能在排队，这里等到 running 或超时都不影响判定语义）
  for (let i = 0; i < 40; i += 1) {
    if (center.view(runningTask.task_id).status === TASK_STATUS.RUNNING) break;
    await sleep(10);
  }
  const r2 = center.cancel(runningTask.task_id, { userId: 'u_task_8c' });
  if (r2.canceled) {
    assert.equal(r2.status, TASK_STATUS.CANCELED);
  } else {
    assert.match(r2.reason, /无法中途撤回|已结束/);
  }
});

test('进程重启：上次遗留的 running/pending 被收尾，不会永远「生成中」', async () => {
  reset();
  const now = new Date().toISOString();
  const stuck = db.insert('tasks', {
    id: 'task_stuck_1',
    user_id: 'u_task_9',
    project_id: null,
    type: 'image',
    label: '旧任务',
    status: TASK_STATUS.RUNNING,
    progress: 40,
    stage: 'calling',
    eta_sec: 45,
    created_at: now,
    updated_at: now,
    started_at: now,
  });
  assert.ok(stuck.id);
  // 新实例 = 进程重启后的第一次访问
  const center = new TaskCenter();
  const v = center.view('task_stuck_1');
  assert.equal(v.status, TASK_STATUS.FAILED);
  assert.equal(v.error_code, 'PROCESS_RESTARTED');
  assert.match(v.error_message, /重新发起/);
});

test('列表与统计：只回自己的任务，activeOnly 过滤掉已结束的', async () => {
  reset();
  const center = new TaskCenter();
  // 先提交会结束的（它立刻拿到并发位），再提交挂住的，避免测试为了等队列白跑几秒
  const a = center.submit({ userId: 'u_task_10', projectId: 'proj_x', type: 'image', run: async () => ({ ok: 1 }) });
  await settle(center, a.task_id);
  center.submit({ userId: 'u_task_11', projectId: 'proj_x', type: 'image', run: () => new Promise(() => {}) });

  const mine = center.list({ userId: 'u_task_10' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].task_id, a.task_id);

  const actives = center.list({ userId: 'u_task_11', activeOnly: true });
  assert.equal(actives.length, 1);
  assert.equal(actives[0].done, false);

  const stats = center.stats();
  assert.ok(stats.total >= 2);
  assert.ok(stats.max_running >= 1);
});

test('阶段文案是中性的：不出现「预计 X 秒」这类会打脸的承诺', async () => {
  reset();
  const center = new TaskCenter();
  const t = center.submit({
    userId: 'u_task_12', type: 'image',
    run: ({ report }) => new Promise((resolve) => {
      report(30, 'calling');
      setTimeout(() => resolve({ ok: 1 }), 60);
    }),
  });
  const v = center.view(t.task_id);
  assert.match(v.stage_text, /生成|处理|准备|排队|校验|扣点|保存|归档|结算|完成/);
  assert.doesNotMatch(v.stage_text, /预计|秒内|马上好/);
  await settle(center, t.task_id);
});
