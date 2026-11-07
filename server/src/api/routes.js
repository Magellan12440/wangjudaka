/**
 * HTTP 路由（零依赖，原生 http）。
 *
 * 安全原则：
 *  - 对外只返回 publicConfig() 白名单；任何含凭据的字段都不出网。
 *  - 所有响应统一 { ok, data } 或 { ok:false, code, message }。
 *  - 点数相关操作必须带 userId（生产环境应换成登录态鉴权，见 docs/上线前需提供的清单.md）。
 */
import seeds from '../seeds/loader.js';
import { config, publicConfig, relayHealthSummary } from '../config/env.js';
import { modelRegistry } from '../relay/ModelRegistry.js';
import { relayPool } from '../relay/RelayPool.js';
import { compiler } from '../compiler/PromptCompiler.js';
import { ledger } from '../ledger/Ledger.js';
import { assetLibrary } from '../assets/AssetLibrary.js';
import { creationDocs } from '../docs/CreationDocs.js';
import { rhythmMaster } from '../rhythm/RhythmMaster.js';
import { blueprintEngine } from '../pipeline/Blueprint.js';
import { generateService } from '../pipeline/GenerateService.js';
import { storyEngine } from '../pipeline/StoryEngine.js';
import { directorPlanEngine } from '../pipeline/DirectorPlan.js';
import { syncRun, syncProjectRuns, runProgress } from '../pipeline/RunSync.js';
import shotService from '../pipeline/ShotService.js';
import editService from '../pipeline/EditService.js';
import oneShot from '../pipeline/OneShot.js';
import { timeline } from '../media/Timeline.js';
import { renderer } from '../media/Renderer.js';
import { distributionHub } from '../distribution/DistributionHub.js';
import analytics from '../analytics/Analytics.js';
import consistencyChecker from '../qc/ConsistencyChecker.js';
import compliancePack from '../compliance/CompliancePack.js';
import { db } from '../store/db.js';
import canvasService from '../canvas/CanvasService.js';
import uploadHelper from '../distribution/UploadHelper.js';
import { configureProviders, providerStatus } from '../qc/providers/index.js';
import tryServeStatic, { staticStatus } from './static.js';
import tryServeMedia from './media.js';
import { parseMultipart, readRawBody } from './multipart.js';
import materialService from '../assets/MaterialService.js';
import objectStore from '../storage/ObjectStore.js';
import authService from '../auth/AuthService.js';
import accountCenter from '../auth/AccountCenter.js';
import { resolveScope, resolveOwnership } from '../auth/scope.js';
import * as relayRuntime from '../relay/RelayRuntime.js';
import * as promptLibrary from '../prompts/PromptLibrary.js';
import { probeModels } from '../relay/probeModels.js';
import contentSecurity from '../security/ContentSecurity.js';
import virtualPay from '../pay/VirtualPay.js';
import wechatClient from '../wechat/WechatClient.js';
import adminService from '../admin/AdminService.js';
import adminConsole from '../admin/AdminConsole.js';
import inviteService from '../growth/InviteService.js';
import seriesService from '../pipeline/SeriesService.js';
import { modelCatalog } from '../relay/ModelCatalog.js';
import { projectIndex } from '../projects/ProjectIndex.js';
import { shellService } from '../shell/ShellService.js';
import { productionService } from '../pipeline/ProductionService.js';
import { submissionPack } from '../distribution/SubmissionPack.js';
import { logger, redact } from '../core/redact.js';
import { AppError } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';

const PROJECTS = 'projects';

/**
 * 项目闸门（V4.2）。
 *
 * 产品规则：**没有项目，就没有剧本 / 分镜 / 视频**。
 * 所有创作类接口都从这里取项目，顺带完成归属校验 ——
 * 只要带登录态，就不能拿别人的项目 id 写东西。
 */
/** 运维通道：带正确的 X-Admin-Token 时可按 ?userId= 代查（仅内部工作台使用） */
function isOperator(req) {
  const expect = config.admin?.token;
  if (!expect) return false;
  const got = String(req?.headers?.['x-admin-token'] ?? '');
  return got.length > 0 && got === expect;
}

/** 取「当前用户 id」：口径统一在 auth/scope.js，这里只负责翻译成 HTTP 错误 */
function scopedUserId(req, query = {}) {
  const user = authService.optionalUser(req);
  const r = resolveScope({
    actorId: user?.id ?? null,
    operator: isOperator(req),
    production: config.server.env === 'production',
    queryUserId: query.userId ?? null,
  });
  if (r.mode === 'denied') throw new AppError('AUTH_REQUIRED', '请先登录');
  return r.userId;
}

function projectOf(req, projectId, { required = true } = {}) {
  if (!projectId) {
    if (!required) return null;
    throw new AppError('PROJECT_REQUIRED', '请先新建一个项目，再开始剧本与视频创作');
  }
  const p = db.findOne(PROJECTS, (x) => x.id === projectId);
  if (!p) throw new AppError('NOT_FOUND', '项目不存在');
  const actor = authService.optionalUser(req);
  const own = resolveOwnership({
    actorId: actor?.id ?? null,
    operator: isOperator(req),
    production: config.server.env === 'production',
    ownerId: p.user_id,
  });
  if (own === 'auth_required') throw new AppError('AUTH_REQUIRED', '请先登录');
  if (own === 'forbidden') throw new AppError('OBJECT_FORBIDDEN', '不能操作其他用户的项目');
  return p;
}

/**
 * 收益看板聚合（V4.4）。
 * 数据来源是用户自己在分发工作台回填的「播放/收益」，所以这里只做汇总与对账提示，
 * 不编造平台侧数据——没回填就是 0，并在 note 里说清楚。
 */
function revenueDashboard(userId) {
  const projects = db.find(PROJECTS, (p) => p.user_id === userId && p.archived !== true);
  const byProject = [];
  const byPlatform = {};
  const byMonth = {};
  let total = 0;
  let pending = 0;
  let settled = 0;
  let published = 0;

  /**
   * 金额与结算状态一律以 earnings 账为准（Analytics 的追加式收益账）。
   * distributions 上只有一份「累计金额 + 最近一期」的兼容快照，没有结算状态，
   * 只看快照会导致「已结算」永远为 0、跨月拆不开。
   */
  const projectIds = new Set(projects.map((p) => p.id));
  const earns = projectIds.size
    ? db.find('earnings', (e) => projectIds.has(e.project_id))
    : [];

  const distById = new Map();
  for (const p of projects) {
    const list = distributionHub.list(p.id).filter((d) => d && d.archived !== true);
    for (const d of list) distById.set(d.id, { d, p });
    if (list.length) {
      published += list.filter((d) => ['已上线', '已通过'].includes(d.status)).length;
    }
  }

  const amountByProject = {};
  for (const e of earns) {
    const amount = Number(e.gross_amount_cny ?? 0) || 0;
    total += amount;
    amountByProject[e.project_id] = (amountByProject[e.project_id] ?? 0) + amount;
    if (String(e.settlement_status ?? '') === '已结算') settled += amount; else pending += amount;

    const holder = distById.get(e.distribution_id);
    const d = holder?.d;
    const pcode = d?.platform_code ?? d?.platform ?? e.platform ?? 'unknown';
    byPlatform[pcode] ||= { platform_code: pcode, platform_name: seeds.platform(pcode)?.name ?? pcode, amount: 0, count: 0 };
    byPlatform[pcode].amount += amount;
    byPlatform[pcode].count += 1;

    const when = String(e.period ?? e.created_at ?? '').slice(0, 7);
    if (when) byMonth[when] = (byMonth[when] ?? 0) + amount;
  }

  const earnedProjectIds = new Set(earns.map((e) => e.project_id));
  for (const p of projects) {
    const list = distributionHub.list(p.id).filter((d) => d && d.archived !== true);
    if (!list.length) continue;
    // 一条收益都没回填的项目不进「按项目」——否则未回填时满屏 0，用户以为坏了；
    // 这时应该走空态引导去回填。
    if (!earnedProjectIds.has(p.id)) continue;
    byProject.push({
      project_id: p.id,
      title: p.title,
      index_label: projectIndex.view(p).index_label,
      distributions: list.length,
      amount: +(amountByProject[p.id] ?? 0).toFixed(2),
    });
  }

  const months = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).slice(-6);

  /**
   * 待回填清单（V4.5）：已上线/已通过但收益还是 0 的分发记录。
   * 之前用户要在「分发」页逐个平台点开才能填，8 个平台就是 8 次往返；
   * 这里一次性列出来，前端用批量回填一次提交。
   */
  const unfilled = [];
  const filledIds = new Set(earns.map((e) => e.distribution_id));
  for (const p of projects) {
    for (const d of distributionHub.list(p.id)) {
      if (!d || d.archived === true) continue;
      if (!['已上线', '已通过'].includes(d.status)) continue;
      // 只要账上已经有回填记录就不算待填（填 0 也是填过了，不能反复提醒）
      if (filledIds.has(d.id)) continue;
      const code = d.platform_code ?? d.platform ?? 'unknown';
      unfilled.push({
        distribution_id: d.id,
        project_id: p.id,
        title: p.title,
        platform_code: code,
        platform_name: seeds.platform(code)?.name ?? code ?? '未知平台',
        status: d.status,
        period: String(d.revenue?.period ?? d.updated_at ?? d.created_at ?? '').slice(0, 7) || null,
      });
    }
  }

  const balance = ledger.balance(userId);
  const lowLine = config.credit.lowBalancePoints;
  const quota = {
    balance: +Number(balance || 0).toFixed(2),
    low_line: lowLine,
    level: balance <= 0 ? 'empty' : (balance < lowLine ? 'low' : 'ok'),
    note: balance <= 0
      ? '点数已用完：下一集会在开始前暂停，充值后从当前集继续'
      : (balance < lowLine
        ? `点数偏低（低于 ${lowLine} 点）：成片是一集一结算，建议先充值再开托管，避免生成到一半停下`
        : null),
  };

  return {
    total: +total.toFixed(2),
    pending: +pending.toFixed(2),
    settled: +settled.toFixed(2),
    published_count: published,
    projects: byProject.sort((a, b) => b.amount - a.amount),
    platforms: Object.values(byPlatform).sort((a, b) => b.amount - a.amount),
    monthly: months.map(([month, amount]) => ({ month, amount: +amount.toFixed(2) })),
    unfilled,
    quota,
    note: total === 0
      ? '还没有回填收益：成片在分发平台上线后，回到「分发」页把播放与收益填进来，这里就会自动汇总'
      : '本页是你自己回填的口径，与平台后台对账时以平台结算单为准',
  };
}

/**
 * 批量回填收益（V4.5）。
 * 一次提交多条，逐条校验归属：任何一条不属于当前用户就整批拒绝，
 * 不做「部分成功」——半截写入会让用户对不上账。
 */
function batchFillRevenue(userId, { period = null, items = [] } = {}) {
  if (!Array.isArray(items) || !items.length) {
    throw new AppError('BAD_REQUEST', '没有要回填的记录');
  }
  if (items.length > 50) throw new AppError('BAD_REQUEST', '一次最多回填 50 条');

  const mine = new Set();
  for (const p of db.find(PROJECTS, (x) => x.user_id === userId)) {
    for (const d of distributionHub.list(p.id)) if (d) mine.add(d.id);
  }

  const clean = [];
  for (const it of items) {
    const id = String(it?.distribution_id ?? it?.id ?? '').trim();
    if (!id) throw new AppError('BAD_REQUEST', '缺少分发记录 ID');
    if (!mine.has(id)) throw new AppError('OBJECT_FORBIDDEN', '含不属于你的分发记录，整批未写入');
    const amount = Number(it?.amount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw new AppError('BAD_REQUEST', '金额必须是不小于 0 的数字');
    const status = String(it?.settlement_status ?? it?.settlementStatus ?? '待结算');
    if (!['待结算', '已结算'].includes(status)) throw new AppError('BAD_REQUEST', '结算状态只能是「待结算」或「已结算」');
    clean.push({ id, amount: +amount.toFixed(2), status });
  }

  const periodOrDefault = /^\d{4}-\d{2}$/.test(String(period ?? ''))
    ? String(period)
    : new Date().toISOString().slice(0, 7);

  let written = 0;
  for (const it of clean) {
    distributionHub.recordRevenue(it.id, {
      amount: it.amount,
      period: periodOrDefault,
      settlementStatus: it.status,
    });
    written += 1;
  }
  return { written, period: periodOrDefault, items: clean };
}

/**
 * 月度对账单（V4.5）：把 earnings 明细导成 CSV。
 *
 * 不直接吐 text/csv 流：小程序侧要拿到文件得 downloadFile + openDocument，
 * csv 在微信里打不开；这里返回 { csv, filename, rows }，前端复制到剪贴板，
 * 用户粘进 Excel/WPS 就能对账，路径最短。
 */
function revenueExport(userId, { period = null } = {}) {
  const projects = db.find(PROJECTS, (p) => p.user_id === userId);
  const nameById = new Map(projects.map((p) => [p.id, p.title]));
  const ids = new Set(projects.map((p) => p.id));
  // 缺省即当月：小程序只提供「本月对账单」一个入口，路径里不带参数便于前后端对齐校验
  const p = /^\d{4}-\d{2}$/.test(String(period ?? ''))
    ? String(period)
    : new Date().toISOString().slice(0, 7);

  let rows = ids.size ? db.find('earnings', (e) => ids.has(e.project_id)) : [];
  if (p) rows = rows.filter((e) => String(e.period ?? '').slice(0, 7) === p);

  const dist = new Map();
  for (const pid of ids) for (const d of distributionHub.list(pid)) if (d) dist.set(d.id, d);

  // 平台名、项目名必须是给人看的，导出里不能出现内部 code
  const HEAD = ['账期', '项目', '平台', '集数', '金额(元)', '结算状态', '发票状态', '回填时间'];
  const q = (c) => `"${String(c).replace(/"/g, '""')}"`;
  const lines = [HEAD.map(q).join(',')];
  let sum = 0;
  for (const e of rows.sort((a, b) => String(a.period).localeCompare(String(b.period)))) {
    const d = dist.get(e.distribution_id);
    const code = d?.platform_code ?? d?.platform ?? e.platform ?? '';
    const cells = [
      String(e.period ?? '').slice(0, 7),
      nameById.get(e.project_id) ?? '',
      seeds.platform(code)?.name ?? code,
      d?.episode ?? e.episode ?? '',
      Number(e.gross_amount_cny ?? 0).toFixed(2),
      e.settlement_status ?? '',
      e.invoice_status ?? '',
      String(e.created_at ?? '').slice(0, 19).replace('T', ' '),
    ];
    sum += Number(e.gross_amount_cny ?? 0) || 0;
    // CSV 转义：字段里可能有逗号/引号，统一加引号并双写引号
    lines.push(cells.map(q).join(','));
  }
  lines.push(['合计', '', '', '', sum.toFixed(2), '', '', ''].map(q).join(','));

  const label = p ?? '全部';
  return {
    filename: `收益对账单_${label}.csv`,
    period: p,
    rows: rows.length,
    total: +sum.toFixed(2),
    csv: `\ufeff${lines.join('\r\n')}`, // BOM：Excel 直接双击打开不乱码
    note: rows.length
      ? '金额为你自己回填的口径；与平台结算单对账时以平台为准'
      : '这个账期没有回填记录。先在收益看板「待回填」里填金额，再导出。',
  };
}

/**
 * 素材改编的准入校验（V4.6）。
 * 用户明确选了「改编我的素材」，就不能在他还没传素材时凭空编一个故事塞给他——
 * 那不是改编，是偷换。抽成纯函数便于单测。
 */
export function assertAdaptReady(spec = {}, digest = null) {
  if (spec.origin === 'material' && !(digest && digest.text)) {
    throw new AppError('MATERIAL_REQUIRED', '这条路是「改编我的素材」：先上传小说正文或剧本文本，再生成剧本');
  }
  return true;
}

/** 路由表：[method, pathPattern, handler] */
export { revenueDashboard, batchFillRevenue, revenueExport };

export const routes = [
  // —— 基础 ——
  ['GET', '/health', async () => {
    const v = seeds.validate();
    return {
      ok: true,
      service: 'wangju-daka-server',
      version: config.server.version,
      env: config.server.env,
      uptime_sec: Math.round(process.uptime()),
      relay: relayHealthSummary(),
      storage: objectStore.status(),
      seeds: v.counts,
      // 种子不全时仍返回 200（否则容器会被判不健康反复重启，掩盖真实原因），
      // 但把诚实状态和缺失清单直接暴露出来，线上一眼可见。
      seeds_ok: v.ok,
      seeds_missing: v.missing_files ?? [],
      seeds_problems: v.ok ? [] : v.problems.slice(0, 8),
      ports: [config.server.port, ...(globalThis.__extraPorts ?? [])],
    };
  }],

  ['GET', '/api/config', async () => publicConfig()],

  // —— 目录：风格/导演/镜头/光影/转场 ——
  ['GET', '/api/styles', async () => seeds.stylePresets.map((s) => ({
    code: s.code, name: s.name, palette: s.palette, art_prompt_zh: s.art_prompt_zh,
    director: s.director_profile_default, avg_shot_len: s.avg_shot_len,
  }))],
  ['GET', '/api/styles/:code', async ({ params }) => {
    const s = seeds.style(params.code);
    if (!s) throw new AppError('NOT_FOUND', '风格不存在');
    return s;
  }],
  ['GET', '/api/directors', async () => seeds.directorProfiles],
  ['GET', '/api/shot-cards', async ({ query }) => seeds.shotsByDim(query.dim ?? '') .length
    ? seeds.shotsByDim(query.dim)
    : seeds.shotCards],
  ['GET', '/api/lighting-cards', async ({ query }) =>
    query.cat ? seeds.lightingCards.filter((c) => c.cat === query.cat) : seeds.lightingCards],
  ['GET', '/api/transitions', async ({ query }) =>
    query.kind ? seeds.transitionCards.filter((t) => t.kind === query.kind) : seeds.transitionCards],
  ['GET', '/api/rhythm-templates', async ({ query }) =>
    query.cat ? seeds.rhythmByCat(query.cat) : seeds.rhythmTemplates],
  // —— 角色情绪库（V3.2：情绪作为资产） ——
  ['GET', '/api/emotion-cards', async ({ query }) => {
    let list = query.cat ? seeds.emotionsByCat(query.cat) : seeds.emotionCards;
    if (query.intensity) list = list.filter((c) => c.intensity === +query.intensity);
    return list.map((c) => ({
      code: c.code, cat: c.cat, name: c.name, intensity: c.intensity, valence: c.valence,
      arousal: c.arousal, prompt_zh: c.prompt_zh, motion_zh: c.motion_zh,
      shot_affinity: c.shot_affinity, lighting_affinity: c.lighting_affinity,
      transition_affinity: c.transition_affinity, bgm_mood: c.bgm_mood, duration_hint: c.duration_hint,
    }));
  }],
  ['GET', '/api/emotion-cards/:code', async ({ params }) => {
    const c = seeds.emotion(params.code);
    if (!c) throw new AppError('NOT_FOUND', '情绪卡不存在');
    return c;
  }],

  // —— 模型（前端只见展示名与点数价） ——
  ['GET', '/api/models', async ({ query }) => modelRegistry.listForClient(query.role || null)],
  // V4.3：用户可选模型目录（每个环节最多 5 个，已实测可用才出现）
  ['GET', '/api/catalog/models', async ({ query }) => {
    if (query.role) return modelCatalog.list(query.role);
    return modelCatalog.publicRoles();
  }],

  // —— 九大提示词库（V4.4）：前端只读展示「系统内置哪些专业约束」 ——
  ['GET', '/api/prompts', async () => ({
    summary: promptLibrary.summary(),
    stages: promptLibrary.STAGE_REQUIREMENTS,
  })],
  ['GET', '/api/prompts/:kind', async ({ params }) => {
    const kind = String(params.kind ?? '');
    if (!promptLibrary.KINDS[kind]) throw new AppError('PROMPT_KIND_UNKNOWN', `未知提示词库: ${kind}`);
    return { kind, name: promptLibrary.KINDS[kind].name, items: promptLibrary.listKind(kind) };
  }],

  // —— 账户与点数 ——
  ['GET', '/api/account/balance', async ({ query, req }) => {
    const uid = scopedUserId(req, query);
    const acc = ledger.ensureAccount(uid);
    return { user_id: acc.user_id, balance_points: acc.balance_points, total_spent: acc.total_spent };
  }],
  ['GET', '/api/account/entries', async ({ query, req }) => ledger.entries(scopedUserId(req, query), { limit: +(query.limit ?? 50) })],
  ['POST', '/api/account/recharge', async ({ body }) => {
    // 生产环境（虚拟支付已配置）：此运维通道关闭，充值只认 /api/pay/virtual/notify 验签回调
    if (wechatClient.payConfigured) {
      throw new AppError('FORBIDDEN', '虚拟支付已启用，充值请走 /api/pay/virtual/order 下单');
    }
    return ledger.recharge({
      userId: body.userId,
      points: body.points,
      idemKey: body.idemKey ?? newId('idem'),
      orderId: body.orderId ?? null,
    });
  }],
  ['GET', '/api/account/reconcile', async ({ query, req }) => ledger.reconcile(scopedUserId(req, query))],

  // —— 首页聚合（V4.0）：一次请求拿到项目列表 + 统计，避免小程序首屏多次往返 ——
  ['GET', '/api/home', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    // 历史项目补序号（幂等），保证列表里的 #编号 稳定且不重复
    projectIndex.ensure(userId);
    const all = db.find(PROJECTS, (p) => p.user_id === userId && (query.includeArchived === '1' || p.archived !== true))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const styleNames = new Map(seeds.stylePresets.map((s) => [s.code, s.name]));

    let totalMinutes = 0;
    let totalShots = 0;
    let totalCredits = 0;
    let totalEpisodes = 0;

    const projects = all.slice(0, 30).map((p) => {
      const spec = p.spec ?? {};
      const runs = blueprintEngine.list(p.id)
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      const run = runs[0] ? syncRun(runs[0].id) : null;
      const plan = db.findOne('director_plans', (x) => x.project_id === p.id);
      const gens = db.find('generations', (g) => g.project_id === p.id);
      const episodes = plan?.script?.episodes?.length
        ?? (Number(spec.episode_count) >= 1
          ? Math.min(200, Math.floor(Number(spec.episode_count)))
          : Math.max(1, Math.ceil(((Number(spec.total_minutes) || 10) * 60) / (Number(spec.episode_sec) || 90))));
      const shots = plan?.storyboard?.stats?.shots ?? 0;
      const credits = gens.reduce((a, g) => a + (Number(g.actual_credits) || 0), 0) || (run?.total_credits ?? 0);
      const prog = runProgress(run);

      totalMinutes += Number(spec.total_minutes) || 0;
      totalShots += shots;
      totalCredits += credits;
      totalEpisodes += episodes;

      return {
        ...p,
        ...projectIndex.view(p),
        style_name: styleNames.get(spec.style_code) ?? spec.style_code ?? '都市',
        episodes,
        shots,
        credits,
        progress: prog.percent,
        run_id: run?.id ?? null,
        next_node: prog.next,
        season_no: p.season_no ?? 1,
        series_id: p.series_id ?? null,
        prev_project_id: p.prev_project_id ?? null,
        archived: p.archived === true,
        updated_at: run?.updated_at ?? p._updatedAt ?? p.created_at ?? null,
      };
    });

    return {
      stats: {
        projects: all.length,
        episodes: totalEpisodes,
        shots: totalShots,
        minutes: totalMinutes,
        credits: totalCredits,
      },
      projects,
    };
  }],

  // —— 项目 ——
  // V3.5 合规：项目名/创意为用户输入，过文本机审
  ['POST', '/api/projects', async ({ body, req }) => {
    // 越权保护：带登录态时，只能给自己建项目（否则可替别人刷“首部作品”骗邀请奖励）
    const actor = authService.optionalUser(req);
    if (actor && body.userId && actor.id !== body.userId) {
      throw new AppError('OBJECT_FORBIDDEN', '不能替其他用户创建项目');
    }
    const userId = actor?.id ?? body.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录再新建项目');

    // V4.3：新建项目只需要一个剧名。创意、素材、风格都可以后置，
    // 但剧名是「一部剧」的身份，必须先有 —— 没有剧名的项目在列表里等于垃圾数据。
    const title = String(body.title ?? '').trim();
    if (!title) throw new AppError('TITLE_REQUIRED', '请先给这部剧起个名字');
    if (title.length > 30) throw new AppError('TITLE_TOO_LONG', '剧名最多 30 个字');

    await contentSecurity.assertText({
      content: [title, body.prompt].filter(Boolean).join('\n'),
      openid: contentSecurity.openidOf(userId),
      bizType: 'project_create', scene: 1,
    });

    // 续集：以既有项目为参考开下一季，继承规格与角色资产
    if (body.fromProjectId) {
      const r = seriesService.createSeason({
        projectId: body.fromProjectId,
        title: title ?? null,
        prompt: body.prompt ?? null,
      });
      const patch = projectIndex.assignPatch(r.project.user_id);
      db.update(PROJECTS, r.project.id, patch);
      // 剧壳：续集默认继承上一季的系列标识（片名卡/片尾文案），但重新生成片头视频
      try { shellService.inherit(body.fromProjectId, r.project.id); } catch { /* 剧壳缺失不阻塞开剧 */ }
      inviteService.markMilestone({ userId: r.project.user_id, milestone: 'project_created' });
      return db.findOne(PROJECTS, (x) => x.id === r.project.id);
    }

    const idx = projectIndex.assignPatch(userId);
    const proj = db.insert(PROJECTS, {
      id: newId('proj'),
      user_id: userId,
      title,
      ...idx,
      series_title: body.seriesTitle ? String(body.seriesTitle).slice(0, 30) : title,
      spec: {
        style_code: body.styleCode ?? 'STY-DUSHI',
        director_code: body.directorCode ?? null,
        aspect: body.aspect ?? '9:16',
        quality: body.quality ?? '1080p',
        total_minutes: body.totalMinutes ?? 10,
        episode_sec: body.episodeSec ?? 90,
        episode_count: body.episodeCount ?? null,
        preset: body.preset ?? 'balanced',
        video_type: body.videoType ?? 'dynamic',
        language: body.language ?? 'zh',
        prompt: body.prompt ?? null,
        /**
         * 创作来源（V4.6）：
         *   idea     —— AI 出创意（默认，现有路径）
         *   material —— 用户自带素材改编：系统必须沿用素材里的人物关系/世界观/关键情节
         * 只是标记，但 plan 生成时会用它做硬校验（没有素材正文就不许生成）。
         */
        origin: body.origin === 'material' ? 'material' : 'idea',
        /** 改编强度：faithful 忠于原著 / remix 按竖屏短剧重排（仅 origin=material 时有意义） */
        adapt_mode: body.adaptMode === 'faithful' ? 'faithful'
          : (body.adaptMode === 'remix' ? 'remix' : null),
        models: body.models ?? {},
        edit_profile: body.editProfile ?? 'ED-STD',
        ...(body.continuityFrom ? { continuity_from: body.continuityFrom } : {}),
      },
      shell: {
        enabled: body.shellEnabled !== false,
        series_title: body.seriesTitle ? String(body.seriesTitle).slice(0, 30) : title,
        tagline: String(body.tagline ?? '').slice(0, 40),
        opening: { enabled: true, sec: 3, text: title },
        ending: { enabled: true, sec: 4, text: '下集更精彩 · 关注不迷路' },
      },
      status: 'draft',
      created_at: nowIso(),
    });
    // 首个项目 = 邀请里程碑（被邀请人达标才给邀请人发奖）；幂等
    inviteService.markMilestone({ userId: proj.user_id, milestone: 'project_created' });
    return proj;
  }],
  // 按编号找项目：项目多了以后「第 7 部」比标题更好用（只在本用户内查）
  ['GET', '/api/projects/lookup', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    projectIndex.ensure(userId);
    const p = projectIndex.findByNo(userId, query.no);
    if (!p) throw new AppError('NOT_FOUND', '没有这个编号的项目');
    return { ...p, ...projectIndex.view(p) };
  }],
  ['GET', '/api/projects/:id', async ({ params, req }) => {
    const p = projectOf(req, params.id);
    return { ...p, ...projectIndex.view(p) };
  }],
  // 项目设置（V4.3）：剧名/风格/集数/时长/画质/模型/剪辑档位都可改，改完再生成
  ['POST', '/api/projects/:id/settings', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    const spec = { ...(p.spec ?? {}) };
    const num = (v, min, max, d) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
    };
    if (body.title !== undefined) {
      const t = String(body.title).trim();
      if (!t) throw new AppError('TITLE_REQUIRED', '剧名不能为空');
      db.update(PROJECTS, p.id, { title: t.slice(0, 30) });
    }
    if (body.styleCode) spec.style_code = String(body.styleCode).slice(0, 40);
    if (body.directorCode !== undefined) spec.director_code = body.directorCode || null;
    if (body.aspect) spec.aspect = ['9:16', '16:9', '4:3', '1:1'].includes(body.aspect) ? body.aspect : spec.aspect;
    if (body.quality) spec.quality = ['720p', '1080p', '2k'].includes(body.quality) ? body.quality : spec.quality;
    if (body.totalMinutes !== undefined) spec.total_minutes = num(body.totalMinutes, 1, 600, spec.total_minutes ?? 10);
    if (body.episodeSec !== undefined) spec.episode_sec = num(body.episodeSec, 15, 600, spec.episode_sec ?? 90);
    if (body.episodeCount !== undefined) spec.episode_count = num(body.episodeCount, 1, 200, null);
    if (body.videoType) spec.video_type = ['dynamic', 'static', 'narration'].includes(body.videoType) ? body.videoType : spec.video_type;
    if (body.prompt !== undefined) spec.prompt = String(body.prompt ?? '').slice(0, 4000) || null;
    if (body.models && typeof body.models === 'object') {
      const next = { ...(spec.models ?? {}) };
      for (const role of ['chat', 'image', 'video', 'audio']) {
        if (body.models[role]) next[role] = modelCatalog.resolve(role, body.models[role]);
      }
      spec.models = next;
    }
    if (body.editProfile) {
      const ok = modelCatalog.list('edit').items.some((x) => x.code === body.editProfile);
      if (ok) spec.edit_profile = body.editProfile;
    }
    // V4.4：剪辑配方与字幕同步规则可由用户指定（不选就按风格自动搭配）
    if (body.editRecipe !== undefined) {
      if (!body.editRecipe) delete spec.edit_recipe;
      else if (seeds.editRecipe(String(body.editRecipe))) spec.edit_recipe = String(body.editRecipe);
    }
    if (body.subtitleSync !== undefined) {
      if (!body.subtitleSync) delete spec.subtitle_sync;
      else if (seeds.subtitleSyncRule(String(body.subtitleSync))) spec.subtitle_sync = String(body.subtitleSync);
    }
    if (body.seriesTitle !== undefined) {
      db.update(PROJECTS, p.id, { series_title: String(body.seriesTitle ?? '').slice(0, 30) || p.title });
    }
    const updated = db.update(PROJECTS, p.id, { spec });
    return { ...updated, ...projectIndex.view(updated) };
  }],

  // —— 项目详情聚合（V4.0）：一次请求渲染小程序详情页 ——
  ['GET', '/api/projects/:id/overview', async ({ params, req }) => {
    const p = projectOf(req, params.id);
    const runs = blueprintEngine.list(p.id)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const run = runs[0] ? syncRun(runs[0].id) : null;
    const planRec = db.findOne('director_plans', (x) => x.project_id === p.id);
    const assets = db.find('assets', (a) => a.project_id === p.id);
    const gens = db.find('generations', (g) => g.project_id === p.id)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

    let qc = null;
    try {
      qc = consistencyChecker.report(p.id);
    } catch { qc = null; }

    let gate = null;
    try {
      gate = compliancePack.deliveryGate({ projectId: p.id, episodeNo: 'E01' });
    } catch (e) {
      gate = { ready: false, blockers: [{ code: 'GATE_ERROR', issue: e.message }], warnings: [] };
    }

    let docs = null;
    try {
      const c = creationDocs.check(p.id);
      docs = { ok: c.ok, errors: (c.errors ?? []).length, warnings: (c.warnings ?? []).length };
    } catch { docs = null; }

    const style = seeds.style(p.spec?.style_code);
    const plan = planRec?.plan;
    const shots = (planRec?.storyboard?.shots ?? []).slice(0, 24).map((s) => ({
      no: s.no,
      episode: s.episode,
      duration: s.duration,
      shot_card: seeds.shot(s.shot_card)?.name ?? s.shot_card,
      shot_code: s.shot_card,
      lighting: (s.lighting_codes ?? []).map((c) => seeds.lighting(c)?.name ?? c).join(' / '),
      transition: seeds.transition(s.transition)?.name ?? s.transition,
      rhythm: s.rhythm,
      emotion: s.emotion ?? '—',
      dialogue: s.dialogue ?? '',
      speaker: s.speaker ?? '',
    }));

    const jobs = productionService.list(p.id);
    const films = editService.films(p.id);
    const packs = submissionPack.list(p.id);

    // 面向用户的「制作进度」：按真实产物统计。
    // 内部画布节点（12 步泳道）属于后端实现，不再作为用户可见口径。
    const progress = (() => {
      const hasScript = Boolean(planRec?.script?.episodes?.length);
      const hasShots = Boolean((planRec?.storyboard?.shots ?? []).length);
      const hasFrames = gens.some((g) => g.kind === 'image' && (g.url || g.status === 'done' || g.status === 'success'));
      const steps = [
        { key: 'script', name: '剧本', ok: hasScript },
        { key: 'shots', name: '分镜', ok: hasShots },
        { key: 'frames', name: '画面', ok: hasFrames || assets.some((a) => a.image_url) },
        { key: 'film', name: '成片', ok: films.length > 0 },
      ];
      const done = steps.filter((x) => x.ok).length;
      return {
        done,
        total: steps.length,
        percent: Math.round((done / steps.length) * 100),
        next: steps.find((x) => !x.ok) ?? null,
        steps,
      };
    })();

    return {
      project: { ...p, ...projectIndex.view(p) },
      index: projectIndex.view(p),
      shell: shellService.get(p.id),
      jobs: jobs.slice(0, 3),
      films: films.slice(0, 20),
      submissions: packs.slice(0, 3),
      style: style ? { code: style.code, name: style.name, art_prompt_zh: style.art_prompt_zh } : null,
      run,
      progress,
      plan: planRec ? {
        plan_id: planRec.plan_id,
        version: planRec.plan_version,
        passed: Boolean(plan?.validation?.ok),
        episodes: planRec.script?.episodes?.length ?? 0,
        beats: plan?.stats?.beats ?? 0,
        shots: planRec.storyboard?.stats?.shots ?? 0,
        total_sec: planRec.storyboard?.stats?.total_sec ?? 0,
        shot_kinds: plan?.validation?.stats?.shot_kinds ?? 0,
        created_at: planRec.created_at,
      } : null,
      shots,
      assets: {
        total: assets.length,
        ready: assets.filter((a) => a.image_url).length,
        items: assets.slice(0, 30).map((a) => ({
          code: a.asset_code, name: a.name, type: a.asset_type,
          version: a.version, locks: (a.locks ?? []).length,
          status: a.status, image_url: a.image_url,
        })),
      },
      generations: {
        total: gens.length,
        credits: gens.reduce((n, g) => n + (Number(g.actual_credits) || 0), 0),
        items: gens.slice(0, 20).map((g) => ({
          id: g.id, kind: g.kind, shot_no: g.shot_no, model: g.model,
          status: g.status, credits: g.actual_credits ?? g.estimated_credits ?? 0,
          url: g.output_url ?? g.url ?? null, created_at: g.created_at,
        })),
      },
      qc: qc ? {
        total: qc.total_shots, passed: qc.passed, drifted: qc.drifted, degraded: qc.degraded,
        avg: qc.avg_score, target: qc.kpi_target, kpi_met: qc.kpi_met,
        drift: qc.drift_shots.slice(0, 6).map((d) => ({
          shot: d.shot_no, score: d.score,
          advice: (d.advice ?? []).map((a) => a.mode).join(' / '),
        })),
      } : null,
      gate: gate ? {
        ready: gate.ready,
        blockers: (gate.blockers ?? []).slice(0, 8).map((b) => ({ code: b.code, issue: b.issue })),
        warnings: (gate.warnings ?? []).slice(0, 5),
      } : null,
      docs,
      materials: materialService.stats(p.id),
      materials_used: (planRec?.materials_used ?? []).length,
    };
  }],
  ['GET', '/api/projects', async ({ query, req }) => {
    const uid = scopedUserId(req, query);
    projectIndex.ensure(uid);
    return db.find(PROJECTS, (p) => p.user_id === uid
      && (query.includeArchived === '1' || p.archived !== true));
  }],

  // —— 系列 / 续集（V4.1）：一季一个项目，资产归属当季，可跨季继承设定 ——
  ['GET', '/api/series', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    return seriesService.listSeries(userId);
  }],
  ['GET', '/api/projects/:id/series', async ({ params }) => seriesService.seriesOf(params.id)],
  ['POST', '/api/projects/:id/season', async ({ params, body, req }) => {
    const before = db.findOne(PROJECTS, (x) => x.id === params.id);
    if (!before) throw new AppError('NOT_FOUND', '参考项目不存在');
    const actor = authService.optionalUser(req);
    if (actor && before.user_id !== actor.id) {
      throw new AppError('OBJECT_FORBIDDEN', '不能操作其他用户的项目');
    }
    await contentSecurity.assertText({
      content: [body.title, body.prompt].filter(Boolean).join('\n') || before.title,
      openid: contentSecurity.openidOf(before.user_id),
      bizType: 'project_create', scene: 1,
    });
    const r = seriesService.createSeason({
      projectId: params.id,
      title: body.title ?? null,
      prompt: body.prompt ?? null,
      inheritAssets: body.inheritAssets !== false,
    });
    inviteService.markMilestone({ userId: r.project.user_id, milestone: 'project_created' });
    return r;
  }],
  ['POST', '/api/projects/:id/archive', async ({ params, body }) => seriesService.setArchived(params.id, body.archived !== false)],
  ['GET', '/api/projects/:id/assets/lineage', async ({ params }) => seriesService.lineage(params.id)],

  // —— 邀请裂变（V4.1）：专属码 / 我的邀请面板 / 绑定 ——
  ['GET', '/api/invite/me', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    return inviteService.dashboard(userId);
  }],
  ['POST', '/api/invite/bind', async ({ body, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? body.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录');
    const ip = (req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').toString().split(',')[0].trim();
    return inviteService.bindOnRegister({ inviteeId: userId, code: body.code, deviceId: body.deviceId ?? null, ip });
  }],

  // —— 项目导演总谱（V3.2）：项目创建后先定死视听规划，再出图 ——
  // V4.2：生成前先把项目里的素材摘要注入大纲；素材是创作输入，不是装饰
  ['POST', '/api/projects/:id/plan', async ({ params, req }) => {
    const p = projectOf(req, params.id);
    const spec = p.spec ?? {};
    const prompt = spec.prompt || p.title || '未命名漫剧';
    const digest = materialService.digest(p.id);
    assertAdaptReady(spec, digest);
    if (digest.text) {
      await contentSecurity.assertText({
        content: digest.text.slice(0, 2400),
        openid: contentSecurity.openidOf(p.user_id),
        bizType: 'material_digest', bizId: p.id, scene: 1,
      });
    }
    const { outline } = await storyEngine.outline({
      userId: p.user_id, projectId: p.id, prompt, spec, reference: digest.text,
      model: modelCatalog.resolve('chat', spec.models?.chat ?? null),
    });
    const plan = storyEngine.directorPlan({ outline, spec, projectId: p.id });
    const script = await storyEngine.script({ outline, plan, spec, userId: p.user_id, projectId: p.id });
    const sb = await storyEngine.storyboard({ outline, spec, plan, script });
    const rec = {
      id: newId('dplan'),
      project_id: p.id,
      plan_id: plan.plan_id,
      plan_version: plan.plan_version,
      outline, plan, script, storyboard: sb,
      materials_used: digest.used,
      reference_chars: digest.chars,
      created_at: nowIso(),
    };
    const old = db.findOne('director_plans', (x) => x.project_id === p.id);
    if (old) {
      const patch = { ...rec };
      delete patch.id; // 覆盖时保留原记录 id
      db.update('director_plans', old.id, patch);
    } else {
      db.insert('director_plans', rec);
    }

    // N05 资产决策落库：把角色草稿写成正式资产（带连续性锁），无需用户手填
    const existing = db.find('assets', (a) => a.project_id === p.id);
    let assetCount = existing.length;
    if (!existing.length) {
      for (const d of storyEngine.toAssetDrafts(outline).slice(0, 8)) {
        try {
          assetLibrary.create({
            projectId: p.id,
            assetType: d.asset_type,
            name: d.name,
            locks: d.locks,
            lockValues: d.lock_values,
            meta: d.meta,
          });
          assetCount += 1;
        } catch (e) {
          logger.error('角色资产落库失败', { projectId: p.id, msg: e.message });
        }
      }
    }

    // 产物变了 → 同步节点进度（真实产物驱动，不做假进度）
    const run = blueprintEngine.list(p.id)[0];
    if (run) syncRun(run.id);

    return {
      plan_id: plan.plan_id,
      validation: plan.validation,
      stats: plan.stats,
      script_episodes: script.episodes.length,
      shots: sb.stats.shots,
      total_sec: sb.stats.total_sec,
      assets: assetCount,
      materials_used: digest.used.length,
      reference_chars: digest.chars,
    };
  }],
  ['GET', '/api/projects/:id/plan', async ({ params, req }) => {
    projectOf(req, params.id);
    const rec = db.findOne('director_plans', (x) => x.project_id === params.id);
    if (!rec) throw new AppError('NOT_FOUND', '该项目还没有导演总谱，请先生成');
    return rec;
  }],

  // —— 剧本视图（V4.2）：只回大纲与剧本正文，供小程序「剧本」tab 阅读 ——
  ['GET', '/api/projects/:id/script', async ({ params, req }) => {
    projectOf(req, params.id);
    const rec = db.findOne('director_plans', (x) => x.project_id === params.id);
    if (!rec) throw new AppError('NOT_FOUND', '还没有剧本，请先上传素材并生成');
    return {
      plan_id: rec.plan_id,
      outline: rec.outline ?? null,
      episodes: (rec.script?.episodes ?? []).map((ep) => ({
        no: ep.no,
        scenes: (ep.scenes ?? []).map((sc) => ({
          beat_no: sc.beat_no,
          action: sc.action ?? '',
          dialogue: (sc.dialogue ?? []).map((d) => ({ speaker: d.speaker, line: d.line })),
          locked: sc.locked ?? null,
        })),
      })),
      materials_used: rec.materials_used ?? [],
      created_at: rec.created_at,
    };
  }],

  // —— 一句话成片：先报价 ——
  ['POST', '/api/oneshot/quote', async ({ body }) => blueprintEngine.quote(body)],
  ['POST', '/api/runs', async ({ body, req }) => {
    const p = projectOf(req, body.projectId);
    const run = blueprintEngine.createRun({
      projectId: p.id, templateCode: body.templateCode ?? 'BP_ONESHOT',
    });
    // 建 run 时若项目已有剧本/总谱/资产，直接点亮对应节点
    return syncRun(run.id) ?? run;
  }],
  ['GET', '/api/runs/:id', async ({ params }) => syncRun(params.id)],
  ['GET', '/api/runs/:id/next', async ({ params }) => {
    const synced = syncRun(params.id);
    return synced ? (synced.nodes.find((n) => n.status === 'pending') ?? null) : null;
  }],
  ['POST', '/api/runs/:id/nodes/:nodeId', async ({ params, body }) => {
    const run = blueprintEngine.markNode(
      params.id, params.nodeId, { status: body.status, costCredits: body.costCredits ?? 0, error: body.error ?? null, output: body.output ?? null }
    );
    return syncRun(params.id) ?? run;
  }],
  ['GET', '/api/blueprints', async () => blueprintEngine.templates()],

  // —— 资产 ——
  ['POST', '/api/projects/:id/assets', async ({ params, body }) => assetLibrary.create({
    projectId: params.id, assetType: body.assetType, name: body.name,
    locks: body.locks ?? [], lockValues: body.lockValues ?? {}, imageUrl: body.imageUrl ?? null, meta: body.meta ?? {},
  })],
  ['GET', '/api/projects/:id/assets', async ({ params, query, req }) => {
    projectOf(req, params.id);
    return assetLibrary.list(params.id, query.type || null);
  }],
  ['POST', '/api/projects/:id/assets/impact', async ({ params, body }) => assetLibrary.impactOfUpdate({
    projectId: params.id, assetCode: body.assetCode, newVersion: body.newVersion, costPerShot: body.costPerShot ?? 6,
  })],
  // 情绪资产：把情绪卡固化成该角色的表演锁
  ['POST', '/api/projects/:id/assets/emotion', async ({ params, body }) => assetLibrary.createEmotion({
    projectId: params.id, emotionCode: body.emotionCode, characterCode: body.characterCode ?? null,
    name: body.name ?? null, lockValues: body.lockValues ?? {}, intensity: body.intensity ?? null,
  })],
  ['GET', '/api/projects/:id/assets/emotion', async ({ params, query, req }) => {
    projectOf(req, params.id);
    return assetLibrary.emotionsOf(params.id, query.characterCode || null);
  }],
  ['POST', '/api/projects/:id/assets/:code/emotion-palette', async ({ params, body }) => assetLibrary.setEmotionPalette(
    params.id, params.code, { baseline: body.baseline ?? null, palette: body.palette ?? [], forbid: body.forbid ?? [] }
  )],
  ['GET', '/api/projects/:id/assets/:code/emotion-palette', async ({ params }) =>
    assetLibrary.emotionPaletteOf(params.id, params.code)],

  // —— 项目素材库（V4.2）：小说文本 / 参考图 / 参考视频 ——
  ['GET', '/api/projects/:id/materials', async ({ params, req }) => {
    projectOf(req, params.id);
    return { items: materialService.list(params.id), stats: materialService.stats(params.id) };
  }],
  // 粘贴正文 / 短文本：JSON 提交，最快路径
  ['POST', '/api/projects/:id/materials/text', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    const text = String(body.text ?? '').trim();
    await contentSecurity.assertText({
      content: text.slice(0, 2400),
      openid: contentSecurity.openidOf(p.user_id),
      bizType: 'material_text', bizId: p.id, scene: 1,
    });
    const item = materialService.addText({
      projectId: p.id, userId: p.user_id, name: body.name ?? '粘贴文本', text, note: body.note ?? '',
    });
    return { item, stats: materialService.stats(p.id) };
  }],
  // 上传文件：multipart/form-data（wx.uploadFile）
  ['POST', '/api/projects/:id/materials/upload', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    const files = body?.files ?? [];
    if (!files.length) throw new AppError('BAD_REQUEST', '没有收到文件');
    const note = body.fields?.note ?? '';
    const items = [];
    for (const f of files) {
      if (f.data.length > 24 * 1024 * 1024) {
        throw new AppError('MATERIAL_TOO_LARGE', '文件超过 24MB 限制');
      }
      // 文本类先过机审（二进制无法机审，交给下游审核与人工）
      if (/^(text\/|.*\.(txt|md|csv|tsv|json)$)/i.test(f.mime) || /\.(txt|md|csv|tsv|json)$/i.test(f.filename)) {
        const probe = f.data.slice(0, 2400).toString('utf8');
        await contentSecurity.assertText({
          content: probe,
          openid: contentSecurity.openidOf(p.user_id),
          bizType: 'material_file', bizId: p.id, scene: 1,
        });
      }
      items.push(await materialService.addFile({
        projectId: p.id, userId: p.user_id, filename: f.filename, mime: f.mime, buffer: f.data, note,
      }));
    }
    return { items, stats: materialService.stats(p.id) };
  }],
  /**
   * 云存储直传登记（V4.8）。
   * 小程序用 wx.cloud.uploadFile 把文件经微信内部链路直接放进云存储（不受服务器域名限制、
   * 也绕开 callContainer 100KiB 的请求体上限），这里只负责「认领」并把它记成项目素材。
   */
  ['POST', '/api/projects/:id/materials/cloud', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    const item = await materialService.addCloudFile({
      projectId: p.id,
      userId: p.user_id,
      fileId: body.file_id,
      filename: body.filename,
      mime: body.mime,
      note: body.note,
      size: body.size,
    });
    return { item, stats: materialService.stats(p.id) };
  }],
  ['POST', '/api/projects/:id/materials/:materialId/remove', async ({ params, req }) => {
    projectOf(req, params.id);
    return materialService.remove(params.id, params.materialId);
  }],
  ['GET', '/api/projects/:id/materials/digest', async ({ params, req }) => {
    projectOf(req, params.id);
    return materialService.digest(params.id);
  }],

  // —— 镜头生产（V4.2）：项目内按分镜号出关键帧 / 视频 ——
  ['POST', '/api/projects/:id/shots/:shotNo/generate', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    return shotService.generate({
      projectId: p.id,
      shotNo: params.shotNo,
      kind: body.kind === 'video' ? 'video' : 'image',
      userId: p.user_id,
    });
  }],
  ['GET', '/api/projects/:id/shots/:shotNo/generations', async ({ params, req }) => {
    projectOf(req, params.id);
    return { items: shotService.history(params.id, params.shotNo) };
  }],

  // —— 剪辑成片（V4.2）：剪辑单 → 字幕/配乐/音效 → mp4 ——
  ['GET', '/api/projects/:id/edit', async ({ params, query, req }) => {
    projectOf(req, params.id);
    return editService.plan(params.id, query.episode || null);
  }],
  ['POST', '/api/projects/:id/edit/render', async ({ params, body, req }) => {
    projectOf(req, params.id);
    return editService.render(params.id, body.episode || null, { preset: body.preset || null });
  }],
  ['GET', '/api/projects/:id/films', async ({ params, req }) => {
    projectOf(req, params.id);
    return { items: editService.films(params.id) };
  }],

  // —— 剧壳（V4.3）：系列标识 / 片头片尾 ——
  ['GET', '/api/projects/:id/shell', async ({ params, req }) => {
    projectOf(req, params.id);
    return shellService.get(params.id);
  }],
  ['POST', '/api/projects/:id/shell', async ({ params, body, req }) => {
    projectOf(req, params.id);
    return shellService.save(params.id, body ?? {});
  }],
  ['POST', '/api/projects/:id/shell/card', async ({ params, body, req }) => {
    projectOf(req, params.id);
    return shellService.renderCard(params.id, body.kind === 'outro' ? 'outro' : 'intro');
  }],

  // —— 剧集生产（V4.3）：单集成片 / 全自动托管 ——
  ['POST', '/api/projects/:id/produce', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    const job = productionService.create({
      projectId: p.id,
      userId: p.user_id,
      mode: body.mode === 'auto' ? 'auto' : 'single',
      episodes: body.episode ?? body.episodes ?? null,
      preset: body.preset || null,
    });
    return productionService.step(job.id);
  }],
  ['GET', '/api/projects/:id/produce', async ({ params, req }) => {
    projectOf(req, params.id);
    return { items: productionService.list(params.id) };
  }],
  ['GET', '/api/produce/:jobId', async ({ params }) => productionService.get(params.jobId)],
  ['POST', '/api/produce/:jobId/step', async ({ params }) => productionService.step(params.jobId)],
  ['POST', '/api/produce/:jobId/pause', async ({ params }) => productionService.pause(params.jobId)],
  ['POST', '/api/produce/:jobId/resume', async ({ params }) => productionService.resume(params.jobId)],
  // 我的资产：所有项目的成片（系列剧逐集成片后统一汇总，便于一键分发）
  ['GET', '/api/me/films', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    return { items: productionService.myFilms(userId, { limit: +(query.limit ?? 100) }) };
  }],

  // —— 分发资料包（V4.3）：一次备齐平台审核要的全部材料 ——
  ['POST', '/api/projects/:id/submission/prepare', async ({ params, body, req }) => {
    const p = projectOf(req, params.id);
    return submissionPack.prepare({
      projectId: p.id, episode: body.episode ?? null, platformCode: body.platformCode ?? null, userId: p.user_id,
    });
  }],
  ['GET', '/api/projects/:id/submission', async ({ params, req }) => {
    projectOf(req, params.id);
    return { items: submissionPack.list(params.id) };
  }],
  ['POST', '/api/submission/:packId/submitted', async ({ params, body }) =>
    submissionPack.markSubmitted({ packId: params.packId, distributionId: body.distributionId ?? null })],

  // —— 一句话成剧编排（V4.2）：plan → shots → edit 单步推进 ——
  ['POST', '/api/oneshot/start', async ({ body, req }) => {
    const p = projectOf(req, body.projectId);
    const run = oneShot.create({ projectId: p.id, userId: p.user_id });
    // 先跑第一步就返回，别把 HTTP 请求挂在长任务上
    return oneShot.step(run.id);
  }],
  ['GET', '/api/oneshot/:runId', async ({ params }) => oneShot.get(params.runId)],
  ['POST', '/api/oneshot/:runId/step', async ({ params }) => oneShot.step(params.runId)],

  // —— 创作文档 ——
  ['POST', '/api/projects/:id/docs', async ({ params, body }) => creationDocs.save({
    projectId: params.id, type: body.type, content: body.content,
  })],
  ['GET', '/api/projects/:id/docs', async ({ params, req }) => {
    projectOf(req, params.id);
    return creationDocs.all(params.id);
  }],
  ['GET', '/api/projects/:id/docs/check', async ({ params, req }) => {
    projectOf(req, params.id);
    return creationDocs.check(params.id);
  }],

  // —— 节奏大师 ——
  ['POST', '/api/rhythm/diagnose', async ({ body }) => rhythmMaster.diagnose(body.script)],
  ['POST', '/api/rhythm/gate', async ({ body }) => {
    try {
      return { passed: true, report: rhythmMaster.gate(body.script) };
    } catch (e) {
      return { passed: false, code: e.code, message: e.message, report: e.report };
    }
  }],
  ['GET', '/api/rhythm/curve', async ({ query }) => rhythmMaster.curve(+(query.totalSec ?? 90))],

  // —— 故事引擎 V3.2：大纲 → 导演总谱(N02.5) → 剧本(N03) → 分镜(N05) → 节奏过闸 ——
  // V4.2：全部要求 projectId —— 没有项目就没有剧本，避免"凭空生成"绕过项目资产与归属
  ['POST', '/api/story/outline', async ({ body, req }) => {
    const p = projectOf(req, body.projectId);
    await contentSecurity.assertText({
      content: body.prompt,
      openid: contentSecurity.openidOf(p.user_id),
      bizType: 'story_outline', bizId: p.id, scene: 3,
    });
    return storyEngine.outline({
      userId: p.user_id, projectId: p.id, prompt: body.prompt, spec: body.spec ?? p.spec, model: body.model ?? null,
    });
  }],
  ['POST', '/api/story/plan', async ({ body }) => storyEngine.directorPlan({
    outline: body.outline, spec: body.spec, projectId: body.projectId ?? null, planId: body.planId ?? null,
  })],
  ['POST', '/api/story/plan/validate', async ({ body }) => storyEngine.validatePlan(body.plan)],
  ['POST', '/api/story/plan/constraints', async ({ body }) => ({
    plan_id: body.plan.plan_id,
    constraints: directorPlanEngine.toScriptConstraints(body.plan, body.episodeNo ?? null),
  })],
  ['POST', '/api/story/script', async ({ body, req }) => {
    const p = projectOf(req, body.projectId);
    return storyEngine.script({
      outline: body.outline, plan: body.plan ?? null, spec: body.spec ?? p.spec,
      userId: p.user_id, projectId: p.id, model: body.model ?? null,
    });
  }],
  ['POST', '/api/story/storyboard', async ({ body, req }) => {
    projectOf(req, body.projectId);
    return storyEngine.storyboard({
      outline: body.outline, spec: body.spec, plan: body.plan ?? null,
      script: body.script ?? null, episodes: body.episodes ?? null, strict: body.strict !== false,
    });
  }],
  ['POST', '/api/story/rhythm', async ({ body }) => storyEngine.rhythmGate(body.outline)],
  ['POST', '/api/story/asset-drafts', async ({ body }) => storyEngine.toAssetDrafts(body.outline)],
  ['POST', '/api/story/chain', async ({ body, req }) => {
    // 一句话 → 完整前置链路（不生成视频，只产出可审阅的结构化产物）
    // V4.2：必须先有项目；素材摘要一并注入
    const p = projectOf(req, body.projectId);
    await contentSecurity.assertText({
      content: body.prompt,
      openid: contentSecurity.openidOf(p.user_id),
      bizType: 'story_chain', bizId: p.id, scene: 3,
    });
    const spec = body.spec ?? p.spec;
    const digest = materialService.digest(p.id);
    const { outline, fromModel, usage } = await storyEngine.outline({
      userId: p.user_id, projectId: p.id, prompt: body.prompt, spec, model: body.model ?? null,
      reference: digest.text,
    });
    const plan = storyEngine.directorPlan({ outline, spec, projectId: p.id });
    const script = await storyEngine.script({ outline, plan, spec, userId: p.user_id, projectId: p.id });
    const sb = await storyEngine.storyboard({ outline, spec, plan, script });
    const gate = storyEngine.rhythmGate(outline);
    return {
      outline, plan_id: plan.plan_id, plan_validation: plan.validation,
      plan, script, storyboard: sb, rhythm_gate: gate,
      from_model: fromModel, usage,
      materials_used: digest.used.length,
      next: '分镜图 → 关键帧/视频 → 时间线 → 渲染 → 分发',
    };
  }],

  // —— 生成（唯一出口） ——
  ['POST', '/api/generate', async ({ body, req }) => {
    const p = projectOf(req, body.projectId);
    return generateService.run({
      userId: p.user_id, projectId: p.id, kind: body.kind ?? 'image',
      compileRequest: body.compileRequest, purpose: body.purpose ?? 'preview',
      idemKey: body.idemKey ?? null,
      meta: {
        shotNo: body.shotNo ?? null,
        assetsSnapshot: body.assetsSnapshot,
        similarityScore: body.similarityScore ?? null,
        primaryAssetCode: body.primaryAssetCode ?? null,
        reference: body.reference ?? null,
        candidate: body.candidate ?? null,
      },
    });
  }],
  ['POST', '/api/generate/:id/regenerate', async ({ params, body }) => generateService.regenerate({
    userId: body.userId, projectId: body.projectId, generationId: params.id,
    mode: body.mode ?? 'resample', patch: body.patch ?? {},
  })],
  ['GET', '/api/generations', async ({ query }) => generateService.list(query.projectId, query.shotNo || null)],

  // —— 编译预览（不花钱，只看提示词与校验） ——
  ['POST', '/api/compile/preview', async ({ body }) => {
    const p = compiler.compile({ ...body.compileRequest, available_credits: body.availableCredits ?? 999999 });
    return p;
  }],
  ['POST', '/api/compile/validate', async ({ body }) => compiler.validateOnly(body.compileRequest)],

  // —— 时间线与渲染 ——
  ['POST', '/api/timeline/build', async ({ body }) => timeline.build(body.segments ?? [], { directorProfile: body.directorProfile ?? 'DIR-BALANCED' })],
  ['POST', '/api/render/command', async ({ body }) => renderer.buildCommand({
    timeline: body.timeline, audio: body.audio ?? {}, output: body.output ?? 'out/episode.mp4',
  })],
  ['POST', '/api/render/music', async ({ body }) => renderer.buildMusicSpec({
    timeline: body.timeline, moodByShot: body.moodByShot ?? {},
  })],
  ['POST', '/api/render/delivery', async ({ body }) => renderer.buildDeliveryPackage({
    projectId: body.projectId, episodeNo: body.episodeNo, timeline: body.timeline,
    musicSpec: body.musicSpec ?? { credits_required: [] }, generations: body.generations ?? [],
  })],

  // —— 分发 ——
  ['GET', '/api/platforms', async () => distributionHub.platforms()],
  ['POST', '/api/distribution', async ({ body }) => distributionHub.create({
    projectId: body.projectId, episodeNo: body.episodeNo, platformCode: body.platformCode, userId: body.userId,
  })],
  ['POST', '/api/distribution/:id/status', async ({ params, body }) => distributionHub.updateStatus(params.id, body.status, body.extra ?? {})],
  ['POST', '/api/distribution/:id/contract', async ({ params, body }) => distributionHub.signContract(params.id, body ?? {})],
  ['POST', '/api/distribution/:id/revenue', async ({ params, body }) => distributionHub.recordRevenue(params.id, body)],
  ['POST', '/api/distribution/:id/stats', async ({ params, body }) => distributionHub.recordStats(params.id, body)],
  ['GET', '/api/distribution', async ({ query, req }) => {
    projectOf(req, query.projectId);
    return distributionHub.listWithSteps(query.projectId);
  }],
  ['GET', '/api/distribution/summary', async ({ query, req }) => {
    projectOf(req, query.projectId);
    return distributionHub.summary(query.projectId);
  }],

  // —— 质检：一致性自检（V3.3 / M3 出口条件）——
  ['GET', '/api/qc/providers', async () => consistencyChecker.listProviders()],
  ['POST', '/api/qc/consistency/check', async ({ body }) => consistencyChecker.check({
    projectId: body.projectId,
    shotNo: body.shotNo,
    assetCode: body.assetCode ?? null,
    generatedUrl: body.generatedUrl ?? null,
    generationId: body.generationId ?? null,
    reference: body.reference ?? null,
    candidate: body.candidate ?? null,
    similarityScore: body.similarityScore ?? null,
    providerName: body.provider ?? null,
    threshold: body.threshold ?? 0.82,
    strict: body.strict ?? false,
  })],
  ['GET', '/api/qc/consistency/report', async ({ query }) => consistencyChecker.report(query.projectId, {
    threshold: +(query.threshold ?? 0.82), episode: query.episode ?? null,
  })],
  ['GET', '/api/qc/consistency/advice/:id', async ({ params }) => consistencyChecker.adviceFor(params.id)],
  ['POST', '/api/qc/delivery-gate', async ({ body }) => compliancePack.deliveryGate({
    projectId: body.projectId, episodeNo: body.episodeNo ?? 'E01', threshold: +(body.threshold ?? 0.82),
  })],

  // —— 数据看板 / 收益（V3.3 / M5）——
  ['GET', '/api/analytics/dashboard', async ({ query }) => analytics.dashboard({
    projectId: query.projectId, from: query.from ?? null, to: query.to ?? null,
    granularity: query.granularity ?? 'day',
  })],
  ['GET', '/api/analytics/settlements', async ({ query }) => analytics.settlements({ projectId: query.projectId })],
  ['POST', '/api/analytics/stats', async ({ body }) => analytics.recordStatsSnapshot({
    distributionId: body.distributionId, stats: body.stats ?? body, recordedAt: body.recordedAt ?? null,
  })],
  ['POST', '/api/analytics/revenue', async ({ body }) => analytics.recordRevenue({
    distributionId: body.distributionId, period: body.period ?? null,
    grossAmount: body.grossAmount ?? body.amount, currency: body.currency ?? 'CNY',
    settlementStatus: body.settlementStatus ?? '待结算', note: body.note ?? null,
  })],
  ['POST', '/api/analytics/revenue/calculate', async ({ body }) => analytics.calculateRevenue({
    platformCode: body.platformCode, dramaType: body.dramaType ?? '2d',
    views: body.views ?? 0, completionRate: body.completionRate ?? 0.5,
    costPoints: body.costPoints ?? 0, exclusiveMultiplier: body.exclusiveMultiplier ?? 1,
  })],
  ['POST', '/api/analytics/settlement/:id', async ({ params, body }) => analytics.updateSettlement(params.id, {
    settlementStatus: body.settlementStatus ?? null, invoiceStatus: body.invoiceStatus ?? null,
  })],
  ['GET', '/api/revenue-policies', async () => analytics.policies()],

  // —— 合规交付包 / AI 创作说明截图包（V3.3 / M5）——
  ['POST', '/api/compliance/pack', async ({ body }) => {
    const projectId = body.projectId;
    if (!projectId) throw new AppError('BAD_REQUEST', '生成合规包需要 projectId');
    const episodeNo = body.episodeNo ?? 'E01';
    const rec = db.findOne('director_plans', (x) => x.project_id === projectId);
    const project = db.findOne(PROJECTS, (x) => x.id === projectId);
    const assets = assetLibrary.list(projectId);
    const gens = generateService.list(projectId);
    let tl = body.timeline ?? null;
    if (!tl && rec?.storyboard?.shots?.length) {
      const eps = rec.storyboard.shots.filter((s) =>
        `E${String(s.episode ?? 1).padStart(2, '0')}` === episodeNo || s.episode === episodeNo);
      tl = timeline.build((eps.length ? eps : rec.storyboard.shots).map((s) => ({
        shot_no: s.no, clip_url: `cos://${s.no}.mp4`, duration: s.duration,
        transition: s.transition, transition_reason: s.transition_reason,
        is_episode_end: s.is_episode_end, dialogue: s.dialogue ?? null,
      })), { directorProfile: rec.plan?.director_code ?? 'DIR-BALANCED' });
    }
    return compliancePack.build({
      projectId, episodeNo, project,
      plan: rec?.plan ?? null,
      script: rec?.script ?? null,
      storyboard: rec?.storyboard ?? null,
      assets, generations: body.generations ?? gens,
      timeline: tl,
      musicSpec: body.musicSpec ?? { credits_required: [] },
      coverage: body.coverage ?? null,
    });
  }],
  ['GET', '/api/compliance/pack', async ({ query }) => compliancePack.get(query.projectId, query.episodeNo ?? 'E01')],

  // —— PC 无限画布（阶段 H / V3.4）：DAG 是事实，布局只是渲染层 ——
  ['GET', '/api/canvas/runs', async ({ query }) => canvasService.list(query.projectId ?? '')],
  ['GET', '/api/canvas/:runId/graph', async ({ params }) => canvasService.graph(params.runId)],
  ['GET', '/api/canvas/:runId/layout', async ({ params }) => {
    const saved = canvasService.getLayout(params.runId);
    return saved ?? { ...canvasService.autoLayout(params.runId), persisted: false };
  }],
  ['PUT', '/api/canvas/:runId/layout', async ({ params, body }) =>
    canvasService.saveLayout(params.runId, body.layout ?? body)],
  ['POST', '/api/canvas/:runId/layout/reset', async ({ params }) => canvasService.resetLayout(params.runId)],

  // —— PC/H5 上传助手（阶段 H / V3.4）：只做预填与提醒，绝不自动投稿 ——
  ['POST', '/api/upload/prepare', async ({ body }) => uploadHelper.prepare(body.distributionId)],
  ['POST', '/api/upload/bundle', async ({ body }) => uploadHelper.exportBundle(body.distributionId)],
  ['POST', '/api/upload/import', async ({ body }) => uploadHelper.importBundle(body.bundle ?? body)],
  ['POST', '/api/upload/mark', async ({ body }) => uploadHelper.markUploaded(body.distributionId, body)],
  ['GET', '/api/upload/submissions', async ({ query }) => uploadHelper.submissions(query.distributionId)],
  ['GET', '/api/upload/bundles', async ({ query }) => uploadHelper.bundles(query.distributionId)],

  // —— 比对 provider 配置 / 异步自检（阶段 H / P0-1）——
  ['GET', '/api/qc/providers/config', async () => providerStatus()],
  ['POST', '/api/qc/providers/configure', async () => configureProviders()],
  ['POST', '/api/qc/consistency/check-async', async ({ body }) => consistencyChecker.checkAsync({
    projectId: body.projectId,
    shotNo: body.shotNo,
    assetCode: body.assetCode ?? null,
    generatedUrl: body.generatedUrl ?? null,
    generationId: body.generationId ?? null,
    reference: body.reference ?? null,
    candidate: body.candidate ?? null,
    providerName: body.provider ?? null,
    threshold: body.threshold ?? 0.82,
    strict: body.strict ?? false,
  })],

  // —— 本地 PC 工作台静态资源状态 ——
  ['GET', '/api/web/status', async () => staticStatus()],

  // —— 微信登录（V3.5）：wx.login(code) → openid → 自签 session token ——
  ['POST', '/api/auth/login', async ({ body, req }) => {    const r = await authService.login({
      code: body.code, nickname: body.nickname ?? null, avatar: body.avatar ?? null, req,
    });
    // 新用户带邀请码注册 → 建立邀请关系（有效性在此判定，不通过则如实返回原因）
    let invite = null;
    if (r.isNewUser && body.inviteCode) {
      const ip = (req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').toString().split(',')[0].trim();
      try {
        invite = inviteService.bindOnRegister({
          inviteeId: r.user.id, code: body.inviteCode, deviceId: body.deviceId ?? null, ip,
        });
      } catch (e) {
        invite = { ok: false, status: 'rejected', message: e.message };
      }
    }
    return { ...r, invite };
  }],
  ['GET', '/api/auth/me', async ({ req }) => {
    const user = authService.requireUser(req);
    return { user: authService.publicUser(user), mode: wechatClient.mode };
  }],
  // 补全头像昵称（登录后的一次性引导，也是「登录功能完善」的最后一环）
  ['POST', '/api/auth/profile', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return { user: authService.updateProfile(user.id, { nickname: body.nickname, avatar: body.avatar }) };
  }],
  // —— 账号体系（V4.4）：短信验证码 / 手机号密码 / 绑定手机 ——
  ['POST', '/api/auth/sms', async ({ body }) => authService.sendCode({ phone: body.phone })],
  ['POST', '/api/auth/login/code', async ({ body, req }) => {
    const r = authService.loginByCode({ phone: body.phone, code: body.code, nickname: body.nickname ?? null, req });
    return { ...r, invite: null };
  }],
  ['POST', '/api/auth/login/password', async ({ body, req }) => authService.loginByPassword({ phone: body.phone, password: body.password, req })],
  // —— 注册（V4.9）：手机号 + 密码，验证码可选 ——
  ['POST', '/api/auth/register', async ({ body, req }) => authService.register({
    phone: body.phone,
    password: body.password,
    nickname: body.nickname ?? null,
    code: body.code ?? null,
    req,
  })],
  // —— 改密码（需旧密码）/ 忘记密码（验证码） ——
  ['POST', '/api/auth/password/change', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return authService.changePassword(user.id, {
      oldPassword: body.oldPassword ?? '',
      newPassword: body.newPassword ?? body.password,
      sid: req.sessionId ?? null,
    });
  }],
  ['POST', '/api/auth/password/reset', async ({ body }) => authService.resetPassword({
    phone: body.phone, code: body.code, newPassword: body.newPassword ?? body.password,
  })],
  // —— 设备与登录态 ——
  ['GET', '/api/account/overview', async ({ req }) => {
    const user = authService.requireUser(req);
    return accountCenter.overview(user.id, req.sessionId ?? null);
  }],
  ['POST', '/api/account/logout-all', async ({ req }) => {
    const user = authService.requireUser(req);
    return authService.logoutAll(user.id);
  }],
  ['POST', '/api/account/sessions/revoke', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return authService.revokeSession(user.id, String(body.sessionId ?? ''));
  }],
  ['GET', '/api/account/quota', async ({ req }) => {
    const user = authService.requireUser(req);
    return accountCenter.quota(user.id);
  }],
  ['POST', '/api/account/alert', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return accountCenter.setAlert(user.id, { threshold: body.threshold });
  }],
  ['POST', '/api/account/close', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return authService.closeAccount(user.id, {
      confirmText: body.confirmText, password: body.password, code: body.code,
    });
  }],
  ['POST', '/api/auth/password', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return { user: authService.setPassword(user.id, { password: body.password }) };
  }],
  ['POST', '/api/auth/bind-phone', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return { user: authService.bindPhone(user.id, { phone: body.phone, code: body.code }) };
  }],

  // —— 收益看板（V4.4）：把分发回填的钱汇总成用户看得懂的口径 ——
  ['GET', '/api/me/revenue', async ({ req, query }) => {
    const userId = scopedUserId(req, query);
    return revenueDashboard(userId);
  }],

  // 批量回填（V4.5）：8 个平台逐个点开太反人类，一次填完；整批校验、整批写入
  ['POST', '/api/me/revenue/batch', async ({ req, body }) => {
    const userId = scopedUserId(req, {});
    return batchFillRevenue(userId, { period: body.period ?? null, items: body.items ?? [] });
  }],

  // 月度对账单 CSV（V4.5）：用户对账的第一个刚需
  ['GET', '/api/me/revenue/export', async ({ req, query }) => {
    const userId = scopedUserId(req, query);
    return revenueExport(userId, { period: query.period ?? null });
  }],

  ['GET', '/api/wechat/status', async () => wechatClient.status()],

  // —— 内容安全机审（V3.5）——
  ['POST', '/api/security/check', async ({ body }) => contentSecurity.checkText({
    content: body.content, openid: body.openid ?? contentSecurity.openidOf(body.userId), scene: body.scene ?? 3,
    bizType: body.bizType ?? 'manual_check', bizId: body.bizId ?? null,
  })],
  ['GET', '/api/security/audit', async ({ query }) => contentSecurity.auditTrail({
    bizType: query.bizType ?? null, limit: +(query.limit ?? 50),
  })],

  // —— 虚拟支付（V3.5）：iOS 合规唯一通道；mock 模式支持联调发货 ——
  ['GET', '/api/pay/packages', async () => ({
    packages: virtualPay.packages(),
    pay_mode: wechatClient.payConfigured ? 'live' : 'mock',
  })],
  ['POST', '/api/pay/virtual/order', async ({ body, req }) => {
    const user = authService.requireUser(req);
    return virtualPay.createOrder({ userId: user.id, packageId: body.packageId, sessionKey: body.sessionKey ?? null });
  }],
  ['GET', '/api/pay/virtual/orders', async ({ req }) => {
    const user = authService.requireUser(req);
    return virtualPay.listByUser(user.id);
  }],
  ['POST', '/api/pay/virtual/mock-success', async ({ body }) => virtualPay.mockPaySuccess({ orderId: body.orderId })],
  // 微信发货回调：验签依赖原始请求体（req._rawBody 由 readJsonBody 挂载）
  ['POST', '/api/pay/virtual/notify', async ({ body, req }) => {
    const signature = req.headers['wechatpay-signature'] ?? req.headers['x-wx-signature'] ?? '';
    return virtualPay.handleNotify({ signature, rawBody: req._rawBody ?? '', payload: body });
  }],

  // —— 充值档次与兑换码（V3.6 · 用户侧公开） ——
  // 小程序「我的」页动态拉取上架档次（含赠送福利）；与管理后台同源
  ['GET', '/api/recharge/packages', async () => ({
    packages: virtualPay.packages(),
    pay_mode: wechatClient.payConfigured ? 'live' : 'mock',
    cny_per_point: config.credit.cnyPerPoint,
    campaign: (() => {
      const c = adminService.campaign();
      const active = adminService.campaignActive();
      return { active, note: c.note || '', end_at: c.endAt ?? null };
    })(),
  })],
  // 兑换码兑换算力额度：幂等（每码每用户一次），入账走 Ledger
  ['POST', '/api/redeem', async ({ body, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? body.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录再兑换');
    return adminService.redeem({ userId, code: body.code });
  }],
  ['GET', '/api/redeem/mine', async ({ query, req }) => {
    const userId = scopedUserId(req, query);
    return { items: adminService.myRedeems(userId, { limit: +(query.limit ?? 50) }) };
  }],

  // —— 管理员账号（V4.7）：小程序内也能进后台 ——
  // 这三个是公开接口（否则没人能建第一个管理员），但都不回吐激活码本身。
  ['GET', '/api/admin/bootstrap', async () => adminConsole.bootstrapStatus()],
  ['POST', '/api/admin/bootstrap', async ({ body }) => adminConsole.bootstrap(body ?? {})],
  ['POST', '/api/admin/login', async ({ body }) => adminConsole.login(body ?? {})],

  // —— 管理员后台（V3.6）：X-Admin-Token 或 role=admin 的登录态，二者其一 ——
  // —— 运维诊断（V4.8.1）：微信登录到底卡在哪一环，别靠猜 ——
  ['GET', '/api/admin/diag/wechat', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return wechatClient.probe();
  }],
  ['GET', '/api/admin/diag/sms', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return {
      provider: config.sms?.provider || '',
      signName: config.sms?.signName || '',
      configured: Boolean(config.sms?.provider),
      hint: config.sms?.provider
        ? '已配置短信服务商'
        : '未配置 SMS_PROVIDER，手机验证码登录不可用（只能微信登录/密码登录）',
    };
  }],
  ['GET', '/api/admin/stats', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return adminConsole.stats();
  }],
  ['GET', '/api/admin/users', async ({ query, req }) => {
    adminConsole.assertAdmin(req);
    return adminConsole.listUsers({
      q: query.q ?? '',
      role: query.role ?? '',
      limit: query.limit ?? 30,
      offset: query.offset ?? 0,
    });
  }],
  ['GET', '/api/admin/users/:id', async ({ params, req }) => {
    adminConsole.assertAdmin(req);
    return adminConsole.userDetail(params.id);
  }],
  ['POST', '/api/admin/users/:id/points', async ({ params, body, req }) => {
    adminConsole.assertAdmin(req);
    return adminConsole.adjustPoints({
      userId: params.id,
      delta: body?.delta,
      note: body?.note ?? null,
      idemKey: body?.idemKey ?? null,
    });
  }],
  ['POST', '/api/admin/users/:id/status', async ({ params, body, req }) => {
    const actor = adminConsole.assertAdmin(req);
    return adminConsole.setUserStatus({ userId: params.id, status: body?.status, actorId: actor.userId });
  }],
  ['POST', '/api/admin/users/:id/role', async ({ params, body, req }) => {
    const actor = adminConsole.assertAdmin(req);
    return adminConsole.setUserRole({ userId: params.id, role: body?.role, actorId: actor.userId });
  }],

  // 算力网关：读脱敏状态 / 写新密钥（存数据盘，立即生效，不进 git）
  ['GET', '/api/admin/relay', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return relayRuntime.view();
  }],
  ['POST', '/api/admin/relay', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return relayRuntime.saveRelayRuntime({
      apiKey: body.apiKey,
      gateway: body.gateway,
      mock: body.mock,
    });
  }],
  // 立即按新密钥探活，避免「填完不知道通不通」
  ['POST', '/api/admin/relay/probe', async ({ req }) => {
    adminConsole.assertAdmin(req);
    const r = await probeModels({ deep: true });
    return { ...relayRuntime.view(), probe: r };
  }],
  ['GET', '/api/admin/overview', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return adminService.overview();
  }],
  ['GET', '/api/admin/packages', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return { items: adminService.listPackages({ includeOffline: true }) };
  }],
  ['POST', '/api/admin/packages', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.createPackage(body);
  }],
  ['POST', '/api/admin/packages/:id', async ({ params, body, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.updatePackage(params.id, body);
  }],
  ['POST', '/api/admin/packages/:id/status', async ({ params, body, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.setPackageStatus(params.id, body.status);
  }],
  ['POST', '/api/admin/redeem-codes', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.generateCodes(body);
  }],
  ['GET', '/api/admin/redeem-codes', async ({ query, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.listCodes({
      status: query.status ?? null, batchId: query.batchId ?? null,
      limit: +(query.limit ?? 100), offset: +(query.offset ?? 0),
    });
  }],
  ['GET', '/api/admin/redeem-codes/stats', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return adminService.codeStats();
  }],
  ['POST', '/api/admin/redeem-codes/revoke', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return adminService.revokeCode(body.code);
  }],

  // —— 管理端：邀请裂变（V4.1）——
  ['GET', '/api/admin/invites', async ({ query, req }) => {
    adminConsole.assertAdmin(req);
    return inviteService.adminList({
      status: query.status || null, limit: +(query.limit ?? 100), offset: +(query.offset ?? 0),
    });
  }],
  ['GET', '/api/admin/invites/stats', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return inviteService.adminStats();
  }],
  ['POST', '/api/admin/invites/reject', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return inviteService.adminReject(body.inviteId, body.reason ?? 'manual');
  }],
  ['GET', '/api/admin/invite-settings', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return inviteService.settings();
  }],
  ['POST', '/api/admin/invite-settings', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    return inviteService.updateSettings(body);
  }],
  ['GET', '/api/admin/redeem-codes/:code/usages', async ({ params, req }) => {
    adminConsole.assertAdmin(req);
    return { items: adminService.codeUsages(params.code) };
  }],

  // —— 管理端：充值活动（按档次加赠） ——
  ['GET', '/api/admin/campaign', async ({ req }) => {
    adminConsole.assertAdmin(req);
    const c = adminService.campaign();
    return { ...c, active: adminService.campaignActive() };
  }],
  ['POST', '/api/admin/campaign', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    const c = adminService.saveCampaign(body ?? {});
    return { ...c, active: adminService.campaignActive() };
  }],

  // —— 管理端：模型目录与探活（实测不可用的模型自动从用户列表消失） ——
  ['GET', '/api/admin/models/catalog', async ({ req }) => {
    adminConsole.assertAdmin(req);
    return { catalog: modelCatalog.all(), health: modelCatalog.health() };
  }],
  ['POST', '/api/admin/models/probe', async ({ body, req }) => {
    adminConsole.assertAdmin(req);
    const { probeModels } = await import('../relay/probeModels.js');
    return probeModels({ deep: body.deep === true });
  }],

  // —— 运维（生产需鉴权） ——
  ['GET', '/api/pool/health', async () => relayPool.health()],  ['POST', '/api/pool/state', async ({ body }) => relayPool.setPoolState(body)],
];

/** 简单路径匹配：/api/x/:id */
function matchPath(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS（本地联调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 阶段 H：PC 工作台页面（web/ 目录白名单，防目录穿越）
  if (tryServeStatic(req, res, pathname)) return;
  // V4.2：素材文件（/media/<24hex>.<ext>），支持 Range，供 <image>/<video> 直接引用
  if (tryServeMedia(req, res, pathname)) return;

  let body = {};
  if (method === 'POST' || method === 'PUT') {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('multipart/form-data')) {
      try {
        const raw = await readRawBody(req, { maxBytes: 26 * 1024 * 1024 });
        body = parseMultipart(raw, ct);
      } catch (e) {
        const code = e.code === 'MATERIAL_TOO_LARGE' ? 'MATERIAL_TOO_LARGE' : 'BAD_REQUEST';
        const status = e.code === 'MATERIAL_TOO_LARGE' ? 413 : 400;
        sendJson(res, status, { ok: false, code, message: e.message || '上传失败' });
        return;
      }
    } else {
      body = await readJsonBody(req).catch(() => ({}));
    }
  }

  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const params = matchPath(pattern, pathname);
    if (!params) continue;
    try {
      const query = Object.fromEntries(url.searchParams.entries());
      const data = await handler({ params, query, body, req });
      sendJson(res, 200, { ok: true, data: redact(data) });
      return;
    } catch (e) {
      const status = e.status ?? 400;
      const code = e.code ?? 'BAD_REQUEST';
      logger.error('请求处理失败', { path: pathname, code, msg: e.message });
      sendJson(res, status, { ok: false, code, message: e.message ?? '请求失败', detail: redact(e.detail ?? {}) });
      return;
    }
  }

  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `接口不存在: ${method} ${pathname}` });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      req._rawBody = raw; // 支付回调验签需要原始报文
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
