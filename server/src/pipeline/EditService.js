/**
 * 成片服务：把「项目 → 分镜 → 已生成片段 → 剪辑单 → 成片 mp4」串起来。
 *
 * 与 ShotService 的分工：
 *   ShotService 负责「按总谱出单镜」；EditService 只负责「把已有的镜头剪成一集」。
 *   所以它不会反写任何分镜字段，缺片段就如实报缺。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../store/db.js';
import seeds from '../seeds/loader.js';
import { newId, nowIso } from '../core/util.js';
import { editPlan } from '../media/EditPlan.js';
import { MEDIA_ROOT } from '../api/media.js';
import shellService from '../shell/ShellService.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import { fail, ERR } from '../core/errors.js';

/** 光影 → 氛围：音效排点靠它决定铺雨声还是风声 */
const ATMOSPHERE_BY_LIGHT = {
  'LIG-RAIN': 'ATM-RAIN',
  'LIG-FOG': 'ATM-FOG',
  'LIG-DUST': 'ATM-DUST',
  'LIG-SMOKE': 'ATM-SMOKE',
  'LIG-NEON': 'ATM-STEAM',
  'LIG-CANDLE': 'ATM-EMBER',
  'LIG-SNOW': 'ATM-SNOW',
  'LIG-MOON': 'ATM-SNOW',
  'LIG-BLOOM': 'ATM-PETAL',
};

export function atmosphereFromLighting(codes = []) {
  for (const c of codes) {
    if (ATMOSPHERE_BY_LIGHT[c]) return ATMOSPHERE_BY_LIGHT[c];
  }
  return null;
}

/** 统一集号：1 / '1' / 'E01' / 'E1' 都归一成 'E01' */
export function normalizeEpisodeNo(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = String(v).match(/(\d+)/);
  if (!m) return null;
  return `E${String(Number(m[1])).padStart(2, '0')}`;
}

export class EditService {
  /** 取某集可剪辑的镜头（已生成优先取视频，其次取图片当静帧） */
  collectShots(projectId, episodeNo = null) {
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) {
      fail(ERR.PROJECT_REQUIRED, '还没有分镜，无法剪辑；请先生成剧本与总谱');
    }
    const ep = normalizeEpisodeNo(episodeNo);
    const all = planRec.storyboard.shots;
    const shots = ep ? all.filter((s) => normalizeEpisodeNo(s.episode) === ep) : all;
    if (!shots.length) fail(ERR.NOT_FOUND, `第 ${episodeNo} 集没有分镜`);

    const gens = db.find('generations', (g) => g.project_id === projectId && g.status === 'done');
    const byShot = new Map();
    for (const g of gens) {
      const url = g.result_url || g.url;
      if (!url) continue;
      const key = g.shot_no;
      const cur = byShot.get(key);
      // 视频优先；同类取最新
      const better = !cur || (g.kind === 'video' && cur.kind !== 'video') ||
        (g.kind === cur.kind && String(g.created_at) > String(cur.created_at));
      if (better) byShot.set(key, g);
    }

    const missing = [];
    const rows = shots.map((s) => {
      const g = byShot.get(s.no);
      if (!g) missing.push(s.no);
      const emotionCodes = Object.values(s.emotions ?? {}).filter(Boolean);
      return {
        shot_no: s.no,
        clip_url: g ? (g.result_url || g.url) : null,
        still: g ? g.kind !== 'video' : false,
        duration: Number(s.duration ?? 4),
        transition: s.transition ?? 'TRN-HARDCUT',
        transition_reason: s.transition_reason ?? null,
        dialogue: s.dialogue ? [{ speaker: s.speaker ?? null, line: s.dialogue }] : [],
        emotions: emotionCodes,
        atmosphere: atmosphereFromLighting(s.lighting_codes ?? []),
        is_episode_end: !!s.is_episode_end,
        mood_tags: s.bgm_mood ?? [],
      };
    });

    return { shots: rows, missing, plan: planRec, episode: ep };
  }

  /** 剪辑单（只算不落盘，秒回，给前端预览） */
  plan(projectId, episodeNo = null) {
    const project = db.findOne('projects', (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    // 还没有分镜属于「流程未走到这一步」，不是错误请求：
    // 抛 428 会让前端只能弹一个红框，用户看不到「下一步该点哪」。
    // 所以这里返回结构化的空剪辑单，把引导交给 UI。
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) {
      return {
        ok: false,
        station: 'need_storyboard',
        blocking: 1,
        advisories: 0,
        errors: [{
          code: 'NO_STORYBOARD',
          severity: 'fatal',
          issue: '还没有分镜，无法剪辑',
          message: '还没有分镜，无法剪辑；请先回到「剧本」生成分镜',
        }],
        warnings: [],
        next_action: { label: '去生成剧本与分镜', tab: 'script' },
        missing_shots: [],
        coverage: 0,
        segments: [],
        timeline: { clips: 0, total_sec: 0, items: [] },
        subtitles: { total: 0, cues: [] },
        sound: { cues: [], bgm: null },
        deliverables: [],
      };
    }
    const { shots, missing, episode } = this.collectShots(projectId, episodeNo);
    const style = seeds.style(project.spec?.style_code) ?? null;
    const director = seeds.director(project.spec?.director_code ?? style?.director_profile_default) ?? null;

    // 剧壳：片头/片尾作为独立片段接在正片前后（只在文件真实存在时接入）
    const shellSegs = shellService.segments(projectId);
    const withShell = [
      ...(shellSegs.intro ? [shellSegs.intro] : []),
      ...shots,
      ...(shellSegs.outro ? [shellSegs.outro] : []),
    ];

    const built = editPlan.buildEditPlan({
      projectId,
      episodeNo: episode ?? normalizeEpisodeNo(shots[0]?.shot_no) ?? 'E01',
      shots: withShell,
      style,
      director,
      aspect: project.spec?.aspect ?? '9:16',
      quality: project.spec?.quality ?? '1080p',
      bgmUrl: project.spec?.bgm_url ?? null,
    });

    return {
      ...built,
      missing_shots: missing,
      coverage: shots.length ? +((shots.length - missing.length) / shots.length).toFixed(3) : 0,
      shell: {
        enabled: shellService.get(projectId).enabled,
        intro: Boolean(shellSegs.intro),
        outro: Boolean(shellSegs.outro),
      },
    };
  }

  /** 把成片与交付物复制到 /media（<24hex>.<ext>），返回可直接播放/下载的 URL */
  publish(plan, assets) {
    const put = (src, ext) => {
      if (!src || !fs.existsSync(src)) return null;
      const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
      const dest = path.join(MEDIA_ROOT, name);
      fs.copyFileSync(src, dest);
      return { url: `/media/${name}`, bytes: fs.statSync(dest).size };
    };
    const ep = plan.episode;
    return {
      video: put(assets.outputPath, 'mp4'),
      srt: put(assets.srtPath, 'srt'),
      ass: put(assets.assPath, 'ass'),
      sheet: put(assets.sheetPath, 'md'),
      script: put(assets.scriptPath, 'txt'),
      manifest: put(assets.manifestPath, 'csv'),
      bgm: assets.bgmUrl ?? null,
      episode: ep,
    };
  }

  /** 真剪：落盘 → 渲染 → 发布；没有 ffmpeg 时返回命令而不是假成功 */
  async render(projectId, episodeNo = null, { preset = null } = {}) {
    const project = db.findOne('projects', (x) => x.id === projectId);
    // 未显式指定时，按项目里选的剪辑档位（ED-STD/ED-FAST/ED-HQ/ED-EDL）
    const profile = preset ?? modelCatalog.editPreset(project?.spec?.edit_profile ?? 'ED-STD');
    const plan = this.plan(projectId, episodeNo);
    if (!plan.ok) {
      return {
        ok: false,
        code: 'EDIT_PLAN_BLOCKED',
        plan,
        errors: plan.errors.filter((e) => e.severity !== 'advisory'),
        hint: plan.missing_shots?.length ? `还有 ${plan.missing_shots.length} 个镜头没出片` : '剪辑单存在阻断问题',
      };
    }
    const assets = editPlan.materialize(plan);
    if (profile === null) {
      return {
        ok: false,
        code: 'EDL_ONLY',
        plan,
        files: assets.files,
        hint: '当前剪辑档位是「仅导出剪辑单」：字幕与剪辑单已生成，可在本地自己合成',
      };
    }
    const built = editPlan.buildCommand(plan, assets, { preset: profile });
    if (!editPlan.hasFfmpeg()) {
      return {
        ok: false,
        code: 'FFMPEG_MISSING',
        cmd: built.cmd,
        plan,
        files: assets.files,
        hint: '本机未安装 ffmpeg：命令与字幕/配乐/剪辑单已生成，可在装有 ffmpeg 的机器（或云托管镜像）执行',
      };
    }
    const result = await editPlan.render(plan, assets, { preset: profile });
    const published = this.publish(plan, assets);
    // 成片登记：分发资料包、我的资产、续集复用都要能按集找到这条记录
    const film = db.insert('episode_films', {
      id: newId('film'),
      project_id: projectId,
      user_id: db.findOne('projects', (x) => x.id === projectId)?.user_id ?? null,
      episode: plan.episode ?? normalizeEpisodeNo(episodeNo) ?? 'E01',
      url: published.video?.url ?? null,
      srt_url: published.srt?.url ?? null,
      ass_url: published.ass?.url ?? null,
      sheet_url: published.sheet?.url ?? null,
      bytes: published.video?.bytes ?? result.bytes ?? null,
      duration_sec: Number(plan.timeline?.total_sec ?? 0),
      resolution: plan.video?.resolution ?? null,
      preset: profile,
      shell: plan.shell ?? null,
      duration_ms: result.duration_ms ?? null,
      created_at: nowIso(),
    });
    return { ok: true, plan, assets: published, render: result, cmd: built.cmd, film };
  }

  /** 某项目已渲染成片（新→旧） */
  films(projectId, { episode = null } = {}) {
    const ep = normalizeEpisodeNo(episode);
    return db.find('episode_films', (f) => f.project_id === projectId && (!ep || f.episode === ep))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /** 最新一集成片（分发资料包默认取这条） */
  latestFilm(projectId, episode = null) {
    return this.films(projectId, { episode })[0] ?? null;
  }
}

export const editService = new EditService();
export default editService;
