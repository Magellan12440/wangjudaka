/**
 * V4.18 电脑端上传指引。
 *
 * 用户原话：「由于红果，抖音签约上传必须在电脑端完成，小程序需要提供足够多的便利和指引。」
 *
 * 锁死四件事：
 *  1. 手机上先说实话：红果/抖音标 desktop_only，不能让人点进去才发现只能电脑端；
 *  2. 步骤要细到「在哪个页面做什么」，不是一句"请到电脑端操作"；
 *  3. 能复制的东西都给出可复制的值（入口 / 成片 / 材料包 / 剧目信息粘贴包）；
 *  4. 永不代提交：`no_auto_submit` 恒 true。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import seeds from '../src/seeds/loader.js';
import { guideFor, buildPasteText, overview, desktopOnlyOf } from '../src/distribution/DesktopUploadGuide.js';

const plat = (code) => seeds.platform(code);

test('红果：标成只能在电脑端，且步骤细到「在哪一页做什么」', () => {
  const g = guideFor(plat('PLT-HONGGUO'), { title: '长夜' });
  assert.equal(g.desktop_only, true);
  assert.equal(g.client_kind, 'desktop_only');
  assert.equal(g.client_kind_text, '只能在电脑端');
  assert.ok(g.why.includes('电脑端'), '要说清为什么只能电脑端');
  assert.ok(g.steps.length >= 5, '步骤不能只给一两句');
  for (const s of g.steps) {
    assert.ok(s.title, '每步都要有标题');
    assert.ok(s.where, `第 ${s.no} 步要指明在哪个页面做`);
    assert.equal(s.done, false, '服务端不替用户勾进度');
  }
  // 签约必须是独立步骤，不能被并进"上传"里
  assert.ok(g.steps.some((s) => s.title.includes('签约') || s.detail.includes('签')));
});

test('抖音：手机能发普通视频，但签约挂载必须电脑端 —— 不能因此标成手机可传', () => {
  const g = guideFor(plat('PLT-DOUYIN'), {});
  assert.equal(g.desktop_only, true);
  assert.ok(g.why.includes('签约'), '要说清"签约在电脑端"这件事');
  assert.ok(g.steps.some((s) => s.title.includes('资质') || s.title.includes('挂载') || s.title.includes('剧集')));
});

test('小红书：手机能传的就不硬说成只能电脑端', () => {
  const g = guideFor(plat('PLT-XIAOHONGSHU'), {});
  assert.equal(g.desktop_only, false);
  assert.equal(g.client_kind_text, '电脑端为主');
  assert.ok(g.steps.length >= 3);
});

test('复制清单：入口永远可复制，成片/材料包没准备好要说清下一步', () => {
  const g = guideFor(plat('PLT-HONGGUO'), { title: '长夜' });
  const byKey = Object.fromEntries(g.handoff.map((h) => [h.key, h]));

  assert.equal(byKey.entry.copyable, true);
  assert.ok(byKey.entry.value.startsWith('https://'), '入口要是真网址');

  assert.equal(byKey.film.copyable, false, '没成片就不能假装能复制');
  assert.ok(byKey.film.hint.includes('我的剧'), '要告诉用户去哪出片');

  assert.equal(byKey.pack.copyable, false);
  assert.ok(byKey.pack.hint.includes('打包'), '要指到「打包审核材料」');

  assert.equal(byKey.paste.copyable, true, '粘贴包任何时候都能复制');

  const ready = guideFor(plat('PLT-HONGGUO'), {
    title: '长夜', filmUrl: 'https://cdn.example.com/e01.mp4', packUrl: 'https://cdn.example.com/pack.zip',
  });
  const r2 = Object.fromEntries(ready.handoff.map((h) => [h.key, h]));
  assert.equal(r2.film.copyable, true);
  assert.equal(r2.pack.copyable, true);
  assert.ok(r2.pack.value.endsWith('.zip'));
});

test('剧目信息粘贴包：一次粘到电脑端表单，字段齐全且带来源声明', () => {
  const text = buildPasteText(plat('PLT-DOUYIN'), {
    title: '长夜', episodes: 8, episodeSec: 90, aspect: '9:16',
    synopsis: '一个雨夜，三个人各自说谎', aiLabel: '本作品由人工智能生成',
    filmUrl: 'https://cdn.example.com/e01.mp4',
  });
  for (const kw of ['长夜', '8 集', '90 秒', '9:16', '人工智能生成', 'e01.mp4', 'creator.douyin.com']) {
    assert.ok(text.includes(kw), `粘贴包要含 ${kw}`);
  }
  assert.ok(text.includes('复核'), '要提示提交前复核，不能当成最终文案');
});

test('永不代提交：no_auto_submit 恒 true，且说明谁在提交', () => {
  for (const code of ['PLT-HONGGUO', 'PLT-DOUYIN', 'PLT-BILIBILI']) {
    const g = guideFor(plat(code), {});
    assert.equal(g.no_auto_submit, true);
    assert.equal(g.policy.auto_submit, false);
    assert.equal(g.policy.submit_actor, 'user_manual');
  }
});

test('平台一览：8 个平台都有角标口径，且红果一定是电脑端', () => {
  const list = overview();
  assert.equal(list.length, seeds.distributionPlatforms.length);
  for (const p of list) {
    assert.ok(['desktop_only', 'desktop_preferred'].includes(p.client_kind));
    assert.equal(p.desktop_only, p.client_kind === 'desktop_only');
    assert.ok(p.client_kind_text);
  }
  assert.equal(list.find((p) => p.code === 'PLT-HONGGUO').desktop_only, true);
  assert.equal(desktopOnlyOf(plat('PLT-HONGGUO')), true);
});

test('未知平台不硬编：缺平台返回 null，别抛一半', () => {
  assert.equal(guideFor(null, {}), null);
});

test('指引里不夹带密钥或上游信息', () => {
  const g = guideFor(plat('PLT-HONGGUO'), { title: '长夜' });
  const raw = JSON.stringify(g);
  assert.ok(!raw.includes('sk-'), '不能出现密钥字样');
  assert.ok(!/upstream_id|api[_ ]?key/i.test(raw), '不能泄漏上游字段');
});
