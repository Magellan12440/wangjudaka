/**
 * 画幅与画质的唯一真源（V4.12）。
 *
 * 为什么单独抽一个文件：之前编译器与剪辑单各写了一份「画幅×画质→像素」的换算，
 * 两份对不上——剪辑单支持 4:3 / 1:1 / 2K，编译器只认 9:16 与 16:9，还漏了 2k，
 * 于是「用户选 2K」实际出的是 576×1024，「用户选方图」实际出的是 1920×1080 横屏。
 * 那种错不会报错，只会让用户觉得"选什么没用"。所以只留一份，谁要换算都从这里取。
 */

/** 用户可选的画幅（与小程序 create 页的 ASPECTS 一一对应） */
export const ASPECTS = {
  '9:16': {
    name: '竖屏 9:16',
    orientation: 'portrait',
    platforms: '红果 / 抖音 / 视频号',
    en: '9:16 vertical framing, full-bleed phone screen',
    zh: '竖屏 9:16 构图，手机全屏满幅',
    // 竖屏的构图禁区分区，直接进提示词（模型不会自己知道平台 UI 压在哪）
    safe_en:
      'keep the subject horizontally centered, leave the right 15% free of story-critical elements (platform UI), leave the bottom 12% clear for burned-in subtitles',
    safe_zh: '主体居中偏左，右侧 15% 不放关键信息（平台 UI 遮挡区），底部 12% 留给字幕',
  },
  '16:9': {
    name: '横屏 16:9',
    orientation: 'landscape',
    platforms: 'B 站 / 腾讯 / 优酷',
    en: '16:9 widescreen cinematic framing',
    zh: '横屏 16:9 电影构图',
    safe_en:
      'compose on the rule of thirds with wide negative space, keep the bottom 14% free of faces for subtitles, action may use the full frame width',
    safe_zh: '三分法构图、左右留白，底部 14% 不放人脸以留字幕区，动作可用满画幅宽度',
  },
  '4:3': {
    name: '横屏 4:3',
    orientation: 'landscape',
    platforms: '番茄 / 百家号',
    en: '4:3 academy-ratio framing, slightly taller than widescreen',
    zh: '横屏 4:3 学院比例构图，纵向比宽银幕更高',
    safe_en:
      'use the extra vertical space for headroom and set dressing, keep the subject within the central 80%, bottom 12% clear for subtitles',
    safe_zh: '利用多出的纵向空间做头顶留白与陈设，主体收在中央 80% 内，底部 12% 留字幕',
  },
  '1:1': {
    name: '方屏 1:1',
    orientation: 'square',
    platforms: '小红书 / 信息流',
    en: '1:1 square framing, single centered subject',
    zh: '方屏 1:1 构图，单一主体居中',
    safe_en:
      'single centered subject, symmetric composition, no wide establishing shot (a square crops the sides), keep the outer 8% free of text-critical detail',
    safe_zh: '单一主体居中、构图对称，不用大远景（方图会切掉两侧），外圈 8% 不放关键细节',
  },
};

/** 画幅 × 画质 → 像素尺寸（剪辑渲染与生图共用一个口径） */
export const RESOLUTION_MAP = {
  '9:16': { '720p': '720x1280', '1080p': '1080x1920', '2k': '1440x2560' },
  '16:9': { '720p': '1280x720', '1080p': '1920x1080', '2k': '2560x1440' },
  '4:3': { '720p': '960x720', '1080p': '1440x1080', '2k': '1920x1440' },
  '1:1': { '720p': '720x720', '1080p': '1080x1080', '2k': '1440x1440' },
};

/**
 * 画质档位。
 * detail_en / detail_zh 是给模型看的「画质描述」，不是分辨率字符串——
 * 提示词里写 "720p" 只会让模型往低清方向画，写"细节到什么程度"才是它听得懂的。
 */
export const QUALITIES = {
  '720p': {
    name: '720P',
    use: '审阅省点',
    factor: 1.0,
    img_factor: 0.85,
    detail_en: 'clean well-defined rendering, crisp silhouette edges, no visible compression artifacts',
    detail_zh: '干净清晰的渲染，轮廓边缘利落，不出现压缩块',
  },
  '1080p': {
    name: '1080P',
    use: '平台定稿',
    factor: 1.6,
    img_factor: 1.0,
    detail_en:
      'high-detail rendering, fine fabric and hair texture, crisp edges, film-grade clarity, no visible compression artifacts',
    detail_zh: '高细节渲染，布料与发丝纹理清晰，边缘锐利，电影级清晰度，无压缩块',
  },
  '2k': {
    name: '2K',
    use: '收藏级',
    factor: 2.3,
    img_factor: 1.9,
    detail_en:
      'ultra-detailed rendering, micro-texture on skin fabric and props, razor-sharp edges, 2K-grade clarity, absolutely no upscaling softness or compression artifacts',
    detail_zh: '超高细节渲染，皮肤布料道具都有微纹理，边缘极锐，2K 级清晰度，绝不允许放大发虚或压缩块',
  },
};

/**
 * 视频类型：三种片型不是同一套拍法，不能只改计费。
 * constraints 会进提示词；need_video 决定要不要真出视频片段。
 */
export const VIDEO_TYPES = {
  dynamic: {
    name: '动态漫剧',
    need_video: true,
    en: 'each shot is animated: the specified camera move is actually executed, characters breathe and shift weight, background has parallax',
    zh: '每镜都是动态：指定的运镜要真实执行，角色有呼吸与重心变化，背景有视差',
  },
  static: {
    name: '静态漫剧',
    need_video: false,
    en: 'static keyframe illustration with only subtle micro-motion (breathing, hair drift), no camera movement, no walking, treat it as a picture that a voice actor speaks over',
    zh: '静态关键帧插画，只有轻微微动（呼吸、发丝飘动），不做运镜、不做走动，当作配音配图',
  },
  narration: {
    name: '解说漫',
    need_video: true,
    en: 'narration-driven b-roll: prefer voice-over narration over lip-synced dialogue, avoid shots that need precise lip sync, keep faces small or turned away',
    zh: '解说驱动的空镜：以旁白推进为主、少口型对白，避开需要精确对口型的镜头，人脸宜小或侧背',
  },
};

export function aspectOf(code) {
  return ASPECTS[code] ?? null;
}

export function qualityOf(code) {
  return QUALITIES[code] ?? null;
}

export function videoTypeOf(code) {
  return VIDEO_TYPES[code] ?? VIDEO_TYPES.dynamic;
}

/** 画幅 × 画质 → 像素。未知组合不静默兜底成 9:16，先退到该画幅的 1080p，再退到竖屏 */
export function resolutionOf(aspect = '9:16', quality = '1080p') {
  const byAspect = RESOLUTION_MAP[aspect] ?? RESOLUTION_MAP['9:16'];
  return byAspect[quality] ?? byAspect['1080p'] ?? '1080x1920';
}

/** 画幅规则（保留旧的返回形状，供既有调用方平滑使用） */
export function aspectRules(aspect = '9:16') {
  const a = aspectOf(aspect) ?? ASPECTS['9:16'];
  return {
    aspect,
    vertical: a.orientation === 'portrait',
    orientation: a.orientation,
    platforms: a.platforms,
    en: a.en,
    zh: a.zh,
    safe_en: a.safe_en,
    safe_zh: a.safe_zh,
  };
}

/** 像素尺寸 → 画幅（渲染前核对上游返图是否符合用户选的画幅） */
export function aspectOfSize(size = '') {
  const m = String(size).match(/(\d+)\s*[x×*]\s*(\d+)/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const r = w / h;
  if (r > 1.6) return '16:9';
  if (r > 1.15) return '4:3';
  if (r < 0.87 && r > 0.6) return '9:16';
  if (r <= 1.15 && r >= 0.87) return '1:1';
  return '9:16';
}

export default { ASPECTS, QUALITIES, VIDEO_TYPES, RESOLUTION_MAP, aspectOf, qualityOf, videoTypeOf, resolutionOf, aspectRules, aspectOfSize };
