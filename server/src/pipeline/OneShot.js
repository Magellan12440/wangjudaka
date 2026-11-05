/**
 * 一句话成剧编排（V4.2）：从「一句话」跑到「一集成片」。
 *
 * 为什么不是一次性长任务：生成一次要几十秒到几分钟，HTTP 请求扛不住。
 * 所以拆成「单步推进」——前端反复调 step，每步只做一小段（≤2 镜），
 * 既能看到进度，断网/失败也能从断点继续，不会白花钱重跑。
 *
 * 步骤：
 *   plan  ：大纲 → 总谱 → 剧本 → 分镜 → 角色资产落库
 *   shots ：逐镜出关键帧；非静态漫剧再基于关键帧出视频
 *   edit  ：剪辑单 → 字幕/配乐/音效 → 成片 mp4（无 ffmpeg 则停在「命令已生成」）
 */
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import { fail, ERR } from '../core/errors.js';
import { storyEngine } from './StoryEngine.js';
import { shotService } from './ShotService.js';
import { editService } from './EditService.js';
import { assetLibrary } from '../assets/AssetLibrary.js';
import { materialService } from '../assets/MaterialService.js';
import { ensureProjectPlan } from './PlanBuilder.js';
import { contentSecurity } from '../security/ContentSecurity.js';
import ledger from '../ledger/Ledger.js';

const COL = 'oneshot_runs';
const STEP_ORDER = ['plan', 'shots', 'edit'];

export class OneShot {
  /** 建一个 run（不执行）；重复调用会复用未完成的 run，避免重复扣费 */
  create({ projectId, userId = null }) {
    const project = db.findOne('projects', (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    if (project.user_id && userId && project.user_id !== userId) {
      fail(ERR.OBJECT_FORBIDDEN, '无权操作他人项目');
    }
    const existing = db.findOne(COL, (r) => r.project_id === projectId && r.status !== 'done');
    if (existing) return existing;

    const rec = {
      id: newId('osr'),
      project_id: projectId,
      user_id: project.user_id ?? userId ?? null,
      status: 'running',
      cursor: 0,
      step: STEP_ORDER[0],
      steps: STEP_ORDER.map((key) => ({ key, status: key === STEP_ORDER[0] ? 'running' : 'pending', summary: null, error: null })),
      progress: { shots_total: 0, shots_done: 0, percent: 0 },
      output: null,
      paused_reason: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return db.insert(COL, rec);
  }

  get(runId) {
    const run = db.findOne(COL, (x) => x.id === runId);
    if (!run) fail(ERR.NOT_FOUND, '编排任务不存在');
    return run;
  }

  /** 执行一步。返回更新后的 run（已含最新进度） */
  async step(runId) {
    const run = this.get(runId);
    if (run.status === 'done') return run;
    const project = db.findOne('projects', (x) => x.id === run.project_id);
    if (!project) fail(ERR.NOT_FOUND, '项目已被删除');

    const idx = STEP_ORDER.indexOf(run.step);
    const key = STEP_ORDER[idx] ?? null;
    if (!key) return this.#finish(run, 'done');

    try {
      let summary = null;
      if (key === 'plan') summary = await this.#runPlan(project, run);
      else if (key === 'shots') summary = await this.#runShots(project, run);
      else if (key === 'edit') summary = await this.#runEdit(project, run);

      // shots 是循环步：没跑完就停在本步
      if (key === 'shots' && summary && !summary.all_done) {
        return this.#patch(run, { step_summary: summary });
      }
      const steps = run.steps.map((s) => (s.key === key ? { ...s, status: 'done', summary } : s));
      const next = STEP_ORDER[idx + 1] ?? null;
      if (!next) return this.#finish({ ...run, steps }, 'done', summary);
      return this.#patch(run, {
        steps: steps.map((s) => (s.key === next ? { ...s, status: 'running' } : s)),
        step: next,
        cursor: idx + 1,
        step_summary: summary,
      });
    } catch (e) {
      const paused = e.code === ERR.INSUFFICIENT_CREDITS || e.code === 'INSUFFICIENT_CREDITS';
      const steps = run.steps.map((s) =>
        s.key === key ? { ...s, status: paused ? 'paused' : 'failed', error: { code: e.code ?? 'ERROR', message: e.message } } : s
      );
      logger.error('一句话成剧步骤失败', { runId, step: key, code: e.code, msg: e.message });
      return this.#patch(
        { ...run, steps },
        {
          status: paused ? 'paused' : 'failed',
          paused_reason: paused ? '算力不足，充值后可继续' : e.message,
        }
      );
    }
  }

  /** 一直推进到完成 / 暂停 / 失败（内部循环，供脚本与测试调用；HTTP 层建议逐 step 调） */
  async runToEnd(runId, { maxSteps = 60 } = {}) {
    let last = this.get(runId);
    for (let i = 0; i < maxSteps; i++) {
      if (last.status === 'done' || last.status === 'failed' || last.status === 'paused') return last;
      last = await this.step(runId);
    }
    return last;
  }

  // —— 步骤实现 ——

  async #runPlan(project, run) {
    // 与「剧集托管」共用同一份计划构建，避免两条链路的集数/镜数不一致
    const built = await ensureProjectPlan(project);
    const shotsTotal = built.storyboard?.shots?.length ?? 0;
    const assetCount = db.find('assets', (a) => a.project_id === project.id).length;
    return {
      episodes: built.script?.episodes?.length ?? 0,
      shots: shotsTotal,
      assets: assetCount,
      materials_used: (built.materials_used ?? []).length,
      shots_total: shotsTotal,
      reused: !!built.reused,
    };
  }

  async #runShots(project, run) {
    const planRec = db.findOne('director_plans', (x) => x.project_id === project.id);
    if (!planRec?.storyboard?.shots?.length) {
      fail(ERR.PROJECT_REQUIRED, '还没有分镜，无法出片');
    }
    const shots = planRec.storyboard.shots;
    const videoType = project.spec?.videoType ?? project.spec?.video_type ?? 'dynamic';
    const needVideo = videoType !== 'static';
    const gens = db.find('generations', (g) => g.project_id === project.id && g.status === 'done');

    const byShot = new Map();
    for (const g of gens) {
      const key = g.shot_no;
      const cur = byShot.get(key) ?? { image: false, video: false };
      if (g.kind === 'video' && (g.result_url || g.url)) cur.video = true;
      if (g.kind === 'image' && (g.result_url || g.url)) cur.image = true;
      byShot.set(key, cur);
    }

    let done = 0;
    for (const s of shots) {
      const st = byShot.get(s.no) ?? { image: false, video: false };
      if (st.image && (!needVideo || st.video)) done += 1;
    }

    // 余额闸门：先看钱，再动手（GenerateService 也会拦，但提前拦能给更清楚的文案）
    const balance = ledger.balance(project.user_id);
    if (balance <= 0) fail(ERR.INSUFFICIENT_CREDITS, '算力余额不足，请先充值');

    const OPS_PER_STEP = 2;
    let ops = 0;
    const justDone = [];
    for (const s of shots) {
      if (ops >= OPS_PER_STEP) break;
      const st = byShot.get(s.no) ?? { image: false, video: false };
      if (!st.image) {
        await shotService.generate({ projectId: project.id, shotNo: s.no, kind: 'image', userId: project.user_id });
        ops += 1;
        justDone.push(`${s.no}:image`);
        continue;
      }
      if (needVideo && !st.video) {
        await shotService.generate({ projectId: project.id, shotNo: s.no, kind: 'video', userId: project.user_id });
        ops += 1;
        justDone.push(`${s.no}:video`);
        continue;
      }
    }

    const total = shots.length * (needVideo ? 2 : 1);
    const already = shots.reduce((a, s) => {
      const st = byShot.get(s.no) ?? { image: false, video: false };
      return a + (st.image ? 1 : 0) + (needVideo && st.video ? 1 : 0);
    }, 0);
    const finished = already + justDone.length;
    return {
      shots_total: total,
      shots_done: finished,
      all_done: finished >= total,
      just_done: justDone,
      percent: total ? Math.min(100, Math.round((finished / total) * 100)) : 0,
    };
  }

  async #runEdit(project, run) {
    const result = await editService.render(project.id, null);
    if (!result.ok) {
      // 不是异常，而是「本机没 ffmpeg」——把命令留在 run 里，用户可复制去渲染
      return {
        rendered: false,
        code: result.code,
        cmd: result.cmd ?? null,
        hint: result.hint ?? null,
        errors: result.errors ?? null,
      };
    }
    return {
      rendered: true,
      video_url: result.assets?.video?.url ?? null,
      srt_url: result.assets?.srt?.url ?? null,
      sheet_url: result.assets?.sheet?.url ?? null,
      bytes: result.render?.bytes ?? null,
      duration_ms: result.render?.duration_ms ?? null,
    };
  }

  // —— 内部 ——

  #patch(run, patch) {
    const next = { ...run, ...patch, updated_at: nowIso() };
    const progress = patch.step_summary?.shots_total
      ? {
        shots_total: patch.step_summary.shots_total,
        shots_done: patch.step_summary.shots_done ?? 0,
        percent: patch.step_summary.percent ?? 0,
      }
      : run.progress;
    next.progress = progress;
    delete next.step_summary;
    // db 是整条替换，先删再插保持 id 不变
    const exists = db.findOne(COL, (x) => x.id === next.id);
    if (exists) {
      const copy = { ...next };
      delete copy.id;
      db.update(COL, next.id, copy);
    } else {
      db.insert(COL, next);
    }
    return { ...next, step_summary: patch.step_summary ?? null };
  }

  #finish(run, status, summary = null) {
    return this.#patch(run, {
      status,
      step: 'done',
      cursor: STEP_ORDER.length,
      progress: { ...(run.progress ?? {}), percent: 100 },
      output: summary,
    });
  }
}

export const oneShot = new OneShot();
export default oneShot;
