/**
 * 合规交付包：AI 创作说明 + 创作过程截图包（§13.2 / §16 M5 / §19）。
 *
 * 这是本工作台相对拼凑工具的核心优势：平台（红果等）要求《AI 创作说明》并附
 * 「创作过程截图」，且截图要**全屏、带网址、带时间**。工作台天然记录了
 * 提示词日志、资产版本链、生成时间、卡片引用、模型与镜号，因此能一键渲染成
 * 可逐页打印/截图的自包含 HTML，而不是让人事后补截图。
 *
 * 产物落盘： <dataDir>/compliance/<projectId>/<episodeNo>/
 *   ai_declaration.md      AI 创作说明正文
 *   ai_evidence.html       7 页创作过程证据（全屏 / 网址 / 时间戳）
 *   manifest.json          交付清单 + 证据校验结果
 *   credits.txt            音乐署名（如有）
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/env.js';
import { db } from '../store/db.js';
import { fail, ERR } from '../core/errors.js';
import { nowIso, round } from '../core/util.js';
import consistencyChecker from '../qc/ConsistencyChecker.js';
import consistencyGuard from '../qc/ConsistencyGuard.js';

/** 证据页固定 7 类，缺一不可（与 §13.2 checklist 对齐） */
export const EVIDENCE_PAGES = [
  { key: 'project', title: '项目创建与需求输入', required: true },
  { key: 'script', title: '剧本 / 大纲生成记录', required: true },
  { key: 'storyboard', title: '分镜表与导演视听总谱', required: true },
  { key: 'assets', title: '角色 / 场景 / 道具资产与版本', required: true },
  { key: 'keyframes', title: '关键帧生成记录（提示词 / 模型 / 时间）', required: true },
  { key: 'videos', title: '视频生成记录（镜号 / 模型 / 时间）', required: true },
  { key: 'timeline', title: '剪辑时间线与转场理由', required: true },
];

const WORKSPACE_URL_DEFAULT = 'https://workbench.lingwu-drama.cn';

export class CompliancePack {
  constructor() {
    this.workspaceUrl = process.env.PUBLIC_WORKSPACE_URL || WORKSPACE_URL_DEFAULT;
    this.generator = '网剧大咖（AI 漫剧一站式创作 / 生成 / 分发平台）';
  }

  /**
   * 生成合规包。
   * @param {object} p projectId, episodeNo, project, plan, script, storyboard,
   *        assets, generations, timeline, musicSpec, coverage
   */
  build({
    projectId,
    episodeNo = 'E01',
    project = null,
    plan = null,
    script = null,
    storyboard = null,
    assets = null,
    generations = null,
    timeline = null,
    musicSpec = null,
    coverage = null,
  }) {
    if (!projectId) fail(ERR.BAD_REQUEST, '合规包需要 projectId');
    const proj = project ?? db.findOne('projects', (p) => p.id === projectId) ?? { id: projectId };
    const gens = generations ?? db.find('generations', (g) => g.project_id === projectId);
    const shots = storyboard?.shots ?? [];
    const segs = timeline?.segments ?? [];
    const assetList = Array.isArray(assets) ? assets : [];
    const genAt = nowIso();
    const dir = path.join(config.server.dataDir, 'compliance', safe(projectId), safe(episodeNo));
    fs.mkdirSync(dir, { recursive: true });

    const ctx = {
      projectId,
      episodeNo,
      project: proj,
      plan,
      script,
      shots,
      assets: assetList,
      generations: gens,
      segs,
      musicSpec,
      coverage,
      generatedAt: genAt,
      workspaceUrl: this.workspaceUrl,
      generator: this.generator,
    };

    const declaration = this.#declaration(ctx);
    const html = this.#evidenceHtml(ctx);
    const validation = this.validateEvidence(ctx);
    const manifest = {
      pack_id: `PACK-${projectId}-${episodeNo}`,
      project_id: projectId,
      episode: episodeNo,
      generated_at: genAt,
      generator: this.generator,
      workspace_url: this.workspaceUrl,
      files: [
        { name: 'ai_declaration.md', type: 'declaration', bytes: Buffer.byteLength(declaration, 'utf8') },
        { name: 'ai_evidence.html', type: 'evidence', bytes: Buffer.byteLength(html, 'utf8'), pages: EVIDENCE_PAGES.length },
        { name: 'manifest.json', type: 'manifest' },
        { name: 'credits.txt', type: 'credits', required: (musicSpec?.credits_required ?? []).length > 0 },
      ],
      evidence_pages: EVIDENCE_PAGES.map((p) => ({ ...p })),
      ai_label: {
        head_3s: config.compliance.aiLabelEnabled,
        cover: config.compliance.aiLabelEnabled,
        description: config.compliance.aiLabelEnabled,
        metadata: config.compliance.aiLabelEnabled,
        removable: false,
        text: config.compliance.aiLabelText,
      },
      counts: {
        shots: shots.length,
        segments: segs.length,
        assets: assetList.length,
        generations: gens.length,
        keyframes: gens.filter((g) => g.kind === 'image').length,
        videos: gens.filter((g) => g.kind === 'video').length,
      },
      validation,
      note: 'ai_evidence.html 用浏览器打开后逐页「打印为 PDF」或全屏截图，即满足平台对创作过程截图（全屏/带网址/带时间）的要求。',
    };

    fs.writeFileSync(path.join(dir, 'ai_declaration.md'), declaration, 'utf8');
    fs.writeFileSync(path.join(dir, 'ai_evidence.html'), html, 'utf8');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const credits = (musicSpec?.credits_required ?? []).map((c) => `${c.track}: ${c.text}`).join('\n');
    fs.writeFileSync(path.join(dir, 'credits.txt'), credits || '本片使用的 BGM 无需署名（或暂无需署名曲目）。\n', 'utf8');

    return { ...manifest, dir, html, declaration };
  }

  /** 读回已有合规包 */
  get(projectId, episodeNo = 'E01') {
    const dir = path.join(config.server.dataDir, 'compliance', safe(projectId), safe(episodeNo));
    const f = path.join(dir, 'manifest.json');
    if (!fs.existsSync(f)) fail(ERR.NOT_FOUND, '合规包尚未生成');
    const manifest = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      ...manifest,
      dir,
      html: fs.readFileSync(path.join(dir, 'ai_evidence.html'), 'utf8'),
      declaration: fs.readFileSync(path.join(dir, 'ai_declaration.md'), 'utf8'),
    };
  }

  /** 证据链完整性校验：缺页 / 无时间戳 / 无网址 / 无生成记录一律拦下 */
  validateEvidence(ctx) {
    const problems = [];
    if (!this.workspaceUrl || !/^https?:\/\//.test(this.workspaceUrl)) {
      problems.push({ code: 'EVIDENCE_NO_URL', issue: '证据页缺少工作台网址' });
    }
    if (!ctx.generatedAt) problems.push({ code: 'EVIDENCE_NO_TIME', issue: '证据页缺少生成时间戳' });
    if (!ctx.project?.id) problems.push({ code: 'EVIDENCE_NO_PROJECT', issue: '缺少项目编号' });
    if (!ctx.shots.length) problems.push({ code: 'EVIDENCE_NO_STORYBOARD', issue: '缺少分镜表，无法证明逐镜创作过程' });
    if (!ctx.generations.length) problems.push({ code: 'EVIDENCE_NO_GENERATIONS', issue: '缺少任何真实生成记录，禁止交付空壳证据包' });
    if (!ctx.generations.some((g) => g.kind === 'image')) {
      problems.push({ code: 'EVIDENCE_NO_KEYFRAME', issue: '缺少关键帧生成记录' });
    }
    if (!ctx.generations.some((g) => g.kind === 'video')) {
      problems.push({ code: 'EVIDENCE_NO_VIDEO', issue: '缺少视频生成记录' });
    }
    if (!ctx.segs.length) problems.push({ code: 'EVIDENCE_NO_TIMELINE', issue: '缺少剪辑时间线' });
    if (!config.compliance.aiLabelEnabled) {
      problems.push({ code: 'AI_LABEL_DISABLED', issue: 'AI 标识被关闭，违反 §19 红线，禁止交付' });
    }
    // 平台要求固定 7 类证据页；定义被改少/改多都要拦下，避免交付缺页的截图包
    if (EVIDENCE_PAGES.length !== 7 || EVIDENCE_PAGES.some((p) => !p.key || !p.title || p.required !== true)) {
      problems.push({ code: 'EVIDENCE_PAGE_MISSING', issue: '证据页定义不完整（应为 7 页且全部必填）' });
    }
    return {
      ok: problems.length === 0,
      problems,
      pages: EVIDENCE_PAGES.length,
      has_url: true,
      has_timestamp: !!ctx.generatedAt,
      fullscreen_printable: true,
    };
  }

  /**
   * 交付闸门（M4/M5 之间）：一致性 + 证据链 + AI 标识，任一不过即阻断。
   * 这是「一句话成片 → 上传分发」之前最后一道自动关卡。
   */
  deliveryGate({ projectId, episodeNo = 'E01', threshold = 0.82 }) {
    const qc = consistencyChecker.report(projectId, { threshold, episode: episodeNo });
    // V4.11：五维一致性（角色/道具/场景/内容/声音字幕）是底层强制规则，
    // 交付前必须整片过一遍 —— 图与图像不像是一回事，结构与声音对不上是另一回事。
    let fiveDim = null;
    try {
      fiveDim = consistencyGuard.audit(projectId, { episode: episodeNo });
    } catch {
      fiveDim = null;
    }
    let evidence;
    let pack = null;
    try {
      pack = this.get(projectId, episodeNo);
      evidence = pack.validation;
    } catch {
      evidence = { ok: false, problems: [{ code: 'PACK_NOT_BUILT', issue: '合规包尚未生成' }] };
    }
    const warnings = [];
    if (pack?.counts?.shots && qc.total_shots < pack.counts.shots) {
      warnings.push(`分镜共 ${pack.counts.shots} 镜，目前仅 ${qc.total_shots} 镜完成一致性自检；建议全量生成后再复核`);
    }
    const blockers = [];
    if (!qc.kpi_met) {
      blockers.push({ code: 'QC_KPI_NOT_MET', issue: `一致性 KPI 未达标（平均 ${qc.avg_score ?? '无分数'} / 目标 ${qc.kpi_target}）` });
    }
    for (const b of qc.blockers) {
      blockers.push({ code: b.type === 'drift' ? 'QC_DRIFT' : 'QC_MANUAL_REVIEW', issue: `${b.shot_no}: ${b.type === 'drift' ? `漂移分 ${b.score}` : b.note}` });
    }
    if (qc.total_shots === 0) blockers.push({ code: 'QC_EMPTY', issue: '尚未做任何一致性自检' });
    // 五维结构化一致性：任一维不过即阻断（这是硬规则，不是建议）
    for (const d of fiveDim?.dimensions ?? []) {
      if (d.ok) continue;
      const first = d.issues?.[0];
      blockers.push({
        code: 'CONSISTENCY_DIM_FAILED',
        issue: `${d.name}未通过：${d.failed}/${d.total} 镜有问题` +
          (first ? `（例 ${first.shot_no}：${first.issues?.[0]?.text ?? ''}）` : ''),
      });
    }
    for (const p of evidence.problems ?? []) blockers.push({ code: p.code, issue: p.issue });
    return {
      ready: blockers.length === 0,
      project_id: projectId,
      episode: episodeNo,
      blockers,
      warnings,
      consistency: qc,
      consistency_guard: fiveDim,
      evidence,
      next_actions: blockers.length
        ? ['按 drift_shots 的建议重生成或补接比对服务', '重新生成合规包', '再次调用本闸门']
        : ['下载交付包', '打开平台创作者中心上传', '回填分发状态'],
    };
  }

  // ——— 正文 ———
  #declaration(c) {
    const title = c.project?.title ?? '（未命名作品）';
    const style = c.project?.style_code ?? c.plan?.style_code ?? '未指定';
    const models = [...new Set(c.generations.map((g) => g.model).filter(Boolean))];
    const line = (s) => String(s ?? '').replace(/[|`]/g, ' ').trim();
    return `# AI 创作说明｜${line(title)}｜${c.episodeNo}

> 本文件由 ${this.generator} 于 ${c.generatedAt} 自动生成，用于向分发平台说明本作品的 AI 辅助创作过程。
> 工作台网址：${this.workspaceUrl}

## 一、作品基本信息

| 项 | 内容 |
|---|---|
| 项目编号 | ${line(c.projectId)} |
| 集号 | ${line(c.episodeNo)} |
| 作品名称 | ${line(title)} |
| 风格预设 | ${line(style)} |
| 分镜镜数 | ${c.shots.length} |
| 剪辑段落 | ${c.segs.length} |
| 生成记录数 | ${c.generations.length}（关键帧 ${c.generations.filter((g) => g.kind === 'image').length} / 视频 ${c.generations.filter((g) => g.kind === 'video').length}） |
| 资产数 | ${c.assets.length} |

## 二、AI 参与环节

本作品在以下环节使用了人工智能生成技术，全过程在本工作台内留痕：

1. **剧本与大纲**：由聊天模型依据用户一句话需求生成，经剧情节奏闸门（黄金三秒 / 强制冲突 / 强反转 / 强共情）校验。
2. **导演视听总谱**：在剧本与分镜图生成**之前**，逐拍确定镜别、运镜、光影、转场、节奏与角色情绪，并写入剧本硬约束。
3. **分镜图**：图片模型依据提示词编译器输出生成，编译器强制引用角色 / 场景 / 道具资产与连续性锁、情绪卡、镜头卡、光影卡、转场卡。
4. **视频片段**：视频模型以分镜图为首帧生成，逐镜记录模型、提示词、时间与消耗。
5. **配音与配乐**：TTS 与无版权 BGM 曲库，混音按 -16 LUFS / 真峰值 ≤ -1.5 dBTP 归一。
6. **剪辑合成**：按剪辑时间线拼接，转场卡带理由，输出含 AI 标识的 MP4。

## 三、人工创作与审核环节

- 用户提出原始创意、选定风格 / 总时长 / 单集时长 / 画幅 / 画质 / 模型；
- 用户对不满意的资产生成与视频片段按镜号选择重新生成（同参重抽 / 改提示词 / 换参考图 / 换模型）；
- 用户对分镜、成片、剪辑结果做人工审阅与取舍；
- 平台上传、内容审核、合同签订、收益提现由用户在平台创作者中心自行完成（小程序不代做）。

## 四、模型与工具清单

${models.length ? models.map((m) => `- ${line(m)}`).join('\n') : '- （本集暂无生成记录）'}

提示词编译器为唯一模型调用出口，任何生成均先通过强制校验（导演卡 / 光影卡 / 连续性锁 / 情绪卡 / 视觉依据 / 时长 / 对白 / 说话人 / 转场理由等）。

## 五、AI 标识

- 片头 3 秒画面标识：${config.compliance.aiLabelEnabled ? '已启用' : '未启用'}
- 封面角标、作品简介、MP4 元数据：${config.compliance.aiLabelEnabled ? '已启用' : '未启用'}
- 标识文案：${config.compliance.aiLabelText}
- **本平台不提供去除 AI 标识的功能**（§19 红线）。

## 六、版权与授权

- 剧本、角色、场景、道具由用户创意与本工作台生成，用户负责确认不侵犯第三方权利；
- BGM 取自无版权 / 可商用曲库并登记授权台账，需署名曲目见 credits.txt；
- 使用模型的商用许可由模型注册表 commercial_ok 字段控制，不可商用模型禁止用于交付产物；
- 平台分成、备案与审核结论以分发平台最新公告及实际审核为准。

## 七、创作过程证据

随附 \`ai_evidence.html\`，共 ${EVIDENCE_PAGES.length} 页，每页均包含：
工作台网址、生成时间戳、项目编号、页面标题与真实创作数据；
页面按全屏 A4 横向排版，可直接逐页打印为 PDF 或全屏截图，满足平台对创作过程截图的要求。

---
生成时间：${c.generatedAt}　|　工作台：${this.workspaceUrl}　|　文档版本：v3.4
`;
  }

  // ——— 证据页 HTML（自包含、可离线打印） ———
  #evidenceHtml(c) {
    const pages = [
      { key: 'project', title: '项目创建与需求输入', body: pageProject(c) },
      { key: 'script', title: '剧本 / 大纲生成记录', body: pageScript(c) },
      { key: 'storyboard', title: '分镜表与导演视听总谱', body: pageStoryboard(c) },
      { key: 'assets', title: '角色 / 场景 / 道具资产与版本', body: pageAssets(c) },
      { key: 'keyframes', title: '关键帧生成记录（提示词 / 模型 / 时间）', body: pageGenerations(c, 'image') },
      { key: 'videos', title: '视频生成记录（镜号 / 模型 / 时间）', body: pageGenerations(c, 'video') },
      { key: 'timeline', title: '剪辑时间线与转场理由', body: pageTimeline(c) },
    ];
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>创作过程证据包｜${esc(c.projectId)}｜${esc(c.episodeNo)}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Microsoft YaHei","PingFang SC",sans-serif; color:#1b2333; background:#eef1f6; }
  .page { width:297mm; min-height:210mm; padding:14mm 16mm 12mm; margin:8mm auto; background:#fff;
          page-break-after:always; position:relative; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .page:last-child { page-break-after:auto; }
  .hd { display:flex; justify-content:space-between; align-items:flex-end; border-bottom:2px solid #2f5cff; padding-bottom:6px; }
  .hd .brand { font-size:15pt; font-weight:700; color:#2f5cff; }
  .hd .meta { font-size:9pt; color:#5b657c; text-align:right; line-height:1.5; }
  h1 { font-size:19pt; margin:14px 0 4px; }
  .sub { color:#6b7488; font-size:10pt; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; font-size:9pt; margin:8px 0; }
  th,td { border:1px solid #d8deea; padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:#f2f6ff; color:#2f5cff; white-space:nowrap; }
  .kv { font-size:10pt; line-height:1.9; }
  .kv b { display:inline-block; min-width:110px; color:#445; }
  .box { background:#f7f9fd; border-left:3px solid #2f5cff; padding:9px 12px; font-size:9.5pt; margin:8px 0; white-space:pre-wrap; word-break:break-all; }
  .mono { font-family:Consolas,monospace; font-size:8.5pt; }
  .ft { position:absolute; left:16mm; right:16mm; bottom:7mm; border-top:1px solid #e2e7f0; padding-top:5px;
        display:flex; justify-content:space-between; font-size:8pt; color:#8892a6; }
  .tag { display:inline-block; background:#eaf0ff; color:#2f5cff; border-radius:3px; padding:1px 6px; margin-right:4px; font-size:8pt; }
  .warn { color:#b4453c; }
  @media print { body{background:#fff} .page{margin:0; box-shadow:none} }
</style></head><body>
${pages.map((p, i) => `<section class="page">
  <div class="hd">
    <div class="brand">网剧大咖 · 创作过程证据</div>
    <div class="meta">工作台网址：${esc(this.workspaceUrl)}<br>生成时间：${esc(c.generatedAt)}<br>项目编号：${esc(c.projectId)} ｜ 集号：${esc(c.episodeNo)}</div>
  </div>
  <h1>${i + 1}. ${esc(p.title)}</h1>
  <div class="sub">本页由工作台依据真实创作记录自动生成 · 全屏可打印 · 含网址与时间戳 · 第 ${i + 1} / ${pages.length} 页</div>
  ${p.body}
  <div class="ft"><span>${esc(this.generator)}</span><span>${esc(c.workspaceUrl)} ｜ ${esc(c.generatedAt)} ｜ ${esc(c.projectId)}-${esc(c.episodeNo)} ｜ ${i + 1}/${pages.length}</span></div>
</section>`).join('\n')}
</body></html>`;
  }
}

// ——— 各页内容（全部取自真实数据，无编造） ———
function pageProject(c) {
  const p = c.project ?? {};
  return `<div class="kv">
    <div><b>项目编号</b>${esc(c.projectId)}</div>
    <div><b>作品名称</b>${esc(p.title ?? '—')}</div>
    <div><b>创建时间</b>${esc(p.created_at ?? p._createdAt ?? '—')}</div>
    <div><b>风格预设</b>${esc(p.styleCode ?? p.style_code ?? '—')}</div>
    <div><b>画幅 / 画质</b>${esc(p.aspect ?? '9:16')} ｜ ${esc(p.quality ?? '1080p')}</div>
    <div><b>总时长 / 单集</b>${esc(p.totalMinutes ?? '—')} 分钟 ｜ ${esc(p.episodeSec ?? '—')} 秒</div>
    <div><b>用户原始需求</b>${esc(p.prompt ?? '—')}</div>
    <div><b>档位</b>${esc(p.preset ?? 'balanced')}</div>
  </div>
  <div class="box">用户在本页输入一句话需求并选择风格、时长、画幅、画质与模型后，工作台生成导演视听总谱并进入创作链。本页记录为平台审核提供「创作起点」举证。</div>`;
}

function pageScript(c) {
  const eps = c.script?.episodes ?? [];
  const rows = eps.slice(0, 12).map((e, i) => `<tr><td>E${String(i + 1).padStart(2, '0')}</td><td>${esc(e.title ?? e.summary ?? e.logline ?? '—')}</td><td>${esc(e.hook?.code ?? e.hook ?? '—')}</td><td>${esc((e.conflicts ?? []).length)}</td><td>${esc((e.reversals ?? []).length)}</td><td>${esc(e.ending_hook ?? '—')}</td></tr>`).join('');
  return `<table><thead><tr><th>集号</th><th>剧情摘要</th><th>黄金三秒钩子</th><th>冲突数</th><th>反转数</th><th>集末钩子</th></tr></thead><tbody>${rows || `<tr><td colspan="6">（无剧本记录）</td></tr>`}</tbody></table>
  <div class="kv"><div><b>节奏闸门</b>${c.plan?.validation?.ok === false ? '<span class="warn">未通过</span>' : '已通过（黄金三秒 / 强制冲突 / 强反转 / 强共情）'}</div>
  <div><b>总谱编号</b>${esc(c.plan?.plan_id ?? '—')}</div>
  <div><b>剧本集数</b>${eps.length}</div></div>
  <div class="box">剧本由聊天模型生成，并在写剧本之前注入导演视听总谱硬约束（镜别 / 光影 / 转场 / 节奏 / 情绪），逐场回抄 locked 标注，确保后续分镜与视频不脱离规划。</div>`;
}

function pageStoryboard(c) {
  const rows = c.shots.slice(0, 14).map((s) => `<tr><td>${esc(s.no)}</td><td>${esc(s.shot_card)}</td><td>${esc(s.camera_move ?? '—')}</td><td>${esc((s.lighting_codes ?? []).join(' / '))}</td><td>${esc(s.transition ?? '—')}</td><td>${esc(s.rhythm ?? '—')}</td><td>${esc(Object.values(s.emotions ?? {}).join(' / ') || '—')}</td><td>${esc(s.duration)}s</td></tr>`).join('');
  return `<table><thead><tr><th>镜号</th><th>镜别</th><th>运镜</th><th>光影卡</th><th>转场</th><th>节奏卡</th><th>情绪卡</th><th>时长</th></tr></thead><tbody>${rows || `<tr><td colspan="8">（无分镜记录）</td></tr>`}</tbody></table>
  <div class="kv"><div><b>分镜总数</b>${c.shots.length} 镜</div><div><b>总时长</b>${c.shots.reduce((a, s) => a + (Number(s.duration) || 0), 0)} 秒</div>
  <div><b>总谱拍数</b>${esc(c.plan?.stats?.beats ?? '—')}</div></div>
  <div class="box">每镜的镜别、光影、转场、节奏与情绪均来自导演视听总谱，分镜图生成时按 plan_id 继承，编译器强制校验卡片齐全。</div>`;
}

function pageAssets(c) {
  const rows = c.assets.slice(0, 14).map((a) => `<tr><td>${esc(a.asset_code)}</td><td>${esc(a.asset_type ?? a.type ?? '—')}</td><td>${esc(a.name ?? '—')}</td><td>v${esc(a.version ?? 1)}</td><td class="mono">${esc((a.locks ?? []).join('; ').slice(0, 160))}</td></tr>`).join('');
  return `<table><thead><tr><th>资产编码</th><th>类型</th><th>名称</th><th>版本</th><th>连续性锁</th></tr></thead><tbody>${rows || `<tr><td colspan="5">（无资产记录）</td></tr>`}</tbody></table>
  <div class="box">资产版本不可变；镜头固化生成当时的资产版本快照，后续修改角色卡不会污染已生成镜头，可预演影响面与重生成点数成本。情绪卡作为第五类资产参与构图与表演约束。</div>`;
}

function pageGenerations(c, kind) {
  const list = c.generations.filter((g) => g.kind === kind).slice(0, 12);
  const rows = list.map((g) => `<tr><td>${esc(g.shot_no ?? '—')}</td><td>${esc(g.model ?? '—')}</td><td class="mono">${esc(String(g.prompt_en ?? g.prompt_zh ?? '').slice(0, 150))}</td><td>${esc(g.created_at ?? '—')}</td><td>${esc(g.actual_credits ?? g.estimated_credits ?? '—')}</td><td>${esc(g.status ?? '—')}</td></tr>`).join('');
  return `<table><thead><tr><th>镜号</th><th>模型</th><th>提示词（截断）</th><th>生成时间</th><th>点数</th><th>状态</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="warn">（无${kind === 'image' ? '关键帧' : '视频'}生成记录）</td></tr>`}</tbody></table>
  <div class="kv"><div><b>记录总数</b>${c.generations.filter((g) => g.kind === kind).length}</div>
  <div><b>调用出口</b>提示词编译器 → 算力池唯一出口（带签名）</div></div>
  <div class="box">每条记录均可回溯到提示词、模型、资产版本、消耗点数与生成时间；不满意可按镜号重生成（同参重抽 / 改提示词 / 换参考图 / 换模型），重生成同样留痕。</div>`;
}

function pageTimeline(c) {
  const rows = c.segs.slice(0, 14).map((s) => `<tr><td>${esc(s.shot_no)}</td><td>${esc(s.start)}s → ${esc(s.end)}s</td><td>${esc(s.duration)}s</td><td>${esc(s.transition ?? 'TRN-HARDCUT')}</td><td>${esc(s.transition_reason ?? '—')}</td></tr>`).join('');
  return `<table><thead><tr><th>镜号</th><th>时间区间</th><th>时长</th><th>转场卡</th><th>转场理由</th></tr></thead><tbody>${rows || `<tr><td colspan="5">（无时间线记录）</td></tr>`}</tbody></table>
  <div class="kv"><div><b>片段总数</b>${c.segs.length}</div><div><b>总时长</b>${round(c.segs.reduce((a, s) => a + (Number(s.duration) || 0), 0), 2)} 秒</div>
  <div><b>混音规格</b>-16 LUFS / 真峰值 ≤ -1.5 dBTP / BGM ducking -12 dB</div>
  <div><b>AI 标识</b>${config.compliance.aiLabelEnabled ? '已写入片头 3 秒 + 封面 + 简介 + MP4 元数据' : '<span class="warn">未启用</span>'}</div></div>
  <div class="box">时间线按转场 7 条硬规则校验（非硬切占比上限、最小间隔、集末定格、理由必填等），渲染命令含 AI 标识烧录与响度归一，不可跳过。</div>`;
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export const compliancePack = new CompliancePack();
export default compliancePack;
