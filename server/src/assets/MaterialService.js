/**
 * 素材库（V4.2）：用户把小说 / 参考图 / 参考视频放进项目，作为剧本创作的输入。
 *
 * 边界（刻意为之）：
 *  - 只有「文本」会真正改写剧本 prompt（节选后注入，见 digest）；
 *  - 图片 / 视频作为视觉参考存档，并把用户备注一并写入 prompt ——
 *    当前上游是文本模型，不假装它能"看懂"画面；
 *  - 所有文件落在 DATA_DIR/uploads，文件名 24 位随机，URL 不可猜；
 *  - 单项目有条数与体积上限，避免 JSON 库被撑爆。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { db } from '../store/db.js';
import { newId, nowIso } from '../core/util.js';
import { fail, ERR } from '../core/errors.js';
import { extractDocxText } from './docx.js';
import { MEDIA_ROOT } from '../api/media.js';

const COL = 'materials';

const MAX_BYTES = {
  image: 8 * 1024 * 1024,
  video: 24 * 1024 * 1024,
  audio: 12 * 1024 * 1024,
  text: 1024 * 1024,
  docx: 10 * 1024 * 1024,
};
const MAX_ITEMS = 24;
const MAX_TEXT_CHARS = 120000;
const MAX_PER_KIND = 12;

const EXT = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'],
  video: ['.mp4', '.mov', '.m4v', '.webm'],
  audio: ['.mp3', '.m4a', '.wav', '.aac'],
  text: ['.txt', '.md', '.markdown', '.text'],
};

function extOf(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function kindOf(mime, filename) {
  const ext = extOf(filename);
  if (mime.startsWith('image/') || EXT.image.includes(ext)) return 'image';
  if (mime.startsWith('video/') || EXT.video.includes(ext)) return 'video';
  if (mime.startsWith('audio/') || EXT.audio.includes(ext)) return 'audio';
  if (mime.startsWith('text/') || EXT.text.includes(ext)) return 'text';
  if (ext === '.docx' || mime.includes('officedocument.wordprocessingml')) return 'docx';
  return null;
}

function storedName(ext) {
  return `${crypto.randomBytes(12).toString('hex')}${ext}`;
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

export class MaterialService {
  list(projectId) {
    return db.find(COL, (m) => m.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((m) => this.#view(m));
  }

  stats(projectId) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    const by = { text: 0, image: 0, video: 0, audio: 0 };
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

  /** 二进制素材（图片 / 视频 / 音频 / txt / docx） */
  addFile({ projectId, userId, filename, mime = '', buffer, note = '' }) {
    if (!buffer?.length) fail(ERR.MATERIAL_EMPTY, '文件为空');
    const kind = kindOf(String(mime).toLowerCase(), filename);
    if (!kind) {
      fail(ERR.MATERIAL_UNSUPPORTED, '暂不支持该格式：请上传图片、视频、音频、.txt 或 .docx');
    }
    const limit = MAX_BYTES[kind] ?? MAX_BYTES.image;
    if (buffer.length > limit) {
      fail(ERR.MATERIAL_TOO_LARGE, `文件超过 ${Math.round(limit / 1024 / 1024)}MB 限制`);
    }

    // 文本与 docx 转成纯文本入库，不再保留二进制（省空间，也便于注入 prompt）
    if (kind === 'text' || kind === 'docx') {
      const text = kind === 'docx' ? extractDocxText(buffer) : decodeText(buffer);
      if (!text) fail(ERR.MATERIAL_EMPTY, '没有从文件中读到正文，请换一个文件或直接粘贴文本');
      return this.addText({
        projectId,
        userId,
        name: filename,
        text,
        note,
        source: kind === 'docx' ? 'docx' : 'file',
      });
    }

    this.#assertQuota(projectId, kind);
    const ext = extOf(filename) || {
      image: '.jpg', video: '.mp4', audio: '.mp3',
    }[kind];
    const stored = storedName(ext);
    fs.mkdirSync(MEDIA_ROOT, { recursive: true });
    fs.writeFileSync(path.join(MEDIA_ROOT, stored), buffer);

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
      file: stored,
      url: `/media/${stored}`,
      created_at: nowIso(),
    });
    return this.#view(rec);
  }

  remove(projectId, id) {
    const m = this.get(projectId, id);
    if (m.file) {
      try {
        fs.unlinkSync(path.join(MEDIA_ROOT, m.file));
      } catch { /* 文件已不在，忽略 */ }
    }
    db.remove(COL, m.id);
    return { removed: true, id: m.id };
  }

  /**
   * 生成剧本时的参考摘要。
   * 文本按每条 perText 截断，总量不超过 maxChars —— 不把整本小说塞进 prompt。
   */
  digest(projectId, { maxChars = 5000, perText = 1600 } = {}) {
    const rows = db.find(COL, (m) => m.project_id === projectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (!rows.length) return { text: '', used: [], chars: 0 };

    const blocks = [];
    const used = [];
    let usedChars = 0;
    let textNo = 0;
    let visualNo = 0;

    for (const m of rows) {
      if (m.kind === 'text') {
        if (!m.text) continue;
        textNo += 1;
        const excerpt = m.text.slice(0, perText);
        const block = `【参考文本 ${textNo}】《${m.name}》共 ${m.chars} 字，节选：\n${excerpt}`
          + `${m.text.length > excerpt.length ? '\n……（后文略）' : ''}`
          + `${m.note ? `\n用户说明：${m.note}` : ''}`;
        if (usedChars + block.length > maxChars) break;
        blocks.push(block);
        usedChars += block.length;
        used.push({ id: m.id, kind: 'text', name: m.name, chars: excerpt.length });
      } else {
        visualNo += 1;
        const label = { image: '参考画面', video: '参考视频', audio: '参考音频' }[m.kind] ?? '参考素材';
        const block = `【${label} ${visualNo}】${m.name}${m.note ? `｜用户说明：${m.note}` : '｜（用户未写说明）'}`;
        if (usedChars + block.length > maxChars) break;
        blocks.push(block);
        usedChars += block.length;
        used.push({ id: m.id, kind: m.kind, name: m.name, note: m.note || '' });
      }
    }
    return { text: blocks.join('\n\n'), used, chars: usedChars };
  }

  /** 项目删除/清空时清理文件（当前版本不提供项目删除，保留给运维脚本） */
  purge(projectId) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    for (const m of rows) {
      if (m.file) {
        try { fs.unlinkSync(path.join(MEDIA_ROOT, m.file)); } catch { /* ignore */ }
      }
      db.remove(COL, m.id);
    }
    return rows.length;
  }

  #assertQuota(projectId, kind) {
    const rows = db.find(COL, (m) => m.project_id === projectId);
    if (rows.length >= MAX_ITEMS) fail(ERR.MATERIAL_LIMIT, `单个项目最多 ${MAX_ITEMS} 个素材，请先删掉不用的`);
    const same = rows.filter((m) => (kind === 'docx' ? 'text' : m.kind) === kind).length;
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
