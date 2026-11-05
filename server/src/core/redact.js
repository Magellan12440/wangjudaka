/**
 * 全局脱敏：任何写日志 / 出响应的对象都要先过这里。
 * 这是"主账号凭据绝不外泄"的最后一道自动防线。
 */
/**
 * 全局脱敏：任何写日志 / 出响应的对象都要先过这里。
 * 这是"主账号凭据绝不外泄"的最后一道自动防线。
 *
 * V3.5 精确化：防的是「系统凭据」（上游 api_key、控制台密码、微信 secret/session_key），
 * 而不是用户自己的会话票据——裸 `token` 字段是服务端签发给终端用户的登录凭证，
 * 必须原样下发，否则登录态无法工作。paySig/signature 同理（wx.requestVirtualPayment 必需）。
 */
const SENSITIVE_KEY = /(api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?key|app[_-]?key|authorization|cookie|console_account|console_password)/i;
const SK_PATTERN = /sk-[A-Za-z0-9_-]{6,}/g;
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

function mask(v) {
  if (typeof v !== 'string') return '***';
  if (v.length <= 8) return '***';
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

export function redactString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(SK_PATTERN, 'sk-***').replace(PHONE_PATTERN, (m) => mask(m));
}

/**
 * @param {any[]} ancestors 当前递归的祖先链。
 * 只用「祖先链」判定循环，不能用全局 seen：
 * 创作文档里同一个 plan / emotions 对象常被多处引用（这是合法的 DAG 共享），
 * 用全局 seen 会把第二处误标成 [circular]，前端拿到的数据直接坏掉。
 */
export function redact(obj, depth = 0, ancestors = []) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj !== 'object') return obj;
  if (depth > 14) return '[deep]';
  if (ancestors.includes(obj)) return '[circular]';
  const next = [...ancestors, obj];

  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1, next));
  if (obj instanceof Error) {
    return { name: obj.name, message: redactString(obj.message), code: obj.code };
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SENSITIVE_KEY.test(k) ? mask(typeof v === 'string' ? v : '') : redact(v, depth + 1, next);
  }
  return out;
}

/** 结构化日志（stdout） */
export function log(level, msg, meta = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactString(msg),
    ...redact(meta),
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
  debug: (m, meta) => {
    if (process.env.NODE_ENV !== 'production') log('debug', m, meta);
  },
};
