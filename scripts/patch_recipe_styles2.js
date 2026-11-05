/** 补齐 4 个题材风格的配方覆盖（医疗 / 律政 / 商战 / 种田），只改 styles 数组。 */
import fs from 'node:fs';

const P = 'server/src/seeds/data/cinema_grammar.json';
const ADD = {
  'GRM-VERTIGO': ['STY-LVZHENG', 'STY-SHANGZHAN'],
  'GRM-ELEVATOR-PRESS': ['STY-SHANGZHAN'],
  'GRM-BOARDROOM': ['STY-YILIAO'],
  'GRM-ONER': ['STY-YILIAO'],
  'GRM-SHADOW-CLOSE': ['STY-YILIAO'],
  'GRM-TEAR-CLOSEUP': ['STY-ZHONGTIAN'],
  'GRM-WATER-PASS': ['STY-ZHONGTIAN'],
  'GRM-STREET-SOLITUDE': ['STY-ZHONGTIAN'],
};

let text = fs.readFileSync(P, 'utf8');
for (const [code, extra] of Object.entries(ADD)) {
  const re = new RegExp(`("code": "${code}"[\\s\\S]*?"styles": \\[)([^\\]]*)(\\])`);
  if (!re.test(text)) { console.log('MISS', code); continue; }
  text = text.replace(re, (m, head, body, tail) => {
    const cur = body.split(',').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...cur, ...extra.map((s) => `"${s}"`)])];
    return head + merged.join(', ') + tail;
  });
}
fs.writeFileSync(P, text);
const j = JSON.parse(text);
console.log('ok, recipes', j.recipes.length);
