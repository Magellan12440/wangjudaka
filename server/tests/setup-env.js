/**
 * 测试前置：每次运行使用独立的全新数据目录，避免跨运行污染。
 *
 * 注意：这里刻意不删除旧目录。删除目录在受管环境里会触发安全策略，
 * 也会让并行/中断的运行互相踩踏；用「时间戳 + pid」新建目录更安全。
 * 目录位于系统临时区，不污染工程，也不会进入 git。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), `wangjudaka-test-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });

process.env.DATA_DIR = dir;
process.env.RELAY_MOCK = 'true';
process.env.NODE_ENV = 'test';
// 测试强制走 mock 通道：屏蔽 .env.local 里的真实微信/算力凭据，绝不打真实 API
process.env.WX_APPID = '';
process.env.WX_SECRET = '';
process.env.WX_PAY_OFFER_ID = '';
process.env.WX_PAY_APP_KEY = '';
process.env.RELAY_API_KEY = '';
process.env.QC_COMPARE_ENDPOINT = '';
// 管理端测试使用固定测试令牌
process.env.ADMIN_TOKEN = 'test-admin-token';
