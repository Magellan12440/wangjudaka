/**
 * 本机账号簿（多账号切换）。
 *
 * 为什么放在本地而不是服务端：token 是自签的、可离线校验，切换账号本质就是
 * 「换一个 token」。放在本地意味着切换不需要联网、不需要短信，点一下就过去了，
 * 这也是主流 App 的账号切换体验。
 *
 * 记录里**只存 token 与展示用的昵称/手机尾号**，不存密码、不存明文手机号。
 * token 被服务端 tv 吊销后，本地记录仍在，但切换时 api.me() 会失败，
 * 我们会把该记录标成 expired 并引导重新登录（不会静默失败）。
 */
const KEY = 'account_book';
const MAX = 5;

function read() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v.filter((a) => a && a.user_id) : [];
  } catch (e) {
    return [];
  }
}

function write(list) {
  // 最近使用的排前面，超出上限的先丢最久没用的（但永远不丢当前账号）
  const sorted = list.slice().sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0));
  const kept = sorted.slice(0, MAX);
  try {
    wx.setStorageSync(KEY, kept);
  } catch (e) { /* 存储满时静默，不影响登录 */ }
  return kept;
}

function maskPhone(phone) {
  const s = String(phone || '').replace(/\D/g, '');
  if (s.length !== 11) return s ? `${s.slice(0, 3)}****` : '';
  return `${s.slice(0, 3)}****${s.slice(7)}`;
}

function list() {
  return read().sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0));
}

function get(userId) {
  return read().find((a) => a.user_id === userId) || null;
}

/**
 * 登录成功后把账号记进账号簿（幂等：同一 user_id 只留一条）。
 * @param {{user:object, token:string, mode?:string}} p
 */
function remember({ user, token, mode = '' }) {
  if (!user || !user.id || !token) return list();
  const rows = read();
  const phone = user.phone_masked || maskPhone(user.phone);
  const next = {
    user_id: user.id,
    token,
    nickname: user.nickname || '创作者',
    avatar: user.avatar || '',
    phone_masked: phone || '',
    is_admin: !!user.is_admin,
    login_mode: mode || '',
    expired: false,
    last_used_at: Date.now(),
  };
  const i = rows.findIndex((a) => a.user_id === user.id);
  if (i >= 0) rows[i] = { ...rows[i], ...next };
  else rows.unshift(next);
  return write(rows);
}

/** 切换后刷新「最近使用」时间 */
function markUsed(userId) {
  const rows = read();
  const hit = rows.find((a) => a.user_id === userId);
  if (hit) hit.last_used_at = Date.now();
  return write(rows);
}

/** token 已失效（被踢 / 改密 / 退出全部设备）：保留记录，但标成需重新登录 */
function markExpired(userId) {
  const rows = read();
  const hit = rows.find((a) => a.user_id === userId);
  if (hit) {
    hit.expired = true;
    hit.token = '';
  }
  return write(rows);
}

/** 退出登录：清掉 token，记录留着，方便再切回来 */
function clearToken(userId) {
  return markExpired(userId);
}

function remove(userId) {
  return write(read().filter((a) => a.user_id !== userId));
}

/** 展示用：昵称 + 手机尾号 + 相对时间 */
function view(currentUserId) {
  const now = Date.now();
  return list().map((a) => {
    const mins = Math.floor((now - (a.last_used_at || now)) / 60000);
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前`
      : mins < 1440 ? `${Math.floor(mins / 60)} 小时前` : `${Math.floor(mins / 1440)} 天前`;
    return {
      userId: a.user_id,
      nickname: a.nickname || '创作者',
      initial: String(a.nickname || '创').slice(0, 1),
      avatar: a.avatar || '',
      phoneMasked: a.phone_masked || '',
      isAdmin: !!a.is_admin,
      expired: !!a.expired,
      current: a.user_id === currentUserId,
      usedText: when,
    };
  });
}

module.exports = { KEY, MAX, list, get, remember, markUsed, markExpired, clearToken, remove, view, maskPhone };
