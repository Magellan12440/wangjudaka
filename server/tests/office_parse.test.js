/**
 * 素材正文抽取（V4.9）：表格 / 幻灯片 / CSV 的零依赖解析。
 * 这里现造最小的 xlsx / pptx（ZIP 存储模式，不压缩），确保解析走的是真实路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  csvToText, extractXlsxText, extractPptxText, extractPdfText, zipEntries,
} from '../src/assets/office.js';

/** 造一个最小 ZIP（全部使用 deflate，和真实 Office 文件一致） */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, eocd]);
}

test('CSV 带引号与逗号也能正确拆列', () => {
  const text = '标题,人物,备注\n"第1集, 开场",林秋,"她说 ""走"" 了"\n第2集,陈默,\n';
  const out = csvToText(text);
  assert.match(out, /表头：标题 \| 人物 \| 备注/);
  assert.match(out, /第1集, 开场 \| 林秋 \| 她说 "走" 了/);
  assert.match(out, /2\. 第2集 \| 陈默 \|/);
});

test('CSV 超出上限时如实标注行数', () => {
  const lines = ['甲,乙', ...Array.from({ length: 30 }, (_, i) => `${i},值${i}`)];
  const out = csvToText(lines.join('\n'), { maxRows: 10 });
  assert.match(out, /仅取前 10 行，共 31 行/);
});

test('xlsx：读 sharedStrings + 每张 sheet，输出表头与行', () => {
  const buf = makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="人物表" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>角色</t></si><si><t>身份</t></si><si><t>林秋</t></si><si><t>女主</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>'
      + '</sheetData></worksheet>',
  });
  assert.ok(zipEntries(buf).size >= 4, 'ZIP 目录应可读');
  const out = extractXlsxText(buf);
  assert.match(out, /【人物表】表头：角色 \| 身份/);
  assert.match(out, /1\. 林秋 \| 女主/);
});

test('pptx：按页序抽取文本', () => {
  const buf = makeZip({
    'ppt/slides/slide2.xml': '<p:sld><a:t>第二页内容</a:t></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:t>第一页标题</a:t><a:t>副标题</a:t></p:sld>',
  });
  const out = extractPptxText(buf);
  assert.equal(out, '【第 1 页】第一页标题 / 副标题\n【第 2 页】第二页内容');
});

test('非 Office 文件不会抛错，返回空串交给「仅存档」分支', () => {
  assert.equal(extractXlsxText(Buffer.from('not a zip at all')), '');
  assert.equal(extractPptxText(Buffer.from('not a zip')), '');
  assert.equal(extractPdfText(Buffer.from('hello')), '');
});
