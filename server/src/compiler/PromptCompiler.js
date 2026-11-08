/**
 * 提示词编译器 V3 —— 全系统唯一的"生成请求"生产者（§12）。
 *
 * 强制链：任何生成 → PromptCompiler.compile() → RelayAdapter.call() → 上游。
 * compile() 产出的 payload 带 _stamp；RelayAdapter 校验 stamp 才放行，
 * 因此"绕过编译器直接调模型"在代码层不可能，且被单元测试断言。
 *
 * 六段：P1 总设定 / P2 角色与连续性 / P3 镜头语言 / P4 光影 / P5 动作与反馈 / P6 转场与声音
 */
import seeds from '../seeds/loader.js';
import { modelRegistry } from '../relay/ModelRegistry.js';
import { issueStamp } from '../relay/RelayAdapter.js';
import { fail, ERR, AppError } from '../core/errors.js';
import { logger } from '../core/redact.js';
import { seedFrom, round, clamp } from '../core/util.js';
import {
  segmentGlobal,
  segmentContinuity,
  segmentEmotion,
  segmentCamera,
  segmentGrammar,
  segmentLighting,
  segmentAction,
  segmentTransitionSound,
  buildNegative,
  aspectRules,
} from './segments.js';
import * as V from './validators.js';
import * as prompts from '../prompts/PromptLibrary.js';
import * as specLib from '../prompts/SpecLibrary.js';
import { qualityOf } from '../core/frame.js';
import { guardCompile } from '../qc/ConsistencyGuard.js';
import promptBudget from '../director/PromptBudget.js';

export class PromptCompiler {
  /**
   * @param {object} req 见文件头《输入契约》
   * @returns {object} §12.3 编译输出契约 + _stamp
   */
  compile(req) {
    const warnings = [];
    const kind = req.kind ?? 'image';
    const isText = kind === 'chat' || kind === 'text';
    const isVideo = kind === 'video';

    // —— 文本环节：走轻量分支（仍需过内容安全与余额）——
    if (isText) return this.#compileText(req);

    // —— 资产设定图（V4.10）：角色 / 场景 / 道具的定妆图，不按分镜拍 ——
    // 为什么不复用分镜分支：分镜要求「画面里的角色必须有已出图的资产」，
    // 而这一步**就是在造那个资产**，走分镜分支必然自锁（先有图才能出图）。
    if (req.options?.mode === 'asset_sheet') return this.#compileAssetSheet(req);

    // —— P1：风格与导演 ——
    const style = seeds.style(req.project?.style_code);
    if (!style) fail(ERR.BAD_REQUEST, `风格不存在: ${req.project?.style_code}`);
    const director =
      seeds.director(req.project?.director_code) ?? seeds.director(style.director_profile_default);
    if (!director) fail(ERR.BAD_REQUEST, '未指定导演原型且风格没有默认值');

    // —— P0：用户规格（V4.12）——
    // 画幅/画质/时长/片型/色板是用户在开机页点的，属于"不可谈判"的约束，
    // 所以比风格段更靠前，并且由 SpecLibrary 统一翻译成指令，不再散落成一句 "9:16 framing"。
    const spec = specLib.normalize(
      { ...(req.project ?? {}), palette: req.project?.palette?.length ? req.project.palette : (style.palette ?? []) },
      { strict: true },
    );
    for (const f of spec.defaulted ?? []) {
      warnings.push({ code: 'SPEC_DEFAULTED', issue: `规格 ${f} 未指定，已按默认值 ${spec[f]} 执行` });
    }

    const aspect = spec.aspect;
    const quality = spec.quality;
    const duration = req.shot?.duration ?? style.avg_shot_len;

    // —— P3：镜头卡 ——
    const shotCard = V.checkShotCard({ shotCardCodes: [req.shot?.shot_card] });
    const moveCard = req.shot?.camera_move ? seeds.shot(req.shot.camera_move) : null;
    if (moveCard && moveCard.dim !== 'movement') {
      fail(ERR.MISSING_DIRECTOR_CARD, `运镜卡必须是 movement 维度: ${moveCard.code}`);
    }

    // —— P4：光影卡（风格强制 + 导演偏好 + 显式指定，剔除风格禁止项）——
    const forbidden = new Set(style.lighting_cards_forbidden ?? []);
    // 显式指定的禁止卡 → 直接报错（而不是静默剔除，避免用户以为生效了）
    for (const c of req.lighting?.codes ?? []) {
      if (forbidden.has(c)) {
        fail(ERR.STYLE_FORBIDDEN_LIGHTING, `风格 ${style.name} 禁止光影卡 ${c}`, { style: style.code, card: c });
      }
    }
    const merged = [
      ...(style.lighting_cards_required ?? []),
      ...(req.lighting?.codes ?? []),
      ...(req.lighting?.motion_code ? [req.lighting.motion_code] : []),
      ...(director.lighting_bias ?? []),
    ].filter((c) => !forbidden.has(c));
    // 去重后取前 3 张（避免提示词过长导致模型忽略）
    const lightingCodes = [...new Set(merged)].slice(0, 3);
    const lightingCards = V.checkLighting({ lightingCodes, style });

    // —— P2：资产与连续性锁 ——
    const characterAssets = (req.shot?.characters ?? [])
      .map((code) => req.assets?.characters?.[code])
      .filter(Boolean);
    const sceneAsset = req.shot?.scene ? req.assets?.scenes?.[req.shot.scene] : null;
    const propAssets = (req.shot?.props ?? []).map((code) => req.assets?.props?.[code]).filter(Boolean);
    const locks = [
      ...characterAssets.flatMap((c) => c.locks ?? []),
      ...(sceneAsset?.locks ?? []),
      ...propAssets.flatMap((p) => p.locks ?? []),
    ];
    V.checkContinuityLocks({ locks });

    // 视觉依据覆盖
    V.checkVisualBasis({
      characters: req.shot?.characters ?? [],
      assetMap: req.assets?.characters ?? {},
      offscreen: req.shot?.offscreen ?? [],
    });

    // —— P2.5：情绪表演（第 13 条强制链）——
    // 情绪是资产：画面中在场的每个角色都必须绑定情绪卡，没有情绪的表演 = 面瘫。
    const offscreen = new Set(req.shot?.offscreen ?? []);
    const onScreen = (req.shot?.characters ?? []).filter((c) => !offscreen.has(c));
    const emotionMap = { ...(req.emotion_map ?? {}), ...(req.shot?.emotions ?? {}) };
    const emotionAssets = req.assets?.emotions ?? {};
    const emo = V.checkEmotion({
      characters: onScreen,
      emotionMap,
      emotionAssets,
      duration,
      speaker: req.shot?.speaker ?? null,
      shotCard: shotCard.code,
      lightingCodes,
      allowNeutral: !!req.options?.allow_neutral_emotion,
    });
    for (const w of emo.warnings) warnings.push(w);

    // —— 参考图 ——
    const references = [];
    let order = 1;
    for (const c of characterAssets) {
      references.push({
        url: c.image_url ?? null,
        role: 'character',
        asset_code: c.asset_code,
        order: order++,
        controls: '面部与服装',
        required: true,
      });
    }
    if (sceneAsset) {
      references.push({
        url: sceneAsset.image_url ?? null,
        role: 'scene',
        asset_code: sceneAsset.asset_code,
        order: order++,
        controls: '空间与光照',
        required: true,
      });
    }
    if (isVideo) {
      references.push({
        url: req.shot?.first_frame_url ?? null,
        role: 'first_frame',
        asset_code: `${req.shot_no ?? 'shot'}-img`,
        order: order++,
        controls: '起始构图',
        required: true,
      });
    }
    // —— 用户素材参考（V4.12）——
    // 之前这批图只是被塞进 options 里，编译器根本没读，等于"上传了没生效"。
    // 它们是**画风倾向**参考，不是一致性依据，所以 required=false：缺图不拦，有图就真的进请求。
    const materialRefs = (req.options?.material_references ?? []).filter((m) => m?.url);
    for (const m of materialRefs.slice(0, 3)) {
      references.push({
        url: m.url,
        role: 'style_reference',
        asset_code: m.name ?? `material-${order}`,
        order: order++,
        controls: '画风与配色倾向',
        required: false,
      });
    }

    // —— 模型 ——
    const modelCode =
      req.model ?? modelRegistry.defaultFor(isVideo ? 'video' : kind === 'audio' ? 'audio' : 'image');
    const model = modelRegistry.get(modelCode);
    if (req.options?.purpose === 'delivery' && model.commercial_ok === false) {
      fail(ERR.MODEL_NOT_COMMERCIAL, `模型 ${modelCode} 不允许商业交付`);
    }

    // —— 成本估算 ——
    const estimatedCredits = this.estimate({ kind, model, duration, quality });

    // —— 校验：时长 / 参考图 / 对白 / 说话人 / 转场 / BGM / 安全 / 余额 ——
    V.checkDuration({ kind, shotDuration: req.shot?.duration, requestedDuration: req.shot?.duration });
    const refCheck = V.checkReferences({
      kind,
      references,
      allowPending: !!req.options?.allow_pending_reference,
      pendingPlan: req.options?.pending_plan,
    });
    const dlg = V.checkDialogue({ dialogue: req.shot?.dialogue, duration });
    const spk = V.checkSpeaker({
      dialogue: req.shot?.dialogue,
      speaker: req.shot?.speaker,
      onScreenCharacters: req.shot?.characters ?? [],
    });
    const trn = V.checkTransition({
      transitionCode: req.transition?.code ?? 'TRN-HARDCUT',
      transitionReason: req.transition?.reason,
    });
    const bgm = V.checkBgm({ bgmTrackId: req.bgm_track_id });
    if (bgm && bgm.attribution_required) {
      warnings.push(`曲目 ${bgm.track_id} 需署名，渲染时必须在片尾追加署名行`);
    }

    const safe = V.checkContentSafety([
      req.shot?.action_start ?? '',
      req.shot?.action_end ?? '',
      req.shot?.dialogue ?? '',
      ...(req.shot?.ambient ?? []),
    ]);
    for (const w of safe.warnings) warnings.push(`含敏感要素需人工确认：${w}`);

    // —— 五维一致性闸门（V4.11 底层强制）——
    // 为什么在这里也要跑一遍：GenerateService 是唯一出图出口，但它只拿得到 compileRequest。
    // 把结构一致性（角色/道具/场景/内容/声音字幕）放在编译期，等于"花钱之前就拦住"。
    // 是否启用由服务端（GenerateService）决定，前端无法关闭，也不会被 /compile/preview 误伤。
    if (req.options?.enforce_consistency) {
      const guard = guardCompile({
        shot: req.shot,
        assets: req.assets,
        libraries: { sync: req.libraries?.sync ?? null },
      });
      if (!guard.ok) {
        fail(ERR.CONSISTENCY_VIOLATION, `五维一致性未通过，已拒绝生成：${guard.hard.slice(0, 4).join('；')}`, {
          shot_no: req.shot_no ?? null,
          dims: guard.dims,
        });
      }
      for (const dim of Object.values(guard.dims)) {
        for (const w of dim.warnings) warnings.push(`一致性提示：${w}`);
      }
    }

    V.checkCredits({ availableCredits: req.available_credits, estimatedCredits });

    // —— P3.5：大师语法（构图 / 焦段 / 调色 / 氛围，可选）——
    // 只在显式传入 grammar 时生效：既有调用零影响；传了就必须每张卡都真实存在。
    const grammarCards = this.#resolveGrammar(req.grammar, warnings);

    // —— 拼装六段（前面加 P0 用户规格段）——
    const s0 = specLib.segments(spec, { kind, shotDuration: duration });
    const s1 = segmentGlobal({ style, director, aspect, duration, quality, emotion: req.shot?.emotion });
    const s2 = segmentContinuity({ characterAssets, sceneAsset, propAssets, locks: [] });
    const s25 = segmentEmotion({
      resolved: emo.resolved,
      isVideo,
      duration,
      speaker: req.shot?.speaker ?? null,
      characterNames: Object.fromEntries(characterAssets.map((c) => [c.asset_code, c.name ?? c.asset_code])),
    });
    const s3 = segmentCamera({ shotCard, moveCard, aspect });
    const s35 = segmentGrammar({
      composition: grammarCards.composition,
      lens: grammarCards.lens,
      color: grammarCards.color,
      atmosphere: grammarCards.atmosphere,
      recipeName: grammarCards.recipe?.name ?? null,
      intent: grammarCards.recipe?.intent ?? null,
      why: grammarCards.recipe?.why ?? null,
    });
    const s4 = segmentLighting({ lightingCards, colorTemp: director.color_temp });
    const s5 = segmentAction({
      actionStart: req.shot?.action_start,
      actionEnd: req.shot?.action_end,
      actionStartZh: req.shot?.action_start_zh,
      actionEndZh: req.shot?.action_end_zh,
      ambient: req.shot?.ambient ?? [],
      reactions: req.shot?.reactions ?? [],
    });
    const s6 = segmentTransitionSound({
      transitionCard: trn.card,
      ambientSound: req.shot?.ambient_sound,
      musicEntry: req.shot?.music_entry,
      dialogue: req.shot?.dialogue,
      silentOthers: spk.silentOthers,
    });

    // V4.4：分镜图/音视频环节强制带上运镜·光影·转场·特效（视频另加配乐与情绪）
    const libStage = kind === 'image' ? 'storyboard' : 'media';
    const lib = prompts.compose(libStage, {
      ...(req.libraries ?? {}),
      movement: req.libraries?.movement ?? moveCard?.code ?? null,
      transition: req.libraries?.transition ?? trn.code ?? null,
      lighting: req.libraries?.lighting ?? (Array.isArray(lightingCodes) ? lightingCodes[0] : lightingCodes) ?? null,
      emotion: req.libraries?.emotion ?? null,
      // 第十个库：用户规格契约（缺了就是 PROMPT_LIBRARY_MISSING，任何环节都别想漏带用户的要求）
      __spec: { code: s0.code, text: s0.zh },
    });
    if (lib.missing.length) {
      fail('PROMPT_LIBRARY_MISSING', `提示词库不完整，缺少：${lib.missing.map((m) => m.name).join('、')}`, { missing: lib.missing });
    }
    const libText = prompts.toPromptText(lib);
    const enParts = [s0.en, s1.en, s2.en, s25.en, s3.en, s35.en, s4.en, s5.en, s6.en].filter(Boolean);
    const zhParts = [s0.zh, s1.zh, s2.zh, s25.zh, s3.zh, s35.zh, s4.zh, s5.zh, s6.zh].filter(Boolean);
    const neg = buildNegative({
      style,
      director,
      emotionCards: emo.cards,
      extra: req.negative_extra ?? [],
    });

    const a = aspectRules(aspect);
    const resolution = spec.resolution;
    const seed = req.options?.seed ?? seedFrom(`${req.shot_no}|${modelCode}|${enParts.join('')}|${req.shot?.take ?? 0}`);

    // —— 提示词预算体检（V4.17）：只算账、只告警，不改写提示词 ——
    const budget = promptBudget.audit({
      prompt: `${libText} ${enParts.join(' ')}. ${neg.en}.`,
      negative: neg.en,
      references: references.filter((r) => r.url),
    });
    for (const line of promptBudget.warningLines(budget)) warnings.push(line);

    const payload = {
      shot_no: req.shot_no ?? null,
      kind,
      target_model: modelCode,
      prompt_en: `${libText} ${enParts.join(' ')}. ${neg.en}.`,
      prompt_zh: `${zhParts.join('')}${libText}负面排除：${neg.zh}。`,
      negative: neg.en,
      reference_images: references.filter((r) => r.url),
      pending_reference_plan: refCheck.pending.map((r) => ({ role: r.role, asset_code: r.asset_code })),
      params: {
        duration: isVideo ? clamp(duration, 2, 10) : undefined,
        resolution,
        aspect,
        seed,
        cfg: style.model_params?.[isVideo ? 'video' : 'image']?.cfg ?? 3.5,
        ...(kind === 'audio' ? { voice: req.shot?.voice ?? 'default' } : {}),
      },
      cards: {
        shot: shotCard.code,
        move: moveCard?.code ?? null,
        lighting: lightingCodes,
        transition: trn.code,
        style: style.code,
        director: director.code,
        rhythm: req.rhythm?.code ?? null,
        recipe: grammarCards.recipe?.code ?? null,
        composition: grammarCards.composition?.code ?? null,
        lens: grammarCards.lens?.code ?? null,
        color: grammarCards.color?.code ?? null,
        atmosphere: grammarCards.atmosphere?.code ?? null,
        spec: s0.code,
        emotion: Object.fromEntries(
          Object.entries(emo.resolved).map(([k, v]) => [k, v?.card?.code ?? null])
        ),
      },
      continuity_locks: locks,
      dialogue_check: dlg,
      // V4.17：提示词预算体检。超字数/多参考图同框/参考图与文字重描打架，
      // 这三类是"扣了钱但效果莫名变差"的常见原因，必须在发请求前就说清。
      budget,
      estimated_credits: estimatedCredits,
      compile_warnings: warnings,
      compiled_at: new Date().toISOString(),
      meta: {
        vertical: a.vertical,
        quality,
        purpose: req.options?.purpose ?? 'preview',
        bgm: bgm?.track_id ?? null,
        // 规格快照：事后核对「这张图是不是按用户点选做的」不需要再去翻项目
        spec: {
          code: s0.code,
          aspect: spec.aspect,
          resolution: spec.resolution,
          quality: spec.quality,
          video_type: spec.video_type,
          shot_sec: Number(duration) || null,
        },
      },
      prompt_libraries: {
        stage: libStage,
        blocks: lib.blocks,
        missing: lib.missing,
        digest: digestOf(lib),
      },
    };

    payload._stamp = issueStamp(payload);
    logger.debug('编译完成', {
      shot: payload.shot_no,
      model: modelCode,
      credits: estimatedCredits,
      cards: payload.cards,
    });
    return payload;
  }

  /**
   * 解析大师语法段。
   * 契约：传了就严格校验（code 必须真实存在），没传就整段跳过。
   * 为什么不静默兜底：配方/构图卡写错还照常出图，用户会拿到一张"看起来正常但没按大师语法拍"的图，
   * 比直接报错更难排查。
   */
  #resolveGrammar(grammar, warnings = []) {
    const empty = { recipe: null, composition: null, lens: null, color: null, atmosphere: null };
    if (!grammar) return empty;

    const out = { ...empty };
    if (grammar.recipe) {
      out.recipe = seeds.recipe(grammar.recipe);
      if (!out.recipe) fail(ERR.MISSING_DIRECTOR_CARD, `语法配方不存在: ${grammar.recipe}`);
    }
    for (const [field, lookup, label] of [
      ['composition', 'composition', '构图卡'],
      ['lens', 'lens', '焦段卡'],
      ['color', 'colorGrade', '调色卡'],
      ['atmosphere', 'atmosphere', '氛围卡'],
    ]) {
      const code = grammar[field];
      if (!code) continue;
      const card = seeds[lookup](code);
      if (!card) fail(ERR.MISSING_DIRECTOR_CARD, `${label}不存在: ${code}`);
      out[field] = card;
    }
    // 光学一致性：远景建置镜头不该出现 85mm/135mm 长焦（规划层已处理，这里只做兜底提示）
    const focal = Number(String(out.lens?.code ?? '').match(/LNS-(\d+)MM/)?.[1] ?? 0);
    if (focal >= 85 && ['SHT-WS', 'SHT-EWS'].includes(grammar.shot_card)) {
      warnings.push({ code: 'GRAMMAR_LENS_MISMATCH', issue: `${out.lens.code} 长焦配远景，透视会被压平` });
    }
    return out;
  }

  /** 文本环节（剧本 / 分镜 / 节奏诊断）：轻量分支，仍过安全与余额 */
  /**
   * 资产设定图（V4.10）。
   *
   * 输入：req.asset = { asset_code, asset_type, name, locks[], lock_values{}, meta{} }
   * 输出：与分镜图同构的 payload（带 _stamp），这样金额、归档、质检链路完全复用。
   *
   * 与分镜图的差别只有三处，且都是必须的：
   *  1. 不带参考图（此刻还没有图，pending 允许）
   *  2. 不校验情绪卡（定妆图是中性表情）
   *  3. 构图是"设定图构图"而不是镜头卡构图
   */
  #compileAssetSheet(req) {
    const asset = req.asset ?? {};
    const assetType = asset.asset_type ?? 'character';
    const locks = (asset.locks ?? []).filter(Boolean);
    V.checkContinuityLocks({ locks });
    // 模板下限也要守住：卡上只有一条锁就出图，等于没有一致性可言
    const tpl = seeds.lockTemplate(assetType);
    if (tpl && locks.length < (tpl.required_lock_count ?? 0)) {
      fail(
        ERR.MISSING_CONTINUITY_LOCK,
        `${assetType} 资产至少需要 ${tpl.required_lock_count} 条连续性锁，当前只有 ${locks.length} 条`,
        { got: locks.length, template: tpl.suggested_locks },
      );
    }

    const style = seeds.style(req.project?.style_code);
    if (!style) fail(ERR.BAD_REQUEST, `风格不存在: ${req.project?.style_code}`);
    const director =
      seeds.director(req.project?.director_code) ?? seeds.director(style.director_profile_default);

    // 设定图沿用用户选的**画幅**与画质（V4.13）。
    // 旧实现把设定图固定成 1:1：用户点 9:16 竖屏，资产图却是方图，等于一进资产环节就偏离规格；
    // 一致性锁在提示词里，不靠"方图更好用"来决定用户的选择。
    const spec = specLib.normalize(
      { ...(req.project ?? {}), palette: req.project?.palette?.length ? req.project.palette : (style.palette ?? []) },
      { strict: true },
    );
    const sheetSpec = { ...spec };
    const s0 = specLib.segments(sheetSpec, { kind: 'image' });
    const aspect = sheetSpec.aspect;
    const quality = sheetSpec.quality;
    const typeCn = { character: '角色定妆图', scene: '场景概念图', prop: '道具设定图' }[assetType] ?? '资产设定图';
    // 用户手写的提示词排在最前（人写的优先于机器抽的），其余设定依次补充（V4.14）
    const desc = [
      asset.lock_values?.prompt, asset.lock_values?.traits, asset.lock_values?.role, asset.lock_values?.desc,
      asset.meta?.traits, asset.meta?.desc,
    ].filter(Boolean).join('；');
    // 本地参考图（V4.14）：用户上传的照片作为"长相/结构依据"进参考图列表
    const userRefs = (req.options?.reference_images ?? []).filter((r) => r && r.url).slice(0, 4);

    const framing = assetType === 'character'
      ? '构图：单人全身入画，正面偏 3/4 角度，中性表情，纯浅灰背景，柔和顶光，便于后续镜头保持同一张脸'
      : assetType === 'scene'
        ? '构图：广角全景，空间结构完整，画面中不出现人物，光源方向清晰，便于作为镜头背景参考'
        : '构图：单件道具居中，45 度视角，材质与做旧程度清楚，浅灰背景';

    const zh = [
      `【${typeCn}】${asset.name ?? asset.asset_code ?? ''}`,
      `画面风格：${style.name}（${style.art_prompt_zh}）`,
      `必须保持一致的特征：${locks.join('、')}`,
      desc ? `设定补充：${desc}` : '',
      framing,
      '不要文字、水印、贴纸、拼图、多视角分格',
    ].filter(Boolean).join('\n');

    const en = [
      `${typeCn === '角色定妆图' ? 'character reference sheet' : assetType === 'scene' ? 'scene concept art' : 'prop design sheet'}`,
      `${asset.name ?? ''}`,
      `style: ${style.art_prompt_en ?? style.name}`,
      `consistent features: ${locks.join(', ')}`,
      'single subject, neutral background, clean lighting, no text, no watermark, no collage',
    ].filter(Boolean).join(', ');

    const neg = buildNegative({
      style, director, emotionCards: [],
      extra: ['text', 'watermark', 'collage', 'multiple views', 'split screen'],
    });
    const modelCode = req.model ?? modelRegistry.defaultFor('image');
    const model = modelRegistry.get(modelCode);
    const duration = req.shot?.duration ?? style.avg_shot_len;
    const estimatedCredits = this.estimate({ kind: 'image', model, duration, quality });
    V.checkContentSafety([zh, en]);
    V.checkCredits({ availableCredits: req.available_credits, estimatedCredits });

    const payload = {
      shot_no: req.shot_no ?? `${asset.asset_code ?? 'asset'}-sheet`,
      kind: 'image',
      asset_sheet: true,
      asset_code: asset.asset_code ?? null,
      asset_type: assetType,
      target_model: modelCode,
      prompt_en: `${s0.en} ${en}. ${neg.en}.`,
      prompt_zh: `${s0.zh}${zh}。负面排除：${neg.zh}。`,
      negative: neg.en,
      // 参考图：用户上传的本地照片（V4.14）。有图就必须真的进请求，
      // 否则用户会觉得"传了没生效"——这正是 V4.12 修过的那类假生效。
      reference_images: userRefs.map((r, i) => ({
        url: r.url,
        role: i === 0 ? 'identity_reference' : 'style_reference',
        asset_code: asset.asset_code ?? null,
        order: i + 1,
        controls: i === 0 ? '长相 / 结构' : '服装与氛围',
        required: false,
      })),
      pending_reference_plan: userRefs.length
        ? []
        : [{ role: assetType, asset_code: asset.asset_code ?? null }],
      params: {
        resolution: sheetSpec.resolution,
        aspect,
        seed: req.options?.seed ?? seedFrom(`${asset.asset_code}|${modelCode}|${en}`),
        cfg: style.model_params?.image?.cfg ?? 3.5,
      },
      cards: {
        shot: 'SHEET',
        move: null,
        lighting: [],
        transition: null,
        style: style.code,
        director: director?.code ?? null,
        spec: s0.code,
      },
      continuity_locks: locks,
      dialogue_check: { units: 0, max: 0 },
      estimated_credits: estimatedCredits,
      compile_warnings: [],
      compiled_at: new Date().toISOString(),
      meta: {
        vertical: aspectRules(aspect).vertical,
        quality,
        purpose: req.options?.purpose ?? 'preview',
        asset_sheet: true,
        spec: { code: s0.code, aspect, resolution: sheetSpec.resolution, quality, video_type: spec.video_type },
      },
      // 设定图也必须挂上规格库，否则 RelayAdapter 的库闸门会拦（这是有意的）
      prompt_libraries: (() => {
        const lib = prompts.compose('character', {
          ...(req.libraries ?? {}),
          __spec: { code: s0.code, text: s0.zh },
        });
        return { stage: 'character', blocks: lib.blocks, missing: lib.missing, digest: digestOf(lib) };
      })(),
    };
    payload._stamp = issueStamp(payload);
    return payload;
  }

  #compileText(req) {
    // V4.4：剧本/角色环节必须带上内置提示词库（情绪 + 节奏 / 情绪 + 光影）
    const stage = req.stage === 'character' ? 'character' : 'script';
    // V4.12：文本环节同样受用户规格约束——集数、单集时长、画幅、片型都是结构承诺，
    // 不能只写在 user 的一句话里靠模型自觉（模型想写几集就几集，下游总谱必然对不上）。
    const spec = specLib.normalize(req.project ?? {}, { strict: true });
    const rules = specLib.textRules(spec, { stage: 'outline' });
    const lib = prompts.compose(stage, {
      ...(req.libraries ?? {}),
      __spec: { code: rules.code, text: rules.zh },
    });
    if (lib.missing.length) {
      fail('PROMPT_LIBRARY_MISSING', `提示词库不完整，缺少：${lib.missing.map((m) => m.name).join('、')}`, { missing: lib.missing });
    }
    const libText = prompts.toPromptText(lib);
    const base = req.messages ?? [
      { role: 'system', content: req.system ?? '你是一位专业的短剧编剧。' },
      { role: 'user', content: req.user ?? '' },
    ];
    // 库约束放在 system 之后、user 之前，保证模型先读到硬规则再动笔
    const messages = req.messages
      ? [...base, { role: 'system', content: libText }]
      : [base[0], { role: 'system', content: libText }, base[1]];
    const modelCode = req.model ?? modelRegistry.defaultFor('chat');
    const model = modelRegistry.get(modelCode);
    const join = messages.map((m) => m.content).join('\n');
    V.checkContentSafety([join]);
    const estimatedCredits = this.estimate({ kind: 'chat', model, tokens: req.max_tokens ?? 2000 });
    V.checkCredits({ availableCredits: req.available_credits, estimatedCredits });

    const payload = {
      shot_no: null,
      kind: 'chat',
      target_model: modelCode,
      prompt_en: join,
      prompt_zh: join,
      negative: '',
      messages,
      reference_images: [],
      pending_reference_plan: [],
      params: { temperature: req.temperature ?? 0.8, max_tokens: req.max_tokens ?? 2000 },
      cards: { style: req.project?.style_code ?? null, spec: rules.code },
      continuity_locks: [],
      estimated_credits: estimatedCredits,
      compile_warnings: [],
      compiled_at: new Date().toISOString(),
      meta: {
        purpose: req.options?.purpose ?? 'preview',
        spec: {
          code: rules.code, aspect: spec.aspect, resolution: spec.resolution, quality: spec.quality,
          episodes: spec.episodes, episode_sec: spec.episode_sec, video_type: spec.video_type,
        },
      },
      prompt_libraries: { stage, blocks: lib.blocks, missing: lib.missing, digest: digestOf(lib) },
    };
    payload._stamp = issueStamp(payload);
    return payload;
  }

  /**
   * 成本估算（点数）。上游报价 × 用量系数 × 画质系数。
   * 与 ModelRegistry.quotePoints 保持同一换算口径。
   * 画质系数从 core/frame 取（V4.12 之前 2K 落到 0.6 倍，比 1080P 还便宜，
   * 等于"选最高画质最省钱"，用户完全无法理解）。
   */
  estimate({ kind, model, duration = 5, quality = '1080p', tokens = 2000 }) {
    const base = modelRegistry.quotePoints(model);
    const q = qualityOf(quality) ?? qualityOf('1080p');
    if (kind === 'video') {
      const units = Math.max(1, Math.ceil(duration / 5));
      return Math.max(1, Math.ceil(base * units * q.factor));
    }
    if (kind === 'chat' || kind === 'text') {
      return Math.max(1, Math.ceil((base * tokens) / 1000));
    }
    if (kind === 'audio') return Math.max(1, base);
    // 出图：1080P 保持原价（不因这次改动涨价），720P 略便宜，2K 比 1080P 贵
    return Math.max(1, Math.ceil(base * q.img_factor));
  }

  /** 只做校验不产出请求（用于分镜表批量体检） */
  validateOnly(req) {
    try {
      const p = this.compile(req);
      return { ok: true, credits: p.estimated_credits, warnings: p.compile_warnings };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, code: e.code, message: e.message, detail: e.detail };
      throw e;
    }
  }
}


/** 库内容指纹：同样的库与选择 → 同样的指纹，便于审计「这条片子用了哪套约束」 */
function digestOf(lib) {
  const raw = `${lib.stage}|${lib.blocks.map((b) => `${b.kind}:${b.code}`).join(',')}`;
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const compiler = new PromptCompiler();
export default compiler;
