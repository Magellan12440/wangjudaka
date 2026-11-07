/**
 * 运行配置（前端唯一可变的环境入口）。
 *
 * 三套地址分开写，按微信给的 envVersion 自动选中，**不用改代码就能在
 * 开发版 / 体验版 / 线上版之间切换**：
 *   develop → 微信开发者工具、真机扫「预览码」（开发版）
 *   trial   → 体验版（内测）
 *   release → 线上正式版
 *
 * 手机内测时最常踩的坑，历史上踩过两次：
 *   1) develop 写 127.0.0.1 —— 手机上的 127.0.0.1 是手机自己，必然连不上；
 *   2) develop 写电脑局域网 IP —— 换网/出门就失效，同样的「网络异常」。
 * 所以现在 develop 也直连云端。本地联调改用本地存储覆盖，见 devOverride。
 *
 * 真机（非「调试模式」）还有一道关：该域名必须在小程序后台
 * 「开发管理 → 开发设置 → 服务器域名 → request 合法域名」里，否则一律网络异常。
 */
// 云托管默认域名（免备案，但必须加进小程序后台的 request 合法域名）
const CLOUD = 'https://express-r0ph-341726-13-1525512932.sh.run.tcloudbase.com';

// 云托管环境与服务名：用于「小程序内网调用」通道（wx.cloud.callContainer）
// 这条通道走微信内部链路，**不校验 request 合法域名**，是白名单没配时的兜底。
const CLOUD_ENV = 'prod-d8gx3wb1v1c823433';
const CLOUD_SERVICE = 'express-r0ph';

const HOSTS = {
  // 开发版：**默认直连云端**。
  // 这里以前写的是电脑局域网 IP，导致真机打开开发版必然「网络异常」——
  // 手机上的 192.168.x.x 是手机自己所在网段，不是你的电脑。
  // 需要连本地后端时，不改代码，在开发者工具控制台执行：
  //   wx.setStorageSync('dev_host', 'http://192.168.1.123:8787')   // 换回云端：wx.removeStorageSync('dev_host')
  develop: CLOUD,
  // 体验版（内测）
  trial: CLOUD,
  // 线上正式版 —— 上线后换成已备案自定义域名；过渡期先用云托管域名
  release: CLOUD,
};

/** 本地联调覆盖：仅在开发版生效，从本地存储读，换机/换网不用改代码 */
function devOverride() {
  try {
    const v = String(wx.getStorageSync('dev_host') || '').trim().replace(/\/+$/, '');
    return v;
  } catch (e) {
    return '';
  }
}

/** 当前运行环境：develop | trial | release；拿不到时按开发版处理 */
function currentEnv() {
  try {
    const info = wx.getAccountInfoSync();
    const v = info && info.miniProgram && info.miniProgram.envVersion;
    if (v === 'develop' || v === 'trial' || v === 'release') return v;
  } catch (e) {
    // 老基础库或非小程序环境（如本地 Node 自测）走默认
  }
  return 'develop';
}

const env = currentEnv();

// 开发版允许用本地存储临时指向本机后端（见 devOverride 注释）
const baseUrl = (env === 'develop' && devOverride()) || HOSTS[env] || HOSTS.develop;

module.exports = {
  env,
  hosts: HOSTS,
  baseUrl,
  cloudEnv: CLOUD_ENV,
  cloudService: CLOUD_SERVICE,
  brand: '网剧大咖',
  slogan: '一句话，开一部网剧',
  version: '4.8.1',
  supportEmail: 'support@wangjudaka.com',
  // 联调阶段允许「mock 发货」（点了即刻到账、不产生真实扣款），用于本地/内测跑通全链路。
  // 正式提审前若虚拟支付商户号还没开通，请把它改成 false：
  // 充值入口会变为「暂未开放」，避免审核员点到一笔不扣款却到账的订单。
  mockRecharge: true,
  // 充值、生成前必须让用户看到的说明（合规）
  aiNotice: '本平台内容由 AI 生成，已按《人工智能生成合成内容标识办法》添加显式与隐式标识。',
};
