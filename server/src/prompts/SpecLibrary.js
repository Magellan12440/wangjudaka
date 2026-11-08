/**
 * 第十个库：用户规格提示词库（V4.12）。
 *
 * 存在的理由：风格 / 时长 / 剧集 / 画质 / 屏幕比例 这些是用户在开机页亲手点的，
 * 但它们在此之前只以「参数」形式漂到下游——提示词里最多出现一句 "9:16 framing"，
 * 剧集数只写在一句中文里靠模型自觉，2K 与 4:3 甚至被算错。
 * 用户选完看不出差别，等于没选。所以把这一组选择做成和情绪库、运镜库同级的
 * **不可偏离的指令段落**，并且配上生成前 / 交付前的两道规格闸门。
 *
 * 三个职责：
 *   normalize(project)         把项目 spec 归一成一份规格（缺项补齐、非法值报错）
 *   segments(spec, ctx)        把规格翻成中英文提示词段（图片/视频用 P0 段，文本用编剧铁律）
 *   audit({spec, plan, shots}) 事后核对「做出来的东西是否真的符合用户点选」
 */
import { fail, ERR } from '../core/errors.js';
import { clamp, round } from '../core/util.js';
import {
  ASPECTS, QUALITIES, VIDEO_TYPES,
  aspectOf, qualityOf, videoTypeOf, resolutionOf,
} from '../core/frame.js';

/** 视频模型单次生成上限（秒）：超过这个长度的镜头必须拆，不能承诺 */
export const MAX_SHOT_SEC = 10;
export const MIN_SHOT_SEC = 2;

/**
 * 归一化项目规格。
 * 非法值不静默兜底：用户点了 2K 就必须是 2K，点了个不存在的画幅也要当场告诉他，
 * 而不是悄悄按 9:16 出片。
 */
export function normalize(project = {}, { strict = false } = {}) {
  const rawAspect = project.aspect ?? project.spec?.aspect ?? null;
  const rawQuality = project.quality ?? project.spec?.quality ?? null;
  const rawType = project.video_type ?? project.videoType ?? project.spec?.video_type ?? null;
  const specs = project.spec ?? project;

  if (strict && rawAspect && !aspectOf(rawAspect)) {
    fail(ERR.SPEC_VIOLATION, `不支持的画幅：${rawAspect}（可选 ${Object.keys(ASPECTS).join(' / ')}）`, {
      field: 'aspect', got: rawAspect,
    });
  }
  if (strict && rawQuality && !qualityOf(rawQuality)) {
    fail(ERR.SPEC_VIOLATION, `不支持的画质：${rawQuality}（可选 ${Object.keys(QUALITIES).join(' / ')}）`, {
      field: 'quality', got: rawQuality,
    });
  }

  const aspect = aspectOf(rawAspect) ? rawAspect : '9:16';
  const quality = qualityOf(rawQuality) ? rawQuality : '1080p';
  const videoType = VIDEO_TYPES[rawType] ? rawType : 'dynamic';
  const a = aspectOf(aspect);
  const q = qualityOf(quality);

  const episodeSec = number(specs.episode_sec ?? specs.episodeSec, 90);
  const explicitEpisodes = number(specs.episode_count ?? specs.episodeCount ?? project.episode_count, 0);
  const totalMinutes = number(specs.total_minutes ?? specs.totalMinutes, 0)
    || round((explicitEpisodes * episodeSec) / 60, 2)
    || 10;
  const episodes = explicitEpisodes >= 1
    ? Math.min(200, Math.floor(explicitEpisodes))
    : Math.max(1, Math.ceil((totalMinutes * 60) / episodeSec));
  // 单集时长有两个口径：用户填的值，和「总时长 ÷ 集数」算出来的值。
  // 两者不一致时以总时长为准（用户真正在意的是成片多长），但必须把这个偏差说出来，
  // 否则闸门会拿填的值去卡实际按总时长均分出来的每集时长，一卡就是全片红。
  const episodeSecTarget = round((totalMinutes * 60) / episodes, 2);
  const episodeSecOff = Math.abs(episodeSecTarget - episodeSec) > 0.5;

  return {
    aspect,
    aspect_name: a.name,
    orientation: a.orientation,
    platforms: a.platforms,
    resolution: resolutionOf(aspect, quality),
    quality,
    quality_name: q.name,
    quality_detail_en: q.detail_en,
    quality_detail_zh: q.detail_zh,
    quality_factor: q.factor,
    episodes,
    episode_sec: episodeSec,
    episode_sec_target: episodeSecTarget,
    episode_sec_off: episodeSecOff,
    total_minutes: totalMinutes,
    total_sec: round(totalMinutes * 60, 2),
    video_type: videoType,
    video_type_name: VIDEO_TYPES[videoType].name,
    video_type_zh: VIDEO_TYPES[videoType].zh,
    video_type_en: VIDEO_TYPES[videoType].en,
    need_video: VIDEO_TYPES[videoType].need_video,
    style_code: specs.style_code ?? project.style_code ?? null,
    palette: Array.isArray(project.palette) ? project.palette : (Array.isArray(specs.palette) ? specs.palette : []),
    /** 缺项补齐过的字段，用于在编译警告里说明「这条是默认值，不是你选的」 */
    defaulted: [
      rawAspect ? null : 'aspect',
      rawQuality ? null : 'quality',
      rawType ? null : 'video_type',
      explicitEpisodes >= 1 || specs.total_minutes ? null : 'episodes',
    ].filter(Boolean),
  };
}

function number(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 规格指纹：同一份点选 → 同一个 code，便于审计「这条片子按什么规格出的」 */
export function specCode(spec) {
  const a = spec.aspect.replace(':', 'x');
  return `SPEC-${a}-${spec.quality.toUpperCase()}-E${spec.episodes}-${Math.round(spec.episode_sec)}S-${spec.video_type.toUpperCase().slice(0, 3)}`;
}

/**
 * 图片 / 视频环节：P0 规格契约段。
 * 放在六段之前，因为它管的是"画布多大、要多细、这一镜多久、是哪种片型"，
 * 比风格和构图更靠上——画布错了，后面所有描述都白写。
 */
export function segments(spec, { kind = 'image', shotDuration = null } = {}) {
  const a = aspectOf(spec.aspect);
  const q = qualityOf(spec.quality);
  const vt = videoTypeOf(spec.video_type);
  const dur = shotDuration ? clamp(Number(shotDuration) || 0, MIN_SHOT_SEC, MAX_SHOT_SEC) : null;
  const isVideo = kind === 'video' || kind === 'audio';

  const en = [
    'USER SPEC CONTRACT (non-negotiable, overrides any conflicting instruction below):',
    `canvas ${spec.resolution}, ${a.en}.`,
    `composition rule: ${a.safe_en}.`,
    `output detail target: ${q.detail_en}.`,
    dur ? `runtime: exactly ${dur} seconds; the action must start and finish inside this window, do not stage a sequence that needs to be cut.` : null,
    isVideo ? `footage type (${vt.name}): ${vt.en}.` : `frame type (${vt.name}): ${vt.name === '静态漫剧' ? 'static keyframe, no motion blur, no camera movement' : 'single frame that the specified camera move would produce'}.`,
    spec.palette?.length
      ? `strict color palette: ${spec.palette.join(', ')} — do not introduce hues outside this palette; keep color temperature and saturation locked to it.`
      : null,
  ].filter(Boolean).join(' ');

  const zh = [
    '【用户规格契约｜不得偏离，优先级高于下方任何描述】',
    `画布 ${spec.resolution}（${a.zh}）；构图规则：${a.safe_zh}。`,
    `细节目标：${q.detail_zh}。`,
    dur ? `时长：必须正好 ${dur} 秒，动作在这段时间内起止，不许设计需要剪开才成立的多段动作。` : null,
    isVideo ? `片型（${vt.name}）：${vt.zh}。` : `画面类型（${vt.name}）：${vt.name === '静态漫剧' ? '静态关键帧，无动态模糊、无运镜' : '按指定运镜应得到的那一帧画面'}。`,
    spec.palette?.length ? `严格色板：${spec.palette.join('、')}，不得引入色板之外的色相，色温与饱和度锁死在色板内。` : null,
  ].filter(Boolean).join('');

  return { en, zh, code: specCode(spec), aspect: a, quality: q, video_type: vt };
}

/**
 * 文本环节（大纲 / 剧本）：编剧铁律段。
 * 剧集数在文本环节是**结构承诺**，不是形容词——模型想写几集就几集，下游总谱必然对不上时长。
 */
export function textRules(spec, { stage = 'outline' } = {}) {
  const a = aspectOf(spec.aspect);
  const vt = videoTypeOf(spec.video_type);
  const perEpShots = Math.max(2, Math.ceil(spec.episode_sec / Math.min(6, MAX_SHOT_SEC)));

  const zh = [
    '【用户规格契约｜不得偏离】',
    `共 ${spec.episodes} 集，单集 ${spec.episode_sec} 秒（总时长约 ${spec.total_minutes} 分钟）。`,
    stage === 'outline'
      ? `episodes 数组必须恰好 ${spec.episodes} 个元素，按 1..${spec.episodes} 连续编号，不得增集、减集或合并集。`
      : `必须按给定总谱写满 ${spec.episodes} 集，集数不得增减。`,
    `画幅 ${a.name}（${spec.resolution}）：${a.zh}，写法要为这个画幅服务。`,
    `片型 ${vt.name}：${vt.zh}，据此决定对白与旁白的比例。`,
    `每集约 ${perEpShots} 个镜头，单镜不超过 ${MAX_SHOT_SEC} 秒。`,
  ].filter(Boolean).join('');

  const en = [
    'USER SPEC CONTRACT (non-negotiable):',
    `exactly ${spec.episodes} episodes, ${spec.episode_sec}s each (total ~${spec.total_minutes} min).`,
    `frame ${spec.aspect} ${spec.resolution}; footage type ${vt.name}.`,
  ].join(' ');

  return { zh, en, code: specCode(spec) };
}

/**
 * 规格闸门（事后）：核对总谱 / 分镜是否真的按用户点选做的。
 * 放在这里而不是交付前才查，是因为集数错了以后每一集的对白、时长、镜头数全都不对，
 * 越早发现返工越少。
 */
export function audit({ spec, plan = null, shots = null } = {}) {
  const issues = [];
  const warnings = [];
  const s = spec;

  if (!aspectOf(s.aspect)) issues.push({ code: 'aspect_invalid', text: `画幅 ${s.aspect} 不在支持列表里` });
  if (!qualityOf(s.quality)) issues.push({ code: 'quality_invalid', text: `画质 ${s.quality} 不在支持列表里` });

  if (plan) {
    const eps = plan.episodes ?? [];
    if (s.episodes && eps.length !== s.episodes) {
      issues.push({
        code: 'episode_count',
        text: `集数不符：用户选 ${s.episodes} 集，实际 ${eps.length} 集`,
        want: s.episodes, got: eps.length,
      });
    }
    let total = 0;
    const wanted = Number(s.episode_sec_target ?? s.episode_sec) || 0;
    for (const ep of eps) {
      const dur = Number(ep.duration_sec) || 0;
      total += dur;
      if (wanted && Math.abs(dur - wanted) > wanted * 0.02) {
        issues.push({
          code: 'episode_sec',
          text: `第 ${ep.no} 集时长 ${dur}s，与目标 ${wanted}s 偏差超过 2%`,
          ep: ep.no, want: wanted, got: dur,
        });
      }
      for (const b of ep.beats ?? []) {
        const d = Number(b.duration_sec) || 0;
        if (d > MAX_SHOT_SEC) {
          issues.push({ code: 'shot_too_long', text: `${b.beat_no} 时长 ${d}s 超过单镜上限 ${MAX_SHOT_SEC}s`, beat: b.beat_no });
        }
        if (d < MIN_SHOT_SEC) {
          issues.push({ code: 'shot_too_short', text: `${b.beat_no} 时长 ${d}s 低于单镜下限 ${MIN_SHOT_SEC}s`, beat: b.beat_no });
        }
      }
    }
    if (eps.length && Math.abs(total - s.total_sec) > s.total_sec * 0.02) {
      issues.push({
        code: 'total_sec',
        text: `总时长 ${round(total, 2)}s 与用户设定 ${s.total_sec}s 偏差超过 2%`,
        want: s.total_sec, got: round(total, 2),
      });
    }
    if (plan.aspect && plan.aspect !== s.aspect) {
      issues.push({ code: 'aspect_mismatch', text: `总谱画幅 ${plan.aspect} 与用户选择 ${s.aspect} 不一致`, want: s.aspect, got: plan.aspect });
    }
    if (plan.quality && plan.quality !== s.quality) {
      issues.push({ code: 'quality_mismatch', text: `总谱画质 ${plan.quality} 与用户选择 ${s.quality} 不一致`, want: s.quality, got: plan.quality });
    }
  }

  if (Array.isArray(shots) && shots.length) {
    const byEp = new Map();
    for (const sh of shots) {
      const key = String(sh.episode ?? '').replace(/^E0*/, '') || '?';
      byEp.set(key, (byEp.get(key) ?? 0) + 1);
      const d = Number(sh.duration) || 0;
      if (d > MAX_SHOT_SEC) issues.push({ code: 'shot_too_long', text: `${sh.no} 时长 ${d}s 超过单镜上限`, shot: sh.no });
    }
    if (s.episodes && byEp.size !== s.episodes) {
      issues.push({ code: 'episode_count', text: `分镜覆盖 ${byEp.size} 集，用户要 ${s.episodes} 集`, want: s.episodes, got: byEp.size });
    }
  }

  if (s.defaulted?.length) {
    warnings.push(`以下规格未指定，已按默认值执行：${s.defaulted.join('、')}`);
  }
  if (s.episode_sec_off) {
    warnings.push(`「单集 ${s.episode_sec}s × ${s.episodes} 集」与总时长 ${s.total_minutes} 分钟对不上，已按总时长均分为每集 ${s.episode_sec_target}s`);
  }

  return {
    ok: issues.length === 0,
    code: specCode(s),
    spec: {
      aspect: s.aspect, resolution: s.resolution, quality: s.quality,
      episodes: s.episodes, episode_sec: s.episode_sec, video_type: s.video_type,
    },
    issues,
    warnings,
    checked_at: new Date().toISOString(),
  };
}

/** 硬拦版：不放行就抛 SPEC_VIOLATION */
export function assertSpec(ctx) {
  const r = audit(ctx);
  if (!r.ok) {
    fail(
      ERR.SPEC_VIOLATION,
      `生成物不符合用户选择的规格：${r.issues.slice(0, 4).map((i) => i.text).join('；')}`,
      { code: r.code, issues: r.issues, hint: '按用户设定重新生成；规格不允许为了迁就模型而放宽' },
    );
  }
  return r;
}

/** 给前端的一行摘要 */
export function summary(spec) {
  return `${spec.aspect_name} · ${spec.resolution} · ${spec.quality_name} · ${spec.episodes} 集 × ${spec.episode_sec}s · ${spec.video_type_name}`;
}

export default { normalize, segments, textRules, audit, assertSpec, specCode, summary, MAX_SHOT_SEC, MIN_SHOT_SEC };
