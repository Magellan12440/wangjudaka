/**
 * V4.1 增长与项目管理：邀请裂变 / 续集系列。
 *
 * 重点验证「邀请有效才发奖」这条业务红线：
 * 自邀、同设备、同 IP 批量、老用户补绑、重复绑定一律不发；
 * 只有「新用户 + 完成首部作品」才结算，且幂等不重复发。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db } from '../src/store/db.js';
import inviteService, { INVITE_STATUS, normalizeInviteCode } from '../src/growth/InviteService.js';
import seriesService from '../src/pipeline/SeriesService.js';
import ledger from '../src/ledger/Ledger.js';
import assetLibrary from '../src/assets/AssetLibrary.js';
import seeds from '../src/seeds/loader.js';
import { nowIso } from '../src/core/util.js';

let seq = 0;
function mkUser(extra = {}) {
  seq += 1;
  const id = extra.id ?? `u_g${seq}`;
  db.insert('users', {
    id,
    openid: `op_${id}`,
    nickname: `测试用户${seq}`,
    created_at: nowIso(),
    ...extra,
  });
  ledger.ensureAccount(id);
  return db.findOne('users', (u) => u.id === id);
}

function devHash(deviceId) {
  return crypto.createHash('sha256').update(String(deviceId)).digest('hex').slice(0, 16);
}

test('邀请码：6 位、无易混淆字符、唯一且可重复取回', () => {
  const u = mkUser();
  const c1 = inviteService.ensureCode(u.id);
  const c2 = inviteService.ensureCode(u.id);
  assert.equal(c1.code, c2.code);
  assert.equal(c1.code.length, 6);
  assert.ok(!/[0O1IL]/.test(c1.code), `不应含易混淆字符: ${c1.code}`);
  assert.equal(normalizeInviteCode(`${c1.code.slice(0, 3)}-${c1.code.slice(3)}`.toLowerCase()), c1.code);
});

test('邀请有效：新用户注册绑定 → 完成首部作品才发 1 点', () => {
  const inviter = mkUser();
  const invitee = mkUser();
  const code = inviteService.ensureCode(inviter.id).code;

  const bind = inviteService.bindOnRegister({ inviteeId: invitee.id, code, deviceId: 'dev-bind', ip: '10.0.0.1' });
  assert.equal(bind.status, INVITE_STATUS.PENDING);
  assert.equal(ledger.balance(inviter.id), 0, '注册即发是错的，必须等里程碑');

  const r = inviteService.markMilestone({ userId: invitee.id, milestone: 'project_created' });
  assert.equal(r.status, INVITE_STATUS.REWARDED);
  assert.equal(r.points, 1);
  assert.equal(ledger.balance(inviter.id), 1, '邀请人应到账 1 点（1 元）');

  // 幂等：重复回调不重复发
  assert.equal(inviteService.markMilestone({ userId: invitee.id }), null);
  assert.equal(ledger.balance(inviter.id), 1);

  // 对账平衡
  assert.equal(ledger.reconcile(inviter.id).ok, true);
  const entry = db.findOne('ledger_entries', (e) => e.user_id === inviter.id && e.channel === 'invite_reward');
  assert.equal(entry.points, 1);
  assert.equal(entry.type, 'grant');
});

test('邀请无效：不能邀请自己', () => {
  const u = mkUser();
  const code = inviteService.ensureCode(u.id).code;
  const r = inviteService.bindOnRegister({ inviteeId: u.id, code });
  assert.equal(r.status, INVITE_STATUS.REJECTED);
  assert.match(r.reason, /自己/);
  assert.equal(db.count('invites', (i) => i.invitee_id === u.id && i.status === INVITE_STATUS.REWARDED), 0);
});

test('邀请无效：同一设备注册的两个账号互相邀请', () => {
  const deviceId = 'device-same-001';
  const inviter = mkUser({ device_hash: devHash(deviceId) });
  const invitee = mkUser();
  const code = inviteService.ensureCode(inviter.id).code;
  const r = inviteService.bindOnRegister({ inviteeId: invitee.id, code, deviceId });
  assert.equal(r.status, INVITE_STATUS.REJECTED);
  assert.match(r.reason, /设备/);
  assert.equal(ledger.balance(inviter.id), 0);
});

test('邀请无效：同一账号只能被邀请一次', () => {
  const a = mkUser();
  const b = mkUser();
  const c = mkUser();
  const r1 = inviteService.bindOnRegister({ inviteeId: b.id, code: inviteService.ensureCode(a.id).code, ip: '10.0.0.9' });
  assert.equal(r1.status, INVITE_STATUS.PENDING);
  const r2 = inviteService.bindOnRegister({ inviteeId: b.id, code: inviteService.ensureCode(c.id).code, ip: '10.0.0.9' });
  assert.equal(r2.status, INVITE_STATUS.PENDING); // 返回已存在记录的状态
  assert.match(r2.message, /已被邀请过/);
  assert.equal(db.count('invites', (i) => i.invitee_id === b.id && i.status === INVITE_STATUS.PENDING), 1);
});

test('邀请无效：老用户补绑 / 已有作品不计数', () => {
  const inviter = mkUser();
  const code = inviteService.ensureCode(inviter.id).code;

  const old = mkUser({ created_at: new Date(Date.now() - 3 * 86400_000).toISOString() });
  const r1 = inviteService.bindOnRegister({ inviteeId: old.id, code });
  assert.equal(r1.status, INVITE_STATUS.REJECTED);
  assert.match(r1.reason, /新注册/);

  const busy = mkUser();
  db.insert('projects', { id: `proj_g_${busy.id}`, user_id: busy.id, title: '已有作品', spec: {}, status: 'draft', created_at: nowIso() });
  const r2 = inviteService.bindOnRegister({ inviteeId: busy.id, code });
  assert.equal(r2.status, INVITE_STATUS.REJECTED);
  assert.match(r2.reason, /新注册/);
});

test('邀请无效：同一 IP 短时间批量绑定超限', () => {
  inviteService.updateSettings({ ip_daily_limit: 2 });
  const ip = '203.0.113.77';
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const inviter = mkUser();
    const invitee = mkUser();
    results.push(inviteService.bindOnRegister({
      inviteeId: invitee.id, code: inviteService.ensureCode(inviter.id).code, ip,
    }));
  }
  assert.equal(results[0].status, INVITE_STATUS.PENDING);
  assert.equal(results[1].status, INVITE_STATUS.PENDING);
  assert.equal(results[2].status, INVITE_STATUS.REJECTED);
  assert.match(results[2].reason, /网络环境/);
  inviteService.updateSettings({ ip_daily_limit: 5 });
});

test('每日奖励上限：超限挂起，调高额度后自动补发', () => {
  inviteService.updateSettings({ daily_reward_limit: 1 });
  const inviter = mkUser();
  const code = inviteService.ensureCode(inviter.id).code;
  const one = mkUser();
  const two = mkUser();

  inviteService.bindOnRegister({ inviteeId: one.id, code, ip: '198.51.100.1' });
  inviteService.bindOnRegister({ inviteeId: two.id, code, ip: '198.51.100.2' });
  assert.equal(inviteService.markMilestone({ userId: one.id }).status, INVITE_STATUS.REWARDED);
  const second = inviteService.markMilestone({ userId: two.id });
  assert.equal(second.status, INVITE_STATUS.QUALIFIED, '受上限限制应挂起而不是判无效');
  assert.equal(ledger.balance(inviter.id), 1);

  inviteService.updateSettings({ daily_reward_limit: 10 });
  const retried = inviteService.retryQualified(inviter.id);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, INVITE_STATUS.REWARDED);
  assert.equal(ledger.balance(inviter.id), 2);
  assert.equal(ledger.reconcile(inviter.id).ok, true);
});

test('后台可改奖励额度：新邀请按新额度发放', () => {
  assert.equal(inviteService.updateSettings({ reward_points: 5 }).reward_points, 5);
  const inviter = mkUser();
  const invitee = mkUser();
  inviteService.bindOnRegister({ inviteeId: invitee.id, code: inviteService.ensureCode(inviter.id).code, ip: '198.51.100.9' });
  inviteService.markMilestone({ userId: invitee.id });
  assert.equal(ledger.balance(inviter.id), 5);
  assert.equal(inviteService.updateSettings({ reward_points: 1 }).reward_points, 1);
});

test('管理端判定无效：已发奖励可追回且余额不为负、对账仍平衡', () => {
  const inviter = mkUser();
  const invitee = mkUser();
  inviteService.bindOnRegister({ inviteeId: invitee.id, code: inviteService.ensureCode(inviter.id).code, ip: '198.51.100.11' });
  inviteService.markMilestone({ userId: invitee.id });
  assert.equal(ledger.balance(inviter.id), 1);

  const inv = db.findOne('invites', (i) => i.invitee_id === invitee.id);
  const r = inviteService.adminReject(inv.id, 'manual');
  assert.equal(r.ok, true);
  assert.equal(ledger.balance(inviter.id), 0);
  assert.equal(ledger.reconcile(inviter.id).ok, true);
  assert.equal(db.findOne('invites', (i) => i.id === inv.id).status, INVITE_STATUS.REJECTED);
});

test('我的邀请面板：统计与规则文案齐全', () => {
  const inviter = mkUser();
  const invitee = mkUser();
  inviteService.bindOnRegister({ inviteeId: invitee.id, code: inviteService.ensureCode(inviter.id).code, ip: '198.51.100.21' });
  inviteService.markMilestone({ userId: invitee.id });
  const d = inviteService.dashboard(inviter.id);
  assert.ok(d.invite_code);
  assert.equal(d.stats.rewarded >= 1, true);
  assert.equal(d.stats.points_earned >= 1, true);
  assert.ok(d.rules.length >= 3);
  assert.ok(d.items[0].name.includes('*'), '被邀请人昵称需脱敏');
});

// ============================================================
// 续集 / 系列
// ============================================================
function mkProject(userId, title, extra = {}) {
  const id = `proj_s_${Math.random().toString(36).slice(2, 10)}`;
  return db.insert('projects', {
    id,
    user_id: userId,
    title,
    spec: { style_code: 'STY-DUSHI', aspect: '9:16', quality: '1080p', total_minutes: 10, episode_sec: 90, prompt: '被家族抛弃的少年十年后归来' },
    status: 'draft',
    created_at: nowIso(),
    ...extra,
  });
}

function mkCharacters(projectId, names) {
  const tpl = seeds.lockTemplate('character');
  return names.map((name, i) => assetLibrary.create({
    projectId,
    assetType: 'character',
    name,
    locks: tpl.suggested_locks.slice(0, tpl.required_lock_count),
    lockValues: { name },
    imageUrl: i === 0 ? 'https://example.com/a.png' : null,
    meta: { traits: '冷静' },
  }));
}

test('续集：第二季继承规格与角色资产，但不继承画面', () => {
  const u = mkUser();
  const p1 = mkProject(u.id, '逆袭人生');
  mkCharacters(p1.id, ['林澈', '苏晚', '陆沉']);

  const r = seriesService.createSeason({ projectId: p1.id, prompt: '第二季：林澈进入商战' });
  assert.equal(r.season_no, 2);
  assert.equal(r.inherited_assets, 3);
  assert.equal(r.project.series_id, db.findOne('projects', (p) => p.id === p1.id).series_id);
  assert.equal(r.project.spec.style_code, 'STY-DUSHI');
  assert.equal(r.project.spec.continuity_from, p1.id);
  assert.match(r.project.spec.prompt, /第 2 季/);

  const inherited = db.find('assets', (a) => a.project_id === r.project.id);
  assert.equal(inherited.length, 3);
  for (const a of inherited) {
    assert.equal(a.image_url, null, '红线：续集不能继承上一季的画面');
    assert.equal(a.meta.inherited, true);
    assert.equal(a.meta.origin_project_id, p1.id);
  }
  // 原项目资产不受影响
  assert.equal(db.count('assets', (a) => a.project_id === p1.id), 3);
});

test('续集：季号递增到 3，系列视图能汇总三季与共享角色', () => {
  const u = mkUser();
  const p1 = mkProject(u.id, '长安绣娘');
  mkCharacters(p1.id, ['阿绣', '裴行']);
  const s2 = seriesService.createSeason({ projectId: p1.id });
  const s3 = seriesService.createSeason({ projectId: s2.project.id });
  assert.equal(s3.season_no, 3);

  const view = seriesService.seriesOf(p1.id);
  assert.equal(view.seasons.length, 3);
  assert.deepEqual(view.seasons.map((s) => s.season_no), [1, 2, 3]);
  assert.equal(view.shared_assets.length, 2);
  assert.equal(view.shared_assets[0].seasons.length, 3);
});

test('续集：资产血缘可追溯到第一季', () => {
  const u = mkUser();
  const p1 = mkProject(u.id, '末日废墟');
  mkCharacters(p1.id, ['陈默']);
  const s2 = seriesService.createSeason({ projectId: p1.id });
  const lin = seriesService.lineage(s2.project.id);
  assert.equal(lin.length, 1);
  assert.equal(lin[0].inherited, true);
  assert.equal(lin[0].origin_project_id, p1.id);
  assert.equal(lin[0].origin_project_title, '末日废墟');
});

test('项目管理：归档后不出现在默认列表，取消归档可恢复', () => {
  const u = mkUser();
  const p1 = mkProject(u.id, '待归档剧');
  seriesService.setArchived(p1.id, true);
  const after = db.findOne('projects', (p) => p.id === p1.id);
  assert.equal(after.archived, true);
  assert.equal(after.status, 'archived');
  seriesService.setArchived(p1.id, false);
  assert.equal(db.findOne('projects', (p) => p.id === p1.id).archived, false);
});

test('项目管理：不同项目的资产互不串台', () => {
  const u = mkUser();
  const a = mkProject(u.id, '项目A');
  const b = mkProject(u.id, '项目B');
  mkCharacters(a.id, ['甲', '乙']);
  mkCharacters(b.id, ['丙']);
  assert.equal(db.count('assets', (x) => x.project_id === a.id), 2);
  assert.equal(db.count('assets', (x) => x.project_id === b.id), 1);
});
