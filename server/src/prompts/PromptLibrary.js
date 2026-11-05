/**
 * 九大提示词库（V4.4）。
 *
 * 为什么要「强制」：创作链路里每一环都有专业判断（情绪怎么走、镜头怎么运、光怎么打、
 * 剪辑怎么卡点、字幕怎么对嘴）。这些判断不能交给模型的自由发挥，必须由内置库提供约束。
 *
 * 设计：
 *  - 九个库统一收口在这里，任何生成都必须带齐该环节要求的库内容（compose 会给默认值，
 *    所以正常调用不会失败；只有当库文件缺失/为空、或调用方显式跳过时才会被闸门拦下）。
 *  - RelayAdapter 在真正打上游之前调用 assertCompiled()，是最后一道闸门：
 *    没有库内容的请求不会消耗用户点数。
 */
import seeds from '../seeds/loader.js';
import { fail } from '../core/errors.js';

/** 九个库的元信息与取数方式 */
export const KINDS = {
  emotion: {
    name: '情绪提示词库',
    hint: '角色的情绪层级、外化动作、强度阈值',
    list: () => seeds.emotionCards ?? [],
    byCode: (c) => seeds.emotion(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.prompt_zh, x?.prompt_en, x?.action_zh].filter(Boolean).join('；'),
  },
  transition: {
    name: '转场提示词库',
    hint: '镜头之间的衔接方式与风险等级',
    list: () => seeds.transitionCards ?? [],
    byCode: (c) => seeds.transition(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.prompt_en].filter(Boolean).join('｜'),
  },
  movement: {
    name: '运镜提示词库',
    hint: '推拉摇移跟升降的动机与速度',
    list: () => seeds.shotsByDim?.('movement') ?? [],
    byCode: (c) => seeds.shot(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.prompt_en].filter(Boolean).join('｜'),
  },
  lighting: {
    name: '光影提示词库',
    hint: '主光位置、光比、色温与阴影质感',
    list: () => seeds.lightingCards ?? [],
    byCode: (c) => seeds.lighting(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.prompt_en].filter(Boolean).join('｜'),
  },
  rhythm: {
    name: '节奏提示词库',
    hint: '整段戏的时间分配与信息密度',
    list: () => seeds.rhythmTemplates ?? [],
    byCode: (c) => seeds.rhythm(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.structure, x?.example, x?.note_zh].filter(Boolean).join('｜'),
  },
  bgm: {
    name: '背景音乐提示词库',
    hint: '情绪标签、BPM、能量曲线与版权信息',
    list: () => seeds.bgmLibrary ?? [],
    byCode: (c) => seeds.bgm(c),
    codeOf: (x) => x?.track_id,
    textOf: (x) => [x?.title, `${x?.bpm ?? '?'}BPM`, (x?.mood_tags ?? []).join('/')].filter(Boolean).join('｜'),
  },
  fx: {
    name: '特效提示词库',
    hint: '雨雪尘雾、速度线、故障、重曝等画面级效果',
    list: () => seeds.fxLibrary ?? [],
    byCode: (c) => seeds.fx(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.prompt_en].filter(Boolean).join('｜'),
  },
  edit: {
    name: '剪辑成片提示词库',
    hint: '开场钩子、平均镜长、卡点密度、字幕样式',
    list: () => seeds.editRecipes ?? [],
    byCode: (c) => seeds.editRecipe(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.cut_rhythm && `节奏:${x.cut_rhythm}`, x?.avg_cut_sec && `平均${x.avg_cut_sec}秒/镜`].filter(Boolean).join('｜'),
  },
  sync: {
    name: '字幕同步提示词库',
    hint: '每行字数、最短停留、提前量、断句规则',
    list: () => seeds.subtitleSync ?? [],
    byCode: (c) => seeds.subtitleSyncRule(c),
    codeOf: (x) => x?.code,
    textOf: (x) => [x?.name, x?.prompt_zh, x?.max_chars_per_line && `每行≤${x.max_chars_per_line}字`].filter(Boolean).join('｜'),
  },
};

/** 各环节必须带齐哪些库（少一个就不许生成） */
export const STAGE_REQUIREMENTS = {
  /** 剧本创作：情绪走向 + 节奏分配 */
  script: ['emotion', 'rhythm'],
  /** 角色生成：情绪底色 + 光影塑形 */
  character: ['emotion', 'lighting'],
  /** 分镜图：运镜 + 光影 + 转场 + 特效 */
  storyboard: ['movement', 'lighting', 'transition', 'fx'],
  /** 音视频：运镜 + 光影 + 特效 + 配乐 + 情绪 */
  media: ['movement', 'lighting', 'fx', 'bgm', 'emotion'],
  /** 剪辑成片：剪辑配方 + 字幕同步 + 转场 + 配乐 */
  edit: ['edit', 'sync', 'transition', 'bgm'],
};

const DEFAULTS = {
  emotion: 'EMO-JOY-03',
  transition: 'TRN-OBJWIPE',
  movement: 'SHT-PUSH',
  lighting: 'LIG-PRACTICAL',
  rhythm: 'HOOK-01',
  bgm: 'BGM-NONE',
  fx: 'FX-NONE',
  edit: 'EDR-SHORTDRAMA',
  sync: 'SYN-STD',
};

/** 默认值兜底：库里第一个可用项（避免写死 code 与库不同步） */
function fallbackOf(kind) {
  const conf = KINDS[kind];
  const list = conf?.list?.() ?? [];
  if (!list.length) return null;
  const want = DEFAULTS[kind];
  if (want) {
    const hit = list.find((x) => conf.codeOf(x) === want);
    if (hit) return hit;
  }
  return list[0];
}

/** 取某库的全部条目（给前端/管理台下拉用，脱敏：只给 code/name/提示） */
export function listKind(kind) {
  const conf = KINDS[kind];
  if (!conf) fail('PROMPT_KIND_UNKNOWN', `未知提示词库: ${kind}`);
  return (conf.list() ?? []).map((x) => ({
    code: conf.codeOf(x),
    name: x.name ?? x.title ?? conf.codeOf(x),
    text: conf.textOf(x),
    ...(x.intensity ? { intensity: x.intensity } : {}),
    ...(x.use_case ? { use_case: x.use_case } : {}),
    ...(x.cat ? { cat: x.cat } : {}),
  }));
}

export function summary() {
  return Object.entries(KINDS).map(([kind, conf]) => ({
    kind,
    name: conf.name,
    hint: conf.hint,
    count: (conf.list() ?? []).length,
    usable: (conf.list() ?? []).length > 0,
    stages: Object.entries(STAGE_REQUIREMENTS)
      .filter(([, req]) => req.includes(kind))
      .map(([s]) => s),
  }));
}

/**
 * 组装某环节的库内容。
 * @param {'script'|'character'|'storyboard'|'media'|'edit'} stage
 * @param {object} codes  { emotion: 'EMO-..', lighting: 'LIG-..' } 传 null 用默认
 */
export function compose(stage, codes = {}) {
  const need = STAGE_REQUIREMENTS[stage];
  if (!need) fail('PROMPT_STAGE_UNKNOWN', `未知创作环节: ${stage}`);

  const blocks = [];
  const missing = [];
  for (const kind of need) {
    const conf = KINDS[kind];
    let item = null;
    const asked = codes?.[kind];
    if (asked) item = conf.byCode(asked) ?? null;
    if (!item) item = fallbackOf(kind);
    if (!item) {
      missing.push({ kind, name: conf.name, reason: '库为空或未加载' });
      continue;
    }
    blocks.push({
      kind,
      name: conf.name,
      code: conf.codeOf(item),
      text: conf.textOf(item),
    });
  }
  return { stage, blocks, missing };
}

/** 把库内容拼成一段可注入提示词的「创作铁律」 */
export function toPromptText(composed) {
  if (!composed?.blocks?.length) return '';
  const lines = composed.blocks.map((b) => `【${b.name}】${b.text}`);
  return `创作必须遵守以下内置提示词库（不得偏离）：\n${lines.join('\n')}`;
}

/**
 * 最后一道闸门：真正调用上游前校验。
 * 不满足就抛错，绝不消耗用户点数去生成一个「没有专业约束」的东西。
 */
export function assertCompiled(compiled) {
  const libs = compiled?.prompt_libraries;
  if (!libs || !Array.isArray(libs.blocks)) {
    fail('PROMPT_LIBRARY_MISSING', '生成请求未绑定提示词库，已拒绝（请通过编译器重新构建）');
  }
  if (libs.missing?.length) {
    fail(
      'PROMPT_LIBRARY_MISSING',
      `提示词库不完整，缺少：${libs.missing.map((m) => m.name).join('、')}`,
      { missing: libs.missing }
    );
  }
  const need = STAGE_REQUIREMENTS[libs.stage] ?? [];
  const have = new Set(libs.blocks.map((b) => b.kind));
  const lack = need.filter((k) => !have.has(k));
  if (lack.length) {
    fail('PROMPT_LIBRARY_MISSING', `环节「${libs.stage}」缺少必需库：${lack.map((k) => KINDS[k]?.name ?? k).join('、')}`, { lack });
  }
  return true;
}

export default { KINDS, STAGE_REQUIREMENTS, listKind, summary, compose, toPromptText, assertCompiled };
