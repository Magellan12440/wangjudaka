/**
 * 分发中控台（§13）。
 *
 * 必须说清的边界：小程序 web-view 只能加载在后台配置过的业务域名，
 * 而我们无法为 creator.shortdramas.com 等第三方上传校验文件 → 无法内嵌登录。
 * 因此本模块做的是「状态跟踪 + 材料准备 + 引导」，审核/签约/提现由用户在平台完成。
 * 这是平台级限制，任何方案都绕不过，不要承诺内嵌。
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';
import analytics from '../analytics/Analytics.js';

const COL = 'distributions';

export const STATUS_FLOW = {
  'PLT-HONGGUO': ['待上传', '审核中', '已通过', '已上线', '被驳回', '已下线'],
  default: ['准备中', '待上传', '审核中', '已上线', '被驳回', '已下线'],
};

export class DistributionHub {
  /** 平台卡片（含政策库字段） */
  platforms() {
    return seeds.distributionPlatforms.map((p) => ({
      code: p.code,
      name: p.name,
      creator_url: p.creator_url,
      entry_note: p.entry_note ?? null,
      identity_choice: p.identity_choice,
      upload_client: p.upload_client,
      in_app_embeddable: false, // 恒为 false：第三方业务域名无法在小程序内嵌
      api_available: p.api_available,
      review_days: p.review_days,
      revenue: p.revenue,
      ai_declaration_required: p.ai_declaration_required,
      ai_declaration_note: p.ai_declaration_note ?? null,
      status_flow: p.status_flow ?? STATUS_FLOW.default,
      tips: p.tips ?? [],
    }));
  }

  platform(code) {
    const p = seeds.platform(code);
    if (!p) fail(ERR.NOT_FOUND, `分发平台不存在: ${code}`);
    return p;
  }

  /** 创建分发任务（用户选定平台后跟踪） */
  create({ projectId, episodeNo, platformCode, userId }) {
    const p = this.platform(platformCode);
    return db.insert(COL, {
      id: newId('dist'),
      user_id: userId,
      project_id: projectId,
      episode: episodeNo,
      platform: platformCode,
      platform_name: p.name,
      status: '准备中',
      checklist: this.checklist(platformCode),
      revenue: { currency: 'CNY', amount: 0, updated_at: null },
      stats: { views: 0, likes: 0, completion_rate: null },
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  /** 材料清单：上传前必须备齐的东西（AI 标识 + 授权 + 版权链） */
  checklist(platformCode) {
    const p = this.platform(platformCode);
    const items = [
      { key: 'video_1080p', label: '成片 MP4（含片头 AI 标识）', required: true },
      { key: 'cover', label: '封面图（含 AI 标识角标）', required: true },
      { key: 'ai_declaration', label: 'AI 创作说明', required: !!p.ai_declaration_required },
      { key: 'ai_evidence', label: '创作过程截图包（全屏/带网址/带时间）', required: !!p.ai_declaration_required },
      { key: 'bgm_credits', label: '音乐署名清单（如需署名）', required: false },
      { key: 'copyright_chain', label: '版权链证明（原创/改编授权）', required: true },
      { key: 'contract', label: '平台合同签署', required: true, note: p.contract },
    ];
    return items;
  }

  updateStatus(id, status, extra = {}) {
    const d = db.findOne(COL, (x) => x.id === id);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    const flow = STATUS_FLOW[d.platform] ?? STATUS_FLOW.default;
    if (!flow.includes(status)) {
      fail(ERR.BAD_REQUEST, `平台 ${d.platform_name} 不支持状态 ${status}`, { allowed: flow });
    }
    return db.update(COL, id, { status, ...extra, updated_at: nowIso() });
  }

  /**
   * 收益回传（手动录入或未来接入平台导出）。
   * V3.3：改为追加写入 earnings 账，不再覆盖历史；本方法保留旧返回结构兼容。
   */
  recordRevenue(id, { amount, currency = 'CNY', period = null, settlementStatus = '待结算' }) {
    const d = db.findOne(COL, (x) => x.id === id);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    analytics.recordRevenue({ distributionId: id, grossAmount: amount, currency, period, settlementStatus });
    return db.findOne(COL, (x) => x.id === id);
  }

  /** 数据回传（播放/互动/完播）：V3.3 追加时序快照，可出趋势 */
  recordStats(id, stats) {
    const d = db.findOne(COL, (x) => x.id === id);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    // recordedAt 是时序元信息，不属于业务指标；必须透传，否则多条回传会挤到同一时刻
    const { recordedAt = null, ...clean } = stats ?? {};
    analytics.recordStatsSnapshot({ distributionId: id, stats: clean, recordedAt });
    return db.findOne(COL, (x) => x.id === id);
  }

  /**
   * 合同签订登记。
   *
   * 边界：小程序不能替用户在第三方平台签合同（登录态、实名、电子签章都在平台侧），
   * 所以这里只登记「已在平台完成签署」这件事 + 合同快照，用于后续审核与提现的前置校验。
   */
  signContract(id, { signer = null, contractNo = null, channel = null, note = null } = {}) {
    const d = db.findOne(COL, (x) => x.id === id);
    if (!d) fail(ERR.NOT_FOUND, '分发记录不存在');
    const p = this.platform(d.platform);
    if (d.contract?.signed) {
      return { ...d, contract: { ...d.contract, already: true } };
    }
    const contract = {
      signed: true,
      signer: signer || d.user_id || null,
      contract_no: contractNo || null,
      channel: channel || p?.contract || '平台线上电子合同',
      note: note || null,
      platform: d.platform,
      signed_at: nowIso(),
    };
    // 材料清单同步打勾：合同是提现的前置，不能只存在一个看不见的字段里
    const checklist = (d.checklist ?? []).map((it) =>
      it.key === 'contract' ? { ...it, done: true, done_at: contract.signed_at } : it
    );
    // 签完合同通常意味着材料备齐 → 推进到「待上传」，但不越权替用户改到「审核中」
    const nextStatus = d.status === '准备中' ? '待上传' : d.status;
    return db.update(COL, id, { contract, checklist, status: nextStatus, updated_at: nowIso() });
  }

  /**
   * 四步闭环状态机：分发上传 → 内容审核 → 合同签订 → 收益提取。
   * 放在服务端算，前端只渲染，避免三个端各写一套判断。
   */
  stepsFor(d) {
    const p = this.platform(d.platform) ?? {};
    const status = d.status;
    const uploaded = ['审核中', '已通过', '已上线', '被驳回', '已下线'].includes(status);
    const reviewing = status === '审核中';
    const approved = ['已通过', '已上线'].includes(status);
    const rejected = status === '被驳回';
    const signed = !!d.contract?.signed;
    const earned = (d.revenue?.amount ?? 0) > 0;

    return [
      {
        key: 'distribute', no: 1, label: '分发上传',
        state: uploaded ? 'done' : 'current',
        note: p.upload_client || '电脑端上传',
        action: '打开创作者中心',
        url: p.creator_url || null,
        hint: p.identity_choice || '',
      },
      {
        key: 'review', no: 2, label: '内容审核',
        state: approved ? 'done' : rejected ? 'blocked' : reviewing ? 'current' : 'todo',
        note: p.review_days ? `参考 ${p.review_days} 天` : '以平台公告为准',
        action: rejected ? '看驳回原因并重提' : '更新审核状态',
        url: null,
        hint: p.ai_declaration_required ? (p.ai_declaration_note || '需提交 AI 创作说明') : '',
      },
      {
        key: 'contract', no: 3, label: '合同签订',
        state: signed ? 'done' : rejected ? 'todo' : approved ? 'current' : 'todo',
        note: p.contract || '平台线上签署',
        action: signed ? '已签署' : '登记已签署',
        url: null,
        hint: p.revenue || '',
      },
      {
        key: 'withdraw', no: 4, label: '收益提取',
        state: earned ? 'done' : signed ? 'current' : 'todo',
        note: p.revenue || '按平台结算周期',
        action: '录入本期收益',
        url: null,
        hint: '提现走平台对公流程，小程序只做金额与结算状态跟踪',
      },
    ];
  }

  list(projectId) {
    return db.find(COL, (d) => d.project_id === projectId);
  }

  /** 列表 + 四步闭环状态（前端只渲染，不自己判断到哪一步了） */
  listWithSteps(projectId) {
    return this.list(projectId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((d) => ({ ...d, steps: this.stepsFor(d) }));
  }

  /** 汇总看板 */
  summary(projectId) {
    const all = this.list(projectId);
    const totalRevenue = all.reduce((a, d) => a + (d.revenue?.amount ?? 0), 0);
    const totalViews = all.reduce((a, d) => a + (d.stats?.views ?? 0), 0);
    const online = all.filter((d) => d.status === '已上线').length;
    // V3.3：从收益账取待结算金额（追加账，不再依赖被覆盖的单字段）
    const earns = db.find('earnings', (e) => e.project_id === projectId);
    const pending = earns.filter((e) => e.settlement_status !== '已结算')
      .reduce((a, e) => a + (e.gross_amount_cny ?? 0), 0);
    return {
      count: all.length,
      online,
      total_revenue_cny: +totalRevenue.toFixed(2),
      pending_settlement_cny: +pending.toFixed(2),
      snapshot_count: db.count('stat_snapshots', (s) => s.project_id === projectId),
      total_views: totalViews,
      by_platform: all.map((d) => ({
        platform: d.platform_name,
        status: d.status,
        revenue: d.revenue?.amount ?? 0,
        views: d.stats?.views ?? 0,
      })),
    };
  }
}

export const distributionHub = new DistributionHub();
export default distributionHub;
