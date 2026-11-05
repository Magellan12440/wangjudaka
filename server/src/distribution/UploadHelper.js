/**
 * PC / H5 上传助手（阶段 H / §13、§25.5 第 6 步）。
 *
 * 边界（硬）：**只做预填与提醒，不做自动投稿**。
 *  - 平台无开放上传 API，且版权方身份绑定后不可改 → 用户必须自己在平台登录/上传/签约/提现。
 *  - 本服务产出：可复制的预填字段、素材清单、平台入口、交付闸门提示、可导出留证包。
 *  - 任何返回里 `no_auto_submit` 恒为 true；markUploaded 只回写我们自己的状态跟踪，
 *    绝不调用任何平台接口，也不代替用户点击提交。
 *  - 小程序内不能内嵌第三方上传页（业务域名限制），故入口只在 PC/H5 提供。
 */
import seeds from '../seeds/loader.js';
import { db } from '../store/db.js';
import { config } from '../config/env.js';
import { fail, ERR } from '../core/errors.js';
import distributionHub, { STATUS_FLOW } from './DistributionHub.js';
import compliancePack from '../compliance/CompliancePack.js';
import { newId, nowIso } from '../core/util.js';

const DIST = 'distributions';
const BUNDLES = 'upload_bundles';
const SUBMISSIONS = 'upload_submissions';
const IMPORTS = 'upload_imports';
export const BUNDLE_SCHEMA = 'lingwu.upload.bundle/1';

export class UploadHelper {
  #dist(distributionId) {
    const d = db.findOne(DIST, (x) => x.id === distributionId);
    if (!d) fail(ERR.UPLOAD_DIST_NOT_FOUND, `分发任务不存在: ${distributionId}`);
    return d;
  }

  /** 生成预填表单 + 素材清单 + 平台入口 + 交付闸门提示 */
  prepare(distributionId) {
    const d = this.#dist(distributionId);
    const project = db.findOne('projects', (x) => x.id === d.project_id) ?? {};
    const platform = distributionHub.platform(d.platform);
    const spec = project.spec ?? {};
    const planRec = db.findOne('director_plans', (x) => x.project_id === d.project_id);
    const plan = planRec?.plan ?? null;
    const script = planRec?.script ?? null;
    const sb = planRec?.storyboard ?? null;
    const style = seeds.style(spec.style_code) ?? null;

    const episodes = script?.episodes?.length
      ?? Math.max(1, Math.ceil(((spec.total_minutes ?? 10) * 60) / (spec.episode_sec ?? 90)));
    const characters = collectCharacters(plan, script, sb);
    const runs = db.find('blueprint_runs', (r) => r.project_id === d.project_id);
    const costCredits = runs.reduce((a, r) => a + (r.total_credits ?? 0), 0);

    const fields = [
      { key: 'drama_title', label: '剧名', value: String(project.title ?? '未命名漫剧'), required: true, copyable: true },
      {
        key: 'drama_synopsis', label: '简介 / 一句话梗概',
        value: buildSynopsis({ prompt: spec.prompt, style: style?.name, episodes, episodeSec: spec.episode_sec }),
        required: true, copyable: true,
        hint: '上传前请复核为最终文案；本内容由 AI 辅助生成，需人工确认',
      },
      { key: 'episode_count', label: '集数', value: String(episodes), required: true, copyable: true },
      { key: 'episode_duration_sec', label: '单集时长（秒）', value: String(spec.episode_sec ?? 90), copyable: true },
      { key: 'aspect_ratio', label: '画幅', value: String(spec.aspect ?? '9:16'), copyable: true },
      { key: 'quality', label: '画质', value: String(spec.quality ?? '1080p'), copyable: true },
      { key: 'art_style', label: '美术风格', value: String(style?.name ?? '未指定'), copyable: true },
      { key: 'character_info', label: '角色信息', value: characters.length ? characters.join('；') : '（待填写）', copyable: true },
      {
        key: 'ai_declaration', label: 'AI 生成标识 / 创作说明',
        value: config.compliance.aiLabelText, required: !!platform.ai_declaration_required, copyable: true,
        hint: '请在平台发布页同步勾选「AI 生成」标识',
      },
      {
        key: 'ai_evidence', label: '创作过程证据',
        value: `合规交付包（7 页，含全屏截图 / 工作台网址 / 时间戳 / 提示词与版本链）：/api/compliance/pack?projectId=${d.project_id}&episodeNo=${encodeURIComponent(d.episode)}`,
        required: !!platform.ai_declaration_required, copyable: false,
        hint: '证据包需自行下载打印或截图，平台要求全屏、带网址、带时间',
      },
      { key: 'copyright_chain', label: '版权链', value: '原创剧本 / 已获改编授权（请按实际情况勾选并留存证明）', required: true, copyable: true },
      {
        key: 'cost_config', label: '制作成本配置（内部记录）',
        value: `累计消耗 ${costCredits} 点；风格 ${style?.name ?? '未指定'}；${spec.preset ?? 'balanced'} 档`,
        copyable: false, hint: '仅供内部对账，不需填入平台',
      },
    ];

    const checklist = (d.checklist ?? []).map((it) => ({
      key: it.key,
      label: it.label,
      required: !!it.required,
      note: it.note ?? null,
      ready: false, // 由用户在前端逐项勾选；服务端不代用户确认
    }));

    const warnings = [
      '本助手只做表单预填与材料提醒，不会也不代替你在平台提交作品（no_auto_submit）。',
      `平台账号身份：${platform.identity_choice}`,
      `审核周期参考：${platform.review_days} 天（以平台实时公告为准）`,
      platform.ai_declaration_required
        ? `AI 声明要求：${platform.ai_declaration_note ?? '发布时需勾选 AI 生成标识'}`
        : '该平台未标注强制 AI 声明，仍建议按监管要求标注',
      `上传端：${platform.upload_client}；小程序内无法内嵌第三方上传页，请在电脑端打开。`,
      '收益与分成以平台后台实际结算为准，工作台中的估算不构成承诺。',
    ];

    let deliveryGate = null;
    try {
      deliveryGate = compliancePack.deliveryGate({
        projectId: d.project_id,
        episodeNo: d.episode ?? 'E01',
      });
    } catch (e) {
      deliveryGate = { available: false, reason: e.message ?? '交付闸门暂不可用' };
    }

    const result = {
      distribution_id: d.id,
      project_id: d.project_id,
      episode: d.episode,
      platform: { code: platform.code, name: platform.name },
      current_status: d.status,
      generated_at: nowIso(),
      fields,
      checklist,
      links: {
        upload_url: platform.creator_url,
        label: `打开 ${platform.name} 创作中心上传页`,
        in_app_embeddable: false,
        reason: '第三方业务域名无法在小程序 web-view 内嵌，只能在新窗口打开',
        entry_note: platform.entry_note ?? null,
      },
      warnings,
      delivery_gate: deliveryGate,
      no_auto_submit: true,
      policy: {
        auto_submit: false,
        submit_actor: 'user_manual',
        status_writeback_only: true,
        note: '审核 / 签约 / 提现均由用户在平台完成，工作台只跟踪状态',
      },
    };
    result.copy_text = buildCopyText(result);
    return result;
  }

  /** 导出可下载、可留证的预填包（另一台电脑可导入） */
  exportBundle(distributionId) {
    const prepared = this.prepare(distributionId);
    const bundle = {
      schema: BUNDLE_SCHEMA,
      bundle_id: newId('bundle'),
      exported_at: nowIso(),
      ...prepared,
    };
    db.insert(BUNDLES, {
      id: bundle.bundle_id,
      distribution_id: distributionId,
      project_id: prepared.project_id,
      platform: prepared.platform.code,
      episode: prepared.episode,
      field_count: prepared.fields.length,
      checklist_count: prepared.checklist.length,
      no_auto_submit: true,
      exported_at: bundle.exported_at,
    });
    return bundle;
  }

  /** 导入预填包（离线迁移场景）；严格校验结构与 no_auto_submit 声明 */
  importBundle(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail(ERR.UPLOAD_BUNDLE_INVALID, '导入内容必须是对象');
    }
    if (payload.schema !== BUNDLE_SCHEMA) {
      fail(ERR.UPLOAD_BUNDLE_INVALID, `预填包 schema 不匹配，期望 ${BUNDLE_SCHEMA}`);
    }
    if (!Array.isArray(payload.fields) || !payload.fields.length) {
      fail(ERR.UPLOAD_BUNDLE_INVALID, '预填包缺少 fields 字段');
    }
    for (const f of payload.fields) {
      if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') {
        fail(ERR.UPLOAD_BUNDLE_INVALID, '预填字段必须包含 key 与 label');
      }
    }
    if (payload.no_auto_submit !== true) {
      fail(ERR.UPLOAD_NO_AUTO_SUBMIT, '导入包缺少 no_auto_submit=true 声明，拒绝导入');
    }
    const rec = db.insert(IMPORTS, {
      id: newId('imp'),
      bundle_id: payload.bundle_id ?? null,
      distribution_id: payload.distribution_id ?? null,
      platform: payload.platform?.code ?? null,
      field_count: payload.fields.length,
      checklist_count: Array.isArray(payload.checklist) ? payload.checklist.length : 0,
      no_auto_submit: true,
      imported_at: nowIso(),
    });
    return {
      ok: true,
      import_id: rec.id,
      distribution_id: rec.distribution_id,
      field_count: rec.field_count,
      checklist_count: rec.checklist_count,
      warnings: payload.warnings ?? [],
      no_auto_submit: true,
      note: '仅导入预填内容，未向任何平台提交作品',
    };
  }

  /**
   * 回写状态：只更新工作台自己的分发状态跟踪，不调用平台。
   * status 必须在该平台 status_flow 内，防止写入非法状态。
   */
  markUploaded(distributionId, payload = {}) {
    const d = this.#dist(distributionId);
    const platform = distributionHub.platform(d.platform);
    const flow = platform.status_flow ?? STATUS_FLOW.default;
    const status = payload.status ?? '审核中';
    if (!flow.includes(status)) {
      fail(ERR.UPLOAD_STATUS_INVALID, `平台 ${platform.name} 不支持状态 ${status}`, { allowed: flow });
    }
    const submission = db.insert(SUBMISSIONS, {
      id: newId('upl'),
      distribution_id: distributionId,
      project_id: d.project_id,
      platform: platform.code,
      platform_name: platform.name,
      episode: d.episode,
      status,
      opened_at: payload.openedAt ?? null,
      submitted_by: 'user_manual',
      auto_submitted: false,
      no_auto_submit: true,
      note: payload.note ?? null,
      prefill_snapshot: payload.prefill ?? null,
      created_at: nowIso(),
    });
    const distribution = distributionHub.updateStatus(distributionId, status, {
      last_upload_submission: submission.id,
      upload_prefill: payload.prefill ?? null,
    });
    return {
      distribution,
      submission,
      no_auto_submit: true,
      note: '状态已回写到工作台；平台侧的上传 / 审核 / 签约仍需你本人在平台完成',
    };
  }

  /** 某分发任务的状态回写历史 */
  submissions(distributionId) {
    this.#dist(distributionId);
    return db.find(SUBMISSIONS, (s) => s.distribution_id === distributionId);
  }

  /** 导出包留证记录 */
  bundles(distributionId) {
    this.#dist(distributionId);
    return db.find(BUNDLES, (b) => b.distribution_id === distributionId);
  }
}

function collectCharacters(plan, script, sb) {
  const out = [];
  const push = (name, desc) => {
    const n = String(name ?? '').trim();
    if (!n || out.some((x) => x.startsWith(n))) return;
    out.push(desc ? `${n}（${desc}）` : n);
  };
  const lists = [
    plan?.characters, script?.characters, sb?.characters,
    plan?.outline?.characters, script?.outline?.characters,
  ];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (typeof c === 'string') push(c);
      else if (c && typeof c === 'object') push(c.name ?? c.code, c.desc ?? c.role ?? c.identity ?? null);
    }
  }
  return out.slice(0, 12);
}

function buildSynopsis({ prompt, style, episodes, episodeSec }) {
  const base = String(prompt ?? '').trim() || '一部由 AI 辅助创作的竖屏漫剧';
  const meta = `共 ${episodes} 集，单集约 ${episodeSec ?? 90} 秒`;
  const tail = style ? `，${style} 画风` : '';
  const text = `${base}${tail}。${meta}。本作品由人工智能辅助生成，已经过人工审阅与编排。`;
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function buildCopyText(p) {
  const lines = [
    `【${p.platform.name} · 上传预填单】`,
    `剧集：${p.project_id} / ${p.episode}　生成时间：${p.generated_at}`,
    '',
    '— 基本信息 —',
    ...p.fields.filter((f) => f.copyable).map((f) => `${f.label}：${f.value}`),
    '',
    '— 上传前材料清单 —',
    ...p.checklist.map((c) => `[ ] ${c.required ? '【必填】' : ''}${c.label}`),
    '',
    '— 平台入口 —',
    `${p.links.label}：${p.links.upload_url}`,
    '',
    '— 提醒 —',
    ...p.warnings.map((w) => `· ${w}`),
    '',
    '本单仅用于预填与提醒，未向任何平台自动提交作品。',
  ];
  return lines.join('\n');
}

export const uploadHelper = new UploadHelper();
export default uploadHelper;
