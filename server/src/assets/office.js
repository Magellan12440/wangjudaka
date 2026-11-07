/**
 * 零依赖表格 / 幻灯片正文抽取（V4.9）。
 *
 * 为什么自己做：素材入口要「什么都能传」，但 .xlsx/.pptx 也是 ZIP + XML，
 * 只取文字的话不需要引入整套 Office 解析库（服务端目前零依赖，包体也小）。
 *
 * 边界（如实）：
 *  - .xlsx：读 sharedStrings + 每张 sheet，输出「表名 + 制表符分隔的行」；
 *    公式只取缓存值，样式/图表/批注丢弃；
 *  - .pptx：按 slide 顺序取 <a:t> 文本，一页一行标题式输出；
 *  - 列宽不做对齐，交给下游 prompt 自己理解。
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

function inflate(buf, method, data) {
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

/**
 * 列出 ZIP 内所有条目名，并按需读取。
 * 返回 Map<name, () => Buffer|null>，惰性解压，避免一次解开整个包。
 */
export function zipEntries(buf) {
  const out = new Map();
  if (!Buffer.isBuffer(buf) || buf.length < 22) return out;
  const eocd = findEocd(buf);
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (!count || off <= 0 || off >= buf.length) return out;

  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CEN) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;

    out.set(name, () => {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOC) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      return inflate(buf, method, buf.slice(start, start + compSize));
    });
  }
  return out;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/** XML 文本节点反转义 */
export function unescapeXml(s) {
  return String(s ?? '').replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => {
    if (ENTITIES[m]) return ENTITIES[m];
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

/* ---------------- CSV / TSV ---------------- */

/** 单行 CSV 拆分：支持双引号包裹与 "" 转义 */
function splitCsvLine(line, sep) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * .csv / .tsv → 纯文本表格。
 * 首行当表头，输出「表头：A | B | C」+ 逐行「- 值1 | 值2」，比裸 tab 更好读。
 */
export function csvToText(text, { sep = ',', maxRows = 400, maxCols = 24 } = {}) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return '';
  const rows = lines.slice(0, maxRows).map((l) => splitCsvLine(l, sep).slice(0, maxCols));
  const head = rows[0];
  const body = rows.slice(1);
  const out = [`表头：${head.join(' | ')}`];
  body.forEach((r, i) => {
    if (!r.some((c) => c)) return;
    out.push(`${i + 1}. ${r.join(' | ')}`);
  });
  if (lines.length > maxRows) out.push(`（仅取前 ${maxRows} 行，共 ${lines.length} 行）`);
  return out.join('\n');
}

/* ---------------- XLSX ---------------- */

const xmlText = (xml, tag) => {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

/** 取「带属性的完整标签」+ 内容：<c r="A1" t="s"><v>1</v></c> 需要的正是属性 */
const xmlNodes = (xml, tag) => {
  const re = new RegExp(`<${tag}\\b([^>]*?)(/?)>([\\s\\S]*?)</${tag}>|<${tag}\\b([^>]*?)/>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    out.push({ attrs: m[1] ?? m[4] ?? '', inner: m[3] ?? '', selfClosing: Boolean(m[2] || m[4] !== undefined) });
  }
  return out;
};

function sharedStrings(zip) {
  const reader = zip.get('xl/sharedStrings.xml');
  if (!reader) return [];
  const xml = reader()?.toString('utf8') || '';
  return xmlText(xml, 'si').map((si) => unescapeXml(si.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')));
}

/** A1 → 列号（0 基） */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || ''));
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetToRows(xml, shared) {
  const rows = [];
  for (const row of xmlNodes(xml, 'row')) {
    const cells = [];
    for (const cell of xmlNodes(row.inner, 'c')) {
      const ref = (/r="([A-Z]+\d+)"/.exec(cell.attrs) || [])[1];
      const type = (/t="(\w+)"/.exec(cell.attrs) || [])[1];
      const rawV = xmlText(cell.inner, 'v')[0] ?? '';
      const inline = xmlNodes(cell.inner, 't')[0]?.inner ?? '';
      let val = '';
      if (type === 's') val = shared[Number(rawV)] ?? '';
      else if (type === 'inlineStr') val = unescapeXml(inline);
      else if (type === 'str') val = unescapeXml(rawV);
      else val = unescapeXml(rawV);
      if (!val) continue;
      cells[colIndex(ref)] = String(val).replace(/\s+/g, ' ').trim();
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

/** .xlsx → 纯文本；解析失败返回 '' */
export function extractXlsxText(buf, { maxRows = 200, maxCols = 16 } = {}) {
  const zip = zipEntries(buf);
  if (!zip.size) return '';
  const shared = sharedStrings(zip);

  // sheet 名与顺序来自 workbook.xml + rels；缺失时按文件名排序兜底
  const nameByRid = new Map();
  const wb = zip.get('xl/workbook.xml')?.()?.toString('utf8') || '';
  for (const node of xmlNodes(wb, 'sheet')) {
    const rid = (/r:id="([^"]+)"/.exec(node.attrs) || [])[1];
    const name = (/name="([^"]*)"/.exec(node.attrs) || [])[1];
    if (rid && name) nameByRid.set(rid, unescapeXml(name));
  }
  const relsXml = zip.get('xl/_rels/workbook.xml.rels')?.()?.toString('utf8') || '';
  const fileByRid = new Map();
  for (const node of xmlNodes(relsXml, 'Relationship')) {
    const id = (/Id="([^"]+)"/.exec(node.attrs) || [])[1];
    const target = (/Target="([^"]+)"/.exec(node.attrs) || [])[1];
    if (!id || !target) continue;
    fileByRid.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const ordered = [];
  for (const [rid, name] of nameByRid) {
    const file = fileByRid.get(rid);
    if (!file) continue;
    const reader = zip.get(`xl/${file}`);
    if (reader) ordered.push({ name, reader });
  }
  if (!ordered.length) {
    for (const [name, reader] of zip) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) ordered.push({ name, reader });
    }
  }

  const chunks = [];
  for (const { name, reader } of ordered) {
    const xml = reader()?.toString('utf8') || '';
    if (!xml) continue;
    const rows = sheetToRows(xml, shared).slice(0, maxRows).map((r) => r.slice(0, maxCols));
    if (!rows.length) continue;
    const head = rows[0];
    const lines = [`【${name}】表头：${head.filter(Boolean).join(' | ')}`];
    rows.slice(1).forEach((r, i) => {
      const cells = r.map((c) => c ?? '');
      if (!cells.some(Boolean)) return;
      lines.push(`${i + 1}. ${cells.join(' | ')}`);
    });
    chunks.push(lines.join('\n'));
  }
  return chunks.join('\n\n').trim();
}

/* ---------------- PPTX ---------------- */

/** .pptx → 纯文本（一页一段） */
export function extractPptxText(buf, { maxSlides = 60 } = {}) {
  const zip = zipEntries(buf);
  if (!zip.size) return '';
  const slides = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]))
    .slice(0, maxSlides);

  const out = [];
  slides.forEach((name, i) => {
    const xml = zip.get(name)()?.toString('utf8') || '';
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => unescapeXml(m[1]).trim())
      .filter(Boolean);
    if (!texts.length) return;
    out.push(`【第 ${i + 1} 页】${texts.join(' / ')}`);
  });
  return out.join('\n');
}

/* ---------------- PDF（尽力而为） ---------------- */

/**
 * .pdf 抽正文：只处理未加密、文本未做 CID 编码的常见情况。
 * 抽不到（扫描件 / 中文字体子集）就返回 ''，由调用方按「仅存档」处理——
 * 假装读懂 PDF 比明确说读不懂更糟。
 */
export function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) return '';
  if (/\/Encrypt\b/.test(raw)) return '';

  const chunks = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const body = m[1];
    let text = body;
    // FlateDecode 压缩流：按 zlib 直接尝试，失败就按明文处理
    const head = raw.slice(Math.max(0, m.index - 400), m.index);
    if (/FlateDecode/.test(head)) {
      try {
        text = zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
      } catch {
        try {
          text = zlib.inflateSync(Buffer.from(body, 'latin1'), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
        } catch {
          text = '';
        }
      }
    }
    if (!text || !/(BT|Tj|TJ)/.test(text)) continue;
    const pieces = [...text.matchAll(/\((?:\\.|[^\\)])*\)/g)].map((x) => x[0].slice(1, -1));
    const decoded = pieces
      .map((p) => p.replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c] ?? c)))
      .join('');
    if (decoded.trim()) chunks.push(decoded);
  }
  const out = chunks.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // 可打印字符占比太低（多半是字体子集/CID）→ 当作没抽到
  if (!out) return '';
  const printable = (out.match(/[\u4e00-\u9fa5\u3000-\u303fA-Za-z0-9，。、；：！？（）《》“”‘’\s.,;:!?'"()\-]/g) || []).length;
  if (printable / out.length < 0.7) return '';
  return out;
}
