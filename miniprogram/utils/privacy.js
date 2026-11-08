/**
 * 隐私授权闸门（V4.14）。
 *
 * 为什么需要单独一层：
 *  - 微信基础库 2.32.3 起，`chooseMessageFile` / `chooseMedia` / `getLocation` 这类接口
 *    属于「隐私接口」，用户没同意《用户隐私保护指引》时**直接 fail**，
 *    errMsg 形如 `chooseMessageFile:fail api scope is not declared in the privacy agreement`。
 *    调用方把它当成普通失败弹一句"选文件失败"，用户看到的就是"上传报错，因为隐私政策"。
 *  - 旧实现在首页放了一个同意弹窗，但用户从 tabBar 直接进「创作」页时根本不会经过首页，
 *    于是第一次上传就必然撞墙。
 *
 * 现在的做法：
 *  1. App 启动即注册 `wx.onNeedPrivacyAuthorization`，任何隐私接口触发授权时都能接住；
 *  2. 页面挂 `<privacy-gate />` 组件，由它渲染带 `open-type="agreePrivacyAuthorization"` 的按钮
 *     （微信只认这个按钮，`wx.showModal` 的确定按钮无法授予授权）；
 *  3. 调隐私接口前先 `await privacy.ensure()`：已同意直接放行，未同意就弹窗等用户点同意，
 *     同意后原来的调用继续，不需要用户再点一次。
 *
 * 失败时绝不静默：`ensure()` 返回 `{ ok:false, reason }`，`explain()` 给出能照着做的下一步。
 */

const CONTRACT_FALLBACK = '《用户隐私保护指引》';

/** 已挂载的弹窗组件（同一时刻只可能有一个页面在前台） */
const gates = [];
/** 微信回调给我们的 resolve 句柄，用户点同意后才能调用 */
let pendingResolve = null;
let pendingTimer = null;

const state = {
  contractName: CONTRACT_FALLBACK,
  needAuthorization: false,
  checked: false,
  /** 最近一次真实失败原因，便于排查（不上报，只在本地弹窗里展示） */
  lastError: '',
};

/** 隐私接口失败的 errMsg 特征：不同基础库措辞略有差异，全都要认出来 */
const PRIVACY_PATTERN = /privacy|隐私|112|api scope is not declared/i;

function wxOk() {
  return typeof wx !== 'undefined';
}

function emit(payload) {
  for (const g of gates.slice()) {
    try {
      g.onNeed(payload);
    } catch (e) {
      /* 单个组件异常不影响其它 */
    }
  }
}

/**
 * 注册授权回调。必须在 App.onLaunch 里调一次。
 * 微信在**任何**隐私接口被调用且用户未授权时触发这个回调，我们只需把句柄存下来，
 * 等组件里的按钮被点击时再 resolve。
 */
function init() {
  if (!wxOk() || !wx.onNeedPrivacyAuthorization) return false;
  if (init.done) return true;
  init.done = true;
  wx.onNeedPrivacyAuthorization((resolve, eventInfo) => {
    pendingResolve = resolve;
    emit({
      info: eventInfo || null,
      contractName: state.contractName,
    });
    // 用户可能一直不点：15 秒后按"未同意"处理，避免页面一直转圈
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        try { r({ event: 'disagree' }); } catch (e) { /* ignore */ }
      }
    }, 15000);
  });
  return true;
}

/** 组件挂载时登记自己，卸载时注销；返回注销函数 */
function attach(component) {
  if (!component || gates.indexOf(component) >= 0) return () => {};
  gates.push(component);
  return () => {
    const i = gates.indexOf(component);
    if (i >= 0) gates.splice(i, 1);
  };
}

/**
 * 查一次当前授权状态（不发弹窗）。
 * 返回 { needAuthorization, contractName }；老基础库无此接口时按「不需要」处理。
 */
function check() {
  return new Promise((resolve) => {
    if (!wxOk() || !wx.getPrivacySetting) {
      state.checked = true;
      state.needAuthorization = false;
      return resolve({ needAuthorization: false, contractName: state.contractName, supported: false });
    }
    wx.getPrivacySetting({
      success: (r) => {
        state.checked = true;
        state.needAuthorization = !!r.needAuthorization;
        if (r.privacyContractName) state.contractName = r.privacyContractName;
        resolve({
          needAuthorization: state.needAuthorization,
          contractName: state.contractName,
          supported: true,
        });
      },
      fail: () => {
        state.checked = true;
        resolve({ needAuthorization: false, contractName: state.contractName, supported: false });
      },
    });
  });
}

/**
 * 调隐私接口前的统一闸门。
 *
 * @returns {Promise<{ok:boolean, reason?:string, message?:string}>}
 *   ok:true  → 可以继续调隐私接口
 *   ok:false → reason: 'denied'（用户拒绝）/ 'no_gate'（页面没挂组件）/ 'timeout' / 'unsupported'
 */
function ensure(opts = {}) {
  const timeout = Number(opts.timeout) || 15000;
  if (!wxOk() || !wx.requirePrivacyAuthorize) {
    return Promise.resolve({ ok: true, reason: 'unsupported' });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // 页面没挂 privacy-gate 时微信不会有人调 resolve，这里兜住，别让用户对着转圈
    const guard = setTimeout(() => {
      if (gates.length === 0) {
        done({
          ok: false,
          reason: 'no_gate',
          message: `需要先同意${state.contractName}才能选择文件。请在首页的隐私弹窗里点「同意并继续」，或到「我的 → 隐私政策」查看。`,
        });
      } else {
        done({ ok: false, reason: 'timeout', message: `还没有同意${state.contractName}，操作已取消` });
      }
    }, timeout);

    wx.requirePrivacyAuthorize({
      success: () => {
        clearTimeout(guard);
        state.needAuthorization = false;
        done({ ok: true });
      },
      fail: (e) => {
        clearTimeout(guard);
        const raw = String((e && e.errMsg) || e || '');
        state.lastError = raw;
        const denied = !PRIVACY_PATTERN.test(raw) || /deny|cancel|拒绝|取消/i.test(raw);
        done({
          ok: false,
          reason: denied ? 'denied' : 'failed',
          message: PRIVACY_PATTERN.test(raw)
            ? `需要先同意${state.contractName}才能继续`
            : '隐私授权失败，请重试',
          raw,
        });
      },
    });
  });
}

/** 用户在弹窗里点了「同意并继续」 */
function resolveAgree() {
  clearTimeout(pendingTimer);
  const r = pendingResolve;
  pendingResolve = null;
  if (!r) return false;
  try {
    r({ event: 'agree', buttonId: 'privacy-agree-btn' });
    state.needAuthorization = false;
    return true;
  } catch (e) {
    return false;
  }
}

/** 用户点了「暂不同意」 */
function resolveDeny() {
  clearTimeout(pendingTimer);
  const r = pendingResolve;
  pendingResolve = null;
  if (!r) return false;
  try {
    r({ event: 'disagree' });
  } catch (e) { /* ignore */ }
  return true;
}

/** 查看完整《用户隐私保护指引》（微信原生的那一份，提审时必须是它） */
function openContract() {
  if (wxOk() && wx.openPrivacyContract) {
    wx.openPrivacyContract({ fail: () => {} });
    return true;
  }
  return false;
}

/** 这个错误是不是"隐私没同意"导致的 */
function isPrivacyError(err) {
  const raw = String((err && (err.errMsg || err.message)) || err || '');
  return PRIVACY_PATTERN.test(raw);
}

/**
 * 把隐私类错误翻译成用户能照着做的话。
 * 关键区别：接口没声明（后台没配）和用户没同意，处理方式完全不同，不能混成一句话。
 */
function explain(err) {
  const raw = String((err && (err.errMsg || err.message)) || err || '');
  if (/api scope is not declared/i.test(raw)) {
    return {
      title: '微信后台还没声明这个用途',
      content: '当前小程序的《用户隐私保护指引》里没有勾选「选择文件 / 相册」等用途，'
        + '所以微信直接拒绝了这次调用。\n\n'
        + '这不是你的问题：需要管理员到小程序后台「设置 → 服务内容声明 → 用户隐私保护指引」里补上对应用途并提交审核。\n\n'
        + '在此期间可以先把正文直接粘贴到输入框。',
      needDeclaration: true,
    };
  }
  if (/privacy/i.test(raw)) {
    return {
      title: `需要先同意${state.contractName}`,
      content: `微信要求先同意${state.contractName}才能选择文件。点下面的按钮会重新拉起授权。`,
      needConsent: true,
    };
  }
  return null;
}

function view() {
  return {
    contractName: state.contractName,
    needAuthorization: state.needAuthorization,
    checked: state.checked,
    gates: gates.length,
  };
}

module.exports = {
  init,
  attach,
  check,
  ensure,
  resolveAgree,
  resolveDeny,
  openContract,
  isPrivacyError,
  explain,
  view,
};
