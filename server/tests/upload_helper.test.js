/** 阶段 H：PC/H5 上传助手 —— 只做预填与提醒，绝不自动投稿 */
import test from 'node:test';
import assert from 'node:assert/strict';
import uploadHelper, { BUNDLE_SCHEMA } from '../src/distribution/UploadHelper.js';
import distributionHub from '../src/distribution/DistributionHub.js';
import { db } from '../src/store/db.js';
import { ERR } from '../src/core/errors.js';
import { newId, nowIso } from '../src/core/util.js';

const U = 'u_upload_' + Date.now();
const P = 'upload_proj_' + Date.now();

function setup(platformCode = 'PLT-HONGGUO') {
  const project = db.insert('projects', {
    id: newId('proj'),
    user_id: U,
    title: '测试漫剧·夜雨',
    spec: {
      style_code: 'STY-DUSHI', total_minutes: 10, episode_sec: 90,
      aspect: '9:16', quality: '1080p', preset: 'balanced',
      prompt: '失忆的侦探在雨夜找回自己的身份',
    },
    status: 'draft',
    created_at: nowIso(),
  });
  const dist = distributionHub.create({
    projectId: project.id, episodeNo: 'E01', platformCode, userId: U,
  });
  return { project, dist };
}
function rejects(code, fn) {
  assert.throws(fn, (e) => e.code === code, `期望错误码 ${code}`);
}
const keys = (fields) => fields.map((f) => f.key);

test('prepare：字段齐备、AI 标识、平台入口、no_auto_submit 恒为 true', () => {
  const { dist } = setup();
  const p = uploadHelper.prepare(dist.id);
  assert.equal(p.distribution_id, dist.id);
  assert.equal(p.platform.code, 'PLT-HONGGUO');
  assert.ok(keys(p.fields).includes('drama_title'));
  assert.ok(keys(p.fields).includes('drama_synopsis'));
  assert.ok(keys(p.fields).includes('ai_declaration'));
  assert.ok(keys(p.fields).includes('ai_evidence'));
  assert.ok(keys(p.fields).includes('copyright_chain'));
  assert.equal(p.fields.find((f) => f.key === 'drama_title').value, '测试漫剧·夜雨');
  assert.equal(p.no_auto_submit, true);
  assert.equal(p.policy.auto_submit, false);
  assert.equal(p.policy.submit_actor, 'user_manual');
  assert.equal(p.links.in_app_embeddable, false);
  assert.match(p.links.upload_url, /^https:\/\//);
  assert.ok(p.checklist.some((c) => c.required && c.key === 'video_1080p'));
  assert.ok(p.checklist.every((c) => c.ready === false), '服务端不代用户确认材料');
  assert.ok(p.warnings.some((w) => w.includes('身份')));
  assert.ok(p.copy_text.includes('测试漫剧·夜雨'));
  assert.ok(p.copy_text.includes('上传前材料清单'));
  assert.ok(p.delivery_gate && typeof p.delivery_gate === 'object');
});

test('prepare：简介带集数/时长与 AI 辅助声明，且长度受限', () => {
  const { dist } = setup();
  const p = uploadHelper.prepare(dist.id);
  const s = p.fields.find((f) => f.key === 'drama_synopsis').value;
  assert.match(s, /人工智能辅助生成/);
  assert.match(s, /7 集/);
  assert.ok(s.length <= 200);
});

test('prepare：不存在的分发任务报 UPLOAD_DIST_NOT_FOUND', () => {
  rejects(ERR.UPLOAD_DIST_NOT_FOUND, () => uploadHelper.prepare('dist_not_exist'));
});

test('exportBundle：schema / bundle_id / no_auto_submit，并留下导出记录', () => {
  const { dist } = setup();
  const b = uploadHelper.exportBundle(dist.id);
  assert.equal(b.schema, BUNDLE_SCHEMA);
  assert.ok(b.bundle_id);
  assert.equal(b.no_auto_submit, true);
  assert.ok(Array.isArray(b.fields) && b.fields.length > 0);
  assert.equal(uploadHelper.bundles(dist.id).length, 1);
  assert.equal(uploadHelper.bundles(dist.id)[0].no_auto_submit, true);
});

test('importBundle：合法包可导入，且明确未提交平台', () => {
  const { dist } = setup();
  const b = uploadHelper.exportBundle(dist.id);
  const r = uploadHelper.importBundle(b);
  assert.equal(r.ok, true);
  assert.equal(r.no_auto_submit, true);
  assert.equal(r.field_count, b.fields.length);
  assert.match(r.note, /未向任何平台提交/);
});

test('importBundle 红线：schema 错 / 缺 fields / 缺 no_auto_submit 一律拒绝', () => {
  const { dist } = setup();
  const b = uploadHelper.exportBundle(dist.id);
  rejects(ERR.UPLOAD_BUNDLE_INVALID, () => uploadHelper.importBundle({ ...b, schema: 'bad/1' }));
  rejects(ERR.UPLOAD_BUNDLE_INVALID, () => uploadHelper.importBundle({ ...b, fields: [] }));
  rejects(ERR.UPLOAD_BUNDLE_INVALID, () => uploadHelper.importBundle({ ...b, fields: [{ key: 'x' }] }));
  rejects(ERR.UPLOAD_NO_AUTO_SUBMIT, () => uploadHelper.importBundle({ ...b, no_auto_submit: false }));
});

test('markUploaded：状态回写 + 留证，提交方恒为 user_manual', () => {
  const { dist } = setup();
  const r = uploadHelper.markUploaded(dist.id, { status: '审核中', note: '已在平台上传' });
  assert.equal(r.no_auto_submit, true);
  assert.equal(r.submission.submitted_by, 'user_manual');
  assert.equal(r.submission.auto_submitted, false);
  assert.equal(r.submission.status, '审核中');
  assert.equal(r.distribution.status, '审核中');
  assert.equal(uploadHelper.submissions(dist.id).length, 1);
});

test('markUploaded 红线：平台不支持的状态被拒', () => {
  const { dist } = setup();
  rejects(ERR.UPLOAD_STATUS_INVALID, () => uploadHelper.markUploaded(dist.id, { status: '草稿' }));
  // 被拒后不应产生任何提交记录
  assert.equal(uploadHelper.submissions(dist.id).length, 0);
});

test('prepare 红线：返回中不含任何自动投稿开关或平台凭据', () => {
  const { dist } = setup();
  const s = JSON.stringify(uploadHelper.prepare(dist.id));
  assert.ok(!/"auto_submit":true/.test(s), '不得出现自动投稿被开启的字段');
  assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(s));
  assert.ok(!s.includes('RELAY_API_KEY'));
});
