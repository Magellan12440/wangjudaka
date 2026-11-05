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
import authService from '../auth/AuthService.js';
import contentSecurity from '../security/ContentSecurity.js';
import virtualPay from '../pay/VirtualPay.js';
import wechatClient from '../wechat/WechatClient.js';
import adminService from '../admin/AdminService.js';
import inviteService from '../growth/InviteService.js';
import seriesService from '../pipeline/SeriesService.js';
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
function projectOf(req, projectId, { required = true } = {}) {
  if (!projectId) {
    if (!required) return null;
    throw new AppError('PROJECT_REQUIRED', '请先新建一个项目，再开始剧本与视频创作');
  }
  const p = db.findOne(PROJECTS, (x) => x.id === projectId);
  if (!p) throw new AppError('NOT_FOUND', '项目不存在');
  const actor = authService.optionalUser(req);
  if (actor && p.user_id !== actor.id) {
    throw new AppError('OBJECT_FORBIDDEN', '不能操作其他用户的项目');
  }
  return p;
}

/** 路由表：[method, pathPattern, handler] */
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

  // —— 账户与点数 ——
  ['GET', '/api/account/balance', async ({ query }) => {
    const acc = ledger.ensureAccount(query.userId);
    return { user_id: acc.user_id, balance_points: acc.balance_points, total_spent: acc.total_spent };
  }],
  ['GET', '/api/account/entries', async ({ query }) => ledger.entries(query.userId, { limit: +(query.limit ?? 50) })],
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
  ['GET', '/api/account/reconcile', async ({ query }) => ledger.reconcile(query.userId)],

  // —— 首页聚合（V4.0）：一次请求拿到项目列表 + 统计，避免小程序首屏多次往返 ——
  ['GET', '/api/home', async ({ query, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? query.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录');
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
        ?? Math.max(1, Math.ceil(((Number(spec.total_minutes) || 10) * 60) / (Number(spec.episode_sec) || 90)));
      const shots = plan?.storyboard?.stats?.shots ?? 0;
      const credits = gens.reduce((a, g) => a + (Number(g.actual_credits) || 0), 0) || (run?.total_credits ?? 0);
      const prog = runProgress(run);

      totalMinutes += Number(spec.total_minutes) || 0;
      totalShots += shots;
      totalCredits += credits;
      totalEpisodes += episodes;

      return {
        ...p,
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
    await contentSecurity.assertText({
      content: [body.title, body.prompt].filter(Boolean).join('\n'),
      openid: contentSecurity.openidOf(actor?.id ?? body.userId),
      bizType: 'project_create', scene: 1,
    });

    // 续集：以既有项目为参考开下一季，继承规格与角色资产
    if (body.fromProjectId) {
      const r = seriesService.createSeason({
        projectId: body.fromProjectId,
        title: body.title ?? null,
        prompt: body.prompt ?? null,
      });
      inviteService.markMilestone({ userId: r.project.user_id, milestone: 'project_created' });
      return r.project;
    }

    const proj = db.insert(PROJECTS, {
      id: newId('proj'),
      user_id: body.userId,
      title: body.title ?? '未命名漫剧',
      spec: {
        style_code: body.styleCode ?? 'STY-DUSHI',
        director_code: body.directorCode ?? null,
        aspect: body.aspect ?? '9:16',
        quality: body.quality ?? '1080p',
        total_minutes: body.totalMinutes ?? 10,
        episode_sec: body.episodeSec ?? 90,
        preset: body.preset ?? 'balanced',
        video_type: body.videoType ?? 'dynamic',
        language: body.language ?? 'zh',
        prompt: body.prompt ?? null,
        ...(body.continuityFrom ? { continuity_from: body.continuityFrom } : {}),
      },
      status: 'draft',
      created_at: nowIso(),
    });
    // 首个项目 = 邀请里程碑（被邀请人达标才给邀请人发奖）；幂等
    inviteService.markMilestone({ userId: proj.user_id, milestone: 'project_created' });
    return proj;
  }],
  ['GET', '/api/projects/:id', async ({ params }) => {
    const p = db.findOne(PROJECTS, (x) => x.id === params.id);
    if (!p) throw new AppError('NOT_FOUND', '项目不存在');
    return p;
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

    return {
      project: p,
      style: style ? { code: style.code, name: style.name, art_prompt_zh: style.art_prompt_zh } : null,
      run,
      progress: runProgress(run),
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
  ['GET', '/api/projects', async ({ query }) => db.find(PROJECTS, (p) => p.user_id === query.userId
    && (query.includeArchived === '1' || p.archived !== true))],

  // —— 系列 / 续集（V4.1）：一季一个项目，资产归属当季，可跨季继承设定 ——
  ['GET', '/api/series', async ({ query, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? query.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录');
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
    const user = authService.optionalUser(req);
    const userId = user?.id ?? query.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录');
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
    if (digest.text) {
      await contentSecurity.assertText({
        content: digest.text.slice(0, 2400),
        openid: contentSecurity.openidOf(p.user_id),
        bizType: 'material_digest', bizId: p.id, scene: 1,
      });
    }
    const { outline } = await storyEngine.outline({
      userId: p.user_id, projectId: p.id, prompt, spec, reference: digest.text,
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
  ['GET', '/api/projects/:id/assets', async ({ params, query }) => assetLibrary.list(params.id, query.type || null)],
  ['POST', '/api/projects/:id/assets/impact', async ({ params, body }) => assetLibrary.impactOfUpdate({
    projectId: params.id, assetCode: body.assetCode, newVersion: body.newVersion, costPerShot: body.costPerShot ?? 6,
  })],
  // 情绪资产：把情绪卡固化成该角色的表演锁
  ['POST', '/api/projects/:id/assets/emotion', async ({ params, body }) => assetLibrary.createEmotion({
    projectId: params.id, emotionCode: body.emotionCode, characterCode: body.characterCode ?? null,
    name: body.name ?? null, lockValues: body.lockValues ?? {}, intensity: body.intensity ?? null,
  })],
  ['GET', '/api/projects/:id/assets/emotion', async ({ params, query }) =>
    assetLibrary.emotionsOf(params.id, query.characterCode || null)],
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
      if (/^(text\/|.*\.(txt|md)$)/i.test(f.mime) || /\.(txt|md|docx)$/i.test(f.filename)) {
        const probe = f.data.slice(0, 2400).toString('utf8');
        await contentSecurity.assertText({
          content: probe,
          openid: contentSecurity.openidOf(p.user_id),
          bizType: 'material_file', bizId: p.id, scene: 1,
        });
      }
      items.push(materialService.addFile({
        projectId: p.id, userId: p.user_id, filename: f.filename, mime: f.mime, buffer: f.data, note,
      }));
    }
    return { items, stats: materialService.stats(p.id) };
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
    return editService.render(params.id, body.episode || null);
  }],

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
  ['GET', '/api/projects/:id/docs', async ({ params }) => creationDocs.all(params.id)],
  ['GET', '/api/projects/:id/docs/check', async ({ params }) => creationDocs.check(params.id)],

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
  ['GET', '/api/distribution', async ({ query }) => distributionHub.listWithSteps(query.projectId)],
  ['GET', '/api/distribution/summary', async ({ query }) => distributionHub.summary(query.projectId)],

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
  ['POST', '/api/auth/login', async ({ body, req }) => {
    const r = await authService.login({
      code: body.code, nickname: body.nickname ?? null, avatar: body.avatar ?? null,
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
  })],
  // 兑换码兑换算力额度：幂等（每码每用户一次），入账走 Ledger
  ['POST', '/api/redeem', async ({ body, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? body.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录再兑换');
    return adminService.redeem({ userId, code: body.code });
  }],
  ['GET', '/api/redeem/mine', async ({ query, req }) => {
    const user = authService.optionalUser(req);
    const userId = user?.id ?? query.userId;
    if (!userId) throw new AppError('AUTH_REQUIRED', '请先登录');
    return { items: adminService.myRedeems(userId, { limit: +(query.limit ?? 50) }) };
  }],

  // —— 管理员后台（V3.6）：一律 X-Admin-Token 鉴权，未配置 ADMIN_TOKEN 全部 403 ——
  ['GET', '/api/admin/overview', async ({ req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.overview();
  }],
  ['GET', '/api/admin/packages', async ({ req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return { items: adminService.listPackages({ includeOffline: true }) };
  }],
  ['POST', '/api/admin/packages', async ({ body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.createPackage(body);
  }],
  ['POST', '/api/admin/packages/:id', async ({ params, body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.updatePackage(params.id, body);
  }],
  ['POST', '/api/admin/packages/:id/status', async ({ params, body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.setPackageStatus(params.id, body.status);
  }],
  ['POST', '/api/admin/redeem-codes', async ({ body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.generateCodes(body);
  }],
  ['GET', '/api/admin/redeem-codes', async ({ query, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.listCodes({
      status: query.status ?? null, batchId: query.batchId ?? null,
      limit: +(query.limit ?? 100), offset: +(query.offset ?? 0),
    });
  }],
  ['GET', '/api/admin/redeem-codes/stats', async ({ req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.codeStats();
  }],
  ['POST', '/api/admin/redeem-codes/revoke', async ({ body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return adminService.revokeCode(body.code);
  }],

  // —— 管理端：邀请裂变（V4.1）——
  ['GET', '/api/admin/invites', async ({ query, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return inviteService.adminList({
      status: query.status || null, limit: +(query.limit ?? 100), offset: +(query.offset ?? 0),
    });
  }],
  ['GET', '/api/admin/invites/stats', async ({ req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return inviteService.adminStats();
  }],
  ['POST', '/api/admin/invites/reject', async ({ body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return inviteService.adminReject(body.inviteId, body.reason ?? 'manual');
  }],
  ['GET', '/api/admin/invite-settings', async ({ req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return inviteService.settings();
  }],
  ['POST', '/api/admin/invite-settings', async ({ body, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return inviteService.updateSettings(body);
  }],
  ['GET', '/api/admin/redeem-codes/:code/usages', async ({ params, req }) => {
    adminService.assertAdmin(req.headers['x-admin-token']);
    return { items: adminService.codeUsages(params.code) };
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
