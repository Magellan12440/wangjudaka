/**
 * 创作文档六表（借鉴 zenstory-ai/drama-skills 的文档契约，工程化为六张表）
 *
 *  1 story_bible    故事圣经：世界观 / 调性 / 风格 / 红线
 *  2 characters     角色卡：外貌锁、性格、动机、声线绑定
 *  3 outline        分集大纲：每集目标、冲突、反转、共情、钩子
 *  4 script         剧本：场次级，含对白与情绪
 *  5 storyboard     分镜表：镜号 / 景别 / 时长 / 角色 / 场景 / 光影 / 转场
 *  6 asset_refs     资产引用：镜头 → 资产版本快照
 *
 * 跨文档校验（drama-skills 的 creator_markdown_check 思路）：
 *   任一文档改动后跑一次，防止"分镜引用了不存在的角色"这类低级错误在花钱后才暴露。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso, speechUnits, maxSpeechUnits } from '../core/util.js';

const COL = 'creation_docs';

const DOC_TYPES = ['story_bible', 'characters', 'outline', 'script', 'storyboard', 'asset_refs'];

export class CreationDocs {
  /** 写入/更新某类文档（按 project + type 唯一） */
  save({ projectId, type, content, version = null, updatedBy = 'system' }) {
    if (!DOC_TYPES.includes(type)) fail(ERR.BAD_REQUEST, `未知文档类型: ${type}`);
    const exist = db.findOne(COL, (d) => d.project_id === projectId && d.type === type);
    if (exist) {
      return db.update(COL, exist.id, {
        content,
        version: version ?? (exist.version ?? 1) + 1,
        updated_by: updatedBy,
        updated_at: nowIso(),
      });
    }
    return db.insert(COL, {
      id: newId('doc'),
      project_id: projectId,
      type,
      content,
      version: version ?? 1,
      updated_by: updatedBy,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  get(projectId, type) {
    return db.findOne(COL, (d) => d.project_id === projectId && d.type === type);
  }

  all(projectId) {
    return db.find(COL, (d) => d.project_id === projectId);
  }

  /**
   * 跨文档校验。返回 { ok, errors[], warnings[] }
   * content 结构约定见文件头；缺失的文档视为警告（允许分步创作）。
   */
  check(projectId) {
    const docs = {};
    for (const t of DOC_TYPES) docs[t] = this.get(projectId, t)?.content ?? null;

    const errors = [];
    const warnings = [];

    for (const t of DOC_TYPES) {
      if (!docs[t]) warnings.push({ doc: t, issue: '尚未创建' });
    }

    const characters = docs.characters?.items ?? docs.characters ?? [];
    const charCodes = new Set((Array.isArray(characters) ? characters : []).map((c) => c.code ?? c.asset_code));
    const scenes = docs.story_bible?.scenes ?? [];
    const sceneCodes = new Set((Array.isArray(scenes) ? scenes : []).map((s) => s.code ?? s.asset_code));
    const shots = docs.storyboard?.shots ?? [];

    // 1) 分镜引用的角色必须在角色卡中存在
    for (const s of shots) {
      for (const c of s.characters ?? []) {
        if (charCodes.size && !charCodes.has(c)) {
          errors.push({ code: 'CHAR_NOT_IN_CARDS', shot: s.no, character: c });
        }
      }
      if (s.scene && sceneCodes.size && !sceneCodes.has(s.scene)) {
        errors.push({ code: 'SCENE_NOT_IN_BIBLE', shot: s.no, scene: s.scene });
      }
      // 2) 镜头卡必填
      if (!s.shot_card) errors.push({ code: 'SHOT_CARD_MISSING', shot: s.no });
      // 3) 时长与对白
      if (s.dialogue && s.duration) {
        const u = speechUnits(s.dialogue);
        if (u > maxSpeechUnits(s.duration)) {
          errors.push({ code: 'DIALOGUE_OVERFLOW', shot: s.no, units: +u.toFixed(1), max: +maxSpeechUnits(s.duration).toFixed(1) });
        }
        if (!s.speaker) errors.push({ code: 'SPEAKER_MISSING', shot: s.no });
      }
      // 4) 光影卡
      if (!(s.lighting?.length || s.lighting_codes?.length)) {
        errors.push({ code: 'LIGHTING_MISSING', shot: s.no });
      }
      // 5) 集末钩子
      if (s.is_episode_end && !s.ending_hook) {
        warnings.push({ code: 'ENDING_HOOK_MISSING', shot: s.no, note: '集末必须有悬念/新威胁/反转揭半' });
      }
    }

    // 6) 时长总和 vs 目标
    const total = shots.reduce((a, s) => a + (s.duration ?? 0), 0);
    const target = docs.storyboard?.target_total_sec;
    if (target && Math.abs(total - target) / target > 0.15) {
      warnings.push({ code: 'DURATION_DEVIATION', total, target, deviation: +((total - target) / target).toFixed(3) });
    }

    // 7) 剧本与分镜的场次对应
    const scenesInScript = new Set((docs.script?.scenes ?? []).map((s) => s.no));
    for (const s of shots) {
      if (scenesInScript.size && s.scene_no && !scenesInScript.has(s.scene_no)) {
        errors.push({ code: 'SCENE_NO_NOT_IN_SCRIPT', shot: s.no, scene_no: s.scene_no });
      }
    }

    return { ok: errors.length === 0, errors, warnings, stats: { shots: shots.length, total_sec: +total.toFixed(1) } };
  }
}

export const creationDocs = new CreationDocs();
export default creationDocs;
