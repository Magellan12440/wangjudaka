/**
 * 一次性脚本：给 cinema_grammar.json 的 21 条配方补 `styles` 标签。
 * 用文本插入而不是 JSON 重新序列化，避免把手工排版的多字段行打散。
 */
import fs from 'node:fs';

const P = 'server/src/seeds/data/cinema_grammar.json';

/** 配方 → 适配风格（必须与 style_presets.json 的 code 一致，loader 会校验） */
const MAP = {
  'GRM-VERTIGO': ['STY-XUANYI', 'STY-FUCHOU', 'STY-DUSHI', 'STY-GONGDOU', 'STY-KEHUAN'],
  'GRM-DOORWAY-PEEK': ['STY-XUANYI', 'STY-LINGYI', 'STY-ZHAIDOU', 'STY-GONGDOU', 'STY-DIEZHAN'],
  'GRM-SHADOW-CLOSE': ['STY-XUANYI', 'STY-LINGYI', 'STY-DAOMU', 'STY-DIEZHAN', 'STY-ZHANZHENG'],
  'GRM-CLOUD-ASCEND': ['STY-XIANXIA', 'STY-XUANHUAN', 'STY-XIUXIAN', 'STY-GUFENG', 'STY-WUXIA'],
  'GRM-ROBE-ENTRANCE': ['STY-GUFENG', 'STY-XIANXIA', 'STY-WUXIA', 'STY-GONGDOU', 'STY-ZHAIDOU', 'STY-XUANHUAN'],
  'GRM-CANDLE-CONFESSION': ['STY-GONGDOU', 'STY-ZHAIDOU', 'STY-GUFENG', 'STY-LISHI'],
  'GRM-ELEVATOR-PRESS': ['STY-DUSHI', 'STY-ZHICHANG', 'STY-XUANYI', 'STY-ZHICHANG'],
  'GRM-STREET-SOLITUDE': ['STY-DUSHI', 'STY-TIANCHONG', 'STY-NIXI', 'STY-JIATING', 'STY-XIAOYUAN'],
  'GRM-BOARDROOM': ['STY-ZHICHANG', 'STY-SHANGZHAN', 'STY-LVZHENG', 'STY-DUSHI'],
  'GRM-NEON-RAIN': ['STY-CYBER', 'STY-KEHUAN', 'STY-DUSHI', 'STY-MORI', 'STY-YOUXI'],
  'GRM-HOLO-UNBALANCE': ['STY-CYBER', 'STY-KEHUAN', 'STY-YOUXI', 'STY-MORI'],
  'GRM-HERO-LANDING': ['STY-NIXI', 'STY-XUANHUAN', 'STY-XIUXIAN', 'STY-XIANXIA', 'STY-JUNLV', 'STY-WUXIA'],
  'GRM-SLAP': ['STY-NIXI', 'STY-DUSHI', 'STY-GONGDOU', 'STY-ZHAIDOU', 'STY-FUCHOU'],
  'GRM-ONER': ['STY-DIEZHAN', 'STY-ZHANZHENG', 'STY-JUNLV', 'STY-WUXIA', 'STY-XUANYI'],
  'GRM-TEAR-CLOSEUP': ['STY-TIANCHONG', 'STY-JIATING', 'STY-XIAOYUAN', 'STY-GUFENG', 'STY-YILIAO'],
  'GRM-REUNION': ['STY-TIANCHONG', 'STY-JIATING', 'STY-ZHONGTIAN', 'STY-DUSHI', 'STY-LISHI'],
  'GRM-FLASHBACK': ['STY-XUANYI', 'STY-FUCHOU', 'STY-DUSHI', 'STY-LISHI', 'STY-JIATING'],
  'GRM-TOMB-POV': ['STY-DAOMU', 'STY-LINGYI', 'STY-XUANYI'],
  'GRM-LOOKBACK': ['STY-LINGYI', 'STY-XUANYI', 'STY-DAOMU'],
  'GRM-WATER-PASS': ['STY-XIANXIA', 'STY-XUANHUAN', 'STY-XIUXIAN', 'STY-GUFENG', 'STY-WUXIA'],
  // 结构性配方：所有风格通用（集末必用）
  'GRM-FREEZE-END': [],
};

let text = fs.readFileSync(P, 'utf8');
let patched = 0;

for (const [code, styles] of Object.entries(MAP)) {
  const uniq = [...new Set(styles)];
  // 定位该配方的 "why" 行（每个配方 why 都在最后），在其后插入 styles
  const re = new RegExp(`("code": "${code}"[\\s\\S]*?\\n(\\s*)"why": "[^"\\n]*")(\\n)`);
  if (!re.test(text)) {
    console.log('MISS', code);
    continue;
  }
  text = text.replace(re, (m, head, indent, nl) => {
    const line = `,\n${indent}"styles": [${uniq.map((s) => `"${s}"`).join(', ')}]`;
    return head + line + nl;
  });
  patched += 1;
}

fs.writeFileSync(P, text);
const parsed = JSON.parse(text);
console.log('patched', patched, '/', Object.keys(MAP).length, '· recipes', parsed.recipes.length);
console.log('sample:', JSON.stringify(parsed.recipes[0]));
