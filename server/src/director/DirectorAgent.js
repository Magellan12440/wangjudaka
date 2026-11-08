/**
 * 内置虚拟导演（V4.11）。位置：贯穿整条链路的 N00，而不是某一环的助手。
 *
 * 为什么需要它：
 *   九大提示词库（V4.4）解决的是「每一环都有库可用」，但库是散落的 —— 剧本用情绪+节奏，
 *   分镜用运镜+光影+转场+特效，剪辑用剪辑配方+字幕同步。谁负责保证「每一环真的用了库、
 *   而且前后不打架」？答案是这位虚拟导演：它在每个节点上按同一套判断做决策，并留下可查的
 *   决策记录。用户不需要懂运镜，也能拿到按专业套路拍出来的片子。
 *
 * 两条硬规矩：
 *   1. **强制**：情绪 / 转场 / 运镜 / 节奏四库在任何生成前都必须有可解析的卡（auto 由导演选，
 *      pinned 由用户指定）。缺一张就不许生成，绝不"先出图再说"。
 *   2. **可覆盖**：用户可以把自己偏好的卡 pin 进来（手动选择引用），pin 生效的位置会写进
 *      总谱的 director_policy 与日志，出问题时能一眼看出"这招是用户点的，不是导演抽的"。
 *
 * 链式顺序（前一步不过闸，后一步不许开工）：
 *   outline → plan → script → rhythm → assets → storyboard → shots → edit → delivery
 */
import { db } from '../store/db.js';
import seeds from '../seeds/loader.js';
import * as prompts from '../prompts/PromptLibrary.js';
import { fail, ERR } from '../core/errors.js';
import { newId, nowIso } from '../core/util.js';

const POLICY = 'director_policies';
const LOG = 'director_logs';

/** 用户点名的四类导演技巧：任何内容生成都必须带上 */
export const CORE_LIBS = ['emotion', 'transition', 'movement', 'rhythm'];

/**
 * 链式节点定义。
 *  libs  —— 该节点必须应用的库（缺一即拦）
 *  stage —— 对应 prompts.STAGE_REQUIREMENTS 的环节名（只用于展示与校验口径对齐）
 */
export const CHAIN = [
  {
    key: 'outline', name: '大纲', stage: 'script', libs: ['emotion', 'rhythm'],
    what: '人物关系与主线落点，开场必须命中黄金三秒模板',
  },
  {
    key: 'plan', name: '导演总谱', stage: 'storyboard', libs: ['emotion', 'transition', 'movement', 'rhythm'],
    what: '镜别 / 运镜 / 光影 / 转场 / 节奏 / 情绪一次定死，下游不得改写',
  },
  {
    key: 'script', name: '剧本', stage: 'script', libs: ['emotion', 'rhythm'],
    what: '编剧只能在总谱给定的镜别与情绪里写对白与动作',
  },
  {
    key: 'rhythm', name: '节奏闸门', stage: 'script', libs: ['rhythm'],
    what: '黄金三秒 / 冲突密度 / 反转 / 共情四条闸门，不过则打回重写',
  },
  {
    key: 'assets', name: '资产设定图', stage: 'character', libs: ['emotion', 'lighting'],
    what: '角色 / 场景 / 道具先定妆，分镜才有视觉依据',
  },
  {
    key: 'storyboard', name: '分镜图', stage: 'storyboard', libs: ['movement', 'transition', 'rhythm', 'fx'],
    what: '按总谱展开，每镜带齐运镜与光影，不再事后补',
  },
  {
    key: 'shots', name: '视频片段', stage: 'media', libs: ['movement', 'lighting', 'emotion', 'fx', 'bgm'],
    what: '只负责让已定的表演动起来，时长与分镜严格一致',
  },
  {
    key: 'edit', name: '剪辑成片', stage: 'edit', libs: ['edit', 'sync', 'transition', 'bgm'],
    what: '剪辑配方 + 字幕同步：卡点、字号、停留时长都按库来',
  },
  {
    key: 'delivery', name: '分发上架', stage: 'edit', libs: ['sync', 'edit'],
    what: '五维一致性 + 证据链 + AI 标识全过才允许交付',
  },
];

/** 各库的导演默认选择（库里没有该 code 时退到第一张卡，绝不写死一个不存在的 code） */
const DEFAULT_CODE = {
  emotion: 'EMO-CALM-02',
  transition: 'TRN-HARDCUT',
  movement: 'SHT-STATIC',
  rhythm: 'HOOK-01',
  lighting: 'LIG-PRACTICAL',
  fx: 'FX-NONE',
  bgm: 'BGM-NONE',
  edit: 'EDR-SHORTDRAMA',
  sync: 'SYN-STD',
};

/** 库 → 校验器：确认 code 真实存在且维度正确（运镜必须是 movement 维度，否则等于没选） */
const VERIFY = {
  emotion: (c) => seeds.emotion(c),
  transition: (c) => seeds.transition(c),
  movement: (c) => (seeds.shot(c)?.dim === 'movement' ? seeds.shot(c) : null),
  rhythm: (c) => seeds.rhythm(c),
  lighting: (c) => seeds.lighting(c),
  fx: (c) => seeds.fx(c),
  bgm: (c) => seeds.bgm(c),
  edit: (c) => seeds.editRecipe(c),
  sync: (c) => seeds.subtitleSyncRule(c),
};

function listOf(kind) {
  const conf = prompts.KINDS[kind];
  return conf?.list?.() ?? [];
}

function fallbackCode(kind) {
  const list = listOf(kind);
  if (!list.length) return null;
  const conf = prompts.KINDS[kind];
  const want = DEFAULT_CODE[kind];
  const hit = want ? list.find((x) => conf.codeOf(x) === want) : null;
  return conf.codeOf(hit ?? list[0]);
}

function emptyPolicy(projectId) {
  const libs = {};
  for (const kind of Object.keys(VERIFY)) {
    libs[kind] = { mode: 'auto', code: null, updated_at: null };
  }
  return {
    id: null,
    project_id: projectId,
    mode: 'enforce',
    libs,
    updated_at: null,
    source: 'default',
  };
}

export class DirectorAgent {
  /** 当前策略（未设置时给内置默认：四库 auto，即"导演自己选，但必须选"） */
  policyOf(projectId) {
    const row = db.findOne(POLICY, (x) => x.project_id === projectId);
    const base = emptyPolicy(projectId);
    if (!row) return base;
    return {
      ...base,
      ...row,
      libs: { ...base.libs, ...(row.libs ?? {}) },
      source: 'project',
    };
  }

  /**
   * 用户手动选择引用某张卡（或恢复 auto）。
   * 只接受真实存在的 code：选了一张不存在的卡就报错，而不是静默退回 auto。
   */
  setPolicy(projectId, patch = {}) {
    if (!projectId) fail(ERR.BAD_REQUEST, '缺少项目编号');
    const cur = this.policyOf(projectId);
    const nextLibs = { ...cur.libs };
    for (const [kind, v] of Object.entries(patch.libs ?? {})) {
      const verify = VERIFY[kind];
      if (!verify) fail(ERR.BAD_REQUEST, `未知提示词库: ${kind}`);
      const mode = v?.mode === 'pinned' ? 'pinned' : 'auto';
      const code = mode === 'pinned' ? String(v?.code ?? '') : null;
      if (mode === 'pinned') {
        if (!code) fail(ERR.BAD_REQUEST, `${prompts.KINDS[kind].name} 选择了手动引用但没有给卡号`);
        const card = verify(code);
        if (!card) {
          fail(ERR.MISSING_DIRECTOR_CARD, `「${prompts.KINDS[kind].name}」里没有这张卡: ${code}`, {
            kind, code, hint: '请从库中选择现有卡号，或改回自动',
          });
        }
      }
      nextLibs[kind] = { mode, code, updated_at: nowIso() };
    }
    const mode = patch.mode === 'advisory' ? 'advisory' : 'enforce';
    const row = {
      project_id: projectId,
      mode,
      libs: nextLibs,
      updated_at: nowIso(),
    };
    const old = db.findOne(POLICY, (x) => x.project_id === projectId);
    const saved = old ? db.update(POLICY, old.id, row) : db.insert(POLICY, { id: newId('dpol'), ...row });
    this.log({
      projectId, stage: 'policy', action: 'set_policy',
      decisions: Object.entries(nextLibs)
        .filter(([, v]) => v.mode === 'pinned')
        .map(([k, v]) => `${prompts.KINDS[k]?.name ?? k} → ${v.code}（用户指定）`),
      gate: { ok: true, issues: [] },
    });
    return saved;
  }

  /** 恢复全自动：仍是强制，只是重新交给导演选 */
  resetPolicy(projectId) {
    const old = db.findOne(POLICY, (x) => x.project_id === projectId);
    if (old) db.remove(POLICY, old.id);
    this.log({
      projectId, stage: 'policy', action: 'reset_policy',
      decisions: ['全部恢复为导演自动选择（强制仍然生效）'], gate: { ok: true, issues: [] },
    });
    return this.policyOf(projectId);
  }

  /**
   * 解析某节点实际要用的库。
   * @returns { libs: {emotion:{code,source,name}}, missing: [], policy }
   */
  resolve(projectId, nodeKey) {
    const node = CHAIN.find((n) => n.key === nodeKey);
    if (!node) fail(ERR.BAD_REQUEST, `未知导演节点: ${nodeKey}`);
    const policy = this.policyOf(projectId);
    const libs = {};
    const missing = [];
    for (const kind of node.libs) {
      const conf = prompts.KINDS[kind];
      if (!conf) { missing.push({ kind, reason: '库未注册' }); continue; }
      const available = listOf(kind);
      if (!available.length) { missing.push({ kind, name: conf.name, reason: '库为空或未加载' }); continue; }

      const p = policy.libs[kind] ?? { mode: 'auto', code: null };
      let code = null;
      let source = 'auto';
      if (p.mode === 'pinned' && p.code) {
        const ok = VERIFY[kind]?.(p.code);
        if (!ok) {
          fail(ERR.MISSING_DIRECTOR_CARD,
            `${conf.name} 里已经没有这张卡了：${p.code}（剧集配置过期，请重新选择）`, { kind, code: p.code });
        }
        code = p.code;
        source = 'pinned';
      } else {
        code = fallbackCode(kind);
      }
      if (!code) { missing.push({ kind, name: conf.name, reason: '无法确定可用卡' }); continue; }
      libs[kind] = { kind, code, source, name: conf.name };
    }
    return { node: node.key, node_name: node.name, libs, missing, policy };
  }

  /**
   * 底层强制闸门：真正生成前调用。
   * advisory 模式下只返回问题不抛错（仅用于内部诊断），默认 enforce 直接拦。
   */
  assertStage(projectId, nodeKey) {
    const r = this.resolve(projectId, nodeKey);
    const issues = r.missing.map((m) => `${m.name ?? m.kind}：${m.reason}`);
    if (issues.length && r.policy.mode !== 'advisory') {
      fail(ERR.DIRECTOR_GATE_BLOCKED, `虚拟导演闸门未通过（${r.node_name}）：${issues.join('；')}`, {
        node: nodeKey, missing: r.missing,
      });
    }
    return r;
  }

  /** 编译请求可直接用的 libraries 覆盖对象（{kind: code}），只取 pinned 的卡 */
  libraryOverrides(projectId) {
    const policy = this.policyOf(projectId);
    const out = {};
    for (const [kind, v] of Object.entries(policy.libs ?? {})) {
      if (v.mode === 'pinned' && v.code) out[kind] = v.code;
    }
    return out;
  }

  /**
   * 把用户 pin 的技巧落到总谱上（"手动选择引用"的落点）。
   *
   * 只改"允许导演自由决定"的位置，不破坏结构硬规则：
   *  - 运镜：整片统一（用户点了推镜就是要推镜）
   *  - 转场：只替换原本已是非硬切的拍（配额与间隔仍由总谱裁决，不会被一条 pin 撞坏）
   *  - 情绪：整片统一，但必须落在该角色调色板内、且强度跳变 ≤2（否则只警告不硬改）
   *  - 节奏：只替换"推进"拍（开场钩子/反转/共情是结构位，不能被一张卡顶掉）
   */
  applyToPlan(plan, projectId) {
    const policy = this.policyOf(projectId);
    const applied = { movement: 0, transition: 0, emotion: 0, rhythm: 0 };
    const warnings = [];

    const pin = (kind) => {
      const p = policy.libs?.[kind];
      if (p?.mode !== 'pinned' || !p.code) return null;
      return VERIFY[kind]?.(p.code) ? p.code : null;
    };
    const moveCode = pin('movement');
    const trnCode = pin('transition');
    const emoCode = pin('emotion');
    const rhyCode = pin('rhythm');
    const emoCard = emoCode ? seeds.emotion(emoCode) : null;

    if (moveCode) {
      for (const ep of plan.episodes ?? []) {
        for (const b of ep.beats ?? []) {
          // 语法配方给了运镜就以配方为准（组合拳不能被单卡拆散），其余统一
          if (b.grammar?.recipe) continue;
          b.camera_move = moveCode;
          applied.movement += 1;
        }
      }
    }

    if (trnCode) {
      for (const ep of plan.episodes ?? []) {
        for (const b of ep.beats ?? []) {
          if (b.transition === 'TRN-HARDCUT' || b.transition === 'TRN-FREEZE') continue;
          b.transition = trnCode;
          b.transition_reason = '导演指定转场（用户在导演面板锁定）';
          applied.transition += 1;
        }
      }
    }

    if (emoCard) {
      const palettes = plan.global?.emotion_palettes ?? {};
      for (const ep of plan.episodes ?? []) {
        const prev = {};
        for (const b of ep.beats ?? []) {
          for (const ch of Object.keys(b.emotions ?? {})) {
            const palette = palettes[ch]?.palette ?? [];
            if (palette.length && !palette.includes(emoCode)) {
              warnings.push(`${ch} 的情绪调色板里没有 ${emoCode}，该角色保留原情绪`);
              continue;
            }
            const before = prev[ch];
            if (before !== undefined && Math.abs(before - emoCard.intensity) > 2) {
              warnings.push(`${ch} 从强度 ${before} 直接切到 ${emoCard.intensity} 会断裂，该拍保留原情绪`);
              continue;
            }
            b.emotions[ch] = emoCode;
            if (b.emotion_cards) b.emotion_cards[ch] = emoCode;
            prev[ch] = emoCard.intensity;
            applied.emotion += 1;
          }
        }
      }
    }

    if (rhyCode) {
      // 结构位（开场钩子 / 反转落点 / 共情高点 / 集末钩子）是节奏骨架，不能被一张卡统一顶掉；
      // 其余推进段与冲突升级段按用户选的卡走。
      const structural = new Set(['黄金三秒开场', '集末钩子', '反转落点', '共情高点']);
      for (const ep of plan.episodes ?? []) {
        for (const b of ep.beats ?? []) {
          if (structural.has(b.beat_purpose)) continue;
          b.rhythm_code = rhyCode;
          applied.rhythm += 1;
        }
      }
    }

    plan.global = {
      ...(plan.global ?? {}),
      director_policy: {
        mode: policy.mode,
        source: policy.source,
        pinned: Object.fromEntries(
          Object.entries(policy.libs ?? {})
            .filter(([, v]) => v.mode === 'pinned' && v.code)
            .map(([k, v]) => [k, v.code]),
        ),
        applied,
        warnings,
        applied_at: nowIso(),
      },
    };
    return { applied, warnings, plan };
  }

  /** 决策日志：谁在哪个节点做了什么决定，为什么。可查、可审计。 */
  log({ projectId, stage, action, decisions = [], gate = null, actor = 'director' }) {
    return db.insert(LOG, {
      id: newId('dlog'),
      project_id: projectId,
      stage,
      action,
      actor,
      decisions,
      gate,
      at: nowIso(),
    });
  }

  trail(projectId, limit = 40) {
    return db.find(LOG, (x) => x.project_id === projectId)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, Math.max(1, Number(limit) || 40));
  }

  /** 前端面板：链状态 + 当前策略 + 四库可选项 + 最近的决策 */
  overview(projectId) {
    const policy = this.policyOf(projectId);
    const planRec = db.findOne('director_plans', (x) => x.project_id === projectId);
    const assets = db.find('assets', (a) => a.project_id === projectId);
    const gens = db.find('generations', (g) => g.project_id === projectId);
    const films = db.find('episode_films', (f) => f.project_id === projectId);
    const packReady = db.findOne('submission_packs', (s) => s.project_id === projectId);
    const images = assets.filter((a) => a.image_url).length;

    const doneOf = {
      outline: Boolean(planRec?.outline || db.count('script_candidates', (c) => c.project_id === projectId)),
      plan: Boolean(planRec?.plan_id),
      script: Boolean(planRec?.script?.episodes?.length),
      rhythm: Boolean(planRec?.plan?.global?.rhythm_report?.passed),
      assets: assets.length > 0 && images >= assets.filter((a) => a.asset_type !== 'emotion' && a.asset_type !== 'voice').length,
      storyboard: Boolean(planRec?.storyboard?.shots?.length),
      shots: gens.some((g) => g.kind === 'video' && g.status === 'done'),
      edit: films.some((f) => f.url),
      delivery: Boolean(packReady),
    };

    const chain = CHAIN.map((n) => {
      const r = this.resolve(projectId, n.key);
      const gate = r.missing.length
        ? { ok: false, issues: r.missing.map((m) => `${m.name ?? m.kind}：${m.reason}`) }
        : { ok: true, issues: [] };
      return {
        key: n.key,
        name: n.name,
        what: n.what,
        done: Boolean(doneOf[n.key]),
        gate,
        libs: Object.values(r.libs).map((x) => ({
          kind: x.kind, name: x.name, code: x.code, source: x.source,
          label: labelOf(x.kind, x.code),
        })),
      };
    });

    return {
      project_id: projectId,
      director: {
        code: planRec?.plan?.director_code ?? null,
        name: seeds.director(planRec?.plan?.director_code)?.name ?? '内置虚拟导演',
        style: planRec?.plan?.style_code ?? null,
        role: '把九个内置库按链路强制落地，并对每一环节的产物负责',
      },
      mode: policy.mode,
      core_libs: CORE_LIBS.map((k) => ({
        kind: k,
        name: prompts.KINDS[k].name,
        hint: prompts.KINDS[k].hint,
        mode: policy.libs[k]?.mode ?? 'auto',
        code: policy.libs[k]?.mode === 'pinned' ? policy.libs[k].code : null,
        effective: policy.libs[k]?.mode === 'pinned' ? policy.libs[k].code : fallbackCode(k),
        effective_label: labelOf(k, policy.libs[k]?.mode === 'pinned' ? policy.libs[k].code : fallbackCode(k)),
        options: prompts.listKind(k).slice(0, 60),
      })),
      chain,
      next: chain.find((c) => !c.gate.ok) ?? chain.find((c) => !c.done) ?? null,
      log: this.trail(projectId, 20),
    };
  }
}

function labelOf(kind, code) {
  if (!code) return '—';
  const conf = prompts.KINDS[kind];
  const hit = (conf?.list?.() ?? []).find((x) => conf.codeOf(x) === code);
  return hit ? `${code} ${hit.name ?? ''}`.trim() : code;
}

export const directorAgent = new DirectorAgent();
export default directorAgent;
