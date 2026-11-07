/**
 * V4.2 素材库：上传 / 解析 / 摘要 / 清理。
 *
 * 这些用例不碰网络：直接调 MaterialService 与解析器，
 * 验证「文本进 prompt、文件能取回、超限被拒、删掉不留垃圾」四件事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/store/db.js';
import materialService from '../src/assets/MaterialService.js';
import { extractDocxText } from '../src/assets/docx.js';
import { parseMultipart } from '../src/api/multipart.js';
import { resolveMediaPath, mediaMime } from '../src/api/media.js';

let seq = 0;
function mkProject() {
  seq += 1;
  const id = `proj_mat_${seq}_${Date.now()}`;
  db.insert('projects', {
    id, user_id: `u_mat_${seq}`, title: `素材项目${seq}`, spec: { total_minutes: 5 }, created_at: new Date().toISOString(),
  });
  return id;
}

/** 造一个最小合法 ZIP（store 模式），用于验证 docx 抽取 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

test('文本素材：入库、统计、摘要按条截断', () => {
  const pid = mkProject();
  const novel = '第一章 雨夜\n'.repeat(300);
  const a = materialService.addText({ projectId: pid, userId: 'u1', name: '原著小说', text: novel });
  assert.equal(a.kind, 'text');
  assert.ok(a.chars > 1000);
  assert.equal(a.preview.length, 120);
  assert.equal(a.text, undefined, '列表视图不得下发全文');

  const b = materialService.addText({ projectId: pid, userId: 'u1', name: '人物小传', text: '林川：二十六岁，沉默，右手有旧伤。' });
  const d = materialService.digest(pid, { maxChars: 5000, perText: 200 });
  assert.match(d.text, /参考文本 1/);
  assert.match(d.text, /参考文本 2/);
  assert.ok(d.text.includes('林川'));
  assert.ok(d.chars <= 5000);
  assert.equal(d.used.length, 2);
  assert.equal(materialService.stats(pid).by_kind.text, 2);
  assert.ok(b.id);
});

test('空文本被拒；超长文本被拒', () => {
  const pid = mkProject();
  assert.throws(() => materialService.addText({ projectId: pid, name: '空', text: '   ' }), /不能为空/);
  assert.throws(
    () => materialService.addText({ projectId: pid, name: '超长', text: '字'.repeat(1200001) }),
    /最多/,
  );
});

test('图片素材：落盘、URL 可解析、删除时清理文件', async () => {
  const pid = mkProject();
  const buf = Buffer.from('89504e470d0a1a0a-fake-png', 'hex');
  const m = await materialService.addFile({ projectId: pid, filename: '女主.png', mime: 'image/png', buffer: buf, note: '参考造型' });
  assert.equal(m.kind, 'image');
  // 测试环境没有微信凭据 → 落本地 /media，且 provider 必须如实标注 local
  assert.match(m.url, /^\/media\/[a-f0-9]{24}\.png$/);
  assert.equal(m.storage, 'local');
  const file = resolveMediaPath(m.url.replace('/media/', ''));
  assert.ok(file && fs.existsSync(file), '素材文件应真实落盘');
  assert.equal(mediaMime(file), 'image/png');
  assert.equal(m.note, '参考造型');

  await materialService.remove(pid, m.id);
  assert.equal(fs.existsSync(file), false, '删除素材应同时删文件');
  assert.equal(materialService.stats(pid).total, 0);
});

test('读不出正文的 PDF 转为存档，并如实标注原因', async () => {
  const pid = mkProject();
  const m = await materialService.addFile({
    projectId: pid, filename: '投稿.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  assert.equal(m.kind, 'file', '抽不到文字时按存档处理，而不是假装读懂');
  assert.equal(m.has_text, false);
  assert.match(m.note, /已存档/);
  assert.ok(m.url, '存档文件要能从存储取回');
});

test('表格素材：CSV 转成文字读入 prompt', async () => {
  const pid = mkProject();
  const m = await materialService.addFile({
    projectId: pid,
    filename: '人物表.csv',
    mime: 'text/csv',
    buffer: Buffer.from('角色,身份\n林秋,女主\n陈默,男主\n', 'utf8'),
  });
  assert.equal(m.kind, 'text');
  assert.equal(m.has_text, true);
  assert.match(m.preview, /角色/);
});

test('任意格式都不拒收：未知扩展名存档且不报错', async () => {
  const pid = mkProject();
  const m = await materialService.addFile({
    projectId: pid,
    filename: '参考素材.zip',
    mime: 'application/zip',
    buffer: Buffer.from('PK\u0003\u0004 fake zip', 'utf8'),
  });
  assert.equal(m.kind, 'file');
  assert.ok(m.url);
  assert.ok(materialService.stats(pid).by_kind.file >= 1, '统计里要能看出「存档」数量');
});

test('云存储直传登记：拒绝跨环境 fileID 与文本类', async () => {
  const pid = mkProject();
  await assert.rejects(
    () => materialService.addCloudFile({ projectId: pid, fileId: 'https://evil.example.com/x.png', filename: 'x.png', mime: 'image/png' }),
    /不合法/,
  );
});

test('docx：零依赖抽取正文并转成文本素材', async () => {
  const xml = '<?xml version="1.0"?><w:document><w:body>'
    + '<w:p><w:r><w:t>第一场 雨夜</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>林川推开门，雨水顺着伞骨落下。</w:t></w:r><w:r><w:tab/><w:t>他没有说话。</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const zip = makeZip({ 'word/document.xml': xml });
  const text = extractDocxText(zip);
  assert.match(text, /第一场 雨夜/);
  assert.match(text, /林川推开门/);
  assert.match(text, /\t他没有说话/);

  const pid = mkProject();
  const m = await materialService.addFile({ projectId: pid, filename: '原著.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: zip });
  assert.equal(m.kind, 'text');
  assert.equal(m.source, 'docx');
  assert.match(m.preview, /林川推开门/);
});

test('multipart 解析：字段 + 文件 + 中文文件名', () => {
  const boundary = '----wjdtest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n参考封面\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="封面.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`);
  assert.equal(parsed.fields.note, '参考封面');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, '封面.png');
  assert.equal(parsed.files[0].mime, 'image/png');
  assert.deepEqual([...parsed.files[0].data], [0x89, 0x50, 0x4e, 0x47]);
  assert.throws(() => parseMultipart(body, 'multipart/form-data'), /boundary/);
});

test('media 路径白名单：拒绝目录穿越与任意文件名', () => {
  assert.equal(resolveMediaPath('../server/.env.local'), null);
  assert.equal(resolveMediaPath('a'.repeat(24) + '.png/../x'), null);
  assert.equal(resolveMediaPath('nothex.png'), null);
  assert.ok(resolveMediaPath('a'.repeat(24) + '.mp4'));
});
