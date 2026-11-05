/**
 * 运行配置（前端唯一可变的环境入口）。
 *
 * 三套地址分开写，按微信给的 envVersion 自动选中，**不用改代码就能在
 * 开发版 / 体验版 / 线上版之间切换**：
 *   develop → 微信开发者工具、真机扫「预览码」（开发版）
 *   trial   → 体验版（内测）
 *   release → 线上正式版
 *
 * 手机内测时最常踩的坑就是 develop 还写着 127.0.0.1：
 * 手机上的 127.0.0.1 是手机自己，必然连不上。两种改法见
 * `docs/上传与内测指南.md`：
 *   1) 同 WiFi 快速测：develop 改成电脑局域网 IP，如 http://192.168.1.8:8787
 *   2) 体验版：trial 必须是 https + 已备案域名，并加入后台 request 合法域名
 */
const HOSTS = {
  // 本地联调（工具内 / 手机预览码）。手机扫码时 127.0.0.1 指的是手机自己，
  // 所以这里填电脑的局域网 IP（换网络后跑 npm run mini:lan 更新这一行）。
  develop: 'http://192.168.1.123:8787',
  // 体验版（内测）—— 微信云托管默认域名（免备案，需加入后台 request 合法域名）
  trial: 'https://express-r0ph-341726-13-1525512932.sh.run.tcloudbase.com',
  // 线上正式版 —— 上线后换成已备案自定义域名；过渡期先用云托管域名
  release: 'https://express-r0ph-341726-13-1525512932.sh.run.tcloudbase.com',
};

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

module.exports = {
  env,
  hosts: HOSTS,
  baseUrl: HOSTS[env] || HOSTS.develop,
  brand: '网剧大咖',
  slogan: '一句话，开一部网剧',
  version: '4.4.1',
  supportEmail: 'support@wangjudaka.com',
  // 联调阶段允许「mock 发货」（点了即刻到账、不产生真实扣款），用于本地/内测跑通全链路。
  // 正式提审前若虚拟支付商户号还没开通，请把它改成 false：
  // 充值入口会变为「暂未开放」，避免审核员点到一笔不扣款却到账的订单。
  mockRecharge: true,
  // 充值、生成前必须让用户看到的说明（合规）
  aiNotice: '本平台内容由 AI 生成，已按《人工智能生成合成内容标识办法》添加显式与隐式标识。',
};
