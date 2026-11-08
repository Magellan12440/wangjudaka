/**
 * 导演定调（Directing Brief，V4.17）。
 *
 * 痛点：总谱里已经有镜别/运镜/光影/转场/节奏，但**没有任何一处说清"这部片要什么感觉"**。
 * 结果是每个环节各自理解风格：剧本写得偏温情，分镜按高密度爽感排，BGM 又是日常。
 * 九列分镜表里最容易漏的那一列就是"叙事目的"——因为它要求先有一份统一定调。
 *
 * 定调不是又一份文案，它必须**可以拿去核对**：
 *   每一项都带 target（可量化的目标），下游（剧本/分镜/剪辑/质检）都拿它当尺子。
 * 例：cut_rate 目标 ≤3.5s ⇒ 分镜时长模型按它收紧 ⇒ 语法体检拿 NO_CONTRAST 反查。
 *
 * 全部由种子库 + 用户规格推导，确定性输出（同样的输入永远同一份定调），不调模型。
 */
import seeds from '../seeds/loader.js';
import { round } from '../core/util.js';

/** 色板用途：按顺序给主色/辅色/强调色/点缀，避免"四个色号堆在一起" */
const PALETTE_ROLES = ['主色（大面积环境与阴影）', '辅色（中间调与服装）', '高光色（皮肤/光源）', '强调色（危险与情绪爆点）'];

/** 镜头覆盖度的目标配比文字化（用于核对是否跑偏） */
function coverageOf(mix = {}) {
  const entries = Object.entries(mix ?? {})
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return entries.map(([k, v]) => ({ code: k, ratio: round(Number(v)) }));
}

export class DirectingBrief {
  /**
   * @param {object} p { outline, spec, style, director }
   * @returns {object} brief（可直接进 plan.global.directing_brief）
   */
  build({ outline = {}, spec = {}, style = null, director = null } = {}) {
    const st = style ?? seeds.style(spec.style_code) ?? seeds.style('STY-DUSHI');
    const dir = director ?? seeds.director(spec.director_code) ?? seeds.director(st.director_profile_default);
    const palette = st.palette ?? [];
    const avgShot = Number(dir.avg_shot_len ?? st.avg_shot_len ?? 4);
    const shotMix = { ...(st.shot_mix ?? {}), ...(dir.shot_mix ?? {}) };
    const coverage = coverageOf(shotMix);
    const moveBias = Object.entries(dir.camera_move_bias ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 3)
      .map(([code, w]) => ({ code, name: seeds.shot(code)?.name ?? code, weight: round(Number(w)) }));
    const trnBias = Object.entries(dir.transition_bias ?? st.transition_bias ?? {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 2)
      .map(([code, w]) => ({ code, name: seeds.transition(code)?.name ?? code, weight: round(Number(w)) }));
    const bgm = { ...(st.bgm_bias ?? {}), ...(dir.bgm_bias ?? {}) };

    const characters = outline.characters ?? [];
    const protagonist = characters.find((c) => c.role === 'protagonist') ?? characters[0] ?? null;
    const antagonist = characters.find((c) => c.role === 'antagonist') ?? null;

    const brief = {
      version: 1,
      tone: `${st.name} × ${dir.name}`,
      // 一句话定调：谁、在什么空间里、被什么拍法盯着
      one_liner: [
        protagonist?.name ? `以${protagonist.name}为轴` : '以主角为轴',
        antagonist?.name ? `，对抗${antagonist.name}` : '',
        `，${st.art_prompt_zh ?? st.name}`,
        `，用${dir.name}的密度（平均 ${avgShot}s/镜）把${st.name}的情绪压到位`,
      ].join(''),
      theme: outline.logline || outline.title || '未命名故事',
      color: {
        palette,
        roles: palette.slice(0, 4).map((hex, i) => ({ hex, role: PALETTE_ROLES[i] ?? '辅助色' })),
        temperature: dir.color_temp ?? st.color_temperature ?? '按风格预设',
        rule: '同一场戏只允许一套色温；跨场靠"冷暖反转"表达立场变化，不靠换滤镜',
      },
      camera: {
        avg_shot_sec: avgShot,
        coverage,
        movement_bias: moveBias,
        rule: `景别按 ${coverage.map((c) => `${seeds.shot(DISTANCE_CODE[c.code] ?? c.code)?.name ?? c.code} ${Math.round(c.ratio * 100)}%`).join(' / ')} 配比；主导运镜是「${moveBias[0]?.name ?? '固定'}」，其余为变奏`,
      },
      cut: {
        avg_shot_sec: avgShot,
        transition_bias: trnBias,
        contrast_target: 1.8,
        rule: `平均 ${avgShot}s/镜；快慢对比至少 1.8 倍（最快镜 ≤ ${round(Math.max(1, avgShot - 1.5))}s，最慢镜 ≥ ${round(avgShot + 1.5)}s）；段落切换才用非硬切`,
      },
      sound: {
        mood: bgm.mood_tags ?? [],
        bpm: bgm.bpm_range ?? bgm.tempo ?? null,
        instruments: bgm.instruments ?? [],
        density: bgm.density ?? 'medium',
        rule: '情绪高点前 2 秒留白（去音乐只留环境声），高点落地才进主旋律',
      },
      // 负向约束比正向约束更有效：模型不会自动"不做"什么
      avoid: [
        ...(st.negative_extra ?? []),
        ...(dir.negative_boost ?? []),
        avgShot <= 3.5 ? '超过 6 秒的静止长镜' : '整集全硬切',
      ],
      checkpoints: [
        { key: 'contrast', label: '快慢对比 ≥1.8 倍', target: 1.8 },
        { key: 'avg_shot_sec', label: `平均镜长 ${avgShot}s`, target: avgShot },
        { key: 'establish', label: '每集前 3 镜内交代空间', target: true },
        { key: 'closeup_ratio', label: '特写占比 ≤50%', target: 0.5 },
      ],
      derived_from: { style: st.code, director: dir.code, episode_count: spec.episode_count ?? null },
    };
    return brief;
  }

  /** 把定调压成一行给日志/面板用 */
  summarize(brief) {
    if (!brief) return '未定调';
    return `${brief.tone}｜${brief.one_liner}`;
  }
}

/** 风格 shot_mix 的简称 → 景别卡（用于定调里写人话） */
const DISTANCE_CODE = {
  LS: 'SHT-WS', EWS: 'SHT-EWS', FS: 'SHT-FS', MLS: 'SHT-MLS', MS: 'SHT-MS',
  MCU: 'SHT-MCU', CU: 'SHT-CU', ECU: 'SHT-ECU',
};

export const directingBrief = new DirectingBrief();
export default directingBrief;
