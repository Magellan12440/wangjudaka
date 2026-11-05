/**
 * 环境配置：唯一读取凭据的入口。
 *
 * 安全约束（硬）：
 *  1. 本模块只能在 server 进程中被 import；禁止任何前端/小程序代码接触。
 *  2. `SECRET_KEYS` 中列出的键，禁止出现在任何日志与任何 HTTP 响应中（见 core/redact.js）。
 *  3. 对外暴露配置时必须走 `publicConfig()`，它只返回前端允许看到的字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/** 敏感键：脱敏与导出时一律排除 */
export const SECRET_KEYS = [
  'RELAY_API_KEY',
  'RELAY_CONSOLE_ACCOUNT',
  'RELAY_CONSOLE_PASSWORD',
  'RELAY_GATEWAY_BACKUP',
  'QC_COMPARE_TOKEN',
  'WX_SECRET',
  'WX_PAY_APP_KEY',
  'SESSION_SECRET',
  'ADMIN_TOKEN',
];

/** 加载 .env.local（优先）与 .env（兜底），不覆盖已有进程环境变量 */
function loadDotEnv() {
  const files = ['.env.local', '.env'];
  const loaded = [];
  for (const f of files) {
    const p = path.join(SERVER_ROOT, f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      // 去掉成对引号
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
    loaded.push(f);
  }
  return loaded;
}

export const envFilesLoaded = loadDotEnv();

const num = (k, d) => {
  const v = process.env[k];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = (process.env[k] ?? '').toLowerCase();
  if (v === '') return d;
  return v === 'true' || v === '1' || v === 'yes';
};
const str = (k, d = '') => process.env[k] ?? d;

/** 版本号：读 package.json；读不到就标 unknown（不因版本信息缺失而启动失败） */
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export const config = {
  server: {
    port: num('PORT', 8787),
    /** 监听地址：容器/云主机用 0.0.0.0；只想本机访问可设 127.0.0.1（配 Nginx 反代时） */
    host: str('HOST', '0.0.0.0'),
    env: str('NODE_ENV', 'development'),
    version: version(),
    dataDir: path.resolve(SERVER_ROOT, str('DATA_DIR', './data')),
  },
  relay: {
    gateway: str('RELAY_GATEWAY', 'https://api.lingkeai.ai/v1'),
    apiKey: str('RELAY_API_KEY', ''),
    backupGateways: str('RELAY_GATEWAY_BACKUP', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** 主账号控制台凭据：仅服务端人工/运维通道使用 */
    consoleAccount: str('RELAY_CONSOLE_ACCOUNT', ''),
    consolePassword: str('RELAY_CONSOLE_PASSWORD', ''),
    maxConcurrency: num('RELAY_MAX_CONCURRENCY', 8),
    rpmLimit: num('RELAY_RPM_LIMIT', 240),
    /** 真实调用开关：无 Key 或显式 mock 时，走 MockRelay（链路全跑、不真花钱） */
    mock: bool('RELAY_MOCK', false) || str('RELAY_API_KEY', '') === '',
    timeoutMs: num('RELAY_TIMEOUT_MS', 120000),
    maxRetry: num('RELAY_MAX_RETRY', 2),
    /** 媒体任务制：提交后轮询 task-status 的间隔与总超时（视频可能需要数分钟） */
    mediaPollIntervalMs: num('RELAY_MEDIA_POLL_INTERVAL_MS', 5000),
    mediaPollTimeoutMs: num('RELAY_MEDIA_POLL_TIMEOUT_MS', 600000),
  },
  pool: {
    warnRatio: num('POOL_WARN_RATIO', 0.3),
    criticalRatio: num('POOL_CRITICAL_RATIO', 0.15),
    fuseRatio: num('POOL_FUSE_RATIO', 0.05),
    /** 真实余额水位（单位：算力）。live 模式下优先生效，0=不启用该级 */
    warnSuanli: num('POOL_WARN_SUANLI', 5),
    criticalSuanli: num('POOL_CRITICAL_SUANLI', 2),
    fuseSuanli: num('POOL_FUSE_SUANLI', 0.5),
    /** 余额刷新缓存：避免每次请求都打余额接口 */
    balanceTtlMs: num('POOL_BALANCE_TTL_MS', 60000),
  },
  credit: {
    cnyPerPoint: num('CREDIT_CNY_PER_POINT', 1.0),
    /**
     * 统一计费倍率（V4.3 定价规则）：
     * 全系统一律「实际消耗 × 2」扣点数 —— 聊天推理、出图、视频、配音、剪辑全部同一口径。
     * 改动只允许动这一个值，禁止在各业务里各自乘系数，否则对账必炸。
     */
    markup: num('CREDIT_MARKUP', 2),
    usdCnyRate: num('USD_CNY_RATE', 7.1),
    /** 中转站算力与人民币换算（代理商合同口径，默认 1 算力 ≈ 1 元） */
    suanliCnyRate: num('SUANLI_CNY_RATE', 1.0),
    /**
     * 余额预警阈值（V4.5）。
     * 刻意不用「按单价预测还能出几集」——单价随模型/时长/画质浮动，
     * 预测必然失真，用户会拿预测去对账。这里只做「余额偏低了」这件事的提醒。
     */
    lowBalancePoints: num('LOW_BALANCE_POINTS', 300),
  },
  compliance: {
    aiLabelEnabled: bool('AI_LABEL_ENABLED', true),
    aiLabelText: str('AI_LABEL_TEXT', '本作品由人工智能生成'),
  },
  /** 一致性比对服务（阶段 H / P0-1）：未配置则不注册 provider，恒 degraded */
  qc: {
    compareEndpoint: str('QC_COMPARE_ENDPOINT', ''),
    compareToken: str('QC_COMPARE_TOKEN', ''),
    compareTimeoutMs: num('QC_COMPARE_TIMEOUT_MS', 8000),
    compareProviderName: str('QC_COMPARE_PROVIDER_NAME', 'http_clip'),
  },
  /**
   * 微信小程序通道（V3.5）：登录 / 内容安全 / 虚拟支付。
   * 未配置 AppID 时全部降级为 MOCK（本地联调可用），并在响应中显式标注 mode:'mock'，
   * 绝不假装已接真实微信能力。
   */
  wechat: {
    appid: str('WX_APPID', ''),
    secret: str('WX_SECRET', ''),
    /** session token 签名密钥：不填则进程内随机生成（重启后旧会话失效） */
    sessionSecret: str('SESSION_SECRET', ''),
    sessionTtlMs: num('SESSION_TTL_MS', 7 * 24 * 3600 * 1000),
    /** 内容安全机审开关：配置了 AppID 后默认开；可用开关强制关闭（仅限调试） */
    msgSecCheckEnabled: bool('WX_SEC_CHECK_ENABLED', true),
    /** 虚拟支付（iOS 合规唯一通道） */
    virtualPay: {
      offerId: str('WX_PAY_OFFER_ID', ''),
      appKey: str('WX_PAY_APP_KEY', ''),
      mchid: str('WX_PAY_MCHID', ''),
      notifyUrl: str('WX_PAY_NOTIFY_URL', ''),
      env: num('WX_PAY_ENV', 1), // 0=正式 1=沙箱
    },
  },
  /**
   * 短信验证码（V4.4）：未配置服务商时走 dev 模式——验证码只回给调用方用于自测，
   * 并在响应里显式写 mode:'dev'，绝不假装「已发送到手机」。
   */
  sms: {
    provider: str('SMS_PROVIDER', ''),
    signName: str('SMS_SIGN_NAME', ''),
    templateCode: str('SMS_TEMPLATE_CODE', ''),
    /** 同手机号 24h 内最多发几条（防刷） */
    dailyLimit: num('SMS_DAILY_LIMIT', 10),
  },
  /**
   * 管理员后台（V3.6）：管理端接口以 X-Admin-Token 鉴权。
   * 未配置 ADMIN_TOKEN 时管理端接口一律 403（绝不放行到默认口令）。
   */
  admin: {
    token: str('ADMIN_TOKEN', ''),
    /**
     * 内置管理员账号（V4.7）：配了手机号 + 密码就在启动时自动建好，
     * 之后在小程序「我的 → 管理后台」用手机号密码登录。
     * 不配也不会卡住：系统会生成一次性激活码并打到启动日志里。
     */
    phone: str('ADMIN_PHONE', ''),
    password: str('ADMIN_PASSWORD', ''),
    /** 兑换码默认有效期天数（生成时可覆盖） */
    redeemDefaultExpireDays: num('REDEEM_DEFAULT_EXPIRE_DAYS', 90),
    /** 单次批量生成兑换码上限 */
    redeemBatchMax: num('REDEEM_BATCH_MAX', 500),
  },
  /**
   * 邀请裂变（V4.1）：默认「1 元算力额度」= 1 点（1 点 = 1 元）。
   * 发放前提是邀请**被判定有效**（新用户 + 非同设备 + 完成首个项目里程碑），
   * 具体规则与阈值可在管理后台覆盖（app_settings）。
   */
  invite: {
    rewardPoints: num('INVITE_REWARD_POINTS', 1),
    /** 邀请人每日最多结算多少笔奖励（防刷） */
    dailyRewardLimit: num('INVITE_DAILY_LIMIT', 20),
    /** 同一 IP 24 小时内最多绑定几个新用户，超出则该条判为无效 */
    ipDailyLimit: num('INVITE_IP_DAILY_LIMIT', 5),
    /** 是否要求被邀请人完成首个项目才发奖（关掉就变成注册即发，容易被薅） */
    requireMilestone: bool('INVITE_REQUIRE_MILESTONE', true),
    /** 「新用户」判定窗口：注册后多少小时内可绑定邀请（防止老号补绑） */
    bindWindowHours: num('INVITE_BIND_WINDOW_HOURS', 24),
  },
};

/**
 * 可下发给小程序的配置白名单。
 * 前端只能知道"怎么买、多少钱、有哪些模型展示名"，绝不知道上游是谁、真实成本多少。
 */
export function publicConfig() {
  return {
    credit: {
      cnyPerPoint: config.credit.cnyPerPoint,
      /** 前端展示「实际消耗 × N」用；不暴露任何上游单价 */
      billing_multiplier: config.credit.markup,
      billing_note: `按实际算力消耗 ×${config.credit.markup} 扣点，生成前预扣、按实际结算多退少补`,
      // 前端展示用的点数包（真实价格在 admin 后台配，这里给默认档）
      packages: [
        { id: 'PKG-100', points: 100, priceCny: 100 },
        { id: 'PKG-500', points: 500, priceCny: 500, bonus: 30 },
        { id: 'PKG-1000', points: 1000, priceCny: 1000, bonus: 100 },
      ],
    },
    compliance: { aiLabelEnabled: config.compliance.aiLabelEnabled },
    // 故意不暴露 gateway / apiKey / 真实单价
  };
}

/** 上游连通性自检（不打印任何敏感值） */
export function relayHealthSummary() {
  return {
    mode: config.relay.mock ? 'mock' : 'live',
    hasApiKey: Boolean(config.relay.apiKey),
    gatewayHost: safeHost(config.relay.gateway),
    maxConcurrency: config.relay.maxConcurrency,
    rpmLimit: config.relay.rpmLimit,
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
