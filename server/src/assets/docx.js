/**
 * 零依赖 .docx 正文抽取。
 *
 * 小说稿件大量是 Word。这里不引第三方库：.docx 本质是 ZIP，
 * 只需读中央目录 → 找到 word/document.xml → inflateRaw → 去标签。
 * 只做「取正文」这一件事，样式 / 批注 / 修订一律丢弃。
 */
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读取 ZIP 内指定文件的解压后内容；找不到返回 null。
 * @param {Buffer} buf
 * @param {string} wanted 例如 'word/document.xml'
 */
export function readZipEntry(buf, wanted) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (!count || off <= 0 || off >= buf.length) return null;

  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOC) return null;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(start, start + compSize);
    if (method === 0) return data;
    if (method === 8) {
      try {
        return zlib.inflateRawSync(data);
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

/** WordprocessingML → 纯文本（段落换行，丢弃所有样式标签） */
export function wordXmlToText(xml) {
  if (!xml) return '';
  return String(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 .docx Buffer 抽取正文；不是合法 docx 返回 '' */
export function extractDocxText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) return '';
  return wordXmlToText(xml.toString('utf8'));
}
