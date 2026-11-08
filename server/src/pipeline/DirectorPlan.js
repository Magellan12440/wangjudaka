/**
 * 导演视听总谱（N02.5） —— 把导演级 SKILL 前置到剧本与分镜图之前。
 *
 * 为什么要前置（这是 V3.2 的核心修正）：
 *   V3.1 里镜别/光影/转场/节奏是在 storyboard() 里"边排镜边随机抽"的，
 *   等到视频生成时才第一次调用导演能力。结果是：剧本写的时候不知道自己会被
 *   怎么拍，分镜图画的时候不知道情绪该怎么演，导演意图在最后一步才补，
 *   补不回来 —— 开头该给大特写的地方已经画成了远景，改图要重花钱。
 *
 *   V3.2 的顺序：
 *     N02   大纲（剧情）
 *     N02.5 导演视听总谱 ← 本模块：镜别 / 光影 / 转场 / 节奏 / 情绪 全部定死
 *     N03   剧本（每场戏带已定的视听标注，编剧只能在这些约束里写对白动作）
 *     N04   节奏闸门（对总谱先过一遍，不合格不进剧本）
 *     N05   分镜图（按总谱展开，图生图阶段就带齐情绪与光影，不再事后补）
 *     N06   视频（只负责让已定的表演动起来）
 *
 * 总谱是「唯一事实」：DAG/画布只是它的渲染，剧本、分镜图、关键帧、视频
 * 都引用同一份 plan_id，任何环节不允许自行发明镜别或情绪。
 */
import seeds from '../seeds/loader.js';
import { rhythmMaster } from '../rhythm/RhythmMaster.js';
import { fail, ERR } from '../core/errors.js';
import { seedFrom, weightedPick, clamp } from '../core/util.js';
import { aspectOf, qualityOf } from '../core/frame.js';

/** 风格 shot_mix 的简称 → 镜头卡编码 */
export const SHOT_CODE_MAP = {
  LS: 'SHT-WS', FS: 'SHT-FS', MS: 'SHT-MS', MCU: 'SHT-MCU', CU: 'SHT-CU', ECU: 'SHT-ECU',
  OTS: 'SHT-OSS', POV: 'SHT-POV', LOW: 'SHT-LOW', HIGH: 'SHT-HIGH', HAND: 'SHT-HAND', SYM: 'SHT-EYE',
  EWS: 'SHT-EWS', MLS: 'SHT-MLS', BIRD: 'SHT-BIRD', DUTCH: 'SHT-DUTCH', TOP: 'SHT-TOP',
};

/** 按角色定位给默认情绪调色板（资产库未设置档案时） */
const ROLE_PALETTES = {
  protagonist: [
    'EMO-CALM-02', 'EMO-ANTICIPATION-03', 'EMO-RAGE-SUPPRESSED-04',
    'EMO-DEFIANCE-04', 'EMO-AGGRIEVED-03', 'EMO-RESOLVE-05',
    'EMO-FIREDUP-04', 'EMO-RELIEF-03', 'EMO-DESPAIR-05', 'EMO-MICRO-BREATH-02',
  ],
  antagonist: [
    'EMO-CALM-02', 'EMO-SNEER-03', 'EMO-PROVOKE-03', 'EMO-INTIMIDATE-04',
    'EMO-KILL-INTENT-05', 'EMO-MANIC-04', 'EMO-JEALOUS-04', 'EMO-PROUD-04',
  ],
  ally: [
    'EMO-CALM-02', 'EMO-TRUST-02', 'EMO-TENDER-02', 'EMO-LOVESTRUCK-03',
    'EMO-FEAR-04', 'EMO-AGGRIEVED-03', 'EMO-GUILT-03',
  ],
  default: [
    'EMO-CALM-02', 'EMO-ANTICIPATION-03', 'EMO-SURPRISE-04',
    'EMO-DEFIANCE-04', 'EMO-RELIEF-03',
  ],
};

/** 建置镜别：开场必须先把空间交代清楚，配方不许在这里改特写 */
const ESTABLISHING_SHOTS = new Set(['SHT-WS', 'SHT-EWS', 'SHT-FS', 'SHT-BIRD', 'SHT-HIGH', 'SHT-TOP']);

export class DirectorPlan {
  /**
   * 构建导演视听总谱。
   * @param {object} p { outline, spec, paletteResolver?, planId? }
   * @returns { plan }
   */
  build({ outline, spec, paletteResolver = null, planId = null }) {
    if (!outline?.episodes?.length) fail(ERR.BAD_REQUEST, '大纲为空，无法生成导演视听总谱');
    const style = seeds.style(spec.style_code) ?? seeds.style('STY-DUSHI');
    const director = seeds.director(spec.director_code) ?? seeds.director(style.director_profile_default);
    const characters = outline.characters ?? [];
    const rnd = mulberry32(seedFrom(`${planId ?? 'plan'}|${style.code}|${outline.title ?? ''}`));

    // 角色情绪调色板：优先读资产库档案，未建档按角色定位给默认
    const palettes = {};
    for (const c of characters) {
      const resolved = paletteResolver?.(c.code);
      const palette = resolved?.palette?.length ? resolved.palette : (ROLE_PALETTES[c.role] ?? ROLE_PALETTES.default);
      palettes[c.code] = {
        baseline: resolved?.baseline ?? 'EMO-CALM-02',
        palette: palette.filter((code) => seeds.emotion(code)),
        forbid: resolved?.forbid ?? [],
      };
    }

    const forbidden = new Set(style.lighting_cards_forbidden ?? []);
    const requiredLighting = (style.lighting_cards_required ?? []).filter((c) => !forbidden.has(c));
    const quota = director?.code === 'DIR-INTENSE' ? 0.10 : 0.30;
    const isIntense = director?.code === 'DIR-INTENSE';

    // 节奏闸门先过：总谱不合格就不许往下写剧本
    let rhythmReport;
    try {
      rhythmReport = rhythmMaster.gate({ episodes: outline.episodes });
    } catch (e) {
      rhythmReport = { passed: false, gates: [], error: e.message };
    }

    const prevIntensity = {};   // 角色 → 上一拍的情绪强度（做连续性约束）
    const planEpisodes = [];
    let allBeatCount = 0;
    let recipeBeats = 0;

    for (const ep of outline.episodes) {
      const epSec = ep.duration_sec ?? spec.episode_sec ?? 90;
      const per = Math.max(2, Math.ceil(epSec / Math.min(director.avg_shot_len, 10)));
      const dur = clamp(round2(epSec / per), 2, 10);
      const maxNonHard = Math.max(0, Math.floor(per * quota) - 1); // -1 预留集末定格
      let nonHardUsed = 0;
      let lastNonHardAtSec = -Infinity;
      let elapsed = 0;

      const beats = [];
      const usedRecipes = new Set();   // 同一集内不重复用同一条语法配方
      // 配方要"点"不要"铺"：连续上会变成公式感，所以限条数 + 最小间隔
      const recipeCap = Math.max(2, Math.ceil(per / 5));
      let recipeUsed = 0;
      let lastRecipeAt = -Infinity;
      for (let i = 1; i <= per; i++) {
        const isOpen = i === 1;
        const isEnd = i === per;
        const progress = i / per;

        // —— 节奏：把大纲里的钩子/冲突/反转/共情落到具体拍 ——
        const rhythm = this.#rhythmAt({ ep, i, per, isOpen, isEnd, rnd });

        // —— 情绪：按张力曲线 + 角色调色板 + 连续性约束 ——
        const targetIntensity = this.#tensionAt({ ep, i, per, isOpen, isEnd, rhythm, rnd });
        const emotions = {};
        const emotionCards = {};
        for (const c of characters.slice(0, 2)) {
          const picked = this.#pickEmotion({
            palettes: palettes[c.code],
            targetIntensity,
            rhythm,
            prev: prevIntensity[c.code],
            rnd,
          });
          emotions[c.code] = picked.code;
          emotionCards[c.code] = picked;
          prevIntensity[c.code] = picked.intensity;
        }

        // —— 镜别：情绪卡亲和反推（情绪是资产，资产参与构图决策）——
        const shotCard = this.#pickShot({
          style, director, i, per, isOpen, isEnd, emotionCards, rnd,
        });

        // —— 光影：风格强制 + 情绪亲和 + 动态光影，剔除风格禁止 ——
        const lightingCodes = this.#pickLighting({
          requiredLighting, forbidden, emotionCards, style, i, rnd,
        });

        // —— 大师语法配方：只在结构性节拍（开场/集末/反转/共情/强张力）上换组合 ——
        const recipe = this.#pickRecipe({
          style, isOpen, isEnd, rhythm, tension: targetIntensity,
          baseShot: shotCard, forbidden, used: usedRecipes, rnd,
          budgetLeft: recipeUsed < recipeCap && (i - lastRecipeAt) >= 2,
        });

        // —— 转场：配额 + 最小间隔 + 集末定格 + 情绪亲和（配方只做"候选偏好"，配额仍由这里裁决）——
        const transition = this.#pickTransition({
          style, director, ep, i, per, isOpen, isEnd, dur,
          nonHardUsed, maxNonHard,
          secSinceLastNonHard: elapsed - lastNonHardAtSec,
          secToEpisodeEnd: (per - i) * dur,
          emotionCards, rnd,
          preferred: recipe?.transition ?? null,
          preferredWhy: recipe?.why ?? null,
        });
        if (transition.code !== 'TRN-HARDCUT') {
          if (transition.code !== 'TRN-FREEZE') nonHardUsed += 1;
          lastNonHardAtSec = elapsed;
        }
        elapsed += dur;

        // —— 配方落地：转场已过配额闸门，这里只替换镜别/运镜/光影并登记语法 ——
        const applied = recipe
          ? this.#applyRecipe({ recipe, isOpen, isEnd, lightingCodes, requiredLighting, transition, forbidden })
          : null;
        if (applied) { usedRecipes.add(recipe.code); recipeBeats += 1; recipeUsed += 1; lastRecipeAt = i; }

        const moveCard = this.#pickMove({ director, shotCard: applied?.shot_card ?? shotCard, targetIntensity, rnd });

        const bgmMood = [
          ...new Set([
            ...Object.values(emotionCards).flatMap((c) => c.bgm_mood ?? []),
            ...(style.bgm_bias?.mood_tags ?? []),
          ]),
        ].slice(0, 4);

        beats.push({
          beat_no: `E${String(ep.no).padStart(2, '0')}-B${String(i).padStart(3, '0')}`,
          beat_purpose: rhythm.purpose,
          duration_sec: dur,
          // ↓↓↓ 以下五项在剧本与分镜图之前就已定死，下游不得改写 ↓↓↓
          shot_card: applied?.shot_card ?? shotCard,
          camera_move: applied?.camera_move ?? moveCard,
          lighting_codes: applied?.lighting_codes ?? lightingCodes,
          transition: transition.code,
          transition_reason: transition.reason,
          rhythm_code: rhythm.code,
          emotions,                       // { CH01: 'EMO-XXX', CH02: ... }
          emotion_cards: Object.fromEntries(Object.entries(emotionCards).map(([k, v]) => [k, v.code])),
          bgm_mood: bgmMood,
          // ↑↑↑ 视听标注结束 ↑↑↑
          // 大师语法：构图/焦段/调色/氛围 + 组合意图（PromptCompiler 会拼进提示词）
          grammar: applied?.grammar ?? null,
          tension: targetIntensity,
          conflict_code: rhythm.conflict_code ?? null,
          reversal_code: rhythm.reversal_code ?? null,
          is_episode_end: isEnd,
          ending_hook: isEnd ? (ep.ending_hook ?? '悬念未解') : null,
          last_3s_rule: isEnd ? { hold_freeze: true, no_dialogue: true } : null,
        });
      }
      allBeatCount += beats.length;
      planEpisodes.push({
        no: ep.no,
        duration_sec: epSec,
        beats,
        transition_quota: { max_non_hard: maxNonHard, quota, intense_director: isIntense },
        opening_hook: ep.hook?.code ?? null,
        ending_hook: ep.ending_hook ?? '悬念未解',
      });
    }

    const plan = {
      plan_id: planId ?? `PLAN-${seedFrom(`${style.code}|${outline.title ?? ''}`).toString(36).toUpperCase()}`,
      plan_version: '3.2',
      stage: 'N02.5',
      style_code: style.code,
      director_code: director.code,
      aspect: spec.aspect ?? '9:16',
      quality: spec.quality ?? '1080p',
      // V4.12：集数是用户点选的结构承诺，落进总谱才能在自检时核对
      episode_count: spec.episode_count ?? outline.episodes.length,
      video_type: spec.video_type ?? 'dynamic',
      total_minutes: spec.total_minutes ?? 10,
      episode_sec: spec.episode_sec ?? 90,
      // 单集时长的实际目标值：总时长均分（用户填的单集秒数与总时长冲突时，以总时长为准）
      episode_sec_target: spec.episode_sec_target
        ?? round2(((spec.total_minutes ?? 10) * 60) / Math.max(1, outline.episodes.length)),
      global: {
        lighting_arc: this.#lightingArc(requiredLighting, planEpisodes),
        shot_mix: style.shot_mix ?? {},
        // V4.13：把这一版风格的"契约"整份落进总谱。
        // 以前风格只散落在各处（画风进提示词、色板只给前端、转场偏好没人读），
        // 出问题无法回答"这条片子到底按哪个风格做的"。现在总谱里有一份完整副本，可核对、可追溯。
        style_contract: {
          code: style.code,
          name: style.name,
          art_prompt_zh: style.art_prompt_zh,
          art_prompt_en: style.art_prompt_en,
          palette: style.palette ?? [],
          lighting_required: style.lighting_cards_required ?? [],
          lighting_forbidden: style.lighting_cards_forbidden ?? [],
          shot_mix: style.shot_mix ?? {},
          avg_shot_len: style.avg_shot_len ?? null,
          transition_bias: style.transition_bias ?? {},
          bgm_bias: style.bgm_bias ?? {},
          rhythm_params: style.rhythm_params ?? {},
          negative_extra: style.negative_extra ?? [],
          director_profile: style.director_profile_default ?? null,
        },
        rhythm_curve: director.rhythm_curve,
        rhythm_report: rhythmReport,
        emotion_palettes: palettes,
        seed_cards: {
          director: director.code,
          style: style.code,
          shot_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.shot_card)))],
          lighting_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.flatMap((b) => b.lighting_codes)))],
          transition_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.transition)))],
          rhythm_codes: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.rhythm_code).filter(Boolean)))],
          emotion_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.flatMap((b) => Object.values(b.emotions))))],
          recipe_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.grammar?.recipe).filter(Boolean)))],
          composition_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.grammar?.composition).filter(Boolean)))],
          lens_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.grammar?.lens).filter(Boolean)))],
          color_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.grammar?.color).filter(Boolean)))],
          atmosphere_cards: [...new Set(planEpisodes.flatMap((e) => e.beats.map((b) => b.grammar?.atmosphere).filter(Boolean)))],
        },
      },
      episodes: planEpisodes,
      stats: {
        episodes: planEpisodes.length,
        beats: allBeatCount,
        recipe_beats: recipeBeats,
        total_sec: round2(planEpisodes.reduce((a, e) => a + e.duration_sec, 0)),
      },
    };
    plan.validation = this.validate(plan);
    return plan;
  }

  /**
   * 总谱自检（在写剧本之前跑，不合格直接打回 N02.5 重排）。
   * 检查项：节奏闸门 / 转场配额 / 光影冲突 / 镜别覆盖 / 情绪连续性 / 字段齐备 / 时长。
   */
  validate(plan) {
    const problems = [];
    const warnings = [];
    const style = seeds.style(plan.style_code);
    const forbidden = new Set(style?.lighting_cards_forbidden ?? []);
    const required = new Set(style?.lighting_cards_required ?? []);

    if (!plan.global?.rhythm_report?.passed) {
      problems.push({ item: 'rhythm_gate', issue: '节奏闸门未通过，禁止进入剧本环节' });
    }

    let shotKinds = new Set();
    let nonHardTotal = 0;
    let beatsTotal = 0;
    let emotionJumps = 0;
    let affinityMiss = 0;

    for (const ep of plan.episodes ?? []) {
      let nonHard = 0;
      let lastNonHardAt = -Infinity;
      let t = 0;
      const prevIntensity = {};
      for (const b of ep.beats ?? []) {
        beatsTotal += 1;
        shotKinds.add(b.shot_card);
        // 字段齐备
        for (const f of ['shot_card', 'camera_move', 'lighting_codes', 'transition', 'rhythm_code', 'emotions', 'duration_sec']) {
          if (b[f] === undefined || b[f] === null) problems.push({ item: b.beat_no, issue: `缺视听标注 ${f}` });
        }
        // 光影：风格强制必须命中，禁止卡不得出现
        for (const c of required) {
          if (!b.lighting_codes?.includes(c)) problems.push({ item: b.beat_no, issue: `缺风格强制光影卡 ${c}` });
        }
        for (const c of b.lighting_codes ?? []) {
          if (forbidden.has(c)) problems.push({ item: b.beat_no, issue: `用了风格禁止光影卡 ${c}` });
          if (!seeds.lighting(c)) problems.push({ item: b.beat_no, issue: `光影卡不存在 ${c}` });
        }
        if (!seeds.shot(b.shot_card)) problems.push({ item: b.beat_no, issue: `镜头卡不存在 ${b.shot_card}` });
        if (!seeds.transition(b.transition)) problems.push({ item: b.beat_no, issue: `转场卡不存在 ${b.transition}` });
        if (b.transition !== 'TRN-HARDCUT' && !b.transition_reason) {
          problems.push({ item: b.beat_no, issue: '非硬切转场缺理由' });
        }
        // 转场配额（集末定格不计入）
        if (b.transition !== 'TRN-HARDCUT' && b.transition !== 'TRN-FREEZE') {
          nonHard += 1;
          if (t - lastNonHardAt < 8.5) problems.push({ item: b.beat_no, issue: '两个非硬切间隔不足 8.5 秒' });
          lastNonHardAt = t;
        }
        // 情绪：每张卡必须存在，且强度跳变 ≤ 2（否则表演断裂）
        for (const [ch, code] of Object.entries(b.emotions ?? {})) {
          const card = seeds.emotion(code);
          if (!card) { problems.push({ item: b.beat_no, issue: `情绪卡不存在 ${code}` }); continue; }
          const prev = prevIntensity[ch];
          if (prev !== undefined && Math.abs(card.intensity - prev) > 2) {
            emotionJumps += 1;
            problems.push({ item: b.beat_no, issue: `角色 ${ch} 情绪强度跃迁 ${prev}→${card.intensity} 超过 2` });
          }
          prevIntensity[ch] = card.intensity;
          if (card.shot_affinity?.length && !card.shot_affinity.includes(b.shot_card)) affinityMiss += 1;
        }
        t += b.duration_sec ?? 0;
      }
      nonHardTotal += nonHard;
      if (nonHard > (ep.transition_quota?.max_non_hard ?? 0)) {
        problems.push({ item: `EP${ep.no}`, issue: `非硬切 ${nonHard} 超出配额 ${ep.transition_quota?.max_non_hard}` });
      }
      if (ep.beats?.[0]?.shot_card !== 'SHT-WS') warnings.push({ item: `EP${ep.no}`, issue: '开场非远景建置' });
    }

    if (shotKinds.size < 3) problems.push({ item: 'shot_mix', issue: `全剧仅 ${shotKinds.size} 种镜别，缺乏景别变化` });
    const targetSec = (plan.total_minutes ?? 10) * 60;
    if (Math.abs((plan.stats?.total_sec ?? 0) - targetSec) > targetSec * 0.02) {
      problems.push({ item: 'duration', issue: '总谱时长与目标偏差超过 2%' });
    }

    // —— 用户规格（V4.12）：集数 / 单集时长 / 画幅 / 画质 必须与用户点选一致 ——
    // 放在总谱自检而不是等出图后再查：集数错了，后面每一集的镜头数、对白量、配乐全要返工。
    if (plan.episode_count && (plan.episodes ?? []).length !== Number(plan.episode_count)) {
      problems.push({
        item: 'episode_count',
        issue: `集数与用户选择不符（用户 ${plan.episode_count} 集 / 总谱 ${(plan.episodes ?? []).length} 集）`,
      });
    }
    if (plan.episode_sec) {
      const wanted = Number(plan.episode_sec_target ?? plan.episode_sec);
      for (const ep of plan.episodes ?? []) {
        const d = Number(ep.duration_sec) || 0;
        if (Math.abs(d - wanted) > wanted * 0.02) {
          problems.push({ item: `EP${ep.no}`, issue: `单集时长 ${d}s 与目标 ${wanted}s 偏差超过 2%` });
        }
      }
    }
    if (plan.aspect && !aspectOf(plan.aspect)) {
      problems.push({ item: 'aspect', issue: `画幅 ${plan.aspect} 不在支持列表里` });
    }
    if (plan.quality && !qualityOf(plan.quality)) {
      problems.push({ item: 'quality', issue: `画质 ${plan.quality} 不在支持列表里` });
    }

    // —— 风格偏差（V4.13）：风格不是"选完就完"，它写在总谱里的每一项都要能对上 ——
    // 这里只报 warning 不拦：结构节拍（冲突数/反转数）是创作判断，偏差要让用户看见，
    // 但硬拦会让"模型少写一个反转"变成整集不能出片。真正的硬闸在光影（上面）。
    const styleWarnings = this.auditStyle(plan, style);
    for (const w of styleWarnings) warnings.push(w);

    return {
      ok: problems.length === 0,
      problems,
      warnings,
      stats: {
        beats: beatsTotal,
        shot_kinds: shotKinds.size,
        non_hard_total: nonHardTotal,
        emotion_jumps: emotionJumps,
        emotion_shot_affinity_miss: affinityMiss,
      },
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * 风格偏差审计（V4.13）：总谱实际做出来的东西 vs 风格声明的偏好。
   * 全部输出 warning，供前端「出片规格条 / 导演页」显示；不参与硬闸。
   */
  auditStyle(plan, style = null) {
    const st = style ?? seeds.style(plan?.style_code);
    if (!st) return [{ item: 'style', issue: `风格 ${plan?.style_code} 不存在` }];
    const out = [];
    const beats = (plan.episodes ?? []).flatMap((e) => e.beats ?? []);
    if (!beats.length) return out;

    // 1) 平均镜长
    const avg = beats.reduce((a, b) => a + (Number(b.duration_sec) || 0), 0) / beats.length;
    const want = Number(st.avg_shot_len) || null;
    if (want && Math.abs(avg - want) > want * 0.25) {
      out.push({ item: 'style.avg_shot_len', issue: `平均镜长 ${round2(avg)}s，风格「${st.name}」基准 ${want}s，偏差超过 25%` });
    }

    // 2) 镜别配比：风格声明的 shot_mix 里权重最高的那一档必须真的出现过
    const mix = Object.entries(st.shot_mix ?? {}).sort((a, b) => b[1] - a[1]);
    if (mix.length) {
      const top = mix[0][0];
      const hit = beats.some((b) => String(b.shot_card ?? '').includes(top));
      if (!hit) out.push({ item: 'style.shot_mix', issue: `风格「${st.name}」以 ${top} 为主，但总谱里一个都没有` });
    }

    // 3) 转场偏好：风格偏好的非硬切转场至少用上一种（否则风格只停留在画风上）
    const bias = Object.keys(st.transition_bias ?? {}).filter((c) => c !== 'TRN-HARDCUT' && c !== 'TRN-FREEZE');
    if (bias.length) {
      const hit = beats.some((b) => bias.includes(b.transition));
      if (!hit) out.push({ item: 'style.transition_bias', issue: `风格「${st.name}」偏好的转场（${bias.join('/')}）一个都没用上` });
    }

    // 4) 结构节拍密度
    const rp = st.rhythm_params ?? {};
    if (rp.reversal_total) {
      const total = (plan.episodes ?? []).reduce((a, e) => a + (e.reversals ?? []).length, 0);
      if (total < Number(rp.reversal_total)) {
        out.push({ item: 'style.reversal_total', issue: `全剧反转 ${total} 次，风格「${st.name}」要求至少 ${rp.reversal_total} 次` });
      }
    }
    if (rp.conflict_per_episode) {
      const weak = (plan.episodes ?? []).filter((e) => (e.conflicts ?? []).length < Number(rp.conflict_per_episode));
      if (weak.length) {
        out.push({
          item: 'style.conflict_per_episode',
          issue: `${weak.map((e) => `EP${e.no}`).join('/')} 冲突数不足风格「${st.name}」要求的 ${rp.conflict_per_episode} 个`,
        });
      }
    }
    if (rp.empathy_every_n_episodes) {
      const n = Math.max(1, Number(rp.empathy_every_n_episodes));
      const need = Math.ceil((plan.episodes ?? []).length / n);
      const got = (plan.episodes ?? []).filter((e) => (e.empathy ?? []).length > 0).length;
      if (got < need) {
        out.push({ item: 'style.empathy', issue: `共情高点 ${got} 集，风格「${st.name}」要求每 ${n} 集至少 1 个（共 ${need} 集）` });
      }
    }

    // 5) 色板必须存在（提示词要用它锁色）
    if (!(st.palette ?? []).length) out.push({ item: 'style.palette', issue: `风格「${st.name}」没有色板，提示词无法锁色` });

    return out;
  }

  /** 供剧本环节使用的"约束摘要"（注入 LLM system prompt，防止编剧改视听标注） */  toScriptConstraints(plan, episodeNo = null) {
    const eps = episodeNo ? plan.episodes.filter((e) => e.no === episodeNo) : plan.episodes;
    const lines = [
      `本剧已有导演视听总谱 ${plan.plan_id}（版本 ${plan.plan_version}），以下标注为硬约束，编剧不得改写：`,
      `风格 ${plan.style_code} / 导演 ${plan.director_code} / 画幅 ${plan.aspect} / 画质 ${plan.quality}`,
      '每一场戏必须严格采用给定的镜别、运镜、光影卡、转场、节奏模板与角色情绪卡；',
      '对白与动作只能在该镜别与情绪允许的范围内写，不得写出需要改镜别才能拍的动作；',
      '情绪卡是资产：角色在该场的表演细节以情绪卡的眉/眼/嘴/下颌/呼吸/手势/体态/视线为准。',
    ];
    for (const ep of eps) {
      lines.push(`第 ${ep.no} 集（${ep.duration_sec} 秒 / ${ep.beats.length} 场）：`);
      for (const b of ep.beats) {
        const g = b.grammar
          ? `｜语法 ${b.grammar.recipe}（${b.grammar.intent}：${b.grammar.composition ?? '—'}/${b.grammar.lens ?? '—'}/${b.grammar.color ?? '—'}/${b.grammar.atmosphere ?? '—'}）`
          : '';
        lines.push(
          `  ${b.beat_no} [${b.beat_purpose}] 时长${b.duration_sec}s | 镜别${b.shot_card} 运镜${b.camera_move} | ` +
          `光影${b.lighting_codes.join('+')} | 转场${b.transition}${b.transition_reason ? '(' + b.transition_reason + ')' : ''} | ` +
          `节奏${b.rhythm_code ?? '—'} | 情绪${Object.entries(b.emotions).map(([k, v]) => k + ':' + v).join(',')} | ` +
          `张力${b.tension}/5 | BGM情绪${b.bgm_mood.join('/')}${g}`
        );
      }
    }
    return lines.join('\n');
  }

  // ——— 内部：节奏落拍 ———
  #rhythmAt({ ep, i, per, isOpen, isEnd, rnd }) {
    if (isOpen) return { code: ep.hook?.code ?? 'HOOK-05', purpose: '黄金三秒开场', conflict_code: null };
    if (isEnd) return { code: 'EMP-02', purpose: '集末钩子', conflict_code: null };
    const conflicts = ep.conflicts ?? [];
    const reversals = ep.reversals ?? [];
    const empathy = ep.empathy ?? [];
    if (reversals.length && i === Math.max(2, Math.floor(per * 0.7))) {
      return { code: 'REV-05', purpose: '反转落点', reversal_code: reversals[0].code };
    }
    if (empathy.length && i === Math.max(2, Math.floor(per * 0.5))) {
      return { code: empathy[0].code, purpose: '共情高点' };
    }
    const c = conflicts[Math.min(conflicts.length - 1, Math.floor(((i - 1) / per) * conflicts.length))] ?? null;
    return {
      code: c?.code ?? null,
      purpose: c ? `冲突升级 L${c.escalation ?? 2}` : '推进',
      conflict_code: c?.code ?? null,
    };
  }

  // ——— 内部：张力曲线 → 目标情绪强度 ———
  #tensionAt({ ep, i, per, isOpen, isEnd, rhythm, rnd }) {
    let t;
    if (isOpen) t = 4;                                  // 黄金三秒必须是强情绪
    else if (isEnd) t = 5;                              // 集末钩子拉满
    else {
      const base = 2 + (i / per) * 2.2;                 // 中段随进度递增
      const escalation = Math.max(...(ep.conflicts ?? []).map((c) => c.escalation ?? 2), 2);
      t = base + (escalation - 2) * 0.25;
    }
    if (rhythm.reversal_code) t += 0.8;
    if ((rhythm.code ?? '').startsWith('EMP')) t = Math.max(3, t - 0.5);
    t += (rnd() - 0.5) * 0.6;
    return Math.round(clamp(t, 1, 5) * 10) / 10;
  }

  // ——— 内部：情绪挑选（资产级）———
  #pickEmotion({ palettes, targetIntensity, rhythm, prev, rnd }) {
    const pool = (palettes?.palette ?? ROLE_PALETTES.default)
      .filter((code) => !(palettes?.forbid ?? []).includes(code))
      .map((code) => seeds.emotion(code))
      .filter(Boolean);
    if (!pool.length) return seeds.emotion('EMO-CALM-02');

    // 共情拍优先 low/high，反转拍优先 basic/conflict，其余按强度选
    let candidates = pool;
    if ((rhythm.code ?? '').startsWith('EMP')) {
      const soft = pool.filter((c) => c.cat === 'low' || c.cat === 'high');
      if (soft.length) candidates = soft;
    }
    if (rhythm.reversal_code) {
      const sharp = pool.filter((c) => c.cat === 'conflict' || c.cat === 'basic');
      if (sharp.length) candidates = sharp;
    }
    // 连续性：强度跳变不得超过 2，否则换一张更接近的卡
    let scored = candidates
      .map((c) => ({ c, score: Math.abs(c.intensity - targetIntensity) + rnd() * 0.25 }))
      .filter((x) => prev === undefined || Math.abs(x.c.intensity - prev) <= 2)
      .sort((a, b) => a.score - b.score);
    if (!scored.length) {
      // 调色板跨度不够 → 从全库补一张"过渡情绪"，保证连续性不断
      const bridge = seeds.emotionsByIntensity(
        clamp(prev + Math.sign(targetIntensity - prev) * 2, 1, 5),
        { tolerance: 0 }
      )[0] ?? seeds.emotion('EMO-CALM-02');
      return bridge;
    }
    return scored[0].c;
  }

  // ——— 内部：镜别（情绪卡亲和反推）———
  #pickShot({ style, director, i, per, isOpen, isEnd, emotionCards, rnd }) {
    if (isOpen) return 'SHT-WS';
    if (isEnd) return 'SHT-CU';
    const mix = style.shot_mix ?? director?.shot_mix ?? {};
    const keys = Object.keys(mix).length ? Object.keys(mix) : ['MS', 'MCU', 'CU'];
    const brief = weightedPick(Object.fromEntries(keys.map((k) => [k, mix[k] ?? 1]))) ?? 'MS';
    let code = SHOT_CODE_MAP[brief] ?? 'SHT-MS';

    // 情绪资产参与构图：主情绪的亲和镜别优先（75% 采纳，留 25% 给风格配比）
    // 开场远景 / 集末特写是硬规则，会在上层直接返回，因此这里不覆盖它们。
    const primary = Object.values(emotionCards)[0];
    const affinity = (primary?.shot_affinity ?? []).filter(
      (c) => seeds.shot(c)?.dim === 'distance'
    );
    if (affinity.length && rnd() < 0.75) code = affinity[Math.floor(rnd() * affinity.length)];
    return code;
  }

  #pickMove({ director, shotCard, targetIntensity, rnd }) {
    const bias = director?.camera_move_bias ?? {};
    let pick = weightedPick(bias) ?? 'SHT-STATIC';
    // 强情绪用推镜/手持逼视，弱情绪用固定镜头让表演自己说话
    if (targetIntensity >= 4 && rnd() < 0.5) pick = rnd() < 0.5 ? 'SHT-PUSH' : 'SHT-HAND';
    if (targetIntensity <= 2 && rnd() < 0.5) pick = 'SHT-STATIC';
    if (pick === 'SHT-WHIP' && shotCard === 'SHT-ECU') pick = 'SHT-STATIC';
    return pick;
  }

  #pickLighting({ requiredLighting, forbidden, emotionCards, style, i, rnd }) {
    const out = [...requiredLighting];
    // 情绪卡亲和光影（剔除风格禁止）
    for (const card of Object.values(emotionCards)) {
      for (const c of card.lighting_affinity ?? []) {
        if (!forbidden.has(c) && !out.includes(c)) { out.push(c); break; }
      }
    }
    // 一张动态光影（motion 类），让画面在镜内有变化
    const motion = seeds.lightingCards.filter((c) => c.cat === 'motion' && !forbidden.has(c.code));
    if (motion.length) out.push(motion[i % motion.length].code);
    return [...new Set(out)].slice(0, 3);
  }

  // ——— 内部：转场 ———
  #pickTransition({ style = null, director, ep, i, per, isOpen, isEnd, dur, nonHardUsed, maxNonHard, secSinceLastNonHard, secToEpisodeEnd, emotionCards, rnd, preferred = null, preferredWhy = null }) {
    if (isEnd) return { code: 'TRN-FREEZE', reason: '集末定格留住悬念' };
    if (isOpen && i === 1) return { code: 'TRN-HARDCUT', reason: null };
    if (secToEpisodeEnd < 8.5) return { code: 'TRN-HARDCUT', reason: null };
    if (nonHardUsed >= maxNonHard) return { code: 'TRN-HARDCUT', reason: null };
    if (secSinceLastNonHard < 8.5) return { code: 'TRN-HARDCUT', reason: null };

    // 语法配方指定了转场：配额与间隔闸门已经放行，直接用（这是"大师手法"的落点）
    if (preferred && preferred !== 'TRN-FREEZE' && seeds.transition(preferred)) {
      return { code: preferred, reason: preferredWhy ? `语法配方：${firstClause(preferredWhy)}` : '语法配方指定' };
    }

    // 情绪卡亲和非硬切优先，其次导演偏好
    const aff = [...new Set(Object.values(emotionCards).flatMap((c) => c.transition_affinity ?? []))]
      .filter((c) => c !== 'TRN-HARDCUT' && c !== 'TRN-FREEZE' && seeds.transition(c));
    let pick;
    if (aff.length && rnd() < 0.65) pick = aff[Math.floor(rnd() * aff.length)];
    else pick = weightedPick(mergeTransitionBias(style?.transition_bias, director?.transition_bias)) ?? 'TRN-HARDCUT';
    if (pick === 'TRN-HARDCUT') return { code: pick, reason: null };
    return { code: pick, reason: '情绪/时间衔接' };
  }

  // ——— 内部：大师语法配方挑选 ———
  /**
   * 配方不是"每拍都上"的装饰：只在结构性节拍（开场 / 集末 / 反转 / 共情 / 强张力）上，
   * 把镜别+运镜+构图+氛围+焦段+调色+光影+转场整体换成一条被验证过的组合。
   * 硬闸：不踩风格禁忌光影、不破坏转场配额、一集内不重复、定格只给集末。
   */
  #pickRecipe({ style, isOpen, isEnd, rhythm, tension, baseShot, forbidden, used, rnd, budgetLeft = true }) {
    const structural = isEnd || isOpen || !!rhythm.reversal_code ||
      (rhythm.code ?? '').startsWith('EMP') || tension >= 4;
    if (!structural) return null;
    // 集末定格是硬规则，永远上；其余受条数与间隔预算限制
    if (!isEnd && !budgetLeft) return null;

    const fam = (code) => String(code ?? '').split('-')[0];
    const beatFam = fam(rhythm.code);
    const pool = seeds.recipesForStyle(style.code).filter((r) => {
      if (used.has(r.code)) return false;
      if ((r.lighting ?? []).some((c) => forbidden.has(c))) return false;
      if (!seeds.shot(r.shot)) return false;
      if (r.move && seeds.shot(r.move)?.dim !== 'movement') return false;
      if (r.transition === 'TRN-FREEZE') return isEnd;  // 定格只给集末
      if (isEnd) return false;                          // 集末必须定格收尾，别的配方不许抢
      // 开场必须建置：手电探洞这种 POV 配方不能当第一镜，否则观众还没看清空间就被扔进洞里
      if (isOpen && !ESTABLISHING_SHOTS.has(r.shot)) return false;
      return true;
    });
    if (!pool.length) return null;

    const ranked = pool
      .map((r) => {
        let s = rnd() * 1.2;
        if (r.rhythm === rhythm.code) s += 6;                              // 节奏卡精确命中
        else if (beatFam && fam(r.rhythm) === beatFam) s += 3;             // 同族节奏（REV/HOOK/CFL/EMP）
        if (r.shot === baseShot) s += 2;                                   // 与情绪反推的镜别一致
        if ((r.styles ?? []).includes(style.code)) s += 1;                 // 题材显式适配
        if (isEnd && r.transition === 'TRN-FREEZE') s += 4;                // 集末定格
        if (isOpen && ESTABLISHING_SHOTS.has(r.shot)) s += 1.5;            // 开场要建置
        return { r, s };
      })
      .sort((a, b) => b.s - a.s);
    return ranked[0].r;
  }

  /** 把配方落到这一拍上：开场锁死远景建置，其余整体替换 */
  #applyRecipe({ recipe, isOpen, isEnd, lightingCodes, requiredLighting, transition, forbidden }) {
    const grammar = {
      recipe: recipe.code,
      name: recipe.name,
      intent: recipe.intent,
      composition: recipe.composition ?? null,
      lens: recipe.lens ?? null,
      color: recipe.color ?? null,
      atmosphere: recipe.atmosphere ?? null,
      why: recipe.why ?? null,
      transition_applied: transition.code,
      transition_dropped: null,
    };
    // 配方想要非硬切但基线判成硬切 → 记下被配额否决的事实，方便前端说明"为什么没用那招"
    if (recipe.transition && recipe.transition !== transition.code && recipe.transition !== 'TRN-FREEZE') {
      grammar.transition_dropped = recipe.transition;
    }
    // 光影：风格强制卡一张都不能丢，配方卡叠上去（最多 4 张，再长模型会忽略）
    const merged = [...new Set([...requiredLighting, ...(recipe.lighting ?? []), ...lightingCodes])]
      .filter((c) => !forbidden.has(c));
    for (const must of requiredLighting) if (!merged.includes(must)) merged.push(must);
    return {
      shot_card: isOpen ? 'SHT-WS' : recipe.shot,   // 开场固定远景建置
      camera_move: recipe.move ?? null,
      lighting_codes: merged.slice(0, 4),
      grammar,
    };
  }


  #lightingArc(required, episodes) {
    // 按幕给光影基调：前 1/3 建置、中段加压、后段收束
    const n = episodes.length;
    return episodes.map((e, idx) => ({
      episode: e.no,
      act: idx < n / 3 ? '建置' : idx < (n * 2) / 3 ? '对抗' : '收束',
      base_cards: required,
      accent: idx < n / 3 ? 'LIG-SOFTBOX' : idx < (n * 2) / 3 ? 'LIG-KEY-SIDE' : 'LIG-RIM',
    }));
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
/**
 * 风格转场偏好 × 导演转场偏好（V4.13）。
 * 以前只读 director.transition_bias —— 32 个风格各自写的 transition_bias 等于白写：
 * 选了「古风」和选了「赛博」的成片转场分布一模一样。现在两者合并，
 * 风格是"这部戏的底色"（权重 1），导演是"这个导演的手癖"（权重 0.5），导演只做微调。
 * 不存在或不合法的转场卡直接剔除，避免把请求打到不存在的卡上。
 */
function mergeTransitionBias(styleBias = null, directorBias = null) {
  const out = {};
  const add = (src, weight) => {
    for (const [code, w] of Object.entries(src ?? {})) {
      if (!seeds.transition(code)) continue;
      const n = Number(w);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[code] = (out[code] ?? 0) + n * weight;
    }
  };
  add(styleBias, 1);
  add(directorBias, 0.5);
  return Object.keys(out).length ? out : { 'TRN-HARDCUT': 1 };
}

/** 取 why 的第一小句，塞进转场理由里（太长会把 UI 撑爆） */
function firstClause(s) {
  return String(s).split(/[；;。]/)[0].slice(0, 28);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const directorPlanEngine = new DirectorPlan();
export default directorPlanEngine;
