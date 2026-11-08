/**
 * 选本地文件（V4.10 / V4.14）。
 *
 * 为什么单独抽一层：
 *  - `wx.chooseMessageFile` 在部分机型/基础库上会静默失败（既不 success 也不 fail 回调），
 *    直接调用时用户看到的就是「点了没反应」；
 *  - 它同时是**隐私接口**：用户没同意《用户隐私保护指引》时直接 fail，
 *    errMsg 是 `api scope is not declared in the privacy agreement`。
 *    不先过隐私闸门就调，用户看到的永远是「上传失败」，却不知道该怎么办。
 *  - 这里统一加：隐私预授权 → 能力探测 → 真实 errMsg 提示 → 降级 → 超时兜底，
 *    任何一条路走不通都要说清原因，绝不静默返回。
 */
const privacy = require('./privacy.js');

const CANCEL_HINT = /cancel|取消/i;

function normalize(file) {
  if (!file) return null;
  return {
    path: file.path || file.tempFilePath || '',
    name: file.name || (file.path || '').split('/').pop() || '未命名文件',
    size: Number(file.size) || 0,
    type: file.type || '',
  };
}

function errOf(msg, code) {
  const e = new Error(msg);
  e.code = code || 'PICK_FAILED';
  return e;
}

/**
 * @param {object} opts { count, type, extensions, timeout }
 * @returns {Promise<Array<{path,name,size,type}>>}
 */
function pickFile(opts) {
  // 先过隐私闸门：未同意就让页面弹同意框，同意后这条链自己继续，用户不用再点一次
  return privacy.ensure({ timeout: 20000 }).then((p) => {
    if (p && p.ok === false) {
      const e = errOf(p.message || '需要先同意隐私保护指引才能选择文件', 'PRIVACY_REQUIRED');
      e.detail = p;
      throw e;
    }
    return pickMessageFile(opts);
  });
}

function pickMessageFile(opts) {
  const o = opts || {};
  const count = Math.max(1, Math.min(9, Number(o.count) || 1));
  const type = o.type || 'all';
  const extensions = o.extensions || undefined;

  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined') {
      return reject(errOf('当前环境不支持选择文件', 'NO_WX'));
    }
    if (!wx.chooseMessageFile) {
      return reject(errOf('当前微信版本不支持选文件，请升级微信或直接把正文粘贴进来', 'NO_API'));
    }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    // 兜底：40s 内两个回调都没来（已知部分安卓机型会这样），主动报错而不是让转圈转到底
    const timer = setTimeout(() => {
      finish(reject, errOf('选文件没有响应，请重试；也可以直接粘贴正文', 'PICK_TIMEOUT'));
    }, Number(o.timeout) || 40000);

    const ok = (res) => {
      clearTimeout(timer);
      const files = (res && res.tempFiles ? res.tempFiles : []).map(normalize).filter((f) => f && f.path);
      if (!files.length) return finish(reject, errOf('没有拿到文件', 'PICK_EMPTY'));
      finish(resolve, files);
    };
    const bad = (e) => {
      clearTimeout(timer);
      const raw = String((e && e.errMsg) || e || '');
      if (CANCEL_HINT.test(raw)) return finish(reject, errOf('已取消', 'CANCEL'));
      // 隐私没同意：这一条以前被当成普通失败，用户只看到"上传失败"
      if (privacy.isPrivacyError(raw)) {
        const why = privacy.explain(raw);
        const err = errOf((why && why.title) || '需要先同意隐私保护指引', 'PRIVACY_REQUIRED');
        err.detail = why;
        return finish(reject, err);
      }
      // 老基础库不认 type:'all'：退回 file 再试一次
      if (/type|param|invalid/i.test(raw)) {
        return wx.chooseMessageFile({
          count,
          type: 'file',
          success: ok,
          fail: (e2) => {
            const raw2 = String((e2 && e2.errMsg) || '');
            if (CANCEL_HINT.test(raw2)) return finish(reject, errOf('已取消', 'CANCEL'));
            if (privacy.isPrivacyError(raw2)) {
              const why = privacy.explain(raw2);
              const err = errOf((why && why.title) || '需要先同意隐私保护指引', 'PRIVACY_REQUIRED');
              err.detail = why;
              return finish(reject, err);
            }
            finish(reject, errOf(`选文件失败：${raw2 || '未知原因'}`, 'PICK_FAILED'));
          },
        });
      }
      finish(reject, errOf(`选文件失败：${raw || '未知原因'}`, 'PICK_FAILED'));
    };

    try {
      wx.chooseMessageFile({ count, type, extensions, success: ok, fail: bad });
    } catch (e) {
      clearTimeout(timer);
      finish(reject, errOf(`选文件失败：${(e && e.message) || '接口异常'}`, 'PICK_THROW'));
    }
  });
}

module.exports = { pickFile, normalize };
