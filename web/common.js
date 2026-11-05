/* 网剧大咖 · PC 端公共脚本（零第三方依赖）
 * 所有请求同源发往本地服务端；前端不含任何上游凭据。
 */
(function (global) {
  'use strict';

  var API_BASE = '';

  async function api(path, options) {
    var opt = options || {};
    var init = { method: opt.method || 'GET', headers: {} };
    if (opt.headers) {
      for (var k in opt.headers) init.headers[k] = opt.headers[k];
    }
    if (opt.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opt.body);
    }
    var resp;
    try {
      resp = await fetch(API_BASE + path, init);
    } catch (e) {
      throw new Error('无法连接本地服务，请先在 server 目录运行 node src/index.js（' + e.message + '）');
    }
    var json;
    try {
      json = await resp.json();
    } catch (e) {
      throw new Error('服务返回了非 JSON 内容（HTTP ' + resp.status + '）');
    }
    if (!resp.ok || json.ok === false) {
      throw new Error((json && (json.message || json.code)) || ('HTTP ' + resp.status));
    }
    return json.data;
  }

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    var wrap = qs('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = String(msg);
    wrap.appendChild(t);
    setTimeout(function () { t.remove(); }, 3600);
  }
  function copy(text) {
    var s = String(text === undefined || text === null ? '' : text);
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      return global.navigator.clipboard.writeText(s).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = s;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }
  }
  function fmtTime(s) {
    if (!s) return '—';
    var d = new Date(s);
    return isNaN(d.getTime()) ? String(s) : d.toLocaleString('zh-CN', { hour12: false });
  }
  function downloadJson(filename, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function param(name) {
    return new URLSearchParams(global.location.search).get(name) || '';
  }

  global.LW = { api: api, qs: qs, qsa: qsa, esc: esc, toast: toast,
    copy: copy, fmtTime: fmtTime, downloadJson: downloadJson, param: param };
})(window);
