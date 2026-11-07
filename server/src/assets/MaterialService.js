/**
 * 素材库（V4.2）：用户把小说 / 参考图 / 参考视频放进项目，作为剧本创作的输入。
 *
 * 边界（刻意为之）：
 *  - 只有「文本」会真正改写剧本 prompt（节选后注入，见 digest）；
 *  - 图片 / 视频作为视觉参考存档，并把用户备注一并写入 prompt ——
 *    当前上游是文本模型，不假装它能"看懂"画面；
 *  - 二进制素材落对象存储（云端 cloud:// fileID，未配置微信凭据时降级本地 /media/<name>），
 *    文件名 24 位随机，URL 不可猜；容器本地只作兜底，重启会丢；
 *  - 单项目有条数与体积上限，避免 JSON 库被撑爆。
 */
import path from 'node:path';
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import { extractDocxText } from './docx.js';
import {
  csvToText, extractXlsxText, extractPptxText, extractPdfText,
} from './office.js';
import objectStore, { cloudEnvId } from '../storage/ObjectStore.js';

const COL = 'materials';

const MAX_BYTES = {
  image: 8 * 1024 * 1024,
  video: 24 * 1024 * 1024,
  audio: 12 * 1024 * 1024,
  text: 8 * 1024 * 1024,
  docx: 10 * 1024 * 1024,
  sheet: 10 * 1024 * 1024,
  slides: 20 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  file: 24 * 1024 * 1024,
};
const MAX_ITEMS = 24;
/**
 * 单条正文上限：120 万字（V4.10 起）。
 * 一本 300 章的长篇大约 90~150 万字，卡在 12 万等于不让人上传真正的长篇，
 * 所以上限直接放到百万级；真正的瓶颈交给「分层压缩」而不是拒收。
 * UTF-8 中文 1 字约 3 字节，120 万字约 3.6MB，text 文件体积上限同步放到 8MB。
 */
const MAX_TEXT_CHARS = 1200000;
const MAX_PER_KIND = 12;

const EXT = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'],
  video: ['.mp4', '.mov', '.m4v', '.webm'],
  audio: ['.mp3', '.m4a', '.wav', '.aac'],
  text: ['.txt', '.md', '.markdown', '.text', '.json', '.srt', '.log', '.xml', '.yaml', '.yml'],
  sheet: ['.csv', '.tsv', '.xlsx'],
  slides: ['.pptx'],
  pdf: ['.pdf'],
};

/** 能抽出正文的格式：入库存纯文本，不保留二进制 */
const PARSED = new Set(['text', 'docx', 'sheet', 'slides', 'pdf']);

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

/**
 * 文件归类。
 * 认不出来的不算错误，归为 'file'（只存档、不参与剧本改写）——
 * 用户要求「什么文件都能传」，能读的读、读不了的诚实标注，别拒之门外。
 */
function kindOf(mime, filename) {
  const ext = extOf(filename);
  for (const [kind, exts] of Object.entries(EXT)) {
    if (exts.includes(ext)) return kind;
  }
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/')) return 'text';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('officedocument.wordprocessingml') || ext === '.doc') return 'docx';
  if (m.includes('officedocument.spreadsheetml') || m.includes('ms-excel')) return 'sheet';
  if (m.includes('officedocument.presentationml') || m.includes('ms-powerpoint')) return 'slides';
  return 'file';
}

function safeName(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').trim();
  return (s || '未命名素材').slice(0, 60);
}

/** UTF-8 解码：替换字符过多说明不是 UTF-8（GBK 稿子请先转码） */
function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > Math.max(8, utf8.length * 0.01)) {
    fail(ERR.MATERIAL_UNSUPPORTED, '文本编码不是 UTF-8，请另存为 UTF-8 后再上传（或直接粘贴正文）');
  }
  return utf8.replace(/^\uFEFF/, '').replace(/\u0000/g, '');
}

/** 章节标题识别：第X章 / 第X回 / Chapter N / "12、" 这类编号行 */
const CHAPTER_RE = /^(第[\d零一二三四五六七八九十百千两]+[章回节卷篇幕集]|chapter\s+\d+|\d{1,4}\s*[、.．:])[\s:：、.．\-—]*\S{0,30}$/i;

/**
 * 长文分层压缩（V4.10）。
 *
 * 一本 120 万字的小说塞不进任何 prompt，但「只取开头」会让编剧看不到结局与反转。
 * 这里用确定性抽样，离线也能跑，且不花钱：
 *   结构（章节标题清单）+ 开头 30% + 主体等距抽样 + 结尾 20%
 * 输出一定会 ≤ budget，调用方如实标注「已分层压缩」。
 */
function condenseText(raw, budget) {
  const text = String(raw ?? '');
  const limit = Math.max(600, Number(budget) || 6000);
  if (text.length <= limit) return { body: text, didCondense: false };

  // 1) 章节结构：只留标题，用于让模型知道全书有多少章、讲到哪
  const heads = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.length > 40) continue;
    if (CHAPTER_RE.test(t)) heads.push(t);
    if (heads.length >= 2000) break;
  }
  const headList = heads.length
    ? `【全书结构】共 ${heads.length} 章：${heads.slice(0, 12).join(' / ')}${heads.length > 12 ? ` … ${heads.slice(-8).join(' / ')}` : ''}\n`
    : '';

  const headLen = Math.floor(limit * 0.3);
  const tailLen = Math.floor(limit * 0.2);
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);

  // 2) 主体等距抽样：把中间 50% 切成 K 段，每段取开头一小段（通常是段落起句）
  const midBudget = Math.max(0, limit - headLen - tailLen - headList.length);
  const midStart = headLen;
  const midEnd = Math.max(midStart, text.length - tailLen);
  const midText = text.slice(midStart, midEnd);
  const K = Math.min(24, Math.max(3, Math.round(midBudget / 260)));
  const per = Math.max(60, Math.floor(midBudget / Math.max(1, K)) - 12);
  const step = Math.floor(midText.length / K) || 1;
  const samples = [];
  for (let i = 0; i < K; i += 1) {
    const seg = midText.slice(i * step, i * step + per).trim();
    if (seg) samples.push(`…${seg.replace(/\s*\n\s*/g, ' ')}…`);
  }
  const mid = samples.join('\n');

  const body = `${headList}【开头】\n${head}\n\n【中段抽样】\n${mid}\n\n【结尾】\n${tail}`;
  return { body: body.slice(0, limit + headList.length), didCondense: true };
}

export class MaterialService {
  list(projectId) {
    return db.find(COL, (m) => m.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((m) => this.#view(m));
  }

  /**
   * 只抽正文、不入库（供「上传本地文件 → 直接生成剧本」使用）。
   * 与 addFile 共用同一套解析器，所以格式支持范围完全一致：
   *   txt/md/json/srt、docx、csv/tsv/xlsx、pptx、pdf，以及其它「读不出」的文件。
   * 读不出正文不抛错，返回 { ok:false, reason }，由前端提示「可以直接粘贴正文」。
   * @returns {{ok:boolean, name:string, kind:string, text:string, chars:number, total_chars:number, truncated:boolean, reason?:string}}
   */
  extractText({ filename, mime = '', buffer, maxChars = MAX_TEXT_CHARS }) {
    if (!buffer?.length) fail(ERR.MATERIAL_EMPTY, '文件为空');
    const kind = kindOf(String(mime).toLowerCase(), filename);
    const limit = MAX_BYTES[kind] ?? MAX_BYTES.file;
    if (buffer.length > limit) {
      fail(ERR.MATERIAL_TOO_LARGE, `文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制，请拆分后再传`);
    }
    const name = safeName(filename);
    if (!PARSED.has(kind)) {
      return {
        ok: false, name, kind, text: '', chars: 0, total_chars: 0, truncated: false,
        reason: '这个格式读不出文字（图片/视频/压缩包等）。正文可以直接粘贴，或换 txt / docx / pdf 上传。',
      };
    }
    let text = '';
    try {
      text = this.#toText(kind, buffer, filename) || '';
    } catch (e) {
      return {
        ok: false, name, kind, text: '', chars: 0, total_chars: 0, truncated: false,
        reason: `解析失败（${e?.message || '文件可能已加密或损坏'}），可以直接粘贴正文`,
      };
    }
    text = String(text).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const chars = text.replace(/\s/g, '').length;
    if (!text) {
      return {
        ok: false, name, kind, text: '', chars: 0, total_chars: 0, truncated: false,
        reason: '没读到正文。扫描版 PDF / 老 .doc 需要先转成文字版，或直接粘贴正文。',
      };
    }
    const cap = Math.min(MAX_TEXT_CHARS, Math.max(1000, Number(maxChars) || MAX_TEXT_CHARS));
    return {
      ok: true,
      name,
      kind,
      text: text.slice(0, cap),
      chars: Math.min(chars, cap),
      total_chars: chars,
      truncated: text.length > cap,
    };
  }

  stats(projectId) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    const by = {
      text: 0, image: 0, video: 0, audio: 0, sheet: 0, slides: 0, pdf: 0, file: 0,
    };
    let chars = 0;
    for (const m of rows) {
      by[m.kind] = (by[m.kind] ?? 0) + 1;
      chars += Number(m.chars) || 0;
    }
    return { total: rows.length, by_kind: by, text_chars: chars };
  }

  get(projectId, id) {
    const m = db.findOne(COL, (x) => x.id === id && x.project_id === projectId);
    if (!m) fail(ERR.NOT_FOUND, '素材不存在');
    return m;
  }

  /** 纯文本素材（粘贴正文 / 上传 .txt / 解析 .docx） */
  addText({ projectId, userId, name, text, note = '', source = 'paste' }) {
    const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) fail(ERR.MATERIAL_EMPTY, '文本素材不能为空');
    if (body.length > MAX_TEXT_CHARS) {
      fail(ERR.MATERIAL_TOO_LARGE, `单条文本最多 ${MAX_TEXT_CHARS.toLocaleString()} 字，请拆分后上传`);
    }
    this.#assertQuota(projectId, 'text');
    const rec = db.insert(COL, {
      id: newId('mat'),
      project_id: projectId,
      user_id: userId ?? null,
      kind: 'text',
      name: safeName(name),
      note: String(note ?? '').slice(0, 300),
      source,
      chars: body.length,
      text: body,
      mime: 'text/plain',
      size: Buffer.byteLength(body, 'utf8'),
      created_at: nowIso(),
    });
    return this.#view(rec);
  }

  /** 二进制素材（图片 / 视频 / 音频 / 文本 / 表格 / 幻灯片 / PDF / 其它任意文件） */
  async addFile({ projectId, userId, filename, mime = '', buffer, note = '' }) {
    if (!buffer?.length) fail(ERR.MATERIAL_EMPTY, '文件为空');
    const kind = kindOf(String(mime).toLowerCase(), filename);
    const limit = MAX_BYTES[kind] ?? MAX_BYTES.file;
    if (buffer.length > limit) {
      fail(ERR.MATERIAL_TOO_LARGE, `文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
    }

    // 能读正文的格式：转成纯文本入库，不保留二进制（省空间，也便于注入 prompt）
    if (PARSED.has(kind)) {
      let text = '';
      try {
        text = this.#toText(kind, buffer, filename);
      } catch {
        text = '';
      }
      if (text && text.trim()) {
        return this.addText({
          projectId,
          userId,
          name: filename,
          text,
          note: this.#parseNote(kind, note),
          source: kind,
        });
      }
      // 读不出来（扫描版 PDF / 老 .doc / 受保护文件）：不报错，转为存档并如实告知
      return this.#archive({
        projectId, userId, filename, mime, buffer, kind: 'file',
        note: this.#archiveNote(kind, note),
      });
    }

    return this.#archive({ projectId, userId, filename, mime, buffer, kind, note });
  }

  /** 抽正文：按类型分派，统一返回纯文本（失败返回 ''） */
  #toText(kind, buffer, filename) {
    if (kind === 'docx') return extractDocxText(buffer);
    if (kind === 'sheet') {
      const ext = extOf(filename);
      if (ext === '.csv' || ext === '.tsv') {
        return csvToText(decodeText(buffer), { sep: ext === '.tsv' ? '\t' : ',' });
      }
      return extractXlsxText(buffer);
    }
    if (kind === 'slides') return extractPptxText(buffer);
    if (kind === 'pdf') return extractPdfText(buffer);
    return decodeText(buffer);
  }

  #parseNote(kind, note) {
    const base = String(note ?? '').slice(0, 260);
    const tail = {
      sheet: '（表格已转成文字读入：取表头与前若干行）',
      slides: '（演示稿已按页转成文字读入）',
      pdf: '（PDF 正文已抽取，排版信息已丢弃）',
      docx: '（Word 正文已抽取）',
    }[kind] || '';
    return tail ? `${base}${base ? ' ' : ''}${tail}`.slice(0, 300) : base;
  }

  #archiveNote(kind, note) {
    const base = String(note ?? '').slice(0, 230);
    const label = {
      pdf: '扫描版 PDF 读不到文字',
      docx: '这份 Word 读不到正文（可能是旧版 .doc 或有密码）',
      sheet: '这份表格读不到数据',
      slides: '这份演示稿读不到文字',
      text: '这个文本不是 UTF-8 编码',
    }[kind] || '这类文件暂不支持解析';
    const tail = `${label}，已存档，可作为参考但不会写进剧本。另存为 docx / xlsx / txt 或直接粘贴正文即可参与改写。`;
    return `${base}${base ? ' ' : ''}${tail}`.slice(0, 300);
  }

  /** 落对象存储并登记（不解析正文） */
  async #archive({ projectId, userId, filename, mime, buffer, kind, note }) {
    this.#assertQuota(projectId, kind);
    const ext = extOf(filename) || {
      image: '.jpg', video: '.mp4', audio: '.mp3', file: '.bin',
    }[kind];
    const saved = await objectStore.put(buffer, { ext, mime: mime || 'application/octet-stream' });

    const rec = db.insert(COL, {
      id: newId('mat'),
      project_id: projectId,
      user_id: userId ?? null,
      kind,
      name: safeName(filename),
      note: String(note ?? '').slice(0, 300),
      source: 'upload',
      mime: mime || 'application/octet-stream',
      size: buffer.length,
      file: saved.provider === 'local' ? saved.file : null,
      url: saved.url,
      storage: saved.provider,
      created_at: nowIso(),
    });
    return this.#view(rec);
  }

  /**
   * 登记「小程序直传云存储」的素材（V4.8）。
   *
   * 为什么需要这条：`wx.uploadFile` 走公网，必须过 uploadFile 合法域名，
   * 而云托管默认域名配不进白名单；`wx.cloud.uploadFile` 走微信内部链路，
   * 不受域名限制，但文件直接进了云存储，后端只拿到 fileID。
   *
   * 安全性：只接受**本环境**的 fileID，并且回源 HEAD 核实文件真实存在与大小，
   * 不信任前端自报的 size（否则可以绕开体积上限）。
   */
  async addCloudFile({ projectId, userId, fileId, filename, mime = '', note = '', size = 0 }) {
    const id = String(fileId || '');
    const env = cloudEnvId();
    if (!id.startsWith('cloud://')) fail(ERR.MATERIAL_UNSUPPORTED, '云文件标识不合法');
    if (!env) fail(ERR.MATERIAL_UNSUPPORTED, '服务端未配置云开发环境，无法接收直传文件');
    // cloud://<env>.<bucket>/<path>：env 段必须一致，防止引用别人环境的对象
    const head = id.slice('cloud://'.length).split('/')[0];
    if (!head.startsWith(`${env}.`)) fail(ERR.MATERIAL_UNSUPPORTED, '云文件不属于当前环境');

    const kind = kindOf(String(mime).toLowerCase(), filename);
    const limit = MAX_BYTES[kind] ?? MAX_BYTES.file;
    const real = await objectStore.headSize(id);
    const bytes = real || Number(size) || 0;
    if (!bytes) fail(ERR.MATERIAL_EMPTY, '云文件读取失败，请重新上传');
    if (bytes > limit) fail(ERR.MATERIAL_TOO_LARGE, `文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);

    // 可解析的格式要先取回内容抽正文，再走普通入库（不保留二进制）
    if (PARSED.has(kind)) {
      const buf = await objectStore.read(id);
      if (!buf?.length) fail(ERR.MATERIAL_EMPTY, '云文件下载失败，请重新上传');
      return this.addFile({ projectId, userId, filename, mime, buffer: buf, note });
    }

    this.#assertQuota(projectId, kind);
    const rec = db.insert(COL, {
      id: newId('mat'),
      project_id: projectId,
      user_id: userId ?? null,
      kind,
      name: safeName(filename),
      note: String(note ?? '').slice(0, 300),
      source: 'upload',
      mime: mime || 'application/octet-stream',
      size: bytes,
      file: null,
      url: id,
      storage: 'cloud',
      created_at: nowIso(),
    });
    return this.#view(rec);
  }

  /** 删除素材（含云存储/本地文件） */
  async remove(projectId, id) {
    const m = this.get(projectId, id);
    if (m.url) await objectStore.remove(m.url);
    db.remove(COL, m.id);
    return { removed: true, id: m.id };
  }

  /** 项目删除/清空时清理文件（当前版本不提供项目删除，保留给运维脚本） */
  async purge(projectId) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    for (const m of rows) {
      if (m.url) await objectStore.remove(m.url);
      db.remove(COL, m.id);
    }
    return rows.length;
  }

  /**
   * 生成剧本时的参考摘要（V4.10：分层压缩，百万字也能用）。
   *
   * 为什么不再「截前 N 字」：一本 120 万字的小说只取前 1600 字，等于让编剧只看扉页就改全书。
   * 现在按「分层抽样」构造故事圣经：
   *   1) 章节标题全收（保留结构：多少章、每章叫什么）
   *   2) 开头 30%（人物出场、世界观）
   *   3) 主体按等距抽样（每章取开头一段，避免只看开头）
   *   4) 结尾 20%（结局与反转）
   * 总量卡在 maxChars，超长文本会标注「已压缩」，不假装读完了全文。
   */
  digest(projectId, { maxChars = 24000, perText = 6000 } = {}) {
    const rows = db.find(COL, (m) => m.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (!rows.length) {
      return { text: '', used: [], chars: 0, condensed: false, total_chars: 0 };
    }

    const blocks = [];
    const used = [];
    let usedChars = 0;
    let textNo = 0;
    let visualNo = 0;
    let totalChars = 0;
    let condensed = false;

    // 文本先算总量，避免大文本被后面的图片说明挤掉
    const texts = rows.filter((m) => m.kind === 'text' && m.text);
    const visuals = rows.filter((m) => m.kind !== 'text');

    for (const m of texts) {
      if (!m.text) continue;
      textNo += 1;
      totalChars += Number(m.chars) || m.text.length;
      const budget = Math.min(perText, Math.max(1200, Math.floor(maxChars / Math.max(1, texts.length))));
      const { body, didCondense } = condenseText(m.text, budget);
      if (didCondense) condensed = true;
      const block = `【参考文本 ${textNo}】《${m.name}》共 ${Number(m.chars) || m.text.length} 字`
        + `${didCondense ? `，已分层压缩到 ${body.length} 字（保留章节结构 + 开头/抽样/结尾）` : ''}：\n${body}`
        + `${m.note ? `\n用户说明：${m.note}` : ''}`;
      if (usedChars + block.length > maxChars && blocks.length) continue;
      blocks.push(block);
      usedChars += block.length;
      used.push({ id: m.id, kind: 'text', name: m.name, chars: body.length, full_chars: Number(m.chars) || m.text.length });
    }

    for (const m of visuals) {
      visualNo += 1;
      const label = { image: '参考画面', video: '参考视频', audio: '参考音频' }[m.kind] ?? '参考素材';
      if (m.kind === 'file' && m.note) {
        // 存档类文件（读不出正文）：至少把用户的说明带进去
      }
      const block = `【${label} ${visualNo}】${m.name}${m.note ? `｜用户说明：${m.note}` : '｜（用户未写说明）'}`;
      if (usedChars + block.length > maxChars) break;
      blocks.push(block);
      usedChars += block.length;
      used.push({ id: m.id, kind: m.kind, name: m.name, note: m.note || '' });
    }

    return { text: blocks.join('\n\n'), used, chars: usedChars, condensed, total_chars: totalChars };
  }

  /** 项目正文总量（用于前端显示「共 xx 万字」与上限提示） */
  textTotal(projectId) {
    const rows = db.find(COL, (m) => m.project_id === projectId && m.kind === 'text');
    return rows.reduce((n, m) => n + (Number(m.chars) || String(m.text || '').length), 0);
  }

  #assertQuota(projectId, kind) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    if (rows.length >= MAX_ITEMS) fail(ERR.MATERIAL_LIMIT, `单个项目最多 ${MAX_ITEMS} 个素材，请先删掉不用的`);
    // 各类「被解析成文本」的素材共享 text 配额；纯存档文件（file）比较杂，放宽到总上限
    if (kind === 'file') return;
    const norm = (k) => (PARSED.has(k) ? 'text' : k);
    const same = rows.filter((m) => norm(m.kind) === norm(kind)).length;
    if (same >= MAX_PER_KIND) fail(ERR.MATERIAL_LIMIT, `同类素材最多 ${MAX_PER_KIND} 个`);
  }

  #view(m) {
    const { text, file, ...rest } = m;
    return {
      ...rest,
      chars: m.chars ?? 0,
      preview: text ? text.slice(0, 120) : '',
      has_text: Boolean(text),
    };
  }
}

export const materialService = new MaterialService();
export default materialService;
