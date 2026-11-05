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
import { editPlan } from '../media/EditPlan.js';
import { MEDIA_ROOT } from '../api/media.js';
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
    const { shots, missing, episode } = this.collectShots(projectId, episodeNo);
    const style = seeds.style(project.spec?.style_code) ?? null;
    const director = seeds.director(project.spec?.director_code ?? style?.director_profile_default) ?? null;

    const built = editPlan.buildEditPlan({
      projectId,
      episodeNo: episode ?? normalizeEpisodeNo(shots[0]?.shot_no) ?? 'E01',
      shots,
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
  async render(projectId, episodeNo = null) {
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
    const built = editPlan.buildCommand(plan, assets);
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
    const result = await editPlan.render(plan, assets);
    const published = this.publish(plan, assets);
    return { ok: true, plan, assets: published, render: result, cmd: built.cmd };
  }
}

export const editService = new EditService();
export default editService;
