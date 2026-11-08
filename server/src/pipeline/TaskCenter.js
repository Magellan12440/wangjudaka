/**
 * 异步任务中心（V4.19）。
 *
 * 为什么必须改成异步：小程序内网通道 wx.cloud.callContainer 的 timeout 硬上限是 15s
 * （官方限制，传更大的值会被忽略）。一张图 20~40s、一段视频 1~3 分钟、一批分镜图
 * 好几分钟 —— 同步接口在真机上必然「请求超时」，用户只能看到转圈然后报错，
 * 而服务端其实还在扣点、还在出图。这是同步 API 在天生有 15s 上限的通道上跑不通的
 * 结构性问题，不是调大 timeout 能解决的。
 *
 * 因此所有慢操作统一走：
 *   POST /api/task/...  →  立刻返回 { task_id }
 *   GET  /api/task/:id  →  轮询状态 / 进度 / 结果
 *
 * 关键设计（都是踩过的坑）：
 *  1. **进度必须诚实**：能上报真实阶段的就上报（编译/提交算力/归档），上报不到的那段
 *     用「已耗时 / 预估耗时」做软推进，但**封顶 92%**——绝不假装 100%，最后 8% 只在
 *     真正完成时给。用户看到卡在 90% 好过看到 100% 却没结果。
 *  2. **任务落库而不是只放内存**：进程重启后内存队列必丢，但记录还在。启动时把
 *     running/pending 的旧任务标成 PROCESS_RESTARTED，前端据此提示「重新发起」，
 *     不会永远停在「生成中」。
 *  3. **同一 idemKey 幂等**：网络抖动导致重复提交时，不会扣两次点。
 *  4. **并发上限**：上游算力是有限资源，排队比全量发起更稳（也避免触发限流）。
 */
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import { logger } from '../core/redact.js';

const COL = 'tasks';

/** 任务状态机：pending → running → succeeded | failed（canceled 只对排队中有效） */
export const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
};

const FINAL = [TASK_STATUS.SUCCEEDED, TASK_STATUS.FAILED, TASK_STATUS.CANCELED];

/** 同时跑几个。上游限流一般按 QPS 与并发双卡，2 个是「不排队太久也不撞限流」的折中 */
const MAX_RUNNING = 2;
/** 软推进封顶：留最后一段给真实完成，避免 100% 却还没结果 */
const SOFT_CAP = 92;
/** 完成任务保留 3 天（够用户回看，也不至于把库撑大） */
const KEEP_MS = 3 * 24 * 3600 * 1000;

/** 各类型的预估耗时（秒）：只用于软推进与「大概还要多久」，不作为超时判据 */
const ETA_SEC = {
  image: 45,
  asset_image: 45,
  video: 150,
  audio: 60,
  batch: 240,
  text: 40,
  default: 60,
};

const LABEL = {
  image: '关键帧',
  asset_image: '资产设定图',
  video: '视频',
  audio: '配音',
  batch: '批量出图',
  text: '文本生成',
};

/** 排队中的任务（只放内存：重启后由 recover 统一标失败，不假装还在跑） */
const queue = [];
let running = 0;

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clip(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** 阶段文案：中性、不承诺时长、不暴露上游细节 */
const STAGE_TEXT = {
  queued: '排队中',
  preparing: '正在准备素材',
  compiling: '正在校验提示词与一致性',
  holding: '正在预扣点数',
  calling: 'AI 正在生成，请稍候',
  returned: '已收到结果，正在保存',
  archiving: '正在归档产物',
  checking: '正在做一致性自检',
  settling: '正在结算点数',
  done: '已完成',
};

export class TaskCenter {
  constructor() {
    // 实例级而不是模块级：单测需要多次模拟「进程重启」，模块级标志第二次就不生效了
    this.recovered = false;
  }

  /** 懒初始化：把上次进程留下的 running/pending 收尾，避免前端永远在「生成中」 */
  #recoverOnce() {
    if (this.recovered) return;
    this.recovered = true;
    const stale = db.find(COL, (t) => !FINAL.includes(t.status));
    if (!stale.length) return;
    const ts = nowIso();
    for (const t of stale) {
      db.update(COL, t.id, {
        status: TASK_STATUS.FAILED,
        error_code: 'PROCESS_RESTARTED',
        error_msg: '服务重启或缩容，这次任务已中断，请重新发起',
        finished_at: ts,
        updated_at: ts,
      });
    }
    logger.warn(`[task] 收尾 ${stale.length} 个中断任务（进程重启）`);
  }

  /** 清理过期任务记录 */
  #prune() {
    const cut = Date.now() - KEEP_MS;
    for (const t of db.find(COL, (x) => FINAL.includes(x.status))) {
      const at = Date.parse(t.finished_at || t.updated_at || t.created_at || '');
      if (Number.isFinite(at) && at < cut) db.remove(COL, t.id);
    }
  }

  /**
   * 提交一个任务。
   * @param {object} p
   * @param {string} p.userId 归属人（轮询与取消都校验）
   * @param {string} [p.projectId]
   * @param {string} p.type image|asset_image|video|audio|batch|text
   * @param {string} [p.label] 覆盖默认中文名（如「第 3 镜 · 关键帧」）
   * @param {number} [p.etaSec] 覆盖预估耗时
   * @param {string} [p.idemKey] 幂等键：同键且未失败时直接返回原任务
   * @param {(ctx:{report:(pct:number,stage?:string)=>void, task:object})=>Promise<any>} p.run
   * @returns {{task_id:string,status:string,progress:number,created_at:string,reused:boolean}}
   */
  submit({ userId, projectId = null, type = 'image', label = null, etaSec = null, idemKey = null, run }) {
    this.#recoverOnce();
    if (typeof run !== 'function') fail(ERR.BAD_REQUEST, '任务缺少执行体');

    // 幂等：重复提交（双击 / 网络重试）拿回同一个任务，不重复扣点
    if (idemKey) {
      const hit = db.findOne(COL, (t) => t.idem_key === idemKey && t.status !== TASK_STATUS.FAILED);
      if (hit) {
        return { task_id: hit.id, status: hit.status, progress: hit.progress ?? 0, created_at: hit.created_at, reused: true };
      }
    }

    // 同一个人手上正在跑的任务数做个软上限，防止连点把上游打爆
    const mine = db.find(COL, (t) => t.user_id === userId && !FINAL.includes(t.status)).length;
    if (mine >= 6) fail(ERR.TASK_TOO_MANY, '你手上还有任务在跑，等它们完成再发起新的');

    const ts = nowIso();
    const rec = db.insert(COL, {
      id: newId('task'),
      user_id: userId,
      project_id: projectId,
      type,
      label: label || LABEL[type] || '生成',
      idem_key: idemKey,
      status: TASK_STATUS.PENDING,
      progress: 0,
      stage: 'queued',
      eta_sec: num(etaSec, ETA_SEC[type] ?? ETA_SEC.default),
      result: null,
      error_code: null,
      error_msg: null,
      created_at: ts,
      updated_at: ts,
      started_at: null,
      finished_at: null,
    });

    queue.push({ id: rec.id, run });
    this.#prune();
    this.#pump();
    return { task_id: rec.id, status: rec.status, progress: 0, created_at: rec.created_at, reused: false };
  }

  /** 队列泵：有空位就启动，启动完继续泵（串行补位，避免同时抢跑） */
  #pump() {
    while (running < MAX_RUNNING && queue.length) {
      const job = queue.shift();
      running += 1;
      this.#start(job).finally(() => {
        running = Math.max(0, running - 1);
        this.#pump();
      });
    }
  }

  async #start({ id, run }) {
    const startedAt = Date.now();
    const ts = nowIso();
    const patch = (extra) => {
      const cur = db.findOne(COL, (t) => t.id === id);
      if (!cur) return;
      db.update(COL, id, { ...extra, updated_at: nowIso() });
    };
    patch({ status: TASK_STATUS.RUNNING, stage: 'preparing', started_at: ts });

    /**
     * 进度上报：单调不降、封顶 92（剩下的留给真正完成）。
     * 前端拿到的 progress 一定不会往回跳，否则进度条会一抖一抖。
     */
    const report = (pct, stage) => {
      const cur = db.findOne(COL, (t) => t.id === id);
      if (!cur || FINAL.includes(cur.status)) return;
      const next = clip(Math.round(num(pct, cur.progress)), num(cur.progress, 0), SOFT_CAP);
      const nextStage = stage || cur.stage;
      if (next === cur.progress && nextStage === cur.stage) return;
      db.update(COL, id, { progress: next, stage: nextStage, updated_at: nowIso() });
    };

    try {
      const task = db.findOne(COL, (t) => t.id === id);
      const result = await run({ report, task });
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      patch({
        status: TASK_STATUS.SUCCEEDED,
        progress: 100,
        stage: 'done',
        result: result ?? null,
        elapsed_sec: elapsed,
        finished_at: nowIso(),
      });
      logger.info('[task] 完成', { id, type: task?.type, sec: elapsed });
    } catch (e) {
      const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      patch({
        status: TASK_STATUS.FAILED,
        stage: 'failed',
        error_code: e?.code ?? 'TASK_FAILED',
        error_msg: e?.message ?? '任务失败，请重试',
        elapsed_sec: elapsed,
        finished_at: nowIso(),
      });
      logger.warn('[task] 失败', { id, code: e?.code, msg: e?.message });
    }
  }

  /** 归属校验：不是自己的任务一律按「不存在」处理，不泄露任务是否存在 */
  #owned(taskId, userId) {
    const t = db.findOne(COL, (x) => x.id === taskId);
    if (!t) fail(ERR.TASK_NOT_FOUND, '任务不存在或已过期');
    if (userId && t.user_id && t.user_id !== userId) fail(ERR.TASK_NOT_FOUND, '任务不存在或已过期');
    return t;
  }

  /**
   * 轮询视图。
   * progress 在 running 阶段用「真实上报值」与「按耗时软推进」取较大者：
   * 上报细的地方（编译/归档）更准；上报不到的等待段也不会让进度条卡死不动。
   */
  view(taskId, { userId = null } = {}) {
    this.#recoverOnce();
    const t = this.#owned(taskId, userId);
    const now = Date.now();
    const created = Date.parse(t.created_at || '') || now;
    const started = Date.parse(t.started_at || '') || created;
    const elapsed = Math.max(0, Math.round((now - started) / 1000));

    let progress = num(t.progress, 0);
    if (t.status === TASK_STATUS.SUCCEEDED) progress = 100;
    else if (t.status === TASK_STATUS.RUNNING) {
      const eta = Math.max(5, num(t.eta_sec, ETA_SEC.default));
      // 软推进：0~1 用 1 - e^-1.4x 的曲线，起步快、越接近预估越慢，视觉上不像卡住
      const x = clip(elapsed / eta, 0, 3);
      const soft = Math.round(6 + (SOFT_CAP - 6) * (1 - Math.exp(-1.4 * x)));
      progress = clip(Math.max(progress, soft), 0, SOFT_CAP);
    }

    const done = FINAL.includes(t.status);
    const etaLeft = done ? 0 : clip(num(t.eta_sec, 0) - elapsed, 0, 3600);

    return {
      task_id: t.id,
      type: t.type,
      label: t.label,
      project_id: t.project_id,
      status: t.status,
      done,
      ok: t.status === TASK_STATUS.SUCCEEDED,
      progress,
      stage: t.stage,
      stage_text: this.#stageText(t),
      elapsed_sec: done ? num(t.elapsed_sec, elapsed) : elapsed,
      eta_sec: etaLeft,
      result: done && t.status === TASK_STATUS.SUCCEEDED ? t.result : null,
      error_code: t.error_code ?? null,
      error_message: t.status === TASK_STATUS.FAILED ? (t.error_msg ?? '任务失败，请重试') : null,
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
  }

  #stageText(t) {
    if (t.status === TASK_STATUS.PENDING) return STAGE_TEXT.queued;
    if (t.status === TASK_STATUS.SUCCEEDED) return STAGE_TEXT.done;
    if (t.status === TASK_STATUS.CANCELED) return '已取消';
    if (t.status === TASK_STATUS.FAILED) return t.error_msg || '任务失败';
    return STAGE_TEXT[t.stage] || STAGE_TEXT.calling;
  }

  /** 取消：排队中的可以直接撤；已经在跑的撤不掉（上游已计费），如实告知 */
  cancel(taskId, { userId = null } = {}) {
    const t = this.#owned(taskId, userId);
    if (FINAL.includes(t.status)) return { canceled: false, status: t.status, reason: '任务已结束' };
    if (t.status === TASK_STATUS.RUNNING) {
      return { canceled: false, status: t.status, reason: '已经开始生成，无法中途撤回' };
    }
    const i = queue.findIndex((j) => j.id === taskId);
    if (i >= 0) queue.splice(i, 1);
    db.update(COL, taskId, { status: TASK_STATUS.CANCELED, stage: 'canceled', finished_at: nowIso(), updated_at: nowIso() });
    return { canceled: true, status: TASK_STATUS.CANCELED, reason: '已取消' };
  }

  /** 某人/某项目的任务列表（用于「我的任务」面板与断线重连后续跑） */
  list({ userId = null, projectId = null, activeOnly = false, limit = 20 } = {}) {
    this.#recoverOnce();
    return db
      .find(COL, (t) => (!userId || t.user_id === userId)
        && (!projectId || t.project_id === projectId)
        && (!activeOnly || !FINAL.includes(t.status)))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, clip(num(limit, 20), 1, 50))
      .map((t) => this.view(t.id, { userId }));
  }

  /**
   * 清空排队与并发计数。
   * **仅供测试与本地调试**：线上调用等于丢弃还没开始的任务（记录会留在库里，
   * 下次进程启动时按 PROCESS_RESTARTED 收尾，不会出现永远 pending 的假象）。
   */
  resetQueue() {
    queue.length = 0;
    running = 0;
  }

  /** 运维/自测用：当前队列与并发实况 */
  stats() {
    return {
      running,
      queued: queue.length,
      max_running: MAX_RUNNING,
      total: db.count(COL),
      active: db.find(COL, (t) => !FINAL.includes(t.status)).length,
    };
  }
}

export const taskCenter = new TaskCenter();
export default taskCenter;
