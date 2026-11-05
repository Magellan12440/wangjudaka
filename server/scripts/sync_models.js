#!/usr/bin/env node
/**
 * 模型清单同步脚本（§18.3 第 3 步 / §0 算力池治理）。
 *
 * 作用：从中转站网关 GET {RELAY_GATEWAY}/models（OpenAI 兼容）拉取上游模型清单，
 * 与本地 model_registry.seed.json 合并，输出 diff 报告。
 *
 * 三条安全规则：
 *  1. **绝不覆盖人工字段**：已有模型的 code / role / price / commercial_ok / notes 全部保留，
 *     只更新 upstream_available 与同步时间。新发现的模型默认 commercial_ok=false，
 *     必须人工核验许可证后才能在交付产物中使用（§3.7 红线）。
 *  2. **绝不静默删除**：本地有而上游没有的模型只标记 upstream_available=false，不删条目，
 *     避免上游临时下架导致定价与编译器映射丢失。
 *  3. **绝不假装成功**：无 API Key 且未指定 --from-file 时直接报错退出；
 *     dry-run 是默认行为，只有 --write 才落盘。
 *
 * 用法：
 *   node scripts/sync_models.js                      # dry-run，需 RELAY_API_KEY
 *   node scripts/sync_models.js --write             # 落盘
 *   node scripts/sync_models.js --from-file x.json  # 用本地抓取结果（离线联调/测试）
 *   node scripts/sync_models.js --from-file x.json --write
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(SERVER_ROOT, 'src', 'seeds', 'data', 'model_registry.seed.json');
const REPORT_PATH = path.join(SERVER_ROOT, 'data', 'model_sync_report.json');

/** 由上游模型 id 推断角色（仅用于新发现的模型，人工必须复核） */
export function inferRole(id = '') {
  const s = String(id).toLowerCase();
  if (/image|flux|sdxl|dall|midjourney|ideogram|gpt-image|qwen-image|kolors|imagen|recraft/.test(s)) return 'image';
  if (/video|wan|kling|seedance|sora|veo|hunyuan|ltx|cogvideo|runway|pika|framepack|skyreels/.test(s)) return 'video';
  if (/tts|audio|speech|voice|cosy|sovits|eleven|sound|music|whisper|asr/.test(s)) return 'audio';
  return 'chat';
}

/** 从 OpenAI 兼容响应里取 id 列表，兼容 {data:[{id}]} / {models:[...]} / 字符串数组 */
export function extractUpstreamIds(payload) {
  const raw = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.models) ? payload.models : [];
  return [...new Set(raw.map((x) => (typeof x === 'string' ? x : x?.id ?? x?.name)).filter(Boolean).map(String))];
}

/**
 * 纯合并函数（可直接单测）。
 * @param {object} registry 现有 { _note, _last_sync, models: [] }
 * @param {string[]} upstreamIds 上游可用 id
 * @param {string} at 同步时间
 */
export function mergeModels(registry, upstreamIds, at = new Date().toISOString()) {
  const local = Array.isArray(registry?.models) ? registry.models : [];
  const upstream = new Set(upstreamIds.map(String));
  const localIds = new Set(local.map((m) => String(m.upstream_id)));
  const byId = new Map(local.map((m) => [String(m.upstream_id), m]));

  const models = local.map((m) => ({ ...m, upstream_available: upstream.has(String(m.upstream_id)) }));
  const added = [];
  const usedCodes = new Set(local.map((m) => String(m.code)));
  for (const id of upstream) {
    if (localIds.has(id)) continue;
    const role = inferRole(id);
    // code 大小写归一后可能撞车（如 minimax-h3 与 MiniMax-H3），撞车则追加序号保证唯一
    let codeBase = `AUTO-${String(id).replace(/[^a-zA-Z0-9_-]/g, '_').toUpperCase().slice(0, 48)}`;
    let code = codeBase;
    for (let i = 2; usedCodes.has(code); i++) code = `${codeBase}-${i}`;
    usedCodes.add(code);
    const rec = {
      code,
      role,
      display_name: `上游新模型（待核验）：${id}`,
      upstream_id: id,
      upstream_available: true,
      commercial_ok: false,
      needs_review: true,
      price: {},
      notes: '由 sync_models.js 自动发现；许可证未核验，禁止用于交付产物。请补齐 price 并逐条确认 commercial_ok。',
    };
    models.push(rec);
    added.push(rec);
  }
  const removed = [...localIds].filter((id) => !upstream.has(id)).map((id) => ({
    upstream_id: id,
    code: byId.get(id)?.code ?? null,
    action: 'marked_unavailable_not_deleted',
  }));

  return {
    registry: {
      ...registry,
      _last_sync: at,
      _sync_note: '由 scripts/sync_models.js 生成；自动发现的模型 commercial_ok=false，必须人工核验。',
      models,
    },
    diff: {
      at,
      upstream_count: upstream.size,
      local_count: local.length,
      result_count: models.length,
      added: added.map((m) => ({ code: m.code, upstream_id: m.upstream_id, role: m.role })),
      marked_unavailable: removed,
      kept: local.filter((m) => upstream.has(String(m.upstream_id))).map((m) => ({ code: m.code, upstream_id: m.upstream_id })),
      role_counts: models.reduce((a, m) => { a[m.role] = (a[m.role] ?? 0) + 1; return a; }, {}),
      needs_review: models.filter((m) => m.needs_review || m.commercial_ok === false).map((m) => m.code),
    },
  };
}

async function fetchUpstream() {
  // 延迟加载配置，避免 --help 也需要 .env
  const { config } = await import('../src/config/env.js');
  if (!config.relay.apiKey) {
    throw new Error('缺少 RELAY_API_KEY：请填入 server/.env.local，或用 --from-file 指定已抓取的 /v1/models 响应');
  }
  const url = `${config.relay.gateway.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.relay.apiKey}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}（${url}），未修改本地注册表`);
  return res.json();
}

function parseArgs(argv) {
  const args = { write: false, fromFile: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') args.write = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else if (argv[i] === '--from-file') args.fromFile = argv[++i] ?? null;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/sync_models.js [--from-file <json>] [--write]\n默认 dry-run，只打印 diff；--write 才落盘。');
    return;
  }
  if (!fs.existsSync(REGISTRY_PATH)) throw new Error(`注册表不存在: ${REGISTRY_PATH}`);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  let payload;
  if (args.fromFile) {
    const f = path.resolve(args.fromFile);
    if (!fs.existsSync(f)) throw new Error(`--from-file 不存在: ${f}`);
    payload = JSON.parse(fs.readFileSync(f, 'utf8'));
  } else {
    payload = await fetchUpstream();
  }
  const ids = extractUpstreamIds(payload);
  if (!ids.length) throw new Error('上游模型清单为空，未修改本地注册表（防止误清空）');

  const { registry: merged, diff } = mergeModels(registry, ids, new Date().toISOString());
  console.log(`模型同步 ${args.write ? '[WRITE]' : '[DRY-RUN]'}`);
  console.log(`  上游 ${diff.upstream_count} 个 / 本地 ${diff.local_count} 个 / 合并后 ${diff.result_count} 个`);
  console.log(`  新增 ${diff.added.length} 个（均 commercial_ok=false，需人工核验）`);
  console.log(`  上游缺失 ${diff.marked_unavailable.length} 个（仅标记不可用，不删除）`);
  console.log(`  角色分布 ${JSON.stringify(diff.role_counts)}`);
  if (diff.added.length) console.log(`  新增明细 ${JSON.stringify(diff.added.slice(0, 10))}`);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(diff, null, 2), 'utf8');
  console.log(`  diff 报告: ${REPORT_PATH}`);

  if (args.write) {
    fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    console.log(`  已写入: ${REGISTRY_PATH}`);
  } else {
    console.log('  未落盘（加 --write 生效）');
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((e) => {
    console.error(`模型同步失败: ${e.message}`);
    process.exitCode = 1;
  });
}

export default { inferRole, extractUpstreamIds, mergeModels };
