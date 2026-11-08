/**
 * 分环节参数（V4.14）。
 *
 * 用户的原话是：「生成剧本、生成角色、生成分镜图、生成视频等环节，加入模型选择、
 * 风格选择、画面比例、画质选择等等细节」。
 *
 * 为什么不能只靠项目级 spec：
 *  - 项目级 spec 决定的是**成片规格**（用户开机时点的），它必须稳，不能因为出几张
 *    角色图就被改掉；
 *  - 但用户确实会想「角色图用便宜点的模型先试、分镜图用好模型定稿」，
 *    或者「这一部整体偏水墨，但分镜想更写实一点」。
 * 这两件事不冲突：**环节参数覆盖只作用于该环节的生成请求，不改项目 spec，也不改成片规格。**
 * 成片规格仍由 spec 决定，剪辑前那道 SPEC 闸门照旧核对。
 *
 * 一个例外：`film`（剪辑）的画幅/画质就是成片规格，这里的覆盖会被写入项目 spec 之外
 * 只用于渲染参数，渲染前仍会与 spec 对账 —— 不一致直接拒绝，不允许"剪出来和用户选的不一样"。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import seeds from '../seeds/loader.js';
import { normalize as normalizeSpec } from '../prompts/SpecLibrary.js';
import { ASPECTS, QUALITIES } from '../core/frame.js';
import { nowIso } from '../core/util.js';

const PROJECT = 'projects';

/**
 * 环节定义。
 *  modelRole   —— 该环节可选的模型池（chat / image / video / edit）
 *  style       —— 是否允许换风格（角色/场景/道具/分镜/视频可以，剪辑不行）
 *  aspect      —— 是否允许换画幅
 *  quality     —— 是否允许换画质
 *  reference   —— 是否支持上传本地参考图并自动填提示词
 */
export const STAGES = {
  script: {
    key: 'script', label: '生成剧本', model_role: 'chat',
    style: true, aspect: false, quality: false, reference: false,
    hint: '剧本阶段换模型只影响文风与结构；画幅/画质在这里不生效（成片规格在剪辑环节核）。',
  },
  character: {
    key: 'character', label: '角色形象', model_role: 'image',
    style: true, aspect: true, quality: true, reference: true,
    hint: '可上传真人/参考照片，系统会把它当"长相依据"，并结合剧本里对这个人的描写与风格色板自动写提示词。',
  },
  scene: {
    key: 'scene', label: '场景概念', model_role: 'image',
    style: true, aspect: true, quality: true, reference: true,
    hint: '可上传实景/参考图，系统按剧本里这个地点的描写生成空间与光源。',
  },
  prop: {
    key: 'prop', label: '道具设定', model_role: 'image',
    style: true, aspect: true, quality: true, reference: true,
    hint: '可上传实物照片，系统按剧本里这件道具的用途与材质描述补全。',
  },
  storyboard: {
    key: 'storyboard', label: '分镜图', model_role: 'image',
    style: true, aspect: true, quality: true, reference: true,
    hint: '分镜图沿用角色/场景已出的图作依据；这里换模型只影响这一环节的成像风格。',
  },
  video: {
    key: 'video', label: '视频片段', model_role: 'video',
    style: true, aspect: true, quality: true, reference: false,
    hint: '视频以分镜图为起始帧；换模型只影响运镜与动态质量。',
  },
  film: {
    key: 'film', label: '剪辑成片', model_role: 'edit',
    style: false, aspect: false, quality: false, reference: false,
    hint: '成片规格由项目决定（剪辑前会核对，不一致直接拒绝渲染），这里只能换剪辑档位。',
  },
};

const STYLE_FIELDS = ['style_code'];
const COMMON_FIELDS = ['model'];

/** 资产类型 → 环节 key */
export function stageOfAsset(assetType) {
  if (assetType === 'scene') return 'scene';
  if (assetType === 'prop') return 'prop';
  return 'character';
}

/** 生成类型 → 环节 key */
export function stageOfShot(kind) {
  return kind === 'video' ? 'video' : 'storyboard';
}

class StageOptions {
  #project(projectId) {
    const p = db.findOne(PROJECT, (x) => x.id === projectId);
    if (!p) fail(ERR.NOT_FOUND, '项目不存在');
    return p;
  }

  /**
   * 该环节当前生效的参数。
   * 优先级：环节覆盖 > 项目 spec > 目录默认（推荐模型 / 项目画幅画质）。
   * @returns {{model:string, style_code:string, style_name:string, aspect:string, quality:string, source:object}}
   */
  effective(projectId, stageKey) {
    const stage = STAGES[stageKey];
    if (!stage) fail(ERR.BAD_REQUEST, `未知环节: ${stageKey}`);
    const project = this.#project(projectId);
    const ov = (project.stage_options ?? {})[stageKey] ?? {};
    const spec = normalizeSpec({ ...project.spec }, { strict: false });

    const model = stage.model_role
      ? modelCatalog.resolve(stage.model_role, ov.model ?? project.spec?.models?.[stage.model_role] ?? null)
      : null;
    const styleCode = ov.style_code ?? project.spec?.style_code ?? null;
    const style = seeds.style(styleCode);
    const aspect = ov.aspect ?? spec.aspect;
    const quality = ov.quality ?? spec.quality;

    return {
      stage: stageKey,
      label: stage.label,
      model,
      model_role: stage.model_role,
      style_code: styleCode,
      style_name: style?.name ?? styleCode,
      palette: style?.palette ?? [],
      aspect,
      quality,
      // 哪些字段是"这一环节单独设过"的 —— 前端要能一眼看出偏离
      source: {
        model: ov.model ? 'stage' : 'project',
        style_code: ov.style_code ? 'stage' : 'project',
        aspect: ov.aspect ? 'stage' : 'project',
        quality: ov.quality ? 'stage' : 'project',
      },
    };
  }

  /**
   * 把一个环节的参数展开成编译器需要的 project 块。
   * ShotService / AssetImageService 都用它，确保两条链路的口径完全一致。
   */
  compileProject(projectId, stageKey, extra = {}) {
    const project = this.#project(projectId);
    const eff = this.effective(projectId, stageKey);
    return {
      project: {
        ...(project.spec ?? {}),
        ...extra,
        style_code: eff.style_code,
        aspect: eff.aspect,
        quality: eff.quality,
        palette: eff.palette?.length ? eff.palette : (project.spec?.palette ?? undefined),
      },
      model: eff.model,
      effective: eff,
    };
  }

  /** 全部环节的选项 + 当前值（前端一次渲染所有选择器） */
  get(projectId) {
    const project = this.#project(projectId);
    const spec = normalizeSpec({ ...project.spec }, { strict: false });
    const styles = (seeds.stylePresets ?? []).map((s) => ({
      code: s.code, name: s.name, palette: s.palette ?? [], art_prompt_zh: s.art_prompt_zh ?? '',
    }));
    const aspects = Object.entries(ASPECTS).map(([code, a]) => ({
      code, label: `${a.name}`, orientation: a.orientation, platforms: a.platforms,
    }));
    const qualities = Object.entries(QUALITIES).map(([code, q]) => ({
      code, label: q.name, detail: q.detail_zh, factor: q.factor,
    }));

    const stages = {};
    for (const key of Object.keys(STAGES)) {
      const meta = STAGES[key];
      const eff = this.effective(projectId, key);
      const pool = meta.model_role ? modelCatalog.publicRoles().roles[meta.model_role] : null;
      stages[key] = {
        ...meta,
        options: {
          models: pool ? pool.items : [],
          model_role_name: pool ? pool.name : '',
          styles: meta.style ? styles : [],
          aspects: meta.aspect ? aspects : [],
          qualities: meta.quality ? qualities : [],
        },
        current: eff,
      };
    }
    return {
      project_id: projectId,
      spec: {
        aspect: spec.aspect,
        quality: spec.quality,
        style_code: spec.style_code ?? project.spec?.style_code ?? null,
      },
      stages,
      stage_order: Object.keys(STAGES),
      note: '环节参数只影响该环节的生成，不改项目规格；成片规格仍以项目为准，剪辑前会核对。',
    };
  }

  /**
   * 设置某环节的参数。只接受该环节支持的字段，别的直接忽略（不报错、不假装生效）。
   * @returns {{ok:boolean, stage:string, effective:object, changed:string[]}}
   */
  set(projectId, stageKey, patch = {}) {
    const stage = STAGES[stageKey];
    if (!stage) fail(ERR.BAD_REQUEST, `未知环节: ${stageKey}`);
    const project = this.#project(projectId);

    const clean = {};
    const changed = [];

    if (patch.model !== undefined && stage.model_role) {
      if (patch.model === null || patch.model === '') {
        clean.model = null;
      } else {
        // 不在可选池里的模型不接受：宁可报错，也不要"设了但被悄悄换掉"
        const pool = modelCatalog.list(stage.model_role).items.map((x) => x.code);
        if (!pool.includes(patch.model)) {
          fail(ERR.BAD_REQUEST, `模型 ${patch.model} 不在「${stage.label}」的可选列表里`, {
            stage: stageKey, available: pool,
          });
        }
        clean.model = patch.model;
      }
      changed.push('model');
    }

    if (patch.style_code !== undefined && stage.style) {
      if (patch.style_code === null || patch.style_code === '') {
        clean.style_code = null;
      } else {
        if (!seeds.style(patch.style_code)) fail(ERR.BAD_REQUEST, `风格不存在: ${patch.style_code}`);
        clean.style_code = patch.style_code;
      }
      changed.push('style_code');
    }

    if (patch.aspect !== undefined && stage.aspect) {
      if (patch.aspect === null || patch.aspect === '') clean.aspect = null;
      else {
        if (!ASPECTS[patch.aspect]) {
          fail(ERR.SPEC_VIOLATION, `不支持的画幅：${patch.aspect}（可选 ${Object.keys(ASPECTS).join(' / ')}）`);
        }
        clean.aspect = patch.aspect;
      }
      changed.push('aspect');
    }

    if (patch.quality !== undefined && stage.quality) {
      if (patch.quality === null || patch.quality === '') clean.quality = null;
      else {
        if (!QUALITIES[patch.quality]) {
          fail(ERR.SPEC_VIOLATION, `不支持的画质：${patch.quality}（可选 ${Object.keys(QUALITIES).join(' / ')}）`);
        }
        clean.quality = patch.quality;
      }
      changed.push('quality');
    }

    const all = { ...(project.stage_options ?? {}) };
    const cur = { ...(all[stageKey] ?? {}) };
    for (const [k, v] of Object.entries(clean)) {
      if (v === null) delete cur[k];
      else cur[k] = v;
    }
    if (Object.keys(cur).length) all[stageKey] = cur;
    else delete all[stageKey];

    db.update(PROJECT, projectId, { stage_options: all, stage_options_at: nowIso() });

    return {
      ok: true,
      stage: stageKey,
      changed,
      ignored: Object.keys(patch).filter((k) => {
        if (COMMON_FIELDS.includes(k)) return false;
        if (STYLE_FIELDS.includes(k)) return !stage.style;
        return !stage[k];
      }),
      effective: this.effective(projectId, stageKey),
    };
  }
}

export const stageOptions = new StageOptions();
export default stageOptions;
