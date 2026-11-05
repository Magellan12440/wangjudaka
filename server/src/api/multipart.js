/**
 * 极简 multipart/form-data 解析（零依赖）。
 *
 * 只服务一个场景：小程序 wx.uploadFile 上传剧本素材。
 * 支持单 boundary、多 part、文本字段与文件字段；不处理嵌套 multipart。
 * 解析失败一律抛 BAD_REQUEST，不把半个文件写进库。
 */

export function readRawBody(req, { maxBytes = 25 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const bail = (err) => {
      if (done) return;
      done = true;
      req.destroy?.();
      reject(err);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        const e = new Error(`上传内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
        e.code = 'MATERIAL_TOO_LARGE';
        bail(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => bail(e));
  });
}

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  // 注意：header 里的 boundary 值本身就可能以 `-` 开头（如 ----WebKitFormBoundary），
  // 不能再剥一层 `--`，否则分隔符会错位，字段尾部会粘上 `--`。
  return ((m && (m[1] || m[2])) || '').trim();
}

function parseHeaders(text) {
  const out = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * @returns {{fields: Record<string,string>, files: Array<{field:string,filename:string,mime:string,data:Buffer}>}}
 */
export function parseMultipart(buffer, contentType, { maxFiles = 12 } = {}) {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw Object.assign(new Error('缺少 multipart boundary'), { code: 'BAD_REQUEST' });
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let cursor = buffer.indexOf(delim);
  if (cursor < 0) throw Object.assign(new Error('multipart 报文格式不正确'), { code: 'BAD_REQUEST' });

  while (cursor >= 0) {
    const next = buffer.indexOf(delim, cursor + delim.length);
    if (next < 0) break;
    let chunk = buffer.slice(cursor + delim.length, next);
    cursor = next;

    // 前导 CRLF 与结尾 CRLF 都是分隔符的一部分
    if (chunk.length >= 2 && chunk[0] === 13 && chunk[1] === 10) chunk = chunk.slice(2);
    if (chunk.length >= 2 && chunk[chunk.length - 2] === 13 && chunk[chunk.length - 1] === 10) {
      chunk = chunk.slice(0, -2);
    }
    if (!chunk.length) continue; // 结束标记 `--`

    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = parseHeaders(chunk.slice(0, headerEnd).toString('utf8'));
    const data = chunk.slice(headerEnd + 4);
    const disp = headers['content-disposition'] || '';
    const field = /name="([^"]*)"/i.exec(disp)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(disp)?.[1] ?? '';
    if (!field) continue;

    if (filename) {
      if (files.length >= maxFiles) {
        throw Object.assign(new Error(`单次最多上传 ${maxFiles} 个文件`), { code: 'MATERIAL_LIMIT' });
      }
      files.push({
        field,
        filename: filename.replace(/[\\/]/g, '_').slice(0, 120),
        mime: (headers['content-type'] || 'application/octet-stream').toLowerCase(),
        data,
      });
    } else {
      fields[field] = data.toString('utf8');
    }
  }

  if (!files.length && !Object.keys(fields).length) {
    throw Object.assign(new Error('multipart 报文里没有可用字段'), { code: 'BAD_REQUEST' });
  }
  return { fields, files };
}

export default parseMultipart;
