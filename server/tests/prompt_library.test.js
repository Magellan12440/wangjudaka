/**
 * 九大提示词库（V4.4）：库必须齐全，且必须真正进入生成请求。
 *
 * 这些用例守住三件事：
 *  1. 九个库都有内容（缺一个就该发版失败，而不是让模型自由发挥）；
 *  2. 编译器把库内容写进提示词，并在产物上留下可审计的指纹；
 *  3. RelayAdapter 的最后一道闸门会拦住「没有库内容」的请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as lib from '../src/prompts/PromptLibrary.js';
import { PromptCompiler } from '../src/compiler/PromptCompiler.js';
import { buildSubtitles } from '../src/media/Subtitle.js';
import seeds from '../src/seeds/loader.js';

const REQUIRED = ['emotion', 'transition', 'movement', 'lighting', 'rhythm', 'bgm', 'fx', 'edit', 'sync'];

test('九大提示词库全部就位，且每个库都有可用条目', () => {
  const sum = lib.summary();
  const kinds = sum.map((s) => s.kind).sort();
  assert.deepEqual(kinds, [...REQUIRED].sort());
  for (const s of sum) {
    assert.ok(s.count > 0, `${s.name} 为空`);
    assert.equal(s.usable, true, `${s.name} 不可用`);
  }
});

test('每个库的条目结构完整：code + 名称 + 中文提示', () => {
  for (const kind of REQUIRED) {
    const items = lib.listKind(kind);
    assert.ok(items.length > 0, kind);
    for (const it of items.slice(0, 3)) {
      assert.ok(it.code, `${kind} 条目缺 code`);
      assert.ok(String(it.name || '').length > 0, `${kind}/${it.code} 缺名称`);
      assert.ok(String(it.text || '').length > 0, `${kind}/${it.code} 缺提示词`);
    }
  }
});

test('环节要求：剧本只要情绪+节奏，分镜要四库，剪辑要配方+同步', () => {
  assert.deepEqual(lib.STAGE_REQUIREMENTS.script, ['emotion', 'rhythm']);
  assert.deepEqual(lib.STAGE_REQUIREMENTS.storyboard, ['movement', 'lighting', 'transition', 'fx']);
  assert.deepEqual(lib.STAGE_REQUIREMENTS.edit, ['edit', 'sync', 'transition', 'bgm']);
});

test('compose：不传 code 时自动取默认，不会出现「空库」', () => {
  const r = lib.compose('storyboard');
  assert.equal(r.missing.length, 0);
  assert.equal(r.blocks.length, 4);
  for (const b of r.blocks) {
    assert.ok(b.code, `${b.kind} 无默认 code`);
    assert.ok(String(b.text).length > 0, `${b.kind} 默认条目没提示词`);
  }
});

test('compose：显式指定 code 时按指定来', () => {
  const r = lib.compose('storyboard', { fx: 'FX-RAIN', transition: 'TRN-WATERWIPE' });
  assert.equal(r.blocks.find((b) => b.kind === 'fx').code, 'FX-RAIN');
  assert.equal(r.blocks.find((b) => b.kind === 'transition').code, 'TRN-WATERWIPE');
});

test('闸门：没有 prompt_libraries 的请求一律拒绝', () => {
  assert.throws(() => lib.assertCompiled({}), /提示词库/);
  assert.throws(() => lib.assertCompiled(null), /提示词库/);
});

test('闸门：环节缺库也会被拦下（防止有人绕过 compose）', () => {
  const fake = {
    prompt_libraries: {
      stage: 'edit',
      blocks: [{ kind: 'edit', code: 'EDR-SHORTDRAMA', text: 'x' }],
      missing: [],
    },
  };
  assert.throws(() => lib.assertCompiled(fake), /缺少必需库/);
});

test('编译器：剧本请求真的把库写进 system，且留了指纹', () => {
  const c = new PromptCompiler();
  const p = c.compile({
    kind: 'chat',
    model: 'AUTO-DEEPSEEK-V4_1-FLASH',
    available_credits: 100,
    system: '你是编剧',
    user: '写一句开场',
  });
  assert.equal(p.prompt_libraries.stage, 'script');
  assert.ok(p.prompt_libraries.digest, '缺库指纹');
  const sys = p.messages.map((m) => m.content).join('\n');
  assert.ok(sys.includes('创作必须遵守以下内置提示词库'), '库约束没进 system');
  assert.ok(sys.includes('情绪提示词库'), '缺情绪库');
  assert.ok(sys.includes('节奏提示词库'), '缺节奏库');
});

test('编译器：指定 stage=character 会换成情绪+光影', () => {
  const c = new PromptCompiler();
  const p = c.compile({
    kind: 'chat',
    stage: 'character',
    model: 'AUTO-DEEPSEEK-V4_1-FLASH',
    available_credits: 100,
    messages: [{ role: 'user', content: '描述主角外形' }],
  });
  assert.equal(p.prompt_libraries.stage, 'character');
  const kinds = p.prompt_libraries.blocks.map((b) => b.kind).sort();
  assert.deepEqual(kinds, ['emotion', 'lighting']);
});

test('字幕同步库真的改变排法：短句库比标准库字更少', () => {
  const segments = [{
    shot_no: 'E01-S001', start: 0, end: 6, duration: 6,
    dialogue: [{ speaker: 'CH01', line: '你以为我不知道你早就把股权转给了你弟弟这件事吗' }],
  }];
  const short = buildSubtitles({ segments, aspect: '9:16', rule: seeds.subtitleSyncRule('SYN-SHORT') });
  const narr = buildSubtitles({ segments, aspect: '9:16', rule: seeds.subtitleSyncRule('SYN-NARR') });
  assert.ok(short.stats.max_chars_per_line <= 13);
  assert.ok(narr.stats.max_chars_per_line > short.stats.max_chars_per_line);
  assert.equal(short.stats.sync_code, 'SYN-SHORT');
  const maxCueChars = (r) => Math.max(...r.cues.map((c) => c.text.length));
  assert.ok(maxCueChars(short) <= 13, `短句库单条应≤13字，实际 ${maxCueChars(short)}`);
  assert.ok(maxCueChars(narr) > maxCueChars(short), '叙述库允许更长的单条');
  assert.ok(short.cues.length >= narr.cues.length, '短句库条数不少于叙述库');
});

test('剪辑配方库字段完整：钩子秒数/平均镜长/字幕风格', () => {
  for (const r of seeds.editRecipes) {
    assert.ok(Number(r.hook_sec) > 0, `${r.code} 缺 hook_sec`);
    assert.ok(Number(r.avg_cut_sec) > 0, `${r.code} 缺 avg_cut_sec`);
    assert.ok(String(r.prompt_zh || '').length > 10, `${r.code} 缺剪辑指导`);
  }
});
