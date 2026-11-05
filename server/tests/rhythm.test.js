import { test } from 'node:test';
import assert from 'node:assert/strict';
import rhythmMaster from '../src/rhythm/RhythmMaster.js';
import { ERR } from '../src/core/errors.js';

function goodScript(episodes = 6) {
  const eps = [];
  for (let i = 1; i <= episodes; i++) {
    eps.push({
      no: i,
      hook: { code: i === 1 ? 'HOOK-01' : 'HOOK-05', micro_hook: true, shots: 3 },
      conflicts: [
        { code: 'CFL-01', escalation: 1 },
        { code: 'CFL-02', escalation: 2 },
        { code: 'CFL-07', escalation: 4 },
      ],
      reversals: i === 2 ? [{ code: 'REV-01', foreshadow: 2 }] : i === 3 ? [{ code: 'REV-02', foreshadow: 2 }] : i === 5 ? [{ code: 'REV-09', foreshadow: 3 }] : [],
      empathy: i % 3 === 0 ? [{ code: 'EMP-02' }] : [],
      ending_hook: '悬念未解',
    });
  }
  return { episodes: eps };
}

test('合格剧本通过全部闸门', () => {
  const r = rhythmMaster.diagnose(goodScript());
  assert.equal(r.passed, true, JSON.stringify(r.gates));
  assert.equal(r.advice.length, 0);
});

test('缺黄金三秒 → hook_score 不达标', () => {
  const s = goodScript();
  s.episodes[0].hook = {};
  const r = rhythmMaster.diagnose(s);
  assert.equal(r.passed, false);
  assert.ok(r.advice.some((a) => a.target === 'episode_1_opening'));
});

test('冲突密度不足 → 给出补冲突建议', () => {
  const s = goodScript();
  s.episodes.forEach((e) => (e.conflicts = [{ code: 'CFL-01', escalation: 1 }]));
  const r = rhythmMaster.diagnose(s);
  assert.equal(r.passed, false);
  assert.ok(r.advice.some((a) => a.target === 'all_episodes'));
});

test('同集内冲突未升级会被点名', () => {
  const s = goodScript();
  s.episodes[0].conflicts = [{ code: 'CFL-07', escalation: 4 }, { code: 'CFL-01', escalation: 1 }];
  const r = rhythmMaster.diagnose(s);
  assert.ok(r.details.conflict_issues.some((i) => i.issue.includes('未升级')));
});

test('第 2 集无反转锚点 → 硬失败', () => {
  const s = goodScript();
  s.episodes[1].reversals = [];
  const r = rhythmMaster.diagnose(s);
  assert.equal(r.passed, false);
  assert.ok(r.advice.some((a) => a.target === 'episode_2'));
});

test('共情不足 → medium 级建议', () => {
  const s = goodScript();
  s.episodes.forEach((e) => (e.empathy = []));
  const r = rhythmMaster.diagnose(s);
  assert.ok(r.advice.some((a) => a.target === 'episodes' && a.severity === 'medium'));
});

test('伏笔不足的反转被标记', () => {
  const s = goodScript();
  s.episodes[2].reversals = [{ code: 'REV-02', foreshadow: 1 }];
  const r = rhythmMaster.diagnose(s);
  assert.ok(r.details.thin_foreshadow.length >= 1);
});

test('闸门抛出带 report 的错误，供流水线回退重写', () => {
  const s = goodScript();
  s.episodes.forEach((e) => (e.conflicts = []));
  try {
    rhythmMaster.gate(s);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, ERR.RHYTHM_CONFLICT_SPARSE);
    assert.ok(e.report?.advice?.length > 0);
  }
});

test('90 秒节奏曲线切成五段且首尾闭合', () => {
  const c = rhythmMaster.curve(90);
  assert.equal(c.length, 5);
  assert.equal(c[0].start, 0);
  assert.equal(Math.round(c[4].end), 90);
});
