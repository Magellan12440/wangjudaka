/**
 * 镜头生产（V4.2）：在**项目内**按分镜号生成关键帧 / 视频。
 *
 * 为什么放在服务端拼 compileRequest：
 *  - 12 条编译校验的输入（镜头卡、光影、情绪、连续性锁、参考图）必须来自总谱与资产库，
 *    不允许前端自己拼 —— 否则用户能绕过总谱直接出图，一致性锁形同虚设。
 *  - 这里只负责"按总谱执行"，不改写任何镜别/光影/转场。
 */
import { db } from '../store/db.js';
import { generateService } from './GenerateService.js';
import { materialService } from '../assets/MaterialService.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import { fail, ERR } from '../core/errors.js';

const PROJECT = 'projects';

export class ShotService {
  /**
   * @param {object} p
   * @param {string} p.projectId
   * @param {string} p.shotNo 分镜号，如 E01-S001
   * @param {'image'|'video'} p.kind
   */
  async generate({ projectId, shotNo, kind = 'image', userId = null }) {
    const project = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!project) fail(ERR.NOT_FOUND, '项目不存在');
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    if (!planRec?.storyboard?.shots?.length) {
      fail(ERR.PROJECT_REQUIRED, '请先生成本剧的剧本与分镜，再逐镜出图');
    }
    const shot = planRec.storyboard.shots.find((s) => s.no === shotNo);
    if (!shot) fail(ERR.SHOT_NOT_FOUND, `分镜 ${shotNo} 不存在`);

    // 上一镜产物：视频必须有起始帧，且必须是本镜已生成的关键帧
    const gens = db.find('generations', (g) => g.project_id === projectId && g.shot_no === shotNo)
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
    const materials = materialService.list(projectId).filter((m) => m.kind === 'image');

    const compileRequest = {
      project: {
        style_code: project.spec?.style_code,
        director_code: project.spec?.director_code ?? null,
        aspect: project.spec?.aspect ?? '9:16',
        quality: project.spec?.quality ?? '1080p',
      },
      // 用户在本项目选的模型：不在可选目录里就回退默认，绝不把请求打到已下架上游
      model: modelCatalog.resolve(kind, project.spec?.models?.[kind] ?? null),
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
      assets: { characters: chars, scenes: {}, props: {}, emotions: {} },
      options: {
        allow_pending_reference: true,
        allow_neutral_emotion: false,
        pending_plan: pending.map((c) => ({
          asset_code: c,
          role: 'character',
          reason: '角色卡尚未出图，按连续性锁文本生成',
        })),
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
        reference: {
          locks: Object.values(chars).flatMap((c) => c.locks ?? []).slice(0, 12),
          emotion_codes: Object.values(shot.emotions ?? {}).filter(Boolean),
          lighting_codes: shot.lighting_codes ?? [],
          style_code: project.spec?.style_code ?? null,
          materials: materials.slice(0, 3).map((m) => m.name),
        },
      },
    });

    return {
      ...result,
      shot_no: shot.no,
      kind,
      compile: {
        shot_card: shot.shot_card,
        lighting_codes: shot.lighting_codes ?? [],
        transition: shot.transition,
        emotion: Object.values(shot.emotions ?? {})[0] ?? null,
        pending_references: pending,
        grammar_recipe: shot.grammar?.recipe ?? null,
      },
    };
  }

  /** 某镜历史产物（供镜头 tab 展示） */
  history(projectId, shotNo) {
    return db.find('generations', (g) => g.project_id === projectId && (!shotNo || g.shot_no === shotNo))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((g) => ({
        id: g.id,
        kind: g.kind,
        shot_no: g.shot_no,
        status: g.status,
        url: g.result_url ?? g.url ?? null,
        credits: g.actual_credits ?? g.estimated_credits ?? 0,
        created_at: g.created_at,
      }));
  }
}

export const shotService = new ShotService();
export default shotService;
