/**
 * V4.0 小程序配套链路冒烟：自启动独立服务（MOCK，不产生算力消耗）。
 *
 * 覆盖小程序真正依赖的接口：
 *   登录 → 首页聚合 → 报价（动态/静态差异）→ 建项目 → 总谱与资产落库 →
 *   12 节点真实产物同步 → 项目详情聚合 → 越权/凭据零命中。
 *
 * 运行：npm run smoke:mini
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_MINI_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), `wangjudaka-smoke-mini-${process.pid}-${Date.now()}`);

let passed = 0;
let failed = 0;
let token = '';
const allText = [];

function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ' → ' + detail : ''}`); }
}

async function call(method, pathname, body, withAuth = false) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (withAuth && token) init.headers.Authorization = `Bearer ${token}`;
  // 传对象时作为额外请求头（管理端 X-Admin-Token）
  if (withAuth && typeof withAuth === 'object') Object.assign(init.headers, withAuth);
  const r = await fetch(BASE + pathname, init);
  const text = await r.text();
  allText.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, text, json };
}
const data = (r) => (r.json && r.json.data) || {};

async function waitHealth() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      RELAY_MOCK: 'true',
      NODE_ENV: 'test',
      // 强制走 mock：屏蔽 .env.local 里的真实微信凭据，避免拿假 code 调真接口
      WX_APPID: '',
      WX_SECRET: '',
      WX_PAY_OFFER_ID: '',
      WX_PAY_APP_KEY: '',
      RELAY_API_KEY: '',
      ADMIN_TOKEN: 'smoke-admin-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    if (!(await waitHealth())) throw new Error(`服务未在预期时间内启动\n${serverLog}`);

    // 1. 健康与品牌
    const health = await call('GET', '/health');
    ok('健康检查可用', health.status === 200 && health.json.ok === true);
    ok('服务名已更名网剧大咖', data(health).service === 'wangju-daka-server', data(health).service);
    ok('八类种子齐全', data(health).seeds.style_presets === 32 && data(health).seeds.transition_cards === 27);

    // 2. 登录（mock）与 /api/auth/me
    const login = await call('POST', '/api/auth/login', { code: 'mini-smoke-code', nickname: '小程序验收' });
    token = data(login).token || '';
    const userId = (data(login).user || {}).id || '';
    ok('登录返回 token 与用户', Boolean(token && userId), JSON.stringify(data(login)).slice(0, 120));
    ok('登录显式标注 mock', data(login).mode === 'mock');
    const me = await call('GET', '/api/auth/me', undefined, true);
    ok('token 可换回用户', me.status === 200 && data(me).user.id === userId);

    // 3. 空首页
    const empty = await call('GET', '/api/home', undefined, true);
    ok('首页空态可用', empty.status === 200 && data(empty).stats.projects === 0);

    // 4. 报价：静态漫剧应显著低于动态漫剧
    const qd = await call('POST', '/api/oneshot/quote', {
      prompt: '被家族抛弃的少年十年后归来复仇', styleCode: 'STY-DUSHI',
      totalMinutes: 10, episodeSec: 90, aspect: '9:16', quality: '1080p', videoType: 'dynamic',
    });
    const qs = await call('POST', '/api/oneshot/quote', {
      prompt: '被家族抛弃的少年十年后归来复仇', styleCode: 'STY-DUSHI',
      totalMinutes: 10, episodeSec: 90, aspect: '9:16', quality: '1080p', videoType: 'static',
    });
    ok('提案卡报价可用', qd.status === 200 && data(qd).est_credits > 0);
    ok('静态漫剧成本低于动态', data(qs).est_credits < data(qd).est_credits,
      `${data(qs).est_credits} vs ${data(qd).est_credits}`);
    ok('报价返回成本构成', data(qd).breakdown && data(qd).breakdown.video_per_shot > 0);

    // 5. 创建项目（中文经 UTF-8 往返不变形）
    const title = '复仇归来：十年之约';
    const created = await call('POST', '/api/projects', {
      userId, title, styleCode: 'STY-DUSHI', aspect: '9:16', quality: '1080p',
      totalMinutes: 5, episodeSec: 90, preset: 'balanced', videoType: 'dynamic',
      prompt: '被家族抛弃的少年，十年后带着一身修为归来复仇',
    });
    const projectId = data(created).id;
    ok('创建项目成功', created.status === 200 && Boolean(projectId));
    ok('中文标题无乱码', data(created).title === title, data(created).title);
    ok('视频类型已写入规格', data(created).spec.video_type === 'dynamic');

    // 6. 素材库（V4.2）：文本入库 → 列表不下发全文 → 图片 multipart 落盘 → 摘要可预检
    const novel = '第一场 夜 外 城中村天台\n李默握着一张被雨水泡皱的欠条，风把纸角掀起来，露出“叁拾万”三个字。\n'
      + '他身后是整片出租屋的灯，像一盘没熄的炭。\n\n'
      + '第二场 日 内 面馆\n老板娘把一碗面推过来，汤面浮着两片薄如纸的牛肉。\n“你爸那笔账，不该你来还。”';
    const textAdd = await call('POST', `/api/projects/${projectId}/materials/text`, { name: '参考小说', text: novel, note: '第一章' }, true);
    ok('小说文本可作为素材入库', textAdd.status === 200 && data(textAdd).stats.total === 1, textAdd.text.slice(0, 100));
    ok('文本素材统计字数', data(textAdd).stats.text_chars >= novel.length - 10, JSON.stringify(data(textAdd).stats));

    const matList = await call('GET', `/api/projects/${projectId}/materials`, undefined, true);
    const matItems = data(matList).items || [];
    ok('素材列表可拉取', matList.status === 200 && matItems.length === 1);
    ok('列表不下发素材全文', matItems.every((m) => m.text === undefined && m.file === undefined));
    ok('列表带预览首句', Boolean(matItems[0] && matItems[0].preview), JSON.stringify(matItems[0] && matItems[0].preview));

    // 图片走 multipart（与 wx.uploadFile 同构）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), '参考图.png');
    fd.append('note', '角色参考');
    const upRes = await fetch(`${BASE}/api/projects/${projectId}/materials/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    });
    const upJson = await upRes.json();
    const upItem = (upJson.data && upJson.data.items && upJson.data.items[0]) || {};
    ok('中文文件名图片可上传', upRes.status === 200 && upItem.kind === 'image', JSON.stringify(upJson).slice(0, 120));
    ok('素材统计含图片', (upJson.data.stats || {}).total === 2, JSON.stringify(upJson.data.stats));

    const media = await fetch(BASE + upItem.url);
    ok('上传的图片可通过 /media 免鉴权访问', media.status === 200 && /image\/png/.test(media.headers.get('content-type') || ''),
      `${media.status} ${media.headers.get('content-type')}`);

    // V4.9：素材不挑格式。读得出正文的（文稿/表格/幻灯片）转文本，读不出的（扫描版 PDF）存档并如实说明
    const fdSheet = new FormData();
    fdSheet.append('file', new Blob([Buffer.from('角色,身份\n林秋,女主\n', 'utf8')], { type: 'text/csv' }), '人物表.csv');
    const sheetRes = await fetch(`${BASE}/api/projects/${projectId}/materials/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fdSheet,
    });
    const sheetJson = sheetRes.status === 200 ? await sheetRes.json() : {};
    const sheetItem = (sheetJson.data && sheetJson.data.items && sheetJson.data.items[0]) || {};
    ok('CSV 素材被读成文本', sheetRes.status === 200 && sheetItem.has_text === true, `${sheetRes.status} ${JSON.stringify(sheetItem).slice(0, 100)}`);

    const fdBad = new FormData();
    fdBad.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), '剧本.pdf');
    const badRes = await fetch(`${BASE}/api/projects/${projectId}/materials/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fdBad,
    });
    const badJson = await badRes.json();
    const badItem = (badJson.data && badJson.data.items && badJson.data.items[0]) || {};
    ok('读不出正文的 PDF 转存档并如实标注', badRes.status === 200 && badItem.kind === 'file' && /已存档/.test(badItem.note || ''),
      `${badRes.status} ${badItem.kind}`);

    const dg = await call('GET', `/api/projects/${projectId}/materials/digest`, undefined, true);
    ok('素材摘要可预检', dg.status === 200 && data(dg).chars > 0, JSON.stringify(data(dg)).slice(0, 100));

    // 7. 生成总谱 → 资产落库 → 素材注入生效
    const planRes = await call('POST', `/api/projects/${projectId}/plan`, {});
    const planData = data(planRes);
    ok('总谱生成成功', planRes.status === 200 && Boolean(planData.plan_id));
    ok('总谱自检通过', planData.validation && planData.validation.ok === true);
    ok('分镜已产出', planData.shots > 0, String(planData.shots));
    ok('角色资产自动落库', planData.assets > 0, String(planData.assets));
    ok('上传的素材已注入总谱', planData.materials_used >= 2, String(planData.materials_used));
    ok('总谱记录参考字数', planData.reference_chars > 0, String(planData.reference_chars));

    // 7. 建流水线 → 节点由产物点亮
    const runRes = await call('POST', '/api/runs', { projectId, templateCode: 'BP_ONESHOT' });
    const nodes = data(runRes).nodes || [];
    const done = nodes.filter((n) => n.status === 'done').map((n) => n.id);
    ok('流水线 12 节点', nodes.length === 12, String(nodes.length));
    ok('前六个创作节点已点亮', ['N01', 'N02', 'N03', 'N04', 'N05', 'N06'].every((x) => done.includes(x)), done.join(','));
    ok('媒体节点不假装完成', !done.includes('N08') && !done.includes('N11'));

    // 8. 项目详情聚合
    const ov = await call('GET', `/api/projects/${projectId}/overview`);
    const ovd = data(ov);
    ok('详情聚合可用', ov.status === 200 && ovd.project.id === projectId);
    ok('聚合返回总谱摘要', ovd.plan && ovd.plan.shots > 0);
    ok('聚合返回分镜前 24 镜', Array.isArray(ovd.shots) && ovd.shots.length > 0 && ovd.shots.length <= 24);
    ok('聚合返回资产与进度', ovd.assets.total > 0 && ovd.progress.percent >= 40,
      `${ovd.assets.total} / ${ovd.progress.percent}%`);
    ok('交付闸门如实阻断', ovd.gate && ovd.gate.ready === false && (ovd.gate.blockers || []).length > 0);

    // 9. 首页聚合（token 鉴权，不传 userId）
    const home = await call('GET', '/api/home', undefined, true);
    const hd = data(home);
    const homeProjects = hd.projects || [];
    ok('首页返回项目', homeProjects.length === 1 && homeProjects[0].id === projectId);
    ok('首页带风格名与进度', homeProjects[0] && homeProjects[0].style_name === '都市' && typeof homeProjects[0].progress === 'number');
    ok('首页统计正确', hd.stats && hd.stats.projects === 1 && hd.stats.episodes >= 1 && hd.stats.minutes === 5);

    // 10. 充值档位与兑换码接口存在（不产生支付）
    const pkgs = await call('GET', '/api/recharge/packages');
    ok('充值档位可拉取', pkgs.status === 200 && Array.isArray(data(pkgs).packages));
    ok('支付模式显式标注', ['mock', 'live'].includes(data(pkgs).pay_mode), data(pkgs).pay_mode);

    // 11. 不存在项目 → 404 业务码
    const miss = await call('GET', '/api/projects/proj_not_exist/overview');
    ok('不存在项目返回 404', miss.status === 404 && miss.json.code === 'NOT_FOUND');

    // 12. 邀请裂变：B 带 A 的邀请码注册 → 待完成；B 建项目 → A 到账 1 点
    const inviteMe = await call('GET', '/api/invite/me', undefined, true);
    const inviterCode = data(inviteMe).invite_code || '';
    ok('我的邀请面板可用', inviteMe.status === 200 && inviterCode.length === 6, inviterCode);

    const loginB = await call('POST', '/api/auth/login', {
      code: 'mini-smoke-code-b', inviteCode: inviterCode, deviceId: 'device-b-smoke',
    });
    const tokenB = data(loginB).token;
    ok('新用户带邀请码注册', loginB.status === 200 && Boolean(tokenB));
    ok('邀请关系待完成作品', data(loginB).invite && data(loginB).invite.status === 'pending', JSON.stringify(data(loginB).invite));

    const balanceBefore = data(await call('GET', '/api/account/balance?userId=' + encodeURIComponent(data(loginB).user.id))).balance_points;
    ok('被邀请人初始余额为 0', balanceBefore === 0, String(balanceBefore));

    const projB = await call('POST', '/api/projects', {
      userId: data(loginB).user.id, title: '好友的第一部剧', prompt: '实习生逆袭成为主理人',
    }, { Authorization: `Bearer ${tokenB}` });
    ok('被邀请人创建首个项目', projB.status === 200 && Boolean(data(projB).id), projB.text.slice(0, 80));

    // 越权保护：拿 A 的 token 替 B 建项目必须被拒（否则可以替小号刷“首部作品”骗奖励）
    const forge = await call('POST', '/api/projects', {
      userId: data(loginB).user.id, title: '代建', prompt: '代建项目',
    }, true);
    ok('不能替其他用户创建项目', forge.status === 403, String(forge.status));

    const inviterBal = await call('GET', '/api/account/balance?userId=' + encodeURIComponent(userId), undefined, true);
    ok('好友完成首部作品后邀请人 +1 点', data(inviterBal).balance_points === 1, String(data(inviterBal).balance_points));

    const rebind = await call('POST', '/api/invite/bind', { code: inviterCode, deviceId: 'device-b-smoke' },
      { Authorization: `Bearer ${tokenB}` });
    ok('同一账号不能重复被邀请', /已被邀请过/.test(data(rebind).message || ''), JSON.stringify(data(rebind)));

    // 13. 续集：以第一季为参考开第二季，继承角色资产
    const season = await call('POST', `/api/projects/${projectId}/season`, { prompt: '第二季：主角进入商战' }, true);
    ok('续集创建成功', season.status === 200 && data(season).season_no === 2, JSON.stringify(data(season).season_no));
    ok('续集继承角色资产', data(season).inherited_assets >= 1, String(data(season).inherited_assets));

    const seriesView = await call('GET', `/api/projects/${projectId}/series`);
    ok('系列视图返回两季', seriesView.status === 200 && data(seriesView).seasons.length === 2, String((data(seriesView).seasons || []).length));
    ok('系列共享角色可复用', (data(seriesView).shared_assets || []).length >= 1);

    const lineage = await call('GET', `/api/projects/${data(season).project.id}/assets/lineage`);
    ok('续集资产可追溯第一季', (data(lineage) || [])[0] && data(lineage)[0].origin_project_id === projectId);

    // 14. 管理端：兑换码生成 / 档次 / 邀请规则（X-Admin-Token 鉴权）
    const adminNoAuth = await call('GET', '/api/admin/invites/stats');
    ok('管理端无令牌被拒', adminNoAuth.status === 403 || adminNoAuth.status === 401, String(adminNoAuth.status));

    const adminHeaders = { 'X-Admin-Token': 'smoke-admin-token' };
    const gen = await call('POST', '/api/admin/redeem-codes', { points: 50, count: 2, prefix: 'SMK', note: '冒烟' }, adminHeaders);
    ok('管理员可生成兑换码', gen.status === 200 && data(gen).codes.length === 2);
    const redeem = await call('POST', '/api/redeem', { code: data(gen).codes[0] }, true);
    ok('用户可用兑换码兑成算力额度', redeem.status === 200 && data(redeem).credited === 50, String(data(redeem).credited));

    const pkgAdd = await call('POST', '/api/admin/packages', {
      name: '冒烟福利包', points: 200, bonus: 40, priceCny: 200, sort: 9,
    }, adminHeaders);
    ok('管理员可设置充值档次与赠送福利', pkgAdd.status === 200 && data(pkgAdd).bonus === 40);

    const invStats = await call('GET', '/api/admin/invites/stats', undefined, adminHeaders);
    ok('管理端邀请统计可用', invStats.status === 200 && data(invStats).rewarded >= 1, JSON.stringify(data(invStats).rewarded));

    const setInv = await call('POST', '/api/admin/invite-settings', { reward_points: 2 }, adminHeaders);
    ok('管理端可调邀请奖励额度', setInv.status === 200 && data(setInv).reward_points === 2);

    // 15. 剧本视图 + 逐镜生产（V4.2）
    const scriptView = await call('GET', `/api/projects/${projectId}/script`, undefined, true);
    const sv = data(scriptView);
    const ep0 = (sv.episodes || [])[0] || {};
    ok('剧本视图返回分集', scriptView.status === 200 && (sv.episodes || []).length >= 1,
      String((sv.episodes || []).length));
    ok('分集含场次与动作', (ep0.scenes || []).length >= 1 && Boolean((ep0.scenes || [])[0].action),
      String((ep0.scenes || []).length));
    ok('剧本记录素材来源', (sv.materials_used || []).length >= 1, JSON.stringify(sv.materials_used));

    const planFull = await call('GET', `/api/projects/${projectId}/plan`, undefined, true);
    const shotsAll = (data(planFull).storyboard || {}).shots || [];
    const shotA = shotsAll[0] && shotsAll[0].no;
    const shotB = (shotsAll[1] && shotsAll[1].no) || shotA;
    ok('总谱含分镜号', Boolean(shotA), String(shotA));

    // 镜头生成要花点数：管理员发码 → 用户兑换
    const bigCodes = await call('POST', '/api/admin/redeem-codes', { points: 800, count: 1, prefix: 'SHOT' }, adminHeaders);
    await call('POST', '/api/redeem', { code: data(bigCodes).codes[0] }, true);

    const vidBad = await call('POST', `/api/projects/${projectId}/shots/${shotB}/generate`, { kind: 'video' }, true);
    // 没资产图时会被五维一致性先拦（422），有关键帧但没资产图则是 409 —— 两者都算"如实拒绝"
    ok('无关键帧时视频被拒',
      (vidBad.status === 409 && vidBad.json.code === 'SHOT_SOURCE_REQUIRED')
      || (vidBad.status === 422 && vidBad.json.code === 'CONSISTENCY_VIOLATION'),
      `${vidBad.status} ${vidBad.json && vidBad.json.code}`);

    // V4.11：五维一致性要求先出资产设定图（角色/场景），分镜才有视觉依据
    const sheetChars = await call('POST', `/api/projects/${projectId}/assets/images`, { type: 'character', limit: 4 }, true);
    ok('角色资产图先出', sheetChars.status === 200 && data(sheetChars).done >= 1, sheetChars.text.slice(0, 120));
    const sheetScenes = await call('POST', `/api/projects/${projectId}/assets/images`, { type: 'scene', limit: 4 }, true);
    ok('场景资产图先出', sheetScenes.status === 200 && data(sheetScenes).done >= 1, sheetScenes.text.slice(0, 120));

    const imgGen = await call('POST', `/api/projects/${projectId}/shots/${shotA}/generate`, { kind: 'image' }, true);
    ok('按镜出关键帧', imgGen.status === 200 && Boolean(data(imgGen).url), imgGen.text.slice(0, 120));
    ok('返回本镜编译信息', Boolean(data(imgGen).compile && data(imgGen).compile.shot_card));

    const vidGen = await call('POST', `/api/projects/${projectId}/shots/${shotA}/generate`, { kind: 'video' }, true);
    ok('有关键帧后可出视频', vidGen.status === 200 && data(vidGen).kind === 'video', String(vidGen.status));

    const history = await call('GET', `/api/projects/${projectId}/shots/${shotA}/generations`, undefined, true);
    ok('镜头历史可回溯', history.status === 200 && (data(history).items || []).length >= 2,
      String((data(history).items || []).length));

    // V4.13：角色名册（含配角）+ 成片装配索引
    const roster = await call('GET', `/api/projects/${projectId}/assets/roster`, undefined, true);
    ok('角色名册可读（含配角）', roster.status === 200 && data(roster).total >= 1,
      `${roster.status} total=${data(roster) && data(roster).total}`);
    ok('名册能指出缺图角色', roster.status === 200 && Array.isArray(data(roster).missing_images));

    const asm = await call('GET', `/api/projects/${projectId}/assembly`, undefined, true);
    ok('成片装配索引可读', asm.status === 200 && Array.isArray(data(asm).clips),
      `${asm.status} clips=${data(asm) && (data(asm).clips || []).length}`);
    ok('装配按镜号排序', asm.status === 200 && (data(asm).clips || []).every((c, i, arr) => i === 0 || arr[i - 1].order <= c.order));

    // 重出关键帧 → 旧版本被弃用、新版本成为当前版本（剪辑只会看到新版本）
    const regen = await call('POST', `/api/projects/${projectId}/shots/${shotA}/regenerate`, { kind: 'image', mode: 'resample' }, true);
    ok('重出某一镜成功并返回当前版本', regen.status === 200 && Boolean(data(regen).version && data(regen).version.generation_id),
      `${regen.status} ${(data(regen) && data(regen).version && data(regen).version.generation_id) || ''}`);
    if (regen.status === 200) {
      const v = data(regen).version;
      ok('新版本同步了镜号索引', Number(v.order) > 0 && v.order === data(asm).clips.find((c) => c.shot_no === shotA)?.order,
        `${v.order}`);
      const asm2 = await call('GET', `/api/projects/${projectId}/assembly`, undefined, true);
      const clip = (data(asm2).clips || []).find((c) => c.shot_no === shotA);
      // 这一镜已经有视频版本，成片仍取视频（这是对的）；重出的关键帧要体现在 still_url 上
      ok('成片引用的分镜图是新版本', clip && clip.still_url && clip.still_url === data(regen).url,
        `${clip && clip.still_url}`);
      ok('旧版本被标废弃但记录仍在', (data(regen).version.superseded || []).length >= 1,
        String((data(regen).version.superseded || []).length));
    }

    // V4.14：分环节参数（模型/风格/画幅/画质）+ 资产参考图 + 自动填词
    const stageAll = await call('GET', `/api/projects/${projectId}/stage-options`, undefined, true);
    ok('分环节参数可读（七个环节）', stageAll.status === 200 && Object.keys(data(stageAll).stages || {}).length === 7,
      `${stageAll.status} ${Object.keys((data(stageAll) && data(stageAll).stages) || {}).length}`);
    const stChar = (data(stageAll) && data(stageAll).stages && data(stageAll).stages.character) || {};
    ok('角色环节能选模型/风格/画幅/画质',
      (stChar.options?.models || []).length > 0 && (stChar.options?.styles || []).length >= 32
      && (stChar.options?.aspects || []).length >= 4 && (stChar.options?.qualities || []).length >= 3);

    const setChar = await call('POST', `/api/projects/${projectId}/stage-options`, {
      stage: 'character', patch: { aspect: '4:3', quality: '2k' },
    }, true);
    ok('能单独设置角色环节的画幅画质',
      setChar.status === 200 && data(setChar).effective?.aspect === '4:3' && data(setChar).effective?.quality === '2k',
      JSON.stringify(data(setChar) && data(setChar).effective));
    const projAfter = await call('GET', `/api/projects/${projectId}`, undefined, true);
    ok('环节设置不改项目规格', data(projAfter).spec?.aspect === '9:16',
      `${data(projAfter).spec && data(projAfter).spec.aspect}`);

    const badAspect = await call('POST', `/api/projects/${projectId}/stage-options`, {
      stage: 'character', patch: { aspect: '21:9' },
    }, true);
    ok('非法画幅被拒绝', badAspect.status === 422 || badAspect.status === 400, String(badAspect.status));

    // 资产参考图 + 自动填词
    const charCode = ((data(roster) && data(roster).characters) || [])[0]?.asset_code || 'CH01';
    const refRes = await call('POST', `/api/projects/${projectId}/assets/${charCode}/reference`, {
      images: [{ url: 'cos://smoke/ref.png', name: 'ref.png' }],
    }, true);
    ok('能给角色挂本地参考图', refRes.status === 200 && data(refRes).count >= 1, `${refRes.status}`);
    const draft = await call('POST', `/api/projects/${projectId}/assets/${charCode}/prompt-draft`, {}, true);
    ok('能自动填提示词并给出处',
      draft.status === 200 && typeof data(draft).prompt === 'string' && data(draft).prompt.length > 10
      && Array.isArray(data(draft).basis?.quotes),
      `${draft.status} ${(data(draft) && data(draft).prompt || '').slice(0, 20)}`);
    const saveP = await call('POST', `/api/projects/${projectId}/assets/${charCode}/prompt`, { prompt: '测试提示词' }, true);
    ok('能保存手写提示词', saveP.status === 200, String(saveP.status));

    // 虚拟支付接入体检 + 到账轮询
    const paySt = await call('GET', '/api/pay/virtual/status', undefined, true);
    ok('虚拟支付体检可读', paySt.status === 200 && Array.isArray(data(paySt).items), String(paySt.status));
    const payOrder = await call('POST', '/api/pay/virtual/order', { amountCny: 6 }, true);
    const qOrder = await call('POST', '/api/pay/virtual/query', { orderId: data(payOrder).order_id }, true);
    ok('未到账时轮询如实返回 pending', qOrder.status === 200 && data(qOrder).paid === false, String(qOrder.status));

    const nf = await call('POST', `/api/projects/${projectId}/shots/E99-S999/generate`, { kind: 'image' }, true);
    ok('未知镜号返回 404', nf.status === 404 && nf.json.code === 'SHOT_NOT_FOUND', `${nf.status} ${nf.json && nf.json.code}`);

    // 16. 项目闸门：没有剧本不能出图（428 而非 400）
    const loginC = await call('POST', '/api/auth/login', { code: 'mini-smoke-code-c', deviceId: 'device-c-smoke' });
    const tokenC = data(loginC).token;
    const projC = await call('POST', '/api/projects', {
      userId: data(loginC).user.id, title: '空项目', prompt: '测试项目闸门',
    }, { Authorization: `Bearer ${tokenC}` });
    const cid = data(projC).id;
    const gateC = await call('POST', `/api/projects/${cid}/shots/E01-S001/generate`, { kind: 'image' },
      { Authorization: `Bearer ${tokenC}` });
    ok('无剧本时出图返回 428', gateC.status === 428 && gateC.json.code === 'PROJECT_REQUIRED',
      `${gateC.status} ${gateC.json && gateC.json.code}`);
    const gateScript = await call('GET', `/api/projects/${cid}/script`, undefined, { Authorization: `Bearer ${tokenC}` });
    ok('无剧本时剧本视图 404', gateScript.status === 404, String(gateScript.status));
    const cross = await call('GET', `/api/projects/${projectId}/materials`, undefined, { Authorization: `Bearer ${tokenB}` });
    ok('跨账号读素材被拒 403', cross.status === 403, String(cross.status));

    // 16.5 资产归属与永久保留（V4.15）
    const aAssets = await call('GET', `/api/projects/${projectId}/assets`, undefined, true);
    const aList = Array.isArray(data(aAssets)) ? data(aAssets) : (data(aAssets).items || []);
    ok('资产带账号归属', aList.length > 0 && aList.every((x) => Boolean(x.user_id)),
      `${aList.length} 条，缺 user_id: ${aList.filter((x) => !x.user_id).length}`);
    ok('资产归属就是项目主人', aList.length > 0 && aList.every((x) => x.user_id === userId));

    // B 读 A 的资产：403（项目级越权拦在 projectOf）
    const bReadA = await call('GET', `/api/projects/${projectId}/assets`, undefined,
      { Authorization: `Bearer ${tokenB}` });
    ok('跨账号读资产被拒', bReadA.status === 403 || bReadA.status === 404, String(bReadA.status));

    // B 删 A 的资产：一律 404（不确认存在性），且 A 的资产必须还在
    const victim = aList[0] && aList[0].asset_code;
    if (victim) {
      const bDel = await call('POST', `/api/projects/${projectId}/assets/${victim}/delete`,
        { confirm: true }, { Authorization: `Bearer ${tokenB}` });
      ok('跨账号删除被拒且不泄漏存在性', bDel.status === 404, `${bDel.status} ${bDel.json && bDel.json.code}`);
      const stillThere = await call('GET', `/api/projects/${projectId}/assets`, undefined, true);
      ok('别人删不掉我的资产',
        (Array.isArray(data(stillThere)) ? data(stillThere) : []).some((x) => x.asset_code === victim));

      // 本人不确认 → 400，数据不动
      const noConfirm = await call('POST', `/api/projects/${projectId}/assets/${victim}/delete`, {}, true);
      ok('删除必须显式确认', noConfirm.status === 400, String(noConfirm.status));

      // 本人确认 → 真删 + 给凭证
      const del = await call('POST', `/api/projects/${projectId}/assets/${victim}/delete`,
        { confirm: true, reason: 'smoke' }, true);
      ok('本人确认后删除成功并给凭证',
        del.status === 200 && Boolean(data(del).receipt_id), `${del.status} ${JSON.stringify(data(del)).slice(0, 80)}`);
      const afterDel = await call('GET', `/api/projects/${projectId}/assets`, undefined, true);
      const rest = Array.isArray(data(afterDel)) ? data(afterDel) : [];
      ok('删除后资产确实不在了', !rest.some((x) => x.asset_code === victim));

      const dlog = await call('GET', `/api/projects/${projectId}/assets/deletions`, undefined, true);
      ok('删除留下可查凭证',
        (data(dlog).items || []).some((x) => x.asset_code === victim && x.reason === 'smoke'));
    }

    // 账号总账：只含自己的东西，且明说永久保留
    const ledgerA = await call('GET', '/api/me/assets', undefined, true);
    ok('账号资产总账可读', ledgerA.status === 200 && data(ledgerA).retention === 'permanent');
    ok('总账里有自己的项目', (data(ledgerA).projects || []).some((x) => x.id === projectId));
    const ledgerB = await call('GET', '/api/me/assets', undefined, { Authorization: `Bearer ${tokenB}` });
    ok('总账不串号', !(data(ledgerB).projects || []).some((x) => x.id === projectId));

    // 隔离自检（管理端）：不允许存在归属不一致的记录
    const iso = await call('GET', '/api/admin/assets/isolation', undefined,
      { 'X-Admin-Token': 'smoke-admin-token' });
    ok('隔离自检可通过', iso.status === 200 && data(iso).ok === true,
      `${iso.status} issues=${data(iso).total_issues}`);
    const ruleRes = await call('GET', '/api/admin/assets/rule', undefined,
      { 'X-Admin-Token': 'smoke-admin-token' });
    ok('规则可对外陈述（四条）', (data(ruleRes).clauses || []).length === 4 && data(ruleRes).retention === 'permanent');

    // 16.6 收益排行榜（V4.16）
    const lbAnon = await call('GET', '/api/leaderboard');
    ok('排行榜未登录也能看（所有人可见）', lbAnon.status === 200, String(lbAnon.status));
    ok('榜单口径只有一份：前 1000 名 / 每日刷新',
      data(lbAnon).rules.capacity === 1000 && data(lbAnon).rules.refresh === 'daily');
    ok('榜单带每日快照日期', /^\d{4}-\d{2}-\d{2}$/.test(String(data(lbAnon).snapshot.date)),
      data(lbAnon).snapshot.date);
    ok('榜单条目不含 user_id',
      (data(lbAnon).list || []).every((x) => !('user_id' in x)));
    const lbRules = await call('GET', '/api/leaderboard/rules');
    ok('榜单规则单独可取（前端文案同源）',
      lbRules.status === 200 && data(lbRules).visible_to === 'all_users' && data(lbRules).participates_by_default === true);

    // A 回填一笔收益；B 不能往 A 的分发里写钱（榜单名次不能被人代刷）
    const distA = await call('POST', '/api/distribution',
      { projectId, episodeNo: 'E01', platformCode: 'PLT-HONGGUO' }, true);
    const distIdA = data(distA).id;
    ok('分发记录可创建', Boolean(distIdA), String(distA.status));
    if (distIdA) {
      const revA = await call('POST', `/api/distribution/${distIdA}/revenue`,
        { amount: 888.8, period: '2026-11' }, true);
      ok('本人可回填收益', revA.status === 200, String(revA.status));
      const revB = await call('POST', `/api/distribution/${distIdA}/revenue`,
        { amount: 99999 }, { Authorization: `Bearer ${tokenB}` });
      ok('别人不能往我的分发里回填收益', revB.status === 404, `${revB.status} ${revB.json && revB.json.code}`);
    }

    // 每日刷新：同一天先看到的是当天已建好的快照，管理端手动重算后才把新收益算进去
    const rsh = await call('POST', '/api/admin/leaderboard/refresh', {},
      { 'X-Admin-Token': 'smoke-admin-token' });
    ok('管理端可重算榜单', rsh.status === 200 && data(rsh).snapshot.entry_count >= 1,
      `${rsh.status} entries=${data(rsh).snapshot && data(rsh).snapshot.entry_count}`);
    const lbMine = await call('GET', '/api/leaderboard', undefined, true);
    ok('回填收益后能上榜', (data(lbMine).list || []).length >= 1);
    ok('本页能读到我自己的名次', Boolean(data(lbMine).me && data(lbMine).me.rank),
      JSON.stringify(data(lbMine).me));
    ok('名次按总收益排（第一名金额最大）',
      (data(lbMine).list || []).every((x, i, arr) => i === 0 || arr[i - 1].total_cny >= x.total_cny));

    // 参与开关：默认参与，关掉立刻下榜
    const offR = await call('POST', '/api/leaderboard/participation', { optOut: true }, true);
    ok('可关闭榜单参与', offR.status === 200 && data(offR).participating === false, String(offR.status));
    const lbOff = await call('GET', '/api/leaderboard', undefined, true);
    ok('关闭后自己立刻不在榜', Boolean(data(lbOff).me) && data(lbOff).me.on_board === false);
    const onR = await call('POST', '/api/leaderboard/participation', { optOut: false }, true);
    ok('可重新参与榜单', onR.status === 200 && data(onR).participating === true);

    // 16.7 电脑端上传指引（V4.18）：红果/抖音只能电脑端，手机侧要给足步骤与复制项
    const plats = await call('GET', '/api/platforms');
    const platList = Array.isArray(data(plats).items) ? data(plats).items : (data(plats) || []);
    ok('平台卡片带「能不能手机传」角标',
      platList.length > 0 && platList.every((p) => p.client_kind && typeof p.desktop_only === 'boolean'));
    ok('红果被标成只能在电脑端',
      platList.find((p) => p.code === 'PLT-HONGGUO')?.desktop_only === true);

    const gd = await call('GET', '/api/distribute/desktop-guide?platform=PLT-HONGGUO');
    ok('红果电脑端指引可取', gd.status === 200 && data(gd).desktop_only === true, String(gd.status));
    ok('指引步骤细到「在哪个页面做」',
      (data(gd).steps || []).length >= 5 && (data(gd).steps || []).every((s) => s.title && s.where));
    ok('指引给出可复制的入口', (data(gd).handoff || []).some((h) => h.key === 'entry' && h.copyable === true));
    ok('指引带剧目信息粘贴包', String(data(gd).paste_text || '').includes('上传入口'));
    ok('指引永不代提交', data(gd).no_auto_submit === true && data(gd).policy.auto_submit === false);

    const gdDy = await call('GET', '/api/distribute/desktop-guide?platform=PLT-DOUYIN');
    ok('抖音也标成必须电脑端签约', data(gdDy).desktop_only === true && String(data(gdDy).why).includes('签约'));

    const gdBad = await call('GET', '/api/distribute/desktop-guide?platform=PLT-NOT-EXIST');
    ok('未知平台返回 404，不硬编', gdBad.status === 404, String(gdBad.status));

    // 16.5 异步任务（V4.19）：慢操作改成「提交 → 轮询」
    //
    // 内网通道 wx.cloud.callContainer 的 timeout 硬上限是 15s，同步等 AI 出图必超时。
    // 这里验协议本身：提交立刻给 task_id、轮询能拿终态、成功带产物、失败带错误码。
    const submitTask = await call('POST', `/api/task/projects/${projectId}/shots/${shotA}/generate`, { kind: 'image' }, true);
    ok('异步任务提交立刻返回 task_id', submitTask.status === 200 && Boolean(data(submitTask).task_id), submitTask.text.slice(0, 120));
    ok('提交返回轮询地址', String(data(submitTask).poll_url || '').includes('/api/task/'));

    const waitTask = async (id, rounds = 80) => {
      let view = null;
      for (let i = 0; i < rounds; i += 1) {
        const r = await call('GET', `/api/task/${id}`);
        view = data(r);
        if (view && view.done) break;
        await new Promise((res) => setTimeout(res, 120));
      }
      return view;
    };

    const shotView = await waitTask(data(submitTask).task_id);
    ok('轮询能拿到终态', Boolean(shotView && shotView.done), JSON.stringify(shotView || {}).slice(0, 160));
    // 这一镜可能因一致性前置条件被拒（那是正确行为）：终态必须有明确说法，不能停在「生成中」
    ok('终态二选一：有产物 或 有错误码',
      Boolean(shotView) && (shotView.status === 'succeeded' ? Boolean(shotView.result && shotView.result.url) : Boolean(shotView.error_code)),
      String(shotView && (shotView.error_code || shotView.error_message)));
    // 成功才给 100；失败保留「停在哪一步」，不假装跑完
    ok('进度口径正确（成功 100 / 失败留在现场）且耗时可用',
      Boolean(shotView) && Number.isFinite(shotView.elapsed_sec)
      && (shotView.status === 'succeeded' ? shotView.progress === 100 : shotView.progress <= 92),
      `${shotView && shotView.status} p=${shotView && shotView.progress}`);
    ok('阶段文案是中文中性描述', Boolean(shotView && /[\u4e00-\u9fa5]/.test(shotView.stage_text || '')));

    // 必定成功的一条：给已有资产重绘（资产图不需要分镜一致性前置）
    const assetList = await call('GET', `/api/projects/${projectId}/assets`, undefined, true);
    const firstAsset = (data(assetList).items || data(assetList) || [])[0];
    if (firstAsset && firstAsset.asset_code) {
      const tAsset = await call('POST', `/api/task/projects/${projectId}/assets/${firstAsset.asset_code}/image`, { force: true }, true);
      ok('资产出图也能走异步任务', tAsset.status === 200 && Boolean(data(tAsset).task_id), tAsset.text.slice(0, 120));
      const assetView = await waitTask(data(tAsset).task_id);
      ok('资产任务成功并带产物地址',
        Boolean(assetView) && assetView.status === 'succeeded' && Boolean(assetView.result && (assetView.result.url || assetView.result.skipped)),
        String(assetView && (assetView.error_message || '')));
    }

    const taskMiss = await call('GET', '/api/task/task_not_exists_xxx');
    ok('不存在的任务号返回 404', taskMiss.status === 404, String(taskMiss.status));

    const taskList = await call('GET', `/api/tasks?projectId=${projectId}`, undefined, true);
    ok('任务列表可读且含并发实况', taskList.status === 200 && Array.isArray(data(taskList).items)
      && Number.isFinite(data(taskList).stats.max_running), String(taskList.status));

    // 同一 idemKey 重复提交不会重复执行（双击/网络重试不该扣两次点）
    const idem = `smoke-${Date.now()}`;
    const firstAssetCode = firstAsset && firstAsset.asset_code;
    if (firstAssetCode) {
      const t1 = await call('POST', `/api/task/projects/${projectId}/assets/${firstAssetCode}/image`, { force: true, idemKey: idem }, true);
      const t2 = await call('POST', `/api/task/projects/${projectId}/assets/${firstAssetCode}/image`, { force: true, idemKey: idem }, true);
      ok('同 idemKey 复用同一个任务号', Boolean(data(t1).task_id) && data(t1).task_id === data(t2).task_id,
        `${data(t1).task_id} vs ${data(t2).task_id}`);
    }

    // 17. 凭据零命中
    const joined = allText.join('\n');
    ok('响应不含 sk- 密钥', !/sk-[A-Za-z0-9]{8,}/.test(joined));
    ok('响应不含环境变量名', !/RELAY_API_KEY|WX_PAY_APP_KEY|RELAY_CONSOLE_PASSWORD/.test(joined));

    console.log(`\n=== 小程序配套冒烟：${passed} 通过 / ${failed} 失败 ===\n`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.on('exit', r)),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  }
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exitCode = 1;
});
