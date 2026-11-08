/**
 * 镜头生产（V4.2 / V4.11）：在**项目内**按分镜号生成关键帧 / 视频。
 *
 * 为什么放在服务端拼 compileRequest：
 *  - 12 条编译校验的输入（镜头卡、光影、情绪、连续性锁、参考图）必须来自总谱与资产库，
 *    不允许前端自己拼 —— 否则用户能绕过总谱直接出图，一致性锁形同虚设。
 *  - 这里只负责"按总谱执行"，不改写任何镜别/光影/转场。
 *
 * V4.11 三处增强（用户可手动更改 / 重新生成 / 一致性强制）：
 *  1. 生成前过虚拟导演闸门（该环节的运镜/光影/情绪/转场库必须落实）与五维一致性闸门；
 *  2. updateShot()：允许人工改写镜别/运镜/光影/情绪/对白等，改写会同步回总谱并记录 override；
 *  3. regenerateShot() / pick()：单镜重出（图或视频）与多版本选定，选定结果被剪辑直接采纳。
 */
import { db } from '../store/db.js';
import { generateService } from './GenerateService.js';
import { materialService } from '../assets/MaterialService.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import { assetLibrary } from '../assets/AssetLibrary.js';
import { directorAgent } from '../director/DirectorAgent.js';
import { consistencyGuard } from '../qc/ConsistencyGuard.js';
import { assembly } from './Assembly.js';
import { stageOptions, stageOfShot } from './StageOptions.js';
import { aspectOf, qualityOf } from '../core/frame.js';
import seeds from '../seeds/loader.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';

const PROJECT = 'projects';
const PLANS = 'director_plans';
const GENS = 'generations';
const PICKS = 'shot_selections';

/** 允许人工改写的字段（其余字段（如 characters）改了会破坏链路，直接不允许） */
const EDITABLE = [
  'shot_card', 'camera_move', 'lighting_codes', 'transition', 'transition_reason',
  'emotions', 'dialogue', 'speaker', 'action_start', 'action_end', 'duration',
  'scene', 'props', 'ambient', 'ambient_sound', 'music_entry', 'prompt_note',
];

export class ShotService {
  /**
   * 合并「这一镜该用什么参数」：本次覆盖 > 环节设置 > 项目规格。
   * 与 AssetImageService 的同名逻辑保持同一口径，避免两条链路各说各话。
   */
  #effective(projectId, stage, kind, overrides, project) {
    const base = stageOptions.effective(projectId, stage);
    const o = overrides || {};
    const model = o.model ? modelCatalog.resolve(kind === 'video' ? 'video' : 'image', o.model) : base.model;
    const styleCode = o.style_code ?? o.styleCode ?? base.style_code;
    const style = seeds.style(styleCode);
    const aspect = o.aspect ?? base.aspect;
    const quality = o.quality ?? base.quality;
    if (!aspectOf(aspect)) fail(ERR.SPEC_VIOLATION, `不支持的画幅：${aspect}`);
    if (!qualityOf(quality)) fail(ERR.SPEC_VIOLATION, `不支持的画质：${quality}`);
    return {
      stage,
      model,
      style_code: styleCode,
      palette: style?.palette ?? base.palette ?? [],
      aspect,
      quality,
      project_spec: project?.spec ?? null,
    };
  }

  /**
   * @param {object} p
   * @param {string} p.projectId
   * @param {string} p.shotNo 分镜号，如 E01-S001
   * @param {'image'|'video'} p.kind
   */
  async generate({ projectId, shotNo, kind = 'image', userId = null, overrides = null }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) {
      fail(ERR.PROJECT_REQUIRED, '请先生成本剧的剧本与分镜，再逐镜出图');
    }
    const shot = planRec.storyboard.shots.find((s) => s.no === shotNo);
    if (!shot) fail(ERR.SHOT_NOT_FOUND, `分镜 ${shotNo} 不存在`);

    /**
     * 分环节参数（V4.14）：分镜图与视频各自可换模型 / 画幅 / 画质 / 风格。
     * 注意它不会改动项目 spec —— 成片规格仍由项目决定，剪辑前还会再核一次。
     */
    const stage = stageOfShot(kind);
    const eff = this.#effective(projectId, stage, kind, overrides, project);

    // —— 虚拟导演闸门：这一步该用的库必须齐（用户 pin 的卡优先，auto 由导演选）——
    directorAgent.assertStage(projectId, kind === 'video' ? 'shots' : 'storyboard');

    // 分镜引用的角色/场景/道具若没有资产卡，按模板补齐（补的是带锁的空卡，仍需出图）
    consistencyGuard.ensureAssetCards(projectId, shot);

    // —— 五维一致性：角色/道具/场景/内容/声音字幕，任一不过不出图 ——
    const guard = consistencyGuard.assertBeforeGenerate({
      projectId,
      shot,
      planRecord: planRec,
      requireImage: true,
      syncCode: directorAgent.libraryOverrides(projectId).sync ?? null,
    });

    // 上一镜产物：视频必须有起始帧，且必须是本镜已生成的关键帧
    const gens = db.find(GENS, (g) => g.project_id === projectId && g.shot_no === shotNo)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const lastImage = gens.find((g) => g.kind === 'image' && g.status === 'done' && (g.result_url || g.url));
    if (kind === 'video' && !lastImage) {
      fail(ERR.SHOT_SOURCE_REQUIRED, `请先生成 ${shotNo} 的关键帧，再基于关键帧出视频`);
    }

    const assets = db.find('assets', (a) => a.project_id === projectId);
    const chars = {};
    for (const a of assets.filter((x) => x.asset_type === 'character')) {
      chars[a.asset_code] = {
        asset_code: a.asset_code,
        name: a.name,
        locks: a.locks ?? [],
        lock_values: a.lock_values ?? {},
        image_url: a.image_url ?? null,
        negative: a.negative ?? [],
      };
    }
    const missing = (shot.characters ?? []).filter((c) => !chars[c]);
    if (missing.length) {
      fail(ERR.VISUAL_BASIS_NOT_COVERED, `角色 ${missing.join('/')} 还没有资产卡，请重新生成总谱`, { missing });
    }

    const pending = (shot.characters ?? []).filter((c) => !chars[c].image_url);

    // 场景 / 道具资产（V4.10）：分镜要复用同一处景，就得把场景图当参考传给编译器，
    // 否则每镜都在重新想象这个地方，一致性只剩角色。
    const scenes = {};
    const props = {};
    for (const a of assets) {
      if (a.asset_type === 'scene' && a.asset_code === shot.scene) {
        scenes[a.asset_code] = {
          asset_code: a.asset_code,
          name: a.name,
          locks: a.locks ?? [],
          lock_values: a.lock_values ?? {},
          image_url: a.image_url ?? null,
          negative: a.negative ?? [],
        };
      }
      if (a.asset_type === 'prop' && (shot.props ?? []).includes(a.asset_code)) {
        props[a.asset_code] = {
          asset_code: a.asset_code,
          name: a.name,
          locks: a.locks ?? [],
          lock_values: a.lock_values ?? {},
          image_url: a.image_url ?? null,
          negative: a.negative ?? [],
        };
      }
    }
    const pendingRefs = [
      ...pending.map((c) => ({ asset_code: c, role: 'character', reason: '角色卡尚未出图，按连续性锁文本生成' })),
      ...(scenes[shot.scene] && !scenes[shot.scene].image_url
        ? [{ asset_code: shot.scene, role: 'scene', reason: '场景图尚未生成，按空间与光源锁生成' }]
        : []),
    ];
    const materials = materialService.list(projectId).filter((m) => m.kind === 'image');

    // 用户手动选过的库（pin）在这里以 code 形式传给编译器，auto 的由总谱自带
    const libOverrides = directorAgent.libraryOverrides(projectId);

    const compileRequest = {
      project: {
        ...(project.spec ?? {}),
        // 环节参数覆盖项目级的那几项（风格/画幅/画质），其余规格字段仍按项目走
        style_code: eff.style_code,
        director_code: project.spec?.director_code ?? null,
        aspect: eff.aspect,
        quality: eff.quality,
        palette: eff.palette?.length ? eff.palette : (project.spec?.palette ?? undefined),
        // V4.12：片型与集数时长也要带下去，否则静态漫剧/解说漫仍会按动态漫剧的提示词出图
        video_type: project.spec?.video_type ?? 'dynamic',
        episode_count: project.spec?.episode_count ?? null,
        episode_sec: project.spec?.episode_sec ?? 90,
        total_minutes: project.spec?.total_minutes ?? 10,
      },
      // 用户在本环节选的模型：不在可选目录里就回退默认，绝不把请求打到已下架上游
      model: modelCatalog.resolve(kind === 'video' ? 'video' : 'image', eff.model),
      shot_no: shot.no,
      shot: {
        shot_no: shot.no,
        duration: shot.duration,
        shot_card: shot.shot_card,
        camera_move: shot.camera_move,
        characters: shot.characters ?? [],
        scene: shot.scene,
        props: shot.props ?? [],
        dialogue: shot.dialogue ?? null,
        speaker: shot.speaker ?? null,
        action_start: shot.action_start ?? null,
        action_end: shot.action_end ?? null,
        ambient: shot.ambient ?? [],
        emotions: shot.emotions ?? {},
        voice: shot.voice ?? null,
        first_frame_url: kind === 'video' ? (lastImage.result_url || lastImage.url) : null,
      },
      lighting: { codes: shot.lighting_codes ?? [] },
      transition: { code: shot.transition ?? 'TRN-HARDCUT', reason: shot.transition_reason ?? null },
      // 语法配方：只有在总谱里抽中时才传，编译器按"传了就严格校验"处理
      grammar: shot.grammar
        ? {
            recipe: shot.grammar.recipe,
            composition: shot.grammar.composition,
            lens: shot.grammar.lens,
            color: shot.grammar.color,
            atmosphere: shot.grammar.atmosphere,
            shot_card: shot.shot_card,
          }
        : null,
      libraries: Object.keys(libOverrides).length ? libOverrides : null,
      assets: { characters: chars, scenes, props, emotions: {} },
      options: {
        allow_pending_reference: true,
        allow_neutral_emotion: false,
        pending_plan: pendingRefs,
        // 用户上传的参考图会作为额外参考登记（不改写总谱，只影响画风倾向）
        material_references: materials.slice(0, 3).map((m) => ({ name: m.name, url: m.url, note: m.note })),
      },
    };

    const result = await generateService.run({
      userId: userId ?? project.user_id,
      projectId,
      kind,
      purpose: 'preview',
      compileRequest,
      meta: {
        shotNo: shot.no,
        primaryAssetCode: (shot.characters ?? [])[0] ?? null,
        stage,
        stage_options: {
          model: eff.model, style_code: eff.style_code, aspect: eff.aspect, quality: eff.quality,
        },
        assetsSnapshot: Object.fromEntries([
          ...Object.values(chars).map((c) => [c.asset_code, { version: c.version ?? 1, image_url: c.image_url }]),
          ...Object.values(scenes).map((c) => [c.asset_code, { version: c.version ?? 1, image_url: c.image_url }]),
        ]),
        reference: {
          locks: Object.values(chars).flatMap((c) => c.locks ?? []).slice(0, 12),
          emotion_codes: Object.values(shot.emotions ?? {}).filter(Boolean),
          lighting_codes: shot.lighting_codes ?? [],
          style_code: eff.style_code ?? project.spec?.style_code ?? null,
          materials: materials.slice(0, 3).map((m) => m.name),
        },
      },
    });

    // V4.13：新出的这一版直接成为该镜当前版本 —— 旧版本标废弃但保留（可回退），
    // 剪辑按"当前版本"取片，所以新版本一定落在原来的位置上，不会多一段也不会少一段。
    const version = result?.generationId
      ? this.markCurrent({ projectId, shotNo: shot.no, kind, generationId: result.generationId })
      : null;

    return {
      ...result,
      shot_no: shot.no,
      kind,
      // 这一镜实际用了什么参数（V4.14）：用户能核对"我选的那个模型/画幅真的生效了"
      effective: {
        stage,
        model: eff.model,
        style_code: eff.style_code,
        aspect: eff.aspect,
        quality: eff.quality,
      },
      compile: {
        shot_card: shot.shot_card,
        lighting_codes: shot.lighting_codes ?? [],
        transition: shot.transition,
        emotion: Object.values(shot.emotions ?? {})[0] ?? null,
        pending_references: pending,
        grammar_recipe: shot.grammar?.recipe ?? null,
        director_libs: Object.fromEntries(Object.entries(libOverrides).map(([k, v]) => [k, v])),
      },
      consistency: {
        ok: guard.audit?.ok !== false,
        voices: guard.voices ?? {},
      },
      version,
    };
  }

  /**
   * 把某一版设为该镜的当前版本（V4.13）。
   * 同时做三件事，这三件事必须一起做，否则"选中的"和"剪辑实际用的"就会分叉：
   *  1. 同镜同类旧版本全部标 superseded_by（保留记录，可回退）；
   *  2. 清掉当前版本身上的 superseded 标记（用户重新选回旧版是合法的）；
   *  3. 分镜上记 picked + version_history，剪辑只认 picked。
   */
  markCurrent({ projectId, shotNo, kind, generationId }) {
    if (!generationId) return null;
    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) return null;
    const idx = planRec.storyboard.shots.findIndex((s) => s.no === shotNo);
    if (idx < 0) return null;
    const shot = planRec.storyboard.shots[idx];

    const gen = db.findOne(GENS, (g) => g.id === generationId);
    if (!gen || gen.project_id !== projectId) return null;

    const older = assembly.supersedeOlder({ projectId, shotNo, kind, keepId: generationId });
    if (gen.superseded_by) {
      db.update(GENS, generationId, { superseded_by: null, superseded_at: null });
    }

    const prev = shot.picked?.[`${kind}_generation_id`] ?? null;
    const picked = {
      ...(shot.picked ?? {}),
      [`${kind}_generation_id`]: generationId,
      updated_at: nowIso(),
    };
    const versionHistory = [
      ...(shot.version_history ?? []),
      { kind, action: prev ? 'replace' : 'set', from: prev, to: generationId, order: assembly.shotOrder(shot), at: nowIso() },
    ].slice(-60);
    const next = {
      ...shot,
      order: assembly.shotOrder(shot),
      picked,
      version_history: versionHistory,
    };
    const shots = [...planRec.storyboard.shots];
    shots[idx] = next;
    db.update(PLANS, planRec.id, { storyboard: { ...planRec.storyboard, shots }, updated_at: nowIso() });

    directorAgent.log({
      projectId, stage: 'shots', action: prev ? 'version_replace' : 'version_set', actor: 'user',
      decisions: [
        `${shotNo} ${kind} 当前版本 → ${generationId}（索引 ${next.order}）`,
        older.superseded.length ? `弃用旧版本 ${older.superseded.length} 条（保留可回退）` : '无旧版本需要弃用',
      ],
      gate: { ok: true, issues: [] },
    });

    return {
      shot_no: shotNo,
      kind,
      generation_id: generationId,
      replaced: prev,
      superseded: older.superseded,
      picked,
      order: next.order,
      at: picked.updated_at,
    };
  }

  /** 装配审计：这一集能不能拼成完整成片（缺哪镜、重哪镜、谁用了废弃版本） */
  assembly(projectId, episode = null) {
    const ep = episode == null ? null : Number(String(episode).replace(/^E0*/i, '')) || null;
    return assembly.auditAssembly({ projectId, episode: ep });
  }

  /**
   * 手动改写某一镜（V4.11）。
   * 只改"表演与画面"层，不许改角色名单（改名单等于换人，必须回剧本重选）。
   * 改写会同步回总谱的对应 beat，这样"内容一致性"仍然成立 —— 一致性不是不许改，
   * 而是"改完只有一份事实"。
   */
  updateShot({ projectId, shotNo, patch = {} }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) fail(ERR.PROJECT_REQUIRED, '还没有分镜');
    const idx = planRec.storyboard.shots.findIndex((s) => s.no === shotNo);
    if (idx < 0) fail(ERR.SHOT_NOT_FOUND, `分镜 ${shotNo} 不存在`);
    const shot = planRec.storyboard.shots[idx];

    const bad = Object.keys(patch).filter((k) => !EDITABLE.includes(k));
    if (bad.length) {
      fail(ERR.BAD_REQUEST, `以下字段不允许手动改写：${bad.join('、')}`, { editable: EDITABLE });
    }

    const style = seeds.style(project.spec?.style_code);
    const next = { ...shot, order: assembly.shotOrder(shot) };
    const touched = [];

    if (patch.shot_card !== undefined) {
      if (!seeds.shot(patch.shot_card)) fail(ERR.MISSING_DIRECTOR_CARD, `镜别卡不存在：${patch.shot_card}`);
      next.shot_card = patch.shot_card;
      touched.push('shot_card');
    }
    if (patch.camera_move !== undefined) {
      const card = seeds.shot(patch.camera_move);
      if (!card || card.dim !== 'movement') fail(ERR.MISSING_DIRECTOR_CARD, `运镜卡不存在或维度不对：${patch.camera_move}`);
      next.camera_move = patch.camera_move;
      touched.push('camera_move');
    }
    if (patch.lighting_codes !== undefined) {
      const codes = [...new Set((patch.lighting_codes ?? []).filter(Boolean))];
      if (!codes.length) fail(ERR.MISSING_LIGHTING_CARD, '至少要留一张光影卡');
      for (const c of codes) {
        if (!seeds.lighting(c)) fail(ERR.MISSING_LIGHTING_CARD, `光影卡不存在：${c}`);
        if ((style?.lighting_cards_forbidden ?? []).includes(c)) {
          fail(ERR.STYLE_FORBIDDEN_LIGHTING, `风格「${style.name}」禁止使用光影卡 ${c}`);
        }
      }
      next.lighting_codes = codes.slice(0, 4);
      touched.push('lighting_codes');
    }
    if (patch.transition !== undefined) {
      if (!seeds.transition(patch.transition)) fail(ERR.TRANSITION_REASON_REQUIRED, `转场卡不存在：${patch.transition}`);
      if (patch.transition !== 'TRN-HARDCUT' && !(patch.transition_reason ?? next.transition_reason)) {
        fail(ERR.TRANSITION_REASON_REQUIRED, '非硬切转场必须说明理由（观众要看懂为什么这么接）');
      }
      next.transition = patch.transition;
      if (patch.transition_reason !== undefined) next.transition_reason = patch.transition_reason;
      touched.push('transition');
    }
    if (patch.emotions !== undefined) {
      for (const [ch, code] of Object.entries(patch.emotions ?? {})) {
        if (code && !seeds.emotion(code)) fail(ERR.EMOTION_CARD_NOT_FOUND, `角色 ${ch} 的情绪卡不存在：${code}`);
      }
      next.emotions = { ...(shot.emotions ?? {}), ...(patch.emotions ?? {}) };
      touched.push('emotions');
    }
    if (patch.scene !== undefined) {
      const a = assetLibrary.get(projectId, patch.scene);
      if (!a || a.asset_type !== 'scene') fail(ERR.ASSET_NOT_FOUND, `场景资产不存在：${patch.scene}`);
      next.scene = patch.scene;
      touched.push('scene');
    }
    if (patch.props !== undefined) {
      const list = [...new Set((patch.props ?? []).filter(Boolean))];
      for (const code of list) {
        const a = assetLibrary.get(projectId, code);
        if (!a || a.asset_type !== 'prop') fail(ERR.ASSET_NOT_FOUND, `道具资产不存在：${code}（先建道具卡再加进镜头）`);
      }
      next.props = list;
      touched.push('props');
    }
    if (patch.duration !== undefined) {
      const d = Number(patch.duration);
      if (!(d >= 2 && d <= 10)) fail(ERR.BAD_REQUEST, '单镜时长必须在 2~10 秒之间');
      next.duration = d;
      touched.push('duration');
    }
    for (const f of ['dialogue', 'speaker', 'action_start', 'action_end', 'ambient_sound', 'music_entry', 'prompt_note', 'transition_reason']) {
      if (patch[f] !== undefined) {
        next[f] = patch[f];
        touched.push(f);
      }
    }
    if (patch.ambient !== undefined) {
      next.ambient = (patch.ambient ?? []).filter(Boolean).slice(0, 6);
      touched.push('ambient');
    }
    if (next.dialogue && !next.speaker) {
      fail(ERR.SPEAKER_AMBIGUOUS, '有对白就必须指定说话人，否则配音对不上嘴');
    }

    next.manual_override = {
      fields: [...new Set([...(shot.manual_override?.fields ?? []), ...touched])],
      updated_at: nowIso(),
      by: 'user',
    };

    // 同步总谱：改完只有一份事实（否则下一镜出图时一致性校验会判"与总谱不一致"）
    const episodes = (planRec.plan?.episodes ?? []).map((ep) => ({
      ...ep,
      beats: (ep.beats ?? []).map((b) => (b.beat_no !== shot.beat_no ? b : {
        ...b,
        shot_card: next.shot_card,
        camera_move: next.camera_move,
        lighting_codes: next.lighting_codes,
        transition: next.transition,
        transition_reason: next.transition_reason ?? b.transition_reason,
        emotions: next.emotions,
        emotion_cards: Object.fromEntries(Object.entries(next.emotions ?? {}).map(([k, v]) => [k, v])),
        duration_sec: next.duration,
      })),
    }));
    const overrides = [
      ...(planRec.plan?.global?.manual_overrides ?? []).filter((x) => x.shot_no !== shotNo),
      { shot_no: shotNo, fields: next.manual_override.fields, at: nowIso() },
    ];

    const shots = [...planRec.storyboard.shots];
    shots[idx] = next;
    db.update(PLANS, planRec.id, {
      storyboard: { ...planRec.storyboard, shots },
      plan: {
        ...planRec.plan,
        episodes,
        global: { ...(planRec.plan?.global ?? {}), manual_overrides: overrides },
      },
      updated_at: nowIso(),
    });

    directorAgent.log({
      projectId, stage: 'shots', action: 'manual_override', actor: 'user',
      decisions: [`${shotNo} 人工改写：${touched.join('、')}`],
      gate: { ok: true, issues: [] },
    });

    return {
      shot: next,
      changed: touched,
      note: '已保存。想让画面跟着变，请点「重出这一镜」；只改设定不重出，旧图仍沿用上一次的参数。',
    };
  }

  /**
   * 单镜重生成（保留历史版本，可回退）。
   * 没有同类生成记录时退化为首次生成；有则以原编译输入为底重新跑。
   */
  async regenerateShot({ projectId, shotNo, kind = 'image', mode = 'resample', patch = {}, overrides = null }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const gens = db.find(GENS, (g) => g.project_id === projectId && g.shot_no === shotNo && g.kind === kind)
      .filter((g) => g.status === 'done')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const last = gens[0] ?? null;
    /**
     * 换了模型 / 风格 / 画幅 / 画质 再点「重出」，必须重新编译（V4.14）。
     * 原来无脑走 generateService.regenerate 是"拿上次的编译结果重跑"，
     * 用户改了设置看到的却还是老样子 —— 典型的假生效。
     */
    if (!last || (overrides && Object.keys(overrides).length)) {
      return this.generate({ projectId, shotNo, kind, userId: project.user_id, overrides });
    }
    const r = await generateService.regenerate({
      userId: project.user_id,
      projectId,
      generationId: last.id,
      mode,
      patch,
    });
    // 新版本立刻成为当前版本：旧版本废弃但留档，剪辑因此只会看到"这一版"
    const version = r?.generationId
      ? this.markCurrent({ projectId, shotNo, kind, generationId: r.generationId })
      : null;
    return { ...r, version };
  }

  /**
   * 从历史版本里挑一版作为该镜的正式版（剪辑与分发都用它）。
   * 图片与视频各自独立选定，互不覆盖。
   */
  pick({ projectId, shotNo, generationId }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const gen = db.findOne(GENS, (g) => g.id === generationId);
    if (!gen || gen.project_id !== projectId) fail(ERR.NOT_FOUND, '生成记录不存在');
    if (gen.shot_no !== shotNo) fail(ERR.BAD_REQUEST, '这条产物不属于该分镜');
    if (gen.status !== 'done' || !(gen.result_url || gen.url)) fail(ERR.BAD_REQUEST, '这条产物还没成功，不能设为正式版');

    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    if (!planRec) fail(ERR.PROJECT_REQUIRED, '还没有分镜');
    const idx = planRec.storyboard.shots.findIndex((s) => s.no === shotNo);
    if (idx < 0) fail(ERR.SHOT_NOT_FOUND, `分镜 ${shotNo} 不存在`);
    const version = this.markCurrent({ projectId, shotNo, kind: gen.kind, generationId: gen.id });
    if (!version) fail(ERR.SHOT_NOT_FOUND, `分镜 ${shotNo} 不存在，无法选定版本`);
    const picked = version.picked;
    db.insert(PICKS, {
      id: newId('pick'),
      project_id: projectId,
      shot_no: shotNo,
      kind: gen.kind,
      generation_id: gen.id,
      url: gen.result_url || gen.url,
      order: version?.order ?? null,
      at: nowIso(),
    });
    return {
      ok: true,
      shot_no: shotNo,
      kind: gen.kind,
      picked,
      url: gen.result_url || gen.url,
      version,
    };
  }

  /** 某镜历史产物（供镜头 tab 展示，带"是否正式版 / 是否已弃用"标记） */
  history(projectId, shotNo = null) {
    const planRec = db.findOne(PLANS, (x) => x.project_id === projectId);
    const pickedIds = new Set();
    const orderByPick = new Map();
    for (const s of planRec?.storyboard?.shots ?? []) {
      for (const v of Object.values(s.picked ?? {})) {
        if (typeof v !== 'string') continue;
        pickedIds.add(v);
        orderByPick.set(v, assembly.shotOrder(s));
      }
    }
    return db.find(GENS, (g) => g.project_id === projectId && (!shotNo || g.shot_no === shotNo))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((g) => ({
        id: g.id,
        kind: g.kind,
        shot_no: g.shot_no,
        order: orderByPick.get(g.id) ?? null,
        status: g.status,
        url: g.result_url ?? g.url ?? null,
        credits: g.actual_credits ?? g.estimated_credits ?? 0,
        created_at: g.created_at,
        picked: pickedIds.has(g.id),
        // V4.13：被新版本顶掉的版本不删除，但明确标出来，免得用户以为剪辑用的是它
        superseded: Boolean(g.superseded_by),
        superseded_by: g.superseded_by ?? null,
        superseded_at: g.superseded_at ?? null,
        consistency: g.consistency ?? null,
        regenerable: Boolean(g.compile_input),
      }));
  }
}

export const shotService = new ShotService();
export default shotService;
