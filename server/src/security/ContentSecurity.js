/**
 * 内容安全机审（V3.5）。
 *
 * 拦截点（微信「深度合成」类目合规硬要求）：
 *  1. 用户输入：一句话创意 / 剧本大纲 / 手动文案 → 生成前必须过文本机审
 *  2. AI 产出：剧本正文 / 分镜提示词 → 落库前过文本机审（产出也可能违规）
 *  3. 分发物料：标题 / 简介 / 标签 → 创建分发任务前过文本机审
 *  4. 生成图片：交付闸门处过图片机审（imgSecCheck）
 *
 * 原则：违规内容直接 CONTENT_BLOCKED 拒绝并落审计；机审接口异常不误伤用户，
 * 但 mode 会如实标注（error_pass_through），审计日志可追溯。
 * mock 模式（未配置微信凭据）默认放行 + 审计，供本地联调。
 */
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import wechatClient from '../wechat/WechatClient.js';

const AUDIT = 'security_audit';
const USERS = 'users';

class ContentSecurity {
  /**
   * 取用户的微信 openid：msgSecCheck v2 只认「本小程序用户」的 openid，
   * 传空或伪造值会直接 40003，等于机审失效。这里从登录档案取真实值。
   */
  openidOf(userId) {
    if (!userId) return '';
    const u = db.findOne(USERS, (x) => x.id === userId);
    return u?.openid ?? '';
  }

  /**
   * 文本机审（不抛错版）：返回 { pass, mode, label }
   */
  async checkText({ content, openid = '', scene = 3, bizType = 'generic', bizId = null }) {
    const text = String(content ?? '');
    if (!text.trim()) return { pass: true, mode: 'empty' };
    const r = await wechatClient.msgSecCheck({ openid, scene, content: text });
    this.#audit({ kind: 'text', bizType, bizId, pass: r.pass, mode: r.mode, label: r.label, len: text.length });
    return r;
  }

  /**
   * 文本机审（强校验版）：违规直接 CONTENT_BLOCKED。
   * 在生成/落库/分发前调用。
   */
  async assertText({ content, openid = '', scene = 3, bizType = 'generic', bizId = null }) {
    const r = await this.checkText({ content, openid, scene, bizType, bizId });
    if (!r.pass) {
      fail(ERR.CONTENT_BLOCKED, '内容包含违规信息，请修改后重试', { bizType, label: r.label ?? null });
    }
    return r;
  }

  /** 图片机审（交付闸门调用） */
  async checkImage({ imageUrl, bizType = 'generation', bizId = null }) {
    if (!imageUrl || !/^https?:\/\//.test(String(imageUrl))) {
      return { pass: true, mode: 'skipped_not_http' };
    }
    const r = await wechatClient.imgSecCheck({ imageUrl });
    this.#audit({ kind: 'image', bizType, bizId, pass: r.pass, mode: r.mode });
    if (!r.pass) {
      fail(ERR.CONTENT_BLOCKED, '图片内容未通过安全审核，请重新生成', { bizType });
    }
    return r;
  }

  /** 审计查询（运营后台） */
  auditTrail({ bizType = null, limit = 50 } = {}) {
    const all = db.find(AUDIT, (a) => !bizType || a.biz_type === bizType);
    return all.slice(-limit).reverse();
  }

  #audit({ kind, bizType, bizId, pass, mode, label = null, len = null }) {
    try {
      db.insert(AUDIT, {
        id: newId('sec'),
        kind,
        biz_type: bizType,
        biz_id: bizId,
        pass,
        mode,
        label,
        content_len: len,
        created_at: nowIso(),
      });
    } catch {
      /* 审计失败不阻断 */
    }
  }
}

export const contentSecurity = new ContentSecurity();
export default contentSecurity;
