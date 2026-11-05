/**
 * 算力池适配器 —— 全系统唯一能调用上游模型的出口。
 *
 * 工程强制（§12.1 唯一出口原则 + §19 红线 3）：
 *  1. 构造函数私有：外部无法 new，只能通过模块内工厂拿到实例。
 *  2. 调用必须携带由 PromptCompiler 签发的 stamp；无 stamp 或 stamp 无效 → ILLEGAL_RELAY_ACCESS。
 *     这样"绕过编译器直接调模型"在代码层面不可能发生，且这条规则可被单元测试断言。
 *  3. 凭据只在模块内读取，任何返回值/日志都不带凭据（core/redact 兜底）。
 *
 * V3.5 真实网关协议（实测 https://api.lingkeai.ai/v1，2026-11-04）：
 *  - chat（语言模型）：POST /chat/completions，OpenAI 兼容，同步返回。
 *  - media（image/video/audio/music）：POST /media/generate → { data.task_id }
 *    → 轮询 GET /skills/task-status?task_id= 直至 is_final，成功取 result_url、cost（真实扣费算力）。
 *  - 该网关没有 /images/generations、/videos/generations、/audio/speech 这些 OpenAI 端点，
 *    媒体一律走任务制；余额/用量走 /skills/balance、/skills/usage。
 *
 * MOCK 模式：无 API Key 或 RELAY_MOCK=true 时不发真实请求，返回模拟产物，
 * 链路、校验、记账全部照常走，用于本地联调与自动化测试。
 */
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../core/redact.js';
import * as prompts from '../prompts/PromptLibrary.js';
import { fail, ERR } from '../core/errors.js';
import { relayPool } from './RelayPool.js';
import { modelRegistry } from './ModelRegistry.js';
import { newId, seedFrom } from '../core/util.js';

/** 签名密钥：进程内随机生成，外部无法伪造（重启即失效，防止跨进程伪造 stamp） */
const STAMP_SECRET = crypto.randomBytes(32).toString('hex');

/** 签发编译器 stamp —— 只允许 PromptCompiler 调用 */
export function issueStamp(payload) {
  const body = JSON.stringify({
    model: payload.target_model,
    kind: payload.kind,
    shot: payload.shot_no ?? null,
  });
  const sig = crypto.createHmac('sha256', STAMP_SECRET).update(body).digest('hex').slice(0, 32);
  return { body, sig };
}

function verifyStamp(stamp, payload) {
  if (!stamp || typeof stamp.sig !== 'string' || typeof stamp.body !== 'string') return false;
  const expectBody = JSON.stringify({
    model: payload.target_model,
    kind: payload.kind,
    shot: payload.shot_no ?? null,
  });
  if (expectBody !== stamp.body) return false;
  const expectSig = crypto.createHmac('sha256', STAMP_SECRET).update(stamp.body).digest('hex').slice(0, 32);
  // 定长比较，防时序攻击
  return crypto.timingSafeEqual(Buffer.from(expectSig), Buffer.from(stamp.sig));
}

class RelayAdapter {
  #authorized = false;

  /** @private 仅本模块可构造 */
  constructor(secret) {
    if (secret !== STAMP_SECRET) {
      // 防御：即使拿到类也无法实例化
      throw new Error('ILLEGAL_RELAY_ACCESS');
    }
    this.#authorized = true;
  }

  static #instance = null;
  static instance() {
    if (!RelayAdapter.#instance) RelayAdapter.#instance = new RelayAdapter(STAMP_SECRET);
    return RelayAdapter.#instance;
  }

  /**
   * 唯一调用入口。
   * @param {object} compiled 必须由 PromptCompiler.compile() 产出（含 _stamp）
   * @param {object} [opts] { purpose: 'preview'|'delivery' }
   */
  async call(compiled, opts = {}) {
    if (!this.#authorized) fail(ERR.ILLEGAL_RELAY_ACCESS, '非法算力访问');
    if (!compiled || !compiled._stamp) {
      fail(ERR.ILLEGAL_RELAY_ACCESS, '未经编译器的生成请求被拒绝：请通过 PromptCompiler.compile() 生成请求');
    }
    if (!verifyStamp(compiled._stamp, compiled)) {
      fail(ERR.ILLEGAL_RELAY_ACCESS, '编译签名校验失败：请求内容与签名不一致');
    }
    // V4.4 硬闸门：必须带齐该环节的内置提示词库，否则拒绝生成（不消耗用户点数）
    prompts.assertCompiled(compiled);

    const model = modelRegistry.get(compiled.target_model);
    if (opts.purpose === 'delivery') modelRegistry.getForDelivery(compiled.target_model);
    if (model.upstream_available === false) {
      fail(ERR.RELAY_MODEL_NOT_FOUND, `模型 ${compiled.target_model} 的上游当前不可用，请更换模型`, {
        code: compiled.target_model,
      });
    }

    // 闸门：水位熔断 + 并发 + 限流
    await relayPool.acquire({ estimatedCredits: compiled.estimated_credits ?? 0 });

    const started = Date.now();
    try {
      const result = config.relay.mock
        ? await this.#mockCall(compiled, model)
        : await this.#liveCall(compiled, model);
      relayPool.recordSuccess({
        costPoints: result.actual_credits ?? compiled.estimated_credits ?? 0,
        latencyMs: Date.now() - started,
      });
      return result;
    } catch (e) {
      relayPool.recordFailure(e);
      throw e;
    } finally {
      relayPool.release();
    }
  }

  // ———————————————————————————— live ————————————————————————————

  /** 统一带鉴权的网关请求（不携带任何会进日志的凭据明文到返回值） */
  async #gatewayFetch(pathname, { method = 'GET', body = null, timeoutMs = config.relay.timeoutMs } = {}) {
    const base = config.relay.gateway.replace(/\/+$/, '');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.relay.apiKey}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') fail(ERR.RELAY_TIMEOUT, '上游模型响应超时，请稍后重试');
      fail(ERR.RELAY_UPSTREAM_ERROR, '算力服务连接失败，请稍后重试', { path: pathname });
    }
    clearTimeout(timer);
    if (res.status === 429) fail(ERR.RELAY_RATE_LIMITED, '算力池繁忙，请稍后再试');
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error('上游返回错误', { status: res.status, path: pathname, snippet: JSON.stringify(json).slice(0, 200) });
      fail(ERR.RELAY_UPSTREAM_ERROR, '算力服务返回错误', { status: res.status });
    }
    return json;
  }

  /**
   * 真实调用分发：
   *  - chat → 同步 /chat/completions
   *  - image/video/audio/music → 任务制 /media/generate + 轮询
   */
  async #liveCall(compiled, model) {
    if (compiled.kind === 'chat' || compiled.kind === 'text') {
      const json = await this.#gatewayFetch('/chat/completions', {
        method: 'POST',
        body: {
          model: model.upstream_id,
          messages: compiled.messages ?? [{ role: 'user', content: compiled.prompt_en }],
          temperature: compiled.params?.temperature ?? 0.8,
          ...(model.supports_json ? { response_format: { type: 'json_object' } } : {}),
        },
      });
      return normalizeResult(compiled, json, { mock: false, model });
    }
    return this.#liveMediaCall(compiled, model);
  }

  /** 媒体任务制：提交 → 轮询 → 归一化 */
  async #liveMediaCall(compiled, model) {
    const params = buildMediaParams(compiled, model);
    const submit = await this.#gatewayFetch('/media/generate', {
      method: 'POST',
      body: { model: model.upstream_id, prompt: compiled.prompt_en, params },
    });
    const taskId = submit?.data?.task_id ?? submit?.task_id ?? null;
    if (!taskId) {
      logger.error('媒体任务提交未返回 task_id', { snippet: JSON.stringify(submit).slice(0, 200) });
      fail(ERR.RELAY_UPSTREAM_ERROR, '算力服务未受理生成任务');
    }
    logger.info('媒体任务已提交', { taskId, kind: compiled.kind, model: model.upstream_id });
    const final = await this.#pollTask(taskId);
    return normalizeResult(compiled, final, { mock: false, model, taskId });
  }

  /** 轮询任务直至终态；超时/失败都如实报错，绝不假装成功 */
  async #pollTask(taskId) {
    const deadline = Date.now() + config.relay.mediaPollTimeoutMs;
    const interval = Math.max(2000, config.relay.mediaPollIntervalMs);
    for (;;) {
      const st = await this.#gatewayFetch(`/skills/task-status?task_id=${encodeURIComponent(taskId)}`);
      const d = st?.data ?? st;
      if (d?.is_final === true) {
        if (d.status_group === '失败' || d.status === '生成失败' || !d.result_url) {
          fail(ERR.RELAY_UPSTREAM_ERROR, `生成失败：${d?.error ?? d?.status ?? '未知原因'}`, { taskId });
        }
        return d;
      }
      if (Date.now() > deadline) {
        fail(ERR.RELAY_TIMEOUT, '生成任务超时（媒体生成耗时较长，请稍后在任务中心查看）', { taskId });
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ——— MOCK：不发请求，产出确定性假产物 ———
  async #mockCall(compiled, model) {
    // 用提示词内容做种子，保证同参数可复现（便于测试断言）
    const seed = compiled.params?.seed ?? seedFrom(compiled.prompt_en);
    const fakeId = newId(compiled.kind === 'video' ? 'clip' : compiled.kind === 'image' ? 'img' : 'txt');
    await new Promise((r) => setTimeout(r, 5)); // 模拟网络耗时
    return normalizeResult(
      compiled,
      {
        mock: true,
        seed,
        text: compiled.kind === 'chat' || compiled.kind === 'text' ? mockText(compiled) : undefined,
      },
      { mock: true, fakeId, model }
    );
  }
}

// ———————————————————————————— 参数映射 ————————————————————————————

/** '1080x1920' → 宽高比 + 清晰度档位 */
function mapResolution(res) {
  const [w, h] = String(res ?? '').split('x').map(Number);
  if (!w || !h) return { aspect_ratio: null, resolution: null };
  const r = w / h;
  let aspect = '1:1';
  if (r > 1.6) aspect = '16:9';
  else if (r > 1.2) aspect = '4:3';
  else if (r < 0.6) aspect = '9:16';
  else if (r < 0.85) aspect = '3:4';
  const longSide = Math.max(w, h);
  const resolution = longSide >= 1920 ? '1080p' : longSide >= 1280 ? '720p' : '480p';
  return { aspect_ratio: aspect, resolution };
}

/** 情绪资产 → 豆包 TTS 情感参数（auto/happy/sad/angry/fearful/surprised/calm） */
function mapTtsEmotion(emotion) {
  if (!emotion) return null;
  const s = String(emotion).toLowerCase();
  const table = [
    [/happy|joy|excited|cheerful|delight|开心|喜悦|兴奋|欢快|甜/, 'happy'],
    [/sad|sorrow|grief|depress|cry|tear|悲|伤|哭|丧|忧/, 'sad'],
    [/angry|rage|furious|mad|怒|愤|暴怒/, 'angry'],
    [/fear|afraid|scared|terror|panic|怕|惧|恐|惊/, 'fearful'],
    [/surpris|shock|astonish|amazed|惊讶|震惊|诧异/, 'surprised'],
    [/calm|peace|serene|gentle|quiet|平静|温柔|安宁|释然/, 'calm'],
  ];
  for (const [re, v] of table) if (re.test(s)) return s === 'auto' ? 'auto' : v;
  return 'auto';
}

/**
 * 按模型 role 构建 /media/generate 的 params。
 * 只传网关模型真实定义的参数；不传的参数平台用自身默认。
 */
function buildMediaParams(compiled, model) {
  const p = compiled.params ?? {};
  const kind = compiled.kind;

  if (kind === 'image') {
    const { aspect_ratio, resolution } = mapResolution(p.resolution);
    const params = {};
    if (model.upstream_id.startsWith('tt-image')) {
      params.version = 'flare';
      if (aspect_ratio) params.aspect_ratio = aspect_ratio;
      if (resolution) params.resolution = resolution === '1080p' ? '2K' : '1K';
      params.quality = 'high';
      params.background = 'opaque';
    } else {
      // seedream 等：size 档位 + aspect_ratio
      if (aspect_ratio) params.aspect_ratio = aspect_ratio;
      if (resolution) params.size = resolution === '1080p' ? '2K' : '2K';
    }
    const refs = (compiled.reference_images ?? []).map((r) => r.url).filter(Boolean);
    if (refs.length && model.supports_reference) params.images = refs.slice(0, 4);
    return params;
  }

  if (kind === 'video') {
    const { aspect_ratio, resolution } = mapResolution(p.resolution ?? '1080x1920');
    const params = {};
    if (model.upstream_id.startsWith('seedance')) {
      params.version = p.quality === 'high' ? '标准' : '快速';
      if (resolution) params.resolution = resolution === '480p' ? '480p' : resolution === '720p' ? '720p' : '1080p';
      if (aspect_ratio) params.aspect_ratio = aspect_ratio;
    } else if (model.upstream_id.startsWith('wan')) {
      params.version = 'standard';
      if (resolution) params.resolution = resolution.toUpperCase();
      if (aspect_ratio) params.ratio = aspect_ratio;
      params.prompt_extend = 'true';
      params.audio = false;
    } else {
      if (aspect_ratio) params.aspect_ratio = aspect_ratio;
    }
    const dur = Math.round(Number(p.duration ?? 5));
    params.duration = String(Math.max(2, Math.min(12, dur)));
    const refs = (compiled.reference_images ?? []).filter((r) => r?.url);
    if (refs.length && model.supports_first_frame) {
      const ff = refs.find((r) => r.role === 'first_frame') ?? refs[0];
      params.images = [ff.url];
    }
    return params;
  }

  if (kind === 'audio') {
    // TTS：文本在 prompt，参数走 voice/emotion
    const params = { format: 'mp3' };
    if (p.voice && p.voice !== 'default') params.voice_id = String(p.voice);
    if (p.speed) {
      const rate = Math.round((Number(p.speed) - 1) * 100);
      params.speech_rate = String(Math.max(-50, Math.min(100, rate)));
    }
    const emo = mapTtsEmotion(p.emotion);
    if (emo) params.emotion = emo;
    if (p.emotion_scale) params.emotion_scale = String(Math.max(1, Math.min(5, Number(p.emotion_scale) || 3)));
    return params;
  }

  if (kind === 'music') {
    return {
      is_instrumental: p.lyrics ? 'song' : 'instrumental',
      ...(p.lyrics ? { lyrics: String(p.lyrics) } : {}),
      sample_rate: '44100',
      bitrate: '256000',
    };
  }

  return {};
}

/** 真实扣费（算力）→ 售价点数（用于账本结算，含加价率） */
export function suanliToPoints(suanli) {
  const cny = Number(suanli ?? 0) * config.credit.suanliCnyRate;
  return Math.max(0, Math.ceil((cny / config.credit.cnyPerPoint) * config.credit.markup));
}

function mockText(compiled) {
  return `[MOCK] 已按提示词生成内容（${compiled.prompt_zh?.slice(0, 30) ?? ''}…）`;
}

/** 把不同 kind 的返回统一成 { url, text, raw, actual_credits } */
function normalizeResult(compiled, json, ctx) {
  const model = ctx.model ?? null;
  if (ctx.mock) {
    const points = model ? modelRegistry.quotePoints(model) : (compiled.estimated_credits ?? 1);
    return {
      ok: true,
      mock: true,
      kind: compiled.kind,
      url:
        compiled.kind === 'chat' || compiled.kind === 'text'
          ? null
          : `mock://${compiled.kind}/${ctx.fakeId}`,
      text: json.text ?? null,
      raw: json,
      actual_credits: points,
      upstream_model: model?.upstream_id ?? null,
      seed: json.seed ?? null,
    };
  }

  // —— live：chat 同步 ——
  if (compiled.kind === 'chat' || compiled.kind === 'text') {
    const usage = json?.usage ?? {};
    const msg = json?.choices?.[0]?.message ?? {};
    // 推理型模型（DeepSeek-V4-Pro 等）会把 token 先花在 reasoning_content 上：
    // 若正文为空，绝不能当成功返回空字符串，否则下游解析会得到莫名其妙的空剧本。
    if (!msg.content && msg.reasoning_content) {
      fail(ERR.RELAY_UPSTREAM_ERROR, '模型只返回了思考过程、没有正文（多为输出长度上限太小），请重试或改用非推理模型');
    }
    const suanli = (Number(usage.prompt_tokens ?? 0) * (model?.price?.suanli_in ?? 0)
      + Number(usage.completion_tokens ?? 0) * (model?.price?.suanli_out ?? 0)) / 1000;
    return {
      ok: true,
      mock: false,
      kind: compiled.kind ?? 'chat',
      url: null,
      text: msg.content ?? '',
      raw: { usage },
      actual_credits: suanli > 0 ? Math.max(1, suanliToPoints(suanli)) : (compiled.estimated_credits ?? 1),
      upstream_model: model?.upstream_id ?? null,
    };
  }

  // —— live：媒体任务终态（task-status 返回） ——
  const cost = Number(json?.cost ?? 0);
  return {
    ok: true,
    mock: false,
    kind: compiled.kind,
    url: json?.result_url ?? null,
    job_id: ctx.taskId ?? null,
    text: null,
    raw: { task_id: ctx.taskId, result_type: json?.result_type, duration_seconds: json?.duration_seconds },
    // 真实扣费（算力）→ 点数；网关返回 0 时回退预估，绝不假装免费
    actual_credits: cost > 0 ? Math.max(1, suanliToPoints(cost)) : (compiled.estimated_credits ?? 1),
    actual_suanli: cost > 0 ? cost : null,
    upstream_model: model?.upstream_id ?? null,
  };
}

export const relay = RelayAdapter.instance();
export default relay;
export { RelayAdapter };
