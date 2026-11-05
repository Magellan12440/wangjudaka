/** 阶段 H：本地静态托管 —— 白名单、防目录穿越、前端文件齐备 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { resolveStaticPath, tryServeStatic, staticStatus, WEB_ROOT } from '../src/api/static.js';

function mockRes() {
  const r = new PassThrough();
  r.code = 0;
  r.headers = {};
  r.ended = false;
  r.writeHead = function (code, headers) { this.code = code; this.headers = headers; return this; };
  const origEnd = r.end.bind(r);
  r.end = function (...args) { this.ended = true; return origEnd(...args); };
  return r;
}
function req(method) { return { method }; }

test('/ 与具体页面能解析到 WEB_ROOT 内文件', () => {
  assert.equal(resolveStaticPath('/'), path.join(WEB_ROOT, 'index.html'));
  assert.equal(resolveStaticPath('/canvas.html'), path.join(WEB_ROOT, 'canvas.html'));
  assert.equal(resolveStaticPath('/upload-helper.js'), path.join(WEB_ROOT, 'upload-helper.js'));
});

test('红线：目录穿越（含 URL 编码）一律解析为 null', () => {
  const bad = [
    '/../server/.env.local',
    '/../../server/.env.local',
    '/%2e%2e/server/.env.local',
    '/%2e%2e%2fserver%2f.env.local',
    '/..%2fserver%2f.env.local',
    '/sub/../../server/src/config/env.js',
  ];
  for (const p of bad) assert.equal(resolveStaticPath(p), null, `应拒绝: ${p}`);
});

test('红线：反斜杠、无扩展名、非白名单扩展名被拒', () => {
  assert.equal(resolveStaticPath('/..\\server\\.env.local'), null);
  assert.equal(resolveStaticPath('/api/config'), null);
  assert.equal(resolveStaticPath('/server/.env'), null);
  assert.equal(resolveStaticPath('/evil.exe'), null);
  assert.equal(resolveStaticPath('/%00.js'), null);
});

test('staticStatus：web/ 已落地且关键文件齐备', () => {
  const s = staticStatus();
  assert.equal(s.web_root_exists, true);
  for (const f of ['index.html', 'canvas.html', 'canvas.js', 'canvas.css',
    'upload-helper.html', 'upload-helper.js', 'common.js', 'common.css']) {
    assert.ok(s.files.includes(f), `缺少前端文件 ${f}`);
  }
  assert.ok(s.file_count >= 8);
});

test('tryServeStatic：HEAD 返回 200 与 no-store，不读正文', () => {
  const res = mockRes();
  assert.equal(tryServeStatic(req('HEAD'), res, '/index.html'), true);
  assert.equal(res.code, 200);
  assert.match(res.headers['Content-Type'], /text\/html/);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.ended, true);
});

test('tryServeStatic：GET 页面返回 true；POST / API 路径 / 不存在文件返回 false', () => {
  const get = mockRes();
  assert.equal(tryServeStatic(req('GET'), get, '/canvas.html'), true);
  assert.equal(get.code, 200);
  assert.match(get.headers['Content-Type'], /text\/html/);

  assert.equal(tryServeStatic(req('POST'), mockRes(), '/index.html'), false);
  assert.equal(tryServeStatic(req('GET'), mockRes(), '/api/config'), false);
  assert.equal(tryServeStatic(req('GET'), mockRes(), '/health'), false);
  assert.equal(tryServeStatic(req('GET'), mockRes(), '/not-exist.html'), false);
  assert.equal(tryServeStatic(req('GET'), mockRes(), '/../server/.env.local'), false);
});

test('红线：静态托管绝不把 .env.local / .js 之外的服务端文件暴露出去', () => {
  assert.equal(resolveStaticPath('/../.env.local'), null);
  assert.equal(resolveStaticPath('/../server/package.json'), null);
  const res = mockRes();
  assert.equal(tryServeStatic(req('GET'), res, '/%2e%2e%2fserver%2f.env.local'), false);
});
