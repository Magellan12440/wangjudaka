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
import directorAgent from '../director/DirectorAgent.js';
import { assembly } from './Assembly.js';
import * as specLib from '../prompts/SpecLibrary.js';

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

export 
/** 剪辑配方 → 字幕同步规则的默认搭配（用户没单独指定时用） */
const SYNC_BY_RECIPE = {
  'EDR-SHORTDRAMA': 'SYN-SHORT',
  'EDR-ACTION': 'SYN-SHORT',
  'EDR-TRAILER': 'SYN-SHORT',
  'EDR-EMOTIONAL': 'SYN-NARR',
  'EDR-DOCU': 'SYN-NARR',
  'EDR-COMEDY': 'SYN-KEYWORD',
  'EDR-SUSPENSE': 'SYN-STD',
  'EDR-SERIES': 'SYN-STD',
};

/** 按项目设定挑剪辑配方：优先用户手选（项目设定 → 导演面板）→ 风格默认 → 兜底短剧强钩 */
function pickEditRecipe(project, pinned = null) {
  const explicit = project.spec?.edit_recipe ?? pinned;
  if (explicit && seeds.editRecipe(explicit)) return seeds.editRecipe(explicit);
  const byStyle = project.spec?.style_code ? seeds.style(project.spec.style_code)?.edit_recipe : null;
  if (byStyle && seeds.editRecipe(byStyle)) return seeds.editRecipe(byStyle);
  return seeds.editRecipe('EDR-SHORTDRAMA') ?? seeds.editRecipes?.[0] ?? null;
}

class EditService {
  /** 取某集可剪辑的镜头（已生成优先取视频，其次取图片当静帧） */
  /**
   * 取一集的镜头（V4.13 重写）。
   *
   * 旧实现有两个隐患，正好对应"成片会漏/会重"：
   *  1. 直接按分镜数组顺序拼，数组一旦重排，成片顺序就乱；
   *  2. 同一镜重出多次时取"最新那条"，把用户已选定的版本无视掉。
   * 现在全部交给 Assembly：按索引排序、只认当前版本、缺镜/重号如实报。
   */
  collectShots(projectId, episodeNo = null) {
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) {
      fail(ERR.PROJECT_REQUIRED, '还没有分镜，无法剪辑；请先生成剧本与总谱');
    }
    const epNo = episodeNo ? Number(String(episodeNo).replace(/^E0*/i, '')) || null : null;
    const audit = assembly.auditAssembly({ projectId, episode: epNo, planRec });
    const ep = epNo;
    if (!audit.clips.length) fail(ERR.NOT_FOUND, `第 ${episodeNo} 集没有分镜`);

    // 按审计里的顺序取原始分镜对象（保留情绪/光影等笔需要但剪辑不需要的字段做追溯）
    const orderedShots = assembly.sortShots(
      (planRec.storyboard.shots ?? []).filter((s) => !ep || assembly.episodeOf(s) === ep),
    );
    const shootByNo = new Map(orderedShots.map((s) => [s.no, s]));

    const rows = audit.clips.map((c) => {
      const s = shootByNo.get(c.shot_no) ?? {};
      const emotionCodes = Object.values(s.emotions ?? {}).filter(Boolean);
      return {
        shot_no: c.shot_no,
        // ↓ V4.13：索引与版本一起进剪辑单，成片每一段都能追回"第几镜、哪一版"
        order: c.order,
        film_index: c.index + 1,
        beat_no: c.beat_no,
        generation_id: c.clip?.generation_id ?? null,
        generation_kind: c.clip?.kind ?? null,
        script_ref: c.script_ref,
        clip_url: c.clip?.url ?? null,
        still_url: c.still_url,
        still: c.clip ? c.clip.kind !== 'video' : false,
        duration: Number(s.duration ?? c.duration ?? 4),
        transition: s.transition ?? c.transition ?? 'TRN-HARDCUT',
        transition_reason: s.transition_reason ?? null,
        dialogue: s.dialogue ? [{ speaker: s.speaker ?? null, line: s.dialogue }] : [],
        emotions: emotionCodes,
        atmosphere: atmosphereFromLighting(s.lighting_codes ?? []),
        is_episode_end: !!s.is_episode_end,
        mood_tags: s.bgm_mood ?? [],
      };
    });

    return {
      shots: rows,
      missing: audit.missing.map((m) => m.shot_no),
      plan: planRec,
      episode: ep ?? audit.episode,
      assembly: audit,
    };
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
    const { shots, missing, episode, assembly: asm } = this.collectShots(projectId, episodeNo);
    const style = seeds.style(project.spec?.style_code) ?? null;
    const director = seeds.director(project.spec?.director_code ?? style?.director_profile_default) ?? null;

    // 剧壳：片头/片尾作为独立片段接在正片前后（只在文件真实存在时接入）
    const shellSegs = shellService.segments(projectId);
    const withShell = [
      ...(shellSegs.intro ? [shellSegs.intro] : []),
      ...shots,
      ...(shellSegs.outro ? [shellSegs.outro] : []),
    ];

    // V4.11：虚拟导演面板 pin 的剪辑配方 / 字幕规则也在这里生效
    const pinnedLibs = directorAgent.libraryOverrides(projectId);
    const recipe = pickEditRecipe(project, pinnedLibs.edit ?? null);
    const syncRule = seeds.subtitleSyncRule(
      project.spec?.subtitle_sync ?? pinnedLibs.sync ?? SYNC_BY_RECIPE[recipe?.code] ?? 'SYN-STD'
    ) ?? seeds.subtitleSync?.[0] ?? null;

    const built = editPlan.buildEditPlan({
      projectId,
      episodeNo: episode ? `E${String(episode).padStart(2, '0')}` : (normalizeEpisodeNo(shots[0]?.shot_no) ?? 'E01'),
      shots: withShell,
      style,
      director,
      aspect: project.spec?.aspect ?? '9:16',
      quality: project.spec?.quality ?? '1080p',
      bgmUrl: project.spec?.bgm_url ?? null,
      // V4.4：剪辑成片与字幕同步都必须落到具体库条目上，不靠模型自由发挥
      editRecipe: recipe,
      subtitleRule: syncRule,
    });

    return {
      ...built,
      missing_shots: missing,
      coverage: shots.length ? +((shots.length - missing.length) / shots.length).toFixed(3) : 0,
      // V4.13：装配体检（漏镜/重号/用了废弃版本）随剪辑单一起返回，前端能直接指到哪一镜
      assembly_audit: asm,
      recipe: recipe ? { code: recipe.code, name: recipe.name, rhythm: recipe.cut_rhythm, avg_cut_sec: recipe.avg_cut_sec } : null,
      sync: syncRule ? { code: syncRule.code, name: syncRule.name, max_chars: syncRule.max_chars_per_line } : null,
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

    // —— 两道硬闸（V4.13）——
    // 1) 装配：漏镜 / 重复镜号 / 选中已弃用版本 → 不许渲染（少一段是事故，不是建议）
    // 2) 规格：成片分辨率必须等于用户点的画幅×画质（剪辑层最容易把 2K 悄悄降成 1080P）
    const epForGate = episodeNo ? Number(String(episodeNo).replace(/^E0*/i, '')) || null : null;
    if (epForGate) assembly.assertAssembly({ projectId, episode: epForGate });

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
    if (project?.spec) {
      const userSpec = specLib.normalize({ ...project.spec }, { strict: true });
      if (plan.video?.resolution && plan.video.resolution !== userSpec.resolution) {
        fail(
          ERR.SPEC_VIOLATION,
          `成片分辨率 ${plan.video.resolution} 与用户选择 ${userSpec.resolution}（${userSpec.aspect} / ${userSpec.quality}）不一致，已拒绝渲染`,
          { want: userSpec.resolution, got: plan.video.resolution, aspect: userSpec.aspect, quality: userSpec.quality },
        );
      }
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
      // V4.13：成片登记里留一份装配索引，日后回查"这一版用的是哪几镜、哪一版"
      style_code: project?.spec?.style_code ?? null,
      assembly: plan.assembly ?? null,
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
