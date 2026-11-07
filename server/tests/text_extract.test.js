import { test } from 'node:test';
import assert from 'node:assert/strict';
import materialService from '../src/assets/MaterialService.js';

const B = (s) => Buffer.from(s, 'utf8');

test('txt 直接读成正文，字数按非空白算', () => {
  const r = materialService.extractText({
    filename: '第一集.txt',
    mime: 'text/plain',
    buffer: B('长夜执灯人\n\n第一场 雪夜。\n沈砚提灯走过长街。'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.name, '第一集.txt');
  assert.ok(r.text.includes('沈砚'));
  assert.equal(r.total_chars, r.text.replace(/\s/g, '').length);
});

test('csv 表格转成可读文字', () => {
  const r = materialService.extractText({
    filename: '人物表.csv',
    mime: 'text/csv',
    buffer: B('角色,身份\n沈砚,提灯人\n苏晚,捕快'),
  });
  assert.equal(r.ok, true);
  assert.ok(/沈砚/.test(r.text) && /捕快/.test(r.text), r.text);
});

test('超长正文按 maxChars 截断，并如实告知原文更长', () => {
  const long = '字'.repeat(5000);
  const r = materialService.extractText({ filename: 'a.txt', mime: 'text/plain', buffer: B(long), maxChars: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.text.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.total_chars, 5000);
});

test('图片等读不出正文的格式不报错，给出可操作的原因', () => {
  const r = materialService.extractText({
    filename: '封面.png', mime: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'image');
  assert.match(r.reason, /粘贴|txt/);
});

test('空文件被拒绝（而不是返回空正文让用户以为读到了）', () => {
  assert.throws(
    () => materialService.extractText({ filename: 'empty.txt', mime: 'text/plain', buffer: Buffer.alloc(0) }),
    /为空/,
  );
});
