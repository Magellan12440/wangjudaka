/**
 * 动效小工具：页面入场重播、数字滚动、进度环、分段指示器、轻震动。
 *
 * 设计约束：
 *  - 只用 setData + CSS，不引第三方动画库（小程序包体越小越好）；
 *  - 所有定时器挂在页面实例上，onHide/onUnload 可统一清掉；
 *  - 任一 API 不存在都不许抛错（低版本基础库降级为静态）。
 */

/** 页面入场动画：切 tab 回来也重播一次（CSS 动画只在节点重建时触发，所以先关再开） */
function enter(page) {
  if (!page || !page.setData) return;
  try {
    page.setData({ pageAnim: false });
    setTimeout(() => {
      if (page.__gone) return;
      page.setData({ pageAnim: true });
    }, 24);
  } catch (e) { /* ignore */ }
}

/** 轻震动：只做锦上添花，失败静默 */
function haptic() {
  try {
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  } catch (e) { /* ignore */ }
}

/**
 * 数字滚动（ease-out）。
 * @param {object} page 页面实例
 * @param {string} key setData 路径，如 'stats.projects'
 * @param {number} to 目标值
 * @param {object} [opts] { duration=700, decimals=0, prefix='', suffix='' }
 */
function countUp(page, key, to, opts = {}) {
  if (!page || !page.setData) return;
  const target = Number(to) || 0;
  const duration = opts.duration ?? 700;
  const decimals = opts.decimals ?? 0;
  page.__counters = page.__counters || {};
  if (page.__counters[key]) clearInterval(page.__counters[key]);

  // 减少无意义动画：目标很小或动画被系统关闭时直接落值
  if (target === 0 || duration <= 0) {
    page.setData({ [key]: target });
    return;
  }
  const start = Date.now();
  const timer = setInterval(() => {
    if (page.__gone) { clearInterval(timer); return; }
    const p = Math.min(1, (Date.now() - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = target * eased;
    page.setData({ [key]: decimals ? Number(v.toFixed(decimals)) : Math.round(v) });
    if (p >= 1) {
      clearInterval(timer);
      delete page.__counters[key];
      page.setData({ [key]: decimals ? Number(target.toFixed(decimals)) : target });
    }
  }, 32);
  page.__counters[key] = timer;
}

/** 进度环样式：conic-gradient 在小程序 webview 可用，这里把角度算好直接内联 */
function ringStyle(percent, color = '#F3C969', track = 'rgba(255,255,255,0.09)') {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const deg = Math.round((p / 100) * 360);
  return `background: conic-gradient(from -90deg, ${color} 0deg, ${color} ${deg}deg, ${track} ${deg}deg, ${track} 360deg);`;
}

/** 分段指示器：返回 translateX 百分比（每格等宽） */
function segStyle(index, count) {
  const n = Math.max(1, Number(count) || 1);
  const i = Math.max(0, Math.min(n - 1, Number(index) || 0));
  return `width: calc((100% - 14rpx) / ${n}); transform: translateX(${i * 100}%);`;
}

/** 清理页面上的所有定时器（onHide / onUnload 调用） */
function clear(page) {
  if (!page) return;
  for (const k of Object.keys(page.__counters || {})) {
    clearInterval(page.__counters[k]);
  }
  page.__counters = {};
}

module.exports = { enter, haptic, countUp, ringStyle, segStyle, clear };
