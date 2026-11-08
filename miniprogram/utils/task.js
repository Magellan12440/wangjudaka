/**
 * 任务进度条（V4.19）。
 *
 * 解决的问题：AI 生成要几十秒到几分钟，中间既不能假装很快、也不能只转个圈不说话。
 * 用户需要知道三件事：**在做什么、大概到哪了、还要不要等**。
 *
 * 设计取舍（都是踩过坑才这么写）：
 *  1. **中性文案，不承诺秒数**：预估时间只用来推进度条，不写进文案。
 *     写「预计 30 秒」而实际用了 3 分钟，比只说「正在生成」更伤信任。
 *  2. **进度数字不撒谎**：服务端只在真实阶段给高百分比，等待段用软推进且封顶 92%，
 *     所以这里直接照抄服务端的 progress，不在前端另算一套。
 *  3. **离开页面不丢任务**：任务号存本地（`task:<key>`），回来自动续上轮询。
 *     用户切去微信回消息再回来，看到的还是同一条进度，而不是「什么都没发生」。
 *  4. **可以不等**：给「先回首页，后台继续」的出口——长任务把用户按在页面上是错的。
 */
const api = require('./api.js');

const TIPS = [
  'AI 生成通常需要几十秒，长任务可能几分钟',
  '可以先去别的页面，回来还能看到进度',
  '点数只在成功时结算，失败会自动退回',
  '这一镜完成后会自动出现在分镜里',
];

function storageKey(key) {
  return `task:${key}`;
}

function loadActive(key) {
  try {
    const v = wx.getStorageSync(storageKey(key));
    return v && v.id ? v : null;
  } catch (e) {
    return null;
  }
}

function saveActive(key, val) {
  try {
    if (val) wx.setStorageSync(storageKey(key), val);
    else wx.removeStorageSync(storageKey(key));
  } catch (e) { /* 存不进去不影响本次等待，只是回来接不上 */ }
}

/**
 * 初始态。
 * 两个标志必须分开：`active` 表示「还在跑」（用来挡住重复点击），
 * `visible` 表示「要不要显示这条」（结束后仍留着让用户看到结果）。
 * 合用一个字段会出现「完成了但仍然 active」→ 后面所有生成按钮全被自己挡住。
 */
const IDLE = {
  active: false,
  visible: false,
  id: '',
  title: '',
  pct: 0,
  stage: '',
  tip: '',
  error: '',
  done: false,
  elapsed: 0,
};

function toView(v, title) {
  const done = v.status === 'succeeded';
  const failed = v.status === 'failed';
  return {
    visible: true,
    active: !done && !failed && !v.done,
    id: v.task_id,
    title: title || v.label || '生成中',
    pct: Math.max(0, Math.min(100, Number(v.progress) || 0)),
    stage: v.stage_text || '正在处理',
    tip: TIPS[0],
    error: v.error_message || '',
    done,
    failed,
    elapsed: Number(v.elapsed_sec) || 0,
  };
}

/**
 * 发起并跟踪一个任务。
 *
 * @param {object} p
 * @param {object} p.page 页面实例（要能 setData）
 * @param {string} p.key 本页唯一键（同一时刻只跟一个任务，抢同一份 UI）
 * @param {string} p.title 展示标题，如「第 3 镜 · 关键帧」
 * @param {()=>Promise<{task_id:string}>} p.submit 调 api.startXxxTask
 * @param {(result:any, view:object)=>void} [p.onDone]
 * @param {(err:Error)=>void} [p.onFail]
 */
function start({ page, key, title, submit, onDone, onFail }) {
  const p = page;
  p._taskKey = key;
  p._taskCanceled = false;
  p.setData({ task: Object.assign({}, IDLE, { active: true, visible: true, title, stage: '正在提交…', tip: TIPS[0] }) });

  return Promise.resolve()
    .then(() => submit())
    .then((r) => {
      // 批量出图时可能「一张可出的都没有」，服务端直接给终态、没有任务号
      if (!r || !r.task_id) {
        const note = (r && (r.note || '没有需要处理的内容')) || '没有需要处理的内容';
        p.setData({ task: Object.assign({}, IDLE, { visible: true, title, stage: note, done: true, pct: 100 }) });
        if (typeof onDone === 'function') onDone(r, { done: true });
        return null;
      }
      saveActive(key, { id: r.task_id, title, at: Date.now() });
      return api.pollTask(r.task_id, {
        interval: r.poll_after_ms || 1500,
        isCanceled: () => p._taskCanceled === true,
        onProgress: (v) => {
          if (p._taskCanceled) return;
          p.setData({ task: toView(v, title) });
        },
      })
        .then((v) => {
          saveActive(key, null);
          p.setData({ task: toView(v, title) });
          if (v.status === 'succeeded') {
            if (typeof onDone === 'function') onDone(v.result, v);
          } else {
            const err = new Error(v.error_message || '任务失败，请重试');
            err.code = v.error_code || 'TASK_FAILED';
            p.setData({ task: Object.assign(toView(v, title), { error: err.message }) });
            if (typeof onFail === 'function') onFail(err);
          }
          return v;
        })
        .catch((err) => {
          if (err && err.code === 'POLL_CANCELED') return null;
          saveActive(key, null);
          // 超时不等于失败：任务可能还在跑，文案要说清，不要吓用户
          const msg = err?.code === 'POLL_TIMEOUT'
            ? '等得有点久，任务可能还在后台执行，稍后在「任务」里查看'
            : (err?.message || '任务状态查询失败');
          p.setData({ task: Object.assign({}, IDLE, { visible: true, title, stage: '已停止等待', error: msg }) });
          if (typeof onFail === 'function') onFail(err);
          return null;
        });
    })
    .catch((err) => {
      saveActive(key, null);
      p.setData({ task: Object.assign({}, IDLE, { visible: true, title, error: err?.message || '提交失败，请稍后重试' }) });
      if (typeof onFail === 'function') onFail(err);
      return null;
    });
}

/**
 * 回到页面时续上未完成的任务（本地存着 task_id 就继续轮询）。
 * 注意：任务在服务端不会因为用户离开而停止，续上是「看到真实进度」，不是重新发起。
 */
function resume({ page, key, title, onDone, onFail }) {
  const p = page;
  const saved = loadActive(key);
  if (!saved || !saved.id) return Promise.resolve(null);
  p._taskKey = key;
  p._taskCanceled = false;
  p.setData({ task: Object.assign({}, IDLE, { active: true, visible: true, title: title || saved.title, stage: '正在查询进度…' }) });
  return api.pollTask(saved.id, {
    isCanceled: () => p._taskCanceled === true,
    onProgress: (v) => {
      if (p._taskCanceled) return;
      p.setData({ task: toView(v, title || saved.title) });
    },
  })
    .then((v) => {
      saveActive(key, null);
      p.setData({ task: toView(v, title || saved.title) });
      if (v.status === 'succeeded' && typeof onDone === 'function') onDone(v.result, v);
      return v;
    })
    .catch((err) => {
      if (err && err.code === 'POLL_CANCELED') return null;
      saveActive(key, null);
      p.setData({ task: Object.assign({}, IDLE, { visible: true, title: title || saved.title, error: err?.message || '查询失败' }) });
      if (typeof onFail === 'function') onFail(err);
      return null;
    });
}

/** 离开页面：停止轮询但保留任务号（回来还能接上） */
function detach(page) {
  const p = page;
  p._taskCanceled = true;
}

/** 收起进度条（用户点「知道了」） */
function dismiss(page) {
  const p = page;
  if (p.data.task && p.data.task.id) saveActive(p._taskKey, null);
  p.setData({ task: Object.assign({}, IDLE) });
}

module.exports = {
  IDLE,
  TIPS,
  start,
  resume,
  detach,
  dismiss,
  loadActive,
};
