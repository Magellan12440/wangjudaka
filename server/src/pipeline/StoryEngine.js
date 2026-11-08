/**
 * 故事引擎：把"一句话"变成可生产的结构化文档（N02 大纲 → N03 剧本 → N05 分镜 → N04 节奏过闸）。
 *
 * 设计要点：
 *  1. 所有文本生成都走 GenerateService（→ 编译器 → 算力池 → 记账），不绕过唯一出口。
 *  2. 模型输出优先；但模型不可用或返回不可解析时，**内置结构化兜底生成器**接管 ——
 *     直接用种子库（节奏模板 / 风格镜头配比 / 导演原型 / 光影卡）拼出合规结构。
 *     这样即使上游抖动，流水线也不会停在半路，且输出天然符合节奏闸门。
 */
import seeds from '../seeds/loader.js';
import { generateService } from './GenerateService.js';
import { directorPlanEngine } from './DirectorPlan.js';
import { directorAgent } from '../director/DirectorAgent.js';
import { rhythmMaster } from '../rhythm/RhythmMaster.js';
import * as specLib from '../prompts/SpecLibrary.js';
import { config } from '../config/env.js';
import { logger } from '../core/redact.js';
import { seedFrom, weightedPick, clamp, round } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';

const LOCK_TEMPLATE_BY_TYPE = { character: 'CH', scene: 'SC', prop: 'PR', voice: 'VO' };

/**
 * 改编强度指令（V4.6）。抽成纯函数是为了能被单测锁住：
 * 这段文案直接决定 AI 敢不敢改用户的结局，不能靠「看代码觉得没问题」。
 */
export function adaptInstruction(spec = {}, hasReference = false) {
  if (!hasReference) return '';
  if (spec.adapt_mode === 'faithful') {
    return '改编要求：忠于原著。保留原作主线、人物关系与关键台词，只做竖屏化拆分，不得改动结局。';
  }
  if (spec.adapt_mode === 'remix') {
    return '改编要求：保留原作的设定与人物，允许重排节奏、合并次要人物、加强钩子，但世界观与主角动机不得改变。';
  }
  return '';
}

export class StoryEngine {
  /**
   * N02：大纲与人物
   * @param {object} p
   * @param {string} [p.reference] 用户上传素材的摘要（文本节选 + 视觉参考说明）
   * @returns { outline, characters, usage }
   */
  async outline({ userId, projectId, prompt, spec, model = null, reference = '' }) {
    const style = seeds.style(spec.style_code) ?? seeds.style('STY-DUSHI');
    const director = seeds.director(spec.director_code) ?? seeds.director(style.director_profile_default);
    // V4.12：用户规格（集数/单集时长/画幅/画质/片型）先归一，再同时喂给提示词与结构
    const userSpec = specLib.normalize({ ...spec, palette: style.palette ?? [] });
    const rules = specLib.textRules(userSpec, { stage: 'outline' });
    // 每个风格的 rhythm_params 不同（慢热型每集 1 个冲突，强压型 3 个），这里把它变成硬性要求
    const rhythmRules = {
      conflictPerEpisode: Math.max(1, Number(style.rhythm_params?.conflict_per_episode) || 2),
      reversalTotal: Math.max(1, Number(style.rhythm_params?.reversal_total) || 3),
      empathyEveryNEpisodes: Math.max(1, Number(style.rhythm_params?.empathy_every_n_episodes) || 3),
    };

    const system = [
      '你是国产漫剧的总编剧。输出必须是严格 JSON，不要任何解释、不要 markdown 代码块。',
      `风格：${style.name}（${style.art_prompt_zh}）`,
      `导演原型：${director.name}，平均镜长 ${director.avg_shot_len}s，节奏曲线 ${director.rhythm_curve}`,
      // 画幅由用户选的，不再写死"竖屏"——16:9 的剧按竖屏短剧的写法写会全程别扭
      `画幅：${userSpec.aspect_name}（${userSpec.resolution}），台词长度与场面调度按该画幅设计。`,
      `片型：${userSpec.video_type_name}，${userSpec.video_type_zh}`,
      // V4.13：冲突/反转/共情的密度不再写死 —— 32 个风格各自的 rhythm_params 必须真的生效，
      // 否则"古风慢热"和"复仇强压"拿到的结构节拍完全一样，风格只停留在画风上。
      `硬性要求：第1集开场必须命中黄金三秒模板 HOOK-01..12 之一；每集至少 ${rhythmRules.conflictPerEpisode} 个不同编码的冲突且强度递增；`,
      `全剧至少 ${rhythmRules.reversalTotal} 次结构级反转${rhythmRules.reversalTotal >= 3 ? '，第 2 集必须有 REV-01 或 REV-09' : ''}；`
      + `每 ${rhythmRules.empathyEveryNEpisodes} 集至少 1 个共情高点；每集结尾必须有集末钩子。`,
      rules.zh,
    ].join('\n');

    const user = [
      `创意：${prompt}`,
      reference ? `以下是用户上传的参考素材，请优先沿用其中的人物关系、世界观与关键情节，不要另起炉灶：\n${reference}` : '',
      // 改编强度（V4.6）：素材改编路线下用户要能选「照原著拍」还是「按竖屏短剧重排」
      adaptInstruction(spec, Boolean(reference)),
      `集数：${userSpec.episodes} 集，单集 ${userSpec.episode_sec} 秒（总时长约 ${userSpec.total_minutes} 分钟）`,
      `episodes 数组必须恰好 ${userSpec.episodes} 个元素，编号 1..${userSpec.episodes}。`,
      '输出 JSON 结构：',
      '{"title":"","logline":"","characters":[{"code":"CH01","name":"","role":"","traits":"","locks":["","","",""]}],',
      '"locations":[{"code":"SC01","name":"","desc":""}],',
      '"props":[{"code":"PR01","name":"","desc":""}],',
      '"episodes":[{"no":1,"goal":"","hook":{"code":"HOOK-01","micro_hook":true,"shots":3},',
      '"conflicts":[{"code":"CFL-02","escalation":2}],"reversals":[{"code":"REV-01","foreshadow":2}],',
      '"empathy":[{"code":"EMP-02"}],"ending_hook":"悬念未解"}]}',
      '说明：locations 按集划分（SC01 对应第 1 集），props 是全剧反复出现的关键道具；没有就返回空数组。',
    ].filter(Boolean).join('\n');

    let parsed = null;
    let usage = null;
    try {
      const r = await generateService.run({
        userId, projectId, kind: 'chat', purpose: 'preview',
        meta: { shotNo: null },
        compileRequest: {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // 规格必须随请求走：编译器要用它算出 SPEC code 并做 strict 校验
          project: {
            style_code: style.code,
            aspect: userSpec.aspect,
            quality: userSpec.quality,
            video_type: userSpec.video_type,
            episode_count: userSpec.episodes,
            episode_sec: userSpec.episode_sec,
            total_minutes: userSpec.total_minutes,
            palette: style.palette ?? [],
          },
          model: model ?? undefined,
          max_tokens: 4000,
        },
      });
      usage = { credits: r.credits, mock: r.mock };
      parsed = safeParseJson(r.text);
    } catch (e) {
      logger.warn('大纲生成失败，启用结构化兜底', { code: e.code, msg: e.message });
    }

    let outline = parsed ?? this.#fallbackOutline({ prompt, spec, style, director });
    // V4.12：模型给几集就是几集是旧账——用户选 6 集、模型写 4 集时，
    // 下游总谱时长必然对不上（然后被自己的时长闸门拦下，用户只看到一句报错）。
    // 这里按用户选择做一次结构对齐，把模型多写/少写的集数收进用户要的集数里。
    const fitted = this.fitEpisodes(outline, userSpec);
    outline = fitted.outline;
    return { outline, fromModel: !!parsed, usage, spec: userSpec, spec_fit: fitted.adjustment };
  }

  /**
   * 把大纲的集数对齐到用户选择（V4.12）。
   *
   * 三种情况：
   *   1. 一样多 → 只把每集 duration_sec 按用户设定重算
   *   2. 模型写多了 → 多出来的并入最后一集（保住它们的情节钩子与反转，不丢内容）
   *   3. 模型写少了 → 用种子库补足合规的集（每集自带 2 个递增冲突 + 集末钩子），
   *      共情点按"每 3 集一个"补齐，保证过得了节奏闸门
   * 补出来的集不伪造"模型原创"：标 padded: true，前端与剧本环节都能看出来。
   */
  fitEpisodes(outline, userSpec) {
    const eps = Array.isArray(outline?.episodes) ? outline.episodes.map((e) => ({ ...e })) : [];
    if (!eps.length) return { outline, adjustment: null };
    const want = userSpec.episodes;
    const epSec = userSpec.episode_sec;
    const adjustment = { want, got: eps.length, action: 'none', notes: [] };

    if (eps.length > want) {
      const keep = eps.slice(0, Math.max(1, want - 1));
      const tail = eps.slice(Math.max(1, want - 1));
      const merged = tail.reduce((acc, e) => {
        acc.conflicts = dedupeCodes([...(acc.conflicts ?? []), ...(e.conflicts ?? [])]).slice(-3);
        acc.reversals = dedupeCodes([...(acc.reversals ?? []), ...(e.reversals ?? [])]);
        acc.empathy = dedupeCodes([...(acc.empathy ?? []), ...(e.empathy ?? [])]);
        acc.ending_hook = e.ending_hook ?? acc.ending_hook;
        acc.goal = acc.goal ?? e.goal;
        return acc;
      }, { ...(tail[0] ?? eps[eps.length - 1]) });
      eps.length = 0;
      eps.push(...keep, merged);
      adjustment.action = 'merged';
      adjustment.notes.push(`模型写了 ${tail.length + keep.length} 集，已把后 ${tail.length} 集并入第 ${want} 集`);
    } else if (eps.length < want) {
      const rnd = mulberry32(seedFrom(`pad|${outline?.title ?? ''}|${want}`));
      while (eps.length < want) {
        const no = eps.length + 1;
        const seeded = this.#paddedEpisode({ no, total: want, rnd });
        eps.push(seeded);
      }
      adjustment.action = 'padded';
      adjustment.notes.push(`模型只写了 ${adjustment.got} 集，已按内置节奏模板补到 ${want} 集`);
    }

    // 时长按用户设定均分（末集吃掉取整误差），不让模型的自估时长漂移
    const totalSec = round(userSpec.total_sec || want * epSec, 2);
    const per = round(totalSec / want, 2);
    eps.forEach((e, i) => {
      e.no = i + 1;
      e.duration_sec = i === want - 1 ? round(totalSec - per * (want - 1), 2) : per;
    });

    // 共情覆盖：节奏闸门要求 ≥1/3，补足时不能只补集不补共情
    const needEmpathy = Math.ceil(want / 3);
    const empathyEps = new Set(eps.filter((e) => (e.empathy ?? []).length).map((e) => e.no));
    if (empathyEps.size < needEmpathy) {
      const pool = seeds.rhythmByCat('empathy');
      for (let i = 3; i <= want && empathyEps.size < needEmpathy; i += 3) {
        if (empathyEps.has(i)) continue;
        const cand = eps[i - 1];
        if (!cand) continue;
        cand.empathy = [{ code: pool[(i - 1) % Math.max(1, pool.length)]?.code ?? 'EMP-02' }];
        empathyEps.add(i);
        adjustment.notes.push(`第 ${i} 集补了共情高点`);
      }
    }

    return { outline: { ...outline, episodes: eps }, adjustment };
  }

  /** 补出来的集：确保过得了节奏闸门（2 个不同编码且强度递增的冲突 + 集末钩子） */
  #paddedEpisode({ no, total, rnd }) {
    const hooks = seeds.rhythmByCat('hook');
    const conflicts = seeds.rhythmByCat('conflict');
    const reversals = seeds.rhythmByCat('reversal');
    const escalating = (conflicts ?? [])
      .map((c) => c)
      .sort((a, b) => (a.escalation ?? 1) - (b.escalation ?? 1));
    const low = escalating[Math.floor(rnd() * Math.max(1, Math.floor(escalating.length / 2)))] ?? escalating[0];
    const high = escalating[escalating.length - 1] ?? low;
    const isLast = no === total;
    return {
      no,
      padded: true,
      goal: isLast ? '终局清算' : '冲突升级',
      hook: {
        code: (hooks[Math.floor(rnd() * Math.max(1, hooks.length))] ?? { code: 'HOOK-05' }).code,
        micro_hook: true,
        shots: 3,
      },
      conflicts: [
        ...(low ? [{ code: low.code, escalation: low.escalation ?? 2 }] : []),
        ...(high ? [{ code: high.code, escalation: Math.max((low?.escalation ?? 2) + 1, high.escalation ?? 4) }] : []),
      ],
      reversals: no % 3 === 0 && reversals?.length
        ? [{ code: reversals[Math.floor(rnd() * reversals.length)].code, foreshadow: 2 }]
        : [],
      empathy: [],
      ending_hook: isLast ? '主线收束但留下续作钩子' : '悬念未解',
    };
  }

  /**
   * N02.5：导演视听总谱（V3.2 新增）。
   * 在**剧本生成之前**把镜别 / 光影 / 转场 / 节奏 / 情绪五项全部定死，
   * 并立即自检。总谱不合格不许进 N03，更不许进分镜图 —— 这就是"提前用导演级 SKILL"。
   */
  directorPlan({ outline, spec, projectId = null, planId = null }) {
    // 若已落资产库，角色情绪调色板优先用资产档案；否则按角色定位给默认
    const resolvePalette = (code) => {
      try {
        // 延迟引用，避免与 AssetLibrary 形成启动期循环依赖
        return globalThis.__lingwuAssetLibrary?.emotionPaletteOf?.(projectId, code) ?? null;
      } catch { return null; }
    };
    const plan = directorPlanEngine.build({ outline, spec, planId, paletteResolver: projectId ? resolvePalette : null });

    // V4.11：用户手动 pin 的技巧库在这里落到总谱（运镜/转场/情绪/节奏），
    // 然后重跑一次自检 —— 人工选择不能把结构规则撞坏，撞坏了就当场暴露出来。
    if (projectId) {
      try {
        const applied = directorAgent.applyToPlan(plan, projectId);
        plan.validation = directorPlanEngine.validate(plan);
        directorAgent.log({
          projectId, stage: 'plan', action: 'apply_policy',
          decisions: [
            ...Object.entries(applied.applied).filter(([, v]) => v > 0).map(([k, v]) => `${k} 应用 ${v} 处`),
            ...applied.warnings.map((w) => `未应用：${w}`),
          ],
          gate: { ok: Boolean(plan.validation?.ok), issues: (plan.validation?.problems ?? []).slice(0, 5) },
        });
      } catch (e) {
        logger.warn('导演策略落总谱失败，已保留自动编排', { projectId, error: e.message });
      }
    }
    return plan;
  }

  /** 总谱自检报告（供 API / 画布 / 流水线在进入剧本前调用） */
  validatePlan(plan) {
    return directorPlanEngine.validate(plan);
  }

  /**
   * N03：剧本（V3.2 新增）。
   * 总谱作为硬约束注入 system prompt：编剧只能在已定的镜别、光影、转场、节奏、情绪里写戏，
   * 不允许写出"需要改镜别才拍得出来"的动作。模型不可用时有结构化兜底。
   */
  async script({ outline, plan, spec, userId = null, projectId = null, model = null }) {
    const activePlan = plan ?? this.directorPlan({ outline, spec, projectId });
    if (!activePlan.validation?.ok) {
      fail(ERR.PLAN_NOT_APPROVED, '导演视听总谱未通过自检，禁止生成剧本', {
        problems: activePlan.validation.problems.slice(0, 5),
      });
    }
    const constraints = directorPlanEngine.toScriptConstraints(activePlan);
    // V4.12：剧本环节也带用户规格——集数/时长/画幅/片型同样是承诺，不只是装饰
    const userSpec = specLib.normalize({ ...spec, aspect: activePlan.aspect, quality: activePlan.quality, palette: seeds.style(activePlan.style_code)?.palette ?? [] });
    const rules = specLib.textRules(userSpec, { stage: 'script' });
    const system = [
      `你是国产漫剧的编剧，本剧画幅为 ${userSpec.aspect_name}（${userSpec.resolution}），片型 ${userSpec.video_type_name}。`,
      '输出必须是严格 JSON，不要任何解释、不要 markdown 代码块。',
      constraints,
      rules.zh,
      '剧本 JSON 结构：{"episodes":[{"no":1,"scenes":[{"beat_no":"E01-B001","action":"","dialogue":[{"speaker":"CH01","line":""}]}]}]}',
      '每场戏的 beat_no 必须与原样一致，不得增删场次、不得改动任何视听标注。',
      '对白极短（每句不超过 15 个汉字），动作描写只写该镜别拍得到的东西。',
    ].join('\n');
    const user = `剧名：${outline?.title ?? '未命名'}。创意：${outline?.logline ?? ''}。请按总谱写全部 ${userSpec.episodes} 集场次（一集都不能少）。`;

    let parsed = null;
    let usage = null;
    try {
      const r = await generateService.run({
        userId, projectId, kind: 'chat', purpose: 'preview',
        meta: { shotNo: null },
        compileRequest: {
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          project: {
            style_code: activePlan.style_code,
            aspect: userSpec.aspect,
            quality: userSpec.quality,
            video_type: userSpec.video_type,
            episode_count: userSpec.episodes,
            episode_sec: userSpec.episode_sec,
            total_minutes: userSpec.total_minutes,
            palette: userSpec.palette,
          },
          model: model ?? undefined,
          max_tokens: 6000,
        },
      });
      usage = { credits: r.credits, mock: r.mock };
      parsed = safeParseJsonScript(r.text);
    } catch (e) {
      logger.warn('剧本生成失败，启用结构化兜底', { code: e.code, msg: e.message });
    }

    const episodes = parsed?.episodes?.length ? parsed.episodes : this.#fallbackScript(activePlan, outline);
    return {
      script_id: `SCRIPT-${activePlan.plan_id}`,
      plan_id: activePlan.plan_id,
      episodes,
      fromModel: !!parsed?.episodes?.length,
      usage,
    };
  }

  /**
   * N05：分镜表（V3.2）—— 严格按导演总谱展开。
   *
   * 关键变化：镜别 / 光影 / 转场 / 节奏 / **情绪** 全部来自 N02.5 总谱，
   * 分镜图生成阶段就带着完整标注，不再是"先画图、到视频时再补导演意图"。
   */
  async storyboard({ outline, spec, plan = null, script = null, episodes = null, strict = true }) {
    const activePlan = plan ?? this.directorPlan({ outline, spec });
    if (strict && !activePlan.validation?.ok) {
      fail(ERR.PLAN_NOT_APPROVED, '导演视听总谱未通过自检，禁止生成分镜图', {
        problems: activePlan.validation.problems.slice(0, 5),
      });
    }
    // 剧本（可选）：提供时把对白与动作按 beat_no 对齐到镜头
    const sceneIndex = new Map();
    for (const ep of script?.episodes ?? []) {
      for (const sc of ep.scenes ?? []) sceneIndex.set(sc.beat_no, sc);
    }

    const shots = [];
    for (const epPlan of activePlan.episodes) {
      for (const b of epPlan.beats) {
        const sc = sceneIndex.get(b.beat_no);
        const speaker = sc?.dialogue?.[0]?.speaker ?? null;
        const dialogue = sc?.dialogue?.[0]?.line ?? null;
        const primaryCode = Object.values(b.emotions ?? {})[0] ?? null;
        const primaryCard = primaryCode ? seeds.emotion(primaryCode) : null;
        const shot = {
          no: b.beat_no.replace('-B', '-S'),
          beat_no: b.beat_no,
          plan_id: activePlan.plan_id,
          episode: epPlan.no,
          index: b.beat_no.split('-B')[1] ? Number(b.beat_no.split('-B')[1]) : 0,
          // V4.13：镜头在成片里的唯一排序键（集号×10000 + 集内镜序）。
          // 剪辑按它排序，用户重出某一镜只换版本、不动索引，所以新版本一定落在原来的位置。
          order: epPlan.no * 10000 + (b.beat_no.split('-B')[1] ? Number(b.beat_no.split('-B')[1]) : 0),
          duration: b.duration_sec,
          // ↓ 来自 N02.5 总谱，下游不得改写 ↓
          shot_card: b.shot_card,
          camera_move: b.camera_move,
          lighting_codes: [...b.lighting_codes],
          transition: b.transition,
          transition_reason: b.transition_reason,
          rhythm: b.rhythm_code,
          emotions: { ...b.emotions },
          emotion_cards: { ...b.emotion_cards },
          tension: b.tension,
          // V4.17：九列分镜表的第 9 列——这一镜在叙事里干什么、为什么是这个长度
          narrative_function: b.narrative_function ?? null,
          narrative_label: b.narrative_label ?? null,
          narrative_intent: b.narrative_intent ?? null,
          bgm_mood: [...b.bgm_mood],
          // 语法配方（构图/焦段/调色/氛围）：来自总谱，编译器要用它拼"为什么这么拍"
          grammar: b.grammar ?? null,
          // ↑ 总谱标注结束 ↑
          characters: Object.keys(b.emotions ?? {}),
          scene: `SC${String(epPlan.no).padStart(2, '0')}`,
          props: [],
          emotion: primaryCard?.name ?? '推进',
          speaker,
          dialogue,
          action_start: sc?.action ?? null,
          action_end: null,
          ambient: ['subtle atmospheric dust'],
          ambient_sound: 'room tone',
          music_entry: 'No music',
          is_episode_end: b.is_episode_end,
          ending_hook: b.ending_hook,
          last_3s_rule: b.last_3s_rule,
        };
        shots.push(shot);
      }
    }
    return {
      plan_id: activePlan.plan_id,
      plan_validation: activePlan.validation,
      target_total_sec: (spec.total_minutes ?? 10) * 60,
      // V4.12：分镜产出即刻核一次用户规格（集数/时长/画幅），不合规当场抛，不带病往下出图
      spec_check: this.assertStoryboardSpec({ plan: activePlan, shots, spec }),
      shots,
      stats: { shots: shots.length, total_sec: round2(shots.reduce((a, s) => a + s.duration, 0)) },
    };
  }

  /** 分镜阶段的规格核对：集数、单镜时长、画幅与画质 */
  assertStoryboardSpec({ plan, shots, spec }) {
    const userSpec = specLib.normalize({
      ...spec,
      aspect: plan?.aspect ?? spec.aspect,
      quality: plan?.quality ?? spec.quality,
      episode_count: plan?.episode_count ?? spec.episode_count ?? null,
    });
    const check = specLib.audit({ spec: userSpec, plan, shots });
    if (!check.ok) {
      fail(
        ERR.SPEC_VIOLATION,
        `分镜不符合用户选择的规格：${check.issues.slice(0, 4).map((i) => i.text).join('；')}`,
        { spec: check.spec, issues: check.issues, plan_id: plan?.plan_id ?? null },
      );
    }
    return check;
  }

  /** 旧版分镜推导（保留作紧急降级与回归对比，正常链路不再使用） */
  async #legacyStoryboard({ outline, spec, episodes = null }) {
    const style = seeds.style(spec.style_code) ?? seeds.style('STY-DUSHI');
    const director = seeds.director(spec.director_code) ?? seeds.director(style.director_profile_default);
    const eps = episodes ?? outline?.episodes ?? [];
    const shotMix = style.shot_mix ?? director.shot_mix ?? {};
    const requiredLighting = style.lighting_cards_required ?? [];

    const shots = [];
    // 转场配额：导演偏好只是倾向，必须服从 §7.3 硬规则（非硬切占比上限 + 最小间隔）
    const isIntense = director?.code === 'DIR-INTENSE';
    const quota = isIntense ? 0.10 : 0.30;
    // 渲染按「集」出片，转场配额也必须按集算（否则全片合格但每集都超标）
    let lastNonHardAtSec = -Infinity; // 上一个非硬切发生的时刻（秒，跨集连续）
    let elapsed = 0;
    let globalIndex = 0;

    for (const ep of eps) {
      // 最后一集按剩余秒数补齐，保证全片总时长精确等于用户设定
      const epSec = ep.duration_sec ?? spec.episode_sec ?? 90;
      // 视频模型单次生成上限 10 秒：长镜导演也要拆镜，且用 ceil 保证单集总时长精确
      const per = Math.max(2, Math.ceil(epSec / Math.min(director.avg_shot_len, 10)));
      const maxNonHard = Math.max(0, Math.floor(per * quota) - 1); // -1 预留集末定格
      let nonHardUsed = 0;
      let acc = 0;
      for (let i = 1; i <= per; i++) {
        globalIndex += 1;
        const dur = clamp(round2(epSec / per), 2, 10);
        const shotCard = this.#pickShotCard(shotMix, i, per);
        const isEnd = i === per;
        const isOpen = i === 1;
        const lighting = [...requiredLighting, ...(isEnd ? [] : [pickMotionLighting(style, i)])].slice(0, 3);
        const transition = this.#pickTransition({
          style, director, isOpen, isEnd, index: i, globalIndex,
          nonHardUsed, maxNonHard,
          secSinceLastNonHard: elapsed - lastNonHardAtSec,
          // 距集末不足 8.5 秒的镜一律硬切，给集末定格留出间隔（按秒算，短镜头风格才不会踩线）
          secToEpisodeEnd: (per - i) * dur,
        });
        if (transition.code !== 'TRN-HARDCUT') {
          // 集末定格同样占用"非硬切时刻"，否则跨集时下一个非硬切会贴得太近
          if (transition.code !== 'TRN-FREEZE') nonHardUsed += 1;
          lastNonHardAtSec = elapsed;
        }
        elapsed += dur;
        const rhythmCode = isOpen ? (ep?.hook?.code ?? 'HOOK-05') : isEnd ? 'EMP-02' : null;
        const shot = {
          no: `E${String(ep.no).padStart(2, '0')}-S${String(i).padStart(3, '0')}`,
          episode: ep.no,
          index: i,
          duration: dur,
          shot_card: shotCard,
          camera_move: this.#pickMove(director, shotCard),
          lighting_codes: [...new Set(lighting)],
          transition: transition.code,
          transition_reason: transition.reason,
          characters: (outline?.characters ?? []).slice(0, 2).map((c) => c.code),
          scene: `SC${String(ep.no).padStart(2, '0')}`,
          props: [],
          emotion: ep.goal ?? '推进',
          speaker: null,
          dialogue: null,
          is_episode_end: isEnd,
          ending_hook: isEnd ? (ep.ending_hook ?? '悬念未解') : null,
          rhythm: rhythmCode,
          ambient: ['subtle atmospheric dust'],
          ambient_sound: 'room tone',
          music_entry: 'No music',
        };
        shots.push(shot);
        acc += dur;
      }
    }
    return {
      target_total_sec: (spec.total_minutes ?? 10) * 60,
      shots,
      stats: { shots: shots.length, total_sec: round2(shots.reduce((a, s) => a + s.duration, 0)) },
    };
  }

  /** N04：节奏过闸（返回报告，不达标给出修订建议，交由流水线回退 N03） */
  rhythmGate(outline) {
    try {
      const report = rhythmMaster.gate({ episodes: outline?.episodes ?? [] });
      return { passed: true, report };
    } catch (e) {
      return { passed: false, code: e.code, message: e.message, report: e.report };
    }
  }

  /** 把大纲里的角色落成资产草稿（锁不足时用模板建议补齐到下限） */
  toAssetDrafts(outline) {
    const tpl = seeds.lockTemplate('character');
    return (outline?.characters ?? []).map((c, i) => {
      const locks = [...new Set([...(c.locks ?? []), ...tpl.suggested_locks])].slice(0, Math.max(4, (c.locks ?? []).length));
      return {
        asset_type: 'character',
        asset_code: c.code ?? `${LOCK_TEMPLATE_BY_TYPE.character}${String(i + 1).padStart(2, '0')}`,
        name: c.name ?? `角色${i + 1}`,
        locks,
        lock_values: { name: c.name ?? '' },
        meta: { traits: c.traits ?? '' },
      };
    });
  }

  // ——— 兜底生成器：不依赖模型也能产出合规结构 ———
  /** 剧本兜底：严格按总谱的 beat_no 展开，台词从种子库取，绝不改视听标注 */
  #fallbackScript(plan, outline) {
    const chars = outline?.characters ?? [];
    const speaker = chars[0]?.code ?? 'CH01';
    const rnd = mulberry32(seedFrom(plan.plan_id));
    return plan.episodes.map((ep) => ({
      no: ep.no,
      scenes: ep.beats.map((b) => {
        const pool = seeds.scriptLines(b.beat_purpose) ?? [];
        const line = pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
        // 集末 3 秒留白：不给对白，只留动作与定格
        const dialogue = b.is_episode_end || !line ? [] : [{ speaker, line }];
        return {
          beat_no: b.beat_no,
          action: `${b.beat_purpose}；${Object.values(b.emotions ?? {})[0] ?? 'EMO-CALM-02'} 的表演贯穿本场`,
          dialogue,
          // 视听标注回抄一份，供下游核对"剧本没有偷偷改镜别"
          locked: {
            shot_card: b.shot_card,
            lighting_codes: b.lighting_codes,
            transition: b.transition,
            rhythm_code: b.rhythm_code,
            emotions: b.emotions,
            grammar_recipe: b.grammar?.recipe ?? null,
          },
        };
      }),
    }));
  }

  #fallbackOutline({ prompt, spec, style, director }) {
    const stdEpSec = spec.episode_sec ?? 90;
    // 用户显式给了集数就按它来（自定义集数/时长时，按总分钟反推会错一集）
    const explicitEp = Number(spec.episode_count);
    const episodes = Number.isFinite(explicitEp) && explicitEp >= 1
      ? Math.min(200, Math.floor(explicitEp))
      : Math.max(1, Math.ceil(((spec.total_minutes ?? 10) * 60) / stdEpSec));
    // 总时长仍以 spec.total_minutes 为准（下游总谱自检会核对偏差 ≤2%），
    // 只是把这一段固定时长按「用户选的集数」均分，避免取整导致集数对不上。
    const totalSec = Number(spec.total_minutes ?? 10) * 60;
    const epSec = round2(totalSec / episodes);
    const lastEpSec = round2(totalSec - (episodes - 1) * epSec);
    const hooks = seeds.rhythmByCat('hook');
    const conflicts = seeds.rhythmByCat('conflict');
    const reversals = seeds.rhythmByCat('reversal');
    const empathies = seeds.rhythmByCat('empathy');
    const rnd = mulberry32(seedFrom(prompt));

    const chars = [
      { code: 'CH01', name: '主角', role: 'protagonist', traits: '被低估、隐忍、有底线', locks: [] },
      { code: 'CH02', name: '对手', role: 'antagonist', traits: '傲慢、掌控欲强', locks: [] },
      { code: 'CH03', name: '关键盟友', role: 'ally', traits: '忠诚、信息源', locks: [] },
    ].map((c) => ({ ...c, locks: seeds.lockTemplate('character').suggested_locks.slice(0, 4) }));

    // 共情集：至少 ceil(episodes/3) 个，先按每 3 集一个，不够再从末集往前补
    const needEmpathy = Math.ceil(episodes / 3);
    const empathySet = new Set();
    for (let i = 3; i <= episodes && empathySet.size < needEmpathy; i += 3) empathySet.add(i);
    for (let i = episodes; i >= 1 && empathySet.size < needEmpathy; i--) empathySet.add(i);

    const eps = [];
    for (let i = 1; i <= episodes; i++) {
      const isE1 = i === 1;
      const isE2 = i === 2;
      const isLast = i === episodes;
      const isPenult = i === episodes - 1;
      eps.push({
        no: i,
        goal: isE1 ? '建立困境与不公' : isLast ? '终局清算' : '冲突升级',
        hook: { code: (isE1 ? hooks[0] : hooks[Math.floor(rnd() * hooks.length)]).code, micro_hook: true, shots: 3 },
        conflicts: [
          { code: conflicts[Math.floor(rnd() * conflicts.length)].code, escalation: 2 },
          { code: conflicts[Math.floor(rnd() * conflicts.length)].code, escalation: 3 },
          { code: 'CFL-07', escalation: 4 },
        ],
        reversals: isE2
          ? [{ code: 'REV-01', foreshadow: 2 }]
          : isPenult
            ? [{ code: 'REV-12', foreshadow: 3 }]
            : i % 3 === 0
              ? [{ code: reversals[Math.floor(rnd() * reversals.length)].code, foreshadow: 2 }]
              : [],
        empathy: empathySet.has(i) ? [{ code: empathies[Math.floor(rnd() * empathies.length)].code }] : [],
        ending_hook: '悬念未解',
        duration_sec: i === episodes ? lastEpSec : epSec,
      });
    }

    // 短剧兜底：4 集以内的项目按“每 3 集一次反转”会凑不满 3 次结构级反转，
    // 这里补齐到闸门下限，避免 5 分钟项目在 N03 被自己的节奏闸门卡死。
    let revCount = eps.reduce((a, e) => a + e.reversals.length, 0);
    while (revCount < 3) {
      let added = false;
      for (const e of eps) {
        if (revCount >= 3) break;
        if (e.reversals.length === 0) {
          e.reversals.push({ code: 'REV-12', foreshadow: 3 });
          revCount += 1;
          added = true;
        }
      }
      if (!added) {
        // 极端短剧（1–2 集）：允许同一集叠加结构级反转
        eps[eps.length - 1].reversals.push({ code: 'REV-12', foreshadow: 3 });
        revCount += 1;
      }
    }
    return { title: (prompt || '未命名').slice(0, 20), logline: prompt, characters: chars, episodes: eps };
  }

  #pickShotCard(shotMix, index, total) {
    const keys = Object.keys(shotMix).length ? Object.keys(shotMix) : ['MS', 'MCU', 'CU'];
    const pick = weightedPick(Object.fromEntries(keys.map((k) => [k, shotMix[k] ?? 1]))) ?? 'MS';
    // 风格里的 shot_mix 用的是简称（MS/MCU/CU/LS/ECU/OTS/POV/LOW/HAND/SYM/FS），映射到镜头卡编码
    const map = {
      LS: 'SHT-WS', FS: 'SHT-FS', MS: 'SHT-MS', MCU: 'SHT-MCU', CU: 'SHT-CU', ECU: 'SHT-ECU',
      OTS: 'SHT-OSS', POV: 'SHT-POV', LOW: 'SHT-LOW', HIGH: 'SHT-HIGH', HAND: 'SHT-HAND', SYM: 'SHT-EYE',
    };
    // 开场用全景建置，结尾用特写收束
    if (index === 1) return 'SHT-WS';
    if (index === total) return 'SHT-CU';
    return map[pick] ?? 'SHT-MS';
  }

  #pickMove(director, shotCard) {
    const bias = director?.camera_move_bias ?? {};
    const pick = weightedPick(bias) ?? 'SHT-STATIC';
    // 甩镜自带转场，避免与固定镜头冲突导致动作过猛
    if (pick === 'SHT-WHIP' && shotCard === 'SHT-ECU') return 'SHT-STATIC';
    return pick;
  }

  #pickTransition({ style = null, director, isOpen, isEnd, index, nonHardUsed = 0, maxNonHard = 0, secSinceLastNonHard = Infinity, secToEpisodeEnd = Infinity }) {
    // 集末强制定格/入黑（§7.3 规则 5），不受配额限制
    if (isEnd) return { code: 'TRN-FREEZE', reason: '集末定格留住悬念' };
    if (isOpen && index === 1) return { code: 'TRN-HARDCUT', reason: null };
    // 距集末太近：让位给集末定格，保证两个非硬切间隔 ≥ 8.5 秒（§7.3 规则 6）
    if (secToEpisodeEnd < 8.5) return { code: 'TRN-HARDCUT', reason: null };

    // V4.13：风格的转场偏好也要参与（以前只读导演，32 个风格的 transition_bias 等于白写）
    const bias = {};
    for (const [src, w] of [[style?.transition_bias, 1], [director?.transition_bias, 0.5]]) {
      for (const [code, weight] of Object.entries(src ?? {})) {
        if (!seeds.transition(code)) continue;
        const n = Number(weight);
        if (!Number.isFinite(n) || n <= 0) continue;
        bias[code] = (bias[code] ?? 0) + n * w;
      }
    }
    const pick = weightedPick(Object.keys(bias).length ? bias : { 'TRN-HARDCUT': 1 }) ?? 'TRN-HARDCUT';
    if (pick === 'TRN-HARDCUT') return { code: pick, reason: null };

    // 配额用尽 → 硬切
    if (nonHardUsed >= maxNonHard) return { code: 'TRN-HARDCUT', reason: null };
    // 两个非硬切之间必须间隔 ≥ 8.5 秒（留 0.5s 余量，避免浮点边界误判）
    if (secSinceLastNonHard < 8.5) return { code: 'TRN-HARDCUT', reason: null };

    return { code: pick, reason: '情绪/时间衔接' };
  }
}

function pickMotionLighting(style, i) {
  const motion = seeds.lightingCards.filter((c) => c.cat === 'motion' && !(style.lighting_cards_forbidden ?? []).includes(c.code));
  if (!motion.length) return null;
  return motion[i % motion.length].code;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 节奏条目去重（按 code），顺带丢掉空项：合并集数时保住反转/共情点不重复堆叠 */
function dedupeCodes(list = []) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const code = typeof x === 'string' ? x : x?.code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(typeof x === 'string' ? { code } : x);
  }
  return out;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function safeParseJson(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const o = JSON.parse(s);
    return o && Array.isArray(o.episodes) ? o : null;
  } catch {
    return null;
  }
}

function safeParseJsonScript(text) {
  if (!text) return null;
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const o = JSON.parse(s);
    return o && Array.isArray(o.episodes) && o.episodes.some((e) => Array.isArray(e.scenes)) ? o : null;
  } catch {
    return null;
  }
}

export const storyEngine = new StoryEngine();
export default storyEngine;
