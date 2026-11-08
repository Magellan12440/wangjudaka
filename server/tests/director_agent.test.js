/**
 * V4.11 虚拟导演：链式闸门 + 四库强制 + 用户手动引用。
 *
 * 测的不是"算法好不好看"，而是三条承诺：
 *  1. 默认状态下四库都解析得出真实卡号（强制 ≠ 必须手动选）
 *  2. 用户 pin 的卡真的落到总谱上，并且不撞坏结构硬规则
 *  3. 选了不存在的卡必须报错，不能静默退回自动（否则用户以为生效了）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store/db.js';
import directorAgent, { CORE_LIBS, CHAIN } from '../src/director/DirectorAgent.js';
import storyEngine from '../src/pipeline/StoryEngine.js';
import { ERR } from '../src/core/errors.js';

const P = `proj_dir_${Date.now()}`;

function outline() {
  return {
    title: '长夜将尽',
    logline: '被顶替身份的拳手回来讨债',
    characters: [
      { code: 'CH01', name: '林默', role: 'protagonist', traits: '瘦削、短黑发、松绿夹克' },
      { code: 'CH02', name: '程野', role: 'antagonist', traits: '高壮、寸头、黑皮衣' },
    ],
    locations: [{ name: '审讯室', desc: '单盏台灯、玻璃桌' }],
    props: [{ code: 'PR01', name: '银色打火机', desc: '磨砂银壳' }],
    episodes: [
      {
        no: 1, duration_sec: 90, goal: '讨债', ending_hook: '他撕了欠条',
        hook: { code: 'HOOK-01', micro_hook: true, shots: 2 },
        conflicts: [{ code: 'CFL-01', escalation: 2 }, { code: 'CFL-02', escalation: 3 }],
        reversals: [{ code: 'REV-01', foreshadow: 2 }],
        empathy: [{ code: 'EMP-02' }],
      },
      {
        no: 2, duration_sec: 90, goal: '反制', ending_hook: '警笛响起',
        hook: { code: 'HOOK-02', micro_hook: true },
        conflicts: [{ code: 'CFL-01', escalation: 2 }, { code: 'CFL-03', escalation: 4 }],
        reversals: [{ code: 'REV-01', foreshadow: 2 }, { code: 'REV-05', foreshadow: 2 }],
        empathy: [{ code: 'EMP-01' }],
      },
    ],
  };
}

const SPEC = { style_code: 'STY-DUSHI', director_code: 'DIR-BALANCED', aspect: '9:16', quality: '1080p', total_minutes: 3, episode_sec: 90 };

function mkProject() {
  const id = `${P}_${Math.random().toString(36).slice(2, 6)}`;
  db.insert('projects', {
    id, user_id: 'u_dir', title: '长夜将尽', spec: SPEC,
    created_at: new Date().toISOString(),
  });
  return id;
}

test('链式节点齐全，且情绪/转场/运镜/节奏四库被声明为强制', () => {
  const keys = CHAIN.map((c) => c.key);
  for (const k of ['outline', 'plan', 'script', 'rhythm', 'assets', 'storyboard', 'shots', 'edit', 'delivery']) {
    assert.ok(keys.includes(k), `链路缺少节点 ${k}`);
  }
  const planNode = CHAIN.find((c) => c.key === 'plan');
  for (const lib of CORE_LIBS) assert.ok(planNode.libs.includes(lib), `总谱节点必须带 ${lib}`);
  assert.deepEqual(CORE_LIBS.sort(), ['emotion', 'movement', 'rhythm', 'transition'].sort());
});

test('默认策略：四库都是 auto，但每个节点都能解析出真实卡号（强制不等于必须手选）', () => {
  const pid = mkProject();
  const policy = directorAgent.policyOf(pid);
  assert.equal(policy.mode, 'enforce');
  for (const lib of CORE_LIBS) assert.equal(policy.libs[lib].mode, 'auto');

  const r = directorAgent.assertStage(pid, 'plan');
  for (const lib of CORE_LIBS) {
    assert.ok(r.libs[lib]?.code, `${lib} 必须解析出卡号`);
    assert.equal(r.libs[lib].source, 'auto');
  }
  assert.equal(r.missing.length, 0);
});

test('手动引用：pin 真实卡后，编译覆盖与总谱都跟着变', () => {
  const pid = mkProject();
  const save = directorAgent.setPolicy(pid, {
    libs: { movement: { mode: 'pinned', code: 'SHT-HAND' }, transition: { mode: 'pinned', code: 'TRN-DISSOLVE-W' } },
  });
  assert.equal(save.libs.movement.code, 'SHT-HAND');
  assert.equal(directorAgent.libraryOverrides(pid).movement, 'SHT-HAND');

  const plan = storyEngine.directorPlan({ outline: outline(), spec: SPEC, projectId: pid });
  const beats = plan.episodes.flatMap((e) => e.beats);
  // 没有语法配方的拍，运镜统一成用户点的那张
  const plain = beats.filter((b) => !b.grammar?.recipe);
  assert.ok(plain.length > 0);
  for (const b of plain) assert.equal(b.camera_move, 'SHT-HAND');

  // 转场只替换原本已是非硬切的拍，硬切拍一张都不许动（否则配额与节奏会崩）
  const hard = beats.filter((b) => b.transition === 'TRN-HARDCUT' || b.transition === 'TRN-FREEZE');
  assert.ok(hard.length > 0, '集末定格/硬切必须还存在');
  const nonHard = beats.filter((b) => b.transition === 'TRN-DISSOLVE-W');
  assert.ok(nonHard.length > 0, '原本的非硬切应被换成用户指定的转场');
  assert.equal(plan.global.director_policy.pinned.movement, 'SHT-HAND');
  assert.ok(plan.global.director_policy.applied.movement > 0);
});

test('手动引用节奏：只落在「推进」拍，不动开场钩子与反转/共情结构位', () => {
  const pid = mkProject();
  const conflict = 'CFL-01';
  directorAgent.setPolicy(pid, { libs: { rhythm: { mode: 'pinned', code: conflict } } });
  const plan = storyEngine.directorPlan({ outline: outline(), spec: SPEC, projectId: pid });
  const beats = plan.episodes.flatMap((e) => e.beats);
  // 开场（黄金三秒）与集末钩子是结构位，不能被一张冲突卡顶掉
  assert.notEqual(beats[0].rhythm_code, conflict);
  assert.equal(beats[0].beat_purpose, '黄金三秒开场');
  for (const ep of plan.episodes) {
    const last = ep.beats[ep.beats.length - 1];
    assert.notEqual(last.rhythm_code, conflict);
    assert.equal(last.beat_purpose, '集末钩子');
  }
  // 而推进/冲突升级段必须统一成用户点的那张（结构位与反转/共情除外）
  const structuralPurpose = new Set(['黄金三秒开场', '集末钩子', '反转落点', '共情高点']);
  const pushed = beats.filter((b) => !structuralPurpose.has(b.beat_purpose));
  assert.ok(pushed.length > 0);
  for (const b of pushed) assert.equal(b.rhythm_code, conflict);
});

test('选了不存在的卡直接报错，不静默退回自动', () => {
  const pid = mkProject();
  assert.throws(
    () => directorAgent.setPolicy(pid, { libs: { movement: { mode: 'pinned', code: 'SHT-NOT-EXIST' } } }),
    (e) => e.code === ERR.MISSING_DIRECTOR_CARD,
  );
  // 维度不对也算不存在：运镜位塞一张景别卡
  assert.throws(
    () => directorAgent.setPolicy(pid, { libs: { movement: { mode: 'pinned', code: 'SHT-CU' } } }),
    (e) => e.code === ERR.MISSING_DIRECTOR_CARD,
  );
});

test('决策日志可查：改策略与落总谱都留痕', () => {
  const pid = mkProject();
  directorAgent.setPolicy(pid, { libs: { emotion: { mode: 'pinned', code: 'EMO-CALM-02' } } });
  storyEngine.directorPlan({ outline: outline(), spec: SPEC, projectId: pid });
  const trail = directorAgent.trail(pid, 10);
  assert.ok(trail.length >= 2);
  assert.ok(trail.some((x) => x.action === 'set_policy'));
  assert.ok(trail.some((x) => x.action === 'apply_policy'));
});

test('恢复自动：pin 全部清掉，但强制仍然生效', () => {
  const pid = mkProject();
  directorAgent.setPolicy(pid, { libs: { movement: { mode: 'pinned', code: 'SHT-HAND' } } });
  assert.equal(directorAgent.policyOf(pid).libs.movement.mode, 'pinned');
  directorAgent.resetPolicy(pid);
  const after = directorAgent.policyOf(pid);
  assert.equal(after.libs.movement.mode, 'auto');
  assert.equal(after.mode, 'enforce');
  assert.equal(directorAgent.assertStage(pid, 'shots').missing.length, 0);
});

test('面板总览：链状态、四库可选项、下一步都对得上', () => {
  const pid = mkProject();
  const ov = directorAgent.overview(pid);
  assert.equal(ov.core_libs.length, 4);
  assert.equal(ov.chain.length, CHAIN.length);
  for (const lib of ov.core_libs) {
    assert.ok(lib.options.length > 0, `${lib.kind} 应该能列出可选项`);
    assert.ok(lib.effective, `${lib.kind} 应该有生效卡`);
  }
  // 新项目什么都没做，链上应该指出下一步
  assert.ok(ov.next);
  assert.equal(ov.chain.find((c) => c.key === 'outline').done, false);
});
