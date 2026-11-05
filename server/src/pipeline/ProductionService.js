/**
 * 剧集生产托管（V4.3）。
 *
 * 解决什么：系列剧动辄十几二十集，让用户每集都点一遍「出图 → 出视频 → 剪辑」不现实。
 * 这里把「一集」当成最小生产单元：
 *   single 模式：只做指定那一集（用户想先看第 3 集，就只花第 3 集的钱）
 *   auto   模式：从当前集往后逐集自动做，做完一集落一集成片，再进下一集
 *
 * 托管方式：服务端 in-process 调度器（默认 4s 一轮）推进，前端只轮询进度；
 * 断点续跑、余额不足暂停、缺 ffmpeg 停下并给出可执行命令，都不假装成功。
 */
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { logger } from '../core/redact.js';
import { fail, ERR } from '../core/errors.js';
import { ensureProjectPlan } from './PlanBuilder.js';
import { normalizeEpisodeNo } from './EditService.js';
import shotService from './ShotService.js';
import editService from './EditService.js';
import ledger from '../ledger/Ledger.js';

const COL = 'production_jobs';
const PROJECTS = 'projects';
const OPS_PER_STEP = 2;

export class ProductionService {
  /** 建任务（幂等：同项目同模式未完成的任务直接复用，避免重复扣费） */
  create({ projectId, userId = null, mode = 'single', episodes = null, preset = null }) {
    const project = db.findOne(PROJECTS, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    if (project.user_id && userId && project.user_id !== userId) {
      fail(ERR.OBJECT_FORBIDDEN, '无权操作他人项目');
    }
    const running = db.findOne(COL, (j) => j.project_id === projectId && (j.status === 'running' || j.status === 'paused'));
    if (running) return running;

    const list = this.#episodeList(project, episodes, mode);
    if (!list.length) fail(ERR.BAD_REQUEST, '没有可生产的集数');

    const rec = {
      id: newId('job'),
      project_id: projectId,
      user_id: project.user_id ?? userId ?? null,
      mode,
      preset,
      episodes: list,
      cursor: 0,
      status: 'running',
      paused_reason: null,
      episode_states: list.map((no) => ({
        no, status: 'pending', shots_total: 0, shots_done: 0, film_id: null, film_url: null, error: null,
      })),
      progress: { episodes_done: 0, episodes_total: list.length, shots_done: 0, shots_total: 0, percent: 0 },
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return db.insert(COL, rec);
  }

  get(id) {
    const j = db.findOne(COL, (x) => x.id === id);
    if (!j) fail(ERR.NOT_FOUND, '生产任务不存在');
    return j;
  }

  list(projectId) {
    return db.find(COL, (j) => j.project_id === projectId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  pause(id) {
    const j = this.get(id);
    if (j.status === 'done') return j;
    return this.#patch(j, { status: 'paused', paused_reason: '用户暂停' });
  }

  resume(id) {
    const j = this.get(id);
    if (j.status === 'done') return j;
    return this.#patch(j, { status: 'running', paused_reason: null });
  }

  /**
   * 推进一步：每次最多出 2 个产物（图/视频），或做一次剪辑。
   * @returns 更新后的 job
   */
  async step(jobId) {
    const job = this.get(jobId);
    if (job.status !== 'running') return job;
    const project = db.findOne(PROJECTS, (x) => x.id === job.project_id);
    if (!project) return this.#patch(job, { status: 'failed', paused_reason: '项目已被删除' });

    const idx = job.cursor;
    const episodeNo = job.episodes[idx];
    if (!episodeNo) return this.#finish(job);

    try {
      // 1) 计划：没有分镜时先生成（所有集共用一份分镜）
      let planRec = db.findOne('director_plans', (x) => x.project_id === project.id);
      if (!planRec?.storyboard?.shots?.length) {
        const built = await ensureProjectPlan(project);
        planRec = db.findOne('director_plans', (x) => x.project_id === project.id);
        logger.info('剧集托管：计划已生成', {
          projectId: project.id, episodes: built?.script?.episodes?.length ?? 0,
        });
      }
      const shots = planRec.storyboard.shots.filter((s) => normalizeEpisodeNo(s.episode ?? s.no) === episodeNo);
      if (!shots.length) {
        return this.#advance(job, idx, { status: 'skipped', error: '该集没有分镜' });
      }

      // 2) 出片：本集缺多少补多少，每步最多 2 个产物
      const videoType = project.spec?.video_type ?? project.spec?.videoType ?? 'dynamic';
      const needVideo = videoType !== 'static';
      const gens = db.find('generations', (g) => g.project_id === project.id && g.status === 'done');
      const byShot = new Map();
      for (const g of gens) {
        const url = g.result_url || g.url;
        if (!url) continue;
        const cur = byShot.get(g.shot_no) ?? { image: false, video: false };
        if (g.kind === 'video') cur.video = true;
        if (g.kind === 'image') cur.image = true;
        byShot.set(g.shot_no, cur);
      }

      const total = shots.length * (needVideo ? 2 : 1);
      const doneOf = (no) => {
        const st = byShot.get(no) ?? { image: false, video: false };
        return (st.image ? 1 : 0) + (needVideo && st.video ? 1 : 0);
      };
      let done = shots.reduce((a, s) => a + doneOf(s.no), 0);

      if (done < total) {
        const balance = ledger.balance(project.user_id);
        if (balance <= 0) {
          return this.#patch(job, { status: 'paused', paused_reason: 'INSUFFICIENT_CREDITS' });
        }
        let ops = 0;
        for (const s of shots) {
          if (ops >= OPS_PER_STEP) break;
          const st = byShot.get(s.no) ?? { image: false, video: false };
          if (!st.image) {
            await shotService.generate({ projectId: project.id, shotNo: s.no, kind: 'image', userId: project.user_id });
            ops += 1;
            st.image = true;
            byShot.set(s.no, st);
            done += 1;
            continue;
          }
          if (needVideo && !st.video) {
            await shotService.generate({ projectId: project.id, shotNo: s.no, kind: 'video', userId: project.user_id });
            ops += 1;
            st.video = true;
            byShot.set(s.no, st);
            done += 1;
          }
        }
        const states = job.episode_states.map((s) =>
          s.no === episodeNo ? { ...s, status: 'running', shots_total: total, shots_done: done } : s
        );
        return this.#patch(job, { episode_states: states, progress: this.#progress({ ...job, episode_states: states }) });
      }

      // 3) 剪辑本集
      const render = await editService.render(project.id, episodeNo, { preset: job.preset });
      if (!render.ok) {
        if (render.code === 'FFMPEG_MISSING' || render.code === 'EDIT_PLAN_BLOCKED') {
          const states = job.episode_states.map((s) =>
            s.no === episodeNo ? { ...s, status: 'blocked', shots_total: total, shots_done: done, error: render.code } : s
          );
          return this.#patch(job, {
            episode_states: states,
            status: 'paused',
            paused_reason: render.code,
            paused_cmd: render.cmd ?? null,
          });
        }
        throw new Error(render.hint || render.code || '剪辑失败');
      }

      const states = job.episode_states.map((s) =>
        s.no === episodeNo
          ? {
            ...s, status: 'done', shots_total: total, shots_done: total,
            film_id: render.film?.id ?? null, film_url: render.film?.url ?? null,
            duration_sec: render.film?.duration_sec ?? null, error: null,
          }
          : s
      );
      const nextCursor = idx + 1;
      const finished = nextCursor >= job.episodes.length;
      const nextJob = { ...job, episode_states: states, cursor: nextCursor };
      return this.#patch(nextJob, {
        episode_states: states,
        cursor: nextCursor,
        status: finished ? 'done' : 'running',
        ...(finished ? { paused_reason: null } : {}),
        progress: this.#progress(nextJob),
      });
    } catch (e) {
      const paused = e.code === ERR.INSUFFICIENT_CREDITS || e.code === 'INSUFFICIENT_CREDITS';
      const states = job.episode_states.map((s) =>
        s.no === episodeNo
          ? { ...s, status: paused ? 'paused' : 'failed', error: { code: e.code ?? 'ERROR', message: e.message } }
          : s
      );
      logger.error('剧集生产失败', { jobId, episode: episodeNo, code: e.code, msg: e.message });
      return this.#patch(job, {
        episode_states: states,
        status: paused ? 'paused' : 'failed',
        paused_reason: paused ? 'INSUFFICIENT_CREDITS' : e.message,
      });
    }
  }

  /** 后台调度：推进所有 running 任务（每轮每任务一步） */
  async tickRunning({ limit = 3 } = {}) {
    const running = db.find(COL, (j) => j.status === 'running').slice(0, limit);
    for (const j of running) {
      try {
        await this.step(j.id);
      } catch (e) {
        logger.error('托管调度失败', { jobId: j.id, msg: e.message });
      }
    }
    return running.length;
  }

  /** 用户「我的资产」：所有成片按项目/集聚合 */
  myFilms(userId, { limit = 100 } = {}) {
    const films = db.find('episode_films', (f) => f.user_id === userId)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
    const projects = new Map(db.find(PROJECTS, (p) => p.user_id === userId).map((p) => [p.id, p]));
    return films.map((f) => {
      const p = projects.get(f.project_id) ?? {};
      return {
        ...f,
        project_title: p.title ?? '未命名',
        index_label: p.index_label ?? null,
        series_title: p.series_title ?? null,
      };
    });
  }

  // —— 内部 ——

  #episodeList(project, episodes, mode) {
    const planRec = db.findOne('director_plans', (x) => x.project_id === project.id);
    const eps = (planRec?.script?.episodes ?? []).map((e) => normalizeEpisodeNo(e.no));
    let all = eps.length ? eps : this.#guessEpisodes(project);
    all = [...new Set(all)];
    if (mode === 'single') {
      const want = normalizeEpisodeNo(Array.isArray(episodes) ? episodes[0] : episodes) ?? all[0];
      return all.includes(want) ? [want] : [all[0]];
    }
    // auto：从指定集往后全部（不给就从头）
    const from = normalizeEpisodeNo(Array.isArray(episodes) ? episodes[0] : episodes);
    if (from && all.includes(from)) all = all.slice(all.indexOf(from));
    return all;
  }

  #guessEpisodes(project) {
    const spec = project.spec ?? {};
    const n = Math.max(1, Math.ceil(((Number(spec.total_minutes) || 10) * 60) / (Number(spec.episode_sec) || 90)));
    return Array.from({ length: n }, (_, i) => `E${String(i + 1).padStart(2, '0')}`);
  }

  #progress(job) {
    const states = job.episode_states ?? [];
    const episodesDone = states.filter((s) => s.status === 'done').length;
    const shotsDone = states.reduce((a, s) => a + (s.shots_done || 0), 0);
    const shotsTotal = states.reduce((a, s) => a + (s.shots_total || 0), 0);
    const total = states.length || 1;
    return {
      episodes_done: episodesDone,
      episodes_total: states.length,
      shots_done: shotsDone,
      shots_total: shotsTotal,
      current_episode: job.episodes?.[job.cursor] ?? null,
      percent: Math.min(100, Math.round(((episodesDone + (shotsTotal ? (shotsDone / shotsTotal) * 0.9 : 0)) / total) * 100)),
    };
  }

  #advance(job, idx, patch) {
    const states = job.episode_states.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    const nextCursor = idx + 1;
    const finished = nextCursor >= job.episodes.length;
    return this.#patch(
      { ...job, episode_states: states, cursor: nextCursor },
      {
        episode_states: states,
        cursor: nextCursor,
        status: finished ? 'done' : 'running',
        progress: this.#progress({ ...job, episode_states: states, cursor: nextCursor }),
      }
    );
  }

  #finish(job) {
    return this.#patch(job, { status: 'done', progress: this.#progress(job) });
  }

  #patch(job, patch) {
    const next = { ...job, ...patch, updated_at: nowIso() };
    const exists = db.findOne(COL, (x) => x.id === next.id);
    if (exists) {
      const copy = { ...next };
      delete copy.id;
      db.update(COL, next.id, copy);
    } else {
      db.insert(COL, next);
    }
    return next;
  }
}

export const productionService = new ProductionService();
export default productionService;
