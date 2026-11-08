/**
 * 电脑端上传指引（V4.18）。
 *
 * 起因：红果、抖音等平台**不接受小程序内上传**——业务域名不能内嵌、签约要走电脑端
 * 创作者中心、资质与电子合同只在 Web 端提供。用户在手机上点「去上传」只能看到一句话
 * "请到电脑端操作"，等于把问题丢回给用户。
 *
 * 本模块的定位：把「手机上能做完的事」和「必须到电脑上做的事」切开，
 * 手机端负责**备料 + 一次复制 + 步骤清单**，电脑端只剩粘贴和点提交。
 *
 * 边界（硬）：
 *  - 不代替用户登录、不代替用户提交，任何返回里 `no_auto_submit` 恒为 true；
 *  - 步骤文案是"通用流程 + 平台差异"，平台改版时不保证逐字对应，返回里带 `disclaimer`；
 *  - 不编造审核时长/分成比例，能引种子的引种子，引不到就说"以平台页面为准"。
 */
import seeds from '../seeds/loader.js';

export const GUIDE_SCHEMA = 'lingwu.upload.desktop-guide/1';

/** 上传端形态：决定手机上要提示到什么程度 */
export const CLIENT_KIND = {
  desktop_only: '只能在电脑端',
  desktop_preferred: '电脑端为主',
  mobile_ok: '手机也能传',
};

/**
 * 平台差异。key 为平台 code，缺省走 DEFAULT。
 * steps 的 where 用来标"这一步在哪个页面做"，用户照着找得到。
 */
const PLATFORM_STEPS = {
  'PLT-HONGGUO': {
    kind: 'desktop_only',
    why: '红果（番茄短剧）只能在电脑端创作者中心上传，签约与结算也在同一处，手机端没有入口。',
    steps: [
      { title: '电脑浏览器打开红果创作者中心', where: '登录页', detail: '用手机号或抖音/番茄账号登录，注意是「创作者」后台，不是普通用户端。' },
      { title: '完成实名认证', where: '账号设置', detail: '个人主体传身份证，企业主体传营业执照；主体一旦绑定不可更改，先确认用哪个主体。' },
      { title: '签署分成协议', where: '签约中心', detail: '看清分成比例与结算周期再签；签完才能在后台看到「上传剧集」入口。' },
      { title: '上传成片与封面', where: '内容管理 → 上传', detail: '按集上传，画幅与时长要与我们导出的成片一致，别在平台侧二次压缩。' },
      { title: '填写剧名 / 简介 / 标签', where: '上传表单', detail: '把手机端复制的「粘贴包」整段贴进简介，再按平台要求拆到各字段。' },
      { title: '勾选 AI 生成声明', where: '上传表单', detail: '平台要求标注 AI 生成内容，必须勾；创作过程证据按需上传截图包。' },
      { title: '提交审核，通过后签约', where: '审核 → 合同', detail: '审核通过会生成电子合同，签完才进入结算；状态回工作台登记即可。' },
    ],
    pitfalls: [
      '主体信息填错后不可改，注册前先定好用个人还是公司',
      '封面比例与画幅不一致是最常见的驳回原因',
      '同一部剧重复上传会被判重复内容，先用「上传前查重」',
    ],
  },
  'PLT-DOUYIN': {
    kind: 'desktop_only',
    why: '抖音 App 能发普通视频，但**短剧签约、剧集挂载、分成结算**只在电脑端创作者中心提供。',
    steps: [
      { title: '电脑浏览器打开抖音创作者中心', where: '登录页', detail: '扫码或验证码登录，确认登录的是要签约的那个抖音号。' },
      { title: '进入短剧/漫剧合作入口', where: '创作者中心 → 变现/短剧', detail: '部分账号需要先满足粉丝或实名条件才显示入口。' },
      { title: '提交资质与版权链', where: '资质提交', detail: '原创剧本说明或改编授权书；用我们导出的创作证据包截图更稳。' },
      { title: '上传剧集并绑定剧集 ID', where: '内容管理', detail: '按集上传后在剧集里关联，未绑定的视频不计入短剧分成。' },
      { title: '填写标题 / 简介 / 话题', where: '上传表单', detail: '粘贴包里的简介可直接用，话题按平台当期活动补。' },
      { title: '勾选 AI 生成标识', where: '上传表单 → 更多设置', detail: '不勾会被判违规，尤其是整段 AI 生成画面。' },
      { title: '提交审核 → 签约 → 结算绑定', where: '审核 / 合同 / 钱包', detail: '签约和收款账户都在电脑端完成，手机端只能看数据。' },
    ],
    pitfalls: [
      '视频没绑剧集 ID，播放量不进短剧分成',
      '同一账号多部剧混发会稀释推荐，建议一部剧一个合集',
      'AI 标识漏勾是最容易被限流的一项',
    ],
  },
  'PLT-KUAISHOU': {
    kind: 'desktop_only',
    why: '快手星芒短剧的入驻、上传与签约都在电脑端创作者平台完成。',
    steps: [
      { title: '电脑浏览器打开快手创作者平台', where: '登录页', detail: '用要签约的快手号登录。' },
      { title: '申请星芒短剧入驻', where: '短剧合作', detail: '填写主体信息与过往作品，等待开通权限。' },
      { title: '上传成片与封面', where: '内容管理', detail: '按集上传，封面与画幅要和成片一致。' },
      { title: '填写剧名 / 简介 / 标签', where: '上传表单', detail: '用手机端复制的粘贴包。' },
      { title: '勾选 AI 生成声明并提交审核', where: '上传表单', detail: '审核通过后进入签约流程。' },
    ],
    pitfalls: ['入驻权限未开通时看不到上传入口', '封面带第三方平台水印会被驳回'],
  },
  'PLT-TENCENT': {
    kind: 'desktop_only',
    why: '腾讯视频十分剧场走 CP 后台，账号需先由平台开通，手机端无入口。',
    steps: [
      { title: '确认已开通 CP 后台账号', where: '合作对接', detail: '没有账号需先联系平台商务开通，个人账号无法自助注册。' },
      { title: '电脑端登录 CP 后台', where: '登录页', detail: '按平台给的账号登录。' },
      { title: '建立剧集并上传素材', where: '内容管理', detail: '按平台模板填元数据，成片走 FTP 或页面上传。' },
      { title: '提交审核与排期', where: '审核 / 排期', detail: '审核通过后由平台排播，分成按合同结算。' },
    ],
    pitfalls: ['无 CP 账号时任何上传入口都不可见', '元数据模板未按平台格式填会被退回'],
  },
  'PLT-YOUKU': {
    kind: 'desktop_only',
    why: '优酷短剧走 CP 后台，同样需要平台开通账号。',
    steps: [
      { title: '确认 CP 后台账号', where: '合作对接', detail: '联系平台商务开通。' },
      { title: '电脑端登录并建剧集', where: '内容管理', detail: '按模板填剧名、集数、时长。' },
      { title: '上传成片与封面', where: '素材上传', detail: '画幅与码率按平台规范，别二次转码。' },
      { title: '提交审核', where: '审核', detail: '通过后进入排播。' },
    ],
    pitfalls: ['码率不达标会被要求重传'],
  },
  'PLT-MANGO': {
    kind: 'desktop_only',
    why: '芒果大芒短剧通过 CP 后台合作，手机端无上传能力。',
    steps: [
      { title: '确认合作与账号', where: '合作对接', detail: '平台侧开通后再操作。' },
      { title: '电脑端建剧集并上传', where: '内容管理', detail: '按模板填元数据。' },
      { title: '提交审核与签约', where: '审核 / 合同', detail: '签约在电脑端完成。' },
    ],
    pitfalls: ['平台对题材有偏好，先看当期招商方向再投'],
  },
  'PLT-XIAOHONGSHU': {
    kind: 'desktop_preferred',
    why: '小红书 App 能发视频，但短剧号入驻、合集管理与商单合作建议在电脑端完成。',
    steps: [
      { title: '电脑端登录创作者中心', where: '登录页', detail: '手机端也能发，但合集与数据在电脑端更全。' },
      { title: '开通专业号 / 短剧合作', where: '账号设置', detail: '按平台当期政策申请。' },
      { title: '上传成片并建合集', where: '内容管理', detail: '一部剧一个合集，方便追更。' },
      { title: '填写标题与话题', where: '发布页', detail: '粘贴包里的简介可直接用。' },
    ],
    pitfalls: ['未开专业号时商业内容受限', '外链与联系方式会被限流'],
  },
  'PLT-BILIBILI': {
    kind: 'desktop_preferred',
    why: 'B 站网页端能建合集、填分 P 信息，手机上做不了这些。',
    steps: [
      { title: '电脑端登录创作中心', where: '登录页', detail: '用要发布的账号登录。' },
      { title: '投稿并建合集', where: '投稿管理', detail: '按集上传后加入同一合集，观众能连续看。' },
      { title: '填写标题 / 简介 / 标签', where: '投稿表单', detail: '用手机端复制的粘贴包。' },
      { title: '勾选 AI 生成声明并提交', where: '投稿表单', detail: 'B 站对 AI 内容有单独标注项。' },
    ],
    pitfalls: ['未入合集时单集很难被推荐', '转载/自制声明要与实际情况一致'],
  },
};

const DEFAULT_STEPS = {
  kind: 'desktop_preferred',
  why: '该平台的上传与签约以电脑端为主，手机端功能有限。',
  steps: [
    { title: '电脑浏览器打开平台创作者中心', where: '登录页', detail: '用要发布的账号登录。' },
    { title: '完成实名与资质', where: '账号设置', detail: '按平台要求提交主体与版权材料。' },
    { title: '上传成片与封面', where: '内容管理', detail: '画幅、时长与导出的成片保持一致。' },
    { title: '填写剧名 / 简介 / 标签', where: '上传表单', detail: '用手机端复制的粘贴包。' },
    { title: '勾选 AI 生成声明并提交审核', where: '上传表单', detail: '审核通过后按平台指引签约结算。' },
  ],
  pitfalls: ['平台流程会随版本调整，以页面实际提示为准'],
};

/** 电脑端必须准备好的东西（手机端只负责提醒与复制链接） */
const PREP = [
  { key: 'film', label: '成片文件', detail: '在「已出成片」里复制下载链接，到电脑浏览器打开即可下载', required: true },
  { key: 'cover', label: '封面图', detail: '竖版 9:16，不要带第三方平台水印', required: true },
  { key: 'subtitle', label: '字幕文件', detail: '部分平台要求单独上传 SRT，随材料包一起下载', required: false },
  { key: 'ai_label', label: 'AI 生成说明', detail: '粘贴包里已含标准话术，直接贴进简介或说明栏', required: true },
  { key: 'evidence', label: '创作过程证据', detail: '7 页截图包，平台要求全屏、带网址与时间戳', required: false },
  { key: 'copyright', label: '版权链材料', detail: '原创说明或改编授权书，改编作品必须有', required: true },
];

function pickClientKind(platform) {
  const preset = PLATFORM_STEPS[platform.code];
  if (preset?.kind) return preset.kind;
  const client = String(platform.upload_client ?? '');
  if (client.includes('仅电脑') || client.includes('CP 后台')) return 'desktop_only';
  if (client.includes('App 为主')) return 'desktop_preferred';
  return 'desktop_preferred';
}

/** 平台是否只能在电脑端完成上传/签约 */
export function desktopOnlyOf(platform) {
  return pickClientKind(platform) === 'desktop_only';
}

/**
 * 生成指引。
 * @param {object} platform 种子平台对象
 * @param {object} ctx { title, episodes, episodeSec, aspect, aiLabel, filmUrl, packUrl, entryUrl }
 */
export function guideFor(platform, ctx = {}) {
  if (!platform) return null;
  const preset = PLATFORM_STEPS[platform.code] ?? DEFAULT_STEPS;
  const kind = pickClientKind(platform);
  const entryUrl = ctx.entryUrl ?? platform.creator_url ?? null;

  const steps = preset.steps.map((s, i) => ({
    no: i + 1,
    title: s.title,
    where: s.where ?? null,
    detail: s.detail ?? null,
    done: false, // 由用户逐项勾选；服务端不替用户确认
  }));

  const handoff = [
    {
      key: 'entry',
      label: `${platform.name} 创作者中心`,
      value: entryUrl,
      copyable: !!entryUrl,
      hint: '在电脑浏览器打开这个地址，不要在微信里点',
    },
    {
      key: 'film',
      label: '成片下载链接',
      value: ctx.filmUrl ?? null,
      copyable: !!ctx.filmUrl,
      hint: ctx.filmUrl ? '复制后到电脑浏览器打开即可下载' : '还没出片，先在「我的剧」剪一集',
    },
    {
      key: 'pack',
      label: '审核材料包下载链接',
      value: ctx.packUrl ?? null,
      copyable: !!ctx.packUrl,
      hint: ctx.packUrl ? '含成片、封面、字幕、AI 说明与证据包' : '还没打包，先点「打包审核材料」',
    },
    {
      key: 'paste',
      label: '剧目信息粘贴包',
      value: buildPasteText(platform, ctx),
      copyable: true,
      hint: '粘到电脑端上传表单，再按字段拆开',
    },
  ];

  return {
    schema: GUIDE_SCHEMA,
    platform: {
      code: platform.code,
      name: platform.name,
      entry_url: entryUrl,
      upload_client: platform.upload_client ?? null,
      review_days: platform.review_days ?? null,
      identity_choice: platform.identity_choice ?? null,
      entry_note: platform.entry_note ?? null,
    },
    client_kind: kind,
    client_kind_text: CLIENT_KIND[kind],
    desktop_only: kind === 'desktop_only',
    why: preset.why,
    prep: PREP.map((p) => ({ ...p })),
    steps,
    pitfalls: [...(preset.pitfalls ?? []), ...(platform.tips ?? [])],
    handoff,
    paste_text: buildPasteText(platform, ctx),
    no_auto_submit: true,
    policy: {
      auto_submit: false,
      submit_actor: 'user_manual',
      note: '小程序只做备料与指引，登录/上传/签约/提现都由你在电脑端完成',
    },
    disclaimer: '平台流程会随版本调整，步骤仅作路径参考；以创作者中心页面实际提示为准。',
  };
}

/** 一段可直接粘到电脑端表单的纯文本 */
export function buildPasteText(platform, ctx = {}) {
  const lines = [];
  lines.push(`【${ctx.title ?? '未命名漫剧'}】`);
  if (ctx.episodes) lines.push(`集数：${ctx.episodes} 集`);
  if (ctx.episodeSec) lines.push(`单集时长：约 ${ctx.episodeSec} 秒`);
  if (ctx.aspect) lines.push(`画幅：${ctx.aspect}`);
  if (ctx.synopsis) lines.push(`简介：${ctx.synopsis}`);
  if (ctx.aiLabel) lines.push(`AI 说明：${ctx.aiLabel}`);
  if (ctx.filmUrl) lines.push(`成片下载：${ctx.filmUrl}`);
  if (ctx.packUrl) lines.push(`材料包：${ctx.packUrl}`);
  if (platform?.creator_url) lines.push(`上传入口：${platform.creator_url}`);
  lines.push('（以上由「网剧大咖」生成，提交前请复核为最终文案）');
  return lines.join('\n');
}

/** 全平台一览：手机端平台格子上打「电脑端 / 手机也能传」角标 */
export function overview() {
  return seeds.distributionPlatforms.map((p) => {
    const kind = pickClientKind(p);
    return {
      code: p.code,
      name: p.name,
      client_kind: kind,
      client_kind_text: CLIENT_KIND[kind],
      desktop_only: kind === 'desktop_only',
      upload_client: p.upload_client ?? null,
      entry_url: p.creator_url ?? null,
    };
  });
}

export const desktopUploadGuide = { guideFor, buildPasteText, overview, desktopOnlyOf, CLIENT_KIND, GUIDE_SCHEMA };
export default desktopUploadGuide;
