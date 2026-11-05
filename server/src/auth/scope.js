/**
 * 作用域收敛（V4.3.1）：决定「这次请求到底算谁的数据」。
 *
 * 背景：早期为方便本地脚本，很多接口允许用 `?userId=` 直接指定用户。
 * 生产环境上就变成了 IDOR：知道别人 userId 就能读他的项目、账本、成片。
 *
 * 规则（唯一实现，路由层只调用，不各自判断）：
 *   1. 有登录态 → 以 token 为准，query 里的 userId 一律忽略（防「登录了却指定别人」）
 *   2. 无登录态 + 运维令牌正确 + 给了 userId → 允许代理（仅内部工作台）
 *   3. 无登录态 + 生产环境 → 直接 401
 *   4. 无登录态 + 开发/测试环境 → 允许 query.userId 回退，方便脚本与用例
 *
 * 纯函数：不读全局 config，不抛业务错误，由调用方决定怎么报错。
 */

export const SCOPE = {
  /** 以登录用户为准 */
  SELF: 'self',
  /** 运维代查 */
  OPERATOR: 'operator',
  /** 开发/测试环境的 userId 回退 */
  DEV_FALLBACK: 'dev_fallback',
  /** 拒绝 */
  DENIED: 'denied',
};

/**
 * @param {object} opts
 * @param {string|null} opts.actorId       登录态解析出的用户 id
 * @param {boolean} opts.operator          是否持有正确的运维令牌
 * @param {boolean} opts.production        是否生产环境
 * @param {string|null} opts.queryUserId   query 里带的 userId
 * @returns {{mode: string, userId: string|null, reason: string}}
 */
export function resolveScope({ actorId = null, operator = false, production = false, queryUserId = null } = {}) {
  const qid = typeof queryUserId === 'string' && queryUserId.trim() ? queryUserId.trim() : null;

  if (actorId) {
    // 登录了就只能看自己：即使传了别人的 userId 也不生效，避免「借 token 越权」
    return { mode: SCOPE.SELF, userId: actorId, reason: 'token' };
  }
  if (operator && qid) {
    return { mode: SCOPE.OPERATOR, userId: qid, reason: 'admin_token' };
  }
  if (production) {
    return { mode: SCOPE.DENIED, userId: null, reason: 'auth_required' };
  }
  if (qid) {
    return { mode: SCOPE.DEV_FALLBACK, userId: qid, reason: 'dev_query' };
  }
  return { mode: SCOPE.DENIED, userId: null, reason: 'auth_required' };
}

/**
 * 归属判定：能不能碰这个资源。
 * 返回 'ok' | 'forbidden' | 'auth_required'，同样不抛错。
 */
export function resolveOwnership({ actorId = null, operator = false, production = false, ownerId = null } = {}) {
  if (actorId) return actorId === ownerId ? 'ok' : 'forbidden';
  if (operator) return 'ok';
  return production ? 'auth_required' : 'ok';
}
