/**
 * 项目索引（V4.3）。
 *
 * 为什么需要：用户的剧会越来越多，同名、同系列、连着做三季，
 * 光靠「标题 + 创建时间」在列表里根本分不清，点错就会把素材传到别的剧里。
 * 所以每个项目在本用户范围内有一个自增序号（1、2、3…），对外显示成 #007 这样的编号，
 * 它只在本用户内唯一 —— 不暴露全局数量，也不能用来猜别人的项目。
 *
 * 隔离原则：
 *  - 序号只在 user_id 维度自增，跨用户不复用也不冲突。
 *  - 所有按编号查项目的入口都必须带 userId，查不到就当不存在（不区分「没权限」和「不存在」）。
 */
import { db } from '../store/db.js';
import { nowIso } from '../core/util.js';

const PROJECTS = 'projects';

export class ProjectIndex {
  /** 该用户下一个可用序号（并发下也只会重复一次，落库时再校正） */
  nextNo(userId) {
    const mine = db.find(PROJECTS, (p) => p.user_id === userId);
    let max = 0;
    for (const p of mine) max = Math.max(max, Number(p.index_no) || 0);
    return max + 1;
  }

  /** 建项目时调用：返回带序号的补丁字段 */
  assignPatch(userId) {
    const no = this.nextNo(userId);
    return { index_no: no, index_label: `#${String(no).padStart(3, '0')}` };
  }

  /** 历史项目补序号（幂等；列表/首页调用时顺手补齐） */
  ensure(userId) {
    const mine = db.find(PROJECTS, (p) => p.user_id === userId)
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
    let max = 0;
    for (const p of mine) max = Math.max(max, Number(p.index_no) || 0);
    let changed = 0;
    for (const p of mine) {
      if (Number(p.index_no) > 0) continue;
      max += 1;
      db.update(PROJECTS, p.id, {
        index_no: max,
        index_label: `#${String(max).padStart(3, '0')}`,
        indexed_at: nowIso(),
      });
      changed += 1;
    }
    return { changed, max };
  }

  /** 展示字段（列表、详情统一走这里，避免各页面自己拼） */
  view(p) {
    const no = Number(p.index_no) || 0;
    return {
      index_no: no,
      index_label: p.index_label ?? (no ? `#${String(no).padStart(3, '0')}` : '#—'),
      series_label: p.series_title ?? null,
      season_no: Number(p.season_no) || 1,
    };
  }

  /** 按编号找项目（限本用户） */
  findByNo(userId, no) {
    const n = Number(String(no).replace(/[^\d]/g, ''));
    if (!n) return null;
    return db.findOne(PROJECTS, (p) => p.user_id === userId && Number(p.index_no) === n) ?? null;
  }
}

export const projectIndex = new ProjectIndex();
export default projectIndex;
